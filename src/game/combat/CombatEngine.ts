import type { ActionId, ActorId, ActorSnapshot, AttackId, CampaignSnapshot, CombatSnapshot, CombatObstacleSnapshot, EncounterStatusSnapshot, PlayerSkillSnapshot, CompanionId, InputFrame, InteractionDefinition, MovableObjectSnapshot, RegionColliderDefinition, RegionDefinition, RegionMovableObjectDefinition, RegionId, RegionRouteDefinition, Vec3, WorldEvent } from '../contracts.js';
import type { FragmentId } from '../../../packages/campaign/src/index.js';
import type { CueCancellationReason, StoryCue } from '../../effects/story-cues.js';
import { ACTORS, INTERACTIONS, REGIONS } from '../../content/campaign.js';
import { COMPANION_ROSTER, type CompanionCommand, type CompanionRosterState, companionCommand, configureCompanionSlots, configureCompanions, createCompanionState, stepCompanions } from '../companions/CompanionSystem.js';
import { ATTACKS, BOSS_ENCOUNTERS, WILDLIFE_ENCOUNTERS, type AttackDefinition, type AttackElement, type BossEncounterDefinition } from './content.js';
import { ATTACK_TURN_RATE_MAX, CAST_FACING_TOLERANCE, CAST_RANGE_MARGIN, MONSTER_PROFILES, ROAR_TICKS, STUCK_TICKS, TRIAL_ENGAGE_RANGE, TRIAL_DISENGAGE_RANGE, clampStepToArena, createMonsterMotion, getWildlifePressure, scaleWildlifeAttack, steerMonster, turnTranslationScale, wrapAngle, type WildlifePressureTier, type MonsterMotionState, type MonsterProfile } from './WildlifePressure.js';
import { EVASION_PROFILES, type EvasionDirection, type EvasionProfile, type EvasionProfileId, type HazardDefinition } from './evasion.js';
import { arenaFromRegion, distance2, facingFrom, groundHeightAt, isAerialCirclePathClear, isCirclePathClear, isSupportedCapsulePose, moveAerialCircle, moveCircle, pointInSector, vec, type CombatArena, type Rect } from './geometry.js';
import { CHAIN_EARLY_TICKS, CHAIN_LATE_TICKS, CRESCENT_WAVE, HIT_STOP_FULL_TICKS, HIT_STOP_TICKS, JUDGEMENT, JUDGEMENT_INSTINCT, LIGHT_ASSIST_RANGE, LIGHT_LOCK_MARGIN_TICKS, LIGHT_STEPS, MAX_MANA, MANA_PER_METRE, PLAYER_MAX_VITALITY, PLAYER_SKILLS, SIGIL, THUNDER_CLEAVE, playerSkillId, targetedStrike, type PlayerSkillId } from './PlayerSkills.js';
import { rotateY, segmentDistanceXZ, turnTowards, yawOf, type DeferredRelease, type HitStopState, type LiveJudgementMark, type LivePlayerProjectile, type PendingLightning, type PlayerCast, type PlayerSwing } from './PlayerArsenal.js';
import { createCombatTrialState, combatTrialSetFor, type CombatTrialDefinition, type CombatTrialSet, type CombatTrialState } from './CombatTrials.js';
import { scaleTrialAttack, trialRamp, type TrialDifficulty } from './TrialDifficulty.js';
import { heroById, type HeroId } from '../heroes.js';
import { HEARTROOT, HEARTROOT_CLIPS, HEARTROOT_LABELS } from './HeartrootSkills.js';
import type { HeroMarkSnapshot } from '../contracts.js';
import { HERO_COMBAT } from './HeroProfiles.js';
import type { HeroKit, KitActionSpec, KitCancelInput, KitHost, KitProjectileSpec, KitStrike } from './kits/KitHost.js';
import { createKit } from './kits/registry.js';

export const FIXED_STEP_SECONDS = 1 / 60;
const MAX_CATCH_UP_TICKS = 8;
const MAX_HOSTILES = 6;
const MAX_GROUNDED_LARGE = 2;
const MAX_TOTAL_LARGE=2;
/** A region that hosts combat trials may hold as many large monsters as it has trials. */
const MAX_TRIAL_REGION_LARGE = 3;
const PLAYER_JUMP_MAX_DISTANCE = 4.2;
const PLAYER_JUMP_BOOST_MAX_DISTANCE = 6.5;
const PLAYER_JUMP_APEX = 1.25;
const PLAYER_JUMP_BOOST_APEX = 2.1;
const PLAYER_JUMP_ANTICIPATION_TICKS = 7;
const PLAYER_JUMP_FLIGHT_TICKS = 42;
const PLAYER_JUMP_LANDING_TICKS = 10;
const PLAYER_MOVE_ACCEL_TICKS = 7;
const PLAYER_MOVE_DECEL_TICKS = 6;
const PERFECT_DODGE_EFFECTS={worldTimeScale:0.25,slowMotionTicks:12,maxSlowMotionTicks:18,instinctGain:20,petRecoveryReductionTicks:18,playerRecoveryReductionTicks:12,weakPointDurationTicks:36,weakPointDamageMultiplier:1.5,counterWindowTicks:36} as const;
/** Trial monsters keep their centre this far inside their arena circle. */
const TRIAL_ARENA_INSET=0.5;
/** A chained second attack is dropped if the monster cannot start it within this many ticks of the first one's active window ending. */
const CHAIN_PATIENCE_TICKS=90;
/** Non-interrupting monster flinch after a player hit, in world ticks. */
const HIT_REACT_TICKS = 12;
/** A held charge never outlasts this many ticks (matches the Charged Heavy hold). */
const MAX_HOLD_TICKS = 3600;
/** Crescent-wave wall probe radius and the vertical slack of its body check. */
const WAVE_PROBE_RADIUS = 0.4;
const WAVE_HEIGHT_MARGIN = 1;
const PLAYER_RADIUS = 0.42;
const ACTION_CLIPS: Readonly<Record<string, ActionId>> = {
  idle: 'aren-idle' as ActionId, walk: 'aren-walk' as ActionId, run: 'aren-run' as ActionId,
  jump: 'aren-jump' as ActionId, strafe: 'aren-strafe' as ActionId,
  quick_step_left: 'aren-quick-step-left' as ActionId, quick_step_right: 'aren-quick-step-right' as ActionId,
  forward_shoulder_roll: 'aren-forward-shoulder-roll' as ActionId, back_handspring: 'aren-back-handspring' as ActionId,
  left_cartwheel: 'aren-left-cartwheel' as ActionId, right_cartwheel: 'aren-right-cartwheel' as ActionId,
  forward_left_dive_roll: 'aren-forward-left-dive-roll' as ActionId, forward_right_dive_roll: 'aren-forward-right-dive-roll' as ActionId,
  back_left_pivot_roll: 'aren-back-left-pivot-roll' as ActionId, back_right_pivot_roll: 'aren-back-right-pivot-roll' as ActionId,
  low_slide: 'aren-low-slide' as ActionId, staff_vault: 'aren-staff-vault' as ActionId,
  low_ledge: 'aren-low-ledge' as ActionId, swing: 'aren-swing' as ActionId,
  perfect_dodge_left: 'aren-perfect-dodge-left' as ActionId, perfect_dodge_right: 'aren-perfect-dodge-right' as ActionId,
  dodge_recovery: 'aren-dodge-recovery' as ActionId, hard_landing: 'aren-hard-landing' as ActionId,
  stumble_recovery: 'aren-stumble-recovery' as ActionId, light_1: 'aren-light-1' as ActionId,
  light_2: 'aren-light-2' as ActionId, light_3: 'aren-light-3' as ActionId, heavy: 'aren-heavy' as ActionId,
  charged_heavy: 'aren-charged-heavy' as ActionId, root_tether: 'aren-root-tether' as ActionId,
  ferocity: 'aren-ferocity' as ActionId, corruption: 'aren-corruption' as ActionId, cleanse: 'aren-cleanse' as ActionId,
  possession_break: 'aren-possession-break' as ActionId, vault_counter: 'aren-staff-vault-downward-strike' as ActionId,
  cartwheel_counter: 'aren-cartwheel-staff-sweep' as ActionId,
  light_4: 'aren-light-4' as ActionId, sigil_bolt: 'aren-sigil-bolt' as ActionId, sigil_charge: 'aren-sigil-charge' as ActionId,
  sigil_barrage: 'aren-sigil-barrage' as ActionId, judgement: 'aren-judgement' as ActionId,
  'actor-idle': 'wild-crown:actor-idle' as ActionId,
  ...Object.fromEntries(Object.keys(ATTACKS).map(id=>[`boss:${id}`,`wild-crown:${id}` as ActionId])),
  ...Object.fromEntries(COMPANION_ROSTER.map(companion=>[`${companion.id}-idle`,`${companion.id}:idle` as ActionId])),
  ...Object.fromEntries(Object.values(BOSS_ENCOUNTERS).map(encounter=>[`${encounter.bossId}-idle`,`${encounter.bossId}:idle` as ActionId])),
};
const EVASION_ACTION_CLIPS = new Set<ActionId>();
for (const profile of Object.values(EVASION_PROFILES)) {
  const actionId = ACTION_CLIPS[profile.id];
  if (actionId) EVASION_ACTION_CLIPS.add(actionId);
}
export const COMBAT_ACTION_CLIPS = ACTION_CLIPS;

export interface CameraBasis { forward: Vec3; right: Vec3 }
export interface CombatInput extends InputFrame { dodgeDirection?: EvasionDirection; heavyHeldTicks?: number; targetCycle?: -1 | 1; tetherPressed?: boolean; cleansePressed?: boolean; ferocityPressed?: boolean; corruptionPressed?: boolean; interactTargetId?: ActorId; interactionId?:string; interactionTargetId?:string; choiceOptionId?:string; traversalId?: string }
export interface CombatActor extends ActorSnapshot {
  radius: number; collisionHeight:number; maxVitality: number; large: boolean; aerial: boolean; command?: CompanionCommand; corruptionCoreIds?: readonly string[]; cleansedCoreIds?: string[];
  /** Finite actions use simulation ticks for playerId, world ticks for every other actor; traversal owns its world-clock sample separately. */
  recoveringUntil: number; invulnerableUntil: number; staggerUntil: number; possessedUntil: number; weakPointUntil?:number; possessionInstanceId?:string; possessionSourceId?:ActorId; actionStartedTick: number; actionEndsTick: number;
  /** Combat-trial monsters only: serializable locomotion state on the world-tick clock. */
  motion?: MonsterMotionState;
  /** World tick at which the non-interrupting hit flinch ends (12 world ticks after the last player hit). */
  hitReactUntil?: number;
  /** World tick until which a trial monster moves at `crippleFactor` of its speed (Sakda's Tempest Stomp). */
  crippleUntil?: number;
  crippleFactor?: number;
}
export interface LiveHazard extends HazardDefinition {
  id: string; attackId: AttackId; sourceId: ActorId; startTick: number; activeFrom: number; activeUntil: number;
  target: Vec3; origin: Vec3; direction: Vec3; hitIds: string[]; threatTicks: number[]; cue: string; targetActorId?:ActorId;
  activePresentationEmitted?:boolean;
  /** Captured at creation: later pressure changes never retime an in-flight attack. */
  windupUntil?:number; castUntil?:number; recoveryUntil?:number;
  nextHitAt?:Record<string,number>; warningPresentationEmitted?:boolean;
  /** Trial difficulty damage multiplier stamped at cast time; `damage` stays the authored value. Absent means 1. */
  damageScale?:number;
}
export interface LiveTelegraph { id: string; attackId: AttackId; sourceId: ActorId; targetPosition: Vec3; phase: 'windup'|'commit'|'active'|'recovery'; remainingTicks: number; cue: string }
/** One confirmed player hit on a hostile; `stagger` picks how the target's current attack reacts. */
interface PlayerStrike { action: string; clip: ActionId; damage: number; stopTicks: number; element: AttackElement; stagger: 'interrupt' | 'idle' | 'none'; instinct: number; counter: boolean }
export interface CombatEvent { id: string; tick: number; kind: 'cue'|'damage'|'perfect-dodge'|'counter-open'|'action'|'companion'|'traversal'|'world'|'attack-interrupted'; actorId?: ActorId; targetId?: ActorId; actionId?: string; attackId?: AttackId; message: string; worldEvent?: WorldEvent; damage?: { readonly targetId: ActorId; readonly amount: number; readonly position: Vec3; readonly worldTick: number } }
export interface EncounterCheckpoint { tick: number; worldTick: number; lastAttackTick: number; attackSelectionWorldOffset?: number; counterUntil: number; actors: CombatActor[]; player: PlayerResources; phaseIndex: number; phaseLatch: number; phaseActionFlags: string[]; rewardEmitted: boolean; companions: CompanionRosterState; wildlifeCombat?:WildlifeCombatState; playerSlow?:PlayerSlow; combatTrial?:CombatTrialState; }
export interface PlayerResources { vitality: number; maxVitality: number; instinct: number; mana: number; maxMana: number; }
export interface PendingImpact { activeAt: number; activeUntil: number; target: ActorId; action: string; range: number; radius: number; damage: number; interrupt: boolean; counter:boolean; startVitality: number; resolved: boolean; interactionId?:string; interactionPosition?:Vec3; }
export interface LiveMovableObject extends MovableObjectSnapshot {
  authored: RegionMovableObjectDefinition;
  startedAtWorldTick?: number;
  interactionId?: string;
  actorId?: ActorId;
}
interface WildlifeCombatState { engagedTicks:number; sourceCursor:number; attackCursors:Record<string,number>; castCount?:number; chain?:{sourceId:ActorId;hazardId:string}; }
interface PlayerSlow { untilWorldTick:number; factor:number; }
export interface EngineState {
  schemaVersion: 3; tick: number; worldTick:number; worldTimeScale:number; timePolicy:CombatSnapshot['worldClock']['policy']; slowMotionRemainingTicks:number; slowMotionElapsedTicks:number; accumulator: number; regionId: RegionId; runId: string; encounterId?: string; encounter: BossEncounterDefinition | null; worldFacts: Readonly<Record<string,boolean|number|string>>;
  actors: CombatActor[]; playerId: ActorId; player: PlayerResources; targetId?: ActorId; arena: CombatArena; hazards: LiveHazard[]; telegraphs: LiveTelegraph[];
  heroId: HeroId;
  movableObjects: LiveMovableObject[];
  sceneColliders: readonly RegionColliderDefinition[];
  combatObstacles: CombatObstacleSnapshot[];
  events: CombatEvent[]; worldEvents: WorldEvent[]; seenWorldKeys: string[]; perfectDodgeKeys: string[]; phaseIndex: number; phaseLatch: number; phaseActionFlags:string[];
  actionId: string; actionUntil: number; actionRecoveryUntil: number; actionCancelable: boolean; counterUntil: number; lastAttackTick: number; attackSelectionWorldOffset: number; heavyChargeStartTick: number | null; lastResolvedActionId?:string; lastResolvedTargetId?:ActorId; lastResolvedActionTick?:number; lightIndex?:number; bufferedAction?:{action:string;targetId?:ActorId;expiresTick:number};
  companionState: CompanionRosterState; companionSlots: { combat?: CompanionId; utility?: CompanionId; scout?: 'vara' };
  eventSequence: number; rewardEmitted: boolean; checkpoint: EncounterCheckpoint | null; traversalGates: TraversalGate[]; pendingImpact?: PendingImpact; presentationCues: StoryCue[];
  traversal?: LiveTraversal;
  playerJump?: PlayerJumpState;
  wildlifeCombat?:WildlifeCombatState;
  playerSlow?:PlayerSlow;
  combatTrial?: CombatTrialState;
  /** Warden Arsenal state. Tick fields are simulation ticks (shifted forward during hit-stop) unless noted. */
  lightChainFrom?: number;
  lightChainUntil?: number;
  swing?: PlayerSwing;
  cast?: PlayerCast;
  /** Held Sigil charge; absent when not charging. `scopeId` joins its sustain and cancel cues. */
  sigilCharge?: { startedTick: number; scopeId: string };
  playerProjectiles: LivePlayerProjectile[];
  judgementMarks: LiveJudgementMark[];
  pendingLightning?: PendingLightning;
  hitStop?: HitStopState;
  deferredRelease?: DeferredRelease;
  /** Monotonic id source for sigils, projectiles and marks. */
  arsenalSequence: number;
  /** Plain-JSON state of the active hero kit (`KitHost.kitState`); emptied on region load, checkpoint reset and death. */
  kit: Record<string, unknown>;
  /** Simulation tick (exclusive) until which a hero skill makes the player untargetable. */
  untargetableUntil?: number;
  /** The hero kit's overridden Dive profile while its dodge plays. */
  evasion?: EvasionProfile;
  /** Kit cancel window of the running action (absolute simulation tick): the listed inputs are routed to the kit from `fromTick` even during lock/recovery. */
  kitCancel?: { fromTick: number; into: KitCancelInput[] };
}
/** The player timers a lifted kit cancel window saved, restored when the routed input started nothing. */
interface KitCancelLift {
  tick: number; window: NonNullable<EngineState['kitCancel']>;
  actionId: string; actionUntil: number; actionRecoveryUntil: number; actionCancelable: boolean;
  clip: ActionId; startedTick: number; endsTick: number; normalizedTime: number; phase: CombatActor['phase']; velocity: Vec3;
}
export interface PlayerJumpState {
  startedAtTick: number;
  /** Supported launch position; bounds total self-propelled travel across both jumps. */
  origin: Vec3;
  /** Current preflighted parabolic segment, rebased without extending its deadline when steering changes. */
  from: Vec3;
  to: Vec3;
  flightStartedAtTick: number;
  flightTicks: number;
  apex: number;
  /** Full airborne phase starts here; steering only rebases the remaining geometric segment. */
  airStartedAtTick: number;
  boosted: boolean;
  boostQueued?: boolean;
  steering: Vec3;
  anticipationFrom?: Vec3;
}
export type EngineStateSeed = Partial<Omit<EngineState, 'schemaVersion'>> & { schemaVersion?: 1 | 2 | 3 };
export interface TraversalGate { id:string; routeId:string; from:Vec3; to:Vec3; anchors:readonly Vec3[]; fromRegion:RegionId; toRegion:RegionId; width:number; rise:number; unlocked:boolean; unlockFact?:string; traversalEvent:string; colliderIds:readonly string[]; traversalActionId:ActionId; traversal?:RegionRouteDefinition['traversal'] }
interface LiveTraversal { gate:TraversalGate; points:Vec3[]; lengths:number[]; length:number; segment:number; segmentDistance:number; startedAtWorldTick:number; lastSafePose:Vec3; lastSafeFacing:Vec3; standingHeight:number; }
export interface EncounterStart { encounterId:string; regionId:RegionId; runId:string; playerPosition?:Vec3; bossPosition?:Vec3; companionSlots?:{combat?:CompanionId;utility?:CompanionId;scout?:'vara'}; actors?:readonly CombatActor[]; worldFacts?:Readonly<Record<string,boolean|number|string>>;}
export interface RegionLoadInput { regionId:RegionId;runId:string;presentActorIds:readonly string[];regionDefinition?:RegionDefinition;playerPosition?:Vec3;companionSlots?:{combat?:CompanionId;utility?:CompanionId;scout?:'vara'};chapter?:number;wardenCall?:boolean;bond?:number;dominionUsed?:boolean;worldFacts?:Readonly<Record<string,boolean|number|string>>; }
export interface AttackImpact { targetId: ActorId; damage: number; avoided: boolean; interrupt: boolean; }

export class CombatEngine {
  private state: EngineState;
  /** Scratch step for trial-monster arena clamping. */
  private readonly monsterStep = { dx: 0, dz: 0 };
  private kit?: HeroKit;
  /** True while the current player update runs with a lifted kit cancel window (a hold-started charge must then abandon the kit's action). */
  private kitCancelLift = false;
  /** Per-region trial difficulty ramp, rebuilt when the loaded trial set changes (derived data, never serialized). */
  private rampCache?: { set: CombatTrialSet; ramp: readonly TrialDifficulty[] };
  private readonly kitHost: KitHost = this.createKitHost();
  constructor(seed?: EngineStateSeed) { this.state = seed ? hydrateEngineState(seed) : createEngineState(); this.syncKit(); this.refreshCombatSolids(); this.cancelTraversal(); }
  startNewRun(runId: string): void {
    this.state = createEngineState();
    this.state.runId = runId;
    this.syncKit();
  }
  setPlayerHero(heroId: HeroId): void {
    if (this.state.encounter) throw new Error('Choose a hero before starting an encounter.');
    const hero = heroById(heroId), player = this.playerActor();
    if (!player) throw new Error('Load a region before choosing a hero.');
    const profile = HERO_COMBAT[heroId], resources = this.state.player;
    this.state.heroId = heroId;
    player.renderVariantId = hero.variantAssetId;
    // A new health pool starts full; choosing the same hero again keeps the current health.
    if (resources.maxVitality !== profile.maxVitality) { resources.maxVitality = profile.maxVitality; resources.vitality = profile.maxVitality; }
    player.maxVitality = resources.maxVitality;
    player.vitality = resources.vitality;
    this.syncKit();
    this.resetArsenal();
    this.state.checkpoint = this.captureEncounterCheckpoint();
  }

  private playerClip(action: string): ActionId {
    const own = this.kit?.clip(action) ?? (this.state.heroId === 'yara' ? HEARTROOT_CLIPS[action] : undefined);
    return (own ?? ACTION_CLIPS[action]) as ActionId;
  }
  /** Element of the player's cues and strikes: the active kit's, else Yara's heartroot, else Aren's arcane. */
  private heroElement(): AttackElement { return this.kit?.element ?? (this.state.heroId === 'yara' ? 'heartroot' : 'arcane'); }
  private syncKit(): void { this.kit = createKit(this.state.heroId, this.kitHost); }
  /** The `aren` actor mirrors the hero's health pool (a fresh actor starts at full health). */
  private syncPlayerActorVitality(): void {
    const player = this.playerActor();
    if (!player) return;
    player.maxVitality = this.state.player.maxVitality;
    player.vitality = this.state.player.maxVitality;
  }
  private isUntargetable(): boolean {
    const until = this.state.untargetableUntil;
    return until !== undefined && this.state.tick < until || this.kit?.isUntargetable?.() === true;
  }
  private heroMarksOf(actor: CombatActor): { heroMarks?: readonly HeroMarkSnapshot[] } {
    const marks = this.kit?.heroMarks?.(actor.id), crippled = actor.crippleUntil !== undefined && this.state.worldTick < actor.crippleUntil;
    if (!marks?.length && !crippled) return {};
    return { heroMarks: crippled ? [...(marks ?? []), { kind: 'cripple', remainingTicks: Math.ceil(actor.crippleUntil! - this.state.worldTick) }] : marks! };
  }
  private playerSnapshotExtras(): { shield?: number; flurryCharges?: number; untargetable?: true } {
    const extras = this.kit?.playerExtras?.(), out: { shield?: number; flurryCharges?: number; untargetable?: true } = {};
    if (extras?.shield !== undefined) out.shield = extras.shield;
    if (extras?.flurryCharges !== undefined) out.flurryCharges = extras.flurryCharges;
    if (this.isUntargetable()) out.untargetable = true;
    return out;
  }
  // ---- Hero kit host --------------------------------------------------------------------------------------------
  private kitSoftTarget(range: number, coneDegrees: number): CombatActor | undefined {
    const s = this.state, player = this.playerActor();
    if (!player) return undefined;
    const locked = s.targetId === undefined ? undefined : this.actorForId(s.targetId);
    if (locked && this.isPlayerHostileTarget(locked) && distance2(player.position, locked.position) <= range) return locked;
    let best: CombatActor | undefined, bestDistance = Infinity;
    for (const actor of s.actors) {
      if (!this.isPlayerHostileTarget(actor)) continue;
      const distance = distance2(player.position, actor.position);
      if (distance >= bestDistance || distance > range) continue;
      if (coneDegrees < 360 && !pointInSector(actor.position, player.position, player.facing, range, coneDegrees)) continue;
      best = actor; bestDistance = distance;
    }
    return best;
  }
  /** Strikes every hostile that passes `inside`, once each when `hitIds` is given. Returns how many were struck. */
  private kitStrikeArea(inside: (actor: CombatActor) => boolean, strike: KitStrike, hitIds?: ActorId[]): number {
    let struck = 0;
    for (const actor of this.state.actors) {
      if (!this.isPlayerHostileTarget(actor) || hitIds?.includes(actor.id) || !inside(actor)) continue;
      hitIds?.push(actor.id);
      this.strikeHostile(actor, { ...strike, counter: false });
      struck++;
    }
    return struck;
  }
  private kitBeginAction(spec: KitActionSpec): void {
    const s = this.state, player = this.playerActor();
    if (!player) return;
    s.pendingImpact = undefined; s.swing = undefined; s.cast = undefined;
    if (spec.light) { s.lightIndex = spec.light.step; s.lightChainFrom = s.tick + spec.totalTicks - spec.light.chainEarlyTicks; s.lightChainUntil = s.tick + spec.totalTicks + spec.light.chainLateTicks; }
    else s.lightIndex = 0;
    s.actionId = spec.id; s.actionUntil = s.tick + (spec.lockTicks ?? spec.totalTicks); s.actionRecoveryUntil = s.tick + spec.totalTicks; s.actionCancelable = spec.cancelable === true;
    s.evasion = undefined;
    s.kitCancel = spec.cancel ? { fromTick: s.tick + spec.cancel.fromTick, into: [...spec.cancel.into] } : undefined;
    player.actionId = spec.clip; player.actionStartedTick = s.tick; player.normalizedTime = 0; player.actionEndsTick = s.tick + spec.totalTicks;
    player.phase = 'anticipation'; player.velocity = vec(0, 0, 0); player.targetId = s.targetId;
  }
  private kitSpawnProjectile(spec: KitProjectileSpec): string {
    const s = this.state, player = this.playerActor()!;
    const projectile: LivePlayerProjectile = {
      id: `${spec.kind}:${++s.arsenalSequence}`, kind: spec.kind, ownerId: player.id, position: copy(spec.origin), direction: copy(spec.direction),
      speed: spec.speed, radius: spec.radius, ageTicks: 0, lifeTicks: Math.max(1, Math.round(spec.range / spec.speed * 60)), damage: spec.damage, hitIds: [],
      actionId: spec.actionId, callbackId: spec.callbackId, ...(spec.targetId ? { targetId: spec.targetId } : {}), ...(spec.pierce ? { pierce: true } : {}),
    };
    s.playerProjectiles.push(projectile);
    this.queueProjectileCue(projectile, projectile.position);
    return projectile.id;
  }
  private kitDisplaceMonster(actor: CombatActor, direction: Vec3, metres: number): number {
    const dx = direction.x * metres, dz = direction.z * metres;
    const definition = this.state.combatTrial ? this.trials().find(trial => trial.monsterId === actor.id) : undefined;
    if (definition) return this.stepMonster(actor, definition, dx, dz, FIXED_STEP_SECONDS, false);
    const next = moveCircle(this.state.arena, actor.position, vec(dx, 0, dz), actor.radius, actor.collisionHeight);
    const moved = distance2(actor.position, next);
    actor.position = vec(next.x, next.y, next.z);
    actor.sockets = { ...actor.sockets, root: copy(actor.position), head: vec(next.x, next.y + 1.5, next.z) };
    return moved;
  }
  private createKitHost(): KitHost {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the host exposes live getters over the engine's current state
    const engine = this;
    return {
      get heroId() { return engine.state.heroId; },
      get tick() { return engine.state.tick; },
      get worldTick() { return engine.state.worldTick; },
      get player() { return engine.playerActor()!; },
      get resources() { return engine.state.player; },
      get actors() { return engine.state.actors; },
      get targetId() { return engine.state.targetId; },
      kitState: <S extends object>(create: () => S): S => {
        const store = engine.state.kit;
        // `for…in` never allocates a key array; an empty store means the kit has not initialised yet.
        let initialised = false;
        for (const _key in store) { initialised = true; break; }
        if (!initialised) Object.assign(store, create());
        return store as S;
      },
      isHostile: actor => engine.isPlayerHostileTarget(actor),
      softTarget: (range, coneDegrees = SIGIL.homingConeDegrees) => engine.kitSoftTarget(range, coneDegrees),
      hostilesInRadius: (centre, radius) => engine.state.actors.filter(actor => engine.isPlayerHostileTarget(actor) && distance2(centre, actor.position) <= radius + actor.radius),
      chestOf: actor => engine.chestOf(actor),
      moveCircle: (from, delta) => moveCircle(engine.state.arena, from, delta, PLAYER_RADIUS, engine.playerActor()!.collisionHeight),
      isPathClear: (from, to) => isCirclePathClear(engine.state.arena, from, to, PLAYER_RADIUS, engine.playerActor()!.collisionHeight),
      isSupported: point => isSupportedCapsulePose(engine.state.arena, point, PLAYER_RADIUS, engine.playerActor()!.collisionHeight),
      groundHeight: (x, z, nearY) => groundHeightAt(engine.state.arena, x, z, nearY),
      wallHit: (from, to, radius) => engine.projectileWallHit(from, to, radius),
      moveAerial: (from, delta) => moveAerialCircle(engine.state.arena, from, delta, PLAYER_RADIUS, engine.playerActor()!.collisionHeight),
      isAerialPathClear: (from, to) => isAerialCirclePathClear(engine.state.arena, from, to, PLAYER_RADIUS, engine.playerActor()!.collisionHeight),
      canStrike: (target, from, reach) => target.visible && !target.downed && distance2(from, target.position) <= reach + target.radius
        && !engine.projectileWallHit(vec(from.x, from.y + 0.9, from.z), engine.chestOf(target), 0.05),
      isWindingUp: actor => engine.state.telegraphs.some(telegraph => telegraph.sourceId === actor.id && (telegraph.phase === 'windup' || telegraph.phase === 'commit')),
      beginAction: spec => engine.kitBeginAction(spec),
      setPhase: phase => { engine.playerActor()!.phase = phase; },
      setPlayerPosition: position => { engine.playerActor()!.position = copy(position); },
      setPlayerFacing: facing => { engine.playerActor()!.facing = copy(facing); },
      setPlayerVelocity: velocity => { engine.playerActor()!.velocity = copy(velocity); },
      setUntargetableUntil: tick => { engine.state.untargetableUntil = tick > engine.state.tick ? tick : undefined; },
      spendMana: skill => engine.spendMana(skill),
      restoreMana: amount => { const resources = engine.state.player; resources.mana = Math.min(resources.maxMana, resources.mana + amount); },
      addInstinct: amount => { const resources = engine.state.player; resources.instinct = Math.min(100, resources.instinct + amount); },
      strikeHostile: (target, strike) => engine.strikeHostile(target, { ...strike, counter: false }),
      strikeDisk: (centre, radius, strike, hitIds) => engine.kitStrikeArea(actor =>
        distance2(centre, actor.position) <= radius + actor.radius && !engine.projectileWallHit(vec(centre.x, centre.y + 0.8, centre.z), engine.chestOf(actor), 0.05), strike, hitIds),
      strikeLane: (from, to, width, strike, hitIds) => engine.kitStrikeArea(actor =>
        segmentDistanceXZ(from, to, actor.position).distance <= width / 2 + actor.radius && !engine.projectileWallHit(vec(from.x, from.y + 0.9, from.z), engine.chestOf(actor), 0.05), strike, hitIds),
      strikeCone: (origin, facing, reach, arcDegrees, strike, hitIds) => {
        const full = arcDegrees >= 360, halfArc = Math.cos(arcDegrees * Math.PI / 360);
        return engine.kitStrikeArea(actor => {
          const dx = actor.position.x - origin.x, dz = actor.position.z - origin.z, distance = Math.hypot(dx, dz);
          if (distance > reach + actor.radius) return false;
          if (!(full || distance < 1e-6 || (dx * facing.x + dz * facing.z) / distance >= halfArc)) return false;
          return !engine.projectileWallHit(vec(origin.x, origin.y + 0.9, origin.z), engine.chestOf(actor), 0.05);
        }, strike, hitIds);
      },
      spawnProjectile: spec => engine.kitSpawnProjectile(spec),
      displaceMonster: (actor, direction, metres) => engine.kitDisplaceMonster(actor, direction, metres),
      crippleMonster: (actor, factor, ticks) => {
        const until = engine.state.worldTick + ticks, active = actor.crippleUntil !== undefined && engine.state.worldTick < actor.crippleUntil;
        actor.crippleFactor = active ? Math.min(actor.crippleFactor ?? 1, factor) : factor;
        actor.crippleUntil = active ? Math.max(actor.crippleUntil!, until) : until;
      },
      staggerMonster: (actor, ticks) => { actor.staggerUntil = Math.max(actor.staggerUntil, engine.state.worldTick + ticks); },
      interruptMonster: (actor, skillClass) => engine.interruptAttack(actor, skillClass),
      queueCue: cue => { engine.queuePresentationCue(cue); },
      emit: (kind, message, targetId, actionId) => engine.emit(kind, message, engine.state.playerId, targetId, actionId),
      hitStop: ticks => engine.startHitStop(ticks),
    };
  }

