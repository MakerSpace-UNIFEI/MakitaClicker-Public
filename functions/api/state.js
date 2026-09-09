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

  // 2. Checagem no Cloudflare D1
  const db = getD1(env);
  if (db) {
    try {
      await ensureD1Tables(db);
      const row = await db.prepare('SELECT banned_until, reason FROM ip_bans WHERE ip = ?').bind(ip).first();
      if (row && row.banned_until > now) {
        memoryBannedIps.set(ip, { bannedAt: now, expiresAt: row.banned_until, reason: row.reason, ip });
        const remainingSec = Math.ceil((row.banned_until - now) / 1000);
        return { banned: true, remainingSec, banExpiresAt: row.banned_until, reason: row.reason };
      }
    } catch (e) {}
  }

  // 3. Checagem no Cloudflare KV
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

  // 1. Grava no Cloudflare D1
  const db = getD1(env);
  if (db) {
    try {
      await ensureD1Tables(db);
      await db.prepare('INSERT OR REPLACE INTO ip_bans (ip, banned_until, reason) VALUES (?, ?, ?)')
        .bind(ip, expiresAt, reason).run();
    } catch (e) {
      console.error(`[ANTI-CLICKER] Erro ao gravar banimento do IP ${ip} no D1:`, e);
    }
  }

  // 2. Grava no Cloudflare KV como backup
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
    if (key === 'ASSETS') continue;
    if (val && typeof val.get === 'function' && typeof val.put === 'function') {
      return { kv: val, name: key, kvName: key, kvConnected: true, diag: `KV detectado via binding alternativo: '${key}'` };
    }
  }

  const keys = Object.keys(env).filter(k => k !== 'ASSETS');
  const makitaType = typeof env.MAKITA_KV;
  let diag = '';
  if (makitaType === 'string') {
    diag = "Atenção: MAKITA_KV está definida como STRING. No Pages, deve ser vinculada em Settings > Functions > KV namespace bindings.";
  } else if (makitaType === 'undefined') {
    diag = keys.length === 0 ? "Nenhum binding ou variável foi injetado neste deploy." : `Binding MAKITA_KV não encontrado em env (chaves presentes: [${keys.join(', ')}]).`;
  } else {
    diag = `MAKITA_KV está presente como '${makitaType}', mas não possui os métodos esperados (.get / .put).`;
  }
  return { kv: null, name: null, kvName: null, kvConnected: false, diag };
}

function getD1(env) {
  if (!env) return null;
  if (env.DB && typeof env.DB.prepare === 'function') {
    return env.DB;
  }
  for (const [key, val] of Object.entries(env)) {
    if (key === 'ASSETS') continue;
    if (val && typeof val.prepare === 'function') {
      return val;
    }
  }
  return null;
}

