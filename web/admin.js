// =====================================================================
// MAKITA CLICKER - PAINEL ADMINISTRATIVO (ADMIN.JS)
// Autenticação Criptográfica com Hash SHA-256 (Senha Segura One-Way)
// =====================================================================

let currentAuthHash = sessionStorage.getItem('makita_admin_hash') || null;

// Elementos do DOM
const loginViewEl = document.getElementById('adminLoginView');
const dashboardViewEl = document.getElementById('adminDashboardView');
const loginFormEl = document.getElementById('adminLoginForm');
const passwordInputEl = document.getElementById('adminPasswordInput');
const loginErrorEl = document.getElementById('adminLoginError');

const totalUsersEl = document.getElementById('adminTotalUsers');
const topPlayerEl = document.getElementById('adminTopPlayer');
const kvStatusEl = document.getElementById('adminKvStatus');
const usersTableBodyEl = document.getElementById('adminUsersTableBody');

const btnRefreshEl = document.getElementById('btnAdminRefresh');
const btnDeleteAllEl = document.getElementById('btnAdminDeleteAll');
const btnResetRealEl = document.getElementById('btnAdminResetReal');
const btnResetGlobalEl = document.getElementById('btnAdminResetGlobal');

const ordersCountBadgeEl = document.getElementById('adminOrdersCountBadge');
const ordersQueueEmptyEl = document.getElementById('adminOrdersQueueEmpty');
const ordersQueueListEl = document.getElementById('adminOrdersQueueList');
let cachedOrders = [];

// Função criptográfica SHA-256 nativa do navegador
async function hashPassword(str) {
    const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

function formatCompact(num) {
    const n = Number(num) || 0;
    if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T';
    if (n >= 1e9)  return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6)  return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3)  return (n / 1e3).toFixed(1) + 'k';
    return Math.floor(n).toLocaleString('pt-BR');
}

function formatDate(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

async function verifyAndLoad(hash) {
    if (!hash) return;
    try {
        const res = await fetch('/api/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'admin_verify', authHash: hash })
        });
        if (!res.ok) throw new Error('Autenticação inválida');
        const data = await res.json();
        if (data.success) {
            currentAuthHash = hash;
            sessionStorage.setItem('makita_admin_hash', hash);
            showDashboard(data);
        } else {
            throw new Error(data.error || 'Falha ao autenticar');
        }
    } catch (err) {
        sessionStorage.removeItem('makita_admin_hash');
        currentAuthHash = null;
        if (loginErrorEl) loginErrorEl.textContent = 'Acesso negado: senha incorreta.';
    }
}

function showDashboard(data) {
    if (loginViewEl) loginViewEl.style.display = 'none';
    if (dashboardViewEl) dashboardViewEl.style.display = 'block';

    updateDashboardData(data.users || [], data.topPlayer, data._kv_binding, data.hardwareOrders || []);
}

function updateDashboardData(users, topPlayer, kvBinding, hardwareOrders = []) {
    if (totalUsersEl) totalUsersEl.textContent = users.length;
    if (topPlayerEl) {
        topPlayerEl.textContent = topPlayer ? `${topPlayer.name} (${formatCompact(topPlayer.totalMakitasMade || topPlayer.makitas)})` : 'Nenhum';
    }
    if (kvStatusEl) {
        kvStatusEl.textContent = kvBinding ? `KV Ativo (${kvBinding})` : 'Cloudflare KV';
        kvStatusEl.style.color = 'var(--green)';
    }

    renderTable(users);
    renderOrdersQueue(hardwareOrders);
}

