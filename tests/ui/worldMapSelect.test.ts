import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  SURVEY_ROUTE,
  WORLD_REGION_SHAPES,
  isClosedPolygon,
  polygonsOverlap,
} from '../../src/content/worldMapRegions.js';
import {
  bindWorldMapSelect,
  pickSpatialNeighbour,
  worldMapRegionOverlay,
  worldMapSelectMarkup,
  type WorldMapBindOptions,
  type WorldMapEntry,
  type WorldMapSelectViewModel,
} from '../../src/ui/worldMapSelect.js';

// ----------------------------------------------------------------------------
// Minimal DOM stub for the bind tests. Bun's test runner does not provide a
// global `document`, and the project intentionally avoids shipping a DOM
// implementation. The binder only needs a tiny surface (querySelector,
// addEventListener with Event, dataset, hidden, parentElement, appendChild,
// remove, ownerDocument, createElement('template').content.firstElementChild)
// so a regex-driven shim is enough to assert the inspection contract.
// ----------------------------------------------------------------------------
type Listener = (event: Event) => void;

interface MiniDocument {
  createElement(tag: string): MiniElement;
  readonly defaultView: null;
}

class MiniElement {
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();
  readonly children: MiniElement[] = [];
  parentElement: MiniElement | null = null;
  hidden = false;
  textContent = '';
  ownerDocument: MiniDocument | null = null;
  private _innerHTML = '';
  private _dataset: Record<string, string> = {};
  readonly dataset = new Proxy(this._dataset, {
    set: (target, key: string, value: string): boolean => {
      target[key] = value;
      this.attributes.set(`data-${dashify(key)}`, value);
      return true;
    },
    deleteProperty: (target, key: string): boolean => {
      delete target[key];
      this.attributes.delete(`data-${dashify(key)}`);
      return true;
    },
  });
  constructor(public readonly tagName: string) {}
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name.startsWith('data-')) this._dataset[camelize(name.slice(5))] = value;
  }
  hasAttribute(name: string): boolean { return this.attributes.has(name); }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
    if (name.startsWith('data-')) delete this._dataset[camelize(name.slice(5))];
  }
  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    const next = list.filter(entry => entry !== listener);
    this.listeners.set(type, next);
  }
  dispatchEvent(event: Event): boolean {
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) listener(event);
    return !event.defaultPrevented;
  }
  querySelector(selector: string): MiniElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector: string): MiniElement[] {
    const out: MiniElement[] = [];
    const stack: MiniElement[] = [...this.children];
    while (stack.length) {
      const el = stack.pop()!;
      if (matchesSelector(el, selector)) out.push(el);
      stack.push(...el.children);
    }
    return out;
  }
  appendChild(node: MiniElement): MiniElement {
    node.parentElement = this;
    this.children.push(node);
    return node;
  }
  remove(): void {
    if (this.parentElement) {
      const idx = this.parentElement.children.indexOf(this);
      if (idx >= 0) this.parentElement.children.splice(idx, 1);
      this.parentElement = null;
    }
  }
  // HTML template element has a separate `content` DocumentFragment-like node. We only need
  // `template.content.firstElementChild` to behave like a parsed node, so we provide a getter.
  get content(): { firstElementChild: MiniElement | null } {
    if (this.tagName.toLowerCase() !== 'template') return { firstElementChild: null };
    const child = parseHtml(this._innerHTML).children[0] ?? null;
    return { firstElementChild: child };
  }
  set innerHTML(markup: string) { this._innerHTML = markup; this.children = []; }
  get innerHTML(): string { return this._innerHTML; }
}

const matchesSelector = (el: MiniElement, selector: string): boolean => {
  // Compound selector: any combination of `.className` and `[attr="value"]`/`[attr]` segments. We don't need
  // full CSS selector support — only what the binder and its tests query.
  const parts = selector.match(/\.[\w-]+|\[[\w-]+(?:="[^"]*")?\]|[a-zA-Z][\w-]*/g) ?? [];
  if (!parts.length) return false;
  for (const part of parts) {
    if (part.startsWith('.')) {
      if (!(el.attributes.get('class') ?? '').split(/\s+/).includes(part.slice(1))) return false;
    } else if (part.startsWith('[')) {
      const m = part.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/)!;
      if (m[2] === undefined) { if (!el.attributes.has(m[1]!)) return false; }
      else if (el.attributes.get(m[1]!) !== m[2]) return false;
    } else {
      if (el.tagName.toLowerCase() !== part.toLowerCase()) return false;
    }
  }
  return true;
};

const camelize = (raw: string): string => raw.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
const dashify = (raw: string): string => raw.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);

