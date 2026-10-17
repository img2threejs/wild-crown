import { describe, expect, it } from 'bun:test';
import { AnimationClip, Bone, Group, VectorKeyframeTrack } from 'three';
import { AnimationController } from '../../src/rendering/AnimationController.js';
import { driveActorAnimation, type ActorAnimationContext } from '../../src/rendering/ActorAnimationDriver.js';
import { ASHA_CLEANSE_SECONDS, createStoryAnimationInput, type StoryAnimationInput } from '../../src/rendering/StoryActorAnimation.js';
import { ASHA_CLIP_SEGMENTS, BAMBOO_CLIP_SECONDS } from '../../src/rendering/BambooMonsterProfiles.js';
import { ASHA_ATTACK_WINDOWS } from '../../src/game/combat/ActOneBossContent.js';
import type { NativeAssetInstance } from '../../src/rendering/NativeAssetLoader.js';
import type { ActorSnapshot, AssetManifestEntry } from '../../src/game/contracts.js';

/**
 * A one-bone rig whose every bound clip reports itself: hips.x is the clip's code, hips.y the clip's normalized time x 10. The driver
 * picks the clip; the sampled bone says which one and how far into it.
 */
const CODES: Readonly<Record<string, number>> = {
  'monster-idle': 1, 'monster-walk': 2, 'monster-run': 3, 'monster-hurt': 4, 'monster-death': 5, 'monster-spawn': 6,
  'asha-stalk': 10, 'asha-corrupted-idle': 11, 'asha-cleanse': 12, 'asha-bond-idle': 13, 'asha-stalk-pounce': 14, 'asha-corrupt-slam': 15, 'asha-bamboo-charge': 16,
  'tali-play': 20, 'tali-nuzzle': 21, 'npc-talk-relaxed': 30, 'npc-talk-explain': 31, 'npc-talk-point': 32,
};
const nameOf = (code: number): string => Object.keys(CODES).find(name => CODES[name] === code)!;

function storyRig(assetId: string) {
  const group = new Group(), hips = new Bone();
  hips.name = 'hips'; group.add(hips);
  const clips = Object.keys(CODES).map(name => new AnimationClip(name, 1, [new VectorKeyframeTrack('hips.position', [0, 1], [CODES[name]!, 0, 0, CODES[name]!, 10, 0])]));
  const mapping = Object.fromEntries(Object.keys(CODES).map(name => [name, name]));
  const policy = { mode: 'in-place', evidenceStatus: 'verified' };
  const entry = { id: assetId, requiredActionIds: Object.keys(CODES), actionToClipMapping: mapping, rootMotion: Object.fromEntries(Object.keys(CODES).map(name => [name, policy])) } as unknown as AssetManifestEntry;
  const animation = new AnimationController(group, clips, entry);
  const instance = { assetId, root: group, animation, sockets: {}, dispose: () => animation.dispose() } as unknown as NativeAssetInstance;
  const story: StoryAnimationInput = createStoryAnimationInput();
  const drive = (snapshot: ActorSnapshot, clock: number): { clip: string; time: number; code: number } => {
    const context: ActorAnimationContext = { interpolate: false, alpha: 1, loopTimeSeconds: clock, manifest: undefined, story };
    driveActorAnimation(instance, snapshot, undefined, context);
    animation.update(1);
    driveActorAnimation(instance, snapshot, undefined, context);
    return { clip: nameOf(Math.round(hips.position.x)), time: hips.position.y / 10, code: hips.position.x };
  };
  return { story, drive };
}

function actor(partial: Partial<ActorSnapshot> = {}): ActorSnapshot {
  return {
    id: 'asha', archetypeId: 'asha', species: 'tiger', allegiance: 'hostile', position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 0, y: 0, z: 1 },
    actionId: 'monster-idle', phase: 'idle', normalizedTime: 0, vitality: 100, maxVitality: 100, sockets: {}, interactionRequirements: [], visible: true, downed: false, possessed: false, ...partial,
  } as unknown as ActorSnapshot;
}

