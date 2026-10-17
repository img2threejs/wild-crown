import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
interface PlaytestEntry { readonly id: string; readonly coordinateTransform: { readonly scale: number } }
interface WalkReport { readonly clips: { readonly 'monster-walk': { readonly measured: { readonly planting: { readonly plantedSpeedUnitsPerSecond: number } } } } }
interface LifecycleRig {
  readonly instance: NativeAssetInstance;
  /** Drives one frame and returns the sampled bone offset plus the vertical presentation offset (m) the driver asks the renderer to add to the root. */
  readonly drive: (snapshot: ActorSnapshot, clock: number, extra?: Partial<ActorAnimationContext>) => { x: number; y: number; z: number; lift: number };
}
import { AnimationClip, Bone, Group, VectorKeyframeTrack } from 'three';
import { AnimationController } from '../../src/rendering/AnimationController.js';
import { driveActorAnimation, nativeLocomotionPlaybackRate, type ActorAnimationContext } from '../../src/rendering/ActorAnimationDriver.js';
import {
  BOSS_ROAR_VITALITY_RATIO, DEATH_GROUND_CONTACT, GAIT_HYSTERESIS_BAND, MONSTER_DEATH_SECONDS, MONSTER_LOCOMOTION, MONSTER_SPAWN_SECONDS, deathFallShare, isMonsterDefeated, monsterHoverHeight, resolveBossRoarOverlay, resolveMonsterAnimation,
  settleMonsterHover,
} from '../../src/rendering/MonsterAnimationProfiles.js';
import type { NativeAssetInstance } from '../../src/rendering/NativeAssetLoader.js';
import type { ActorSnapshot, AssetManifestEntry } from '../../src/game/contracts.js';

const BOAR = 'actor-ember-boar';
const HORNBILL = 'actor-storm-hornbill';
const root = process.cwd();

function monster(partial: Partial<ActorSnapshot> = {}): ActorSnapshot {
  return {
    id: 'boar', archetypeId: 'corrupted-boar', allegiance: 'hostile', position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 0, y: 0, z: 1 },
    actionId: 'monster-idle', phase: 'idle', normalizedTime: 0, vitality: 100, maxVitality: 100, sockets: {}, interactionRequirements: [], visible: true, downed: false, possessed: false, ...partial,
  } as unknown as ActorSnapshot;
}

/** One-bone rig: idle shows nothing, death shows its sampled time on y, spawn on x, the roar on z (so a blended overlay is readable per axis). */
function lifecycleRig(assetId = BOAR): LifecycleRig {
  const group = new Group(), hips = new Bone();
  hips.name = 'hips'; group.add(hips);
  const track = (values: number[]) => new VectorKeyframeTrack('hips.position', [0, 1], values);
  const clips = [
    new AnimationClip('idle', 1, [track([0, 0, 0, 0, 0, 0])]),
    new AnimationClip('death', 1, [track([0, 0, 0, 0, 10, 0])]),
    new AnimationClip('spawn', 1, [track([0, 0, 0, 10, 0, 0])]),
    new AnimationClip('roar', 1, [track([0, 0, 0, 0, 0, 10])]),
    new AnimationClip('hurt', 1, [track([0, 0, 0, 0, 0, 0])]),
    new AnimationClip('slash', 1, [track([0, 0, 0, 0, 0, 0])]),
  ];
  const policy = { mode: 'in-place', evidenceStatus: 'verified' };
  const names = { 'monster-idle': 'idle', 'monster-death': 'death', 'monster-spawn': 'spawn', 'monster-roar': 'roar', 'monster-hurt': 'hurt', 'monster-slash': 'slash' };
  const manifest = {
    id: assetId, requiredActionIds: Object.keys(names), actionToClipMapping: names,
    rootMotion: Object.fromEntries(Object.keys(names).map(slot => [slot, policy])),
  } as unknown as AssetManifestEntry;
  const animation = new AnimationController(group, clips, manifest);
  const instance = { assetId, root: group, animation, sockets: {}, dispose: () => animation.dispose() } as unknown as NativeAssetInstance;
  const drive = (snapshot: ActorSnapshot, clock: number, extra: Partial<ActorAnimationContext> = {}) => {
    const context = { interpolate: false, alpha: 1, loopTimeSeconds: clock, manifest: undefined, ...extra };
    driveActorAnimation(instance, snapshot, undefined, context);
    animation.update(1); // finish the 0.12 s crossfade the clip switch started, then re-evaluate the same frame at full weight
    const lift = driveActorAnimation(instance, snapshot, undefined, context);
    return { x: hips.position.x, y: hips.position.y, z: hips.position.z, lift };
  };
  return { instance, drive };
}