  loadRegion(input:RegionLoadInput):void{
    const region=input.regionDefinition??REGIONS.find(candidate=>candidate.id===input.regionId);
    if(!region)throw new Error(`Unknown authored region: ${input.regionId}`);
    if (input.regionId !== this.state.regionId) this.state.sceneColliders = [];
    const presence=new Set(input.presentActorIds);
    const entry=input.playerPosition??region.entrances[0]?.from??region.navigation.nodes[0]?.position;
    if(!entry)throw new Error(`Region ${region.id} has no authored player entry`);
    this.cancelTraversal();
    const arena=arenaFromRegion(region,this.state.arena.cameraBasis);
    const playerGround=groundHeightAt(arena,entry.x,entry.z,entry.y);
    const playerPosition=vec(entry.x,playerGround??entry.y,entry.z);
    const actors=[makeActor('aren','human','player',playerPosition,false,false,100)];
    const slots=input.companionSlots??{};
    for(const id of [slots.combat,slots.utility,slots.scout])if(id&&region.entities.filter(entity=>entity.actorId===id&&presence.has(entity.id)).length!==1)throw new Error('Party companion '+id+' must resolve to one explicitly present region instance');
    for(const instanceId of presence){
      if(instanceId==='aren')continue;
      const entity=region.entities.find(candidate=>candidate.id===instanceId);
      if(!entity)throw new Error('Actor '+instanceId+' has no explicitly present placement in region '+region.id);
      const archetypeId=entity.actorId??(instanceId as ActorId);
      const definition=ACTORS[archetypeId];
      if(!definition)throw new Error('No authored actor definition for '+archetypeId);
      const requested=entity.position;
      const elevation=groundHeightAt(arena,requested.x,requested.z,requested.y)??requested.y;
      const large=isLargeSpecies(definition.species);
      const actor=makeActor(instanceId as ActorId,definition.species,definition.allegiance,vec(requested.x,elevation,requested.z),large,definition.species==='hornbill',100,archetypeId);
      actor.visible=entity?.visibleWhen===undefined||input.worldFacts?.[entity.visibleWhen]===true;
      actors.push(actor);
    }
    this.state.regionId=region.id;
    this.state.runId=input.runId;
    this.state.timePolicy='normal';this.state.slowMotionRemainingTicks=0;this.state.slowMotionElapsedTicks=0;this.state.worldTimeScale=1;this.state.accumulator=0;
    this.state.worldFacts=structuredClone(input.worldFacts??{});
    this.state.movableObjects=region.movableObjects.map(definition=>{
      const settled=input.worldFacts?.[definition.movedFactId]===true;
      return {objectId:definition.id,position:copy(settled?definition.to:definition.from),phase:settled?'settled':'resting',authored:structuredClone(definition)};
    });
    this.state.encounterId=undefined;
    this.state.encounter=null;
    this.state.arena=arena;
    this.state.combatObstacles = [];
    this.refreshCombatSolids();
    this.state.actors=actors;this.syncPlayerActorVitality();
    this.state.playerId='aren';
    this.state.targetId=actors.find(actor=>actor.allegiance==='hostile'&&actor.visible)?.id;
    this.state.companionSlots={...slots};
    const previousCompanions=this.state.companionState;
    const chapter=input.chapter??previousCompanions.chapter;
    const wardenCall=input.wardenCall??previousCompanions.wardenCall;
    const bond=input.bond??previousCompanions.bond;
    const dominionUsed=input.dominionUsed??previousCompanions.dominionUsed;
    this.state.companionState=createCompanionState(slots,chapter);
    this.state.companionState.wardenCall=wardenCall;this.state.companionState.bond=bond;this.state.companionState.dominionUsed=dominionUsed;
    configureCompanions(this.state,{chapter,wardenCall,bond,dominionUsed,navNodes:region.navigation.nodes});
    this.setTraversalGates(region.traversalArcs,input.worldFacts??{});
    this.state.phaseIndex=0;
    this.state.phaseLatch=0;
    this.state.phaseActionFlags=[];
    this.state.rewardEmitted=false;
    this.state.hazards=[];
    this.state.telegraphs=[];
    this.state.pendingImpact=undefined;
    this.state.bufferedAction=undefined;this.state.heavyChargeStartTick=null;this.state.lightIndex=0;this.state.actionId='idle';this.state.actionUntil=this.state.tick;this.state.actionRecoveryUntil=0;this.state.actionCancelable=false;this.resetArsenal();
    this.state.events=[];
    this.state.worldEvents=[];
    this.state.presentationCues=[];
    this.state.playerJump=undefined;
    this.state.wildlifeCombat=undefined;this.state.playerSlow=undefined;
    this.state.combatTrial=undefined;
    this.refreshCombatSolids();
    this.state.checkpoint=this.captureEncounterCheckpoint();
    this.enforceCaps();
  }
  startEncounter(input:EncounterStart):void{
    const definition=BOSS_ENCOUNTERS[input.encounterId]??WILDLIFE_ENCOUNTERS[input.encounterId];
    if(!definition)throw new Error(`Unknown authored encounter: ${input.encounterId}`);
    if(definition.regionId!==input.regionId)throw new Error(`Encounter ${input.encounterId} does not belong to ${input.regionId}`);
    const region=REGIONS.find(candidate=>candidate.id===input.regionId);
    if(!region)throw new Error(`Unknown authored region: ${input.regionId}`);
    this.cancelTraversal();
    this.setTimePolicy('normal');
    const mustLoadRegion=this.state.runId!==input.runId||this.state.regionId!==input.regionId||this.state.arena.surfaces.length===0;
    if(input.actors)this.state.actors=input.actors.map(cloneActor);
    else if(mustLoadRegion){
      const placedActors=[...definition.actorIds,...(definition.supportActorIds??[])].filter(id=>id!=='aren'&&region.entities.some(entity=>entity.id===id));
      const presentActorIds=[...new Set<ActorId>([...placedActors,...[input.companionSlots?.combat,input.companionSlots?.utility,input.companionSlots?.scout].filter((id):id is CompanionId=>id!==undefined)])];
      this.loadRegion({regionId:input.regionId,runId:input.runId,presentActorIds,playerPosition:input.playerPosition,companionSlots:input.companionSlots,worldFacts:input.worldFacts});
    }
    this.state.regionId=region.id;
    this.state.runId=input.runId;
    // Prepared scene geometry remains authoritative when entering its encounter.
    if(input.actors||mustLoadRegion)this.state.arena=arenaFromRegion(region,this.state.arena.cameraBasis);
    this.state.combatObstacles = [];
    this.refreshCombatSolids();
    let player=this.playerActor();
    if(!player){
      const entry=input.playerPosition??region.entrances[0]?.from??region.navigation.nodes[0]?.position;
      if(!entry)throw new Error(`Region ${region.id} has no authored player entry`);
      const floor=groundHeightAt(this.state.arena,entry.x,entry.z,entry.y)??entry.y;
      player=makeActor('aren','human','player',vec(entry.x,floor,entry.z),false,false,100);
      this.state.actors.unshift(player);
      this.syncPlayerActorVitality();
    }else if(input.playerPosition){player.position=copy(input.playerPosition);}
    const bossId=definition.bossId;
    let boss=this.state.actors.find(actor=>actor.id===bossId);
    if(!boss){
      const placement=region.entities.find(entity=>entity.id===bossId||entity.actorId===bossId);
      const archetypeId=placement?.actorId??bossId;
      const source=ACTORS[archetypeId];
      if(!placement||!source)throw new Error(`Boss ${bossId} has no authored actor placement in ${region.id}`);
      const position=input.bossPosition??placement.position;
      const floor=groundHeightAt(this.state.arena,position.x,position.z,position.y)??position.y;
      boss=makeActor(bossId,source.species,'hostile',vec(position.x,floor,position.z),definition.largeActors.includes(bossId),source.species==='hornbill',100,archetypeId);
      this.state.actors.push(boss);
    }
    for(const actorId of definition.actorIds){
      if(actorId==='aren'||actorId===bossId)continue;
      let participant=this.state.actors.find(actor=>actor.id===actorId);
      if(!participant){
        const placement=region.entities.find(entity=>entity.id===actorId);
        const archetypeId=placement?.actorId??actorId;
        const source=ACTORS[archetypeId];
        if(!placement||!source)throw new Error(`Encounter ${input.encounterId} has no authored placement for ${actorId}`);
        const requested=placement.position;
        const floor=groundHeightAt(this.state.arena,requested.x,requested.z,requested.y)??requested.y;
        participant=makeActor(actorId,source.species,'hostile',vec(requested.x,floor,requested.z),definition.largeActors.includes(actorId),source.species==='hornbill',100,archetypeId);
        this.state.actors.push(participant);
      }
      participant.allegiance='hostile';participant.downed=false;participant.vitality=participant.maxVitality;participant.ferocity=participant.species==='human'?undefined:100;participant.recoveringUntil=0;
    }
    boss.allegiance='hostile';boss.downed=false;boss.vitality=boss.maxVitality;
    boss.ferocity=100;
    boss.corruptionCoreIds=definition.corruptionCoreIds?[...definition.corruptionCoreIds]:undefined;
    boss.cleansedCoreIds=[];
    boss.corruption=boss.corruptionCoreIds?.length?100:60;
    boss.large=definition.largeActors.includes(boss.id);
    this.state.encounterId=input.encounterId;
    this.state.encounter=structuredClone(definition);
    this.state.companionSlots={...input.companionSlots};
    const previous=this.state.companionState;
    const companions=createCompanionState(this.state.companionSlots,previous.chapter);
    companions.wardenCall=previous.wardenCall;
    companions.bond=previous.bond;
    companions.dominionUsed=previous.dominionUsed;
    companions.navNodes=structuredClone(region.navigation.nodes);
    this.state.companionState=companions;
    for(const id of [this.state.companionSlots.combat,this.state.companionSlots.utility,this.state.companionSlots.scout]){
      if(id&&!this.actorForId(id))throw new Error('Selected companion '+id+' is absent; encounter startup will not summon it');
    }
    this.enforceCaps();
    this.state.phaseIndex=0;
    this.state.phaseLatch=0;
    this.state.phaseActionFlags=[];
    this.state.rewardEmitted=false;
    this.state.hazards=[];
    this.state.telegraphs=[];
    this.state.pendingImpact=undefined;
    this.state.bufferedAction=undefined;this.state.heavyChargeStartTick=null;this.state.lightIndex=0;this.state.actionId='idle';this.state.actionUntil=this.state.tick;this.state.actionRecoveryUntil=0;this.state.actionCancelable=false;this.resetArsenal();
    this.state.events=[];
    this.state.worldEvents=[];
    this.state.presentationCues=[];
    this.state.playerJump=undefined;
    this.state.wildlifeCombat=undefined;this.state.playerSlow=undefined;
    this.state.combatTrial=undefined;
    this.refreshCombatSolids();
    this.state.targetId=bossId;
    this.state.checkpoint=this.captureEncounterCheckpoint();
    const initialPhase=this.state.encounter.phases[0];
    if(initialPhase)this.emitPhaseEvent(initialPhase.id,0,'entered');
  }
  setCompanionSlots(slots:{combat?:CompanionId;utility?:CompanionId;scout?:'vara'},presentActorIds:readonly string[]):boolean{
    const present=new Set(presentActorIds);
    const region=REGIONS.find(candidate=>candidate.id===this.state.regionId);
    if(!region)return false;
    for(const id of [slots.combat,slots.utility,slots.scout])if(id&&(region.entities.filter(entity=>entity.actorId===id&&present.has(entity.id)).length!==1||!this.actorForId(id)))return false;
    return configureCompanionSlots(this.state,slots);
  }
  setCameraBasis(basis:CameraBasis):void{this.state.arena.cameraBasis=basis;}
  syncWorldFacts(facts:Readonly<Record<string,boolean|number|string>>):void{
    this.state.worldFacts={...this.state.worldFacts,...structuredClone(facts)};
    const region=REGIONS.find(candidate=>candidate.id===this.state.regionId);
    if(!region)return;
    this.setTraversalGates(region.traversalArcs,this.state.worldFacts);
    for(const actor of this.state.actors){
      const placement=region.entities.find(entity=>entity.id===actor.id)??region.entities.find(entity=>entity.actorId===actor.id);
      if(placement?.visibleWhen!==undefined)actor.visible=this.state.worldFacts[placement.visibleWhen]===true;
    }
  }
  setTraversalGates(routes:readonly RegionRouteDefinition[],worldFacts:Readonly<Record<string,boolean|number|string>>={}):void{
    this.state.traversalGates=routes.map(route=>({id:route.id,routeId:route.id,from:copy(route.from),to:copy(route.to),anchors:structuredClone(route.anchors),fromRegion:this.state.regionId,toRegion:route.destinationRegionId,width:route.traversal?.startRadius??2,rise:Math.abs(route.to.y-route.from.y),unlocked:route.unlockFact===undefined||worldFacts[route.unlockFact]===true,unlockFact:route.unlockFact,traversalEvent:route.traversalEvent,colliderIds:structuredClone(route.colliderIds),traversalActionId:route.traversalActionId,traversal:route.traversal?{...route.traversal}:undefined}));
  }
  commandCompanion(companionId:CompanionId,command:CompanionCommand,targetId?:ActorId):boolean{
    if(this.playerIsDown())return false;
    const companion=this.actorForId(companionId);
    if(companion?.possessed&&(command==='ask'||command==='signal')&&!this.state.companionState.wardenCall&&this.state.companionState.bond>=10){
      this.breakPossession(companion);
      return true;
    }
    if(companionId==='koro'&&command==='special'){
      if(!targetId)return false;
      const object=this.state.movableObjects.find(candidate=>candidate.objectId===targetId);
      const interaction=object&&INTERACTIONS.find(candidate=>candidate.id===object.authored.koroInteractionId);
      if(!companion||!object||!interaction||!this.canStartMovableObjectMove(object,interaction,companion))return false;
      if(!companionCommand(this.state,companionId,command,targetId))return false;
      return this.startMovableObjectMove(object,interaction,companion);
    }
    return companionCommand(this.state,companionId,command,targetId);
  }
  resolveInteraction(interactionId:string,targetId:string,choiceOptionId?:string):boolean{
    if(this.playerIsDown())return false;
    if(this.state.traversal)return false;
    const interaction=INTERACTIONS.find(candidate=>candidate.id===interactionId);
    if(!interaction||interaction.regionId!==this.state.regionId)return false;
    const actor=this.interactionTargetActor(interaction,targetId);
    const hasAuthoredActor=this.state.actors.some(candidate=>candidate.id===interaction.targetId||candidate.archetypeId===interaction.targetId);
    if(targetId!==interaction.targetId&&!actor)return false;
    if(targetId===interaction.targetId&&hasAuthoredActor&&!actor)return false;
    if(interaction.requiresFacts.some(fact=>this.state.worldFacts[fact]!==true))return false;
    if(interaction.requiresActors.some(id=>{const required=this.actorForId(id);return !required||!required.visible||required.downed||required.possessed;}))return false;
    const player=this.playerActor();
    if(actor&&actor.id===this.state.encounter?.bossId&&!this.state.rewardEmitted&&!actor.downed)return false;
    const region=REGIONS.find(candidate=>candidate.id===this.state.regionId);
    const entity=region?.entities.find(candidate=>candidate.interactionId===interactionId||candidate.id===interactionId)??region?.entities.find(candidate=>candidate.actorId===targetId||candidate.id===targetId);
    const position=actor?.position??entity?.position;
    if(!player||!position||distance2(player.position,position)>interaction.radiusMeters)return false;
    if(interactionId==='koro-thorn'){
      const koro=this.actorForId('koro');
      if(!koro?.visible||koro.downed||koro.possessed)return false;
    }
    if(interaction.actionId&&!this.interactionMechanicSatisfied(interaction,actor))return false;
    const success=interaction.success;
    if(success.type==='object-move'){
      const object=this.state.movableObjects.find(candidate=>candidate.objectId===success.objectId);
      if(!object||targetId!==success.objectId||interaction.targetId!==success.objectId||interaction.id!==object.authored.playerInteractionId||interaction.playerActionId!=='staff-heavy'||this.koroAssignedToParty()||!this.hasRecentHeavyImpact(success.objectId))return false;
      if(!this.canStartMovableObjectMove(object,interaction,player))return false;
      return this.startMovableObjectMove(object,interaction,player);
    }
    if(success.type==='semantic-interaction'){
      if(success.kind!==interaction.kind)return false;
      if(['repair','restore','break','move-object','shelter'].includes(success.kind)&&!this.interactionMechanicSatisfied(interaction,actor))return false;
      if(success.kind==='cleanse'&&(actor?.corruption??0)>0)return false;
      const eventId=this.interactionEventId(interaction);
      const signalActor=success.kind==='signal'?interaction.requiresActors.map(id=>this.actorForId(id)).find((candidate):candidate is CombatActor=>!!candidate&&candidate.visible&&!candidate.downed&&!candidate.possessed):undefined;
      const eventActor=signalActor??player;
      return this.emitWorldEvent({type:'semantic-interaction',eventId,idempotencyKey:eventId,actorId:eventActor.id,interactionId:interaction.id,kind:success.kind,targetId:success.targetId,position:copy(eventActor.position),facts:choiceOptionId?{choiceOptionId}:undefined});
    }
    if(success.type==='rescue'){
      const rescueTarget=this.actorForId(success.targetId as ActorId);
      const freed=this.state.worldFacts[`${interactionId}:freed`]===true;
      if(!rescueTarget&&!freed)return false;
      if(success.targetId==='tali'&&(!rescueTarget||this.state.worldFacts.taliInBamboo!==true))return false;
      const safe=success.targetId==='tali'?this.isTaliSafe(rescueTarget!.position):!!rescueTarget?.downed&&!rescueTarget.possessed&&!this.hasActiveThreatNear(rescueTarget.position);
      if(!safe)return false;
      const eventId=this.interactionEventId(interaction);
      const emitted=this.emitWorldEvent({type:'rescue',eventId,idempotencyKey:eventId,targetId:rescueTarget?.id??success.targetId,locationId:success.locationId,safe});
      if(emitted&&safe&&rescueTarget){rescueTarget.downed=false;rescueTarget.possessed=false;rescueTarget.allegiance='ally';}
      return emitted;
    }
    if(success.type==='fragment'){
      if(this.state.worldFacts[`fragment:${success.fragmentId}`]===true)return false;
      const fragmentId:FragmentId=success.fragmentId;
      const eventId=this.interactionEventId(interaction);
      return this.emitWorldEvent({type:'fragment',eventId,idempotencyKey:eventId,fragmentId,sourceId:success.sourceId});
    }
    if(success.type==='restoration'){
      if(!this.interactionMechanicSatisfied(interaction,actor))return false;
      const eventId=this.interactionEventId(interaction);
      return this.emitWorldEvent({type:'restoration',eventId,idempotencyKey:eventId,regionId:success.regionId,state:success.state,causeId:success.causeId});
    }
    if(success.type==='choice'){
      if(!choiceOptionId||!success.optionIds.includes(choiceOptionId))return false;
      const factionScoped=success.choiceId==='faction-covenant'||success.choiceId==='chapter-seven-commitment';
      const eventId=this.interactionEventId(interaction)+(factionScoped?':'+choiceOptionId.replace(/^decline-/,''):'');
      return this.emitWorldEvent({type:'choice',eventId,idempotencyKey:eventId,choiceId:success.choiceId,optionId:choiceOptionId});
    }
    if(success.type==='traversal')return this.traverse(success.routeId);
    if(success.type==='checkpoint'){this.state.checkpoint=this.captureEncounterCheckpoint();return true;}
    return false;
  }
  applyRecoveryRequest(snapshot:Pick<CampaignSnapshot,'runId'|'recoveryRequest'|'lastSafeCheckpoint'>):boolean{
    const request=snapshot.recoveryRequest;
    const checkpoint=snapshot.lastSafeCheckpoint;
    if(!request||request.kind!=='restart-checkpoint'||request.reason!=='tali-safety'||!checkpoint)return false;
    if(checkpoint.runId!==snapshot.runId||checkpoint.checkpointId!==request.checkpointId)return false;
    const party=checkpoint.progress.party;
    const presentActorIds=[...new Set<ActorId>(['aren',...checkpoint.encounterReset.actorIds,party.combat,party.utility,party.scout].filter((id):id is ActorId=>id!==undefined))];
    this.loadRegion({regionId:checkpoint.safeSpawn.regionId,runId:checkpoint.runId,presentActorIds,playerPosition:checkpoint.safeSpawn.position,companionSlots:party,chapter:checkpoint.progress.chapter,worldFacts:checkpoint.progress.worldFacts});
    this.state.seenWorldKeys=[...checkpoint.progress.eventKeys];
    const encounterId=checkpoint.encounterReset.encounterId;
    if(encounterId)this.startEncounter({encounterId,regionId:checkpoint.safeSpawn.regionId,runId:checkpoint.runId,playerPosition:checkpoint.safeSpawn.position,companionSlots:party});
    return true;
  }
  useAbility(kind: 'root-tether'|'ferocity'|'corruption'|'cleanse'|'ask'|'signal', targetId?: ActorId): boolean {
    switch(kind) {
      case 'root-tether': return this.startPlayerAction('root_tether', targetId);
      case 'ferocity': return this.startPlayerAction('ferocity', targetId);
      case 'corruption': return this.startPlayerAction('corruption', targetId);
      case 'cleanse': return this.startPlayerAction('cleanse', targetId);
      case 'ask': return this.commandCompanionForInput(targetId, 'ask');
      case 'signal': return this.commandCompanionForInput(targetId, 'signal');
    }
  }
  step(input: CombatInput, deltaSeconds = FIXED_STEP_SECONDS, basis?: CameraBasis): number {
    if (basis) this.setCameraBasis(basis);
    if(this.state.timePolicy==='paused'){this.state.accumulator=0;return 0;}
    this.state.accumulator = Math.min(this.state.accumulator + Math.max(0, deltaSeconds), FIXED_STEP_SECONDS * MAX_CATCH_UP_TICKS);
    let steps = 0;
    while (this.state.accumulator + 1e-10 >= FIXED_STEP_SECONDS && steps < MAX_CATCH_UP_TICKS) {
      this.fixedStep(input); this.state.accumulator -= FIXED_STEP_SECONDS; steps++;
    }
    return steps;
  }
  fixedStep(input: CombatInput = { tick: this.state.tick+1, move: vec(0,0,0), dodgePressed:false, lightPressed:false, heavyPressed:false, heavyHeld:false, heavyReleased:false, interactPressed:false }): void {
    if(this.state.timePolicy==='paused')return;
    const firstEvent=this.state.events.length;
    const playerWasAlive=this.state.player.vitality>0;
    this.state.tick++;
    if(this.state.hitStop){this.freezeForHitStop(input);return;}
    if(this.state.timePolicy==='perfect-dodge-slow'&&this.state.slowMotionRemainingTicks<=0)this.state.timePolicy='normal';
    const slowMotionActive=this.state.timePolicy==='perfect-dodge-slow';
    const worldScale=this.effectiveWorldTimeScale();
    this.state.worldTimeScale=worldScale;
    this.state.worldTick+=worldScale;
    if(this.state.playerSlow&&this.state.worldTick>=this.state.playerSlow.untilWorldTick)this.state.playerSlow=undefined;
    this.expireCombatObstacles();
    const wasTraversing=this.state.traversal!==undefined;
    if(this.playerIsDown())this.endPlayerCombat();else {this.updateActors(worldScale);this.updateHazards();}
    if(!this.playerIsDown()){
      this.updateBossAI();
      if(wasTraversing)this.updateTraversal(worldScale);else this.updatePlayer(input);
      this.updateArsenal(worldScale,input);
      stepCompanions(this.state);
      this.updateMovableObjects();
      this.updatePhase();
      this.updateCombatTrial();
    }
    if(this.state.actionRecoveryUntil>0&&this.state.tick>=this.state.actionRecoveryUntil&&this.state.actionId!=='idle')this.finishAction();
    if(slowMotionActive&&this.state.timePolicy==='perfect-dodge-slow'){
      this.state.slowMotionRemainingTicks=Math.max(0,this.state.slowMotionRemainingTicks-1);
      this.state.slowMotionElapsedTicks++;
      if(this.state.slowMotionRemainingTicks===0){this.state.timePolicy='normal';this.state.slowMotionElapsedTicks=0;}
    }
    this.state.worldTimeScale=this.effectiveWorldTimeScale();
    for(const event of this.state.events.slice(firstEvent).flatMap(item=>item.worldEvent?[item.worldEvent]:[])){
      if(!this.state.worldEvents.some(existing=>existing.idempotencyKey===event.idempotencyKey))this.state.worldEvents.push(structuredClone(event));
    }
    if(playerWasAlive&&this.state.player.vitality===0)this.queuePresentationCue({kind:'cancel',phase:'resolve',cancellationReason:'death'});
  }
  snapshot(): CombatSnapshot {
    const currentPhase=this.state.encounter?.phases[this.state.phaseIndex];
    const actors=this.state.actors.map(actor=>{
      const variantId=actor.id===this.state.encounter?.bossId?currentPhase?.actorVariantId:undefined;
      // Trial monsters render their own playtest asset instead of the shared archetype default.
      const trialAssetId=this.state.combatTrial?this.trials().find(trial=>trial.monsterId===actor.id)?.monsterAssetId:undefined;
      const renderVariantId=variantId??actor.renderVariantId??trialAssetId??ACTORS[actor.archetypeId]?.assetId;
      const weakPointExposed=this.state.worldTick<(actor.weakPointUntil??0);
      const attack=this.monsterAttackProgress(actor);
      const motion=actor.motion;
      const jump=actor.id===this.state.playerId?this.state.playerJump:undefined;
      const landingAt=jump?jump.flightStartedAtTick+jump.flightTicks:0;
      const peakAt=jump?jump.flightStartedAtTick+jump.flightTicks*(.5+(jump.to.y-jump.from.y)/(8*jump.apex)):0;
      const jumpPhase:ActorSnapshot['jumpPhase']=!jump?undefined:this.state.tick<=jump.airStartedAtTick?'takeoff':this.state.tick<peakAt?'rising':this.state.tick<landingAt?'falling':'landing';
      const jumpPhaseProgress=!jump?undefined:Math.max(0,Math.min(1,jumpPhase==='takeoff'?(this.state.tick-jump.startedAtTick)/Math.max(1,jump.airStartedAtTick-jump.startedAtTick):jumpPhase==='rising'?(this.state.tick-jump.airStartedAtTick)/Math.max(1,peakAt-jump.airStartedAtTick):jumpPhase==='falling'?(this.state.tick-peakAt)/Math.max(1,landingAt-peakAt):(this.state.tick-landingAt)/PLAYER_JUMP_LANDING_TICKS));
      return {id:actor.id,archetypeId:actor.archetypeId,species:actor.species,allegiance:actor.allegiance,position:copy(actor.position),velocity:copy(actor.velocity),facing:copy(actor.facing),actionId:actor.actionId,phase:actor.phase,normalizedTime:attack?.time??actor.normalizedTime,vitality:actor.vitality,maxVitality:actor.maxVitality,ferocity:actor.ferocity,corruption:actor.corruption,targetId:actor.targetId,renderVariantId,sockets:structuredClone(actor.sockets),interactionRequirements:structuredClone(actor.interactionRequirements),visible:actor.visible,downed:actor.downed,possessed:actor.possessed,weakPointExposed,
        ...this.heroMarksOf(actor),
        ...(attack?{attackPhase:attack.phase,attackPhaseProgress:attack.progress}:{}),
        jumpPhase,jumpPhaseProgress,jumpBoosted:jump?.boosted,
        ...(motion&&motion.yawRate!==0?{yawRate:motion.yawRate}:{}),
        ...(motion&&this.state.worldTick<motion.roarUntil?{roarProgress:(this.state.worldTick-motion.roarFrom)/Math.max(1,motion.roarUntil-motion.roarFrom)}:{}),
        ...(actor.hitReactUntil!==undefined&&this.state.worldTick<actor.hitReactUntil?{hitReact:Math.min(1,Math.max(0,1-(actor.hitReactUntil-this.state.worldTick)/HIT_REACT_TICKS))}:{})};
    });
    const boss=this.currentBoss();
    return {
      actors,
      movableObjects:this.state.movableObjects.map(object=>({objectId:object.objectId,position:copy(object.position),phase:object.phase,...(object.rotationY===undefined?{}:{rotationY:object.rotationY})})),
      combatObstacles: structuredClone(this.state.combatObstacles),
      worldClock:{simulationTick:this.state.tick,worldTick:this.state.worldTick,worldTimeSeconds:this.state.worldTick*FIXED_STEP_SECONDS,timeScale:this.state.worldTimeScale,policy:this.state.timePolicy},
      player:{heroId:this.state.heroId,vitality:this.state.player.vitality,maxVitality:this.state.player.maxVitality,instinct:this.state.player.instinct,mana:this.state.player.mana,maxMana:this.state.player.maxMana,...this.playerSnapshotExtras()},
      skills:this.playerSkills(),
      encounterStatus:this.encounterStatus(),
      ...(this.state.combatTrial ? { trialGates:this.trials().map((trial,index)=>({id:trial.id,collider:trial.gate,open:this.state.combatTrial!.index>index})) } : {}),
      ...(this.state.playerProjectiles.length?{playerProjectiles:this.state.playerProjectiles.map(projectile=>({id:projectile.id,kind:projectile.kind,ownerId:projectile.ownerId,position:copy(projectile.position),direction:copy(projectile.direction),speed:projectile.speed,radius:projectile.radius,ageTicks:projectile.ageTicks,lifeTicks:projectile.lifeTicks,...(projectile.targetId?{targetId:projectile.targetId}:{})}))}:{}),
      ...(this.state.judgementMarks.length?{judgementMarks:this.state.judgementMarks.map(mark=>({id:mark.id,position:copy(mark.position),angleRadians:mark.angleRadians,createdAtTick:mark.createdAtTick,detonateAtTick:mark.detonateAtTick}))}:{}),
      ...(this.state.hitStop?{hitStop:{remainingTicks:this.state.hitStop.remainingTicks,strength:this.state.hitStop.strength}}:{}),
      encounterId:this.state.encounterId,
      boss:boss?{actorId:boss.id,phaseId:currentPhase?.id??'resolved',phaseIndex:this.state.phaseIndex,ferocity:boss.ferocity??0,maxFerocity:100,corruption:boss.corruption??0,exposed:this.state.worldTick<boss.staggerUntil||this.state.worldTick<(boss.weakPointUntil??0),...(boss.corruptionCoreIds?{corruptionCores:boss.corruptionCoreIds.map(id=>({id,cleansed:boss.cleansedCoreIds?.includes(id)??false}))}:{})}:undefined,
      telegraphs:this.state.telegraphs.map(telegraph=>({id:telegraph.id,attackId:telegraph.attackId,sourceId:telegraph.sourceId,targetPosition:copy(telegraph.targetPosition),phase:telegraph.phase,remainingTicks:telegraph.remainingTicks})),
      hazards:this.state.hazards.map(hazard=>({id:hazard.id,kind:hazard.kind==='cone'?'area':hazard.kind,bounds:{min:copy(hazard.bounds.min),max:copy(hazard.bounds.max)},active:this.state.worldTick>=hazard.activeFrom&&this.state.worldTick<hazard.activeUntil})),
      targetId:this.state.targetId,events:structuredClone(this.state.worldEvents),
    };
  }
  serialize(): string { return JSON.stringify(this.state); }
  restore(serialized: string): void { this.cancelTraversal(); this.state = hydrateEngineState(JSON.parse(serialized) as EngineStateSeed); this.syncKit(); this.refreshCombatSolids(); this.cancelTraversal(); this.state.presentationCues=[]; for(const hazard of this.state.hazards){hazard.activePresentationEmitted=false;hazard.warningPresentationEmitted=false;} this.queuePresentationCue({kind:'cancel',phase:'resolve',cancellationReason:'load'}); if(this.state.sigilCharge)this.queueSigilCue(this.state.sigilCharge.scopeId,'sustain',SIGIL.chargeSustainTicks,1); }
  consumeEvents(): CombatEvent[] { const events = structuredClone(this.state.events); this.state.events.length=0; return events; }
  consumeWorldEvents(): WorldEvent[] { const events = structuredClone(this.state.worldEvents); this.state.worldEvents.length=0; return events; }
  /** Release only an uncommitted choice emission after the Director permanently rejects it. */
  discardRejectedChoice(event:Extract<WorldEvent,{type:'choice'}>,committed:boolean):void{
    if(committed)return;
    this.state.seenWorldKeys=this.state.seenWorldKeys.filter(key=>key!==event.idempotencyKey);
  }
  drainPresentationCues(): readonly StoryCue[] { const cues=structuredClone(this.state.presentationCues);this.state.presentationCues.length=0;return cues; }
  queuePresentationCue(cue:Omit<StoryCue,'instanceId'|'tick'|'worldTick'|'worldTimeSeconds'>):StoryCue{
    const heroCue=(this.state.heroId==='yara'||this.kit!==undefined)&&cue.actorId===this.state.playerId&&(cue.kind==='cleanse'||cue.kind==='tether');
    const normalized=structuredClone(heroCue?{...cue,element:this.heroElement(),actionId:this.playerClip(cue.kind==='cleanse'?'cleanse':'root_tether')}:cue);
    const instanceId=this.state.runId+':'+(this.state.encounterId??'free')+':cue:'+this.state.tick+':'+(++this.state.eventSequence);
    const event:StoryCue={...normalized,instanceId,tick:this.state.tick,worldTick:this.state.worldTick,worldTimeSeconds:this.state.worldTick*FIXED_STEP_SECONDS};
    this.state.presentationCues.push(event);
    return structuredClone(event);
  }
  private captureEncounterCheckpoint(): EncounterCheckpoint {
    return { tick: this.state.tick, worldTick:this.state.worldTick, lastAttackTick:this.state.lastAttackTick, attackSelectionWorldOffset:this.state.attackSelectionWorldOffset, counterUntil:this.state.counterUntil, actors: this.state.actors.map(cloneActor), player: structuredClone(this.state.player), phaseIndex: this.state.phaseIndex, phaseLatch: this.state.phaseLatch, phaseActionFlags:[...this.state.phaseActionFlags], rewardEmitted: this.state.rewardEmitted, companions: structuredClone(this.state.companionState), wildlifeCombat:structuredClone(this.state.wildlifeCombat), playerSlow:structuredClone(this.state.playerSlow), combatTrial:structuredClone(this.state.combatTrial) };
  }
  resetToCheckpoint(): void {
    const traversalSafePose=this.state.traversal?copy(this.state.traversal.lastSafePose):undefined;
    this.cancelTraversal();
    const checkpoint = this.state.checkpoint;
    if (!checkpoint) { this.state.presentationCues=[]; this.queuePresentationCue({kind:'cancel',phase:'resolve',cancellationReason:'load'}); return; }
    this.setTimePolicy('normal');
    this.state.tick = checkpoint.tick;
    const worldOffset=this.state.worldTick-checkpoint.worldTick;
    this.state.actors = checkpoint.actors.map(cloneActor);
    for(const actor of this.state.actors){
      actor.recoveringUntil=shiftDeadline(actor.recoveringUntil,worldOffset);
      if(actor.id!==this.state.playerId)actor.invulnerableUntil=shiftDeadline(actor.invulnerableUntil,worldOffset);
      actor.staggerUntil=shiftDeadline(actor.staggerUntil,worldOffset);
      actor.possessedUntil=shiftDeadline(actor.possessedUntil,worldOffset);
      if(actor.weakPointUntil!==undefined)actor.weakPointUntil=shiftDeadline(actor.weakPointUntil,worldOffset);
      if(actor.id!==this.state.playerId&&actor.actionEndsTick>0){
        actor.actionStartedTick+=worldOffset;
        actor.actionEndsTick+=worldOffset;
      }
    }
    // Rebase the selector timestamp and its virtual-clock offset together.
    this.state.lastAttackTick=shiftDeadline(checkpoint.lastAttackTick,worldOffset);
    this.state.attackSelectionWorldOffset=(checkpoint.attackSelectionWorldOffset??0)+worldOffset;
    this.state.counterUntil=checkpoint.counterUntil;
    this.state.player = structuredClone(checkpoint.player);
    this.state.phaseIndex = checkpoint.phaseIndex;
    this.state.phaseLatch = checkpoint.phaseLatch;
    this.state.phaseActionFlags = [...checkpoint.phaseActionFlags];
    this.state.rewardEmitted = checkpoint.rewardEmitted;
    this.state.companionState = structuredClone(checkpoint.companions);
    this.state.wildlifeCombat=structuredClone(checkpoint.wildlifeCombat);
    this.state.playerSlow=checkpoint.playerSlow?{...checkpoint.playerSlow,untilWorldTick:shiftDeadline(checkpoint.playerSlow.untilWorldTick,worldOffset)}:undefined;
    this.state.combatTrial=structuredClone(checkpoint.combatTrial);
    this.refreshCombatSolids();
    this.state.hazards = [];
    this.clearCombatObstacles();
    this.state.telegraphs = [];
    this.state.events = [];
    this.state.worldEvents = [];
    this.state.bufferedAction=undefined;this.state.heavyChargeStartTick=null;this.state.lightIndex=0;this.state.pendingImpact=undefined;this.state.actionCancelable=false;this.resetArsenal();
    this.state.presentationCues = [];
    this.state.playerJump=undefined;
    if(traversalSafePose){const player=this.playerActor();if(player)player.position=traversalSafePose;}
    this.queuePresentationCue({kind:'cancel',phase:'resolve',cancellationReason:'load'});
    this.state.actionUntil = this.state.tick;
    this.state.actionRecoveryUntil = 0;
  }
  snapshotState(): EngineState { return structuredClone(this.state); }
  getActionClipMapping(): Readonly<Record<string,ActionId>> { return ACTION_CLIPS; }
  get pendingAssets(): readonly { action: string; clip: ActionId; status:'pending' }[] { return Object.entries(ACTION_CLIPS).map(([action,clip])=>({action,clip,status:'pending'})); }
  get simulationTick(): number { return this.state.tick; }
  setTimePolicy(policy:'normal'|'paused'):void{
    this.state.timePolicy=policy;this.state.slowMotionRemainingTicks=0;this.state.slowMotionElapsedTicks=0;this.state.worldTimeScale=policy==='paused'||this.state.hitStop?0:1;this.state.accumulator=0;
  }
  finishLocalStage(): void {
    this.resetArsenal();
    this.clearCombatObstacles();
    this.state.hazards = [];
    this.state.telegraphs = [];
    this.state.pendingImpact = undefined;
    this.state.playerJump = undefined;
    this.setTimePolicy('paused');
  }

