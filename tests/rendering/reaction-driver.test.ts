import { describe, expect, it } from 'bun:test';
import { AnimationClip, Bone, Group, VectorKeyframeTrack } from 'three';
import { AnimationController } from '../../src/rendering/AnimationController.js';
import { driveActorAnimation } from '../../src/rendering/ActorAnimationDriver.js';
import { createReactionPose, type ReactionPose } from '../../src/rendering/ReactionPresenter.js';
import type { NativeAssetInstance } from '../../src/rendering/NativeAssetLoader.js';
import type { ActorSnapshot, AssetManifestEntry } from '../../src/game/contracts.js';
import { reactionAt } from './reaction-fixtures.js';

/** One-bone rig whose clips draw their normalized time on one axis each: hurt / hit on x (x = 10 t), death on z (z = 5 t), spawn on z (z = -5 t), idle on y (y = 1). */
function rig(assetId: string, actions: Record<string, [number, number, number]>) {
  const root = new Group(), hips = new Bone();
  hips.name = 'hips'; root.add(hips);
  const clips = Object.entries(actions).map(([name, end]) => new AnimationClip(name, 1, [new VectorKeyframeTrack('hips.position', [0, 1], [0, name.endsWith('idle') ? 1 : 0, 0, ...end])]));
  const policy = { mode: 'in-place', evidenceStatus: 'verified' };
  const manifest = {
    id: assetId, requiredActionIds: Object.keys(actions),
    actionToClipMapping: Object.fromEntries(Object.keys(actions).map(name => [name, name])),
    rootMotion: Object.fromEntries(Object.keys(actions).map(name => [name, policy])),
  } as unknown as AssetManifestEntry;
  const animation = new AnimationController(root, clips, manifest);
  const instance = { assetId, root, animation, sockets: {}, dispose: () => animation.dispose() } as unknown as NativeAssetInstance;
  return { instance, hips };
}
const monsterRig = () => rig('actor-ember-boar', {
  'monster-idle': [0, 1, 0], 'monster-hurt': [10, 0, 0], 'monster-death': [0, 0, 5], 'monster-spawn': [0, 0, -5],
});
const heroRig = () => rig('actor-vesper-hero', { 'aren-idle': [0, 1, 0], 'aren-hit': [10, 0, 0] });

const monster = (partial: Partial<ActorSnapshot> = {}): ActorSnapshot => ({
  id: 'boar', archetypeId: 'corrupted-boar', allegiance: 'hostile', position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 0, y: 0, z: 1 },
  actionId: 'monster-idle', phase: 'idle', normalizedTime: 0, vitality: 100, maxVitality: 100, sockets: {}, interactionRequirements: [], visible: true, downed: false, possessed: false, ...partial,
}) as unknown as ActorSnapshot;
const hero = (partial: Partial<ActorSnapshot> = {}): ActorSnapshot => ({
  id: 'aren', archetypeId: 'aren', allegiance: 'player', position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 0, y: 0, z: 1 },
  actionId: 'aren-idle', phase: 'idle', normalizedTime: 0, sockets: {}, interactionRequirements: [], visible: true, downed: false, possessed: false, ...partial,
}) as unknown as ActorSnapshot;

const pose = (partial: Partial<ReactionPose>): ReactionPose => ({ ...createReactionPose(), ...partial });
/** `clock` is the world clock seconds; a trial role that is not active keeps the monster's entrance clip from playing on the first frame. */
const context = (reaction: ReactionPose | undefined, extra: { vitality?: number; clock?: number } = {}) => ({
  interpolate: false, alpha: 1, loopTimeSeconds: extra.clock ?? 1, manifest: undefined, reaction, vitality: extra.vitality, trialMonster: { active: false, boss: false },
});

