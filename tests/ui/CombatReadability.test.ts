import { afterEach, describe, expect, it } from 'bun:test';
import { PerspectiveCamera } from 'three';
import { CombatReadability } from '../../src/ui/CombatReadability.js';
import type { ActorId, ActorSnapshot, AttackId, CombatSnapshot, GameSettings, Vec3 } from '../../src/game/contracts.js';
import { DEFAULT_GAME_SETTINGS } from '../../src/game/contracts.js';

/** Internal helper shape: a Map-backed stand-in for `CSSStyleDeclaration` that supports both
 * `style.setProperty('name', value)` and direct member writes (`style.transform = value`). */
interface TestStyle {
  setProperty(name: string, value: string): void;
  get(name: string): string | undefined;
  [key: string]: unknown;
}
const makeStyle = (): TestStyle => {
  const values = new Map<string, string>();
  const proxy = new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      if (prop === 'setProperty') return (name: string, value: string) => values.set(name, value);
      if (prop === 'get') return (name: string) => values.get(name);
      if (typeof prop === 'symbol') return undefined;
      return values.get(prop as string) ?? '';
    },
    set(_target, prop, value) {
      if (typeof prop === 'symbol') return true;
      values.set(prop as string, String(value));
      return true;
    },
    has(_target, prop) {
      if (typeof prop === 'symbol') return false;
      return values.has(prop as string);
    },
  });
  return proxy as unknown as TestStyle;
};

class TestNode {
  parentNode: TestNode | null = null;
  children: TestNode[] = [];
  className = '';
  textContent = '';
  hidden = false;
  disabled = false;
  readonly dataset: Record<string, string> = {};
  readonly style: TestStyle = makeStyle();
  readonly classList = {
    _set: new Set<string>(),
    add: (n: string) => { this.classList._set.add(n); this.className = Array.from(this.classList._set).join(' '); },
    remove: (n: string) => { this.classList._set.delete(n); this.className = Array.from(this.classList._set).join(' '); },
    toggle: (n: string, force?: boolean) => {
      const on = force === undefined ? !this.classList._set.has(n) : force;
      if (on) this.classList._set.add(n); else this.classList._set.delete(n);
      this.className = Array.from(this.classList._set).join(' ');
    },
    contains: (n: string) => this.classList._set.has(n),
  };
  setAttribute(name: string, value: string): void { this.dataset[name] = value; }
  removeAttribute(name: string): void { delete this.dataset[name]; }
  hasAttribute(name: string): boolean { return name in this.dataset; }
  getAttribute(name: string): string | null { return this.dataset[name] ?? null; }
  appendChild(child: TestNode): TestNode { child.parentNode = this; this.children.push(child); return child; }
  removeChild(child: TestNode): TestNode {
    const index = this.children.indexOf(child);
    if (index >= 0) { this.children.splice(index, 1); child.parentNode = null; }
    return child;
  }
  remove(): void { if (this.parentNode) this.parentNode.removeChild(this); }
  get parentElement(): TestNode | null { return this.parentNode; }
}

class TestDocument {
  createElement(_tag: string): TestNode { return new TestNode(); }
}

const realDocument = globalThis.document;
const realElement = globalThis.Element;
const realHTMLElement = globalThis.HTMLElement;
const realHTMLDivElement = globalThis.HTMLDivElement;

function installDocument(): TestDocument {
  const doc = new TestDocument();
  Object.assign(globalThis, { document: doc, Element: TestNode, HTMLElement: TestNode, HTMLDivElement: TestNode });
  return doc;
}

afterEach(() => {
  Object.assign(globalThis, {
    document: realDocument,
    Element: realElement,
    HTMLElement: realHTMLElement,
    HTMLDivElement: realHTMLDivElement,
  });
});

