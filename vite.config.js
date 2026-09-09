import { resolve } from 'path';
import { readFileSync, copyFileSync } from 'fs';
import { execSync } from 'child_process';
import { defineConfig } from 'vite';

function gameConfigPlugin() {
  return {
    name: 'game-config-plugin',
    buildStart() {
      const rootConfig = resolve(import.meta.dirname, 'game-config.json');
      const webConfig = resolve(import.meta.dirname, 'web/game-config.json');
      const apiConfig = resolve(import.meta.dirname, 'functions/api/game-config.json');
      try {
        copyFileSync(rootConfig, webConfig);
        copyFileSync(rootConfig, apiConfig);
      } catch (e) {
        console.warn('[VITE] Falha ao sincronizar game-config.json:', e);
      }
    },
    generateBundle() {
      const configPath = resolve(import.meta.dirname, 'game-config.json');
      const content = readFileSync(configPath, 'utf-8');
      this.emitFile({
        type: 'asset',
        fileName: 'game-config.json',
        source: content
      });

      let rev = Date.now();
      try {
        rev = parseInt(execSync('git rev-list --count HEAD', { cwd: import.meta.dirname, stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim(), 10) || rev;
      } catch (e) {}

      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({
          web_version: rev,
          build_time: Date.now()
        }, null, 2)
      });
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === '/game-config.json') {
          const configPath = resolve(import.meta.dirname, 'game-config.json');
          res.setHeader('Content-Type', 'application/json');
          res.end(readFileSync(configPath, 'utf-8'));
          return;
        }
        next();
      });
    }
  };
}

export default defineConfig({
  // A pasta web será a raiz do servidor de desenvolvimento e do build
  root: 'web',
  plugins: [gameConfigPlugin()],
  build: {
    // A pasta de saída será na raiz do repositório (fora da pasta web)
    outDir: '../dist',
    // Limpa a pasta dist antes de cada build
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'web/index.html'),
        admin: resolve(import.meta.dirname, 'web/admin.html')
      }
    }
  }
});

