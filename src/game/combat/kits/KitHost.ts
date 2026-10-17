import type { ActionId, ActorId, HeroMarkSnapshot, Vec3 } from '../../contracts.js';
import type { StoryCue } from '../../../effects/story-cues.js';
import type { HeroId } from '../../heroes.js';
import type { AttackElement } from '../content.js';
import type { CombatActor, CombatInput, PlayerResources } from '../CombatEngine.js';
import type { LivePlayerProjectile } from '../PlayerArsenal.js';
import type { HitSpec } from '../reactions.js';
import type { PlayerSkillId } from '../PlayerSkills.js';

/**
 * The seam between `CombatEngine` and a hero kit (Vesper, Sakda). The engine owns input, timing rules, damage
 * and persistence; a kit decides what each routed skill does by driving the player and hostiles through `KitHost`.
 *
 * Clocks: everything about the player (`tick`, action timers, `setUntargetableUntil`) is on the simulation clock;
 * everything about monsters (stagger, cripple, mark remaining ticks, `worldTick`) is on the world clock, which slows
 * during Perfect Dodge. The engine freezes both during hit-stop and calls `HeroKit.onHitStop` once per frozen tick so
 * a kit can shift the absolute simulation ticks it stores.
 *
 * Persistence: kit state lives in `host.kitState()`, a plain JSON object inside `EngineState`; it is serialized with
 * the engine, restored by `restore()`/`serialize()`, and cleared by `HeroKit.reset` on region load, checkpoint reset and death.
 */

/** A presentation cue as accepted by `CombatEngine.queuePresentationCue`; `actorId` should be the player (`'aren'`). */
export type KitCue = Omit<StoryCue, 'instanceId' | 'tick' | 'worldTick' | 'worldTimeSeconds'>;

/** How the struck monster's current attack reacts: `interrupt` cancels a winding-up attack, `idle` only staggers an idle monster, `none` leaves it alone. */
export type KitStagger = 'interrupt' | 'idle' | 'none';

/** One confirmed hit. Interrupt-capable hits must use `action` `heavy`, `charged_heavy` or `root_tether` (the monsters' interrupt lists key on those); every other hit may use the kit's own skill id. */
export interface KitStrike {
  action: string;
  clip: ActionId;
  damage: number;
  element: AttackElement;
  stagger: KitStagger;
  /** Hit-stop in ticks (0 for none; 7 is the full-strength freeze). */
  stopTicks: number;
  /** Instinct gained by the hit. */
  instinct: number;
  /** Actual projectile travel direction, when the contact came from a projectile rather than the attacker's current position. */
  direction?: Vec3;
  /** Weight, poise damage and knockback of the blow (reactions.ts); derived from the damage when absent. */
  hit?: HitSpec;
}

/** Inputs a cancel window can route to the kit while an action is still locked or recovering. */
export type KitCancelInput = 'light' | 'heavy' | 'ranged' | 'dodge' | 'tether' | 'ultimate';

/** From `fromTick` ticks after the action start, the engine routes the listed inputs to the kit even while lock/recovery ticks run. The kit's start method must abandon its in-flight action cleanly (no orphan pending impacts). */
export interface KitCancelWindow {
  fromTick: number;
  into: ReadonlyArray<KitCancelInput>;
}

/** What `beginAction` writes into the player: the same state the engine's own skills use. */
export interface KitActionSpec {
  /** Stored as the engine's current action id (also the skill id used by evasion/avoid checks). */
  id: string;
  clip: ActionId;
  /** Full clip length: the action finishes (and Idle returns) this many ticks after the start. */
  totalTicks: number;
  /** Ticks the player is rooted by input (movement locked); defaults to `totalTicks`. Recovery runs from here to `totalTicks`. */
  lockTicks?: number;
  /** True lets Dodge cancel the action during its lock. Default false. */
  cancelable?: boolean;
  /** Light-chain bookkeeping: the next J is accepted from `totalTicks - chainEarlyTicks` through `totalTicks + chainLateTicks`. */
  light?: { step: number; chainEarlyTicks: number; chainLateTicks: number };
  /** Optional cancel window; `fromTick` is an offset from the action start. */
  cancel?: KitCancelWindow;
}

