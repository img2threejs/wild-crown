import type { ActionId, ActorSnapshot, AssetManifestEntry } from '../game/contracts';
import { MONSTER_HOVER, resolveMonsterAnimation, type MonsterAnimationSample } from './MonsterAnimationProfiles';
import type { NativeAssetInstance } from './NativeAssetLoader';

const LOCOMOTION_RECOVERY_ACTIONS: Readonly<Record<string, true>> = {
  'aren-jump': true, 'aren-forward-left-dive-roll': true, 'aren-forward-right-dive-roll': true,
  'aren-perfect-dodge-left': true, 'aren-perfect-dodge-right': true,
  // Dash and blink skills end upright and moving: their tails flow into run or idle with no pose gap.
  'vesper-iai-4': true, 'vesper-shadow-step': true, 'vesper-shade-swap': true, 'vesper-severing-shadow': true, 'vesper-mist-blink': true,
  'sakda-resonating-strike': true, 'sakda-flying-knee': true, 'sakda-hundred-elbows': true, 'sakda-iron-clinch': true, 'sakda-guard-dash': true,
};
/** Held poses the simulation reports as an action but the clip plays as a seamless loop on the actor clock (the controller loops the 'idle' phase). */
const LOOPING_ACTIONS: Readonly<Record<string, true>> = {
  'aren-sigil-charge': true, 'yara-seed-charge': true, 'yara-root-charge': true,
  'vesper-cuts-charge': true, 'vesper-shade-charge': true, 'sakda-knee-charge': true, 'sakda-elbow-charge': true,
};
/** Default ground speed (m/s) above which a recovering actor blends into the run loop instead of walk (Aren's walk speed); heroes override per context. */
const RUN_SPEED = 4.1;
/** Normalized finite-action progress where the locomotion loop starts to take over (smoothstep to 1 at the end). */
const RECOVERY_START = 0.7;
/** Ground speed range (m/s) over which a moving actor weighs the locomotion loop in; a standing actor settles into idle instead. */
const RECOVERY_SPEED_MIN = 0.5, RECOVERY_SPEED_FULL = 2.5;

/** Presentation-only hit reaction on Aren: lasts at most this long and never gates locomotion or actions. */
export const HIT_OVERLAY_SECONDS = 0.35;
const HIT_OVERLAY_ACTION = 'aren-hit';
const HIT_OVERLAY_PEAK_SHARE = 0.6;
const HIT_OVERLAY_ATTACK_SECONDS = 0.05;

interface DriverState {
  lastVitality: number | undefined;
  hitStartedAt: number | undefined;
  overlayActive: boolean;
  /** Locomotion loop chosen when the current finite action's recovery began (no walk/run flicker mid-blend). */
  recoveryActionId: ActionId | undefined;
}
const states = new WeakMap<NativeAssetInstance, DriverState>();

export interface ActorAnimationContext {
  /** True when the rendered pose interpolates between two snapshots of the same visible actor. */
  readonly interpolate: boolean;
  readonly alpha: number;
  /** Authoritative actor clock in seconds used for looping cadence. */
  readonly loopTimeSeconds: number | undefined;
  readonly manifest: AssetManifestEntry | undefined;
  /**
   * Authoritative vitality of the driven actor. Aren's damage lives in `CombatSnapshot.player.vitality`
   * (her ActorSnapshot does not change), so the renderer supplies it here; other actors fall back to `ActorSnapshot.vitality`.
   */
  readonly vitality?: number;
  /** Walk speed (m/s) of the driven hero; faster ground speed blends the tail of a dash into run, otherwise walk. */
  readonly walkSpeed?: number;
}

const smoothstep = (t: number): number => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };

/** Crossfade for monster attack hand-offs and same-slot clip restarts (brief: 0.1–0.15 s). */
export const MONSTER_BLEND_SECONDS = 0.12;
const AIR_STEP_ACTION = 'aren-air-step';
/** Normalized `aren-air-step` time at the start of each jump phase: rising 0→0.50, falling 0.50→0.82, landing 0.82→1. */
const AIR_STEP_PHASE_START = { rising: 0, falling: 0.5, landing: 0.82 } as const;
const AIR_STEP_PHASE_SPAN = { rising: 0.5, falling: 0.32, landing: 0.18 } as const;
/** Presentation-only hop height (m) for the authored airborne segment of a `monster-jump` attack, by native asset id. */
const MONSTER_HOP_HEIGHT: Readonly<Record<string, number>> = {
  'actor-ember-boar': 0.3, 'actor-frost-sap-stalker': 0.32, 'actor-root-rammer': 0.38, 'actor-thornback-howler': 0.3,
  'actor-howl-scout': 0.34, 'actor-ruun-chained-howl': 0.42, 'actor-bog-lurker': 0.26, 'actor-ghor-mire-maw': 0.5,
};
const HOP_FALLBACK_PER_SCALE = 0.1, HOP_FALLBACK_MIN = 0.15, HOP_FALLBACK_MAX = 0.45;