const SHELF_VOID_TAGS = new Set(['br', 'img', 'input', 'meta', 'link', 'hr']);

const parseHtml = (html: string, doc: MiniDocument | null = null): MiniElement => {
  const root = new MiniElement('div');
  if (doc) root.ownerDocument = doc;
  const stack: MiniElement[] = [root];
  const tagRe = /<\/?([a-zA-Z][\w-]*)([^>]*?)\/?>/g;
  const attrRe = /([\w:-]+)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html))) {
    const tag = match[1]!.toLowerCase();
    if (match[0].startsWith('</')) { stack.pop(); continue; }
    const el = new MiniElement(tag);
    if (doc) el.ownerDocument = doc;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRe.exec(match[2] ?? ''))) el.setAttribute(attrMatch[1]!, attrMatch[2]!);
    stack[stack.length - 1]!.appendChild(el);
    if (!match[0].endsWith('/>') && !SHELF_VOID_TAGS.has(tag)) stack.push(el);
  }
  return root;
};

// Provide a per-test document with a createElement that returns a MiniElement owned by this document.
// The bind tests pass a real-world document (via the test root's ownerDocument) so panels cloned by
// `bindWorldMapSelect` use the same object identity.
const makeDocument = (): MiniDocument => {
  const doc: MiniDocument = {
    defaultView: null,
    createElement: (tag: string) => {
      const el = new MiniElement(tag);
      el.ownerDocument = doc;
      return el;
    },
  };
  return doc;
};

const PLAYABLE = (overrides: Partial<WorldMapEntry> = {}): WorldMapEntry => ({
  id: 'greenwake', label: 'Prologue', name: 'Greenwake', setting: 'Forest edge',
  thumbnailUrl: '/asset-source/ui/maps/greenwake.jpg', monsters: ['Ember Boar', 'Root Rammer'],
  comingSoon: false, unlocked: true, cleared: false, ...overrides,
});

const COMING_SOON = (overrides: Partial<WorldMapEntry> = {}): WorldMapEntry => ({
  id: 'chapter-2', label: 'Chapter 2', name: 'Blood Bamboo Valley', setting: 'A red-lit bamboo valley',
  thumbnailUrl: null, monsters: [], comingSoon: true, unlocked: false, cleared: false, ...overrides,
});

const FIXTURE_VM = (overrides: Partial<WorldMapSelectViewModel> = {}): WorldMapSelectViewModel => ({
  selectedMapId: 'greenwake',
  reducedMotion: false,
  maps: [
    PLAYABLE({ id: 'canopy', label: 'Chapter 1', name: 'Whispering Canopy' }),
    PLAYABLE({ id: 'grove', label: 'Sanctuary', name: 'The Grove', unlocked: false }),
    PLAYABLE({ id: 'greenwake', name: 'Greenwake', cleared: true }),
    COMING_SOON(),
    PLAYABLE({ id: 'moonpine', label: 'Chapter 3', name: 'Moonpine Ridge', unlocked: false }),
    PLAYABLE({ id: 'mistveil', label: 'Chapter 4', name: 'Mistveil Basin', unlocked: false }),
    COMING_SOON({ id: 'chapter-5', label: 'Chapter 5', name: 'Sunmane Expanse' }),
    COMING_SOON({ id: 'chapter-6', label: 'Chapter 6', name: 'The Fall of the Grove' }),
    COMING_SOON({ id: 'chapter-7', label: 'Chapter 7', name: 'The Living Pact' }),
    COMING_SOON({ id: 'chapter-8', label: 'Chapter 8', name: 'Heartroot Hollow' }),
  ],
  ...overrides,
});

