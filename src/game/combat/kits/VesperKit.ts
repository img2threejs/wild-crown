import type { ActionId, HeroMarkSnapshot, Vec3 } from '../../contracts.js';
import type { CombatActor } from '../CombatEngine.js';
import { distance2, facingFrom, vec } from '../geometry.js';
import { rotateY, yawOf, type LivePlayerProjectile } from '../PlayerArsenal.js';
import { LIGHT_ASSIST_RANGE, PLAYER_SKILLS } from '../PlayerSkills.js';
import { VESPER, VESPER_CLIPS, VESPER_LABELS } from '../VesperSkills.js';
import type { HeroKit, KitCue, KitFactory, KitHost, KitStagger, KitStrike } from './KitHost.js';

/**
 * Vesper, the Moonshade Blade (`umbral`): a samurai assassin. Moonlit Iai (J), Shadow Step / Thousand Cuts (K), Kunai Fan / Shade Swap (L),
 * Severing Shadow (Q), Mist Blink (F) and Crimson Requiem (U), plus the Death Mark and backstab passives.
 *
 * Every counter in the kit state ticks down or up once per live simulation tick (`update` never runs during hit-stop), so the kit needs no
 * hit-stop clock shifting and its state is plain JSON that serializes with the engine.
 */

/** The player's capsule radius (the engine's `PLAYER_RADIUS`); only used to stand a blink destination off a target's body. */
const BODY_RADIUS = 0.42;
const STAND_OFF = 0.45;
const FIXED_STEP_SECONDS = 1 / 60;
const ELEMENT = 'umbral' as const;
/** Landing candidates around a target, as turns away from the preferred side: the preferred spot first, then alternating sides, the front last. */
const LANDING_TURNS: readonly number[] = [0, 0.7, -0.7, 1.4, -1.4, 2.1, -2.1, Math.PI];
const GOLDEN_ANGLE = 2.399963;
const KUNAI_HEIGHT = 1.1;
/** The clone moves at this speed, so its 8 m lane is flown by the swap tick. */
const CLONE_SPEED = 24;
const SHADE_LANE_CUE_TICKS = 24;
const CUT_TIMES: readonly number[] = [...VESPER.thousandCuts.strikeAt, VESPER.thousandCuts.finisherAt];
const RIFT_LANE_WIDTH = 2;
/** Reach of every blink-and-strike impact, measured from the player's actual position (the blink stands Vesper well inside it). */
const STRIKE_REACH = 2.8;
/** Crimson Requiem's detonation hits any marked foe in sight; the marks were laid within 12 m of the cast. */
const DETONATION_REACH = 24;
const RIFT_SEARCH_MARGIN = 3;
const CANCEL_AFTER_STRIKE = ['light', 'heavy', 'dodge'] as const;

const INSTINCT = { light: 8, rift: 12, step: 10, cut: 3, finisher: 10, kunai: 3, clone: 8, sever: 12, requiem: 2 } as const;
const HIT_STOP = { light: 3, rift: 5, step: 4, finisher: 5, kunai: 1, clone: 3, sever: 5, slash: 1, requiem: 6 } as const;

type ActionKind = 'iai' | 'step' | 'cuts' | 'kunai' | 'shade' | 'sever' | 'requiem';

/** The skill in flight; `age` is the number of live ticks since it began (0 on its first tick). */
interface VesperAction {
  kind: ActionKind;
  age: number;
  /** Iai step 1..4. */
  step: number;
  targetId: string | null;
  /** Scheduled effects already triggered (cuts, slashes) or 1 once a one-shot launched. */
  fired: number;
  /** Hostiles this skill's area strikes already hit. */
  hit: string[];
  dir: Vec3;
  from: Vec3;
  to: Vec3;
  /** Requiem: hostiles marked at the cast. */
  marked: string[];
}

interface VesperState {
  /** Per hostile, the remaining ticks of each live Death Mark stack. */
  stacks: Record<string, number[]>;
  /** Per hostile, the remaining ticks of its Death Mark. */
  marks: Record<string, number>;
  /** Per hostile, the remaining ticks of its Crimson Requiem mark. */
  requiem: Record<string, number>;
  action: VesperAction | null;
}

