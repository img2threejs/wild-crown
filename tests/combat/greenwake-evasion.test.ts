import { describe, expect, it } from 'bun:test';
import { CombatEngine, createEngineState, makeActor, type CombatActor, type CombatInput } from '../../src/game/combat/CombatEngine.js';
import { vec } from '../../src/game/combat/geometry.js';
import type { StoryCue } from '../../src/effects/story-cues.js';
import type { ActorId } from '../../src/game/contracts.js';

const idle: CombatInput = {
  tick: 0,
  move: vec(0, 0, 0),
  dodgePressed: false,
  lightPressed: false,
  heavyPressed: false,
  heavyHeld: false,
  heavyReleased: false,
  interactPressed: false,
};

const GREENWAKE_INSTANCES = ['corrupted-boar', 'greenwake-sap-stalker', 'greenwake-root-rammer'] as const;
type GreenwakeInstanceId = (typeof GREENWAKE_INSTANCES)[number];
type GreenwakeCueKind = 'pounce' | 'sap-vein' | 'low-wave';

function makeGreenwakeHostiles(originX = 9, originZ = 0): { boar: CombatActor; sap: CombatActor; root: CombatActor } {
  // All three instances reuse the existing authored Greenwake hostile candidate — same archetype,
  // same asset, same species. No new production assets are introduced.
  const offsets: Record<GreenwakeInstanceId, { x: number; z: number }> = {
    'corrupted-boar': { x: originX, z: originZ },
    'greenwake-sap-stalker': { x: originX - 4, z: originZ + 2 },
    'greenwake-root-rammer': { x: originX + 4, z: originZ - 2 },
  };
  const make = (id: GreenwakeInstanceId): CombatActor => {
    // These are three large boar actors. Greenwake's authored route has a scoped three-large-actor budget.
    return makeActor(id as ActorId, 'boar', 'hostile', vec(offsets[id].x, 0, offsets[id].z), true, false, 100, 'corrupted-boar' as ActorId);
  };
  return { boar: make('corrupted-boar'), sap: make('greenwake-sap-stalker'), root: make('greenwake-root-rammer') };
}

function startGreenwake(playerPosition = vec(9, 0, 3), originX = 9, originZ = 0): CombatEngine {
  const engine = new CombatEngine();
  const player = makeActor('aren', 'human', 'player', playerPosition, false, false, 100);
  const hostiles = makeGreenwakeHostiles(originX, originZ);
  engine.startEncounter({
    encounterId: 'greenwake-boar',
    regionId: 'greenwake',
    runId: 'aren-greenwake-evasion-test',
    companionSlots: {},
    playerPosition,
    actors: [player, hostiles.boar, hostiles.sap, hostiles.root],
  });
  return engine;
}

function stepUntil(engine: CombatEngine, predicate: () => boolean, max = 600): void {
  for (let i = 0; i < max && !predicate(); i++) engine.fixedStep(idle);
}

describe('Greenwake encounter composition', () => {
  it('loads three large Greenwake actor placements under the region-specific budget', () => {
    const engine = new CombatEngine();
    engine.loadRegion({
      regionId: 'greenwake',
      runId: 'greenwake-large-actor-budget',
      presentActorIds: [...GREENWAKE_INSTANCES],
    });
    const wildlife = engine.snapshotState().actors.filter((actor) => GREENWAKE_INSTANCES.includes(actor.id as GreenwakeInstanceId));
    expect(wildlife.map((actor) => actor.id)).toEqual([...GREENWAKE_INSTANCES]);
    expect(wildlife.every((actor) => actor.large)).toBe(true);
  });

  it('keeps the two-large-actor limit in other regions', () => {
    const engine = new CombatEngine();
    const actors = [
      makeActor('aren', 'human', 'player', vec(0, 0, 0), false, false, 100),
      makeActor('asha', 'tiger', 'hostile', vec(4, 0, 0), true, false, 100),
      makeActor('ruun', 'wolf', 'hostile', vec(8, 0, 0), true, false, 100),
      makeActor('ghor', 'crocodile', 'hostile', vec(12, 0, 0), true, false, 100),
    ];
    expect(() => engine.startEncounter({
      encounterId: 'encounter-asha',
      regionId: 'blood-bamboo-valley',
      runId: 'non-greenwake-large-actor-budget',
      actors,
    })).toThrow('Encounter exceeds 2 total large actors.');
  });
  it('loads the three authored Greenwake enemy instance IDs sharing the corrupted-boar archetype', () => {
    const engine = startGreenwake();
    const snapshot = engine.snapshot();
    const ids = snapshot.actors.filter((actor) => actor.allegiance === 'hostile').map((actor) => actor.id);
    expect(ids).toEqual(expect.arrayContaining([...GREENWAKE_INSTANCES]));
    for (const instanceId of GREENWAKE_INSTANCES) {
      const actor = snapshot.actors.find((candidate) => candidate.id === instanceId);
      expect(actor?.archetypeId).toBe('corrupted-boar');
      expect(actor?.species).toBe('boar');
    }
  });


  it('ignores Greenwake sources that are outside the proximity radius', () => {
    const far = startGreenwake(vec(0, 0, 3), 60, 0);
    far.fixedStep(idle);
    expect(far.snapshot().telegraphs.filter((telegraph) => GREENWAKE_INSTANCES.includes(telegraph.sourceId as GreenwakeInstanceId))).toHaveLength(0);
  });
});

