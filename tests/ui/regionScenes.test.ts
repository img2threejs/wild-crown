import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { REGION_PRESENTATION, type RegionSceneId } from '../../src/content/regionPresentation.js';
import { loadingSceneMarkup, loadingSceneProgressMarkup, mapIntroMarkup, type LoadingSceneModel } from '../../src/ui/regionScenes.js';

const REGION_IDS = Object.keys(REGION_PRESENTATION) as RegionSceneId[];

const loading = (overrides: Partial<LoadingSceneModel> = {}): LoadingSceneModel => ({
  regionId: 'canopy', label: 'Beginning the Whispering Canopy trials', progress: 0.5, phaseLabel: 'Loading scene assets',
  detail: 'Streaming foliage', loreIndex: 0, reducedMotion: false, ...overrides,
});


describe('loadingSceneMarkup', () => {
  it('is a full-bleed scene with the region, chapter, title, tagline, lore and an actions slot', () => {
    for (const id of REGION_IDS) {
      const region = REGION_PRESENTATION[id];
      const markup = loadingSceneMarkup(loading({ regionId: id, loreIndex: 2 }));
      expect(markup).toContain(`data-region="${id}"`);
      expect(markup).toContain('wc-scene--loading');
      expect(markup).toContain(region.chapterLabel);
      expect(markup).toContain(region.title);
      expect(markup).toContain(region.tagline.replace(/'/g, '&#39;'));
      expect(markup).toContain(region.loadingLore[2]!.replace(/'/g, '&#39;'));
      expect(markup).toContain(region.artUrl);
      expect(markup).toContain('data-scene-actions');
      expect(markup).toContain('data-atmosphere="' + region.atmosphere + '"');
    }
  });

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
    const bar = (progress: number | null) => /<div class="wc-scene__bar-track[^>]*role="progressbar"[^>]*>/.exec(loadingSceneMarkup(loading({ progress })))![0];
    expect(bar(0.5)).toContain('aria-valuemin="0"');
    expect(bar(0.5)).toContain('aria-valuemax="100"');
    expect(bar(0.5)).toContain('aria-valuenow="50"');
    expect(bar(0.5)).toContain('aria-valuetext="50 percent loaded"');
    expect(bar(0)).toContain('aria-valuenow="0"');
    expect(bar(1.7)).toContain('aria-valuenow="100"');
    expect(bar(-3)).toContain('aria-valuenow="0"');
    expect(loadingSceneMarkup(loading({ progress: 0.5 }))).toContain('--p:0.5');
    expect(loadingSceneMarkup(loading({ progress: 0.5 }))).toContain('>50%<');
  });

  it('is indeterminate (no aria-valuenow) for null or non-finite progress', () => {
    for (const progress of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
      const markup = loadingSceneMarkup(loading({ progress }));
      const bar = /<div class="wc-scene__bar-track[^>]*role="progressbar"[^>]*>/.exec(markup)![0];
      expect(bar).not.toContain('aria-valuenow');
      expect(bar).toContain('aria-valuetext="Preparing"');
      expect(markup).toContain('is-indeterminate');
    }
  });

  it('can re-render just the progress block for in-place patching', () => {
    const block = loadingSceneProgressMarkup({ progress: 0.25, phaseLabel: 'Checking assets', detail: 'Required native assets' });
    expect(block.startsWith('<div class="wc-scene__progress')).toBe(true);
    expect(block).toContain('data-scene-progress');
    expect(block).toContain('aria-valuenow="25"');
    expect(loadingSceneMarkup(loading({ progress: 0.25, phaseLabel: 'Checking assets', detail: 'Required native assets' }))).toContain(block);
  });

  it('renders an authored static frame for reduced motion: no particles, drift or per-letter reveal', () => {
    for (const id of REGION_IDS) {
      const reduced = loadingSceneMarkup(loading({ regionId: id, reducedMotion: true }));
      expect(reduced).toContain('wc-scene--static');
      expect(reduced).not.toContain('wc-atmo');
      expect(reduced).not.toContain('wc-scene__art--drift');
      expect(reduced).not.toContain('wc-scene__char');
      expect(reduced).toContain(`<h1 class="wc-scene__title" id="wc-scene-title-${id}">${REGION_PRESENTATION[id].title}</h1>`);
      expect(reduced).toContain(REGION_PRESENTATION[id].title);
      const animated = loadingSceneMarkup(loading({ regionId: id, reducedMotion: false }));
      expect(animated).toContain('wc-scene__art--drift');
      expect(animated).toContain(`wc-atmo--${REGION_PRESENTATION[id].atmosphere}`);
      expect(animated).toContain('wc-scene__char');
      expect(animated).not.toContain('wc-scene--static');
    }
  });

  it('keeps the particle layer at or under 24 elements and deterministic', () => {
    for (const id of REGION_IDS) {
      const markup = loadingSceneMarkup(loading({ regionId: id }));
      const layer = /<div class="wc-scene__atmosphere[^>]*>(.*?)<\/div>/.exec(markup)![1]!;
      const particles = layer.match(/<i /g)!.length;
      expect(particles).toBeGreaterThan(0);
      expect(particles).toBeLessThanOrEqual(24);
      expect(loadingSceneMarkup(loading({ regionId: id }))).toBe(markup);
    }
  });

  it('throws for an unknown region', () => {
    expect(() => loadingSceneMarkup(loading({ regionId: 'sunmane' as RegionSceneId }))).toThrow('Unknown region scene: sunmane');
    expect(() => loadingSceneMarkup(loading({ regionId: 'constructor' as RegionSceneId }))).toThrow('Unknown region scene');
    expect(() => loadingSceneMarkup(loading({ regionId: '__proto__' as RegionSceneId }))).toThrow('Unknown region scene');
  });
});

describe('mapIntroMarkup', () => {
  it('shows the hero entering the region, every story beat, the threat line and both actions', () => {
    for (const id of REGION_IDS) {
      const region = REGION_PRESENTATION[id];
      const markup = mapIntroMarkup({ regionId: id, heroName: 'Aren', reducedMotion: false });
      expect(markup).toContain('wc-scene--intro');
      expect(markup).toContain(`data-region="${id}"`);
      expect(markup).toContain(`Aren enters ${region.title}`);
      for (const beat of region.introBeats) expect(markup).toContain(beat.replace(/'/g, '&#39;'));
      expect(markup).toContain(region.threatLine.replace(/'/g, '&#39;'));
      expect(markup.match(/wc-scene__beat/g)!.length).toBe(region.introBeats.length);
      expect(markup).toContain('wc-scene__letterbox--top');
      expect(markup).toContain('wc-scene__letterbox--bottom');
    }
  });

  it('offers Continue as the primary focus target and Skip, each keyed for the UI shell', () => {
    const markup = mapIntroMarkup({ regionId: 'moonpine', heroName: 'Aren', reducedMotion: false });
    expect(markup).toMatch(/<button type="button" class="wc-scene__btn wc-scene__btn--primary" data-ui-action="intro-continue" data-focus-key="intro-continue">Continue<\/button>/);
    expect(markup).toMatch(/<button type="button" class="wc-scene__btn wc-scene__btn--quiet" data-ui-action="intro-skip" data-focus-key="intro-skip">Skip<\/button>/);
    expect(markup.indexOf('intro-continue')).toBeLessThan(markup.indexOf('intro-skip'));
  });

  it('sequences chapter label, title, tagline and beats with strictly increasing CSS delays', () => {
    const markup = mapIntroMarkup({ regionId: 'canopy', heroName: 'Aren', reducedMotion: false });
    const delay = (cls: string) => Number(new RegExp(`class="${cls}"[^>]*style="--d:([0-9.]+)s"`).exec(markup)![1]);
    const beatDelays = [...markup.matchAll(/class="wc-scene__beat" style="--d:([0-9.]+)s"/g)].map(match => Number(match[1]));
    expect(beatDelays.length).toBe(REGION_PRESENTATION.canopy.introBeats.length);
    const chain = [delay('wc-scene__chapter'), delay('wc-scene__tagline'), ...beatDelays, delay('wc-scene__threat'), delay('wc-scene__hero')];
    for (let i = 1; i < chain.length; i++) expect(chain[i]!).toBeGreaterThan(chain[i - 1]!);
    expect(markup).toContain('--t0:1s');
  });

  it('renders an authored static frame for reduced motion: no particles, drift or letter reveal, actions kept', () => {
    for (const id of REGION_IDS) {
      const reduced = mapIntroMarkup({ regionId: id, heroName: 'Aren', reducedMotion: true });
      expect(reduced).toContain('wc-scene--static');
      expect(reduced).not.toContain('wc-atmo');
      expect(reduced).not.toContain('wc-scene__art--drift');
      expect(reduced).not.toContain('wc-scene__char');
      expect(reduced).toContain('data-ui-action="intro-continue"');
      expect(reduced).toContain('data-ui-action="intro-skip"');
      expect(reduced).toContain(`Aren enters ${REGION_PRESENTATION[id].title}`);
    }
  });

  it('throws for an unknown region', () => {
    expect(() => mapIntroMarkup({ regionId: 'blood-bamboo' as RegionSceneId, heroName: 'Aren', reducedMotion: false })).toThrow('Unknown region scene: blood-bamboo');
  });
});

describe('region scene implementation constraints', () => {
  const source = readFileSync('src/ui/regionScenes.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const css = readFileSync('src/ui/region-scenes.css', 'utf8');

  it('uses no JS timers, frame loops or randomness', () => {
    expect(source).not.toMatch(/setTimeout|setInterval|requestAnimationFrame|Math\.random|addEventListener/);
  });

  it('animates only transform and opacity in every keyframe', () => {
    const blocks = [...css.matchAll(/@keyframes ([\w-]+) \{((?:[^{}]|\{[^{}]*\})*)\}/g)];
    expect(blocks.length).toBeGreaterThan(10);
    for (const [, name, body] of blocks) {
      const properties = new Set([...body!.matchAll(/([\w-]+)\s*:/g)].map(match => match[1]));
      for (const property of properties) expect([name, ['transform', 'opacity'].includes(property!)]).toEqual([name, true]);
    }
  });

  it('resolves reduced motion to a static frame in CSS as well', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('.wc-scene--static');
  });
});