const copy = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z });
const scale = (v: Vec3, factor: number): Vec3 => ({ x: v.x * factor, y: v.y * factor, z: v.z * factor });
const smooth = (t: number): number => { const u = Math.min(1, Math.max(0, t)); return u * u * (3 - 2 * u); };
const degrees = (value: number): number => value * Math.PI / 180;

function newAction(kind: ActionKind, step = 0, targetId: string | null = null): VesperAction {
  return { kind, age: 0, step, targetId, fired: 0, hit: [], dir: vec(0, 0, 1), from: vec(0, 0, 0), to: vec(0, 0, 0), marked: [] };
}

export const createVesperKit: KitFactory = (host: KitHost): HeroKit => {
  const state = (): VesperState => host.kitState<VesperState>(() => ({ stacks: {}, marks: {}, requiem: {}, action: null }));
  const clipOf = (key: string): ActionId => VESPER_CLIPS[key] as ActionId;
  const strike = (action: string, clip: ActionId, damage: number, stagger: KitStagger, stopTicks: number, instinct: number): KitStrike =>
    ({ action, clip, damage, element: ELEMENT, stagger, stopTicks, instinct });
  const hostile = (id: string | null): CombatActor | undefined => {
    if (id === null) return undefined;
    const actor = host.actors.find(candidate => candidate.id === id);
    return actor && host.isHostile(actor) ? actor : undefined;
  };
  const cue = (kind: KitCue['kind'], phase: NonNullable<KitCue['phase']>, extra: Partial<KitCue>): KitCue =>
    ({ kind, phase, actorId: host.player.id, element: ELEMENT, priority: 'essential', ...extra });
  const facePoint = (point: Vec3): void => host.setPlayerFacing(facingFrom({ x: point.x - host.player.position.x, y: 0, z: point.z - host.player.position.z }));

  /** The side of a target Vesper prefers to land on: directly behind it. A target with no facing is approached from the far side. */
  const behindOf = (target: CombatActor): Vec3 => {
    const length = Math.hypot(target.facing.x, target.facing.z);
    if (length > 1e-6) return vec(-target.facing.x / length, 0, -target.facing.z / length);
    return facingFrom({ x: target.position.x - host.player.position.x, y: 0, z: target.position.z - host.player.position.z });
  };
  /** A standable, path-clear spot beside `target`, trying `preferred` first; undefined when every side is walled off. */
  const landingAround = (target: CombatActor, preferred: Vec3): Vec3 | undefined => {
    const player = host.player, gap = target.radius + BODY_RADIUS + STAND_OFF;
    for (const turn of LANDING_TURNS) {
      const direction = rotateY(preferred, turn), x = target.position.x + direction.x * gap, z = target.position.z + direction.z * gap;
      const y = host.groundHeight(x, z, player.position.y);
      if (y === null) continue;
      const point = vec(x, y, z);
      if (host.isSupported(point) && host.isPathClear(player.position, point) && host.canStrike(target, point, STRIKE_REACH)) return point;
    }
    return undefined;
  };
  /** Fallback when no landing spot exists: the farthest standable spot on the straight line toward the target. */
  const approach = (target: CombatActor): Vec3 => {
    const player = host.player, gap = target.radius + BODY_RADIUS + STAND_OFF, distance = distance2(player.position, target.position);
    if (distance <= gap) return copy(player.position);
    const toward = facingFrom({ x: target.position.x - player.position.x, y: 0, z: target.position.z - player.position.z });
    return farthestStandable(player.position, toward, distance - gap);
  };
  /** Instantly relocates Vesper (always to a point the caller validated or the collision sweep produced) and queues the blink cue. */
  const blinkTo = (point: Vec3, lookAt: Vec3 | undefined, clip: ActionId, durationTicks: number): void => {
    const from = copy(host.player.position);
    host.setPlayerPosition(point);
    if (lookAt) facePoint(lookAt);
    host.setPlayerVelocity(vec(0, 0, 0));
    host.queueCue(cue('blink', 'commit', { position: from, from, to: copy(point), durationTicks, actionId: clip, shape: 'trail' }));
  };
  const slashCue = (clip: ActionId, reach: number, arcDegrees: number, durationTicks: number, intensity: number): KitCue =>
    cue('slash', 'active', {
      position: copy(host.player.position), actionId: clip, durationTicks, intensity, shape: 'arc',
      footprint: { width: reach, length: reach, angleRadians: yawOf(host.player.facing), sectorRadians: degrees(arcDegrees) },
    });
  const begin = (action: VesperAction): VesperAction => { state().action = action; return action; };

  // ---- Death Mark and backstab --------------------------------------------------------------------------------------
  const decay = (s: VesperState): void => {
    for (const id in s.stacks) {
      const list = s.stacks[id]!;
      let kept = 0;
      for (let index = 0; index < list.length; index++) if (--list[index]! > 0) list[kept++] = list[index]!;
      list.length = kept;
      if (kept === 0) delete s.stacks[id];
    }
    for (const id in s.marks) if (--s.marks[id]! <= 0) delete s.marks[id];
    for (const id in s.requiem) if (--s.requiem[id]! <= 0) delete s.requiem[id];
  };
  const forget = (s: VesperState, id: string): void => { delete s.stacks[id]; delete s.marks[id]; delete s.requiem[id]; };
  /** One targeted hit from the player's ACTUAL position: nothing happens (no damage, mark, interrupt or stack) unless the target is in reach with a clear line. */
  const reachStrike = (target: CombatActor, hit: KitStrike): boolean => {
    if (!host.canStrike(target, host.player.position, STRIKE_REACH)) return false;
    host.strikeHostile(target, hit);
    return true;
  };
  /**
   * Crescent Rift: a hostile is struck once, the tick the segment Vesper ACTUALLY swept this tick (previous → current position after the collision sweep)
   * passes within the lane half-width of it and a clear strike from her actual position succeeds. Foes beyond the dash's current reach, or behind walls, wait.
   */
  const riftSweep = (a: VesperAction, before: Vec3, now: Vec3, hit: () => KitStrike): void => {
    const half = RIFT_LANE_WIDTH / 2, dx = now.x - before.x, dz = now.z - before.z, lengthSq = dx * dx + dz * dz;
    const centre = vec((before.x + now.x) / 2, (before.y + now.y) / 2, (before.z + now.z) / 2);
    for (const foe of host.hostilesInRadius(centre, Math.sqrt(lengthSq) / 2 + half + RIFT_SEARCH_MARGIN)) {
      if (a.hit.includes(foe.id)) continue;
      const t = lengthSq > 1e-9 ? Math.min(1, Math.max(0, ((foe.position.x - before.x) * dx + (foe.position.z - before.z) * dz) / lengthSq)) : 0;
      if (Math.hypot(foe.position.x - (before.x + dx * t), foe.position.z - (before.z + dz * t)) > half + foe.radius) continue;
      if (!host.canStrike(foe, now, STRIKE_REACH)) continue;
      a.hit.push(foe.id);
      host.strikeHostile(foe, hit());
    }
  };
  /** Cleanly ends whatever action is live before a replacement starts: no movement, untargetable window or pending hit state survives it. */
  const abandon = (s: VesperState): void => {
    const current = s.action;
    if (!current) return;
    if (current.kind === 'cuts' || current.kind === 'requiem' || current.kind === 'iai') host.setUntargetableUntil(0);
    if (current.kind === 'iai') host.setPlayerVelocity(vec(0, 0, 0));
    if (current.kind === 'requiem') for (const id of current.marked) delete s.requiem[id];
    current.hit.length = 0;
    s.action = null;
  };

  // ---- skills --------------------------------------------------------------------------------------------------------
  const startShadowStep = (): boolean => {
    if (!host.spendMana('heavy')) return false;
    abandon(state());
    const target = host.softTarget(VESPER.shadowStep.blinkRange);
    if (target) facePoint(target.position);
    const clip = clipOf('heavy');
    host.beginAction({
      id: clip, clip, totalTicks: VESPER.shadowStep.ticks, lockTicks: VESPER.shadowStep.strikeAt + 1,
      cancel: { fromTick: VESPER.shadowStep.strikeAt + 1, into: CANCEL_AFTER_STRIKE },
    });
    begin(newAction('step', 0, target?.id ?? null));
    return true;
  };

  const startThousandCuts = (): boolean => {
    if (!host.spendMana('charged_heavy')) return false;
    const clip = clipOf('charged_heavy'), cuts = VESPER.thousandCuts;
    host.beginAction({ id: clip, clip, totalTicks: cuts.ticks });
    host.setUntargetableUntil(host.tick + cuts.ticks);
    begin(newAction('cuts'));
    return true;
  };

  /** Runs the iai step; true once its clip has ended. */
  const runIai = (a: VesperAction): boolean => {
    const spec = VESPER.iai.steps[a.step - 1]!, player = host.player, clip = clipOf(`light_${a.step}`);
    if (a.step < 4) {
      if (a.age === spec.activeAt) {
        host.setPhase('active');
        host.queueCue(slashCue(clip, spec.reach, spec.arcDegrees, 6, 1 + 0.15 * a.step));
        host.strikeCone(player.position, player.facing, spec.reach, spec.arcDegrees, strike(`light_${a.step}`, clip, spec.damage, 'interrupt', HIT_STOP.light, INSTINCT.light), a.hit);
      } else if (a.age === spec.activeAt + 3) host.setPhase('recovery');
      return a.age + 1 >= spec.ticks;
    }
    const rift = VESPER.iai, dashTicks = rift.riftDashTo - rift.riftDashFrom;
    if (a.age === rift.riftDashFrom) {
      a.from = copy(player.position);
      a.dir = facingFrom(player.facing);
      a.to = host.moveCircle(a.from, scale(a.dir, rift.riftDashDistance));
      // Untouchable for the whole dash, tick `riftDashTo` included.
      host.setUntargetableUntil(host.tick + dashTicks + 1);
      host.queueCue(cue('beam', 'active', {
        position: copy(a.from), from: copy(a.from), to: copy(a.to), actionId: clip, durationTicks: dashTicks + 6, shape: 'beam',
        footprint: { width: 1, length: distance2(a.from, a.to), angleRadians: yawOf(a.dir) },
      }));
    }
    if (a.age >= rift.riftDashFrom && a.age < rift.riftDashTo) {
      const t0 = (a.age - rift.riftDashFrom) / dashTicks, t1 = (a.age - rift.riftDashFrom + 1) / dashTicks;
      const before = copy(player.position), next = host.moveCircle(before, scale(a.dir, rift.riftDashDistance * (smooth(t1) - smooth(t0))));
      host.setPlayerPosition(next);
      host.setPlayerVelocity(scale({ x: next.x - before.x, y: 0, z: next.z - before.z }, 1 / FIXED_STEP_SECONDS));
      riftSweep(a, before, player.position, () => strike('light_4', clip, spec.damage, 'interrupt', HIT_STOP.rift, INSTINCT.rift));
    }
    if (a.age === spec.activeAt) host.setPhase('active');
    else if (a.age === rift.riftDashTo) { host.setPhase('recovery'); host.setPlayerVelocity(vec(0, 0, 0)); }
    return a.age + 1 >= spec.ticks;
  };

  const runShadowStep = (a: VesperAction): boolean => {
    const spec = VESPER.shadowStep, clip = clipOf('heavy'), player = host.player;
    if (a.age === spec.blinkAt) {
      const target = hostile(a.targetId);
      if (target) blinkTo(landingAround(target, behindOf(target)) ?? approach(target), target.position, clip, spec.strikeAt - spec.blinkAt);
      else blinkTo(farthestStandable(player.position, facingFrom(player.facing), spec.fallbackDistance), undefined, clip, spec.strikeAt - spec.blinkAt);
    } else if (a.age === spec.strikeAt) {
      host.setPhase('active');
      host.queueCue(slashCue(clip, 2.8, 140, 6, 1.4));
      const target = hostile(a.targetId), hit = strike('heavy', clip, spec.damage, 'interrupt', HIT_STOP.step, INSTINCT.step);
      if (target && distance2(player.position, target.position) <= STRIKE_REACH + target.radius) reachStrike(target, hit);
      else {
        // A blocked or out-of-reach locked target is never swept up by the cone either.
        if (target) a.hit.push(target.id);
        host.strikeCone(player.position, player.facing, STRIKE_REACH, 140, hit, a.hit);
      }
    } else if (a.age === spec.strikeAt + 3) host.setPhase('recovery');
    return a.age + 1 >= spec.ticks;
  };

  const runCuts = (a: VesperAction): boolean => {
    const spec = VESPER.thousandCuts, clip = clipOf('charged_heavy'), player = host.player;
    if (a.fired < CUT_TIMES.length && a.age === CUT_TIMES[a.fired]) {
      const index = a.fired++, finisher = index === CUT_TIMES.length - 1;
      host.setPhase('active');
      const foes = host.hostilesInRadius(player.position, spec.range);
      const target = foes.length > 0 ? foes[index % foes.length]! : undefined;
      if (target) {
        const angle = index * GOLDEN_ANGLE;
        const point = landingAround(target, vec(Math.sin(angle), 0, Math.cos(angle))) ?? approach(target);
        if (index === 0) host.queueCue(cue('slash', 'active', {
          position: copy(target.position), actionId: clip, durationTicks: CUT_TIMES[CUT_TIMES.length - 2]! - spec.strikeAt[0]! + 6, intensity: 1.2, shape: 'arc',
          footprint: { width: 2.5, length: 2.5, angleRadians: yawOf(player.facing), sectorRadians: Math.PI * 2 },
        }));
        blinkTo(point, target.position, clip, 4);
        reachStrike(target, finisher
          ? strike('charged_heavy', clip, spec.finisherDamage, 'interrupt', HIT_STOP.finisher, INSTINCT.finisher)
          : strike('thousand_cuts', clip, spec.strikeDamage, 'none', 0, INSTINCT.cut));
      }
    }
    if (a.age === spec.finisherAt + 1) host.setPhase('recovery');
    return a.age + 1 >= spec.ticks;
  };

  const runKunai = (a: VesperAction): boolean => {
    const spec = VESPER.kunaiFan, clip = clipOf('sigil_bolt'), player = host.player;
    if (a.age === spec.releaseAt) {
      host.setPhase('active');
      const target = hostile(a.targetId), facing = facingFrom(player.facing);
      const aim = target ? facingFrom({ x: target.position.x - player.position.x, y: 0, z: target.position.z - player.position.z }) : facing;
      host.setPlayerFacing(aim);
      const origin = vec(player.position.x + aim.x * 0.5, player.position.y + KUNAI_HEIGHT, player.position.z + aim.z * 0.5);
      for (let index = 0; index < spec.count; index++) {
        const angle = degrees(spec.spreadDegrees) * (index - (spec.count - 1) / 2) * (2 / (spec.count - 1));
        host.spawnProjectile({
          kind: 'kunai', actionId: clip, origin: copy(origin), direction: rotateY(aim, angle), speed: spec.speed, range: spec.range,
          radius: spec.radius, damage: spec.damage, callbackId: 'kunai',
        });
      }
    } else if (a.age === spec.releaseAt + 3) host.setPhase('recovery');
    return a.age + 1 >= spec.ticks;
  };

  /** The farthest straight-line spot up to `maxDistance` from `from` along `dir` Vesper can stand on and reach without crossing a wall. */
  const farthestStandable = (from: Vec3, dir: Vec3, maxDistance: number): Vec3 => {
    for (let distance = maxDistance; distance > 0.2; distance -= 0.25) {
      const x = from.x + dir.x * distance, z = from.z + dir.z * distance, y = host.groundHeight(x, z, from.y);
      if (y === null) continue;
      const point = vec(x, y, z);
      if (host.isSupported(point) && host.isPathClear(from, point)) return point;
    }
    return copy(from);
  };

  const runShade = (a: VesperAction): boolean => {
    const spec = VESPER.shadeSwap, clip = clipOf('sigil_barrage'), player = host.player;
    if (a.age === spec.cloneLaunchAt) {
      const target = hostile(a.targetId);
      a.dir = target ? facingFrom({ x: target.position.x - player.position.x, y: 0, z: target.position.z - player.position.z }) : facingFrom(player.facing);
      host.setPlayerFacing(a.dir);
      a.from = copy(player.position);
      a.to = farthestStandable(a.from, a.dir, spec.dashDistance);
      a.fired = 1;
      host.setPhase('active');
      host.queueCue(cue('beam', 'active', {
        position: copy(a.from), from: copy(a.from), to: copy(a.to), actionId: clip, durationTicks: SHADE_LANE_CUE_TICKS, shape: 'beam',
        footprint: { width: spec.laneWidth, length: spec.dashDistance, angleRadians: yawOf(a.dir) },
      }));
      host.spawnProjectile({
        kind: 'shade-clone', actionId: clip, origin: vec(a.from.x + a.dir.x * 0.6, a.from.y + 1, a.from.z + a.dir.z * 0.6), direction: copy(a.dir),
        speed: CLONE_SPEED, range: spec.dashDistance, radius: spec.laneWidth / 2, damage: spec.damage, callbackId: 'shade-clone', pierce: true,
      });
    } else if (a.age === spec.swapAt && a.fired === 1) {
      host.setPhase('recovery');
      if (distance2(a.to, player.position) > 0.1) blinkTo(copy(a.to), undefined, clip, 4);
      host.setUntargetableUntil(host.tick + spec.untouchableTicks);
    }
    return a.age + 1 >= spec.ticks;
  };

  const runSever = (a: VesperAction): boolean => {
    const spec = VESPER.severingShadow, clip = clipOf('root_tether'), player = host.player;
    if (a.age === 4) {
      const target = hostile(a.targetId);
      if (target) blinkTo(landingAround(target, behindOf(target)) ?? approach(target), target.position, clip, spec.strikeAt - 4);
    } else if (a.age === spec.strikeAt) {
      host.setPhase('active');
      const target = hostile(a.targetId);
      if (target && host.canStrike(target, player.position, STRIKE_REACH)) {
        host.queueCue(cue('tether', 'commit', { targetId: target.id, position: copy(player.position), from: copy(player.position), to: copy(target.position), durationTicks: 10, actionId: clip, shape: 'beam' }));
        host.strikeHostile(target, strike('root_tether', clip, spec.damage, 'interrupt', HIT_STOP.sever, INSTINCT.sever));
      }
    } else if (a.age === spec.strikeAt + 3) host.setPhase('recovery');
    return a.age + 1 >= spec.ticks;
  };

  const runRequiem = (a: VesperAction, s: VesperState): boolean => {
    const spec = VESPER.requiem, clip = clipOf('judgement'), player = host.player;
    if (a.age === 0) host.queueCue(cue('judgement', 'anticipation', { position: copy(player.position), durationTicks: spec.markAt, actionId: clip, shape: 'ring', intensity: 1.4 }));
    if (a.age === spec.markAt) {
      host.queueCue(cue('judgement', 'commit', { position: copy(player.position), durationTicks: 12, actionId: clip, shape: 'ring', intensity: 1.4 }));
      for (const foe of host.hostilesInRadius(player.position, spec.markRadius)) {
        s.requiem[foe.id] = spec.detonationAt - spec.markAt + 4;
        a.marked.push(foe.id);
        host.queueCue(cue('judgement-mark', 'commit', { targetId: foe.id, position: copy(foe.position), durationTicks: spec.detonationAt - spec.markAt, actionId: clip, shape: 'ring', intensity: 1 }));
      }
    }
    const slashAge = a.age - spec.slashFrom;
    if (slashAge >= 0 && slashAge % spec.slashInterval === 0 && slashAge / spec.slashInterval < spec.slashCount) {
      const index = slashAge / spec.slashInterval;
      host.setPhase('active');
      const foes = a.marked.map(hostile).filter((foe): foe is CombatActor => foe !== undefined);
      const target = foes.length > 0 ? foes[index % foes.length]! : undefined;
      if (target) {
        const angle = index * GOLDEN_ANGLE;
        blinkTo(landingAround(target, vec(Math.sin(angle), 0, Math.cos(angle))) ?? approach(target), target.position, clip, 6);
        reachStrike(target, strike('requiem_slash', clip, spec.slashDamage, 'none', HIT_STOP.slash, INSTINCT.requiem));
      }
    }
    if (a.age === spec.detonationAt) {
      host.setPhase('active');
      for (const id of a.marked) {
        const target = hostile(id);
        delete s.requiem[id];
        if (!target || !host.canStrike(target, player.position, DETONATION_REACH)) continue;
        host.queueCue(cue('judgement-mark', 'hit', { targetId: target.id, position: host.chestOf(target), actionId: clip, durationTicks: 12, shape: 'burst', intensity: 2.4 }));
        host.strikeHostile(target, strike('judgement', clip, spec.detonationDamage, 'none', HIT_STOP.requiem, 0));
      }
      a.marked = [];
    } else if (a.age === spec.detonationAt + 4) host.setPhase('recovery');
    return a.age + 1 >= spec.ticks;
  };

  const advance = (s: VesperState, a: VesperAction): void => {
    let finished = false;
    switch (a.kind) {
      case 'iai': finished = runIai(a); break;
      case 'step': finished = runShadowStep(a); break;
      case 'cuts': finished = runCuts(a); break;
      case 'kunai': finished = runKunai(a); break;
      case 'shade': finished = runShade(a); break;
      case 'sever': finished = runSever(a); break;
      case 'requiem': finished = runRequiem(a, s); break;
    }
    if (finished) { if (s.action === a) s.action = null; } else a.age++;
  };

  const kit: HeroKit = {
    heroId: 'vesper',
    element: ELEMENT,
    labels: VESPER_LABELS,
    lightSteps: VESPER.iai.steps.length,
    dodge: {
      clip: clipOf('dodge'), distance: VESPER.mistBlink.distance, durationTicks: VESPER.mistBlink.durationTicks,
      iframes: VESPER.mistBlink.iframes, recoveryTicks: VESPER.mistBlink.recoveryTicks, blinkCue: true,
    },
    clip: action => VESPER_CLIPS[action] as ActionId | undefined,

    startLight(step) {
      const spec = VESPER.iai.steps[step - 1];
      if (!spec) return false;
      const target = host.softTarget(LIGHT_ASSIST_RANGE, 360);
      if (target) facePoint(target.position);
      const clip = clipOf(`light_${step}`);
      const lockTicks = step === VESPER.iai.steps.length ? VESPER.iai.riftDashTo + 1 : spec.activeAt + 1;
      const cancelFrom = spec.activeAt + 1;
      host.beginAction({
        id: clip, clip, totalTicks: spec.ticks, lockTicks, light: { step, chainEarlyTicks: VESPER.iai.chainEarlyTicks, chainLateTicks: VESPER.iai.chainLateTicks },
        cancel: { fromTick: cancelFrom, into: ['heavy', 'dodge'] },
      });
      begin(newAction('iai', step, target?.id ?? null));
      return true;
    },
    startHeavy: charged => charged ? startThousandCuts() : startShadowStep(),
    startRanged(charged) {
      if (!host.spendMana(charged ? 'sigil_barrage' : 'sigil_bolt')) return false;
      const target = host.softTarget(charged ? VESPER.shadeSwap.dashDistance + 4 : VESPER.kunaiFan.range);
      if (target) facePoint(target.position);
      const clip = clipOf(charged ? 'sigil_barrage' : 'sigil_bolt'), spec = charged ? VESPER.shadeSwap : VESPER.kunaiFan;
      host.beginAction({
        id: clip, clip, totalTicks: spec.ticks, lockTicks: charged ? VESPER.shadeSwap.swapAt + 1 : VESPER.kunaiFan.releaseAt + 1,
        ...(charged ? {} : { cancel: { fromTick: VESPER.kunaiFan.releaseAt + 1, into: CANCEL_AFTER_STRIKE } }),
      });
      begin(newAction(charged ? 'shade' : 'kunai', 0, target?.id ?? null));
      return true;
    },
    startTether(target) {
      if (distance2(host.player.position, target.position) > VESPER.severingShadow.range) {
        host.restoreMana(PLAYER_SKILLS.root_tether.manaCost);
        return false;
      }
      facePoint(target.position);
      const clip = clipOf('root_tether');
      host.beginAction({ id: clip, clip, totalTicks: VESPER.severingShadow.ticks, lockTicks: VESPER.severingShadow.strikeAt + 1 });
      begin(newAction('sever', 0, target.id));
      return true;
    },
    startUltimate() {
      const clip = clipOf('judgement');
      host.beginAction({ id: clip, clip, totalTicks: VESPER.requiem.ticks });
      host.setUntargetableUntil(host.tick + VESPER.requiem.ticks);
      begin(newAction('requiem'));
      return true;
    },

    update() {
      const s = state();
      decay(s);
      const current = s.action;
      if (!current) return;
      // Cancel windows (`beginAction.cancel`) route a cancelling input to a start method, which replaces the action wholesale.
      advance(s, current);
    },
    cancel() { abandon(state()); },
    reset() { /* The engine already emptied the kit state: no stacks, marks or action remain. */ },

    modifyStrike(target, incoming) {
      const s = state(), player = host.player;
      let damage = incoming.damage, stopTicks = incoming.stopTicks;
      const dx = player.position.x - target.position.x, dz = player.position.z - target.position.z;
      const away = Math.hypot(dx, dz), looking = Math.hypot(target.facing.x, target.facing.z);
      if (away > 1e-6 && looking > 1e-6 && (target.facing.x * dx + target.facing.z * dz) / (away * looking) < VESPER.backstab.dotThreshold) {
        damage = Math.round(damage * VESPER.backstab.multiplier);
      }
      if (s.marks[target.id] !== undefined) {
        delete s.marks[target.id];
        host.queueCue(cue('hit', 'hit', { targetId: target.id, position: host.chestOf(target), actionId: incoming.clip, intensity: 1.8, shape: 'burst', durationTicks: 12 }));
        damage += VESPER.deathMark.executionDamage;
        stopTicks = Math.max(stopTicks, VESPER.deathMark.executionHitStopTicks);
      }
      return damage === incoming.damage && stopTicks === incoming.stopTicks ? incoming : { ...incoming, damage, stopTicks };
    },
    afterStrike(target) {
      const s = state();
      if (target.downed) { forget(s, target.id); return; }
      const stacks = s.stacks[target.id] ??= [];
      stacks.push(VESPER.deathMark.stackWindowTicks);
      if (stacks.length >= VESPER.deathMark.stacksRequired) {
        delete s.stacks[target.id];
        s.marks[target.id] = VESPER.deathMark.markTicks;
      }
    },
    heroMarks(actorId) {
      const s = state(), marks: HeroMarkSnapshot[] = [];
      const stacks = s.stacks[actorId], mark = s.marks[actorId], requiem = s.requiem[actorId];
      if (stacks?.length) marks.push({ kind: 'death-stack', stacks: stacks.length, remainingTicks: Math.max(...stacks) });
      if (mark !== undefined) marks.push({ kind: 'death-mark', remainingTicks: mark });
      if (requiem !== undefined) marks.push({ kind: 'requiem-mark', remainingTicks: requiem });
      return marks.length > 0 ? marks : undefined;
    },
    onDodge() {
      // Mist Blink is a true blink: untouchable for its full iframe window, not only against the dodge profile's authored hazards.
      host.setUntargetableUntil(host.tick + VESPER.mistBlink.iframes);
    },
    onProjectileHit(projectile: LivePlayerProjectile, target: CombatActor) {
      const clip = (projectile.actionId ?? VESPER_CLIPS.sigil_bolt) as ActionId;
      if (projectile.callbackId === 'kunai') host.strikeHostile(target, strike('kunai', clip, projectile.damage, 'none', HIT_STOP.kunai, INSTINCT.kunai));
      else if (projectile.callbackId === 'shade-clone') host.strikeHostile(target, strike('sigil_barrage', clip, projectile.damage, 'idle', HIT_STOP.clone, INSTINCT.clone));
    },
  };
  return kit;
};
