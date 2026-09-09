#include <ESP8266WiFi.h>
#include <WiFiClientSecure.h>
#include <ESP8266HTTPClient.h>
#include <ESP8266httpUpdate.h>
#include <ArduinoJson.h>
#include <LittleFS.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <math.h>

// =====================================================================
// MAKITA CLICKER — FIRMWARE EMBARCADO ESP8266 (EDIÇÃO DE ALTA PERFORMANCE)
// 100% Autônomo · Xtensa LX106 @ 160MHz · ISR Botão 0ms · Zero-Recursion
// LittleFS Flash Wear-Leveling Shield · Static Buffers · BearSSL Tuned
// =====================================================================

// ===== CONFIGURAÇÃO DE HARDWARE =====
// I2C Display LCD 20x4: SDA = D2 (GPIO4), SCL = D1 (GPIO5), VCC = VV (5V), GND = GND
// Botão Físico: Pino D5 (GPIO14) com INPUT_PULLUP (fecha no GND ao pressionar)
const int PIN_BOTAO = D5;
const unsigned long DEBOUNCE_MICROS = 25000; // 25ms de filtro para microswitches mecânicos

// Fila volátil de interrupção externa (garante ZERO perda de cliques mesmo sob TLS)
volatile uint32_t isrPendingClicks = 0;
volatile unsigned long lastIsrMicros = 0;

void ICACHE_RAM_ATTR isrBotao() {
  unsigned long now = micros();
  if (now - lastIsrMicros >= DEBOUNCE_MICROS) {
    lastIsrMicros = now;
    isrPendingClicks++;
  }
}

// Ponteiro dinâmico para o LCD (permite auto-detecção de endereço I2C: 0x27, 0x3F, etc.)
LiquidCrystal_I2C* lcd = nullptr;

// Controle de atualização desacoplada do LCD (elimina latência I2C)
bool precisaAtualizarLCD = false;
unsigned long ultimoUpdateLCD = 0;
const unsigned long INTERVALO_UPDATE_LCD = 75; // ~13 FPS cadenciado

// Feedback visual de clique
unsigned long ultimoClickVisual = 0;
const unsigned long duracaoFeedbackClick = 600;

// Status operacional da ESP
const char* statusAtual = "Iniciando";

// Double-buffering estático nas 4 linhas do LCD para eliminar flicker e latência I2C
// Zero uso de String no hot path para eliminar fragmentação de Heap na SRAM
char prevLcdLines[4][21] = {"", "", "", ""};

// Variáveis de controle de conexão Wi-Fi e reconexão infinita
unsigned long ultimoWifiRetry = 0;
bool wifiConectadoAnterior = false;
const unsigned long WIFI_RETRY_INTERVAL_MS = 10000; // Retry a cada 10 segundos

const int NUM_UPGRADES = 24;

struct UpgradeConfig {
  const char* id;
  double baseCost;
  float growth;
  double mps;
};

// ===== VERSÃO LOCAL — gerenciado automaticamente pelo build-firmware.sh =====
#define CURRENT_FIRMWARE_VER 0

const char* VERSION_URL = "https://makitaclicker.pages.dev/version.json";
const char* STATE_URL   = "https://makitaclicker.pages.dev/api/state";
const char* GAMESTATE_FILE = "/gamestate.json";

const char* ssid = "MakerSpace UNIFEI";
const char* password = "SUA_SENHA_WIFI";

// ===== ESTADO DO JOGO =====
double makitas = 0.0;
const int MAX_OWNED = 100;
int pendingPhysicalClicks = 0;

// Top Player do Ranking recebido da Nuvem
String topPlayerName = "";
double topPlayerMakitas = 0.0;

// Controle de Posse do Console Físico (Usuário Atual / Hardware Lease)
bool hardwareOwnerActive = false;
String hardwareOwnerName = "";
unsigned long hardwareOwnerExpiresAtMillis = 0;
String currentTargetUserId = "";
uint64_t lastHardwareOwnerClaimedAt = 0; // Timestamp estrito para blindagem contra consistência eventual do KV
uint64_t lastExecutedResetTimestamp = 0; // Timestamp do último reset executado (evita reexecuções obsoletas)

// Protótipos de funções de rede, ACK e OTA
bool enviarAckOrdem(const char* orderId);
void executarAtualizacaoFirmware(const char* fwUrl, const char* fwMd5, const char* titulo, const char* subtitulo);
void forcarRegravacaoOTA();
void checkOTA();

const UpgradeConfig UPGRADE_CONFIGS[NUM_UPGRADES] = {
  { "upgrade1",          10.0,         1.10, 0.1 },        // +0.1 MPS
  { "upgrade_1mps",      100.0,        1.12, 1.0 },        // +1.0 MPS
  { "upgrade_2mps",      250.0,        1.12, 2.0 },        // +2.0 MPS
  { "upgrade_5mps",      750.0,        1.13, 5.0 },        // +5.0 MPS
  { "upgrade_10mps",     1800.0,       1.13, 10.0 },       // +10.0 MPS
  { "upgrade_15mps",     3500.0,       1.14, 15.0 },       // +15.0 MPS
  { "upgrade_20mps",     6000.0,       1.14, 20.0 },       // +20.0 MPS
  { "upgrade_25mps",     10000.0,      1.14, 25.0 },       // +25.0 MPS
  { "upgrade_30mps",     16000.0,      1.15, 30.0 },       // +30.0 MPS
  { "upgrade_50mps",     35000.0,      1.15, 50.0 },       // +50.0 MPS
  { "upgrade_100mps",    100000.0,     1.15, 100.0 },      // +100.0 MPS
  { "upgrade_200mps",    300000.0,     1.16, 200.0 },      // +200.0 MPS
  { "upgrade_500mps",    1000000.0,    1.16, 500.0 },      // +500.0 MPS
  { "upgrade_1200mps",   3500000.0,    1.16, 1200.0 },     // +1.2k MPS
  { "upgrade_3000mps",   12000000.0,   1.16, 3000.0 },     // +3.0k MPS
  { "upgrade_8000mps",   40000000.0,   1.17, 8000.0 },     // +8.0k MPS
  { "upgrade_20kmps",    150000000.0,  1.17, 20000.0 },    // +20k MPS
  { "upgrade_60kmps",    500000000.0,  1.17, 60000.0 },    // +60k MPS
  { "upgrade_180kmps",   1800000000.0, 1.17, 180000.0 },   // +180k MPS
  { "upgrade_500kmps",   6000000000.0, 1.18, 500000.0 },   // +500k MPS
  { "upgrade_1500kmps",  20000000000.0,1.18, 1500000.0 },  // +1.5M MPS
  { "upgrade_5000kmps",  60000000000.0,1.18, 5000000.0 },  // +5.0M MPS
  { "upgrade_15000kmps", 200000000000.0,1.19,15000000.0 }, // +15.0M MPS
  { "upgrade_50000kmps", 800000000000.0,1.19,50000000.0 }  // +50.0M MPS
};

int ownedUpgrades[NUM_UPGRADES] = {0};

