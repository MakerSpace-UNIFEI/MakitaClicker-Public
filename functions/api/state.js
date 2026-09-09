// =====================================================================
// MAKITA CLICKER - CLOUDFLARE PAGES FUNCTION: /api/state
// API Serverless autoritativa com persistência no Cloudflare KV
// Master de Estado + Sincronização Inteligente (Cloud Master / Client Slave)
// =====================================================================

import gameConfig from './game-config.json';

const KV_KEY = 'gamestate';
const USERS_LIST_KEY = 'users:list';
const MAX_OWNED = gameConfig.meta?.maxOwnedPerUpgrade || 100;
// Hash SHA-256 criptográfico de 'ADMIN_PASSWORD' para autenticação segura e irreversível no painel administrativo
const ADMIN_AUTH_HASH = 'c9a2abd67ad59717195e5d8a6f917ba5084d81af244b0a8d40c8b30f234742d7';

// Configuração das oficinas e tecnologias derivadas de game-config.json
const UPGRADES = gameConfig.upgrades;
const PERMANENT_UPGRADES = (gameConfig.skillTree || gameConfig.permanentUpgrades || []).map(p => ({
  id: p.id,
  cost: Number(p.cost) || 0,
  req: Number(p.req ?? p.reqMakitas ?? 0),
  parent: p.parent ?? p.reqUpgrade ?? null,
  effects: p.effects || {}
}));

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
  'Pragma': 'no-cache',
  'Expires': '0'
};

const HARDWARE_LEASE_KEY = 'hardware:controller';
const HARDWARE_LEASE_MS = 3 * 60 * 1000; // 3 minutos de posse por solicitação

// Fallback em memória caso o binding MAKITA_KV ainda não esteja vinculado
let memoryFallbackState = null;
let memoryFallbackUsers = [];
let memoryFallbackUserStates = {};
let memoryFallbackHardwareLease = null;

// Sistema Anti-AutoClicker (Ban de 5 minutos por IP no Cloudflare KV e em memória)
const BAN_DURATION_MS = 5 * 60 * 1000; // 5 minutos
const memoryBannedIps = new Map(); // IP -> { bannedAt, expiresAt, reason, ip }
const memoryIpClickTracking = new Map(); // IP -> { windowStart, totalClicks, requestCount }

function getClientIp(request) {
  const cfIp = request.headers.get('CF-Connecting-IP');
  if (cfIp) return cfIp.trim();
  const xRealIp = request.headers.get('x-real-ip');
  if (xRealIp) return xRealIp.trim();
  const xForwardedFor = request.headers.get('x-forwarded-for');
  if (xForwardedFor) return xForwardedFor.split(',')[0].trim();
  return 'unknown';
}

async function checkIpBan(env, ip) {
  if (!ip || ip === 'unknown' || ip === '127.0.0.1' || ip === '::1') {
    return { banned: false };
  }

  const now = Date.now();

  // 1. Checagem ultra-rápida no cache em memória
  const memBan = memoryBannedIps.get(ip);
  if (memBan) {
    if (now < memBan.expiresAt) {
      const remainingSec = Math.ceil((memBan.expiresAt - now) / 1000);
      return { banned: true, remainingSec, banExpiresAt: memBan.expiresAt, reason: memBan.reason };
    } else {
      memoryBannedIps.delete(ip);
    }
  }

  // 2. Checagem no Cloudflare KV
  const { kv } = getKV(env);
  if (kv) {
    try {
      const kvBan = await kv.get(`ban:ip:${ip}`, { type: 'json' });
      if (kvBan && kvBan.expiresAt > now) {
        memoryBannedIps.set(ip, kvBan);
        const remainingSec = Math.ceil((kvBan.expiresAt - now) / 1000);
        return { banned: true, remainingSec, banExpiresAt: kvBan.expiresAt, reason: kvBan.reason };
      }
    } catch (e) {}
  }

  return { banned: false };
}

async function applyIpBan(env, ip, reason = 'Uso de auto-clicker detectado') {
  if (!ip || ip === 'unknown' || ip === '127.0.0.1' || ip === '::1') return;
  const now = Date.now();
  const expiresAt = now + BAN_DURATION_MS;
  const banData = { bannedAt: now, expiresAt, reason, ip };

  memoryBannedIps.set(ip, banData);

  const { kv } = getKV(env);
  if (kv) {
    try {
      await kv.put(`ban:ip:${ip}`, JSON.stringify(banData), {
        expirationTtl: 300 // 5 minutos (300 segundos) de expiração automática no KV
      });
    } catch (e) {
      console.error(`[ANTI-CLICKER] Erro ao gravar banimento do IP ${ip} no KV:`, e);
    }
  }
}

function getDefaultState() {
  const owned = {};
  UPGRADES.forEach(u => { owned[u.id] = 0; });
  const perms = {};
  PERMANENT_UPGRADES.forEach(p => { perms[p.id] = false; });

  return {
    makitas: 0.0,
    mps: 0.0,
    clickPower: 1.0,
    totalOwned: 0,
    totalMakitasMade: 0.0,
    owned,
    perms,
    resetId: 0,
    resetPendingEsp: false,
    hardwareOrders: [], // Fila latente FIFO de ordens para o hardware ESP8266
    lastResetAckAt: 0,
    lastResetExecutedAt: 0, // Timestamp da última ordem de reset concluída/confirmada
    espTelemetry: null,
    lastUpdate: Date.now()
  };
}

function unitCost(upgrade, count) {
  return Math.ceil(upgrade.baseCost * Math.pow(upgrade.growth, count));
}

function calculateClickPower(perms) {
  let basePower = 1.0;
  let clickMult = 1.0;

  PERMANENT_UPGRADES.forEach(p => {
    if (perms?.[p.id] && p.effects) {
      if (typeof p.effects.addClickPower === 'number') {
        basePower += p.effects.addClickPower;
      }
      if (typeof p.effects.multClickPower === 'number') {
        clickMult *= p.effects.multClickPower;
      }
    }
  });

  return basePower * clickMult;
}

function calculateMps(owned, perms) {
  let baseMps = 0.0;
  UPGRADES.forEach(u => {
    baseMps += ((owned?.[u.id] || 0) * u.mps);
  });

  let workshopMultiplier = 1.0;
  let globalMpsAddPercent = 0.0;

  PERMANENT_UPGRADES.forEach(p => {
    if (perms?.[p.id] && p.effects) {
      if (typeof p.effects.multWorkshopMps === 'number') {
        workshopMultiplier *= p.effects.multWorkshopMps;
      }
      if (typeof p.effects.addGlobalMpsPercent === 'number') {
        globalMpsAddPercent += p.effects.addGlobalMpsPercent;
      }
    }
  });

  return baseMps * workshopMultiplier * (1.0 + globalMpsAddPercent);
}

function getSingleClickGain(perms, mps) {
  const baseGain = calculateClickPower(perms);
  let maxSynergy = 0.0;
  PERMANENT_UPGRADES.forEach(p => {
    if (perms?.[p.id] && p.effects && typeof p.effects.clickSynergyMpsPercent === 'number') {
      if (p.effects.clickSynergyMpsPercent > maxSynergy) {
        maxSynergy = p.effects.clickSynergyMpsPercent;
      }
    }
  });
  return baseGain + (mps * maxSynergy);
}

function getTotalOwned(owned) {
  let total = 0;
  for (const k in owned) {
    total += (owned[k] || 0);
  }
  return total;
}

// =====================================================================
// SERIALIZAÇÃO COMPACTA INDEXADA (ECONOMIA DE KV & REDE)
// =====================================================================

function getUserStateKey(userId) {
  return `user:${userId}:state`;
}