/**
 * Vertical offset (m) over the jump clip's authored airborne segment (0.3–0.7), not over the damaging phase.
 * Slam clips land as active contact begins; restarting a hop during active would lift the body away from its impact. Hovering avians keep their own flight curve.
 */
export function monsterHopHeight(actor: ActorSnapshot, assetId: string, sample: Pick<MonsterAnimationSample, 'actionId' | 'normalizedTime'> | undefined, manifest?: AssetManifestEntry): number {
  if (sample?.actionId !== 'monster-jump' || (actor.attackPhase !== 'commit' && actor.attackPhase !== 'active') || MONSTER_HOVER[assetId] || actor.downed) return 0;
  const time = sample.normalizedTime;
  if (time <= 0.3 || time >= 0.7) return 0;
  const height = MONSTER_HOP_HEIGHT[assetId]
    ?? Math.max(HOP_FALLBACK_MIN, Math.min(HOP_FALLBACK_MAX, (manifest?.coordinateTransform?.scale ?? 2) * HOP_FALLBACK_PER_SCALE));
  return height * Math.sin(Math.PI * (time - 0.3) / 0.4);
}

/** Presentation-only: selects and samples the native clip for one actor snapshot. Returns the drawn vertical hop offset (m) to add to the root. */
export function driveActorAnimation(instance: NativeAssetInstance, actor: ActorSnapshot, previous: ActorSnapshot | undefined, context: ActorAnimationContext): number {
  const { interpolate, alpha, loopTimeSeconds, manifest } = context;
  if (actor.allegiance !== 'player') {
    const sample = resolveMonsterAnimation(actor, instance.assetId);
    if (sample) {
      instance.animation.setBlendSeconds(MONSTER_BLEND_SECONDS);
      instance.animation.play(sample.actionId, sample.phase, sample.normalizedTime, loopTimeSeconds, sample.loopRate);
      return monsterHopHeight(actor, instance.assetId, sample, manifest);
    }
  }
  let state = states.get(instance);
  if (!state) states.set(instance, state = { lastVitality: undefined, hitStartedAt: undefined, overlayActive: false, recoveryActionId: undefined });
  if (actor.id === 'aren') driveHitOverlay(instance, actor, state, loopTimeSeconds, context.vitality ?? actor.vitality);
  let normalizedTime = interpolate && previous && previous.actionId === actor.actionId && previous.normalizedTime <= actor.normalizedTime
    ? previous.normalizedTime + (actor.normalizedTime - previous.normalizedTime) * alpha : actor.normalizedTime;
  // Second (boosted) jump: the dedicated in-place air-step clip, by jump phase; otherwise the standard jump mapping.
  const airStep = actor.actionId === 'aren-jump' && actor.jumpBoosted === true && instance.animation.hasAction(AIR_STEP_ACTION);
  let clipActionId: ActionId | string = actor.actionId;
  if (actor.actionId === 'aren-jump' && actor.jumpPhase) {
    let progress = actor.jumpPhaseProgress ?? 0;
    if (interpolate && previous?.jumpPhase === actor.jumpPhase && previous.jumpBoosted === actor.jumpBoosted && (previous.jumpPhaseProgress ?? 0) <= progress) progress = (previous.jumpPhaseProgress ?? 0) + (progress - (previous.jumpPhaseProgress ?? 0)) * alpha;
    if (airStep) {
      clipActionId = AIR_STEP_ACTION;
      normalizedTime = actor.jumpPhase === 'takeoff' ? 0
        : AIR_STEP_PHASE_START[actor.jumpPhase] + AIR_STEP_PHASE_SPAN[actor.jumpPhase] * Math.max(0, Math.min(1, progress));
    } else {
      // Keep native knees/arms airborne until simulation landing, including a second upward kick.
      normalizedTime = actor.jumpPhase === 'takeoff' ? progress * .24
        : actor.jumpPhase === 'rising' ? .24 + progress * .2
        : actor.jumpPhase === 'falling' ? .44 + progress * .24
        : .68 + progress * .32;
    }
  } else if (airStep) clipActionId = AIR_STEP_ACTION;
  const speed = Math.hypot(actor.velocity.x, actor.velocity.z);
  // Native airborne poses follow jump phases; the upright recovery tail blends into
  // the locomotion loop so run→jump/Dive→run has no pose gap.
  let recoveryWeight = 0;
  if (actor.phase === 'recovery' && LOCOMOTION_RECOVERY_ACTIONS[String(actor.actionId)]) {
    recoveryWeight = smoothstep((normalizedTime - RECOVERY_START) / (1 - RECOVERY_START)) * smoothstep((speed - RECOVERY_SPEED_MIN) / (RECOVERY_SPEED_FULL - RECOVERY_SPEED_MIN));
    if (recoveryWeight > 0 && state.recoveryActionId === undefined) state.recoveryActionId = (speed > (context.walkSpeed === undefined ? RUN_SPEED : context.walkSpeed + 0.05) ? 'aren-run' : 'aren-walk') as ActionId;
  } else state.recoveryActionId = undefined;
  const recoveryActionId = recoveryWeight > 0 ? state.recoveryActionId : undefined;
  const loopPlaybackRate = nativeLocomotionPlaybackRate(instance, manifest, recoveryActionId ?? actor.actionId, actor.velocity);
  instance.animation.play(clipActionId, LOOPING_ACTIONS[String(actor.actionId)] ? 'idle' : actor.phase, normalizedTime, loopTimeSeconds, loopPlaybackRate, recoveryActionId, recoveryWeight);
  return 0;
}

