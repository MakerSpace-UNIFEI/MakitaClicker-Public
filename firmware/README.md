# 🔌 Firmware — MakitaClicker

Manual completo do firmware embarcado do **MakitaClicker** para o microcontrolador **ESP8266 NodeMCU (ESP-12E / ESP-12F)**.

O firmware é 100% autônomo e opera com arquitetura de alta performance:
- Leitura de botão físico via **Interrupção de Hardware (ISR)** com resposta instantânea de 0 ms e zero perda de cliques.
- Display LCD 20×4 I2C operando em **Fast Mode (400 kHz)** com **double-buffering estático** (zero alocação dinâmica no Heap) e **sanitização ASCII** de caracteres.
- Exibição de **Posse de Hardware** em tempo real (`Dono: <Nome> (MM:SS)`) e **Top Player Global** (`1o: <Nome> (<Saldo>)`).
- Persistência em memória flash protegida por **Wear-Leveling Shield** via **LittleFS** (gravação condicional).
- Reconexão Wi-Fi contínua e não-bloqueante a cada **10 segundos** com indicação visual dinâmica.
- Sincronização HTTPS com Cloudflare Pages Functions (Dual-Engine D1 + KV) com buffers BearSSL calibrados (`2560/768` bytes, timeout `2500ms`) e proteção contra *Stack Overflow* (zero recursão no reset).
- Auto-atualização de firmware **OTA (Over-The-Air)** com **checksum criptográfico MD5**, suporte a records de 16 KB e barra de progresso em tempo real no LCD.

---

## 📂 Estrutura de Arquivos

```
firmware/
├── codigo_esp/
│   └── codigo_esp.ino    # Código C++ Arduino unificado e otimizado para NodeMCU
│
├── projeto/              # Projeto de hardware no KiCad
│   ├── projeto.kicad_pcb # Layout da placa de circuito impresso
│   ├── projeto.kicad_sch # Esquemático eletrônico
│   └── projeto.kicad_pro # Projeto KiCad
│
└── GAME_DESIGN.md        # Tabela completa de balanceamento, custos e fórmulas
```

---

## ⚡ Conexões Elétricas e Pinagem (ESP8266 NodeMCU)

| Dispositivo | Pino no Componente | Pino na NodeMCU | Função / Tipo | Observações |
|---|---|---|---|---|
| **LCD 20×4 I2C** | **GND** | **GND** | Alimentação Negativa | Terra comum do circuito |
| **LCD 20×4 I2C** | **VCC** | **VV (ou VU)** | Alimentação Positiva 5V | **Obrigatório 5V** vindo da USB para contraste nítido do LCD |
| **LCD 20×4 I2C** | **SDA** | **D2 (GPIO 4)** | Barramento I2C Dados | Suporta auto-detecção de endereço (`0x27` ou `0x3F`) |
| **LCD 20×4 I2C** | **SCL** | **D1 (GPIO 5)** | Barramento I2C Clock | Configurado em **Fast Mode (400 kHz)** |
| **Botão Físico** | **Pino 1** | **D5 (GPIO 14)** | Interrupção Externa | `attachInterrupt` em modo `FALLING` com `INPUT_PULLUP` |
| **Botão Físico** | **Pino 2** | **GND** | Referência | O botão fecha no GND ao ser pressionado |

> ⚠️ **Importante sobre a Tensão no LCD (Pino VV):**  
> O display LCD 2004 com módulo PCF8574 necessita de **5V** para polarizar corretamente os cristais líquidos. Alimentar o VCC do LCD no pino 3V3 resultará em tela sem texto legível (contraste insuficiente). O pino **VV** (ou **VU** em alguns clones da NodeMCU) fornece diretamente os 5V provenientes do conector micro-USB.

---

## 📺 Funcionamento do Display LCD 20×4

O display opera com um layout industrial direto, limpo e sem poluição visual. Utiliza **double-buffering estático em arrays de caracteres (`char[21]`)**, eliminando o uso da classe `String` no caminho crítico de desenho para impedir a fragmentação da SRAM (DRAM):

```text
Linha 0: Dono: Victor (02:45)  OU  1o: Victor (12.5M)
Linha 1: Makitas: 45.2k MKT
Linha 2: Prod: +15.0/s   (+1)
Linha 3: Status: Ativo
```