// Converte estado operacional para representação compacta no KV
function compactUserState(state) {
  const upgradesArr = UPGRADES.map(u => {
    if (state.owned && typeof state.owned[u.id] === 'number') {
      return state.owned[u.id];
    }
    return 0;
  });

  const permsArr = [];
  PERMANENT_UPGRADES.forEach((p, idx) => {
    if (state.perms && state.perms[p.id] === true) {
      permsArr.push(idx);
    }
  });

  return {
    makitas: typeof state.makitas === 'number' ? state.makitas : 0,
    totalMakitasMade: typeof state.totalMakitasMade === 'number' ? state.totalMakitasMade : (state.makitas || 0),
    upgrades: upgradesArr,
    perms: permsArr,
    saveRev: state.saveRev || 1,
    resetEpoch: state.resetEpoch || 0,
    lastUpdate: state.lastUpdate || Date.now(),
    lastSavedAt: Date.now()
  };
}

// Expande estado compacto para o formato operacional completo
function expandUserState(raw) {
  if (!raw || typeof raw !== 'object') return getDefaultState();

  const owned = {};
  UPGRADES.forEach((u, idx) => {
    if (Array.isArray(raw.upgrades)) {
      owned[u.id] = Math.max(0, Math.min(MAX_OWNED, parseInt(raw.upgrades[idx] || 0, 10)));
    } else if (raw.owned && typeof raw.owned === 'object') {
      owned[u.id] = Math.max(0, Math.min(MAX_OWNED, parseInt(raw.owned[u.id] || 0, 10)));
    } else {
      owned[u.id] = 0;
    }
  });

  const perms = {};
  PERMANENT_UPGRADES.forEach((p, idx) => {
    if (Array.isArray(raw.perms)) {
      perms[p.id] = raw.perms.includes(idx);
    } else if (raw.perms && typeof raw.perms === 'object') {
      perms[p.id] = raw.perms[p.id] === true;
    } else {
      perms[p.id] = false;
    }
  });

  const mps = calculateMps(owned, perms);
  const clickPower = calculateClickPower(perms);
  const totalOwned = getTotalOwned(owned);
  const makitas = typeof raw.makitas === 'number' ? raw.makitas : 0;
  const totalMakitasMade = typeof raw.totalMakitasMade === 'number' ? raw.totalMakitasMade : makitas;

  return {
    makitas,
    mps,
    clickPower,
    totalOwned,
    totalMakitasMade,
    owned,
    perms,
    saveRev: raw.saveRev || 1,
    resetEpoch: raw.resetEpoch || 0,
    lastUpdate: raw.lastUpdate || Date.now(),
    lastSavedAt: raw.lastSavedAt || Date.now()
  };
}

// Identifica o jogador com o maior progresso para telemetria no LCD da ESP8266
function getTopPlayer(usersList) {
  if (!Array.isArray(usersList) || usersList.length === 0) {
    return { name: 'MakerSpace', makitas: 0, totalMakitasMade: 0 };
  }
  let top = usersList[0];
  for (const u of usersList) {
    const currentScore = typeof u.totalMakitasMade === 'number' ? u.totalMakitasMade : (u.makitas || 0);
    const topScore = typeof top.totalMakitasMade === 'number' ? top.totalMakitasMade : (top.makitas || 0);
    if (currentScore > topScore) {
      top = u;
    }
  }
  return {
    id: top.id || null,
    name: top.name || 'Maker',
    makitas: top.makitas || 0,
    totalMakitasMade: top.totalMakitasMade || top.makitas || 0
  };
}

function getKV(env) {
  if (!env) {
    return { kv: null, name: null, kvName: null, kvConnected: false, diag: 'Objeto context.env não fornecido pelo Cloudflare Pages.' };
  }
  if (env.MAKITA_KV && typeof env.MAKITA_KV.get === 'function') {
    return { kv: env.MAKITA_KV, name: 'MAKITA_KV', kvName: 'MAKITA_KV', kvConnected: true, diag: 'MAKITA_KV conectado com sucesso.' };
  }
  for (const [key, val] of Object.entries(env)) {
    if (key === 'ASSETS') continue; // Ignora o repositório interno de assets estáticos do Pages
    if (val && typeof val.get === 'function' && typeof val.put === 'function') {
      return { kv: val, name: key, kvName: key, kvConnected: true, diag: `KV detectado via binding alternativo: '${key}'` };
    }
  }

  // Diagnóstico detalhado para troubleshooting no Cloudflare Pages
  const keys = Object.keys(env).filter(k => k !== 'ASSETS');
  const makitaType = typeof env.MAKITA_KV;
  let diag = '';

  if (makitaType === 'string') {
    diag = "Atenção: MAKITA_KV está definida como STRING (Variável de Ambiente comum). No Cloudflare Pages, ela deve ser vinculada como 'KV namespace binding' em Settings > Functions > KV namespace bindings.";
  } else if (makitaType === 'undefined') {
    if (keys.length === 0) {
      diag = "Nenhum binding ou variável foi injetado neste deploy. Se você já configurou o binding no painel, é OBRIGATÓRIO disparar um NOVO deploy (ou clicar em 'Retry deployment') para que a Cloudflare aplique as alterações.";
    } else {
      diag = `Binding MAKITA_KV não encontrado em env (chaves presentes: [${keys.join(', ')}]). Se configurou recentemente, dispare um novo deploy.`;
    }
  } else {
    diag = `MAKITA_KV está presente como '${makitaType}', mas não possui os métodos esperados de KV (.get / .put).`;
  }

  return { kv: null, name: null, kvName: null, kvConnected: false, diag };
}

// Produção passiva autoritativa baseada no delta de tempo.
function advancePassiveProduction(state, now) {
  const last = state.lastUpdate || now;
  const dt = Math.max(0, (now - last) / 1000.0);
  // Garante que o MPS não fique zerado se houver upgrades
  const calculatedMps = calculateMps(state.owned, state.perms);
  if ((!state.mps || state.mps <= 0) && calculatedMps > 0) {
    state.mps = calculatedMps;
  }
  const currentMps = state.mps || calculatedMps || 0;
  if (dt > 0 && currentMps > 0) {
    const gain = currentMps * dt;
    state.makitas = (state.makitas || 0) + gain;
    state.totalMakitasMade = (state.totalMakitasMade || 0) + gain;
  }
  state.lastUpdate = now;
  state.clickPower = calculateClickPower(state.perms);
  state.totalOwned = getTotalOwned(state.owned);
}

function sanitizeNick(raw) {
  if (!raw) return 'Maker ' + Math.floor(Math.random() * 1000);
  let s = String(raw).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  s = s.replace(/[º°]/g, 'o').replace(/[ª]/g, 'a');
  s = s.replace(/[^a-zA-Z0-9 _-]/g, '').trim();
  if (!s) return 'Maker ' + Math.floor(Math.random() * 1000);
  return s.slice(0, 16);
}

async function saveUserMeta(env, userEntry) {
  if (!userEntry || !userEntry.id) return;
  const { kv } = getKV(env);
  if (kv) {
    try {
      await kv.put(`user_meta:${userEntry.id}`, JSON.stringify(userEntry));
    } catch (err) {
      console.error(`[KV] Erro ao gravar user_meta para ${userEntry.id}:`, err);
    }
  }
}