  /** Monster attack phase derived from its newest live hazard; `time` is the composite normalized clip time (windup .5, commit .12, active .24, recovery .14). */
  private monsterAttackProgress(actor: CombatActor): { phase: NonNullable<ActorSnapshot['attackPhase']>; progress: number; time: number } | undefined {
    if (actor.id === this.state.playerId) return undefined;
    const hazard = this.liveAttackOf(actor);
    if (!hazard) return undefined;
    const windupEnd = hazard.windupUntil ?? hazard.activeFrom;
    const castEnd = hazard.castUntil ?? hazard.activeUntil;
    const recoveryEnd = hazard.recoveryUntil ?? castEnd;
    const tick = this.state.worldTick;
    if (tick < windupEnd) { const progress = Math.max(0, tick - hazard.startTick) / Math.max(1, windupEnd - hazard.startTick); return { phase: 'windup', progress, time: 0.5 * progress }; }
    if (tick < hazard.activeFrom) { const progress = (tick - windupEnd) / Math.max(1, hazard.activeFrom - windupEnd); return { phase: 'commit', progress, time: 0.5 + 0.12 * progress }; }
    if (tick < castEnd) { const progress = (tick - hazard.activeFrom) / Math.max(1, castEnd - hazard.activeFrom); return { phase: 'active', progress, time: 0.62 + 0.24 * progress }; }
    const progress = Math.min(1, (tick - castEnd) / Math.max(1, recoveryEnd - castEnd));
    return { phase: 'recovery', progress, time: Math.min(1, 0.86 + 0.14 * progress) };
  }
  setSceneColliders(colliders: readonly RegionColliderDefinition[]): void {
    const previous = this.state.sceneColliders;
    this.state.arena.colliders = this.state.arena.colliders.filter(collider => !previous.some(solid => solid.id === collider.id));
    this.state.sceneColliders = colliders.slice();
    this.refreshCombatSolids();
  }

  /** Local nonlethal combat stages never resolve campaign encounters or award world facts. */
  enableCombatTrials(): void {
    const set=combatTrialSetFor(this.state.regionId);
    if(!set||this.state.encounterId!==set.encounterId)throw new Error('Combat trials require the authored trial encounter of a playtest region.');
    this.state.combatTrial=createCombatTrialState();
    set.trials.forEach((trial,index)=>{
      const actor=this.state.actors.find(candidate=>candidate.id===trial.monsterId);
      const profile=MONSTER_PROFILES[trial.monsterId];
      if(!actor||!profile)throw new Error('Missing trial monster '+trial.monsterId);
      actor.position=copy(trial.monsterPosition);
      actor.radius=profile.radius;
      actor.maxVitality=actor.vitality=this.trialRamp()[index]!.vitality;
      actor.motion=createMonsterMotion(index*7919+13);
      // Idle monsters look down the route the player arrives along: from the gate back towards the room.
      actor.facing=facingFrom(sub(trial.monsterPosition,trial.gate.from));
    });
    this.refreshCombatSolids();
    this.state.checkpoint=this.captureEncounterCheckpoint();
  }
  /** The combat-trial set of the loaded region; valid while `state.combatTrial` exists. */
  private trialSet():CombatTrialSet{
    const set=combatTrialSetFor(this.state.regionId);
    if(!set)throw new Error('Region '+this.state.regionId+' hosts no combat trials.');
    return set;
  }
  private trials():readonly CombatTrialDefinition[]{return this.trialSet().trials;}
  private trialRamp():readonly TrialDifficulty[]{
    const set=this.trialSet();
    if(this.rampCache?.set!==set)this.rampCache={set,ramp:trialRamp(set.regionId,set.trials.length)};
    return this.rampCache.ramp;
  }
  /** Difficulty of the stage hosting `monsterId`; undefined outside combat trials. */
  private trialDifficultyOf(monsterId:ActorId):TrialDifficulty|undefined{
    if(!this.state.combatTrial)return undefined;
    const index=this.trials().findIndex(stage=>stage.monsterId===monsterId);
    return index<0?undefined:this.trialRamp()[index];
  }
  private updateCombatTrial():void{
    const trial=this.state.combatTrial,player=this.playerActor();
    if(!trial||!player||this.playerIsDown()||trial.index>=this.trials().length)return;
    const definition=this.trials()[trial.index]!;
    const source=this.state.actors.find(actor=>actor.id===definition.monsterId);
    if(!source?.visible)return;
    if(!source.downed||source.vitality!==0){
      trial.status=distance2(source.position,player.position)<=12?'fighting':'approach';
      if(trial.status==='fighting')this.state.targetId=source.id;
      return;
    }
    trial.index++;
    trial.status=trial.index===this.trials().length?'complete':'open';
    source.allegiance='neutral';source.velocity=vec(0,0,0);
    if(source.motion){source.motion.lunge=undefined;this.endRoar(source,source.motion);}
    if(this.state.wildlifeCombat?.chain?.sourceId===source.id)this.state.wildlifeCombat.chain=undefined;
    if(this.state.targetId===source.id)this.state.targetId=undefined;
    for(const hazard of this.state.hazards)if(hazard.sourceId===source.id)this.queuePresentationCue({kind:'cancel',phase:'resolve',scopeId:hazard.id,cancellationReason:'interrupt'});
    this.state.hazards=this.state.hazards.filter(hazard=>hazard.sourceId!==source.id);
    this.state.telegraphs=this.state.telegraphs.filter(telegraph=>telegraph.sourceId!==source.id);
    this.clearCombatObstacles(source.id);
    this.refreshCombatSolids();
    this.emit('cue',definition.title+' gate opened. Follow the trail.',source.id);
  }
  private encounterStatus():EncounterStatusSnapshot|undefined{
    const encounter=this.state.encounter;
    if(!encounter)return undefined;
    const trial=this.state.combatTrial;
    if(trial){
      const trials=this.trials();
      const ramp=this.trialRamp();
      const complete=trial.index>=trials.length;
      const current=trials[Math.min(trial.index,trials.length-1)]!;
      return {title:complete?this.trialSet().clearedTitle:current.title,monsters:trials.map((stage,index)=>{
        const actor=this.state.actors.find(candidate=>candidate.id===stage.monsterId);
        return {id:stage.monsterId,name:stage.monsterName,skills:stage.attackIds.map(attackName),active:index===trial.index,cleared:index<trial.index,vitality:actor?.vitality,maxVitality:actor?.maxVitality,boss:ramp[index]!.boss};
      }),trial:{stage:Math.min(trial.index+1,trials.length),totalStages:trials.length,status:trial.status,complete,boss:ramp[Math.min(trial.index,trials.length-1)]!.boss,level:ramp[Math.min(trial.index,trials.length-1)]!.level}};
    }
    const phase=encounter.phases[this.state.phaseIndex];
    return {title:phase?.id.replaceAll('-',' ')??'Encounter',monsters:encounter.actorIds.filter(id=>id!==this.state.playerId).map(id=>{
      const actor=this.state.actors.find(candidate=>candidate.id===id);
      return {id,name:id.replaceAll('-',' '),skills:(phase?.attackIds??[]).filter(attack=>ATTACKS[attack]?.bossId===id).map(attackName),active:!this.state.rewardEmitted,cleared:this.state.rewardEmitted,vitality:actor?.vitality,maxVitality:actor?.maxVitality};
    })};
  }
  private skillReason(id:PlayerSkillId,targetId=this.state.targetId,counter=false):string{
    const player=this.playerActor();
    if(this.playerIsDown()||!player)return 'Downed';
    if(this.state.timePolicy==='paused')return 'Paused';
    if(this.state.traversal)return 'Traversing';
    if(id==='jump'&&this.state.playerJump){
      const jump=this.state.playerJump;
      if(jump.boosted)return 'Boost used';
      if(this.state.tick>=jump.flightStartedAtTick+jump.flightTicks)return 'Landing';
      return this.state.player.mana<PLAYER_SKILLS.jump.manaCost?'Need '+PLAYER_SKILLS.jump.manaCost+' mana':'';
    }
    if(id==='heavy'&&this.state.heavyChargeStartTick!==null&&!counter)return 'Charging — release';
    const sigil=id==='sigil_bolt'||id==='sigil_barrage';
    if(sigil&&this.state.sigilCharge)return '';
    const busy=id==='dive'
      ?this.state.tick<this.state.actionUntil&&(!this.state.actionCancelable||!!EVASION_PROFILES[this.state.actionId as EvasionProfileId])
      :!counter&&this.state.tick<this.state.actionRecoveryUntil&&!(id==='light'&&this.lightChainOpen());
    if(busy)return 'Recovering';
    if(id==='judgement')return this.state.player.instinct<JUDGEMENT_INSTINCT?'Need full Instinct':'';
    if(this.state.player.mana<PLAYER_SKILLS[id].manaCost)return 'Need '+PLAYER_SKILLS[id].manaCost+' mana';
    if(id==='dive'||id==='jump'||id==='light'||sigil)return '';
    if((this.state.heroId==='yara'||this.kit)&&(id==='heavy'||id==='charged_heavy'))return '';
    const target=targetId&&this.actorForId(targetId);
    if(!target||!target.visible||target.downed||id!=='cleanse'&&target.allegiance!=='hostile'&&!target.possessed)return 'No target';
    if(id==='cleanse'&&(target.corruption??0)<=0&&!target.possessed)return 'No corruption';
    if(id==='root_tether'&&!this.state.telegraphs.some(telegraph=>telegraph.sourceId===target.id&&(telegraph.phase==='windup'||telegraph.phase==='commit')))return 'Wait for windup';
    return '';
  }
  private playerSkills():readonly PlayerSkillSnapshot[]{
    const target=this.state.targetId&&this.actorForId(this.state.targetId);
    const contextual:PlayerSkillId=(target&&((target.corruption??0)>0||target.possessed)&&(this.snapshotBossExposed(target)))?'cleanse':'root_tether';
    const charging=this.state.heavyChargeStartTick!==null;
    const heavy:PlayerSkillId=charging&&this.state.tick-this.state.heavyChargeStartTick!>=THUNDER_CLEAVE.holdTicks?'charged_heavy':'heavy';
    const sigilCharge=this.state.sigilCharge;
    const sigil:PlayerSkillId=sigilCharge?'sigil_barrage':'sigil_bolt';
    const labels=this.kit?.labels??(this.state.heroId==='yara'?HEARTROOT_LABELS:undefined);
    return (['dive','jump','light',heavy,sigil,contextual,'judgement'] as const).map(id=>{
      const definition=PLAYER_SKILLS[id],release=charging&&(id==='heavy'||id==='charged_heavy');
      const reason=this.skillReason(id,this.state.targetId,release||(id==='light'||id==='heavy')&&this.state.counterUntil>this.state.tick);
      const idle=sigilCharge&&id==='sigil_barrage'?(this.state.tick+1-sigilCharge.startedTick>=SIGIL.barrageHoldTicks?'Release to fire':'Hold to charge'):release?'Release to strike':'Ready';
      return {id,label:labels?.[id]??definition.label,binding:definition.binding,manaCost:definition.manaCost,available:reason==='',reason:reason||idle};
    });
  }
  private snapshotBossExposed(target:CombatActor):boolean{
    return this.state.worldTick<target.staggerUntil||this.state.worldTick<(target.weakPointUntil??0);
  }
  private spendMana(id:PlayerSkillId):boolean{
    const cost=PLAYER_SKILLS[id].manaCost;
    if(this.state.player.mana<cost)return false;
    this.state.player.mana-=cost;
    return true;
  }

  private refreshCombatSolids(): void {
    const colliders = new Map<string, RegionColliderDefinition>();
    for (const collider of this.state.arena.colliders) {
      if (!collider.id.startsWith('combat-obstacle:')&&!collider.id.startsWith('trial-gate:')) colliders.set(collider.id, collider);
    }
    for (const collider of this.state.sceneColliders) colliders.set(collider.id, collider);
    for (const obstacle of this.state.combatObstacles) colliders.set(obstacle.collider.id, obstacle.collider);
    if(this.state.combatTrial){
      const trials=this.trials();
      for(let index=this.state.combatTrial.index;index<trials.length;index++){const gate=trials[index]!.gate;colliders.set(gate.id,gate);}
    }
    this.state.arena.colliders = [...colliders.values()];
  }

  private expireCombatObstacles(): void {
    for (const obstacle of this.state.combatObstacles) {
      if (this.state.worldTick >= obstacle.expiresAtWorldTick) {
        this.state.combatObstacles = this.state.combatObstacles.filter(solid => this.state.worldTick < solid.expiresAtWorldTick);
        this.refreshCombatSolids();
        return;
      }
    }
  }

  private clearCombatObstacles(sourceId?: ActorId): void {
    if (!this.state.combatObstacles.length) return;
    this.state.combatObstacles = sourceId ? this.state.combatObstacles.filter(obstacle => obstacle.sourceId !== sourceId) : [];
    this.refreshCombatSolids();
  }

  private spawnCombatObstacles(hazard: LiveHazard, attack: AttackDefinition | undefined): void {
    if (attack?.element !== 'ice' && !/root|sap|stomp|march|seismic|trample|thorn|charge/.test(hazard.attackId)) return;
    const kind = attack?.element === 'ice' ? 'ice' : 'roots';
    // Opposing flanks, not a ring: the central 1.46m escape corridor always remains open.
    for (const side of [-1, 1]) {
      if (this.state.combatObstacles.length >= 8) break;
      const x = hazard.target.x + hazard.direction.z * side * 1.15;
      const z = hazard.target.z - hazard.direction.x * side * 1.15;
      const y = groundHeightAt(this.state.arena, x, z, hazard.target.y);
      if (y === null) continue;
      const foot = vec(x, y, z);
      const escapeRadius = this.playerActor()?.radius ?? 0.42;
      if (!isSupportedCapsulePose(this.state.arena, foot, 0.42 + escapeRadius * 2 + 0.12, 1.4)) continue;
      if (this.state.combatObstacles.some(obstacle => distance2(obstacle.collider.from, foot) < 0.84 + escapeRadius * 2 + 0.12)) continue;
      if (this.state.actors.some(actor => actor.visible && !actor.downed && distance2(actor.position, foot) < actor.radius + 0.62)) continue;
      if (this.state.traversalGates.some(gate => distance2(gate.from, foot) < 1.15 || distance2(gate.to, foot) < 1.15)) continue;
      const id = `combat-obstacle:${hazard.id}:${side}`;
      const collider: RegionColliderDefinition = { id, kind: 'capsule', from: vec(x, y + 0.42, z), to: vec(x, y + 0.98, z), radius: 0.42, blocksMovement: true, blocksCamera: true };
      this.state.combatObstacles.push({ id, sourceId: hazard.sourceId, attackId: hazard.attackId, kind, collider, spawnedAtWorldTick: this.state.worldTick, expiresAtWorldTick: this.state.worldTick + (kind === 'ice' ? 240 : 180) });
      // Check the second flank against the first, using the same authoritative collision path.
      this.refreshCombatSolids();
    }
  }
  private effectiveWorldTimeScale():number{
    if(this.state.timePolicy==='paused'||this.state.hitStop)return 0;
    if(this.state.timePolicy==='perfect-dodge-slow'&&this.state.slowMotionRemainingTicks>0)return PERFECT_DODGE_EFFECTS.worldTimeScale;
    return 1;
  }
  get companions(): CompanionRosterState { return structuredClone(this.state.companionState); }
  private updateActors(worldScale:number):void{
    for(const actor of this.state.actors){
      if(actor.id===this.state.playerId&&this.state.traversal)continue;
      if(actor.downed)continue;
      if(actor.possessed&&actor.possessedUntil>0&&this.state.worldTick>=actor.possessedUntil)this.breakPossession(actor,true);
      const actionDuration=Math.max(1,actor.actionEndsTick-actor.actionStartedTick);
      if(actor.actionEndsTick>0){
        // Aren's persisted timestamps are authoritative, including the exact completion tick.
        actor.normalizedTime=actor.id===this.state.playerId
          ?Math.min(1,Math.max(0,(this.state.tick-actor.actionStartedTick)/actionDuration))
          :Math.min(1,actor.normalizedTime+worldScale/actionDuration);
      }
      if(actor.actionEndsTick>0&&actor.normalizedTime>=1){
        actor.phase='idle';
        actor.actionId=ACTION_CLIPS.idle!;
        actor.normalizedTime=0;
        actor.actionStartedTick=actor.id===this.state.playerId?this.state.tick:this.state.worldTick;
        actor.actionEndsTick=0;
      }
    }
  }
  private updatePlayer(input: CombatInput): void {
    const lift = this.liftKitCancel(input);
    this.kitCancelLift = lift !== undefined;
    this.updatePlayerInput(lift ? this.kitCancelInput(input, lift.window.into) : input);
    this.kitCancelLift = false;
    if (lift) this.settleKitCancel(lift);
  }
  /** The tick's input reduced to the movement axes plus the actions the window lists; every other action (Jump, Ultimate, Tether, Ferocity, Corruption, Cleanse, Interact, commands, target cycling...) is dropped so one routed button cannot unlock a simultaneous unlisted one. */
  private kitCancelInput(input: CombatInput, into: ReadonlyArray<KitCancelInput>): CombatInput {
    const heavy = into.includes('heavy');
    return {
      tick: input.tick, move: input.move, sprintHeld: input.sprintHeld,
      dodgePressed: input.dodgePressed && into.includes('dodge'), dodgeDirection: into.includes('dodge') ? input.dodgeDirection : undefined,
      lightPressed: input.lightPressed && into.includes('light'),
      heavyPressed: input.heavyPressed && heavy, heavyHeld: input.heavyHeld && heavy, heavyReleased: input.heavyReleased && heavy, heavyHeldTicks: heavy ? input.heavyHeldTicks : undefined,
      rangedPressed: input.rangedPressed && into.includes('ranged'), rangedHeld: input.rangedHeld && into.includes('ranged'), rangedReleased: input.rangedReleased && into.includes('ranged'),
      tetherPressed: input.tetherPressed && into.includes('tether'),
      ultimatePressed: input.ultimatePressed && into.includes('ultimate'),
      interactPressed: false,
    };
  }
  /** Opens the lock/recovery gates for one update when the kit's cancel window routes a pressed input; undefined when nothing is lifted. */
  private liftKitCancel(input: CombatInput): KitCancelLift | undefined {
    const s = this.state, window = s.kitCancel, player = this.playerActor();
    if (!window || !player || s.tick < window.fromTick || s.tick >= s.actionRecoveryUntil || s.playerJump || s.traversal || this.playerIsDown()) return undefined;
    const into = window.into;
    const routed = input.lightPressed && into.includes('light') || input.heavyPressed && into.includes('heavy') || input.rangedPressed && into.includes('ranged')
      || input.dodgePressed && into.includes('dodge') || input.tetherPressed && into.includes('tether') || input.ultimatePressed && into.includes('ultimate');
    if (!routed) return undefined;
    const lift: KitCancelLift = {
      tick: s.tick, window, actionId: s.actionId, actionUntil: s.actionUntil, actionRecoveryUntil: s.actionRecoveryUntil, actionCancelable: s.actionCancelable,
      clip: player.actionId, startedTick: player.actionStartedTick, endsTick: player.actionEndsTick, normalizedTime: player.normalizedTime, phase: player.phase, velocity: player.velocity,
    };
    s.kitCancel = undefined; s.actionUntil = s.tick; s.actionRecoveryUntil = s.tick; s.actionCancelable = false;
    return lift;
  }
  /** When the routed input started nothing (no mana, no target), the cancelled action carries on exactly as before. */
  private settleKitCancel(lift: KitCancelLift): void {
    const s = this.state, player = this.playerActor();
    if (!player || s.actionId !== lift.actionId || s.actionUntil !== lift.tick || s.actionRecoveryUntil !== lift.tick) return;
    s.kitCancel = lift.window; s.actionUntil = lift.actionUntil; s.actionRecoveryUntil = lift.actionRecoveryUntil; s.actionCancelable = lift.actionCancelable;
    player.actionId = lift.clip; player.actionStartedTick = lift.startedTick; player.actionEndsTick = lift.endsTick; player.normalizedTime = lift.normalizedTime; player.phase = lift.phase; player.velocity = lift.velocity;
  }
  private updatePlayerInput(input: CombatInput): void {
    const player=this.playerActor();
    if(!player)return;
    if(player.downed||this.state.player.vitality<=0)return;
    if(this.state.deferredRelease)input=this.applyDeferredRelease(input);
    if(this.state.playerJump){
      this.updatePlayerJump(player,input);
      if(this.state.playerJump)return;
    }
    if(input.interactPressed&&input.traversalId){this.traverse(input.traversalId);return;}
    if(input.targetCycle)this.cycleTarget(input.targetCycle);
    if(input.dodgePressed&&this.tryDodge(player,input,input.dodgeDirection))return;
    if(input.jumpPressed&&this.state.tick>=this.state.actionRecoveryUntil&&this.state.heavyChargeStartTick===null&&!this.state.sigilCharge&&this.startPlayerJump(player,input))return;
    if(this.state.counterUntil>this.state.tick&&(input.lightPressed||input.heavyPressed&&!input.heavyHeld)){
      const counterAction=input.heavyPressed?'heavy':'light_1';
      this.state.counterUntil=0;
      this.startPlayerAction(counterAction,this.state.targetId,true);
      return;
    }
    if(this.state.bufferedAction&&this.state.tick>this.state.bufferedAction.expiresTick)this.state.bufferedAction=undefined;
    const focusedInteraction=input.interactionId?INTERACTIONS.find(item=>item.id===input.interactionId):undefined;
    const staticTarget=focusedInteraction&&input.interactionTargetId===focusedInteraction.targetId&&!this.state.actors.some(actor=>actor.id===focusedInteraction.targetId||actor.archetypeId===focusedInteraction.targetId);
    const focusedActionId=focusedInteraction?.playerActionId??focusedInteraction?.actionId;
    if(staticTarget&&focusedActionId==='staff-heavy'&&input.heavyPressed&&!input.heavyHeld){
      if(focusedInteraction?.playerActionId==='staff-heavy')this.startPlayerObjectHeavyAction(focusedInteraction,'heavy',input.interactTargetId);
      else this.startInteractionAction(focusedInteraction,'heavy');
      return;
    }
    if(staticTarget&&focusedActionId==='cleanse-pulse'&&input.cleansePressed){this.startInteractionAction(focusedInteraction,'cleanse');return;}
    if(this.lightChainOpen()&&this.state.heavyChargeStartTick===null&&!this.state.sigilCharge&&(input.lightPressed||this.state.bufferedAction?.action.startsWith('light_'))){
      // The next Warden Blade step is accepted from CHAIN_EARLY_TICKS before the current clip ends.
      this.state.bufferedAction=undefined;
      if(this.startLight(this.nextLightStep(),false,true))return;
    }
    if(this.state.bufferedAction&&this.state.tick>=this.state.actionRecoveryUntil){
      const queued=this.state.bufferedAction;
      this.state.bufferedAction=undefined;
      if(this.startBufferedAction(player,queued,input))return;
    }
    if(this.state.tick<this.state.actionRecoveryUntil&&this.state.actionRecoveryUntil-this.state.tick<=8)this.bufferAttackInput(input);
    if(input.heavyPressed&&input.heavyHeld&&this.state.heavyChargeStartTick===null&&this.state.tick>=this.state.actionRecoveryUntil&&this.state.player.mana>=PLAYER_SKILLS.heavy.manaCost){
      this.state.heavyChargeStartTick=this.state.tick;
      if(this.kitCancelLift)this.kit?.cancel();
      this.state.actionId='charged-heavy-charge';
      this.state.actionUntil=this.state.tick+3600;
      this.state.actionRecoveryUntil=this.state.actionUntil;
      this.state.actionCancelable=true;
      player.actionId=(this.kit?.clip('heavy_charge')??(this.state.heroId==='yara'?'yara-root-charge':'aren-charged-heavy-charge')) as ActionId;
      player.actionStartedTick=this.state.tick;player.normalizedTime=0;
      player.actionEndsTick=this.state.actionUntil;
      player.phase='anticipation';
      this.emit('cue','Charged Heavy: release Heavy to strike; Dodge cancels the charge.',player.id,this.state.targetId,'charged_heavy');
      return;
    }
    if(input.heavyReleased&&this.state.heavyChargeStartTick!==null){
      const heldTicks=input.heavyHeldTicks??this.state.tick-this.state.heavyChargeStartTick;
      this.state.heavyChargeStartTick=null;
      this.state.actionId='idle';
      this.state.actionUntil=this.state.tick;
      this.state.actionCancelable=false;
      this.state.actionRecoveryUntil=this.state.tick;
      player.actionId=ACTION_CLIPS.idle!;player.actionEndsTick=0;player.actionStartedTick=this.state.tick;player.normalizedTime=0;player.phase='idle';
      if(staticTarget&&focusedActionId==='staff-heavy'){
        if(focusedInteraction?.playerActionId==='staff-heavy')this.startPlayerObjectHeavyAction(focusedInteraction,heldTicks>=THUNDER_CLEAVE.holdTicks?'charged_heavy':'heavy',input.interactTargetId);
        else this.startInteractionAction(focusedInteraction,heldTicks>=THUNDER_CLEAVE.holdTicks?'charged_heavy':'heavy');
      }
      else this.startPlayerAction(heldTicks>=THUNDER_CLEAVE.holdTicks?'charged_heavy':'heavy',this.state.targetId);
      return;
    }
    if(this.state.heavyChargeStartTick!==null)return;
    if(this.state.sigilCharge){this.updateSigilCharge(player,input);return;}
    if(input.rangedPressed&&this.state.tick>=this.state.actionRecoveryUntil&&this.startRanged(player,input))return;
    if(input.ultimatePressed&&this.state.tick>=this.state.actionRecoveryUntil&&this.startJudgement(player))return;
    const finiteDodgePlaying=player.actionEndsTick>this.state.tick&&EVASION_ACTION_CLIPS.has(player.actionId);
    const locked=this.state.tick<this.state.actionUntil;
    if(locked){
      const evasionProfile=this.state.evasion?.id===this.state.actionId?this.state.evasion:EVASION_PROFILES[this.state.actionId as EvasionProfileId];
      if(evasionProfile&&finiteDodgePlaying)this.advanceEvasion(player,evasionProfile);
      else player.velocity=vec(0,0,0);
    }
    if(!locked){
      // Recovery still owns the finite clip/combat deadlines, not a movement lock.
      if(!finiteDodgePlaying||Math.hypot(input.move.x,input.move.z)>.001)this.applyPlayerMotion(player,input);
      else player.velocity=vec(0,0,0);
      const moving=Math.hypot(player.velocity.x,player.velocity.z)>.01;
      if(!finiteDodgePlaying){
        if(moving){
          player.actionId=input.sprintHeld?ACTION_CLIPS.run!:ACTION_CLIPS.walk!;
          if(player.actionEndsTick!==0){player.actionStartedTick=this.state.tick;player.actionEndsTick=0;player.normalizedTime=0;}
          player.phase='idle';
        }else if(player.actionEndsTick===0||player.normalizedTime>=1){
          player.actionId=ACTION_CLIPS.idle!;player.phase='idle';
        }
      }
      // A lifted kit cancel (already masked to the window's listed inputs) may start its action over the shared finite dodge clip.
      if(!finiteDodgePlaying||this.kitCancelLift){
        if(input.lightPressed)this.startLight(this.nextLightStep(),false,false);
        else if(input.heavyPressed)this.startPlayerAction('heavy',this.state.targetId);
        else if(input.tetherPressed)this.startPlayerAction('root_tether',this.state.targetId);
        else if(input.ferocityPressed)this.startPlayerAction('ferocity',this.state.targetId);
        else if(input.corruptionPressed)this.startPlayerAction('corruption',this.state.targetId);
        else if(input.cleansePressed)this.startPlayerAction('cleanse',input.interactTargetId??this.state.targetId);
        else if(input.command)this.commandCompanion(input.command.companionId,input.command.command,input.command.targetId);
      }
    }
  }
  /** Screen-relative input with analog magnitude retained and diagonals capped. */
  private motionDesired(input: CombatInput): Vec3 {
    const basis=this.state.arena.cameraBasis??{forward:vec(0,0,-1),right:vec(1,0,0)};
    const x=input.move.x*basis.right.x+input.move.z*basis.forward.x;
    const z=input.move.x*basis.right.z+input.move.z*basis.forward.z;
    const divisor=Math.max(1,Math.hypot(x,z));
    return vec(x/divisor,0,z/divisor);
  }

