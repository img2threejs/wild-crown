import './region-scenes.css';
import { REGION_PRESENTATION, type RegionAtmosphere, type RegionPresentation, type RegionSceneId } from '../content/regionPresentation.js';

/**
 * Static HTML for the per-map loading scene and map intro. Everything here is a pure string builder: the scenes animate
 * through CSS classes and custom properties only, so no timers, listeners or per-frame work live in this module. The caller
 * stages the markup with innerHTML, appends errors/actions inside `[data-scene-actions]` and adds `.is-leaving` to the
 * `.wc-scene` root to play the exit animation.
 */

export interface LoadingSceneModel {
  readonly regionId: RegionSceneId;
  readonly label: string;
  /** 0..1, or null while the amount of work is unknown. */
  readonly progress: number | null;
  readonly phaseLabel: string;
  readonly detail: string;
  readonly loreIndex: number;
  readonly reducedMotion: boolean;
}

export interface MapIntroModel {
  readonly regionId: RegionSceneId;
  readonly heroName: string;
  readonly reducedMotion: boolean;
}

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value: string | number): string => String(value).replace(/[&<>"']/g, char => ESCAPES[char]!);

function region(id: RegionSceneId): RegionPresentation {
  if (!Object.prototype.hasOwnProperty.call(REGION_PRESENTATION, id)) throw new Error(`Unknown region scene: ${String(id)}`);
  const found = REGION_PRESENTATION[id];
  return found;
}

/** Colours are authored data, but they still pass through a conservative filter before entering a style attribute. */
const cssColour = (value: string): string => value.replace(/[^#%(),.\w\s-]/g, '');
const artUrl = (value: string): string => value.replace(/[^\w\-./:%~]/g, '');

function paletteStyle(presentation: RegionPresentation): string {
  const { sky, mid, accent, glow } = presentation.palette;
  return `--rs-sky:${cssColour(sky)};--rs-mid:${cssColour(mid)};--rs-accent:${cssColour(accent)};--rs-glow:${cssColour(glow)}`;
}

/** Deterministic 0..1 value so identical models produce identical markup (no Math.random). */
function unit(index: number, salt: number): number {
  let h = Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(salt + 7, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= h >>> 12;
  return ((h >>> 0) % 10000) / 10000;
}

const PARTICLE_COUNT: Readonly<Record<RegionAtmosphere, number>> = { fireflies: 18, leaves: 14, pollen: 24, snow: 24, mist: 12 };
/** Base + spread of each particle size (px; vmax for mist banks). */
const SIZE: Readonly<Record<RegionAtmosphere, readonly [number, number]>> = { fireflies: [3, 5], leaves: [9, 9], pollen: [2, 4], snow: [2, 5], mist: [20, 22] };

/** CSS-only particle layer: at most 24 `<i>` elements, animated with transform/opacity only. Also used by the title screen. */
export function atmosphereMarkup(kind: RegionAtmosphere): string {
  const count = PARTICLE_COUNT[kind];
  let items = '';
  for (let i = 0; i < count; i++) {
    const x = Math.round(unit(i, 1) * 96 + 2);
    const size = Math.round(SIZE[kind][0] + unit(i, 2) * SIZE[kind][1]);
    const duration = kind === 'mist' ? Math.round(34 + unit(i, 3) * 30) : Math.round((kind === 'fireflies' ? 9 : kind === 'leaves' ? 11 : kind === 'snow' ? 10 : 15) + unit(i, 3) * 10);
    const delay = -Math.round(unit(i, 4) * duration * 10) / 10;
    const drift = Math.round((unit(i, 5) - 0.5) * (kind === 'mist' ? 36 : 22));
    const lane = Math.round(unit(i, 6) * 100);
    const style = `--x:${x}%;--y:${lane}%;--s:${size}${kind === 'mist' ? 'vmax' : 'px'};--t:${duration}s;--d:${delay}s;--w:${drift}vw;--k:${unit(i, 7).toFixed(2)}`;
    items += `<i style="${style}"></i>`;
  }
  return `<div class="wc-scene__atmosphere wc-atmo wc-atmo--${kind}" aria-hidden="true">${items}</div>`;
}

function backdropMarkup(presentation: RegionPresentation, reducedMotion: boolean): string {
  const drift = reducedMotion ? '' : ' wc-scene__art--drift';
  return `<div class="wc-scene__backdrop" aria-hidden="true">`
    + `<div class="wc-scene__art${drift}" style="background-image:url(&quot;${esc(artUrl(presentation.artUrl))}&quot;)"></div>`
    + `<div class="wc-scene__shade"></div><div class="wc-scene__vignette"></div>`
    + `</div>${reducedMotion ? '' : atmosphereMarkup(presentation.atmosphere)}`;
}

/** One readable heading from the first frame, including reduced motion. */
function titleMarkup(title: string, id: string): string {
  return `<h1 class="wc-scene__title" id="${id}">${esc(title)}</h1>`;
}

const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

/** The progress block alone, so a caller that re-renders on every progress tick can patch `[data-scene-progress]` in place. */
export function loadingSceneProgressMarkup(model: Pick<LoadingSceneModel, 'progress' | 'phaseLabel' | 'detail'>): string {
  const known = typeof model.progress === 'number' && Number.isFinite(model.progress);
  const ratio = known ? clamp01(model.progress as number) : 0;
  const percent = Math.round(ratio * 100);
  const trackAttrs = known
    ? `aria-valuenow="${percent}" aria-valuetext="${percent} percent loaded"`
    : 'aria-valuetext="Preparing"';
  return `<div class="wc-scene__progress${known ? '' : ' is-indeterminate'}" data-scene-progress style="--p:${ratio}">`
    + `<p class="wc-scene__phase"><span class="wc-scene__phase-label">${esc(model.phaseLabel)}</span><span class="wc-scene__percent" aria-hidden="true">${known ? `${percent}%` : '&middot;&middot;&middot;'}</span></p>`
    + `<div class="wc-scene__bar-wrap"><div class="wc-scene__bar-track" role="progressbar" aria-label="Loading progress" aria-valuemin="0" aria-valuemax="100" ${trackAttrs}><span class="wc-scene__fill"></span></div></div>`
    + `<p class="wc-scene__detail" role="status" aria-live="polite">${esc(model.detail)}</p>`
    + `</div>`;
}

/**
 * Full-bleed loading scene. Contains the progressbar; the caller appends errors and recovery buttons inside
 * `[data-scene-actions]`. Throws for an unknown region.
 */
export function loadingSceneMarkup(model: LoadingSceneModel): string {
  const presentation = region(model.regionId);
  const lore = presentation.loadingLore;
  const loreIndex = Number.isFinite(model.loreIndex) ? ((Math.trunc(model.loreIndex) % lore.length) + lore.length) % lore.length : 0;
  const mode = model.reducedMotion ? ' wc-scene--static' : '';
  const titleId = `wc-scene-title-${presentation.id}`;
  const progress = loadingSceneProgressMarkup(model);
  return `<section class="wc-scene wc-scene--loading wc-scene--${presentation.id}${mode}" data-region="${presentation.id}" data-atmosphere="${presentation.atmosphere}" style="${paletteStyle(presentation)}" aria-labelledby="${titleId}">`
    + backdropMarkup(presentation, model.reducedMotion)
    + `<div class="wc-scene__content">`
    + `<header class="wc-scene__head-block">${titleMarkup(presentation.title, titleId)}<p class="wc-scene__chapter">${esc(presentation.chapterLabel)}</p>`
    + `<p class="wc-scene__tagline">${esc(presentation.tagline)}</p></header>`
    + `<footer class="wc-scene__foot">`
    + `<p class="wc-scene__lore" data-scene-lore><span class="wc-scene__lore-mark" aria-hidden="true"></span><span>${esc(lore[loreIndex]!)}</span></p>`
    + `<p class="wc-scene__label">${esc(model.label)}</p>`
    + progress
    + `<div class="wc-scene__actions" data-scene-actions></div>`
    + `</footer></div></section>`;
}


/**
 * Full-bleed chapter entry: native scenery, complete authored story beats and immediate Continue/Skip.
 * The player controls the pace; no timed text reveal or automatic continuation.
 */
export function mapIntroMarkup(model: MapIntroModel): string {
  const presentation = region(model.regionId);
  const reduced = model.reducedMotion;
  const titleId = `wc-intro-title-${presentation.id}`;
  const beats = presentation.introBeats
    .map(beat => `<p class="wc-scene__beat">${esc(beat)}</p>`)
    .join('');
  const mode = reduced ? ' wc-scene--static' : '';
  return `<section class="wc-scene wc-scene--intro wc-scene--${presentation.id}${mode}" data-region="${presentation.id}" data-atmosphere="${presentation.atmosphere}" style="${paletteStyle(presentation)}" role="dialog" aria-modal="false" aria-labelledby="${titleId}">`
    + backdropMarkup(presentation, reduced)
    + `<div class="wc-scene__content wc-scene__content--intro">`
    + `<header class="wc-scene__head-block">${titleMarkup(presentation.title, titleId)}<p class="wc-scene__chapter">${esc(presentation.chapterLabel)}</p>`
    + `<p class="wc-scene__tagline">${esc(presentation.tagline)}</p></header>`
    + `<div class="wc-scene__story">${beats}<p class="wc-scene__threat">${esc(presentation.threatLine)}</p></div>`
    + `<p class="wc-scene__hero">${esc(model.heroName)} enters ${esc(presentation.title)}</p>`
    + `<div class="wc-scene__actions wc-scene__actions--intro">`
    + `<button type="button" class="wc-scene__btn wc-scene__btn--primary" data-ui-action="intro-continue" data-focus-key="intro-continue">Continue</button>`
    + `<button type="button" class="wc-scene__btn wc-scene__btn--quiet" data-ui-action="intro-skip" data-focus-key="intro-skip">Skip</button>`
    + `</div></div></section>`;
}