// 20 Melhorias permanentes ativas (Skill Tree)
bool permLubrificante = false;      // (bit 0)  +10% MPS global
bool permDiscoDiamante = false;     // (bit 1)  +1.0 poder de clique
bool permMotorBrushless = false;    // (bit 2)  2x ganho base das oficinas
bool permEmpunhadura = false;       // (bit 3)  clique gera +5% do MPS atual
bool permBateriaLitio = false;      // (bit 4)  +25% MPS global
bool permIaMaker = false;           // (bit 5)  +50% MPS global
bool permRefrigeracao = false;      // (bit 6)  +20% MPS global
bool permTitanio = false;           // (bit 7)  +3.0 poder de clique
bool permOverclock = false;         // (bit 8)  sinergia de clique passa a +10% do MPS
bool permNanobots = false;          // (bit 9)  +75% MPS global
bool permSingularidade = false;     // (bit 10) +150% MPS global e triplica clique base
bool permPlasmaCutter = false;      // (bit 11) +25.0 poder de clique
bool permFusaoFria = false;         // (bit 12) +100% MPS global
bool permHiperconducao = false;     // (bit 13) 3x produção base das oficinas
bool permSinergiaQuantica = false;  // (bit 14) sinergia de clique passa a +20% do MPS
bool permLaserGama = false;         // (bit 15) +200.0 poder de clique
bool permTaquions = false;          // (bit 16) +200% MPS global
bool permMateriaEscura = false;     // (bit 17) +300% MPS global
bool permHiperClique = false;       // (bit 18) 10x multiplicador de poder de clique
bool permOnipotenciaMaker = false;  // (bit 19) +500% MPS global, +30% MPS/clique, 4x oficinas

// Cache local de MPS e Poder de Clique
double cachedMps = 0.0;
double cachedClickPower = 1.0;

// Proteção de Flash SPI: Dirty Tracking para prolongar vida útil dos setores
bool isFlashDirty = false;

// Auto-detecta endereço I2C do display LCD (0x27, 0x3F, etc.)
uint8_t detectarEnderecoI2C() {
  const uint8_t enderecosComuns[] = {0x27, 0x3F, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x38, 0x39, 0x3A, 0x3B, 0x3C, 0x3D, 0x3E};
  for (uint8_t i = 0; i < sizeof(enderecosComuns); i++) {
    Wire.beginTransmission(enderecosComuns[i]);
    if (Wire.endTransmission() == 0) {
      return enderecosComuns[i];
    }
  }
  return 0x27; // Endereço padrão fallback
}

// Formatação estática de números ultra-compacta (Zero Alocação Dinâmica)
void formatarNumeroBuffer(double num, char* out, size_t outSize) {
  if (!out || outSize == 0) return;
  if (num < 0) {
    snprintf(out, outSize, "0");
    return;
  }
  if (num < 10.0) {
    if (fabs(num - (long)num) > 0.05) {
      snprintf(out, outSize, "%.1f", num);
    } else {
      snprintf(out, outSize, "%ld", (long)(num + 0.5));
    }
  } else if (num < 999.5) {
    snprintf(out, outSize, "%ld", (long)(num + 0.5));
  } else if (num < 999500.0) {
    double k = num / 1000.0;
    if (k < 9.995) snprintf(out, outSize, "%.2fk", k);
    else if (k < 99.95) snprintf(out, outSize, "%.1fk", k);
    else snprintf(out, outSize, "%ldk", (long)(k + 0.5));
  } else if (num < 999500000.0) {
    double m = num / 1000000.0;
    if (m < 9.995) snprintf(out, outSize, "%.2fM", m);
    else if (m < 99.95) snprintf(out, outSize, "%.1fM", m);
    else snprintf(out, outSize, "%ldM", (long)(m + 0.5));
  } else if (num < 999500000000.0) {
    double b = num / 1000000000.0;
    if (b < 9.995) snprintf(out, outSize, "%.2fB", b);
    else if (b < 99.95) snprintf(out, outSize, "%.1fB", b);
    else snprintf(out, outSize, "%ldB", (long)(b + 0.5));
  } else if (num < 999500000000000.0) {
    double t = num / 1000000000000.0;
    if (t < 9.995) snprintf(out, outSize, "%.2fT", t);
    else if (t < 99.95) snprintf(out, outSize, "%.1fT", t);
    else snprintf(out, outSize, "%ldT", (long)(t + 0.5));
  } else {
    double q = num / 1000000000000000.0;
    if (q < 9.995) snprintf(out, outSize, "%.2fQa", q);
    else snprintf(out, outSize, "%.1fQa", q);
  }
}

// Double-buffering sem alocação dinâmica com preenchimento exato de 20 colunas
void printLinhaFormatada(int linha, const char* texto) {
  if (!lcd || linha < 0 || linha >= 4 || !texto) return;

  char formatted[21];
  size_t len = strlen(texto);
  if (len > 20) len = 20;

  memcpy(formatted, texto, len);
  for (size_t i = len; i < 20; i++) {
    formatted[i] = ' ';
  }
  formatted[20] = '\0';

  // Se a linha não mudou, economiza tráfego no barramento I2C
  if (strncmp(formatted, prevLcdLines[linha], 20) == 0) {
    return;
  }

  memcpy(prevLcdLines[linha], formatted, 21);
  lcd->setCursor(0, linha);
  lcd->print(formatted);
}

