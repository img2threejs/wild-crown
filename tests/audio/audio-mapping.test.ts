import { describe, expect, it } from 'bun:test';
import { REGION_IDS } from '../../packages/campaign/src/index.js';
import { uiSoundForAction } from '../../src/audio/AppAudio.js';
import {
  CUE_SOUND_MODE, SAMPLE_REQUESTS, hurtVocalFor, impactMaterialOf, impactWeightOf, isBossActor, sampleReplacesSynth, samplesForCue, vocalFamilyOf, weaponOfCue,
} from '../../src/audio/CueSoundMap.js';
import {
  AMBIENCE_TRACKS, IMPACT_MATERIALS, IMPACT_WEIGHTS, MUSIC_TRACKS, REGION_AUDIO, REACTION_SOUNDS, SOUND_GROUPS, UI_SOUNDS, VOCAL_FAMILIES, VOCAL_KINDS, WEAPON_KINDS,
  FOOT_SURFACES, footGroupId, impactGroupId, reactionGroupId, regionPlanOf, uiGroupId, vocalGroupId, weaponGroupId,
} from '../../src/audio/SampleCatalog.js';
import { StoryAudio } from '../../src/audio/StoryAudio.js';
import type { StoryCue, StoryCueKind } from '../../src/effects/story-cues.js';
import { ACTORS } from '../../src/content/world.js';
import { ATTACKS } from '../../src/game/combat/content.js';
import type { UIAction } from '../../src/game/contracts.js';
import { cue, withFakeAudio } from './support/fakes.js';

/** Requests of the most recent `samplesForCue`, copied out of the shared scratch. */
function groupsOf(c: StoryCue): string[] {
  const count = samplesForCue(c);
  return SAMPLE_REQUESTS.slice(0, count).map(request => request.group);
}

describe('every presentation cue has a sound', () => {
  const kinds = Object.keys(CUE_SOUND_MODE) as StoryCueKind[];

  it('decides a mode for every cue kind, silent only for cancel', () => {
    expect(kinds.length).toBeGreaterThan(40);
    for (const kind of kinds) {
      if (kind === 'cancel') expect(CUE_SOUND_MODE[kind]).toBe('silent');
      else expect(['sample', 'layered', 'procedural'], kind).toContain(CUE_SOUND_MODE[kind]);
    }
  });

  const SAMPLE_CUES: Readonly<Partial<Record<StoryCueKind, StoryCue>>> = {
    landing: cue({ kind: 'landing', phase: 'landing', intensity: 1 }),
    'reaction-start': cue({ kind: 'reaction-start', phase: 'active', reactionKind: 'knockback', intensity: 0.8, targetId: 'corrupted-boar' }),
    'wall-impact': cue({ kind: 'wall-impact', intensity: 0.7 }),
    'poise-break': cue({ kind: 'poise-break', reactionKind: 'stun', targetId: 'corrupted-boar' }),
    getup: cue({ kind: 'getup', phase: 'resolve', reactionKind: 'getup' }),
    hit: cue({ kind: 'hit', confirmedDamage: 10, targetId: 'corrupted-boar', actorId: 'aren' }),
    'projectile-impact': cue({ kind: 'projectile-impact', contact: { kind: 'solid', normal: { x: 0, y: 1, z: 0 }, surfaceId: 'rock' } }),
    slash: cue({ kind: 'slash', phase: 'active', actorId: 'aren', element: 'arcane' }),
    pounce: cue({ kind: 'pounce', phase: 'active', actorId: 'corrupted-boar' }),
    'roar-cone': cue({ kind: 'roar-cone', phase: 'anticipation', actorId: 'canopy-howler' }),
    grovebreak: cue({ kind: 'grovebreak' }),
    active: cue({ kind: 'active', phase: 'active', attackId: 'koro-branch-swing' as never, actorId: 'koro' }),
    'storm-talon': cue({ kind: 'storm-talon', phase: 'hit', actorId: 'vara', targetId: 'corrupted-boar', intensity: 1 }),
  };

  it('gives every sample-moded and layered kind at least one sampled sound from a catalogue group that exists', () => {
    for (const kind of kinds) {
      const mode = CUE_SOUND_MODE[kind];
      if (mode !== 'sample' && mode !== 'layered') continue;
      const sample = SAMPLE_CUES[kind];
      expect(sample, `${kind} needs a representative cue in this test`).toBeDefined();
      const groups = groupsOf(sample!);
      expect(groups.length, kind).toBeGreaterThan(0);
      for (const group of groups) expect(SOUND_GROUPS[group]?.files.length, `${kind} -> ${group}`).toBeGreaterThan(0);
    }
  });

  it('voices every procedural kind through the synthesiser (no sample fits: telegraphs, spell timbres, story chords)', async () => {
    await withFakeAudio(async context => {
      const audio = new StoryAudio({ acquireContext: () => context as unknown as AudioContext, samples: false, createMedia: false });
      expect(await audio.unlock()).toBe(true);
      const silent: string[] = [];
      for (const kind of kinds) {
        if (CUE_SOUND_MODE[kind] !== 'procedural') continue;
        const voiced = audio.play(cue({ kind, phase: 'active', element: kind === 'sigil' ? 'arcane' : undefined, actorId: 'aren', actionId: 'aren-skill' as never, intensity: 1 }));
        if (!voiced) silent.push(kind);
      }
      // Warden-style recipes deliberately stay silent for phases they do not voice; everything else must sound.
      expect(silent.filter(kind => !['sigil', 'projectile', 'lightning', 'judgement', 'judgement-mark', 'beam', 'bloom', 'root-eruption', 'blink'].includes(kind))).toEqual([]);
      audio.dispose();
    });
  });
});

