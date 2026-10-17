import { describe, expect, it } from 'bun:test';
import { Color, InstancedMesh, Mesh, Object3D, Scene, ShaderMaterial } from 'three';
import { StoryEffects } from '../../src/effects/StoryEffects.js';
import { StoryPresentation } from '../../src/effects/StoryPresentation.js';
import type { StoryCue } from '../../src/effects/story-cues.js';
import { resolveKit, type ImpactSink } from '../../src/effects/vfx/ElementKits.js';
import { EMBER_CLIPS, SAKDA_LIMB_MASKS, UMBRAL_CLIPS, VESPER_BLADE_CLIPS, isEmberKit, isHeartrootKit, isUmbralKit } from '../../src/effects/vfx/HeroKits.js';
import { ELEMENT_INDEX, PALETTE, UMBRAL_RIM, EMBER_GOLD, HDR_DOMINANT_MAX } from '../../src/effects/vfx/palette.js';
import type { ActionId, ActorSnapshot, CombatSnapshot, HeroMarkSnapshot, PlayerProjectileSnapshot } from '../../src/game/contracts.js';

let sequence = 0;
type Partial2 = Partial<StoryCue> & Pick<StoryCue, 'kind' | 'phase'>;
function cue(partial: Partial2, tick = 0): StoryCue {
  return { instanceId: `herokit:${++sequence}`, tick, worldTick: tick, worldTimeSeconds: tick / 60, priority: 'essential', actorId: 'aren', ...partial };
}
const at = { x: 4, y: 0.9, z: -3 };
const from = { x: 0, y: 0, z: 0 };
const to = { x: 5, y: 0, z: 2 };
function clock(effects: StoryEffects, tick: number): void { effects.update({ simulationTick: tick, worldTick: tick, worldTimeSeconds: tick / 60, timeScale: 1, policy: 'normal' }); }
function spawned(effects: StoryEffects): number { const p = effects.vfx.particles; return p.additive.nextSlot + p.alpha.nextSlot; }
function sink(): ImpactSink & { shakes: number[]; rims: string[]; impulses: number[] } {
  const record = { shakes: [] as number[], rims: [] as string[], impulses: [] as number[] };
  return Object.assign(record, {
    shake: (amplitude: number) => { record.shakes.push(amplitude); },
    flashActor: (id: string, _color: Color, _intensity: number, _seconds: number, mode: string) => { record.rims.push(`${id}:${mode}`); },
    impulse: (strength: number) => { record.impulses.push(strength); },
  });
}
/** Everything a cue can leave in pooled resources, beyond the shared particle pools. */
function pooled(effects: StoryEffects): number {
  const w = effects.warden;
  return effects.vfx.ground.activeCount() + w.sigils.activeCount + w.crescents.activeCount(effects.vfx.time) + effects.vfx.beams.activeCount;
}
function drew(effects: StoryEffects, emit: StoryCue): boolean {
  const before = spawned(effects), pools = pooled(effects);
  effects.emit(emit);
  return spawned(effects) > before || pooled(effects) > pools;
}