void atualizarLCD() {
  if (!lcd) return;
  unsigned long now = millis();
  bool clickAtivo = (now - ultimoClickVisual < duracaoFeedbackClick);

  char lineBuf[32];

  // Linha 0: Dono Atual do Console OU 1° Lugar
  if (hardwareOwnerActive) {
    int remSec = 0;
    if (hardwareOwnerExpiresAtMillis > now) {
      remSec = (int)((hardwareOwnerExpiresAtMillis - now) / 1000UL);
    }
    char timeStr[16];
    snprintf(timeStr, sizeof(timeStr), " (%02d:%02d)", remSec / 60, remSec % 60);

    const char* nome = (hardwareOwnerName.length() > 0) ? hardwareOwnerName.c_str() : "Maker";
    int maxNomeLen = 20 - 6 - (int)strlen(timeStr); // 6 = strlen("Dono: ")
    char nomeTrunc[21];
    if (maxNomeLen > 2 && (int)strlen(nome) > maxNomeLen) {
      strncpy(nomeTrunc, nome, maxNomeLen);
      nomeTrunc[maxNomeLen] = '\0';
    } else {
      strncpy(nomeTrunc, nome, sizeof(nomeTrunc));
      nomeTrunc[sizeof(nomeTrunc) - 1] = '\0';
    }
    snprintf(lineBuf, sizeof(lineBuf), "Dono: %s%s", nomeTrunc, timeStr);
  } else {
    char scoreStr[16] = "";
    if (topPlayerMakitas > 0) {
      char numBuf[12];
      formatarNumeroBuffer(topPlayerMakitas, numBuf, sizeof(numBuf));
      snprintf(scoreStr, sizeof(scoreStr), " (%s)", numBuf);
    }
    const char* nome = (topPlayerName.length() > 0) ? topPlayerName.c_str() : "MakerSpace";
    int maxNomeLen = 20 - 4 - (int)strlen(scoreStr); // 4 = strlen("1o: ")
    char nomeTrunc[21];
    if (maxNomeLen > 2 && (int)strlen(nome) > maxNomeLen) {
      strncpy(nomeTrunc, nome, maxNomeLen);
      nomeTrunc[maxNomeLen] = '\0';
    } else {
      strncpy(nomeTrunc, nome, sizeof(nomeTrunc));
      nomeTrunc[sizeof(nomeTrunc) - 1] = '\0';
    }
    snprintf(lineBuf, sizeof(lineBuf), "1o: %s%s", nomeTrunc, scoreStr);
  }
  printLinhaFormatada(0, lineBuf);

  // Linha 1: Quantidade Atual de Makitas
  if (makitas >= 99000000000.0) {
    printLinhaFormatada(1, "Makitas: 99B (META!)");
  } else {
    char mktBuf[12];
    formatarNumeroBuffer(makitas, mktBuf, sizeof(mktBuf));
    snprintf(lineBuf, sizeof(lineBuf), "Makitas: %s MKT", mktBuf);
    printLinhaFormatada(1, lineBuf);
  }

  // Linha 2: Produção Atual ou Feedback Visual de Corte
  if (clickAtivo) {
    printLinhaFormatada(2, ">> CORTE EFETUADO! <<");
  } else {
    char mpsBuf[12];
    char clkBuf[12];
    formatarNumeroBuffer(cachedMps, mpsBuf, sizeof(mpsBuf));
    formatarNumeroBuffer(cachedClickPower, clkBuf, sizeof(clkBuf));

    char clkFormatted[16];
    snprintf(clkFormatted, sizeof(clkFormatted), "(+%s)", clkBuf);
    char prodPrefix[20];
    snprintf(prodPrefix, sizeof(prodPrefix), "Prod: +%s/s", mpsBuf);

    int espaco = 20 - (int)strlen(prodPrefix) - (int)strlen(clkFormatted);
    if (espaco >= 1) {
      char spaces[21];
      memset(spaces, ' ', espaco);
      spaces[espaco] = '\0';
      snprintf(lineBuf, sizeof(lineBuf), "%s%s%s", prodPrefix, spaces, clkFormatted);
    } else {
      snprintf(lineBuf, sizeof(lineBuf), "%s", prodPrefix);
    }
    printLinhaFormatada(2, lineBuf);
  }

  // Linha 3: Status Operacional (Ativo, Offline, Conectando, Sincroniz., Apagando..., Reset OK!)
  snprintf(lineBuf, sizeof(lineBuf), "Status: %s", statusAtual);
  printLinhaFormatada(3, lineBuf);
}

void recalculateStats() {
  // Poder de clique base
  double power = 1.0;
  if (permDiscoDiamante) power += 1.0;
  if (permTitanio) power += 3.0;
  if (permPlasmaCutter) power += 25.0;
  if (permLaserGama) power += 200.0;
  if (permSingularidade) power *= 3.0;
  if (permHiperClique) power *= 10.0;
  cachedClickPower = power;

  // MPS base das oficinas
  double baseMps = 0.0;
  for (int i = 0; i < NUM_UPGRADES; i++) {
    baseMps += ((double)ownedUpgrades[i] * UPGRADE_CONFIGS[i].mps);
  }

  // Multiplicadores base de oficinas
  double workshopMultiplier = 1.0;
  if (permMotorBrushless) workshopMultiplier *= 2.0;
  if (permHiperconducao) workshopMultiplier *= 3.0;
  if (permOnipotenciaMaker) workshopMultiplier *= 4.0;
  baseMps *= workshopMultiplier;

  // Multiplicadores globais percentuais aditivos
  double multiplier = 1.0;
  if (permLubrificante) multiplier += 0.10;
  if (permRefrigeracao) multiplier += 0.20;
  if (permBateriaLitio) multiplier += 0.25;
  if (permIaMaker) multiplier += 0.50;
  if (permNanobots) multiplier += 0.75;
  if (permFusaoFria) multiplier += 1.00;
  if (permSingularidade) multiplier += 1.50;
  if (permTaquions) multiplier += 2.00;
  if (permMateriaEscura) multiplier += 3.00;
  if (permOnipotenciaMaker) multiplier += 5.00;

  cachedMps = baseMps * multiplier;
}

// Processamento atômico de rajadas de cliques acumulados pela ISR
void handleClicks(uint32_t count) {
  if (count == 0) return;

  double gainPerClick = cachedClickPower;
  if (permOnipotenciaMaker) {
    gainPerClick += (cachedMps * 0.30);
  } else if (permSinergiaQuantica) {
    gainPerClick += (cachedMps * 0.20);
  } else if (permOverclock) {
    gainPerClick += (cachedMps * 0.10);
  } else if (permEmpunhadura) {
    gainPerClick += (cachedMps * 0.05);
  }

  makitas += (gainPerClick * (double)count);
  pendingPhysicalClicks += count;
  isFlashDirty = true;
  ultimoClickVisual = millis();
  precisaAtualizarLCD = true;
}

// ===== PERSISTÊNCIA LOCAL (LITTLEFS) =====
void loadLocalGameState() {
  if (!LittleFS.begin()) {
    Serial.println(F("[FS] Falha ao montar LittleFS"));
    recalculateStats();
    return;
  }

  if (!LittleFS.exists(GAMESTATE_FILE)) {
    Serial.println(F("[FS] Nenhum save local encontrado. Iniciando estado padrao."));
    recalculateStats();
    return;
  }

  File f = LittleFS.open(GAMESTATE_FILE, "r");
  if (!f) {
    Serial.println(F("[FS] Erro ao abrir gamestate.json"));
    recalculateStats();
    return;
  }

#if ARDUINOJSON_VERSION_MAJOR >= 7
  JsonDocument doc;
#else
  DynamicJsonDocument doc(2048);
#endif
  DeserializationError err = deserializeJson(doc, f);
  f.close();

  if (err) {
    Serial.printf("[FS] Erro parse save local: %s\n", err.c_str());
    recalculateStats();
    return;
  }

  if (doc.containsKey("makitas")) makitas = doc["makitas"].as<double>();
  if (doc.containsKey("lastExecutedResetTimestamp")) {
    lastExecutedResetTimestamp = doc["lastExecutedResetTimestamp"].as<uint64_t>();
  }
  if (doc.containsKey("owned")) {
    JsonObject ownedObj = doc["owned"].as<JsonObject>();
    for (int i = 0; i < NUM_UPGRADES; i++) {
      if (ownedObj.containsKey(UPGRADE_CONFIGS[i].id)) {
        ownedUpgrades[i] = ownedObj[UPGRADE_CONFIGS[i].id].as<int>();
      }
    }
  }

  if (doc.containsKey("perms")) {
    JsonObject permsObj = doc["perms"].as<JsonObject>();
    permLubrificante = permsObj["perm_lubrificante"] | false;
    permDiscoDiamante = permsObj["perm_disco_diamante"] | false;
    permMotorBrushless = permsObj["perm_motor_brushless"] | false;
    permEmpunhadura = permsObj["perm_empunhadura"] | false;
    permBateriaLitio = permsObj["perm_bateria_litio"] | false;
    permIaMaker = permsObj["perm_ia_maker"] | false;
    permRefrigeracao = permsObj["perm_refrigeracao"] | false;
    permTitanio = permsObj["perm_titanio"] | false;
    permOverclock = permsObj["perm_overclock"] | false;
    permNanobots = permsObj["perm_nanobots"] | false;
    permSingularidade = permsObj["perm_singularidade"] | false;
    permPlasmaCutter = permsObj["perm_plasma_cutter"] | false;
    permFusaoFria = permsObj["perm_fusao_fria"] | false;
    permHiperconducao = permsObj["perm_hiperconducao"] | false;
    permSinergiaQuantica = permsObj["perm_sinergia_quantica"] | false;
    permLaserGama = permsObj["perm_laser_gama"] | false;
    permTaquions = permsObj["perm_taquions"] | false;
    permMateriaEscura = permsObj["perm_materia_escura"] | false;
    permHiperClique = permsObj["perm_hiper_clique"] | false;
    permOnipotenciaMaker = permsObj["perm_onipotencia_maker"] | false;
  }

  recalculateStats();
  Serial.printf("[FS] Save local carregado! Saldo: %.1f | MPS: %.1f\n", makitas, cachedMps);
}

