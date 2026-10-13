import { describe, expect, it } from 'bun:test';
import { AnimationClip, Bone, Group, Vector3, VectorKeyframeTrack } from 'three';
import { AnimationController } from '../../src/rendering/AnimationController.js';
import { driveActorAnimation, monsterHopHeight } from '../../src/rendering/ActorAnimationDriver.js';
import { resolveMonsterAnimation } from '../../src/rendering/MonsterAnimationProfiles.js';
import { NativeAssetLoader, type NativeAssetInstance } from '../../src/rendering/NativeAssetLoader.js';
import type { ActorSnapshot, AssetManifestEntry } from '../../src/game/contracts.js';

/** Synthetic character: the head bone sits 1 m along the model's NATIVE head direction `head` (before any manifest correction). */
function syntheticTemplate(head: Vector3, manifest: AssetManifestEntry) {
  const root = new Group(), hips = new Bone(), neck = new Bone();
  hips.name = 'hips'; neck.name = 'head'; neck.position.copy(head);
  hips.add(neck); root.add(hips);
  return { key: manifest.id, root, clips: [], manifest, leases: 0, lastUsed: 0, evictWhenFree: false };
}

function manifestFor(kind: 'character' | 'prop', forward: { x: number; y: number; z: number }, scale = 2): AssetManifestEntry {
  return {
    id: 'synthetic-' + kind, kind, coordinateTransform: { forward, scale }, sockets: [], requiredActionIds: [], actionToClipMapping: {}, castSocketBone: 'head',
  } as unknown as AssetManifestEntry;
}

/** The manifest builders encode the native head h as the corrective heading f = (-h.x, 0, h.z); the loader's inner node applies atan2(f.x, f.z). */
const encodedForward = (h: Vector3) => ({ x: -h.x, y: 0, z: h.z });
const NATIVE_HEADS: readonly [string, Vector3][] = [
  ['+Z', new Vector3(0, 0, 1)], ['-Z', new Vector3(0, 0, -1)], ['+X', new Vector3(1, 0, 0)], ['-X', new Vector3(-1, 0, 0)],
  ['howl-scout oblique', new Vector3(0.6763, 0, 0.7366).normalize()], ['ghor oblique', new Vector3(0.9249, 0, 0.3801).normalize()],
];

async function loadSynthetic(head: Vector3, kind: 'character' | 'prop' = 'character') {
  const manifest = manifestFor(kind, encodedForward(head));
  const loader = new NativeAssetLoader();
  const template = syntheticTemplate(head, manifest);
  // The loader's template acquisition is private; the test substitutes a synthetic in-memory template for the GLB fetch.
  const seam = loader as unknown as { acquireTemplate: () => Promise<unknown> };
  seam.acquireTemplate = async () => { template.leases++; return template; };
  return { loader, instance: await loader.load(manifest), manifest };
}

describe('character forward correction lives on an inner node', () => {
  for (const [name, head] of NATIVE_HEADS) {
    it(`${name}: the head points along the simulation facing for every yaw the renderer writes`, async () => {
      const { loader, instance } = await loadSynthetic(head);
      try {
        // The root carries no correction of its own: the renderer is free to overwrite position/yaw every frame.
        expect(instance.root.rotation.y).toBe(0);
        expect(instance.root.scale.x).toBe(1);
        const cast = instance.sockets.cast!;
        expect(cast).toBeDefined();
        for (const yaw of [0, 0.5, -1.3, Math.PI / 2, Math.PI, -Math.PI / 2, 2.6]) {
          instance.root.position.set(4, 0, -7);
          instance.root.rotation.y = yaw;
          instance.root.updateMatrixWorld(true);
          const offset = cast.getWorldPosition(new Vector3()).sub(instance.root.getWorldPosition(new Vector3()));
          const error = Math.atan2(Math.sin(Math.atan2(offset.x, offset.z) - yaw), Math.cos(Math.atan2(offset.x, offset.z) - yaw));
          expect(Math.abs(error)).toBeLessThan(1e-6);
          expect(Math.hypot(offset.x, offset.z)).toBeCloseTo(2, 6); // manifest scale is applied below the root
        }
      } finally { instance.dispose(); loader.dispose(); }
    });
  }

  it('props keep the legacy single-node transform (static batches, movable props and weapons are unchanged)', async () => {
    const head = new Vector3(1, 0, 0);
    const { loader, instance, manifest } = await loadSynthetic(head, 'prop');
    try {
      expect(instance.root.scale.x).toBe(manifest.coordinateTransform!.scale);
      expect(instance.root.rotation.y).toBeCloseTo(Math.atan2(-1, 0), 9);
    } finally { instance.dispose(); loader.dispose(); }
  });
});

