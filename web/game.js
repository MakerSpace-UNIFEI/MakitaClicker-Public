import gameConfig from './game-config.json';

// =====================================================================
// MAKITA CLICKER - MOTOR DE JOGO (RENDERIZAÇÃO NATIVA) + SYNC COM NUVEM
// Sistema de Perfis de Usuário + Cloudflare KV + LocalStorage
// Loja e Árvore de Habilidades derivadas de game-config.json
// =====================================================================

let isLocalMode = false;
let pendingClicks = 0;
let serverClickPower = 1.0;

// ---------- PERFIL ATIVO & CONTROLE DE SALVAMENTO ----------
let currentUserId = null;
let currentUserName = null;
let currentUserCreatedAt = null;
let lastCloudSaveTime = 0;
let lastLocalSaveTime = 0;
let currentResetEpoch = 0;
let currentSaveRev = 1;
let hasUnsavedChanges = false;
let totalClicks = 0;
const sessionStartTime = Date.now();
let latestTopPlayer = null;
let latestHardwareOwner = null;

// ---------- CONSTANTES CONFIGURÁVEIS (DO GAME-CONFIG.JSON) ----------
const MAX_OWNED = gameConfig.meta?.maxOwnedPerUpgrade || 100;
const GOAL_MAKITAS = gameConfig.meta?.goalMakitas || 99000000000;

// ---------- ESTADO DO JOGO ----------
let makitas = 0;
let mps = 0;
let buyQty = 1;

// Total de makitas acumuladas no histórico
let totalMakitasMade = 0;
let prevMakitas = 0;

// Controle de Renderização Otimizada
let isDirty = true;
let lastThrottledRender = 0;
const THROTTLE_RENDER_MS = 150; // Atualiza estados de botões/árvore com cadência suave

// ---------- OFICINAS DA LOJA (DERIVADAS DO GAME-CONFIG.JSON) ----------
const upgrades = (gameConfig.upgrades || []).map(u => ({
    id: u.id,
    name: u.name,
    icon: u.icon || '⚙️',
    baseCost: Number(u.baseCost) || 10,
    growth: Number(u.growth) || 1.15,
    mps: Number(u.mps) || 0
}));

const owned = {};
upgrades.forEach(u => { owned[u.id] = 0; });

// ---------- ÁRVORE DE HABILIDADES PERMANENTES (DERIVADA DO GAME-CONFIG.JSON) ----------
const permanentUpgrades = (gameConfig.skillTree || gameConfig.permanentUpgrades || []).map(p => ({
    id: p.id,
    name: p.name,
    icon: p.icon || '⚡',
    cost: Number(p.cost) || 0,
    reqMakitas: Number(p.reqMakitas ?? p.req ?? 0),
    reqUpgrade: p.reqUpgrade ?? p.parent ?? null,
    desc: p.desc || '',
    effects: p.effects || {},
    purchased: false
}));

// Dicionário para busca O(1) de melhorias permanentes (elimina .find() repetitivo)
const permById = {};
permanentUpgrades.forEach(p => { permById[p.id] = p; });

// ---------- elementos ----------
const counterEl = document.getElementById('counter');
const rateEl = document.getElementById('rate');
const makitaBtn = document.getElementById('makitaBtn');
const clickArea = document.getElementById('clickArea');
const shopListEl = document.getElementById('shopList');
const shopQtyEl = document.getElementById('shopQty');
const logEl = document.getElementById('log');
const permTreeGridEl = document.getElementById('permTreeGrid');

// Elementos de estatísticas
const statMakitasEl = document.getElementById('statMakitas');
const statTotalMakitasEl = document.getElementById('statTotalMakitas');
const statMpsEl = document.getElementById('statMps');
const statClickPowerEl = document.getElementById('statClickPower');
const statPermCountEl = document.getElementById('statPermCount');
const goalPercentTextEl = document.getElementById('goalPercentText');
const goalProgressBarEl = document.getElementById('goalProgressBar');
const goalStatusMsgEl = document.getElementById('goalStatusMsg');

const statProfileNameEl = document.getElementById('statProfileName');
const statCloudStatusEl = document.getElementById('statCloudStatus');
const statLastSaveEl = document.getElementById('statLastSave');
const statCreatedAtEl = document.getElementById('statCreatedAt');
const statSessionTimeEl = document.getElementById('statSessionTime');
const statTopPlayerLeaderEl = document.getElementById('statTopPlayerLeader');
const statGoalProgressEl = document.getElementById('statGoalProgress');
const statTotalClicksEl = document.getElementById('statTotalClicks');
const statTotalOwnedEl = document.getElementById('statTotalOwned');

// ---------- ELEMENTOS EXCLUSIVOS MOBILE ----------
const gameContainerEl = document.getElementById('gameContainer');
const mobileCounterEl = document.getElementById('mobileCounter');
const mobileRateEl = document.getElementById('mobileRate');
const mobileProfileNameEl = document.getElementById('mobileProfileName');
const btnMobileProfileEl = document.getElementById('btnMobileProfile');
const btnMobileSaveEl = document.getElementById('btnMobileSave');
const mobileSaveIconEl = document.getElementById('mobileSaveIcon');
const mobileQuickClickPowerEl = document.getElementById('mobileQuickClickPower');
const mobileQuickGoalEl = document.getElementById('mobileQuickGoal');
const mobileNavBtns = document.querySelectorAll('.mobile-nav-btn');

// ---------- CONTROLE DE ABAS & VIEWS MOBILE ----------
const tabBtns = document.querySelectorAll('.center-nav .navbtn');

function activateTab(targetTab) {
    tabBtns.forEach(b => b.classList.toggle('is-active', b.dataset.tab === targetTab));
    document.querySelectorAll('.tab-pane').forEach(pane => {
        pane.classList.toggle('is-active', pane.id === targetTab);
    });
    isDirty = true;
    if (targetTab === 'tab-ranking') {
        fetchRanking();
    }
}

tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        activateTab(btn.dataset.tab);
    });
});

function setMobileView(viewName) {
    if (!gameContainerEl) return;
    gameContainerEl.dataset.activeView = viewName;
    mobileNavBtns.forEach(b => b.classList.toggle('is-active', b.dataset.mobileView === viewName));

    if (viewName === 'perms') {
        activateTab('tab-perm');
    } else if (viewName === 'ranking') {
        activateTab('tab-ranking');
    } else if (viewName === 'status') {
        activateTab('tab-status');
    }
    isDirty = true;
    renderUI();
}

mobileNavBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        setMobileView(btn.dataset.mobileView);
    });
});

// Botão Atualizar do ranking (wired early para ser capturado mesmo antes do initGame)
const _btnRefreshRanking = document.getElementById('btnRefreshRanking');
if (_btnRefreshRanking) {
    _btnRefreshRanking.addEventListener('click', () => fetchRanking());
}

// ---------- PERSISTÊNCIA LOCAL (LOCALSTORAGE + BACKUP + COOKIES) ----------
function getLocalStorageKey() {
    return currentUserId ? `makitaclicker_save_${currentUserId}` : 'makitaclicker_save';
}

// Persistência em Cookie de redundância (protege contra limpeza do localStorage)
function saveToCookie(userId, saveObj) {
    if (!userId || !saveObj) return;
    try {
        const compactCookie = {
            m: Math.round((Number(saveObj.makitas) || 0) * 10) / 10,
            t: Math.round((Number(saveObj.totalMakitasMade) || 0) * 10) / 10,
            c: saveObj.totalClicks || 0,
            u: saveObj.upgrades || [],
            p: saveObj.perms || [],
            e: saveObj.resetEpoch || 0,
            r: saveObj.saveRev || 1,
            ts: saveObj.lastSavedAt || Date.now()
        };
        const jsonStr = JSON.stringify(compactCookie);
        const cookieVal = encodeURIComponent(jsonStr);
        document.cookie = `makita_ck_${userId}=${cookieVal}; path=/; max-age=31536000; SameSite=Lax`;
    } catch (e) {}
}

function loadFromCookie(userId) {
    if (!userId) return null;
    try {
        const name = `makita_ck_${userId}=`;
        const decodedCookie = decodeURIComponent(document.cookie || '');
        const parts = decodedCookie.split(';');
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i].trim();
            if (part.indexOf(name) === 0) {
                const jsonStr = part.substring(name.length);
                const p = JSON.parse(jsonStr);
                return {
                    makitas: p.m || 0,
                    totalMakitasMade: p.t || 0,
                    totalClicks: p.c || 0,
                    upgrades: p.u || [],
                    perms: p.p || [],
                    resetEpoch: p.e || 0,
                    saveRev: p.r || 1,
                    lastSavedAt: p.ts || 0,
                    lastUpdate: p.ts || 0
                };
            }
        }
    } catch (e) {}
    return null;
}

function clearCookie(userId) {
    if (!userId) return;
    try {
        document.cookie = `makita_ck_${userId}=; path=/; max-age=0; SameSite=Lax`;
    } catch (e) {}
}

// Custo total cumulativo de N unidades de uma oficina (soma da progressão geométrica de custos)
function calculateCumulativeUpgradeCost(upgrade, count) {
    if (!count || count <= 0) return 0;
    let sum = 0;
    for (let i = 0; i < count; i++) {
        sum += Math.ceil(upgrade.baseCost * Math.pow(upgrade.growth, i));
    }
    return sum;
}

// Patrimônio Líquido Acumulado Total:
// Mede a verdadeira quantidade de valor gerado pelo jogador,
// somando o saldo atual de makitas + tudo o que foi investido em oficinas + tudo o que foi investido em habilidades.
// Isso impede que um jogador que acabou de gastar makitas comprando upgrades pareça ter "menos progresso" que uma versão antiga.
function calculateTotalProgressScore(stateObj) {
    if (!stateObj) return 0;
    const currentMkt = Number(stateObj.makitas) || 0;
    const totalMade = Number(stateObj.totalMakitasMade) || 0;

    let investedUpgrades = 0;
    upgrades.forEach((u, idx) => {
        let count = 0;
        if (stateObj.owned && typeof stateObj.owned[u.id] === 'number') {
            count = stateObj.owned[u.id];
        } else if (Array.isArray(stateObj.upgrades) && typeof stateObj.upgrades[idx] === 'number') {
            count = stateObj.upgrades[idx];
        }
        if (count > 0) {
            investedUpgrades += calculateCumulativeUpgradeCost(u, count);
        }
    });

    let investedPerms = 0;
    permanentUpgrades.forEach((p, idx) => {
        let isPurchased = false;
        if (stateObj.perms && typeof stateObj.perms === 'object') {
            if (Array.isArray(stateObj.perms)) {
                isPurchased = stateObj.perms.includes(idx);
            } else {
                isPurchased = stateObj.perms[p.id] === true;
            }
        }
        if (isPurchased) {
            investedPerms += p.cost;
        }
    });

    const netWorth = currentMkt + investedUpgrades + investedPerms;
    return Math.max(totalMade, netWorth);
}

function countTotalUpgrades(stateObj) {
    if (!stateObj) return 0;
    let sum = 0;
    if (stateObj.owned && typeof stateObj.owned === 'object') {
        for (const k in stateObj.owned) {
            sum += (Number(stateObj.owned[k]) || 0);
        }
    } else if (Array.isArray(stateObj.upgrades)) {
        for (const val of stateObj.upgrades) {
            sum += (Number(val) || 0);
        }
    }
    return sum;
}

function countTotalPerms(stateObj) {
    if (!stateObj) return 0;
    if (Array.isArray(stateObj.perms)) {
        return stateObj.perms.length;
    }
    if (stateObj.perms && typeof stateObj.perms === 'object') {
        return Object.values(stateObj.perms).filter(Boolean).length;
    }
    return 0;
}

// Compara o progresso entre dois estados (ex: Local vs Nuvem)
// Retorna 1 se A for superior, -1 se B for superior, 0 se equivalentes
function compareProgress(stateA, stateB) {
    if (!stateA && !stateB) return 0;
    if (!stateA) return -1;
    if (!stateB) return 1;

    // 1. Prioridade absoluta: resetEpoch (se houve reset explícito)
    const resetA = Number(stateA.resetEpoch) || 0;
    const resetB = Number(stateB.resetEpoch) || 0;
    if (resetA !== resetB) {
        return resetA > resetB ? 1 : -1;
    }

    // 2. Score total de patrimônio (makitas geradas e investidas)
    const scoreA = calculateTotalProgressScore(stateA);
    const scoreB = calculateTotalProgressScore(stateB);
    const scoreDiff = scoreA - scoreB;
    if (Math.abs(scoreDiff) >= 1) {
        return scoreDiff > 0 ? 1 : -1;
    }

    // 3. Desempate por quantidade de habilidades desbloqueadas na árvore
    const permsA = countTotalPerms(stateA);
    const permsB = countTotalPerms(stateB);
    if (permsA !== permsB) {
        return permsA > permsB ? 1 : -1;
    }

    // 4. Desempate por quantidade total de oficinas compradas
    const upgradesA = countTotalUpgrades(stateA);
    const upgradesB = countTotalUpgrades(stateB);
    if (upgradesA !== upgradesB) {
        return upgradesA > upgradesB ? 1 : -1;
    }

    // 5. Desempate por revisão monotônica
    const revA = Number(stateA.saveRev) || 0;
    const revB = Number(stateB.saveRev) || 0;
    if (revA !== revB) {
        return revA > revB ? 1 : -1;
    }

    // 6. Desempate por timestamp
    const timeA = Math.max(Number(stateA.lastSavedAt) || 0, Number(stateA.lastUpdate) || 0);
    const timeB = Math.max(Number(stateB.lastSavedAt) || 0, Number(stateB.lastUpdate) || 0);
    if (timeA !== timeB) {
        return timeA > timeB ? 1 : -1;
    }

    return 0;
}