describe('monster lifecycle on a real rig', () => {
  it('plays monster-death once from the frame the vitality reaches 0 and holds the last frame', () => {
    const { instance, drive } = lifecycleRig();
    try {
      drive(monster(), 10); // alive: the first frame the driver sees
      const defeated = monster({ vitality: 0, downed: true });
      expect(isMonsterDefeated(defeated)).toBe(true);
      expect(drive(defeated, 10).y).toBeLessThan(0.5); // clip start, not the dazed hurt hold
      const mid = drive(defeated, 10 + MONSTER_DEATH_SECONDS * 0.5).y;
      expect(mid).toBeGreaterThan(3);
      expect(mid).toBeLessThan(7);
      // Held: any later time (and a far later world clock) stays on the last frame, it never loops.
      for (const clock of [10 + MONSTER_DEATH_SECONDS, 10 + MONSTER_DEATH_SECONDS * 1.7, 90]) expect(drive(defeated, clock).y).toBeCloseTo(10, 3);
      // A downed monster that is not defeated keeps the dazed hurt hold, never the collapse.
      const dazed = lifecycleRig();
      try {
        dazed.drive(monster(), 0);
        expect(dazed.drive(monster({ downed: true, vitality: 40 }), 1).y).toBeCloseTo(0, 6);
      } finally { dazed.instance.dispose(); }
    } finally { instance.dispose(); }
  });

  it('starts on the held collapse when a monster is restored already defeated (no replay)', () => {
    const { instance, drive } = lifecycleRig();
    try { expect(drive(monster({ vitality: 0, downed: true }), 3).y).toBeCloseTo(10, 3); } finally { instance.dispose(); }
  });

  it('eases a hovering flyer to the ground over its death clip (gravity-like, contact at 70%) and keeps its presentation height at 0', () => {
    const { instance, drive } = lifecycleRig(HORNBILL);
    try {
      const flying = monster({ id: 'hornbill', archetypeId: 'storm-hornbill' });
      const struck = monster({ id: 'hornbill', archetypeId: 'storm-hornbill', vitality: 0, downed: true });
      const flightHeight = monsterHoverHeight(flying, HORNBILL, 10);
      expect(flightHeight).toBeGreaterThan(2);
      expect(drive(flying, 10).lift).toBe(0); // alive: the renderer's own hover carries the height
      // Defeated: the renderer-side hover is 0 at once (no exponential settle), the driver owns the fall.
      expect(monsterHoverHeight(struck, HORNBILL, 10)).toBe(0);
      expect(settleMonsterHover(flightHeight, 0, struck, 1 / 60)).toBe(0);
      const steps = 20, lifts: number[] = [];
      for (let step = 0; step <= steps; step++) lifts.push(drive(struck, 10 + MONSTER_DEATH_SECONDS * step / steps).lift);
      expect(lifts[0]).toBeCloseTo(flightHeight, 6); // the frame it is struck keeps its height: no pop
      const contact = Math.round(DEATH_GROUND_CONTACT * steps);
      const drops = lifts.slice(1).map((value, index) => lifts[index] - value);
      for (let index = 1; index < contact; index++) expect(drops[index]).toBeGreaterThan(drops[index - 1]); // accelerating, like gravity
      expect(lifts[contact]).toBeCloseTo(0, 9);
      for (const lift of lifts.slice(contact)) expect(lift).toBe(0);
      for (const clock of [10 + MONSTER_DEATH_SECONDS * 1.3, 10 + 40]) expect(drive(struck, clock).lift).toBe(0); // held on the ground, never rises again
      expect(deathFallShare(0)).toBe(0);
      expect(deathFallShare(DEATH_GROUND_CONTACT)).toBe(1);
      expect(deathFallShare(1)).toBe(1);
    } finally { instance.dispose(); }
  });

  it('has no height to lower for a grounded monster or one restored already defeated', () => {
    const grounded = lifecycleRig();
    const restored = lifecycleRig(HORNBILL);
    try {
      grounded.drive(monster(), 4);
      for (const step of [0, 0.3, 0.6, 1, 2]) expect(grounded.drive(monster({ vitality: 0, downed: true }), 4 + step).lift).toBe(0);
      expect(restored.drive(monster({ id: 'hornbill', vitality: 0, downed: true }), 7).lift).toBe(0);
    } finally { grounded.instance.dispose(); restored.instance.dispose(); }
  });

  it('plays monster-spawn once, the first time the monster is the active trial monster, then hands over to idle', () => {
    const { instance, drive } = lifecycleRig();
    try {
      const waiting = { trialMonster: { active: false, boss: false } };
      expect(drive(monster(), 5, waiting).x).toBeCloseTo(0, 6); // not active yet: idle
      const active = { trialMonster: { active: true, boss: false } };
      expect(drive(monster(), 6, active).x).toBeLessThan(0.5);
      expect(drive(monster(), 6 + MONSTER_SPAWN_SECONDS * 0.5, active).x).toBeCloseTo(5, 1);
      expect(drive(monster(), 6 + MONSTER_SPAWN_SECONDS + 0.01, active).x).toBeLessThan(1); // handed back to idle (crossfading)
      // Once only: becoming active again later never replays it.
      drive(monster(), 20, waiting);
      expect(drive(monster(), 21, active).x).toBeCloseTo(0, 6);
    } finally { instance.dispose(); }
  });

  it('cancels the entrance when the monster is already attacking, so it never stands in the entrance pose while fighting', () => {
    const { instance, drive } = lifecycleRig();
    try {
      const active = { trialMonster: { active: true, boss: false } };
      drive(monster(), 6, active);
      drive(monster({ attackPhase: 'windup', attackPhaseProgress: 0.1, actionId: 'wild-crown:boar-gale-scythe' as never }), 6.2, active);
      expect(drive(monster(), 6.4, active).x).toBeCloseTo(0, 6);
    } finally { instance.dispose(); }
  });

  it('roars once as an overlay when a boss first drops below half vitality, never for a regular trial monster', () => {
    const boss = lifecycleRig(), regular = lifecycleRig();
    try {
      const bossCtx = { trialMonster: { active: true, boss: true } }, regularCtx = { trialMonster: { active: true, boss: false } };
      const wait = (rig: LifecycleRig, ctx: { trialMonster: { active: boolean; boss: boolean } }) => { rig.drive(monster({ actionId: 'wild-crown:boar-gale-scythe' as never, attackPhase: 'recovery', attackPhaseProgress: 0.5 }), 1, ctx); };
      wait(boss, bossCtx); wait(regular, regularCtx);
      const weak = monster({ vitality: 100 * BOSS_ROAR_VITALITY_RATIO - 1, actionId: 'wild-crown:boar-gale-scythe' as never, attackPhase: 'recovery', attackPhaseProgress: 0.5 });
      boss.drive(weak, 2, bossCtx); // the phase change is seen here; the overlay fades in over 0.15 s
      const roaring = boss.drive(weak, 2.2, bossCtx).z;
      expect(roaring).toBeGreaterThan(0.1);
      expect(boss.drive(weak, 2.8, bossCtx).z).toBeGreaterThan(roaring); // the clip advances while it overlays
      expect(boss.drive(weak, 2 + 3, bossCtx).z).toBeCloseTo(0, 6); // over after 1.6 s, and it never starts again
      expect(boss.drive(monster({ ...weak, vitality: 10 }), 9, bossCtx).z).toBeCloseTo(0, 6);
      expect(regular.drive(weak, 2, regularCtx).z).toBeCloseTo(0, 6);
      expect(resolveBossRoarOverlay(-0.1)).toBeUndefined();
      expect(resolveBossRoarOverlay(0.01)!.share).toBeLessThan(resolveBossRoarOverlay(0.3)!.share);
      expect(resolveBossRoarOverlay(1.7)).toBeUndefined();
    } finally { boss.instance.dispose(); regular.instance.dispose(); }
  });

  it('does not roar for a boss that is already below half when first seen or that dies from above half in one blow', () => {
    const loaded = lifecycleRig(), oneBlow = lifecycleRig();
    try {
      const ctx = { trialMonster: { active: true, boss: true } };
      expect(loaded.drive(monster({ vitality: 30 }), 1, ctx).z).toBeCloseTo(0, 6);
      oneBlow.drive(monster({ vitality: 80 }), 1, ctx);
      expect(oneBlow.drive(monster({ vitality: 0, downed: true }), 2, ctx).z).toBeCloseTo(0, 6);
    } finally { loaded.instance.dispose(); oneBlow.instance.dispose(); }
  });
});