  private applyPlayerMotion(player:CombatActor,input:CombatInput):void{
    const desired=this.motionDesired(input);
    const hasInput=Math.hypot(desired.x,desired.z)>.001;
    const hero=HERO_COMBAT[this.state.heroId],speed=(input.sprintHeld?hero.runSpeed:hero.walkSpeed)*(this.state.playerSlow?.factor??1)*(this.kit?.moveSpeedScale?.()??1);
    const targetX=desired.x*speed,targetZ=desired.z*speed;
    const dx=targetX-player.velocity.x,dz=targetZ-player.velocity.z;
    const change=Math.hypot(dx,dz);
    const maxChange=(hasInput?hero.runSpeed/PLAYER_MOVE_ACCEL_TICKS:hero.runSpeed/PLAYER_MOVE_DECEL_TICKS);
    const blend=change>maxChange?maxChange/change:1;
    const vx=player.velocity.x+dx*blend,vz=player.velocity.z+dz*blend;
    const previous=player.position;
    player.position=moveCircle(this.state.arena,previous,vec(vx*FIXED_STEP_SECONDS,0,vz*FIXED_STEP_SECONDS),PLAYER_RADIUS,player.collisionHeight);
    player.velocity=scale(sub(player.position,previous),1/FIXED_STEP_SECONDS);
    if(hasInput)this.state.player.mana=Math.min(this.state.player.maxMana,this.state.player.mana+distance2(previous,player.position)*MANA_PER_METRE);
    if(hasInput)player.facing=normalize(desired);
  }

  private updatePlayerJump(player:CombatActor,input:CombatInput):void{
    let jump=this.state.playerJump!;
    if(input.jumpPressed&&this.state.tick>jump.startedAtTick&&this.state.tick<=jump.airStartedAtTick&&!jump.boosted)jump.boostQueued=true;
    if(this.state.tick>=this.state.actionUntil){
      this.state.playerJump=undefined;
      this.finishAction();
      // updatePlayer owns this tick's grounded step; never integrate twice.
      return;
    }
    let landingAt=jump.flightStartedAtTick+jump.flightTicks;
    if(this.state.tick>landingAt){
      if(Math.hypot(input.move.x,input.move.z)>.001)this.applyPlayerMotion(player,input);
      else player.velocity=vec(0,0,0);
      player.phase='recovery';
      return;
    }
    if(this.state.tick>jump.airStartedAtTick){
      const steering=this.jumpSteering(input);
      const boost=(input.jumpPressed||jump.boostQueued)&&!jump.boosted&&this.state.player.mana>=PLAYER_SKILLS.jump.manaCost;
      jump.boostQueued=false;
      const change=distance2(steering,jump.steering)>.001;
      if(boost||change){
        const segmentStart=this.state.tick-1;
        const remaining=landingAt-segmentStart;
        const fraction=Math.max(0,Math.min(1,(segmentStart-jump.flightStartedAtTick)/jump.flightTicks));
        const candidate:PlayerJumpState={...jump,from:copy(player.position),flightStartedAtTick:segmentStart,flightTicks:boost?PLAYER_JUMP_FLIGHT_TICKS:remaining,apex:boost?PLAYER_JUMP_BOOST_APEX:jump.apex*(1-fraction)**2,airStartedAtTick:boost?segmentStart:jump.airStartedAtTick,boosted:jump.boosted||!!boost,steering,anticipationFrom:undefined};
        const landing=this.planJumpLanding(candidate,player.collisionHeight);
        if(landing){
          candidate.to=landing;
          this.state.playerJump=jump=candidate;
          landingAt=jump.flightStartedAtTick+jump.flightTicks;
          if(boost){
            this.spendMana('jump');
            this.state.actionUntil=landingAt+PLAYER_JUMP_LANDING_TICKS;
            this.state.actionRecoveryUntil=this.state.actionUntil;
            player.actionEndsTick=this.state.actionUntil;
          }
          if(Math.hypot(steering.x,steering.z)>.001)player.facing=normalize(steering);
        }
      }
    }
    const previous=player.position;
    const elapsed=this.state.tick-jump.startedAtTick;
    if(elapsed<=PLAYER_JUMP_ANTICIPATION_TICKS&&!jump.boosted){
      if(jump.anticipationFrom){
        const progress=(elapsed+1)/(PLAYER_JUMP_ANTICIPATION_TICKS+1);
        const x=jump.anticipationFrom.x+(jump.from.x-jump.anticipationFrom.x)*progress;
        const z=jump.anticipationFrom.z+(jump.from.z-jump.anticipationFrom.z)*progress;
        player.position=moveCircle(this.state.arena,previous,vec(x-previous.x,0,z-previous.z),PLAYER_RADIUS,player.collisionHeight);
      }
    }else{
      const desired=jumpPosition(jump.from,jump.to,this.state.tick-jump.flightStartedAtTick,jump.flightTicks,jump.apex);
      player.position=moveAerialCircle(this.state.arena,previous,sub(desired,previous),PLAYER_RADIUS,player.collisionHeight);
    }
    player.velocity=scale(sub(player.position,previous),1/FIXED_STEP_SECONDS);
    player.phase=this.state.tick<=jump.airStartedAtTick?'anticipation':this.state.tick<landingAt?'active':'recovery';
  }

  private jumpSteering(input:CombatInput):Vec3{
    const hero=HERO_COMBAT[this.state.heroId];
    return scale(this.motionDesired(input),(input.sprintHeld?hero.runSpeed:hero.walkSpeed)*(this.state.playerSlow?.factor??1)*(this.kit?.moveSpeedScale?.()??1));
  }

  /** Every accepted trajectory has a swept clear arc and a supported landing; a blocked input shortens travel, never teleports. */
  private planJumpLanding(jump:PlayerJumpState,collisionHeight:number):Vec3|undefined{
    const desired=add(jump.from,scale(jump.steering,jump.flightTicks*FIXED_STEP_SECONDS));
    const maximum=jump.boosted?PLAYER_JUMP_BOOST_MAX_DISTANCE:PLAYER_JUMP_MAX_DISTANCE;
    const reach=distance2(jump.origin,desired);
    const target=reach>maximum?vec(jump.origin.x+(desired.x-jump.origin.x)*maximum/reach,desired.y,jump.origin.z+(desired.z-jump.origin.z)*maximum/reach):desired;
    const candidates=Math.max(1,Math.ceil(distance2(jump.from,target)/.1));
    for(let index=candidates;index>=0;index--){
      const progress=index/candidates;
      const x=jump.from.x+(target.x-jump.from.x)*progress,z=jump.from.z+(target.z-jump.from.z)*progress;
      const y=groundHeightAt(this.state.arena,x,z,jump.origin.y);
      if(y===null||Math.abs(y-jump.origin.y)>.45)continue;
      const to=vec(x,y,z);
      if(!isSupportedCapsulePose(this.state.arena,to,PLAYER_RADIUS,collisionHeight))continue;
      let previous=jump.from,clear=true;
      for(let tick=1;tick<=jump.flightTicks;tick++){
        const point=jumpPosition(jump.from,to,tick,jump.flightTicks,jump.apex);
        if(!isAerialCirclePathClear(this.state.arena,previous,point,PLAYER_RADIUS,collisionHeight)){clear=false;break;}
        previous=point;
      }
      if(clear)return to;
    }
    return undefined;
  }

  private startPlayerObjectHeavyAction(interaction:InteractionDefinition,action:'heavy'|'charged_heavy',targetId?:ActorId):boolean{
    const success=interaction.success;
    if(success.type!=='object-move')return false;
    const object=this.state.movableObjects.find(candidate=>candidate.objectId===success.objectId);
    const player=this.playerActor();
    if(!object||!player||player.downed||this.koroAssignedToParty()||interaction.regionId!==this.state.regionId||!targetId||targetId!==object.objectId||interaction.id!==object.authored.playerInteractionId||interaction.targetId!==object.objectId||interaction.playerActionId!=='staff-heavy'||interaction.actionId!==undefined||object.phase!=='resting'||this.state.worldFacts[object.authored.movedFactId]===true||object.authored.requiredFacts.some(fact=>this.state.worldFacts[fact]!==true)||interaction.requiresFacts.some(fact=>this.state.worldFacts[fact]!==true)||this.state.tick<this.state.actionRecoveryUntil)return false;
    if(interaction.requiresActors.some(id=>{const required=this.actorForId(id);return !required||!required.visible||required.downed||required.possessed;}))return false;
    if(distance2(player.position,object.position)>interaction.radiusMeters)return false;
    if(!this.spendMana(playerSkillId(action)))return false;
    const range=action==='charged_heavy'?2.8:2.5;
    const radius=action==='charged_heavy'?1.15:1;
    const duration=action==='charged_heavy'?58:45;
    const activeAt=this.state.tick+(action==='charged_heavy'?36:20);
    const attackId=('aren-'+action) as AttackId;
    const target=object.objectId as ActorId;
    this.state.targetId=target;this.state.actionId=action;this.state.actionUntil=this.state.tick+duration;this.state.actionRecoveryUntil=this.state.actionUntil+18;this.state.actionCancelable=false;
    player.actionId=ACTION_CLIPS[action]!;player.actionStartedTick=this.state.tick;player.normalizedTime=0;player.actionEndsTick=this.state.tick+duration+18;player.phase='anticipation';player.targetId=target;
    const cue='Aren draws the staff back toward the loose snare.';
    const id=this.state.runId+':'+this.state.tick+':'+interaction.id+':'+action;
    this.state.telegraphs.push({id,attackId,sourceId:player.id,targetPosition:copy(object.position),phase:'windup',remainingTicks:activeAt-this.state.tick,cue});
    this.state.pendingImpact={activeAt,activeUntil:activeAt+6,target,action,range,radius,damage:0,interrupt:false,counter:false,startVitality:this.state.player.vitality,resolved:false,interactionId:interaction.id,interactionPosition:copy(object.position)};
    this.emit('cue',cue,player.id,target,action,attackId);
    this.queuePresentationCue({kind:'anticipation',phase:'anticipation',actorId:player.id,targetId:target,position:copy(object.position),from:copy(player.position),to:copy(object.position),scopeId:this.state.encounterId,attackId,actionId:ACTION_CLIPS[action],footprint:{width:1,length:action==='charged_heavy'?2.8:2.5},durationTicks:activeAt-this.state.tick,priority:'essential',shape:'trail'});
    return true;
  }
  private startInteractionAction(interaction:InteractionDefinition,action:'heavy'|'charged_heavy'|'cleanse'):boolean{
    const player=this.playerActor();
    const playerAction=action==='cleanse'?'cleanse-pulse':'staff-heavy';
    if(!player||player.downed||interaction.actionId!==playerAction||this.state.tick<this.state.actionRecoveryUntil)return false;
    const region=REGIONS.find(candidate=>candidate.id===this.state.regionId);
    if(!region)return false;
    const targetActor=this.actorForId(interaction.targetId as ActorId);
    if(targetActor?.visible&&!targetActor.downed)return false;
    const entity=region.entities.find(candidate=>candidate.interactionId===interaction.id||candidate.id===interaction.id)??region.entities.find(candidate=>candidate.id===interaction.targetId);
    const position=entity?.position;
    if(!position||distance2(player.position,position)>interaction.radiusMeters)return false;
    if(!this.spendMana(playerSkillId(action)))return false;
    const duration=action==='charged_heavy'?58:action==='heavy'?45:90;
    const activeAt=this.state.tick+(action==='charged_heavy'?36:action==='heavy'?20:35);
    const attackId=`aren-${action}` as AttackId;
    this.state.targetId=interaction.targetId as ActorId;
    this.state.actionId=action;this.state.actionUntil=this.state.tick+duration;this.state.actionRecoveryUntil=this.state.actionUntil+18;this.state.actionCancelable=false;
    player.actionId=ACTION_CLIPS[action]!;player.actionStartedTick=this.state.tick;player.normalizedTime=0;player.actionEndsTick=this.state.tick+duration+18;player.phase='anticipation';player.targetId=this.state.targetId;player.facing=facingFrom(sub(position,player.position));
    const cue=action==='cleanse'?'Root light gathers around the world mechanism.':'Aren draws back the staff for a heavy strike.';
    const id=`${this.state.runId}:${this.state.tick}:${interaction.id}:${action}`;
    this.state.telegraphs.push({id,attackId,sourceId:player.id,targetPosition:copy(position),phase:'windup',remainingTicks:activeAt-this.state.tick,cue});
    this.state.pendingImpact={activeAt,activeUntil:activeAt+6,target:this.state.targetId,action,range:interaction.radiusMeters,radius:0,damage:action==='charged_heavy'?36:action==='heavy'?22:0,interrupt:action!=='cleanse',counter:false,startVitality:this.state.player.vitality,resolved:false,interactionId:interaction.id,interactionPosition:copy(position)};
    this.emit('cue',cue,player.id,this.state.targetId,action,attackId);
    this.queuePresentationCue({kind:action==='cleanse'?'cleanse':'anticipation',phase:'anticipation',actorId:player.id,targetId:this.state.targetId,position:copy(position),from:copy(player.position),to:copy(position),scopeId:this.state.encounterId,attackId,actionId:ACTION_CLIPS[action],footprint:{width:1,length:action==='charged_heavy'?2.8:2.5},durationTicks:activeAt-this.state.tick,priority:'essential',shape:action==='cleanse'?'pulse':'trail'});
    return true;
  }
  private startPlayerJump(player:CombatActor,input:CombatInput):boolean{
    if(!isSupportedCapsulePose(this.state.arena,player.position,PLAYER_RADIUS,player.collisionHeight)||this.state.player.mana<PLAYER_SKILLS.jump.manaCost)return false;
    const steering=this.jumpSteering(input),moving=Math.hypot(steering.x,steering.z)>.001;
    const direction=moving?normalize(steering):player.facing;
    const origin=copy(player.position);
    let from=origin;
    const launchDistance=moving?Math.min(HERO_COMBAT[this.state.heroId].runSpeed,Math.max(0,dot(player.velocity,direction)))*(PLAYER_JUMP_ANTICIPATION_TICKS+1)*FIXED_STEP_SECONDS:0;
    if(launchDistance>0){
      const takeoff=moveCircle(this.state.arena,origin,scale(direction,launchDistance),PLAYER_RADIUS,player.collisionHeight);
      if(Math.abs(distance2(origin,takeoff)-launchDistance)<1e-6&&isCirclePathClear(this.state.arena,origin,takeoff,PLAYER_RADIUS,player.collisionHeight)&&isSupportedCapsulePose(this.state.arena,takeoff,PLAYER_RADIUS,player.collisionHeight))from=takeoff;
    }
    const flightStartedAtTick=this.state.tick+PLAYER_JUMP_ANTICIPATION_TICKS;
    const jump:PlayerJumpState={startedAtTick:this.state.tick,origin,from,to:from,flightStartedAtTick,flightTicks:PLAYER_JUMP_FLIGHT_TICKS,apex:PLAYER_JUMP_APEX,airStartedAtTick:flightStartedAtTick,boosted:false,steering,...(from!==origin?{anticipationFrom:origin}:{})};
    const landing=this.planJumpLanding(jump,player.collisionHeight);
    if(!landing)return false;
    jump.to=landing;
    this.spendMana('jump');this.state.lightIndex=0;
    this.state.playerJump=jump;
    this.state.actionId='jump';
    this.state.actionUntil=flightStartedAtTick+PLAYER_JUMP_FLIGHT_TICKS+PLAYER_JUMP_LANDING_TICKS;
    this.state.actionRecoveryUntil=this.state.actionUntil;
    this.state.actionCancelable=false;
    player.actionId=ACTION_CLIPS.jump!;
    player.actionStartedTick=this.state.tick;
    player.actionEndsTick=this.state.actionUntil;
    player.normalizedTime=0;
    player.phase='anticipation';
    player.facing=direction;
    this.updatePlayerJump(player,input);
    this.kit?.onSharedSkill?.('jump');
    return true;
  }
  private tryDodge(player: CombatActor,input:CombatInput,dodgeDirection?:EvasionDirection): boolean {
    if(this.playerIsDown()||this.state.traversal)return false;
    if(this.state.tick<this.state.actionUntil&&(!this.state.actionCancelable||EVASION_PROFILES[this.state.actionId as EvasionProfileId]))return false;
    if(!this.spendMana('dive')){this.emit('cue','Dive needs 25 mana. Walk or run to restore mana.',player.id);return false;}
    const start=copy(player.position);
    const basis=this.state.arena.cameraBasis;
    const {profile:baseProfile,travelVector,side}=dodgeDirection!==undefined?this.selectAuthoredDodge(player,dodgeDirection,basis):this.selectDefaultDive(player,input,basis);
    const kitDodge=this.kit?.dodge;
    const profile:EvasionProfile=kitDodge?{...baseProfile,distance:kitDodge.distance,durationTicks:kitDodge.durationTicks,iframes:kitDodge.iframes,recoveryTicks:kitDodge.recoveryTicks}:baseProfile;
    const travelLength=Math.hypot(travelVector.x,travelVector.z);
    if(this.state.heavyChargeStartTick!==null){this.state.heavyChargeStartTick=null;this.emit('action','Charged Heavy cancelled by Dodge.',player.id,undefined,'charged_heavy');}
    this.cancelPlayerAttackState();
    this.state.bufferedAction=undefined;
    // Launch facing tracks the chosen travel direction so the actor mesh aligns to the dive.
    if(travelLength>1e-4)player.facing=vec(travelVector.x/travelLength,0,travelVector.z/travelLength);
    // Velocity points along the chosen travel direction; advanceEvasion integrates the smooth
    // progress curve from this reference. Per-tick swept collisions happen inside advanceEvasion
    // (no teleport on the first tick; first step is progress(1/duration) * profile.distance).
    player.velocity=scale(travelVector,profile.distance/(profile.durationTicks*FIXED_STEP_SECONDS));
    player.actionStartedTick=this.state.tick;
    player.normalizedTime=0;
    player.actionEndsTick=this.state.tick+profile.durationTicks+profile.recoveryTicks;
    player.actionId=(ACTION_CLIPS[profile.id]??ACTION_CLIPS.stumble_recovery!) as ActionId;
    player.phase='start';
    player.invulnerableUntil=this.state.tick+profile.iframes;
    this.state.actionId=profile.id;
    this.state.actionUntil=this.state.tick+profile.durationTicks;
    this.state.actionRecoveryUntil=this.state.tick+profile.durationTicks+profile.recoveryTicks;
    this.state.actionCancelable=true;
    this.state.evasion=kitDodge?profile:undefined;
    this.state.kitCancel=kitDodge?.cancel?{fromTick:this.state.tick+kitDodge.cancel.fromTick,into:[...kitDodge.cancel.into]}:undefined;
    // Predict the destination along the chosen travel direction for perfect-dodge threat tests
    // (no actual teleport — the position is only used to evaluate whether the dive would clear
    // the committed hazard).
    let predicted:Vec3;
    if(kitDodge){predicted=start;for(let elapsed=0;elapsed<profile.durationTicks;elapsed++)predicted=this.evasionStep(predicted,player.facing,profile,elapsed,true);}
    else predicted=moveCircle(this.state.arena,start,scale(travelVector,profile.distance),PLAYER_RADIUS,profile.collisionHeight??player.collisionHeight);
    if(this.state.heroId==='yara'||kitDodge?.blinkCue)this.queuePresentationCue({kind:'blink',phase:'commit',actorId:player.id,position:copy(start),from:copy(start),to:copy(predicted),durationTicks:profile.durationTicks,element:this.heroElement(),...(kitDodge?{actionId:kitDodge.clip}:{}),priority:'essential',shape:'trail'});
    const threatened=this.findThreatenedHazard(start,{...player,position:predicted},profile.id);
    if(threatened){
      const key=threatened.sourceId+':'+threatened.attackId+':'+threatened.startTick+':'+threatened.hitGroup;
      if(!this.state.perfectDodgeKeys.includes(key)){
        this.state.perfectDodgeKeys.push(key);
        if(this.state.timePolicy!=='perfect-dodge-slow')this.state.slowMotionElapsedTicks=0;
        this.state.timePolicy='perfect-dodge-slow';
        const extension=Math.min(PERFECT_DODGE_EFFECTS.slowMotionTicks,PERFECT_DODGE_EFFECTS.maxSlowMotionTicks-this.state.slowMotionElapsedTicks-this.state.slowMotionRemainingTicks);
        this.state.slowMotionRemainingTicks+=Math.max(0,extension);
        this.state.worldTimeScale=this.effectiveWorldTimeScale();
        this.state.player.instinct=Math.min(100,this.state.player.instinct+PERFECT_DODGE_EFFECTS.instinctGain);
        this.state.counterUntil=this.state.tick+PERFECT_DODGE_EFFECTS.counterWindowTicks;
        const recoveryReduction=Math.min(PERFECT_DODGE_EFFECTS.playerRecoveryReductionTicks,Math.max(0,this.state.actionRecoveryUntil-this.state.tick));
        this.state.actionRecoveryUntil-=recoveryReduction;
        const companionId=this.state.companionState.combat??this.state.companionState.utility;
        const companionSlot=companionId?this.state.companionState.slots[companionId]:undefined;
        if(companionSlot)companionSlot.readyAt=Math.max(this.state.tick,companionSlot.readyAt-PERFECT_DODGE_EFFECTS.petRecoveryReductionTicks);
        const weakPointTarget=this.state.actors.find(actor=>actor.id===threatened.sourceId);
        if(weakPointTarget)weakPointTarget.weakPointUntil=Math.max(weakPointTarget.weakPointUntil??0,this.state.worldTick+PERFECT_DODGE_EFFECTS.weakPointDurationTicks);
        const perfectAction=`perfect_dodge_${side}` as EvasionProfileId;
        if(!kitDodge)player.actionId=ACTION_CLIPS[perfectAction]!;
        this.emit('perfect-dodge','Perfect Dodge — threat cleared; counter window open.',player.id,threatened.sourceId,perfectAction,threatened.attackId);
        this.emit('counter-open','Choose a quick counter or coordinate with a ready companion.',player.id,threatened.sourceId);
        const possessed=this.state.actors.find(actor=>actor.id===threatened.sourceId&&actor.possessed);
        if(possessed)this.breakPossession(possessed);
      }
    }
    this.emit('action',`Evasion: ${profile.id}`,player.id,undefined,profile.id);
    this.kit?.onDodge?.({from:start,to:predicted,durationTicks:profile.durationTicks});
    this.kit?.onSharedSkill?.('dodge');
    // Integrate the first step on the launching tick so locomotion is continuous.
    this.advanceEvasion(player,profile);
    return true;
  }
  private selectDefaultDive(player:CombatActor,input:CombatInput,basis?:CameraBasis):{profile:EvasionProfile,travelVector:Vec3,side:'left'|'right'}{
    const desired=this.motionDesired(input);
    const travelVector=normalize(Math.hypot(desired.x,desired.z)>.001?desired:player.facing);
    const side=dot(travelVector,basis?.right??vec(1,0,0))<0?'left':'right';
    const profile=side==='left'?EVASION_PROFILES.forward_left_dive_roll:EVASION_PROFILES.forward_right_dive_roll;
    return {profile,travelVector,side};
  }
  /**
   * Explicit dodgeDirection path: preserve the existing authored evasion profiles (quick steps,
   * cartwheels, handsprings, back pivots, vault/slide). Used by tests and any authored caller.
   */
  private selectAuthoredDodge(player:CombatActor,direction:EvasionDirection,basis?:CameraBasis):{profile:EvasionProfile,travelVector:Vec3,side:'left'|'right'}{
    const profile=resolveProfile(direction,this.state.arena.traversalAffordances??[],player.position,this.state.hazards,this.state.worldTick);
    const travelVector=profileVector(profile.id,direction,player.facing,basis);
    const right=basis?.right??vec(1,0,0);
    const side=dot(travelVector,right)<0?'left':'right';
    return {profile,travelVector,side};
  }

