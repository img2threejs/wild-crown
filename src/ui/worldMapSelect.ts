/**
 * Interactive world map select: the Warden's illustrated survey of Erya.
 *
 * Replaces the previous card grid (`GameUI.ts:564-590 mapSelectState`) with one full-bleed painted map plus an SVG
 * overlay of clickable region polygons. The output is the inner body of a `.wc-state wc-selection` screen, so the
 * outer chrome (`containerScreen`, header copy, progress warning, Return to Title button) stays in GameUI; this
 * module owns the map art, the polygons, the side info panel and the spatial keyboard / gamepad navigation.
 *
 * The screen is intentionally reduced-motion aware: `.wc-state--static` (set by `GameUI` when `settings.reducedMotion`
 * is true) and `prefers-reduced-motion: reduce` both resolve to a static frame with no zoom transform, no shimmer and
 * no scanline pulse; spatial key navigation still works under reduced motion.
 *
 * The overlay also exposes `worldMapRegionOverlay` as a reusable export so the coordinator can later reuse the
 * polygons on the in-game World map (`GameUI.ts:704-719`).
 */
import './map-select.css';
import { esc } from './markup.js';
import { icon } from './icons.js';
import {
  LOCKED_COLOUR,
  REGION_BY_PLAYTEST_ID,
  ROUTE_COLOUR,
  SURVEY_ROUTE,
  WORLD_REGION_SHAPES,
  polygonArea,
  polygonBounds,
  type WorldRegionId,
  type WorldRegionShape,
  type WorldRegionStatus,
} from '../content/worldMapRegions.js';
import type { AssetPlaytestId } from '../app/AssetPlaytests.js';

const MAP_ART = '/ui/world-map-game.webp';

/** One entry of `viewModel.maps`; mirrors `GameViewModel['playtestSelection']['maps'][number]` but stays
 *  a plain interface that tests and the GameUI call site can build without the conditional chain. */
export interface WorldMapEntry {
  readonly id: string;
  readonly label: string;
  readonly name: string;
  readonly setting: string;
  readonly thumbnailUrl: string | null;
  readonly mapArt?: { readonly size: string; readonly position: string };
  readonly monsters: readonly string[];
  readonly comingSoon: boolean;
  readonly unlocked: boolean;
  readonly cleared: boolean;
}

/** The shape GameUI feeds into `worldMapSelectMarkup`. Mirrors `GameViewModel['playtestSelection']` minus
 *  the `heroId` and `nextMapId` fields the map doesn't need. */
export interface WorldMapSelectViewModel {
  readonly maps: readonly WorldMapEntry[];
  readonly selectedMapId: string;
  readonly reducedMotion: boolean;
}

/** Coordinates of every region in viewport percent. The order matches `WORLD_REGION_SHAPES`. */
const SHAPE_BY_ID: Readonly<Record<WorldRegionId, WorldRegionShape>> = (() => {
  const out: Record<WorldRegionId, WorldRegionShape> = {} as Record<WorldRegionId, WorldRegionShape>;
  for (const shape of WORLD_REGION_SHAPES) out[shape.id] = shape;
  return Object.freeze(out);
})();

/** Status classifier: Coming Soon wins for chapters without a playable map, otherwise Locked until the player
 *  has cleared the previous map. Cleared worlds map in the same playable group as Open. */
function statusFor(map: PlaytestMapEntry): WorldRegionStatus {
  if (map.comingSoon) return 'coming-soon';
  if (map.cleared || map.unlocked) return 'playable';
  return 'locked';
}

/** Find the matching `WorldRegionShape` for a map entry: either by playtest id (no-op) or by name when the
 *  chapter has no playtest (Coming Soon entries). */
function shapeFor(map: PlaytestMapEntry): WorldRegionShape | null {
  if (map.comingSoon) {
    // Coming-soon cards match by name slug; StoryChapters labels are 'Whispering Canopy', 'Blood Bamboo Valley'…
    const slug = map.name.toLowerCase().replace(/[^a-z]+/g, '-').replace(/(^-|-$)/g, '') as WorldRegionId;
    return SHAPE_BY_ID[slug] ?? null;
  }
  const playtest = map.id as AssetPlaytestId;
  return SHAPE_BY_ID[REGION_BY_PLAYTEST_ID[playtest]] ?? null;
}

