# Guia de Arquitetura e Desenvolvimento para IAs (MakitaClicker)

Este documento descreve as regras, arquitetura e convenções do projeto **MakitaClicker**. Qualquer assistente de IA ou agente que modificar o código deve ler estas diretrizes antes de realizar alterações.

## 🏗️ 1. Arquitetura Geral

O projeto é um jogo incremental (Cookie Clicker) **híbrido** (Físico + Web).
- **Web (`web/`):** Frontend Vanilla JS + CSS, empacotado via **Vite**.
- **Backend (`functions/api/`):** API Serverless na Cloudflare Functions com Cloudflare KV (Banco de dados de Chave-Valor).
- **Firmware (`firmware/codigo_esp/`):** C++ rodando em um ESP8266 NodeMCU.
- **Build (`dist/`):** O comando `npm run build` cria a build Web via Vite e em seguida executa o script `build-firmware.sh` para compilar o `.bin` da ESP8266 (usando `arduino-cli`). Tudo é exportado para `dist/` e servido no Cloudflare Pages.

## 🧠 2. Padrões Técnicos e Regras de Negócio

### Frontend (Vanilla JS)
- **Não adicione frameworks** (como React ou Vue). O frontend é 100% Vanilla JS focado em performance.
- **Motor Gráfico:** O arquivo `game.js` roda o ciclo principal usando `requestAnimationFrame` na taxa de atualização nativa do monitor do usuário (sem bloqueio arbitrário a 60 FPS), calculando a produção passiva através do delta de tempo (`dt`).
- **DOM Throttling:** Atualizações no DOM que não exigem taxa máxima (como atualizar listas de oficinas, textos descritivos) devem ser feitas via throttling (~6 FPS) para manter o uso de CPU mínimo.
- **Sistema de Perfis de Usuário:** O jogo é individual por perfil (sem senha, focado em facilidade). O progresso local fica em `localStorage` sob a chave `makita_clicker_state_<userId>` e sincroniza na nuvem com Cloudflare KV a cada 3 minutos (auto-save) ou via botão manual ("Salvar na Nuvem").
- **Proteção contra Perda de Progresso:** Um listener `beforeunload` avisa o jogador caso ele tente fechar o navegador com progresso local não salvo há mais de 5 minutos.

### Backend (Reconciliação, Perfis e Compactação no KV)
- **Sincronismo Assíncrono:** O Frontend e a ESP enviam dados via POST para `/api/state`. 
- **Chaves no Cloudflare KV:**
  - `users:list`: Lista com metadados de todos os perfis cadastrados (`id`, `name`, `createdAt`, `lastSeen`, `makitas`).
  - `user:<userId>:state`: Estado individual de jogo do usuário.
  - `gamestate`: Estado global mantido para compatibilidade e sincronização da ESP8266 física.
- **Serialização Compacta:** Para otimizar armazenamento e cota de rede no KV, os upgrades e melhorias permanentes são compactados em vetores indexados:
  - `upgrades`: Array denso de 24 inteiros `[q0, q1, ..., q23]`.
  - `perms`: Array esparso contendo os índices numéricos das habilidades desbloqueadas `[0, 1, 4]`.
  - `resetEpoch`: Timestamp de época do último reset, utilizado para anular saves defasados de nós CDN com consistência eventual.
- **Top Player / Leaderboard:** O backend calcula automaticamente o jogador com maior saldo de Makitas (`topPlayer: { name, makitas }`) e o injeta nas respostas para o frontend e para o firmware da ESP8266.
- **Regra de Ouro (Isolamento de Saves vs. Hardware Global):** 
  - Perfis de usuário não herdam nem sofrem `Math.max` com o saldo da ESP física (`gamestate`).
  - O salvamento de usuário só é aceito se o `resetEpoch` do payload for `>=` ao `resetEpoch` gravado no KV, eliminando a ressurreição de saves zumbis decorrentes da consistência eventual da Cloudflare.
- **Painel Administrativo (`/admin.html`):**
  - Rota protegida por hash SHA-256 da senha `ADMIN_PASSWORD` (`c9a2abd67ad59717195e5d8a6f917ba5084d81af244b0a8d40c8b30f234742d7`).
  - Permite verificar credenciais (`admin_verify`), deletar perfil individual (`admin_delete_user`), deletar todos os perfis (`admin_delete_all_users`) e forçar reset global de hardware (`admin_reset_hardware`).
- O Cloudflare KV tem limite de gravações gratuitas (1.000 writes/dia). O backend utiliza cache e o frontend controla a periodicidade de salvamento do estado do usuário.

### Firmware (C++ ESP8266)
- **Sem bloqueios:** É proibido usar `delay()` no loop principal. Toda temporização deve ser não-bloqueante usando `millis()` ou `yield()`.
- **Interrupção de Hardware:** A leitura do botão físico no pino D5 deve sempre ser tratada por ISR (`ICACHE_RAM_ATTR`) com debounce por microssegundos e drenagem atômica no `loop()`, garantindo zero perda de cliques.
- **Display LCD (I2C 400 kHz):** O LCD (20x4) usa double-buffering estático em `char[21]` com `snprintf` e comparação por `strncmp`. Nunca use alocações dinâmicas de `String` no caminho de desenho.
- **Top Player na Tela:** A Linha 0 do LCD exibe o líder do ranking global recebido via nuvem (`1o: <nome> (<saldo>)`).
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
  `Web envia reset` -> `KV liga resetOrder=true` -> `ESP recebe ordem` -> `ESP apaga Flash` -> `ESP envia resetAck=true` -> `KV desliga resetOrder`.

## 🚀 4. Desenvolvimento Local
- **Frontend:** Rode `npm run dev`. O frontend vai detectar o modo local e cortar as requisições HTTPS para simular o jogo offline perfeitamente.
- **ESP8266:** Só precisa compilar a primeira vez via USB. A placa auto-atualiza o `.bin` via rede a cada push na branch `main`.
