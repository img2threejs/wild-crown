import type { Vec3 } from '../contracts.js';

export type EvasionDirection='left'|'right'|'forward'|'back'|'forward-left'|'forward-right'|'back-left'|'back-right';
export type EvasionProfileId='quick_step_left'|'quick_step_right'|'forward_shoulder_roll'|'back_handspring'|'left_cartwheel'|'right_cartwheel'|'forward_left_dive_roll'|'forward_right_dive_roll'|'back_left_pivot_roll'|'back_right_pivot_roll'|'low_slide'|'staff_vault'|'perfect_dodge_left'|'perfect_dodge_right'|'dodge_recovery'|'hard_landing'|'stumble_recovery';
export interface EvasionProfile { id:EvasionProfileId;distance:number;durationTicks:number;recoveryTicks:number;iframes:number;startsIFrames:boolean;verticalClearance:number;collisionHeight?:number; }
export interface HazardDefinition { kind:'strike'|'sweep'|'wave'|'area'|'projectile'|'cone';width:number;depth:number;radius:number;heightAboveGround:number;damage:number;bounds:{min:Vec3;max:Vec3};hitGroup:string;range?:number;angleDeg?:number; }
export const EVASION_PROFILES:Readonly<Record<EvasionProfileId,EvasionProfile>>={
  quick_step_left:{id:'quick_step_left',distance:1.45,durationTicks:15,recoveryTicks:12,iframes:7,startsIFrames:true,verticalClearance:.1},
  quick_step_right:{id:'quick_step_right',distance:1.45,durationTicks:15,recoveryTicks:12,iframes:7,startsIFrames:true,verticalClearance:.1},
  forward_shoulder_roll:{id:'forward_shoulder_roll',distance:2.2,durationTicks:24,recoveryTicks:16,iframes:8,startsIFrames:true,verticalClearance:.15},
  back_handspring:{id:'back_handspring',distance:2.05,durationTicks:27,recoveryTicks:20,iframes:8,startsIFrames:true,verticalClearance:.65},
  left_cartwheel:{id:'left_cartwheel',distance:2.25,durationTicks:23,recoveryTicks:18,iframes:8,startsIFrames:true,verticalClearance:.9},
  right_cartwheel:{id:'right_cartwheel',distance:2.25,durationTicks:23,recoveryTicks:18,iframes:8,startsIFrames:true,verticalClearance:.9},
  forward_left_dive_roll:{id:'forward_left_dive_roll',distance:4.8,durationTicks:30,recoveryTicks:26,iframes:10,startsIFrames:true,verticalClearance:.35},
  forward_right_dive_roll:{id:'forward_right_dive_roll',distance:4.8,durationTicks:30,recoveryTicks:26,iframes:10,startsIFrames:true,verticalClearance:.35},
  back_left_pivot_roll:{id:'back_left_pivot_roll',distance:2.35,durationTicks:27,recoveryTicks:21,iframes:8,startsIFrames:true,verticalClearance:.25},
  back_right_pivot_roll:{id:'back_right_pivot_roll',distance:2.35,durationTicks:27,recoveryTicks:21,iframes:8,startsIFrames:true,verticalClearance:.25},
  low_slide:{id:'low_slide',distance:2.7,durationTicks:24,recoveryTicks:17,iframes:5,startsIFrames:true,verticalClearance:.45,collisionHeight:.75},
  staff_vault:{id:'staff_vault',distance:2.1,durationTicks:29,recoveryTicks:22,iframes:7,startsIFrames:true,verticalClearance:1.8},
  perfect_dodge_left:{id:'perfect_dodge_left',distance:1.45,durationTicks:15,recoveryTicks:12,iframes:7,startsIFrames:true,verticalClearance:.1},
  perfect_dodge_right:{id:'perfect_dodge_right',distance:1.45,durationTicks:15,recoveryTicks:12,iframes:7,startsIFrames:true,verticalClearance:.1},
  dodge_recovery:{id:'dodge_recovery',distance:0,durationTicks:12,recoveryTicks:0,iframes:0,startsIFrames:false,verticalClearance:0},
  hard_landing:{id:'hard_landing',distance:0,durationTicks:15,recoveryTicks:15,iframes:0,startsIFrames:false,verticalClearance:0},
  stumble_recovery:{id:'stumble_recovery',distance:0,durationTicks:18,recoveryTicks:12,iframes:0,startsIFrames:false,verticalClearance:0},
};
export interface TraversalAffordance {kind:'staff-vault'|'low-slide';bounds:{minX:number;maxX:number;minZ:number;maxZ:number}}
export function canonicalEvasionActions():readonly EvasionProfileId[]{return Object.keys(EVASION_PROFILES) as EvasionProfileId[];}