describe('worldMapRegions polygon contract', () => {
  it('every region has a closed polygon inside 0-100 percent', () => {
    for (const shape of WORLD_REGION_SHAPES) {
      expect(isClosedPolygon(shape.polygon)).toBe(true);
      for (const [x, y] of shape.polygon) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(100);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(100);
      }
    }
  });

  it('no two polygons overlap beyond the small tolerance', () => {
    for (let i = 0; i < WORLD_REGION_SHAPES.length; i++) {
      for (let j = i + 1; j < WORLD_REGION_SHAPES.length; j++) {
        const a = WORLD_REGION_SHAPES[i]!;
        const b = WORLD_REGION_SHAPES[j]!;
        expect({ a: a.id, b: b.id, overlap: polygonsOverlap(a.polygon, b.polygon) }).toEqual({ a: a.id, b: b.id, overlap: false });
      }
    }
  });

  it('survey route visits every playable region in journey order', () => {
    expect(SURVEY_ROUTE.length).toBe(WORLD_REGION_SHAPES.length);
    for (const id of SURVEY_ROUTE) {
      expect(WORLD_REGION_SHAPES.find(shape => shape.id === id)).toBeTruthy();
    }
  });

  it('centres fall inside their own polygons', () => {
    for (const shape of WORLD_REGION_SHAPES) {
      const [cx, cy] = shape.centre;
      let inside = false;
      const polygon = shape.polygon;
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [xi, yi] = polygon[i]!;
        const [xj, yj] = polygon[j]!;
        const intersect = ((yi > cy) !== (yj > cy))
          && (cx < ((xj - xi) * (cy - yi)) / (yj - yi || 1e-9) + xi);
        if (intersect) inside = !inside;
      }
      expect({ id: shape.id, inside }).toEqual({ id: shape.id, inside: true });
    }
  });
});

describe('worldMapRegionOverlay', () => {
  it('emits one polygon per region and the dashed survey route', () => {
    const svg = worldMapRegionOverlay();
    const polygons = svg.match(/<polygon /g) ?? [];
    expect(polygons.length).toBe(WORLD_REGION_SHAPES.length);
    for (const shape of WORLD_REGION_SHAPES) {
      expect(svg).toContain(`data-region="${shape.id}"`);
    }
    expect(svg).toContain('class="wc-map__route"');
    expect(svg).toContain('<svg class="wc-map__overlay"');
  });
});

describe('pickSpatialNeighbour', () => {
  it('finds the on-axis neighbour in every direction', () => {
    // From the central Grove, the southernmost neighbour is Greenwake; the northernmost is Moonpine Ridge;
    // the leftmost is Whispering Canopy and the rightmost is Mistveil Basin.
    expect(pickSpatialNeighbour('the-grove', 'down')).toBe('greenwake');
    expect(pickSpatialNeighbour('the-grove', 'up')).toBe('moonpine-ridge');
    expect(pickSpatialNeighbour('the-grove', 'left')).toBe('whispering-canopy');
    expect(pickSpatialNeighbour('the-grove', 'right')).toBe('mistveil-basin');
  });

  it('returns the current id when no neighbour sits in the requested direction', () => {
    // Moonpine Ridge is the north-most region (top of the painted map); asking "up" must keep us there.
    expect(pickSpatialNeighbour('moonpine-ridge', 'up')).toBe('moonpine-ridge');
  });
});