let d1TablesChecked = false;
async function ensureD1Tables(db) {
  if (d1TablesChecked || !db) return;
  try {
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_saved_at INTEGER NOT NULL,
        makitas REAL DEFAULT 0,
        total_makitas_made REAL DEFAULT 0
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS user_states (
        user_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        save_rev INTEGER DEFAULT 0,
        reset_epoch INTEGER DEFAULT 0,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS hardware_lease (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        user_id TEXT,
        user_name TEXT,
        claimed_at INTEGER,
        expires_at INTEGER,
        lease_id INTEGER DEFAULT 0
      )`),
      db.prepare(`INSERT OR IGNORE INTO hardware_lease (id, user_id, user_name, claimed_at, expires_at, lease_id)
        VALUES (1, NULL, 'Maker', 0, 0, 0)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS ip_bans (
        ip TEXT PRIMARY KEY,
        banned_until INTEGER NOT NULL,
        reason TEXT
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_users_total_makitas ON users(total_makitas_made DESC)`)
    ]);
    d1TablesChecked = true;
  } catch (e) {
    console.warn('[D1] Verificação de tabelas D1:', e);
  }
}

// Produção passiva autoritativa baseada no delta de tempo com teto offline de 24h.
function advancePassiveProduction(state, now) {
  const last = Number(state.lastUpdate) || Number(state.lastSavedAt) || now;
  const rawDt = Math.max(0, (now - last) / 1000.0);
  const dt = Math.min(86400, rawDt); // Limite máximo de 24 horas (86.400s)
  const calculatedMps = calculateMps(state.owned, state.perms);
  if ((!state.mps || state.mps <= 0) && calculatedMps > 0) {
    state.mps = calculatedMps;
  }
  const currentMps = state.mps || calculatedMps || 0;
  if (dt > 0 && currentMps > 0) {
    const gain = currentMps * dt;
    state.makitas = (state.makitas || 0) + gain;
    state.totalMakitasMade = (state.totalMakitasMade || 0) + gain;

    if (dt >= 15 && gain >= 0.1) {
      state.offlineGain = (state.offlineGain || 0) + gain;
      state.offlineSeconds = (state.offlineSeconds || 0) + dt;
      state.offlineMps = currentMps;
      state.offlineWasCapped = rawDt > 86400;
    }
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

// Desambiguação de nomes duplicados: mantém o nome original para o perfil mais antigo
// e sufixa 2, 3, 4 etc para perfis mais recentes criados com mesmo nome, respeitando o limite de 16 caracteres do LCD
function deduplicateUserNames(list) {
  if (!Array.isArray(list) || list.length === 0) return { list: [], changed: false };

  // 1. Ordena cronologicamente por createdAt ascendente (mais antigo tem prioridade)
  const sorted = [...list].sort((a, b) => {
    const timeA = Number(a.createdAt) || 0;
    const timeB = Number(b.createdAt) || 0;
    if (timeA !== timeB) return timeA - timeB;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });

  const usedNames = new Set();
  let changed = false;

  for (const user of sorted) {
    if (!user || !user.id) continue;
    const originalName = sanitizeNick(user.name || 'Maker');

    // Extrai a raiz sem sufixo numérico trailing (ex: "Pedro 2" -> raiz "Pedro")
    const match = originalName.match(/^(.*?)(?:\s+(\d+))?$/);
    const rootName = (match && match[1] && match[1].trim()) ? match[1].trim() : originalName;

    let candidate = originalName;
    let count = 1;

    // Se já estiver em uso por outro usuário criado anteriormente, incrementa sufixo
    while (usedNames.has(candidate.toLowerCase())) {
      count++;
      const suffix = ` ${count}`;
      const maxBaseLen = 16 - suffix.length;
      const truncatedRoot = rootName.slice(0, Math.max(1, maxBaseLen)).trim();
      candidate = (truncatedRoot + suffix).slice(0, 16);
    }

    if (candidate !== user.name) {
      user.name = candidate;
      changed = true;
    }
    usedNames.add(candidate.toLowerCase());
  }

  return { list: sorted, changed };
}

async function saveUserMeta(env, userEntry) {
  if (!userEntry || !userEntry.id) return;
  const db = getD1(env);
  if (db) {
    try {
      await ensureD1Tables(db);
      await db.prepare(`
        INSERT OR REPLACE INTO users (id, name, created_at, last_saved_at, makitas, total_makitas_made)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        userEntry.id,
        userEntry.name || 'Maker',
        userEntry.createdAt || Date.now(),
        userEntry.lastSavedAt || Date.now(),
        Number(userEntry.makitas) || 0,
        Number(userEntry.totalMakitasMade) || 0
      ).run();
    } catch (err) {
      console.error(`[D1] Erro ao gravar usuário no D1:`, err);
    }
  }

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
  const db = getD1(env);
  if (db) {
    try {
      await ensureD1Tables(db);
      const { results } = await db.prepare(
        'SELECT id, name, created_at as createdAt, last_saved_at as lastSavedAt, makitas, total_makitas_made as totalMakitasMade FROM users ORDER BY total_makitas_made DESC LIMIT 100'
      ).all();

      if (results && results.length > 0) {
        const { list: deduped, changed } = deduplicateUserNames(results);
        if (changed) {
          console.log('[DEDUP] Nomes duplicados desambiguados no D1.');
          await saveUsersList(env, deduped);
        }
        memoryFallbackUsers = deduped;
        return deduped;
      }

      // Se o D1 estiver vazio mas houver dados no KV, migra automaticamente do KV para o D1!
      const { kv } = getKV(env);
      if (kv) {
        const kvUsers = await kv.get(USERS_LIST_KEY, { type: 'json' }).catch(() => null);
        if (Array.isArray(kvUsers) && kvUsers.length > 0) {
          console.log(`[D1 MIGRATION] Migrando ${kvUsers.length} usuários do KV para o D1...`);
          for (const u of kvUsers) {
            if (u && u.id) {
              await db.prepare(
                'INSERT OR REPLACE INTO users (id, name, created_at, last_saved_at, makitas, total_makitas_made) VALUES (?, ?, ?, ?, ?, ?)'
              ).bind(
                u.id,
                u.name || 'Maker',
                u.createdAt || Date.now(),
                u.lastSavedAt || Date.now(),
                Number(u.makitas) || 0,
                Number(u.totalMakitasMade) || 0
              ).run().catch(() => {});
            }
          }
          memoryFallbackUsers = kvUsers;
          return kvUsers;
        }
      }
    } catch (err) {
      console.error('[D1] Erro ao carregar usuários:', err);
    }
  }

  // Fallback para KV
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

  const map = new Map();
  if (Array.isArray(kvUsers)) {
    kvUsers.forEach(u => { if (u && u.id) map.set(u.id, u); });
  }

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
  const { list: deduped, changed } = deduplicateUserNames(merged);
  if (changed) {
    await saveUsersList(env, deduped);
  }
  memoryFallbackUsers = deduped;
  return deduped;
}