type PlaytestMapEntry = WorldMapSelectViewModel['maps'][number];

/** SVG polygon `points` attribute string from a 0–100 polygon. */
function polygonPoints(polygon: ReadonlyArray<readonly [number, number]>): string {
  return polygon.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
}

/** Stroke colour a region renders with: route colour for playable, neutral for locked/coming-soon. */
const strokeFor = (status: WorldRegionStatus): string => status === 'playable' ? ROUTE_COLOUR : LOCKED_COLOUR;

/** Fill colour (rgba) for the hovered region: route colour for playable, neutral ink for the rest. */
const fillFor = (status: WorldRegionStatus, alpha: number): string => {
  if (status === 'playable') return `rgba(168, 23, 79, ${alpha.toFixed(2)})`;
  if (status === 'coming-soon') return `rgba(140, 90, 43, ${alpha.toFixed(2)})`;
  return `rgba(100, 95, 78, ${alpha.toFixed(2)})`;
};

/** The status mark drawn in a region's pin: the survey icon set, never a letter. */
function statusPinIcon(status: WorldRegionStatus, map: PlaytestMapEntry): string {
  if (status === 'playable') return icon(map.cleared ? 'check' : 'pin');
  return icon('lock');
}

/** The dashed survey route across the journey order, connecting region centres. */
function surveyRouteMarkup(): string {
  const byId = SHAPE_BY_ID;
  const points = SURVEY_ROUTE
    .map(id => byId[id])
    .filter((shape): shape is WorldRegionShape => Boolean(shape))
    .map(shape => shape.centre);
  if (points.length < 2) return '';
  return `<path class="wc-map__route" d="${points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ')}" aria-hidden="true" />`;
}

/**
 * Reusable SVG overlay: an `aspect-ratio: 8 / 5` viewBox with one polygon per region, the dashed survey route and
 * the painted map's locked regions. The overlay is purely presentation — hover/focus styling lives in the consuming
 * screen, so the same shapes can be reused on the in-game World map later.
 */
export function worldMapRegionOverlay(): string {
  const polygons = WORLD_REGION_SHAPES
    .map(shape => `<polygon class="wc-map__region" data-region="${shape.id}" points="${polygonPoints(shape.polygon)}" />`)
    .join('');
  return `<svg class="wc-map__overlay" viewBox="0 0 100 62.5" preserveAspectRatio="none" aria-hidden="true" focusable="false">`
    + `<g class="wc-map__routes">${surveyRouteMarkup()}</g>`
    + `<g class="wc-map__shapes">${polygons}</g>`
    + `</svg>`;
}

/** Find the spatially nearest region in `direction` from `currentId`; ties broken by smaller angular offset. */
export function pickSpatialNeighbour(currentId: WorldRegionId, direction: 'up' | 'down' | 'left' | 'right'): WorldRegionId {
  const current = SHAPE_BY_ID[currentId];
  if (!current) return currentId;
  const [cx, cy] = current.centre;
  let bestId: WorldRegionId = currentId;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const shape of WORLD_REGION_SHAPES) {
    if (shape.id === currentId) continue;
    const [x, y] = shape.centre;
    const dx = x - cx;
    const dy = y - cy;
    let aligned = 0;
    let cross = 0;
    if (direction === 'left') { aligned = -dx; cross = dy; }
    else if (direction === 'right') { aligned = dx; cross = dy; }
    else if (direction === 'up') { aligned = -dy; cross = dx; }
    else { aligned = dy; cross = dx; }
    if (aligned <= 0) continue;
    // Score is the squared tangent: `(cross/aligned)²`. The on-axis neighbour (cross ≈ 0) always wins over an
    // off-axis one (cross large). Ties broken by smaller distance. This matches the visual arrow-key expectation:
    // "down" from the Grove goes to the painted region directly below it, even if it's farther away than a
    // diagonal neighbour.
    const tangent = cross / aligned;
    const score = tangent * tangent * 1e6 + (dx * dx + dy * dy);
    if (score < bestScore) { bestScore = score; bestId = shape.id; }
  }
  return bestId;
}