export interface KitProjectileSpec {
  kind: 'kunai' | 'echo-wave' | 'shade-clone';
  /** Clip id of the skill that fired it; used as the cue's `actionId`. */
  actionId: string;
  origin: Vec3;
  /** Unit direction; y may be non-zero. */
  direction: Vec3;
  /** Metres per second on the world clock. */
  speed: number;
  /** Maximum flight distance in metres. */
  range: number;
  /** Bolt radius, or half the lane width when `pierce`. */
  radius: number;
  /** Authored damage carried on the projectile for the kit's own use; the engine never applies it for kit projectiles. */
  damage: number;
  /** Hostile it homes onto (turn rate of the Sigil Bolt); absent flies straight. */
  targetId?: ActorId;
  /** Routes hits and the end of flight to `HeroKit.onProjectileHit` / `onProjectileEnd`. */
  callbackId: string;
  /** Lane projectile: hits every hostile it sweeps through instead of stopping at the first. */
  pierce?: boolean;
}

export interface KitDodgeSpec {
  /** The clip played for the dodge (the hero's dash/blink clip). */
  clip: ActionId;
  distance: number;
  durationTicks: number;
  /** Untouchable ticks from the start of the dodge. */
  iframes: number;
  recoveryTicks: number;
  /** The engine emits a `blink` cue (element = kit element) from start to end. */
  blinkCue: boolean;
  /** Optional cancel window of the dodge; `fromTick` is an offset from the dodge start. */
  cancel?: KitCancelWindow;
}

export interface KitDodgeInfo {
  from: Vec3;
  /** Predicted destination along the travel direction. */
  to: Vec3;
  durationTicks: number;
}

/** Live values a kit contributes to `CombatSnapshot.player`. */
export interface KitPlayerExtras {
  shield?: number;
  flurryCharges?: number;
}

export interface KitHost {
  readonly heroId: HeroId;
  /** Simulation tick. */
  readonly tick: number;
  readonly worldTick: number;
  /** The live player actor (id `aren`). Mutate only through the setters below. */
  readonly player: CombatActor;
  /** Live resources (vitality, mana, Instinct). Spend mana through `spendMana`. */
  readonly resources: PlayerResources;
  readonly actors: readonly CombatActor[];
  /** Locked hostile, if any. */
  readonly targetId: ActorId | undefined;
  /** The engine's actual airborne phase, excluding takeoff and supported landing recovery. */
  readonly airborne: boolean;

  /** The kit's plain-JSON state object inside `EngineState`; `create()` initializes it the first time (empty object). */
  kitState<S extends object>(create: () => S): S;

  // ---- queries ------------------------------------------------------------------------------------------------
  /** A hostile this hero may hit now (visible, alive, not possessed; in a combat trial only the current stage's monster). */
  isHostile(actor: CombatActor): boolean;
  /** Locked target when hostile and within `range`, otherwise the nearest hostile within `range` inside the cone of the player's facing (`coneDegrees` full angle; 360 = all around). */
  softTarget(range: number, coneDegrees?: number): CombatActor | undefined;
  hostilesInRadius(centre: Vec3, radius: number): CombatActor[];
  chestOf(actor: CombatActor): Vec3;
  /** The player's capsule swept along `delta` with the arena's collision; returns where it ends (never inside a wall). */
  moveCircle(from: Vec3, delta: Vec3): Vec3;
  isPathClear(from: Vec3, to: Vec3): boolean;
  /** True when the player's capsule can stand at `point` (floor under it, nothing inside it). */
  isSupported(point: Vec3): boolean;
  /** The player's capsule swept along `delta` without ground snapping (airborne motion); returns where it ends. The landing must still satisfy `isSupported`. */
  moveAerial(from: Vec3, delta: Vec3): Vec3;
  /**
   * True when the straight segment from→to (both are the capsule's FOOT position, same convention as `moveAerial`) is traversable exactly as drawn:
   * inside the arena bounds, no wall/collider contact, and no point of it below the walkable floor under that point (the floor is solid, so
   * a path whose Y is even slightly under the ground — e.g. an arc sampled around the player's centre/chest instead of the feet — is rejected).
   * A plain ground-to-ground leap or a feet-based arc above the floor is clear. It is an all-or-nothing check; to shorten a leap to the furthest
   * flyable part, sample `moveAerial` and finish with `isSupported`.
   */
  isAerialPathClear(from: Vec3, to: Vec3): boolean;
  groundHeight(x: number, z: number, nearY: number): number | null;
  /** First blocking point along from→to for a probe of `radius` (walls, colliders, closed trial gates, obstacles), or undefined when clear. */
  wallHit(from: Vec3, to: Vec3, radius: number): Vec3 | undefined;
  /** True while the monster has a telegraphed attack in windup/commit. */
  isWindingUp(actor: CombatActor): boolean;
  /** True when `target` (visible, not downed) is within `reach` + its radius horizontally of `from` and the segment from `from` to its chest is not blocked. Every targeted kit impact must pass this at the moment of impact, measured from the player's actual position. */
  canStrike(target: CombatActor, from: Vec3, reach: number): boolean;

