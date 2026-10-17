import { describe, expect, it } from 'bun:test';
import {
  ASHA_CLEANSE_SECONDS, NPC_POINT_SECONDS, TALI_NUZZLE_SECONDS, TALI_TREMBLE, createMutableSample, createStoryAnimationInput, createStoryAnimationState, resolveStoryAnimation, trackStoryAnimation,
  type StoryAnimationInput,
} from '../../src/rendering/StoryActorAnimation.js';
import { MONSTER_HURT_HOLD_TIME, MONSTER_SPAWN_SECONDS, resolveMonsterAnimation } from '../../src/rendering/MonsterAnimationProfiles.js';
import type { ActorSnapshot } from '../../src/game/contracts.js';

const ASHA = 'actor-asha', TALI = 'actor-tali', MAREK = 'actor-marek', KORO = 'actor-koro', KORO_BB = 'actor-koro-branchbreaker';

function actor(partial: Partial<ActorSnapshot> = {}): ActorSnapshot {
  return {
    id: 'asha', archetypeId: 'asha', species: 'tiger', allegiance: 'hostile', position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 0, y: 0, z: 1 },
    actionId: 'monster-idle', phase: 'idle', normalizedTime: 0, vitality: 100, maxVitality: 100, sockets: {}, interactionRequirements: [], visible: true, downed: false, possessed: false, ...partial,
  } as unknown as ActorSnapshot;
}
const moving = (speed: number) => ({ velocity: { x: 0, y: 0, z: speed } });

/** One story actor as the driver sees it: facts + per-instance memory; `frame` tracks then resolves, returning a plain copy of the sample. */
function rig(assetId: string, overrides: Partial<StoryAnimationInput> = {}) {
  const input: StoryAnimationInput = { ...createStoryAnimationInput(), ...overrides };
  const state = createStoryAnimationState(), out = createMutableSample();
  return {
    input,
    frame(snapshot: ActorSnapshot, clock: number) {
      trackStoryAnimation(snapshot, input, state, clock);
      const sample = resolveStoryAnimation(snapshot, assetId, input, state, clock, out);
      return sample === undefined ? undefined : { ...sample };
    },
  };
}

describe('Asha', () => {
  it('plays the authored cleanse clip once over its 2.8 s and then holds the bonded idle (nonlethal)', () => {
    const asha = rig(ASHA);
    expect(asha.frame(actor({ chapterStatus: 'tethered' }), 10)).toBeUndefined();
    const cleansed = actor({ chapterStatus: 'cleansed', vitality: 0, downed: true });
    expect(asha.frame(cleansed, 10.5)).toMatchObject({ actionId: 'asha-cleanse', phase: 'active', normalizedTime: 0 });
    expect(asha.frame(cleansed, 10.5 + ASHA_CLEANSE_SECONDS / 2)!.normalizedTime).toBeCloseTo(0.5, 9);
    // The reunion status continues the same ceremony (it does not restart the clip), then the bonded stance holds.
    expect(asha.frame(actor({ chapterStatus: 'reunion', vitality: 0, downed: true }), 10.5 + ASHA_CLEANSE_SECONDS * 0.75)!.normalizedTime).toBeCloseTo(0.75, 9);
    expect(asha.frame(actor({ chapterStatus: 'reunion', vitality: 0 }), 10.5 + ASHA_CLEANSE_SECONDS + 0.01)).toMatchObject({ actionId: 'asha-bond-idle', phase: 'idle' });
  });

  it('holds the bonded idle, without replaying the ceremony, when first seen already cleansed (load or checkpoint restore)', () => {
    const asha = rig(ASHA);
    expect(asha.frame(actor({ chapterStatus: 'cleansed' }), 500)).toMatchObject({ actionId: 'asha-bond-idle' });
    expect(asha.frame(actor({ chapterStatus: 'cleansed' }), 500.2)).toMatchObject({ actionId: 'asha-bond-idle' });
  });

  it('stalks low in phase 1, stands corrupted from phase 2, and leaves combat poses and fast gaits to the generic resolver', () => {
    const asha = rig(ASHA, { bossPhaseIndex: 0 });
    expect(asha.frame(actor(moving(1.1)), 1)).toMatchObject({ actionId: 'asha-stalk', phase: 'idle' });
    expect(asha.frame(actor(moving(4.2)), 1.1)).toBeUndefined();
    expect(asha.frame(actor(), 1.2)).toBeUndefined();
    asha.input.bossPhaseIndex = 1;
    expect(asha.frame(actor(), 1.3)).toMatchObject({ actionId: 'asha-corrupted-idle' });
    asha.input.bossPhaseIndex = 2;
    expect(asha.frame(actor(), 1.4)).toMatchObject({ actionId: 'asha-corrupted-idle' });
    expect(asha.frame(actor({ attackPhase: 'windup', attackPhaseProgress: 0.2, actionId: 'wild-crown:asha-guarding-pounce' as never }), 1.5)).toBeUndefined();
    expect(asha.frame(actor({ roarProgress: 0.3 }), 1.6)).toBeUndefined();
    expect(asha.frame(actor({ weakPointExposed: true }), 1.7)).toBeUndefined();
  });

  it('is a plain monster outside an encounter (no boss phase), and bonded when an ally stands still', () => {
    expect(rig(ASHA).frame(actor(), 1)).toBeUndefined();
    const ally = rig(ASHA);
    expect(ally.frame(actor({ allegiance: 'ally' }), 1)).toMatchObject({ actionId: 'asha-bond-idle' });
    expect(ally.frame(actor({ allegiance: 'ally', ...moving(2) }), 1.1)).toBeUndefined();
  });

  it('draws the cleansed boss with the nonlethal clip and never the death clip', () => {
    const cleansed = actor({ chapterStatus: 'cleansed', vitality: 0, downed: true });
    expect(resolveMonsterAnimation(cleansed, ASHA)).toBeDefined();
    const sample = rig(ASHA).frame(cleansed, 1)!;
    expect(sample.actionId).not.toBe('monster-death');
  });
});