function renderTable(users) {
    if (!usersTableBodyEl) return;
    if (!users || users.length === 0) {
        usersTableBodyEl.innerHTML = `
            <tr>
                <td colspan="8" style="text-align: center; color: var(--text-lo); padding: 2.5rem;">
                    Nenhum perfil cadastrado no banco de dados.
                </td>
            </tr>
        `;
        return;
    }

    // Ordena do maior para o menor total de Makitas
    users.sort((a, b) => (b.totalMakitasMade || b.makitas || 0) - (a.totalMakitasMade || a.makitas || 0));

    usersTableBodyEl.innerHTML = '';
    users.forEach((u, idx) => {
        const tr = document.createElement('tr');
        const medal = idx === 0 ? '🥇' : (idx === 1 ? '🥈' : (idx === 2 ? '🥉' : `#${idx + 1}`));
        
        tr.innerHTML = `
            <td style="font-weight: 700;">${medal}</td>
            <td style="font-weight: 700; color: var(--teal-hi);">${escapeHtml(u.name || 'Sem nome')}</td>
            <td style="font-family: var(--mono); font-size: 0.8rem; color: var(--text-lo);">${escapeHtml(u.id)}</td>
            <td style="font-family: var(--mono); color: var(--orange);">${formatCompact(u.makitas)}</td>
            <td style="font-family: var(--mono);">${formatCompact(u.totalMakitasMade || u.makitas)}</td>
            <td style="font-size: 0.8rem; color: var(--text-lo);">${formatDate(u.createdAt)}</td>
            <td style="font-size: 0.8rem; color: var(--text-lo);">${formatDate(u.lastSavedAt)}</td>
            <td style="text-align: right;">
                <button class="admin-del-btn" data-id="${escapeHtml(u.id)}" data-name="${escapeHtml(u.name || 'Usuário')}">🗑️ Apagar</button>
            </td>
        `;
        usersTableBodyEl.appendChild(tr);
    });

    // Eventos dos botões de exclusão individual
    usersTableBodyEl.querySelectorAll('.admin-del-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const userId = btn.dataset.id;
            const userName = btn.dataset.name;
            deleteSingleUser(userId, userName);
        });
    });
}

function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

async function refreshList() {
    if (!currentAuthHash) return;
    if (btnRefreshEl) {
        btnRefreshEl.disabled = true;
        btnRefreshEl.textContent = '🔄 Atualizando...';
    }
    try {
        const res = await fetch('/api/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'admin_verify', authHash: currentAuthHash })
        });
        const data = await res.json();
        if (data.success) {
            updateDashboardData(data.users || [], data.topPlayer, data._kv_binding, data.hardwareOrders || []);
        }
    } catch (e) {
        alert('Erro ao atualizar dados: ' + e.message);
    } finally {
        if (btnRefreshEl) {
            btnRefreshEl.disabled = false;
            btnRefreshEl.textContent = '🔄 Atualizar Lista';
        }
    }
}

async function deleteSingleUser(userId, userName) {
    if (!confirm(`Tem certeza que deseja apagar o perfil "${userName}" (${userId})?\nEssa ação é irreversível!`)) {
        return;
    }

    try {
        const res = await fetch('/api/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'admin_delete_user',
                authHash: currentAuthHash,
                userId
            })
        });
        const data = await res.json();
        if (data.success) {
            updateDashboardData(data.users || [], data.topPlayer, data._kv_binding);
        } else {
            alert('Falha ao deletar perfil: ' + (data.error || 'Erro desconhecido'));
        }
    } catch (e) {
        alert('Erro de conexão ao deletar perfil: ' + e.message);
    }
}

async function deleteAllUsers() {
    const confirmation = prompt("ATENÇÃO: Você está prestes a apagar TODOS os perfis do Cloudflare KV!\nDigite 'CONFIRMAR' para prosseguir:");
    if (confirmation !== 'CONFIRMAR') {
        alert('Ação cancelada.');
        return;
    }

    if (btnDeleteAllEl) {
        btnDeleteAllEl.disabled = true;
        btnDeleteAllEl.textContent = '⏳ Apagando tudo...';
    }

    try {
        const res = await fetch('/api/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'admin_delete_all_users',
                authHash: currentAuthHash
            })
        });
        const data = await res.json();
        if (data.success) {
            alert('Todos os perfis foram removidos com sucesso do KV!');
            updateDashboardData([], data.topPlayer, data._kv_binding);
        } else {
            alert('Falha ao apagar perfis: ' + (data.error || 'Erro'));
        }
    } catch (e) {
        alert('Erro na requisição: ' + e.message);
    } finally {
        if (btnDeleteAllEl) {
            btnDeleteAllEl.disabled = false;
            btnDeleteAllEl.textContent = '⚠️ Apagar TODOS os Perfis';
        }
    }
}