### 1. Linha 0 (Posse de Hardware ou Líder Global)
- **Modo Posse Exclusiva (Hardware Lease):** Se algum jogador reivindicou a ESP pela Web ("Tomar ESP"), exibe o dono e a contagem regressiva de posse: `Dono: <Nome> (MM:SS)`.
- **Modo Livre (Líder Global / Top Player):** Quando livre, exibe o 1° colocado do ranking geral e seu saldo: `1o: <Nome> (<Saldo>)`. Se o ranking estiver vazio, exibe `1o: MakerSpace`.
- **Sanitização de Caracteres (`sanitizarParaLCD`):** Nomes com acentos ou caracteres especiais (ex: `ç`, `º`, `á`) são convertidos para caracteres ASCII puros correspondentes antes da exibição, prevenindo glifos defeituosos no controlador HD44780.
- Trunca dinamicamente o nome caso necessário para caber com precisão nos 20 caracteres da linha.

### 2. Linha 1 (Saldo Atual)
- Exibe o saldo de Makitas acumuladas no console: `Makitas: 125.4k MKT`.
- Ao atingir a meta lendária cósmica (99 Bilhões), a linha muda para: `Makitas: 99B (META!)`.

### 3. Linha 2 (Produção & Poder de Clique)
- Exibe a produção passiva por segundo (MPS) e o ganho por clique manual: `Prod: +15.0/s   (+1)`.
- **Feedback Tátil Instantâneo:** Ao pressionar o botão físico, a linha alterna temporariamente para `>> CORTE EFETUADO! <<` por 600 ms.

### 4. Linha 3 (Status Operacional em Tempo Real)
- Reflete o estado exato da máquina a cada momento:
  - `Status: Ativo` — Operação normal com Wi-Fi conectado e sincronizado.
  - `Status: Conectando` — Negociação WPA2 / DHCP com o roteador em andamento.
  - `Status: Offline` — Operando em modo autônomo local sem internet (retry a cada 10s).
  - `Status: Sincroniz.` — Pacote HTTPS sendo trocado com a Cloudflare.
  - `Status: Apagando...` — Ordem de reset em processamento.
  - `Status: Reset OK!` — Flash limpa e confirmação ACK transmitida.
  - `>> GRAVANDO: XX% <<` — Barra de progresso ao vivo durante atualização OTA.

---

## 🖱️ Captura de Cliques por Interrupção de Hardware (0 ms de Latência)

- O botão no pino **D5** é monitorado por interrupção externa (`FALLING`).
- A rotina de serviço de interrupção (`isrBotao()`) roda com atributo `ICACHE_RAM_ATTR` na memória IRAM rápida do Xtensa e aplica filtro temporal de 25 ms em microssegundos.
- No `loop()`, os cliques acumulados são drenados atomicamente com `noInterrupts()` / `interrupts()`.
- **Vantagem Crítica:** Mesmo durante o tempo em que o ESP8266 está efetuando o handshake TLS com a Cloudflare (que pode levar de 300 ms a 1 s), **nenhum clique mecânico do operador é perdido**.

---

## 💾 Persistência Flash com *Wear-Leveling Shield* (LittleFS)

- O save local é persistido no arquivo `/gamestate.json` usando o sistema de arquivos **LittleFS**.
- **Gravação Inteligente Condicional:** A gravação na flash SPI ocorre a cada 30 segundos, mas **somente se houver alterações reais não salvas** (`isFlashDirty == true`).
- Se o jogador estiver inativo ou apenas em produção passiva estática, nenhuma gravação inútil é disparada, **reduzindo o desgaste da memória flash em mais de 90%** e garantindo longa vida útil ao hardware.
- **Flush de Emergência:** O arquivo é gravado e o sistema de arquivos é desmontado com `LittleFS.end()` imediatamente antes de qualquer reinicialização por atualização OTA ou execução de reset.

---

## 📡 Telemetria e Sincronização HTTPS

A ESP8266 sincroniza com a nuvem via HTTPS POST para `/api/state`:
- **Cadência Dinâmica:** A cada **2.0 segundos** se houver cliques recentes pendentes, ou a cada **3.5 segundos** quando em repouso (idle), permitindo reação rápida a mudanças na liderança e na posse do console.

```json
{
  "action": "sync",
  "source": "esp",
  "clicks": 3,
  "makitas": 15400.0,
  "fwVersion": 63,
  "ip": "192.168.1.150",
  "rssi": -58,
  "uptime": 12450,
  "freeHeap": 41200
}
```