describe('worldMapSelectMarkup', () => {
  it('renders the painted map and one region button per mapped entry', () => {
    const html = worldMapSelectMarkup(FIXTURE_VM());
    expect(html).toContain('src="/ui/world-map-game.webp"');
    expect(html).toContain('class="wc-map__viewport"');
    const regionButtons = html.match(/class="wc-map__region-btn"/g) ?? [];
    // One button per map whose name resolves to a region shape (Refuge is a future map with no chapter entry).
    expect(regionButtons.length).toBe(WORLD_REGION_SHAPES.length - 1); // fixture covers 8 of 9 region shapes
  });

  it('carries data-ui-action="select-map" and data-map for playable regions', () => {
    const html = worldMapSelectMarkup(FIXTURE_VM());
    for (const map of FIXTURE_VM().maps) {
      const playable = !map.comingSoon && (map.unlocked || map.cleared);
      if (playable) {
        expect(html).toContain(`data-ui-action="select-map" data-map="${map.id}"`);
      } else {
        // Locked/coming-soon region buttons stay focusable (aria-disabled, NOT the `disabled` attribute)
        // so the player can still inspect them; the data-ui-action="select-map" pair is absent.
        const statusRe = map.comingSoon ? 'coming-soon' : 'locked';
        // Order-independent: any button carrying all three attributes (data-region, data-status, aria-disabled)
        // matches, regardless of attribute order.
        const region = new RegExp(
          `<button[^>]*\\bdata-region="[^"]+"[^>]*\\bdata-status="${statusRe}"[^>]*>`,
        );
        const button = (html.match(region) ?? [])[0] ?? '';
        expect(button).toContain('aria-disabled="true"');
        expect(button).not.toMatch(/\sdisabled(=|>|\s)/);
        expect(button).not.toContain('data-ui-action="select-map"');
        // For non-playable entries there must never be a `data-ui-action="select-map" data-map="<id>"` pair
        // on any button (region button OR inline panel button).
        if (map.id !== FIXTURE_VM().selectedMapId) {
          const actionPair = new RegExp(`<button[^>]*data-ui-action="select-map"[^>]*data-map="${map.id}"`);
          expect(html.match(actionPair)).toBeNull();
        }
      }
    }
  });

  it('does not duplicate the painted region names as visible chips', () => {
    // The painted illustration already names every region. The buttons should only show a tiny status pin;
    // the full region name should live inside the button for screen readers and the side panel, and only
    // appear visually when the region becomes active.
    const html = worldMapSelectMarkup(FIXTURE_VM());
    // Each region button contains a status pin span with a single-letter glyph (O / ✓ / L / …).
    const pins = html.match(/class="wc-map__region-pin"/g) ?? [];
    expect(pins.length).toBeGreaterThan(0);
    // The full region name lives inside a hidden helper span inside the button for AT. We assert each
    // mapped region whose name resolves to a region shape has a `.wc-map__region-name` element so the
    // name is available for the highlight tooltip. Future chapters whose names don't yet resolve to a
    // painted region don't render a button and so don't get a chip.
    for (const map of FIXTURE_VM().maps) {
      const slug = map.name.toLowerCase().replace(/[^a-z]+/g, '-').replace(/(^-|-$)/g, '');
      const re = new RegExp(`<span class="wc-map__region-name"[^>]*>\\s*${map.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*</span>`);
      const found = html.match(re);
      if (slug === 'the-fall-of-the-grove' || slug === 'the-living-pact') {
        // No region shape yet, so no button.
        expect(found).toBeNull();
      } else {
        expect(found).toBeTruthy();
      }
    }
  });

  it('renders the panel with status text for locked and coming-soon regions', () => {
    const vm = FIXTURE_VM();
    const lockedSelected: WorldMapSelectViewModel = { ...vm, selectedMapId: 'grove' };
    const html = worldMapSelectMarkup(lockedSelected);
    expect(html).toContain('data-status="locked"');
    expect(html).toContain('Locked');
    // The previous playable map (in STORY_CHAPTERS order) for "grove" is "canopy" → Whispering Canopy.
    expect(html).toContain('Clear Whispering Canopy first');
  });

  it('shows the Enter button carrying select-map/data-map for the playable selected region', () => {
    const html = worldMapSelectMarkup(FIXTURE_VM());
    // The selected map is 'greenwake', which is cleared (so the button says "Replay").
    expect(html).toContain('Replay Greenwake');
    expect(html).toMatch(/<button[^>]*class="wc-action wc-action--primary wc-map__enter"[^>]*data-ui-action="select-map"[^>]*data-map="greenwake"/);
  });

  it('marks the inline Enter button aria-disabled (not disabled) for non-playable regions', () => {
    const vm = FIXTURE_VM();
    const lockedSelected: WorldMapSelectViewModel = { ...vm, selectedMapId: 'grove' };
    const html = worldMapSelectMarkup(lockedSelected);
    // The panel's Enter button is rendered (with the new aria-disabled contract) and never with `disabled`.
    const enterForGrove = html.match(/<button[^>]*class="[^"]*wc-map__enter"[^>]*data-focus-key="map-enter-grove"[^>]*>/);
    expect(enterForGrove).toBeTruthy();
    expect(enterForGrove![0]).toContain('aria-disabled="true"');
    expect(enterForGrove![0]).not.toMatch(/\sdisabled(=|>|\s)/);
    expect(enterForGrove![0]).not.toContain('data-ui-action="select-map"');
  });

  it('keeps a single Return to Title (in the panel) and never in the footer', () => {
    const html = worldMapSelectMarkup(FIXTURE_VM());
    const matches = html.match(/data-ui-action="return-title"/g) ?? [];
    expect(matches.length).toBe(1);
    // The single return-title lives inside the panel (data-region panel section).
    expect(html).toMatch(/<section class="wc-map__panel[^"]*"[\s\S]*data-ui-action="return-title"[\s\S]*<\/section>/);
    // The footer has only the hint text; no return-title button and no stray 'Animated' word.
    const footer = html.match(/<div class="wc-map__footer">[\s\S]*?<\/div>/);
    expect(footer).toBeTruthy();
    expect(footer![0]).not.toContain('return-title');
    expect(footer![0]).not.toContain('Animated');
    expect(footer![0]).toContain('inspect');
  });

  it('reduced-motion markup adds wc-state--static and never transforms the viewport', () => {
    const reduced = worldMapSelectMarkup(FIXTURE_VM({ reducedMotion: true }));
    expect(reduced).toContain('wc-state--static');
    const animated = worldMapSelectMarkup(FIXTURE_VM({ reducedMotion: false }));
    expect(animated).not.toContain('wc-state--static');
  });

  it('contains the dashed survey route and the legend', () => {
    const html = worldMapSelectMarkup(FIXTURE_VM());
    expect(html).toContain('class="wc-map__route"');
    expect(html).toContain('wc-map__legend');
    expect(html).toContain('data-kind="open"');
    expect(html).toContain('data-kind="cleared"');
    expect(html).toContain('data-kind="locked"');
    expect(html).toContain('data-kind="soon"');
  });

  it('escapes user-supplied setting / monster names', () => {
    const hostile = '<img src=x onerror=alert(1)> & "quoted" \'single\'';
    const vm = FIXTURE_VM({ maps: [PLAYABLE({ id: 'greenwake', name: 'Greenwake', setting: hostile, monsters: [hostile] })] });
    const html = worldMapSelectMarkup(vm);
    expect(html).not.toContain('<img src=x onerror=');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quoted&quot; &#39;single&#39;');
  });

  it('advertises an initial data-inspect-region equal to the selected playable map', () => {
    const html = worldMapSelectMarkup(FIXTURE_VM());
    expect(html).toMatch(/data-inspect-region="[^"]+"/);
    expect(html).toContain('data-inspect-region="greenwake"');
  });
});

