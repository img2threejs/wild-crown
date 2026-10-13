import { afterEach, describe, expect, it } from 'bun:test';
import { PerspectiveCamera } from 'three';
import { DamageNumbers } from '../../src/ui/DamageNumbers.js';
import type { ActorId, WorldClockSnapshot } from '../../src/game/contracts.js';
import type { CombatEvent } from '../../src/game/combat/CombatEngine.js';

class TestNode {
  parentNode: TestNode | null = null;
  children: TestNode[] = [];
  className = '';
  textContent = '';
  hidden = false;
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
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
    const i = this.children.indexOf(child);
    if (i >= 0) { this.children.splice(i, 1); child.parentNode = null; }
    return child;
  }
  remove(): void { if (this.parentNode) this.parentNode.removeChild(this); }
}

class TestDocument {
  created: TestNode[] = [];
  createElement(_tag: string): TestNode { const n = new TestNode(); this.created.push(n); return n; }
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

function clock(worldTick: number, paused = false): WorldClockSnapshot {
  return { simulationTick: worldTick, worldTick, worldTimeSeconds: worldTick / 60, timeScale: paused ? 0 : 1, policy: paused ? 'paused' : 'normal' };
}

function camera(): PerspectiveCamera {
  const c = new PerspectiveCamera(40, 16 / 9, 0.1, 200);
  c.position.set(0, 6, 12);
  c.lookAt(0, 0, 0);
  c.updateMatrixWorld(true);
  return c;
}

function evt(id: string, amount: number, targetId: ActorId, tick: number, position: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }): CombatEvent {
  return { id, tick, kind: 'damage', message: 'damage', targetId, damage: { targetId, amount, position, worldTick: tick } };
}

function mount(): { host: TestNode; ui: DamageNumbers } {
  const host = new TestNode();
  const ui = new DamageNumbers(host as unknown as HTMLElement);
  return { host, ui };
}

function labelNodes(ui: DamageNumbers): TestNode[] {
  return Array.from(ui.element.children) as unknown as TestNode[];
}

function spawnedLabels(ui: DamageNumbers): TestNode[] {
  return labelNodes(ui).filter(c => c.textContent.startsWith('-'));
}

function visibleLabels(ui: DamageNumbers): TestNode[] {
  return labelNodes(ui).filter(c => c.style['opacity'] !== '0');
}

describe('DamageNumbers — consumption and label content', () => {
  it('renders the minus prefix and exact amount via textContent, sets dataset, tags the aren victim with --player', () => {
    installDocument();
    const { ui } = mount();
    ui.consume([
      evt('p1', 17, 'aren' as ActorId, 5, { x: 0, y: 0, z: 0 }),
      evt('e1', 8, 'boar-1' as ActorId, 5, { x: 2, y: 0, z: 0 }),
    ]);
    ui.update(clock(5), camera(), 1280, 720, false);
    const labels = visibleLabels(ui);
    expect(labels.length).toBe(2);
    const playerDiv = labels.find(c => c.classList.contains('wc-damage-number--player'))!;
    expect(playerDiv.textContent).toBe('-17');
    expect(playerDiv.dataset['amount']).toBe('17');
    expect(playerDiv.dataset['targetId']).toBe('aren');
    const enemyDiv = labels.find(c => !c.classList.contains('wc-damage-number--player'))!;
    expect(enemyDiv.textContent).toBe('-8');
    expect(enemyDiv.dataset['targetId']).toBe('boar-1');
  });

  it('suppresses zero, negative, NaN, and event kinds without a damage payload', () => {
    installDocument();
    const { ui } = mount();
    const cueOnly: CombatEvent = { id: 'cue-1', tick: 1, kind: 'cue', message: 'windup' };
    ui.consume([cueOnly, evt('z', 0, 'boar' as ActorId, 2), evt('n', -5, 'boar' as ActorId, 3), evt('q', Number.NaN, 'boar' as ActorId, 4)]);
    expect(spawnedLabels(ui).length).toBe(0);
  });

  it('deduplicates repeated event ids within the bounded 128 window', () => {
    installDocument();
    const { ui } = mount();
    for (let i = 0; i < 150; i++) ui.consume([evt('dup', 5, 'boar' as ActorId, i + 1)]);
    expect(spawnedLabels(ui).length).toBe(1);
  });

  it('preserves the newest labels when repeated same-tick hits overflow the bounded pool', () => {
    installDocument();
    const { ui } = mount();
    const capacity = ui.element.children.length;
    for (let i = 0; i < capacity; i++) ui.consume([evt(`e-${i}`, i + 1, 'boar' as ActorId, 10)]);
    ui.consume([evt('extra-1', 999, 'boar' as ActorId, 10), evt('extra-2', 888, 'boar' as ActorId, 10)]);
    const texts = spawnedLabels(ui).map(c => c.textContent);
    expect(texts).not.toContain('-1');
    expect(texts).not.toContain('-2');
    expect(texts).toContain('-3');
    expect(texts).toContain('-999');
    expect(texts).toContain('-888');
  });
});