// Mescla defensiva (CRDT): se a nuvem tiver algum upgrade ou tecnologia que o local não tem,
// incorpora sem sobrescrever o saldo ou progresso local superior.
function mergeSafeIntoLocal(cloudData) {
    if (!cloudData) return;
    let changed = false;

    // Upgrades: mantém sempre o máximo (CRDT)
    if (Array.isArray(cloudData.upgrades)) {
        upgrades.forEach((u, idx) => {
            const cVal = cloudData.upgrades[idx] || 0;
            if (cVal > (owned[u.id] || 0)) {
                owned[u.id] = cVal;
                changed = true;
            }
        });
    } else if (cloudData.owned && typeof cloudData.owned === 'object') {
        upgrades.forEach(u => {
            const cVal = cloudData.owned[u.id] || 0;
            if (cVal > (owned[u.id] || 0)) {
                owned[u.id] = cVal;
                changed = true;
            }
        });
    }

    // Perms: se a nuvem desbloqueou alguma perm adicional, incorpora
    if (Array.isArray(cloudData.perms)) {
        permanentUpgrades.forEach((p, idx) => {
            if (cloudData.perms.includes(idx) && !p.purchased) {
                p.purchased = true;
                changed = true;
            }
        });
    } else if (cloudData.perms && typeof cloudData.perms === 'object') {
        permanentUpgrades.forEach(p => {
            if (cloudData.perms[p.id] === true && !p.purchased) {
                p.purchased = true;
                changed = true;
            }
        });
    }

    // Total makitas made: preserva o maior
    if (typeof cloudData.totalMakitasMade === 'number' && cloudData.totalMakitasMade > totalMakitasMade) {
        totalMakitasMade = cloudData.totalMakitasMade;
        changed = true;
    }

    // Reset epoch
    if (typeof cloudData.resetEpoch === 'number' && cloudData.resetEpoch > currentResetEpoch) {
        currentResetEpoch = cloudData.resetEpoch;
        changed = true;
    }

    // Save rev
    if (typeof cloudData.saveRev === 'number' && cloudData.saveRev > currentSaveRev) {
        currentSaveRev = cloudData.saveRev;
    }

    if (changed) {
        mps = calculateLocalMps();
        serverClickPower = calculateLocalClickPower();
        isDirty = true;
        renderUI();
    }
}

function getCompactGameState() {
    const upgradesArr = upgrades.map(u => owned[u.id] || 0);
    const permsArr = [];
    permanentUpgrades.forEach((p, idx) => {
        if (p.purchased) permsArr.push(idx);
    });
    return {
        name: currentUserName || 'Maker',
        createdAt: currentUserCreatedAt || Date.now(),
        makitas,
        totalMakitasMade,
        totalClicks,
        upgrades: upgradesArr,
        perms: permsArr,
        resetEpoch: currentResetEpoch,
        saveRev: currentSaveRev,
        lastSavedAt: lastLocalSaveTime || Date.now(),
        lastUpdate: Date.now(),
        lastOnline: Date.now()
    };
}

function applyCompactState(data) {
    if (!data) return;
    if (typeof data.makitas === 'number') {
        makitas = data.makitas;
    }
    if (typeof data.totalMakitasMade === 'number') {
        totalMakitasMade = data.totalMakitasMade;
    }
    if (typeof data.totalClicks === 'number') {
        totalClicks = data.totalClicks;
    }
    if (typeof data.resetEpoch === 'number') {
        currentResetEpoch = Math.max(currentResetEpoch, data.resetEpoch);
    }
    if (typeof data.saveRev === 'number') {
        currentSaveRev = Math.max(currentSaveRev, data.saveRev);
    }
    if (typeof data.lastSavedAt === 'number') {
        lastLocalSaveTime = Math.max(lastLocalSaveTime, data.lastSavedAt);
    }
    if (Array.isArray(data.upgrades)) {
        upgrades.forEach((u, idx) => {
            owned[u.id] = data.upgrades[idx] || 0;
        });
    } else if (data.owned && typeof data.owned === 'object') {
        upgrades.forEach(u => {
            owned[u.id] = data.owned[u.id] || 0;
        });
    }
    if (Array.isArray(data.perms)) {
        permanentUpgrades.forEach((p, idx) => {
            p.purchased = data.perms.includes(idx);
        });
    } else if (data.perms && typeof data.perms === 'object') {
        permanentUpgrades.forEach(p => {
            p.purchased = data.perms[p.id] === true;
        });
    }
    mps = calculateLocalMps();
    serverClickPower = calculateLocalClickPower();
    isDirty = true;
    renderUI();
}

function saveLocalState() {
    try {
        lastLocalSaveTime = Date.now();
        const saveObj = getCompactGameState();
        saveObj.name = currentUserName;
        saveObj.createdAt = currentUserCreatedAt;
        saveObj.lastCloudSaveTime = lastCloudSaveTime;
        saveObj.lastSavedAt = lastLocalSaveTime;
        saveObj.lastOnline = lastLocalSaveTime;

        const jsonStr = JSON.stringify(saveObj);
        localStorage.setItem(getLocalStorageKey(), jsonStr);
        if (currentUserId) {
            localStorage.setItem(`makita_backup_${currentUserId}`, jsonStr);
            localStorage.setItem(`makita_last_online_${currentUserId}`, String(lastLocalSaveTime));
            saveToCookie(currentUserId, saveObj);
        }
    } catch (e) {
        // Se localStorage falhar, tenta gravar no cookie
        if (currentUserId) {
            try {
                saveToCookie(currentUserId, getCompactGameState());
            } catch (err) {}
        }
    }
}

function loadLocalState() {
    try {
        let bestCandidate = null;

        // 1. Tenta ler localStorage primário
        const rawPrimary = localStorage.getItem(getLocalStorageKey());
        if (rawPrimary) {
            try { bestCandidate = JSON.parse(rawPrimary); } catch (e) {}
        }

        // 2. Tenta ler localStorage de backup
        if (currentUserId) {
            const rawBackup = localStorage.getItem(`makita_backup_${currentUserId}`);
            if (rawBackup) {
                try {
                    const parsedBackup = JSON.parse(rawBackup);
                    if (!bestCandidate || compareProgress(parsedBackup, bestCandidate) > 0) {
                        bestCandidate = parsedBackup;
                    }
                } catch (e) {}
            }

            // 3. Tenta ler Cookie de redundância
            const cookieCandidate = loadFromCookie(currentUserId);
            if (cookieCandidate) {
                if (!bestCandidate || compareProgress(cookieCandidate, bestCandidate) > 0) {
                    bestCandidate = cookieCandidate;
                }
            }
        }

        if (!bestCandidate) return false;

        applyCompactState(bestCandidate);
        if (bestCandidate.createdAt) {
            currentUserCreatedAt = bestCandidate.createdAt;
        }
        if (typeof bestCandidate.lastCloudSaveTime === 'number' && bestCandidate.lastCloudSaveTime > 0) {
            lastCloudSaveTime = bestCandidate.lastCloudSaveTime;
        }

        // Se o backup ou cookie tinha dados mais avançados, sincroniza de volta ao armazenamento primário
        saveLocalState();
        return true;
    } catch (e) {
        return false;
    }
}

function savePermanentProgress() {
    saveLocalState();
}

function loadLocalPermanentProgress() {
    loadLocalState();
}

// ---------- CÁLCULOS LOCAIS OTIMIZADOS ----------
function calculateLocalMps() {
    let baseMps = 0.0;
    upgrades.forEach(u => {
        baseMps += (owned[u.id] || 0) * u.mps;
    });

    let workshopMult = 1.0;
    let globalMpsAdd = 0.0;

    permanentUpgrades.forEach(p => {
        if (p.purchased && p.effects) {
            if (typeof p.effects.multWorkshopMps === 'number') {
                workshopMult *= p.effects.multWorkshopMps;
            }
            if (typeof p.effects.addGlobalMpsPercent === 'number') {
                globalMpsAdd += p.effects.addGlobalMpsPercent;
            }
        }
    });

    return baseMps * workshopMult * (1.0 + globalMpsAdd);
}