void saveLocalGameState() {
#if ARDUINOJSON_VERSION_MAJOR >= 7
  JsonDocument doc;
#else
  DynamicJsonDocument doc(2048);
#endif
  doc["makitas"] = makitas;
  doc["lastExecutedResetTimestamp"] = lastExecutedResetTimestamp;

  JsonObject ownedObj = doc["owned"].to<JsonObject>();
  for (int i = 0; i < NUM_UPGRADES; i++) {
    ownedObj[UPGRADE_CONFIGS[i].id] = ownedUpgrades[i];
  }

  JsonObject permsObj = doc["perms"].to<JsonObject>();
  permsObj["perm_lubrificante"] = permLubrificante;
  permsObj["perm_disco_diamante"] = permDiscoDiamante;
  permsObj["perm_motor_brushless"] = permMotorBrushless;
  permsObj["perm_empunhadura"] = permEmpunhadura;
  permsObj["perm_bateria_litio"] = permBateriaLitio;
  permsObj["perm_ia_maker"] = permIaMaker;
  permsObj["perm_refrigeracao"] = permRefrigeracao;
  permsObj["perm_titanio"] = permTitanio;
  permsObj["perm_overclock"] = permOverclock;
  permsObj["perm_nanobots"] = permNanobots;
  permsObj["perm_singularidade"] = permSingularidade;
  permsObj["perm_plasma_cutter"] = permPlasmaCutter;
  permsObj["perm_fusaoFria"] = permFusaoFria;
  permsObj["perm_hiperconducao"] = permHiperconducao;
  permsObj["perm_sinergiaQuantica"] = permSinergiaQuantica;
  permsObj["perm_laser_gama"] = permLaserGama;
  permsObj["perm_taquions"] = permTaquions;
  permsObj["perm_materia_escura"] = permMateriaEscura;
  permsObj["perm_hiper_clique"] = permHiperClique;
  permsObj["perm_onipotencia_maker"] = permOnipotenciaMaker;

  File f = LittleFS.open(GAMESTATE_FILE, "w");
  if (!f) {
    Serial.println(F("[FS] Erro ao gravar gamestate.json"));
    return;
  }
  serializeJson(doc, f);
  f.close();
}

// Controle de Reset Remoto da ESP
bool hasPendingResetAck = false;
bool forceCloudSync = false;

