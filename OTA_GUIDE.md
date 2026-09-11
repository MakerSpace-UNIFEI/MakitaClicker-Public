# 📡 Guia Definitivo: Sistema OTA Autônomo com Progresso no Display LCD (ESP8266 + Cloudflare Pages + GitHub)

> **MakerSpace UNIFEI**  
> **Tecnologia:** ESP8266 (NodeMCU) · C++ Arduino · Cloudflare Pages (CI/CD Gratuito) · GitHub · I2C LCD 20×4 / 16×2  
> **Objetivo:** Isolar e documentar do zero um sistema completo de atualização de firmware pelo ar (*Over-The-Air - OTA*) com feedback visual em tempo real de porcentagem no display LCD, verificação criptográfica MD5 e deploy automatizado a cada `git push`.

---

## 📑 Sumário

1. [Visão Geral e Arquitetura](#1-visão-geral-e-arquitetura)
2. [Lista de Materiais e Conexões Físicas (Pinout)](#2-lista-de-materiais-e-conexões-físicas-pinout)
3. [Estrutura de Pastas do Repositório](#3-estrutura-de-pastas-do-repositório)
4. [Código C++ do Firmware Isolado (`ota_lcd.ino`)](#4-código-c-do-firmware-isolado-ota_lcdino)
5. [Script de Build de Produção (`build-firmware.sh`)](#5-script-de-build-de-produção-build-firmwaresh)
6. [Arquivo de Configuração NPM (`package.json`)](#6-arquivo-de-configuração-npm-packagejson)
7. [Configuração do Repositório GitHub](#7-configuração-do-repositório-github)
8. [Configuração do Cloudflare Pages (Hospedagem & CI/CD)](#8-configuração-do-cloudflare-pages-hospedagem--cicd)
9. [Fluxo de Trabalho Diário (Do Código ao Chip)](#9-fluxo-de-trabalho-diário-do-código-ao-chip)
10. [Engenharia e Boas Práticas Críticas](#10-engenharia-e-boas-práticas-críticas)
11. [Guia de Diagnóstico e Resolução de Problemas (Troubleshooting)](#11-guia-de-diagnóstico-e-resolução-de-problemas-troubleshooting)

---

## 1. Visão Geral e Arquitetura

O sistema implementa uma esteira de entrega contínua (*Continuous Deployment*) para dispositivos embarcados sem depender de servidores dedicados pagos, túneis ngrok ou IPs públicos na placa:

```
                                  [ DESENVOLVEDOR ]
                                          │
                                     git push
                                          │
                                          ▼
                                 [ REPOSITÓRIO GITHUB ]
                                          │
                                  Webhook Automático
                                          │
                                          ▼
                             [ CLOUDFLARE PAGES (BUILD) ]
                             │ 1. Instala arduino-cli
                             │ 2. Compila .ino para .bin
                             │ 3. Calcula Hash MD5 e Tamanho
                             │ 4. Gera version.json
                             │ 5. Publica na Edge CDN Global
                                          │
                                          ▼
                             [ CDN HTTPS (PAGES.DEV) ]
                             ├── firmware.bin  (Binário compilado)
                             └── version.json  (Manifesto de versão)
                                          ▲
                                   Polling HTTPS (Wi-Fi)
                                          │
                                [ ESP8266 NODEMCU ]
                                ├── 1. Lê version.json periodicamente
                                ├── 2. Compara: Versão Remota > Versão Atual?
                                ├── 3. Se sim: Baixa firmware.bin com TLS
                                ├── 4. Callback onProgress -> Desenha % e barra no LCD
                                ├── 5. Valida MD5 -> Grava na Flash -> Reinicia no novo código
```

### Por que Cloudflare Pages?
- **Tráfego e Banda Gratuitos e Ilimitados:** Não há cobrança por gigabyte baixado pela placa.
- **Certificado SSL/TLS Automático:** URLs HTTPS globais sem custos e sem necessidade de renovar certificados `Let's Encrypt`.
- **Ambiente de Build Linux Integrado:** Executa comandos bash e scripts personalizados nativamente a cada commit.

---

## 2. Lista de Materiais e Conexões Físicas (Pinout)

### Componentes Necessários:
1. **Placa ESP8266:** NodeMCU V2/V3, Wemos D1 Mini ou equivalente (mínimo 4MB de Flash SPI).
2. **Display LCD:** Módulo LCD 20×4 ou 16×2 com adaptador I2C PCF8574.
3. **Fonte de Alimentação:** Cabo Micro-USB conectado a fonte 5V/1A.

### Tabela de Ligações (Pinagem):

| Pino do Módulo LCD I2C | Pino na ESP8266 NodeMCU | Descrição |
|---|---|---|
| **GND** | **GND** | Terra Comum |
| **VCC** | **VV (ou VIN / VU)** | **5V Direto da USB** *(Evite usar o pino 3V3, o LCD ficará sem contraste!)* |
| **SDA** | **D2 (GPIO 4)** | Linha de Dados do Barramento I2C |
| **SCL** | **D1 (GPIO 5)** | Linha de Clock do Barramento I2C |

> [!IMPORTANT]
> O módulo I2C do display LCD funciona melhor alimentado a 5V (pino **VV** da NodeMCU). Se alimentado em 3.3V, o circuito de cristal líquido pode não ter polarização suficiente para gerar contraste legível. Lembre-se de ajustar o potenciômetro azul traseiro do módulo I2C com uma chave de fenda para ajustar o contraste.

---

## 3. Estrutura de Pastas do Repositório

Crie um novo repositório limpo com a seguinte árvore de arquivos:

```text
meu-projeto-ota/
│
├── firmware/
│   └── ota_lcd/
│       └── ota_lcd.ino          # Sketch C++ Arduino isolado
│
├── build-firmware.sh            # Script Bash de compilação automatizada
├── package.json                 # Manifesto NPM para o Cloudflare Pages
└── README.md                    # Documentação do seu projeto
```

---

## 4. Código C++ do Firmware Isolado (`ota_lcd.ino`)

Crie o arquivo em `firmware/ota_lcd/ota_lcd.ino`:

```cpp
#include <ESP8266WiFi.h>
#include <WiFiClientSecure.h>
#include <ESP8266HTTPClient.h>
#include <ESP8266httpUpdate.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

// =====================================================================
// SISTEMA OTA AUTÔNOMO COM FEEDBACK NO DISPLAY LCD
// ESP8266 + Cloudflare Pages + BearSSL + ArduinoJson
// =====================================================================

// ----- CONFIGURAÇÃO DO DISPLAY LCD -----
// Se o seu display for 16x2, altere para 16 e 2:
#define LCD_COLS 20
#define LCD_ROWS 4

// Auto-detecção de endereço I2C (padrões comuns: 0x27 ou 0x3F)
LiquidCrystal_I2C* lcd = nullptr;

// Double-buffering para evitar redesenho desnecessário no I2C
char prevLcdLines[LCD_ROWS][LCD_COLS + 1];

// ----- VERSÃO DO FIRMWARE -----
// ATENÇÃO: Esta constante é substituída automaticamente pelo script CI/CD!
#define CURRENT_FIRMWARE_VER 1

// ----- CONFIGURAÇÕES DE REDE E ENDPOINTS -----
const char* WIFI_SSID     = "SUA_REDE_WIFI";
const char* WIFI_PASSWORD = "SUA_SENHA_WIFI";

// Substitua pelo subdomínio gerado no Cloudflare Pages:
const char* VERSION_URL = "https://seu-projeto.pages.dev/version.json";

// Intervalo de checagem periódica por novas versões (Ex: a cada 60 segundos)
const unsigned long CHECK_INTERVAL_MS = 60000;
unsigned long lastCheckTime = 0;

// =====================================================================
// FUNÇÕES AUXILIARES DE DISPLAY LCD
// =====================================================================

void initLCD() {
  Wire.begin(D2, D1); // SDA = D2 (GPIO4), SCL = D1 (GPIO5)
  Wire.setClock(400000); // 400kHz Fast Mode I2C

  // Testa endereço 0x27 primeiro, depois 0x3F
  byte addresses[] = {0x27, 0x3F};
  for (byte addr : addresses) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      lcd = new LiquidCrystal_I2C(addr, LCD_COLS, LCD_ROWS);
      lcd->init();
      lcd->backlight();
      break;
    }
  }

  for (int r = 0; r < LCD_ROWS; r++) {
    for (int c = 0; c < LCD_COLS; c++) {
      prevLcdLines[r][c] = ' ';
    }
    prevLcdLines[r][LCD_COLS] = '\0';
  }
}

// Imprime uma linha completa preenchendo espaços vazios e eliminando flicker
void printLinha(int row, const char* texto) {
  if (!lcd || row < 0 || row >= LCD_ROWS || !texto) return;

  char formatted[LCD_COLS + 1];
  size_t len = strlen(texto);
  if (len > LCD_COLS) len = LCD_COLS;

  memcpy(formatted, texto, len);
  for (size_t i = len; i < LCD_COLS; i++) {
    formatted[i] = ' ';
  }
  formatted[LCD_COLS] = '\0';

  // Só transmite no barramento se houver diferença no conteúdo
  if (strncmp(formatted, prevLcdLines[row], LCD_COLS) == 0) {
    return;
  }

  memcpy(prevLcdLines[row], formatted, LCD_COLS + 1);
  lcd->setCursor(0, row);
  lcd->print(formatted);
}

// Renderiza barra de progresso gráfica no display: [██████░░░░] 60%
void renderizarBarraProgresso(int row, int pct) {
  if (!lcd || row < 0 || row >= LCD_ROWS) return;
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;

  char line[LCD_COLS + 1];
  
  if (LCD_COLS >= 20) {
    // Para LCD 20x4: 12 caracteres de barra + 2 colchetes + espaço + "100%" (5 chars) = 20
    const int barWidth = 12;
    int filled = (pct * barWidth) / 100;
    
    line[0] = '[';
    for (int i = 0; i < barWidth; i++) {
      line[1 + i] = (i < filled) ? '=' : ' ';
    }
    line[1 + barWidth] = ']';
    line[2 + barWidth] = ' ';
    snprintf(&line[3 + barWidth], LCD_COLS + 1 - (3 + barWidth), "%3d%%", pct);
  } else {
    // Para LCD 16x2: 8 caracteres de barra + 2 colchetes + espaço + "100%" = 15 chars
    const int barWidth = 8;
    int filled = (pct * barWidth) / 100;
    line[0] = '[';
    for (int i = 0; i < barWidth; i++) {
      line[1 + i] = (i < filled) ? '=' : ' ';
    }
    line[1 + barWidth] = ']';
    line[2 + barWidth] = ' ';
    snprintf(&line[3 + barWidth], LCD_COLS + 1 - (3 + barWidth), "%3d%%", pct);
  }

  printLinha(row, line);
}

// =====================================================================
// MOTOR DE ATUALIZAÇÃO OTA
// =====================================================================

void executarAtualizacao(const char* fwUrl, const char* fwMd5, int versaoAlvo) {
  if (!fwUrl || strlen(fwUrl) == 0) return;

  Serial.println(F("[OTA] Iniciando procedimento de regravação..."));

  // 1. Mensagem de inicialização no LCD
  printLinha(0, "== ATUALIZANDO OTA ==");
  
  char vBuf[LCD_COLS + 1];
  snprintf(vBuf, sizeof(vBuf), " De v%d para v%d", CURRENT_FIRMWARE_VER, versaoAlvo);
  printLinha(1, vBuf);

  renderizarBarraProgresso(2, 0);
  printLinha(3, "Conectando ao CDN...");

  // 2. Cliente HTTPS dedicado (ignora checagem de cadeia CA raiz para economizar 30KB de RAM)
  WiFiClientSecure otaClient;
  otaClient.setInsecure();

  // 3. Configurações essenciais da biblioteca ESPhttpUpdate
  ESPhttpUpdate.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  ESPhttpUpdate.rebootOnUpdate(true); // Reinicia automaticamente ao concluir com sucesso

  // Validação criptográfica de integridade por Hash MD5
  if (fwMd5 && strlen(fwMd5) > 0) {
    Serial.printf("[OTA] Aplicando Checksum MD5 esperado: %s\n", fwMd5);
    ESPhttpUpdate.setMD5sum(fwMd5);
  }

  // 4. Hook de Progresso chamado durante o stream do download
  ESPhttpUpdate.onProgress([](int cur, int total) {
    if (total > 0) {
      int pct = (cur * 100) / total;
      static int lastPct = -1;

      // Só atualiza a tela se a porcentagem inteira mudar
      if (pct != lastPct) {
        lastPct = pct;
        renderizarBarraProgresso(2, pct);

        char statusBuf[LCD_COLS + 1];
        snprintf(statusBuf, sizeof(statusBuf), "Gravando: %3d%%", pct);
        printLinha(3, statusBuf);

        Serial.printf("[OTA] Progresso: %d%% (%d / %d bytes)\n", pct, cur, total);
      }
    }
    // Alimenta o Watchdog Timer da ESP8266 para evitar resets espúrios
    yield();
  });

  // 5. Executa download, escrita sequencial nos blocos da flash e reinício
  t_httpUpdate_return ret = ESPhttpUpdate.update(otaClient, fwUrl);

  // Se o código continuar executando após esta linha, ocorreu uma falha
  Serial.printf("[OTA] Erro durante o update (%d): %s\n", ret, ESPhttpUpdate.getLastErrorString().c_str());

  printLinha(1, "   FALHA NO OTA!    ");
  char errBuf[LCD_COLS + 1];
  snprintf(errBuf, sizeof(errBuf), "Cod: %d", ret);
  printLinha(2, errBuf);
  printLinha(3, "Tentando depois...  ");
  delay(3000);
}

void verificarAtualizacao() {
  if (WiFi.status() != WL_CONNECTED) return;

  Serial.println(F("[OTA] Consultando manifesto version.json na nuvem..."));

  WiFiClientSecure client;
  client.setInsecure();
  client.setBufferSizes(2048, 512); // Otimiza tamanho de buffer TLS

  HTTPClient http;
  http.setTimeout(4000);

  // Truque anti-cache: adiciona timestamp na query string para furar caches de borda
  String urlComCacheBuster = String(VERSION_URL) + "?t=" + String(millis());
  http.begin(client, urlComCacheBuster);
  http.addHeader("Cache-Control", "no-cache");

  int httpCode = http.GET();
  if (httpCode != HTTP_CODE_OK) {
    Serial.printf("[OTA] Falha na requisicao HTTP: %d\n", httpCode);
    http.end();
    return;
  }

  String jsonPayload = http.getString();
  http.end();
  client.stop();

  // Parsing do manifesto JSON
  #if ARDUINOJSON_VERSION_MAJOR >= 7
    JsonDocument doc;
  #else
    DynamicJsonDocument doc(512);
  #endif

  DeserializationError err = deserializeJson(doc, jsonPayload);
  if (err) {
    Serial.print(F("[OTA] Falha ao processar JSON: "));
    Serial.println(err.c_str());
    return;
  }

  int versaoRemota   = doc["firmware_version"] | 0;
  const char* fwUrl = doc["firmware_url"]     | "";
  const char* fwMd5 = doc["firmware_md5"]     | "";

  Serial.printf("[OTA] Versao Atual: %d | Versao Remota: %d\n", CURRENT_FIRMWARE_VER, versaoRemota);

  if (versaoRemota > CURRENT_FIRMWARE_VER && strlen(fwUrl) > 0) {
    Serial.println(F("[OTA] Nova versao detectada! Disparando atualizacao..."));
    executarAtualizacao(fwUrl, fwMd5, versaoRemota);
  } else {
    Serial.println(F("[OTA] Firmware ja esta na versao mais recente."));
  }
}

// =====================================================================
// SETUP & LOOP
// =====================================================================

void setup() {
  system_update_cpu_freq(160); // Opera a 160MHz para máxima velocidade TLS
  Serial.begin(115200);
  delay(100);

  initLCD();

  printLinha(0, "== SISTEMA ATIVO ==");
  char vBuf[LCD_COLS + 1];
  snprintf(vBuf, sizeof(vBuf), "Firmware: v%d", CURRENT_FIRMWARE_VER);
  printLinha(1, vBuf);
  printLinha(2, "Conectando WiFi...");
  printLinha(3, WIFI_SSID);

  Serial.printf("\n[BOOT] Iniciando dispositivo. Versao: v%d\n", CURRENT_FIRMWARE_VER);
  Serial.printf("[BOOT] Conectando a %s...\n", WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  // Aguarda até 10 segundos pela conexão
  unsigned long startWait = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - startWait < 10000)) {
    delay(250);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println(F("\n[WIFI] Conectado com sucesso!"));
    Serial.print(F("[WIFI] IP: "));
    Serial.println(WiFi.localIP());

    printLinha(2, "WiFi Conectado!");
    printLinha(3, WiFi.localIP().toString().c_str());
    delay(1500);

    // Checa OTA imediatamente ao ligar a placa
    verificarAtualizacao();
  } else {
    Serial.println(F("\n[WIFI] Falha ao conectar. Iniciando em modo offline."));
    printLinha(2, "WiFi: Offline");
    printLinha(3, "Continuando...");
    delay(1500);
  }

  // Restaura tela de operação normal
  printLinha(0, "== MONITOR PADRAO ==");
  printLinha(1, vBuf);
  printLinha(2, "Status: Operacional");
  printLinha(3, "Aguardando eventos..");
}

void loop() {
  unsigned long now = millis();

  // Verificação periódica por novas versões
  if (now - lastCheckTime >= CHECK_INTERVAL_MS) {
    lastCheckTime = now;
    verificarAtualizacao();
  }

  // SEU CÓDIGO DA APLICAÇÃO VEM AQUI:
  // (Sensores, botões, leituras, etc.)

  yield(); // Permite que a pilha Wi-Fi do ESP8266 processe pacotes em background
}
```

---

## 5. Script de Build de Produção (`build-firmware.sh`)

Este script é o coração do CI/CD. Ele é executado pelo Cloudflare Pages para compilar o firmware no servidor e gerar os arquivos estáticos de distribuição.

Crie o arquivo na raiz do repositório: `build-firmware.sh`:

```bash
#!/usr/bin/env bash
set -e

# =====================================================================
# PIPELINE CI/CD — COMPILAÇÃO HEADLESS DE FIRMWARE OTA ESP8266
# =====================================================================

echo "================================================="
echo "  INICIANDO PIPELINE DE COMPILAÇÃO OTA (ESP8266)  "
echo "================================================="

# 1. Recupera o histórico completo do Git (Cloudflare Pages clona com profundidade 1)
git fetch --unshallow 2>/dev/null || true

# 2. Define a versão como a contagem total de commits da branch
VERSION=$(git rev-list --count HEAD 2>/dev/null || echo 0)
if [ "$VERSION" -le 0 ]; then
  # Fallback: Timestamp unix caso o git falhe
  VERSION=$(date +%s)
fi

echo "[VERSAO] Numero de versao gerado para este build: v$VERSION"

SKETCH_PATH="firmware/ota_lcd/ota_lcd.ino"

# 3. Patch temporário no código-fonte substituindo a constante de versão
sed -i "s/#define CURRENT_FIRMWARE_VER .*/#define CURRENT_FIRMWARE_VER $VERSION/" "$SKETCH_PATH"
echo "[PATCH] Constante CURRENT_FIRMWARE_VER definida para $VERSION em $SKETCH_PATH"

# 4. Garante que o arduino-cli esteja instalado
if ! command -v arduino-cli &> /dev/null; then
  echo "[SETUP] Baixando e instalando arduino-cli..."
  curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | BINDIR=. sh
  export PATH=$PATH:.
else
  echo "[SETUP] arduino-cli ja disponivel no ambiente."
fi

# 5. Configura repositório de placas da ESP8266
echo "[CORE] Instalando Core ESP8266..."
arduino-cli config init --additional-urls https://arduino.esp8266.com/stable/package_esp8266com_index.json 2>/dev/null || true
arduino-cli core update-index
arduino-cli core install esp8266:esp8266

# 6. Instala as bibliotecas C++ necessárias
echo "[LIBS] Instalando bibliotecas: ArduinoJson e LiquidCrystal I2C..."
arduino-cli lib install "ArduinoJson" "LiquidCrystal I2C" || true

# 7. Cria diretórios de saída
mkdir -p build_output
mkdir -p dist

# 8. Compilação Headless do Sketch para arquitetura NodeMCU 1.0 (ESP-12E Module)
echo "[BUILD] Compilando firmware para esp8266:esp8266:nodemcuv2..."
arduino-cli compile --fqbn esp8266:esp8266:nodemcuv2 \
  --output-dir ./build_output \
  "$(dirname "$SKETCH_PATH")"

# 9. Localiza com segurança o binário principal gerado
BIN_FOUND=$(find ./build_output -maxdepth 1 -name "*.bin" ! -name "*littlefs*" ! -name "*spiffs*" ! -name "*partitions*" | head -n 1)

if [ -z "$BIN_FOUND" ] || [ ! -f "$BIN_FOUND" ]; then
  echo "ERRO CRITICO: Binario de firmware nao encontrado em ./build_output!"
  exit 1
fi

cp "$BIN_FOUND" ./dist/firmware.bin

# 10. Calcula o tamanho em bytes e o Checksum criptográfico MD5
SIZE_BYTES=$(wc -c < ./dist/firmware.bin | tr -d ' ')
MD5_HASH=$(md5sum ./dist/firmware.bin | awk '{print $1}')
BUILD_TIME_MS=$(date +%s%3N 2>/dev/null || date +%s)

echo "-------------------------------------------------"
echo "FIRMWARE COMPILADO COM SUCESSO:"
echo "Arquivo: dist/firmware.bin"
echo "Tamanho: $SIZE_BYTES bytes"
echo "MD5:     $MD5_HASH"
echo "-------------------------------------------------"

# 11. Gera o manifesto version.json consumido pela placa ESP8266
# OBS: O Cloudflare Pages disponibiliza a variável $CF_PAGES_URL automaticamente
PROJECT_URL="${CF_PAGES_URL:-https://seu-projeto.pages.dev}"

cat > ./dist/version.json << EOF
{
  "firmware_version": $VERSION,
  "firmware_url": "$PROJECT_URL/firmware.bin",
  "firmware_size": $SIZE_BYTES,
  "firmware_md5": "$MD5_HASH",
  "build_time": $BUILD_TIME_MS
}
EOF

echo "[MANIFESTO] dist/version.json gerado:"
cat ./dist/version.json

# 12. Limpeza de segurança: Restaura o valor 0 no arquivo original para manter o git limpo
sed -i "s/#define CURRENT_FIRMWARE_VER .*/#define CURRENT_FIRMWARE_VER 0/" "$SKETCH_PATH"

echo "================================================="
echo "       BUILD CONCLUÍDO COM SUCESSO! 🚀           "
echo "================================================="
```

Dê permissão de execução local para o script:
```bash
chmod +x build-firmware.sh
```

---

## 6. Arquivo de Configuração NPM (`package.json`)

O Cloudflare Pages precisa de um `package.json` para saber qual comando executar ao receber um deploy.

Crie o arquivo na raiz do repositório: `package.json`:

```json
{
  "name": "esp8266-ota-system",
  "version": "1.0.0",
  "description": "Sistema de Compilação e Distribuição de Firmware OTA para ESP8266",
  "scripts": {
    "build": "bash build-firmware.sh"
  }
}
```

---

## 7. Configuração do Repositório GitHub

1. Inicialize o repositório Git local e faça o primeiro commit:
   ```bash
   git init
   git add .
   git commit -m "feat: estrutura inicial do sistema ota"
   ```

2. Crie um repositório no GitHub (ex: `esp8266-ota-system`).

3. Vincule a branch remota e envie o código:
   ```bash
   git branch -M main
   git remote add origin https://github.com/SEU_USUARIO/esp8266-ota-system.git
   git push -u origin main
   ```

---

## 8. Configuração do Cloudflare Pages (Hospedagem & CI/CD)

1. Crie uma conta gratuita em [Cloudflare.com](https://dash.cloudflare.com/) (caso ainda não tenha).
2. No menu lateral esquerdo, vá em **Workers & Pages** > selecione a aba **Pages** e clique em **Create a project**.
3. Escolha **Connect to Git** e autorize o Cloudflare a acessar sua conta GitHub.
4. Selecione o repositório criado (`esp8266-ota-system`) e clique em **Begin setup**.
5. Preencha as configurações de build exatamente como abaixo:
   - **Project name:** Escolha o nome do subdomínio (ex: `esp-ota-makerspace` -> URL será `https://esp-ota-makerspace.pages.dev`).
   - **Production branch:** `main`
   - **Framework preset:** `None`
   - **Build command:** `bash build-firmware.sh` (ou `npm run build`)
   - **Build output directory:** `dist`
   - **Root directory:** `/` *(deixe em branco ou barra)*
6. Clique em **Save and Deploy**.

> [!NOTE]
> O primeiro build levará cerca de 1 a 2 minutos enquanto o runner do Cloudflare Pages instala o `arduino-cli`, baixa o core da ESP8266 e compila o primeiro `.bin`.
> Ao finalizar, o Cloudflare exibirá a URL pública do seu projeto: `https://seu-projeto.pages.dev`.

7. **Ajuste no Firmware:** Abra o arquivo `firmware/ota_lcd/ota_lcd.ino` e substitua a constante `VERSION_URL` pela sua URL real:
   ```cpp
   const char* VERSION_URL = "https://esp-ota-makerspace.pages.dev/version.json";
   ```

---

## 9. Fluxo de Trabalho Diário (Do Código ao Chip)

### Passo 1: A Primeira Gravação (Via Cabo USB)
Como a placa sai virgem de fábrica, a primeira gravação **obrigatoriamente** deve ser feita via cabo USB pelo Arduino IDE ou VS Code/PlatformIO.
- Conecte a ESP8266 via USB.
- Selecione a placa `NodeMCU 1.0 (ESP-12E Module)`.
- Configure o tamanho de flash: `Flash Size: "4MB (FS:1MB OTA:~1019KB)"`.
- Grave o sketch `ota_lcd.ino`.
- O display acenderá exibindo:
  ```text
  == SISTEMA ATIVO ==
  Firmware: v1
  WiFi Conectado!
  192.168.1.150
  ```

### Passo 2: Fazendo uma Alteração e Atualizando pelo Ar
Nunca mais será necessário ligar o cabo USB! Sempre que você quiser alterar o código:

1. Modifique o que desejar no arquivo `.ino` (por exemplo, mude o texto do display na linha 257 de `"Aguardando eventos.."` para `"Monitoramento OK!"`).
2. Faça o commit e envie para a branch `main`:
   ```bash
   git add .
   git commit -m "feat: alterando mensagens do display"
   git push origin main
   ```
3. O Cloudflare Pages detectará o push automaticamente:
   - Compilará o binário com o novo número de versão (ex: `v2`).
   - Gerará `dist/firmware.bin` e `dist/version.json`.
4. Em até 60 segundos (ou no próximo ciclo de checagem configurado em `CHECK_INTERVAL_MS`), a placa ESP8266 conectada no Wi-Fi fará:
   1. Detecta `Versao Remota (v2) > Versao Local (v1)`.
   2. O display LCD mudará instantaneamente para:
      ```text
      == ATUALIZANDO OTA ==
       De v1 para v2
      [======      ]  50%
      Gravando:  50%
      ```
   3. A cada bloco gravado, a barra avança até `100%`.
   4. O chip reinicia sozinho.
   5. O novo código entra em execução exibindo: `Firmware: v2`!

---

## 10. Engenharia e Boas Práticas Críticas

### 1. Particionamento de Flash (Dual-Bank OTA)
Para que a atualização OTA funcione na ESP8266, a memória Flash SPI precisa ser particionada em duas áreas (Slots A e B):
- O código atual roda no **Slot A**.
- O binário novo é baixado e gravado no **Slot B**.
- Após a validação do MD5, o bootloader altera o ponteiro de boot para o **Slot B** e reinicia o microcontrolador.
- **Exigência Técnica:** Use placas com pelo menos **4MB de Flash** (como NodeMCU ou D1 Mini). No Arduino IDE, garanta a partição `4MB (FS:1MB OTA:~1019KB)`. Se a flash tiver apenas 1MB (ESP-01 antiga), o binário novo pode não caber.

### 2. Gerenciamento da Memória SRAM e Buffers TLS (BearSSL)
A ESP8266 possui apenas ~80 KB de memória RAM (SRAM). Conexões HTTPS modernas consomem muita memória com o handshake TLS:
- O uso de `otaClient.setInsecure()` é **obrigatório** em microcontroladores desse porte. Ele desativa a verificação de certificados CA raiz (que exigiria alocar mais de 30 KB de RAM apenas para armazenar a lista de certificados).
- **A integridade é garantida pelo Checksum MD5:** Mesmo sem verificar o certificado HTTPS da Cloudflare, a autenticidade e integridade do firmware são 100% blindadas pela diretiva `ESPhttpUpdate.setMD5sum(fwMd5)`. Se um único bit do binário for corrompido em trânsito, a ESP descarta o arquivo e recusa o flash.

### 3. Evitando o Watchdog Timer (WDT Reset)
Durante downloads via rede, o processador pode ficar ocupado recebendo pacotes TCP.
- Dentro do callback `ESPhttpUpdate.onProgress()`, **sempre chame `yield();`**.
- O `yield()` passa o controle temporariamente para o sistema operacional subjacente do ESP8266 alimentar o temporizador de cão de guarda de hardware (*Hardware Watchdog*), evitando que a placa reinicie no meio de um download longo.

### 4. Furando o Cache da CDN (Cache-Busting)
Redes CDN como a Cloudflare mantêm arquivos estáticos em cache nos servidores de borda (*Edge nodes*):
- Se a ESP consultar `version.json` diretamente, a CDN pode devolver a versão anterior que ainda está em cache.
- Por isso, o código usa a técnica de query string com timestamp:
  ```cpp
  String urlComCacheBuster = String(VERSION_URL) + "?t=" + String(millis());
  ```
  Isso obriga o servidor a sempre entregar o manifesto mais recente.

---

## 11. Guia de Diagnóstico e Resolução de Problemas (Troubleshooting)

### O display trava ou exibe caracteres estranhos
- **Causa:** Queda de tensão na alimentação ou falta de contraste.
- **Solução:** Alimente o pino **VCC** do adaptador I2C com **5V** (pino `VV` ou `VIN`) e gire o potenciômetro de contraste atrás do LCD. Certifique-se de que os pinos SDA/SCL estão nos pinos corretos (D2 e D1).

### O display mostra `FALHA NO OTA! Cod: -1`
- **Causa:** `HTTP_UE_TOO_LESS_SPACE` — O arquivo `.bin` compilado é maior do que o espaço disponível para OTA na Flash.
- **Solução:** Verifique o tamanho do sketch. No Arduino IDE, configure o particionamento de memória para `4MB (FS:1MB OTA:~1019KB)`.

### O display mostra `FALHA NO OTA! Cod: -100`
- **Causa:** `HTTP_UE_SERVER_NOT_REPORT_SIZE` ou Timeout de Conexão.
- **Solução:** Verifique se a URL no `VERSION_URL` está correta e abre normalmente no navegador do seu celular ou computador. Certifique-se de que a rede Wi-Fi possui acesso à internet externa.

### O display mostra `FALHA NO OTA! Cod: -104`
- **Causa:** `HTTP_UE_SERVER_FILE_NOT_FOUND` (Erro 404).
- **Solução:** O arquivo `firmware.bin` não foi encontrado na raiz do site. Verifique no painel do Cloudflare Pages se a pasta de saída do build está configurada como `dist`.

### O display mostra `FALHA NO OTA! Cod: -105`
- **Causa:** `HTTP_UE_SERVER_FORBIDDEN` ou redirecionamento não seguido.
- **Solução:** Garanta que a linha `ESPhttpUpdate.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);` está presente no código antes de chamar `.update()`.

### A compilação falha no Cloudflare Pages
- **Causa:** Biblioteca ausente ou erro de sintaxe.
- **Solução:** Abra o painel do **Cloudflare Pages** > clique no deploy com erro > expanda os logs do terminal. O `arduino-cli` exibirá a linha exata do erro de compilação em C++.

---

## 📄 Licença

Desenvolvido para o **MakerSpace UNIFEI**.  
Código aberto para estudantes, pesquisadores e a comunidade Maker.