describe('impact, weapon and reaction mapping', () => {
  it('picks weight from confirmed damage and material from the victim or the struck surface', () => {
    const base = { kind: 'hit' as const, actorId: 'aren', targetId: 'corrupted-boar' };
    expect(impactWeightOf(cue({ ...base, confirmedDamage: 4 }))).toBe('light');
    expect(impactWeightOf(cue({ ...base, confirmedDamage: 9 }))).toBe('medium');
    expect(impactWeightOf(cue({ ...base, confirmedDamage: 16 }))).toBe('heavy');
    expect(impactWeightOf(cue({ ...base, confirmedDamage: 26 }))).toBe('finisher');
    expect(impactWeightOf(cue({ ...base, confirmedDamage: 5, intensity: 2.5 }))).toBe('finisher');
    expect(impactMaterialOf(cue(base))).toBe('flesh');
    expect(impactMaterialOf(cue({ ...base, targetId: 'grove-sprig' }))).toBe('bark');
    expect(impactMaterialOf(cue({ kind: 'projectile-impact', contact: { kind: 'solid', normal: { x: 0, y: 1, z: 0 }, surfaceId: 'bridge-plank' } }))).toBe('wood');
    expect(impactMaterialOf(cue({ kind: 'projectile-impact', contact: { kind: 'solid', normal: { x: 0, y: 1, z: 0 }, surfaceId: 'tree-trunk' } }))).toBe('bark');
    expect(impactMaterialOf(cue({ kind: 'projectile-impact', contact: { kind: 'solid', normal: { x: 0, y: 1, z: 0 }, surfaceId: 'cliff-rock' } }))).toBe('stone');
  });

  it('has a sound group for every material x weight, with a finisher sub-layer', () => {
    for (const material of IMPACT_MATERIALS) for (const weight of IMPACT_WEIGHTS) expect(SOUND_GROUPS[impactGroupId(material, weight)]?.files.length, `${material}/${weight}`).toBeGreaterThan(0);
    expect(groupsOf(cue({ kind: 'hit', confirmedDamage: 40, targetId: 'corrupted-boar' }))).toEqual(['impact.flesh.finisher', 'impact.finisher-layer']);
    expect(groupsOf(cue({ kind: 'hit', confirmedDamage: 0, targetId: 'corrupted-boar' }))).toEqual([]);
    expect(groupsOf(cue({ kind: 'hit', phase: 'anticipation', confirmedDamage: 9 }))).toEqual([]);
  });

  it('swings the hero weapon: glaive, staff, katana, fists; monsters use the swipe', () => {
    expect(weaponOfCue(cue({ kind: 'slash', actorId: 'aren', element: 'arcane' }))).toBe('glaive');
    expect(weaponOfCue(cue({ kind: 'slash', actorId: 'aren', element: 'heartroot', actionId: 'yara-staff-1' as never }))).toBe('staff');
    expect(weaponOfCue(cue({ kind: 'slash', actorId: 'aren', element: 'umbral', actionId: 'vesper-iai-1' as never }))).toBe('katana');
    expect(weaponOfCue(cue({ kind: 'slash', actorId: 'aren', element: 'ember', actionId: 'sakda-limb-1' as never }))).toBe('fist');
    for (const weapon of WEAPON_KINDS) expect(SOUND_GROUPS[weaponGroupId(weapon)]?.files.length, weapon).toBeGreaterThan(0);
    expect(groupsOf(cue({ kind: 'slash', phase: 'active', actorId: 'aren', element: 'ember', actionId: 'sakda-limb-1' as never }))).toEqual(['weapon.fist']);
    expect(groupsOf(cue({ kind: 'slash', phase: 'anticipation', actorId: 'aren' }))).toEqual([]);
    const strike = Object.values(ATTACKS).find(attack => attack.hazard.kind === 'sweep' && attack.element === undefined)!;
    expect(groupsOf(cue({ kind: 'active', phase: 'active', attackId: strike.id as never, actorId: strike.bossId }))).toEqual(['weapon.monster']);
  });

  it('voices the new reaction cues: knockback, knockdown, launch, stagger, wall impact, poise break and get-up', () => {
    const reaction = (reactionKind: NonNullable<StoryCue['reactionKind']>, extra: Partial<StoryCue> = {}): string[] => groupsOf(cue({ kind: 'reaction-start', phase: 'active', reactionKind, intensity: 0.8, targetId: 'corrupted-boar', ...extra }));
    expect(reaction('knockback')).toEqual(['react.knockback']);
    expect(reaction('knockdown')).toEqual(['react.knockdown']);
    expect(reaction('launch')).toEqual(['react.knockback', 'react.knockdown']);
    expect(reaction('stagger')).toEqual(['react.stagger']);
    expect(reaction('flinch')).toEqual([]);
    expect(reaction('stun')).toEqual([]); // the stun ring is a snapshot-driven loop plus the poise-break one-shot
    expect(groupsOf(cue({ kind: 'wall-impact' }))).toEqual(['react.wall-impact']);
    expect(groupsOf(cue({ kind: 'poise-break' }))).toEqual(['react.poise-break']);
    expect(groupsOf(cue({ kind: 'getup', reactionKind: 'getup' }))).toEqual(['react.getup']);
    for (const sound of REACTION_SOUNDS) expect(SOUND_GROUPS[reactionGroupId(sound)]?.files.length, sound).toBeGreaterThan(0);
  });

  it('grunts on reactions: hostiles from stagger up, the player only when knocked down', () => {
    const hurt = (reactionKind: NonNullable<StoryCue['reactionKind']>, targetId: string) => hurtVocalFor(cue({ kind: 'reaction-start', reactionKind, targetId }));
    expect(hurt('flinch', 'corrupted-boar')).toBeUndefined();
    expect(hurt('stagger', 'corrupted-boar')).toBe('beast');
    expect(hurt('knockback', 'canopy-hornbill')).toBe('avian');
    expect(hurt('stagger', 'aren')).toBeUndefined();
    expect(hurt('knockdown', 'aren')).toBe('humanoid');
    expect(hurtVocalFor(cue({ kind: 'hit' }))).toBeUndefined();
  });

  it('replaces the synthesised body of physical hits and swings only', () => {
    expect(sampleReplacesSynth(cue({ kind: 'hit' }))).toBe(true);
    expect(sampleReplacesSynth(cue({ kind: 'hit', element: 'arcane' }))).toBe(true);
    expect(sampleReplacesSynth(cue({ kind: 'slash', element: 'umbral' }))).toBe(true);
    expect(sampleReplacesSynth(cue({ kind: 'hit', element: 'fire' }))).toBe(false);
    expect(sampleReplacesSynth(cue({ kind: 'hit', element: 'lightning' }))).toBe(false);
    expect(sampleReplacesSynth(cue({ kind: 'beam' }))).toBe(false);
  });
});