function calculateLocalClickPower() {
    let basePower = 1.0;
    let clickMult = 1.0;

    permanentUpgrades.forEach(p => {
        if (p.purchased && p.effects) {
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

function getClickSynergyPct() {
    let maxSynergy = 0.0;
    permanentUpgrades.forEach(p => {
        if (p.purchased && p.effects && typeof p.effects.clickSynergyMpsPercent === 'number') {
            if (p.effects.clickSynergyMpsPercent > maxSynergy) {
                maxSynergy = p.effects.clickSynergyMpsPercent;
            }
        }
    });
    return maxSynergy;
}

function unitCost(upgrade, count) {
    return Math.ceil(upgrade.baseCost * Math.pow(upgrade.growth, count));
}

function costForQuantity(upgrade, qty) {
    let total = 0;
    for (let i = 0; i < qty; i++) {
        total += unitCost(upgrade, owned[upgrade.id] + i);
    }
    return total;
}

function formatCompactNumber(n) {
    if (n == null || isNaN(n)) return '0';
    if (n < 1000) return Math.floor(n).toString();
    if (n < 1e6) {
        const k = n / 1e3;
        return k.toLocaleString('pt-BR', { minimumFractionDigits: (k < 10 ? 2 : (k < 100 ? 1 : 0)), maximumFractionDigits: (k < 10 ? 2 : (k < 100 ? 1 : 0)) }) + ' k';
    }
    if (n < 1e9) {
        const m = n / 1e6;
        return m.toLocaleString('pt-BR', { minimumFractionDigits: (m < 10 ? 2 : (m < 100 ? 1 : 0)), maximumFractionDigits: (m < 10 ? 2 : (m < 100 ? 1 : 0)) }) + ' M';
    }
    if (n < 1e12) {
        const b = n / 1e9;
        return b.toLocaleString('pt-BR', { minimumFractionDigits: (b < 10 ? 2 : (b < 100 ? 1 : 0)), maximumFractionDigits: (b < 10 ? 2 : (b < 100 ? 1 : 0)) }) + ' B';
    }
    if (n < 1e15) {
        const t = n / 1e12;
        return t.toLocaleString('pt-BR', { minimumFractionDigits: (t < 10 ? 2 : (t < 100 ? 1 : 0)), maximumFractionDigits: (t < 10 ? 2 : (t < 100 ? 1 : 0)) }) + ' T';
    }
    const qa = n / 1e15;
    return qa.toLocaleString('pt-BR', { minimumFractionDigits: (qa < 10 ? 2 : 1), maximumFractionDigits: (qa < 10 ? 2 : 1) }) + ' Qa';
}

function formatFullNumber(n) {
    if (n == null || isNaN(n)) return '0';
    return Math.floor(n).toLocaleString('pt-BR');
}

function descForQty(upgrade, qty) {
    const gain = upgrade.mps * qty;
    return `+${gain >= 1000 ? formatCompactNumber(gain) : gain.toFixed(1)} makita/s (${qty}x)`;
}

function computeBuy(upgrade) {
    const remaining = MAX_OWNED - owned[upgrade.id];
    if (remaining <= 0) return { qty: 0, cost: 0 };

    if (buyQty === 'max') {
        let qty = 0;
        let cost = 0;
        while (qty < remaining) {
            const next = unitCost(upgrade, owned[upgrade.id] + qty);
            if (cost + next > makitas) break;
            cost += next;
            qty++;
        }
        return { qty, cost };
    }

    const qty = Math.min(buyQty, remaining);
    return { qty, cost: costForQuantity(upgrade, qty) };
}

function setBuyQty(qty) {
    buyQty = qty;
    shopQtyEl.querySelectorAll('button').forEach(btn => {
        btn.classList.toggle('is-active', btn.dataset.qty === String(qty));
    });
    isDirty = true;
}

shopQtyEl.querySelectorAll('button').forEach(btn => {
    const raw = btn.dataset.qty;
    btn.addEventListener('click', () => setBuyQty(raw === 'max' ? 'max' : Number(raw)));
});

// ---------- CONSTRUÇÃO INICIAL DO DOM ----------
function buildShopList() {
    shopListEl.innerHTML = '';
    upgrades.forEach(upgrade => {
        const btn = document.createElement('button');
        btn.className = 'shop-item';
        btn.id = 'buy-' + upgrade.id;
        btn.innerHTML = `
            <span class="shop-item__icon">${upgrade.icon}</span>
            <span class="shop-item__info">
                <span class="shop-item__name">${upgrade.name}</span>
                <span class="shop-item__desc" id="desc-${upgrade.id}"></span>
            </span>
            <span class="shop-item__cost" id="cost-${upgrade.id}"></span>
            <span class="shop-item__owned" id="owned-${upgrade.id}"></span>
        `;
        btn.addEventListener('click', () => buyUpgrade(upgrade));
        shopListEl.appendChild(btn);
    });
}

function buildPermTree() {
    permTreeGridEl.innerHTML = '';
    permanentUpgrades.forEach(perm => {
        const node = document.createElement('div');
        node.className = 'perm-node status-locked';
        node.id = 'perm-node-' + perm.id;
        node.innerHTML = `
            <div class="perm-node__top">
                <div class="perm-node__icon" id="perm-icon-${perm.id}">${perm.icon}</div>
                <div class="perm-node__title-wrap">
                    <span class="perm-node__name" id="perm-name-${perm.id}">${perm.name}</span>
                    <span class="perm-node__badge" id="perm-badge-${perm.id}">Bloqueado</span>
                </div>
            </div>
            <div class="perm-node__desc" id="perm-desc-${perm.id}">${perm.desc}</div>
            <div class="perm-node__reqs" id="perm-reqs-${perm.id}" style="display:none;"></div>
            <button class="perm-node__btn" id="btn-perm-${perm.id}">
                <span id="btn-perm-label-${perm.id}">Comprar</span>
                <span id="btn-perm-cost-${perm.id}">${formatCompactNumber(perm.cost)}</span>
            </button>
        `;
        const btn = node.querySelector(`#btn-perm-${perm.id}`);
        btn.addEventListener('click', () => buyPermanentUpgrade(perm));
        permTreeGridEl.appendChild(node);
    });
}

// ---------- COMPRAS NO CLIENTE (LOCAL-FIRST + D1 SYNC IMEDIATO) ----------
function buyUpgrade(upgrade) {
    const { qty, cost } = computeBuy(upgrade);
    if (qty <= 0 || makitas < cost) return;

    if (navigator.vibrate) { try { navigator.vibrate(18); } catch(e){} }

    makitas -= cost;
    owned[upgrade.id] = (owned[upgrade.id] || 0) + qty;
    mps = calculateLocalMps();
    isDirty = true;
    hasUnsavedChanges = true;

    saveLocalState();
    updateSaveIndicator();
    scheduleCloudSaveDebounced(3000);
}

function buyPermanentUpgrade(perm) {
    if (perm.purchased || makitas < perm.cost) return;

    if (perm.reqUpgrade) {
        const req = permById[perm.reqUpgrade];
        if (req && !req.purchased) return;
    }

    if (navigator.vibrate) { try { navigator.vibrate(25); } catch(e){} }

    perm.purchased = true;
    makitas -= perm.cost;
    mps = calculateLocalMps();
    serverClickPower = calculateLocalClickPower();
    isDirty = true;
    hasUnsavedChanges = true;

    saveLocalState();
    updateSaveIndicator();
    scheduleCloudSaveDebounced(2000);
}

// ---------- RENDERIZAÇÃO INTELIGENTE E DESACOPLADA ----------
function renderPermTree() {
    const totalAccum = Math.max(totalMakitasMade, makitas);

    permanentUpgrades.forEach(perm => {
        const node = document.getElementById('perm-node-' + perm.id);
        if (!node) return;

        let reqUpgradeMet = true;
        let reqUpgradeName = '';
        if (perm.reqUpgrade) {
            const parent = permById[perm.reqUpgrade];
            if (parent) {
                reqUpgradeName = parent.name;
                reqUpgradeMet = parent.purchased;
            }
        }

        const isRevealed = perm.purchased || reqUpgradeMet || (totalAccum >= perm.reqMakitas);
        const iconEl = document.getElementById('perm-icon-' + perm.id);
        const nameEl = document.getElementById('perm-name-' + perm.id);
        const badgeEl = document.getElementById('perm-badge-' + perm.id);
        const descEl = document.getElementById('perm-desc-' + perm.id);
        const reqsEl = document.getElementById('perm-reqs-' + perm.id);
        const btn = document.getElementById('btn-perm-' + perm.id);
        const btnLabel = document.getElementById('btn-perm-label-' + perm.id);
        const btnCost = document.getElementById('btn-perm-cost-' + perm.id);

        if (!isRevealed) {
            node.className = 'perm-node status-locked';
            if (iconEl) iconEl.textContent = '🔒';
            if (nameEl) nameEl.textContent = 'Tecnologia Oculta';
            if (badgeEl) badgeEl.textContent = 'Bloqueado';
            if (descEl) descEl.textContent = 'Produza mais makitas ou desbloqueie tecnologias anteriores para revelar esta melhoria.';
            if (reqsEl) {
                reqsEl.style.display = 'block';
                reqsEl.textContent = `Requer: ${formatCompactNumber(perm.reqMakitas)} makitas acumuladas`;
            }
            if (btn) btn.style.display = 'none';
            return;
        }

        // Revelado
        if (iconEl) iconEl.textContent = perm.icon;
        if (nameEl) nameEl.textContent = perm.name;
        if (descEl) descEl.textContent = perm.desc;

        let statusClass = 'status-available';
        let badgeText = 'Disponível';
        let isPurchasable = reqUpgradeMet && (makitas >= perm.cost) && !perm.purchased;

        if (perm.purchased) {
            statusClass = 'status-purchased';
            badgeText = 'Adquirido ✓';
        } else if (!reqUpgradeMet) {
            statusClass = 'status-locked';
            badgeText = 'Requisito Pendente';
        }

        node.className = `perm-node ${statusClass}`;
        if (badgeEl) badgeEl.textContent = badgeText;

        if (reqsEl) {
            if (perm.reqUpgrade && !reqUpgradeMet) {
                reqsEl.style.display = 'block';
                reqsEl.textContent = `Pré-requisito: ${reqUpgradeName}`;
            } else {
                reqsEl.style.display = 'none';
            }
        }

        if (btn) {
            btn.style.display = 'flex';
            if (perm.purchased) {
                btn.disabled = true;
                btn.style.background = '#1b5e20';
                if (btnLabel) btnLabel.textContent = 'Ativo';
                if (btnCost) btnCost.textContent = '✓';
            } else {
                btn.disabled = !isPurchasable;
                btn.style.background = '';
                if (btnLabel) btnLabel.textContent = 'Comprar';
                if (btnCost) btnCost.textContent = formatCompactNumber(perm.cost);
                btn.title = `${formatFullNumber(perm.cost)} Makitas`;
            }
        }
    });
}

function renderStats() {
    // 1. Dados do Perfil e Nuvem
    if (statProfileNameEl) {
        statProfileNameEl.textContent = currentUserName || 'Sem Perfil';
    }

    if (statCloudStatusEl) {
        if (!currentUserId) {
            statCloudStatusEl.textContent = '⚪ Sem Perfil';
            statCloudStatusEl.style.color = 'var(--text-lo)';
        } else if (hasUnsavedChanges) {
            const elapsedSec = Math.round((Date.now() - (lastCloudSaveTime || Date.now())) / 1000);
            statCloudStatusEl.textContent = `🟡 Alterações pendentes (${elapsedSec < 60 ? elapsedSec + 's' : Math.round(elapsedSec / 60) + 'm'})`;
            statCloudStatusEl.style.color = 'var(--orange)';
        } else {
            statCloudStatusEl.textContent = '🟢 Salvo na Nuvem';
            statCloudStatusEl.style.color = 'var(--green)';
        }
    }

    if (statLastSaveEl) {
        if (!lastCloudSaveTime || lastCloudSaveTime === 0) {
            statLastSaveEl.textContent = 'Ainda não salvo';
        } else {
            const d = new Date(lastCloudSaveTime);
            statLastSaveEl.textContent = d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR');
        }
    }

    if (statCreatedAtEl) {
        if (!currentUserCreatedAt) {
            statCreatedAtEl.textContent = '—';
        } else {
            const d = new Date(currentUserCreatedAt);
            statCreatedAtEl.textContent = d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR');
        }
    }

    if (statSessionTimeEl) {
        const diff = Math.max(0, Math.floor((Date.now() - sessionStartTime) / 1000));
        const hours = Math.floor(diff / 3600);
        const mins = Math.floor((diff % 3600) / 60);
        const secs = diff % 60;
        statSessionTimeEl.textContent = hours > 0 ? `${hours}h ${mins}m ${secs}s` : `${mins}m ${secs}s`;
    }

    if (statTopPlayerLeaderEl) {
        if (latestTopPlayer && latestTopPlayer.name) {
            const topScore = formatCompactNumber(latestTopPlayer.totalMakitasMade || latestTopPlayer.makitas || 0);
            statTopPlayerLeaderEl.textContent = `${latestTopPlayer.name} (${topScore})`;
        } else {
            statTopPlayerLeaderEl.textContent = 'MakerSpace (0)';
        }
    }

    // 2. Economia e Produção
    if (statMakitasEl) {
        statMakitasEl.textContent = formatCompactNumber(makitas);
        statMakitasEl.title = formatFullNumber(makitas) + ' Makitas';
    }
    
    const total = Math.max(totalMakitasMade, makitas);
    if (statTotalMakitasEl) {
        statTotalMakitasEl.textContent = formatCompactNumber(total);
        statTotalMakitasEl.title = formatFullNumber(total) + ' Makitas';
    }
    
    if (statMpsEl) {
        statMpsEl.textContent = mps >= 1000 ? formatCompactNumber(mps) + '/s' : mps.toFixed(1) + '/s';
        statMpsEl.title = mps.toLocaleString('pt-BR') + ' Makitas por segundo';
    }

    let clickPower = calculateLocalClickPower() || 1.0;
    const synergyPct = getClickSynergyPct();

    if (statClickPowerEl) {
        if (synergyPct > 0) {
            const extra = (mps * synergyPct);
            statClickPowerEl.textContent = `${formatCompactNumber(clickPower)} (+${formatCompactNumber(extra)}/s)`;
        } else {
            statClickPowerEl.textContent = formatCompactNumber(clickPower);
        }
        statClickPowerEl.title = clickPower.toLocaleString('pt-BR') + ' por clique base';
    }

    if (statTotalClicksEl) {
        statTotalClicksEl.textContent = totalClicks.toLocaleString('pt-BR');
    }

    if (statTotalOwnedEl) {
        const totalUnits = Object.values(owned).reduce((sum, val) => sum + (val || 0), 0);
        statTotalOwnedEl.textContent = `${totalUnits} un.`;
    }

    if (statPermCountEl) {
        const purchasedCount = permanentUpgrades.filter(u => u.purchased).length;
        statPermCountEl.textContent = `${purchasedCount}/${permanentUpgrades.length}`;
    }

    // Meta Lendária
    const goalTotal = GOAL_MAKITAS;
    const currentProgress = Math.max(makitas, totalMakitasMade);
    const pct = Math.min(100, (currentProgress / goalTotal) * 100);

    if (statGoalProgressEl) {
        statGoalProgressEl.textContent = pct >= 100 ? '100.00% 👑' : (pct < 0.01 && currentProgress > 0 ? '>0.01%' : pct.toFixed(2) + '%');
    }

    if (goalPercentTextEl && goalProgressBarEl) {
        goalPercentTextEl.textContent = pct >= 100 ? '100.00% CONCLUÍDO! 👑' : (pct < 0.01 && currentProgress > 0 ? '>0.01%' : pct.toFixed(2) + '%');
        goalProgressBarEl.style.width = Math.min(100, pct) + '%';
        if (pct >= 100) {
            goalStatusMsgEl.textContent = '🎉 PARABÉNS! Você atingiu a Meta Lendária de 99 Bilhões no MakerSpace UNIFEI!';
            goalStatusMsgEl.style.color = '#a5d6a7';
        } else {
            const remaining = Math.max(0, goalTotal - currentProgress);
            goalStatusMsgEl.textContent = `Faltam ${formatCompactNumber(remaining)} makitas para a Onipotência Maker (99B).`;
            goalStatusMsgEl.style.color = 'var(--text-lo)';
        }
    }

    if (mobileProfileNameEl) {
        mobileProfileNameEl.textContent = currentUserName || 'Sem Perfil';
    }
    if (mobileQuickClickPowerEl) {
        mobileQuickClickPowerEl.textContent = formatCompactNumber(clickPower);
    }
    if (mobileQuickGoalEl) {
        mobileQuickGoalEl.textContent = pct >= 100 ? '100% 👑' : pct.toFixed(1) + '%';
    }
}

// Renderização de elementos DOM desacoplada (evita 100+ manipulações DOM por frame)
function renderUI() {
    upgrades.forEach(upgrade => {
        const capped = owned[upgrade.id] >= MAX_OWNED;
        const { qty, cost } = computeBuy(upgrade);

        const costEl = document.getElementById('cost-' + upgrade.id);
        if (costEl) {
            costEl.textContent = capped ? '—' : formatCompactNumber(cost);
            costEl.title = capped ? 'Máximo atingido' : formatFullNumber(cost) + ' Makitas';
        }
        const ownedEl = document.getElementById('owned-' + upgrade.id);
        if (ownedEl) ownedEl.textContent = owned[upgrade.id];

        const descEl = document.getElementById('desc-' + upgrade.id);
        if (descEl) {
            descEl.textContent = capped ? 'nível máximo atingido (100 un.)' : descForQty(upgrade, qty);
        }

        const buyBtn = document.getElementById('buy-' + upgrade.id);
        if (buyBtn) {
            buyBtn.disabled = capped || qty <= 0 || makitas < cost;
        }
    });

    renderPermTree();
    renderStats();
}

// ---------- EFEITOS VISUAIS E CLIQUES ----------
function showFloatText(text) {
    if (!makitaBtn || !clickArea) return;
    const rect = makitaBtn.getBoundingClientRect();
    const areaRect = clickArea.getBoundingClientRect();
    const el = document.createElement('span');
    el.className = 'float-plus';
    el.textContent = text;
    el.style.left = (rect.left - areaRect.left + rect.width / 2) + 'px';
    el.style.top = (rect.top - areaRect.top) + 'px';
    clickArea.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
}

function showFloatPlus(amount) {
    if (typeof amount !== 'number') {
        showFloatText(String(amount));
        return;
    }
    const text = '+' + (amount >= 1000 ? formatCompactNumber(amount) : (amount % 1 === 0 ? amount : amount.toFixed(1)));
    showFloatText(text);
}

function spawnFlyingMakita() {
    const rect = makitaBtn.getBoundingClientRect();
    const areaRect = clickArea.getBoundingClientRect();

    const img = document.createElement('img');
    img.className = 'flying-makita';
    img.src = '/makitaCoracao.png';
    img.alt = '';

    const size = 1.8 + Math.random() * 1.6;
    img.style.width = size + 'rem';
    img.style.height = size + 'rem';

    const startX = rect.left - areaRect.left + rect.width / 2;
    const startY = rect.top - areaRect.top + rect.height / 2;
    img.style.left = startX + 'px';
    img.style.top = startY + 'px';

    clickArea.appendChild(img);

    const angle = Math.random() * Math.PI * 2;
    const distance = 90 + Math.random() * 140;
    const tx = Math.cos(angle) * distance;
    const ty = Math.sin(angle) * distance - 40;
    const rot = Math.random() * 720 - 360;

    img.offsetWidth;

    img.style.transform = `translate(calc(-50% + ${tx.toFixed(1)}px), calc(-50% + ${ty.toFixed(1)}px)) rotate(${rot.toFixed(0)}deg) scale(.8)`;
    img.classList.add('is-flying');

    let removed = false;
    const remove = () => {
        if (removed) return;
        removed = true;
        img.remove();
    };
    img.addEventListener('transitionend', remove);
    setTimeout(remove, 1200);
}

function playClickFeedback(gain) {
    showFloatPlus(gain);
    spawnFlyingMakita();
}

// ---------- SISTEMA ANTI-AUTOCLICKER (BAN DE 5 MINUTOS) ----------
const banModalEl = document.getElementById('banModal');
const banCountdownTimerEl = document.getElementById('banCountdownTimer');
const banReasonTextEl = document.getElementById('banReasonText');

let banIntervalId = null;
let clientBannedUntil = 0;

// Detecção heurística de auto-clicker no cliente
const clickTimestamps = [];
const recentIntervals = [];
let lastClickTime = 0;

function formatBanTime(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(s / 60);
    const remS = s % 60;
    return `${String(m).padStart(2, '0')}:${String(remS).padStart(2, '0')}`;
}

function isBanned() {
    return clientBannedUntil > Date.now();
}

function triggerAutoClickerBan(reason = 'Uso de auto-clicker detectado') {
    const BAN_DURATION_MS = 5 * 60 * 1000; // 5 minutos
    clientBannedUntil = Date.now() + BAN_DURATION_MS;
    try {
        localStorage.setItem('makita_ban_until', String(clientBannedUntil));
        localStorage.setItem('makita_ban_reason', reason);
    } catch (e) {}

    // Notifica o backend imediatamente para registrar o banimento do IP no Cloudflare KV
    fetch('/api/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            action: 'report_autoclicker',
            reason: reason,
            userId: currentUserId
        })
    }).catch(() => {});

    showBanOverlay(clientBannedUntil, reason);
}

function showBanOverlay(untilMs, reason = 'Frequência anormal de cliques detectada') {
    clientBannedUntil = untilMs;
    if (banModalEl) banModalEl.style.display = 'flex';
    if (banReasonTextEl) banReasonTextEl.textContent = `Motivo: ${reason}`;
    if (makitaBtn) makitaBtn.disabled = true;

    if (banIntervalId) clearInterval(banIntervalId);

    const updateTimer = () => {
        const remainingMs = clientBannedUntil - Date.now();
        if (remainingMs <= 0) {
            clearInterval(banIntervalId);
            banIntervalId = null;
            clientBannedUntil = 0;
            try {
                localStorage.removeItem('makita_ban_until');
                localStorage.removeItem('makita_ban_reason');
            } catch (e) {}
            if (banModalEl) banModalEl.style.display = 'none';
            if (makitaBtn) makitaBtn.disabled = false;
            logEl.textContent = '✅ Banimento de 5 minutos expirado. Seja bem-vindo de volta!';
            logEl.style.color = 'var(--green)';
            return;
        }
        if (banCountdownTimerEl) {
            banCountdownTimerEl.textContent = formatBanTime(remainingMs / 1000);
        }
    };

    updateTimer();
    banIntervalId = setInterval(updateTimer, 500);
}

function checkLocalBan() {
    try {
        const storedUntil = localStorage.getItem('makita_ban_until');
        const storedReason = localStorage.getItem('makita_ban_reason') || 'Uso de auto-clicker detectado';
        if (storedUntil) {
            const until = Number(storedUntil);
            if (until > Date.now()) {
                showBanOverlay(until, storedReason);
                return true;
            } else {
                localStorage.removeItem('makita_ban_until');
                localStorage.removeItem('makita_ban_reason');
            }
        }
    } catch (e) {}
    return false;
}

makitaBtn.addEventListener('click', (e) => {
    if (isBanned()) return;

    const now = performance.now();

    // 1. Detecção de cliques sintéticos de script (isTrusted === false)
    if (e && e.isTrusted === false) {
        triggerAutoClickerBan('Cliques sintéticos automatizados detectados (isTrusted=false)');
        return;
    }

    // 2. Análise de CPS (janela deslizante de 1 segundo)
    clickTimestamps.push(now);
    while (clickTimestamps.length > 0 && clickTimestamps[0] < now - 1000) {
        clickTimestamps.shift();
    }

    // Limite fisiológico humano: jitter/butterfly clicking raramente supera 24-26 CPS em um único botão
    if (clickTimestamps.length > 28) {
        triggerAutoClickerBan(`Velocidade desumana de cliques (${clickTimestamps.length} CPS)`);
        return;
    }

    // 3. Detecção de robô com intervalo exato e constante (desvio padrão ~0)
    if (lastClickTime > 0) {
        const interval = now - lastClickTime;
        recentIntervals.push(interval);
        if (recentIntervals.length > 20) recentIntervals.shift();

        if (recentIntervals.length >= 15) {
            const avg = recentIntervals.reduce((a, b) => a + b, 0) / recentIntervals.length;
            const variance = recentIntervals.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / recentIntervals.length;
            // Intervalo ultrarrápido (< 40ms, >25 CPS) com variação constante de robô (< 2ms)
            if (avg < 40 && variance < 2.0) {
                triggerAutoClickerBan('Padrão robótico com intervalo exato e constante detectado');
                return;
            }
        }
    }
    lastClickTime = now;

    let gain = calculateLocalClickPower();
    const synergyPct = getClickSynergyPct();
    if (synergyPct > 0) {
        gain += (mps * synergyPct);
    }

    makitas += gain;
    totalMakitasMade += gain;
    totalClicks++;
    pendingClicks++;
    hasUnsavedChanges = true;
    isDirty = true;
    if (navigator.vibrate) {
        try { navigator.vibrate(10); } catch (err) {}
    }
    playClickFeedback(gain);
    scheduleCloudSaveDebounced(5000);
});

// ---------- RESET TOTAL UNIFICADO ----------
function resetAllProgress(sendToServer = true) {
    const now = Date.now();
    currentResetEpoch = now;
    currentSaveRev = (currentSaveRev || 1) + 10;
    lastLocalSaveTime = now;
    lastOfflineCheckTime = now;

    if (currentUserId) {
        clearCookie(currentUserId);
        try {
            localStorage.setItem(`makita_last_online_${currentUserId}`, String(now));
            localStorage.removeItem(`makita_backup_${currentUserId}`);
        } catch (e) {}
    }

    try {
        localStorage.removeItem(getLocalStorageKey());
        localStorage.removeItem('makitaclicker_save');
        localStorage.removeItem('makita_perm_upgrades');
        localStorage.removeItem('makita_total_produced');
        localStorage.removeItem('makita_local_state');
    } catch (e) {}

    makitas = 0;
    mps = 0;
    totalMakitasMade = 0;
    totalClicks = 0;
    prevMakitas = 0;
    pendingClicks = 0;
    upgrades.forEach(u => { owned[u.id] = 0; });
    permanentUpgrades.forEach(u => { u.purchased = false; });
    serverClickPower = 1.0;
    isDirty = true;
    hasUnsavedChanges = false;
    lastCloudSaveTime = now;

    saveLocalState();

    if (sendToServer && currentUserId) {
        fetch('/api/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'reset_user_state', userId: currentUserId })
        }).then(res => res.json()).then(data => {
            if (data.topPlayer) latestTopPlayer = data.topPlayer;
            updateSaveIndicator();
            renderStats();
        }).catch(err => console.warn('Erro ao resetar perfil no servidor:', err));
    } else if (sendToServer) {
        syncWithCloud({ action: 'reset' });
    }

    renderUI();
    renderStats();
}