function slashRig() {
  const root = new Group(), hips = new Bone();
  hips.name = 'hips'; root.add(hips);
  const rise = new AnimationClip('rise', 1, [new VectorKeyframeTrack('hips.position', [0, 1], [0, 0, 0, 0, 1, 0])]);
  const drop = new AnimationClip('drop', 1, [new VectorKeyframeTrack('hips.position', [0, 1], [0, 2, 0, 0, 2, 0])]);
  const policy = { mode: 'in-place', evidenceStatus: 'verified' };
  const manifest = {
    id: 'synthetic-monster', requiredActionIds: ['monster-slash', 'monster-shoot'],
    actionToClipMapping: { 'monster-slash': 'rise', 'monster-shoot': 'drop' },
    rootMotion: { 'monster-slash': policy, 'monster-shoot': policy },
  } as unknown as AssetManifestEntry;
  const controller = new AnimationController(root, [rise, drop], manifest);
  return { controller, hips };
}

describe('monster clip blending', () => {
  it('crossfades a finite clip that restarts on the same slot instead of popping', () => {
    const { controller, hips } = slashRig();
    controller.setBlendSeconds(0.12);
    controller.play('monster-slash', 'active', 0.9, 0);
    expect(hips.position.y).toBeCloseTo(0.9, 6);
    controller.play('monster-slash', 'active', 0, 0);
    expect(hips.position.y).toBeCloseTo(0.9, 6); // the restart frame still shows the previous pose
    controller.update(0.06);
    expect(hips.position.y).toBeCloseTo(0.45, 6); // halfway through the fade
    controller.update(0.06);
    expect(hips.position.y).toBeCloseTo(0, 6);
    controller.update(0.5);
    expect(hips.position.y).toBeCloseTo(0, 6);
    controller.dispose();
  });

  it('keeps the old behaviour (no restart blend) when no blend is requested', () => {
    const { controller, hips } = slashRig();
    controller.play('monster-slash', 'active', 0.9, 0);
    controller.play('monster-slash', 'active', 0, 0);
    expect(hips.position.y).toBeCloseTo(0, 6);
    controller.dispose();
  });

  it('does not treat normal forward progress as a restart', () => {
    const { controller, hips } = slashRig();
    controller.setBlendSeconds(0.12);
    controller.play('monster-slash', 'active', 0.1, 0);
    controller.play('monster-slash', 'active', 0.5, 0);
    expect(hips.position.y).toBeCloseTo(0.5, 6);
    controller.dispose();
  });

  it('chains into the next attack clip over the requested blend time', () => {
    const { controller, hips } = slashRig();
    controller.setBlendSeconds(0.12);
    controller.play('monster-slash', 'active', 1, 0);
    controller.play('monster-shoot', 'active', 0, 0);
    expect(hips.position.y).toBeCloseTo(1, 6);
    controller.update(0.06);
    expect(hips.position.y).toBeCloseTo(1.5, 6);
    controller.update(0.06);
    expect(hips.position.y).toBeCloseTo(2, 6);
    controller.dispose();
  });
});