/** The (element, kind, actionId) table: every Vesper and Sakda clip with the cue kinds the kits draw for it. */
interface Row { readonly element: 'umbral' | 'ember'; readonly action: string; readonly kind: StoryCue['kind']; readonly phase: StoryCue['phase']; readonly extra?: Partial<StoryCue> }
const slash = { position: { x: 0, y: 0, z: 0 }, footprint: { width: 2.6, length: 2.6, angleRadians: 0.4, sectorRadians: 2.44 }, durationTicks: 6 } satisfies Partial<StoryCue>;
const blinkGeometry = { from, to, durationTicks: 14 } satisfies Partial<StoryCue>;
const TABLE: readonly Row[] = [
  // Vesper
  ...['vesper-iai-1', 'vesper-iai-2', 'vesper-iai-3'].map((action): Row => ({ element: 'umbral', action, kind: 'slash', phase: 'active', extra: slash })),
  { element: 'umbral', action: 'vesper-iai-4', kind: 'beam', phase: 'active', extra: { ...blinkGeometry, footprint: { width: 0.6, length: 5 } } },
  { element: 'umbral', action: 'vesper-shadow-step', kind: 'blink', phase: 'commit', extra: blinkGeometry },
  { element: 'umbral', action: 'vesper-cuts-charge', kind: 'sigil', phase: 'sustain', extra: { position: from, durationTicks: 600 } },
  { element: 'umbral', action: 'vesper-thousand-cuts', kind: 'slash', phase: 'active', extra: { ...slash, durationTicks: 72 } },
  { element: 'umbral', action: 'vesper-thousand-cuts', kind: 'blink', phase: 'commit', extra: blinkGeometry },
  { element: 'umbral', action: 'vesper-kunai-fan', kind: 'projectile', phase: 'commit', extra: { from: { x: 0, y: 1, z: 0 }, to: { x: 8, y: 1, z: 0 } } },
  { element: 'umbral', action: 'vesper-kunai-fan', kind: 'projectile-impact', phase: 'hit', extra: { position: at, scopeId: 'kunai:1', targetId: 'boar' as ActorSnapshot['targetId'] } },
  { element: 'umbral', action: 'vesper-shade-charge', kind: 'sigil', phase: 'sustain', extra: { position: from, durationTicks: 600 } },
  { element: 'umbral', action: 'vesper-shade-swap', kind: 'beam', phase: 'active', extra: { ...blinkGeometry, footprint: { width: 1.4, length: 8 } } },
  { element: 'umbral', action: 'vesper-shade-swap', kind: 'blink', phase: 'commit', extra: blinkGeometry },
  { element: 'umbral', action: 'vesper-severing-shadow', kind: 'tether', phase: 'active', extra: { from, to, targetId: 'boar' as ActorSnapshot['targetId'] } },
  { element: 'umbral', action: 'vesper-cleanse', kind: 'cleanse', phase: 'active', extra: { position: at, targetId: 'boar' as ActorSnapshot['targetId'] } },
  { element: 'umbral', action: 'vesper-mist-blink', kind: 'blink', phase: 'commit', extra: blinkGeometry },
  { element: 'umbral', action: 'vesper-requiem', kind: 'judgement', phase: 'anticipation', extra: { position: from, durationTicks: 12 } },
  { element: 'umbral', action: 'vesper-requiem', kind: 'blink', phase: 'commit', extra: blinkGeometry },
  { element: 'umbral', action: 'vesper-requiem', kind: 'judgement-mark', phase: 'anticipation', extra: { position: at, scopeId: 'mark:1', durationTicks: 90 } },
  { element: 'umbral', action: 'vesper-requiem', kind: 'judgement-mark', phase: 'hit', extra: { position: at, scopeId: 'mark:2', intensity: 1.6 } },
  { element: 'umbral', action: 'vesper-iai-1', kind: 'hit', phase: 'hit', extra: { position: at, to: { x: 5, y: 0.9, z: -3 }, targetId: 'boar' as ActorSnapshot['targetId'] } },
  // Sakda
  ...['sakda-limb-1', 'sakda-limb-2', 'sakda-limb-3'].map((action): Row => ({ element: 'ember', action, kind: 'slash', phase: 'active', extra: { ...slash, footprint: { width: 2, length: 2, angleRadians: 0.2, sectorRadians: 2 }, durationTicks: 8 } })),
  { element: 'ember', action: 'sakda-limb-4', kind: 'slash', phase: 'active', extra: { ...slash, footprint: { width: 5, length: 2.6, angleRadians: 0, sectorRadians: 3.49 }, durationTicks: 13 } },
  { element: 'ember', action: 'sakda-echo-wave', kind: 'projectile', phase: 'commit', extra: { from: { x: 0, y: 1, z: 0 }, to: { x: 8, y: 1, z: 0 } } },
  { element: 'ember', action: 'sakda-echo-wave', kind: 'projectile-impact', phase: 'hit', extra: { position: at, scopeId: 'echo:1', targetId: 'boar' as ActorSnapshot['targetId'] } },
  { element: 'ember', action: 'sakda-resonating-strike', kind: 'blink', phase: 'commit', extra: blinkGeometry },
  { element: 'ember', action: 'sakda-resonating-strike', kind: 'hit', phase: 'hit', extra: { position: at, targetId: 'boar' as ActorSnapshot['targetId'] } },
  { element: 'ember', action: 'sakda-elbow-charge', kind: 'sigil', phase: 'sustain', extra: { position: from, durationTicks: 600 } },
  { element: 'ember', action: 'sakda-hundred-elbows', kind: 'hit', phase: 'hit', extra: { position: at, targetId: 'boar' as ActorSnapshot['targetId'] } },
  { element: 'ember', action: 'sakda-tempest', kind: 'slash', phase: 'active', extra: { position: at, footprint: { width: 8, length: 8 }, durationTicks: 12 } },
  { element: 'ember', action: 'sakda-knee-charge', kind: 'sigil', phase: 'sustain', extra: { position: from, durationTicks: 600 } },
  { element: 'ember', action: 'sakda-flying-knee', kind: 'blink', phase: 'commit', extra: { ...blinkGeometry, durationTicks: 26 } },
  { element: 'ember', action: 'sakda-flying-knee', kind: 'slash', phase: 'active', extra: { position: at, footprint: { width: 6, length: 6 }, durationTicks: 12 } },
  { element: 'ember', action: 'sakda-iron-clinch', kind: 'tether', phase: 'active', extra: { from, to, targetId: 'boar' as ActorSnapshot['targetId'] } },
  { element: 'ember', action: 'sakda-cleanse', kind: 'cleanse', phase: 'active', extra: { position: at, targetId: 'boar' as ActorSnapshot['targetId'] } },
  { element: 'ember', action: 'sakda-guard-dash', kind: 'blink', phase: 'commit', extra: blinkGeometry },
  { element: 'ember', action: 'sakda-tigers-wrath', kind: 'slash', phase: 'active', extra: { ...slash, footprint: { width: 6, length: 3, angleRadians: 0, sectorRadians: 6.28 }, durationTicks: 10 } },
  { element: 'ember', action: 'sakda-tigers-wrath', kind: 'beam', phase: 'active', extra: { ...blinkGeometry, durationTicks: 20 } },
  { element: 'ember', action: 'sakda-tigers-wrath', kind: 'hit', phase: 'hit', extra: { position: at, to: { x: 9, y: 0.9, z: -3 }, targetId: 'boar' as ActorSnapshot['targetId'] } },
];
const rowCue = (row: Row, tick = 10, scopeId?: string): StoryCue => cue({ element: row.element, actionId: row.action as ActionId, kind: row.kind, phase: row.phase, ...row.extra, ...(scopeId ? { scopeId } : {}) }, tick);