  /** One dodge tick. Kit dodges travel far enough to leave the arena or a ramp, so every step must land on a fully supported capsule pose; otherwise the dash stops at the farthest supported pose. */
  private evasionStep(from:Vec3,facing:Vec3,profile:EvasionProfile,elapsed:number,supportChecked:boolean):Vec3{
    const stepDistance=profile.distance*(evasionDistanceProgress((elapsed+1)/profile.durationTicks)-evasionDistanceProgress(elapsed/profile.durationTicks));
    const height=profile.collisionHeight??this.playerActor()?.collisionHeight??1.7;
    const next=moveCircle(this.state.arena,from,scale(facing,stepDistance),PLAYER_RADIUS,height);
    if(!supportChecked)return next;
    if(!isSupportedCapsulePose(this.state.arena,next,PLAYER_RADIUS,height)||!isCirclePathClear(this.state.arena,from,next,PLAYER_RADIUS,height))return from;
    return next;
  }
  private advanceEvasion(player:CombatActor,profile:EvasionProfile):void{
    const elapsed=this.state.tick-player.actionStartedTick;
    if(elapsed<0||elapsed>=profile.durationTicks)return;
    const previous=player.position;
    player.position=this.evasionStep(previous,player.facing,profile,elapsed,this.state.evasion===profile);
    player.velocity=scale(sub(player.position,previous),1/FIXED_STEP_SECONDS);
    player.phase=elapsed<profile.iframes?'active':'recovery';
  }
  private findThreatenedHazard(start:Vec3,player:CombatActor,profile:EvasionProfileId):LiveHazard|undefined{
    const initial={...player,position:start};
    return this.state.hazards.find(h=>{
      const threatened=hazardThreatens(h,initial);
      const iframes=EVASION_PROFILES[profile].iframes;
      const key=h.sourceId+':'+h.attackId+':'+h.startTick+':'+h.hitGroup;
      const grantsEffect=!this.state.perfectDodgeKeys.includes(key);
      const remainingSlowTicks=this.state.timePolicy==='perfect-dodge-slow'?this.state.slowMotionRemainingTicks:0;
      const episodeElapsed=this.state.timePolicy==='perfect-dodge-slow'?this.state.slowMotionElapsedTicks:0;
      const projectedSlowTicks=grantsEffect?remainingSlowTicks+Math.max(0,Math.min(PERFECT_DODGE_EFFECTS.slowMotionTicks,PERFECT_DODGE_EFFECTS.maxSlowMotionTicks-episodeElapsed-remainingSlowTicks)):remainingSlowTicks;
      const slowedIFrames=Math.min(iframes,projectedSlowTicks);
      const evasionUntil=this.state.worldTick+slowedIFrames*PERFECT_DODGE_EFFECTS.worldTimeScale+(iframes-slowedIFrames);
      const timely=this.state.worldTick<h.activeUntil&&evasionUntil>h.activeFrom;
      const cleared=!hazardThreatens(h,player)||avoids(profile,h);
      return timely&&threatened&&cleared&&!h.hitIds.includes(player.id);
    });
  }
  // ---- Warden Arsenal: Warden Blade combo, Sigil Bolt/Barrage, Judgement, hit-stop -------------------------------
  private lightChainLive():boolean{
    const s=this.state,step=s.lightIndex??0;
    return step>=1&&step<(this.kit?.lightSteps??(s.heroId==='yara'?3:LIGHT_STEPS.length))&&s.lightChainUntil!==undefined&&s.tick<=s.lightChainUntil;
  }
  /** The follow-up step is accepted from CHAIN_EARLY_TICKS before the current clip ends through CHAIN_LATE_TICKS after it. */
  private lightChainOpen():boolean{return this.lightChainLive()&&this.state.lightChainFrom!==undefined&&this.state.tick>=this.state.lightChainFrom;}
  private nextLightStep():number{return this.lightChainLive()?(this.state.lightIndex??0)+1:1;}
  private startLight(step:number,counter:boolean,chain:boolean):boolean{
    const s=this.state,player=this.playerActor(),spec=LIGHT_STEPS[step-1];
    if(!player||!spec||player.downed||this.playerIsDown()||s.traversal)return false;
    if(!counter&&!chain&&s.tick<s.actionRecoveryUntil)return false;
    if(this.kit)return this.kit.startLight(step,chain,counter);
    const target=s.targetId===undefined?undefined:this.actorForId(s.targetId);
    if(target&&target.allegiance==='hostile'&&target.visible&&!target.downed&&distance2(target.position,player.position)<=LIGHT_ASSIST_RANGE)player.facing=facingFrom(sub(target.position,player.position));
    const action=`light_${step}`;
    s.lightIndex=step;s.lightChainFrom=s.tick+spec.ticks-CHAIN_EARLY_TICKS;s.lightChainUntil=s.tick+spec.ticks+CHAIN_LATE_TICKS;
    s.actionId=action;s.actionUntil=s.tick+spec.ticks-LIGHT_LOCK_MARGIN_TICKS;s.actionRecoveryUntil=s.tick+spec.ticks;s.actionCancelable=false;
    s.pendingImpact=undefined;s.cast=undefined;
    s.swing={step:step as PlayerSwing['step'],startedTick:s.tick,hitIds:[],counter,waveSpawned:false,slashed:false,baseFacing:copy(player.facing)};
    player.actionId=this.playerClip(action);player.actionStartedTick=s.tick;player.normalizedTime=0;player.actionEndsTick=s.tick+spec.ticks;
    player.phase='anticipation';player.targetId=s.targetId;player.velocity=vec(0,0,0);
    this.emit('cue',`Aren prepares ${action.replaceAll('_',' ')}.`,player.id,s.targetId,action,`aren-${action}` as AttackId);
    return true;
  }
  /** Sector hits, the light_3 spin and the crescent wave of the swing in progress; every tick count is from the swing's first tick. */
  private updateSwing(player:CombatActor):void{
    const s=this.state,swing=s.swing;
    if(!swing)return;
    const spec=LIGHT_STEPS[swing.step-1]!,elapsed=s.tick-swing.startedTick,action=`light_${swing.step}`;
    if(s.heroId==='yara'){
      player.phase=elapsed<spec.activeFrom?'anticipation':'recovery';
      if(elapsed>=spec.activeFrom&&!swing.waveSpawned){
        swing.waveSpawned=true;
        if(swing.step===2){this.launchHeartrootSeed(player,'thorn-bolt',-.12,HEARTROOT.twinDamage);this.launchHeartrootSeed(player,'thorn-bolt',.12,HEARTROOT.twinDamage);}
        else this.launchHeartrootSeed(player,swing.step===3?'bloom-seed':'thorn-bolt',0,swing.step===3?HEARTROOT.seedDamage:HEARTROOT.thornDamage);
      }
      if(elapsed>spec.activeTo)s.swing=undefined;
      return;
    }
    if(spec.spin)player.facing=rotateY(swing.baseFacing,2*Math.PI*Math.min(1,Math.max(0,(elapsed-spec.spin.from)/(spec.spin.to-spec.spin.from))));
    player.phase=elapsed<spec.activeFrom?'anticipation':elapsed<=spec.activeTo?'active':'recovery';
    if(elapsed>=spec.activeFrom&&!swing.slashed){
      swing.slashed=true;
      this.queuePresentationCue({kind:'slash',phase:'active',actorId:player.id,actionId:ACTION_CLIPS[action],position:copy(player.position),footprint:{width:spec.reach,length:spec.reach,angleRadians:yawOf(player.facing),sectorRadians:spec.arc},durationTicks:spec.activeTo-spec.activeFrom+1,intensity:spec.intensity,element:'arcane',priority:'essential',shape:'arc'});
    }
    if(spec.waveAt!==undefined&&!swing.waveSpawned&&elapsed>=spec.waveAt){
      swing.waveSpawned=true;
      if(this.spendManaAmount(CRESCENT_WAVE.manaCost))this.spawnCrescentWave(player);
    }
    if(elapsed>=spec.activeFrom&&elapsed<=spec.activeTo){
      const halfArc=Math.cos(spec.arc/2),full=spec.arc>=2*Math.PI;
      for(const actor of s.actors){
        if(!this.isPlayerHostileTarget(actor)||swing.hitIds.includes(actor.id))continue;
        const dx=actor.position.x-player.position.x,dz=actor.position.z-player.position.z,distance=Math.hypot(dx,dz);
        if(distance>spec.reach+actor.radius)continue;
        if(!full&&distance>1e-6&&(dx*player.facing.x+dz*player.facing.z)/distance<halfArc)continue;
        swing.hitIds.push(actor.id);
        this.strikeHostile(actor,{action,clip:ACTION_CLIPS[action]!,damage:spec.damage,stopTicks:spec.hitStopTicks,element:'arcane',stagger:'interrupt',instinct:8,counter:swing.counter});
      }
    }
    if(elapsed>Math.max(spec.activeTo,spec.spin?.to??0))s.swing=undefined;
  }
  private isPlayerHostileTarget(actor:CombatActor):boolean{
    return actor.id!==this.state.playerId&&actor.allegiance==='hostile'&&actor.visible&&!actor.downed&&!actor.possessed&&(!this.state.combatTrial||this.trials()[this.state.combatTrial.index]?.monsterId===actor.id);
  }
  private spendManaAmount(cost:number):boolean{
    if(this.state.player.mana<cost)return false;
    this.state.player.mana-=cost;
    return true;
  }
  private spawnCrescentWave(player:CombatActor):void{
    const s=this.state,facing=player.facing;
    const origin=vec(player.position.x+facing.x*CRESCENT_WAVE.spawnForward,player.position.y+CRESCENT_WAVE.height,player.position.z+facing.z*CRESCENT_WAVE.spawnForward);
    const lifeTicks=Math.round(CRESCENT_WAVE.travel/CRESCENT_WAVE.speed*60);
    const projectile:LivePlayerProjectile={id:`crescent-wave:${++s.arsenalSequence}`,kind:'crescent-wave',ownerId:player.id,position:origin,direction:vec(facing.x,0,facing.z),speed:CRESCENT_WAVE.speed,radius:CRESCENT_WAVE.width/2,ageTicks:0,lifeTicks,damage:CRESCENT_WAVE.damage,hitIds:[]};
    s.playerProjectiles.push(projectile);
    this.queueProjectileCue(projectile,origin);
  }
  private queueProjectileCue(projectile:LivePlayerProjectile,from:Vec3):void{
    const range=projectile.speed*projectile.lifeTicks*FIXED_STEP_SECONDS;
    this.queuePresentationCue({kind:'projectile',phase:'commit',actorId:projectile.ownerId,...(projectile.targetId?{targetId:projectile.targetId}:{}),scopeId:projectile.id,actionId:(projectile.actionId??projectile.kind) as ActionId,from:copy(from),to:vec(from.x+projectile.direction.x*range,from.y+projectile.direction.y*range,from.z+projectile.direction.z*range),durationTicks:projectile.lifeTicks,element:this.heroElement(),priority:'essential',shape:'trail'});
  }
  /** One confirmed player hit: damage, Instinct, stagger, cue, event, hit-stop and the monster flinch. Returns the vitality actually lost. */
  private strikeHostile(target:CombatActor,incoming:PlayerStrike):number{
    const s=this.state,player=this.playerActor();
    if(!player)return 0;
    if(s.combatTrial&&this.trials()[s.combatTrial.index]?.monsterId!==target.id)return 0;
    const modified=this.kit?.modifyStrike?.(target,incoming),strike:PlayerStrike=modified?{...modified,counter:incoming.counter}:incoming;
    const before=target.vitality??100;
    const damage=target.weakPointUntil!==undefined&&target.weakPointUntil>s.worldTick?Math.ceil(strike.damage*PERFECT_DODGE_EFFECTS.weakPointDamageMultiplier):strike.damage;
    target.vitality=Math.max(0,before-damage);
    const loss=Math.max(0,before-target.vitality);
    const payload=loss>0?{targetId:target.id,amount:loss,position:copy(target.position),worldTick:s.worldTick}:undefined;
    if(target.ferocity!==undefined)target.ferocity=Math.max(0,target.ferocity-damage);
    if(strike.counter)this.markPhaseAction('counter');
    if(strike.instinct>0)s.player.instinct=Math.min(100,s.player.instinct+strike.instinct);
    const attackId=`aren-${strike.action}` as AttackId;
    if(strike.stagger==='interrupt')this.interruptAttack(target,strike.action);
    else if(strike.stagger==='idle'&&!this.liveAttackOf(target)&&this.state.worldTick>=target.staggerUntil)target.staggerUntil=s.worldTick+SIGIL.staggerTicks;
    if(target.vitality===0||!s.combatTrial&&target.ferocity===0){
      target.downed=true;
      target.allegiance='neutral';
      const participants=s.encounter?.actorIds.filter(id=>id!==s.playerId)??[];
      if(participants.length>0&&participants.every(id=>{const actor=s.actors.find(candidate=>candidate.id===id);return !!actor&&(actor.downed||actor.allegiance!=='hostile');}))this.resolveEncounter('subdued',target);
    }
    this.emit('damage',`${strike.action.replaceAll('_',' ')} connects.`,player.id,target.id,strike.action,attackId,payload);
    const direction=facingFrom(sub(target.position,player.position));
    const position=vec(target.position.x-direction.x*0.4,target.position.y+0.9,target.position.z-direction.z*0.4);
    this.queuePresentationCue({kind:'hit',phase:'hit',actorId:player.id,targetId:target.id,position,to:vec(position.x+direction.x,position.y,position.z+direction.z),scopeId:s.encounterId,attackId,actionId:strike.clip,intensity:damage/12,element:strike.element,priority:'essential',shape:'burst'});
    if(damage>0){
      this.startHitStop(strike.stopTicks);
      if(!target.downed&&this.monsterAttackProgress(target)?.phase!=='active')target.hitReactUntil=s.worldTick+HIT_REACT_TICKS;
    }
    this.kit?.afterStrike?.(target,strike,loss);
    return loss;
  }
  /** Overlapping hit-stops take the longest remaining freeze; they never stack. */
  private startHitStop(ticks:number):void{
    const stop=this.state.hitStop;
    if(ticks<=0||stop&&stop.remainingTicks>=ticks)return;
    this.state.hitStop={remainingTicks:ticks,strength:Math.min(1,ticks/HIT_STOP_FULL_TICKS)};
  }
  /** A hit-stop tick: the world clock and every simulation-clock player timer stand still; only buffered input moves. */
  private freezeForHitStop(input:CombatInput):void{
    const s=this.state,stop=s.hitStop!;
    this.shiftPlayerClocks();
    if(s.playerJump&&input.jumpPressed&&s.tick<=s.playerJump.flightStartedAtTick+s.playerJump.flightTicks&&!s.playerJump.boosted)s.playerJump.boostQueued=true;
    if(input.heavyReleased&&s.heavyChargeStartTick!==null)(s.deferredRelease??={}).heavy=true;
    if(input.rangedReleased&&s.sigilCharge)(s.deferredRelease??={}).ranged=true;
    if(s.heavyChargeStartTick===null&&!s.sigilCharge)this.bufferAttackInput(input);
    stop.remainingTicks--;
    if(stop.remainingTicks<=0)s.hitStop=undefined;
    s.worldTimeScale=this.effectiveWorldTimeScale();
  }
  private shiftPlayerClocks():void{
    const s=this.state,player=this.playerActor();
    if(s.actionUntil>0)s.actionUntil++;
    if(s.actionRecoveryUntil>0)s.actionRecoveryUntil++;
    if(s.counterUntil>0)s.counterUntil++;
    if(s.untargetableUntil!==undefined)s.untargetableUntil++;
    if(s.kitCancel)s.kitCancel.fromTick++;
    this.kit?.onHitStop?.();
    if(s.heavyChargeStartTick!==null)s.heavyChargeStartTick++;
    if(s.sigilCharge)s.sigilCharge.startedTick++;
    if(s.bufferedAction)s.bufferedAction.expiresTick++;
    if(s.lastResolvedActionTick!==undefined)s.lastResolvedActionTick++;
    if(s.lightChainFrom!==undefined)s.lightChainFrom++;
    if(s.lightChainUntil!==undefined)s.lightChainUntil++;
    if(s.pendingImpact){s.pendingImpact.activeAt++;s.pendingImpact.activeUntil++;}
    if(s.playerJump){s.playerJump.startedAtTick++;s.playerJump.flightStartedAtTick++;s.playerJump.airStartedAtTick++;}
    if(s.swing)s.swing.startedTick++;
    if(s.cast)s.cast.startedTick++;
    if(s.pendingLightning)s.pendingLightning.atTick++;
    for(const mark of s.judgementMarks){mark.createdAtTick++;mark.detonateAtTick++;}
    for(const slot of Object.values(s.companionState.slots))if(slot&&slot.readyAt>0)slot.readyAt++;
    if(s.companionState.tokens.nextAt>0)s.companionState.tokens.nextAt++;
    if(!player)return;
    if(player.actionEndsTick>0){player.actionStartedTick++;player.actionEndsTick++;}
    if(player.invulnerableUntil>0)player.invulnerableUntil++;
  }
  private applyDeferredRelease(input:CombatInput):CombatInput{
    const deferred=this.state.deferredRelease!;
    this.state.deferredRelease=undefined;
    return {...input,heavyReleased:input.heavyReleased||deferred.heavy===true,rangedReleased:input.rangedReleased||deferred.ranged===true};
  }
  /** Queues the pressed attack for the first tick it can start; recovery buffers the last 8 ticks, hit-stop buffers throughout. */
  private bufferAttackInput(input:CombatInput):void{
    let action:string|undefined;
    let targetId=this.state.targetId;
    if(input.lightPressed)action=`light_${this.nextLightStep()}`;
    else if(input.heavyPressed)action='heavy';
    else if(input.rangedPressed)action='ranged';
    else if(input.ultimatePressed)action='judgement';
    else if(input.tetherPressed)action='root_tether';
    else if(input.ferocityPressed)action='ferocity';
    else if(input.corruptionPressed)action='corruption';
    else if(input.cleansePressed){action='cleanse';targetId=input.interactTargetId??this.state.targetId;}
    if(action)this.state.bufferedAction={action,targetId,expiresTick:this.state.tick+8};
  }
  private startBufferedAction(player:CombatActor,queued:NonNullable<EngineState['bufferedAction']>,input:CombatInput):boolean{
    if(queued.action==='ranged')return this.startRanged(player,input);
    if(queued.action==='judgement')return this.startJudgement(player);
    return this.startPlayerAction(queued.action,queued.targetId);
  }
  // ---- Sigil Bolt / Barrage --------------------------------------------------------------------------------
  private sigilCentre(player:CombatActor):Vec3{
    return vec(player.position.x+player.facing.x*SIGIL.forward,player.position.y+SIGIL.height,player.position.z+player.facing.z*SIGIL.forward);
  }
  private chestOf(actor:CombatActor):Vec3{return vec(actor.position.x,actor.position.y+actor.collisionHeight*0.55,actor.position.z);}
  /** Nearest visible hostile inside the homing range and cone of `facing`; undefined fires straight. */
  private softTarget(origin:Vec3,facing:Vec3):CombatActor|undefined{
    let best:CombatActor|undefined,bestDistance=Infinity;
    for(const actor of this.state.actors){
      if(!this.isPlayerHostileTarget(actor)||!pointInSector(actor.position,origin,facing,SIGIL.homingRange,SIGIL.homingConeDegrees))continue;
      const distance=distance2(origin,actor.position);
      if(distance<bestDistance){best=actor;bestDistance=distance;}
    }
    return best;
  }
  private queueSigilCue(scopeId:string,phase:'anticipation'|'sustain',durationTicks:number,intensity:number):void{
    const player=this.playerActor();
    if(!player)return;
    const centre=this.sigilCentre(player),target=this.softTarget(player.position,player.facing);
    const to=target?this.chestOf(target):vec(centre.x+player.facing.x*10,centre.y,centre.z+player.facing.z*10);
    this.queuePresentationCue({kind:'sigil',phase,actorId:player.id,scopeId,position:centre,to,durationTicks,intensity,element:this.heroElement(),...(this.kit?{actionId:player.actionId}:{}),priority:'essential',shape:'ring'});
  }
  private startRanged(player:CombatActor,input:CombatInput):boolean{
    const s=this.state;
    if(this.playerIsDown()||s.traversal||s.sigilCharge||s.tick<s.actionRecoveryUntil)return false;
    if(s.player.mana<SIGIL.boltMana){this.emit('cue','Sigil Bolt needs 15 mana. Walk or run to restore mana.',player.id);return false;}
    if(!input.rangedHeld||input.rangedReleased)return this.startSigilCast(player,'bolt');
    if(this.kitCancelLift)this.kit?.cancel();
    s.lightIndex=0;s.pendingImpact=undefined;
    s.sigilCharge={startedTick:s.tick,scopeId:`sigil:${++s.arsenalSequence}`};
    s.actionId='sigil-charge';s.actionUntil=s.tick+MAX_HOLD_TICKS;s.actionRecoveryUntil=s.actionUntil;s.actionCancelable=true;
    player.actionId=this.playerClip('sigil_charge');player.actionStartedTick=s.tick;player.normalizedTime=0;player.actionEndsTick=s.actionUntil;player.phase='anticipation';player.velocity=vec(0,0,0);
    this.queueSigilCue(s.sigilCharge.scopeId,'sustain',SIGIL.chargeSustainTicks,1);
    this.emit('cue','Sigil Bolt: release to fire; hold to charge a Barrage. Dodge cancels the charge.',player.id,undefined,'sigil_bolt');
    return true;
  }
  /** While held Aren stays rooted but turns freely; release fires a Barrage after a full charge, otherwise a bolt. */
  private updateSigilCharge(player:CombatActor,input:CombatInput):void{
    const s=this.state,charge=s.sigilCharge!;
    const desired=this.motionDesired(input);
    player.velocity=vec(0,0,0);
    if(Math.hypot(desired.x,desired.z)>.001)player.facing=normalize(desired);
    if(input.rangedHeld&&!input.rangedReleased)return;
    const held=s.tick-charge.startedTick;
    this.endSigilCharge('interrupt');
    if(held>=SIGIL.barrageHoldTicks&&s.player.mana>=SIGIL.barrageMana)this.startSigilCast(player,'barrage');
    else if(s.player.mana>=SIGIL.boltMana)this.startSigilCast(player,'bolt');
    else this.emit('cue','Sigil Bolt needs 15 mana. Walk or run to restore mana.',player.id);
  }
  private endSigilCharge(reason:CueCancellationReason):void{
    const s=this.state,charge=s.sigilCharge,player=this.playerActor();
    if(!charge)return;
    s.sigilCharge=undefined;
    this.queuePresentationCue({kind:'cancel',phase:'resolve',scopeId:charge.scopeId,cancellationReason:reason});
    if(!player||s.actionId!=='sigil-charge')return;
    s.actionId='idle';s.actionUntil=s.tick;s.actionCancelable=false;s.actionRecoveryUntil=s.tick;
    player.actionId=ACTION_CLIPS.idle!;player.actionEndsTick=0;player.actionStartedTick=s.tick;player.normalizedTime=0;player.phase='idle';
  }
  private launchHeartrootSeed(player:CombatActor,kind:'thorn-bolt'|'bloom-seed'|'storm-seed',angle:number,damage:number):void{
    const origin=this.sigilCentre(player),target=this.softTarget(player.position,player.facing);
    let direction=target?normalize3(sub(this.chestOf(target),origin)):copy(player.facing);
    if(angle)direction=rotateY(direction,angle);
    const projectile:LivePlayerProjectile={id:`${kind}:${++this.state.arsenalSequence}`,kind,ownerId:player.id,position:origin,direction,speed:HEARTROOT.projectileSpeed,radius:kind==='bloom-seed' ? 0.28 : 0.14,ageTicks:0,lifeTicks:HEARTROOT.projectileTicks,damage,hitIds:[],...(target?{targetId:target.id}:{})};
    this.state.playerProjectiles.push(projectile);
    this.queueProjectileCue(projectile,origin);
  }

  private startHeartrootCast(player:CombatActor,kind:'root-spike'|'root-eruption'|'heartroot-bloom',ticks:number):boolean{
    const s=this.state,target=this.softTarget(player.position,player.facing);
    if(target)player.facing=facingFrom(sub(target.position,player.position));
    const action=kind==='root-spike'?'heavy':kind==='root-eruption'?'charged_heavy':'judgement';
    let position=copy(player.position);
    if(kind==='root-spike')position=vec(player.position.x+player.facing.x*HEARTROOT.spikeRange/2,player.position.y,player.position.z+player.facing.z*HEARTROOT.spikeRange/2);
    if(kind==='root-eruption'){
      const range=target?Math.min(HEARTROOT.eruptionRange,distance2(player.position,target.position)):6;
      const destination=vec(player.position.x+player.facing.x*range,player.position.y,player.position.z+player.facing.z*range);
      const origin=this.chestOf(player),end=vec(destination.x,origin.y,destination.z);
      const blocked=this.projectileWallHit(origin,end,.2);
      position=blocked?vec(blocked.x,player.position.y,blocked.z):destination;
      position=vec(position.x,groundHeightAt(s.arena,position.x,position.z,player.position.y)??player.position.y,position.z);
    }
    s.lightIndex=0;s.swing=undefined;s.pendingImpact=undefined;
    s.actionId=action;s.actionUntil=s.tick+ticks;s.actionRecoveryUntil=s.actionUntil;s.actionCancelable=false;
    player.actionId=this.playerClip(action);player.actionStartedTick=s.tick;player.actionEndsTick=s.actionUntil;
    player.normalizedTime=0;player.phase='anticipation';player.velocity=vec(0,0,0);
    s.cast={kind,position,startedTick:s.tick,progress:0,stage:0};
    const bloom=kind==='heartroot-bloom',radius=bloom?HEARTROOT.bloomRadius:HEARTROOT.eruptionRadius;
    this.queuePresentationCue({kind:bloom?'bloom':'root-eruption',phase:'anticipation',actorId:player.id,actionId:player.actionId,position,footprint:{width:kind==='root-spike'?HEARTROOT.spikeWidth:radius*2,length:kind==='root-spike'?HEARTROOT.spikeRange:radius*2,angleRadians:yawOf(player.facing)},durationTicks:bloom?ticks:kind==='root-spike'?HEARTROOT.spikeAt:HEARTROOT.eruptionAt,element:'heartroot',priority:'essential',shape:bloom?'ring':kind==='root-spike'?'trail':'ring'});
    return true;
  }

  private heartrootBurst(position:Vec3,radius:number,damage:number,clip:string):void{
    const player=this.playerActor();
    if(!player)return;
    this.queuePresentationCue({kind:'bloom',phase:'hit',actorId:player.id,actionId:clip as ActionId,position:copy(position),footprint:{width:radius*2,length:radius*2},durationTicks:36,element:'heartroot',intensity:1.5,priority:'essential',shape:'burst'});
    for(const actor of this.state.actors){
      if(!this.isPlayerHostileTarget(actor)||distance2(position,actor.position)>radius+actor.radius)continue;
      const origin=vec(position.x,position.y+.8,position.z);
      if(this.projectileWallHit(origin,this.chestOf(actor),.05))continue;
      this.strikeHostile(actor,{action:clip,clip:clip as ActionId,damage,stopTicks:0,element:'heartroot',stagger:'idle',instinct:clip==='yara-heartroot-bloom'?0:4,counter:false});
    }
  }

  private heartrootLane(player:CombatActor,range:number,width:number,damage:number,beam:boolean):void{
    const from=this.chestOf(player),destination=vec(from.x+player.facing.x*range,from.y,from.z+player.facing.z*range);
    const to=this.projectileWallHit(from,destination,width/2)??destination;
    this.queuePresentationCue({kind:beam?'beam':'root-eruption',phase:'active',actorId:player.id,actionId:player.actionId,position:vec((from.x+to.x)/2,player.position.y,(from.z+to.z)/2),from,to,footprint:{width,length:distance2(from,to),angleRadians:yawOf(player.facing)},durationTicks:30,element:'heartroot',intensity:1.5,priority:'essential',shape:beam?'beam':'trail'});
    for(const actor of this.state.actors){
      if(!this.isPlayerHostileTarget(actor)||segmentDistanceXZ(from,to,actor.position).distance>width/2+actor.radius)continue;
      if(Math.abs(this.chestOf(actor).y-from.y)>actor.collisionHeight/2+width/2)continue;
      if(this.projectileWallHit(from,this.chestOf(actor),.05))continue;
      this.strikeHostile(actor,{action:beam?'sigil_bolt':'heavy',clip:player.actionId,damage,stopTicks:0,element:'heartroot',stagger:beam?'idle':'interrupt',instinct:6,counter:false});
    }
  }

  private updateHeartrootCast(player:CombatActor,cast:PlayerCast,elapsed:number):void{
    const s=this.state;
    if(cast.kind==='heartroot-bloom'){
      const center=cast.position!;
      player.velocity=vec(0,0,0);
      player.phase=elapsed<HEARTROOT.meteorFrom?'anticipation':elapsed<HEARTROOT.bloomPulseAt?'active':'recovery';
      while(cast.progress<HEARTROOT.meteorCount&&elapsed>=HEARTROOT.meteorFrom+cast.progress*HEARTROOT.meteorInterval){
        const index=cast.progress++,angle=index*2.399963229728653,radius=index===0?0:HEARTROOT.bloomRadius*.75*Math.sqrt(index/(HEARTROOT.meteorCount-1));
        const x=center.x+Math.sin(angle)*radius,z=center.z+Math.cos(angle)*radius;
        const position=vec(x,groundHeightAt(s.arena,x,z,center.y)??center.y,z);
        this.queuePresentationCue({kind:'beam',phase:'commit',actorId:player.id,actionId:'yara-bloom-meteor' as ActionId,from:vec(position.x,position.y+10,position.z),to:position,durationTicks:18,element:'heartroot',priority:'essential',shape:'beam'});
        this.heartrootBurst(position,HEARTROOT.meteorRadius,HEARTROOT.meteorDamage,'yara-heartroot-bloom');
      }
      if(elapsed>=HEARTROOT.bloomPulseAt&&cast.stage===0){
        cast.stage=1;this.heartrootBurst(center,HEARTROOT.bloomRadius,HEARTROOT.bloomPulseDamage,'yara-heartroot-bloom');
      }
      if(elapsed>=HEARTROOT.bloomTicks)s.cast=undefined;
      return;
    }
    if(cast.kind==='root-spike'||cast.kind==='root-eruption'){
      const spike=cast.kind==='root-spike',activeAt=spike?HEARTROOT.spikeAt:HEARTROOT.eruptionAt;
      player.phase=elapsed<activeAt?'anticipation':'recovery';
      if(elapsed>=activeAt&&cast.progress===0){
        cast.progress=1;
        if(spike)this.heartrootLane(player,HEARTROOT.spikeRange,HEARTROOT.spikeWidth,HEARTROOT.spikeDamage,false);
        else{
          this.queuePresentationCue({kind:'root-eruption',phase:'active',actorId:player.id,position:cast.position,footprint:{width:HEARTROOT.eruptionRadius*2,length:HEARTROOT.eruptionRadius*2},durationTicks:36,element:'heartroot',priority:'essential',shape:'ring'});
          this.heartrootBurst(cast.position!,HEARTROOT.eruptionRadius,HEARTROOT.eruptionDamage,'yara-root-eruption');
        }
      }
      if(elapsed>=(spike?HEARTROOT.spikeTicks:HEARTROOT.eruptionTicks))s.cast=undefined;
      return;
    }
    const bolt=cast.kind==='bolt';
    if(bolt&&elapsed>=SIGIL.boltLaunchTick&&cast.progress===0){
      cast.progress=1;this.heartrootLane(player,HEARTROOT.lanceRange,HEARTROOT.lanceWidth,HEARTROOT.lanceDamage,true);
    }else if(!bolt){
      while(cast.progress<HEARTROOT.stormLaunches.length&&elapsed>=HEARTROOT.stormLaunches[cast.progress]!){
        this.launchHeartrootSeed(player,'storm-seed',(cast.progress-2.5)*.12,HEARTROOT.stormDamage);cast.progress++;
      }
    }
    player.phase=elapsed<(bolt?SIGIL.boltLaunchTick:HEARTROOT.stormLaunches[0]!)?'anticipation':'recovery';
    if(elapsed>=(bolt?SIGIL.boltTicks:60))s.cast=undefined;
  }

