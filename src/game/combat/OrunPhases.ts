import type { ActorId, CompanionId, OrunPresentationSnapshot, Vec3 } from '../contracts.js';
import type { AttackDefinition } from './content.js';
import { ATTACKS } from './content.js';
import type { CombatActor, CombatEvent, EngineState, LiveHazard } from './CombatEngine.js';
import type { OrunAspectCast, OrunState } from './ChapterCombat.js';
import { appendCue, type CueInput } from './EngineEffects.js';
import { FALL_POSSESSED_ATTACKS, FALL_POSSESSION_ATTACK_ID } from './FallProtection.js';
import { distance2, facingFrom, groundHeightAt, isCirclePathClear, isSupportedCapsulePose } from './geometry.js';
import { liveAttackOf } from './HitReactions.js';
import { ORUN_ASPECTS, ORUN_SKY_ECHO_IDS, ORUN_TUNING as T, ORUN_VINE_ROUTE, ORUN_WARDEN_ATTACKS, ORUN_WARDEN_ROTATION, type OrunAspect, type OrunWardenMove } from './OrunBossContent.js';
import { beginReaction, stunPlan } from './reactions.js';

/**
 * The live Heartroot Hollow duel (Bible ch. 8): one serializable state machine in `state.chapter.orun`, driven by the engine
 * through {@link OrunHost} each fixed step. Phase advancement, the Cleanse gate and every aspect answer come from real
 * engine evidence (hazard damage, interrupts, counter strikes, accepted companion support), never from authored facts.
 */
export interface OrunHost {
  readonly state: EngineState;
  emit(kind: CombatEvent['kind'], message: string, actorId?: ActorId, targetId?: ActorId): void;
  queueCue(cue: CueInput): void;
  /** Starts a telegraphed attack; `variant` keeps simultaneous hazards of one attack distinct, `target` picks the companion a grasp seizes. */
  beginAttack(source: CombatActor, def: AttackDefinition, aim?: Vec3, variant?: string, target?: CombatActor): LiveHazard | undefined;
  /** One swept body displacement (collision-checked against the arena); returns the metres moved. */
  displaceActor(actor: CombatActor, dx: number, dz: number): number;
  /** Clears the current phase (canonical `cleared`/`entered` events, threats cleared) and enters the next one. */
  advancePhase(): void;
  /** A recruit Orun holds attacks Aren with its own authored move (the Fall's possession machinery). */
  driveHeldAlly(ally: CombatActor): void;
  /** Rebuilds the traversal gates so a vine opened or withdrawn takes effect. */
  refreshTraversalGates(): void;
  /** The authored roost of a Sky echo. */
  echoHome(echoId: ActorId): Vec3 | undefined;
}

const PLAYER_RADIUS = 0.42;

export function createOrunState(): OrunState {
  return { shown: [], pressure: 0, cursor: 0, nextMoveAt: 0, dodgeReadyAt: 0, handspringReadyAt: 0, riposte: false, aspectIndex: 0, answered: [], casts: 0, coreOpenUntil: 0, moments: [], soloAnswers: 0 };
}

function bossOf(state: EngineState): CombatActor | undefined {
  return state.encounter ? state.actors.find(actor => actor.id === state.encounter!.bossId) : undefined;
}
function playerOf(state: EngineState): CombatActor | undefined { return state.actors.find(actor => actor.id === state.playerId); }
/** An instance id, or the one actor placed for an archetype (a projected party instance carries a suffixed id). */
function actorFor(state: EngineState, id: ActorId): CombatActor | undefined {
  const exact = state.actors.find(actor => actor.id === id);
  if (exact) return exact;
  const matches = state.actors.filter(actor => actor.archetypeId === id);
  return matches.length === 1 ? matches[0] : undefined;
}
function show(orun: OrunState, move: OrunWardenMove): void { if (!orun.shown.includes(move)) orun.shown.push(move); }
/** True on the one world tick an instant crosses (slow motion advances the world clock by fractions). */
function crossed(state: EngineState, at: number): boolean { return state.worldTick >= at && state.worldTick - state.worldTimeScale < at; }
function announce(host: OrunHost, boss: CombatActor, message: string): void {
  host.emit('cue', message, boss.id, host.state.playerId);
  host.queueCue({ kind: 'phase', phase: 'resolve', actorId: boss.id, targetId: host.state.playerId, position: { ...boss.position }, scopeId: host.state.encounterId, priority: 'essential', shape: 'pulse' });
}
function busy(state: EngineState, orun: OrunState, boss: CombatActor): boolean {
  return state.worldTick < boss.recoveringUntil || orun.evade !== undefined || state.telegraphs.some(telegraph => telegraph.sourceId === boss.id)
    || (boss.reactionState !== undefined && boss.reactionState.kind !== 'flinch');
}
function stun(state: EngineState, boss: CombatActor, ticks: number): void {
  beginReaction(boss, stunPlan(1, ticks), -boss.facing.x, -boss.facing.z, state.worldTick, false);
}