/** Status label: Open / Cleared / Locked: reason / Coming soon. */
function statusLabel(map: PlaytestMapEntry, previous: PlaytestMapEntry | undefined): { tone: 'open' | 'cleared' | 'locked' | 'soon'; text: string } {
  if (map.comingSoon) return { tone: 'soon', text: 'Coming soon' };
  if (map.cleared) return { tone: 'cleared', text: 'Cleared' };
  if (map.unlocked) return { tone: 'open', text: 'Open' };
  return { tone: 'locked', text: `Locked: Clear ${previous?.name ?? 'the previous map'} first` };
}

/** The info-panel markup for a single region: chapter label, region name, tagline, status, monsters and Enter. */
function infoPanelMarkup(map: PlaytestMapEntry, previous: PlaytestMapEntry | undefined): string {
  const status = statusLabel(map, previous);
  const monsterList = map.monsters.length ? `<ul class="wc-map__monsters">${map.monsters.map(monster => `<li>${esc(monster)}</li>`).join('')}</ul>` : `<p class="wc-map__monsters-empty">No encounters listed.</p>`;
  const thumbnail = map.thumbnailUrl
    ? `<figure class="wc-map__thumb" style="background-image:url('${esc(map.thumbnailUrl)}')" role="img" aria-label="${esc(map.name)} illustration"></figure>`
    : `<figure class="wc-map__thumb wc-map__thumb--placeholder" role="img" aria-label="${esc(map.name)} on the map of Erya"></figure>`;
  const playable = !map.comingSoon && (map.unlocked || map.cleared);
  const actionAttrs = playable
    ? `data-ui-action="select-map" data-map="${esc(map.id)}"`
    : 'aria-disabled="true"';
  const actionLabel = map.cleared ? `Replay ${map.name}` : `Enter ${map.name}`;
  const actionClass = playable ? 'wc-action wc-action--primary wc-map__enter' : 'wc-action wc-action--quiet wc-map__enter';
  const encounters = map.comingSoon
    ? `<p class="wc-map__monsters-empty">Encounters revealed when the chapter opens.</p>`
    : monsterList;
  return `<section class="wc-map__panel wc-sheet" data-region="${esc(map.id)}" aria-labelledby="wc-map-panel-${esc(map.id)}">
    <header class="wc-sheet__head">
      <p class="wc-map__chapter"><span>${esc(map.label)}</span></p>
      <h2 id="wc-map-panel-${esc(map.id)}" class="wc-map__name">${esc(map.name)}</h2>
      <span class="wc-tag" data-tone="${status.tone}">${esc(status.text)}</span>
    </header>
    ${thumbnail}
    <p class="wc-map__setting wc-lore">${esc(map.setting)}</p>
    <h3 class="wc-label">Encounters</h3>
    ${encounters}
    <div class="wc-actions">
      <button type="button" class="${actionClass}" ${actionAttrs} data-focus-key="map-enter-${esc(map.id)}" aria-disabled="${playable ? 'false' : 'true'}">${esc(actionLabel)}</button>
      <button type="button" class="wc-action wc-action--quiet wc-map__return" data-ui-action="return-title" data-focus-key="return-title">Return to Title</button>
    </div>
  </section>`;
}

/** Build the per-region button used over the SVG overlay. Locked regions stay focusable (aria-disabled) so
 *  the player can inspect them; the click/Enter path stays gated by `data-ui-action` only being set on
 *  playable buttons. */
