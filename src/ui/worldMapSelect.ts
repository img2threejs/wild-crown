/**
 * The existing illustrated map, native Pixi geographic inspection, and semantic menu controls.
 * The painting and progression gates are unchanged; the binder owns presentation and its async renderer.
 * Keyboard/gamepad selection remains with GameUI's existing focus navigation.
 */
import './map-select.css';
import { esc } from './markup.js';
import { icon } from './icons.js';
import { REGION_BY_PLAYTEST_ID, WORLD_REGION_SHAPES } from '../content/worldMapRegions.js';
import type { WorldRegionId, WorldRegionShape, WorldRegionStatus } from '../content/worldMapRegions.js';
import type { EryaMapController, EryaMapRegion } from './eryaWorldMap.js';
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

/** The status mark drawn in a region's pin: the survey icon set, never a letter. */
function statusPinIcon(status: WorldRegionStatus, map: PlaytestMapEntry): string {
  if (status === 'playable') return icon(map.cleared ? 'check' : 'pin');
  return icon('lock');
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
    : `<figure class="wc-map__thumb wc-map__thumb--placeholder"${map.mapArt ? ` style="background-size:${esc(map.mapArt.size)};background-position:${esc(map.mapArt.position)}"` : ''} role="img" aria-label="${esc(map.name)} on the map of Erya"></figure>`;
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
  const [cx, cy] = shape.chipPosition;
  // Native polygons own geographic hit areas; these markers retain semantic focus and selection.
  const pin = statusPinIcon(status, map);
  return `<button type="button" class="wc-map__region-btn" data-region="${shape.id}" data-map-id="${esc(map.id)}" ${action} ${focusability} ${statusAttr} ${selectedAttr} aria-label="${esc(ariaLabel)}" aria-pressed="${ariaPressed}" data-focus-key="map-region-${esc(map.id)}" style="--wc-map-cx:${cx.toFixed(2)}%;--wc-map-cy:${cy.toFixed(2)}%">
      <span class="wc-map__region-pin" aria-hidden="true">${pin}</span>
      <span class="wc-map__region-name" aria-hidden="true">${esc(map.name)}</span>
    </button>`;
}

/** Existing map screen and information panels; the native renderer is mounted by the binder. */
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
          <h1 class="wc-heading">Choose your path</h1>
          <p class="wc-meta">Follow the journey through Erya. Clear each map to open the next.</p>
        </header>
        <div class="wc-map__viewport">
          <img class="wc-map__art" src="${MAP_ART}" alt="Illustrated world map of Erya with named regions and Heartroot Hollow beneath the Grove">
          <div class="wc-map__canvas"></div>
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

/** Presentation-only inspection; no game dispatch or replacement of focused region buttons. */
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
  const byRegion = new Map<WorldRegionId, HTMLButtonElement>();
  for (const button of buttons) byRegion.set(button.dataset.region as WorldRegionId, button);
  let controller: EryaMapController | null = null;
  let hovered: WorldRegionId | null = null;
  let focused: WorldRegionId | null = null;
  let inspected: WorldRegionId | null = null;
  let disposed = false;
  const abort = new AbortController();
  const setInspect = (mapId: string, regionId: WorldRegionId): boolean => {
    if (options.resolveMap && !options.resolveMap(mapId)) return false;
    inspected = regionId;
    root.setAttribute('data-inspect-region', mapId);
    for (const [id, node] of bank) node.hidden = id !== mapId;
    for (const button of buttons) {
      if (button.dataset.region === regionId) button.setAttribute('data-active', 'true');
      else button.removeAttribute('data-active');
    }
    return true;
  };
  const present = (): void => {
    const region = hovered ?? focused;
    const button = region ? byRegion.get(region) : null;
    if (button && !setInspect(button.dataset.mapId!, region!)) return;
    controller?.inspect(inspected, region !== null);
  };
  const handlers: Array<() => void> = [];
  const attach = (button: HTMLButtonElement): void => {
    const mapId = button.dataset.mapId ?? '';
    if (!mapId) return;
    const region = button.dataset.region as WorldRegionId;
    const onEnter = (): void => { hovered = region; present(); };
    const onLeave = (): void => { if (hovered === region) hovered = null; present(); };
    const onFocus = (): void => { hovered = null; focused = region; present(); };
    const onBlur = (): void => { if (focused === region) focused = null; present(); };
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
  // First paint retains the selected region without pre-zooming the map.
  const initialButton = buttons.find(button => button.dataset.mapId === initialMapId);
  if (initialButton) setInspect(initialMapId, initialButton.dataset.region as WorldRegionId);
  const canvasHost = root.querySelector<HTMLElement>('.wc-map__canvas');
  const buttonsLayer = root.querySelector<HTMLElement>('.wc-map__buttons');
  if (canvasHost && buttonsLayer && doc.defaultView) {
    const entries: EryaMapRegion[] = [];
    for (const [id, button] of byRegion) entries.push({ shape: SHAPE_BY_ID[id], status: button.dataset.status as WorldRegionStatus });
    void import('./eryaWorldMap.js').then(module => {
      if (disposed) return null;
      return module.mountEryaWorldMap(canvasHost, buttonsLayer, entries, {
        hover(id) { hovered = id; present(); },
        activate(id) {
          const button = byRegion.get(id);
          button?.focus({ preventScroll: true });
          button?.click();
        },
      }, root.classList.contains('wc-state--static'), abort.signal);
    }).then(mounted => {
      if (!mounted) return;
      if (disposed) mounted.dispose();
      else { controller = mounted; present(); }
    }).catch(error => {
      if (disposed) return;
      const message = doc.createElement('p');
      message.className = 'wc-map__render-error';
      message.setAttribute('role', 'status');
      message.textContent = 'Interactive map unavailable. Use the region markers to choose a path.';
      canvasHost.parentElement!.after(message);
      console.error('Erya map renderer failed', error);
    });
  }
  return () => {
    if (disposed) return;
    disposed = true;
    abort.abort();
    controller?.dispose();
    for (const off of handlers) off();
    for (const node of bank.values()) {
      if (node !== initialPanel) node.remove();
    }
    bank.clear();
    byRegion.clear();
    initialPanel.hidden = false;
  };
}