/** Per-tick Orun AI: the evasive body movement, then the current phase's choreography. Replaces the generic boss rotation. */
export function updateOrun(host: OrunHost): void {
  const state = host.state, orun = state.chapter.orun, boss = bossOf(state), player = playerOf(state);
  if (!orun || state.rewardEmitted || !boss || !player || boss.downed) return;
  stepEvade(host, orun, boss, player);
  if (state.phaseIndex === 0) updateWarden(host, orun, boss, player);
  else if (state.phaseIndex === 1) updateBeast(host, orun, boss, player);
  else updateCrown(host, orun, boss, player);
}

// ---- Phase 1: the Last Warden ------------------------------------------------------------------------------------------

function updateWarden(host: OrunHost, orun: OrunState, boss: CombatActor, player: CombatActor): void {
  const state = host.state, now = state.worldTick;
  // Pressure (counters landed, Warden attacks broken) ends the Warden, but only once his whole proactive arsenal has been shown;
  // the reactive families (Perfect Dodge with its Cartwheel Counter, Back Handspring) answer the hero whenever provoked.
  if (orun.pressure >= T.wardenPressure && ORUN_WARDEN_ROTATION.every(move => orun.shown.includes(move)) && !busy(state, orun, boss)) {
    announce(host, boss, 'The Last Warden breaks. The Heartroot answers him: the Crowned Beast rises.');
    host.advancePhase();
    return;
  }
  applySuppression(host, boss, 'orun-companion-suppression', () => true);
  if (busy(state, orun, boss) || now < orun.nextMoveAt) return;
  const distance = distance2(boss.position, player.position);
  if (distance <= T.crowdMetres && now >= orun.handspringReadyAt) {
    const hazard = host.beginAttack(boss, ATTACKS[ORUN_WARDEN_ATTACKS['back-handspring']]!);
    if (!hazard) return;
    const away = facingFrom({ x: boss.position.x - player.position.x, y: 0, z: boss.position.z - player.position.z });
    // The kick lands at the launch point; the flip then carries the body back over the following ticks.
    orun.evade = { move: 'back-handspring', dirX: away.x, dirZ: away.z, travel: T.handspringTravel, done: 0, fromTick: hazard.castUntil ?? hazard.activeUntil, toTick: (hazard.castUntil ?? hazard.activeUntil) + T.handspringTicks };
    orun.handspringReadyAt = now + T.handspringCooldownTicks;
    show(orun, 'back-handspring');
    orun.nextMoveAt = (hazard.recoveryUntil ?? hazard.activeUntil) + T.moveGapTicks;
    return;
  }
  const next = ORUN_WARDEN_ROTATION[orun.cursor % ORUN_WARDEN_ROTATION.length]!;
  const inReach = next === 'staff-combo' ? distance <= T.staffComboRange : next === 'root-tether' ? distance <= T.tetherRange : next === 'dive-roll' ? distance <= T.diveMaxRange : true;
  // Out of reach of the next family: close in with a Dive Roll (or reach out with the Ground Root Wave); that family stays next.
  const move = inReach ? next : distance <= T.diveMaxRange ? 'dive-roll' : 'root-wave';
  let aim: Vec3 | undefined;
  if (move === 'dive-roll') {
    // The roll goes past the hero's flank, alternating sides, not straight at the body.
    const axis = facingFrom({ x: player.position.x - boss.position.x, y: 0, z: player.position.z - boss.position.z }), side = Math.floor(now / 60) % 2 === 0 ? 1 : -1;
    aim = { x: player.position.x - axis.z * side * T.diveSideOffset, y: player.position.y, z: player.position.z + axis.x * side * T.diveSideOffset };
  }
  const hazard = host.beginAttack(boss, ATTACKS[ORUN_WARDEN_ATTACKS[move]]!, aim);
  if (!hazard) return;
  show(orun, move);
  if (inReach) orun.cursor++;
  orun.nextMoveAt = (hazard.recoveryUntil ?? hazard.activeUntil) + T.moveGapTicks;
}

