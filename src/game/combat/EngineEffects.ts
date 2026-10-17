import type { ActorId, AttackId, WorldEvent } from '../contracts.js';
import type { StoryCue } from '../../effects/story-cues.js';
import type { CombatEvent, EngineState } from './CombatEngine.js';

/** A presentation cue as authored by a producer; the engine stamps identity and time. */
export type CueInput = Omit<StoryCue, 'instanceId' | 'tick' | 'worldTick' | 'worldTimeSeconds'>;

/** Stamps `cue` with its instance id and the current ticks and queues it for the presentation layer. Returns the queued cue. */
export function appendCue(state: EngineState, cue: CueInput): StoryCue {
  const instanceId = state.runId + ':' + (state.encounterId ?? 'free') + ':cue:' + state.tick + ':' + (++state.eventSequence);
  const event: StoryCue = { ...cue, instanceId, tick: state.tick, worldTick: state.worldTick, worldTimeSeconds: state.worldTick * (1 / 60) };
  state.presentationCues.push(event);
  return event;
}

/** Records one engine event; world events must go through {@link emitWorldEvent}. */
export function pushEvent(state: EngineState, kind: CombatEvent['kind'], message: string, actorId?: ActorId, targetId?: ActorId, actionId?: string, attackId?: AttackId, damage?: CombatEvent['damage']): void {
  state.events.push({ id: `${state.runId}:combat:${state.tick}:${++state.eventSequence}`, tick: state.tick, kind, message, actorId, targetId, actionId, attackId, damage });
}

/** Emits a campaign-facing event once per idempotency key; false when it was already emitted. */
export function emitWorldEvent(state: EngineState, worldEvent: WorldEvent): boolean {
  if (state.seenWorldKeys.includes(worldEvent.idempotencyKey)) return false;
  state.seenWorldKeys.push(worldEvent.idempotencyKey);
  state.events.push({ id: worldEvent.eventId, tick: state.tick, kind: 'world', message: `World event: ${worldEvent.type}.`, worldEvent });
  state.worldEvents.push(structuredClone(worldEvent));
  return true;
}
