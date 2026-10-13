import type { ActionId, ActorId, HeroMarkSnapshot, Vec3 } from '../../contracts.js';
import type { CombatActor, CombatInput } from '../CombatEngine.js';
import { PLAYER_SKILLS } from '../PlayerSkills.js';
import { yawOf } from '../PlayerArsenal.js';
import type { LivePlayerProjectile } from '../PlayerArsenal.js';
import { SAKDA, SAKDA_CLIPS, SAKDA_LABELS } from '../SakdaSkills.js';
import type { HeroKit, KitCue, KitFactory, KitHost, KitPlayerExtras, KitStagger, KitStrike } from './KitHost.js';

/**
 * Sakda, the Ember Fist: the Muay Thai brawler kit (design contract section 5).
 *
 * All state is plain JSON inside `host.kitState()`. Player-side ticks (`start`, `flurryUntil`, `shieldUntil`) are on the
 * simulation clock and are shifted by `onHitStop`; echo marks are on the world clock, which the engine already freezes.
 */

type SakdaActionKind = 'limb' | 'echo' | 'resonate' | 'elbows' | 'tempest' | 'knee' | 'clinch' | 'wrath';

/** The one skill in flight. Everything a later tick needs is stored here so the kit survives serialization. */
interface SakdaAction {
  kind: SakdaActionKind;
  /** Simulation tick the action began on. */
  start: number;
  total: number;
  /** J step (1..4). */
  step: number;
  /** J swing that plays with Flurry timing; it spends a charge on its first contact. */
  flurried: boolean;
  /** The swing already made contact (its Flurry charge and mana refund are settled). */
  manaDone: boolean;
  /** Tick (from `start`) the main effect lands. */
  activeAt: number;
  targetId?: ActorId;
  /** Events already fired (hits of Hundred Elbows, stages of a skill). */
  done: number;
  /** Dash window: first tick, length, planned metres, and how much of it has been travelled (0..1). */
  dashFrom: number;
  dashTicks: number;
  dashDistance: number;
  progress: number;
  /** Hostiles the main strike has hit (the roundhouse kick, the knee, Tempest Stomp). */
  hitIds: ActorId[];
  /** Hostiles the roundhouse's ember ring has hit; tracked apart from the kick so a kicked target also takes the ring. */
  ringHitIds: ActorId[];
  /** Tiger's Wrath knockback: unit direction and metres already slid. */
  slideDir?: Vec3;
  slid: number;
  /** Flying Knee: the leap is over (landed, or the sweep was blocked mid-air). */
  landed: boolean;
  /** Flying Knee: the last standable ground point of the leap. */
  safe?: { x: number; y: number; z: number };
}

interface SakdaState {
  action: SakdaAction | null;
  /** Echo marks: hostile id and the world tick the mark expires on. An array so the per-tick sweep allocates nothing. */
  echo: { id: ActorId; until: number }[];
  flurryCharges: number;
  flurryUntil: number;
  shield: number;
  shieldUntil: number;
}

/** Distance kept between Sakda and a target he dashes onto: the target's radius plus this. */
const CONTACT_GAP = 0.9;
/** Reach of a single-target impact measured from Sakda's actual position (beside `CONTACT_GAP`, so a finished dash always connects). */
const STRIKE_REACH = CONTACT_GAP + 0.9;
/** Tiger's Wrath kick reach: the soft-target margin beyond its 2 m dash. */
const WRATH_REACH = 2.6;
/** Frames of the active pose after a J strike (ring excluded). */
const ACTIVE_HOLD = 4;
/** Peak height (m) of the Flying Knee arc. */
const KNEE_ARC_HEIGHT = 1.4;
/** Shortest Flying Knee leap worth taking when the target is further away; a shorter clear path rejects the skill. */
const MIN_LEAP = 0.5;
/** Distance (m) between the leap's desired and swept end point beyond which the sweep counts as blocked. */
const BLOCK_EPSILON = 0.05;
/** Ticks over which Tiger's Wrath slides its target. */
const SLIDE_TICKS = 6;
/** Largest single knockback increment, so a fast slide cannot skip over a hostile or a wall. */
const SLIDE_SUBSTEP = 0.5;
const FULL_RING = Math.PI * 2;
/** Inputs the Flying Knee, Resonating Strike and Guard Dash cancel into once they have landed: each other. */
const CHAIN_INTO = ['heavy', 'ranged', 'dodge'] as const;

const smoothstep = (t: number): number => { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x); };
const flat = (from: Vec3, to: Vec3): { x: number; z: number; length: number } => {
  const dx = to.x - from.x, dz = to.z - from.z, length = Math.hypot(dx, dz);
  return length < 1e-6 ? { x: 0, z: 0, length: 0 } : { x: dx / length, z: dz / length, length };
};
const facingOf = (direction: { x: number; z: number }): Vec3 => ({ x: direction.x, y: 0, z: direction.z });