/** Swept evasive body movement on the world clock; a finished Perfect Dodge starts the Cartwheel Counter riposte. */
function stepEvade(host: OrunHost, orun: OrunState, boss: CombatActor, player: CombatActor): void {
  const evade = orun.evade, state = host.state;
  if (!evade || state.worldTick < evade.fromTick) return;
  if (boss.reactionState && boss.reactionState.kind !== 'flinch') { orun.evade = undefined; orun.riposte = false; boss.velocity = { x: 0, y: 0, z: 0 }; return; }
  const u = Math.min(1, (state.worldTick - evade.fromTick) / Math.max(1e-6, evade.toTick - evade.fromTick));
  const want = evade.travel * u * u * (3 - 2 * u) - evade.done;
  if (want > 1e-4) {
    const moved = host.displaceActor(boss, evade.dirX * want, evade.dirZ * want), dt = Math.max(state.worldTimeScale, 1e-6) / 60;
    evade.done += moved;
    boss.velocity = { x: evade.dirX * moved / dt, y: 0, z: evade.dirZ * moved / dt };
    // A wall ends the flight early: the body never passes through it.
    if (moved < want * 0.5) evade.toTick = state.worldTick;
  }
  if (state.worldTick < evade.toTick) return;
  orun.evade = undefined;
  boss.velocity = { x: 0, y: 0, z: 0 };
  if (evade.move !== 'perfect-dodge' || !orun.riposte) return;
  orun.riposte = false;
  if (distance2(boss.position, player.position) > T.staffComboRange + 2) return;
  const hazard = host.beginAttack(boss, ATTACKS[ORUN_WARDEN_ATTACKS['cartwheel-counter']]!);
  if (!hazard) return;
  show(orun, 'cartwheel-counter');
  orun.nextMoveAt = (hazard.recoveryUntil ?? hazard.activeUntil) + T.moveGapTicks;
}

/**
 * Perfect Dodge: at the moment a hero's blow (not a counter) reaches an idle Warden, he slips it with a swept sidestep and answers
 * with the Cartwheel Counter. Bounded by its cooldown; a blow during the sidestep itself also misses. True when the blow misses.
 */
export function orunEvadesStrike(state: EngineState, target: CombatActor, counter: boolean): boolean {
  const orun = state.chapter.orun;
  if (!orun || state.rewardEmitted || state.phaseIndex !== 0 || target.id !== state.encounter?.bossId) return false;
  if (orun.evade?.move === 'perfect-dodge') return true;
  if (counter || state.worldTick < orun.dodgeReadyAt || orun.evade || liveAttackOf(state, target) || (target.reactionState && target.reactionState.kind !== 'flinch')) return false;
  const player = playerOf(state);
  if (!player) return false;
  const axis = facingFrom({ x: target.position.x - player.position.x, y: 0, z: target.position.z - player.position.z });
  let side = orun.cursor % 2 === 0 ? 1 : -1;
  const clear = (sign: number) => isCirclePathClear(state.arena, target.position, { x: target.position.x - axis.z * sign * T.dodgeTravel, y: target.position.y, z: target.position.z + axis.x * sign * T.dodgeTravel }, target.radius, target.collisionHeight);
  if (!clear(side)) side = -side;
  orun.evade = { move: 'perfect-dodge', dirX: -axis.z * side, dirZ: axis.x * side, travel: T.dodgeTravel, done: 0, fromTick: state.worldTick, toTick: state.worldTick + T.dodgeTicks };
  orun.riposte = true;
  orun.dodgeReadyAt = state.worldTick + T.dodgeCooldownTicks;
  show(orun, 'perfect-dodge');
  appendCue(state, { kind: 'perfect-dodge', phase: 'hit', actorId: target.id, targetId: player.id, position: { ...target.position }, scopeId: `${target.id}:perfect-dodge:${orun.dodgeReadyAt}`, priority: 'essential', shape: 'burst' });
  state.events.push({ id: `${state.runId}:combat:${state.tick}:${++state.eventSequence}`, tick: state.tick, kind: 'cue', message: 'Orun slips your blow. His counter is coming: dodge it, then punish.', actorId: target.id, targetId: player.id });
  return true;
}

/** Real pressure on the Last Warden: a counter strike that landed or an interrupted Warden attack. */
export function noteOrunPressure(state: EngineState, target: CombatActor): void {
  const orun = state.chapter.orun;
  if (orun && state.phaseIndex === 0 && target.id === state.encounter?.bossId && !state.rewardEmitted) orun.pressure++;
}

// ---- Phase 2: the Crowned Beast ----------------------------------------------------------------------------------------

function updateBeast(host: OrunHost, orun: OrunState, boss: CombatActor, player: CombatActor): void {
  const state = host.state, now = state.worldTick;
  if (now < orun.coreOpenUntil) return;
  if (orun.cast) { advanceCast(host, orun, orun.cast, boss, player); return; }
  if (busy(state, orun, boss) || now < orun.nextMoveAt) return;
  startAspect(host, orun, ORUN_ASPECTS[orun.aspectIndex % ORUN_ASPECTS.length]!, boss, player);
}