describe('repeated and interrupted restarts', () => {
  it('stays continuous when a restart interrupts a running restart fade, and settles on the sampled target every time', () => {
    const { controller, hips } = slashRig();
    controller.setBlendSeconds(0.12);
    controller.play('monster-slash', 'active', 0.9, 0);
    controller.play('monster-slash', 'active', 0, 0);
    controller.update(0.03);
    controller.play('monster-slash', 'active', 0.5, 0);
    const shown = hips.position.y;
    expect(shown).toBeGreaterThan(0.5); // still pulled towards the captured pose
    expect(shown).toBeLessThan(0.9);
    controller.play('monster-slash', 'active', 0.1, 0); // a second restart while the first fade is still running
    expect(hips.position.y).toBeCloseTo(shown, 5); // the blended pose being shown is what the new fade starts from
    controller.update(0.06);
    expect(hips.position.y).toBeGreaterThan(0.1);
    expect(hips.position.y).toBeLessThan(shown);
    controller.update(0.2);
    expect(hips.position.y).toBeCloseTo(0.1, 5);
    for (let cycle = 0; cycle < 4; cycle += 1) {
      controller.play('monster-slash', 'active', 0.8, 0);
      expect(hips.position.y).toBeCloseTo(0.8, 5);
      controller.play('monster-slash', 'active', 0.1, 0);
      expect(hips.position.y).toBeCloseTo(0.8, 5);
      controller.update(0.2);
      expect(hips.position.y).toBeCloseTo(0.1, 5);
    }
    controller.dispose();
  });

  it('hands over to a different clip cleanly while a restart fade is running', () => {
    const { controller, hips } = slashRig();
    controller.setBlendSeconds(0.12);
    controller.play('monster-slash', 'active', 0.9, 0);
    controller.play('monster-slash', 'active', 0, 0);
    controller.update(0.03);
    controller.play('monster-shoot', 'active', 0, 0);
    const shown = hips.position.y;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(0.9);
    controller.update(0.3);
    expect(hips.position.y).toBeCloseTo(2, 5);
    controller.dispose();
  });
});

/** Two distinct clips on one bone: `aren-jump` shows y = t, `aren-air-step` shows y = 10 + t, so the pose on screen names the clip and the sampled time. */
function jumpRig(withAirStep: boolean) {
  const root = new Group(), hips = new Bone();
  hips.name = 'hips'; root.add(hips);
  const track = (offset: number) => new VectorKeyframeTrack('hips.position', [0, 1], [0, offset, 0, 0, offset + 1, 0]);
  const clips = [new AnimationClip('jump', 1, [track(0)]), ...(withAirStep ? [new AnimationClip('air', 1, [track(10)])] : [])];
  const policy = { mode: 'in-place', evidenceStatus: 'verified' };
  const manifest = {
    id: 'actor-aren', requiredActionIds: ['aren-jump'],
    actionToClipMapping: { 'aren-jump': 'jump', ...(withAirStep ? { 'aren-air-step': 'air' } : {}) },
    rootMotion: { 'aren-jump': policy, ...(withAirStep ? { 'aren-air-step': policy } : {}) },
  } as unknown as AssetManifestEntry;
  const animation = new AnimationController(root, clips, manifest);
  const instance = { assetId: 'actor-aren', root, animation, sockets: {}, dispose: () => animation.dispose() } as unknown as NativeAssetInstance;
  return { instance, hips };
}

const actor = (patch: Partial<ActorSnapshot>): ActorSnapshot => ({
  id: 'aren', archetypeId: 'aren', species: 'human', allegiance: 'player', position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 0, y: 0, z: 1 },
  actionId: 'aren-jump', phase: 'active', normalizedTime: 0.4, sockets: {}, interactionRequirements: [], visible: true, downed: false, possessed: false, ...patch,
}) as ActorSnapshot;
const still = { interpolate: false, alpha: 1, loopTimeSeconds: 1, manifest: undefined };