// ---------- COMUNICAÇÃO HTTP COM CLOUDFLARE PAGES & KV ----------
let isSyncing = false;

function applyServerState(data) {
    if (!data) return;

    if (data.isReset === true) {
        resetAllProgress(false);
        return;
    }

    // Reconciliação Monotônica (Ratchet / CRDT):
    // Se o usuário está logado em um perfil, suas makitas/upgrades pertencem EXCLUSIVAMENTE ao seu perfil!
    // NÃO adotar o saldo global da ESP8266 física!
    if (!currentUserId) {
        if (typeof data.makitas === 'number') {
            const localPendingClicksGain = pendingClicks * calculateLocalClickPower();
            const serverEffective = data.makitas + localPendingClicksGain;
            if (serverEffective > makitas) {
                makitas = serverEffective;
            }
            if (typeof data.totalMakitasMade === 'number') {
                totalMakitasMade = Math.max(totalMakitasMade, data.totalMakitasMade);
            }
        }

        // 2. Upgrades da loja: NUNCA perde upgrades. Mantém sempre o maior valor entre local e servidor.
        if (data.owned && typeof data.owned === 'object') {
            upgrades.forEach(upgrade => {
                if (typeof data.owned[upgrade.id] === 'number') {
                    owned[upgrade.id] = Math.max(owned[upgrade.id] || 0, data.owned[upgrade.id]);
                }
            });
        }

        // 3. Tecnologias permanentes: Se foi desbloqueada no servidor, ativa localmente
        if (data.perms && typeof data.perms === 'object') {
            permanentUpgrades.forEach(u => {
                if (u.id in data.perms && data.perms[u.id] === true) {
                    u.purchased = true;
                }
            });
        }

        // MPS: usa o oficial do servidor se > 0, senão calcula localmente
        const serverMps = typeof data.mps === 'number' ? data.mps : 0;
        mps = serverMps > 0 ? serverMps : calculateLocalMps();
        serverClickPower = calculateLocalClickPower();
    }

    // Feedback de status da ordem de reset para a ESP
    if (data.resetPendingEsp === true) {
        logEl.textContent = '⏳ Ordem de Reset emitida! Aguardando a ESP confirmar a limpeza...';
        logEl.style.color = 'var(--orange)';
    } else if (data.lastResetAckAt && (Date.now() - data.lastResetAckAt < 30000)) {
        logEl.textContent = '✅ A ESP confirmou que limpou sua memória e reiniciou!';
        logEl.style.color = 'var(--green)';
    } else if (data._kv_connected !== undefined) {
        if (data._kv_connected) {
            logEl.textContent = `🟢 Nuvem ativa: Cloudflare KV (${data._kv_binding}) conectado`;
            logEl.style.color = 'var(--text-lo)';
        } else {
            logEl.textContent = data._kv_diag ? `⚠️ ${data._kv_diag}` : '⚠️ KV não vinculado no Cloudflare Pages (Pages > Settings > Functions > KV)';
            logEl.style.color = 'var(--orange)';
        }
    }

    if (data.topPlayer) {
        latestTopPlayer = data.topPlayer;
    }
    if (data.hardwareOwner) {
        setLatestHardwareOwner(data.hardwareOwner);
    }

    latestServerData = data;
    isDirty = true;
    saveLocalState();
    updateStatusUI();
}

// ---------- TELEMETRIA E STATUS DA ESP8266 & CLOUD ----------
let remoteFirmwareVersion = null;
let currentAppBuildTime = null;
let measuredPingMs = null;
let latestServerData = null;

async function fetchRemoteVersion() {
    try {
        const res = await fetch('/version.json?t=' + Date.now(), { cache: 'no-store' });
        if (res.ok) {
            const data = await res.json();
            if (typeof data.firmware_version === 'number') {
                remoteFirmwareVersion = data.firmware_version;
            }
            if (typeof data.build_time === 'number') {
                if (currentAppBuildTime === null) {
                    currentAppBuildTime = data.build_time;
                } else if (data.build_time > currentAppBuildTime) {
                    console.log(`[VERSION] Nova versão detectada na nuvem (${data.build_time} > ${currentAppBuildTime}). Atualizando...`);
                    showFloatText('🚀 Nova versão do jogo! Atualizando...');
                    setTimeout(() => {
                        window.location.reload(true);
                    }, 1200);
                    return;
                }
            }
        }
    } catch (e) {
        console.warn('Erro ao consultar version.json:', e);
    }
    updateStatusUI();
}

function formatUptime(seconds) {
    if (!seconds || seconds <= 0) return '0s';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    if (s > 0 || parts.length === 0) parts.push(`${s}s`);
    return parts.join(' ');
}

