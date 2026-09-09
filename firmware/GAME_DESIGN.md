# 🎮 Arquitetura e Organização do Jogo — MakitaClicker (Edição 99B)

> Documento de referência técnica para o funcionamento, regras de negócio, mecânicas de gameplay, árvore de habilidades, persistência de dados e comunicação hardware/software.

---

## 1. ⚙️ Visão Geral do Sistema

O **MakitaClicker** é um jogo incremental híbrido físico/digital. A arquitetura atual é 100% autônoma no microcontrolador **ESP8266 NodeMCU**, sem necessidade de placas secundárias. O estado de jogo e a telemetria sincronizam com a nuvem na infraestrutura **Cloudflare Pages (Dual-Engine D1 SQL + Cloudflare KV)**, conectando o console físico do laboratório à **Interface Web**.

```
    ┌──────────────────────┐    ┌────────────────────────────────────────┐    ┌──────────────────────┐
    │     Navegador        │    │      Cloudflare Edge Serverless        │    │  ESP8266 NodeMCU     │
    │  (Desktop / Mobile)  │◀──▶│        makitaclicker.pages.dev         │◀──▶│  (Hardware Físico)   │
    │                      │    │   - Cloudflare D1 (SQL Primário)       │    │                      │
    │ - Taxa Nativa (dt)   │    │   - Cloudflare KV (Cache Rápido)       │    │ - Display LCD 20x4   │
    │ - Perfis & Auto-Sync │    │   - Desduplicação de Nomes             │    │ - Dono / Top no LCD  │
    │ - Loja de Oficinas   │    │   - Reconciliação & Top Player         │    │ - Botão Físico (D5)  │
    │ - Tomar ESP (Lease)  │    │   - Hardware Lease (Posse Exclusiva)   │    │ - Flash LittleFS     │
    │ - Proteção Anti-Bot  │    │   - Auto-Update OTA (/version.json)    │    │ - Auto-Update OTA    │
    └──────────────────────┘    └────────────────────────────────────────┘    └──────────────────────┘
```

---

## 2. 🌳 Árvore de Habilidades & Melhorias Permanentes (20 Tecnologias até 99B)

As melhorias permanentes fornecem **multiplicadores e bônus diretos** tanto na produção manual (clique) quanto na produção passiva (MPS).

### Regras de Desbloqueio e Visibilidade (Névoa de Guerra):
- **Oculto (🔒):** O jogador ainda não atingiu o saldo acumulado de Makitas necessário nem comprou a melhoria anterior.
- **Revelado / Requisito Pendente (⏳):** Visível quando o jogador atinge o volume histórico de Makitas, mas exige a compra do nó pai na árvore.
- **Disponível (🔶):** Pré-requisito atendido e saldo suficiente para compra.
- **Adquirido (🟢):** Bônus ativo de forma permanente.

### Tabela Completa de Habilidades (20 Tecnologias):