describe('walk / run hysteresis', () => {
  const threshold = 3.5; // ember boar runThreshold
  const gaitAt = (speed: number, previous?: 'monster-walk' | 'monster-run') => resolveMonsterAnimation(monster({ velocity: { x: 0, y: 0, z: speed } }), BOAR, previous)!.actionId;
  it('holds the walk until the speed clears the upper edge of the band and holds the run until it falls under the lower edge', () => {
    expect(GAIT_HYSTERESIS_BAND).toBeGreaterThanOrEqual(0.1);
    expect(GAIT_HYSTERESIS_BAND).toBeLessThanOrEqual(0.15);
    expect(gaitAt(threshold + 0.01)).toBe('monster-run'); // no memory: the plain threshold
    expect(gaitAt(threshold * (1 + GAIT_HYSTERESIS_BAND) - 0.05, 'monster-walk')).toBe('monster-walk');
    expect(gaitAt(threshold * (1 + GAIT_HYSTERESIS_BAND) + 0.05, 'monster-walk')).toBe('monster-run');
    expect(gaitAt(threshold * (1 - GAIT_HYSTERESIS_BAND) + 0.05, 'monster-run')).toBe('monster-run');
    expect(gaitAt(threshold * (1 - GAIT_HYSTERESIS_BAND) - 0.05, 'monster-run')).toBe('monster-walk');
  });

  it('never flickers while the speed wobbles inside the band', () => {
    let gait: 'monster-walk' | 'monster-run' | undefined;
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      gait = gaitAt(threshold + 0.25 * Math.sin(i) , gait) as typeof gait;
      seen.add(gait!);
    }
    expect(seen.size).toBe(1);
  });
});