/**
 * Starts a short upper-body flinch whenever Aren's vitality drops between two sampled snapshots. The overlay is a share of
 * the 'aren-hit' clip blended over whatever is playing; it is purely cosmetic and decays to nothing within HIT_OVERLAY_SECONDS.
 */
function driveHitOverlay(instance: NativeAssetInstance, actor: ActorSnapshot, state: DriverState, clock: number | undefined, vitality: number | undefined): void {
  const lastVitality = state.lastVitality;
  state.lastVitality = vitality;
  if (clock === undefined || !instance.animation.hasAction(HIT_OVERLAY_ACTION)) return;
  if (lastVitality !== undefined && vitality !== undefined && vitality < lastVitality - 1e-3 && !actor.downed) state.hitStartedAt = clock;
  const elapsed = state.hitStartedAt === undefined ? -1 : clock - state.hitStartedAt;
  if (elapsed >= 0 && elapsed < HIT_OVERLAY_SECONDS) {
    const progress = elapsed / HIT_OVERLAY_SECONDS;
    const decay = 1 - smoothstep((elapsed - HIT_OVERLAY_ATTACK_SECONDS) / (HIT_OVERLAY_SECONDS - HIT_OVERLAY_ATTACK_SECONDS));
    instance.animation.setOverlay(HIT_OVERLAY_ACTION, progress, HIT_OVERLAY_PEAK_SHARE * smoothstep(elapsed / HIT_OVERLAY_ATTACK_SECONDS) * decay);
    state.overlayActive = true;
  } else {
    state.hitStartedAt = undefined;
    if (state.overlayActive) { instance.animation.setOverlay(undefined); state.overlayActive = false; }
  }
}

function nativeLocomotionPlaybackRate(
  instance: NativeAssetInstance,
  manifest: AssetManifestEntry | undefined,
  actionId: ActionId,
  velocity: ActorSnapshot['velocity'],
): number {
  if (!/walk|run|strafe/.test(String(actionId))) return 1;
  const motion = manifest?.rootMotion?.[String(actionId)];
  const samples = motion?.curveSamples;
  if (motion?.mode !== 'native-root-motion' || motion.evidenceStatus !== 'verified' || !samples || samples.length < 2) return 1;
  const authoredSpeed = instance.animation.authoredPlanarSpeed(actionId);
  const actorSpeed = Math.hypot(velocity.x, velocity.z);
  return Number.isFinite(authoredSpeed) && authoredSpeed > 0.05 && Number.isFinite(actorSpeed)
    ? actorSpeed / authoredSpeed
    : 1;
}