| ID | Nome | Ícone | Custo | Req. Makitas | Pré-requisito | Efeito Real no Jogo |
|---|---|:---:|---|---|---|---|
| `perm_lubrificante` | Óleo Sintético Premium | 🛢️ | 25 | 10 | *Nenhum* | **+10% MPS Global** em todas as fontes |
| `perm_disco_diamante` | Disco Diamantado Reforçado | 💠 | 100 | 50 | `perm_lubrificante` | **+1.0 Poder de Clique** (Clique base passa de 1 para 2) |
| `perm_motor_brushless` | Motor Brushless Industrial | ⚡ | 300 | 150 | `perm_lubrificante` | **2x Produção Base** de todas as oficinas |
| `perm_empunhadura` | Empunhadura Ergonômica Pro | 🧤 | 600 | 250 | `perm_disco_diamante` | **Clique Sinergético**: Cada clique gera +5% do MPS atual |
| `perm_bateria_lítio` | Bateria Makita 40V Max XGT | 🔋 | 1.500 | 600 | `perm_motor_brushless` | **+25% MPS Global** permanente |
| `perm_ia_maker` | MakerBot Autônomo com IA | 🤖 | 5.000 | 2.000 | `perm_bateria_lítio` | **+50% MPS Global** permanente |
| `perm_refrigeracao` | Sistema Criogênico de Nitrogênio | ❄️ | 15.000 | 6.000 | `perm_motor_brushless` | **+20% MPS Global** permanente |
| `perm_titanio` | Lâmina de Titânio a Plasma | 🗡️ | 35.000 | 12.000 | `perm_disco_diamante` | **+3.0 Poder de Clique** manual |
| `perm_overclock` | Circuito de Overclock Extremo | ⚡ | 100.000 | 30.000 | `perm_empunhadura` | **Sinergia Dobrada**: Cada clique gera **+10% do MPS** |
| `perm_nanobots` | Enxame de Nanobots Montadores | 🔬 | 250.000 | 80.000 | `perm_ia_maker` | **+75% MPS Global** permanente |
| `perm_singularidade` | Núcleo de Singularidade Maker | 🌌 | 1.000.000 | 300.000 | `perm_nanobots` | **+150% MPS Global** e triplica o clique base |
| `perm_plasma_cutter` | Cortador a Plasma Estelar | ✨ | 5.000.000 | 1.500.000 | `perm_titanio` | **+25.0 Poder de Clique** base |
| `perm_fusao_fria` | Reator de Fusão Fria Compacta | 🧪 | 20.000.000 | 6.000.000 | `perm_singularidade` | **+100% MPS Global** permanente |
| `perm_hiperconducao` | Hipercondutores de Grafeno | ⚡ | 80.000.000 | 25.000.000 | `perm_fusao_fria` | **3x Produção Base** de todas as oficinas |
| `perm_sinergia_quantica` | Sinergia Quântica de Impacto | 🔮 | 300.000.000 | 100.000.000 | `perm_overclock` | **Sinergia Quântica**: Cada clique gera **+20% do MPS** |
| `perm_laser_gama` | Emissor Laser de Raios Gama | 🌠 | 1.200.000.000 | 400.000.000 | `perm_plasma_cutter` | **+200.0 Poder de Clique** base |
| `perm_taquions` | Reator de Táquions Espacial | ⏳ | 5.000.000.000 | 1.500.000.000 | `perm_hiperconducao` | **+200% MPS Global** permanente |
| `perm_materia_escura` | Condensador de Matéria Escura | 🌑 | 20.000.000.000 | 6.000.000.000 | `perm_taquions` | **+300% MPS Global** permanente |
| `perm_hiper_clique` | Martelo de Fótons Subatômico | 🔨 | 50.000.000.000 | 15.000.000.000 | `perm_laser_gama` | **10x Multiplicador de Clique** total |
| `perm_onipotencia_maker` | Onipotência Maker Cósmica | 👑 | 99.000.000.000 | 35.000.000.000 | `perm_materia_escura` | **+500% MPS Global**, 4x oficinas e **+30% MPS por clique** |

---

## 3. 🏭 Loja de Upgrades (24 Oficinas de Produção Passiva)

- **Fórmula de Custo por Unidade:**
  $$\text{Custo}(n) = \lceil \text{baseCost} \times \text{growth}^n \rceil$$
- **Teto Máximo:** 100 unidades por tipo de oficina (`MAX_OWNED = 100`).
- **Modos de Compra:** `1x`, `10x`, `MAX` (calcula o lote máximo acessível com o saldo atual sem ultrapassar 100).

### Tabela Completa de 24 Upgrades da Loja:

| ID | Nome | Ícone | Custo Base | Growth | Produção (MPS) |
|---|---|:---:|---|---|---|
| `upgrade1` | Bancada Básica | ⚙️ | 10 | 1.10 | +0.1 MPS |
| `upgrade_1mps` | Esmerilhadeira Manual | 🪚 | 100 | 1.12 | +1.0 MPS |
| `upgrade_2mps` | Serra Mármore 1400W | ⚡ | 250 | 1.12 | +2.0 MPS |
| `upgrade_5mps` | Torno Mecânico | 🔧 | 750 | 1.13 | +5.0 MPS |
| `upgrade_10mps` | Fresadora CNC | 🎛️ | 1.800 | 1.13 | +10.0 MPS |
| `upgrade_15mps` | Robô de Solda Industrial | 🦾 | 3.500 | 1.14 | +15.0 MPS |
| `upgrade_20mps` | Cortadora a Laser CO2 | 🔴 | 6.000 | 1.14 | +20.0 MPS |
| `upgrade_25mps` | Prensa Hidráulica 50T | 🏗️ | 10.000 | 1.14 | +25.0 MPS |
| `upgrade_30mps` | Impressora 3D de Metal | 🖨️ | 16.000 | 1.15 | +30.0 MPS |
| `upgrade_50mps` | Linha de Montagem IA | 🤖 | 35.000 | 1.15 | +50.0 MPS |
| `upgrade_100mps` | Mega Fábrica Makita | 🏭 | 100.000 | 1.15 | +100.0 MPS |
| `upgrade_200mps` | Reator de Fusão Maker | ☢️ | 300.000 | 1.16 | +200.0 MPS |
| `upgrade_500mps` | Estação Espacial Orbital | 🛸 | 1.000.000 | 1.16 | +500.0 MPS |
| `upgrade_1200mps` | Acelerador de Partículas Makita | 🌀 | 3.500.000 | 1.16 | +1.200.0 MPS |
| `upgrade_3000mps` | Mineração de Asteroides | ☄️ | 12.000.000 | 1.16 | +3.000.0 MPS |
| `upgrade_8000mps` | Usina Vulcânica Maker | 🌋 | 40.000.000 | 1.17 | +8.000.0 MPS |
| `upgrade_20kmps` | Forja de Antimatéria | ⚛️ | 150.000.000 | 1.17 | +20.000.0 MPS |
| `upgrade_60kmps` | Computador Quântico UNIFEI | 💻 | 500.000.000 | 1.17 | +60.000.0 MPS |
| `upgrade_180kmps` | Esfera de Dyson Makita | ☀️ | 1.800.000.000 | 1.17 | +180.000.0 MPS |
| `upgrade_500kmps` | Portal Dimensional Maker | 🌌 | 6.000.000.000 | 1.18 | +500.000.0 MPS |
| `upgrade_1500kmps` | Manipulador Gravitacional | 🪐 | 20.000.000.000 | 1.18 | +1.500.000.0 MPS |
| `upgrade_5000kmps` | Motor de Dobra Espacial | 🚀 | 60.000.000.000 | 1.18 | +5.000.000.0 MPS |
| `upgrade_15000kmps` | Fábrica de Realidade Paralela | 🔮 | 200.000.000.000 | 1.19 | +15.000.000.0 MPS |
| `upgrade_50000kmps` | Big Bang Maker Contínuo | 💥 | 800.000.000.000 | 1.19 | +50.000.000.0 MPS |

