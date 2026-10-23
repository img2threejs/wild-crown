import { Application, Assets, Container, Graphics, Polygon, Sprite } from 'pixi.js';
import type { Texture } from 'pixi.js';
import { LOCKED_COLOUR, ROUTE_COLOUR, SURVEY_ROUTE, WORLD_REGION_SHAPES, polygonBounds } from '../content/worldMapRegions.js';
import type { WorldRegionId, WorldRegionShape, WorldRegionStatus } from '../content/worldMapRegions.js';

export interface EryaMapRegion {
  readonly shape: WorldRegionShape;
  readonly status: WorldRegionStatus;
}

interface EryaMapEvents {
  readonly hover: (id: WorldRegionId | null) => void;
  readonly activate: (id: WorldRegionId) => void;
}

export interface EryaWorldMap {
  readonly root: Container;
  readonly backdrop: Sprite;
  readonly route: Graphics;
  readonly regions: ReadonlyMap<WorldRegionId, Container>;
  readonly animating: boolean;
  inspect(id: WorldRegionId | null, zoom: boolean, immediate?: boolean): void;
  resize(width: number, height: number): void;
  update(deltaMs: number): void;
  dispose(): void;
}

const DURATION_MS = 300;
const ZOOM = 1.1;

/** Native scene only: no Application, ticker, shared-texture loading or destruction. */
export function createEryaWorldMap(texture: Texture, entries: readonly EryaMapRegion[], events: EryaMapEvents): EryaWorldMap {
  const root = new Container({ label: 'erya-world-map' });
  const backdrop = new Sprite({ texture, label: 'painted-erya-map', eventMode: 'none' });
  const route = new Graphics({ label: 'survey-route', eventMode: 'none' });
  root.addChild(backdrop, route);
  const regions = new Map<WorldRegionId, Container>();
  const nodes = entries.map(entry => {
    const owner = new Container({ label: `region/${entry.shape.id}`, eventMode: 'static' });
    const border = new Graphics({ label: `border/${entry.shape.id}`, eventMode: 'none' });
    const points: number[] = [];
    const hitArea = new Polygon(points);
    owner.hitArea = hitArea;
    owner.cursor = entry.status === 'playable' ? 'pointer' : 'help';
    border.alpha = 0;
    owner.addChild(border);
    owner.on('pointerover', event => { if (event.pointerType !== 'touch') events.hover(entry.shape.id); });
    owner.on('pointerout', event => { if (event.pointerType !== 'touch') events.hover(null); });
    owner.on('pointertap', event => { if (event.button === 0) events.activate(entry.shape.id); });
    root.addChild(owner);
    regions.set(entry.shape.id, owner);
    return { entry, owner, border, points, hitArea, bounds: polygonBounds(entry.shape.polygon), fromAlpha: 0 };
  });
  const routeShapes = SURVEY_ROUTE.map(id => WORLD_REGION_SHAPES.find(shape => shape.id === id)!);
  let width = 1, height = 1;
  let active: WorldRegionId | null = null;
  let zoomed = false, disposed = false;
  let elapsed = DURATION_MS;
  let fromScale = 1, fromX = 0, fromY = 0;
  let toScale = 1, toX = 0, toY = 0;

  const update = (deltaMs: number): void => {
    if (disposed) return;
    elapsed = Math.min(DURATION_MS, elapsed + deltaMs);
    const progress = 1 - (1 - elapsed / DURATION_MS) ** 4;
    root.scale.set(fromScale + (toScale - fromScale) * progress);
    root.position.set(fromX + (toX - fromX) * progress, fromY + (toY - fromY) * progress);
    for (const node of nodes) node.border.alpha = node.fromAlpha + ((node.entry.shape.id === active ? 1 : 0) - node.fromAlpha) * progress;
  };
  const inspect = (id: WorldRegionId | null, zoom: boolean, immediate = false): void => {
    if (disposed || (!immediate && active === id && zoomed === zoom)) return;
    active = id;
    zoomed = zoom;
    const selected = nodes.find(node => node.entry.shape.id === id);
    fromScale = root.scale.x; fromX = root.x; fromY = root.y;
    toScale = zoom && selected ? ZOOM : 1;
    toX = 0; toY = 0;
    if (selected && zoom) {
      const { shape } = selected.entry;
      const { minX, minY, maxX, maxY } = selected.bounds;
      // Keep the complete inspected contour in frame without uncovering the original map plane.
      toX = Math.max(8 - minX / 100 * width * ZOOM, Math.min(width - 8 - maxX / 100 * width * ZOOM, shape.centre[0] / 100 * width * (1 - ZOOM)));
      toY = Math.max(8 - minY / 100 * height * ZOOM, Math.min(height - 8 - maxY / 100 * height * ZOOM, shape.centre[1] / 100 * height * (1 - ZOOM)));
      toX = Math.max(width * (1 - ZOOM), Math.min(0, toX));
      toY = Math.max(height * (1 - ZOOM), Math.min(0, toY));
    }
    for (const node of nodes) node.fromAlpha = node.border.alpha;
    elapsed = immediate ? DURATION_MS : 0;
    update(0);
  };
  const resize = (nextWidth: number, nextHeight: number): void => {
    if (disposed || nextWidth <= 0 || nextHeight <= 0) return;
    width = nextWidth; height = nextHeight;
    backdrop.width = width; backdrop.height = height;
    for (const node of nodes) {
      node.points.length = 0;
      for (const [x, y] of node.entry.shape.polygon) node.points.push(x / 100 * width, y / 100 * height);
      node.hitArea.points = node.points;
      node.border.clear().poly(node.points).fill({ color: node.entry.status === 'playable' ? ROUTE_COLOUR : LOCKED_COLOUR, alpha: 0.08 })
        .stroke({ color: '#101c14', width: 5, alpha: 0.9, join: 'round' })
        .poly(node.points).stroke({ color: '#f2d48f', width: 2, alpha: 1, join: 'round' });
    }
    route.clear();
    for (let index = 1; index < routeShapes.length; index++) {
      const [ax, ay] = routeShapes[index - 1]!.centre;
      const [bx, by] = routeShapes[index]!.centre;
      const x = ax / 100 * width, y = ay / 100 * height;
      const dx = (bx - ax) / 100 * width, dy = (by - ay) / 100 * height;
      const length = Math.hypot(dx, dy);
      for (let at = 0; at < length; at += 7) {
        const end = Math.min(at + 3.5, length);
        route.moveTo(x + dx * at / length, y + dy * at / length).lineTo(x + dx * end / length, y + dy * end / length);
      }
    }
    route.stroke({ color: ROUTE_COLOUR, width: 1, alpha: 0.3 });
    inspect(active, zoomed, true);
  };
  return {
    root, backdrop, route, regions,
    get animating() { return elapsed < DURATION_MS; },
    inspect, resize, update,
    dispose() {
      if (disposed) return;
      disposed = true;
      root.destroy({ children: true, texture: false, textureSource: false });
      regions.clear();
    },
  };
}

