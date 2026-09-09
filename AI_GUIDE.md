# Guia de Arquitetura e Desenvolvimento para IAs (MakitaClicker)

Este documento descreve as regras, arquitetura e convenções do projeto **MakitaClicker**. Qualquer assistente de IA ou agente que modificar o código deve ler estas diretrizes antes de realizar alterações.

## 🏗️ 1. Arquitetura Geral

O projeto é um jogo incremental (Cookie Clicker) **híbrido** (Físico + Web).
- **Web (`web/`):** Frontend Vanilla JS + CSS, empacotado via **Vite**.
- **Backend (`functions/api/`):** API Serverless na Cloudflare Functions com arquitetura **Dual-Engine (Cloudflare D1 SQL + Cloudflare KV)**. O D1 atua como armazenamento relacional primário autoritativo (100.000 gravações gratuitas/dia) e o KV como cache de leitura rápida e redundância.
- **Firmware (`firmware/codigo_esp/`):** C++ rodando em um ESP8266 NodeMCU autônomo com display LCD 20x4 I2C e botão mecânico de 0 ms.
- **Build (`dist/`):** O comando `npm run build` cria a build Web via Vite e em seguida executa o script `build-firmware.sh` para compilar o `.bin` da ESP8266 (usando `arduino-cli`). Tudo é exportado para `dist/` e servido no Cloudflare Pages.

## 🧠 2. Padrões Técnicos e Regras de Negócio

### Frontend (Vanilla JS)
- **Não adicione frameworks** (como React ou Vue). O frontend é 100% Vanilla JS focado em performance.
- **Motor Gráfico:** O arquivo `game.js` roda o ciclo principal usando `requestAnimationFrame` na taxa de atualização nativa do monitor do usuário (sem bloqueio arbitrário a 60 FPS), calculando a produção passiva através do delta de tempo (`dt`).
- **DOM Throttling:** Atualizações no DOM que não exigem taxa máxima (como atualizar listas de oficinas, textos descritivos) devem ser feitas via throttling (~6 FPS) para manter o uso de CPU mínimo.
- **Sistema de Nomes e Sanitização:** O apelido do jogador passa por `sanitizeNick()`, que remove acentos, cedilhas (`ç`), caracteres ordinais (`º`, `ª`) e caracteres de controle, restringindo a `[a-zA-Z0-9 _-]` com comprimento máximo de 16 caracteres para caber com segurança no display LCD 20x4 do hardware.
- **Desduplicação Automática:** Perfis com mesmo nome raiz recebem sufixos automáticos ordenados por data de criação (`Pedro`, `Pedro 2`, `Pedro 3`...). O nome mais antigo é preservado.
- **Auto-Upload & Recuperação de Perfis Locais:** Se o navegador contiver um perfil em `localStorage` que ainda não foi registrado na nuvem (ex: criado offline ou mobile), o frontend detecta (`userFound: false` na resposta `/api/state?userId=<id>`) e dispara automaticamente a criação (`create_user`) e o salvamento (`save_user_state`) com todo o progresso acumulado.
- **Salvamento na Nuvem:** O progresso sincroniza na nuvem com o D1 como banco primário a cada 15 segundos (auto-save) e via debounced saves em compras (2-3s) ou botão manual ("💾 Salvar na Nuvem"), com o KV atuando como backup secundário (throttled a cada 60s).
- **Posse do Console Físico (Hardware Lease):** Qualquer jogador pode tentar tomar a posse da ESP física clicando em "Tomar ESP" (ação `claim_hardware`), garantindo 180 segundos de exclusividade. O display LCD reflete o dono temporário e a contagem regressiva em tempo real.
- **Produção Offline (Teto de 24h):** O cliente salva continuamente a marca temporal de atividade (`lastOnline`). Ao carregar o perfil ou ao retornar à aba (`visibilitychange`), se o tempo ausente for $\ge 15\text{s}$, calcula os ganhos offline ($\text{MPS} \times \Delta t$, limitado a 24h) e exibe o modal `#offlineProgressModal`. No backend, `advancePassiveProduction` também respeita o limite de 24 horas e informa `offlineGain` na rota GET de perfil.
- **Proteção contra Perda de Progresso:** Um listener `beforeunload` avisa o jogador caso ele tente fechar o navegador com progresso local não salvo há mais de 5 minutos.
- **Proteção Anti-AutoClicker (Ban de 5 min por IP):** O cliente detecta cliques sintéticos (`isTrusted=false`), CPS desumano (>28 CPS) e variância robótica. Ao detectar, suspende o IP por 5 minutos gravando na tabela `ip_bans` (D1) e na chave `ban:ip:<clientIp>` (KV com TTL 300s). A placa física ESP8266 (`source: esp`) é estritamente imune.