function regionButtonMarkup(map: PlaytestMapEntry, status: WorldRegionStatus, shape: WorldRegionShape, previous: PlaytestMapEntry | undefined, viewModel: WorldMapSelectViewModel): string {
  const playable = !map.comingSoon && (map.unlocked || map.cleared);
  const action = playable
    ? `data-ui-action="select-map" data-map="${esc(map.id)}"`
    : '';
  // Locked/coming-soon regions stay focusable so hover and keyboard focus can highlight and inspect them.
  const focusability = playable
    ? ''
    : 'aria-disabled="true"';
  const ariaLabel = `${map.name}, ${map.label}: ${status === 'playable' ? (map.cleared ? 'Cleared' : 'Open') : status === 'locked' ? `Locked: Clear ${previous?.name ?? 'the previous map'} first` : 'Coming soon'}`;
  const ariaPressed = map.id === viewModel.selectedMapId ? 'true' : 'false';
  const statusAttr = `data-status="${status}"`;
  const selectedAttr = map.id === viewModel.selectedMapId ? 'data-selected="true"' : '';
  const area = polygonArea(shape.polygon).toFixed(1);
  const bounds = polygonBounds(shape.polygon);
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  const stroke = strokeFor(status);
  const fill = fillFor(status, 0.18);
  // The button itself sits over the polygon so screen readers and pointer events work; the SVG polygon
  // provides the visual fill, stroke and hatch. A small status pin (survey icon) is always visible so the
  // player can scan the map at a glance; the full painted name only renders on the hovered/focused/
  // selected region so we never duplicate the names already painted on the illustration.
  const pin = statusPinIcon(status, map);
  return `<button type="button" class="wc-map__region-btn" data-region="${shape.id}" data-map-id="${esc(map.id)}" ${action} ${focusability} ${statusAttr} ${selectedAttr} aria-label="${esc(ariaLabel)}" aria-pressed="${ariaPressed}" data-focus-key="map-region-${esc(map.id)}" style="--wc-map-fill:${fill};--wc-map-stroke:${stroke};--wc-map-cx:${cx.toFixed(2)}%;--wc-map-cy:${cy.toFixed(2)}%;--wc-map-area:${area}%">
      <span class="wc-map__region-pin" aria-hidden="true">${pin}</span>
      <span class="wc-map__region-name" aria-hidden="true">${esc(map.name)}</span>
    </button>`;
}

/** The full screen body: map art, SVG overlay with polygons, region buttons, info panel for the selected map. */
export function worldMapSelectMarkup(viewModel: WorldMapSelectViewModel): string {
  const selected = viewModel.maps.find(map => map.id === viewModel.selectedMapId) ?? viewModel.maps[0];
  if (!selected) return '';
  const staticClass = viewModel.reducedMotion ? ' wc-state--static' : '';
  // Map entries by their inferred WorldRegionId so the panel sits next to its polygon.
  const playable = viewModel.maps.filter(map => !map.comingSoon);
  const regionMarkup = viewModel.maps.map((map) => {
    const shape = shapeFor(map);
    if (!shape) return '';
    const status = statusFor(map);
    const previous = playable[playable.indexOf(map) - 1];
    return regionButtonMarkup(map, status, shape, previous, viewModel);
  }).join('');
  // Side panel always describes the currently inspected region. The default inspection is the selected map
  // (so the screen reads as "you've already chosen this one"). `bindWorldMapSelect` updates `data-inspect-region`
  // on hover/focus/Enter so the same panel markup drives inspection locally.
  const playableSelected = viewModel.maps.find(map => map.id === viewModel.selectedMapId && !map.comingSoon);
  const infoSubject = playableSelected ?? selected;
  const previous = playable[playable.indexOf(infoSubject)] ? playable[playable.indexOf(infoSubject) - 1] : undefined;
  const panelMarkup = infoPanelMarkup(infoSubject, previous);
  return `<section class="wc-state wc-selection wc-map${staticClass}" data-screen="map-select" data-inspect-region="${esc(infoSubject.id)}">
    <div class="wc-map__layout">
      <section class="wc-map__stage wc-sheet" aria-label="Illustrated world map of Erya with regions">
        <header class="wc-sheet__head">
          <p class="wc-label">The Warden's survey</p>
          <h1 class="wc-heading">Choose your path</h1>
          <p class="wc-meta">Follow the journey through Erya. Clear each map to open the next.</p>
        </header>
        <div class="wc-map__viewport" style="--wc-map-zoom:1">
          <img class="wc-map__art" src="${MAP_ART}" alt="Illustrated world map of Erya with named regions and Heartroot Hollow beneath the Grove">
          <svg class="wc-map__overlay wc-map__overlay--interactive" viewBox="0 0 100 62.5" preserveAspectRatio="none" aria-hidden="true" focusable="false">
            <defs>
              <pattern id="wc-map-hatch" width="2.4" height="2.4" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
                <line x1="0" y1="0" x2="0" y2="2.4" stroke="rgba(30, 35, 27, 0.45)" stroke-width="0.4" />
              </pattern>
            </defs>
            <g class="wc-map__routes">${surveyRouteMarkup()}</g>
            <g class="wc-map__shapes">${WORLD_REGION_SHAPES.map(shape => {
              const matching = viewModel.maps.find(map => shapeFor(map)?.id === shape.id);
              const status: WorldRegionStatus = matching ? statusFor(matching) : 'coming-soon';
              return `<polygon class="wc-map__shape" data-region="${shape.id}" data-status="${status}" points="${polygonPoints(shape.polygon)}" />`;
            }).join('')}</g>
            <g class="wc-map__lock-icons">${WORLD_REGION_SHAPES.map(shape => {
              const [x, y] = shape.centre;
              return `<g class="wc-map__lock" data-region="${shape.id}" transform="translate(${x.toFixed(2)},${y.toFixed(2)})" aria-hidden="true">${icon('lock')}</g>`;
            }).join('')}</g>
          </svg>
          <div class="wc-map__buttons">${regionMarkup}</div>
        </div>
        <ul class="wc-legend wc-map__legend" aria-label="Map legend">
          <li data-kind="open">${icon('pin')}Open</li>
          <li data-kind="cleared">${icon('check')}Cleared</li>
          <li data-kind="locked">${icon('lock')}Locked</li>
          <li data-kind="soon"><i></i>Coming soon</li>
        </ul>
      </section>
      ${panelMarkup}
    </div>
    <div class="wc-map__footer">
      <p class="wc-meta">Arrow keys / D-pad move between regions · Enter selects · Tap or focus to inspect</p>
    </div>
  </section>`;
}