// ===== SINCRONIZAÇÃO COM A NUVEM (ESP = RECEIVER, SERVIDOR = MASTER) =====
void syncWithCloud() {
  if (WiFi.status() != WL_CONNECTED) {
    statusAtual = "Offline";
    precisaAtualizarLCD = true;
    return;
  }

  statusAtual = "Sincroniz.";
  precisaAtualizarLCD = true;
  atualizarLCD();

  WiFiClientSecure client;
  client.setInsecure();
  // Alocação consciente de buffers BearSSL: economiza ~15 KB de Heap na SRAM
  client.setBufferSizes(2048, 512);

  HTTPClient http;
  http.setTimeout(2500); // Timeout estrito de 2.5s para evitar travamento da CPU
  http.begin(client, STATE_URL);
  http.addHeader("Content-Type", "application/json");

  int clicksToSend = pendingPhysicalClicks;

#if ARDUINOJSON_VERSION_MAJOR >= 7
  JsonDocument reqDoc;
#else
  DynamicJsonDocument reqDoc(512);
#endif
  reqDoc["action"] = "sync";
  reqDoc["source"] = "esp";
  reqDoc["clicks"] = clicksToSend;
  reqDoc["makitas"] = makitas;
  reqDoc["fwVersion"] = CURRENT_FIRMWARE_VER;
  reqDoc["ip"] = WiFi.localIP().toString();
  reqDoc["rssi"] = WiFi.RSSI();
  reqDoc["uptime"] = (unsigned long)(millis() / 1000);
  reqDoc["freeHeap"] = ESP.getFreeHeap();

  if (hasPendingResetAck) {
    reqDoc["resetAck"] = true;
  }

  String reqBody;
  serializeJson(reqDoc, reqBody);

  int httpCode = http.POST(reqBody);

  if (httpCode == HTTP_CODE_OK) {
    String responsePayload = http.getString();
#if ARDUINOJSON_VERSION_MAJOR >= 7
    JsonDocument doc;
#else
    DynamicJsonDocument doc(3072);
#endif
    DeserializationError err = deserializeJson(doc, responsePayload);

    if (!err) {
      // Sincroniza o timestamp do último reset executado registrado na nuvem
      if (doc.containsKey("lastResetExecutedAt")) {
        uint64_t srvReset = doc["lastResetExecutedAt"].as<uint64_t>();
        if (srvReset > lastExecutedResetTimestamp) {
          lastExecutedResetTimestamp = srvReset;
        }
      }

      // 0. TRATAMENTO DA FILA DE ORDENS LATENTES VINDA DA NUVEM:
      bool resetOrder = doc["resetOrder"] | false;
      JsonObject orderObj;
      bool hasOrderObj = false;
      if (doc["pendingOrder"].is<JsonObject>()) {
        orderObj = doc["pendingOrder"].as<JsonObject>();
        hasOrderObj = true;
      }

      if (resetOrder || hasOrderObj) {
        const char* orderId = hasOrderObj ? (orderObj["id"] | "") : "legacy";
        const char* orderType = hasOrderObj ? (orderObj["type"] | "reset") : "reset";
        uint64_t orderCreatedAt = 0;
        if (hasOrderObj && orderObj.containsKey("createdAt")) {
          orderCreatedAt = orderObj["createdAt"].as<uint64_t>();
        }
        Serial.printf("[ORDEM] Ordem latente recebida da nuvem! ID=%s | Tipo=%s | CriadaEm=%llu\n",
                      orderId, orderType, (unsigned long long)orderCreatedAt);

        // VERIFICAÇÃO TEMPORAL DE RESET (PROTEÇÃO CONTRA CONSISTÊNCIA EVENTUAL):
        // Se a ordem foi criada em timestamp anterior ou igual ao último reset já executado,
        // ela é considerada obsoleta / já concluída (ex: reset emitido às 3:30 após um reset de 3:50).
        if (orderCreatedAt > 0 && lastExecutedResetTimestamp > 0 && orderCreatedAt <= lastExecutedResetTimestamp) {
          Serial.printf("[ORDEM] Ordem ID=%s IGNORADA por antiguidade (%llu <= ultimoReset: %llu). ACK de descarte enviado.\n",
                        orderId, (unsigned long long)orderCreatedAt, (unsigned long long)lastExecutedResetTimestamp);
          enviarAckOrdem(orderId);
        } else {
          if (orderCreatedAt > 0) {
            lastExecutedResetTimestamp = orderCreatedAt;
          }

          if (strcmp(orderType, "factory_reset") == 0) {
            // -------------------------------------------------------------
            // RESET REAL: ZERA MEMÓRIA FLASH E REGRAVA FIRMWARE VIA OTA
            // -------------------------------------------------------------
            Serial.println(F("[RESET_REAL] Executando Reset Real: Limpeza da Flash LittleFS e Regravacao OTA..."));
            statusAtual = "Reset Real";
            precisaAtualizarLCD = true;
            atualizarLCD();

            if (lcd) {
              lcd->clear();
              for (int i = 0; i < 4; i++) prevLcdLines[i][0] = '\0';
              printLinhaFormatada(0, "====================");
              printLinhaFormatada(1, "   RESET REAL ESP   ");
              printLinhaFormatada(2, "Limpando Flash FS...");
              printLinhaFormatada(3, "Enviando ACK...     ");
            }

            // 1. Zera todas as variáveis em RAM
            makitas = 0.0;
            pendingPhysicalClicks = 0;
            for (int i = 0; i < NUM_UPGRADES; i++) ownedUpgrades[i] = 0;
            permLubrificante = permDiscoDiamante = permMotorBrushless = permEmpunhadura = false;
            permBateriaLitio = permIaMaker = permRefrigeracao = permTitanio = false;
            permOverclock = permNanobots = permSingularidade = permPlasmaCutter = false;
            permFusaoFria = permHiperconducao = permSinergiaQuantica = permLaserGama = false;
            permTaquions = permMateriaEscura = permHiperClique = permOnipotenciaMaker = false;
            recalculateStats();

            // 2. Apaga arquivos locais e formata partição flash LittleFS
            LittleFS.remove(GAMESTATE_FILE);
            LittleFS.format();
            isFlashDirty = false;

            // 3. Encerra conexões ativas
            http.end();
            client.stop();

            // 4. Envia confirmação de ACK para retirar da fila no servidor antes de regravar
            enviarAckOrdem(orderId);

            // 5. Força download e regravação completa do firmware via OTA com reboot automático
            forcarRegravacaoOTA();
            return;
          } else {
            // -------------------------------------------------------------
            // RESET SIMPLES DE JOGO: LIMPA VARIÁVEIS E SALVA ESTADO ZERADO
            // -------------------------------------------------------------
            Serial.println(F("[RESET] Executando reset simples de variaveis..."));
            statusAtual = "Apagando...";
            precisaAtualizarLCD = true;
            atualizarLCD();

            makitas = 0.0;
            pendingPhysicalClicks = 0;
            for (int i = 0; i < NUM_UPGRADES; i++) ownedUpgrades[i] = 0;
            permLubrificante = permDiscoDiamante = permMotorBrushless = permEmpunhadura = false;
            permBateriaLitio = permIaMaker = permRefrigeracao = permTitanio = false;
            permOverclock = permNanobots = permSingularidade = permPlasmaCutter = false;
            permFusaoFria = permHiperconducao = permSinergiaQuantica = permLaserGama = false;
            permTaquions = permMateriaEscura = permHiperClique = permOnipotenciaMaker = false;
            recalculateStats();
            saveLocalGameState();
            isFlashDirty = false;

            http.end();
            client.stop();

            // Envia confirmação (ACK) para a nuvem
            enviarAckOrdem(orderId);

            statusAtual = "Reset OK!";
            precisaAtualizarLCD = true;
            atualizarLCD();

            forceCloudSync = true;
            return;
          }
        }
      }

      // Desconta cliques confirmados
      pendingPhysicalClicks -= clicksToSend;
      if (pendingPhysicalClicks < 0) pendingPhysicalClicks = 0;

      // 1. TELEMETRIA DO LÍDER DO RANKING (TOP PLAYER):
      if (doc["topPlayer"].is<JsonObject>()) {
        JsonObject topObj = doc["topPlayer"];
        const char* tName = topObj["name"] | "";
        if (strlen(tName) > 0) {
          topPlayerName = String(tName);
          topPlayerMakitas = topObj["makitas"] | 0.0;
        }
      }

      // 2. CONTROLE DE POSSE DO CONSOLE FÍSICO (HARDWARE OWNER COM PROTEÇÃO TEMPORAL CONTRA KV EVENTUAL):
      bool isStaleOwnerPayload = false;
      if (doc["hardwareOwner"].is<JsonObject>()) {
        JsonObject hObj = doc["hardwareOwner"];
        bool active = hObj["active"] | false;
        uint64_t remoteClaimedAt = 0;
        if (hObj.containsKey("claimedAt")) {
          remoteClaimedAt = hObj["claimedAt"].as<uint64_t>();
        }

        // Blindagem contra consistência eventual do Cloudflare KV:
        // Se o timestamp claimedAt for anterior ao que já conhecemos (ex: recebemos pacote de 1:22
        // mas o console já está no dono de 1:24), descarta completamente o pacote obsoleto!
        if (remoteClaimedAt > 0 && lastHardwareOwnerClaimedAt > 0 && remoteClaimedAt < lastHardwareOwnerClaimedAt) {
          Serial.printf("[OWNER] Rejeitando proprietario obsoleto do KV (recebido: %llu < atual: %llu)\n",
                        (unsigned long long)remoteClaimedAt, (unsigned long long)lastHardwareOwnerClaimedAt);
          isStaleOwnerPayload = true;
        } else {
          if (remoteClaimedAt >= lastHardwareOwnerClaimedAt) {
            lastHardwareOwnerClaimedAt = remoteClaimedAt;
          }
          if (active) {
            hardwareOwnerActive = true;
            hardwareOwnerName = String((const char*)(hObj["userName"] | "Maker"));
            unsigned long remSec = hObj["remainingSec"] | 0;
            hardwareOwnerExpiresAtMillis = millis() + (remSec * 1000UL);
          } else {
            hardwareOwnerActive = false;
          }
        }
      }

      // 3. ADOÇÃO OU RECONCILIAÇÃO DO USUÁRIO-ALVO (OWNER OU TOP PLAYER):
      if (!isStaleOwnerPayload) {
        const char* rawTarget = doc["targetUserId"] | "";
        String newTarget = String(rawTarget);
        bool targetChanged = (newTarget.length() > 0 && newTarget != currentTargetUserId);
        if (targetChanged) {
          currentTargetUserId = newTarget;
          Serial.printf("[TARGET] Alvo do console alterado para: %s\n", newTarget.c_str());
          if (doc.containsKey("makitas")) {
            makitas = doc["makitas"].as<double>();
          }
          for (int i = 0; i < NUM_UPGRADES; i++) {
            ownedUpgrades[i] = 0;
          }
          if (doc.containsKey("owned")) {
            JsonObject ownedObj = doc["owned"].as<JsonObject>();
            for (int i = 0; i < NUM_UPGRADES; i++) {
              if (ownedObj.containsKey(UPGRADE_CONFIGS[i].id)) {
                ownedUpgrades[i] = ownedObj[UPGRADE_CONFIGS[i].id].as<int>();
              }
            }
          }
          permLubrificante = false;
          permDiscoDiamante = false;
          permMotorBrushless = false;
          permEmpunhadura = false;
          permBateriaLitio = false;
          permIaMaker = false;
          permRefrigeracao = false;
          permTitanio = false;
          permOverclock = false;
          permNanobots = false;
          permSingularidade = false;
          permPlasmaCutter = false;
          permFusaoFria = false;
          permHiperconducao = false;
          permSinergiaQuantica = false;
          permLaserGama = false;
          permTaquions = false;
          permMateriaEscura = false;
          permHiperClique = false;
          permOnipotenciaMaker = false;
          if (doc.containsKey("perms")) {
            JsonObject permsObj = doc["perms"].as<JsonObject>();
            permLubrificante = permsObj["perm_lubrificante"] | false;
            permDiscoDiamante = permsObj["perm_disco_diamante"] | false;
            permMotorBrushless = permsObj["perm_motor_brushless"] | false;
            permEmpunhadura = permsObj["perm_empunhadura"] | false;
            permBateriaLitio = permsObj["perm_bateria_litio"] | false;
            permIaMaker = permsObj["perm_ia_maker"] | false;
            permRefrigeracao = permsObj["perm_refrigeracao"] | false;
            permTitanio = permsObj["perm_titanio"] | false;
            permOverclock = permsObj["perm_overclock"] | false;
            permNanobots = permsObj["perm_nanobots"] | false;
            permSingularidade = permsObj["perm_singularidade"] | false;
            permPlasmaCutter = permsObj["perm_plasma_cutter"] | false;
            permFusaoFria = permsObj["perm_fusao_fria"] | false;
            permHiperconducao = permsObj["perm_hiperconducao"] | false;
            permSinergiaQuantica = permsObj["perm_sinergia_quantica"] | false;
            permLaserGama = permsObj["perm_laser_gama"] | false;
            permTaquions = permsObj["perm_taquions"] | false;
            permMateriaEscura = permsObj["perm_materia_escura"] | false;
            permHiperClique = permsObj["perm_hiper_clique"] | false;
            permOnipotenciaMaker = permsObj["perm_onipotencia_maker"] | false;
          }
          recalculateStats();
          isFlashDirty = true;
        } else {
          // Saldo Monotônico dentro da mesma sessão de jogador
          if (doc.containsKey("makitas")) {
            double serverMakitas = doc["makitas"].as<double>();
            if (serverMakitas > makitas) {
              makitas = serverMakitas;
              isFlashDirty = true;
            }
          }

          // Upgrades: Mantém maior nível dentro da mesma sessão
          bool statsChanged = false;
          if (doc.containsKey("owned")) {
            JsonObject ownedObj = doc["owned"].as<JsonObject>();
            for (int i = 0; i < NUM_UPGRADES; i++) {
              if (ownedObj.containsKey(UPGRADE_CONFIGS[i].id)) {
                int serverVal = ownedObj[UPGRADE_CONFIGS[i].id].as<int>();
                if (serverVal > ownedUpgrades[i]) {
                  ownedUpgrades[i] = serverVal;
                  statsChanged = true;
                  isFlashDirty = true;
                }
              }
            }
          }

          // Tecnologias Permanentes
          if (doc.containsKey("perms")) {
            JsonObject permsObj = doc["perms"].as<JsonObject>();
            #define CHECK_PERM(var, key) if (!var && (permsObj[key] | false)) { var = true; statsChanged = true; isFlashDirty = true; }
            CHECK_PERM(permLubrificante, "perm_lubrificante");
            CHECK_PERM(permDiscoDiamante, "perm_disco_diamante");
            CHECK_PERM(permMotorBrushless, "perm_motor_brushless");
            CHECK_PERM(permEmpunhadura, "perm_empunhadura");
            CHECK_PERM(permBateriaLitio, "perm_bateria_litio");
            CHECK_PERM(permIaMaker, "perm_ia_maker");
            CHECK_PERM(permRefrigeracao, "perm_refrigeracao");
            CHECK_PERM(permTitanio, "perm_titanio");
            CHECK_PERM(permOverclock, "perm_overclock");
            CHECK_PERM(permNanobots, "perm_nanobots");
            CHECK_PERM(permSingularidade, "perm_singularidade");
            CHECK_PERM(permPlasmaCutter, "perm_plasma_cutter");
            CHECK_PERM(permFusaoFria, "perm_fusao_fria");
            CHECK_PERM(permHiperconducao, "perm_hiperconducao");
            CHECK_PERM(permSinergiaQuantica, "perm_sinergia_quantica");
            CHECK_PERM(permLaserGama, "perm_laser_gama");
            CHECK_PERM(permTaquions, "perm_taquions");
            CHECK_PERM(permMateriaEscura, "perm_materia_escura");
            CHECK_PERM(permHiperClique, "perm_hiper_clique");
            CHECK_PERM(permOnipotenciaMaker, "perm_onipotencia_maker");
            #undef CHECK_PERM
          }

          if (statsChanged) {
            recalculateStats();
          }
        }
      }

      statusAtual = "Ativo";
      precisaAtualizarLCD = true;
      Serial.printf("[CLOUD] Sync OK! Saldo: %.1f | MPS: %.1f\n", makitas, cachedMps);
    } else {
      Serial.printf("[CLOUD] Erro parse JSON: %s\n", err.c_str());
      statusAtual = "Ativo";
      precisaAtualizarLCD = true;
    }
  } else {
    Serial.printf("[CLOUD] Falha HTTP: %d\n", httpCode);
    if (WiFi.status() == WL_CONNECTED) {
      statusAtual = "Ativo";
    } else {
      statusAtual = "Offline";
    }
    precisaAtualizarLCD = true;
  }

  http.end();
  client.stop();
}