function startAspect(host: OrunHost, orun: OrunState, aspect: OrunAspect, boss: CombatActor, player: CombatActor): void {
  const state = host.state, p = player.position;
  const axis = facingFrom({ x: p.x - boss.position.x, y: 0, z: p.z - boss.position.z }), lateral = { x: -axis.z, z: axis.x };
  const cast: OrunAspectCast = { aspect, hazardIds: [], hit: false };
  const add = (hazard: LiveHazard | undefined) => { if (hazard) cast.hazardIds.push(hazard.id); };
  switch (aspect) {
    case 'sky': {
      add(host.beginAttack(boss, ATTACKS['orun-sky-aspect']!));
      const dive = ATTACKS['orun-sky-dive']!;
      ORUN_SKY_ECHO_IDS.forEach((echoId, index) => {
        const echo = state.actors.find(actor => actor.id === echoId);
        if (!echo) return;
        const angle = (index - 1) * 0.6, dirX = -axis.x * Math.cos(angle) + axis.z * Math.sin(angle), dirZ = -axis.z * Math.cos(angle) - axis.x * Math.sin(angle);
        const x = p.x + dirX * T.skyEchoDistance, z = p.z + dirZ * T.skyEchoDistance, y = groundHeightAt(state.arena, x, z, p.y);
        if (y === null || !isSupportedCapsulePose(state.arena, { x, y, z }, echo.radius, echo.collisionHeight)) return;
        // The shadow echo condenses out of the Heartroot at its dive start; it is hidden again when the aspect ends.
        echo.position = { x, y, z };
        echo.visible = true;
        echo.allegiance = 'neutral';
        const offset = (index - 1) * T.skyLaneSpacing;
        const aim = { x: p.x + lateral.x * offset, y: p.y, z: p.z + lateral.z * offset };
        add(host.beginAttack(echo, { ...dive, windupTicks: dive.windupTicks + index * T.skyStaggerTicks }, aim));
      });
      break;
    }
    case 'canopy':
      add(host.beginAttack(boss, ATTACKS['orun-canopy-root']!, { x: p.x + lateral.x * T.canopyFlankOffset, y: p.y, z: p.z + lateral.z * T.canopyFlankOffset }, 'left'));
      add(host.beginAttack(boss, ATTACKS['orun-canopy-root']!, { x: p.x - lateral.x * T.canopyFlankOffset, y: p.y, z: p.z - lateral.z * T.canopyFlankOffset }, 'right'));
      add(host.beginAttack(boss, ATTACKS['orun-canopy-aspect']!, { ...p }));
      break;
    case 'fang':
      add(host.beginAttack(boss, ATTACKS['orun-fang-aspect']!));
      break;
    case 'pack': {
      // Rows at five depth bands along the beast's line to the hero, one band left open: the only safe ground under the rows.
      const gap = orun.casts % 2 === 0 ? 1 : -1;
      for (let band = -2; band <= 2; band++) {
        if (band === gap) continue;
        add(host.beginAttack(boss, ATTACKS['orun-pack-aspect']!, { x: p.x + axis.x * band * T.packBandSpacing, y: p.y, z: p.z + axis.z * band * T.packBandSpacing }, `band${band + 2}`));
      }
      const gx = p.x + axis.x * gap * T.packBandSpacing, gz = p.z + axis.z * gap * T.packBandSpacing;
      cast.gap = { x: gx, y: groundHeightAt(state.arena, gx, gz, p.y) ?? p.y, z: gz };
      cast.gapRevealed = false;
      break;
    }
    case 'shadow': {
      const veil = host.beginAttack(boss, ATTACKS['orun-shadow-aspect']!);
      add(veil);
      if (veil) { cast.coreFrom = veil.castUntil ?? veil.activeUntil; cast.coreUntil = cast.coreFrom + T.shadowCoreTicks; cast.coreStruck = false; }
      break;
    }
    case 'crown':
      add(host.beginAttack(boss, ATTACKS['orun-crown-aspect']!));
      break;
  }
  if (!cast.hazardIds.length) return;
  orun.cast = cast;
  orun.casts++;
}

function advanceCast(host: OrunHost, orun: OrunState, cast: OrunAspectCast, boss: CombatActor, player: CombatActor): void {
  const state = host.state, tick = state.worldTick;
  const live = cast.hazardIds.map(id => state.hazards.find(hazard => hazard.id === id)).filter((hazard): hazard is LiveHazard => hazard !== undefined && tick < hazard.activeUntil);
  if (cast.aspect === 'canopy' && cast.koroVine && !cast.vine) openVine(host, cast, boss, player, live);
  if (cast.aspect === 'sky' && !cast.varaWarned) warnDives(host, cast, boss, live);
  if (cast.aspect === 'crown') {
    if (cast.solkarRally && live.length && live.every(hazard => tick < hazard.activeFrom)) {
      cancelCast(host, cast);
      host.emit('companion', 'Solkar roars back against the Crown. The Dominion Roar breaks.', actorFor(state, 'solkar' as ActorId)?.id, boss.id);
      return;
    }
    applySuppression(host, boss, 'orun-crown-aspect', id => bondOf(state, id) < T.highBond);
  }
  if (cast.aspect === 'shadow' && cast.coreFrom !== undefined && tick >= cast.coreFrom && tick < cast.coreUntil! && (boss.weakPointUntil ?? 0) < cast.coreUntil!) {
    boss.weakPointUntil = cast.coreUntil;
    host.queueCue({ kind: 'heartbeat', phase: 'sustain', actorId: boss.id, targetId: state.playerId, position: { ...boss.position }, scopeId: `${state.encounterId}:shadow-core`, durationTicks: Math.ceil(cast.coreUntil! - tick), priority: 'essential', shape: 'pulse' });
  }
  if (live.length || (cast.aspect === 'shadow' && tick < (cast.coreUntil ?? 0) && !cast.coreStruck) || state.traversal?.gate.id === ORUN_VINE_ROUTE.id) return;
  finishCast(host, orun, cast, boss);
}