function updateStatusUI() {
    // 1. Firmware Remoto
    const statRemoteFw = document.getElementById('statRemoteFw');
    if (statRemoteFw) {
        statRemoteFw.textContent = remoteFirmwareVersion !== null ? `v${remoteFirmwareVersion}` : 'Consultando...';
    }

    // Telemetria da ESP recebida pelo backend
    const esp = latestServerData?.espTelemetry;
    const now = Date.now();
    const espLastPing = esp?.lastPing || 0;
    const secondsSinceEsp = espLastPing > 0 ? Math.max(0, Math.round((now - espLastPing) / 1000)) : null;

    // 2. Hero Card & Indicador de Status da ESP8266
    const statusDot = document.getElementById('statusDot');
    const statusEspTitle = document.getElementById('statusEspTitle');
    const statusEspSubtitle = document.getElementById('statusEspSubtitle');

    if (statusDot && statusEspTitle && statusEspSubtitle) {
        if (secondsSinceEsp !== null && secondsSinceEsp < 90) {
            statusDot.style.background = 'var(--green)';
            statusDot.style.boxShadow = '0 0 10px rgba(0, 230, 118, 0.6)';
            statusDot.style.animation = 'pulseGreen 2s infinite';
            statusEspTitle.textContent = 'ESP8266 Conectada & Sincronizada';
            statusEspTitle.style.color = 'var(--green)';
            statusEspSubtitle.textContent = `Último contato há ${secondsSinceEsp}s • IP: ${esp.ip || 'desconhecido'}`;
        } else if (secondsSinceEsp !== null && secondsSinceEsp < 300) {
            statusDot.style.background = 'var(--orange)';
            statusDot.style.boxShadow = '0 0 10px rgba(255, 145, 0, 0.6)';
            statusDot.style.animation = 'pulseOrange 2s infinite';
            statusEspTitle.textContent = 'ESP8266 Sem Sinal Recente';
            statusEspTitle.style.color = 'var(--orange)';
            statusEspSubtitle.textContent = `Último contato há ${Math.round(secondsSinceEsp / 60)} min`;
        } else {
            statusDot.style.background = 'var(--text-lo)';
            statusDot.style.boxShadow = 'none';
            statusDot.style.animation = 'none';
            statusEspTitle.textContent = 'ESP8266 Offline / Aguardando';
            statusEspTitle.style.color = 'var(--text-lo)';
            statusEspSubtitle.textContent = secondsSinceEsp !== null ? `Visto há ${Math.round(secondsSinceEsp / 60)} min` : 'Nenhum sinal recebido';
        }
    }

    // 3. Versão Local na ESP e Comparação com a Nuvem
    const statLocalFw = document.getElementById('statLocalFw');
    const statFwSyncBadge = document.getElementById('statFwSyncBadge');
    if (statLocalFw && statFwSyncBadge) {
        if (esp && typeof esp.fwVersion === 'number' && esp.fwVersion > 0) {
            statLocalFw.textContent = `v${esp.fwVersion}`;
            if (remoteFirmwareVersion !== null) {
                if (esp.fwVersion >= remoteFirmwareVersion) {
                    statFwSyncBadge.textContent = '✅ Atualizado com a nuvem';
                    statFwSyncBadge.style.color = 'var(--green)';
                } else {
                    statFwSyncBadge.textContent = `⚠️ OTA Pendente (Nuvem: v${remoteFirmwareVersion})`;
                    statFwSyncBadge.style.color = 'var(--orange)';
                }
            } else {
                statFwSyncBadge.textContent = 'Versão reportada via telemetria';
                statFwSyncBadge.style.color = 'var(--text-lo)';
            }
        } else {
            statLocalFw.textContent = 'v--';
            statFwSyncBadge.textContent = 'Aguardando telemetria da ESP';
            statFwSyncBadge.style.color = 'var(--text-lo)';
        }
    }

    // 4. Ping / Latência Web ↔ Servidor Cloudflare
    const statPing = document.getElementById('statPing');
    const statPingHint = document.getElementById('statPingHint');
    if (statPing && statPingHint) {
        if (measuredPingMs !== null) {
            statPing.textContent = `${measuredPingMs} ms`;
            if (measuredPingMs < 120) {
                statPing.style.color = 'var(--green)';
                statPingHint.textContent = '⚡ Latência excelente (< 120ms)';
                statPingHint.style.color = 'var(--green)';
            } else if (measuredPingMs < 350) {
                statPing.style.color = 'var(--accent)';
                statPingHint.textContent = '🟢 Latência estável (< 350ms)';
                statPingHint.style.color = 'var(--accent)';
            } else {
                statPing.style.color = 'var(--orange)';
                statPingHint.textContent = '🟡 Latência elevada';
                statPingHint.style.color = 'var(--orange)';
            }
        } else {
            statPing.textContent = '-- ms';
            statPing.style.color = 'var(--text-hi)';
            statPingHint.textContent = 'Medido a cada ciclo de sync';
            statPingHint.style.color = 'var(--text-lo)';
        }
    }

    // 5. Sinal Wi-Fi (ESP RSSI)
    const statRssi = document.getElementById('statRssi');
    const statRssiQuality = document.getElementById('statRssiQuality');
    if (statRssi && statRssiQuality) {
        if (esp && typeof esp.rssi === 'number' && esp.rssi !== 0) {
            statRssi.textContent = `${esp.rssi} dBm`;
            if (esp.rssi >= -60) {
                statRssi.style.color = 'var(--green)';
                statRssiQuality.textContent = '🟢 Excelente (> -60 dBm)';
                statRssiQuality.style.color = 'var(--green)';
            } else if (esp.rssi >= -70) {
                statRssi.style.color = 'var(--accent)';
                statRssiQuality.textContent = '🟡 Bom (-60 a -70 dBm)';
                statRssiQuality.style.color = 'var(--accent)';
            } else if (esp.rssi >= -80) {
                statRssi.style.color = 'var(--orange)';
                statRssiQuality.textContent = '🟠 Regular (-70 a -80 dBm)';
                statRssiQuality.style.color = 'var(--orange)';
            } else {
                statRssi.style.color = 'var(--red)';
                statRssiQuality.textContent = '🔴 Sinal fraco (< -80 dBm)';
                statRssiQuality.style.color = 'var(--red)';
            }
        } else {
            statRssi.textContent = '-- dBm';
            statRssi.style.color = 'var(--text-hi)';
            statRssiQuality.textContent = 'Aguardando telemetria';
            statRssiQuality.style.color = 'var(--text-lo)';
        }
    }

    // 6. IP Local da ESP
    const statEspIp = document.getElementById('statEspIp');
    if (statEspIp) {
        statEspIp.textContent = (esp && esp.ip) ? esp.ip : '--';
    }

    // 7. Uptime & RAM Heap da ESP
    const statEspUptime = document.getElementById('statEspUptime');
    const statEspHeap = document.getElementById('statEspHeap');
    if (statEspUptime) {
        statEspUptime.textContent = (esp && esp.uptime) ? formatUptime(esp.uptime) : '--';
    }
    if (statEspHeap) {
        if (esp && typeof esp.freeHeap === 'number' && esp.freeHeap > 0) {
            statEspHeap.textContent = `RAM Livre: ${(esp.freeHeap / 1024).toFixed(1)} KB`;
        } else {
            statEspHeap.textContent = 'RAM Livre: --';
        }
    }

    // 8. Cloudflare KV Database
    const statKvStatus = document.getElementById('statKvStatus');
    const statKvBinding = document.getElementById('statKvBinding');
    if (statKvStatus && statKvBinding) {
        if (latestServerData) {
            if (latestServerData._kv_connected) {
                statKvStatus.textContent = '🟢 Conectado e Persistente';
                statKvStatus.style.color = 'var(--green)';
                statKvBinding.textContent = `Binding: ${latestServerData._kv_binding || 'MAKITA_KV'}`;
            } else {
                statKvStatus.textContent = '🟡 Memória Volátil (Sem KV)';
                statKvStatus.style.color = 'var(--orange)';
                statKvBinding.textContent = latestServerData._kv_diag ? latestServerData._kv_diag : 'Binding ausente no Cloudflare';
            }
        }
    }

    // 9. Ordem de Reset Remoto
    const statResetOrder = document.getElementById('statResetOrder');
    const statResetAck = document.getElementById('statResetAck');
    if (statResetOrder && statResetAck) {
        if (latestServerData?.resetOrder) {
            statResetOrder.textContent = '⚠️ Ordem Ativa (Pendente)';
            statResetOrder.style.color = 'var(--orange)';
            statResetAck.textContent = 'Aguardando microcontrolador executar reset';
            statResetAck.style.color = 'var(--orange)';
        } else {
            statResetOrder.textContent = '✅ Normal / Sincronizado';
            statResetOrder.style.color = 'var(--green)';
            statResetAck.textContent = 'Nenhuma ordem de reset pendente';
            statResetAck.style.color = 'var(--text-lo)';
        }
    }
}

// ---------- GERENCIAMENTO DE PERFIS DE USUÁRIO & SAVE NA NUVEM ----------
const profileModalEl = document.getElementById('profileModal');
const profileListContainerEl = document.getElementById('profileListContainer');
const newProfileFormEl = document.getElementById('newProfileForm');
const newProfileInputEl = document.getElementById('newProfileInput');
const currentProfileNameEl = document.getElementById('currentProfileName');
const btnSwitchProfileEl = document.getElementById('btnSwitchProfile');
const btnSaveCloudEl = document.getElementById('btnSaveCloud');
const saveStatusTextEl = document.getElementById('saveStatusText');

// ---------- MODAL DE PRODUÇÃO OFFLINE ----------
const offlineProgressModalEl = document.getElementById('offlineProgressModal');
const offlinePlayerNameEl = document.getElementById('offlinePlayerName');
const offlineTimeElapsedEl = document.getElementById('offlineTimeElapsed');
const offlineMpsRateEl = document.getElementById('offlineMpsRate');
const offlineEarnedAmountEl = document.getElementById('offlineEarnedAmount');
const offlineCapNoticeEl = document.getElementById('offlineCapNotice');
const btnCollectOfflineProgressEl = document.getElementById('btnCollectOfflineProgress');

let isOfflineModalOpen = false;
let lastOfflineCheckTime = 0;

function formatOfflineDuration(seconds) {
    const s = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const remSec = s % 60;

    const parts = [];
    if (h > 0) parts.push(`${h}h`);
    if (m > 0 || h > 0) parts.push(`${m}m`);
    parts.push(`${remSec}s`);
    return parts.join(' ');
}

function showOfflineProgressModal(seconds, mpsRate, earned, wasCapped = false) {
    if (!offlineProgressModalEl) return;
    if (earned < 0.1 || seconds < 15) return;

    if (offlinePlayerNameEl) offlinePlayerNameEl.textContent = currentUserName || 'Maker';
    if (offlineTimeElapsedEl) offlineTimeElapsedEl.textContent = formatOfflineDuration(seconds);
    if (offlineMpsRateEl) {
        const rateFormatted = mpsRate >= 1000 ? formatCompactNumber(mpsRate) : mpsRate.toFixed(1);
        offlineMpsRateEl.textContent = '+' + rateFormatted + ' /s';
    }
    if (offlineEarnedAmountEl) {
        offlineEarnedAmountEl.textContent = '+' + formatCompactNumber(earned) + ' MKT';
        offlineEarnedAmountEl.title = '+' + formatFullNumber(earned) + ' Makitas';
    }
    if (offlineCapNoticeEl) {
        offlineCapNoticeEl.style.display = wasCapped ? 'block' : 'none';
    }

    offlineProgressModalEl.style.display = 'flex';
    isOfflineModalOpen = true;

    if (navigator.vibrate) {
        try { navigator.vibrate([30, 50, 30]); } catch (e) {}
    }
}

function closeOfflineProgressModal() {
    if (offlineProgressModalEl) {
        offlineProgressModalEl.style.display = 'none';
    }
    isOfflineModalOpen = false;
}

function checkAndProcessOfflineProgress(cloudData = null) {
    if (!currentUserId) return;
    if (profileModalEl && profileModalEl.style.display !== 'none') return;
    if (isOfflineModalOpen) return;

    const now = Date.now();
    if (now - lastOfflineCheckTime < 4000) return;
    lastOfflineCheckTime = now;

    // Caso 1: A nuvem calculou e enviou offlineGain
    if (cloudData && typeof cloudData.offlineGain === 'number' && cloudData.offlineGain >= 0.1 && (cloudData.offlineSeconds || 0) >= 15) {
        const seconds = cloudData.offlineSeconds;
        const mpsRate = cloudData.offlineMps || mps || calculateLocalMps();
        const earned = cloudData.offlineGain;
        const wasCapped = !!cloudData.offlineWasCapped;

        try {
            localStorage.setItem(`makita_last_online_${currentUserId}`, String(now));
        } catch (e) {}
        saveLocalState();
        showOfflineProgressModal(seconds, mpsRate, earned, wasCapped);
        return;
    }

    // Caso 2: Cálculo local (modo offline, local mais recente que nuvem, retorno de aba em segundo plano)
    const storedLastOnline = Number(localStorage.getItem(`makita_last_online_${currentUserId}`)) || 0;
    const localSave = Number(lastLocalSaveTime) || 0;
    const lastActive = Math.max(storedLastOnline, localSave);

    if (lastActive <= 0 || lastActive >= now) {
        try {
            localStorage.setItem(`makita_last_online_${currentUserId}`, String(now));
        } catch (e) {}
        return;
    }

    const rawElapsed = (now - lastActive) / 1000.0;
    if (rawElapsed < 15) {
        try {
            localStorage.setItem(`makita_last_online_${currentUserId}`, String(now));
        } catch (e) {}
        return;
    }

    const currentMps = calculateLocalMps();
    if (currentMps <= 0) {
        try {
            localStorage.setItem(`makita_last_online_${currentUserId}`, String(now));
        } catch (e) {}
        return;
    }

    const MAX_OFFLINE_SECONDS = 86400; // Teto de 24h
    const seconds = Math.min(rawElapsed, MAX_OFFLINE_SECONDS);
    const wasCapped = rawElapsed > MAX_OFFLINE_SECONDS;
    const earned = seconds * currentMps;

    if (earned >= 0.1) {
        makitas += earned;
        totalMakitasMade += earned;
        hasUnsavedChanges = true;
        isDirty = true;

        try {
            localStorage.setItem(`makita_last_online_${currentUserId}`, String(now));
        } catch (e) {}
        saveLocalState();
        renderUI();
        showOfflineProgressModal(seconds, currentMps, earned, wasCapped);
    } else {
        try {
            localStorage.setItem(`makita_last_online_${currentUserId}`, String(now));
        } catch (e) {}
    }
}

// ---------- CONTROLE DE POSSE DO CONSOLE FÍSICO (ESP8266) ----------
const btnClaimHardwareEl = document.getElementById('btnClaimHardware');
const statHardwareOwnerEl = document.getElementById('statHardwareOwner');
const statHardwareOwnerHintEl = document.getElementById('statHardwareOwnerHint');
const hardwareBusyModalEl = document.getElementById('hardwareBusyModal');
const hardwareBusyOwnerNameEl = document.getElementById('hardwareBusyOwnerName');
const hardwareBusyRemainingTimeEl = document.getElementById('hardwareBusyRemainingTime');
const btnCancelHardwareClaimEl = document.getElementById('btnCancelHardwareClaim');
const btnConfirmHardwareTakeoverEl = document.getElementById('btnConfirmHardwareTakeover');
const btnClaimHardwareTabEl = document.getElementById('btnClaimHardwareTab');

