// Run in the local Vite page's browser console (not Node):
// const { renderPortrait } = await import('/asset-source/generated/actor-vesper-hero-01/portrait/render-portrait.mjs');
// const portrait = await renderPortrait('sakda'); // or 'vesper'
// const link = document.createElement('a'); link.href = portrait.dataUrl;
// link.download = `${portrait.hero}.png`; link.click();
// Uses the real selector renderer, native fitted hands/weapon, materials and manifest-bound idle.
import { mountHeroPreview } from '../../../../src/rendering/HeroPreview.ts';
import { heroById } from '../../../../src/game/heroes.ts';

export async function renderPortrait(heroId, manifestUrl = '/asset-source/playtests/greenwake.json') {
  const hero = heroById(heroId);
  const response = await fetch(manifestUrl, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Portrait manifest: HTTP ${response.status}`);
  const assets = await response.json();
  const asset = assets.find(entry => entry.id === (hero.variantAssetId ?? 'actor-aren'));
  if (!asset) throw new Error(`Portrait asset missing: ${hero.id}`);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:512px;height:640px;pointer-events:none';
  const placeholder = document.createElement('span');
  placeholder.dataset.previewPlaceholder = '';
  host.append(placeholder);
  document.body.append(host);
  let preview, observer, timer;
  try {
    const ready = new Promise((resolve, reject) => {
      observer = new MutationObserver(() => {
        if (host.dataset.previewState === 'ready') resolve();
        else if (host.dataset.previewState === 'error') reject(new Error(placeholder.textContent));
      });
      observer.observe(host, { attributes: true, attributeFilter: ['data-preview-state'] });
      timer = setTimeout(() => reject(new Error(`Portrait loading timed out: ${hero.id}`)), 60000);
    });
    preview = mountHeroPreview(host, assets, { reducedMotion: true });
    preview.show(hero.id);
    await ready;
    // Render and copy synchronously: WebGL's non-preserved drawing buffer is valid in this task.
    preview.update(0);
    const output = document.createElement('canvas');
    output.width = 512;
    output.height = 640;
    const context = output.getContext('2d');
    if (!context) throw new Error('Portrait PNG encoder is unavailable.');
    context.fillStyle = '#10221a';
    context.fillRect(0, 0, output.width, output.height);
    context.drawImage(host.querySelector('canvas'), 0, 0, output.width, output.height);
    return { hero: hero.id, assetId: asset.id, outputHash: asset.outputHash, width: output.width, height: output.height, dataUrl: output.toDataURL('image/png') };
  } finally {
    clearTimeout(timer);
    observer?.disconnect();
    preview?.dispose();
    host.remove();
  }
}