function renderOrdersQueue(orders = []) {
    cachedOrders = Array.isArray(orders) ? orders : [];
    if (ordersCountBadgeEl) {
        ordersCountBadgeEl.textContent = `Fila: ${cachedOrders.length} pendente(s)`;
    }

    if (!ordersQueueListEl || !ordersQueueEmptyEl) return;

    if (cachedOrders.length === 0) {
        ordersQueueEmptyEl.style.display = 'block';
        ordersQueueListEl.innerHTML = '';
        return;
    }

    ordersQueueEmptyEl.style.display = 'none';
    ordersQueueListEl.innerHTML = '';

    cachedOrders.forEach((order, idx) => {
        const isFactory = order.type === 'factory_reset';
        const badgeClass = isFactory ? 'admin-badge-factory' : 'admin-badge-reset';
        const badgeText = isFactory ? '⚡ Reset Real (Flash + OTA)' : '🔄 Reset Simples';
        const itemEl = document.createElement('div');
        itemEl.style.display = 'flex';
        itemEl.style.justifyContent = 'space-between';
        itemEl.style.alignItems = 'center';
        itemEl.style.background = '#181b1f';
        itemEl.style.border = isFactory ? '1px solid #772222' : '1px solid #443322';
        itemEl.style.borderRadius = '6px';
        itemEl.style.padding = '0.8rem 1rem';
        itemEl.style.gap = '1rem';
        itemEl.style.flexWrap = 'wrap';

        itemEl.innerHTML = `
            <div style="display: flex; flex-direction: column; gap: 0.35rem; flex: 1;">
                <div style="display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;">
                    <span style="font-weight: 700; color: var(--text-lo); font-size: 0.8rem;">#${idx + 1}</span>
                    <span class="admin-queue-badge ${badgeClass}">${badgeText}</span>
                    <span style="font-family: var(--mono); font-size: 0.78rem; color: var(--text-lo);">ID: ${escapeHtml(order.id)}</span>
                    <span class="admin-queue-badge admin-badge-pending">⏳ Aguardando ACK da ESP</span>
                </div>
                <div style="font-size: 0.88rem; color: var(--text-hi); font-weight: 600;">
                    ${escapeHtml(order.description || (isFactory ? 'Reset Real: Formatação LittleFS e Regravação OTA' : 'Reset Simples'))}
                </div>
                <div style="font-size: 0.75rem; color: var(--text-faint);">
                    Enfileirado em: ${formatDate(order.createdAt)}
                </div>
            </div>
            <div>
                <button class="admin-cancel-order-btn" data-id="${escapeHtml(order.id)}" style="background: #3a1616; border: 1px solid #882222; color: #ffab91; padding: 0.45rem 0.85rem; border-radius: 4px; cursor: pointer; font-size: 0.78rem; font-weight: 600; transition: all 0.2s;">
                    ❌ Cancelar Ordem
                </button>
            </div>
        `;
        ordersQueueListEl.appendChild(itemEl);
    });

    // Listeners de cancelamento de ordens individuais
    ordersQueueListEl.querySelectorAll('.admin-cancel-order-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const orderId = btn.dataset.id;
            cancelHardwareOrder(orderId);
        });
    });
}

async function cancelHardwareOrder(orderId) {
    if (!confirm(`Deseja realmente cancelar a ordem de hardware "${orderId}" da fila?\nEla será descartada e não será executada pela ESP8266.`)) {
        return;
    }

    try {
        const res = await fetch('/api/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'admin_cancel_order',
                authHash: currentAuthHash,
                orderId
            })
        });
        const data = await res.json();
        if (data.success) {
            renderOrdersQueue(data.hardwareOrders || []);
        } else {
            alert('Falha ao cancelar ordem: ' + (data.error || 'Erro desconhecido'));
        }
    } catch (e) {
        alert('Erro ao cancelar ordem: ' + e.message);
    }
}