describe('monster vocal families and regions', () => {
  it('maps every authored actor to a family whose roar, hurt and death sets exist', () => {
    for (const actor of Object.values(ACTORS)) {
      const family = vocalFamilyOf(actor.id, actor.species);
      for (const kind of VOCAL_KINDS) expect(SOUND_GROUPS[vocalGroupId(family, kind)]?.files.length, `${actor.id} ${family}/${kind}`).toBeGreaterThan(0);
    }
    expect(vocalFamilyOf('canopy-howler')).toBe('primate');
    expect(vocalFamilyOf('canopy-hornbill')).toBe('avian');
    expect(vocalFamilyOf('canopy-mire-viper')).toBe('reptile');
    expect(vocalFamilyOf('corrupted-boar')).toBe('beast');
    expect(vocalFamilyOf('poacher-hunter')).toBe('humanoid');
    expect(vocalFamilyOf('grove-sprig')).toBe('rootling');
    expect(vocalFamilyOf('moonpine-frostfang')).toBe('canine');
    expect(vocalFamilyOf('mistveil-lurker')).toBe('reptile');
    for (const family of VOCAL_FAMILIES) for (const kind of VOCAL_KINDS) expect(SOUND_GROUPS[vocalGroupId(family, kind)], `${family}/${kind}`).toBeDefined();
  });

  it('roars bosses with the giant set', () => {
    for (const bossId of ['koro', 'asha', 'ruun', 'ghor', 'solkar', 'orun']) expect(isBossActor(bossId), bossId).toBe(true);
    expect(isBossActor('corrupted-boar')).toBe(false);
    expect(groupsOf(cue({ kind: 'roar-cone', phase: 'anticipation', actorId: 'ruun' }))).toEqual(['vocal.giant.roar']);
    expect(groupsOf(cue({ kind: 'roar-cone', phase: 'anticipation', actorId: 'canopy-howler' }))).toEqual(['vocal.primate.roar']);
    expect(groupsOf(cue({ kind: 'roar-cone', phase: 'active', actorId: 'canopy-howler' }))).toEqual([]);
  });

  it('plans music, ambience and footsteps for every region the campaign can enter', () => {
    const regions = [...REGION_IDS, 'greenwake', 'the-grove', 'refuge', 'heartroot-hollow'];
    for (const id of regions) {
      const plan = REGION_AUDIO[id];
      expect(plan, id).toBeDefined();
      expect(MUSIC_TRACKS[plan!.explore], id).toBeDefined();
      expect(MUSIC_TRACKS[plan!.combat], id).toBeDefined();
      for (const bed of plan!.ambience) expect(AMBIENCE_TRACKS[bed], id).toBeDefined();
      expect(SOUND_GROUPS[footGroupId(plan!.surface)], id).toBeDefined();
      for (const family of plan!.families) expect(VOCAL_FAMILIES, id).toContain(family);
    }
    for (const surface of FOOT_SURFACES) expect(SOUND_GROUPS[footGroupId(surface)]?.files.length, surface).toBeGreaterThan(0);
    expect(regionPlanOf('the-hollow-vale').explore).toBe(REGION_AUDIO['heartroot-hollow']!.explore);
    expect(regionPlanOf('totally-unknown')).toBe(REGION_AUDIO.greenwake!);
  });

  it('keeps the four regions with dedicated pieces distinct, and exploration distinct from combat', () => {
    const explore = ['greenwake', 'whispering-canopy', 'the-grove', 'moonpine-ridge', 'mistveil-basin', 'refuge', 'heartroot-hollow'].map(id => REGION_AUDIO[id]!.explore);
    expect(new Set(explore).size).toBe(explore.length);
    for (const plan of Object.values(REGION_AUDIO)) expect(plan.explore).not.toBe(plan.combat);
  });
});