  private startSigilCast(player:CombatActor,kind:'bolt'|'barrage'):boolean{
    const s=this.state,bolt=kind==='bolt',skill=bolt?'sigil_bolt':'sigil_barrage';
    if(this.kit)return this.kit.startRanged(!bolt);
    if(!this.spendMana(skill))return false;
    const target=this.softTarget(player.position,player.facing);
    if(target)player.facing=facingFrom(sub(target.position,player.position));
    const total=bolt?SIGIL.boltTicks:s.heroId==='yara'?60:SIGIL.barrageTicks;
    s.lightIndex=0;s.pendingImpact=undefined;s.swing=undefined;
    s.actionId=skill;s.actionUntil=s.tick+(bolt?SIGIL.boltLockTicks:s.heroId==='yara'?50:SIGIL.barrageLockTicks);s.actionRecoveryUntil=s.tick+total;s.actionCancelable=false;
    player.actionId=this.playerClip(skill);player.actionStartedTick=s.tick;player.normalizedTime=0;player.actionEndsTick=s.tick+total;player.phase='anticipation';player.velocity=vec(0,0,0);
    s.cast={kind,startedTick:s.tick,progress:0,stage:0};
    this.queueSigilCue(`sigil:${++s.arsenalSequence}`,'anticipation',bolt?SIGIL.boltLaunchTick:SIGIL.barrageLaunchTicks[0]!,bolt?1:1.6);
    this.emit('action',bolt?'Sigil Bolt.':'Sigil Barrage.',player.id,s.targetId,skill);
    return true;
  }
  private updateCast(player:CombatActor):void{
    const s=this.state,cast=s.cast;
    if(!cast)return;
    const elapsed=s.tick-cast.startedTick;
    if(cast.kind==='judgement'){this.updateJudgement(player,cast,elapsed);return;}
    if(s.heroId==='yara'){this.updateHeartrootCast(player,cast,elapsed);return;}
    const bolt=cast.kind==='bolt',launches=bolt?[SIGIL.boltLaunchTick]:SIGIL.barrageLaunchTicks;
    while(cast.progress<launches.length&&elapsed>=launches[cast.progress]!){
      this.launchSigilBolt(player,bolt?0:SIGIL.barrageAngles[cast.progress]!,bolt?SIGIL.boltDamage:SIGIL.barrageDamage);
      cast.progress++;
      if(!bolt&&cast.progress<launches.length)this.queueSigilCue(`sigil:${++s.arsenalSequence}`,'anticipation',launches[cast.progress]!-elapsed,1.6);
    }
    player.phase=elapsed<launches[0]!?'anticipation':elapsed<(bolt?SIGIL.boltLockTicks:SIGIL.barrageLockTicks)?'active':'recovery';
    if(elapsed>=(bolt?SIGIL.boltTicks:SIGIL.barrageTicks))s.cast=undefined;
  }
  private launchSigilBolt(player:CombatActor,angle:number,damage:number):void{
    const s=this.state,origin=this.sigilCentre(player),target=this.softTarget(player.position,player.facing);
    let direction=target?normalize3(sub(this.chestOf(target),origin)):vec(player.facing.x,0,player.facing.z);
    if(angle!==0)direction=rotateY(direction,angle);
    const projectile:LivePlayerProjectile={id:`sigil-bolt:${++s.arsenalSequence}`,kind:'sigil-bolt',ownerId:player.id,position:origin,direction,speed:SIGIL.speed,radius:SIGIL.radius,ageTicks:0,lifeTicks:SIGIL.lifeTicks,damage,...(target?{targetId:target.id}:{}),hitIds:[]};
    s.playerProjectiles.push(projectile);
    this.queueProjectileCue(projectile,origin);
  }
  // ---- Projectiles, lightning, marks ---------------------------------------------------------------------------
  private updateArsenal(worldScale:number,input:CombatInput):void{
    const player=this.playerActor();
    if(!player)return;
    this.updateProjectiles(worldScale);
    this.updatePendingLightning();
    this.updateJudgementMarks();
    this.updateSwing(player);
    this.updateCast(player);
    this.kit?.update(input);
  }
  private updateProjectiles(worldScale:number):void{
    const s=this.state,projectiles=s.playerProjectiles;
    if(!projectiles.length||worldScale<=0)return;
    const dt=FIXED_STEP_SECONDS*worldScale;
    let kept=0;
    const count=projectiles.length;
    for(let index=0;index<count;index++){
      const projectile=projectiles[index]!;
      if(this.stepProjectile(projectile,dt,worldScale))projectiles[kept++]=projectile;
      else if(projectile.callbackId)this.kit?.onProjectileEnd?.(projectile,projectile.position);
    }
    // Projectiles a kit spawned from its callbacks during this pass sit after `count`.
    for(let index=count;index<projectiles.length;index++)projectiles[kept++]=projectiles[index]!;
    projectiles.length=kept;
  }
  /** Advances one projectile by `dt`; returns false when it hit something, was blocked or expired. */
  private stepProjectile(projectile:LivePlayerProjectile,dt:number,worldScale:number):boolean{
    const s=this.state,bolt=projectile.kind!=='crescent-wave'&&!projectile.pierce;
    if(bolt&&projectile.targetId){
      const target=this.actorForId(projectile.targetId);
      if(target&&this.isPlayerHostileTarget(target))projectile.direction=turnTowards(projectile.direction,normalize3(sub(this.chestOf(target),projectile.position)),SIGIL.turnRate*dt);
      else projectile.targetId=undefined;
    }
    const from=projectile.position,travel=projectile.speed*dt,d=projectile.direction;
    const to=vec(from.x+d.x*travel,from.y+d.y*travel,from.z+d.z*travel);
    const wall=this.projectileWallHit(from,to,bolt?projectile.radius:WAVE_PROBE_RADIUS);
    const end=wall??to;
    const impactAction=(projectile.actionId??projectile.kind) as ActionId;
    let finished=false;
    if(bolt){
      let first:CombatActor|undefined,firstT=Infinity;
      for(const actor of s.actors){
        if(!this.isPlayerHostileTarget(actor))continue;
        const t=this.projectileContact(projectile,from,end,actor);
        if(t>=0&&t<firstT){first=actor;firstT=t;}
      }
      if(first){
        const impact=vec(from.x+(end.x-from.x)*firstT,from.y+(end.y-from.y)*firstT,from.z+(end.z-from.z)*firstT);
        this.queueProjectileImpact(projectile,impact,first.id,1);
        projectile.position=impact;
        if(projectile.callbackId)this.kit?.onProjectileHit?.(projectile,first,impact);
        else if(projectile.kind==='bloom-seed')this.heartrootBurst(impact,HEARTROOT.seedRadius,projectile.damage,'yara-thornshot-3');
        else this.strikeHostile(first,{action:projectile.kind==='sigil-bolt'?'sigil_bolt':'light',clip:impactAction,damage:projectile.damage,stopTicks:SIGIL.hitStopTicks,element:projectile.kind==='sigil-bolt'?'arcane':'heartroot',stagger:'idle',instinct:SIGIL.instinct,counter:false});
        return false;
      }
    }else{
      for(const actor of s.actors){
        if(!this.isPlayerHostileTarget(actor)||projectile.hitIds.includes(actor.id))continue;
        const t=this.projectileContact(projectile,from,end,actor);
        if(t<0)continue;
        projectile.hitIds.push(actor.id);
        this.queueProjectileImpact(projectile,vec(from.x+(end.x-from.x)*t,from.y+(end.y-from.y)*t,from.z+(end.z-from.z)*t),actor.id,1);
        if(projectile.callbackId)this.kit?.onProjectileHit?.(projectile,actor,vec(from.x+(end.x-from.x)*t,from.y+(end.y-from.y)*t,from.z+(end.z-from.z)*t));
        else this.strikeHostile(actor,{action:'crescent_wave',clip:impactAction,damage:projectile.damage,stopTicks:CRESCENT_WAVE.hitStopTicks,element:'arcane',stagger:'none',instinct:0,counter:false});
      }
    }
    if(wall){this.queueProjectileImpact(projectile,wall,undefined,0.6);finished=true;}
    projectile.position=end;
    projectile.ageTicks+=worldScale;
    if(projectile.kind==='bloom-seed'&&(finished||projectile.ageTicks>=projectile.lifeTicks))this.heartrootBurst(end,HEARTROOT.seedRadius,projectile.damage,'yara-thornshot-3');
    return !finished&&projectile.ageTicks<projectile.lifeTicks;
  }
  /** First blocking point along from→to (arena bounds, colliders, closed trial gates, combat obstacles), or undefined when clear. Projectiles fly at a fixed height, so the terrain surface is deliberately left out. */
  private projectileWallHit(from:Vec3,to:Vec3,radius:number):Vec3|undefined{
    const arena:CombatArena={...this.state.arena,surfaces:[]},height=radius*2;
    const clear=(t:number)=>isAerialCirclePathClear(arena,vec(from.x,from.y-radius,from.z),vec(from.x+(to.x-from.x)*t,from.y+(to.y-from.y)*t-radius,from.z+(to.z-from.z)*t),radius,height);
    if(clear(1))return undefined;
    let low=0,high=1;
    for(let iteration=0;iteration<7;iteration++){const mid=(low+high)/2;if(clear(mid))low=mid;else high=mid;}
    return vec(from.x+(to.x-from.x)*low,from.y+(to.y-from.y)*low,from.z+(to.z-from.z)*low);
  }
  /** Normalised position (0..1) along from→to where the projectile touches `actor`, or -1. */
  private projectileContact(projectile:LivePlayerProjectile,from:Vec3,to:Vec3,actor:CombatActor):number{
    const bolt=projectile.kind!=='crescent-wave',margin=bolt?projectile.radius:WAVE_HEIGHT_MARGIN;
    if(from.y<actor.position.y-margin||from.y>actor.position.y+actor.collisionHeight+margin)return -1;
    if(bolt){
      const closest=segmentDistanceXZ(from,to,actor.position);
      return closest.distance<=projectile.radius+actor.radius?closest.t:-1;
    }
    const dx=to.x-from.x,dz=to.z-from.z,length=Math.hypot(dx,dz),ux=projectile.direction.x,uz=projectile.direction.z;
    const rx=actor.position.x-from.x,rz=actor.position.z-from.z;
    const along=rx*ux+rz*uz,side=Math.abs(rx*uz-rz*ux);
    if(side>projectile.radius+actor.radius||along<-actor.radius||along>length+actor.radius)return -1;
    return length>1e-9?Math.min(1,Math.max(0,along/length)):0;
  }
  private queueProjectileImpact(projectile:LivePlayerProjectile,position:Vec3,targetId:ActorId|undefined,intensity:number):void{
    this.queuePresentationCue({kind:'projectile-impact',phase:'hit',actorId:projectile.ownerId,...(targetId?{targetId}:{}),scopeId:projectile.id,position:copy(position),actionId:(projectile.actionId??projectile.kind) as ActionId,intensity,element:this.heroElement(),priority:'essential',shape:'burst'});
  }
  private updatePendingLightning():void{
    const s=this.state,pending=s.pendingLightning,player=this.playerActor();
    if(!pending||!player||s.tick<pending.atTick)return;
    s.pendingLightning=undefined;
    this.queuePresentationCue({kind:'lightning',phase:'active',actorId:player.id,position:copy(pending.position),footprint:{width:THUNDER_CLEAVE.radius*2,length:THUNDER_CLEAVE.radius*2},durationTicks:THUNDER_CLEAVE.cueTicks,intensity:2,element:'lightning',priority:'essential',shape:'burst'});
    for(const actor of s.actors){
      if(!this.isPlayerHostileTarget(actor)||distance2(pending.position,actor.position)>THUNDER_CLEAVE.radius+actor.radius)continue;
      this.strikeHostile(actor,{action:'thunder_cleave',clip:ACTION_CLIPS.charged_heavy!,damage:THUNDER_CLEAVE.damage,stopTicks:THUNDER_CLEAVE.hitStopTicks,element:'lightning',stagger:'none',instinct:0,counter:false});
    }
  }
  // ---- Warden's Judgement ---------------------------------------------------------------------------------------
  private startJudgement(player:CombatActor):boolean{
    const s=this.state;
    if(this.playerIsDown()||s.traversal||s.sigilCharge||s.tick<s.actionRecoveryUntil)return false;
    if(s.player.instinct<JUDGEMENT_INSTINCT){this.emit('cue','Warden’s Judgement needs full Instinct.',player.id);return false;}
    if(this.kit){if(!this.kit.startUltimate())return false;s.player.instinct=0;return true;}
    s.player.instinct=0;
    if(s.heroId==='yara')return this.startHeartrootCast(player,'heartroot-bloom',HEARTROOT.bloomTicks);
    const target=this.judgementTarget(player);
    if(target)player.facing=facingFrom(sub(target.position,player.position));
    s.lightIndex=0;s.pendingImpact=undefined;s.swing=undefined;
    s.actionId='judgement';s.actionUntil=s.tick+JUDGEMENT.ticks;s.actionRecoveryUntil=s.actionUntil;s.actionCancelable=false;
    player.actionId=ACTION_CLIPS.judgement!;player.actionStartedTick=s.tick;player.normalizedTime=0;player.actionEndsTick=s.actionUntil;player.phase='anticipation';player.velocity=vec(0,0,0);
    s.cast={kind:'judgement',startedTick:s.tick,progress:0,stage:1};
    this.queuePresentationCue({kind:'judgement',phase:'anticipation',actorId:player.id,position:copy(player.position),durationTicks:JUDGEMENT.dashFrom,intensity:2,element:'arcane',priority:'essential',shape:'pulse'});
    this.emit('action','Warden’s Judgement.',player.id,target?.id,'judgement');
    return true;
  }
  /** The locked hostile when it is within dash range. */
  private judgementTarget(player:CombatActor):CombatActor|undefined{
    const target=this.state.targetId===undefined?undefined:this.actorForId(this.state.targetId);
    return target&&this.isPlayerHostileTarget(target)&&distance2(player.position,target.position)<=JUDGEMENT.targetRange?target:undefined;
  }
  private judgementInvulnerable():boolean{
    const cast=this.state.cast;
    if(cast?.kind==='heartroot-bloom')return this.state.tick-cast.startedTick<HEARTROOT.bloomTicks;
    if(cast?.kind!=='judgement')return false;
    const elapsed=this.state.tick-cast.startedTick;
    return elapsed>=JUDGEMENT.dashFrom&&elapsed<=JUDGEMENT.dashTo;
  }
  private updateJudgement(player:CombatActor,cast:PlayerCast,elapsed:number):void{
    const s=this.state;
    if(elapsed>=JUDGEMENT.dashFrom&&!cast.dash){
      const target=this.judgementTarget(player);
      const direction=target?facingFrom(sub(target.position,player.position)):normalize(player.facing);
      const distance=target?distance2(player.position,target.position)+JUDGEMENT.overshoot:JUDGEMENT.dashDistance;
      cast.dash={from:copy(player.position),direction,distance};
      player.facing=direction;
      cast.stage=2;
      this.queuePresentationCue({kind:'judgement',phase:'commit',actorId:player.id,from:copy(player.position),to:vec(player.position.x+direction.x*distance,player.position.y,player.position.z+direction.z*distance),durationTicks:JUDGEMENT.dashTo-JUDGEMENT.dashFrom+1,intensity:2,element:'arcane',priority:'essential',shape:'trail'});
    }
    if(cast.dash&&elapsed>=JUDGEMENT.dashFrom&&elapsed<=JUDGEMENT.dashTo){
      const direction=cast.dash.direction,stepLength=cast.dash.distance/(JUDGEMENT.dashTo-JUDGEMENT.dashFrom+1);
      const previous=player.position;
      player.position=moveCircle(s.arena,previous,vec(direction.x*stepLength,0,direction.z*stepLength),PLAYER_RADIUS,player.collisionHeight);
      player.velocity=scale(sub(player.position,previous),1/FIXED_STEP_SECONDS);
      player.facing=direction;
      while(cast.progress<JUDGEMENT.markCount&&elapsed-JUDGEMENT.dashFrom>=JUDGEMENT.markOffsets[cast.progress]!)this.placeJudgementMark(player,cast,direction);
    }
    if(elapsed>=JUDGEMENT.recoveryFrom&&cast.stage<3){
      cast.stage=3;
      player.velocity=vec(0,0,0);
      this.queuePresentationCue({kind:'judgement',phase:'resolve',actorId:player.id,position:copy(player.position),durationTicks:JUDGEMENT.ticks-JUDGEMENT.recoveryFrom,element:'arcane',priority:'essential',shape:'pulse'});
    }
    player.phase=elapsed<JUDGEMENT.dashFrom?'anticipation':elapsed<=JUDGEMENT.dashTo?'active':'recovery';
    if(elapsed>=JUDGEMENT.ticks)s.cast=undefined;
  }
  /** Mark `i` sits (i+1)/5 of the way along the planned dash, or where Aren was stopped short of that point. */
  private placeJudgementMark(player:CombatActor,cast:PlayerCast,direction:Vec3):void{
    const s=this.state,index=cast.progress++,dash=cast.dash!;
    const angle=yawOf(direction)+(index%2===0?JUDGEMENT.markAngle:-JUDGEMENT.markAngle);
    const planned=dash.distance*(index+1)/JUDGEMENT.markCount;
    const position=distance2(dash.from,player.position)>=planned-1e-6?vec(dash.from.x+dash.direction.x*planned,player.position.y,dash.from.z+dash.direction.z*planned):copy(player.position);
    const mark:LiveJudgementMark={id:`judgement-mark:${++s.arsenalSequence}`,position,angleRadians:angle,createdAtTick:s.tick,detonateAtTick:cast.startedTick+JUDGEMENT.dashTo+1+JUDGEMENT.detonationDelay+JUDGEMENT.detonationSpacing*index};
    s.judgementMarks.push(mark);
    this.queuePresentationCue({kind:'judgement-mark',phase:'anticipation',actorId:player.id,scopeId:mark.id,position:copy(mark.position),footprint:{width:JUDGEMENT.markRadius,length:JUDGEMENT.markRadius,angleRadians:angle},durationTicks:mark.detonateAtTick-s.tick,element:'arcane',priority:'essential',shape:'ring'});
  }
  private updateJudgementMarks():void{
    const s=this.state,marks=s.judgementMarks;
    if(!marks.length)return;
    let kept=0;
    for(let index=0;index<marks.length;index++){
      const mark=marks[index]!;
      if(s.tick<mark.detonateAtTick){marks[kept++]=mark;continue;}
      this.queuePresentationCue({kind:'judgement-mark',phase:'hit',actorId:s.playerId,scopeId:mark.id,position:copy(mark.position),footprint:{width:JUDGEMENT.markRadius,length:JUDGEMENT.markRadius,angleRadians:mark.angleRadians},intensity:1.2,element:'arcane',priority:'essential',shape:'burst'});
      for(const actor of s.actors){
        if(!this.isPlayerHostileTarget(actor)||distance2(mark.position,actor.position)>JUDGEMENT.markRadius+actor.radius)continue;
        this.strikeHostile(actor,{action:'judgement',clip:ACTION_CLIPS.judgement!,damage:JUDGEMENT.markDamage,stopTicks:JUDGEMENT.detonationHitStopTicks,element:'arcane',stagger:'none',instinct:0,counter:false});
      }
    }
    marks.length=kept;
  }
  /** Cancels every in-progress Arsenal cast, swing and held Sigil; flying projectiles and Judgement marks keep going. */
  private cancelPlayerAttackState():void{
    const s=this.state;
    this.endSigilCharge('interrupt');
    s.swing=undefined;s.cast=undefined;s.lightIndex=0;s.kitCancel=undefined;
    this.kit?.cancel();
  }
  private resetArsenal():void{
    const s=this.state;
    s.lightIndex=0;s.lightChainFrom=undefined;s.lightChainUntil=undefined;s.swing=undefined;s.cast=undefined;s.sigilCharge=undefined;
    s.kit={};s.untargetableUntil=undefined;s.evasion=undefined;s.kitCancel=undefined;this.kit?.reset();
    s.playerProjectiles=[];s.judgementMarks=[];s.pendingLightning=undefined;s.hitStop=undefined;s.deferredRelease=undefined;
    for(const actor of s.actors)actor.hitReactUntil=undefined;
  }
  private startPlayerAction(action:string,targetId?:ActorId,counter=false):boolean{
    const player=this.playerActor();
    if(this.playerIsDown())return false;
    if(this.state.traversal)return false;
    if(!player||player.downed)return false;
    if(action.startsWith('light_'))return this.startLight(Number(action.slice(6)),counter,false);
    if(!counter&&this.state.tick<this.state.actionRecoveryUntil)return false;
    if(this.kit&&(action==='heavy'||action==='charged_heavy'))return this.kit.startHeavy(action==='charged_heavy');
    if(this.state.heroId==='yara'&&(action==='heavy'||action==='charged_heavy')){
      if(!this.spendMana(playerSkillId(action)))return false;
      return this.startHeartrootCast(player,action==='heavy'?'root-spike':'root-eruption',action==='heavy'?HEARTROOT.spikeTicks:HEARTROOT.eruptionTicks);
    }
    if(this.skillReason(playerSkillId(action),targetId,counter))return false;
    const target=targetId===undefined?undefined:this.actorForId(targetId);
    if(!target||!target.visible||target.downed)return false;
    if(action==='cleanse'&&(target.corruption??0)<=0&&!target.possessed)return false;
    if(action==='root_tether'){
      const telegraph=this.state.telegraphs.find(item=>item.sourceId===target.id&&(item.phase==='windup'||item.phase==='commit'));
      if(!telegraph)return false;
    }
    if(this.kit&&action==='root_tether'){
      if(!this.spendMana('root_tether'))return false;
      this.state.targetId=target.id;
      return this.kit.startTether(target);
    }
    if(!this.spendMana(playerSkillId(action)))return false;
    this.state.targetId=target.id;this.state.lightIndex=0;
    const duration=action==='charged_heavy'?58:action==='heavy'?45:action==='cleanse'?90:action==='root_tether'?36:42;
    this.state.actionId=action;
    this.state.actionUntil=this.state.tick+duration;
    this.state.actionRecoveryUntil=this.state.actionUntil+18;
    this.state.actionCancelable=false;
    player.actionId=this.playerClip(action)??`aren-${action}` as ActionId;
    player.actionStartedTick=this.state.tick;player.normalizedTime=0;
    player.actionEndsTick=this.state.tick+duration+18;
    player.phase='anticipation';
    player.targetId=target.id;
    player.facing=facingFrom(sub(target.position,player.position));
    const attack=targetedStrike(action);
    const activeAt=this.state.tick+(action==='charged_heavy'?36:action==='heavy'?20:action==='cleanse'?35:12);
    const attackId=`aren-${action}` as AttackId;
    const cue=action==='cleanse'?'Root light gathers around the target.':'Staff draws back before the strike.';
    this.state.telegraphs.push({id:`${this.state.runId}:${this.state.tick}:${action}`,attackId,sourceId:player.id,targetPosition:copy(target.position),phase:'windup',remainingTicks:activeAt-this.state.tick,cue});
    this.emit('cue',action==='cleanse'?'Cleanse: stay within reach until the pulse completes.':`Aren prepares ${action.replaceAll('_',' ')}.`,player.id,target.id,action,attackId);
    this.state.pendingImpact={activeAt,activeUntil:activeAt+6,target:target.id,action,range:attack.range,radius:attack.radius,damage:attack.damage,interrupt:attack.interrupt,counter,startVitality:this.state.player.vitality,resolved:false};
    if(action==='cleanse')this.kit?.onSharedSkill?.('cleanse');
    return true;
  }
  private applyHazardPush(actor:CombatActor,direction:Vec3,meters:number):void{
    const jump=actor.id===this.state.playerId?this.state.playerJump:undefined;
    const committed=jump&&this.state.tick<=jump.flightStartedAtTick+jump.flightTicks;
    const airborne=committed&&this.state.tick>jump.airStartedAtTick;
    const delta=scale(direction,meters);
    const position=airborne
      ?moveAerialCircle(this.state.arena,actor.position,delta,actor.radius,actor.collisionHeight)
      :moveCircle(this.state.arena,actor.position,delta,actor.radius,actor.collisionHeight);
    if(committed){
      const offset=sub(position,actor.position);
      const from=add(jump.from,offset),to=add(jump.to,offset);
      const anticipationFrom=jump.anticipationFrom?add(jump.anticipationFrom,offset):undefined;
      // A push must not invalidate the committed landing or pull the next sample backward.
      if(!isSupportedCapsulePose(this.state.arena,to,actor.radius,actor.collisionHeight))return;
      let prior=position;
      for(let tick=this.state.tick;tick<=jump.flightStartedAtTick+jump.flightTicks;tick++){
        const elapsed=tick-jump.startedAtTick;
        const anticipation=anticipationFrom&&tick<=jump.airStartedAtTick;
        const progress=(elapsed+1)/(PLAYER_JUMP_ANTICIPATION_TICKS+1);
        const point=anticipation
          ?vec(anticipationFrom.x+(from.x-anticipationFrom.x)*progress,anticipationFrom.y+(from.y-anticipationFrom.y)*progress,anticipationFrom.z+(from.z-anticipationFrom.z)*progress)
          :jumpPosition(from,to,tick-jump.flightStartedAtTick,jump.flightTicks,jump.apex);
        const clear=anticipation
          ?isCirclePathClear(this.state.arena,prior,point,actor.radius,actor.collisionHeight)
          :isAerialCirclePathClear(this.state.arena,prior,point,actor.radius,actor.collisionHeight);
        if(!clear)return;
        prior=point;
      }
      jump.from=from;jump.to=to;jump.origin=add(jump.origin,offset);
      if(anticipationFrom)jump.anticipationFrom=anticipationFrom;
    }
    actor.position=position;
  }
  private updateHazards():void{
    if(this.playerIsDown()){this.endPlayerCombat();return;}
    for(const hazard of this.state.hazards){
      if(this.state.worldTick<hazard.activeFrom||this.state.worldTick>=hazard.activeUntil)continue;
      const attack=ATTACKS[hazard.attackId];
      if(!hazard.activePresentationEmitted){
        hazard.activePresentationEmitted=true;
        this.spawnCombatObstacles(hazard, attack);
        const impactKind=!attack?.element&&this.isWildlifeSource(hazard.sourceId)?this.wildlifeImpactKind(hazard.attackId):undefined;
        if(impactKind){
          // Physical Greenwake attacks retain their localized, target-locked impact.
          this.queuePresentationCue({kind:impactKind,phase:'active',actorId:hazard.sourceId,targetId:hazard.targetActorId??this.state.playerId,scopeId:hazard.id,position:copy(hazard.target),durationTicks:30,intensity:1,priority:'essential'});
        }else{
          this.queuePresentationCue({kind:'active',phase:'active',phaseStartedAtWorldTick:hazard.activeFrom,element:attack?.element,actorId:hazard.sourceId,targetId:hazard.targetActorId??this.state.playerId,scopeId:hazard.id,attackId:hazard.attackId,...hazardPresentation(hazard),durationTicks:hazard.activeUntil-this.state.worldTick,priority:'essential'});
        }
      }
      const targetClass=attack?.targetClass,hitInterval=attack?.hitIntervalTicks;
      for(const actor of this.state.actors){
        if(actor.downed||(targetClass==='companion'?actor.id!==hazard.targetActorId:actor.id!==this.state.playerId))continue;
        if(hitInterval?this.state.worldTick<(hazard.nextHitAt?.[actor.id]??0):hazard.hitIds.includes(actor.id))continue;
        if(!hazardThreatens(hazard,actor))continue;
        if(actor.id===this.state.playerId&&(this.judgementInvulnerable()||this.isUntargetable()))continue;
        const profileId=actor.id==='aren'?this.state.actionId as EvasionProfileId:'stumble_recovery';
        if((actor.id===this.state.playerId?this.state.tick:this.state.worldTick)<actor.invulnerableUntil&&avoids(profileId,hazard))continue;
        if(!hazard.hitIds.includes(actor.id))hazard.hitIds.push(actor.id);
        if(hitInterval)(hazard.nextHitAt??={})[actor.id]=this.state.worldTick+hitInterval;
        if(targetClass==='companion'&&hazard.attackId==='orun-crown-possession'){
          const phaseId=this.state.encounter?.phases[this.state.phaseIndex]?.id??'unknown';
          actor.possessed=true;actor.allegiance='hostile';actor.possessedUntil=this.state.worldTick+180;actor.targetId=this.state.playerId;actor.possessionInstanceId=hazard.id;actor.possessionSourceId=hazard.sourceId;
          const eventId=`${this.state.runId}:${this.state.encounterId}:possession:${hazard.id}:began`;
          this.emitWorldEvent({type:'possession',eventId,idempotencyKey:eventId,actorId:hazard.sourceId,targetId:actor.id,phaseId,state:'began',simulationTick:this.state.tick});
          this.emit('companion','Orun’s Crown holds the companion briefly; cleanse or coordinate a break before the hold ends.',hazard.sourceId,actor.id,'possession',hazard.attackId);
          this.queuePresentationCue({kind:'possession',phase:'hit',actorId:hazard.sourceId,targetId:actor.id,position:copy(actor.position),scopeId:this.state.encounterId,durationTicks:180,priority:'essential',shape:'pulse'});
          continue;
        }
        // Trial difficulty scales at hit time (direct hits and poison pulses alike); the authored damage stays on the hazard.
        const hazardDamage=Math.round(hazard.damage*(hazard.damageScale??1));
        const hazardPreDamage=actor.id===this.state.playerId?this.state.player.vitality:(actor.vitality??100);
        if(actor.id===this.state.playerId){
          this.state.player.vitality=Math.max(0,this.state.player.vitality-(this.kit?.absorbDamage?.(hazardDamage)??hazardDamage));
          if(attack?.onHit?.slowFactor!==undefined&&attack.onHit.slowTicks){
            this.state.playerSlow={factor:attack.onHit.slowFactor,untilWorldTick:this.state.worldTick+attack.onHit.slowTicks};
          }
        }
        else if(actor.possessed){this.breakPossession(actor);continue;}
        else actor.vitality=Math.max(0,(actor.vitality??100)-hazardDamage);
        const hazardActualLoss=Math.max(0,hazardPreDamage-(actor.id===this.state.playerId?this.state.player.vitality:(actor.vitality??100)));
        const hazardPayload=hazardActualLoss>0?{targetId:actor.id,amount:hazardActualLoss,position:copy(actor.position),worldTick:this.state.worldTick}:undefined;
        if(actor.id===this.state.playerId&&this.state.traversal)this.cancelTraversal();
        if(attack?.onHit?.pushMeters)this.applyHazardPush(actor,hazard.direction,attack.onHit.pushMeters);
        this.emit('damage',hazard.cue,actor.id,hazard.sourceId,undefined,hazard.attackId,hazardPayload);
        if(attack?.element||!this.isWildlifeSource(hazard.sourceId)||!this.wildlifeImpactKind(hazard.attackId)){
          this.queuePresentationCue({kind:'hit',phase:'hit',element:attack?.element,actorId:hazard.sourceId,targetId:actor.id,scopeId:hazard.id,attackId:hazard.attackId,...hazardPresentation(hazard),durationTicks:Math.max(1,Math.min(attack?.element?18:Infinity,hazard.activeUntil-this.state.worldTick)),priority:'essential'});
        }
        if(this.playerIsDown()){this.endPlayerCombat();return;}
      }
    }
    this.state.hazards=this.state.hazards.filter(hazard=>this.state.worldTick<Math.max(hazard.activeUntil,hazard.recoveryUntil??hazard.activeUntil+(ATTACKS[hazard.attackId]?.recoveryTicks??0)));
    this.state.telegraphs=this.state.telegraphs.filter(telegraph=>{
      if(telegraph.sourceId===this.state.playerId)return !!this.state.pendingImpact;
      const hazard=this.state.hazards.find(current=>current.id===telegraph.id);
      if(!hazard)return false;
      return this.state.worldTick<(hazard.recoveryUntil??hazard.activeUntil+(ATTACKS[telegraph.attackId]?.recoveryTicks??0));
    });
    for(const telegraph of this.state.telegraphs){
      if(telegraph.sourceId===this.state.playerId){
        const pending=this.state.pendingImpact;
        if(!pending)continue;
        telegraph.phase=this.state.tick<pending.activeAt?'windup':this.state.tick<pending.activeUntil?'active':'recovery';
        telegraph.remainingTicks=Math.max(0,(telegraph.phase==='windup'?pending.activeAt:telegraph.phase==='active'?pending.activeUntil:this.state.actionRecoveryUntil)-this.state.tick);
        const actor=this.playerActor();
        if(actor)actor.phase=telegraph.phase==='active'?'active':telegraph.phase==='recovery'?'recovery':'anticipation';
        continue;
      }
      const hazard=this.state.hazards.find(current=>current.id===telegraph.id);
      if(!hazard)continue;
      const attack=ATTACKS[telegraph.attackId];
      const commitAt=hazard.windupUntil??hazard.startTick+(attack?.windupTicks??0);
      const castUntil=hazard.castUntil??hazard.activeUntil;
      const recoveryUntil=hazard.recoveryUntil??hazard.activeUntil+(attack?.recoveryTicks??0);
      const priorPhase=telegraph.phase;
      telegraph.phase=this.state.worldTick<commitAt?'windup':this.state.worldTick<hazard.activeFrom?'commit':this.state.worldTick<castUntil?'active':'recovery';
      const phaseEnd=telegraph.phase==='windup'?commitAt:telegraph.phase==='commit'?hazard.activeFrom:telegraph.phase==='active'?castUntil:recoveryUntil;
      telegraph.remainingTicks=Math.max(0,phaseEnd-this.state.worldTick);
      const source=this.state.actors.find(actor=>actor.id===telegraph.sourceId);
      if(source)source.phase=telegraph.phase==='active'?'active':telegraph.phase==='recovery'?'recovery':'anticipation';
      const restoredWarning=!hazard.warningPresentationEmitted&&(telegraph.phase==='windup'||telegraph.phase==='commit');
      if(restoredWarning||(priorPhase==='windup'&&telegraph.phase==='commit')){
          const kind=telegraph.phase==='windup'?'anticipation':'commit';
          this.queuePresentationCue({kind,phase:kind,phaseStartedAtWorldTick:telegraph.phase==='windup'?hazard.startTick:commitAt,element:attack?.element,actorId:telegraph.sourceId,targetId:hazard.targetActorId??this.state.playerId,scopeId:hazard.id,attackId:telegraph.attackId,...hazardPresentation(hazard),durationTicks:Math.max(0,phaseEnd-this.state.worldTick),priority:'essential'});
          hazard.warningPresentationEmitted=true;
      }
    }
    const pending=this.state.pendingImpact;
    const player=this.playerActor();
    if(pending&&player&&pending.action==='cleanse'&&this.state.player.vitality<pending.startVitality){
      this.emit('cue','Cleanse interrupted by the incoming hit.',player.id,pending.target,'cleanse');
      this.state.pendingImpact=undefined;
    }else if(pending&&this.state.tick>=pending.activeAt&&!pending.resolved){
      this.resolvePlayerImpact(pending);
      pending.resolved=true;
    }
    if(pending?.resolved&&this.state.tick>=pending.activeUntil)this.state.pendingImpact=undefined;
  }
  private resolvePlayerImpact(p:PendingImpact):void{
    if(this.playerIsDown())return;
    const player=this.playerActor();
    if(player&&(p.action==='heavy'||p.action==='charged_heavy'))this.queueHeavySlash(player,p);
    const target=this.state.actors.find(actor=>actor.id===p.target);
    const objectTarget=!target&&(p.action==='heavy'||p.action==='charged_heavy')?this.state.movableObjects.find(object=>object.objectId===p.target&&object.phase==='resting'&&object.authored.playerInteractionId===p.interactionId):undefined;
    const targetPosition=target?.position??objectTarget?.position??p.interactionPosition;
    const targetRadius=objectTarget?.authored.radiusMeters??0;
    if(player&&p.action==='charged_heavy')this.scheduleThunder(player,targetPosition,p.range+p.radius+targetRadius);
    if(!player||!targetPosition||target?.downed||distance2(player.position,targetPosition)>p.range+p.radius+targetRadius)return;
    const face=facingFrom(sub(targetPosition,player.position));
    const facingMiss=dot(face,player.facing)<.5;
    if(objectTarget?facingMiss:distance2(player.position,targetPosition)>.01&&facingMiss)return;
    if(!target){
      if(!p.interactionId)return;
      this.recordResolvedAction(p.action,p.target);
      this.emit('action',`${p.action.replaceAll('_',' ')} lands on ${p.target}.`,player.id,p.target,p.action,`aren-${p.action}` as AttackId);
      this.queuePresentationCue({kind:p.action==='cleanse'?'cleanse':'hit',phase:'hit',actorId:player.id,targetId:p.target,position:copy(targetPosition),from:copy(player.position),to:copy(targetPosition),scopeId:this.state.encounterId,attackId:`aren-${p.action}` as AttackId,actionId:(ACTION_CLIPS[p.action]??'aren-hit') as ActionId,footprint:{width:1,length:p.range},priority:'essential',shape:p.action==='cleanse'?'pulse':'burst'});
      this.resolveInteraction(p.interactionId,p.target);
      return;
    }
    if(p.action==='cleanse'){
      if(target.possessed){
        this.breakPossession(target);
        this.recordResolvedAction(p.action,target.id);
        this.markPhaseAction('cleanse');
        this.queuePresentationCue({kind:'cleanse',phase:'resolve',actionId:'aren-cleanse' as ActionId,actorId:player.id,targetId:target.id,position:copy(target.position),scopeId:this.state.encounterId,priority:'essential',shape:'pulse'});
        return;
      }
      if((target.corruption??0)<=0)return;
      const coreIds=target.corruptionCoreIds;
      if(coreIds?.length){
        const cleansed=target.cleansedCoreIds??[];
        const nextCoreId=coreIds.find(id=>!cleansed.includes(id));
        if(!nextCoreId)return;
        target.cleansedCoreIds=[...cleansed,nextCoreId];
        target.corruption=Math.round(100*(coreIds.length-target.cleansedCoreIds.length)/coreIds.length);
      }else target.corruption=Math.max(0,(target.corruption??0)-40);
      this.recordResolvedAction(p.action,target.id);
      this.emit('world','Corruption eased; environmental repair and trust remain separate.',player.id,target.id,'cleanse');
      const required=this.state.encounter?.phases[this.state.phaseIndex]?.requiredAction;
      if(target.corruption===0||required==='cleanse')this.markPhaseAction('cleanse');
      if(target.corruption===0&&target.id===this.state.encounter?.bossId)this.resolveEncounter('cleansed',target);
      this.queuePresentationCue({kind:'cleanse',phase:'resolve',actionId:'aren-cleanse' as ActionId,actorId:player.id,targetId:target.id,position:copy(target.position),scopeId:this.state.encounterId,intensity:target.corruption===0?1:.55,priority:'essential',shape:'pulse'});
      return;
    }
    if(p.action==='root_tether'){
      if(this.interruptAttack(target,'root_tether')){
        this.markPhaseAction('tether');
        this.recordResolvedAction(p.action,target.id);
        this.queuePresentationCue({kind:'tether',phase:'hit',actionId:'aren-root-tether' as ActionId,actorId:player.id,targetId:target.id,from:copy(player.position),to:copy(target.position),scopeId:this.state.encounterId,attackId:this.state.telegraphs.find(item=>item.sourceId===target.id)?.attackId,priority:'essential',shape:'beam'});
      }
      return;
    }
    this.recordResolvedAction(p.action,target.id);
    this.strikeHostile(target,{action:p.action,clip:(ACTION_CLIPS[p.action]??'aren-hit') as ActionId,damage:p.damage,stopTicks:p.action==='charged_heavy'?HIT_STOP_TICKS.charged:HIT_STOP_TICKS.heavy,element:'arcane',stagger:p.interrupt?'interrupt':'none',instinct:0,counter:p.counter});
  }
  private queueHeavySlash(player:CombatActor,p:PendingImpact):void{
    const charged=p.action==='charged_heavy';
    this.queuePresentationCue({kind:'slash',phase:'active',actorId:player.id,actionId:ACTION_CLIPS[p.action],position:copy(player.position),footprint:{width:p.range,length:p.range,angleRadians:yawOf(player.facing),sectorRadians:charged?2.8:2.4},durationTicks:p.activeUntil-p.activeAt,intensity:charged?2:1.6,element:'arcane',priority:'essential',shape:'arc'});
  }
  /** Thunder Cleave: the lightning lands on the struck point when the blow is in reach, otherwise ahead of Aren. */
  private scheduleThunder(player:CombatActor,struck:Vec3|undefined,reach:number):void{
    const point=struck&&distance2(player.position,struck)<=reach?struck:vec(player.position.x+player.facing.x*THUNDER_CLEAVE.fallbackForward,player.position.y,player.position.z+player.facing.z*THUNDER_CLEAVE.fallbackForward);
    this.state.pendingLightning={atTick:this.state.tick+THUNDER_CLEAVE.delayTicks,position:copy(point)};
  }
  private updateBossAI():void{
    if(this.playerIsDown())return;
    const encounter=this.state.encounter;
    if(!encounter||this.state.rewardEmitted)return;
    const phase=encounter.phases[this.state.phaseIndex];
    if(!phase)return;
    if(encounter.encounterFamily==='wildlife'){this.updateWildlifeAI(encounter,phase.attackIds);return;}
    const selectorTick=Math.max(0,this.state.lastAttackTick-this.state.attackSelectionWorldOffset);
    for(const sourceId of encounter.actorIds){
      if(sourceId===this.state.playerId)continue;
      const source=this.state.actors.find(actor=>actor.id===sourceId&&actor.visible&&actor.allegiance==='hostile');
      if(!source||source.downed||this.state.worldTick<source.recoveringUntil||this.state.telegraphs.some(telegraph=>telegraph.sourceId===source.id))continue;
      const attackIds=phase.attackIds.filter(id=>ATTACKS[id]?.bossId===source.id);
      if(!attackIds.length)continue;
      const attackIndex=Math.floor(selectorTick/120)%attackIds.length;
      const attackId=attackIds[attackIndex];if(!attackId)continue;
      let def:AttackDefinition|undefined=ATTACKS[attackId];
      if(def?.targetClass==='companion'&&!this.selectedCompanion())def=attackIds.map(id=>ATTACKS[id]).find(attack=>attack&&attack.targetClass!=='companion');
      if(def&&def.targetClass!=='companion'&&this.isUntargetable())continue;
      if(!def)continue;
      this.beginAttack(source,def);
      this.state.lastAttackTick=this.state.worldTick;
    }
  }
  private updateWildlifeAI(encounter:BossEncounterDefinition,attackIds:readonly string[]):void{
    const player=this.playerActor();
    if(!player)return;
    const trial=this.state.combatTrial;
    const engageRange=trial?TRIAL_ENGAGE_RANGE:12;
    let engaged=false;
    for(const actor of this.state.actors){
      if(encounter.actorIds.includes(actor.id)&&actor.id!==player.id&&actor.visible&&actor.allegiance==='hostile'&&!actor.downed&&distance2(actor.position,player.position)<=engageRange&&(!trial||this.trials()[trial.index]?.monsterId===actor.id)){engaged=true;break;}
    }
    const state=engaged?(this.state.wildlifeCombat??={engagedTicks:0,sourceCursor:0,attackCursors:{}}):this.state.wildlifeCombat;
    if(state&&engaged)state.engagedTicks+=this.state.worldTimeScale;
    const pressure=getWildlifePressure(state?.engagedTicks??0);
    const aggression=trial?this.trialRamp()[trial.index]?.aggression??1:1;
    if(trial){
      attackIds=this.trials()[trial.index]?.attackIds??attackIds;
      this.updateTrialMonsters(trial,player,pressure);
    }
    if(!engaged||!state)return;
    if(state.chain&&this.continueChain(state,pressure,player,attackIds))return;
    if(this.state.lastAttackTick>0&&this.state.worldTick-this.state.lastAttackTick<Math.round(pressure.cadenceTicks/aggression))return;
    const load=this.wildlifeLoad();
    if(load.casting>=pressure.maxConcurrent||load.live>=4)return;
    for(let offset=0;offset<encounter.actorIds.length;offset++){
      const index=(state.sourceCursor+offset)%encounter.actorIds.length;
      const id=encounter.actorIds[index]!;
      const source=this.state.actors.find(actor=>actor.id===id);
      if(!source||source.id===player.id||!source.visible||source.allegiance!=='hostile'||source.downed||this.state.worldTick<source.recoveringUntil||this.state.telegraphs.some(telegraph=>telegraph.sourceId===id))continue;
      if(trial?this.trials()[trial.index]?.monsterId!==source.id||!this.trialCastReady(source,player,false):distance2(source.position,player.position)>12)continue;
      if(this.castFromRotation(source,attackIds,state,pressure,load.poison,false)){
        state.sourceCursor=(index+1)%encounter.actorIds.length;
        return;
      }
    }
  }
  /** Casting / live-hazard counts across wildlife sources, used to enforce the per-tier concurrency caps. */
  private wildlifeLoad():{casting:number;live:number;poison:number}{
    let casting=0,live=0,poison=0;
    for(const hazard of this.state.hazards){
      if(!this.isWildlifeSource(hazard.sourceId))continue;
      if(this.state.worldTick<(hazard.castUntil??hazard.activeUntil))casting++;
      if(this.state.worldTick<hazard.activeUntil){live++;if(ATTACKS[hazard.attackId]?.element==='poison')poison++;}
    }
    return {casting,live,poison};
  }
  /** Starts the next authored attack in `source`'s rotation; the cursor advances past skipped poison casts. */
  private castFromRotation(source:CombatActor,attackIds:readonly string[],state:WildlifeCombatState,pressure:WildlifePressureTier,poison:number,chainSecond:boolean):boolean{
    let count=0;
    for(const attackId of attackIds)if(ATTACKS[attackId]?.bossId===source.id)count++;
    if(!count)return false;
    const cursor=state.attackCursors[source.id]??0;
    for(let attempt=0;attempt<count;attempt++){
      const selected=(cursor+attempt)%count;
      let ordinal=0,definition:AttackDefinition|undefined;
      for(const attackId of attackIds){
        const candidate=ATTACKS[attackId];
        if(candidate?.bossId===source.id&&ordinal++===selected){definition=candidate;break;}
      }
      if(!definition||(definition.element==='poison'&&poison>=2))continue;
      if(definition.targetClass!=='companion'&&this.isUntargetable())return false;
      const aggression=this.trialDifficultyOf(source.id)?.aggression??1;
      const hazard=this.beginAttack(source,scaleTrialAttack(scaleWildlifeAttack(definition,pressure),aggression));
      state.attackCursors[source.id]=cursor+attempt+1;
      this.state.lastAttackTick=this.state.worldTick;
      if(hazard&&this.state.combatTrial&&source.motion){
        source.motion.nextCastAt=hazard.recoveryUntil!+Math.round(pressure.repositionTicks/aggression);
        if(!chainSecond){
          state.castCount=(state.castCount??0)+1;
          if(pressure.chainEvery>0&&state.castCount%pressure.chainEvery===0)state.chain={sourceId:source.id,hazardId:hazard.id};
        }
      }
      return true;
    }
    return false;
  }
  /** Start of a trial cast: past roar and reposition pauses, inside its range band, body pointed at the player. */
  private trialCastReady(source:CombatActor,player:CombatActor,chainSecond:boolean):boolean{
    const motion=source.motion,profile=MONSTER_PROFILES[source.id];
    if(!motion||!profile)return false;
    const tick=this.state.worldTick;
    if(tick<motion.roarUntil||!chainSecond&&tick<motion.nextCastAt)return false;
    const dx=player.position.x-source.position.x,dz=player.position.z-source.position.z;
    return Math.hypot(dx,dz)<=profile.bandMax+CAST_RANGE_MARGIN&&Math.abs(wrapAngle(Math.atan2(dx,dz)-Math.atan2(source.facing.x,source.facing.z)))<=CAST_FACING_TOLERANCE;
  }
  /** Queues the second attack of a chain the moment the first one's active window ends, with no recovery in between. */
  private continueChain(state:WildlifeCombatState,pressure:WildlifePressureTier,player:CombatActor,attackIds:readonly string[]):boolean{
    const chain=state.chain!;
    const source=this.state.actors.find(actor=>actor.id===chain.sourceId);
    const first=this.state.hazards.find(hazard=>hazard.id===chain.hazardId);
    const ready=first?.castUntil??first?.activeUntil??0;
    if(!source||!first||source.downed||source.allegiance!=='hostile'||!this.state.telegraphs.some(telegraph=>telegraph.id===first.id)||this.state.worldTick>ready+CHAIN_PATIENCE_TICKS){state.chain=undefined;return false;}
    if(this.state.worldTick<ready||!this.trialCastReady(source,player,true))return false;
    const load=this.wildlifeLoad();
    if(load.casting>=pressure.maxConcurrent||load.live>=4)return false;
    first.recoveryUntil=Math.min(first.recoveryUntil??Infinity,this.state.worldTick);
    state.chain=undefined;
    return this.castFromRotation(source,attackIds,state,pressure,load.poison,true);
  }
  /** Locomotion for the three trial monsters: only the current stage's hostile monster moves; the others idle in place. */
  private updateTrialMonsters(trial:CombatTrialState,player:CombatActor,pressure:WildlifePressureTier):void{
    const dt=FIXED_STEP_SECONDS*this.state.worldTimeScale;
    const trials=this.trials();
    for(let index=0;index<trials.length;index++){
      const definition=trials[index]!;
      const actor=this.state.actors.find(candidate=>candidate.id===definition.monsterId);
      const profile=MONSTER_PROFILES[definition.monsterId];
      if(!actor||!profile)continue;
      const motion=actor.motion??=createMonsterMotion(index*7919+13);
      actor.velocity=vec(0,0,0);motion.yawRate=0;
      if(dt<=0||actor.downed||!actor.visible||index!==trial.index||actor.allegiance!=='hostile')continue;
      this.driveTrialMonster(actor,motion,profile,definition,player,pressure,dt,this.trialRamp()[index]!.speedScale);
    }
  }
  private driveTrialMonster(actor:CombatActor,motion:MonsterMotionState,profile:MonsterProfile,definition:CombatTrialDefinition,player:CombatActor,pressure:WildlifePressureTier,dt:number,speedScale:number):void{
    const tick=this.state.worldTick;
    const dx=player.position.x-actor.position.x,dz=player.position.z-actor.position.z;
    const distance=Math.hypot(dx,dz),toPlayer=Math.atan2(dx,dz);
    const hazard=this.liveAttackOf(actor);
    if(!motion.engaged){
      if(distance<=TRIAL_ENGAGE_RANGE){
        motion.engaged=true;motion.roarTier=pressure.tier;
        // A player who arrives already inside the attack band is ambushed rather than announced.
        if(distance>profile.bandMax&&!hazard)this.startRoar(actor,motion,pressure.tier,toPlayer);
      }
    }else if(distance>TRIAL_DISENGAGE_RANGE)motion.engaged=false;
    else if(!hazard&&pressure.tier>motion.roarTier&&tick>=motion.roarUntil&&tick>=actor.staggerUntil){motion.roarTier=pressure.tier;this.startRoar(actor,motion,pressure.tier,toPlayer);}
    if(tick<actor.staggerUntil){motion.lunge=undefined;this.endRoar(actor,motion);return;}
    if(hazard){
      const heading=Math.atan2(hazard.direction.x,hazard.direction.z);
      if(tick<(hazard.windupUntil??hazard.activeFrom))this.moveMonster(actor,motion,profile,definition,heading,0,dt);
      else if(tick<hazard.activeFrom){
        // Commit: finish turning towards the committed direction at a bounded rate that still reaches it by the first active tick (facing never snaps).
        const remaining=Math.abs(wrapAngle(heading-Math.atan2(actor.facing.x,actor.facing.z)))/(Math.max(1,hazard.activeFrom-tick)*dt);
        this.moveMonster(actor,motion,profile,definition,heading,0,dt,Math.min(ATTACK_TURN_RATE_MAX,Math.max(profile.yawRate,remaining)));
      }else if(tick<(hazard.castUntil??hazard.activeUntil))actor.facing=vec(hazard.direction.x,0,hazard.direction.z);
      else this.moveMonster(actor,motion,profile,definition,toPlayer,0,dt);
      const lunge=motion.lunge;
      if(lunge&&!lunge.landed&&lunge.hazardId===hazard.id&&tick>=lunge.fromTick)this.stepLunge(actor,motion,definition,dt);
      return;
    }
    motion.lunge=undefined;
    if(tick<motion.roarUntil){this.moveMonster(actor,motion,profile,definition,toPlayer,0,dt);return;}
    if(!motion.engaged)return;
    const blocked=motion.blockedTicks>=STUCK_TICKS;
    if(blocked)motion.blockedTicks=0;
    const steer=steerMonster(profile,motion,{distance,toPlayer,fromCenterX:actor.position.x-definition.arena.center.x,fromCenterZ:actor.position.z-definition.arena.center.z,arenaRadius:definition.arena.radius,squareUp:tick>=motion.nextCastAt&&tick>=actor.recoveringUntil,worldTick:tick,blocked});
    this.moveMonster(actor,motion,profile,definition,steer.heading,steer.speed*speedScale*(actor.crippleUntil!==undefined&&tick<actor.crippleUntil?actor.crippleFactor??1:1),dt);
  }
  /** The newest hazard of `actor` that has not finished its recovery. */
  private liveAttackOf(actor:CombatActor):LiveHazard|undefined{
    let latest:LiveHazard|undefined;
    for(const hazard of this.state.hazards){
      if(hazard.sourceId!==actor.id||this.state.worldTick>=(hazard.recoveryUntil??hazard.activeUntil))continue;
      if(!latest||hazard.startTick>latest.startTick)latest=hazard;
    }
    return latest;
  }
  /** Turns at the profile's yaw rate, then walks along the new facing, slowing to a pivot when the heading error is large. */
  private moveMonster(actor:CombatActor,motion:MonsterMotionState,profile:MonsterProfile,definition:CombatTrialDefinition,heading:number,speed:number,dt:number,yawLimit=profile.yawRate):void{
    const current=Math.atan2(actor.facing.x,actor.facing.z);
    const error=wrapAngle(heading-current),limit=yawLimit*dt;
    const applied=Math.max(-limit,Math.min(limit,error));
    const angle=current+applied;
    actor.facing=vec(Math.sin(angle),0,Math.cos(angle));
    motion.yawRate=applied/dt;
    const step=speed>0?speed*turnTranslationScale(error-applied)*dt:0;
    if(step<=0)return;
    const moved=this.stepMonster(actor,definition,actor.facing.x*step,actor.facing.z*step,dt,false);
    motion.blockedTicks=moved<step*0.33?motion.blockedTicks+1:0;
  }
  /** One collision-swept monster step that never leaves the trial arena circle or walkable ground; returns metres moved. */
  private stepMonster(actor:CombatActor,definition:CombatTrialDefinition,dx:number,dz:number,dt:number,ignoreOwnObstacles:boolean):number{
    const center=definition.arena.center,limit=definition.arena.radius-TRIAL_ARENA_INSET;
    const step=clampStepToArena(actor.position.x,actor.position.z,dx,dz,center.x,center.z,limit,this.monsterStep);
    if(step.dx===0&&step.dz===0)return 0;
    let arena=this.state.arena;
    // A charge must run through the roots its own commit spawned beside the lane.
    if(ignoreOwnObstacles&&this.state.combatObstacles.some(obstacle=>obstacle.sourceId===actor.id)){
      const prefix=`combat-obstacle:${actor.id}:`;
      arena={...arena,colliders:arena.colliders.filter(collider=>!collider.id.startsWith(prefix))};
    }
    const next=moveCircle(arena,actor.position,vec(step.dx,0,step.dz),actor.radius,actor.collisionHeight);
    const before=Math.hypot(actor.position.x-center.x,actor.position.z-center.z);
    if(Math.hypot(next.x-center.x,next.z-center.z)>Math.max(limit,before))return 0;
    const moved=Math.hypot(next.x-actor.position.x,next.z-actor.position.z);
    actor.velocity=vec((next.x-actor.position.x)/dt,0,(next.z-actor.position.z)/dt);
    actor.position=vec(next.x,next.y,next.z);
    actor.sockets={...actor.sockets,root:copy(actor.position),head:vec(next.x,next.y+1.5,next.z)};
    return moved;
  }
  private stepLunge(actor:CombatActor,motion:MonsterMotionState,definition:CombatTrialDefinition,dt:number):void{
    const lunge=motion.lunge!;
    const u=Math.min(1,Math.max(0,(this.state.worldTick-lunge.fromTick)/Math.max(1e-6,lunge.toTick-lunge.fromTick)));
    const want=lunge.travel*(lunge.kind==='charge'?u:u*u*(3-2*u))-lunge.done;
    let blocked=false;
    if(want>1e-3){
      const moved=this.stepMonster(actor,definition,lunge.dirX*want,lunge.dirZ*want,dt,true);
      lunge.done+=moved;
      blocked=moved<want*0.5;
    }
    if(!blocked&&u<1)return;
    lunge.landed=true;
    this.queuePresentationCue({kind:'landing',phase:'landing',actorId:actor.id,targetId:this.state.playerId,scopeId:lunge.hazardId,position:copy(actor.position),footprint:{width:3.2,length:3.2},shape:'ring',durationTicks:24,intensity:lunge.kind==='charge'?1:0.5,priority:'essential'});
  }
  private startRoar(actor:CombatActor,motion:MonsterMotionState,tier:number,toPlayer:number):void{
    motion.roarFrom=this.state.worldTick;motion.roarUntil=motion.roarFrom+ROAR_TICKS;motion.lunge=undefined;
    // Apex is the monster's ground root: the presentation draws the sector from `position`.
    this.queuePresentationCue({kind:'roar-cone',phase:'anticipation',actorId:actor.id,targetId:this.state.playerId,scopeId:actor.id+':roar',position:copy(actor.position),durationTicks:ROAR_TICKS,intensity:Math.min(1,0.6+0.13*tier),priority:'essential',shape:'sector',footprint:{width:8,length:6,angleRadians:toPlayer,sectorRadians:1.4}});
  }
  /** Ends a roar early (stagger, cleared stage) and releases its scoped presentation. No-op when the monster is not roaring. */
  private endRoar(actor:CombatActor,motion:MonsterMotionState):void{
    if(this.state.worldTick>=motion.roarUntil)return;
    motion.roarUntil=0;
    this.queuePresentationCue({kind:'cancel',phase:'resolve',actorId:actor.id,scopeId:actor.id+':roar',cancellationReason:'interrupt'});
  }
  private beginAttack(source:CombatActor,def:AttackDefinition):LiveHazard|undefined{
    if(this.playerIsDown())return undefined;
    if(def.targetClass!=='companion'&&this.isUntargetable())return undefined;
    const target=def.targetClass==='companion'?this.selectedCompanion():this.playerActor();
    if(!target)return undefined;
    const trial=this.state.combatTrial;
    const id=`${source.id}:${def.id}:${this.state.tick}`;
    const aim=vec(target.position.x,def.element?(groundHeightAt(this.state.arena,target.position.x,target.position.z,target.position.y)??target.position.y):target.position.y,target.position.z);
    const origin=copy(source.position);
    const direction=facingFrom(sub(aim,origin));
    const shape=structuredClone(def.hazard);
    // Trial monsters cast lanes from their own body, long enough to cover the aimed position.
    let anchor=aim;
    if(trial&&def.laneFromSource){
      shape.depth=Math.min(shape.depth+2,Math.max(shape.depth,distance2(origin,aim)+1.5));
      anchor=vec(origin.x+direction.x*shape.depth/2,aim.y,origin.z+direction.z*shape.depth/2);
    }
    const cone=shape.kind==='cone',disk=shape.kind==='strike'||shape.kind==='projectile',longAxis=shape.kind==='sweep'||shape.kind==='wave';
    const center=cone?origin:anchor;
    const range=shape.depth;
    const longHalf=cone?range:disk?shape.radius:shape.depth/2;
    const wideHalf=cone?range:disk?shape.radius:shape.width/2;
    const extentX=longAxis?Math.abs(direction.x)*longHalf+Math.abs(direction.z)*wideHalf:wideHalf;
    const extentZ=longAxis?Math.abs(direction.z)*longHalf+Math.abs(direction.x)*wideHalf:longHalf;
    const groundY=def.element?center.y:origin.y;
    shape.bounds={min:vec(center.x-extentX,groundY-.15,center.z-extentZ),max:vec(center.x+extentX,groundY+Math.max(.15,shape.heightAboveGround),center.z+extentZ)};
    this.state.telegraphs.push({id,attackId:def.id as AttackId,sourceId:source.id,targetPosition:anchor,phase:'windup',remainingTicks:def.windupTicks+def.commitTicks,cue:def.cue});
    this.emit('cue',def.cue,source.id,target.id,undefined,def.id as AttackId);
    const h:LiveHazard={...shape,id,attackId:def.id as AttackId,sourceId:source.id,startTick:this.state.worldTick,activeFrom:this.state.worldTick+def.windupTicks+def.commitTicks,activeUntil:this.state.worldTick+def.windupTicks+def.commitTicks+def.activeTicks,target:anchor,origin,direction,range:shape.depth,angleDeg:shape.angleDeg??70,hitIds:[],threatTicks:[this.state.worldTick+def.windupTicks+def.commitTicks-8,this.state.worldTick+def.windupTicks+def.commitTicks-4],cue:def.cue,targetActorId:target.id};
    h.windupUntil=h.startTick+def.windupTicks;
    h.castUntil=h.activeFrom+(def.castTicks??def.activeTicks);
    if(trial)h.damageScale=this.trialDifficultyOf(source.id)?.damageScale??1;
    h.recoveryUntil=h.castUntil+def.recoveryTicks;
    this.state.hazards.push(h);
      this.queuePresentationCue({kind:'anticipation',phase:'anticipation',phaseStartedAtWorldTick:h.startTick,element:def.element,actorId:source.id,targetId:target.id,scopeId:h.id,attackId:def.id as AttackId,...hazardPresentation(h),durationTicks:def.windupTicks,intensity:1,priority:'essential'});
      h.warningPresentationEmitted=true;
    if(def.targetClass==='companion'&&this.state.encounterId){
      const phaseId=this.state.encounter?.phases[this.state.phaseIndex]?.id??'unknown';
      const eventId=`${this.state.runId}:${this.state.encounterId}:possession:${id}:telegraphed`;
      this.emitWorldEvent({type:'possession',eventId,idempotencyKey:eventId,actorId:source.id,targetId:target.id,phaseId,state:'telegraphed',simulationTick:this.state.tick});
    }
    if(trial&&source.motion){
      const lunge=def.lunge;
      source.motion.lunge=undefined;
      if(lunge){
        const charge=lunge.kind==='charge';
        const travel=lunge.kind==='charge'?Math.max(2,shape.depth-1):Math.min(lunge.meters,Math.max(0,distance2(origin,aim)-3.5));
        if(travel>0.05)source.motion.lunge={hazardId:id,kind:lunge.kind,dirX:direction.x,dirZ:direction.z,travel,fromTick:charge?h.activeFrom:h.windupUntil,toTick:charge?h.castUntil:h.activeFrom,done:0,landed:false};
      }
    }
    source.actionId=ACTION_CLIPS[`boss:${def.id}`]!;
    source.phase='anticipation';
    source.targetId=target.id;
    if(!trial)source.facing=h.direction;
    source.recoveringUntil=h.recoveryUntil;
    source.normalizedTime=0;
    source.actionStartedTick=this.state.worldTick;
    source.actionEndsTick=source.recoveringUntil;
    return h;
  }
  private interruptAttack(source:CombatActor,action:string):boolean{
    const tele=this.state.telegraphs.find(t=>t.sourceId===source.id);if(!tele)return false;
    const def=ATTACKS[tele.attackId];if(def?.interruptibleBy.length&&!def.interruptibleBy.includes(action as never))return false;
    const hazard=this.state.hazards.find(h=>h.id===tele.id);
    if(hazard){hazard.activeUntil=this.state.worldTick;hazard.castUntil=this.state.worldTick;hazard.recoveryUntil=this.state.worldTick;}
    if(source.motion)source.motion.lunge=undefined;
    this.queuePresentationCue({kind:'cancel',phase:'resolve',scopeId:tele.id,cancellationReason:'interrupt'});
    this.clearCombatObstacles(source.id);
    this.state.telegraphs=this.state.telegraphs.filter(t=>t.id!==tele.id);source.phase='recovery';source.actionId=(source.id+'-stagger') as ActionId;source.normalizedTime=0;source.actionStartedTick=this.state.worldTick;source.staggerUntil=this.state.worldTick+42;source.recoveringUntil=source.staggerUntil;source.actionEndsTick=source.recoveringUntil;this.emit('attack-interrupted',tele.attackId+' interrupted before its active window.',this.state.playerId,source.id,action,tele.attackId);return true;
  }
  private markPhaseAction(action:string):void{
    if(!this.state.phaseActionFlags.includes(action))this.state.phaseActionFlags.push(action);
  }
  private updatePhase():void{
    if(this.state.combatTrial)return;
    const boss=this.currentBoss();if(!boss||!this.state.encounter)return;
    const expected=Math.min(this.state.encounter.phases.length-1,Math.floor((100-(boss.ferocity??100))/Math.max(1,100/this.state.encounter.phases.length)));
    if(expected<=this.state.phaseIndex)return;
    const phase=this.state.encounter.phases[this.state.phaseIndex];
    const required=phase?.requiredAction;
    if(required&&required!=='none'&&!this.state.phaseActionFlags.includes(required))return;
    const completed=this.state.encounter.phases[this.state.phaseIndex];
    if(completed)this.emitPhaseEvent(completed.id,this.state.phaseIndex,'cleared');
    const next=this.state.phaseIndex+1;
    this.state.phaseIndex=next;
    this.state.phaseLatch=next;
    this.state.phaseActionFlags=[];
    for(const hazard of this.state.hazards)this.queuePresentationCue({kind:'cancel',phase:'resolve',scopeId:hazard.id,cancellationReason:'interrupt'});
    this.state.hazards=[];
    this.clearCombatObstacles();
    this.state.telegraphs=[];
    const nextPhase=this.state.encounter.phases[next];
    if(nextPhase)this.emitPhaseEvent(nextPhase.id,next,'entered');
    this.emit('cue',`Boss phase changed: ${nextPhase?.id}.`,boss.id);
    this.queuePresentationCue({kind:'phase',phase:'resolve',actorId:boss.id,targetId:this.state.playerId,position:copy(boss.position),scopeId:this.state.encounterId,priority:'essential',shape:'pulse'});
  }
  private emitPhaseEvent(phaseId:string,phaseIndex:number,state:'entered'|'cleared'):void{
    if(!this.state.encounterId)return;
    const eventId=`${this.state.runId}:${this.state.encounterId}:phase:${phaseIndex}:${state}`;
    this.emitWorldEvent({type:'encounter-phase',eventId,idempotencyKey:eventId,encounterId:this.state.encounterId,actorId:this.state.encounter?.bossId??'orun' as ActorId,phaseId,phaseIndex,state,simulationTick:this.state.tick});
  }
  private resolveEncounter(resolution:'cleansed'|'subdued'|'escaped'|'dominated',actor:CombatActor):void{
    if(this.state.rewardEmitted||this.state.combatTrial)return;
    this.state.rewardEmitted=true;
    this.clearCombatObstacles();
    if(this.state.encounter?.encounterFamily==='wildlife'){
      for(const hazard of this.state.hazards)this.queuePresentationCue({kind:'cancel',phase:'resolve',scopeId:hazard.id,cancellationReason:'interrupt'});
      this.state.hazards=[];this.state.telegraphs=this.state.telegraphs.filter(telegraph=>telegraph.sourceId===this.state.playerId);
      this.state.playerSlow=undefined;
    }
    const finalPhase=this.state.encounter?.phases[this.state.phaseIndex];
    if(finalPhase)this.emitPhaseEvent(finalPhase.id,this.state.phaseIndex,'cleared');
    const eventId=`${this.state.runId}:${this.state.encounterId}:resolved`;
    const actorIds=this.state.encounter?.actorIds.filter(id=>id!==this.state.playerId)??[actor.id];
    const event:WorldEvent={type:'encounter-resolved',eventId,idempotencyKey:eventId,encounterId:this.state.encounterId??'unknown',resolution,actorIds};
    this.emitWorldEvent(event);
    if(resolution==='cleansed'){
      const restoration:WorldEvent={type:'restoration',eventId:`${eventId}:restoration`,idempotencyKey:`${eventId}:restoration`,regionId:this.state.regionId,state:'restored',causeId:this.state.encounterId??'encounter'};
      this.emitWorldEvent(restoration);
    }
  }
  private playerIsDown():boolean{
    const player=this.playerActor();
    return !player||player.downed||this.state.player.vitality<=0;
  }
  private endPlayerCombat():void{
    this.cancelTraversal();
    this.state.pendingImpact=undefined;this.state.bufferedAction=undefined;this.state.heavyChargeStartTick=null;this.state.counterUntil=0;
    this.cancelPlayerAttackState();this.resetArsenal();
    this.state.hazards=[];this.state.telegraphs=[];this.finishAction();
    this.clearCombatObstacles();
    this.state.playerJump=undefined;
    this.state.playerSlow=undefined;
    const player=this.playerActor();
    if(player){player.downed=true;player.vitality=0;player.velocity=vec(0,0,0);player.actionEndsTick=0;player.actionId=ACTION_CLIPS.idle!;player.phase='idle';player.normalizedTime=0;}
    this.state.player.vitality=0;
  }
  /** Returns only an available local affordance; remote routes belong to CampaignDirector.travel. */
  nearestTraversal(position:Vec3):TraversalGate|undefined{
    if(this.state.traversal||this.state.timePolicy==='paused')return undefined;
    const player=this.playerActor();
    if(!player||player.downed||this.state.player.vitality<=0||this.state.tick<this.state.actionRecoveryUntil)return undefined;
    let best:TraversalGate|undefined;let nearest=Infinity;
    for(const gate of this.state.traversalGates){
      const distance=Math.hypot(position.x-gate.from.x,position.y-gate.from.y,position.z-gate.from.z);
      if(distance<nearest&&this.canTraverse(gate,player)){best=gate;nearest=distance;}
    }
    return best;
  }
  get isTraversing():boolean{return this.state.traversal!==undefined;}
  private canTraverse(gate:TraversalGate,player:CombatActor):boolean{
    const authored=gate.traversal;
    if(!authored||!gate.unlocked||gate.toRegion!==this.state.regionId||!Number.isInteger(authored.durationTicks)||authored.durationTicks<=0)return false;
    if(authored.kind==='low-ledge'){
      const ledge=authored.ledge;
      if(!ledge||ledge.riseMeters<=0||Math.abs(gate.to.y-gate.from.y-ledge.riseMeters)>1e-6||distance2(gate.from,gate.to)>ledge.maxCrossingMeters)return false;
      const face=this.state.arena.colliders.find(collider=>collider.id===ledge.faceColliderId&&gate.colliderIds.includes(collider.id));
      if(!face?.blocksMovement||face.kind!=='box'||!face.halfExtents||Math.abs(face.from.y+face.halfExtents.y-gate.to.y)>1e-6)return false;
      if(gate.to.x<face.from.x-face.halfExtents.x||gate.to.x>face.from.x+face.halfExtents.x||gate.to.z<face.from.z-face.halfExtents.z||gate.to.z>face.from.z+face.halfExtents.z)return false;
      for(const point of gate.anchors)if(point.y<gate.from.y||point.y>gate.to.y+.15||distance2(point,gate.from)>ledge.maxCrossingMeters)return false;
    }
    if(Math.hypot(player.position.x-gate.from.x,player.position.y-gate.from.y,player.position.z-gate.from.z)>authored.startRadius||Math.abs(player.position.y-gate.from.y)>.35)return false;
    if(!isSupportedCapsulePose(this.state.arena,player.position,player.radius,player.collisionHeight)||!isSupportedCapsulePose(this.state.arena,gate.from,player.radius,player.collisionHeight)||!isSupportedCapsulePose(this.state.arena,gate.to,player.radius,player.collisionHeight))return false;
    if(!isCirclePathClear(this.state.arena,player.position,gate.from,player.radius,player.collisionHeight))return false;
    const height=authored.kind==='slide' ? .65 : player.collisionHeight;
    let prior=gate.from;
    for(const point of [...gate.anchors,gate.to]){
      if(!isAerialCirclePathClear(this.state.arena,prior,point,player.radius,height))return false;
      prior=point;
    }
    return true;
  }
  private traverse(id:string):boolean{
    const gate=this.state.traversalGates.find(g=>g.id===id);const player=this.playerActor();
    if(this.state.traversal||this.state.timePolicy==='paused'||!gate||!player||player.downed||this.state.player.vitality<=0||this.state.tick<this.state.actionRecoveryUntil||!this.canTraverse(gate,player))return false;
    const points=[copy(player.position),copy(gate.from),...gate.anchors.map(copy),copy(gate.to)].filter((point,index,array)=>index===0||Math.hypot(point.x-array[index-1]!.x,point.y-array[index-1]!.y,point.z-array[index-1]!.z)>1e-6);
    const lengths=points.slice(1).map((point,index)=>Math.hypot(point.x-points[index]!.x,point.y-points[index]!.y,point.z-points[index]!.z));
    const length=lengths.reduce((total,value)=>total+value,0);if(length<=0)return false;
    this.state.traversal={gate:structuredClone(gate),points,lengths,length,segment:0,segmentDistance:0,startedAtWorldTick:this.state.worldTick,lastSafePose:copy(player.position),lastSafeFacing:copy(player.facing),standingHeight:player.collisionHeight};
    this.state.bufferedAction=undefined;this.state.pendingImpact=undefined;this.state.heavyChargeStartTick=null;this.state.counterUntil=0;
    this.cancelPlayerAttackState();
    this.state.playerJump=undefined;
    this.state.actionId='traversal';this.state.actionCancelable=false;
    player.collisionHeight=gate.traversal!.kind==='slide' ? .65 : player.collisionHeight;
    player.actionId=gate.traversalActionId;player.actionStartedTick=this.state.worldTick;player.actionEndsTick=0;player.normalizedTime=0;player.phase='anticipation';player.velocity=vec(0,0,0);
    return true;
  }
  private updateTraversal(worldScale:number):void{
    const traversal=this.state.traversal;const player=this.playerActor();if(!traversal||!player)return;
    if(player.downed||player.possessed||this.state.player.vitality<=0||player.actionId!==traversal.gate.traversalActionId){this.cancelTraversal();return;}
    const gate=this.state.traversalGates.find(candidate=>candidate.id===traversal.gate.id);
    if(!gate?.unlocked){this.cancelTraversal();return;}
    const duration=traversal.gate.traversal!.durationTicks;
    let remaining=traversal.length*worldScale/duration;
    const previous=copy(player.position);
    while(remaining>1e-8&&traversal.segment<traversal.lengths.length){
      const segmentLength=traversal.lengths[traversal.segment]!;
      const distance=Math.min(remaining,segmentLength-traversal.segmentDistance);
      const from=traversal.points[traversal.segment]!,to=traversal.points[traversal.segment+1]!;
      const ratio=Math.min(1,(traversal.segmentDistance+distance)/segmentLength);
      const point=segmentLength-traversal.segmentDistance-distance<1e-8?copy(to):vec(from.x+(to.x-from.x)*ratio,from.y+(to.y-from.y)*ratio,from.z+(to.z-from.z)*ratio);
      if(!isAerialCirclePathClear(this.state.arena,player.position,point,player.radius,player.collisionHeight)){this.cancelTraversal();return;}
      player.position=point;traversal.segmentDistance+=distance;remaining-=distance;
      if(isSupportedCapsulePose(this.state.arena,point,player.radius,traversal.standingHeight)){traversal.lastSafePose=copy(point);traversal.lastSafeFacing=copy(player.facing);}
      if(segmentLength-traversal.segmentDistance<1e-8){traversal.segment++;traversal.segmentDistance=0;}
    }
    player.velocity=scale(sub(player.position,previous),1/FIXED_STEP_SECONDS);
    if(distance2(previous,player.position)>1e-8)player.facing=facingFrom(sub(player.position,previous));
    player.normalizedTime=Math.min(1,(this.state.worldTick-traversal.startedAtWorldTick)/duration);player.phase=player.normalizedTime<.15?'anticipation':player.normalizedTime>.85?'recovery':'active';
    if(traversal.segment<traversal.lengths.length)return;
    if(!isSupportedCapsulePose(this.state.arena,player.position,player.radius,traversal.standingHeight)){this.cancelTraversal();return;}
    this.state.traversal=undefined;player.collisionHeight=traversal.standingHeight;player.velocity=vec(0,0,0);player.phase='recovery';player.normalizedTime=1;
    this.finishAction();
    this.emit('traversal',`Traversal ${traversal.gate.id} completed.`,player.id,undefined,traversal.gate.id);
  }
  private cancelTraversal():void{
    const traversal=this.state.traversal;if(!traversal)return;
    const player=this.playerActor();
    if(player){player.position=copy(traversal.lastSafePose);player.facing=copy(traversal.lastSafeFacing);player.collisionHeight=traversal.standingHeight;player.velocity=vec(0,0,0);player.actionId=ACTION_CLIPS.idle!;player.normalizedTime=0;player.phase='idle';player.actionEndsTick=0;}
    this.state.traversal=undefined;this.state.pendingImpact=undefined;this.state.bufferedAction=undefined;this.state.heavyChargeStartTick=null;
    this.state.playerJump=undefined;
    this.finishAction();
  }
  private cycleTarget(direction:-1|1):void{const candidates=this.state.actors.filter(a=>a.allegiance==='hostile'&&a.visible&&!a.downed).sort((a,b)=>distance2(this.playerActor()?.position??vec(0,0,0),a.position)-distance2(this.playerActor()?.position??vec(0,0,0),b.position));if(!candidates.length)return;let i=candidates.findIndex(a=>a.id===this.state.targetId);i=(i+direction+candidates.length)%candidates.length;const player=this.playerActor();const next=candidates[i]!;if(player&&dot(facingFrom(sub(next.position,player.position)),player.facing)<-.2)return;this.state.targetId=next.id;}
  private selectedCompanion():CombatActor|undefined{
    for(const id of [this.state.companionSlots.combat,this.state.companionSlots.utility,this.state.companionSlots.scout]){
      if(!id)continue;
      const actor=this.actorForId(id);
      if(actor?.visible&&!actor.downed&&!actor.possessed)return actor;
    }
    return undefined;
  }
  private currentBoss():CombatActor|undefined{
    const id=this.state.combatTrial?this.trials()[this.state.combatTrial.index]?.monsterId:this.state.encounter?.bossId;
    return this.state.actors.find(actor=>actor.id===id);
  }
  private playerActor():CombatActor|undefined{return this.state.actors.find(a=>a.id===this.state.playerId);}
  /** Wildlife encounters only: any source the current encounter has registered as an enemy. */
  private isWildlifeSource(actorId:ActorId):boolean{
    return this.state.encounter?.encounterFamily==='wildlife'&&this.state.encounter.actorIds.includes(actorId)&&actorId!==this.state.playerId;
  }
  /**
   * Greenwake only: the unique localized impact cue for a given attack id, or `undefined` for
   * any attack outside the Greenwake authored set. Each cue family (pounce / sap-vein / low-wave)
   * already exists in the `StoryCue` kind union and is reused as-is — no new assets, no `attackId`
   * or `footprint` fields, only the locked target position.
   */
  private wildlifeImpactKind(attackId:string):StoryCue['kind']|undefined{
    switch(attackId){
      case 'boar-charge':
      case 'boar-pounce':
        return 'pounce';
      case 'boar-sap-thrash':
      case 'sap-vein-snap':
      case 'sap-vein-thrash':
        return 'sap-vein';
      case 'root-rammer-low-wave':
      case 'root-rammer-slam':
        return 'low-wave';
      default:
        return undefined;
    }
  }
  private emit(kind:CombatEvent['kind'],message:string,actorId?:ActorId,targetId?:ActorId,actionId?:string,attackId?:AttackId,damage?:CombatEvent['damage']):void{const id=`${this.state.runId}:combat:${this.state.tick}:${++this.state.eventSequence}`;this.state.events.push({id,tick:this.state.tick,kind,message,actorId,targetId,actionId,attackId,damage});}
  private recordResolvedAction(actionId:string,targetId:ActorId):void{this.state.lastResolvedActionId=actionId;this.state.lastResolvedTargetId=targetId;this.state.lastResolvedActionTick=this.state.tick;}
  private actorForId(id:ActorId):CombatActor|undefined{
    const exact=this.state.actors.find(actor=>actor.id===id);
    if(exact)return exact;
    let match:CombatActor|undefined;
    for(const actor of this.state.actors){
      if(actor.archetypeId!==id)continue;
      if(match)return undefined;
      match=actor;
    }
    return match;
  }