function actor(id: ActorId, kind: 'player' | 'ally' | 'neutral' | 'hostile' | 'wild', position: Vec3, extra: Partial<ActorSnapshot> = {}): ActorSnapshot {
  return {
    id, archetypeId: id, species: 'human', allegiance: kind, position, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 0, y: 0, z: -1 },
    actionId: 'aren-idle', phase: 'idle', normalizedTime: 0, sockets: {}, interactionRequirements: [], visible: true, downed: false, possessed: false,
    ...extra,
  } as unknown as ActorSnapshot;
}

function camera(): PerspectiveCamera {
  const c = new PerspectiveCamera(40, 16 / 9, 0.1, 200);
  c.position.set(0, 6, 12);
  c.lookAt(0, 0, 0);
  c.updateMatrixWorld(true);
  return c;
}

function worldTick(value: number): { simulationTick: number; worldTick: number; worldTimeSeconds: number; timeScale: number; policy: 'normal' } {
  return { simulationTick: value, worldTick: value, worldTimeSeconds: value / 60, timeScale: 1, policy: 'normal' };
}

function snapshot(actors: readonly ActorSnapshot[], targetId: ActorId | undefined, telegraphs: CombatSnapshot['telegraphs']): CombatSnapshot {
  return {
    actors: actors as ActorSnapshot[],
    movableObjects: [],
    worldClock: worldTick(120),
    player: { vitality: 100, maxVitality: 100, instinct: 0, mana: 100, maxMana: 100, heroId: 'aren' },
    skills: [],
    telegraphs,
    hazards: [],
    events: [],
    targetId,
  } as unknown as CombatSnapshot;
}

function telegraph(sourceId: ActorId, targetActorId: ActorId | undefined, phase: 'windup' | 'commit' | 'active' | 'recovery', remainingTicks: number, targetPosition: Vec3 = { x: 0, y: 0, z: 0 }, attackId: AttackId = 'koro-charge' as AttackId): CombatSnapshot['telegraphs'][number] {
  return { id: `${sourceId}:${targetActorId ?? 'none'}:${phase}:${remainingTicks}`, attackId, sourceId, targetPosition, phase, remainingTicks, targetActorId };
}

function findRing(ui: CombatReadability): TestNode { return ui.element.children[0]! as unknown as TestNode; }
function arrowChildren(ui: CombatReadability): TestNode[] { return ui.element.children.slice(1).map(child => child as unknown as TestNode); }
function readTransform(node: TestNode): string { return (node.style.get('transform') ?? '') as string; }