describe('Vesper and Sakda palette', () => {
  it('umbral and ember are real elements with their own ground-shader index and HDR-capped colours', () => {
    expect(ELEMENT_INDEX.umbral).toBe(12);
    expect(ELEMENT_INDEX.ember).toBe(13);
    expect(new Set(Object.values(ELEMENT_INDEX)).size).toBe(Object.keys(ELEMENT_INDEX).length);
    for (const palette of [PALETTE.umbral, PALETTE.ember]) for (const color of [palette.a, palette.b, palette.hot]) expect(Math.max(color.r, color.g, color.b)).toBeLessThanOrEqual(HDR_DOMINANT_MAX);
    // Violet core, crimson rim; flame orange, gold highlight.
    expect(PALETTE.umbral.b.b).toBeGreaterThan(PALETTE.umbral.b.r * 3);
    expect(UMBRAL_RIM.body.r).toBeGreaterThan(UMBRAL_RIM.body.b * 5);
    expect(PALETTE.ember.b.r).toBeGreaterThan(PALETTE.ember.b.g * 3);
    expect(EMBER_GOLD.hot.g).toBeGreaterThan(EMBER_GOLD.hot.b * 3);
  });
});

describe('kit resolution', () => {
  it('every Vesper and Sakda clip id resolves, for every cue kind, to a kit of its own family (never Aren, Yara or a monster kit)', () => {
    const kinds: StoryCue['kind'][] = ['slash', 'hit', 'blink', 'beam', 'sigil', 'projectile', 'projectile-impact', 'tether', 'cleanse', 'judgement', 'judgement-mark', 'bloom'];
    for (const [element, clips, isOwn] of [['umbral', UMBRAL_CLIPS, isUmbralKit], ['ember', EMBER_CLIPS, isEmberKit]] as const) {
      expect(clips.length).toBeGreaterThanOrEqual(14);
      for (const clip of clips) for (const kind of kinds) {
        const resolved = resolveKit(cue({ element, actionId: clip as ActionId, kind, phase: 'hit' }));
        expect(isOwn(resolved.kit), `${clip}/${kind}`).toBe(true);
        expect(isHeartrootKit(resolved.kit)).toBe(false);
        expect(resolved.element).toBe(element);
        expect(resolved.attack).toBe(false);
      }
    }
  });

  it('distinct skills resolve to distinct kits so every skill has its own look; the shared dodge ids fall back to the blink kit of the hero', () => {
    const kit = (element: 'umbral' | 'ember', action: string): string => resolveKit(cue({ element, actionId: action as ActionId, kind: 'hit', phase: 'hit' })).kit;
    const umbral = ['vesper-iai-1', 'vesper-iai-4', 'vesper-shadow-step', 'vesper-thousand-cuts', 'vesper-kunai-fan', 'vesper-shade-swap', 'vesper-severing-shadow', 'vesper-cleanse', 'vesper-mist-blink', 'vesper-requiem'].map(action => kit('umbral', action));
    expect(new Set(umbral).size).toBe(umbral.length);
    expect(kit('umbral', 'vesper-iai-1')).toBe(kit('umbral', 'vesper-iai-3'));
    expect(kit('umbral', 'vesper-cuts-charge')).toBe(kit('umbral', 'vesper-thousand-cuts'));
    const ember = ['sakda-limb-1', 'sakda-limb-4', 'sakda-echo-wave', 'sakda-resonating-strike', 'sakda-hundred-elbows', 'sakda-tempest', 'sakda-flying-knee', 'sakda-iron-clinch', 'sakda-cleanse', 'sakda-guard-dash', 'sakda-tigers-wrath'].map(action => kit('ember', action));
    expect(new Set(ember).size).toBe(ember.length);
    expect(kit('ember', 'sakda-limb-2')).toBe(kit('ember', 'sakda-limb-3'));
    const dodge = (element: 'umbral' | 'ember'): string => resolveKit(cue({ element, actionId: 'aren-forward-left-dive-roll' as ActionId, kind: 'blink', phase: 'commit' })).kit;
    expect(dodge('umbral')).toBe(kit('umbral', 'vesper-mist-blink'));
    expect(dodge('ember')).toBe(kit('ember', 'sakda-guard-dash'));
  });

  it('Aren and Yara cues keep their own kits', () => {
    expect(isHeartrootKit(resolveKit(cue({ element: 'heartroot', actionId: 'yara-sap-lance' as ActionId, kind: 'beam', phase: 'active' })).kit)).toBe(true);
    expect(resolveKit(cue({ element: 'arcane', kind: 'slash', phase: 'active' })).kit).toBe('slash');
  });
});