describe('Greenwake attack presentation', () => {

  it('shows a distinct localized VFX at the locked target position when an attack becomes active', () => {
    const engine = startGreenwake();
    engine.fixedStep(idle);
    const firstTelegraph = engine.snapshot().telegraphs.find((telegraph) =>
      GREENWAKE_INSTANCES.includes(telegraph.sourceId as GreenwakeInstanceId),
    )!;
    const lockedTarget = firstTelegraph.targetPosition;
    const collected: StoryCue[] = engine.drainPresentationCues();
    for (let i = 0; i < 120 && !collected.some((cue) => cue.kind === 'pounce' || cue.kind === 'sap-vein' || cue.kind === 'low-wave'); i++) {
      engine.fixedStep(idle);
      collected.push(...engine.drainPresentationCues());
    }
    const localized = collected.filter((cue) => cue.kind === 'pounce' || cue.kind === 'sap-vein' || cue.kind === 'low-wave');
    expect(localized.length).toBeGreaterThan(0);
    for (const cue of localized) {
      expect(cue.attackId).toBeUndefined();
      expect(cue.footprint).toBeUndefined();
      expect(cue.phase).toBe('active');
      expect(cue.position?.x).toBeCloseTo(lockedTarget.x, 2);
      expect(cue.position?.y).toBeCloseTo(lockedTarget.y, 2);
      expect(cue.position?.z).toBeCloseTo(lockedTarget.z, 2);
    }
    expect(localized[0]!.durationTicks).toBe(30);
    const source = engine.snapshot().actors.find(actor => actor.id === firstTelegraph.sourceId)!;
    expect(source.actionId).toBe(`wild-crown:${firstTelegraph.attackId}`);
    expect(source.phase).toBe('active');
    expect(source.normalizedTime).toBeGreaterThan(0.5);
  });

  it('keeps distinct physical impact cues for each enemy alongside elemental attacks', () => {
    const engine = startGreenwake();
    const cueBySource = new Map<GreenwakeInstanceId, GreenwakeCueKind>();
    for (let i = 0; i < 800 && cueBySource.size < GREENWAKE_INSTANCES.length; i++) {
      engine.fixedStep(idle);
      for (const cue of engine.drainPresentationCues()) {
        if (
          (cue.kind === 'pounce' || cue.kind === 'sap-vein' || cue.kind === 'low-wave')
          && GREENWAKE_INSTANCES.includes(cue.actorId as GreenwakeInstanceId)
        ) {
          cueBySource.set(cue.actorId as GreenwakeInstanceId, cue.kind);
        }
      }
    }
    expect(cueBySource.get('corrupted-boar')).toBe('pounce');
    expect(cueBySource.get('greenwake-sap-stalker')).toBe('sap-vein');
    expect(cueBySource.get('greenwake-root-rammer')).toBe('low-wave');
  });

});