describe('CombatReadability', () => {
  it('shows the ring when the current target is hostile, visible, and standing — including an implicit lock', () => {
    installDocument();
    const host = new TestNode();
    const ui = new CombatReadability(host as unknown as HTMLElement);
    ui.setSettings(DEFAULT_GAME_SETTINGS);
    const player = actor('aren', 'player', { x: 0, y: 0, z: 0 });
    const hostile = actor('koro', 'hostile', { x: 0, y: 0, z: -4 });
    ui.update(snapshot([player, hostile], 'koro', []), camera(), 1280, 720);
    expect(findRing(ui).hidden).toBe(false);
    expect(findRing(ui).dataset['actor']).toBe('koro');
  });

  it('hides the ring when the locked target is downed, invisible, or non-hostile', () => {
    installDocument();
    const host = new TestNode();
    const ui = new CombatReadability(host as unknown as HTMLElement);
    ui.setSettings(DEFAULT_GAME_SETTINGS);
    const player = actor('aren', 'player', { x: 0, y: 0, z: 0 });
    const companion = actor('tali', 'ally', { x: 1, y: 0, z: -4 });
    ui.update(snapshot([player, companion], 'tali', []), camera(), 1280, 720);
    expect(findRing(ui).hidden).toBe(true);
    const downed = actor('koro', 'hostile', { x: 0, y: 0, z: -4 }, { downed: true });
    ui.update(snapshot([player, downed], 'koro', []), camera(), 1280, 720);
    expect(findRing(ui).hidden).toBe(true);
    const hidden = actor('koro', 'hostile', { x: 0, y: 0, z: -4 }, { visible: false });
    ui.update(snapshot([player, hidden], 'koro', []), camera(), 1280, 720);
    expect(findRing(ui).hidden).toBe(true);
  });

  it('emits an off-screen arrow only when the source is hostile + off-screen + targets the player (targetActorId)', () => {
    installDocument();
    const host = new TestNode();
    const ui = new CombatReadability(host as unknown as HTMLElement);
    ui.setSettings(DEFAULT_GAME_SETTINGS);
    const player = actor('aren', 'player', { x: 0, y: 0, z: 0 });
    const hostile = actor('koro', 'hostile', { x: 60, y: 0, z: -60 });
    const telegraphs = [telegraph('koro', 'aren', 'windup', 12)];
    ui.update(snapshot([player, hostile], undefined, telegraphs), camera(), 1280, 720);
    expect(arrowChildren(ui).some(arrow => !arrow.hidden)).toBe(true);
    const telegraphsCompanion = [telegraph('koro', 'tali', 'windup', 12)];
    ui.update(snapshot([player, hostile], undefined, telegraphsCompanion), camera(), 1280, 720);
    expect(arrowChildren(ui).every(arrow => arrow.hidden)).toBe(true);
    // Missing targetActorId is also not a player warning.
    ui.update(snapshot([player, hostile], undefined, [telegraph('koro', undefined, 'windup', 12)]), camera(), 1280, 720);
    expect(arrowChildren(ui).every(arrow => arrow.hidden)).toBe(true);
  });

  it('removes the arrow immediately when the next snapshot no longer wants it (no grace period)', () => {
    installDocument();
    const host = new TestNode();
    const ui = new CombatReadability(host as unknown as HTMLElement);
    ui.setSettings(DEFAULT_GAME_SETTINGS);
    const player = actor('aren', 'player', { x: 0, y: 0, z: 0 });
    const hostile = actor('koro', 'hostile', { x: 60, y: 0, z: -60 });
    ui.update(snapshot([player, hostile], undefined, [telegraph('koro', 'aren', 'windup', 12)]), camera(), 1280, 720);
    expect(arrowChildren(ui).filter(a => !a.hidden).length).toBe(1);
    ui.update(snapshot([player, hostile], undefined, []), camera(), 1280, 720);
    expect(arrowChildren(ui).every(arrow => arrow.hidden)).toBe(true);
    // Same when the source becomes downed mid-telegraph.
    ui.update(snapshot([player, hostile], undefined, [telegraph('koro', 'aren', 'windup', 12)]), camera(), 1280, 720);
    const downed = { ...hostile, downed: true } as ActorSnapshot;
    ui.update(snapshot([player, downed], undefined, [telegraph('koro', 'aren', 'windup', 12)]), camera(), 1280, 720);
    expect(arrowChildren(ui).every(arrow => arrow.hidden)).toBe(true);
  });

  it.each([
    ['front right', 10, -5, 1144, 344, 90],
    ['front left', -10, -5, 56, 344, 270],
    ['behind right', 10, 5, 1144, 344, 90],
    ['behind left', -10, 5, 56, 344, 270],
    ['beyond far plane', 10, -1000, 1144, 344, 90],
    ['before near plane', 1, -0.01, 1144, 344, 90],
    ['on camera plane', 1, 0, 1144, 344, 90],
    ['directly behind', 0, 5, 600, 632, 180],
  ] as const)('points toward %s without reversing or leaving the viewport', (_name, x, z, px, py, angle) => {
    installDocument();
    const ui = new CombatReadability(new TestNode() as unknown as HTMLElement);
    const c = new PerspectiveCamera(48, 1200 / 688, 0.1, 100);
    const player = actor('aren', 'player', { x: 0, y: 0, z: 0 });
    const hostile = actor('koro', 'hostile', { x, y: -1.2, z });
    const scene = snapshot([player, hostile], undefined, [telegraph('koro', 'aren', 'windup', 12)]);
    for (const reducedMotion of [false, true]) {
      ui.setSettings({ ...DEFAULT_GAME_SETTINGS, reducedMotion });
      ui.update(scene, c, 1200, 688);
      const visible = arrowChildren(ui).filter(a => !a.hidden);
      expect(visible).toHaveLength(1);
      const match = /translate\(([^p]+)px, ([^p]+)px\).*rotate\(([^d]+)deg\)/.exec(readTransform(visible[0]!))!;
      expect(Number(match[1])).toBeCloseTo(px);
      expect(Number(match[2])).toBeCloseTo(py);
      const radians = Number(match[3]) * Math.PI / 180;
      expect(Math.sin(radians)).toBeCloseTo(Math.sin(angle * Math.PI / 180));
      expect(Math.cos(radians)).toBeCloseTo(Math.cos(angle * Math.PI / 180));
    }
    ui.update(scene, c, 100, 80);
    const compact = arrowChildren(ui).find(a => !a.hidden)!;
    expect(readTransform(compact)).toContain('translate(50px, 40px)');
    ui.dispose();
  });

  it('deduplicates sources, bounds simultaneous warnings, and releases missing threats', () => {
    installDocument();
    const ui = new CombatReadability(new TestNode() as unknown as HTMLElement);
    const player = actor('aren', 'player', { x: 0, y: 0, z: 0 });
    const hostiles = Array.from({ length: 8 }, (_, i) => actor(`threat-${i}` as ActorId, 'hostile', { x: 60 + i, y: 0, z: -60 }));
    const tells = hostiles.map(a => telegraph(a.id, 'aren', 'windup', 12));
    const c = camera();
    ui.update(snapshot([player, ...hostiles], undefined, [...tells, ...tells]), c, 1280, 720);
    expect(arrowChildren(ui).filter(a => !a.hidden)).toHaveLength(6);
    ui.update(snapshot([player, ...hostiles], undefined, [tells[0]!, tells[0]!]), c, 1280, 720);
    expect(arrowChildren(ui).filter(a => !a.hidden)).toHaveLength(1);
    const onScreen = { ...hostiles[0]!, position: { x: 0, y: 0, z: -4 } };
    ui.update(snapshot([player, onScreen], undefined, [tells[0]!]), c, 1280, 720);
    expect(arrowChildren(ui).every(a => a.hidden)).toBe(true);
    ui.dispose();
  });

  it('clear() hides everything, dispose() removes the overlay, dispose is idempotent', () => {
    installDocument();
    const host = new TestNode();
    const ui = new CombatReadability(host as unknown as HTMLElement);
    ui.setSettings(DEFAULT_GAME_SETTINGS);
    const player = actor('aren', 'player', { x: 0, y: 0, z: 0 });
    const near = actor('koro', 'hostile', { x: 0, y: 0, z: -4 });
    const far = actor('rookie', 'hostile', { x: 60, y: 0, z: 30 });
    const telegraphs = [
      telegraph('koro', 'aren', 'windup', 12),
      telegraph('rookie', 'aren', 'windup', 12, { x: 60, y: 0, z: 30 }, 'rookie-charge' as AttackId),
    ];
    ui.update(snapshot([player, near, far], 'koro', telegraphs), camera(), 1280, 720);
    expect(findRing(ui).hidden).toBe(false);
    expect(arrowChildren(ui).some(arrow => !arrow.hidden)).toBe(true);
    ui.clear();
    expect(findRing(ui).hidden).toBe(true);
    expect(arrowChildren(ui).every(arrow => arrow.hidden)).toBe(true);
    const childrenCount = host.children.length;
    ui.dispose();
    expect(host.children.length).toBe(childrenCount - 1);
    ui.dispose();
    expect(host.children.length).toBe(childrenCount - 1);
  });
});