describe('Vesper and Sakda cue kits', () => {
  it('every (element, kind, actionId) row draws something visible and never throws', () => {
    const effects = new StoryEffects({ scene: new Scene() });
    try {
      for (const row of TABLE) {
        const emit = rowCue(row);
        expect(drew(effects, emit), `${row.element}/${row.kind}/${row.action}`).toBe(true);
        clock(effects, 11);
      }
    } finally { effects.dispose(); }
  });

  it('every row is cancelled with its scope and leaves nothing in the pools; cancelling everything clears the system', () => {
    const effects = new StoryEffects({ scene: new Scene() });
    try {
      for (const row of TABLE) {
        const scope = `scope:${row.action}:${row.kind}:${row.phase}`;
        effects.emit(rowCue(row, 10, scope));
        clock(effects, 11);
        effects.cancelScope(scope, 'interrupt');
        expect(effects.activeCount, `${row.action}/${row.kind}`).toBe(0);
        expect(pooled(effects), `${row.action}/${row.kind}`).toBe(0);
      }
      for (const row of TABLE) effects.emit(rowCue(row, 10, `all:${row.action}:${row.kind}:${row.phase}`));
      effects.cancelAll('load');
      expect(effects.activeCount).toBe(0);
      expect(pooled(effects)).toBe(0);
    } finally { effects.dispose(); }
  });

  it('the pooled spire/shadow modules die with their scope', () => {
    const effects = new StoryEffects({ scene: new Scene() });
    try {
      /** Visible spire instances of the Vesper shadow-blade and Sakda flame-spire modules (hidden instances have a zero-scale matrix). */
      const visibleSpires = (): number => {
        let visible = 0;
        effects.group.traverse(node => {
          if (!(node instanceof InstancedMesh) || !/^vfx-(ember-pillars|umbral-shadows)$/.test(node.name)) return;
          for (let i = 0; i < node.count; i++) if (Math.abs(node.instanceMatrix.array[i * 16]!) > 1e-6) visible++;
        });
        return visible;
      };
      effects.emit(rowCue(TABLE.find(row => row.action === 'sakda-tempest')!, 10, 'stomp:1'));
      effects.emit(rowCue(TABLE.find(row => row.action === 'vesper-requiem' && row.phase === 'hit')!, 10, 'requiem:1'));
      clock(effects, 12);
      expect(visibleSpires()).toBeGreaterThan(0);
      effects.cancelScope('stomp:1', 'interrupt'); effects.cancelScope('requiem:1', 'interrupt');
      clock(effects, 13);
      expect(visibleSpires()).toBe(0);
    } finally { effects.dispose(); }
  });

  it('reduced effects keep every kit running with fewer particles', () => {
    const full = new StoryEffects({ scene: new Scene() }), reduced = new StoryEffects({ scene: new Scene(), reducedEffects: true });
    try {
      let fullTotal = 0, reducedTotal = 0;
      for (const row of TABLE) {
        const a = spawned(full), b = spawned(reduced), pools = pooled(reduced);
        full.emit(rowCue(row)); reduced.emit(rowCue(row));
        const fullCount = spawned(full) - a, reducedCount = spawned(reduced) - b;
        fullTotal += fullCount; reducedTotal += reducedCount;
        expect(reducedCount, `${row.action}/${row.kind}`).toBeLessThanOrEqual(fullCount);
        // Reduced mode never silences a kit: it still draws particles or its pooled resources (a charge sigil, a crescent, a lane).
        expect(reducedCount > 0 || pooled(reduced) > pools, `${row.action}/${row.kind}`).toBe(true);
      }
      expect(reducedTotal).toBeGreaterThan(0);
      expect(reducedTotal).toBeLessThan(fullTotal);
    } finally { full.dispose(); reduced.dispose(); }
  });

  it('a kunai or echo impact draws once: the same-tick hit cue for the same contact adds no second burst but still rims the target', () => {
    for (const [element, action] of [['umbral', 'vesper-kunai-fan'], ['ember', 'sakda-echo-wave']] as const) {
      const impact = sink(), effects = new StoryEffects({ scene: new Scene(), impact });
      try {
        effects.emit(cue({ element, actionId: action as ActionId, kind: 'projectile-impact', phase: 'hit', position: at, scopeId: `${action}:1`, targetId: 'boar' as ActorSnapshot['targetId'] }, 30));
        const afterImpact = spawned(effects), shakes = impact.shakes.length;
        expect(afterImpact).toBeGreaterThan(0);
        effects.emit(cue({ element, actionId: action as ActionId, kind: 'hit', phase: 'hit', position: at, targetId: 'boar' as ActorSnapshot['targetId'] }, 30));
        expect(spawned(effects)).toBe(afterImpact);
        expect(impact.shakes.length).toBe(shakes);
        expect(impact.rims.filter(entry => entry === 'boar:hit').length).toBeGreaterThanOrEqual(1);
        // Another tick, another target, and a second contact of the same tick are independent.
        const grew = (emit: StoryCue): boolean => { const before = spawned(effects); effects.emit(emit); return spawned(effects) > before; };
        expect(grew(cue({ element, actionId: action as ActionId, kind: 'hit', phase: 'hit', position: at, targetId: 'boar' as ActorSnapshot['targetId'] }, 31))).toBe(true);
        expect(grew(cue({ element, actionId: action as ActionId, kind: 'hit', phase: 'hit', position: at, targetId: 'boar' as ActorSnapshot['targetId'] }, 30))).toBe(true);
      } finally { effects.dispose(); }
    }
  });

  it('Requiem releases once per marked target even when its damage hit follows the mark cue', () => {
    const impact = sink(), effects = new StoryEffects({ scene: new Scene(), impact });
    try {
      const contact = { element: 'umbral', actionId: 'vesper-requiem' as ActionId, phase: 'hit', position: at, targetId: 'boar' as ActorSnapshot['targetId'], intensity: 2.4 } as const;
      effects.emit(cue({ ...contact, kind: 'judgement-mark', scopeId: 'requiem:release' }, 110));
      expect(impact.shakes).toHaveLength(1);
      effects.emit(cue({ ...contact, kind: 'hit', confirmedDamage: 45 }, 110));
      // The shared confirmed-hit overlay still draws; only the heavyweight ritual release is deduplicated.
      expect(impact.impulses).toEqual([0.6]);
      expect(impact.shakes).toHaveLength(1);
      expect(impact.rims).toContain('boar:hit');
      // A different victim and a later release must not be swallowed by the contact ledger.
      effects.emit(cue({ ...contact, kind: 'hit', targetId: 'stag' as ActorSnapshot['targetId'], confirmedDamage: 45 }, 110));
      effects.emit(cue({ ...contact, kind: 'hit', confirmedDamage: 45 }, 111));
      expect(impact.shakes).toHaveLength(3);
    } finally { effects.dispose(); }
  });

  it("Sakda's elbow barrage raises the uppercut pillar on the closing hit only", () => {
    const effects = new StoryEffects({ scene: new Scene() });
    try {
      const hit = (tick: number): number => { const before = spawned(effects); effects.emit(cue({ element: 'ember', actionId: 'sakda-hundred-elbows' as ActionId, kind: 'hit', phase: 'hit', position: at, targetId: 'boar' as ActorSnapshot['targetId'] }, tick)); return spawned(effects) - before; };
      const sizes: number[] = [];
      for (let i = 0; i < 7; i++) sizes.push(hit(10 + i * 6));
      expect(Math.max(...sizes.slice(0, 6))).toBeLessThan(sizes[6]!);
      // A new barrage after a pause starts counting from zero.
      expect(hit(200)).toBeLessThan(sizes[6]!);
    } finally { effects.dispose(); }
  });

  it('saturating Vesper and Sakda cues stays within two particle draw calls and the pool capacity', () => {
    const effects = new StoryEffects({ scene: new Scene(), capacity: 48 });
    try {
      let draws = 0;
      effects.group.traverse(node => { if (node instanceof Mesh && node.name.startsWith('vfx-particles')) draws++; });
      expect(draws).toBe(2);
      for (let wave = 0; wave < 30; wave++) for (const row of TABLE) {
        effects.emit(rowCue(row, wave * 6));
        clock(effects, wave * 6 + 1);
        expect(effects.vfx.particles.liveCount(effects.vfx.time)).toBeLessThanOrEqual(effects.vfx.particles.capacity);
      }
      expect(effects.activeCount).toBeLessThanOrEqual(48);
    } finally { effects.dispose(); }
  });

  it('disposal leaves nothing in the scene', () => {
    const scene = new Scene(), effects = new StoryEffects({ scene });
    for (const row of TABLE) effects.emit(rowCue(row));
    effects.dispose();
    expect(scene.children.length).toBe(0);
  });
});

