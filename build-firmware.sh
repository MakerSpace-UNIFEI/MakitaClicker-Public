#!/usr/bin/env bash
set -e

# =============================================================
# MAKITA CLICKER — PIPELINE CI/CD FIRMWARE OTA ESP8266
# Versionamento Automático · Checksum MD5 · Safe Wildcard · Clean Git
# =============================================================

# 1. Unshallow no clone do Cloudflare Pages (que usa --depth=1)
git fetch --unshallow 2>/dev/null || true

VERSION=$(git rev-list --count HEAD 2>/dev/null || echo 0)
if [ "$VERSION" -le 1 ]; then
  # Fallback caso não consiga unshallow: timestamp unix do commit
  VERSION=$(git log -1 --format=%ct 2>/dev/null || date +%s)
fi

echo "=== Versão deste build: $VERSION ==="

# 2. Patch temporário da versão do firmware no .ino ANTES de compilar
sed -i "s/#define CURRENT_FIRMWARE_VER .*/#define CURRENT_FIRMWARE_VER $VERSION/" firmware/codigo_esp/codigo_esp.ino

echo "[VERSION] codigo_esp.ino patchado com CURRENT_FIRMWARE_VER = $VERSION"

# 3. Garante existência do arduino-cli (usa local/PATH se já existir)
if ! command -v arduino-cli &> /dev/null; then
  echo "=== [1/3] Instalando arduino-cli ==="
  curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | BINDIR=. sh
  export PATH=$PATH:.
else
  echo "=== [1/3] arduino-cli ja instalado no sistema ==="
fi

# 4. Configuração do Core ESP8266
echo "=== [2/3] Configurando Core ESP8266 ==="
arduino-cli config init --additional-urls https://arduino.esp8266.com/stable/package_esp8266com_index.json 2>/dev/null || true
arduino-cli core update-index
arduino-cli core install esp8266:esp8266

# 5. Instalação das Bibliotecas
echo "=== [3/3] Instalando Bibliotecas ESP ==="
arduino-cli lib install "ArduinoJson" "LiquidCrystal I2C" || true

mkdir -p dist

# 6. Compilação Headless do Firmware
echo "=== Compilando Firmware ESP8266 (FQBN: nodemcuv2) ==="
SKETCH_DIR="firmware/codigo_esp"
mkdir -p build_esp

arduino-cli compile --fqbn esp8266:esp8266:nodemcuv2 \
  --output-dir ./build_esp \
  "$SKETCH_DIR"

# 7. Localiza de forma segura o binário compilado principal (evita erros com wildcards)
BIN_PATH=$(find ./build_esp -maxdepth 1 -name "*.bin" ! -name "*littlefs*" ! -name "*partitions*" | head -n 1)
if [ -z "$BIN_PATH" ] || [ ! -f "$BIN_PATH" ]; then
  echo "ERRO CRITICO: Nenhum binario compilado encontrado em ./build_esp!"
  exit 1
fi

cp "$BIN_PATH" ./dist/firmware.bin

# 8. Cálculo de integridade por Hash MD5 e Tamanho em Bytes
MD5=$(md5sum ./dist/firmware.bin | awk '{print $1}')
SIZE=$(wc -c < ./dist/firmware.bin | tr -d ' ')

echo "=== Firmware gerado com sucesso ==="
echo "Arquivo: ./dist/firmware.bin"
echo "Tamanho: $SIZE bytes"
echo "MD5:     $MD5"

# 9. Geração do manifesto version.json com validação criptográfica
BUILD_TIME_MS=$(date +%s%3N 2>/dev/null || date +%s)
cat > ./dist/version.json << VERSIONJSON
{
  "firmware_version": $VERSION,
  "firmware_url": "https://makitaclicker.pages.dev/firmware.bin",
  "firmware_size": $SIZE,
  "firmware_md5": "$MD5",
  "web_version": $VERSION,
  "build_time": $BUILD_TIME_MS
}
VERSIONJSON

echo "[VERSION] version.json gerado:"
cat ./dist/version.json

# 10. Limpeza: Restaura a constante CURRENT_FIRMWARE_VER no .ino para manter o arquivo base limpo
sed -i "s/#define CURRENT_FIRMWARE_VER .*/#define CURRENT_FIRMWARE_VER 0/" firmware/codigo_esp/codigo_esp.ino

echo "=== Pipeline OTA concluido com sucesso ==="
