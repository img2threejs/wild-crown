import type { BambooClipAction } from './BambooMonsterProfiles';
import type { OrunClipAction } from './LaterMonsterProfiles';
import type { MonsterClipAction } from './MonsterAnimationProfiles';
import type { EnemyAttackAction } from './EnemyAttackPresentation';

/** Native locomotion, lifecycle, story or action-specific combat clip accepted by the actor driver. */
export type PlanClipAction = MonsterClipAction | BambooClipAction | OrunClipAction | EnemyAttackAction;

/** Walk/run selection and loop-rate references (m/s at which the loop plays at 1x). */
export interface LocomotionProfile { readonly runThreshold: number; readonly walkRef: number; readonly runRef: number }
