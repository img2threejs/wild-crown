import type { ActorSnapshot } from '../../src/game/contracts.js';
import { ASSET_PLAYTESTS } from '../../src/app/AssetPlaytests.js';
import { REGIONS } from '../../src/content/campaign.js';
import type { StoryCue } from '../../src/effects/story-cues.js';
import type { HeroId } from '../../src/game/heroes.js';
import type { ActorId, RegionColliderDefinition, Vec3 } from '../../src/game/contracts.js';
import { CombatEngine, createEngineState, type CombatActor, type CombatEvent, type CombatInput, type EngineState, type LiveHazard } from '../../src/game/combat/CombatEngine.js';
import { ATTACKS, type AttackDefinition } from '../../src/game/combat/content.js';
import { vec } from '../../src/game/combat/geometry.js';
import { createCombatTrialRegion } from '../../src/game/combat/TrialRegions.js';
import type { HitSpec } from '../../src/game/combat/reactions.js';

export const idleInput: CombatInput = { tick: 0, move: vec(0, 0, 0), dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };
const playtest = ASSET_PLAYTESTS.find(candidate => candidate.regionId === 'greenwake')!;

/** Engine internals the reaction tests reach into (the other combat tests read the live state the same way). */
export interface ReactionInternals {
  state: EngineState;
  beginAttack(source: unknown, definition: AttackDefinition): LiveHazard | undefined;
  strikeHostile(target: unknown, strike: Record<string, unknown>): number;
}

export interface ReactionRigOptions {
  /** Greenwake trial stage: 0 Ember Boar (heavy), 1 Frost Sap-Stalker (light), 2 Root Rammer (the stage boss). */
  stage?: 0 | 1 | 2;
  hero?: HeroId;
  /** Metres between the hero and the monster along z (the hero stands on the +z side facing -z). */
  distance?: number;
  /** Solid boxes by centre offset from the monster and half extents. */
  walls?: readonly { readonly offset: Vec3; readonly half: Vec3 }[];
  /** A frozen monster never moves or attacks on its own. Default true. */
  frozen?: boolean;
}

export interface ReactionRig {
  engine: CombatEngine;
  internals: ReactionInternals;
  state: EngineState;
  monsterId: ActorId;
  cues: StoryCue[];
  events: CombatEvent[];
  monster(): CombatActor;
  me(): CombatActor;
  step(patch?: Partial<CombatInput>, count?: number): void;
  /** One confirmed player blow on the monster through the engine's full strike path. */
  strike(hit: HitSpec, damage?: number): number;
  cuesOf(kind: StoryCue['kind']): StoryCue[];
  snapshotMonster(): ActorSnapshot;
}

/** A real Greenwake combat-trial run with the arena swapped for flat open ground and a real trial monster in front of the hero. */
export function reactionRig(options: ReactionRigOptions = {}): ReactionRig {
  const stage = options.stage ?? 0;
  const trial = playtest.trialSet.trials[stage]!;
  const region = createCombatTrialRegion(REGIONS.find(candidate => candidate.id === playtest.regionId)!);
  const base = new CombatEngine();
  base.loadRegion({ regionId: playtest.regionId, regionDefinition: region, runId: 'reaction-rig', presentActorIds: playtest.trialSet.trials.map(candidate => candidate.monsterId) });
  base.setPlayerHero(options.hero ?? 'aren');
  base.startEncounter({ encounterId: playtest.trialSet.encounterId, regionId: playtest.regionId, runId: 'reaction-rig' });
  base.enableCombatTrials();
  const seed = base.snapshotState();
  const flat = createEngineState().arena;
  flat.bounds = { min: vec(-200, -1, -200), max: vec(200, 12, 200) };
  flat.colliders = (options.walls ?? []).map((wall, index): RegionColliderDefinition => ({
    id: `rig-wall-${index}`, kind: 'box', from: vec(trial.monsterPosition.x + wall.offset.x, wall.offset.y, trial.monsterPosition.z + wall.offset.z), halfExtents: wall.half, blocksMovement: true, blocksCamera: false,
  }));
  seed.arena = flat;
  seed.combatTrial!.index = stage;
  const monster = seed.actors.find(actor => actor.id === trial.monsterId)!;
  const player = seed.actors.find(actor => actor.id === seed.playerId)!;
  monster.vitality = monster.maxVitality = 1000;
  monster.ferocity = 0;
  if (options.frozen !== false) monster.staggerUntil = 1e9;
  player.position = vec(monster.position.x, monster.position.y, monster.position.z + (options.distance ?? 3));
  player.facing = vec(0, 0, -1);
  player.velocity = vec(0, 0, 0);
  seed.player.vitality = seed.player.maxVitality = 100_000;
  seed.player.mana = seed.player.maxMana;
  seed.targetId = trial.monsterId;
  const engine = new CombatEngine(seed);
  const internals = engine as unknown as ReactionInternals;
  const state = internals.state;
  const cues: StoryCue[] = [], events: CombatEvent[] = [];
  const live = (): CombatActor => state.actors.find(actor => actor.id === trial.monsterId)!;
  return {
    engine, internals, state, monsterId: trial.monsterId, cues, events,
    monster: live,
    me: () => state.actors.find(actor => actor.id === state.playerId)!,
    step(patch = {}, count = 1) {
      for (let i = 0; i < count; i++) { engine.fixedStep({ ...idleInput, ...patch }); cues.push(...engine.drainPresentationCues()); events.push(...engine.consumeEvents()); }
    },
    strike(hit, damage = 1) {
      const dealt = internals.strikeHostile(live(), { action: 'rig', clip: 'aren-light-1', damage, stopTicks: 0, element: 'arcane', stagger: 'none', instinct: 0, counter: false, hit });
      cues.push(...engine.drainPresentationCues()); events.push(...engine.consumeEvents());
      return dealt;
    },
    cuesOf: kind => cues.filter(cue => cue.kind === kind),
    snapshotMonster: () => engine.snapshot().actors.find(actor => actor.id === trial.monsterId)!,
  };
}

export { ATTACKS };
