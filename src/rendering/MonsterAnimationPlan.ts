import type { MonsterClipAction } from './MonsterAnimationProfiles';

export type Ease = 'linear' | 'in' | 'out' | 'inOut';
/** A finite clip window played across one attack phase, or a clip looped at a (possibly ramping) rate. */
export type PhaseStep =
  | { readonly action: MonsterClipAction; readonly from: number; readonly to: number; readonly ease: Ease }
  | { readonly action: MonsterClipAction; readonly loopRate: number; readonly toLoopRate?: number };

/**
 * Clip plan for one attack. The `active` window starts on the clip's strike pose, so the visible hit
 * lands with the hazard; windup and commit lead into it, recovery eases out of the follow-through.
 */
export interface MonsterAttackPlan {
  readonly windup: PhaseStep;
  readonly commit: PhaseStep;
  readonly active: PhaseStep;
  readonly recovery: PhaseStep;
}

/** Walk/run selection and loop-rate references (m/s at which the loop plays at 1x). */
export interface LocomotionProfile { readonly runThreshold: number; readonly walkRef: number; readonly runRef: number }

export const clip = (action: MonsterClipAction, from: number, to: number, ease: Ease = 'linear'): PhaseStep => ({ action, from, to, ease });
export const loop = (action: MonsterClipAction, loopRate: number, toLoopRate?: number): PhaseStep => ({ action, loopRate, toLoopRate });
/** One clip across all four phases: [from, to] windows for windup, commit, active (starting on the strike pose) and recovery. */
export const plan = (action: MonsterClipAction, windup: readonly [number, number], commit: readonly [number, number], active: readonly [number, number], recovery: readonly [number, number]): MonsterAttackPlan => ({
  windup: clip(action, windup[0], windup[1], 'inOut'),
  commit: clip(action, commit[0], commit[1], 'in'),
  active: clip(action, active[0], active[1]),
  recovery: clip(action, recovery[0], recovery[1], 'out'),
});