describe('UI sounds', () => {
  it('maps every UI action to a sound or to silence (in-world actions voiced elsewhere)', () => {
    const types: UIAction['type'][] = ['new-game', 'select-map', 'select-hero', 'map-select', 'continue', 'pause', 'resume', 'retry-load', 'advance-dialogue', 'return-title', 'view-credits', 'interact', 'open-map', 'open-journal', 'open-companions', 'open-settings', 'close-screen', 'create-save-slot', 'save', 'load', 'import', 'export', 'accept-quest', 'track-objective', 'select-companion', 'issue-command', 'use-ability', 'choose', 'travel', 'update-settings', 'remap', 'skip-cinematic', 'leave-map-intro', 'skip-establishing-shot'];
    for (const type of types) {
      const sound = uiSoundForAction(type);
      if (sound) expect(SOUND_GROUPS[uiGroupId(sound)]?.files.length, type).toBeGreaterThan(0);
    }
    expect(uiSoundForAction('interact')).toBeUndefined();
    expect(uiSoundForAction('use-ability')).toBeUndefined();
    expect(uiSoundForAction('new-game')).toBe('confirm');
    expect(uiSoundForAction('close-screen')).toBe('back');
    expect(uiSoundForAction('open-journal')).toBe('open');
    expect(uiSoundForAction('advance-dialogue')).toBe('click');
    for (const sound of UI_SOUNDS) expect(SOUND_GROUPS[uiGroupId(sound)]?.files.length, sound).toBeGreaterThan(0);
  });
});