function formatHardwareTime(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

function setLatestHardwareOwner(owner) {
    if (!owner) return;
    const curTime = Math.max(latestHardwareOwner?.claimedAt || 0, latestHardwareOwner?.releasedAt || 0);
    const newTime = Math.max(owner.claimedAt || 0, owner.releasedAt || 0);
    // Blindagem de consistência eventual: se o pacote recebido tem timestamp anterior ao que já temos, ignora!
    if (newTime > 0 && curTime > 0 && newTime < curTime) {
        return;
    }
    latestHardwareOwner = owner;
    updateHardwareUI();
}

function updateHardwareUI() {
    const isLeader = latestTopPlayer && latestTopPlayer.id && latestTopPlayer.id === currentUserId;
    const isActive = latestHardwareOwner && latestHardwareOwner.active && latestHardwareOwner.remainingSec > 0;
    const isMe = isActive && (latestHardwareOwner.userId === currentUserId);
    const remStr = isActive ? formatHardwareTime(latestHardwareOwner.remainingSec) : '';

    // ---------- Status card text (Card 9) ----------
    if (statHardwareOwnerEl) {
        if (isActive) {
            statHardwareOwnerEl.textContent = `${latestHardwareOwner.userName} (${remStr})`;
            statHardwareOwnerEl.style.color = isMe ? 'var(--green)' : 'var(--orange)';
            if (statHardwareOwnerHintEl) {
                statHardwareOwnerHintEl.textContent = isMe ? '⚡ Cliques físicos creditados ao seu perfil!' : 'Controlado por outro jogador';
            }
        } else if (isLeader) {
            statHardwareOwnerEl.textContent = '👑 Você (1º Lugar)';
            statHardwareOwnerEl.style.color = '#facc15';
            if (statHardwareOwnerHintEl) {
                statHardwareOwnerHintEl.textContent = 'Cliques físicos já vão para o seu perfil automaticamente';
            }
        } else {
            statHardwareOwnerEl.textContent = 'Livre (1º Lugar)';
            statHardwareOwnerEl.style.color = 'var(--teal)';
            if (statHardwareOwnerHintEl) {
                statHardwareOwnerHintEl.textContent = latestTopPlayer ? `Cliques vão para: ${latestTopPlayer.name}` : 'Cliques creditados ao Líder';
            }
        }
    }

    // ---------- Atualiza ambos os botões (header + aba Status) ----------
    const buttons = [btnClaimHardwareEl, btnClaimHardwareTabEl].filter(Boolean);
    if (buttons.length === 0) return;

    for (const btn of buttons) {
        if (isActive) {
            if (isMe) {
                // Estado A: Eu sou o dono temporário ativo
                btn.className = btn.classList.contains('btn-hardware-claim--tab')
                    ? 'btn-hardware-claim btn-hardware-claim--tab is-owned'
                    : 'btn-hardware-claim is-owned';
                btn.textContent = `🎮 Console Ativo (${remStr})`;
                btn.title = 'Você está no controle! Clique para estender ou liberar.';
            } else {
                // Estado B: Outro jogador é o dono temporário
                btn.className = btn.classList.contains('btn-hardware-claim--tab')
                    ? 'btn-hardware-claim btn-hardware-claim--tab is-busy'
                    : 'btn-hardware-claim is-busy';
                const shortName = (latestHardwareOwner.userName || 'Maker').slice(0, 10);
                btn.textContent = `🔒 ${shortName} (${remStr})`;
                btn.title = `Controlado por ${latestHardwareOwner.userName}. Clique para tomar o controle!`;
            }
        } else if (isLeader) {
            // Estado C: Console livre e EU sou o 1º lugar (dono padrão)
            btn.className = btn.classList.contains('btn-hardware-claim--tab')
                ? 'btn-hardware-claim btn-hardware-claim--tab is-leader'
                : 'btn-hardware-claim is-leader';
            btn.textContent = '👑 Você é o Líder';
            btn.title = 'Você é o 1º lugar! Cliques físicos já vão para o seu perfil automaticamente.';
        } else {
            // Estado D: Console livre e eu NÃO sou o 1º lugar
            btn.className = btn.classList.contains('btn-hardware-claim--tab')
                ? 'btn-hardware-claim btn-hardware-claim--tab'
                : 'btn-hardware-claim';
            btn.textContent = '⚡ Tomar Console (3 min)';
            btn.title = 'Assumir o console físico ESP8266 por 3 minutos para creditar cliques no seu perfil.';
        }
    }
}

// Contador regressivo local a cada segundo para fluidez visual da posse
setInterval(() => {
    if (latestHardwareOwner && latestHardwareOwner.active) {
        if (latestHardwareOwner.remainingSec > 0) {
            latestHardwareOwner.remainingSec--;
            if (hardwareBusyModalEl && hardwareBusyModalEl.style.display !== 'none' && hardwareBusyRemainingTimeEl) {
                hardwareBusyRemainingTimeEl.textContent = formatHardwareTime(latestHardwareOwner.remainingSec);
            }
        }
        if (latestHardwareOwner.remainingSec <= 0) {
            latestHardwareOwner.active = false;
            if (hardwareBusyModalEl) hardwareBusyModalEl.style.display = 'none';
        }
        updateHardwareUI();
    }
}, 1000);

async function claimHardware(force = false) {
    if (!currentUserId) {
        alert('Por favor, selecione ou crie um perfil antes de assumir o console físico!');
        openProfileModal();
        return;
    }

    // Salva o progresso e melhorias na nuvem antes de assumir o hardware para que a ESP receba imediatamente
    try {
        await saveGameStateCloud(true);
    } catch (e) {}

    if (btnClaimHardwareEl) {
        btnClaimHardwareEl.disabled = true;
    }
    if (btnClaimHardwareTabEl) {
        btnClaimHardwareTabEl.disabled = true;
    }

    try {
        const res = await fetch('/api/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'claim_hardware',
                userId: currentUserId,
                userName: currentUserName || 'Maker',
                createdAt: currentUserCreatedAt,
                state: getCompactGameState(),
                force
            })
        });

        const data = await res.json();

        if (res.status === 409 || (data && data.busy)) {
            if (data.owner) {
                latestHardwareOwner = {
                    ...data.owner,
                    active: true
                };
            }
            openHardwareBusyModal(data.owner);
            return;
        }

        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        if (data.hardwareOwner) {
            setLatestHardwareOwner(data.hardwareOwner);
            closeHardwareBusyModal();
            showFloatText('🎮 Console Físico Vinculado!');
        }
    } catch (e) {
        console.warn('Erro ao reivindicar console:', e);
        alert('Erro ao conectar ao console: ' + e.message);
    } finally {
        if (btnClaimHardwareEl) {
            btnClaimHardwareEl.disabled = false;
        }
        if (btnClaimHardwareTabEl) {
            btnClaimHardwareTabEl.disabled = false;
        }
    }
}

async function releaseHardware() {
    if (!currentUserId) return;
    try {
        const res = await fetch('/api/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'release_hardware',
                userId: currentUserId
            })
        });
        const data = await res.json();
        if (data.hardwareOwner) {
            setLatestHardwareOwner(data.hardwareOwner);
            showFloatText('🔓 Console Liberado!');
        }
    } catch (e) {
        console.warn('Erro ao liberar console:', e);
    }
}

function openHardwareBusyModal(owner) {
    if (!hardwareBusyModalEl) return;
    const name = owner?.userName || latestHardwareOwner?.userName || 'Outro Maker';
    const remSec = owner?.remainingSec || latestHardwareOwner?.remainingSec || 0;
    if (hardwareBusyOwnerNameEl) hardwareBusyOwnerNameEl.textContent = name;
    if (hardwareBusyRemainingTimeEl) hardwareBusyRemainingTimeEl.textContent = formatHardwareTime(remSec);
    hardwareBusyModalEl.style.display = 'flex';
}

function closeHardwareBusyModal() {
    if (hardwareBusyModalEl) hardwareBusyModalEl.style.display = 'none';
}

function handleHardwareClaimClick() {
    if (!currentUserId) {
        alert('Por favor, selecione ou crie um perfil antes de assumir o console!');
        openProfileModal();
        return;
    }

    if (latestHardwareOwner && latestHardwareOwner.active && latestHardwareOwner.remainingSec > 0) {
        if (latestHardwareOwner.userId === currentUserId) {
            const action = confirm(`Você está conectado ao console físico (tempo restante: ${formatHardwareTime(latestHardwareOwner.remainingSec)}).\n\nClique em OK para estender por mais 3 minutos, ou CANCELAR para liberar o console agora.`);
            if (action) {
                claimHardware(true);
            } else {
                releaseHardware();
            }
        } else {
            openHardwareBusyModal(latestHardwareOwner);
        }
    } else {
        // Se eu já sou o líder (1º lugar), permite travar exclusividade com confirmação
        const isLeader = latestTopPlayer && latestTopPlayer.id && latestTopPlayer.id === currentUserId;
        if (isLeader) {
            const ok = confirm('👑 Você é o 1º colocado do ranking!\n\nOs cliques da ESP já são creditados para seu perfil. Deseja travar a exclusividade do console físico por 3 minutos para que ninguém possa tomar de você?');
            if (ok) {
                claimHardware(true);
            }
        } else {
            claimHardware(false);
        }
    }
}

function updateProfileUI() {
    if (currentProfileNameEl) {
        currentProfileNameEl.textContent = currentUserName || 'Sem Perfil';
    }
    if (mobileProfileNameEl) {
        mobileProfileNameEl.textContent = currentUserName || 'Sem Perfil';
    }
    updateSaveIndicator();
}

function updateSaveIndicator() {
    if (mobileSaveIconEl) {
        if (!currentUserId) {
            mobileSaveIconEl.textContent = '👤';
        } else if (hasUnsavedChanges) {
            mobileSaveIconEl.textContent = '🟡';
        } else {
            mobileSaveIconEl.textContent = '💾';
        }
    }

    if (!saveStatusTextEl) return;
    if (!currentUserId) {
        saveStatusTextEl.textContent = 'Sem Perfil';
        saveStatusTextEl.style.color = 'var(--text-lo)';
        return;
    }

    const elapsedMs = Date.now() - lastCloudSaveTime;
    const elapsedSec = Math.round(elapsedMs / 1000);
    const elapsedMin = Math.round(elapsedMs / 60000);

    if (elapsedMs > 5 * 60 * 1000 && hasUnsavedChanges) {
        saveStatusTextEl.textContent = `⚠️ Não salvo há ${elapsedMin} min`;
        saveStatusTextEl.style.color = 'var(--orange)';
    } else if (hasUnsavedChanges) {
        saveStatusTextEl.textContent = `🟡 Alterações locais (${elapsedSec < 60 ? elapsedSec + 's' : elapsedMin + 'm'})`;
        saveStatusTextEl.style.color = 'var(--orange)';
    } else {
        saveStatusTextEl.textContent = elapsedSec < 10 ? '🟢 Salvo agora' : `🟢 Salvo há ${elapsedSec < 60 ? elapsedSec + 's' : elapsedMin + 'm'}`;
        saveStatusTextEl.style.color = 'var(--green)';
    }
}

// ---------- RANKING GLOBAL ----------
const rankingListContainerEl = document.getElementById('rankingListContainer');
const btnRefreshRankingEl = document.getElementById('btnRefreshRanking');