/** The pose shown the first frame an actor snapshot is driven (fresh rig, so no fade is involved). */
function shownPose(withAirStep: boolean, snapshot: Partial<ActorSnapshot>, previous?: Partial<ActorSnapshot>, alpha = 1): number {
  const { instance, hips } = jumpRig(withAirStep);
  driveActorAnimation(instance, actor(snapshot), previous ? actor(previous) : undefined, { ...still, interpolate: previous !== undefined, alpha });
  const y = hips.position.y;
  instance.dispose();
  return y;
}
const AIR = 10; // pose offset that identifies the air-step clip

describe('boosted jump clip selection', () => {
  it('shows the air-step clip along the rising / falling / landing schedule, continuous at the phase boundaries', () => {
    const at = (jumpPhase: ActorSnapshot['jumpPhase'], jumpPhaseProgress: number) => shownPose(true, { jumpBoosted: true, jumpPhase, jumpPhaseProgress }) - AIR;
    expect(at('rising', 0)).toBeCloseTo(0, 5);
    expect(at('rising', 1)).toBeCloseTo(0.5, 5);
    expect(at('falling', 0)).toBeCloseTo(at('rising', 1), 5);
    expect(at('falling', 1)).toBeCloseTo(0.82, 5);
    expect(at('landing', 0)).toBeCloseTo(at('falling', 1), 5);
    expect(at('landing', 1)).toBeCloseTo(1, 5);
    let last = -1;
    for (const [phase, steps] of [['rising', 4], ['falling', 4], ['landing', 4]] as const) {
      for (let i = 0; i <= steps; i += 1) {
        const value = at(phase, i / steps);
        expect(value).toBeGreaterThanOrEqual(last - 1e-6);
        last = value;
      }
    }
  });

  it('keeps the standard jump clip for an unboosted jump even when the air-step clip exists', () => {
    const y = shownPose(true, { jumpBoosted: false, jumpPhase: 'rising', jumpPhaseProgress: 1 });
    expect(y).toBeLessThan(AIR / 2);
    expect(y).toBeGreaterThan(0);
  });

  it('falls back to the standard jump clip for a boosted jump when the rig has no air-step clip', () => {
    const boosted = shownPose(false, { jumpBoosted: true, jumpPhase: 'falling', jumpPhaseProgress: 0.5 });
    const normal = shownPose(true, { jumpBoosted: false, jumpPhase: 'falling', jumpPhaseProgress: 0.5 });
    expect(boosted).toBeLessThan(AIR / 2);
    expect(boosted).toBeCloseTo(normal, 6);
  });

  it('interpolates the phase progress between snapshots of the same boosted phase', () => {
    const previous = { jumpBoosted: true, jumpPhase: 'rising' as const, jumpPhaseProgress: 0.2 };
    const current = { jumpBoosted: true, jumpPhase: 'rising' as const, jumpPhaseProgress: 0.6 };
    const half = shownPose(true, current, previous, 0.5);
    const exact = shownPose(true, { ...current, jumpPhaseProgress: 0.4 });
    expect(half).toBeCloseTo(exact, 6);
    expect(half).toBeGreaterThan(shownPose(true, previous));
    expect(half).toBeLessThan(shownPose(true, current));
  });

  it('crossfades from the jump pose into the air-step pose at the boost instead of popping', () => {
    const { instance, hips } = jumpRig(true);
    driveActorAnimation(instance, actor({ jumpBoosted: false, jumpPhase: 'rising', jumpPhaseProgress: 1 }), undefined, still);
    const before = hips.position.y;
    driveActorAnimation(instance, actor({ jumpBoosted: true, jumpPhase: 'rising', jumpPhaseProgress: 1 }), undefined, still);
    expect(Math.abs(hips.position.y - before)).toBeLessThan(1e-5); // the boost frame still shows the pose it came from
    instance.animation.update(0.04);
    expect(hips.position.y).toBeGreaterThan(before);
    expect(hips.position.y).toBeLessThan(AIR);
    instance.animation.update(0.3);
    expect(hips.position.y).toBeCloseTo(AIR + 0.5, 5);
    instance.dispose();
  });
});