  private koroAssignedToParty():boolean{return this.state.companionSlots.combat==='koro'||this.state.companionSlots.utility==='koro';}
  private hasRecentHeavyImpact(targetId:string):boolean{
    const tick=this.state.lastResolvedActionTick;
    return (this.state.lastResolvedActionId==='heavy'||this.state.lastResolvedActionId==='charged_heavy')&&this.state.lastResolvedTargetId===targetId&&tick!==undefined&&this.state.tick>=tick&&this.state.tick-tick<=12;
  }
  private canStartMovableObjectMove(object:LiveMovableObject,interaction:InteractionDefinition,actor:CombatActor):boolean{
    const definition=object.authored;
    if(object.phase!=='resting'||this.state.worldFacts[definition.movedFactId]===true||definition.requiredFacts.some(fact=>this.state.worldFacts[fact]!==true)||interaction.requiresFacts.some(fact=>this.state.worldFacts[fact]!==true))return false;
    if(interaction.regionId!==this.state.regionId||interaction.targetId!==object.objectId||interaction.success.type!=='object-move'||interaction.success.objectId!==object.objectId||distance2(object.position,definition.from)>.02)return false;
    if(!actor.visible||actor.downed||actor.possessed||distance2(actor.position,object.position)>interaction.radiusMeters)return false;
    if(interaction.requiresActors.some(id=>{const required=this.actorForId(id);return !required||!required.visible||required.downed||required.possessed;}))return false;
    const commandGate=interaction.requiresCompanionCommand;
    const koroAction=actor.archetypeId===definition.requiredCompanionId&&definition.requiredCompanionId==='koro'&&interaction.id===definition.koroInteractionId&&this.state.companionSlots.utility==='koro'&&commandGate?.companionId==='koro'&&commandGate.slot==='utility'&&commandGate.command==='special';
    const playerAction=actor.id===this.state.playerId&&interaction.id===definition.playerInteractionId&&interaction.playerActionId==='staff-heavy'&&!this.koroAssignedToParty()&&this.hasRecentHeavyImpact(object.objectId);
    return (koroAction||playerAction)&&this.movableObjectPathClear(object,actor.id);
  }
  private movableObjectPathClear(object:LiveMovableObject,initiatorId:ActorId):boolean{
    const definition=object.authored;
    const surface=this.state.arena.surfaces.find(candidate=>candidate.id===definition.supportSurfaceId&&candidate.walkable);
    if(!surface||!pointInPolygonXZ(definition.from,surface.points)||!pointInPolygonXZ(definition.to,surface.points))return false;
    let previous=copy(definition.from);
    for(let index=1;index<=definition.animationTicks;index++){
      const progress=index/definition.animationTicks;
      const desired=vec(definition.from.x+(definition.to.x-definition.from.x)*progress,definition.from.y+(definition.to.y-definition.from.y)*progress,definition.from.z+(definition.to.z-definition.from.z)*progress);
      const swept=moveCircle(this.state.arena,previous,sub(desired,previous),definition.radiusMeters,.3);
      if(distance2(swept,desired)>.02||Math.abs(swept.y-desired.y)>.12||!pointInPolygonXZ(swept,surface.points)||this.movableObjectOccupied(object,swept,initiatorId))return false;
      previous=swept;
    }
    return true;
  }
  private movableObjectOccupied(object:LiveMovableObject,position:Vec3,initiatorId:ActorId):boolean{
    const definition=object.authored;
    for(const actor of this.state.actors){
      if(!actor.visible||actor.id===initiatorId||actor.id===definition.effect.targetActorInstanceId||distance2(actor.position,definition.from)<=definition.radiusMeters)continue;
      if(distance2(actor.position,position)<definition.radiusMeters+actor.radius)return true;
    }
    return false;
  }
  private startMovableObjectMove(object:LiveMovableObject,interaction:InteractionDefinition,actor:CombatActor):boolean{
    object.phase='in-flight';object.position=copy(object.authored.from);object.startedAtWorldTick=this.state.worldTick;object.interactionId=interaction.id;object.actorId=actor.id;
    return true;
  }
  private updateMovableObjects():void{
    for(const object of this.state.movableObjects){
      if(object.phase!=='in-flight')continue;
      const definition=object.authored;
      const startedAtWorldTick=object.startedAtWorldTick;
      const actorId=object.actorId;
      if(startedAtWorldTick===undefined||actorId===undefined||!object.interactionId){object.phase='resting';object.position=copy(definition.from);delete object.startedAtWorldTick;delete object.actorId;delete object.interactionId;continue;}
      const progress=Math.min(1,(this.state.worldTick-startedAtWorldTick)/definition.animationTicks);
      const desired=vec(definition.from.x+(definition.to.x-definition.from.x)*progress,definition.from.y+(definition.to.y-definition.from.y)*progress,definition.from.z+(definition.to.z-definition.from.z)*progress);
      const surface=this.state.arena.surfaces.find(candidate=>candidate.id===definition.supportSurfaceId&&candidate.walkable);
      const swept=moveCircle(this.state.arena,object.position,sub(desired,object.position),definition.radiusMeters,.3);
      if(!surface||distance2(swept,desired)>.02||Math.abs(swept.y-desired.y)>.12||!pointInPolygonXZ(swept,surface.points)||this.movableObjectOccupied(object,swept,actorId)){
        object.phase='resting';object.position=copy(definition.from);delete object.startedAtWorldTick;delete object.actorId;delete object.interactionId;continue;
      }
      object.position=progress>=1?copy(definition.to):copy(swept);
      if(progress<1)continue;
      object.phase='settled';
      const target=this.state.actors.find(candidate=>candidate.id===definition.effect.targetActorInstanceId&&candidate.visible&&!candidate.downed&&!candidate.possessed);
      const telegraphIndex=target&&distance2(target.position,object.position)<=definition.effect.radiusMeters?this.state.telegraphs.findIndex(candidate=>candidate.sourceId===target.id&&candidate.phase==='windup'):-1;
      if(telegraphIndex>=0&&target){
        const telegraph=this.state.telegraphs[telegraphIndex]!;
        this.queuePresentationCue({kind:'cancel',phase:'resolve',scopeId:telegraph.id,cancellationReason:'interrupt'});
        this.state.telegraphs.splice(telegraphIndex,1);
        const hazardIndex=this.state.hazards.findIndex(candidate=>candidate.id===telegraph.id);
        if(hazardIndex>=0)this.state.hazards.splice(hazardIndex,1);
        this.state.counterUntil=this.state.tick+definition.effect.interruptRangedWindupTicks;
        target.staggerUntil=this.state.worldTick+definition.effect.interruptRangedWindupTicks;
        this.emit('attack-interrupted','The thrown snare distracts the ranged hunter and opens a counter.',actorId,target.id,'object-distraction',telegraph.attackId);
      }
      const eventId=this.state.runId+':object-moved:'+object.objectId;
      this.emitWorldEvent({type:'object-moved',eventId,idempotencyKey:eventId,regionId:this.state.regionId,objectId:object.objectId,interactionId:object.interactionId,actorId,from:copy(definition.from),to:copy(definition.to)});
    }
  }