describe('Tali', () => {
  it('trembles in the hurt clip\'s dazed hold while in danger, and runs the generic gait once she moves', () => {
    const tali = rig(TALI);
    const sample = tali.frame(actor({ id: 'tali', archetypeId: 'tali', allegiance: 'ally', chapterStatus: 'in-danger' }), 3)!;
    expect(sample).toMatchObject({ actionId: 'monster-hurt', phase: 'active' });
    expect(Math.abs(sample.normalizedTime - MONSTER_HURT_HOLD_TIME)).toBeLessThanOrEqual(TALI_TREMBLE.amplitude + 1e-9);
    // A pure function of the world clock: a paused world holds the pose, a later clock moves it.
    expect(tali.frame(actor({ id: 'tali', allegiance: 'ally', chapterStatus: 'in-danger' }), 3)!.normalizedTime).toBe(sample.normalizedTime);
    expect(tali.frame(actor({ id: 'tali', allegiance: 'ally', chapterStatus: 'in-danger', ...moving(3) }), 3.05)).toBeUndefined();
  });

  it('nuzzles once on the reunion and then plays while the field is calm', () => {
    const tali = rig(TALI, { calm: true });
    tali.frame(actor({ allegiance: 'ally', chapterStatus: 'sheltered' }), 20);
    expect(tali.frame(actor({ allegiance: 'ally', chapterStatus: 'reunion' }), 21)).toMatchObject({ actionId: 'tali-nuzzle', normalizedTime: 0 });
    expect(tali.frame(actor({ allegiance: 'ally', chapterStatus: 'reunion' }), 21 + TALI_NUZZLE_SECONDS * 0.5)!.normalizedTime).toBeCloseTo(0.5, 9);
    expect(tali.frame(actor({ allegiance: 'ally', chapterStatus: 'reunion' }), 21 + TALI_NUZZLE_SECONDS + 0.1)).toMatchObject({ actionId: 'tali-play', phase: 'idle' });
    tali.input.calm = false;
    expect(tali.frame(actor({ allegiance: 'ally', chapterStatus: 'reunion' }), 30)).toBeUndefined();
  });

  it('plays the cub bow only when calm and still, never as a hostile', () => {
    const tali = rig(TALI, { calm: true });
    expect(tali.frame(actor({ allegiance: 'ally' }), 1)).toMatchObject({ actionId: 'tali-play' });
    expect(tali.frame(actor({ allegiance: 'ally', ...moving(1) }), 1.1)).toBeUndefined();
    expect(rig(TALI, { calm: true }).frame(actor({ allegiance: 'hostile' }), 1)).toBeUndefined();
  });
});