// ---- snapshot-driven pass ----

function actor(partial: Partial<ActorSnapshot> & { id: string }): ActorSnapshot {
  return {
    archetypeId: partial.id, species: 'x', allegiance: 'hostile', position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 0, y: 0, z: 1 }, actionId: 'idle', phase: 'idle',
    normalizedTime: 0, sockets: {}, interactionRequirements: [], visible: true, downed: false, possessed: false, ...partial,
  } as ActorSnapshot;
}
interface SnapshotExtra { readonly hero?: 'vesper' | 'sakda'; readonly actors?: ActorSnapshot[]; readonly projectiles?: PlayerProjectileSnapshot[]; readonly player?: Record<string, unknown>; readonly aren?: Partial<ActorSnapshot> }
function snapshot(tick: number, extra: SnapshotExtra = {}): CombatSnapshot {
  return {
    actors: [actor({ id: 'aren', allegiance: 'player', ...extra.aren }), ...(extra.actors ?? [])], playerProjectiles: extra.projectiles,
    player: { heroId: extra.hero ?? 'vesper', vitality: 80, maxVitality: 80, instinct: 0, mana: 100, maxMana: 100, ...extra.player },
    worldClock: { simulationTick: tick, worldTick: tick, worldTimeSeconds: tick / 60, timeScale: 1, policy: 'normal' },
  } as unknown as CombatSnapshot;
}
const mark = (kind: HeroMarkSnapshot['kind'], remainingTicks = 120, stacks?: number): HeroMarkSnapshot => ({ kind, remainingTicks, ...(stacks === undefined ? {} : { stacks }) });
const projectile = (kind: PlayerProjectileSnapshot['kind'], x: number, age: number, radius = 0.4): PlayerProjectileSnapshot => ({ id: `${kind}:1`, kind, ownerId: 'aren', position: { x, y: 1, z: 0 }, direction: { x: 1, y: 0, z: 0 }, speed: 22, radius, ageTicks: age, lifeTicks: 60 });

