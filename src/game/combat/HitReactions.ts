import type { ActorSnapshot } from '../contracts.js';
import type { CombatActor, EngineState, LiveHazard } from './CombatEngine.js';
import { appendCue } from './EngineEffects.js';
import { BOSS_POISE, REACTION_RANK, beginReaction, buildOf, isCommitted, planHostileReaction, reactionStrength, stunPlan, type ActorBuild, type HitSpec } from './reactions.js';

/** The newest hazard of `actor` that has not finished its recovery. */
export function liveAttackOf(state: EngineState, actor: CombatActor): LiveHazard | undefined {
  let latest: LiveHazard | undefined;
  for (const hazard of state.hazards) {
    if (hazard.sourceId !== actor.id || state.worldTick >= (hazard.recoveryUntil ?? hazard.activeUntil)) continue;
    if (!latest || hazard.startTick > latest.startTick) latest = hazard;
  }
  return latest;
}

/** Monster attack phase derived from its newest live hazard; `time` is the composite normalized clip time (windup .5, commit .12, active .24, recovery .14). */
export function monsterAttackProgress(state: EngineState, actor: CombatActor): { phase: NonNullable<ActorSnapshot['attackPhase']>; progress: number; time: number } | undefined {
  if (actor.id === state.playerId) return undefined;
  const hazard = liveAttackOf(state, actor);
  if (!hazard) return undefined;
  const windupEnd = hazard.windupUntil ?? hazard.activeFrom;
  const castEnd = hazard.castUntil ?? hazard.activeUntil;
  const recoveryEnd = hazard.recoveryUntil ?? castEnd;
  const tick = state.worldTick;
  if (tick < windupEnd) { const progress = Math.max(0, tick - hazard.startTick) / Math.max(1, windupEnd - hazard.startTick); return { phase: 'windup', progress, time: 0.5 * progress }; }
  if (tick < hazard.activeFrom) { const progress = (tick - windupEnd) / Math.max(1, hazard.activeFrom - windupEnd); return { phase: 'commit', progress, time: 0.5 + 0.12 * progress }; }
  if (tick < castEnd) { const progress = (tick - hazard.activeFrom) / Math.max(1, castEnd - hazard.activeFrom); return { phase: 'active', progress, time: 0.62 + 0.24 * progress }; }
  const progress = Math.min(1, (tick - castEnd) / Math.max(1, recoveryEnd - castEnd));
  return { phase: 'recovery', progress, time: Math.min(1, 0.86 + 0.14 * progress) };
}

/** True for the encounter's boss (never a wildlife-family monster or a trial stage). */
export function isBossActor(state: EngineState, actor: CombatActor): boolean {
  const encounter = state.encounter;
  return !state.combatTrial && !!encounter && encounter.encounterFamily !== 'wildlife' && encounter.bossId === actor.id;
}
export function buildOfActor(state: EngineState, actor: CombatActor): ActorBuild {
  return buildOf(actor.id, actor.radius, isBossActor(state, actor), actor.poiseBreaks ?? 0);
}
/** Super-armour: a monster ignores physical reactions while its attack is committed (bosses from the commit, everyone else in the active swing). */
export function isArmoured(state: EngineState, actor: CombatActor): boolean {
  const attack = monsterAttackProgress(state, actor);
  return attack !== undefined && (attack.phase === 'active' || attack.phase === 'commit' && isBossActor(state, actor));
}

/**
 * A blow from a companion on a hostile, under the same poise, mass and super-armour rules as a hero's blow. The reaction is
 * started pending: the engine runs its start cue and attack cancel on the next reaction update, exactly as for any reaction.
 */
export function reactToCompanionHit(state: EngineState, target: CombatActor, spec: HitSpec, dirX: number, dirZ: number): void {
  if (target.anchored || spec.inert || target.downed) return;
  const build = buildOfActor(state, target), committed = target.reactionState !== undefined && isCommitted(target.reactionState.kind), armoured = isArmoured(state, target);
  const poiseDamage = spec.stun ? build.boss ? build.poiseMax * BOSS_POISE.controlFraction : build.poiseMax : spec.poise;
  const meter = Math.min(build.poiseMax, (target.poiseMeter ?? 0) + (committed ? 0 : poiseDamage));
  if (!committed) { target.poiseMeter = meter; target.poiseHitAt = state.worldTick; }
  const broken = !committed && meter >= build.poiseMax - 1e-9;
  const strength = reactionStrength(spec.weight, spec.poise, build.poiseMax);
  const plan = planHostileReaction(spec, build.mass, strength, armoured);
  const current = target.reactionState;
  if (broken && !armoured) {
    const chosen = !spec.stun && plan && REACTION_RANK[plan.kind] > REACTION_RANK.stun ? plan : stunPlan(strength, build.stunTicks);
    if (current && (isCommitted(current.kind) || REACTION_RANK[current.kind] > REACTION_RANK[chosen.kind])) return;
    appendCue(state, { kind: 'poise-break', phase: 'hit', actorId: target.id, targetId: target.id, scopeId: `${target.id}:reaction:${(target.reactionSerial ?? 0) + 1}`, position: { ...target.position }, to: { x: target.position.x + dirX, y: target.position.y, z: target.position.z + dirZ }, reactionKind: chosen.kind, intensity: strength, priority: 'essential', shape: 'burst' });
    target.poiseBreaks = (target.poiseBreaks ?? 0) + 1;
    if (chosen.kind !== 'stun') target.poiseMeter = 0;
    beginReaction(target, chosen, dirX, dirZ, state.worldTick, false);
    return;
  }
  if (!plan) return;
  // A boss loses an attack to a poise break or an authored interrupt, never to a plain stagger.
  const applied = build.boss && plan.kind !== 'flinch' ? { ...plan, cancelsAttack: false } : plan;
  if (current && (isCommitted(current.kind) || REACTION_RANK[current.kind] > REACTION_RANK[applied.kind])) return;
  beginReaction(target, applied, dirX, dirZ, state.worldTick, false);
}