async function fetchRanking(silent = false) {
    if (!rankingListContainerEl) return;
    if (!silent) {
        rankingListContainerEl.innerHTML = '<div class="ranking-empty">Carregando ranking...</div>';
        if (btnRefreshRankingEl) {
            btnRefreshRankingEl.disabled = true;
            btnRefreshRankingEl.textContent = '⏳ Carregando...';
        }
    }

    try {
        const res = await fetch('/api/state?action=list_users&_t=' + Date.now(), { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        if (data.topPlayer) latestTopPlayer = data.topPlayer;
        if (data.hardwareOwner) setLatestHardwareOwner(data.hardwareOwner);

        renderRanking(data.users || []);
    } catch (e) {
        if (!silent) {
            console.warn('Erro ao carregar ranking:', e);
            rankingListContainerEl.innerHTML = '<div class="ranking-empty">Erro ao carregar o ranking. Tente novamente.</div>';
        }
    } finally {
        if (!silent && btnRefreshRankingEl) {
            btnRefreshRankingEl.disabled = false;
            btnRefreshRankingEl.textContent = '🔄 Atualizar';
        }
    }
}

function renderRanking(users) {
    if (!rankingListContainerEl) return;
    if (!users || users.length === 0) {
        rankingListContainerEl.innerHTML = '<div class="ranking-empty">Nenhum jogador registrado ainda.</div>';
        return;
    }

    const currentTotal = Math.max(Number(totalMakitasMade) || 0, Number(makitas) || 0);
    const updatedUsers = users.map(u => {
        if (u && u.id === currentUserId) {
            return {
                ...u,
                makitas: Math.max(Number(u.makitas) || 0, Number(makitas) || 0),
                totalMakitasMade: Math.max(Number(u.totalMakitasMade) || Number(u.makitas) || 0, currentTotal)
            };
        }
        return u;
    });

    // Ordena por totalMakitasMade decrescente
    updatedUsers.sort((a, b) => (b.totalMakitasMade || b.makitas || 0) - (a.totalMakitasMade || a.makitas || 0));

    const topScore = updatedUsers[0].totalMakitasMade || updatedUsers[0].makitas || 0;

    rankingListContainerEl.innerHTML = '';
    updatedUsers.forEach((user, idx) => {
        const score = user.totalMakitasMade || user.makitas || 0;
        const isMe = user.id === currentUserId;
        const pos = idx + 1;

        const medal = pos === 1 ? '🥇' : (pos === 2 ? '🥈' : (pos === 3 ? '🥉' : `#${pos}`));
        const barPct = topScore > 0 ? Math.max(1, (score / topScore) * 100) : 0;

        const row = document.createElement('div');
        row.className = 'ranking-row' + (isMe ? ' is-me' : '') + (pos === 1 ? ' is-top1' : '');

        row.innerHTML = `
            <div class="ranking-pos">${medal}</div>
            <div class="ranking-info">
                <div class="ranking-name">${escapeHtml(user.name)}${isMe ? ' <span class="ranking-you">(Você)</span>' : ''}</div>
                <div class="ranking-bar-track"><div class="ranking-bar-fill" style="width: ${barPct}%"></div></div>
            </div>
            <div class="ranking-score">${formatCompactNumber(score)}</div>
        `;

        rankingListContainerEl.appendChild(row);
    });
}

function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

async function openProfileModal() {
    if (!profileModalEl) return;
    profileModalEl.style.display = 'flex';
    if (profileListContainerEl) {
        profileListContainerEl.innerHTML = '<div class="profile-list-empty">Carregando perfis da nuvem...</div>';
    }

    try {
        const url = `/api/state?action=list_users&clientUserId=${encodeURIComponent(currentUserId || '')}&clientUserName=${encodeURIComponent(currentUserName || '')}&clientMakitas=${Math.floor(makitas || 0)}&clientTotalMakitas=${Math.floor(totalMakitasMade || makitas || 0)}&_t=${Date.now()}`;
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.hardwareOwner) {
            setLatestHardwareOwner(data.hardwareOwner);
        }
        let users = Array.isArray(data.users) ? [...data.users] : [];

        // Auto-reconciliação de perfis locais: se houver perfis no localStorage que não estão na lista da nuvem,
        // inclui-os na lista visual e dispara o registro/envio para o Cloudflare D1/KV
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.startsWith('makitaclicker_save_')) {
                    const localUid = key.substring('makitaclicker_save_'.length);
                    if (localUid && !users.some(u => u.id === localUid)) {
                        let localState = null;
                        try { localState = JSON.parse(localStorage.getItem(key)); } catch (e) {}
                        
                        const profileName = (localUid === currentUserId && currentUserName) 
                            ? currentUserName 
                            : (localState?.name || 'Maker');
                        
                        const localUserEntry = {
                            id: localUid,
                            name: profileName,
                            createdAt: localState?.createdAt || Date.now(),
                            lastSavedAt: localState?.lastSavedAt || Date.now(),
                            makitas: Number(localState?.makitas) || 0,
                            totalMakitasMade: Number(localState?.totalMakitasMade) || Number(localState?.makitas) || 0
                        };
                        users.push(localUserEntry);

                        if (localUid === currentUserId) {
                            saveUserProgressToCloud(false);
                        }
                    }
                }
            }
        } catch (e) {}

        renderProfileList(users);
    } catch (e) {
        console.warn('Erro ao carregar lista de usuários da nuvem:', e);
        // Resiliência offline: carrega perfis locais mesmo sem conexão
        const localUsers = [];
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.startsWith('makitaclicker_save_')) {
                    const localUid = key.substring('makitaclicker_save_'.length);
                    if (localUid) {
                        let localState = null;
                        try { localState = JSON.parse(localStorage.getItem(key)); } catch (err) {}
                        localUsers.push({
                            id: localUid,
                            name: (localUid === currentUserId && currentUserName) ? currentUserName : (localState?.name || 'Maker'),
                            createdAt: localState?.createdAt || Date.now(),
                            lastSavedAt: localState?.lastSavedAt || Date.now(),
                            makitas: Number(localState?.makitas) || 0,
                            totalMakitasMade: Number(localState?.totalMakitasMade) || Number(localState?.makitas) || 0
                        });
                    }
                }
            }
        } catch (err) {}

        if (localUsers.length > 0) {
            renderProfileList(localUsers);
        } else if (profileListContainerEl) {
            profileListContainerEl.innerHTML = '<div class="profile-list-empty">Não foi possível carregar os perfis. Crie um novo abaixo!</div>';
        }
    }
}

function renderProfileList(users) {
    if (!profileListContainerEl) return;
    if (!users || users.length === 0) {
        profileListContainerEl.innerHTML = '<div class="profile-list-empty">Nenhum perfil criado ainda. Seja o primeiro a criar!</div>';
        return;
    }

    users.sort((a, b) => (b.totalMakitasMade || b.makitas || 0) - (a.totalMakitasMade || a.makitas || 0));

    profileListContainerEl.innerHTML = '';
    users.forEach((user, idx) => {
        const item = document.createElement('div');
        const isCurrent = user.id === currentUserId;
        item.className = 'profile-item' + (isCurrent ? ' is-active-user' : '');
        
        const medal = idx === 0 ? '🥇' : (idx === 1 ? '🥈' : (idx === 2 ? '🥉' : '👤'));
        const score = formatCompactNumber(user.totalMakitasMade || user.makitas || 0);

        item.innerHTML = `
            <div class="profile-item__left">
                <span class="profile-item__icon">${medal}</span>
                <div>
                    <div class="profile-item__name">${user.name} ${isCurrent ? '<small style="color: var(--green); font-weight: normal;">(Atual)</small>' : ''}</div>
                    <div class="profile-item__score">${score} Makitas acumuladas</div>
                </div>
            </div>
            <button class="profile-item__btn">${isCurrent ? 'Continuar' : 'Jogar'}</button>
        `;

        item.addEventListener('click', () => {
            selectProfile(user);
        });

        profileListContainerEl.appendChild(item);
    });
}

function selectProfile(user) {
    if (!user || !user.id) return;
    currentUserId = user.id;
    currentUserName = user.name;
    currentUserCreatedAt = user.createdAt || Date.now();

    try {
        localStorage.setItem('makita_active_user_id', currentUserId);
        localStorage.setItem('makita_active_user_name', currentUserName);
        localStorage.setItem('makita_active_user_created_at', String(currentUserCreatedAt));
    } catch (e) {}

    updateProfileUI();
    if (profileModalEl) profileModalEl.style.display = 'none';

    // Primeiro carrega o save local desse perfil (se houver) para resposta imediata
    const hadLocal = loadLocalState();
    if (!hadLocal) {
        makitas = 0;
        mps = 0;
        totalMakitasMade = 0;
        totalClicks = 0;
        prevMakitas = 0;
        pendingClicks = 0;
        upgrades.forEach(u => { owned[u.id] = 0; });
        permanentUpgrades.forEach(u => { u.purchased = false; });
        mps = calculateLocalMps();
        serverClickPower = calculateLocalClickPower();
        isDirty = true;
        renderUI();
    }

    // Busca o save mais recente na nuvem
    fetchUserProfileState(currentUserId);
}