/** One side-panel markup per map id, for `bindWorldMapSelect` to swap in place on hover/focus. */
export function worldMapPanels(viewModel: WorldMapSelectViewModel): Record<string, string> {
  const playable = viewModel.maps.filter(map => !map.comingSoon);
  const panels: Record<string, string> = {};
  for (const map of viewModel.maps) panels[map.id] = infoPanelMarkup(map, playable[playable.indexOf(map) - 1]);
  return panels;
}

/**
 * Wires UI-local hover/focus/inspection behaviour to the rendered map select screen. This is a presentation-only
 * binder: it does not dispatch any game action, it does not re-render the screen, and it only swaps the side
 * info panel markup by cloning the pre-rendered panels and toggling their visibility, plus a per-button
 * `data-active` flag for the highlight.
 *
 * On mount the binder expects a single visible panel whose markup matches the selected map; to support
 * inspecting any region (including locked/coming-soon), the binder clones every region's panel into an
 * internal template bank so the same DOM nodes can be swapped in place. Existing focus on buttons survives
 * because the binder never replaces the buttons.
 *
 * The caller passes a `panels` map keyed by `mapId`; the markup of one such panel is the same as
 * `infoPanelMarkup(map, previous)`. When the caller cannot supply a panel for a map (e.g. the playable list
 * is empty for that map id), the binder falls back to whatever the current root renders.
 *
 * @returns A teardown function that removes all listeners and clears the panel bank.
 */
export interface WorldMapBindOptions {
  /** All panels keyed by map id. The binder keeps one node per map in a hidden bank and shows the
   *  matching one. The map id strings are exactly the values of `data-map-id` on the region buttons. */
  readonly panels: Readonly<Record<string, string>>;
  /** Initial map id to show; defaults to whatever the root currently advertises via `data-inspect-region`. */
  readonly initialMapId?: string;
  /** Optional filter: when set, the binder only inspects ids the resolver accepts (used to gate hidden maps). */
  readonly resolveMap?: (mapId: string) => { id: string; playable: boolean } | null;
}