// ---- per-tick scratch ---------------------------------------------------------------------------------------------------
type Scratch = { x: number; y: number; z: number };
// Reused by the live tick paths (dashes, the Flying Knee leap) so they allocate nothing. They are only ever filled and
// consumed inside one helper call and never stored into kit state; the host setters copy what they are given.
const setVec = (out: Scratch, x: number, y: number, z: number): Vec3 => { out.x = x; out.y = y; out.z = z; return out; };
const flatInto = (out: { x: number; z: number; length: number }, from: Vec3, to: Vec3): void => {
  const dx = to.x - from.x, dz = to.z - from.z, length = Math.hypot(dx, dz);
  if (length < 1e-6) { out.x = 0; out.z = 0; out.length = 0; } else { out.x = dx / length; out.z = dz / length; out.length = length; }
};
const aimDir = { x: 0, z: 0, length: 0 }, stepDir = { x: 0, z: 0, length: 0 };
const faceOut: Scratch = { x: 0, y: 0, z: 0 }, velOut: Scratch = { x: 0, y: 0, z: 0 }, probe: Scratch = { x: 0, y: 0, z: 0 };
const stepFrom: Scratch = { x: 0, y: 0, z: 0 }, moveDelta: Scratch = { x: 0, y: 0, z: 0 };
const leapPrev: Scratch = { x: 0, y: 0, z: 0 }, leapPoint: Scratch = { x: 0, y: 0, z: 0 };
const clipOf = (key: string): ActionId => SAKDA_CLIPS[key] as ActionId;
const createState = (): SakdaState => ({ action: null, echo: [], flurryCharges: 0, flurryUntil: 0, shield: 0, shieldUntil: 0 });
const blankAction = (kind: SakdaActionKind, start: number, total: number, activeAt: number): SakdaAction =>
  ({ kind, start, total, step: 0, flurried: false, manaDone: false, activeAt, done: 0, dashFrom: 0, dashTicks: 0, dashDistance: 0, progress: 0, hitIds: [], ringHitIds: [], slid: 0, landed: false });