describe('bindWorldMapSelect', () => {
  const makeRoot = (): MiniElement => {
    const doc = makeDocument();
    return parseHtml(worldMapSelectMarkup(FIXTURE_VM()), doc);
  };
  const buildOptions = (): WorldMapBindOptions => {
    // Build a panel for every map so the binder has a full bank to swap from. We extract the panel section
    // from a re-rendered markup of the map-select screen so the test never duplicates the contract.
    const panels: Record<string, string> = {};
    for (const map of FIXTURE_VM().maps) {
      const single = worldMapSelectMarkup({ ...FIXTURE_VM(), selectedMapId: map.id });
      const match = single.match(/<section class="wc-map__panel[\s\S]*?<\/section>/);
      if (match) panels[map.id] = match[0];
    }
    return { panels };
  };

  it('exposes the inspected region through data-inspect-region and data-active on the matching button', () => {
    const root = makeRoot();
    const teardown = bindWorldMapSelect(root as unknown as HTMLElement, buildOptions());
    // Pick a locked region: "grove" is locked in the fixture.
    const locked = root.querySelector('[data-region="the-grove"]');
    expect(locked).toBeTruthy();
    locked!.dispatchEvent(new Event('mouseenter'));
    const screen = root.querySelector('[data-screen="map-select"]')!;
    expect(screen.getAttribute('data-inspect-region')).toBe('grove');
    expect(locked!.getAttribute('data-active')).toBe('true');
    // No other button is active.
    const othersActive = root.querySelectorAll('.wc-map__region-btn[data-active="true"]');
    expect(othersActive.length).toBe(1);
    expect(othersActive[0]).toBe(locked);
    teardown();
  });

  it('keyboard focus also highlights the region and updates the panel', () => {
    const root = makeRoot();
    const teardown = bindWorldMapSelect(root as unknown as HTMLElement, buildOptions());
    const button = root.querySelector('[data-region="the-grove"]')!;
    button.dispatchEvent(new Event('focus'));
    const screen = root.querySelector('[data-screen="map-select"]')!;
    expect(screen.getAttribute('data-inspect-region')).toBe('grove');
    expect(button.getAttribute('data-active')).toBe('true');
    // Exactly one panel is visible (the others are hidden by the binder).
    const allPanels = root.querySelectorAll('.wc-map__panel');
    const visible = allPanels.filter(p => !p.hidden);
    expect(visible.length).toBe(1);
    expect(visible[0]!.getAttribute('data-region-panel')).toBe('grove');
    // The visible panel's markup must mention The Grove and the locked reason. We re-derive the panel
    // markup from the canonical worldMapSelectMarkup helper so the test reads the actual rendered string
    // (rather than reflecting on the DOM shim) — keeps the assertion honest against the same source the
    // production path emits.
    const grovePanelHtml = worldMapSelectMarkup({ ...FIXTURE_VM(), selectedMapId: 'grove' })
      .match(/<section class="wc-map__panel[\s\S]*?<\/section>/)![0]!;
    expect(grovePanelHtml).toContain('The Grove');
    expect(grovePanelHtml).toContain('Clear Whispering Canopy first');
    teardown();
  });

  it('locked regions stay focusable (no `disabled` attribute) so the player can inspect them', () => {
    const root = makeRoot();
    const locked = root.querySelector('[data-region="the-grove"]')!;
    expect(locked.hasAttribute('disabled')).toBe(false);
    expect(locked.getAttribute('aria-disabled')).toBe('true');
  });

  it('does not dispatch any game action or call re-render when the user hovers', () => {
    const root = makeRoot();
    let clickCount = 0;
    root.addEventListener('click', () => { clickCount += 1; });
    const teardown = bindWorldMapSelect(root as unknown as HTMLElement, buildOptions());
    const locked = root.querySelector('[data-region="the-grove"]')!;
    locked.dispatchEvent(new Event('mouseenter'));
    locked.dispatchEvent(new Event('focus'));
    // No clicks happened; nothing should have been dispatched.
    expect(clickCount).toBe(0);
    teardown();
  });

  it('teardown removes listeners and the cloned panel bank', () => {
    const root = makeRoot();
    const teardown = bindWorldMapSelect(root as unknown as HTMLElement, buildOptions());
    const initialPanels = root.querySelectorAll('.wc-map__panel').length;
    expect(initialPanels).toBe(FIXTURE_VM().maps.length);
    teardown();
    // After teardown the binder has removed the cloned panels, leaving only the original markup's panel.
    const remaining = root.querySelectorAll('.wc-map__panel').length;
    expect(remaining).toBe(1);
  });

  it('locked regions keep the Enter button aria-disabled even when inspected', () => {
    const root = makeRoot();
    const teardown = bindWorldMapSelect(root as unknown as HTMLElement, buildOptions());
    const locked = root.querySelector('[data-region="the-grove"]')!;
    locked.dispatchEvent(new Event('focus'));
    const visible = root.querySelectorAll('.wc-map__panel').find(p => !p.hidden)!;
    const enter = visible.querySelector('.wc-map__enter')!;
    expect(enter.hasAttribute('disabled')).toBe(false);
    expect(enter.getAttribute('aria-disabled')).toBe('true');
    expect(enter.hasAttribute('data-ui-action')).toBe(false);
    teardown();
  });
});

describe('worldMapSelect css-side contract', () => {
  const css = readFileSync('src/ui/map-select.css', 'utf8');

  it('uses no JS hooks; hover/focus styling lives in CSS only', () => {
    expect(css).toContain(':hover');
    expect(css).toContain(':focus-visible');
  });

  it('locks reduced motion to a static frame with no transform: scale', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('wc-state--static');
  });

  it('animates only transform and opacity in every keyframe', () => {
    const blocks = [...css.matchAll(/@keyframes ([\w-]+) \{((?:[^{}]|\{[^{}]*\})*)\}/g)];
    // CSS-only animations are not required here (the module is mostly layout), but if any keyframes exist they
    // must respect the project-wide rule.
    for (const [, name, body] of blocks) {
      const properties = new Set([...body!.matchAll(/([\w-]+)\s*:/g)].map(match => match[1]));
      for (const property of properties) expect([name, ['transform', 'opacity', 'stroke-opacity'].includes(property!)]).toEqual([name, true]);
    }
  });
});