import source from '../content/enemy-attack-presentation.json';
import type { ActorSnapshot } from '../game/contracts';

export type EnemyAttackId = keyof typeof source.attacks;
export type EnemyAttackAction = `wild-crown:${EnemyAttackId}`;
export type EnemyAttackAnchor = typeof source.attacks[EnemyAttackId]['socket'];
export interface EnemyAttackPresentation {
  readonly assets: readonly string[];
  readonly motion: string;
  readonly socket: string;
}

/** One native finite clip across all four authoritative phases; no gait/strike clip handoff at contact. */
const BY_ACTION: Readonly<Record<string, EnemyAttackPresentation>> = Object.fromEntries(
  Object.entries(source.attacks).map(([id, spec]) => [`wild-crown:${id}`, spec]),
);
const ENDS = source.phaseEnds;
const BY_ID: Readonly<Record<string, EnemyAttackPresentation>> = source.attacks;

export function enemyAttackPresentation(actionId: string): EnemyAttackPresentation | undefined { return BY_ACTION[actionId]; }
export function enemyAttackPresentationForId(attackId: string): EnemyAttackPresentation | undefined { return BY_ID[attackId]; }

export function enemyAttackTime(phase: NonNullable<ActorSnapshot['attackPhase']>, progress: number): number {
  const p = Math.max(0, Math.min(1, progress));
  switch (phase) {
    case 'windup': return ENDS[0]! * p;
    case 'commit': return ENDS[0]! + (ENDS[1]! - ENDS[0]!) * p;
    case 'active': return ENDS[1]! + (ENDS[2]! - ENDS[1]!) * p;
    case 'recovery': return ENDS[2]! + (ENDS[3]! - ENDS[2]!) * p;
  }
}

const FREE_BODY = /^(cartwheel-counter|back-handspring|dive-roll)$/;
const FLIGHT = /^(talon-dive|pride-pounce|fang-pounce|tusk-pounce|leap-slam|vine-vault|stalking-pounce|corrupted-slam|guardian-smash|flank-pounce|chain-pounce|mud-hop|beak-dive)$/;

/** Foot solvers must not pin an authored airborne attack to the floor. Native clips already carry their vertical arc. */
export function enemyAttackAirborne(actor: ActorSnapshot): boolean {
  if (!actor.attackPhase) return false;
  const spec = BY_ACTION[actor.actionId];
  return spec !== undefined && (FREE_BODY.test(spec.motion) || FLIGHT.test(spec.motion) && (actor.attackPhase === 'commit' || actor.attackPhase === 'active'));
}