describe('DamageNumbers — independent simultaneous labels', () => {
  it('keeps simultaneous damage labels independent in identity and deterministic spread', () => {
    installDocument();
    const { ui } = mount();
    ui.consume([
      evt('a', 5, 'boar-1' as ActorId, 1),
      evt('b', 12, 'boar-2' as ActorId, 1),
      evt('c', 3, 'boar-3' as ActorId, 1),
    ]);
    ui.update(clock(1), camera(), 1280, 720, false);
    const labels = visibleLabels(ui);
    expect(labels.length).toBe(3);
    expect(new Set(labels.map(c => c.textContent)).size).toBe(3);
    // Each label's transform encodes a distinct screen position; no two share the same translate origin.
    const transforms = labels.map(c => c.style['transform']);
    expect(new Set(transforms).size).toBe(3);
  });
});

describe('DamageNumbers — pause and expiry', () => {
  it('freezes label age while worldTick is held constant (simulationTick moves)', () => {
    installDocument();
    const { ui } = mount();
    ui.consume([evt('e', 10, 'boar' as ActorId, 100)]);
    ui.update(clock(100), camera(), 1280, 720, false);
    const first = visibleLabels(ui)[0]!.style['transform'];
    for (let i = 0; i < 10; i++) ui.update({ simulationTick: 100 + i, worldTick: 100, worldTimeSeconds: 100 / 60, timeScale: 0, policy: 'paused' }, camera(), 1280, 720, false);
    expect(visibleLabels(ui)[0]!.style['transform']).toBe(first);
  });

  it('removes old labels after world time has advanced', () => {
    installDocument();
    const { ui } = mount();
    ui.consume([evt('e', 4, 'boar' as ActorId, 50)]);
    ui.update(clock(50), camera(), 1280, 720, false);
    expect(visibleLabels(ui).length).toBe(1);
    ui.update(clock(650), camera(), 1280, 720, false);
    expect(visibleLabels(ui).length).toBe(0);
  });
});

describe('DamageNumbers — reduced motion', () => {
  it('keeps the static separation and value but removes the rising drift when reducedMotion is on', () => {
    installDocument();
    // Normal motion: spawn at tick 10, render at tick 20 → 10 ticks of rise.
    const host1 = new TestNode();
    const ui1 = new DamageNumbers(host1 as unknown as HTMLElement);
    ui1.consume([evt('n', 9, 'boar' as ActorId, 10)]);
    ui1.update(clock(20), camera(), 1280, 720, false);
    const normalLabel = labelNodes(ui1).find(c => c.textContent === '-9')!;
    // Reduced motion: same spawn tick, same render tick, but no rise applied.
    const host2 = new TestNode();
    const ui2 = new DamageNumbers(host2 as unknown as HTMLElement);
    ui2.consume([evt('r', 9, 'boar' as ActorId, 10)]);
    ui2.update(clock(20), camera(), 1280, 720, true);
    const reducedLabel = labelNodes(ui2).find(c => c.textContent === '-9')!;
    // Same horizontal origin (anchor x=0 → screenX=width/2, identical spread at same tick).
    // Vertical differs: reduced motion never adds rise, so the reduced Y is at the unrisen base
    // while the normal Y has drifted upward (smaller y on screen).
    const ty = (s: string) => Number(s.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/)![2]);
    expect(ty(reducedLabel.style['transform']!)).toBeGreaterThan(ty(normalLabel.style['transform']!));
    expect(reducedLabel.textContent).toBe('-9');
  });
});

describe('DamageNumbers — clipping and behind-camera', () => {
  it('hides labels that project outside the visible canvas', () => {
    installDocument();
    const { ui } = mount();
    ui.consume([evt('far', 5, 'boar' as ActorId, 1, { x: 100000, y: 0, z: 0 })]);
    ui.update(clock(1), camera(), 1280, 720, false);
    const labels = spawnedLabels(ui);
    expect(labels.length).toBe(1);
    expect(labels[0]!.style['opacity']).toBe('0');
  });

  it('hides labels that fall behind the camera', () => {
    installDocument();
    const { ui } = mount();
    ui.consume([evt('behind', 5, 'boar' as ActorId, 1, { x: 0, y: 0, z: 30 })]);
    ui.update(clock(1), camera(), 1280, 720, false);
    const labels = spawnedLabels(ui);
    expect(labels.length).toBe(1);
    expect(labels[0]!.style['opacity']).toBe('0');
  });
});

describe('DamageNumbers — clear and dispose lifecycle', () => {
  it('clear() removes active labels and resets dedup so a region load replays fresh', () => {
    installDocument();
    const { ui } = mount();
    ui.consume([evt('e', 7, 'boar' as ActorId, 1)]);
    expect(spawnedLabels(ui).length).toBe(1);
    ui.clear();
    expect(spawnedLabels(ui).length).toBe(0);
    ui.consume([evt('e', 7, 'boar' as ActorId, 5)]);
    expect(spawnedLabels(ui).length).toBe(1);
  });

  it('dispose() detaches the owner element and is idempotent', () => {
    installDocument();
    const { host, ui } = mount();
    ui.consume([evt('before', 7, 'aren', 1)]);
    ui.update(clock(1), camera(), 800, 600, false);
    expect(visibleLabels(ui).map(c => c.textContent)).toEqual(['-7']);
    ui.dispose();
    expect(host.children).not.toContain(ui.element);
    ui.dispose();
    ui.update(clock(99), camera(), 800, 600, false);
    ui.consume([evt('after', 5, 'boar' as ActorId, 1)]);
    expect(spawnedLabels(ui).length).toBe(0);
  });
});