describe('Marek', () => {
  it('speaks with the talking idle of the current line and keeps the generic idle otherwise', () => {
    const marek = rig(MAREK, { talk: 'explain', talkSerial: 1 });
    expect(marek.frame(actor({ allegiance: 'neutral' }), 5)).toMatchObject({ actionId: 'npc-talk-explain', phase: 'idle' });
    marek.input.talk = 'guarded'; marek.input.talkSerial = 2;
    expect(marek.frame(actor({ allegiance: 'neutral' }), 6)).toMatchObject({ actionId: 'npc-talk-guarded' });
    marek.input.talk = 'relaxed'; marek.input.talkSerial = 3;
    expect(marek.frame(actor({ allegiance: 'neutral' }), 7)).toMatchObject({ actionId: 'npc-talk-relaxed' });
    marek.input.talk = null; marek.input.talkSerial = 4;
    expect(marek.frame(actor({ allegiance: 'neutral' }), 8)).toBeUndefined();
  });

  it('points once from the start of the line and then relaxes; a walking Marek never gestures', () => {
    const marek = rig(MAREK, { talk: null, talkSerial: 0 });
    marek.frame(actor({ allegiance: 'neutral' }), 9);
    marek.input.talk = 'point'; marek.input.talkSerial = 1;
    expect(marek.frame(actor({ allegiance: 'neutral' }), 10)).toMatchObject({ actionId: 'npc-talk-point', phase: 'active', normalizedTime: 0 });
    expect(marek.frame(actor({ allegiance: 'neutral' }), 10 + NPC_POINT_SECONDS / 2)!.normalizedTime).toBeCloseTo(0.5, 9);
    expect(marek.frame(actor({ allegiance: 'neutral' }), 10 + NPC_POINT_SECONDS + 0.1)).toMatchObject({ actionId: 'npc-talk-relaxed' });
    expect(marek.frame(actor({ allegiance: 'neutral', ...moving(1.4) }), 20)).toBeUndefined();
  });

  it('plays assistance from simulation progress without a dialogue and holds it while the world is paused', () => {
    const marek = rig(MAREK);
    const helping = actor({ id: 'marek', allegiance: 'neutral', actionId: 'npc-talk-point', phase: 'active', normalizedTime: 0.4 });
    expect(marek.frame(helping, 10)).toMatchObject({ actionId: 'npc-talk-point', phase: 'active', normalizedTime: 0.4 });
    expect(marek.frame(helping, 20)).toMatchObject({ normalizedTime: 0.4 });
    expect(marek.frame({ ...helping, normalizedTime: 0.8 }, 21)).toMatchObject({ normalizedTime: 0.8 });
    expect(marek.frame({ ...helping, ...moving(1.4) }, 22)).toBeUndefined();
    expect(marek.frame({ ...helping, downed: true }, 23)).toBeUndefined();
    expect(marek.frame(actor({ id: 'marek', allegiance: 'neutral' }), 24)).toBeUndefined();
  });
});

describe('camp hunters', () => {
  it('kneel over the authored subdue clip and then hold the kneel idle; a restored subdued hunter holds the kneel; never a death', () => {
    const hunter = rig('actor-camp-hunter-melee');
    hunter.frame(actor({ id: 'hunter-1', archetypeId: 'hunter' }), 1);
    const subdued = actor({ id: 'hunter-1', allegiance: 'neutral', chapterStatus: 'subdued', vitality: 0, downed: true });
    expect(hunter.frame(subdued, 2)).toMatchObject({ actionId: 'hunter-subdue', phase: 'active', normalizedTime: 0 });
    expect(hunter.frame(subdued, 2.8)!.normalizedTime).toBeCloseTo(0.5, 9);
    expect(hunter.frame(subdued, 4)).toMatchObject({ actionId: 'hunter-kneel-idle', phase: 'idle' });
    expect(rig('actor-camp-hunter-ranged').frame(actor({ chapterStatus: 'kneeling', vitality: 0 }), 9)).toMatchObject({ actionId: 'hunter-kneel-idle' });
    expect(rig('actor-camp-hunter-melee').frame(actor({ chapterStatus: 'subdued' }), 9)).toMatchObject({ actionId: 'hunter-kneel-idle' });
    expect(hunter.frame(actor({}), 10)).toBeUndefined();
  });
});

describe('Koro', () => {
  it('rises with the spawn clip once after the cleanse swap, then stands calm', () => {
    const koro = rig(KORO, { entranceStartedAt: 100 });
    expect(koro.frame(actor({ id: 'koro', allegiance: 'ally', chapterStatus: 'cleansed' }), 100)).toMatchObject({ actionId: 'monster-spawn', phase: 'active', normalizedTime: 0 });
    expect(koro.frame(actor({ id: 'koro', allegiance: 'ally' }), 100 + MONSTER_SPAWN_SECONDS / 2)!.normalizedTime).toBeCloseTo(0.5, 9);
    expect(koro.frame(actor({ id: 'koro', allegiance: 'ally', chapterStatus: 'cleansed' }), 100 + MONSTER_SPAWN_SECONDS + 0.1)).toMatchObject({ actionId: 'monster-idle' });
  });

  it('never rises for an ally that was simply loaded', () => {
    expect(rig(KORO).frame(actor({ id: 'koro', allegiance: 'ally' }), 5)).toBeUndefined();
  });

  it('stands calm on the hostile body while cleansed, instead of the downed hurt pose', () => {
    const hostile = rig(KORO_BB);
    expect(hostile.frame(actor({ id: 'koro', chapterStatus: 'cleansed', downed: true }), 5)).toMatchObject({ actionId: 'monster-idle' });
    expect(hostile.frame(actor({ id: 'koro', chapterStatus: 'tethered' }), 6)).toBeUndefined();
  });
});

describe('other actors', () => {
  it('are untouched by the story resolver', () => {
    expect(rig('actor-ember-boar').frame(actor({ chapterStatus: 'cleansed' }), 1)).toBeUndefined();
  });
});