bool enviarAckOrdem(const char* orderId) {
  if (WiFi.status() != WL_CONNECTED) return false;
  Serial.printf("[ORDEM] Enviando ACK para nuvem (orderId: %s)...\n", orderId);

  WiFiClientSecure client;
  client.setInsecure();
  client.setBufferSizes(1024, 512);

  HTTPClient http;
  http.setTimeout(4000);
  http.begin(client, API_URL);
  http.addHeader("Content-Type", "application/json");

#if ARDUINOJSON_VERSION_MAJOR >= 7
  JsonDocument doc;
#else
  DynamicJsonDocument doc(256);
#endif
  doc["auth"] = API_AUTH;
  doc["isEsp"] = true;
  doc["ackOrderId"] = orderId;
  doc["resetAck"] = true;

  String body;
  serializeJson(doc, body);
  int httpCode = http.POST(body);
  bool ok = (httpCode == HTTP_CODE_OK || httpCode == 201);
  Serial.printf("[ORDEM] ACK HTTP code: %d (sucesso=%d)\n", httpCode, ok);

  http.end();
  client.stop();
  return ok;
}

void executarAtualizacaoFirmware(const char* fwUrl, const char* fwMd5, const char* titulo, const char* subtitulo) {
  if (strlen(fwUrl) == 0) return;

  // 1. Salva estado pendente (se houver) e desmonta o LittleFS para proteger setores da flash
  if (isFlashDirty) {
    saveLocalGameState();
    isFlashDirty = false;
  }
  LittleFS.end();

  // 2. Feedback visual no LCD
  if (lcd) {
    lcd->clear();
    for (int i = 0; i < 4; i++) prevLcdLines[i][0] = '\0';
    printLinhaFormatada(0, "====================");
    printLinhaFormatada(1, titulo);
    printLinhaFormatada(2, subtitulo);
    printLinhaFormatada(3, ">> GRAVANDO:  0% <<");
  }

  Serial.println(F("[OTA] Conectando para download e gravacao do binario..."));

  // 3. Cliente TLS dedicado com buffer completo
  WiFiClientSecure otaClient;
  otaClient.setInsecure();

  // 4. Configuração de atualização com reboot automático
  ESPhttpUpdate.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  ESPhttpUpdate.rebootOnUpdate(true);

  if (strlen(fwMd5) > 0) {
    Serial.printf("[OTA] Checksum MD5 esperado: %s\n", fwMd5);
    ESPhttpUpdate.setMD5sum(fwMd5);
  }

  // 5. Hook de progresso no LCD
  ESPhttpUpdate.onProgress([](int cur, int total) {
    if (total > 0 && lcd) {
      int pct = (cur * 100) / total;
      static int lastPct = -1;
      if (pct != lastPct) {
        lastPct = pct;
        char progBuf[21];
        snprintf(progBuf, sizeof(progBuf), ">> GRAVANDO: %2d%% <<", pct);
        printLinhaFormatada(3, progBuf);
      }
    }
    yield();
  });

  // 6. Executa gravação na flash e reboot automático
  t_httpUpdate_return ret = ESPhttpUpdate.update(otaClient, fwUrl);

  // Se chegou nesta linha, o update falhou
  Serial.printf("[OTA] Falha no FW update (%d): %s\n", ret, ESPhttpUpdate.getLastErrorString().c_str());

  LittleFS.begin();
  if (lcd) {
    printLinhaFormatada(1, "  FALHA NO OTA!     ");
    printLinhaFormatada(3, "Tentando depois...  ");
    delay(2500);
    for (int i = 0; i < 4; i++) prevLcdLines[i][0] = '\0';
  }
}