async function saveUsersList(env, list) {
  const db = getD1(env);
  if (db && Array.isArray(list)) {
    try {
      await ensureD1Tables(db);
      for (const u of list) {
        if (u && u.id) {
          await db.prepare(
            'INSERT OR REPLACE INTO users (id, name, created_at, last_saved_at, makitas, total_makitas_made) VALUES (?, ?, ?, ?, ?, ?)'
          ).bind(
            u.id,
            u.name || 'Maker',
            u.createdAt || Date.now(),
            u.lastSavedAt || Date.now(),
            Number(u.makitas) || 0,
            Number(u.totalMakitasMade) || 0
          ).run().catch(() => {});
        }
      }
    } catch (err) {
      console.error('[D1] Erro ao sincronizar usersList no D1:', err);
    }
  }

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
  if (!userId) {
    return { state: getDefaultState(), isNew: true, kvName: 'none', kvConnected: false, diag: 'Sem userId' };
  }

  const db = getD1(env);
  if (db) {
    try {
      await ensureD1Tables(db);
      const row = await db.prepare(
        'SELECT state_json, save_rev, reset_epoch, updated_at FROM user_states WHERE user_id = ?'
      ).bind(userId).first();

      if (row && row.state_json) {
        const parsed = expandUserState(JSON.parse(row.state_json));
        parsed.saveRev = row.save_rev || parsed.saveRev || 0;
        parsed.resetEpoch = row.reset_epoch || parsed.resetEpoch || 0;
        return { state: parsed, isNew: false, kvName: 'D1', kvConnected: true, kvDiag: 'Carregado do Cloudflare D1' };
      }

      // Migração sob demanda do KV para D1:
      const { kv } = getKV(env);
      if (kv) {
        const kvRaw = await kv.get(getUserStateKey(userId), { type: 'json' }).catch(() => null);
        if (kvRaw) {
          const parsed = expandUserState(kvRaw);
          await saveUserState(env, userId, parsed);
          return { state: parsed, isNew: false, kvName: 'KV->D1', kvConnected: true, kvDiag: 'Migrado do KV para o D1' };
        }
      }
    } catch (e) {
      console.error('[D1] Erro ao ler estado do usuário:', e);
    }
  }

  // Fallback para KV
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
  const isFound = !!(kvState || memState);
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

  return { state, isNew: !isFound, kvName: name, kvConnected: !!kv, kvDiag: diag };
}