/**
 * Vara's mark on the beast lets her call the Sky dives: every dive still winding up commits later (its whole timeline, swept
 * body charge included, shifts by the warning), so its lane reads longer. Committed dives stay committed.
 */
function warnDives(host: OrunHost, cast: OrunAspectCast, boss: CombatActor, live: readonly LiveHazard[]): void {
  const state = host.state, mark = boss.markState;
  const vara = mark && state.worldTick < mark.untilWorldTick ? actorFor(state, mark.sourceId) : undefined;
  if (vara?.archetypeId !== 'vara') return;
  cast.varaWarned = true;
  const ticks = T.varaWarningTicks;
  for (const hazard of live) {
    if (hazard.attackId !== 'orun-sky-dive' || state.worldTick >= (hazard.windupUntil ?? hazard.activeFrom)) continue;
    hazard.windupUntil = (hazard.windupUntil ?? hazard.activeFrom) + ticks;
    hazard.activeFrom += ticks; hazard.activeUntil += ticks;
    if (hazard.castUntil !== undefined) hazard.castUntil += ticks;
    if (hazard.recoveryUntil !== undefined) hazard.recoveryUntil += ticks;
    hazard.threatTicks = hazard.threatTicks.map(at => at + ticks);
    for (const lunge of state.bossLunges) if (lunge.hazardId === hazard.id) { lunge.fromTick += ticks; lunge.toTick += ticks; }
    const echo = state.actors.find(actor => actor.id === hazard.sourceId);
    if (echo) { echo.recoveringUntil += ticks; echo.actionEndsTick += ticks; }
  }
  host.emit('companion', 'Vara calls the dive lanes early: read them and step between.', vara.id, boss.id);
}

/** Every hazard of the cast closes now (an interrupt or Solkar's counter): nothing more lands from it. */
function cancelCast(host: OrunHost, cast: OrunAspectCast): void {
  const state = host.state;
  for (const id of cast.hazardIds) {
    const hazard = state.hazards.find(candidate => candidate.id === id);
    if (!hazard || state.worldTick >= hazard.activeUntil) continue;
    hazard.activeUntil = hazard.castUntil = hazard.recoveryUntil = state.worldTick;
    host.queueCue({ kind: 'cancel', phase: 'resolve', scopeId: id, cancellationReason: 'interrupt' });
  }
  state.telegraphs = state.telegraphs.filter(telegraph => !cast.hazardIds.includes(telegraph.id));
  state.bossLunges = state.bossLunges.filter(lunge => !cast.hazardIds.includes(lunge.hazardId));
}

function finishCast(host: OrunHost, orun: OrunState, cast: OrunAspectCast, boss: CombatActor): void {
  const state = host.state;
  orun.cast = undefined;
  hideEchoes(host);
  if (cast.vine) host.refreshTraversalGates();
  const answered = !cast.hit && (cast.aspect !== 'shadow' || cast.coreStruck === true);
  orun.nextMoveAt = state.worldTick + T.aspectGapTicks;
  if (state.phaseIndex === 2) {
    if (!answered) return;
    orun.soloAnswers++;
    if (orun.soloAnswers >= T.soloCounters) openCore(host, orun, boss, 'The Crown core is open. Cleanse it.');
    return;
  }
  if (!answered) { host.emit('cue', `The ${cast.aspect} aspect returns. Answer it without taking its blow.`, boss.id); return; }
  if (!orun.answered.includes(cast.aspect)) orun.answered.push(cast.aspect);
  orun.aspectIndex = nextAspectIndex(orun);
  host.emit('cue', `The ${cast.aspect} aspect is answered (${orun.answered.length}/6).`, boss.id);
  if (orun.answered.length === ORUN_ASPECTS.length) openCore(host, orun, boss, 'All six aspects answered: the beast core is open. Cleanse it.');
}
function nextAspectIndex(orun: OrunState): number {
  for (let step = 1; step <= ORUN_ASPECTS.length; step++) {
    const index = (orun.aspectIndex + step) % ORUN_ASPECTS.length;
    if (!orun.answered.includes(ORUN_ASPECTS[index]!)) return index;
  }
  return (orun.aspectIndex + 1) % ORUN_ASPECTS.length;
}
function openCore(host: OrunHost, orun: OrunState, boss: CombatActor, message: string): void {
  const state = host.state;
  orun.coreOpenUntil = state.worldTick + T.coreOpenTicks;
  boss.weakPointUntil = Math.max(boss.weakPointUntil ?? 0, orun.coreOpenUntil);
  stun(state, boss, T.coreOpenTicks);
  announce(host, boss, message);
}