A nuvem responde com o estado mestre atualizado, multiplicadores, informações de posse (`hardwareController`) e o **Top Player**.
Os buffers TLS BearSSL são configurados em `client.setBufferSizes(2560, 768)` e `client.setTimeout(2500)`, prevenindo truncamento TLS e economizando DRAM sem estouro de buffer.

---

## 🔄 Protocolo de Reset Remoto (Zero-Recursion)

1. Quando o reset global é disparado na Web, a nuvem ativa a flag contínua `resetPendingEsp: true`.
2. Ao receber a ordem, a ESP8266 zera variáveis em RAM, exclui `/gamestate.json` da flash e exibe no display `Status: Reset OK!`.
3. A ESP8266 agenda o envio de confirmação (`resetAck: true`) de forma **não-bloqueante no próximo ciclo de loop** (sem chamadas recursivas a `syncWithCloud()`), protegendo a pilha de execução contra *Stack Overflow*.
4. Apenas ao receber o ACK, a nuvem desativa a ordem latente, encerrando o ciclo com segurança absoluta.

---

## 📶 Reconexão Wi-Fi Rápida e Não-Bloqueante (10s)

- Caso o Wi-Fi falhe no boot ou o sinal do roteador caia, o microcontrolador entra no modo offline com persistência e cliques 100% funcionais.
- A cada **10 segundos**, a ESP8266 dispara uma tentativa assíncrona de reconexão.
- Durante a negociação inicial (primeiros 4 segundos), o LCD exibe `Status: Conectando`. Se a conexão falhar, retorna a `Status: Offline` até o próximo ciclo de 10 segundos.

---

## 🚀 Auto-Update de Firmware via Nuvem (OTA)

1. A ESP8266 consulta o manifesto `https://makitaclicker.pages.dev/version.json` no boot, na reconexão Wi-Fi e periodicamente a cada 5 minutos.
2. Se `firmware_version` for superior a `CURRENT_FIRMWARE_VER`:
   - O save pendente é salvo e o LittleFS é descarregado com `LittleFS.end()`.
   - O LCD é limpo e exibe a tela de atualização:
     ```text
     ====================
       ATUALIZANDO OTA   
      v62 -> v63         
     >> GRAVANDO:  0% <<
     ```
   - O download ocorre através de um cliente TLS BearSSL sem restrição de buffer (suportando records completos de 16 KB da Cloudflare Pages CDN).
   - O **Checksum MD5** recebido no manifesto é validado criptograficamente com `ESPhttpUpdate.setMD5sum(fwMd5)`. Se o download truncar ou falhar, a gravação é rejeitada automaticamente.
   - O hook `ESPhttpUpdate.onProgress(...)` atualiza a porcentagem de gravação em tempo real no display (`>> GRAVANDO: XX% <<`).
   - A ESP8266 reinicia automaticamente rodando a nova versão.

---

## 🛠️ Como Gravar o Firmware Inicialmente (USB)

Apenas o **primeiro flash** precisa ser feito via cabo USB. Depois disso, todos os futuros updates ocorrem pelo ar via OTA.

1. Instale a [Arduino IDE](https://www.arduino.cc/en/software) ou utilize o [`build-firmware.sh`](../build-firmware.sh).
2. Adicione a URL do Core ESP8266 em **Preferências > URLs Adicionais para Gerenciadores de Placas**:
   ```
   https://arduino.esp8266.com/stable/package_esp8266com_index.json
   ```
3. Instale a placa **esp8266** (versão 3.1.2 ou superior) no Gerenciador de Placas.
4. No menu **Gerenciador de Bibliotecas**, instale:
   - **ArduinoJson** (versão 6 ou 7)
   - **LiquidCrystal I2C**
5. Conecte a NodeMCU no computador via micro-USB.
6. Selecione a placa **NodeMCU 1.0 (ESP-12E Module)** e a porta correspondente.
7. Configure as credenciais do seu Wi-Fi criando `codigo_esp/secrets.h` (baseado no modelo `codigo_esp/secrets.example.h`) ou via variáveis de ambiente `WIFI_SSID` e `WIFI_PASSWORD` no CI/CD.
8. Abra `codigo_esp/codigo_esp.ino` e clique em **Upload**.