async function saveUserState(env, userId, state, userName = null) {
  const currentMem = memoryFallbackUserStates[userId];
  if (currentMem) {
    const memReset = currentMem.resetEpoch || 0;
    const stateReset = state.resetEpoch || 0;
    if (memReset > stateReset) {
      return;
    }
  }

  const compact = compactUserState(state);
  const stateJson = JSON.stringify(compact);
  const saveRev = Number(state.saveRev) || 0;
  const resetEpoch = Number(state.resetEpoch) || 0;
  const now = Date.now();
  const resolvedName = sanitizeNick(userName || state.name || 'Maker');
  const createdAt = Number(state.createdAt) || now;

  const db = getD1(env);
  if (db) {
    try {
      await ensureD1Tables(db);
      await db.batch([
        db.prepare(`
          INSERT INTO users (id, name, created_at, last_saved_at, makitas, total_makitas_made)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = CASE WHEN excluded.name != '' AND excluded.name != 'Maker' THEN excluded.name ELSE users.name END,
            last_saved_at = excluded.last_saved_at,
            makitas = excluded.makitas,
            total_makitas_made = excluded.total_makitas_made
        `).bind(userId, resolvedName, createdAt, now, Number(state.makitas) || 0, Number(state.totalMakitasMade) || 0),
        db.prepare(`
          INSERT INTO user_states (user_id, state_json, save_rev, reset_epoch, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET
            state_json = excluded.state_json,
            save_rev = excluded.save_rev,
            reset_epoch = excluded.reset_epoch,
            updated_at = excluded.updated_at
        `).bind(userId, stateJson, saveRev, resetEpoch, now)
      ]);
    } catch (e) {
      console.error('[D1] Erro ao salvar estado:', e);
    }
  }

  // Backup no KV
  const { kv } = getKV(env);
  if (kv) {
    try {
      await kv.put(getUserStateKey(userId), stateJson);
      await kv.put(`user_meta:${userId}`, JSON.stringify({
        id: userId,
        name: resolvedName,
        createdAt,
        lastSavedAt: now,
        makitas: Number(state.makitas) || 0,
        totalMakitasMade: Number(state.totalMakitasMade) || 0
      }));
    } catch (err) {
      console.error(`[KV] Erro ao salvar estado do usuário ${userId}:`, err);
    }
  }
  memoryFallbackUserStates[userId] = state;
}