function hideEchoes(host: OrunHost): void {
  for (const echoId of ORUN_SKY_ECHO_IDS) {
    const echo = host.state.actors.find(actor => actor.id === echoId);
    if (!echo || !echo.visible) continue;
    echo.visible = false;
    echo.velocity = { x: 0, y: 0, z: 0 };
    const home = host.echoHome(echoId);
    if (home) echo.position = { ...home };
  }
}

/** Koro's accepted support throws a vine over the flank root: a transient swing route from where Aren stands to safe ground. */
function openVine(host: OrunHost, cast: OrunAspectCast, boss: CombatActor, player: CombatActor, live: readonly LiveHazard[]): void {
  const state = host.state, p = player.position;
  const axis = facingFrom({ x: p.x - boss.position.x, y: 0, z: p.z - boss.position.z });
  for (const side of [1, -1]) {
    const x = p.x - axis.z * side * T.canopySwingOffset, z = p.z + axis.x * side * T.canopySwingOffset, y = groundHeightAt(state.arena, x, z, p.y);
    if (y === null || Math.abs(y - p.y) > 0.35) continue;
    const to = { x, y, z };
    if (!isSupportedCapsulePose(state.arena, to, PLAYER_RADIUS, player.collisionHeight)) continue;
    if (live.some(hazard => distance2(hazard.target, to) <= Math.max(hazard.width, hazard.depth) / 2 + PLAYER_RADIUS)) continue;
    cast.vine = { from: { ...p }, to, anchors: [{ x: (p.x + x) / 2, y: p.y + 2.6, z: (p.z + z) / 2 }] };
    host.refreshTraversalGates();
    host.emit('companion', 'Koro throws a vine over the roots. Swing clear (Interact).', actorFor(state, 'koro' as ActorId)?.id, player.id);
    return;
  }
  cast.koroVine = false;
}

/** The live Canopy vine route, if Koro opened one (consumed by the engine's traversal gates). */
export function orunVineRoute(state: EngineState): { from: Vec3; to: Vec3; anchors: readonly Vec3[] } | undefined {
  return state.chapter.orun?.cast?.vine;
}

/** Suppression lands on the tick its attack turns active: present companions within reach lose command and support for a while. */
function applySuppression(host: OrunHost, boss: CombatActor, attackId: string, binds: (id: CompanionId) => boolean): void {
  const state = host.state;
  const hazard = state.hazards.find(candidate => candidate.sourceId === boss.id && candidate.attackId === attackId);
  if (!hazard || !crossed(state, hazard.activeFrom)) return;
  const bound: string[] = [];
  for (const [id, slot] of Object.entries(state.companionState.slots) as [CompanionId, NonNullable<EngineState['companionState']['slots'][CompanionId]>][]) {
    const actor = actorFor(state, id);
    if (!slot || !actor || !actor.visible || actor.downed || actor.possessed || distance2(actor.position, boss.position) > T.suppressRadius || !binds(id)) continue;
    slot.suppressedUntil = Math.max(slot.suppressedUntil ?? 0, state.worldTick + T.suppressTicks);
    bound.push(id);
  }
  if (bound.length) host.emit('companion', `Orun binds ${bound.join(' and ')}: commands and support are held.`, boss.id);
}

function bondOf(state: EngineState, id: CompanionId): number { return state.companionState.progress?.[id]?.bondLevel ?? state.companionState.bond; }
function dominionOf(state: EngineState, id: CompanionId): number { return state.companionState.progress?.[id]?.dominionLevel ?? 0; }