export interface EryaMapController {
  inspect(id: WorldRegionId | null, zoom: boolean): void;
  dispose(): void;
}

/** The existing map screen owns this host; it never runs while another screen is mounted. */
export async function mountEryaWorldMap(host: HTMLElement, buttonsLayer: HTMLElement, entries: readonly EryaMapRegion[], events: EryaMapEvents, reducedMotion: boolean, signal: AbortSignal): Promise<EryaMapController | null> {
  const doc = host.ownerDocument;
  const win = doc.defaultView!;
  const canvas = doc.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  const app = new Application();
  let initialized = false;
  try {
    await app.init({ canvas, width: host.clientWidth || 1, height: host.clientHeight || 1, autoStart: false, sharedTicker: false, antialias: true, autoDensity: true, resolution: Math.min(win.devicePixelRatio, 2), preference: 'webgl' });
    initialized = true;
    if (signal.aborted) { app.destroy(true, { children: true }); return null; }
    const texture = await Assets.load<Texture>('/ui/world-map-game.webp');
    if (signal.aborted) { app.destroy(true, { children: true }); return null; }
    const scene = createEryaWorldMap(texture, entries, events);
    app.stage.addChild(scene.root);
    app.renderer.events.autoPreventDefault = false;
    canvas.style.touchAction = 'pan-y';
    host.appendChild(canvas);
    const media = win.matchMedia('(prefers-reduced-motion: reduce)');
    let disposed = false;
    let inspected: WorldRegionId | null = null;
    let zoom = false;
    const activeTouches = new Set<number>();
    const syncButtons = (): void => {
      buttonsLayer.style.transform = `matrix(${scene.root.scale.x},0,0,${scene.root.scale.y},${scene.root.x},${scene.root.y})`;
    };
    const frame = (): void => {
      scene.update(app.ticker.deltaMS);
      syncButtons();
      if (!scene.animating) app.stop();
    };
    app.ticker.add(frame);
    let lastWidth = 0, lastHeight = 0, lastResolution = 0;
    const resize = (entries?: readonly ResizeObserverEntry[]): void => {
      if (disposed) return;
      const content = entries?.[0]?.contentRect;
      const style = content ? null : win.getComputedStyle(host);
      const width = content?.width ?? Number.parseFloat(style!.width);
      const height = content?.height ?? Number.parseFloat(style!.height);
      const resolution = Math.min(win.devicePixelRatio, 2);
      if (!(width > 0 && height > 0) || width === lastWidth && height === lastHeight && resolution === lastResolution) return;
      lastWidth = width; lastHeight = height; lastResolution = resolution;
      app.renderer.resize(width, height, resolution);
      scene.resize(width, height);
      syncButtons();
      app.render();
    };
    const inspect = (id: WorldRegionId | null, nextZoom: boolean): void => {
      if (disposed) return;
      inspected = id; zoom = nextZoom;
      const reduced = reducedMotion || media.matches;
      scene.inspect(id, nextZoom && !reduced, reduced);
      syncButtons();
      // Keep the pressed geographic target stationary until tap or scroll cancellation resolves.
      if (activeTouches.size) { app.stop(); return; }
      if (scene.animating && !doc.hidden) app.start();
      else { app.stop(); app.render(); }
    };
    const onMotion = (): void => { inspect(inspected, zoom); };
    const onTouchStart = (event: PointerEvent): void => {
      if (event.pointerType !== 'touch') return;
      activeTouches.add(event.pointerId);
      app.stop();
    };
    const onTouchEnd = (event: PointerEvent): void => {
      if (activeTouches.delete(event.pointerId) && !activeTouches.size) inspect(inspected, zoom);
    };
    const onVisibility = (): void => {
      if (doc.hidden) { activeTouches.clear(); app.stop(); }
      else inspect(inspected, zoom);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    media.addEventListener('change', onMotion);
    doc.addEventListener('visibilitychange', onVisibility);
    canvas.addEventListener('pointerdown', onTouchStart, true);
    doc.addEventListener('pointerup', onTouchEnd, true);
    doc.addEventListener('pointercancel', onTouchEnd, true);
    resize();
    host.dataset.ready = 'true';
    return {
      inspect,
      dispose() {
        if (disposed) return;
        disposed = true;
        observer.disconnect();
        media.removeEventListener('change', onMotion);
        doc.removeEventListener('visibilitychange', onVisibility);
        canvas.removeEventListener('pointerdown', onTouchStart, true);
        doc.removeEventListener('pointerup', onTouchEnd, true);
        doc.removeEventListener('pointercancel', onTouchEnd, true);
        activeTouches.clear();
        app.stop();
        app.ticker.remove(frame);
        // Pixi finishes pointerup after activation; preserve its event boundary until then.
        queueMicrotask(() => {
          scene.dispose();
          app.destroy(true, { children: true, texture: false, textureSource: false });
        });
        buttonsLayer.style.removeProperty('transform');
        delete host.dataset.ready;
      },
    };
  } catch (error) {
    if (initialized) app.destroy(true, { children: true, texture: false, textureSource: false });
    else app.stage.destroy({ children: true });
    throw error;
  }
}