async function deleteUserState(env, userId) {
  const db = getD1(env);
  if (db) {
    try {
      await ensureD1Tables(db);
      await db.batch([
        db.prepare('DELETE FROM users WHERE id = ?').bind(userId),
        db.prepare('DELETE FROM user_states WHERE user_id = ?').bind(userId)
      ]);
    } catch (e) {}
  }

  const { kv } = getKV(env);
  if (kv) {
    try {
      await kv.delete(getUserStateKey(userId));
      await kv.delete(`user_meta:${userId}`);
    } catch (err) {}
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
  const db = getD1(env);
  const now = Date.now();

  if (db) {
    try {
      await ensureD1Tables(db);
      const row = await db.prepare(
        'SELECT user_id, user_name, claimed_at, expires_at, lease_id FROM hardware_lease WHERE id = 1'
      ).first();

      if (row) {
        const expiresAt = row.expires_at || 0;
        const isUnexpired = expiresAt > now;
        if (row.user_id && isUnexpired) {
          const leaseObj = {
            active: true,
            userId: row.user_id,
            userName: row.user_name || 'Maker',
            claimedAt: row.claimed_at || 0,
            expiresAt,
            leaseId: row.lease_id || 0,
            remainingSec: Math.max(0, Math.ceil((expiresAt - now) / 1000))
          };
          memoryFallbackHardwareLease = leaseObj;
          return leaseObj;
        } else {
          const expiredObj = {
            active: false,
            userId: null,
            userName: null,
            claimedAt: row.claimed_at || 0,
            releasedAt: row.expires_at || 0,
            expiresAt: 0,
            leaseId: row.lease_id || 0,
            remainingSec: 0
          };
          memoryFallbackHardwareLease = expiredObj;
          return expiredObj;
        }
      }
    } catch (e) {
      console.error('[D1] Erro ao ler hardware lease:', e);
    }
  }

  // Fallback para KV
  const { kv } = getKV(env);
  let kvLease = null;
  if (kv) {
    try {
      kvLease = await kv.get(HARDWARE_LEASE_KEY, { type: 'json' });
    } catch (err) {
      console.error('[KV] Erro ao ler hardware lease:', err);
    }
  }

  let lease = kvLease;
  if (memoryFallbackHardwareLease) {
    const memTimestamp = Math.max(memoryFallbackHardwareLease.claimedAt || 0, memoryFallbackHardwareLease.releasedAt || 0);
    const kvTimestamp = Math.max(kvLease?.claimedAt || 0, kvLease?.releasedAt || 0);
    if (memTimestamp >= kvTimestamp) {
      lease = memoryFallbackHardwareLease;
    }
  }

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
  if (currentMem && lease) {
    const curTime = Math.max(currentMem.claimedAt || 0, currentMem.releasedAt || 0);
    const newTime = Math.max(lease.claimedAt || 0, lease.releasedAt || 0);
    if (curTime > newTime) return;
  }

  const db = getD1(env);
  if (db) {
    try {
      await ensureD1Tables(db);
      if (lease && lease.userId) {
        await db.prepare(`
          INSERT OR REPLACE INTO hardware_lease (id, user_id, user_name, claimed_at, expires_at, lease_id)
          VALUES (1, ?, ?, ?, ?, ?)
        `).bind(
          lease.userId,
          lease.userName || 'Maker',
          lease.claimedAt || 0,
          lease.expiresAt || 0,
          lease.leaseId || 0
        ).run();
      } else {
        await db.prepare(`
          INSERT OR REPLACE INTO hardware_lease (id, user_id, user_name, claimed_at, expires_at, lease_id)
          VALUES (1, NULL, NULL, 0, 0, 0)
        `).run();
      }
    } catch (e) {
      console.error('[D1] Erro ao salvar hardware lease:', e);
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
  const clientMakitas = Number(url.searchParams.get('clientMakitas')) || 0;
  const clientTotalMakitas = Number(url.searchParams.get('clientTotalMakitas')) || clientMakitas;

  const { kvName, kvConnected, diag } = getKV(env);
  const db = getD1(env);
  const storageType = (db && kvConnected) ? 'D1+KV (Dual-Engine)' : (db ? 'D1 (Primary)' : (kvConnected ? 'KV (Primary)' : 'Memory'));
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
        name: sanitizeNick(clientUserName || uState.name || 'Maker'),
        createdAt: uState.createdAt || Date.now(),
        lastSavedAt: uState.lastSavedAt || Date.now(),
        makitas: Math.max(Number(uState.makitas) || 0, clientMakitas),
        totalMakitasMade: Math.max(Number(uState.totalMakitasMade) || Number(uState.makitas) || 0, clientTotalMakitas)
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
      _storage: storageType,
      _d1_connected: !!db,
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
    const { state, isNew } = await loadUserState(env, userId);
    const now = Date.now();
    advancePassiveProduction(state, now);

    return new Response(JSON.stringify({
      ...state,
      userFound: !isNew,
      isNewUser: !!isNew,
      topPlayer,
      hardwareOwner,
      _storage: storageType,
      _d1_connected: !!db,
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
      _storage: storageType,
      _d1_connected: !!db,
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
  const db = getD1(env);
  const storageType = (db && kvConnected) ? 'D1+KV (Dual-Engine)' : (db ? 'D1 (Primary)' : (kvConnected ? 'KV (Primary)' : 'Memory'));

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
      _storage: storageType,
      _d1_connected: !!db,
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
      _storage: storageType,
      _d1_connected: !!db,
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
      hardwareOwner: { active: false, userId: null, userName: null, releasedAt: Date.now(), expiresAt: 0, remainingSec: 0 },
      topPlayer,
      _storage: storageType,
      _d1_connected: !!db,
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
    const rawName = sanitizeNick(body.name);
    const now = Date.now();
    const userId = 'u_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 6);

    const newUserEntry = {
      id: userId,
      name: rawName,
      createdAt: now,
      lastSavedAt: now,
      makitas: 0,
      totalMakitasMade: 0
    };

    // Desambiguação automática de nomes duplicados baseada em tempo de criação:
    usersList.push(newUserEntry);
    const { list: dedupedList } = deduplicateUserNames(usersList);
    usersList = dedupedList;
    const finalUser = usersList.find(u => u.id === userId) || newUserEntry;

    const initialState = getDefaultState();
    initialState.name = finalUser.name;
    await saveUserState(env, userId, initialState, finalUser.name);
    await saveUserMeta(env, finalUser);
    await saveUsersList(env, usersList);
    topPlayer = getTopPlayer(usersList);

    return new Response(JSON.stringify({
      success: true,
      user: finalUser,
      state: initialState,
      topPlayer,
      hardwareOwner,
      _storage: storageType,
      _d1_connected: !!db,
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
        _storage: storageType,
      _d1_connected: !!db,
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

    // Atualiza resumo no users:list para ranking
    const userIndex = usersList.findIndex(u => u.id === userId);
    let resolvedName = sanitizeNick(body.userName || body.name || (userIndex >= 0 ? usersList[userIndex].name : 'Maker'));
    let isNewUserInList = false;
    const createdAt = Number(body.createdAt || (userIndex >= 0 ? usersList[userIndex].createdAt : currentState?.createdAt)) || now;
    const userEntry = {
      id: userId,
      name: resolvedName,
      createdAt,
      lastSavedAt: now,
      makitas: expanded.makitas,
      totalMakitasMade: expanded.totalMakitasMade
    };

    if (userIndex >= 0) {
      usersList[userIndex].lastSavedAt = now;
      usersList[userIndex].makitas = expanded.makitas;
      usersList[userIndex].totalMakitasMade = expanded.totalMakitasMade;
      if (body.userName) usersList[userIndex].name = resolvedName;
    } else {
      isNewUserInList = true;
      usersList.push(userEntry);
    }

    // Desambiguação de nomes duplicados baseada em tempo de criação (createdAt)
    const { list: dedupedUsers, changed: dedupChanged } = deduplicateUserNames(usersList);
    usersList = dedupedUsers;
    const updatedUser = usersList.find(u => u.id === userId);
    if (updatedUser) {
      resolvedName = updatedUser.name;
      userEntry.name = resolvedName;
    }

    expanded.name = resolvedName;
    await saveUserState(env, userId, expanded, resolvedName);

    // Economia estrita de cota KV: só grava USERS_LIST_KEY se for novo usuário, renomeado ou superou o líder
    const isNewLeader = expanded.totalMakitasMade > (topPlayer?.totalMakitasMade || 0);
    if (isNewUserInList || dedupChanged || isNewLeader) {
      await saveUsersList(env, usersList);
      await saveUserMeta(env, userEntry);
    }
    topPlayer = getTopPlayer(usersList);

    return new Response(JSON.stringify({
      success: true,
      lastSavedAt: now,
      saveRev: expanded.saveRev,
      state: expanded,
      topPlayer,
      hardwareOwner,
      _storage: storageType,
      _d1_connected: !!db,
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
      _storage: storageType,
      _d1_connected: !!db,
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
      _storage: storageType,
      _d1_connected: !!db,
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
      _storage: storageType,
      _d1_connected: !!db,
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
      _storage: storageType,
      _d1_connected: !!db,
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
      _storage: storageType,
      _d1_connected: !!db,
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
      _storage: storageType,
      _d1_connected: !!db,
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
      _storage: storageType,
      _d1_connected: !!db,
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
        topPlayer: {
          id: topPlayer?.id || '',
          name: topPlayer?.name || 'MakerSpace',
          makitas: topPlayer?.makitas || 0
        },
        hardwareOwner: {
          active: !!hardwareOwner?.active,
          userId: hardwareOwner?.userId || null,
          userName: hardwareOwner?.userName || null,
          claimedAt: hardwareOwner?.claimedAt || 0,
          remainingSec: hardwareOwner?.remainingSec || 0
        }
      }), {
        status: 200,
        headers: CORS_HEADERS
      });
    }

    // Roteamento dinâmico de cliques e dados da ESP8266:
    // Se houver dono ativo do console físico, credita e sincroniza com o perfil do dono.
    // Se não houver dono ativo, credita e sincroniza com o 1º colocado (topPlayer).
    const targetUserId = (hardwareOwner && hardwareOwner.active && hardwareOwner.userId) 
      ? hardwareOwner.userId 
      : (topPlayer?.id || (usersList.length > 0 ? usersList[0].id : null));

    let targetState = null;
    if (targetUserId) {
      const loaded = await loadUserState(env, targetUserId);
      targetState = loaded.state;
    }
    if (!targetState) {
      targetState = getDefaultState();
    }
    advancePassiveProduction(targetState, now);

    if (clicks > 0 && targetUserId) {
      const gainPerClick = getSingleClickGain(targetState.perms, targetState.mps);
      const totalGain = gainPerClick * clicks;
      targetState.makitas = (targetState.makitas || 0) + totalGain;
      targetState.totalMakitasMade = (targetState.totalMakitasMade || 0) + totalGain;
      targetState.lastSavedAt = now;
      await saveUserState(env, targetUserId, targetState);

      const uIdx = usersList.findIndex(u => u.id === targetUserId);
      if (uIdx >= 0) {
        usersList[uIdx].makitas = targetState.makitas;
        usersList[uIdx].totalMakitasMade = targetState.totalMakitasMade;
        usersList[uIdx].lastSavedAt = now;
        await saveUsersList(env, usersList);
      }
      topPlayer = getTopPlayer(usersList);
    }

    const resolvedTargetName = (hardwareOwner && hardwareOwner.active && hardwareOwner.userName) 
      ? hardwareOwner.userName 
      : (topPlayer?.name || 'MakerSpace');

    state.espTelemetry.activeTargetUserId = targetUserId || '';
    state.espTelemetry.activeTargetName = resolvedTargetName;
    state.lastUpdate = now;
    await saveState(env, state);

    // Resposta compacta e leve para o ESP8266 (elimina engasgos e cabe perfeitamente no buffer RX TLS)
    return new Response(JSON.stringify({
      targetUserId: targetUserId || '',
      targetUserName: resolvedTargetName,
      makitas: targetState.makitas || 0,
      totalMakitasMade: targetState.totalMakitasMade || 0,
      owned: targetState.owned || {},
      perms: targetState.perms || {},
      mps: targetState.mps || 0,
      clickPower: targetState.clickPower || 1,
      topPlayer: {
        id: topPlayer?.id || '',
        name: topPlayer?.name || 'MakerSpace',
        makitas: topPlayer?.makitas || 0,
        totalMakitasMade: topPlayer?.totalMakitasMade || 0
      },
      hardwareOwner: {
        active: !!hardwareOwner?.active,
        userId: hardwareOwner?.userId || null,
        userName: hardwareOwner?.userName || null,
        claimedAt: hardwareOwner?.claimedAt || 0,
        remainingSec: hardwareOwner?.remainingSec || 0
      },
      lastResetExecutedAt: state.lastResetExecutedAt || 0,
      resetOrder: false
    }), {
      status: 200,
      headers: CORS_HEADERS
    });
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