describe('driving Asha through the native clip pipeline', () => {
  it('samples the custom pounce clip at the authored marker pose when the active window opens and closes', () => {
    const { drive } = storyRig('actor-asha');
    const segments = ASHA_CLIP_SEGMENTS['asha-guarding-pounce']!;
    const length = BAMBOO_CLIP_SECONDS[segments.action];
    const pounce = (attackPhase: NonNullable<ActorSnapshot['attackPhase']>, progress: number) =>
      actor({ actionId: 'wild-crown:asha-guarding-pounce' as never, attackPhase, attackPhaseProgress: progress });
    const open = drive(pounce('active', 0), 10);
    expect(open.clip).toBe('asha-stalk-pounce');
    expect(open.time * length).toBeCloseTo(segments.markers[1], 3);
    expect(drive(pounce('active', 1), 10.2).time * length).toBeCloseTo(segments.markers[2], 3);
    expect(ASHA_ATTACK_WINDOWS['asha-guarding-pounce'].activeStart).toBe(40);
  });

  it('runs the cleanse ceremony from the moment the status begins, then the bonded idle; a stale status never plays the death clip', () => {
    const { drive } = storyRig('actor-asha');
    // Her entrance (spawn) clip plays first, as for any hostile; the status is then read after it.
    drive(actor({ chapterStatus: 'sealed' }), 40);
    expect(drive(actor({ chapterStatus: 'tethered' }), 50).clip).toBe('monster-idle');
    const cleansed = actor({ chapterStatus: 'cleansed', vitality: 0, downed: true });
    const start = drive(cleansed, 51);
    expect(start.clip).toBe('asha-cleanse');
    expect(start.time).toBeCloseTo(0, 3);
    expect(drive(cleansed, 51 + ASHA_CLEANSE_SECONDS / 2).time).toBeCloseTo(0.5, 3);
    expect(drive(cleansed, 51 + ASHA_CLEANSE_SECONDS + 1).clip).toBe('asha-bond-idle');
  });

  it('prowls in phase 1 and stands in the corrupted idle afterwards', () => {
    const { drive, story } = storyRig('actor-asha');
    story.bossPhaseIndex = 0;
    expect(drive(actor({ velocity: { x: 0, y: 0, z: 1.1 } }), 1).clip).toBe('asha-stalk');
    story.bossPhaseIndex = 1;
    expect(drive(actor(), 2).clip).toBe('asha-corrupted-idle');
  });

  it('keeps the story pose under a flinch: the hurt clip is an overlay that fades back to it (a hit never freezes the idle)', () => {
    const { drive, story } = storyRig('actor-asha');
    story.bossPhaseIndex = 1;
    drive(actor(), 0);
    const flinch = (progress: number) => actor({ reaction: { kind: 'flinch', direction: { x: 0, y: 0, z: 1 }, side: 'front', strength: 0.5, progress, durationTicks: 12, serial: 1 } });
    // Mid-flinch the pose is mostly the hurt clip (code 4) pulled off the idle (code 11); at the end it is the idle again.
    expect(drive(flinch(0.1), 3).code).toBeLessThan(6);
    expect(drive(flinch(1), 3.2).code).toBeCloseTo(11, 3);
  });
});

describe('driving the rest of the cast', () => {
  it('nuzzles Tali on the reunion and lets Marek gesture while he speaks', () => {
    const tali = storyRig('actor-tali');
    tali.drive(actor({ id: 'tali', archetypeId: 'tali', allegiance: 'ally', chapterStatus: 'sheltered' }), 1);
    expect(tali.drive(actor({ id: 'tali', archetypeId: 'tali', allegiance: 'ally', chapterStatus: 'reunion' }), 2).clip).toBe('tali-nuzzle');
    const marek = storyRig('actor-marek');
    marek.story.talk = 'explain'; marek.story.talkSerial = 1;
    expect(marek.drive(actor({ id: 'marek', archetypeId: 'marek', allegiance: 'neutral', vitality: undefined }), 5).clip).toBe('npc-talk-explain');
  });

  it('shows the ally Koro rising on the clock second the swap began', () => {
    const koro = storyRig('actor-koro');
    koro.story.entranceStartedAt = 7;
    const rise = koro.drive(actor({ id: 'koro', archetypeId: 'koro', allegiance: 'ally', vitality: undefined }), 7.7);
    expect(rise.clip).toBe('monster-spawn');
    expect(rise.time).toBeCloseTo(0.5, 2);
  });
});
