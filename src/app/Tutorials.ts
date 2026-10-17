import type { CombatSnapshot, TutorialId } from '../game/contracts.js';

/**
 * The first unseen how-to-play card whose moment has arrived in this gameplay snapshot, or null.
 * Controls come first; the cleanse explainer opens the first fight against a corrupted boss; each phase action
 * (tether, counter, cleanse) is explained the first time a phase actually asks for it.
 */
export function dueTutorial(snapshot: CombatSnapshot, seen: readonly TutorialId[]): TutorialId | null {
  const due: TutorialId[] = ['controls'];
  const step = snapshot.encounterStatus?.step;
  if (snapshot.encounterStatus?.endsWithCleanse) due.push('cleanse-boss');
  if (step && !step.done && step.action !== 'wear-down') due.push(step.action);
  return due.find(id => !seen.includes(id)) ?? null;
}