---

## 4. 💾 Persistência de Dados e Reset

- **Arquivo no LittleFS:** `/gamestate.json`
- **Wear-Leveling Shield:** A gravação na flash ocorre a cada **30 segundos**, mas **apenas se houver alterações reais pendentes** (`isFlashDirty == true`). Evita gravações redundantes, reduzindo o desgaste da flash em mais de 90%.
- **Carregamento Automático:** No boot, o ESP executa `loadGameState()` e restaura a partida exatamente de onde parou.
- **Handshake de Reset Bidirecional (Zero-Recursion):**
  1. Nuvem envia `resetOrder: true`.
  2. ESP8266 zera a RAM, formata `/gamestate.json` no LittleFS e exibe `Status: Reset OK!`.
  3. No próximo ciclo de loop, a ESP transmite de forma não-bloqueante a confirmação `resetAck: true`.
  4. Nuvem limpa a pendência `resetPendingEsp = false`.

---

## 5. 📡 Protocolo de Comunicação HTTPS REST

A ESP8266 comunica-se diretamente com a Cloudflare através do endpoint `/api/state`:

### Sincronização Periódica (`sync`):
- **Cadência Dinâmica:** A cada **2.0 segundos** quando o botão físico estiver sendo acionado, ou a cada **3.5 segundos** em repouso.
- **Buffers TLS BearSSL:** `2560` bytes (RX) e `768` bytes (TX) com timeout de `2500ms`.
- **Payload Enviado:** Cliques pendentes, makitas, versão de firmware, IP local, RSSI Wi-Fi, uptime e RAM livre.
- **Resposta da Nuvem:** JSON compacto (< 700 bytes) contendo estado mestre, dono do hardware (`hardwareController`) e `topPlayer`.

---

## 6. 📺 Display LCD I2C 20×4 na NodeMCU

O display é acionado diretamente pela ESP8266 no barramento I2C a **400 kHz** com double-buffering estático (`char[21]`) e sanitização ASCII:

- **Linha 0 (Dono / Top Player):**
  - Se a ESP foi tomada via Web: `Dono: <Nome> (MM:SS)` com contagem regressiva de até 3 minutos.
  - Se estiver livre: `1o: <Nome> (<Saldo>)` com o líder geral do ranking.
  - Caracteres incompatíveis (como acentos, `ç`, `º`) são sanitizados para ASCII simples legível.
- **Linha 1 (Saldo Atual):**
  - `Makitas: 125.4k MKT` (ou `Makitas: 99B (META!)` ao bater o objetivo).
- **Linha 2 (Produção / Corte):**
  - `Prod: +15.0/s   (+1)`
  - Alterna instantaneamente para `>> CORTE EFETUADO! <<` por 600 ms ao pressionar o botão físico D5.
- **Linha 3 (Status Operacional ao Vivo):**
  - `Status: Ativo` (Wi-Fi e nuvem sincronizados)
  - `Status: Conectando` (Negociando Wi-Fi)
  - `Status: Offline` (Modo autônomo local sem rede)
  - `Status: Sincroniz.` (Trocando pacotes HTTPS)
  - `Status: Apagando...` / `Status: Reset OK!` (Executando reset)
  - `>> GRAVANDO: XX% <<` (Barra de progresso durante atualização OTA)