describe('hero locomotion rate without authored root motion (Sakda, Vesper)', () => {
  const instance = { animation: { authoredPlanarSpeed: () => 0 } } as unknown as NativeAssetInstance;
  const context = (extra: Partial<ActorAnimationContext>): ActorAnimationContext => ({ interpolate: false, alpha: 1, loopTimeSeconds: 0, manifest: undefined, ...extra });
  const rate = (actionId: string, speed: number, extra: Partial<ActorAnimationContext>) =>
    nativeLocomotionPlaybackRate(instance, undefined, actionId as never, { x: speed, y: 0, z: 0 }, context(extra));
  it('scales walk with ground speed against the hero walk speed and run against the run speed, clamped like the monsters', () => {
    expect(rate('aren-walk', 4.4, { walkSpeed: 4.4, runSpeed: 6.6 })).toBeCloseTo(1, 6);
    expect(rate('aren-walk', 2.2, { walkSpeed: 4.4, runSpeed: 6.6 })).toBeCloseTo(0.5, 6);
    expect(rate('aren-walk', 0.5, { walkSpeed: 4.4, runSpeed: 6.6 })).toBe(0.5);
    expect(rate('aren-run', 6.6, { walkSpeed: 4.4, runSpeed: 6.6 })).toBeCloseTo(1, 6);
    expect(rate('aren-run', 5.28, { walkSpeed: 4.4, runSpeed: 6.6 })).toBeCloseTo(0.8, 6);
    expect(rate('aren-run', 30, { walkSpeed: 4.9, runSpeed: 7.5 })).toBe(2);
    expect(rate('aren-run', 7.35, { walkSpeed: 4.9 })).toBeCloseTo(1, 6); // run speed falls back to 1.5x the walk speed
  });
  it('leaves non-locomotion clips and heroes without a declared speed untouched', () => {
    expect(rate('aren-jump', 5, { walkSpeed: 4.4 })).toBe(1);
    expect(rate('aren-walk', 5, {})).toBe(1);
  });
});

describe('authored walk references', () => {
  it('binds walkRef of every authored-walk quadruped to the ground speed its planted feet need (clips report planting x manifest scale)', () => {
    const manifests = ['greenwake', 'moonpine'].flatMap(name => JSON.parse(readFileSync(`${root}/asset-source/playtests/${name}.json`, 'utf8')) as PlaytestEntry[]);
    for (const id of ['actor-ember-boar', 'actor-frost-sap-stalker', 'actor-root-rammer', 'actor-frostfang-tracker', 'actor-howl-scout', 'actor-ruun-chained-howl']) {
      const walkRef = MONSTER_LOCOMOTION[id]!.walkRef;
      const report = JSON.parse(readFileSync(`${root}/asset-source/generated/${id}-runtime-01/clips-report.json`, 'utf8')) as WalkReport;
      const scale = manifests.find(entry => entry.id === id)!.coordinateTransform.scale;
      const planted = report.clips['monster-walk'].measured.planting.plantedSpeedUnitsPerSecond * scale;
      expect(Math.abs(walkRef - planted) / planted).toBeLessThan(0.05);
    }
  });
});