### Backend (D1-Primary Authoritative + KV Secondary Backup)
- **Sincronismo Assíncrono:** O Frontend e a ESP enviam dados via POST para `/api/state`.
- **Armazenamento D1-Primary (com KV Backup Throttled):**
  - **Cloudflare D1 (SQL Primário Autoritativo - 100k writes/dia, 5M reads/dia):**
    - `users`: ID, nome desduplicado, saldo de makitas, timestamps de criação e último acesso.
    - `user_states`: Estado serializado completo em JSON, `reset_epoch` e timestamp de atualização.
    - `global_state`: Estado global mestre para `gamestate`, telemetria e fila de ordens da ESP8266.
    - `hardware_lease`: Registro único do dono temporário da ESP (`controller_user_id`, `controller_user_name`, `lease_expires_at`).
    - `ip_bans`: Lista de bloqueios temporários de IPs infratores.
  - **Cloudflare KV (Backup Secundário com Throttling de 60s):**
    - Gravações protegidas pelo helper `canWriteToKv()` para nunca estourar a cota gratuita de 1.000 writes/dia do KV.
    - `users:list`: Backup da lista de usuários.
    - `user:<userId>:state`: Backup do estado individual de jogo do usuário.
    - `gamestate`: Backup do estado global.
    - `hardware:controller`: Backup da posse da ESP.
- **Serialização Compacta:**
  - `upgrades`: Array denso de 24 inteiros `[q0, q1, ..., q23]`.
  - `perms`: Array esparso contendo os índices numéricos das habilidades desbloqueadas `[0, 1, 4]`.
  - `resetEpoch`: Timestamp de época do último reset, utilizado para anular saves defasados.
- **Otimização Crítica para Firmware ESP:** Quando uma requisição possui `source: 'esp'`, a API remove diagnósticos extensos da resposta e devolve um JSON enxuto (< 700 bytes) contendo apenas o estado mestre, multiplicadores, o dono do hardware e o `topPlayer`. Isso impede saturação de memória na ESP8266.
- **Top Player / Leaderboard:** O backend calcula automaticamente o jogador com maior saldo de Makitas (`topPlayer: { name, makitas }`) e o injeta nas respostas.
- **Regra de Ouro (Isolamento de Saves vs. Hardware Global):** 
  - Perfis de usuário não herdam nem sofrem `Math.max` com o saldo da ESP física (`gamestate`).
  - O salvamento de usuário só é aceito se o `resetEpoch` do payload for `>=` ao `resetEpoch` gravado no banco.
- **Painel Administrativo (`/admin.html`):**
  - Rota protegida por hash SHA-256 da senha `ADMIN_PASSWORD` (`c9a2abd67ad59717195e5d8a6f917ba5084d81af244b0a8d40c8b30f234742d7`).
  - Permite verificar credenciais (`admin_verify`), deletar perfil individual (`admin_delete_user`), deletar todos os perfis (`admin_delete_all_users`) e forçar reset global de hardware (`admin_reset_hardware`).