void forcarRegravacaoOTA() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println(F("[RESET_REAL] Sem conexao WiFi para regravacao. Reiniciando..."));
    ESP.restart();
    return;
  }

  Serial.println(F("[RESET_REAL] Consultando version.json para forcar regravacao completa..."));
  WiFiClientSecure client;
  client.setInsecure();
  client.setBufferSizes(2048, 512);

  HTTPClient http;
  http.setTimeout(4000);
  String checkUrl = String(VERSION_URL) + "?t=" + String(millis());
  http.begin(client, checkUrl);
  http.addHeader("Cache-Control", "no-cache");
  int httpCode = http.GET();

  if (httpCode != HTTP_CODE_OK) {
    Serial.printf("[RESET_REAL] Falha ao obter version.json: %d. Reiniciando...\n", httpCode);
    http.end();
    client.stop();
    delay(1000);
    ESP.restart();
    return;
  }

  String payload = http.getString();
  http.end();
  client.stop();

#if ARDUINOJSON_VERSION_MAJOR >= 7
  JsonDocument doc;
#else
  DynamicJsonDocument doc(512);
#endif
  DeserializationError err = deserializeJson(doc, payload);
  if (err) {
    Serial.println(F("[RESET_REAL] Erro JSON version. Reiniciando..."));
    delay(1000);
    ESP.restart();
    return;
  }

  const char* fwUrl = doc["firmware_url"] | "";
  const char* fwMd5 = doc["firmware_md5"] | "";

  if (strlen(fwUrl) > 0) {
    Serial.printf("[RESET_REAL] Regravando firmware a partir de: %s\n", fwUrl);
    executarAtualizacaoFirmware(fwUrl, fwMd5, "   RESET REAL ESP   ", "Regravando Flash...");
  } else {
    Serial.println(F("[RESET_REAL] URL de firmware vazia. Reiniciando..."));
  }

  // Se não reiniciou pelo OTA, reinicia manualmente
  delay(1000);
  ESP.restart();
}

void checkOTA() {
  if (WiFi.status() != WL_CONNECTED) return;

  Serial.println(F("[OTA] Verificando atualizacoes..."));

  WiFiClientSecure client;
  client.setInsecure();
  client.setBufferSizes(2048, 512);

  HTTPClient http;
  http.setTimeout(3000);
  String checkUrl = String(VERSION_URL) + "?t=" + String(millis());
  http.begin(client, checkUrl);
  http.addHeader("Cache-Control", "no-cache");
  int httpCode = http.GET();

  if (httpCode != HTTP_CODE_OK) {
    Serial.printf("[OTA] Falha ao buscar version.json: %d\n", httpCode);
    http.end();
    return;
  }

  String payload = http.getString();
  http.end();
  client.stop();

#if ARDUINOJSON_VERSION_MAJOR >= 7
  JsonDocument doc;
#else
  DynamicJsonDocument doc(512);
#endif
  DeserializationError err = deserializeJson(doc, payload);
  if (err) {
    Serial.println(F("[OTA] Erro parse version.json"));
    return;
  }

  int remoteVersion = doc["firmware_version"] | 0;
  const char* fwUrl = doc["firmware_url"] | "";
  const char* fwMd5 = doc["firmware_md5"] | "";

  Serial.printf("[OTA] Local FW=%d | Remoto FW=%d\n", CURRENT_FIRMWARE_VER, remoteVersion);

  if (remoteVersion > CURRENT_FIRMWARE_VER && strlen(fwUrl) > 0) {
    char vBuf[21];
    snprintf(vBuf, sizeof(vBuf), " v%d -> v%d", CURRENT_FIRMWARE_VER, remoteVersion);
    executarAtualizacaoFirmware(fwUrl, fwMd5, "  ATUALIZANDO OTA   ", vBuf);
  }
}