  // ---- player ---------------------------------------------------------------------------------------------------
  /** Starts a kit action: cancels the engine's swing/cast, writes action id/clip/timers, zeroes velocity, phase `anticipation`. */
  beginAction(spec: KitActionSpec): void;
  setPhase(phase: CombatActor['phase']): void;
  setPlayerPosition(position: Vec3): void;
  setPlayerFacing(facing: Vec3): void;
  setPlayerVelocity(velocity: Vec3): void;
  /** Player takes no hazard damage and cannot be targeted until this simulation tick (exclusive). Pass a past tick to clear. */
  setUntargetableUntil(tick: number): void;
  /** Starts the shared skill cooldown and spends mana; false changes neither when unavailable. */
  spendMana(skill: PlayerSkillId): boolean;
  restoreMana(amount: number): void;
  addInstinct(amount: number): void;

  // ---- hostiles -------------------------------------------------------------------------------------------------
  /** One hit through the engine's full path: kit `modifyStrike`/`afterStrike`, weak-point multiplier, damage, Instinct, stagger, cue, event, hit-stop. Returns vitality lost. */
  strikeHostile(target: CombatActor, strike: KitStrike): number;
  /** Hits every hostile within `radius` (+ its own radius) of `centre` that is not behind a wall. Actors in `hitIds` are skipped and struck ones are appended. Returns the number struck. */
  strikeDisk(centre: Vec3, radius: number, strike: KitStrike, hitIds?: ActorId[]): number;
  /** Hits every hostile within `width/2` (+ its own radius) of the ground segment from→to (horizontal test; height is ignored) that is not behind a wall. */
  strikeLane(from: Vec3, to: Vec3, width: number, strike: KitStrike, hitIds?: ActorId[]): number;
  /** Hits every hostile in the cone (`arcDegrees` full angle, 360 = ring) of `facing` within `reach` (+ its own radius). */
  strikeCone(origin: Vec3, facing: Vec3, reach: number, arcDegrees: number, strike: KitStrike, hitIds?: ActorId[]): number;
  /** Spawns a player projectile and queues its `projectile` cue. Returns its id. */
  spawnProjectile(spec: KitProjectileSpec): string;
  /** Pushes a monster along `direction` by up to `metres`, stopping at walls and the trial arena edge. Returns metres moved. */
  displaceMonster(actor: CombatActor, direction: Vec3, metres: number): number;
  /** Monster moves at `factor` of its speed for `ticks` world ticks (a longer or stronger cripple wins). */
  crippleMonster(actor: CombatActor, factor: number, ticks: number): void;
  /** Monster is staggered (idle, no attacks) for `ticks` world ticks. */
  staggerMonster(actor: CombatActor, ticks: number): void;
  /** Cancels the monster's attack if it is still telegraphed; `skillClass` is `heavy`, `charged_heavy` or `root_tether`. */
  interruptMonster(actor: CombatActor, skillClass: 'heavy' | 'charged_heavy' | 'root_tether'): boolean;

  // ---- presentation ---------------------------------------------------------------------------------------------
  queueCue(cue: KitCue): void;
  /** Adds a combat event to the engine log. */
  emit(kind: 'cue' | 'action', message: string, targetId?: ActorId, actionId?: string): void;
  /** Freezes the world for `ticks` (overlapping freezes take the longest). */
  hitStop(ticks: number): void;
}