### Firmware (C++ ESP8266)
- **Sem bloqueios:** É proibido usar `delay()` no loop principal. Toda temporização deve ser não-bloqueante usando `millis()` ou `yield()`.
- **Interrupção de Hardware:** A leitura do botão físico no pino D5 é tratada por ISR (`ICACHE_RAM_ATTR`) com debounce por microssegundos e drenagem atômica no `loop()`. Zero cliques perdidos.
- **Buffers BearSSL Calibrados:** O cliente HTTPS usa `client.setBufferSizes(2560, 768)` e timeout de `2500ms`, garantindo recepção de pacotes TLS sem truncamento e liberando memória SRAM.
- **Cadência de Sincronização Dinâmica:** Sincroniza a cada 2.0s se houver cliques recentes pendentes, ou a cada 3.5s em repouso (idle).
- **Display LCD (I2C 400 kHz) & Sanitização:** Double-buffering estático em `char[21]`. A função `sanitizarParaLCD()` converte caracteres fora da tabela ASCII para caracteres legíveis.
- **Linha 0 do LCD Dinâmica:** Exibe `Dono: <Nome> (MM:SS)` se a ESP foi tomada via Web, ou `1o: <Nome> (<Saldo>)` com o líder geral caso a posse esteja livre.
- **LittleFS Wear-Leveling Shield:** O estado é persistido em `/gamestate.json` a cada 30 segundos, mas **apenas se houver alterações pendentes** (`isFlashDirty == true`). Sempre execute `LittleFS.end()` antes de gravações de OTA.
- **OTA Seguro:** O manifesto `version.json` exige validação por checksum criptográfico MD5 (`setMD5sum`) e buffer BearSSL completo para records de 16 KB.

## 🛠️ 3. Como Adicionar Funcionalidades (Playbook)

### Adicionar ou Modificar uma Oficina (Loja) ou Habilidade (Skill Tree)
O arquivo central configurável é o `game-config.json` na raiz do repositório. Ele é adicionado no build ao site e compartilhado automaticamente entre Frontend (`web/`) e Backend (`functions/api/`):
1. **Configuração Unificada (`game-config.json`):** Adicione ou altere o item no array `upgrades` (loja) ou `skillTree` (habilidades com requisitos, custos e `effects` dinâmicos).
2. **Firmware (`firmware/codigo_esp/codigo_esp.ino`):** Se a oficina ou habilidade afetar os multiplicadores físicos do hardware autônomo, espelhe na struct `UPGRADE_CONFIGS` ou na função `recalculateStats()` para a produção passiva offline do chip.
3. **Build e Sincronização:** O comando `npm run build` (ou `npm run dev`) sincroniza automaticamente o `game-config.json` para `dist/game-config.json`, `web/game-config.json` e `functions/api/game-config.json`.

### Modificar o Handshake de Reset
O reset é bidirecional para evitar ressurreição de dados offline antigos.
- Se alterar a lógica, mantenha o ciclo: 
  `Web envia reset` -> `D1/KV liga resetOrder=true` -> `ESP recebe ordem` -> `ESP apaga Flash` -> `ESP envia resetAck=true` -> `D1/KV desliga resetOrder`.

## 🚀 4. Desenvolvimento Local
- **Frontend:** Rode `npm run dev`. O frontend vai detectar o modo local e cortar as requisições HTTPS para simular o jogo offline perfeitamente.
- **ESP8266:** Só precisa compilar a primeira vez via USB. A placa auto-atualiza o `.bin` via rede a cada push na branch `main`.

## 🌐 5. API de Leitura Pública (Read-All API)
Como o repositório é privado, está disponível um token de leitura da Cloudflare para que serviços externos e IAs possam inspecionar os dados do banco D1/KV e telemetria:

- **API Token (Read-Only):** Definido via variável `$CF_READ_TOKEN` (chave `cfat_*` de leitura)
- **Account ID:** `<CLOUDFLARE_ACCOUNT_ID>`
- **D1 Database ID (`makitaclicker-db`):** `<SEU_D1_DATABASE_ID>`
- **KV Namespace ID (`makita-kv`):** `<SEU_KV_NAMESPACE_ID>`
- **Documentação Completa:** Consulte [`API_READ_GUIDE.md`](./API_READ_GUIDE.md) para exemplos práticos de chamadas `curl`, Node.js e Python para consultar o D1 SQL, o cache KV e os endpoints REST da aplicação.


