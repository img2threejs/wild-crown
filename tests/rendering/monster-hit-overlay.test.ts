import { describe, expect, it } from 'bun:test';
import { AnimationClip, Bone, Group, VectorKeyframeTrack } from 'three';
import { AnimationController } from '../../src/rendering/AnimationController.js';
import { driveActorAnimation } from '../../src/rendering/ActorAnimationDriver.js';
import { resolveMonsterAnimation, resolveMonsterHitOverlay } from '../../src/rendering/MonsterAnimationProfiles.js';
import type { NativeAssetInstance } from '../../src/rendering/NativeAssetLoader.js';
import type { ActorSnapshot, AssetManifestEntry } from '../../src/game/contracts.js';
import { flinchAt } from './reaction-fixtures.js';

const BOAR = 'actor-ember-boar';

function monster(partial: Partial<ActorSnapshot> = {}): ActorSnapshot {
  return {
    id: 'boar', archetypeId: 'corrupted-boar', allegiance: 'hostile', position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 0, y: 0, z: 1 },
    actionId: 'monster-idle', phase: 'idle', normalizedTime: 0, sockets: {}, interactionRequirements: [], visible: true, downed: false, possessed: false, ...partial,
  } as unknown as ActorSnapshot;
}
const attacking = (attackPhase: NonNullable<ActorSnapshot['attackPhase']>, flinchProgress?: number): ActorSnapshot =>
  monster({ actionId: 'wild-crown:boar-gale-scythe' as never, attackPhase, attackPhaseProgress: 0.5, reaction: flinchProgress === undefined ? undefined : flinchAt(flinchProgress) });

describe('monster hit overlay decisions', () => {
  it('exists only while the engine reports a reaction on a living monster', () => {
    expect(resolveMonsterHitOverlay(monster(), BOAR)).toBeUndefined();
    expect(resolveMonsterHitOverlay(monster({ reaction: flinchAt(0.2) }), BOAR)?.actionId).toBe('monster-hurt');
    expect(resolveMonsterHitOverlay(monster({ reaction: flinchAt(0.2), downed: true }), BOAR)).toBeUndefined();
    expect(resolveMonsterHitOverlay(monster({ reaction: flinchAt(0.2) }), 'actor-not-a-monster')).toBeUndefined();
    // Heavier reactions replace the clip (ReactionPresenter) instead of overlaying the flinch.
    expect(resolveMonsterHitOverlay(monster({ reaction: { ...flinchAt(0.2), kind: 'stagger' } }), BOAR)).toBeUndefined();
  });

  it('never replaces the base clip', () => {
    expect(resolveMonsterAnimation(monster({ reaction: flinchAt(0.3), velocity: { x: 6, y: 0, z: 0 } }), BOAR)).toMatchObject({ actionId: 'monster-run' });
    expect(resolveMonsterAnimation(attacking('windup', 0.1), BOAR)).toEqual(resolveMonsterAnimation(attacking('windup'), BOAR)!);
  });
});

/**
 * Real controller on a one-bone rig. Base clips show their sampled time on y (`slash`: y = t); the hurt clip shows a recoil on x
 * (x = 10 t) and nothing on y, so a recoil blended in at share s scales the base pose by (1 - s) and adds s * 10 * t on x.
 */
function monsterRig() {
  const root = new Group(), hips = new Bone();
  hips.name = 'hips'; root.add(hips);
  const track = (values: number[]) => new VectorKeyframeTrack('hips.position', [0, 1], values);
  const clips = [
    new AnimationClip('idle', 1, [track([0, 0, 0, 0, 0, 0])]),
    new AnimationClip('slash', 1, [track([0, 0, 0, 0, 1, 0])]),
    new AnimationClip('hurt', 1, [track([0, 0, 0, 10, 0, 0])]),
  ];
  const policy = { mode: 'in-place', evidenceStatus: 'verified' };
  const manifest = {
    id: BOAR, requiredActionIds: ['monster-idle', 'wild-crown:boar-gale-scythe', 'monster-hurt'],
    actionToClipMapping: { 'monster-idle': 'idle', 'wild-crown:boar-gale-scythe': 'slash', 'monster-hurt': 'hurt' },
    rootMotion: { 'monster-idle': policy, 'wild-crown:boar-gale-scythe': policy, 'monster-hurt': policy },
  } as unknown as AssetManifestEntry;
  const animation = new AnimationController(root, clips, manifest);
  const instance = { assetId: BOAR, root, animation, sockets: {}, dispose: () => animation.dispose() } as unknown as NativeAssetInstance;
  const drive = (snapshot: ActorSnapshot): { x: number; y: number } => {
    driveActorAnimation(instance, snapshot, undefined, { interpolate: false, alpha: 1, loopTimeSeconds: 1, manifest: undefined });
    return { x: hips.position.x, y: hips.position.y };
  };
  return { instance, animation, drive };
}

describe('monster hit overlay on a real rig', () => {
  it('shows the recoil on the frame of the hit, held untouched through hit-stop frames', () => {
    const { instance, animation, drive } = monsterRig();
    try {
      const rest = drive(monster());
      expect(rest.x).toBeCloseTo(0, 6);
      expect(rest.y).toBeCloseTo(0, 6);
      const hit = drive(monster({ reaction: flinchAt(0) }));
      expect(hit.x).toBeGreaterThan(0.5); // recoil already visible, no waiting for a fade
      // Hit-stop: render frames advance real time but the world (and the sampled snapshot) stands still.
      for (let frame = 0; frame < 8; frame++) {
        animation.update(1 / 60, true);
        expect(drive(monster({ reaction: flinchAt(0) }))).toEqual(hit);
      }
    } finally { instance.dispose(); }
  });

  it('keeps the attack clip and its sampled time while flinching, with a lower weight', () => {
    const control = monsterRig(), struck = monsterRig();
    try {
      const plain = control.drive(attacking('windup'));
      expect(plain.y).toBeGreaterThan(0.05); // the slash clip is the base pose
      const flinch = struck.drive(attacking('windup', 0));
      expect(flinch.x).toBeGreaterThan(0);
      expect(flinch.y).toBeGreaterThan(plain.y * 0.5); // most of the attack pose remains
      expect(flinch.y).toBeLessThan(plain.y);
      // The damaging window keeps even more of the pose than the wind-up.
      const activePlain = control.drive(attacking('active')), activeFlinch = struck.drive(attacking('active', 0));
      expect(activeFlinch.y / activePlain.y).toBeGreaterThan(flinch.y / plain.y);
    } finally { control.instance.dispose(); struck.instance.dispose(); }
  });

  it('restarts the recoil on a second hit after the first decayed, and clears after the hit window', () => {
    const { instance, drive } = monsterRig();
    try {
      const first = drive(monster({ reaction: flinchAt(0) }));
      const decayed = drive(monster({ reaction: flinchAt(0.95) }));
      expect(decayed.x).toBeLessThan(first.x * 0.3);
      const second = drive(monster({ reaction: flinchAt(0) }));
      expect(second.x).toBeCloseTo(first.x, 6);
      expect(drive(monster()).x).toBeCloseTo(0, 6); // reaction over: overlay removed, base pose only
    } finally { instance.dispose(); }
  });
});