/** A cast hazard damaged the hero: that aspect (or phase-3 attack) is not answered. */
export function noteOrunHazardDamage(state: EngineState, hazardId: string): void {
  const cast = state.chapter.orun?.cast;
  if (cast?.hazardIds.includes(hazardId)) cast.hit = true;
}
/** A blow that landed on the beast during the Shadow core window found the true core. */
export function noteOrunCoreStrike(state: EngineState, target: CombatActor): void {
  const cast = state.chapter.orun?.cast;
  if (cast?.aspect === 'shadow' && target.id === state.encounter?.bossId && cast.coreFrom !== undefined && state.worldTick >= cast.coreFrom && state.worldTick < cast.coreUntil!) cast.coreStruck = true;
}
/** An interrupt landed on Orun: phase-1 pressure, or the whole live aspect cast closes unanswered-by-damage. */
export function onOrunInterrupted(host: OrunHost, source: CombatActor): void {
  const state = host.state, orun = state.chapter.orun;
  if (!orun || source.id !== state.encounter?.bossId) return;
  if (state.phaseIndex === 0) { orun.pressure++; return; }
  if (orun.cast) cancelCast(host, orun.cast);
}

/**
 * The aspect counter of an accepted, completed companion support on the beast (CompanionSystem `applySupport`). Returns the
 * companion event message when the support answered a live aspect, undefined to leave the ordinary support untouched.
 */
export function orunAspectSupport(state: EngineState, actor: CombatActor, target: CombatActor): string | undefined {
  const orun = state.chapter.orun, cast = orun?.cast;
  if (!orun || !cast || target.id !== state.encounter?.bossId || state.rewardEmitted) return undefined;
  const live = cast.hazardIds.some(id => { const hazard = state.hazards.find(candidate => candidate.id === id); return hazard !== undefined && state.worldTick < hazard.activeUntil; });
  switch (actor.archetypeId) {
    case 'koro':
      if (cast.aspect !== 'canopy' || !live || cast.koroVine) return undefined;
      cast.koroVine = true;
      return 'Vine Route';
    case 'sable':
      if (cast.aspect !== 'pack' || !live || cast.gapRevealed) return undefined;
      cast.gapRevealed = true;
      return 'Pack Gap';
    case 'nyra':
      if (cast.aspect !== 'shadow' || cast.coreStruck) return undefined;
      // Nyra stalks through the fog to the true core and holds it open.
      cast.coreFrom = state.worldTick;
      cast.coreUntil = state.worldTick + T.nyraRevealTicks;
      cast.coreStruck = true;
      target.weakPointUntil = Math.max(target.weakPointUntil ?? 0, cast.coreUntil);
      return 'True Core';
    case 'solkar': {
      if (cast.aspect !== 'crown' || !live || cast.solkarRally) return undefined;
      if (bondOf(state, 'solkar') < T.highBond) return 'Solkar bows to the Dominion Roar';
      cast.solkarRally = true;
      return 'Crown Resisted';
    }
    default: return undefined;
  }
}

// ---- Phase 3: the Choice of the Crown ----------------------------------------------------------------------------------

/** Only the equipped, recruited companion can be seized; Vara's authored moment remains her mark. */
function graspable(state: EngineState, orun: OrunState): CombatActor[] {
  const roster = state.companionState, id = roster.companionId;
  if (!id || !FALL_POSSESSED_ATTACKS[id] || orun.moments.includes(id) || (roster.progress && !roster.progress[id]?.recruited)) return [];
  const actor = actorFor(state, id);
  return actor?.visible && !actor.downed ? [actor] : [];
}

function updateCrown(host: OrunHost, orun: OrunState, boss: CombatActor, player: CombatActor): void {
  const state = host.state, tick = state.worldTick;
  if (tick < orun.coreOpenUntil) return;
  const held = state.actors.find(actor => actor.possessed && actor.possessionSourceId === boss.id);
  if (held) { host.driveHeldAlly(held); return; }
  if (orun.cast) { advanceCast(host, orun, orun.cast, boss, player); return; }
  if (busy(state, orun, boss) || tick < orun.nextMoveAt) return;
  const candidates = graspable(state, orun);
  if (candidates.length) {
    const target = candidates[orun.cursor % candidates.length]!;
    const hazard = host.beginAttack(boss, ATTACKS[FALL_POSSESSION_ATTACK_ID]!, undefined, undefined, target);
    if (!hazard) return;
    orun.cursor++;
    orun.nextMoveAt = (hazard.recoveryUntil ?? hazard.activeUntil) + T.moveGapTicks;
    return;
  }
  if (orun.moments.length) { openCore(host, orun, boss, 'Every bond has answered. The Crown core is open: Cleanse it.'); return; }
  // No recruit to seize: Orun turns the Crown and the Fang on Aren himself; answering them opens the core.
  startAspect(host, orun, orun.casts % 2 === 0 ? 'crown' : 'fang', boss, player);
}

/** Bond resists the Crown: a recruit at the Bond threshold whose Bond outweighs its Dominion throws the grasp off at once. */
export function orunGraspResisted(state: EngineState, actor: CombatActor): boolean {
  const orun = state.chapter.orun;
  if (!orun || state.phaseIndex !== 2) return false;
  const id = actor.archetypeId as CompanionId, bond = bondOf(state, id);
  return bond >= T.highBond && bond >= dominionOf(state, id);
}