/** The shape consumed by GameUI's mount flow. Exposed for the test as well. */
export function bindWorldMapSelect(screenRoot: HTMLElement, options: WorldMapBindOptions): () => void {
  const root = screenRoot.querySelector<HTMLElement>('[data-screen="map-select"]');
  if (!root) return () => {};
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('.wc-map__region-btn')];
  const initialPanel = root.querySelector<HTMLElement>('.wc-map__panel');
  if (!buttons.length || !initialPanel) return () => {};
  // Build the panel bank: one HTMLElement per map id, all hidden except the initial one. We use the
  // initial panel's own `ownerDocument` so the binder works in the browser, in jsdom and in tests that
  // shim `document` (a custom minimal shim can supply `createElement` via a passed factory).
  const doc = root.ownerDocument;
  if (!doc) return () => {};
  const bank = new Map<string, HTMLElement>();
  const register = (mapId: string, html: string, visible: boolean): HTMLElement | null => {
    if (!html) return null;
    const tpl = doc.createElement('template');
    tpl.innerHTML = html.trim();
    const node = tpl.content.firstElementChild as HTMLElement | null;
    if (!node) return null;
    node.dataset.regionPanel = mapId;
    node.hidden = !visible;
    initialPanel.parentElement?.appendChild(node);
    bank.set(mapId, node);
    return node;
  };
  // Stash the initial visible panel under its map id (the markup already labels it with data-region).
  const initialMapId = options.initialMapId
    ?? initialPanel.dataset.region
    ?? root.getAttribute('data-inspect-region')
    ?? '';
  if (initialMapId) {
    initialPanel.dataset.regionPanel = initialMapId;
    bank.set(initialMapId, initialPanel);
  }
  for (const [mapId, html] of Object.entries(options.panels)) {
    if (bank.has(mapId)) continue;
    register(mapId, html, false);
  }
  const shapes = [...root.querySelectorAll<SVGElement>('.wc-map__shape')];
  const setInspect = (mapId: string, regionId: string | undefined): void => {
    if (options.resolveMap && !options.resolveMap(mapId)) return;
    root.setAttribute('data-inspect-region', mapId);
    for (const [id, node] of bank) node.hidden = id !== mapId;
    // The painted land mass of the inspected region lights up; the others dim through the root attribute.
    for (const shape of shapes) {
      if (shape.getAttribute('data-region') === regionId) shape.setAttribute('data-active', 'true');
      else shape.removeAttribute('data-active');
    }
  };
  const setActive = (button: HTMLButtonElement, active: boolean): void => {
    if (active) button.setAttribute('data-active', 'true');
    else button.removeAttribute('data-active');
  };
  const handlers: Array<() => void> = [];
  const attach = (button: HTMLButtonElement): void => {
    const mapId = button.dataset.mapId ?? '';
    if (!mapId) return;
    const onEnter = (): void => { setActive(button, true); setInspect(mapId, button.dataset.region); };
    const onLeave = (): void => { setActive(button, false); };
    const onFocus = (): void => { setActive(button, true); setInspect(mapId, button.dataset.region); };
    const onBlur = (): void => { setActive(button, false); };
    button.addEventListener('mouseenter', onEnter);
    button.addEventListener('mouseleave', onLeave);
    button.addEventListener('focus', onFocus);
    button.addEventListener('blur', onBlur);
    handlers.push(() => button.removeEventListener('mouseenter', onEnter));
    handlers.push(() => button.removeEventListener('mouseleave', onLeave));
    handlers.push(() => button.removeEventListener('focus', onFocus));
    handlers.push(() => button.removeEventListener('blur', onBlur));
  };
  buttons.forEach(attach);
  // First paint: the inspected (selected) region is already lit.
  const initialButton = buttons.find(button => button.dataset.mapId === initialMapId);
  if (initialButton) setInspect(initialMapId, initialButton.dataset.region);
  return () => {
    for (const off of handlers) off();
    for (const node of bank.values()) {
      if (node !== initialPanel) node.remove();
    }
    bank.clear();
  };
}

// Re-export region helpers and shapes so consumers (notably the deterministic test) can import the whole surface
// from this module without reaching into the content module.
export { WORLD_REGION_SHAPES, SURVEY_ROUTE, isClosedPolygon, polygonsOverlap, polygonArea, polygonBounds } from '../content/worldMapRegions.js';
