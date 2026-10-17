import type { ActorId, ChapterPresentationStatus, RegionDefinition, WorldEvent } from '../contracts.js';
import type { StoryCue } from '../../effects/story-cues.js';
import type { AttackDefinition, BossEncounterDefinition } from './content.js';
import type { CombatActor, CombatEvent, EngineState, LiveHazard } from './CombatEngine.js';
import { ACT_ONE_ATTACKS, ASHA_SEQUENCE, KORO_SEQUENCE } from './ActOneBossContent.js';
import type { BossSequenceState } from './ChapterCombat.js';
import { facingFrom } from './geometry.js';
import { beginReaction, stunPlan } from './reactions.js';

type CueInput = Omit<StoryCue, 'instanceId' | 'tick' | 'worldTick' | 'worldTimeSeconds'>;

/** The engine services the Act I boss sequences need; implemented by `CombatEngine` (like `KitHost` for hero kits). */
export interface ChapterHost {
  readonly state: EngineState;
  emit(kind: CombatEvent['kind'], message: string, actorId?: ActorId, targetId?: ActorId): void;
  emitWorldEvent(event: WorldEvent): boolean;
  queueCue(cue: CueInput): void;
  beginAttack(source: CombatActor, def: AttackDefinition, aim?: { x: number; y: number; z: number }): LiveHazard | undefined;
  cancelLiveAttack(source: CombatActor, action: string): void;
  /** Cancels every live boss hazard, telegraph, committed lunge and combat obstacle with interrupt cues. */
  clearBossThreats(): void;
  /** Returns an encounter-resettable movable object to rest. */
  resetMovableObject(objectId: string): void;
}

export type SequenceAttack = 'hold' | 'started' | 'default';

export function sequenceOf(state: EngineState): BossSequenceState | undefined { return state.chapter.sequence; }

/** Creates the sequence of `encounter` for a freshly started encounter (undefined when the boss has none). */
export function initSequence(encounter: BossEncounterDefinition, region: RegionDefinition): BossSequenceState | undefined {
  if (!encounter.sequence) return undefined;
  const base = { until: 0, dangerRemaining: 0, attackCursor: 0, shelterHazardIds: [] as string[], landedCharges: 0 };
  if (encounter.sequence === 'koro-thorn') return { kind: 'koro-thorn', step: 'sealed', ...base };
  const arena = region.navigation.nodes.find(node => node.id === ASHA_SEQUENCE.arenaNodeId);
  const shelter = region.navigation.nodes.find(node => node.id === ASHA_SEQUENCE.shelterNodeId);
  if (!arena || !shelter) throw new Error(`Encounter ${encounter.id} needs the authored nav nodes ${ASHA_SEQUENCE.arenaNodeId} and ${ASHA_SEQUENCE.shelterNodeId} in ${region.id}`);
  return { kind: 'asha-cub', step: 'stalking', ...base, shelter: { ...shelter.position }, arenaCenter: { ...arena.position } };
}

export function updateSequence(host: ChapterHost): void {
  const state = host.state, seq = state.chapter.sequence;
  if (!seq || state.rewardEmitted || !state.encounter) return;
  const boss = state.actors.find(actor => actor.id === state.encounter!.bossId);
  if (!boss) return;
  if (seq.kind === 'koro-thorn') updateKoro(host, seq, boss);
  else updateAsha(host, seq, boss);
}

function announce(host: ChapterHost, boss: CombatActor, message: string): void {
  host.emit('cue', message, boss.id);
  host.queueCue({ kind: 'phase', phase: 'resolve', actorId: boss.id, targetId: host.state.playerId, position: { ...boss.position }, scopeId: host.state.encounterId, priority: 'essential', shape: 'pulse' });
}
function stun(host: ChapterHost, boss: CombatActor, ticks: number): void {
  const away = facingFrom({ x: -boss.facing.x, y: 0, z: -boss.facing.z });
  beginReaction(boss, stunPlan(1, ticks), away.x, away.z, host.state.worldTick, false);
}

function updateKoro(host: ChapterHost, seq: BossSequenceState, boss: CombatActor): void {
  const state = host.state;
  if (seq.step === 'sealed' && state.phaseIndex >= 1 && (boss.ferocity ?? 100) <= KORO_SEQUENCE.thornExposeFerocity) {
    seq.step = 'thorn-exposed';
    announce(host, boss, 'Koro’s shoulder thorn is exposed. Tether his next move, then cleanse the thorn.');
  } else if (seq.step === 'tethered' && state.worldTick >= seq.until) {
    seq.step = 'thorn-exposed';
    host.emit('cue', 'The tether slips; the thorn is still exposed. Tether Koro again.', boss.id);
  }
}