/** A held (or resisting) recruit is free again: its approach-to-core moment staggers the beast and exposes the core. */
export function onOrunPossessionEnded(host: OrunHost, actor: CombatActor): void {
  const state = host.state, orun = state.chapter.orun, boss = bossOf(state);
  if (!orun || !boss || state.phaseIndex !== 2 || state.rewardEmitted) return;
  const id = actor.archetypeId as CompanionId;
  if (orun.moments.includes(id)) return;
  orun.moments.push(id);
  boss.weakPointUntil = Math.max(boss.weakPointUntil ?? 0, state.worldTick + T.momentTicks);
  stun(state, boss, T.momentTicks);
  host.emit('companion', `${id[0]!.toUpperCase()}${id.slice(1)} breaks the Crown's hold and drives at the core.`, actor.id, boss.id);
  host.queueCue({ kind: 'bond', phase: 'hit', actorId: actor.id, targetId: boss.id, position: { ...boss.position }, scopeId: `${state.encounterId}:moment:${id}`, priority: 'essential', shape: 'burst' });
}

// ---- Cleanse, presentation and lifecycle -------------------------------------------------------------------------------

/** Why a Cleanse on Orun must wait, or null while a core is genuinely open. */
export function orunCleanseBlock(state: EngineState, target: CombatActor): string | null {
  const orun = state.chapter.orun;
  if (!orun || target.id !== state.encounter?.bossId || state.worldTick < orun.coreOpenUntil) return null;
  if (state.phaseIndex === 0) return 'The Last Warden’s corruption is sealed: break his guard first.';
  if (state.phaseIndex === 1) return 'The beast core is sealed: answer all six aspects.';
  return 'The Crown core is sealed: break Orun’s hold on your companions first.';
}
/** A Cleanse eased one of Orun's cores; the beast core opens the Choice of the Crown (the final core resolves the encounter). */
export function onOrunCleansed(host: OrunHost, target: CombatActor): void {
  const state = host.state, orun = state.chapter.orun;
  if (!orun || target.id !== state.encounter?.bossId) return;
  orun.coreOpenUntil = 0;
  target.reactionState = undefined;
  if (state.phaseIndex === 1 && (target.corruption ?? 0) > 0) host.advancePhase();
}
/** Resets the per-phase choreography when a phase begins. */
export function enterOrunPhase(state: EngineState): void {
  const orun = state.chapter.orun;
  if (!orun) return;
  orun.evade = undefined;
  orun.riposte = false;
  orun.cast = undefined;
  orun.cursor = 0;
  orun.nextMoveAt = state.worldTick + T.aspectGapTicks;
}

/** The `CombatSnapshot.orun` part: present only while the Hollow duel runs. */
export function orunSnapshot(state: EngineState): { orun?: OrunPresentationSnapshot } {
  const orun = state.chapter.orun, phase = state.encounter?.phases[state.phaseIndex];
  if (!orun || !phase) return {};
  const tick = state.worldTick, cast = orun.cast;
  const shadowCore = cast?.aspect === 'shadow' && cast.coreFrom !== undefined && tick >= cast.coreFrom && tick < cast.coreUntil!;
  const packLive = cast?.aspect === 'pack' && cast.hazardIds.some(id => { const hazard = state.hazards.find(candidate => candidate.id === id); return hazard !== undefined && tick < hazard.activeUntil; });
  const suppressed: CompanionId[] = [];
  for (const slot of Object.values(state.companionState.slots)) if (slot && (slot.suppressedUntil ?? 0) > tick) suppressed.push(slot.companionId);
  return { orun: {
    phase: phase.id as OrunPresentationSnapshot['phase'],
    ...(cast ? { aspect: cast.aspect } : {}),
    fog: cast?.aspect === 'shadow',
    coreExposed: tick < orun.coreOpenUntil || shadowCore,
    ...(packLive && cast!.gapRevealed && cast!.gap ? { safeGap: { ...cast!.gap } } : {}),
    suppressedCompanionIds: suppressed,
  } };
}

/** A checkpoint retry: live hazards are gone, so the live cast and evade end; world-clock deadlines follow the rebased clock. */
export function resetOrunForCheckpoint(state: EngineState, worldOffset: number): void {
  const orun = state.chapter.orun;
  if (!orun) return;
  const shift = (deadline: number) => deadline === 0 ? 0 : deadline + worldOffset;
  orun.nextMoveAt = shift(orun.nextMoveAt);
  orun.dodgeReadyAt = shift(orun.dodgeReadyAt);
  orun.handspringReadyAt = shift(orun.handspringReadyAt);
  orun.coreOpenUntil = shift(orun.coreOpenUntil);
  orun.evade = undefined;
  orun.riposte = false;
  orun.cast = undefined;
}