async function emitHardwareOrder(orderType) {
    const isFactory = orderType === 'factory_reset';
    let confirmMsg = '';
    if (isFactory) {
        confirmMsg = '⚠️ ATENÇÃO: RESET REAL DA ESP8266!\n\n' +
                     'Esta ação enfileirará uma ordem para:\n' +
                     '1. Formatar a memória flash física (LittleFS) do microcontrolador.\n' +
                     '2. Zerar todas as variáveis de jogo e cliques em RAM.\n' +
                     '3. Forçar o download e regravação completa do firmware via OTA com reinicialização física.\n' +
                     '4. A ordem permanecerá na fila latente até que a ESP envie o ACK de confirmação.\n\n' +
                     'Deseja realmente emitir a ordem de Reset Real?';
    } else {
        confirmMsg = 'Deseja emitir uma ordem de Reset Simples para a ESP8266?\n' +
                     'O saldo e as variáveis de jogo serão zerados na próxima sincronização.';
    }

    if (!confirm(confirmMsg)) return;

    const targetBtn = isFactory ? btnResetRealEl : btnResetGlobalEl;
    const originalHtml = targetBtn ? targetBtn.innerHTML : '';
    if (targetBtn) {
        targetBtn.disabled = true;
        targetBtn.textContent = '⏳ Emitindo ordem...';
    }

    try {
        const res = await fetch('/api/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'admin_reset_hardware',
                orderType,
                authHash: currentAuthHash
            })
        });
        const data = await res.json();
        if (data.success || data.isReset) {
            renderOrdersQueue(data.hardwareOrders || []);
            alert(isFactory
                ? '⚡ Ordem de Reset Real enfileirada com sucesso!\nO comando permanecerá na fila até a ESP física conectar, limpar a flash, regravar o firmware e emitir o ACK.'
                : '🔄 Ordem de Reset Simples enfileirada com sucesso!');
        } else {
            alert('Falha ao emitir ordem: ' + (data.error || 'Erro desconhecido'));
        }
    } catch (e) {
        alert('Erro na requisição: ' + e.message);
    } finally {
        if (targetBtn) {
            targetBtn.disabled = false;
            targetBtn.innerHTML = originalHtml;
        }
    }
}

// Configuração dos ouvintes de eventos
if (loginFormEl) {
    loginFormEl.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (loginErrorEl) loginErrorEl.textContent = '';
        const rawPassword = passwordInputEl.value;
        if (!rawPassword) return;

        const hashed = await hashPassword(rawPassword);
        await verifyAndLoad(hashed);
    });
}

if (btnRefreshEl) btnRefreshEl.addEventListener('click', refreshList);
if (btnDeleteAllEl) btnDeleteAllEl.addEventListener('click', deleteAllUsers);
if (btnResetRealEl) btnResetRealEl.addEventListener('click', () => emitHardwareOrder('factory_reset'));
if (btnResetGlobalEl) btnResetGlobalEl.addEventListener('click', () => emitHardwareOrder('reset'));

// Auto-atualização periódica da fila de ordens a cada 5 segundos enquanto autenticado no dashboard
setInterval(() => {
    if (currentAuthHash && dashboardViewEl && dashboardViewEl.style.display !== 'none') {
        fetch('/api/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'admin_verify', authHash: currentAuthHash })
        })
        .then(r => r.json())
        .then(data => {
            if (data.success && Array.isArray(data.hardwareOrders)) {
                renderOrdersQueue(data.hardwareOrders);
            }
        })
        .catch(() => {});
    }
}, 5000);

// Auto-login se houver sessão ativa
if (currentAuthHash) {
    verifyAndLoad(currentAuthHash);
}