function updateAsha(host: ChapterHost, seq: BossSequenceState, boss: CombatActor): void {
  const state = host.state, now = state.worldTick;
  if (seq.step === 'stalking' && state.phaseIndex >= 1) seq.step = 'rage';
  if (seq.step === 'rage' && state.phaseIndex >= 2) beginAnnounce(host, seq, boss);
  else if (seq.step === 'announce' && now >= seq.until) seq.step = 'danger';
  else if (seq.step === 'danger') updateDanger(host, seq, boss);
  else if ((seq.step === 'exposed' || seq.step === 'tethered') && now >= seq.until) resumeDanger(host, seq, boss);
}

function beginAnnounce(host: ChapterHost, seq: BossSequenceState, boss: CombatActor): void {
  const state = host.state;
  host.clearBossThreats();
  seq.step = 'announce';
  seq.until = state.worldTick + ASHA_SEQUENCE.announceTicks;
  seq.dangerRemaining = ASHA_SEQUENCE.dangerTicks;
  seq.taliStatus = 'in-danger';
  announce(host, boss, 'Tali is in danger. Asha charges the shelter lane: break the charge, release the bundle, tether her, then cleanse.');
  host.queueCue({ kind: 'shelter', phase: 'sustain', actorId: 'tali', targetId: state.playerId, position: { ...seq.shelter! }, scopeId: 'shelter:' + state.encounterId, durationTicks: ASHA_SEQUENCE.dangerTicks, footprint: { width: ASHA_SEQUENCE.shelterRadius * 2, length: ASHA_SEQUENCE.shelterRadius * 2 }, priority: 'essential', shape: 'ring' });
}

function updateDanger(host: ChapterHost, seq: BossSequenceState, boss: CombatActor): void {
  const state = host.state;
  seq.dangerRemaining -= state.worldTimeScale;
  for (const hazardId of [...seq.shelterHazardIds]) {
    const hazard = state.hazards.find(candidate => candidate.id === hazardId);
    const live = state.telegraphs.some(telegraph => telegraph.id === hazardId);
    if (!hazard || !live) { seq.shelterHazardIds.splice(seq.shelterHazardIds.indexOf(hazardId), 1); continue; }
    if (state.worldTick >= (hazard.castUntil ?? hazard.activeUntil)) {
      seq.shelterHazardIds.splice(seq.shelterHazardIds.indexOf(hazardId), 1);
      seq.landedCharges++;
      host.emit('cue', 'The charge reaches the shelter lane. Break the next one.', boss.id);
    }
  }
  if (seq.landedCharges >= ASHA_SEQUENCE.maxLandedCharges || seq.dangerRemaining <= 0) failTali(host, seq, boss);
}

function failTali(host: ChapterHost, seq: BossSequenceState, boss: CombatActor): void {
  const state = host.state;
  seq.step = 'failed';
  seq.taliStatus = 'failed';
  seq.shelterHazardIds = [];
  host.clearBossThreats();
  host.queueCue({ kind: 'shelter', phase: 'resolve', actorId: 'tali', position: { ...seq.shelter! }, scopeId: 'shelter:' + state.encounterId, priority: 'essential', shape: 'ring' });
  host.emit('world', 'tali-danger-failed', boss.id, 'tali' as ActorId);
  const eventId = `${state.runId}:${state.encounterId}:tali-lost:${state.tick}`;
  host.emitWorldEvent({ type: 'rescue', eventId, idempotencyKey: eventId, targetId: 'tali', locationId: 'tali-shelter', safe: false });
}

function resumeDanger(host: ChapterHost, seq: BossSequenceState, boss: CombatActor): void {
  seq.step = 'danger';
  seq.until = 0;
  seq.taliStatus = 'in-danger';
  host.resetMovableObject(ASHA_SEQUENCE.bundleObjectId);
  host.emit('cue', 'Asha shakes off the hold. Release the bundle again.', boss.id);
}

/** The bundle settled: while the danger is live it breaks Asha's charge and leaves her stunned and exposed. */
export function onObjectSettled(host: ChapterHost, objectId: string): void {
  const state = host.state, seq = state.chapter.sequence;
  if (!seq || seq.kind !== 'asha-cub' || seq.step !== 'danger' || objectId !== ASHA_SEQUENCE.bundleObjectId) return;
  const boss = state.actors.find(actor => actor.id === state.encounter!.bossId);
  if (!boss) return;
  host.clearBossThreats();
  seq.shelterHazardIds = [];
  seq.landedCharges = 0;
  seq.step = 'exposed';
  seq.until = state.worldTick + ASHA_SEQUENCE.exposureTicks;
  seq.taliStatus = 'sheltered';
  stun(host, boss, ASHA_SEQUENCE.exposureTicks);
  announce(host, boss, 'The bundle falls across the lane. Asha is stunned and her corruption is exposed: tether her.');
}