async function loadUsersList(env) {
  const { kv } = getKV(env);
  let kvUsers = null;
  if (kv) {
    try {
      const data = await kv.get(USERS_LIST_KEY, { type: 'json' });
      if (Array.isArray(data)) kvUsers = data;
    } catch (err) {
      console.error('[KV] Erro ao ler lista de usuários:', err);
    }
  }

  // Mapa de usuários para mesclagem defensiva sem perda de perfis
  const map = new Map();

  // 1. Incorpora usuários lidos do Cloudflare KV (leitura econômica kv.get)
  if (Array.isArray(kvUsers)) {
    kvUsers.forEach(u => { if (u && u.id) map.set(u.id, u); });
  }

  // 2. Incorpora usuários da memória local deste worker (proteção contra replicação assíncrona do KV)
  if (Array.isArray(memoryFallbackUsers)) {
    memoryFallbackUsers.forEach(u => {
      if (u && u.id) {
        const existing = map.get(u.id);
        if (!existing) {
          map.set(u.id, u);
        } else {
          const memScore = u.totalMakitasMade || u.makitas || 0;
          const kvScore = existing.totalMakitasMade || existing.makitas || 0;
          if ((u.lastSavedAt || 0) >= (existing.lastSavedAt || 0) || memScore > kvScore) {
            map.set(u.id, { ...existing, ...u });
          }
        }
      }
    });
  }

  const merged = Array.from(map.values());
  memoryFallbackUsers = merged;
  return merged;
}

async function saveUsersList(env, list) {
  const { kv } = getKV(env);
  if (kv) {
    try {
      await kv.put(USERS_LIST_KEY, JSON.stringify(list));
    } catch (err) {
      console.error('[KV] Erro ao salvar lista de usuários:', err);
    }
  }
  memoryFallbackUsers = list;
}

async function loadUserState(env, userId) {
  const { kv, name, kvConnected, diag } = getKV(env);
  const key = getUserStateKey(userId);
  let kvState = null;
  if (kv) {
    try {
      const raw = await kv.get(key, { type: 'json' });
      if (raw && typeof raw === 'object') {
        kvState = expandUserState(raw);
      }
    } catch (err) {
      console.error(`[KV] Erro ao ler estado do usuário ${userId}:`, err);
    }
  }

  const memState = memoryFallbackUserStates[userId];

  // Blindagem contra consistência eventual do Cloudflare KV:
  // Se o cache de memória deste worker tiver estado com resetEpoch mais recente,
  // ou revisão/timestamp superior ao que o KV retornou, a memória PREVALECE.
  let state = kvState || memState || getDefaultState();

  if (kvState && memState) {
    const memReset = memState.resetEpoch || 0;
    const kvReset = kvState.resetEpoch || 0;
    if (memReset !== kvReset) {
      state = memReset > kvReset ? memState : kvState;
    } else {
      const memRev = memState.saveRev || 0;
      const kvRev = kvState.saveRev || 0;
      const memTime = Math.max(memState.lastSavedAt || 0, memState.lastUpdate || 0);
      const kvTime = Math.max(kvState.lastSavedAt || 0, kvState.lastUpdate || 0);
      if (memRev > kvRev || (memRev === kvRev && memTime >= kvTime)) {
        state = memState;
      }
    }
  }

  return { state, kvName: name, kvConnected: !!kv, kvDiag: diag };
}

async function saveUserState(env, userId, state) {
  const currentMem = memoryFallbackUserStates[userId];
  if (currentMem) {
    const memReset = currentMem.resetEpoch || 0;
    const stateReset = state.resetEpoch || 0;
    if (memReset > stateReset) {
      // Rejeita sobrescrita de um reset recente por dados pré-reset
      return;
    }
  }

  const { kv } = getKV(env);
  const key = getUserStateKey(userId);
  const compact = compactUserState(state);
  if (kv) {
    try {
      await kv.put(key, JSON.stringify(compact));
    } catch (err) {
      console.error(`[KV] Erro ao salvar estado do usuário ${userId}:`, err);
    }
  }
  memoryFallbackUserStates[userId] = state;
}

async function deleteUserState(env, userId) {
  const { kv } = getKV(env);
  const key = getUserStateKey(userId);
  if (kv) {
    try {
      await kv.delete(key);
    } catch (err) {
      console.error(`[KV] Erro ao deletar estado do usuário ${userId}:`, err);
    }
  }
  delete memoryFallbackUserStates[userId];
}

async function loadState(env) {
  const { kv, name, diag } = getKV(env);
  if (kv) {
    try {
      const data = await kv.get(KV_KEY, { type: 'json' });
      if (data && typeof data === 'object') {
        return { state: data, kvName: name, kvConnected: true, kvDiag: diag };
      }
    } catch (err) {
      console.error(`[KV] Erro ao ler KV (${name}):`, err);
    }
  }
  if (!memoryFallbackState) {
    memoryFallbackState = getDefaultState();
  }
  return { state: memoryFallbackState, kvName: name, kvConnected: !!kv, kvDiag: diag };
}

async function saveState(env, state) {
  const { kv, name } = getKV(env);
  if (kv) {
    try {
      await kv.put(KV_KEY, JSON.stringify(state));
    } catch (err) {
      console.error(`[KV] Erro ao gravar KV (${name}):`, err);
    }
  }
  memoryFallbackState = state;
}

async function loadHardwareLease(env) {
  const { kv } = getKV(env);
  let kvLease = null;
  if (kv) {
    try {
      kvLease = await kv.get(HARDWARE_LEASE_KEY, { type: 'json' });
    } catch (err) {
      console.error('[KV] Erro ao ler hardware lease:', err);
    }
  }

  // Reconciliação Temporal com Cache em Memória:
  // Se o cache de memória possuir versão com timestamp superior (claimedAt ou releasedAt),
  // ele prevalece para evitar regressões causadas por consistência eventual do Cloudflare KV.
  let lease = kvLease;
  if (memoryFallbackHardwareLease) {
    const memTimestamp = Math.max(memoryFallbackHardwareLease.claimedAt || 0, memoryFallbackHardwareLease.releasedAt || 0);
    const kvTimestamp = Math.max(kvLease?.claimedAt || 0, kvLease?.releasedAt || 0);
    if (memTimestamp >= kvTimestamp) {
      lease = memoryFallbackHardwareLease;
    }
  }

  const now = Date.now();
  if (lease && typeof lease === 'object') {
    const isUnexpired = lease.expiresAt && lease.expiresAt > now;
    if (lease.active !== false && lease.userId && isUnexpired) {
      return {
        ...lease,
        active: true,
        remainingSec: Math.max(0, Math.ceil((lease.expiresAt - now) / 1000))
      };
    }
    return {
      active: false,
      userId: null,
      userName: null,
      claimedAt: lease.claimedAt || 0,
      releasedAt: lease.releasedAt || 0,
      expiresAt: 0,
      remainingSec: 0
    };
  }
  return { active: false, userId: null, userName: null, claimedAt: 0, releasedAt: 0, expiresAt: 0, remainingSec: 0 };
}

async function saveHardwareLease(env, lease) {
  const currentMem = memoryFallbackHardwareLease;
  // Guarda sempre o lease com maior timestamp temporal
  if (currentMem && lease) {
    const curTime = Math.max(currentMem.claimedAt || 0, currentMem.releasedAt || 0);
    const newTime = Math.max(lease.claimedAt || 0, lease.releasedAt || 0);
    if (curTime > newTime) {
      // Tentativa de escrita com timestamp inferior: ignora para proteger contra eventual consistency
      return;
    }
  }

  const { kv } = getKV(env);
  if (kv) {
    try {
      if (lease) {
        await kv.put(HARDWARE_LEASE_KEY, JSON.stringify(lease));
      } else {
        const tombstone = {
          active: false,
          userId: null,
          userName: null,
          claimedAt: currentMem?.claimedAt || 0,
          releasedAt: Date.now(),
          expiresAt: 0,
          remainingSec: 0
        };
        await kv.put(HARDWARE_LEASE_KEY, JSON.stringify(tombstone));
      }
    } catch (err) {
      console.error('[KV] Erro ao salvar hardware lease:', err);
    }
  }
  memoryFallbackHardwareLease = lease;
}