  private interactionTargetActor(interaction:InteractionDefinition,targetId:string):CombatActor|undefined{
    const actor=this.actorForId(targetId as ActorId);
    return actor&&(actor.id===interaction.targetId||actor.archetypeId===interaction.targetId)&&actor.visible?actor:undefined;
  }
  private interactionTargetIdMatches(interaction:InteractionDefinition,targetId?:ActorId):boolean{
    if(targetId===interaction.targetId)return true;
    return targetId!==undefined&&this.actorForId(targetId)?.archetypeId===interaction.targetId;
  }
  private interactionMechanicSatisfied(interaction:InteractionDefinition,target?:CombatActor):boolean{
    if(this.state.worldFacts[`${interaction.id}:solved`]===true)return true;
    if(interaction.actionId==='contextual-interact'){
      if(interaction.kind==='inspect')return true;
      const success=interaction.success;
      if(interaction.kind==='choose'&&success.type==='choice')return true;
      if(success.type==='rescue'){
        if(success.targetId==='tali')return target?.archetypeId==='tali'&&this.isTaliSafe(target.position);
        const rescueTarget=this.actorForId(success.targetId as ActorId);
        return this.state.worldFacts[interaction.id+':freed']===true||!!rescueTarget?.downed;
      }
      if(success.type==='semantic-interaction'&&success.kind==='signal')return this.state.regionId===interaction.regionId&&interaction.requiresActors.some(id=>{const required=this.actorForId(id);return !!required&&required.visible&&!required.downed&&!required.possessed;});
      return false;
    }
    const tick=this.state.lastResolvedActionTick;
    if(tick===undefined||this.state.tick-tick<0||this.state.tick-tick>12||!this.interactionTargetIdMatches(interaction,this.state.lastResolvedTargetId))return false;
    if(interaction.actionId==='cleanse-pulse'){
      if(this.state.lastResolvedActionId!=='cleanse')return false;
      if(interaction.success.type==='restoration')return true;
      return (target?.corruption??1)<=0;
    }
    if(interaction.actionId==='staff-heavy')return this.state.lastResolvedActionId==='heavy'||this.state.lastResolvedActionId==='charged_heavy';
    return false;
  }
  private interactionEventId(interaction:InteractionDefinition):string{return `${this.state.runId}:interaction:${interaction.id}${interaction.repeatable?`:${this.state.tick}`:''}`;}
  private emitWorldEvent(worldEvent:WorldEvent):boolean{
    if(this.state.seenWorldKeys.includes(worldEvent.idempotencyKey))return false;
    this.state.seenWorldKeys.push(worldEvent.idempotencyKey);
    this.state.events.push({id:worldEvent.eventId,tick:this.state.tick,kind:'world',message:`World event: ${worldEvent.type}.`,worldEvent});
    this.state.worldEvents.push(structuredClone(worldEvent));
    return true;
  }
  private isTaliSafe(position:Vec3):boolean{
    const campDisable=INTERACTIONS.find(interaction=>interaction.id==='camp-disable');
    if(!campDisable||this.state.worldFacts.taliInBamboo!==true)return false;
    const disabled=this.state.seenWorldKeys.includes(this.interactionEventId(campDisable))||this.state.worldFacts['interaction:camp-disable']===true;
    const hostileHunters=this.state.actors.some(actor=>(actor.archetypeId==='poacher-hunter'||actor.archetypeId==='poacher-scout')&&actor.allegiance==='hostile'&&!actor.downed);
    return disabled&&!hostileHunters&&!this.hasActiveThreatNear(position);
  }
  private hasActiveThreatNear(position:Vec3):boolean{
    const player=this.playerActor();
    const probe=player?{...player,position}:makeActor('aren','human','player',position,false,false,100);
    return this.state.hazards.some(hazard=>this.state.worldTick<hazard.activeUntil&&hazardThreatens(hazard,probe))||this.state.telegraphs.some(telegraph=>(telegraph.phase==='windup'||telegraph.phase==='commit')&&distance2(position,telegraph.targetPosition)<=Math.max(ATTACKS[telegraph.attackId]?.hazard.width??0,ATTACKS[telegraph.attackId]?.hazard.depth??0)/2+1);
  }
  private finishAction():void{this.state.actionId='idle';this.state.actionUntil=this.state.tick;this.state.actionRecoveryUntil=0;this.state.actionCancelable=false;this.state.kitCancel=undefined;}
  private commandCompanionForInput(targetId:ActorId|undefined,command:CompanionCommand):boolean{const actor=this.state.companionSlots.combat??this.state.companionSlots.utility;if(!actor)return false;return this.commandCompanion(actor,command,targetId);}
  private breakPossession(actor:CombatActor,escaped=false):void{
    const instance=actor.possessionInstanceId;
    const source=actor.possessionSourceId;
    if(actor.possessed&&instance&&this.state.encounterId){
      const phaseId=this.state.encounter?.phases[this.state.phaseIndex]?.id??'unknown';
      const state=escaped?'escaped':'broken';
      const eventId=`${this.state.runId}:${this.state.encounterId}:possession:${instance}:${state}`;
      this.emitWorldEvent({type:'possession',eventId,idempotencyKey:eventId,actorId:source??('orun' as ActorId),targetId:actor.id,phaseId,state,simulationTick:this.state.tick});
    }
    actor.possessed=false;actor.allegiance='ally';actor.possessedUntil=0;actor.possessionInstanceId=undefined;actor.possessionSourceId=undefined;actor.staggerUntil=this.state.worldTick+24;
    this.emit('attack-interrupted',escaped?'Orun’s hold releases the companion; they escape unharmed.':'Orun’s hold breaks. Your companion is safe.',actor.id,source??('orun' as ActorId),'possession-break');
  }
  private enforceCaps():void{
    const hostiles=this.state.actors.filter(actor=>actor.allegiance==='hostile');
    const large=this.state.actors.filter(actor=>actor.large);
    const groundedLarge=large.filter(actor=>!actor.aerial);
    const aerialLarge=large.filter(actor=>actor.aerial);
    const trialRegion=combatTrialSetFor(this.state.regionId)!==undefined;
    const maxLarge=trialRegion?MAX_TRIAL_REGION_LARGE:MAX_TOTAL_LARGE;
    const maxGroundedLarge=trialRegion?MAX_TRIAL_REGION_LARGE:MAX_GROUNDED_LARGE;
    if(hostiles.length>MAX_HOSTILES)throw new Error(`Encounter exceeds ${MAX_HOSTILES} hostile actors.`);
    if(large.length>maxLarge)throw new Error(`Encounter exceeds ${maxLarge} total large actors.`);
    if(groundedLarge.length>maxGroundedLarge)throw new Error(`Encounter exceeds ${maxGroundedLarge} grounded large actors.`);
    if(aerialLarge.length>1)throw new Error('Encounter exceeds one aerial large actor.');
  }
}

export function createEngineState():EngineState{
  const player=makeActor('aren','human','player',vec(0,0,0),false,false,100);
  return {
    schemaVersion:3,tick:0,worldTick:0,worldTimeScale:1,timePolicy:'normal',slowMotionRemainingTicks:0,slowMotionElapsedTicks:0,accumulator:0,regionId:'greenwake',runId:'unstarted',encounter:null,worldFacts:{},
    actors:[player],playerId:'aren',heroId:'aren',player:{vitality:PLAYER_MAX_VITALITY,maxVitality:PLAYER_MAX_VITALITY,instinct:0,mana:MAX_MANA,maxMana:MAX_MANA},
    movableObjects:[],
    sceneColliders:[],combatObstacles:[],
    arena:{bounds:{min:vec(-12,0,-12),max:vec(12,12,12)},groundY:0,surfaces:[],colliders:[],routes:[],obstacles:[],cameraBasis:{forward:vec(0,0,-1),right:vec(1,0,0)},traversalAffordances:[]},
    hazards:[],telegraphs:[],events:[],worldEvents:[],seenWorldKeys:[],perfectDodgeKeys:[],phaseIndex:0,phaseLatch:0,phaseActionFlags:[],
    actionId:'idle',actionUntil:0,actionRecoveryUntil:0,actionCancelable:false,counterUntil:0,lastAttackTick:0,attackSelectionWorldOffset:0,heavyChargeStartTick:null,
    companionState:createCompanionState({}),companionSlots:{},eventSequence:0,rewardEmitted:false,checkpoint:null,traversalGates:[],presentationCues:[],
    playerProjectiles:[],judgementMarks:[],arsenalSequence:0,kit:{},
  };
}
export function hydrateEngineState(seed:EngineStateSeed):EngineState{
  const base=createEngineState();const state={...base,...structuredClone(seed)} as EngineState;
  const legacy=seed.schemaVersion===1||seed.worldTick===undefined;
  // Versionless states with an explicit world clock follow the v2 timestamp convention.
  const legacyPlayerActionClock=seed.worldTick!==undefined&&(seed.schemaVersion===2||seed.schemaVersion===undefined);
  state.schemaVersion=3;
  state.worldTick=legacy?seed.tick??base.tick:seed.worldTick??base.worldTick;
  state.timePolicy=legacy?'normal':seed.timePolicy??base.timePolicy;
  state.slowMotionRemainingTicks=legacy?0:seed.slowMotionRemainingTicks??base.slowMotionRemainingTicks;
  state.slowMotionElapsedTicks=legacy?0:seed.slowMotionElapsedTicks??0;
  state.attackSelectionWorldOffset=legacy?0:seed.attackSelectionWorldOffset??0;
  if(state.timePolicy==='perfect-dodge-slow'&&state.slowMotionRemainingTicks<=0)state.timePolicy='normal';
  state.playerProjectiles=seed.playerProjectiles??[];
  state.judgementMarks=seed.judgementMarks??[];
  state.arsenalSequence=seed.arsenalSequence??0;
  if(state.hitStop&&!(state.hitStop.remainingTicks>0))state.hitStop=undefined;
  state.worldTimeScale=state.timePolicy==='paused'||state.hitStop?0:state.timePolicy==='perfect-dodge-slow'?PERFECT_DODGE_EFFECTS.worldTimeScale:1;
  state.actors=(seed.actors??base.actors).map(cloneActor);
  state.player=hydratePlayerResources(seed.player);
  state.arena={...base.arena,...seed.arena};
  state.sceneColliders=structuredClone(seed.sceneColliders??[]);
  state.combatObstacles=structuredClone(seed.combatObstacles??[]);
  state.hazards=seed.hazards??[];
  state.telegraphs=seed.telegraphs??[];
  state.events=seed.events??[];
  state.worldEvents=seed.worldEvents??[];
  state.worldFacts=seed.worldFacts??{};
  state.seenWorldKeys=seed.seenWorldKeys??[];
  state.perfectDodgeKeys=seed.perfectDodgeKeys??[];
  state.phaseActionFlags=seed.phaseActionFlags??[];
  state.presentationCues=(seed.presentationCues??[]).map(cue=>({...cue,worldTick:cue.worldTick??(cue.worldTimeSeconds===undefined?cue.tick:cue.worldTimeSeconds*60),worldTimeSeconds:cue.worldTimeSeconds??cue.tick/60}));
  state.movableObjects=(seed.movableObjects??[]).map(object=>{
    const migrated={...object};
    if(migrated.startedAtWorldTick===undefined&&'startedAtTick' in migrated)migrated.startedAtWorldTick=(migrated as typeof migrated & {startedAtTick:number}).startedAtTick;
    delete (migrated as typeof migrated & {startedAtTick?:number}).startedAtTick;
    return migrated;
  });
  if(state.checkpoint){
    state.checkpoint.player=hydratePlayerResources(state.checkpoint.player);
    state.checkpoint.worldTick=state.checkpoint.worldTick??state.checkpoint.tick;
    state.checkpoint.lastAttackTick=state.checkpoint.lastAttackTick??state.checkpoint.tick;
    state.checkpoint.counterUntil=state.checkpoint.counterUntil??0;
  }
  if(legacyPlayerActionClock){
    migrateLegacyPlayerActionClock(state.actors,state.playerId,state.tick);
    if(state.checkpoint)migrateLegacyPlayerActionClock(state.checkpoint.actors,state.playerId,state.checkpoint.tick);
  }
  return state;
}
function migrateLegacyPlayerActionClock(actors:readonly CombatActor[],playerId:ActorId,simulationTick:number):void{
  for(const actor of actors){
    if(actor.id!==playerId||actor.actionEndsTick<=0)continue;
    // Preserve the saved sample, not elapsed world time: v2 normalizedTime was accumulated independently.
    const duration=Math.max(1,actor.actionEndsTick-actor.actionStartedTick);
    const progress=Number.isFinite(actor.normalizedTime)?Math.min(1,Math.max(0,actor.normalizedTime)):0;
    actor.actionStartedTick=simulationTick-progress*duration;
    actor.actionEndsTick=actor.actionStartedTick+duration;
  }
}
export function makeActor(id:ActorId,species:string,allegiance:CombatActor['allegiance'],position:Vec3,large:boolean,aerial:boolean,vitality:number,archetypeId:ActorId=id):CombatActor{
  const idle=ACTION_CLIPS[`${archetypeId}-idle`]??ACTION_CLIPS['actor-idle']!;
  const collisionHeight=large?2.4:aerial?0.8:species==='macaque'?1:1.6;
  return {id,archetypeId,species,allegiance,position:copy(position),velocity:vec(0,0,0),facing:vec(0,0,-1),actionId:(id==='aren'?ACTION_CLIPS.idle:idle) as ActionId,phase:'idle',normalizedTime:0,vitality,ferocity:id==='aren'||species==='human'?undefined:100,corruption:undefined,targetId:undefined,sockets:{root:copy(position),head:vec(position.x,position.y+1.5,position.z)},interactionRequirements:[],visible:true,downed:false,possessed:false,radius:large?1.1:.42,collisionHeight,maxVitality:vitality,large,aerial,corruptionCoreIds:undefined,cleansedCoreIds:[],recoveringUntil:0,invulnerableUntil:0,staggerUntil:0,possessedUntil:0,actionStartedTick:0,actionEndsTick:0};
}
function cloneActor(a:CombatActor):CombatActor{return structuredClone(a);}
function copy(v:Vec3):Vec3{return{x:v.x,y:v.y,z:v.z};}
function pointInPolygonXZ(point:Vec3,points:readonly Vec3[]):boolean{
  if(points.length<3)return false;
  let inside=false;
  for(let i=0,j=points.length-1;i<points.length;j=i++){
    const a=points[i]!,b=points[j]!;
    if((a.z>point.z)!==(b.z>point.z)&&point.x<(b.x-a.x)*(point.z-a.z)/(b.z-a.z)+a.x)inside=!inside;
  }
  return inside;
}
function sub(a:Vec3,b:Vec3):Vec3{return{x:a.x-b.x,y:a.y-b.y,z:a.z-b.z};}
function scale(v:Vec3,s:number):Vec3{return{x:v.x*s,y:v.y*s,z:v.z*s};}
function dot(a:Vec3,b:Vec3):number{return a.x*b.x+a.y*b.y+a.z*b.z;}
function resolveProfile(direction:EvasionDirection,affordances:readonly {kind:string;bounds:Rect}[],position:Vec3,hazards:readonly LiveHazard[],worldTick:number):EvasionProfile{
  const nearby=hazards.find(h=>worldTick<h.activeUntil&&distance2(position,h.origin)<4.5);
  if(nearby?.kind==='wave'&&affordances.some(a=>a.kind==='staff-vault'&&pointInRect(position,a.bounds)))return EVASION_PROFILES.staff_vault;
  if(nearby?.kind==='sweep'&&affordances.some(a=>a.kind==='low-slide'&&pointInRect(position,a.bounds)))return EVASION_PROFILES.low_slide;
  if(direction==='forward-left')return EVASION_PROFILES.forward_left_dive_roll;
  if(direction==='forward-right')return EVASION_PROFILES.forward_right_dive_roll;
  if(direction==='back-left')return EVASION_PROFILES.back_left_pivot_roll;
  if(direction==='back-right')return EVASION_PROFILES.back_right_pivot_roll;
  if(nearby?.kind==='sweep'&&nearby.depth>nearby.width*1.4&&direction==='left')return EVASION_PROFILES.left_cartwheel;
  if(nearby?.kind==='sweep'&&nearby.depth>nearby.width*1.4&&direction==='right')return EVASION_PROFILES.right_cartwheel;
  if(direction==='left')return EVASION_PROFILES.quick_step_left;
  if(direction==='right')return EVASION_PROFILES.quick_step_right;
  return direction==='forward'?EVASION_PROFILES.forward_shoulder_roll:EVASION_PROFILES.back_handspring;
}
function shiftDeadline(deadline:number,offset:number):number{return deadline===0?0:deadline+offset;}
function pointInRect(p:Vec3,r:Rect):boolean{return p.x>=r.minX&&p.x<=r.maxX&&p.z>=r.minZ&&p.z<=r.maxZ;}
function profileVector(id:EvasionProfileId,direction:EvasionDirection,facing:Vec3,basis?:CameraBasis):Vec3{
  const right=basis?.right??vec(facing.z,0,-facing.x);
  const side=direction.includes('left')?-1:direction.includes('right')?1:0;
  const forward=direction.startsWith('forward')?1:direction.startsWith('back')?-1:0;
  if(id==='back_handspring')return scale(facing,-1);
  if(id==='forward_shoulder_roll'||id==='perfect_dodge_left'||id==='perfect_dodge_right'||id==='dodge_recovery'||id==='hard_landing'||id==='stumble_recovery')return id==='forward_shoulder_roll'?facing:vec(0,0,0);
  return normalize(add(scale(right,side),scale(facing,forward)));
}
function normalize(v:Vec3):Vec3{const n=Math.hypot(v.x,v.z)||1;return{x:v.x/n,y:0,z:v.z/n};}
function normalize3(v:Vec3):Vec3{const n=Math.hypot(v.x,v.y,v.z)||1;return{x:v.x/n,y:v.y/n,z:v.z/n};}
/** Smooth distance progress with zero velocity at both action boundaries. */
function evasionDistanceProgress(t:number):number{
  const u=Math.max(0,Math.min(1,t));
  return u*u*(3-2*u);
}
function jumpPosition(from:Vec3,to:Vec3,elapsed:number,flightTicks:number,apex:number):Vec3{
  const u=Math.max(0,Math.min(1,elapsed/flightTicks));
  return vec(from.x+(to.x-from.x)*u,from.y+(to.y-from.y)*u+4*apex*u*(1-u),from.z+(to.z-from.z)*u);
}
function add(a:Vec3,b:Vec3):Vec3{return{x:a.x+b.x,y:a.y+b.y,z:a.z+b.z};}
function hazardThreatens(h:LiveHazard,a:CombatActor):boolean{
  const bodyTop=a.position.y+a.collisionHeight;
  const groundY=ATTACKS[h.attackId]?.element?h.target.y:h.origin.y;
  const hazardBottom=groundY-.15;
  const hazardTop=groundY+Math.max(.15,h.heightAboveGround);
  if(bodyTop<hazardBottom||a.position.y>hazardTop)return false;
  if(h.kind==='strike'||h.kind==='projectile')return Math.abs(a.position.y-h.target.y)<=Math.max(.8,h.heightAboveGround)+a.radius&&distance2(a.position,h.target)<=h.radius+a.radius;
  if(h.kind==='cone')return pointInSector(a.position,h.origin,h.direction,h.range??h.depth,h.angleDeg??70);
  const dx=a.position.x-h.target.x;
  const dz=a.position.z-h.target.z;
  if(h.kind==='sweep'||h.kind==='wave'){
    const forward=dx*h.direction.x+dz*h.direction.z;
    const side=dx*-h.direction.z+dz*h.direction.x;
    return Math.abs(forward)<=h.depth/2+a.radius&&Math.abs(side)<=h.width/2+a.radius;
  }
  return Math.abs(dx)<=h.width/2+a.radius&&Math.abs(dz)<=h.depth/2+a.radius;
}
function avoids(id:EvasionProfileId,h:LiveHazard):boolean{
  const profile=EVASION_PROFILES[id];
  if(!profile)return false;
  if(h.kind==='wave')return id==='staff_vault';
  if(h.kind==='area'||h.kind==='cone')return false;
  if(h.kind==='sweep'&&id==='low_slide')return h.heightAboveGround>=.7;
  if(id==='staff_vault')return h.kind==='sweep';
  return profile.iframes>0||profile.verticalClearance>h.heightAboveGround;
}
function storyShape(kind:HazardDefinition['kind']):NonNullable<StoryCue['shape']>{
  switch(kind){
    case 'area':return 'ring';
    case 'cone':return 'sector';
    case 'sweep':return 'arc';
    case 'wave':return 'wave';
    case 'strike':case 'projectile':return 'burst';
  }
}
function isLargeSpecies(species:string):boolean{return species==='tiger'||species==='lion'||species==='boar'||species==='crocodile';}
function hazardPresentation(h:LiveHazard):Pick<StoryCue,'position'|'from'|'to'|'footprint'|'shape'>{
  const cone=h.kind==='cone',disk=h.kind==='strike'||h.kind==='projectile';
  const radius=h.range??h.depth;
  return {position:copy(cone?h.origin:h.target),from:copy(h.origin),to:copy(h.target),shape:storyShape(h.kind),footprint:{width:disk?2*h.radius:h.width,length:cone?2*radius:disk?2*h.radius:h.depth,angleRadians:h.kind==='area'?0:Math.atan2(h.direction.x,h.direction.z),...(cone?{sectorRadians:(h.angleDeg??70)*Math.PI/180}:{})}};
}

function attackName(id:string):string{
  return id.replace(/^(?:boar|sap-stalker|sap-vein|root-rammer|howler|hornbill|viper|sprig|frostfang|howl-scout|chained-ruun|bog-lurker|lantern-heron|mire-maw|koro|asha|ruun|ghor|solkar|orun|poacher-hunter-east|poacher-hunter|poacher-scout)-/,'').replaceAll('-',' ');
}

function hydratePlayerResources(saved?:Partial<PlayerResources>):PlayerResources{
  return {vitality:saved?.vitality??PLAYER_MAX_VITALITY,maxVitality:saved?.maxVitality??PLAYER_MAX_VITALITY,instinct:saved?.instinct??0,mana:saved?.mana??MAX_MANA,maxMana:saved?.maxMana??MAX_MANA};
}