describe('Greenwake evasion, damage, and dive persistence', () => {
  it('deals damage only when Aren stays inside the committed hazard area', () => {
    const engine = startGreenwake();
    engine.fixedStep(idle);
    stepUntil(engine, () => engine.snapshot().player.vitality < 100 || engine.snapshot().telegraphs.length === 0);
    const startVitality = engine.snapshot().player.vitality;
    expect(startVitality).toBeLessThan(100);
    const damageEvents = engine.consumeEvents().filter((event) => event.kind === 'damage');
    expect(damageEvents.length).toBeGreaterThan(0);
    expect(damageEvents.some((event) => GREENWAKE_INSTANCES.includes(event.targetId as GreenwakeInstanceId))).toBe(true);
  });

  it('lets Aren dive-roll clear of the committed attack without taking damage', () => {
    const engine = startGreenwake(vec(6, 0, 3), 9, 0);
    engine.fixedStep(idle);
    const committed = engine.snapshotState().hazards[0]!;
    const startVitality = engine.snapshot().player.vitality;
    // The committed lane runs from (9,0) toward (6,3). Screen-right/back
    // moves perpendicular to it; screen-right/forward runs into the boar.
    engine.fixedStep({ ...idle, move: vec(1, 0, -1), dodgePressed: true });
    while (engine.snapshotState().worldTick < committed.activeUntil) engine.fixedStep(idle);
    expect(engine.snapshot().player.vitality).toBe(startVitality);
    expect(engine.consumeEvents().filter(event => event.kind === 'damage' && event.actorId === 'aren' && event.attackId === committed.attackId)).toHaveLength(0);
  });

  it('keeps the finite dive clip alive while movement input continues', () => {
    const engine = startGreenwake(vec(6, 0, 6), 9, 0);
    engine.fixedStep(idle);
    // Trigger a forward-right dive roll, then continue holding the move stick during the clip.
    engine.fixedStep({ ...idle, move: vec(1, 0, 1), dodgePressed: true });
    const initial = engine.snapshotState();
    const initialPlayer = initial.actors.find((actor) => actor.id === 'aren')!;
    expect(initialPlayer.actionId).toBe('aren-forward-right-dive-roll');
    expect(initialPlayer.actionEndsTick).toBeGreaterThan(initialPlayer.actionStartedTick);

    const startingX = initialPlayer.position.x;
    const startingZ = initialPlayer.position.z;
    const diveEnd = initialPlayer.actionEndsTick;

    // Continue moving forward-right through the dive's final active tick; the clip must not be
    // replaced by walk/run/strafe until it actually completes.
    for (let i = initial.tick + 1; i < diveEnd; i++) {
      engine.fixedStep({ ...idle, move: vec(1, 0, 1) });
      const aren = engine.snapshotState().actors.find((actor) => actor.id === 'aren')!;
      expect(aren.actionId).toBe('aren-forward-right-dive-roll');
      expect(aren.position.x).toBeGreaterThanOrEqual(startingX);
      expect(aren.position.z).toBeLessThanOrEqual(startingZ);
    }
    // Run one more tick to step past the dive's end and verify locomotion returns to walk/run.
    engine.fixedStep({ ...idle, move: vec(1, 0, 1) });
    const after = engine.snapshotState().actors.find((actor) => actor.id === 'aren')!;
    expect(after.actionId === 'aren-walk' || after.actionId === 'aren-run' || after.actionId === 'aren-strafe' || after.actionId === 'aren-idle').toBe(true);
  });

  it('allows repeated movement+dive sequences without cancelling the finite action', () => {
    const engine = startGreenwake(vec(6, 0, 6), 9, 0);
    engine.fixedStep(idle);
    for (let cycle = 0; cycle < 3; cycle++) {
      engine.fixedStep({ ...idle, move: vec(1, 0, 1), dodgePressed: true });
      const diver = engine.snapshotState().actors.find((actor) => actor.id === 'aren')!;
      expect(diver.actionId).toBe('aren-forward-right-dive-roll');
      const diveEnd = diver.actionEndsTick;
      for (let i = engine.snapshotState().tick + 1; i < diveEnd - 1; i++) {
        engine.fixedStep({ ...idle, move: vec(1, 0, 1) });
        const moving = engine.snapshotState().actors.find((actor) => actor.id === 'aren')!;
        expect(moving.actionId).toBe('aren-forward-right-dive-roll');
      }
    }
  });
});

describe('non-Greenwake attack behavior is preserved', () => {
  it('keeps the existing anticipation cue with attackId and footprint for a non-Greenwake encounter', () => {
    const regionId = 'blood-bamboo-valley' as const;
    const seed = createEngineState();
    seed.lastAttackTick = 10_000;
    const engine = new CombatEngine(seed);
    engine.startEncounter({
      encounterId: 'camp-hunters',
      regionId,
      runId: 'non-greenwake-cue-test',
      companionSlots: {},
    });
    engine.fixedStep(idle);
    const cues = engine.drainPresentationCues();
    const anticipation = cues.find((cue) => cue.kind === 'anticipation' && cue.attackId);
    expect(anticipation).toBeDefined();
    expect(anticipation!.footprint).toBeDefined();
  });
});