void setup() {
  system_update_cpu_freq(160); // 160MHz para máxima velocidade de processamento
  Serial.begin(115200);

  // Configuração do Botão Físico com Interrupção de Hardware
  pinMode(PIN_BOTAO, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(PIN_BOTAO), isrBotao, FALLING);

  // Inicialização do Barramento I2C nos pinos D2 (SDA) e D1 (SCL) a 400 kHz (Fast Mode)
  Wire.begin(D2, D1);
  Wire.setClock(400000);

  // Auto-detecta endereço e inicializa LCD 20x4
  uint8_t lcdAddr = detectarEnderecoI2C();
  lcd = new LiquidCrystal_I2C(lcdAddr, 20, 4);
  lcd->init();
  lcd->backlight();
  lcd->clear();

  // Tela de Inicialização
  printLinhaFormatada(0, "====================");
  printLinhaFormatada(1, "   MAKITA CLICKER   ");
  char vInitBuf[21];
  snprintf(vInitBuf, sizeof(vInitBuf), "    Versao: v%d", CURRENT_FIRMWARE_VER);
  printLinhaFormatada(2, vInitBuf);
  printLinhaFormatada(3, "Iniciando sistema...");

  // Carrega save da flash LittleFS imediatamente
  loadLocalGameState();
  recalculateStats();

  delay(600);

  // Tentativa inicial de conexão Wi-Fi
  printLinhaFormatada(3, "Conectando WiFi...  ");
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(ssid, password);
  Serial.print(F("[WiFi] Conectando"));
  unsigned long wifiStart = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - wifiStart < 7000)) {
    delay(250);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    wifiConectadoAnterior = true;
    statusAtual = "Ativo";
    Serial.print(F("[WiFi] Conectado! IP: "));
    Serial.println(WiFi.localIP());
    printLinhaFormatada(3, "WiFi: Conectado!    ");
    delay(500);
    checkOTA();
    syncWithCloud();
  } else {
    wifiConectadoAnterior = false;
    statusAtual = "Offline";
    ultimoWifiRetry = millis();
    Serial.println(F("[WiFi] Falha inicial. Entrando em Modo Offline (retry a cada 10s)..."));
    printLinhaFormatada(3, "Modo Offline (10s)  ");
    delay(600);
  }

  // Limpa buffer de linhas para desenhar a Tela Principal
  for (int i = 0; i < 4; i++) prevLcdLines[i][0] = '\0';
  atualizarLCD();
}

unsigned long lastTick = 0;
unsigned long lastCloudSync = 0;
unsigned long lastLocalSave = 0;
const unsigned long CLOUD_SYNC_INTERVAL_MS = 3000;  // Sincronização a cada 3 segundos (alta responsividade)
const unsigned long LOCAL_SAVE_INTERVAL_MS = 30000; // Autosave condicional na flash a cada 30 segundos

void gerenciarWiFi() {
  unsigned long now = millis();
  wl_status_t wifiStatus = WiFi.status();

  if (wifiStatus == WL_CONNECTED) {
    if (!wifiConectadoAnterior) {
      wifiConectadoAnterior = true;
      Serial.print(F("[WiFi] Reconectado com sucesso! IP: "));
      Serial.println(WiFi.localIP());
      statusAtual = "Ativo";
      precisaAtualizarLCD = true;
      checkOTA();
      syncWithCloud();
    }
  } else {
    if (wifiConectadoAnterior) {
      wifiConectadoAnterior = false;
      Serial.println(F("[WiFi] Conexao perdida. Modo Offline ativo (retry 10s)."));
      statusAtual = "Offline";
      precisaAtualizarLCD = true;
    }

    // Após 4s de tentativa sem sucesso, exibe "Offline" no LCD aguardando o próximo ciclo de 10s
    if (strcmp(statusAtual, "Offline") != 0 && (now - ultimoWifiRetry >= 4000)) {
      statusAtual = "Offline";
      precisaAtualizarLCD = true;
    }

    // Tentativa periódica infinita a cada 10 segundos
    if (now - ultimoWifiRetry >= WIFI_RETRY_INTERVAL_MS) {
      ultimoWifiRetry = now;
      Serial.println(F("[WiFi] Tentando reconectar (retry 10s)..."));
      statusAtual = "Conectando";
      precisaAtualizarLCD = true;
      WiFi.disconnect();
      WiFi.begin(ssid, password);
    }
  }
}

void loop() {
  unsigned long now = millis();

  // 1. Drenagem atômica de cliques físicos capturados via Interrupção de Hardware no pino D5
  uint32_t clicksToProcess = 0;
  if (isrPendingClicks > 0) {
    noInterrupts();
    clicksToProcess = isrPendingClicks;
    isrPendingClicks = 0;
    interrupts();
  }

  if (clicksToProcess > 0) {
    handleClicks(clicksToProcess);
  }

  // 2. Produção passiva local contínua entre ciclos de sync
  if (now - lastTick >= 100) {
    float dt = (now - lastTick) / 1000.0;
    lastTick = now;
    if (cachedMps > 0) {
      makitas += (cachedMps * dt);
      precisaAtualizarLCD = true;
    }
  }

  // 3. Gerenciamento do Timer de Posse do Hardware Físico
  if (hardwareOwnerActive) {
    if (now >= hardwareOwnerExpiresAtMillis) {
      hardwareOwnerActive = false;
      precisaAtualizarLCD = true;
      forceCloudSync = true;
      Serial.println(F("[HARDWARE] Posse expirada! Retornando console ao 1o lugar."));
    } else {
      static unsigned long lastCountdownTick = 0;
      if (now - lastCountdownTick >= 1000) {
        lastCountdownTick = now;
        precisaAtualizarLCD = true;
      }
    }
  }

  // 4. Atualização não-bloqueante e cadenciada do Display LCD 20x4
  if (precisaAtualizarLCD && (now - ultimoUpdateLCD >= INTERVALO_UPDATE_LCD)) {
    precisaAtualizarLCD = false;
    ultimoUpdateLCD = now;
    atualizarLCD();
  }

  // 4. Gerenciamento de Wi-Fi Não-Bloqueante (Retry Infinito a cada 10s)
  gerenciarWiFi();

  // 5. Autosave condicional na flash LittleFS a cada 30s (Proteção contra desgaste prematuro)
  if (isFlashDirty && (now - lastLocalSave >= LOCAL_SAVE_INTERVAL_MS)) {
    lastLocalSave = now;
    saveLocalGameState();
    isFlashDirty = false;
  }

  // 6. Sincronização periódica com a Nuvem a cada 5 segundos ou imediata após Reset
  if (forceCloudSync || (now - lastCloudSync >= CLOUD_SYNC_INTERVAL_MS)) {
    forceCloudSync = false;
    lastCloudSync = now;
    if (WiFi.status() == WL_CONNECTED) {
      syncWithCloud();
    }
  }

  // 7. Verificação periódica de OTA a cada 5 minutos
  static unsigned long lastOtaCheck = 0;
  if (now - lastOtaCheck >= 300000) {
    lastOtaCheck = now;
    if (WiFi.status() == WL_CONNECTED) {
      checkOTA();
    }
  }
}
