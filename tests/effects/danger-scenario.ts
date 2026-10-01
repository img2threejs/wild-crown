import { CombatEngine } from '../../src/game/combat/CombatEngine.js';
import { ATTACKS } from '../../src/game/combat/content.js';
import type { StoryCue } from '../../src/effects/story-cues.js';

/** Qualification scenarios select existing encounter phases/attacks; no presentation cue is fabricated. */
export const DANGER_SCENARIOS = [
  { family: 'strike', encounterId: 'encounter-asha', regionId: 'blood-bamboo-valley', attackId: 'asha-guarding-pounce', phaseIndex: 0, selectorTick: 0 },
  { family: 'sweep', encounterId: 'encounter-asha', regionId: 'blood-bamboo-valley', attackId: 'asha-claw-combination', phaseIndex: 0, selectorTick: 120 },
  { family: 'wave', encounterId: 'encounter-asha', regionId: 'blood-bamboo-valley', attackId: 'asha-ground-wave', phaseIndex: 1, selectorTick: 0 },
  { family: 'area', encounterId: 'encounter-koro', regionId: 'whispering-canopy', attackId: 'koro-fruit-burst', phaseIndex: 0, selectorTick: 120 },
  { family: 'projectile', encounterId: 'camp-hunters', regionId: 'blood-bamboo-valley', attackId: 'poacher-scout-net', phaseIndex: 0, selectorTick: 0 },
  { family: 'area', encounterId: 'encounter-asha', regionId: 'blood-bamboo-valley', attackId: 'asha-protective-roar', phaseIndex: 1, selectorTick: 120 },
] as const;

export function startDangerScenario(index: number): { engine: CombatEngine; anticipation: StoryCue } {
  const scenario = DANGER_SCENARIOS[index]!;
  const initial = new CombatEngine();
  initial.startEncounter({ encounterId: scenario.encounterId, regionId: scenario.regionId, runId: `danger-${index}` });
  const state = initial.snapshotState();
  state.phaseIndex = scenario.phaseIndex;
  state.phaseLatch = scenario.phaseIndex;
  state.lastAttackTick = scenario.selectorTick;
  const sourceId = ATTACKS[scenario.attackId]!.bossId;
  const source = state.actors.find(actor => actor.id === sourceId)!;
  const player = state.actors.find(actor => actor.id === 'aren')!;
  player.position = { x: source.position.x, y: source.position.y, z: source.position.z + 1 };
  for (const actor of state.actors) if (actor.id !== sourceId && actor.id !== 'aren') actor.recoveringUntil = 10_000;
  const engine = new CombatEngine(state);
  engine.fixedStep();
  const anticipation = engine.drainPresentationCues().find(cue => cue.kind === 'anticipation' && cue.attackId === scenario.attackId);
  if (!anticipation) throw new Error(`Actual encounter did not emit ${scenario.attackId}.`);
  return { engine, anticipation };
}