// ------------------- HANDLERS -------------------

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet(context) {
  const { request, env } = context;

  // Verificação Anti-AutoClicker por IP (Ban de 5 minutos)
  const clientIp = getClientIp(request);
  const banStatus = await checkIpBan(env, clientIp);
  if (banStatus.banned) {
    return new Response(JSON.stringify({
      error: 'Seu IP está temporariamente suspenso por 5 minutos devido a uso de auto-clicker.',
      banned: true,
      remainingSec: banStatus.remainingSec,
      banExpiresAt: banStatus.banExpiresAt,
      reason: banStatus.reason
    }), {
      status: 429,
      headers: {
        ...CORS_HEADERS,
        'Retry-After': String(banStatus.remainingSec)
      }
    });
  }

  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  const userId = url.searchParams.get('userId');
  const clientUserId = url.searchParams.get('clientUserId') || userId;
  const clientUserName = url.searchParams.get('clientUserName');

  const { kvName, kvConnected, diag } = getKV(env);
  let usersList = await loadUsersList(env);

  // Auto-reconciliação defensiva: se o cliente possui um perfil local que não está em usersList
  // (devido a eventual consistency ou criação recente), restaura e re-indexa imediatamente
  if (clientUserId && !usersList.some(u => u.id === clientUserId)) {
    const { kv } = getKV(env);
    let meta = null;
    if (kv) {
      try { meta = await kv.get(`user_meta:${clientUserId}`, { type: 'json' }); } catch (e) {}
    }
    if (!meta) {
      const { state: uState } = await loadUserState(env, clientUserId);
      meta = {
        id: clientUserId,
        name: clientUserName || 'Maker',
        createdAt: uState.createdAt || Date.now(),
        lastSavedAt: uState.lastSavedAt || Date.now(),
        makitas: uState.makitas || 0,
        totalMakitasMade: uState.totalMakitasMade || uState.makitas || 0
      };
    }
    usersList.push(meta);
    await saveUsersList(env, usersList);
    await saveUserMeta(env, meta);
  }

  const topPlayer = getTopPlayer(usersList);
  const hardwareOwner = await loadHardwareLease(env);

  // 1. Rota de Listagem de Perfis
  if (action === 'list_users') {
    return new Response(JSON.stringify({
      users: usersList,
      topPlayer,
      hardwareOwner,
      _kv_connected: kvConnected,
      _kv_binding: kvName || 'NONE',
      _kv_diag: diag
    }), {
      status: 200,
      headers: CORS_HEADERS
    });
  }

  // 2. Rota de Estado Individual de Perfil
  if (userId) {
    const { state } = await loadUserState(env, userId);
    const now = Date.now();
    advancePassiveProduction(state, now);

    return new Response(JSON.stringify({
      ...state,
      topPlayer,
      hardwareOwner,
      _kv_connected: kvConnected,
      _kv_binding: kvName || 'NONE',
      _kv_diag: diag
    }), {
      status: 200,
      headers: CORS_HEADERS
    });
  }

  // 2.5 Rota de Status do Hardware (polling leve do frontend a cada 5s)
  if (action === 'get_hardware_status') {
    return new Response(JSON.stringify({
      success: true,
      hardwareOwner,
      topPlayer,
      _kv_connected: kvConnected,
      _kv_binding: kvName || 'NONE',
      _kv_diag: diag
    }), {
      status: 200,
      headers: CORS_HEADERS
    });
  }

  // 3. Rota Padrão / Estado Global (ESP8266 & Legado)
  const { state } = await loadState(env);
  const now = Date.now();
  advancePassiveProduction(state, now);

  const activeOrder = (state.hardwareOrders && state.hardwareOrders.length > 0) ? state.hardwareOrders[0] : null;

  return new Response(JSON.stringify({
    ...state,
    topPlayer,
    hardwareOwner,
    resetOrder: (state.hardwareOrders && state.hardwareOrders.length > 0) || state.resetPendingEsp === true,
    pendingOrder: activeOrder,
    hardwareOrders: state.hardwareOrders || [],
    queueLength: (state.hardwareOrders ? state.hardwareOrders.length : 0),
    _kv_connected: kvConnected,
    _kv_binding: kvName || 'NONE',
    _kv_diag: diag
  }), {
    status: 200,
    headers: CORS_HEADERS
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  let body = {};
  try {
    body = await request.json();
  } catch (e) {
    // Body vazio ou malformado
  }

  const url = new URL(request.url);
  const action = body.action || url.searchParams.get('action') || (body.clicks ? 'sync' : '');
  const isEsp = body.source === 'esp';
  const clientIp = getClientIp(request);

  // Verificação Anti-AutoClicker por IP (a ESP8266 física nunca é bloqueada por IP)
  if (!isEsp) {
    const banStatus = await checkIpBan(env, clientIp);
    if (banStatus.banned) {
      return new Response(JSON.stringify({
        error: 'Seu IP está temporariamente suspenso por 5 minutos devido a uso de auto-clicker.',
        banned: true,
        remainingSec: banStatus.remainingSec,
        banExpiresAt: banStatus.banExpiresAt,
        reason: banStatus.reason
      }), {
        status: 429,
        headers: {
          ...CORS_HEADERS,
          'Retry-After': String(banStatus.remainingSec)
        }
      });
    }

    // Ação explícita de reporte enviada pelo cliente (detecção de cliques sintéticos ou CPS > 28)
    if (action === 'report_autoclicker') {
      const reason = String(body.reason || 'Auto-clicker reportado pelo cliente').slice(0, 120);
      await applyIpBan(env, clientIp, reason);
      return new Response(JSON.stringify({
        success: true,
        banned: true,
        remainingSec: 300,
        banExpiresAt: Date.now() + BAN_DURATION_MS,
        reason
      }), {
        status: 429,
        headers: {
          ...CORS_HEADERS,
          'Retry-After': '300'
        }
      });
    }

    // Monitoramento no backend de taxa anormal de cliques / requests (Web)
    const nowMs = Date.now();
    let tracking = memoryIpClickTracking.get(clientIp);
    if (!tracking || nowMs - tracking.windowStart > 10000) {
      tracking = { windowStart: nowMs, totalClicks: 0, requestCount: 0 };
      memoryIpClickTracking.set(clientIp, tracking);
    }
    tracking.requestCount++;
    const incomingClicks = typeof body.clicks === 'number' ? body.clicks : 0;
    tracking.totalClicks += incomingClicks;

    // Se um único payload web vier com mais de 500 cliques ou se em 10s tiver mais de 350 cliques (>35 CPS)
    // ou mais de 50 requisições em 10s:
    if (incomingClicks > 500 || tracking.totalClicks > 350 || tracking.requestCount > 50) {
      const reason = incomingClicks > 500
        ? `Taxa desumana de cliques em lote único (${incomingClicks} cliques)`
        : `Taxa anormal de cliques/requisições (${tracking.totalClicks} cliques em 10s)`;
      await applyIpBan(env, clientIp, reason);
      return new Response(JSON.stringify({
        error: 'Seu IP foi banido por 5 minutos por uso de auto-clicker.',
        banned: true,
        remainingSec: 300,
        banExpiresAt: nowMs + BAN_DURATION_MS,
        reason
      }), {
        status: 429,
        headers: {
          ...CORS_HEADERS,
          'Retry-After': '300'
        }
      });
    }
  }

  const { kvName, kvConnected, diag } = getKV(env);

  let usersList = await loadUsersList(env);
  const clientUserId = body.userId || url.searchParams.get('clientUserId');
  const clientUserName = body.userName || url.searchParams.get('clientUserName');

  // Auto-reconciliação defensiva no POST
  if (clientUserId && !usersList.some(u => u.id === clientUserId)) {
    const { kv } = getKV(env);
    let meta = null;
    if (kv) {
      try { meta = await kv.get(`user_meta:${clientUserId}`, { type: 'json' }); } catch (e) {}
    }
    if (!meta) {
      meta = {
        id: clientUserId,
        name: clientUserName || 'Maker',
        createdAt: Date.now(),
        lastSavedAt: Date.now(),
        makitas: Number(body.makitas) || 0,
        totalMakitasMade: Number(body.totalMakitasMade) || Number(body.makitas) || 0
      };
    }
    usersList.push(meta);
    await saveUsersList(env, usersList);
    await saveUserMeta(env, meta);
  }

  let topPlayer = getTopPlayer(usersList);
  const hardwareOwner = await loadHardwareLease(env);

  // -------------------------------------------------------------
  // AÇÕES DE CONTROLE DO CONSOLE FÍSICO (ESP8266)
  // -------------------------------------------------------------
  if (action === 'get_hardware_status') {
    return new Response(JSON.stringify({
      success: true,
      hardwareOwner,
      topPlayer,
      _kv_connected: kvConnected,
      _kv_binding: kvName || 'NONE',
      _kv_diag: diag
    }), {
      status: 200,
      headers: CORS_HEADERS
    });
  }

  if (action === 'claim_hardware') {
    const userId = body.userId;
    const userName = sanitizeNick(body.userName);
    const force = body.force === true;
    const now = Date.now();

    if (!userId) {
      return new Response(JSON.stringify({ error: 'userId obrigatório' }), {
        status: 400,
        headers: CORS_HEADERS
      });
    }

    const currentLease = await loadHardwareLease(env);

    // Se outro usuário ativo estiver controlando e não for forçado
    if (currentLease.active && currentLease.userId !== userId && !force) {
      return new Response(JSON.stringify({
        success: false,
        busy: true,
        owner: {
          userId: currentLease.userId,
          userName: currentLease.userName,
          expiresAt: currentLease.expiresAt,
          remainingSec: currentLease.remainingSec
        },
        message: `O console está sendo controlado por ${currentLease.userName}.`
      }), {
        status: 409,
        headers: CORS_HEADERS
      });
    }

    // Garante timestamp estritamente monotônico para blindagem contra consistência eventual do KV
    const monotonicClaimedAt = Math.max(now, (currentLease?.claimedAt || 0) + 1, (currentLease?.releasedAt || 0) + 1);
    const newLease = {
      userId,
      userName,
      claimedAt: monotonicClaimedAt,
      expiresAt: monotonicClaimedAt + HARDWARE_LEASE_MS,
      leaseId: (currentLease?.leaseId || 0) + 1
    };

    await saveHardwareLease(env, newLease);

    const activeOwner = {
      ...newLease,
      active: true,
      remainingSec: Math.ceil(HARDWARE_LEASE_MS / 1000)
    };

    return new Response(JSON.stringify({
      success: true,
      hardwareOwner: activeOwner,
      topPlayer,
      _kv_connected: kvConnected,
      _kv_binding: kvName || 'NONE',
      _kv_diag: diag
    }), {
      status: 200,
      headers: CORS_HEADERS
    });
  }

  if (action === 'release_hardware') {
    const userId = body.userId;
    const currentLease = await loadHardwareLease(env);
    if (currentLease.active && currentLease.userId === userId) {
      await saveHardwareLease(env, null);
    }

    return new Response(JSON.stringify({
      success: true,
      hardwareOwner: { active: false, userId: null, userName: null, expiresAt: 0, remainingSec: 0 },
      topPlayer,
      _kv_connected: kvConnected,
      _kv_binding: kvName || 'NONE',
      _kv_diag: diag
    }), {
      status: 200,
      headers: CORS_HEADERS
    });
  }

  // -------------------------------------------------------------
  // AÇÃO 1: CRIAR NOVO PERFIL DE USUÁRIO (Salvo imediatamente no KV)
  // -------------------------------------------------------------
  if (action === 'create_user') {
    const name = sanitizeNick(body.name);
    const now = Date.now();
    const userId = 'u_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 6);

    const initialState = getDefaultState();
    await saveUserState(env, userId, initialState);

    const newUserEntry = {
      id: userId,
      name,
      createdAt: now,
      lastSavedAt: now,
      makitas: 0,
      totalMakitasMade: 0
    };

    await saveUserMeta(env, newUserEntry);
    usersList.push(newUserEntry);
    await saveUsersList(env, usersList);
    topPlayer = getTopPlayer(usersList);

    return new Response(JSON.stringify({
      success: true,
      user: newUserEntry,
      state: initialState,
      topPlayer,
      hardwareOwner,
      _kv_connected: kvConnected,
      _kv_binding: kvName || 'NONE',
      _kv_diag: diag
    }), {
      status: 200,
      headers: CORS_HEADERS
    });
  }

  // -------------------------------------------------------------
  // AÇÃO 2: SALVAR ESTADO DO PERFIL (Save Manual ou Auto-Save)
  // -------------------------------------------------------------
  if (action === 'save_user_state') {
    const userId = body.userId;
    if (!userId) {
      return new Response(JSON.stringify({ error: 'userId obrigatório' }), {
        status: 400,
        headers: CORS_HEADERS
      });
    }

    const now = Date.now();
    const statePayload = body.state || body;

    // Proteção contra consistência eventual / ressurreição pós-reset:
    // Se o estado já salvo no servidor possui um resetEpoch mais recente que o payload enviado,
    // significa que este payload veio de uma requisição/aba anterior ao reset. Rejeitamos para não ressuscitar!
    const { state: currentState } = await loadUserState(env, userId);
    if (currentState && currentState.resetEpoch && (!statePayload.resetEpoch || statePayload.resetEpoch < currentState.resetEpoch)) {
      return new Response(JSON.stringify({
        success: true,
        staleRejected: true,
        state: currentState,
        topPlayer,
        hardwareOwner,
        _kv_connected: kvConnected,
        _kv_binding: kvName || 'NONE',
        _kv_diag: 'Save defasado descartado pelo servidor para evitar ressurreição de dados.'
      }), {
        status: 200,
        headers: CORS_HEADERS
      });
    }

    const expanded = expandUserState(statePayload);

    if (typeof statePayload.makitas === 'number') {
      expanded.makitas = statePayload.makitas;
    }
    if (typeof statePayload.totalMakitasMade === 'number') {
      expanded.totalMakitasMade = statePayload.totalMakitasMade;
    }
    expanded.saveRev = Math.max(Number(statePayload.saveRev) || 0, Number(currentState?.saveRev) || 0) + 1;
    expanded.lastSavedAt = now;
    expanded.lastUpdate = now;
    if (currentState && currentState.resetEpoch) {
      expanded.resetEpoch = currentState.resetEpoch;
    }

    await saveUserState(env, userId, expanded);

    // Atualiza resumo no users:list para ranking
    const userIndex = usersList.findIndex(u => u.id === userId);
    const resolvedName = sanitizeNick(body.userName || body.name || (userIndex >= 0 ? usersList[userIndex].name : 'Maker'));
    let isNewUserInList = false;

    if (userIndex >= 0) {
      usersList[userIndex].lastSavedAt = now;
      usersList[userIndex].makitas = expanded.makitas;
      usersList[userIndex].totalMakitasMade = expanded.totalMakitasMade;
      if (body.userName) usersList[userIndex].name = resolvedName;
    } else {
      isNewUserInList = true;
      usersList.push({
        id: userId,
        name: resolvedName,
        createdAt: currentState?.createdAt || now,
        lastSavedAt: now,
        makitas: expanded.makitas,
        totalMakitasMade: expanded.totalMakitasMade
      });
    }

    // Economia estrita de cota KV: só grava USERS_LIST_KEY se for novo usuário ou se superou o líder
    const isNewLeader = expanded.totalMakitasMade > (topPlayer?.totalMakitasMade || 0);
    if (isNewUserInList || isNewLeader) {
      await saveUsersList(env, usersList);
    }
    topPlayer = getTopPlayer(usersList);

    return new Response(JSON.stringify({
      success: true,
      lastSavedAt: now,
      saveRev: expanded.saveRev,
      state: expanded,
      topPlayer,
      hardwareOwner,
      _kv_connected: kvConnected,
      _kv_binding: kvName || 'NONE',
      _kv_diag: diag
    }), {
      status: 200,
      headers: CORS_HEADERS
    });
  }

  // -------------------------------------------------------------
  // AÇÃO 3: RESETAR ESTADO DE UM PERFIL ESPECÍFICO
  // -------------------------------------------------------------
  if (action === 'reset_user_state') {
    const userId = body.userId;
    if (!userId) {
      return new Response(JSON.stringify({ error: 'userId obrigatório' }), {
        status: 400,
        headers: CORS_HEADERS
      });
    }

    const now = Date.now();
    const freshState = getDefaultState();
    freshState.lastSavedAt = now;
    freshState.lastUpdate = now;
    freshState.resetEpoch = now; // Marca temporal de reset absoluto
    freshState.saveRev = (currentState?.saveRev || 0) + 10; // Avança a revisão para superar quaisquer saves concorrentes em voo

    await saveUserState(env, userId, freshState);

    const userIndex = usersList.findIndex(u => u.id === userId);
    if (userIndex >= 0) {
      usersList[userIndex].makitas = 0;
      usersList[userIndex].totalMakitasMade = 0;
      usersList[userIndex].lastSavedAt = now;
      await saveUsersList(env, usersList);
    }
    topPlayer = getTopPlayer(usersList);

    return new Response(JSON.stringify({
      success: true,
      isReset: true,
      state: freshState,
      topPlayer,
      hardwareOwner,
      _kv_connected: kvConnected,
      _kv_binding: kvName || 'NONE',
      _kv_diag: diag
    }), {
      status: 200,
      headers: CORS_HEADERS
    });
  }

  // -------------------------------------------------------------
  // AÇÕES ADMINISTRATIVAS (Protegidas por Hash Criptográfico SHA-256)
  // -------------------------------------------------------------
  if (action === 'admin_verify') {
    const authHash = String(body.authHash || '').trim().toLowerCase();
    if (authHash !== ADMIN_AUTH_HASH) {
      return new Response(JSON.stringify({ success: false, error: 'Senha administrativa incorreta.' }), {
        status: 401,
        headers: CORS_HEADERS
      });
    }
    const { state: curState } = await loadState(env);
    return new Response(JSON.stringify({
      success: true,
      users: usersList,
      topPlayer,
      hardwareOwner,
      hardwareOrders: curState.hardwareOrders || [],
      queueLength: (curState.hardwareOrders ? curState.hardwareOrders.length : 0),
      _kv_connected: kvConnected,
      _kv_binding: kvName || 'NONE',
      _kv_diag: diag
    }), {
      status: 200,
      headers: CORS_HEADERS
    });
  }

  if (action === 'admin_delete_user') {
    const authHash = String(body.authHash || '').trim().toLowerCase();
    if (authHash !== ADMIN_AUTH_HASH) {
      return new Response(JSON.stringify({ success: false, error: 'Não autorizado.' }), {
        status: 401,
        headers: CORS_HEADERS
      });
    }
    const userId = body.userId;
    if (!userId) {
      return new Response(JSON.stringify({ error: 'userId obrigatório' }), {
        status: 400,
        headers: CORS_HEADERS
      });
    }

    await deleteUserState(env, userId);
    const { kv } = getKV(env);
    if (kv) {
      try { await kv.delete(`user_meta:${userId}`); } catch (e) {}
    }
    const updatedUsers = usersList.filter(u => u.id !== userId);
    await saveUsersList(env, updatedUsers);
    topPlayer = getTopPlayer(updatedUsers);

    return new Response(JSON.stringify({
      success: true,
      deletedUserId: userId,
      users: updatedUsers,
      topPlayer,
      hardwareOwner,
      _kv_connected: kvConnected,
      _kv_binding: kvName || 'NONE',
      _kv_diag: diag
    }), {
      status: 200,
      headers: CORS_HEADERS
    });
  }

  if (action === 'admin_delete_all_users') {
    const authHash = String(body.authHash || '').trim().toLowerCase();
    if (authHash !== ADMIN_AUTH_HASH) {
      return new Response(JSON.stringify({ success: false, error: 'Não autorizado.' }), {
        status: 401,
        headers: CORS_HEADERS
      });
    }

    for (const u of usersList) {
      await deleteUserState(env, u.id);
    }
    await saveUsersList(env, []);
    topPlayer = { id: null, name: 'MakerSpace', makitas: 0, totalMakitasMade: 0 };

    return new Response(JSON.stringify({
      success: true,
      users: [],
      topPlayer,
      hardwareOwner,
      _kv_connected: kvConnected,
      _kv_binding: kvName || 'NONE',
      _kv_diag: diag
    }), {
      status: 200,
      headers: CORS_HEADERS
    });
  }

  // AÇÃO ADMINISTRATIVA: EMITIR ORDEM NA FILA DA ESP (Factory Reset / Reset Simples)
  if (action === 'admin_reset_hardware') {
    const authHash = String(body.authHash || '').trim().toLowerCase();
    if (authHash !== ADMIN_AUTH_HASH) {
      return new Response(JSON.stringify({ success: false, error: 'Não autorizado.' }), {
        status: 401,
        headers: CORS_HEADERS
      });
    }

    const { state: curState } = await loadState(env);
    curState.hardwareOrders = Array.isArray(curState.hardwareOrders) ? curState.hardwareOrders : [];

    const now = Date.now();
    const orderId = 'ord_' + now + '_' + Math.random().toString(36).slice(2, 6);
    const orderType = body.orderType || 'factory_reset'; // 'factory_reset' (Reset Real: limpa LittleFS + regrava firmware via OTA) ou 'reset' (limpa jogo)

    // SUPERSESSÃO TEMPORAL DE RESET:
    // Se emitimos um reset agora (ex: 3:50), ordens de reset criadas anteriormente (ex: 3:30)
    // são completamente redundantes e obsoletas, pois este novo reset reinicializa todo o estado.
    // Descartamos ordens anteriores de reset da fila para evitar reboots e formatações duplicadas.
    curState.hardwareOrders = curState.hardwareOrders.filter(o => {
      if ((o.type === 'reset' || o.type === 'factory_reset') && o.createdAt <= now) {
        return false;
      }
      return true;
    });

    const order = {
      id: orderId,
      type: orderType,
      target: 'esp',
      createdAt: now,
      description: orderType === 'factory_reset'
        ? 'Reset Real: Limpeza da Flash LittleFS e Regravação de Firmware via OTA'
        : 'Reset Simples de Jogo: Limpeza de variáveis e saldo'
    };

    curState.hardwareOrders.push(order);
    curState.resetPendingEsp = true;
    curState.lastResetOrderAt = now;
    curState.lastUpdate = now;
    curState.lastKvSave = now;
    await saveState(env, curState);

    return new Response(JSON.stringify({
      success: true,
      order,
      queueLength: curState.hardwareOrders.length,
      hardwareOrders: curState.hardwareOrders,
      pendingOrder: curState.hardwareOrders[0],
      topPlayer,
      hardwareOwner,
      resetOrder: true,
      _kv_connected: kvConnected,
      _kv_binding: kvName || 'NONE',
      _kv_diag: diag
    }), {
      status: 200,
      headers: CORS_HEADERS
    });
  }

  // AÇÃO ADMINISTRATIVA: CANCELAR ORDEM PENDENTE NA FILA
  if (action === 'admin_cancel_order') {
    const authHash = String(body.authHash || '').trim().toLowerCase();
    if (authHash !== ADMIN_AUTH_HASH) {
      return new Response(JSON.stringify({ success: false, error: 'Não autorizado.' }), {
        status: 401,
        headers: CORS_HEADERS
      });
    }
    const orderId = body.orderId;
    const { state: curState } = await loadState(env);
    curState.hardwareOrders = (curState.hardwareOrders || []).filter(o => o.id !== orderId);
    if (curState.hardwareOrders.length === 0) {
      curState.resetPendingEsp = false;
    }
    await saveState(env, curState);
    return new Response(JSON.stringify({
      success: true,
      cancelledOrderId: orderId,
      hardwareOrders: curState.hardwareOrders,
      queueLength: curState.hardwareOrders.length,
      _kv_connected: kvConnected
    }), {
      status: 200,
      headers: CORS_HEADERS
    });
  }

  // AÇÃO DE CONFIRMAÇÃO (ACK) DIRETA DE ORDEM PELA ESP8266
  if (action === 'ack_order') {
    const { state: curState } = await loadState(env);
    curState.hardwareOrders = Array.isArray(curState.hardwareOrders) ? curState.hardwareOrders : [];
    const ackOrderId = body.ackOrderId;
    let dequeued = null;

    if (ackOrderId) {
      const idx = curState.hardwareOrders.findIndex(o => o.id === ackOrderId);
      if (idx >= 0) dequeued = curState.hardwareOrders.splice(idx, 1)[0];
    } else if (curState.hardwareOrders.length > 0) {
      dequeued = curState.hardwareOrders.shift();
    }

    const orderTime = dequeued?.createdAt || Date.now();
    curState.lastResetExecutedAt = Math.max(curState.lastResetExecutedAt || 0, orderTime);
    curState.lastResetAckAt = Date.now();

    // Remove também quaisquer ordens antigas remanescentes cujo createdAt <= curState.lastResetExecutedAt
    if (curState.lastResetExecutedAt) {
      curState.hardwareOrders = curState.hardwareOrders.filter(o => o.createdAt > curState.lastResetExecutedAt);
    }

    if (curState.hardwareOrders.length === 0) {
      curState.resetPendingEsp = false;
    }
    curState.lastUpdate = Date.now();
    await saveState(env, curState);

    return new Response(JSON.stringify({
      success: true,
      dequeued,
      queueLength: curState.hardwareOrders.length,
      hardwareOrders: curState.hardwareOrders,
      lastResetExecutedAt: curState.lastResetExecutedAt,
      nextOrder: curState.hardwareOrders[0] || null,
      _kv_connected: kvConnected,
      _kv_binding: kvName || 'NONE'
    }), {
      status: 200,
      headers: CORS_HEADERS
    });
  }

  // -------------------------------------------------------------
  // AÇÃO 4: FLUXO GLOBAL / HARDWARE ESP8266 & RESET
  // -------------------------------------------------------------
  const { state } = await loadState(env);
  const now = Date.now();
  const previousMakitas = state.makitas || 0;
  advancePassiveProduction(state, now);

  let clientMakitas = typeof body.makitas === 'number' ? body.makitas : null;
  let clientTotal = typeof body.totalMakitasMade === 'number' ? body.totalMakitasMade : null;
  let clicks = Math.max(0, Math.min(parseInt(body.clicks || body.count || 0, 10), 5000));

  // Reset total disparado pelo website: adiciona ordem de reset de jogo na fila da ESP
  if (action === 'reset') {
    const resetId = Date.now();
    const orderId = 'ord_' + resetId + '_' + Math.random().toString(36).slice(2, 6);

    state.hardwareOrders = Array.isArray(state.hardwareOrders) ? state.hardwareOrders : [];
    const order = {
      id: orderId,
      type: 'reset',
      target: 'esp',
      createdAt: resetId,
      description: 'Reset de Partida: Limpar saldo e upgrades'
    };
    state.hardwareOrders.push(order);

    state.resetId = resetId;
    state.resetPendingEsp = true;
    state.makitas = 0.0;
    state.totalMakitasMade = 0.0;
    state.owned = {};
    state.perms = {};
    state.mps = 0.0;
    state.clickPower = 1.0;
    state.lastUpdate = resetId;
    state.lastKvSave = resetId;
    await saveState(env, state);
    return new Response(JSON.stringify({
      ...state,
      topPlayer,
      hardwareOwner,
      isReset: true,
      resetOrder: true,
      pendingOrder: state.hardwareOrders[0],
      queueLength: state.hardwareOrders.length,
      hardwareOrders: state.hardwareOrders,
      _kv_connected: kvConnected,
      _kv_binding: kvName || 'NONE',
      _kv_diag: diag
    }), {
      status: 200,
      headers: CORS_HEADERS
    });
  }

  // -------------------------------------------------------------
  // TRATAMENTO EXCLUSIVO DE SINCRONIZAÇÃO DA ESP8266
  // -------------------------------------------------------------
  if (isEsp) {
    state.hardwareOrders = Array.isArray(state.hardwareOrders) ? state.hardwareOrders : [];

    // 1. Processamento de Confirmação (ACK) enviado pela ESP
    const ackOrderId = body.ackOrderId;
    if (ackOrderId || body.resetAck === true) {
      let dequeued = null;
      if (ackOrderId) {
        const found = state.hardwareOrders.find(o => o.id === ackOrderId);
        if (found) dequeued = found;
        state.hardwareOrders = state.hardwareOrders.filter(o => o.id !== ackOrderId);
      } else if (state.hardwareOrders.length > 0) {
        dequeued = state.hardwareOrders.shift();
      }

      const orderTime = dequeued?.createdAt || now;
      state.lastResetExecutedAt = Math.max(state.lastResetExecutedAt || 0, orderTime);
      state.lastResetAckAt = now;

      // Purga quaisquer ordens residuais obsoletas cujo createdAt <= state.lastResetExecutedAt
      if (state.lastResetExecutedAt) {
        state.hardwareOrders = state.hardwareOrders.filter(o => o.createdAt > state.lastResetExecutedAt);
      }

      if (state.hardwareOrders.length === 0) {
        state.resetPendingEsp = false;
      }
      state.makitas = 0.0;
      state.totalMakitasMade = 0.0;
      state.owned = {};
      state.perms = {};
      state.mps = 0.0;
      state.clickPower = 1.0;
      await saveState(env, state);
    }

    state.espTelemetry = {
      lastPing: now,
      fwVersion: typeof body.fwVersion === 'number' ? body.fwVersion : (state.espTelemetry?.fwVersion || 0),
      ip: typeof body.ip === 'string' ? body.ip : (state.espTelemetry?.ip || 'desconhecido'),
      rssi: typeof body.rssi === 'number' ? body.rssi : (state.espTelemetry?.rssi || null),
      uptime: typeof body.uptime === 'number' ? body.uptime : (state.espTelemetry?.uptime || 0),
      freeHeap: typeof body.freeHeap === 'number' ? body.freeHeap : (state.espTelemetry?.freeHeap || 0)
    };

    // 2. Descarta ordens obsoletas da fila cujo createdAt <= state.lastResetExecutedAt
    if (state.lastResetExecutedAt) {
      state.hardwareOrders = state.hardwareOrders.filter(o => o.createdAt > state.lastResetExecutedAt);
    }

    // 3. Se houver ordens latentes pendentes na fila, envia a mais antiga (FIFO) para a ESP
    const activeOrder = state.hardwareOrders.length > 0 ? state.hardwareOrders[0] : null;
    if (activeOrder) {
      await saveState(env, state);
      return new Response(JSON.stringify({
        resetOrder: true,
        pendingOrder: activeOrder,
        lastResetExecutedAt: state.lastResetExecutedAt || 0,
        queueLength: state.hardwareOrders.length,
        topPlayer,
        hardwareOwner,
        _kv_connected: kvConnected,
        _kv_binding: kvName || 'NONE',
        _kv_diag: diag
      }), {
        status: 200,
        headers: CORS_HEADERS
      });
    }

    // Roteamento dinâmico de cliques e dados da ESP8266:
    // Se houver dono ativo do console físico, credita e sincroniza com o perfil do dono.
    // Se não houver dono ativo, credita e sincroniza com o 1º colocado (topPlayer).
    const targetUserId = hardwareOwner.active ? hardwareOwner.userId : topPlayer.id;

    if (targetUserId) {
      let { state: targetState } = await loadUserState(env, targetUserId);
      if (!targetState) {
        targetState = getDefaultState();
      }
      advancePassiveProduction(targetState, now);

      if (clicks > 0) {
        const gainPerClick = getSingleClickGain(targetState.perms, targetState.mps);
        const totalGain = gainPerClick * clicks;
        targetState.makitas = (targetState.makitas || 0) + totalGain;
        targetState.totalMakitasMade = (targetState.totalMakitasMade || 0) + totalGain;
        targetState.lastSavedAt = now;
      }

      await saveUserState(env, targetUserId, targetState);

      const uIdx = usersList.findIndex(u => u.id === targetUserId);
      if (uIdx >= 0) {
        usersList[uIdx].makitas = targetState.makitas;
        usersList[uIdx].totalMakitasMade = targetState.totalMakitasMade;
        usersList[uIdx].lastSavedAt = now;
        await saveUsersList(env, usersList);
      }
      topPlayer = getTopPlayer(usersList);

      state.espTelemetry.activeTargetUserId = targetUserId;
      state.espTelemetry.activeTargetName = hardwareOwner.active ? hardwareOwner.userName : topPlayer.name;
      state.lastUpdate = now;
      await saveState(env, state);

      return new Response(JSON.stringify({
        targetUserId,
        targetUserName: hardwareOwner.active ? hardwareOwner.userName : topPlayer.name,
        makitas: targetState.makitas,
        totalMakitasMade: targetState.totalMakitasMade,
        owned: targetState.owned || {},
        perms: targetState.perms || {},
        mps: targetState.mps || 0,
        clickPower: targetState.clickPower || 1,
        topPlayer,
        hardwareOwner,
        lastResetExecutedAt: state.lastResetExecutedAt || 0,
        resetOrder: false,
        _kv_connected: kvConnected,
        _kv_binding: kvName || 'NONE',
        _kv_diag: diag
      }), {
        status: 200,
        headers: CORS_HEADERS
      });
    }
  }

  // TRATAMENTO DA ORDEM DE RESET LATENTE PARA CLIENTE WEB:
  let espAckReceived = false;
  if (state.resetPendingEsp) {
    clientMakitas = null;
    clientTotal = null;
    clicks = 0;
    body.owned = null;
    body.perms = null;
    state.makitas = 0.0;
    state.totalMakitasMade = 0.0;
  }

  // RECONCILIAÇÃO MONOTÔNICA E CONVERGÊNCIA (CRDT / RATCHET):
  // 1. Saldo e Total: O saldo só pode AUMENTAR. Nunca adota um saldo menor no sync.
  if (clientMakitas !== null) {
    if (clientMakitas > state.makitas) {
      state.makitas = clientMakitas;
    }
    if (clientTotal && clientTotal > (state.totalMakitasMade || 0)) {
      state.totalMakitasMade = clientTotal;
    } else if (state.makitas > (state.totalMakitasMade || 0)) {
      state.totalMakitasMade = state.makitas;
    }
  }

  // Processa cliques pendentes enviados
  if (clicks > 0) {
    const gainPerClick = getSingleClickGain(state.perms, state.mps);
    const totalGain = gainPerClick * clicks;
    state.makitas += totalGain;
    state.totalMakitasMade = (state.totalMakitasMade || 0) + totalGain;
  }

  // 2. Upgrades da Loja: Convergência aditiva — sempre mantém o MAIOR nível de cada oficina
  if (body.owned && typeof body.owned === 'object') {
    state.owned = state.owned || {};
    for (const u of UPGRADES) {
      if (typeof body.owned[u.id] === 'number') {
        state.owned[u.id] = Math.max(state.owned[u.id] || 0, Math.min(MAX_OWNED, body.owned[u.id]));
      }
    }
  }

  // 3. Tecnologias Permanentes: Se qualquer nó ativou uma tecnologia, ela permanece ativa
  if (body.perms && typeof body.perms === 'object') {
    state.perms = state.perms || {};
    for (const p of PERMANENT_UPGRADES) {
      if (body.perms[p.id] === true) {
        state.perms[p.id] = true;
      }
    }
  }

  state.mps = calculateMps(state.owned, state.perms);
  state.clickPower = calculateClickPower(state.perms);

  // AÇÕES DE COMPRA (Web Master para Upgrades):
  if (action === 'buy') {
    const upgradeId = body.upgradeId || body.id;
    const qtyStr = String(body.qty || '1');
    const up = UPGRADES.find(u => u.id === upgradeId);

    if (up) {
      state.owned = state.owned || {};
      const currentOwned = state.owned[up.id] || 0;
      const remaining = MAX_OWNED - currentOwned;

      if (remaining > 0) {
        if (qtyStr === 'max') {
          let count = 0;
          while (count < remaining) {
            const nextCost = unitCost(up, currentOwned + count);
            if (state.makitas < nextCost) break;
            state.makitas -= nextCost;
            count++;
          }
          state.owned[up.id] = currentOwned + count;
        } else {
          const requested = Math.max(1, parseInt(qtyStr, 10) || 1);
          const toBuy = Math.min(requested, remaining);
          let totalCost = 0;
          for (let i = 0; i < toBuy; i++) {
            totalCost += unitCost(up, currentOwned + i);
          }
          if (state.makitas >= totalCost && toBuy > 0) {
            state.makitas -= totalCost;
            state.owned[up.id] = currentOwned + toBuy;
          }
        }
      }
      state.mps = calculateMps(state.owned, state.perms);
      state.clickPower = calculateClickPower(state.perms);
    }
  } else if (action === 'perm_buy') {
    const permId = body.permId || body.id;
    const perm = PERMANENT_UPGRADES.find(p => p.id === permId);

    if (perm) {
      state.perms = state.perms || {};
      const alreadyBought = (state.perms[perm.id] === true);
      const parentBought = !perm.parent || (state.perms[perm.parent] === true);
      const reqMet = (state.totalMakitasMade || state.makitas) >= perm.req;

      if (!alreadyBought && parentBought && reqMet && state.makitas >= perm.cost) {
        state.makitas -= perm.cost;
        state.perms[perm.id] = true;
        state.mps = calculateMps(state.owned, state.perms);
        state.clickPower = calculateClickPower(state.perms);
      }
    }
  }

  state.totalOwned = getTotalOwned(state.owned);
  state.lastUpdate = now;

  // COTA INTELIGENTE DE ESCRITA NO KV (1.000 writes/dia no plano gratuito):
  // Grava imediatamente em compras, reset, cliques ou novos saldos.
  // Em syncs periódicos sem cliques, grava a cada 60 segundos como checkpoint.
  const hasStateChanged = 
    action === 'buy' || 
    action === 'perm_buy' || 
    action === 'reset' ||
    espAckReceived ||
    clicks > 0 ||
    Math.abs(state.makitas - previousMakitas) > 5.0 ||
    (now - (state.lastKvSave || 0) >= 60000);

  if (hasStateChanged) {
    state.lastKvSave = now;
    await saveState(env, state);
  }

  return new Response(JSON.stringify({
    ...state,
    topPlayer,
    hardwareOwner,
    resetOrder: state.resetPendingEsp === true,
    _kv_connected: kvConnected,
    _kv_binding: kvName || 'NONE',
    _kv_diag: diag
  }), {
    status: 200,
    headers: CORS_HEADERS
  });
}