async function fetchUserProfileState(userId) {
    try {
        const url = `/api/state?userId=${encodeURIComponent(userId)}&clientUserId=${encodeURIComponent(currentUserId || '')}&clientUserName=${encodeURIComponent(currentUserName || '')}&clientMakitas=${Math.floor(makitas || 0)}&clientTotalMakitas=${Math.floor(totalMakitasMade || makitas || 0)}&_t=${Date.now()}`;
        const res = await fetch(url);
        if (res.status === 429) {
            const errData = await res.json().catch(() => ({}));
            if (errData.banned) {
                const untilMs = errData.banExpiresAt || (Date.now() + (errData.remainingSec || 300) * 1000);
                showBanOverlay(untilMs, errData.reason || 'IP suspenso por 5 minutos');
                return;
            }
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        // 1. Constrói representação do estado local atual
        const currentLocal = getCompactGameState();

        // 2. Compara progresso entre Local e Nuvem considerando patrimônio total (makitas + oficinas + árvore)
        const cmp = compareProgress(currentLocal, data);
        const isProfileMissingInCloud = (data.userFound === false || data.isNewUser === true);

        if (isProfileMissingInCloud || cmp > 0) {
            // O LOCAL É MAIOR/MAIS AVANÇADO QUE A NUVEM OU O PERFIL NÃO EXISTE NA NUVEM!
            // O local prevalece e cria/atualiza a nuvem com os dados locais
            console.log('[SYNC] ' + (isProfileMissingInCloud 
                ? 'Perfil local não encontrado na nuvem. Criando perfil e enviando progresso local...' 
                : 'Progresso local é MAIOR que a nuvem. Sincronizando com a nuvem...'));
            logEl.textContent = isProfileMissingInCloud 
                ? '⚡ Perfil local registrado e sincronizado com a nuvem!' 
                : '⚡ Progresso local mais avançado que a nuvem. Sincronizando com a nuvem...';
            logEl.style.color = 'var(--teal)';

            mergeSafeIntoLocal(data);
            saveLocalState();
            // Dispara envio para a nuvem para criar o perfil e subir o progresso!
            saveUserProgressToCloud(false);
            checkAndProcessOfflineProgress(null);
        } else if (cmp < 0) {
            // A NUVEM É MAIS AVANÇADA
            console.log('[SYNC] Nuvem possui progresso mais avançado. Adotando dados da nuvem.');
            applyCompactState(data);
            saveLocalState();
            hasUnsavedChanges = false;
            checkAndProcessOfflineProgress(data);
        } else {
            // Equivalentes: mescla defensivamente sem sobrescrever
            mergeSafeIntoLocal(data);
            saveLocalState();
            checkAndProcessOfflineProgress(data);
        }

        if (typeof data.lastSavedAt === 'number' && data.lastSavedAt > 0) {
            lastCloudSaveTime = data.lastSavedAt;
        } else {
            lastCloudSaveTime = Date.now();
        }
        if (data.topPlayer) {
            latestTopPlayer = data.topPlayer;
        }
        if (data.hardwareOwner) {
            setLatestHardwareOwner(data.hardwareOwner);
        }
        updateSaveIndicator();
        renderStats();
        updateHardwareUI();
    } catch (e) {
        console.warn('Erro ao carregar estado do perfil na nuvem:', e);
        checkAndProcessOfflineProgress(null);
    }
}

function sanitizeNick(raw) {
    if (!raw) return '';
    let s = String(raw).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    s = s.replace(/[º°]/g, 'o').replace(/[ª]/g, 'a');
    s = s.replace(/[^a-zA-Z0-9 _-]/g, '');
    return s.trim().slice(0, 16);
}

async function createNewProfile(name) {
    const cleanName = sanitizeNick(name);
    if (!cleanName) {
        alert('Por favor, informe um nome ou apelido válido (letras ou números).');
        return;
    }

    const btnCreate = document.getElementById('btnCreateProfile');
    if (btnCreate) {
        btnCreate.disabled = true;
        btnCreate.textContent = 'Salvando no KV...';
    }

    try {
        const res = await fetch('/api/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'create_user', name: cleanName }),
            keepalive: true
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.success && data.user) {
            selectProfile(data.user);
            saveLocalState();
            saveUserProgressToCloud(true);
        }
    } catch (e) {
        alert('Erro ao criar perfil na nuvem: ' + e.message);
    } finally {
        if (btnCreate) {
            btnCreate.disabled = false;
            btnCreate.textContent = 'Criar Perfil e Jogar 🚀';
        }
    }
}

let isSavingUserProgress = false;
let saveRetryTimer = null;
let saveRetryDelay = 3000;
let debouncedSaveTimer = null;

function scheduleCloudSaveDebounced(delayMs = 3500) {
    if (!currentUserId) return;
    hasUnsavedChanges = true;
    if (debouncedSaveTimer) clearTimeout(debouncedSaveTimer);
    debouncedSaveTimer = setTimeout(() => {
        debouncedSaveTimer = null;
        if (currentUserId && hasUnsavedChanges) {
            saveUserProgressToCloud(false);
        }
    }, delayMs);
}

function scheduleSaveRetry() {
    if (saveRetryTimer) return;
    saveRetryTimer = setTimeout(() => {
        saveRetryTimer = null;
        if (currentUserId && hasUnsavedChanges) {
            saveUserProgressToCloud(false);
        }
    }, saveRetryDelay);
    saveRetryDelay = Math.min(30000, Math.round(saveRetryDelay * 1.5));
}

async function saveUserProgressToCloud(isManual = false) {
    if (!currentUserId) return;
    if (isSavingUserProgress && !isManual) return;
    isSavingUserProgress = true;

    if (isManual && btnSaveCloudEl) {
        btnSaveCloudEl.disabled = true;
        btnSaveCloudEl.textContent = '⏳ Salvando no D1...';
    }
    if (saveStatusTextEl) {
        saveStatusTextEl.textContent = '🟡 Sincronizando com D1...';
        saveStatusTextEl.style.color = 'var(--orange)';
    }

    currentSaveRev++;
    lastLocalSaveTime = Date.now();

    const payload = {
        action: 'save_user_state',
        userId: currentUserId,
        userName: currentUserName,
        createdAt: currentUserCreatedAt,
        state: getCompactGameState(),
        manual: isManual
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

    try {
        const res = await fetch('/api/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            keepalive: true,
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (res.status === 429) {
            const errData = await res.json().catch(() => ({}));
            if (errData.banned) {
                const untilMs = errData.banExpiresAt || (Date.now() + (errData.remainingSec || 300) * 1000);
                showBanOverlay(untilMs, errData.reason || 'IP suspenso por 5 minutos');
                return;
            }
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        // Se o servidor rejeitou por ser obsoleto em relação a um reset recente
        if (data && data.staleRejected) {
            console.warn('[SYNC] Servidor rejeitou save por ser mais antigo que o estado atual do D1/KV.');
            if (data.state) {
                applyCompactState(data.state);
                saveLocalState();
            }
            return;
        }

        lastCloudSaveTime = typeof data.lastSavedAt === 'number' ? data.lastSavedAt : Date.now();
        if (data && typeof data.saveRev === 'number') {
            currentSaveRev = Math.max(currentSaveRev, data.saveRev);
        }
        hasUnsavedChanges = false;
        saveRetryDelay = 3000;
        if (saveRetryTimer) {
            clearTimeout(saveRetryTimer);
            saveRetryTimer = null;
        }

        if (data && data.topPlayer) {
            latestTopPlayer = data.topPlayer;
        }
        if (data && data.hardwareOwner) {
            setLatestHardwareOwner(data.hardwareOwner);
        }

        saveLocalState();
        updateSaveIndicator();
        renderStats();

        if (isManual) {
            showFloatText('💾 Salvo no D1!');
            if (btnSaveCloudEl) {
                btnSaveCloudEl.disabled = false;
                btnSaveCloudEl.textContent = '✅ Salvo!';
                setTimeout(() => {
                    if (btnSaveCloudEl && btnSaveCloudEl.textContent === '✅ Salvo!') {
                        btnSaveCloudEl.textContent = '💾 Salvar na Nuvem';
                    }
                }, 1800);
            }
        }
    } catch (e) {
        clearTimeout(timeoutId);
        console.warn('Falha ao salvar progresso na nuvem:', e);
        scheduleSaveRetry();
        if (saveStatusTextEl) {
            saveStatusTextEl.textContent = '⚠️ Falha ao salvar: ' + (e.message || 'offline');
            saveStatusTextEl.style.color = 'var(--orange)';
        }
        if (isManual && btnSaveCloudEl) {
            btnSaveCloudEl.disabled = false;
            btnSaveCloudEl.textContent = '❌ Erro ao salvar';
            setTimeout(() => {
                if (btnSaveCloudEl && btnSaveCloudEl.textContent === '❌ Erro ao salvar') {
                    btnSaveCloudEl.textContent = '💾 Salvar na Nuvem';
                }
            }, 2500);
        }
    } finally {
        isSavingUserProgress = false;
        if (btnSaveCloudEl && !isManual) {
            btnSaveCloudEl.disabled = false;
            btnSaveCloudEl.textContent = '💾 Salvar na Nuvem';
        }
    }
}

// Auto-Save frequente no D1 a cada 15 segundos (D1 comporta 100.000 writes/dia!)
setInterval(() => {
    if (currentUserId && hasUnsavedChanges) {
        saveUserProgressToCloud(false);
    }
}, 15000);

// Indicador visual de tempo decorrido do save atualizado a cada 2s
setInterval(updateSaveIndicator, 2000);

// Sincronização e proteção robusta ao sair, trocar de app ou minimizar (iOS Safari & Android Chrome)
const handleExitOrSuspend = () => {
    saveLocalState();
    if (currentUserId) {
        try {
            localStorage.setItem(`makita_last_online_${currentUserId}`, String(Date.now()));
        } catch (e) {}
    }
    if (currentUserId && hasUnsavedChanges) {
        saveUserProgressToCloud(false);
    }
};

window.addEventListener('beforeunload', handleExitOrSuspend);
window.addEventListener('pagehide', handleExitOrSuspend);
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        handleExitOrSuspend();
    } else if (document.visibilityState === 'visible') {
        lastFrameTime = performance.now();
        checkAndProcessOfflineProgress(null);
    }
});
window.addEventListener('online', () => {
    if (currentUserId && hasUnsavedChanges) {
        saveUserProgressToCloud(false);
    }
});

const btnTestPing = document.getElementById('btnTestPing');
if (btnTestPing) {
    btnTestPing.addEventListener('click', async () => {
        btnTestPing.disabled = true;
        const prevText = btnTestPing.textContent;
        btnTestPing.textContent = '🔄 Medindo...';
        await Promise.all([syncWithCloud(), fetchRemoteVersion()]);
        btnTestPing.textContent = prevText;
        btnTestPing.disabled = false;
    });
}

async function syncWithCloud(actionPayload = null) {
    if (!window.location.hostname || window.location.protocol === 'file:') {
        logEl.textContent = '🛠️ Modo de Teste Local Ativo (Simulador Offline)';
        logEl.style.color = 'var(--orange)';
        return;
    }

    if (isSyncing && !actionPayload) return;
    isSyncing = true;

    let body = null;
    let clicksSent = 0;

    const permsPayload = {};
    permanentUpgrades.forEach(p => { permsPayload[p.id] = p.purchased; });

    if (actionPayload) {
        body = { ...actionPayload };
        if (pendingClicks > 0 && actionPayload.action !== 'reset') {
            body.clicks = (body.clicks || 0) + pendingClicks;
            clicksSent = pendingClicks;
            pendingClicks = 0;
        }
        body.userId = currentUserId;
        body.makitas = makitas;
        body.totalMakitasMade = totalMakitasMade;
        body.owned = owned;
        body.perms = permsPayload;
    } else {
        clicksSent = pendingClicks;
        pendingClicks = 0;
        body = {
            action: 'sync',
            source: 'web',
            userId: currentUserId,
            clicks: clicksSent,
            makitas,
            totalMakitasMade,
            owned,
            perms: permsPayload
        };
    }

    const pingStart = performance.now();
    try {
        const res = await fetch('/api/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (res.status === 429) {
            const errData = await res.json().catch(() => ({}));
            if (errData.banned) {
                const untilMs = errData.banExpiresAt || (Date.now() + (errData.remainingSec || 300) * 1000);
                showBanOverlay(untilMs, errData.reason || 'IP suspenso por 5 minutos');
                return;
            }
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        measuredPingMs = Math.round(performance.now() - pingStart);
        const data = await res.json();
        applyServerState(data);
    } catch (err) {
        measuredPingMs = null;
        pendingClicks += clicksSent;
        logEl.textContent = '⚠️ Modo autônomo local (aguardando conexão com a nuvem)';
        logEl.style.color = 'var(--orange)';
    } finally {
        isSyncing = false;
        updateStatusUI();
    }
}

// Sincronização periódica de telemetria a cada 15 segundos em segundo plano
setInterval(() => {
    syncWithCloud();
}, 15000);


// ---------- BOTÃO DE RESET TOTAL ----------
const resetGameBtn = document.getElementById('resetGameBtn');
if (resetGameBtn) {
    resetGameBtn.addEventListener('click', () => {
        if (confirm('Tem certeza que deseja resetar TODO o seu progresso (saldo, melhorias e estatísticas)?')) {
            resetAllProgress(true);
        }
    });
}

// ---------- MOTOR DE RENDERIZAÇÃO CONTÍNUA DO CLIENTE (TAXA NATIVA DO MONITOR) ----------
let lastFrameTime = performance.now();

function gameLoop(now) {
    const dt = Math.min(0.2, (now - lastFrameTime) / 1000.0);
    lastFrameTime = now;

    // Produção contínua e suave na taxa de quadros nativa da GPU/Monitor
    if (mps > 0) {
        const gain = mps * dt;
        makitas += gain;
        totalMakitasMade += gain;
        hasUnsavedChanges = true;
    }

    // Atualização rápida de texto (apenas 2 elementos DOM)
    const formattedMakitas = formatCompactNumber(makitas);
    const formattedRate = mps >= 1000 ? formatCompactNumber(mps) : mps.toFixed(1);

    counterEl.textContent = formattedMakitas;
    counterEl.title = formatFullNumber(makitas) + ' Makitas';
    rateEl.textContent = formattedRate;
    rateEl.title = mps.toLocaleString('pt-BR') + ' por segundo';

    if (mobileCounterEl) {
        mobileCounterEl.textContent = formattedMakitas;
    }
    if (mobileRateEl) {
        mobileRateEl.textContent = formattedRate + '/s';
    }

    // Renderização throttled de listas/botões para máxima eficiência
    if (isDirty || (now - lastThrottledRender >= THROTTLE_RENDER_MS)) {
        isDirty = false;
        lastThrottledRender = now;
        renderUI();
    }

    requestAnimationFrame(gameLoop);
}

// ---------- INICIALIZAÇÃO DO JOGO ----------
function initGame() {
    checkLocalBan();

    currentUserId = localStorage.getItem('makita_active_user_id') || null;
    currentUserName = localStorage.getItem('makita_active_user_name') || null;
    const storedCreatedAt = localStorage.getItem('makita_active_user_created_at');
    if (storedCreatedAt) {
        currentUserCreatedAt = Number(storedCreatedAt);
    }

    // Auto-detecção defensiva de perfil local:
    // Se não há perfil ativo em makita_active_user_id, procura por perfis locais existentes no localStorage
    if (!currentUserId) {
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith('makitaclicker_save_')) {
                    const candidateId = k.substring('makitaclicker_save_'.length);
                    if (candidateId) {
                        currentUserId = candidateId;
                        let savedData = null;
                        try { savedData = JSON.parse(localStorage.getItem(k)); } catch (e) {}
                        currentUserName = savedData?.name || localStorage.getItem('makita_active_user_name') || 'Maker';
                        currentUserCreatedAt = savedData?.createdAt || Date.now();
                        localStorage.setItem('makita_active_user_id', currentUserId);
                        localStorage.setItem('makita_active_user_name', currentUserName);
                        localStorage.setItem('makita_active_user_created_at', String(currentUserCreatedAt));
                        break;
                    }
                }
            }

            // Se ainda não encontrou mas existe save legado local (sem perfil id)
            if (!currentUserId) {
                const legacySave = localStorage.getItem('makitaclicker_save');
                if (legacySave) {
                    const parsed = JSON.parse(legacySave);
                    if (parsed && (parsed.makitas > 0 || parsed.totalMakitasMade > 0 || (parsed.upgrades && parsed.upgrades.some(x => x > 0)))) {
                        currentUserId = 'u_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
                        currentUserName = 'Maker';
                        currentUserCreatedAt = Date.now();
                        localStorage.setItem('makita_active_user_id', currentUserId);
                        localStorage.setItem('makita_active_user_name', currentUserName);
                        localStorage.setItem('makita_active_user_created_at', String(currentUserCreatedAt));
                        localStorage.setItem(`makitaclicker_save_${currentUserId}`, legacySave);
                        console.log('[MIGRATION] Save local legado migrado para perfil:', currentUserId);
                    }
                }
            }
        } catch (e) {}
    }

    if (btnSwitchProfileEl) {
        btnSwitchProfileEl.addEventListener('click', () => {
            openProfileModal();
        });
    }
    if (btnMobileProfileEl) {
        btnMobileProfileEl.addEventListener('click', () => {
            openProfileModal();
        });
    }

    if (btnSaveCloudEl) {
        btnSaveCloudEl.addEventListener('click', () => {
            saveUserProgressToCloud(true);
        });
    }
    if (btnMobileSaveEl) {
        btnMobileSaveEl.addEventListener('click', () => {
            saveUserProgressToCloud(true);
        });
    }

    if (newProfileFormEl) {
        newProfileFormEl.addEventListener('submit', (e) => {
            e.preventDefault();
            if (newProfileInputEl) {
                createNewProfile(newProfileInputEl.value);
                newProfileInputEl.value = '';
            }
        });
    }

    if (btnClaimHardwareEl) {
        btnClaimHardwareEl.addEventListener('click', handleHardwareClaimClick);
    }
    if (btnClaimHardwareTabEl) {
        btnClaimHardwareTabEl.addEventListener('click', handleHardwareClaimClick);
    }
    if (btnCancelHardwareClaimEl) {
        btnCancelHardwareClaimEl.addEventListener('click', closeHardwareBusyModal);
    }
    if (btnConfirmHardwareTakeoverEl) {
        btnConfirmHardwareTakeoverEl.addEventListener('click', () => {
            claimHardware(true);
        });
    }

    if (btnCollectOfflineProgressEl) {
        btnCollectOfflineProgressEl.addEventListener('click', () => {
            closeOfflineProgressModal();
            if (navigator.vibrate) {
                try { navigator.vibrate([20, 30, 20]); } catch (e) {}
            }
            if (logEl) {
                logEl.textContent = '⚡ Makitas offline coletadas com sucesso!';
                logEl.style.color = 'var(--teal)';
            }
            saveUserProgressToCloud(false);
        });
    }

    buildShopList();
    buildPermTree();

    if (currentUserId) {
        updateProfileUI();
        loadLocalState();
        fetchUserProfileState(currentUserId);
    } else {
        openProfileModal();
    }

    renderUI();
    syncWithCloud();
    fetchRemoteVersion();

    setInterval(fetchRemoteVersion, 60000); // Consulta nova versão remota a cada 1 minuto
    setInterval(() => {
        updateStatusUI();
        renderStats();
        if (currentUserId) {
            try {
                localStorage.setItem(`makita_last_online_${currentUserId}`, String(Date.now()));
            } catch (e) {}
        }
    }, 1000); // Atualiza contadores, telemetria, online timestamp e estatísticas a cada segundo

    // Consulta status de posse do console físico e sincronização com D1 a cada 3.5s
    setInterval(async () => {
        if (document.visibilityState !== 'hidden') {
            try {
                const uParam = currentUserId ? `&userId=${encodeURIComponent(currentUserId)}` : '';
                const res = await fetch(`/api/state?action=get_hardware_status${uParam}&_t=${Date.now()}`);
                if (res.ok) {
                    const data = await res.json();
                    if (data.hardwareOwner) {
                        setLatestHardwareOwner(data.hardwareOwner);
                    }
                    if (data.topPlayer) {
                        latestTopPlayer = data.topPlayer;
                    }
                    if (data.currentUser && typeof data.currentUser.makitas === 'number') {
                        if (data.currentUser.makitas > makitas) {
                            makitas = data.currentUser.makitas;
                            totalMakitasMade = Math.max(totalMakitasMade, Number(data.currentUser.totalMakitasMade) || makitas);
                            isDirty = true;
                            saveLocalState();
                            renderStats();
                        }
                    }
                }

                // Se a aba de ranking estiver aberta, atualiza o ranking em tempo real
                const rankingTabEl = document.getElementById('tab-ranking');
                if (rankingTabEl && rankingTabEl.classList.contains('is-active')) {
                    fetchRanking(true);
                }
            } catch (e) {}
        }
    }, 3500);

    // Inicia o motor gráfico irrestrito (suave e fluido)
    requestAnimationFrame(gameLoop);
}

initGame();

