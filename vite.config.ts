import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { SCHEMA_VERSION } from './packages/campaign/src/index.js';
import { SAVE_FORMAT_SCHEMA_VERSION } from './src/game/storage/SaveRepository.js';
import { BUILD_SCHEMA_VERSION } from './src/app/applicationSchema.js';
import { CHAPTER_ASSET_BINDINGS } from './src/content/chapter-assets.js';
import { HEROES } from './src/game/heroes.js';
import type { AssetManifestEntry } from './src/game/contracts.js';
import { REGIONS } from './src/content/campaign.js';
import { REGION_PRESENTATION } from './src/content/regionPresentation.js';
import { biomeProfileFor } from './src/world/Biomes.js';

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

/** Ship only runtime dependencies, never the raw provider downloads or private source/evidence directories. */
function campaignRuntimeAssets(): Plugin {
  let outDir: string;
  return {
    name: 'wild-crown-campaign-runtime-assets',
    apply: 'build',
    configResolved(config) { outDir = resolve(config.root, config.build.outDir); },
    async closeBundle() {
      const catalogs = new Set([
        ...Object.values(CHAPTER_ASSET_BINDINGS).flatMap(bindings => bindings.map(binding => binding.catalogUrl)),
        '/asset-source/playtests/hero-pedestals.json',
      ]);
      const urls = new Set([...catalogs, ...HEROES.map(hero => hero.portraitUrl), ...Object.values(REGION_PRESENTATION).map(scene => scene.artUrl).filter(url => url.startsWith('/asset-source/'))]);
      for (const region of REGIONS) {
        const splat = biomeProfileFor(region)?.splat;
        if (!splat) continue;
        for (const layer of splat.layers) {
          for (const map of ['diffuse', 'normal', 'arm']) urls.add(`${splat.textureRoot}/${layer.id}/${map}.jpg`);
        }
      }
      for (const url of catalogs) {
        const entries = JSON.parse(await readFile(resolve(projectRoot, url.slice(1)), 'utf8')) as AssetManifestEntry[];
        for (const entry of entries) if (entry.runtimeUrl) urls.add(entry.runtimeUrl);
      }
      for (const url of urls) {
        if (!url.startsWith('/asset-source/') || url.split('/').includes('..')) throw new Error(`Invalid campaign runtime URL: ${url}`);
        const relative = url.slice(1);
        const destination = resolve(outDir, relative);
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(resolve(projectRoot, relative), destination);
      }
    },
  };
}

export default defineConfig({
  base: '/',
  plugins: [compatibilityArtifact(), campaignRuntimeAssets()],
  optimizeDeps: { include: ['meshoptimizer', 'three/addons/exporters/GLTFExporter.js'] },
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