/** Whether the boss's sequence lets a tether land now (it needs no telegraph while the sequence has opened the exposure). */
export function acceptsTether(state: EngineState, target: CombatActor): boolean {
  const seq = state.chapter.sequence;
  if (!seq || target.id !== state.encounter?.bossId) return false;
  return seq.kind === 'koro-thorn' ? seq.step === 'thorn-exposed' : seq.step === 'exposed';
}
export function applyTether(host: ChapterHost, source: CombatActor): boolean {
  if (!acceptsTether(host.state, source)) return false;
  const seq = host.state.chapter.sequence!, window = seq.kind === 'koro-thorn' ? KORO_SEQUENCE.tetherWindowTicks : ASHA_SEQUENCE.tetherWindowTicks;
  host.cancelLiveAttack(source, 'root_tether');
  seq.step = 'tethered';
  seq.until = host.state.worldTick + window;
  stun(host, source, window);
  announce(host, source, seq.kind === 'koro-thorn' ? 'Koro is tethered. Close in and cleanse the thorn.' : 'Asha is tethered. Close in and cleanse the Cub.');
  return true;
}

/** Why a cleanse on `target` must wait, or null when the boss's sequence allows it now. */
export function cleanseBlock(state: EngineState, target: CombatActor): string | null {
  const seq = state.chapter.sequence;
  if (!seq || target.id !== state.encounter?.bossId) return null;
  if (seq.kind === 'koro-thorn') return seq.step === 'tethered' ? null : 'Corruption is sealed: expose the thorn and tether Koro first.';
  const cores = state.encounter.corruptionCoreIds?.length ?? 1, eased = target.cleansedCoreIds?.length ?? 0;
  if (state.phaseIndex < eased) return 'Corruption is sealed: Asha is not ready yet.';
  if (eased >= cores - 1) return seq.step === 'tethered' ? null : 'The Cub sequence is not complete: release the bundle, tether her, then cleanse.';
  return state.worldTick < target.staggerUntil || state.worldTick < (target.weakPointUntil ?? 0) ? null : 'Asha must be exposed before the corruption eases.';
}

/** Chooses and starts the boss's next attack when its sequence overrides the generic rotation. */
export function startSequenceAttack(host: ChapterHost, source: CombatActor): SequenceAttack {
  const state = host.state, seq = state.chapter.sequence;
  if (!seq || source.id !== state.encounter?.bossId) return 'default';
  if (seq.kind === 'koro-thorn') return seq.step === 'tethered' ? 'hold' : 'default';
  if (seq.step === 'stalking' || seq.step === 'rage') return 'default';
  if (seq.step !== 'danger') return 'hold';
  const rotation = ASHA_SEQUENCE.cubRotation, attackId = rotation[seq.attackCursor++ % rotation.length]!;
  const def = ACT_ONE_ATTACKS[attackId]!, shelterLane = attackId === 'asha-bamboo-charge';
  const hazard = host.beginAttack(source, def, shelterLane ? seq.shelter : undefined);
  if (!hazard) return 'hold';
  if (shelterLane) seq.shelterHazardIds.push(hazard.id);
  return 'started';
}

/** Cleanse settles the boss: it joins as an ally in presentation terms, Tali is safe and the reunion plays. */
export function settleBoss(host: ChapterHost, boss: CombatActor): void {
  const state = host.state, seq = state.chapter.sequence;
  host.clearBossThreats();
  boss.reactionState = undefined;
  boss.staggerUntil = 0;
  boss.recoveringUntil = 0;
  boss.allegiance = 'ally';
  boss.vitality = boss.maxVitality;
  if (!seq) return;
  seq.step = 'settled';
  seq.until = 0;
  if (seq.kind !== 'asha-cub') return;
  seq.taliStatus = 'reunion';
  const eventId = `${state.runId}:${state.encounterId}:tali-safe`;
  host.emitWorldEvent({ type: 'rescue', eventId, idempotencyKey: eventId, targetId: 'tali', locationId: 'tali-shelter', safe: true });
  host.queueCue({ kind: 'reunion', phase: 'resolve', actorId: boss.id, targetId: 'tali', position: { ...boss.position }, scopeId: state.encounterId, priority: 'essential', shape: 'pulse' });
  host.queueCue({ kind: 'shelter', phase: 'resolve', actorId: 'tali', position: { ...seq.shelter! }, scopeId: 'shelter:' + state.encounterId, priority: 'essential', shape: 'ring' });
}

/** Authoritative presentation status of one actor for the snapshot. */
export function chapterStatusOf(state: EngineState, actor: CombatActor): ChapterPresentationStatus | undefined {
  const seq = state.chapter.sequence, encounter = state.encounter;
  if (seq && encounter) {
    if (actor.id === encounter.bossId) {
      switch (seq.step) {
        case 'settled': return seq.kind === 'asha-cub' ? 'reunion' : 'cleansed';
        case 'tethered': return 'tethered';
        case 'thorn-exposed': case 'exposed': return 'thorn-exposed';
        default: return 'sealed';
      }
    }
    if (actor.id === 'tali' && seq.taliStatus && seq.taliStatus !== 'failed') return seq.taliStatus === 'in-danger' ? 'in-danger' : seq.taliStatus === 'sheltered' ? 'sheltered' : 'reunion';
  }
  if (encounter?.id === 'camp-hunters' && actor.downed && actor.id !== state.playerId) return state.rewardEmitted ? 'subdued' : 'kneeling';
  return undefined;
}
