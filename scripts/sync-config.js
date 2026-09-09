import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');

const sourceConfig = resolve(rootDir, 'game-config.json');
const targetFunctions = resolve(rootDir, 'functions/api/game-config.json');
const targetWeb = resolve(rootDir, 'web/game-config.json');

if (!existsSync(sourceConfig)) {
  console.error('[SYNC] Erro: game-config.json nao encontrado na raiz!');
  process.exit(1);
}

// Garante pastas de destino
mkdirSync(dirname(targetFunctions), { recursive: true });
mkdirSync(dirname(targetWeb), { recursive: true });

copyFileSync(sourceConfig, targetFunctions);
copyFileSync(sourceConfig, targetWeb);

console.log('[SYNC] game-config.json sincronizado com sucesso para web/ e functions/api/');
