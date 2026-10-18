import { describe, expect, it } from 'bun:test';
import { REGION_PRESENTATION, type RegionSceneId } from '../../src/content/regionPresentation.js';
import { loadingSceneMarkup, mapIntroMarkup, type LoadingSceneModel } from '../../src/ui/regionScenes.js';

const loading = (overrides: Partial<LoadingSceneModel> = {}): LoadingSceneModel => ({
  regionId: 'canopy', label: 'Beginning the Whispering Canopy trials', progress: 0.5, phaseLabel: 'Loading scene assets',
  detail: 'Streaming foliage', loreIndex: 0, reducedMotion: false, ...overrides,
});


describe('loadingSceneMarkup', () => {
  it('wraps the lore index in both directions and tolerates non-finite values', () => {
    const lore = REGION_PRESENTATION.grove.loadingLore;
    const at = (loreIndex: number) => loadingSceneMarkup(loading({ regionId: 'grove', loreIndex }));
    const first = lore[0]!.replace(/'/g, '&#39;');
    const last = lore[lore.length - 1]!.replace(/'/g, '&#39;');
    expect(at(lore.length)).toContain(first);
    expect(at(-1)).toContain(last);
    expect(at(Number.NaN)).toContain(first);
  });

  it('escapes every caller-supplied string', () => {
    const hostile = '<img src=x onerror=alert(1)> "quoted" & \'single\'';
    const markup = loadingSceneMarkup(loading({ label: hostile, phaseLabel: hostile, detail: hostile }));
    expect(markup).not.toContain('<img');
    expect(markup).not.toContain('onerror=alert(1)>');
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt; &quot;quoted&quot; &amp; &#39;single&#39;');
    const intro = mapIntroMarkup({ regionId: 'canopy', heroName: '<script>alert(1)</script>', reducedMotion: false });
    expect(intro).not.toContain('<script>');
    expect(intro).toContain('&lt;script&gt;alert(1)&lt;/script&gt; enters Whispering Canopy');
  });

  it('exposes numeric progress through the progressbar aria attributes', () => {
    const bar = (progress: number | null) => /<div[^>]*role="progressbar"[^>]*>/.exec(loadingSceneMarkup(loading({ progress })))![0];
    expect(bar(0.5)).toContain('aria-valuemin="0"');
    expect(bar(0.5)).toContain('aria-valuemax="100"');
    expect(bar(0.5)).toContain('aria-valuenow="50"');
    expect(bar(0)).toContain('aria-valuenow="0"');
    expect(bar(1.7)).toContain('aria-valuenow="100"');
    expect(bar(-3)).toContain('aria-valuenow="0"');
    expect(loadingSceneMarkup(loading({ progress: 0.5 }))).toContain('>50%<');
  });

  it('is indeterminate (no aria-valuenow) for null or non-finite progress', () => {
    for (const progress of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
      const markup = loadingSceneMarkup(loading({ progress }));
      const bar = /<div[^>]*role="progressbar"[^>]*>/.exec(markup)![0];
      expect(bar).not.toContain('aria-valuenow');
    }
  });

  it('throws for an unknown region', () => {
    expect(() => loadingSceneMarkup(loading({ regionId: 'sunmane' as RegionSceneId }))).toThrow('Unknown region scene: sunmane');
    expect(() => loadingSceneMarkup(loading({ regionId: 'constructor' as RegionSceneId }))).toThrow('Unknown region scene');
    expect(() => loadingSceneMarkup(loading({ regionId: '__proto__' as RegionSceneId }))).toThrow('Unknown region scene');
  });
});

describe('mapIntroMarkup', () => {
  it('throws for an unknown region', () => {
    expect(() => mapIntroMarkup({ regionId: 'blood-bamboo' as RegionSceneId, heroName: 'Aren', reducedMotion: false })).toThrow('Unknown region scene: blood-bamboo');
  });
});