describe('presentation-only monster hop', () => {
  const monster = (patch: Partial<ActorSnapshot>) => actor({ id: 'm' as ActorSnapshot['id'], allegiance: 'hostile', actionId: 'wild-crown:howler-leap-slam' as ActorSnapshot['actionId'], attackPhase: 'active', ...patch });
  const jump = { actionId: 'monster-jump' as const, normalizedTime: 0.5 };
  const hop = (progress: number, asset = 'actor-thornback-howler', patch: Partial<ActorSnapshot> = {}, actionId: 'monster-jump' | 'monster-slash' = 'monster-jump') =>
    monsterHopHeight(monster({ attackPhase: 'commit', attackPhaseProgress: progress, ...patch }), asset, { actionId, normalizedTime: 0.3 + progress * 0.4 });

  it('is a symmetric arc over the authored flight, with no offset before takeoff or after landing', () => {
    expect(hop(0)).toBeCloseTo(0, 9);
    expect(hop(1)).toBeCloseTo(0, 9);
    expect(hop(0.5)).toBeGreaterThan(0.05);
    for (const progress of [0.1, 0.25, 0.4]) {
      expect(hop(progress)).toBeCloseTo(hop(1 - progress), 9);
      expect(hop(progress)).toBeGreaterThan(0);
      expect(hop(progress)).toBeLessThan(hop(0.5));
    }
    expect(hop(0.25)).toBeLessThan(hop(0.4));
    expect(hop(-0.5)).toBe(0);
    expect(hop(1.5)).toBe(0);
  });

  it('applies during commit or active flight, never during anticipation, recovery or non-jump attacks', () => {
    expect(hop(0.5, 'actor-thornback-howler', { attackPhase: 'active' })).toBeGreaterThan(0);
    expect(hop(0.5, 'actor-thornback-howler', { attackPhase: 'windup' })).toBe(0);
    expect(hop(0.5, 'actor-thornback-howler', { attackPhase: 'recovery' })).toBe(0);
    expect(hop(0.5, 'actor-thornback-howler', {}, 'monster-slash')).toBe(0);
    expect(hop(0.5, 'actor-thornback-howler', { downed: true })).toBe(0);
    expect(monsterHopHeight(monster({ attackPhase: undefined }), 'actor-thornback-howler', jump)).toBe(0);
  });

  it('lands a howler leap before its damaging slam instead of starting a second hop at contact', () => {
    const asset = 'actor-thornback-howler';
    const flight = monster({ attackPhase: 'commit', attackPhaseProgress: 0.5 });
    expect(monsterHopHeight(flight, asset, resolveMonsterAnimation(flight, asset))).toBeGreaterThan(0);
    for (const progress of [0, 0.25, 0.5, 1]) {
      const contact = monster({ attackPhase: 'active', attackPhaseProgress: progress });
      expect(monsterHopHeight(contact, asset, resolveMonsterAnimation(contact, asset))).toBe(0);
    }
  });

  it('is zero for hovering avians, which keep their own flight curve', () => {
    expect(hop(0.5, 'actor-storm-hornbill')).toBe(0);
  });

  it('gives every asset a finite, plausible height (assets without a table entry use a scale-based fallback)', () => {
    for (const asset of ['actor-ember-boar', 'actor-ghor-mire-maw', 'actor-unlisted']) {
      const peak = hop(0.5, asset);
      expect(Number.isFinite(peak)).toBe(true);
      expect(peak).toBeGreaterThan(0.05);
      expect(peak).toBeLessThan(1);
    }
  });
});