export const createSakdaKit: KitFactory = (host: KitHost): HeroKit => {
  const state = (): SakdaState => host.kitState<SakdaState>(createState);

  const actorFor = (id: ActorId | undefined): CombatActor | undefined => {
    if (id === undefined) return undefined;
    const actors = host.actors;
    for (let i = 0; i < actors.length; i++) {
      const actor = actors[i]!;
      if (actor.id === id) return host.isHostile(actor) ? actor : undefined;
    }
    return undefined;
  };
  const strike = (action: string, clip: string, damage: number, stagger: KitStagger, stopTicks: number, instinct: number): KitStrike =>
    ({ action, clip: clipOf(clip), damage, element: 'ember', stagger, stopTicks, instinct });
  const cue = (partial: Omit<KitCue, 'actorId' | 'element' | 'priority'>): void =>
    host.queueCue({ actorId: host.player.id, element: 'ember', priority: 'essential', ...partial });
  /** Whether Sakda, standing where he actually is now, can land a single-target hit on `target` (reach, visibility, walls). */
  const connects = (target: CombatActor, reach: number): boolean => host.canStrike(target, host.player.position, reach);

  // ---- echo marks (world clock) ---------------------------------------------------------------------------------------
  const echoUntil = (s: SakdaState, id: ActorId): number | undefined => {
    for (let i = 0; i < s.echo.length; i++) if (s.echo[i]!.id === id) return s.echo[i]!.until;
    return undefined;
  };
  const setEcho = (s: SakdaState, id: ActorId, until: number): void => {
    for (let i = 0; i < s.echo.length; i++) if (s.echo[i]!.id === id) { s.echo[i]!.until = until; return; }
    s.echo.push({ id, until });
  };
  const clearEcho = (s: SakdaState, id: ActorId): void => {
    for (let i = 0; i < s.echo.length; i++) if (s.echo[i]!.id === id) { s.echo[i] = s.echo[s.echo.length - 1]!; s.echo.pop(); return; }
  };
  const expireEchoes = (s: SakdaState): void => {
    for (let i = s.echo.length - 1; i >= 0; i--) if (s.echo[i]!.until <= host.worldTick) { s.echo[i] = s.echo[s.echo.length - 1]!; s.echo.pop(); }
  };

  const flurryCharges = (s: SakdaState): number => host.tick < s.flurryUntil ? s.flurryCharges : 0;
  const shieldAmount = (s: SakdaState): number => host.tick < s.shieldUntil ? s.shield : 0;
  /** Any skill but J arms Flurry; the window starts when the skill's recovery ends. */
  const armFlurry = (s: SakdaState, totalTicks: number): void => {
    s.flurryCharges = SAKDA.flurry.charges;
    s.flurryUntil = host.tick + totalTicks + SAKDA.flurry.windowTicks;
  };

  /** `cancelFrom` is the offset from the start at which the action may be cancelled into `CHAIN_INTO`. */
  const begin = (s: SakdaState, kind: SakdaActionKind, id: string, clip: string, total: number, activeAt: number, extra: Partial<SakdaAction> = {}, cancelable = false, cancelFrom?: number): SakdaAction => {
    host.beginAction({ id, clip: clipOf(clip), totalTicks: total, cancelable, ...(cancelFrom === undefined ? {} : { cancel: { fromTick: cancelFrom, into: CHAIN_INTO } }) });
    const action: SakdaAction = { ...blankAction(kind, host.tick, total, activeAt), ...extra };
    s.action = action;
    return action;
  };

  const faceTarget = (target: CombatActor): void => {
    flatInto(aimDir, host.player.position, target.position);
    if (aimDir.length > 0) host.setPlayerFacing(setVec(faceOut, aimDir.x, 0, aimDir.z));
  };

  /** One collision-safe ground step; returns where Sakda ends (a scratch vector or the host's result). Never leaves walkable support. */
  const glide = (from: Vec3, goalX: number, goalZ: number): Vec3 => {
    const next = host.moveCircle(from, setVec(moveDelta, goalX - from.x, 0, goalZ - from.z));
    return host.isSupported(next) ? next : from;
  };
  /** Moves up to `metres` towards `target` (or along the facing without one), keeping `CONTACT_GAP` from it. Returns metres moved. */
  const approach = (target: CombatActor | undefined, metres: number): number => {
    const player = host.player, raised = player.position;
    const from = setVec(stepFrom, raised.x, host.groundHeight(raised.x, raised.z, raised.y) ?? raised.y, raised.z);
    const direction = stepDir;
    if (target) flatInto(direction, from, target.position);
    else { direction.x = player.facing.x; direction.z = player.facing.z; direction.length = Infinity; }
    const room = target ? Math.max(0, direction.length - (target.radius + CONTACT_GAP)) : Infinity;
    const step = Math.min(metres, room);
    const next = step > 1e-6 ? glide(from, from.x + direction.x * step, from.z + direction.z * step) : from;
    const moved = Math.hypot(next.x - from.x, next.z - from.z);
    host.setPlayerPosition(next);
    host.setPlayerVelocity(setVec(velOut, direction.x * moved * 60, 0, direction.z * moved * 60));
    return moved;
  };
  /** Advances a planned dash linearly across its window; returns true while the dash window is open. */
  const dash = (a: SakdaAction, elapsed: number): boolean => {
    if (elapsed < a.dashFrom || a.dashTicks <= 0) return false;
    const p = Math.min(1, (elapsed - a.dashFrom + 1) / a.dashTicks);
    const target = actorFor(a.targetId);
    if (target) faceTarget(target);
    approach(target, a.dashDistance * (p - a.progress));
    a.progress = p;
    return elapsed < a.dashFrom + a.dashTicks;
  };
  const planDash = (a: SakdaAction, target: CombatActor | undefined, from: number, ticks: number, maxMetres: number): void => {
    const room = target ? Math.max(0, flat(host.player.position, target.position).length - (target.radius + CONTACT_GAP)) : maxMetres;
    a.dashFrom = from; a.dashTicks = ticks; a.dashDistance = Math.min(maxMetres, room);
  };
  const dashCue = (clip: string, from: Vec3, a: SakdaAction): void => {
    const target = actorFor(a.targetId);
    const direction = target ? flat(from, target.position) : { x: host.player.facing.x, z: host.player.facing.z, length: 0 };
    cue({ kind: 'blink', phase: 'commit', actionId: clipOf(clip), position: { ...from }, from: { ...from }, to: { x: from.x + direction.x * a.dashDistance, y: from.y, z: from.z + direction.z * a.dashDistance }, durationTicks: a.dashTicks, shape: 'trail' });
  };
  const slashCue = (clip: string, reach: number, arcDegrees: number, durationTicks: number, intensity: number, shape: 'arc' | 'ring' = 'arc'): void =>
    cue({ kind: 'slash', phase: 'active', actionId: clipOf(clip), position: { ...host.player.position }, footprint: { width: reach, length: reach, angleRadians: yawOf(host.player.facing), sectorRadians: arcDegrees * Math.PI / 180 }, durationTicks, intensity, shape });
  const missCue = (message: string, target: CombatActor, clip: string): void => host.emit('cue', message, target.id, clipOf(clip));

  // ---- J: Eight Limbs ---------------------------------------------------------------------------------------------
  const startLight = (step: number): boolean => {
    const spec = SAKDA.limbs.steps[step - 1];
    if (!spec) return false;
    const s = state();
    // Flurry timing applies while a charge is available; the charge is only spent on the swing's first contact.
    const flurried = flurryCharges(s) > 0;
    const speed = flurried ? 1 + SAKDA.flurry.speedBonus : 1;
    const total = Math.max(1, Math.round(spec.ticks / speed)), activeAt = Math.max(1, Math.round(spec.activeAt / speed));
    const target = host.softTarget(spec.reach + 1.2, 140);
    if (target) faceTarget(target);
    host.beginAction({ id: `light_${step}`, clip: clipOf(`light_${step}`), totalTicks: total, light: { step, chainEarlyTicks: SAKDA.limbs.chainEarlyTicks, chainLateTicks: SAKDA.limbs.chainLateTicks } });
    s.action = { ...blankAction('limb', host.tick, total, activeAt), step, flurried, ...(target ? { targetId: target.id } : {}) };
    host.emit('action', `Eight Limbs ${step}.`, target?.id, clipOf(`light_${step}`));
    return true;
  };
  const updateLimb = (s: SakdaState, a: SakdaAction, elapsed: number): void => {
    const spec = SAKDA.limbs.steps[a.step - 1]!, clip = `light_${a.step}`;
    if (spec.stepMetres !== undefined && elapsed < a.activeAt) approach(actorFor(a.targetId), spec.stepMetres / a.activeAt);
    const ringTicks = spec.ring?.ticks ?? 0;
    host.setPhase(elapsed < a.activeAt ? 'anticipation' : elapsed < a.activeAt + Math.max(ACTIVE_HOLD, ringTicks) ? 'active' : 'recovery');
    if (elapsed < a.activeAt) return;
    let struck = 0;
    if (a.done === 0) {
      a.done = 1;
      const arc = spec.arcDegrees ?? 120;
      slashCue(clip, spec.reach, arc, ACTIVE_HOLD + 2, 0.8 + a.step * 0.15);
      if (spec.ring) cue({ kind: 'slash', phase: 'active', actionId: clipOf(clip), position: { ...host.player.position }, footprint: { width: spec.ring.radius * 2, length: spec.ring.radius * 2, sectorRadians: FULL_RING }, durationTicks: spec.ring.ticks, intensity: 1.2, shape: 'ring' });
      struck += host.strikeCone(host.player.position, host.player.facing, spec.reach, arc, strike(clip, clip, spec.damage, 'none', a.step === 4 ? 5 : 3, 8), a.hitIds);
    }
    // The ember ring is its own strike with its own hit tracking: a target the kick hit takes the ring too.
    if (spec.ring && elapsed < a.activeAt + spec.ring.ticks) struck += host.strikeDisk(host.player.position, spec.ring.radius, strike(clip, clip, spec.ring.damage, 'none', 2, 4), a.ringHitIds);
    // A Flurry charge and its mana refund are spent on the swing's first successful contact, never on a miss.
    if (struck > 0 && !a.manaDone) {
      a.manaDone = true;
      if (a.flurried && s.flurryCharges > 0) { s.flurryCharges--; host.restoreMana(SAKDA.flurry.manaPerHit); }
    }
  };

  // ---- L tap: Echo Wave / Resonating Strike ------------------------------------------------------------------------
  /** The echoed hostile Resonating Strike would dash to: the locked one first, else the nearest. */
  const echoedTarget = (s: SakdaState): CombatActor | undefined => {
    let best: CombatActor | undefined, bestDistance = Infinity;
    for (const actor of host.actors) {
      const until = echoUntil(s, actor.id);
      if (until === undefined || until <= host.worldTick || !host.isHostile(actor)) continue;
      const distance = flat(host.player.position, actor.position).length;
      if (distance > SAKDA.resonatingStrike.maxDashRange + actor.radius) continue;
      if (actor.id === host.targetId) return actor;
      if (distance < bestDistance) { best = actor; bestDistance = distance; }
    }
    return best;
  };
  const startRanged = (charged: boolean): boolean => {
    const s = state();
    if (charged) return startElbows(s);
    const echoed = echoedTarget(s);
    return echoed ? startResonating(s, echoed) : startEcho(s);
  };
  const startEcho = (s: SakdaState): boolean => {
    if (!host.spendMana('sigil_bolt')) return false;
    const spec = SAKDA.echoWave;
    const target = host.softTarget(spec.range);
    if (target) faceTarget(target);
    begin(s, 'echo', 'sakda-echo-wave', 'sigil_bolt', spec.ticks, spec.releaseAt, target ? { targetId: target.id } : {});
    armFlurry(s, spec.ticks);
    host.emit('action', 'Echo Wave.', target?.id, clipOf('sigil_bolt'));
    return true;
  };
  const releaseEcho = (a: SakdaAction): void => {
    const spec = SAKDA.echoWave, player = host.player;
    const target = actorFor(a.targetId);
    const origin = { x: player.position.x + player.facing.x * 0.8, y: player.position.y + 1.2, z: player.position.z + player.facing.z * 0.8 };
    let direction: Vec3 = { x: player.facing.x, y: 0, z: player.facing.z };
    if (target) {
      const chest = host.chestOf(target), dx = chest.x - origin.x, dy = chest.y - origin.y, dz = chest.z - origin.z, length = Math.hypot(dx, dy, dz) || 1;
      direction = { x: dx / length, y: dy / length, z: dz / length };
    }
    host.spawnProjectile({ kind: 'echo-wave', actionId: SAKDA_CLIPS.sigil_bolt!, origin, direction, speed: spec.speed, range: spec.range, radius: spec.width / 2, damage: spec.damage, ...(target ? { targetId: target.id } : {}), callbackId: 'echo-wave' });
  };
  const startResonating = (s: SakdaState, target: CombatActor): boolean => {
    const spec = SAKDA.resonatingStrike;
    faceTarget(target);
    const room = Math.max(0, flat(host.player.position, target.position).length - (target.radius + CONTACT_GAP));
    const distance = Math.min(spec.maxDashRange, room);
    // The 24 m/s cap stretches the dash for a far target (the clip's 14-tick dash covers 5.6 m); the strike follows the dash.
    const dashTicks = Math.max(spec.dashTo - spec.dashFrom, Math.ceil(distance / spec.maxDashSpeed * 60));
    const impactAt = spec.dashFrom + dashTicks;
    const a = begin(s, 'resonate', 'sakda-resonating-strike', 'sigil_recast', Math.max(spec.ticks, impactAt + (spec.ticks - spec.impactAt)), impactAt, { targetId: target.id }, true, impactAt + 1);
    a.dashFrom = spec.dashFrom; a.dashTicks = dashTicks; a.dashDistance = distance;
    armFlurry(s, a.total);
    dashCue('sigil_recast', host.player.position, a);
    host.emit('action', 'Resonating Strike.', target.id, clipOf('sigil_recast'));
    return true;
  };
  const updateResonating = (s: SakdaState, a: SakdaAction, elapsed: number): void => {
    const spec = SAKDA.resonatingStrike;
    const dashing = dash(a, elapsed);
    host.setPhase(elapsed < a.activeAt ? (dashing ? 'start' : 'anticipation') : elapsed < a.activeAt + ACTIVE_HOLD ? 'active' : 'recovery');
    if (elapsed < a.activeAt || a.done > 0) return;
    a.done = 1;
    const target = actorFor(a.targetId);
    slashCue('sigil_recast', 2.4, 160, ACTIVE_HOLD + 4, 1.4);
    if (!target) return;
    faceTarget(target);
    // A whiff (out of reach or behind a wall) deals nothing and keeps the Echo mark for another try.
    if (!connects(target, STRIKE_REACH)) { missCue('Resonating Strike missed.', target, 'sigil_recast'); return; }
    const before = target.vitality ?? 100, missing = Math.max(0, (target.maxVitality ?? before) - before);
    const bonus = Math.min(spec.missingHealthCap, Math.round(missing * spec.missingHealthRatio));
    clearEcho(s, target.id);
    host.strikeHostile(target, strike('sigil_barrage', 'sigil_recast', spec.damage + bonus, 'idle', 6, 8));
  };

  // ---- L hold: Hundred Elbows ---------------------------------------------------------------------------------------
  const startElbows = (s: SakdaState): boolean => {
    if (!host.spendMana('sigil_barrage')) return false;
    const spec = SAKDA.hundredElbows;
    const target = host.softTarget(spec.dashDistance + 4, 360);
    if (target) faceTarget(target);
    const a = begin(s, 'elbows', 'sakda-hundred-elbows', 'sigil_barrage', spec.ticks, spec.hitAt[0]!, target ? { targetId: target.id } : {}, true);
    planDash(a, target, spec.dashFrom, spec.dashTo - spec.dashFrom, spec.dashDistance);
    armFlurry(s, spec.ticks);
    if (a.dashDistance > 0) dashCue('sigil_barrage', host.player.position, a);
    host.emit('action', 'Hundred Elbows.', target?.id, clipOf('sigil_barrage'));
    return true;
  };
  const updateElbows = (a: SakdaAction, elapsed: number): void => {
    const spec = SAKDA.hundredElbows;
    dash(a, elapsed);
    const target = actorFor(a.targetId);
    if (target && elapsed < spec.uppercutAt + 1) faceTarget(target);
    host.setPhase(elapsed < spec.hitAt[0]! ? 'anticipation' : elapsed <= spec.uppercutAt + ACTIVE_HOLD ? 'active' : 'recovery');
    while (a.done < spec.hitAt.length && elapsed >= spec.hitAt[a.done]!) {
      a.done++;
      slashCue('sigil_barrage', 2.4, 100, 6, 0.7);
      host.strikeCone(host.player.position, host.player.facing, 2.4, 100, strike('sigil_barrage', 'sigil_barrage', spec.hitDamage, 'none', 2, 3));
    }
    if (a.done === spec.hitAt.length && elapsed >= spec.uppercutAt) {
      a.done++;
      slashCue('sigil_barrage', 2.6, 120, ACTIVE_HOLD + 6, 1.6);
      const struck: ActorId[] = [];
      host.strikeCone(host.player.position, host.player.facing, 2.6, 120, strike('sigil_barrage', 'sigil_barrage', spec.uppercutDamage, 'none', 5, 8), struck);
      for (const id of struck) { const hit = actorFor(id); if (hit) host.interruptMonster(hit, 'charged_heavy'); }
    }
  };

  // ---- K tap: Tempest Stomp ------------------------------------------------------------------------------------------
  const startTempest = (s: SakdaState): boolean => {
    if (!host.spendMana('heavy')) return false;
    const spec = SAKDA.tempestStomp;
    const target = host.softTarget(spec.radius, 360);
    if (target) faceTarget(target);
    begin(s, 'tempest', 'sakda-tempest', 'heavy', spec.ticks, spec.activeAt);
    armFlurry(s, spec.ticks);
    host.emit('action', 'Tempest Stomp.', target?.id, clipOf('heavy'));
    return true;
  };
  const updateTempest = (a: SakdaAction, elapsed: number): void => {
    const spec = SAKDA.tempestStomp;
    host.setPhase(elapsed < spec.activeAt ? 'anticipation' : elapsed < spec.activeAt + ACTIVE_HOLD ? 'active' : 'recovery');
    if (elapsed < spec.activeAt || a.done > 0) return;
    a.done = 1;
    cue({ kind: 'slash', phase: 'active', actionId: clipOf('heavy'), position: { ...host.player.position }, footprint: { width: spec.radius * 2, length: spec.radius * 2, sectorRadians: FULL_RING }, durationTicks: 14, intensity: 1.5, shape: 'ring' });
    host.strikeDisk(host.player.position, spec.radius, strike('heavy', 'heavy', spec.damage, 'interrupt', 6, 8), a.hitIds);
    for (const id of a.hitIds) { const hit = actorFor(id); if (hit) host.crippleMonster(hit, spec.crippleSpeedFactor, spec.crippleTicks); }
  };

  // ---- K hold: Flying Knee --------------------------------------------------------------------------------------------
  /**
   * The furthest part of a `wanted`-metre leap along `direction` that the airborne capsule can sweep without hitting
   * anything and that ends above standable ground. Sampled once per tick of the leap; 0 when nothing is flyable.
   */
  const planLeap = (direction: { x: number; z: number }, wanted: number): number => {
    if (wanted <= 1e-6) return 0;
    const spec = SAKDA.flyingKnee, origin = host.player.position, ticks = spec.leapTo - spec.leapFrom;
    const previous = setVec(leapPrev, origin.x, origin.y, origin.z), point = leapPoint;
    let best = 0;
    for (let i = 1; i <= ticks; i++) {
      const t = i / ticks, travelled = wanted * smoothstep(t);
      setVec(point, origin.x + direction.x * travelled, origin.y + KNEE_ARC_HEIGHT * Math.sin(Math.PI * t), origin.z + direction.z * travelled);
      // The same capsule sweep the flight uses: a point the sweep cannot reach is blocked, so the leap ends before it.
      const swept = host.moveAerial(previous, setVec(moveDelta, point.x - previous.x, point.y - previous.y, point.z - previous.z));
      if (Math.hypot(swept.x - point.x, swept.y - point.y, swept.z - point.z) > BLOCK_EPSILON) break;
      setVec(previous, point.x, point.y, point.z);
      const floor = host.groundHeight(point.x, point.z, origin.y);
      if (floor !== null && host.isSupported(setVec(probe, point.x, floor, point.z))) best = travelled;
    }
    return best;
  };
  const startKnee = (s: SakdaState): boolean => {
    const spec = SAKDA.flyingKnee;
    const target = host.softTarget(spec.range, 360);
    if (target) faceTarget(target);
    const player = host.player, origin = { x: player.position.x, y: player.position.y, z: player.position.z };
    const direction = target ? flat(origin, target.position) : { x: player.facing.x, z: player.facing.z, length: Infinity };
    const room = target ? Math.max(0, direction.length - (target.radius + CONTACT_GAP)) : Infinity;
    const wanted = Math.min(target ? spec.range : spec.range / 2, room);
    const distance = planLeap(direction, wanted);
    // Too little clear, landable air to reach the target at all: refuse before any mana is spent.
    if (wanted > MIN_LEAP && distance < MIN_LEAP) {
      host.emit('cue', 'Flying Knee is blocked.', target?.id, clipOf('charged_heavy'));
      return false;
    }
    if (!host.spendMana('charged_heavy')) return false;
    const a = begin(s, 'knee', 'sakda-flying-knee', 'charged_heavy', spec.ticks, spec.impactAt, target ? { targetId: target.id } : {}, true, spec.impactAt + 1);
    a.dashFrom = spec.leapFrom; a.dashTicks = spec.leapTo - spec.leapFrom; a.dashDistance = distance;
    a.safe = { x: origin.x, y: origin.y, z: origin.z };
    armFlurry(s, spec.ticks);
    dashCue('charged_heavy', origin, a);
    host.emit('action', 'Flying Knee.', target?.id, clipOf('charged_heavy'));
    return true;
  };
  /** Puts Sakda back on the ground under the leap, or on the last standable point of it when that is not supported. */
  const land = (a: SakdaAction): void => {
    const at = host.player.position, floor = host.groundHeight(at.x, at.z, at.y);
    let supported = false;
    if (floor !== null) { setVec(probe, at.x, floor, at.z); supported = host.isSupported(probe); }
    host.setPlayerPosition(supported ? probe : a.safe ?? at);
    host.setPlayerVelocity(setVec(velOut, 0, 0, 0));
    a.landed = true;
  };
  /** One tick of the leap through the engine's aerial sweep. A blocked sweep ends the leap on the spot. Returns true while the leap is open. */
  const leapTick = (a: SakdaAction, elapsed: number): boolean => {
    if (a.landed || a.dashTicks <= 0 || elapsed < a.dashFrom) return false;
    const t = Math.min(1, (elapsed - a.dashFrom + 1) / a.dashTicks), p = smoothstep(t);
    const target = actorFor(a.targetId);
    if (target) faceTarget(target);
    const from = host.player.position, player = host.player, direction = stepDir;
    if (target) flatInto(direction, from, target.position);
    else { direction.x = player.facing.x; direction.z = player.facing.z; direction.length = Infinity; }
    const room = target ? Math.max(0, direction.length - (target.radius + CONTACT_GAP)) : Infinity;
    const step = Math.min(a.dashDistance * (p - a.progress), room);
    const x = from.x + direction.x * step, z = from.z + direction.z * step;
    const floor = host.groundHeight(x, z, from.y) ?? a.safe?.y ?? from.y;
    const wantedY = floor + KNEE_ARC_HEIGHT * Math.sin(Math.PI * t);
    const end = host.moveAerial(from, setVec(moveDelta, x - from.x, wantedY - from.y, z - from.z));
    host.setPlayerPosition(end);
    host.setPlayerVelocity(setVec(velOut, direction.x * step * 60, 0, direction.z * step * 60));
    a.progress = p;
    if (Math.hypot(end.x - x, end.y - wantedY, end.z - z) > BLOCK_EPSILON) { land(a); return false; }
    if (host.isSupported(setVec(probe, end.x, floor, end.z))) {
      if (a.safe) { a.safe.x = end.x; a.safe.y = floor; a.safe.z = end.z; } else a.safe = { x: end.x, y: floor, z: end.z };
    }
    return elapsed < a.dashFrom + a.dashTicks;
  };
  const updateKnee = (a: SakdaAction, elapsed: number): void => {
    const spec = SAKDA.flyingKnee;
    const leaping = leapTick(a, elapsed);
    host.setPhase(elapsed < spec.leapFrom ? 'anticipation' : elapsed < spec.impactAt ? (leaping ? 'start' : 'anticipation') : elapsed < spec.impactAt + ACTIVE_HOLD ? 'active' : 'recovery');
    if (elapsed < a.activeAt || a.done > 0) return;
    a.done = 1;
    if (!a.landed) land(a);
    const target = actorFor(a.targetId);
    if (target) faceTarget(target);
    cue({ kind: 'slash', phase: 'active', actionId: clipOf('charged_heavy'), position: { ...host.player.position }, footprint: { width: spec.ringRadius * 2, length: spec.ringRadius * 2, sectorRadians: FULL_RING }, durationTicks: 12, intensity: 1.8, shape: 'ring' });
    if (target) {
      // The knee only hurts the target when it actually connects from where Sakda landed; a missed target also skips the ring.
      a.hitIds.push(target.id);
      if (connects(target, STRIKE_REACH)) host.strikeHostile(target, strike('charged_heavy', 'charged_heavy', spec.damage, 'interrupt', 7, 10));
      else missCue('Flying Knee missed.', target, 'charged_heavy');
    }
    host.strikeDisk(host.player.position, spec.ringRadius, strike('charged_heavy', 'charged_heavy', spec.ringDamage, 'interrupt', 4, 4), a.hitIds);
  };

  // ---- Q: Iron Clinch ---------------------------------------------------------------------------------------------------
  const startClinch = (target: CombatActor): boolean => {
    const spec = SAKDA.ironClinch, s = state();
    const distance = flat(host.player.position, target.position).length;
    if (distance > spec.range + target.radius + CONTACT_GAP) {
      // Out of reach: the engine has already charged Q, so hand the mana back.
      host.restoreMana(PLAYER_SKILLS.root_tether.manaCost);
      host.emit('cue', 'Iron Clinch needs the target within 6 m.', target.id, clipOf('root_tether'));
      return false;
    }
    faceTarget(target);
    const a = begin(s, 'clinch', 'sakda-iron-clinch', 'root_tether', spec.ticks, spec.strikeAt, { targetId: target.id });
    planDash(a, target, 0, spec.strikeAt, spec.range);
    armFlurry(s, spec.ticks);
    dashCue('root_tether', host.player.position, a);
    host.emit('action', 'Iron Clinch.', target.id, clipOf('root_tether'));
    return true;
  };
  const updateClinch = (a: SakdaAction, elapsed: number): void => {
    const spec = SAKDA.ironClinch;
    const dashing = dash(a, elapsed);
    host.setPhase(elapsed < spec.strikeAt ? (dashing ? 'start' : 'anticipation') : elapsed < spec.strikeAt + ACTIVE_HOLD ? 'active' : 'recovery');
    if (elapsed < spec.strikeAt || a.done > 0) return;
    a.done = 1;
    host.setPlayerVelocity({ x: 0, y: 0, z: 0 });
    const target = actorFor(a.targetId);
    slashCue('root_tether', 2.2, 120, ACTIVE_HOLD + 2, 1.2);
    if (!target) return;
    faceTarget(target);
    if (connects(target, STRIKE_REACH)) host.strikeHostile(target, strike('root_tether', 'root_tether', spec.damage, 'interrupt', 5, 8));
    else missCue('Iron Clinch missed.', target, 'root_tether');
  };

  // ---- U: Tiger's Wrath ---------------------------------------------------------------------------------------------------
  const startWrath = (): boolean => {
    const spec = SAKDA.tigersWrath, s = state();
    const target = host.softTarget(spec.dashRange + 2.5, 360);
    if (!target) {
      host.emit('cue', "Tiger's Wrath needs a target within reach.", undefined, clipOf('judgement'));
      return false;
    }
    faceTarget(target);
    const a = begin(s, 'wrath', 'judgement', 'judgement', spec.ticks, spec.kickAt, { targetId: target.id });
    planDash(a, target, spec.kickAt - 10, 10, spec.dashRange);
    armFlurry(s, spec.ticks);
    host.setUntargetableUntil(host.tick + spec.untargetableTo);
    host.emit('action', "Tiger's Wrath.", target.id, clipOf('judgement'));
    return true;
  };
  /** Slides `target` along `a.slideDir` for this tick's share of the knockback, striking every other hostile it passes through. */
  const slide = (a: SakdaAction, target: CombatActor): void => {
    const spec = SAKDA.tigersWrath, direction = a.slideDir!;
    let share = Math.min(spec.knockback / SLIDE_TICKS, spec.knockback - a.slid);
    while (share > 1e-6) {
      const step = Math.min(SLIDE_SUBSTEP, share), moved = host.displaceMonster(target, direction, step);
      a.slid += moved; share -= step;
      host.strikeDisk(target.position, target.radius, strike('judgement', 'judgement', spec.slideDamage, 'none', 2, 0), a.hitIds);
      if (moved < step * 0.5) { a.slid = spec.knockback; break; }
    }
  };
  const updateWrath = (a: SakdaAction, elapsed: number): void => {
    const spec = SAKDA.tigersWrath;
    const target = actorFor(a.targetId);
    if (target && elapsed <= spec.kickAt) faceTarget(target);
    dash(a, elapsed);
    host.setPhase(elapsed < spec.kickAt ? 'anticipation' : elapsed < spec.kickAt + SLIDE_TICKS ? 'active' : 'recovery');
    if (elapsed < spec.kickAt) return;
    if (a.done === 0) {
      a.done = 1;
      host.setPlayerVelocity({ x: 0, y: 0, z: 0 });
      slashCue('judgement', 3.2, 200, 12, 2);
      if (!target) return;
      // Out of reach or behind a wall: no damage, interrupt, stagger or knockback.
      if (!connects(target, WRATH_REACH)) { missCue("Tiger's Wrath missed.", target, 'judgement'); return; }
      const direction = flat(host.player.position, target.position);
      a.slideDir = facingOf(direction.length > 0 ? direction : { x: host.player.facing.x, z: host.player.facing.z });
      a.hitIds.push(target.id);
      host.strikeHostile(target, strike('judgement', 'judgement', spec.damage, 'none', 7, 0));
      if (target.downed) return;
      host.interruptMonster(target, 'charged_heavy');
      host.staggerMonster(target, spec.staggerTicks);
      cue({ kind: 'beam', phase: 'active', actionId: clipOf('judgement'), from: { ...target.position }, to: { x: target.position.x + a.slideDir.x * spec.knockback, y: target.position.y, z: target.position.z + a.slideDir.z * spec.knockback }, durationTicks: SLIDE_TICKS + 6, intensity: 1.5, shape: 'beam' });
    }
    if (a.slideDir && target && a.slid < spec.knockback && !target.downed) slide(a, target);
  };

  // ---- kit surface ------------------------------------------------------------------------------------------------------------
  const update = (_input: CombatInput): void => {
    const s = state();
    expireEchoes(s);
    if (s.shield > 0 && host.tick >= s.shieldUntil) s.shield = 0;
    const a = s.action;
    if (!a) return;
    const elapsed = host.tick - a.start;
    switch (a.kind) {
      case 'limb': updateLimb(s, a, elapsed); break;
      case 'echo':
        host.setPhase(elapsed < a.activeAt ? 'anticipation' : elapsed < a.activeAt + ACTIVE_HOLD ? 'active' : 'recovery');
        if (elapsed >= a.activeAt && a.done === 0) { a.done = 1; releaseEcho(a); }
        break;
      case 'resonate': updateResonating(s, a, elapsed); break;
      case 'elbows': updateElbows(a, elapsed); break;
      case 'tempest': updateTempest(a, elapsed); break;
      case 'knee': updateKnee(a, elapsed); break;
      case 'clinch': updateClinch(a, elapsed); break;
      case 'wrath': updateWrath(a, elapsed); break;
    }
    if (elapsed >= a.total - 1 && s.action === a) s.action = null;
  };

  return {
    heroId: 'sakda',
    element: 'ember',
    labels: SAKDA_LABELS,
    lightSteps: SAKDA.limbs.steps.length,
    dodge: { clip: clipOf('dodge'), distance: SAKDA.guardDash.distance, durationTicks: SAKDA.guardDash.durationTicks, iframes: SAKDA.guardDash.iframes, recoveryTicks: SAKDA.guardDash.recoveryTicks, blinkCue: true, cancel: { fromTick: SAKDA.guardDash.durationTicks, into: CHAIN_INTO } },
    clip: action => SAKDA_CLIPS[action] as ActionId | undefined,
    startLight: step => startLight(step),
    startHeavy: charged => charged ? startKnee(state()) : startTempest(state()),
    startRanged,
    startTether: startClinch,
    startUltimate: startWrath,
    update,
    onHitStop() {
      const s = state();
      if (s.action) s.action.start++;
      if (s.flurryUntil > 0) s.flurryUntil++;
      if (s.shieldUntil > 0) s.shieldUntil++;
    },
    cancel() {
      const s = state();
      if (s.action?.kind === 'wrath') host.setUntargetableUntil(0);
      s.action = null;
    },
    reset() { /* The engine empties `kitState` before calling this; the next `state()` call recreates it. */ },
    onDodge() {
      const s = state(), spec = SAKDA.guardDash;
      s.shield = spec.shield;
      s.shieldUntil = host.tick + spec.shieldTicks;
      armFlurry(s, spec.durationTicks + spec.recoveryTicks);
    },
    /** Jump and Cleanse are skills too, so they arm Flurry; Guard Dash arms it in `onDodge`. */
    onSharedSkill(skill) {
      if (skill === 'jump') armFlurry(state(), 0);
      else if (skill === 'cleanse') armFlurry(state(), SAKDA.cleanse.lockTicks);
    },
    absorbDamage(amount) {
      const s = state();
      const shield = shieldAmount(s);
      if (shield <= 0) return amount;
      const absorbed = Math.min(shield, amount);
      s.shield = shield - absorbed;
      return amount - absorbed;
    },
    playerExtras(): KitPlayerExtras {
      const s = state(), shield = shieldAmount(s), charges = flurryCharges(s);
      return { ...(shield > 0 ? { shield } : {}), ...(charges > 0 ? { flurryCharges: charges } : {}) };
    },
    heroMarks(actorId): readonly HeroMarkSnapshot[] | undefined {
      const until = echoUntil(state(), actorId);
      if (until === undefined || until <= host.worldTick) return undefined;
      const actor = actorFor(actorId);
      return actor ? [{ kind: 'echo-mark', remainingTicks: Math.ceil(until - host.worldTick) }] : undefined;
    },
    onProjectileHit(projectile: LivePlayerProjectile, target: CombatActor): void {
      if (projectile.callbackId !== 'echo-wave') return;
      host.strikeHostile(target, strike('sigil_bolt', 'sigil_bolt', projectile.damage, 'idle', 2, 4));
      if (!target.downed) setEcho(state(), target.id, host.worldTick + SAKDA.echoWave.markTicks);
    },
  };
};