describe('Vesper and Sakda snapshot-driven effects', () => {
  it('hostile hero marks draw their own sprites: stack pips grow with the stacks, and every mark kind is distinct from the others', () => {
    const effects = new StoryEffects({ scene: new Scene() });
    try {
      const w = effects.warden;
      const used = (marks: HeroMarkSnapshot[], tick: number): number => {
        clock(effects, tick);
        w.updateCombat(snapshot(tick, { actors: [actor({ id: 'boar', heroMarks: marks })] }), 0);
        return w.sprites.used;
      };
      const none = used([], 1);
      const stack1 = used([mark('death-stack', 120, 1)], 2), stack3 = used([mark('death-stack', 120, 3)], 3);
      expect(stack1).toBeGreaterThan(none);
      expect(stack3).toBeGreaterThan(stack1);
      const counts = [used([mark('death-mark')], 4), used([mark('echo-mark')], 5), used([mark('requiem-mark')], 6), used([mark('cripple')], 7)];
      for (const count of counts) expect(count).toBeGreaterThan(none);
      expect(new Set([stack3, ...counts]).size).toBe(5);
      // Hidden or downed targets draw nothing.
      clock(effects, 8);
      w.updateCombat(snapshot(8, { actors: [actor({ id: 'boar', heroMarks: [mark('death-mark')], downed: true })] }), 0);
      expect(w.sprites.used).toBe(none);
    } finally { effects.dispose(); }
  });

  it('a Death Mark consumed with time left bursts as a Shadow Execution; one that merely runs out does not', () => {
    const impact = sink(), effects = new StoryEffects({ scene: new Scene(), impact });
    try {
      const w = effects.warden;
      const step = (tick: number, marks: HeroMarkSnapshot[]): void => { clock(effects, tick); w.updateCombat(snapshot(tick, { actors: [actor({ id: 'boar', heroMarks: marks })] }), 0); };
      step(1, [mark('death-mark', 200)]);
      step(2, [mark('death-mark', 199)]);
      const before = spawned(effects);
      step(3, []);
      expect(spawned(effects)).toBeGreaterThan(before);
      expect(impact.rims).toContain('boar:hit');
      const rims = impact.rims.length, afterBurst = spawned(effects);
      step(4, [mark('death-mark', 2)]);
      step(5, []);
      expect(spawned(effects)).toBe(afterBurst);
      expect(impact.rims.length).toBe(rims);
    } finally { effects.dispose(); }
  });

  it('kunai, echo-wave and shade-clone projectiles each draw, follow the snapshot and release when it drops them', () => {
    const effects = new StoryEffects({ scene: new Scene() });
    try {
      const w = effects.warden;
      for (const kind of ['kunai', 'echo-wave', 'shade-clone'] as const) {
        clock(effects, 1);
        w.updateCombat(snapshot(1, { projectiles: [projectile(kind, 1, 0)] }), 0);
        expect(w.projectiles.map(visual => visual.kind)).toEqual([kind]);
        expect(w.sprites.used, kind).toBeGreaterThan(0);
        if (kind === 'echo-wave') expect(w.crescents.activeCount(effects.vfx.time)).toBe(1);
        else expect(w.lines.usedPoints, kind).toBeGreaterThan(0);
        clock(effects, 2);
        w.updateCombat(snapshot(2, { projectiles: [projectile(kind, 1.4, 1)] }), 1);
        expect(w.projectiles[0]!.display.x).toBeCloseTo(1.4, 5);
        clock(effects, 3);
        w.updateCombat(snapshot(3), 0);
        expect(w.projectiles).toHaveLength(0);
        expect(w.crescents.activeCount(effects.vfx.time)).toBe(0);
      }
    } finally { effects.dispose(); }
  });

  it('an impact cue ends the kunai and echo-wave visuals', () => {
    const effects = new StoryEffects({ scene: new Scene() });
    try {
      const w = effects.warden;
      clock(effects, 1);
      w.updateCombat(snapshot(1, { projectiles: [projectile('echo-wave', 1, 0)] }), 0);
      expect(w.projectiles).toHaveLength(1);
      effects.emit(cue({ element: 'ember', actionId: 'sakda-echo-wave' as ActionId, kind: 'projectile-impact', phase: 'hit', position: at, scopeId: 'echo-wave:1' }, 2));
      expect(w.projectiles).toHaveLength(0);
      expect(w.crescents.activeCount(effects.vfx.time)).toBe(0);
    } finally { effects.dispose(); }
  });

  it('the flame shield bubble draws while a shield remains and bursts when it is spent; the flurry glow lights both fists', () => {
    const scene = new Scene(), fists: Record<string, Object3D> = { 'fist-left': new Object3D(), 'fist-right': new Object3D() };
    fists['fist-left']!.position.set(-0.4, 1.2, 0.4); fists['fist-right']!.position.set(0.4, 1.2, 0.4);
    for (const fist of Object.values(fists)) scene.add(fist);
    const effects = new StoryEffects({ scene, resolveSocket: (_id, name) => fists[name] });
    try {
      const w = effects.warden;
      const draw = (tick: number, player: Record<string, unknown>): number => { clock(effects, tick); w.updateCombat(snapshot(tick, { hero: 'sakda', player }), 0); return w.sprites.used; };
      const plain = draw(1, {});
      const shielded = draw(2, { shield: 25 });
      expect(shielded).toBeGreaterThan(plain);
      const before = spawned(effects);
      expect(draw(3, {})).toBe(plain);
      expect(spawned(effects)).toBeGreaterThan(before);
      const fluttering = draw(4, { flurryCharges: 2 });
      expect(fluttering).toBeGreaterThan(plain);
      expect(draw(5, { flurryCharges: 1 })).toBe(fluttering);
    } finally { effects.dispose(); }
  });

  it('untargetable Vesper sheds ink wisps and untargetable Sakda sheds embers; nothing otherwise', () => {
    for (const hero of ['vesper', 'sakda'] as const) {
      const effects = new StoryEffects({ scene: new Scene() });
      try {
        const w = effects.warden;
        for (let tick = 1; tick <= 3; tick++) { clock(effects, tick); w.updateCombat(snapshot(tick, { hero }), 0); }
        const calm = spawned(effects);
        for (let tick = 4; tick <= 12; tick++) { clock(effects, tick); w.updateCombat(snapshot(tick, { hero, player: { untargetable: true } }), 0); }
        expect(spawned(effects), hero).toBeGreaterThan(calm);
      } finally { effects.dispose(); }
    }
  });

  it("Sakda's limb trails follow the fist and foot sockets while a strike clip runs, and only the limbs that strike", () => {
    const scene = new Scene(), sockets: Record<string, Object3D> = {};
    for (const name of ['fist-left', 'fist-right', 'foot-left', 'foot-right', 'root']) { sockets[name] = new Object3D(); scene.add(sockets[name]!); }
    const effects = new StoryEffects({ scene, resolveSocket: (_id, name) => sockets[name] });
    try {
      const w = effects.warden;
      expect(SAKDA_LIMB_MASKS['sakda-limb-3']).toBe(8);
      const step = (tick: number, action: string): number => {
        sockets['foot-right']!.position.set(tick * 0.2, 0.4, 0); sockets['fist-right']!.position.set(0, 1.2, tick * 0.2);
        clock(effects, tick);
        w.updateCombat(snapshot(tick, { hero: 'sakda', aren: { actionId: action as ActionId, phase: 'active' } }), 0);
        return w.lines.usedPoints;
      };
      for (let tick = 1; tick <= 4; tick++) expect(step(tick, 'aren-idle')).toBe(0);
      let knee = 0;
      for (let tick = 5; tick <= 9; tick++) knee = step(tick, 'sakda-limb-3');
      expect(knee).toBeGreaterThan(1);
      // The knee strike trails only the right foot: the fist moves too but its trail is not drawn.
      expect(knee).toBeLessThanOrEqual(10);
      let after = knee;
      for (let tick = 10; tick <= 40; tick++) after = step(tick, 'aren-idle');
      expect(after).toBe(0);
    } finally { effects.dispose(); }
  });

  it("Vesper's katana edge trails through the weapon sockets during a strike clip and stops after it", () => {
    const scene = new Scene(), tip = new Object3D(), base = new Object3D();
    scene.add(tip, base);
    const effects = new StoryEffects({ scene, resolveSocket: (_id, name) => name === 'weapon-tip' ? tip : name === 'weapon-base' ? base : undefined });
    try {
      const w = effects.warden;
      expect(VESPER_BLADE_CLIPS['vesper-iai-2']).toBe(true);
      const step = (tick: number, action: string): number => {
        base.position.set(tick * 0.1, 1, 0); tip.position.set(tick * 0.1, 1, 1);
        clock(effects, tick);
        w.updateCombat(snapshot(tick, { hero: 'vesper', aren: { actionId: action as ActionId, phase: 'active' } }), 0);
        return w.trail.visibleRows;
      };
      for (let tick = 1; tick <= 4; tick++) step(tick, 'aren-idle');
      expect(w.trail.visibleRows).toBe(0);
      let rows = 0;
      for (let tick = 5; tick <= 10; tick++) rows = step(tick, 'vesper-iai-2');
      expect(rows).toBeGreaterThanOrEqual(2);
      expect(w.trailElement).toBe('umbral');
      for (let tick = 11; tick <= 60; tick++) rows = step(tick, 'aren-idle');
      expect(rows).toBe(0);
    } finally { effects.dispose(); }
  });
});