describe('monster reaction clips', () => {
  it('a stagger plays the hurt clip at the pose time instead of the monster\'s own clip', () => {
    const { instance, hips } = monsterRig();
    try {
      driveActorAnimation(instance, monster({ reaction: reactionAt('stagger', 0.5) }), undefined, context(pose({ kind: 'stagger', baseAction: 'monster-hurt', baseTime: 0.3 })));
      expect(hips.position.x).toBeCloseTo(3, 6);
      expect(hips.position.y).toBeCloseTo(0, 6);
    } finally { instance.dispose(); }
  });

  it('a knockdown falls over the head of the death clip and lies on its collapsed pose, then the get-up plays the entrance clip', () => {
    const { instance, hips } = monsterRig();
    try {
      driveActorAnimation(instance, monster({ reaction: reactionAt('knockdown', 0.2) }), undefined, context(pose({ kind: 'knockdown', baseAction: 'monster-death', baseTime: 0.43 })));
      expect(hips.position.z).toBeCloseTo(5 * 0.43, 6);
      driveActorAnimation(instance, monster({ reaction: reactionAt('knockdown', 1) }), undefined, context(pose({ kind: 'knockdown', baseAction: 'monster-death', baseTime: 0.86 })));
      expect(hips.position.z).toBeCloseTo(5 * 0.86, 6);
      for (let i = 0; i < 30; i += 1) instance.animation.update(1 / 60);
      driveActorAnimation(instance, monster({ reaction: reactionAt('getup', 0.5) }), undefined, context(pose({ kind: 'getup', baseAction: 'monster-spawn', baseTime: 0.5 })));
      for (let i = 0; i < 30; i += 1) instance.animation.update(1 / 60);
      driveActorAnimation(instance, monster({ reaction: reactionAt('getup', 0.5) }), undefined, context(pose({ kind: 'getup', baseAction: 'monster-spawn', baseTime: 0.5 })));
      expect(hips.position.z).toBeCloseTo(-2.5, 6);
    } finally { instance.dispose(); }
  });

  it('never replaces the one-shot defeat of a monster whose vitality is spent', () => {
    const { instance, hips } = monsterRig();
    try {
      for (let i = 0; i < 4; i += 1) driveActorAnimation(instance, monster({ vitality: 0, downed: true, reaction: reactionAt('knockdown', 0.5) }), undefined, context(pose({ kind: 'knockdown', baseAction: 'monster-hurt', baseTime: 0.3 })));
      expect(hips.position.x).toBeCloseTo(0, 6);
      expect(hips.position.z).toBeCloseTo(5, 6);
    } finally { instance.dispose(); }
  });

  it('does not name a clip the rig lacks: the monster keeps its own', () => {
    const { instance, hips } = monsterRig();
    try {
      driveActorAnimation(instance, monster(), undefined, context(pose({ kind: 'stagger', baseAction: 'monster-nonexistent', baseTime: 0.3 })));
      expect(hips.position.y).toBeCloseTo(1, 6);
      expect(hips.position.x).toBeCloseTo(0, 6);
    } finally { instance.dispose(); }
  });

  it('clears the reaction clip the frame the reaction ends', () => {
    const { instance, hips } = monsterRig();
    try {
      driveActorAnimation(instance, monster({ reaction: reactionAt('stagger', 0.5) }), undefined, context(pose({ kind: 'stagger', baseAction: 'monster-hurt', baseTime: 0.3 })));
      for (let i = 0; i < 30; i += 1) instance.animation.update(1 / 60);
      driveActorAnimation(instance, monster(), undefined, context(undefined));
      for (let i = 0; i < 40; i += 1) instance.animation.update(1 / 60);
      driveActorAnimation(instance, monster(), undefined, context(undefined));
      expect(hips.position.x).toBeCloseTo(0, 3);
      expect(hips.position.y).toBeCloseTo(1, 3);
    } finally { instance.dispose(); }
  });
});

describe('hero reaction clips', () => {
  it('a hero flinch overlays aren-hit over the standing pose without replacing it', () => {
    const { instance, hips } = heroRig();
    try {
      driveActorAnimation(instance, hero(), undefined, context(undefined));
      const rest = { x: hips.position.x, y: hips.position.y };
      driveActorAnimation(instance, hero({ reaction: reactionAt('flinch', 0.2) }), undefined, context(pose({ kind: 'flinch', overlayAction: 'aren-hit', overlayTime: 0.5, overlayShare: 0.5 })));
      expect(hips.position.x).toBeGreaterThan(rest.x + 2);
      expect(hips.position.y).toBeLessThan(rest.y);
      expect(hips.position.y).toBeGreaterThan(0.3);
    } finally { instance.dispose(); }
  });

  it('a knockback or stagger plays aren-hit as the base clip', () => {
    const { instance, hips } = heroRig();
    try {
      driveActorAnimation(instance, hero({ reaction: reactionAt('knockback', 0.5) }), undefined, context(pose({ kind: 'knockback', baseAction: 'aren-hit', baseTime: 0.55 })));
      expect(hips.position.x).toBeCloseTo(5.5, 6);
      expect(hips.position.y).toBeCloseTo(0, 6);
    } finally { instance.dispose(); }
  });

  it('keeps the vitality-drop flinch as the fallback when the engine reports no reaction, and skips it while one is reported', () => {
    const fallback = heroRig(), reported = heroRig();
    try {
      driveActorAnimation(fallback.instance, hero(), undefined, context(undefined, { vitality: 100, clock: 1 }));
      driveActorAnimation(fallback.instance, hero(), undefined, context(undefined, { vitality: 90, clock: 1 }));
      driveActorAnimation(fallback.instance, hero(), undefined, context(undefined, { vitality: 90, clock: 1.06 }));
      expect(fallback.hips.position.x).toBeGreaterThan(0.5);
      driveActorAnimation(reported.instance, hero({ reaction: reactionAt('knockback', 0.5) }), undefined, context(undefined, { vitality: 100, clock: 1 }));
      driveActorAnimation(reported.instance, hero({ reaction: reactionAt('knockback', 0.5) }), undefined, context(undefined, { vitality: 90, clock: 1 }));
      driveActorAnimation(reported.instance, hero({ reaction: reactionAt('knockback', 0.5) }), undefined, context(undefined, { vitality: 90, clock: 1.06 }));
      expect(reported.hips.position.x).toBeCloseTo(0, 6);
    } finally { fallback.instance.dispose(); reported.instance.dispose(); }
  });
});
