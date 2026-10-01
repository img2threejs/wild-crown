import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { SCHEMA_VERSION } from './packages/campaign/src/index.js';
import { SAVE_FORMAT_SCHEMA_VERSION } from './src/game/storage/SaveRepository.js';
import { BUILD_SCHEMA_VERSION } from './src/app/applicationSchema.js';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

function compatibilityArtifact(): Plugin {
  return {
    name: 'wild-crown-compatibility-artifact',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'release-compatibility.json',
        source: JSON.stringify({
          buildSchema: BUILD_SCHEMA_VERSION,
          saveSchema: SAVE_FORMAT_SCHEMA_VERSION,
          campaignSchema: SCHEMA_VERSION,
          authority: 'BUILD_SCHEMA_VERSION from src/app/applicationSchema.ts; SAVE_FORMAT_SCHEMA_VERSION from src/game/storage/SaveRepository.ts; SCHEMA_VERSION from packages/campaign/src/index.ts',
        }, null, 2) + '\n',
      });
    },
  };
}

export default defineConfig({
  base: '/',
  plugins: [compatibilityArtifact()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  build: {
    rollupOptions: {
      input: {
        main: resolve(projectRoot, 'index.html'),
        movementLab: resolve(projectRoot, 'lab/index.html'),
      },
    },
  },
});