describe('actor effects per hero', () => {
  function actorSnapshot(partial: Partial<ActorSnapshot>): ActorSnapshot {
    return actor({ id: 'aren', allegiance: 'player', actionId: 'aren-idle' as ActionId, ...partial });
  }
  function playerStep(presentation: StoryPresentation, tick: number, partial: Partial<ActorSnapshot>): void {
    presentation.update({ simulationTick: tick, worldTick: tick, worldTimeSeconds: tick / 60, timeScale: 1, policy: 'normal' });
    presentation.updateActors([actorSnapshot(partial)]);
    presentation.effects.vfx.update(tick / 60);
  }

  it('updateCombat follows the snapshot hero for all four heroes', () => {
    const presentation = new StoryPresentation({ scene: new Scene() });
    try {
      for (const hero of ['aren', 'yara', 'vesper', 'sakda'] as const) {
        presentation.updateCombat({ actors: [actorSnapshot({})], player: { heroId: hero }, worldClock: { simulationTick: 1, worldTick: 1, worldTimeSeconds: 1 / 60, timeScale: 1, policy: 'normal' } } as unknown as CombatSnapshot, 0);
        expect(presentation.effects.warden.player.hero).toBe(hero);
      }
    } finally { presentation.dispose(); }
  });

  it('every hero ripples a ground disc at its boosted-jump air steps in its own element, with its own particles', () => {
    const elements: Record<string, number> = {};
    for (const hero of ['aren', 'yara', 'vesper', 'sakda'] as const) {
      const presentation = new StoryPresentation({ scene: new Scene() });
      try {
        presentation.actors.setHero(hero);
        const before = presentation.effects.vfx.particles.additive.nextSlot + presentation.effects.vfx.particles.alpha.nextSlot;
        playerStep(presentation, 10, { actionId: 'aren-jump' as ActionId, phase: 'startup', jumpPhase: 'takeoff', jumpBoosted: true, facing: { x: 1, y: 0, z: 0 } });
        playerStep(presentation, 11, { actionId: 'aren-jump' as ActionId, phase: 'active', jumpPhase: 'rising', jumpPhaseProgress: 0.05, jumpBoosted: true, facing: { x: 1, y: 0, z: 0 } });
        let shocks = 0;
        presentation.effects.group.traverse(node => {
          if (!(node instanceof Mesh) || node.name !== 'vfx-ground-shock' || !node.visible) return;
          shocks++;
          if (node.material instanceof ShaderMaterial) elements[hero] = node.material.uniforms.uElement!.value as number;
        });
        expect(shocks, hero).toBe(1);
        expect(presentation.effects.vfx.particles.additive.nextSlot + presentation.effects.vfx.particles.alpha.nextSlot - before, hero).toBeGreaterThan(0);
      } finally { presentation.dispose(); }
    }
    expect(elements).toEqual({ aren: ELEMENT_INDEX.arcane, yara: ELEMENT_INDEX.heartroot, vesper: ELEMENT_INDEX.umbral, sakda: ELEMENT_INDEX.ember });
  });

  it('every shared dodge clip counts as a dodge for the dust, vanish burst and speed streaks', () => {
    for (const hero of ['vesper', 'sakda'] as const) {
      // One presentation per hero (each build compiles the full effect system); an idle frame between clips ends the previous dodge.
      const presentation = new StoryPresentation({ scene: new Scene() });
      try {
        presentation.actors.setHero(hero);
        let tick = 1;
        for (const action of ['aren-forward-left-dive-roll', 'aren-perfect-dodge-right', 'aren-quick-step-left', 'aren-left-cartwheel', 'aren-low-slide']) {
          playerStep(presentation, tick, { actionId: 'aren-idle' as ActionId });
          const before = presentation.effects.vfx.particles.additive.nextSlot + presentation.effects.vfx.particles.alpha.nextSlot;
          playerStep(presentation, tick + 1, { actionId: action as ActionId, velocity: { x: 6, y: 0, z: 0 } });
          playerStep(presentation, tick + 7, { actionId: action as ActionId, velocity: { x: 6, y: 0, z: 0 } });
          expect(presentation.effects.vfx.particles.additive.nextSlot + presentation.effects.vfx.particles.alpha.nextSlot, `${hero}/${action}`).toBeGreaterThan(before);
          tick += 60;
        }
      } finally { presentation.dispose(); }
    }
  });
});