/** Everything the engine routes to a hero's kit. The engine falls back to Aren's behaviour for any hero without a registered kit. */
export interface HeroKit {
  readonly heroId: HeroId;
  /** Element of the kit's cues, strikes and snapshot colouring. */
  readonly element: AttackElement;
  /** HUD skill labels per slot (`HEARTROOT_LABELS` pattern). */
  readonly labels: Partial<Record<PlayerSkillId, string>>;
  /** Number of J chain steps. */
  readonly lightSteps: number;
  /** Replaces the Dive's distance/duration/iframes/recovery/clip; the engine keeps its Perfect Dodge rules. */
  readonly dodge: KitDodgeSpec;
  /** Clip for an engine action key (`light_1`..`light_4`, `heavy`, `heavy_charge`, `charged_heavy`, `sigil_charge`, `sigil_bolt`, `sigil_barrage`, `root_tether`, `cleanse`, `judgement`); undefined falls back to Aren's clip (locomotion stays `aren-*`). */
  clip(action: string): ActionId | undefined;

  // ---- routed inputs (the engine has already checked downed/paused/traversal/recovery and, for Q, target/windup validity) ----
  /** J. `step` is 1..lightSteps; `chain` is true when continuing a chain inside its window; `counter` after a Perfect Dodge. Mana is free. */
  startLight(step: number, chain: boolean, counter: boolean): boolean;
  /** K tap (`charged` false) or release after the hold threshold (`charged` true). Spend mana with `host.spendMana('heavy' | 'charged_heavy')`. */
  startHeavy(charged: boolean): boolean;
  /** L tap (`charged` false) or release after the Barrage hold (`charged` true). Spend mana with `host.spendMana('sigil_bolt' | 'sigil_barrage')`. */
  startRanged(charged: boolean): boolean;
  /** Q on a winding-up hostile (`root_tether` mana is already spent). Cleanse keeps the engine's own flow with the kit's `cleanse` clip. */
  startTether(target: CombatActor): boolean;
  /** U with full Instinct. The engine empties Instinct only when this returns true. */
  startUltimate(): boolean;

  // ---- lifecycle -------------------------------------------------------------------------------------------------
  /** Once per live simulation tick after the engine's own update, never during hit-stop. */
  update(input: CombatInput): void;
  /** Once per frozen hit-stop tick: shift every absolute simulation tick the kit stores by +1. */
  onHitStop?(): void;
  /** The in-flight action must stop (Dodge, death, checkpoint reset). Marks and passives survive. */
  cancel(): void;
  /** Region load / checkpoint reset / new run: drop everything (the engine has already emptied `kitState`). */
  reset(): void;

  // ---- hooks -----------------------------------------------------------------------------------------------------
  /** Dodge just started (after Perfect Dodge evaluation); e.g. Guard Dash grants its shield here. */
  onDodge?(info: KitDodgeInfo): void;
  /** A shared engine skill (Jump, Cleanse, Dodge) was just accepted for this hero. */
  onSharedSkill?(skill: 'jump' | 'cleanse' | 'dodge'): void;
  /** Adjusts a hit before it lands (Death Mark execution, backstab). Return the strike to use; it may be the same object. */
  modifyStrike?(target: CombatActor, strike: KitStrike): KitStrike;
  /** A hit landed and `dealt` vitality was lost (add Death Mark stacks, Flurry, Echo marks). */
  afterStrike?(target: CombatActor, strike: KitStrike, dealt: number): void;
  /** Damage about to reach the player's vitality; returns what passes through (shield). */
  absorbDamage?(amount: number): number;
  /** Extra untargetable condition beside `setUntargetableUntil`. */
  isUntargetable?(): boolean;
  /** Multiplier on walk/run speed (default 1). */
  moveSpeedScale?(): number;
  playerExtras?(): KitPlayerExtras;
  /** Statuses to show on a hostile (`cripple` is added by the engine). */
  heroMarks?(actorId: ActorId): readonly HeroMarkSnapshot[] | undefined;
  /** A kit projectile (spawned with a `callbackId`) touched `target` at `point`. A bolt ends after this; a pierce lane keeps flying. */
  onProjectileHit?(projectile: LivePlayerProjectile, target: CombatActor, point: Vec3): void;
  /** A kit projectile ended (hit a target, hit a wall or ran out of range) at `point`. */
  onProjectileEnd?(projectile: LivePlayerProjectile, point: Vec3): void;
}

export type KitFactory = (host: KitHost) => HeroKit;
