import { describe, expect, it, spyOn } from 'bun:test';
import { AppAudio, SETTINGS_TICK_GAP_MS } from '../../src/audio/AppAudio.js';
import { SampleBank } from '../../src/audio/SampleBank.js';
import { packGroups, vocalPackId } from '../../src/audio/SampleCatalog.js';
import { DIALOGUE_DUCK, StoryAudio, STINGER_DUCK, type StoryAudioOptions } from '../../src/audio/StoryAudio.js';
import { DEFAULT_GAME_SETTINGS, type ActorSnapshot } from '../../src/game/contracts.js';
import { FakeContext, FakeMedia, cue, settle, withFakeAudio } from './support/fakes.js';

const CORE_FILES = new Set(packGroups('core').flatMap(group => group.files));

function create(context: FakeContext, over: Partial<StoryAudioOptions> = {}): StoryAudio {
  return new StoryAudio({
    acquireContext: () => context as unknown as AudioContext,
    samples: { fetchBytes: async () => new ArrayBuffer(16), decode: bytes => context.decodeAudioData(bytes) as unknown as Promise<AudioBuffer> },
    createMedia: () => new FakeMedia(),
    random: () => 0.3,
    ...over,
  });
}
async function ready(audio: StoryAudio): Promise<void> {
  expect(await audio.unlock()).toBe(true);
  await settle(12);
}

function actor(over: Partial<ActorSnapshot> & Pick<ActorSnapshot, 'id'>): ActorSnapshot {
  return {
    archetypeId: over.id, species: 'human', allegiance: 'hostile', position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 0, y: 0, z: 1 },
    actionId: 'idle' as never, phase: 'idle', normalizedTime: 0, sockets: {}, interactionRequirements: [], visible: true, downed: false, possessed: false, ...over,
  };
}
const player = (over: Partial<ActorSnapshot> = {}): ActorSnapshot => actor({ id: 'aren', allegiance: 'player', ...over });

describe('sample library loading', () => {
  it('decodes the core pack once on unlock and never again', async () => {
    await withFakeAudio(async context => {
      const audio = create(context);
      await ready(audio);
      const state = audio.mixerState.samples!;
      expect(state.loadedPacks).toContain('core');
      expect(context.decodeCount).toBe(CORE_FILES.size);
      expect(state.failedFiles).toEqual([]);
      await audio.unlock();
      await settle();
      expect(context.decodeCount).toBe(CORE_FILES.size);
      audio.dispose();
    });
  });

  it('decodes a shared file once even when requested twice at the same time', async () => {
    const context = new FakeContext();
    let fetches = 0;
    const bank = new SampleBank({ fetchBytes: async () => { fetches++; return new ArrayBuffer(4); }, decode: bytes => context.decodeAudioData(bytes) as unknown as Promise<AudioBuffer> });
    await Promise.all([bank.loadPack('core'), bank.loadPack('core')]);
    expect(fetches).toBe(CORE_FILES.size);
    expect(bank.stats.encodedBytes).toBe(CORE_FILES.size * 4);
    expect(bank.stats.decodedBytes).toBe(CORE_FILES.size * 4 * 10 * 4);
    expect(bank.pick('impact.flesh.light', 0)).toBeDefined();
    const first = bank.pick('impact.flesh.light', 0), last = bank.pick('impact.flesh.light', 0.99);
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    expect(first).not.toBe(last);
  });

  it('records failed files visibly and keeps every other sound working', async () => {
    await withFakeAudio(async context => {
      const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
      const audio = create(context, {
        samples: {
          fetchBytes: async path => { if (path === 'audio/impact/flesh-medium-1.ogg') throw new Error('HTTP 404'); return new ArrayBuffer(16); },
          decode: bytes => context.decodeAudioData(bytes) as unknown as Promise<AudioBuffer>,
        },
      });
      await ready(audio);
      expect(audio.mixerState.samples!.failedFiles).toEqual(['audio/impact/flesh-medium-1.ogg']);
      expect(warn).toHaveBeenCalled();
      expect(audio.play(cue({ kind: 'hit', confirmedDamage: 10, targetId: 'corrupted-boar', actorId: 'aren' }))).toBe(true);
      warn.mockRestore();
      audio.dispose();
    });
  });
});

describe('cue voicing', () => {
  it('plays a weight- and material-matched impact and replaces the old synthesised hit body', async () => {
    await withFakeAudio(async context => {
      const audio = create(context);
      await ready(audio);
      const sources = context.sources.length;
      expect(audio.play(cue({ kind: 'hit', confirmedDamage: 18, targetId: 'corrupted-boar', actorId: 'aren' }))).toBe(true);
      expect(context.sources.length).toBe(sources + 1);
      expect(audio.mixerState.samples!.last!.group).toBe('impact.flesh.heavy');
      expect(context.oscillators.length).toBe(0);
      audio.dispose();
    });
  });

  it('keeps the elemental synth accent on top of the impact sample', async () => {
    await withFakeAudio(async context => {
      const audio = create(context);
      await ready(audio);
      expect(audio.play(cue({ kind: 'hit', phase: 'hit', element: 'fire', confirmedDamage: 12, actorId: 'x', targetId: 'aren' }))).toBe(true);
      expect(audio.mixerState.samples!.last!.group).toBe('impact.flesh.medium');
      expect(context.oscillators.length).toBeGreaterThan(0);
      audio.dispose();
    });
  });

  it('falls back to the synth while the sample pack is still decoding', async () => {
    await withFakeAudio(async context => {
      const gate = Promise.withResolvers<void>();
      const audio = create(context, {
        samples: { fetchBytes: async () => { await gate.promise; return new ArrayBuffer(16); }, decode: bytes => context.decodeAudioData(bytes) as unknown as Promise<AudioBuffer> },
      });
      expect(await audio.unlock()).toBe(true);
      expect(audio.play(cue({ kind: 'hit', confirmedDamage: 12, actorId: 'x', targetId: 'aren' }))).toBe(true);
      expect(context.oscillators.length).toBeGreaterThan(0);
      expect(audio.mixerState.samples!.player!.missed).toBeGreaterThan(0);
      gate.resolve();
      await settle(12);
      expect(audio.play(cue({ kind: 'hit', confirmedDamage: 12, actorId: 'x', targetId: 'aren' }))).toBe(true);
      expect(audio.mixerState.samples!.last!.group).toBe('impact.flesh.medium');
      audio.dispose();
    });
  });

  it('voices the new reaction cues, loading the victim family vocal on first need', async () => {
    await withFakeAudio(async context => {
      const audio = create(context);
      await ready(audio);
      audio.play(cue({ kind: 'reaction-start', phase: 'active', reactionKind: 'knockback', intensity: 0.9, targetId: 'canopy-hornbill', actorId: 'canopy-hornbill' }));
      expect(audio.mixerState.samples!.last!.group).toBe('react.knockback');
      await settle(12);
      expect(audio.mixerState.samples!.loadedPacks).toContain(vocalPackId('avian'));
      context.currentTime += 1;
      audio.play(cue({ kind: 'reaction-start', phase: 'active', reactionKind: 'stagger', intensity: 0.9, targetId: 'canopy-hornbill', actorId: 'canopy-hornbill' }));
      expect(audio.mixerState.samples!.last!.group).toBe('vocal.avian.hurt');
      for (const [kind, group] of [['wall-impact', 'react.wall-impact'], ['poise-break', 'react.poise-break'], ['getup', 'react.getup']] as const) {
        audio.play(cue({ kind, reactionKind: kind === 'getup' ? 'getup' : undefined, targetId: 'canopy-hornbill' }));
        expect(audio.mixerState.samples!.last!.group).toBe(group);
      }
      audio.dispose();
    });
  });

  it('rate-limits repeated hurt vocals of one victim', async () => {
    await withFakeAudio(async context => {
      const audio = create(context);
      await ready(audio);
      audio.play(cue({ kind: 'reaction-start', phase: 'active', reactionKind: 'stagger', targetId: 'corrupted-boar' }));
      await settle(12);
      const base = audio.mixerState.samples!.player!.played;
      audio.play(cue({ kind: 'reaction-start', phase: 'active', reactionKind: 'stagger', targetId: 'corrupted-boar' }));
      audio.play(cue({ kind: 'reaction-start', phase: 'active', reactionKind: 'stagger', targetId: 'corrupted-boar' }));
      // two staggers -> two react.stagger one-shots but at most one hurt vocal inside the gap
      expect(audio.mixerState.samples!.player!.played - base).toBeLessThanOrEqual(3);
      audio.dispose();
    });
  });

  it('ignores duplicate cue instances and cancelled cues', async () => {
    await withFakeAudio(async context => {
      const audio = create(context);
      await ready(audio);
      const hit = cue({ kind: 'hit', confirmedDamage: 10, targetId: 'corrupted-boar', actorId: 'aren' });
      expect(audio.play(hit)).toBe(true);
      expect(audio.play(hit)).toBe(false);
      expect(audio.play(cue({ kind: 'cancel' }))).toBe(false);
      audio.dispose();
    });
  });

  it('culls sounds far from the listener and stops all sample voices on cancelAll', async () => {
    await withFakeAudio(async context => {
      const audio = create(context);
      await ready(audio);
      audio.setListenerPose({ position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 } });
      expect(audio.play(cue({ kind: 'hit', confirmedDamage: 10, targetId: 'corrupted-boar', position: { x: 90, y: 0, z: 0 } }))).toBe(false);
      expect(audio.mixerState.samples!.player!.culled).toBe(1);
      audio.play(cue({ kind: 'hit', confirmedDamage: 10, targetId: 'corrupted-boar', position: { x: 3, y: 0, z: 0 } }));
      expect(audio.mixerState.samples!.player!.active).toBe(1);
      audio.cancelAll('skip');
      expect(audio.mixerState.samples!.player!.active).toBe(0);
      audio.dispose();
    });
  });
});

describe('region score, ambience and story layers', () => {
  it('starts a region requested before unlock as soon as the context runs, loading its footsteps and vocals lazily', async () => {
    await withFakeAudio(async context => {
      const audio = create(context);
      expect(audio.startBiomeAmbience('moonpine-ridge')).toBe(false);
      await ready(audio);
      const state = audio.mixerState;
      expect(state.region).toBe('moonpine-ridge');
      expect(state.stems.explore!.path).toBe('audio/music/moonpine-explore.ogg');
      expect(state.stems.combat!.path).toBe('audio/music/combat-a.ogg');
      expect(state.ambience.map(bed => bed.url)).toEqual(['/audio/ambience/wind.ogg']);
      expect(state.samples!.loadedPacks).toEqual(expect.arrayContaining(['core', 'surface-snow', 'vocal-canine', 'vocal-humanoid']));
      expect(state.stems.boss!.state).toBe('unloaded');
      audio.dispose();
    });
  });

  it('streams exploration, prefetches combat and loops the region ambience; unload tears everything down', async () => {
    await withFakeAudio(async context => {
      const audio = create(context);
      await ready(audio);
      expect(audio.startBiomeAmbience('mistveil-basin')).toBe(true);
      audio.updateStreams(0.2);
      const state = audio.mixerState;
      expect(state.stems.explore!.state).toBe('playing');
      expect(state.stems.combat!.state).toBe('idle');
      expect(state.ambience.map(bed => bed.url)).toEqual(['/audio/ambience/swamp.ogg', '/audio/ambience/water.ogg']);
      expect(state.ambience.every(bed => bed.state === 'playing')).toBe(true);
      audio.cancelAll('unload');
      expect(audio.mixerState.ambience).toEqual([]);
      expect(audio.mixerState.region).toBeUndefined();
      audio.dispose();
    });
  });

  it('raises combat intensity from attacks and hits, crossfading to the combat cue, then back to exploration', async () => {
    await withFakeAudio(async context => {
      const audio = create(context);
      await ready(audio);
      audio.startBiomeAmbience('greenwake');
      for (let i = 0; i < 80; i++) audio.updateStreams(0.2);
      expect(audio.mixerState.stems.explore!.gain).toBeGreaterThan(0.9);
      audio.play(cue({ kind: 'hit', confirmedDamage: 12, targetId: 'aren', actorId: 'corrupted-boar' }));
      for (let i = 0; i < 20; i++) audio.updateStreams(0.2);
      let state = audio.mixerState;
      expect(state.combatLevel).toBeGreaterThan(0.5);
      expect(state.stems.combat!.state).toBe('playing');
      expect(state.stems.combat!.gain).toBeGreaterThan(0.6);
      expect(state.stems.explore!.gain).toBeLessThan(0.8);
      for (let i = 0; i < 200; i++) audio.updateStreams(0.2);
      state = audio.mixerState;
      expect(state.combatLevel).toBe(0);
      expect(state.stems.explore!.gain).toBeGreaterThan(0.9);
      expect(state.stems.combat!.gain).toBeLessThan(0.05);
      audio.dispose();
    });
  });

  it('crossfades the corrupted and restored layers from the region restoration state', async () => {
    await withFakeAudio(async context => {
      const audio = create(context);
      await ready(audio);
      audio.startBiomeAmbience('whispering-canopy');
      audio.setRegionRestorationState('corrupted');
      for (let i = 0; i < 80; i++) audio.updateStreams(0.2);
      let stems = audio.mixerState.stems;
      expect(stems.corrupted!.gain).toBeGreaterThan(0.4);
      expect(stems.restored!.state).toBe('unloaded');
      audio.setRegionRestorationState('restored');
      for (let i = 0; i < 120; i++) audio.updateStreams(0.2);
      stems = audio.mixerState.stems;
      expect(stems.restored!.gain).toBeGreaterThan(0.4);
      expect(stems.corrupted!.gain).toBeLessThan(0.05);
      audio.dispose();
    });
  });

  it('respects the settings volumes on every bus and ducks music, ambience and effects for dialogue', async () => {
    await withFakeAudio(async context => {
      const audio = create(context);
      await ready(audio);
      audio.setSettings({ ...DEFAULT_GAME_SETTINGS, masterVolume: 0.9, musicVolume: 0.5, effectsVolume: 0.6, ambienceVolume: 0.4, dialogueVolume: 0.8 });
      let gains = audio.mixerState.busGains;
      expect(gains).toMatchObject({ master: 0.9, music: 0.5, effects: 0.6, ambience: 0.4, dialogue: 0.8 });
      audio.setDialogueActive(true);
      gains = audio.mixerState.busGains;
      expect(gains.music).toBeCloseTo(0.5 * DIALOGUE_DUCK.music, 6);
      expect(gains.ambience).toBeCloseTo(0.4 * DIALOGUE_DUCK.ambience, 6);
      expect(gains.effects).toBeCloseTo(0.6 * DIALOGUE_DUCK.effects, 6);
      expect(gains.dialogue).toBe(0.8);
      audio.setDialogueActive(false);
      expect(audio.mixerState.busGains).toMatchObject({ music: 0.5, ambience: 0.4, effects: 0.6, dialogue: 0.8 });
      audio.dispose();
    });
  });

  it('streams the victory stinger over a ducked score and releases it when it ends', async () => {
    await withFakeAudio(async context => {
      const audio = create(context);
      await ready(audio);
      audio.setSettings({ ...DEFAULT_GAME_SETTINGS, musicVolume: 0.8, ambienceVolume: 0.7 });
      audio.startBiomeAmbience('greenwake');
      expect(audio.playStinger('victory')).toBe(true);
      const media = FakeMedia.instances[FakeMedia.instances.length - 1]!;
      expect(media.src).toBe('/audio/music/stinger-victory.ogg');
      expect(audio.mixerState.stingerActive).toBe(true);
      expect(audio.mixerState.busGains.music).toBeCloseTo(0.8 * STINGER_DUCK.music, 6);
      media.ended = true;
      audio.updateStreams(0.2);
      expect(audio.mixerState.stingerActive).toBe(false);
      expect(audio.mixerState.busGains.music).toBeCloseTo(0.8, 6);
      audio.dispose();
    });
  });

  it('stays inert without sample or streaming support (procedural-only environments)', async () => {
    await withFakeAudio(async context => {
      const audio = create(context, { samples: false, createMedia: false });
      expect(await audio.unlock()).toBe(true);
      expect(audio.mixerState.samples).toBeUndefined();
      expect(audio.mixerState.streamingAvailable).toBe(false);
      expect(audio.startBiomeAmbience('greenwake')).toBe(false);
      expect(audio.playUi('click')).toBe(false);
      audio.consumeActors([player()], 0.016);
      audio.dispose();
    });
  });
});

describe('snapshot-driven audio', () => {
  it('plays footsteps by the region surface from player movement, spaced by stride', async () => {
    await withFakeAudio(async context => {
      const audio = create(context);
      await ready(audio);
      audio.startBiomeAmbience('moonpine-ridge');
      await settle(12);
      const runner = player({ velocity: { x: 5, y: 0, z: 0 }, position: { x: 1, y: 0, z: 0 } });
      const groups = new Set<string>();
      let steps = 0;
      for (let i = 0; i < 100; i++) {
        const before = audio.mixerState.samples!.player!.played;
        audio.consumeActors([runner], 0.02);
        if (audio.mixerState.samples!.player!.played > before) { steps++; groups.add(audio.mixerState.samples!.last!.group); }
      }
      // 2 s at 5 m/s with a ~2 m stride
      expect(steps).toBeGreaterThanOrEqual(3);
      expect(steps).toBeLessThanOrEqual(7);
      expect([...groups]).toEqual(['foot.snow']);
      const before = audio.mixerState.samples!.player!.played;
      for (let i = 0; i < 100; i++) audio.consumeActors([player({ velocity: { x: 5, y: 0, z: 0 }, jumpPhase: 'rising' })], 0.02);
      expect(audio.mixerState.samples!.player!.played).toBe(before);
      audio.dispose();
    });
  });

  it('drives combat and boss music from hostiles that engage the player', async () => {
    await withFakeAudio(async context => {
      const audio = create(context);
      await ready(audio);
      audio.startBiomeAmbience('whispering-canopy');
      const near = { x: 6, y: 0, z: 0 };
      audio.consumeActors([player(), actor({ id: 'canopy-howler', archetypeId: 'canopy-howler', position: near, targetId: 'aren' })], 0.016);
      for (let i = 0; i < 10; i++) audio.updateStreams(0.2);
      expect(audio.mixerState.combatLevel).toBeGreaterThan(0.5);
      expect(audio.mixerState.mix.boss).toBe(false);
      audio.consumeActors([player(), actor({ id: 'koro', archetypeId: 'koro', species: 'macaque', position: { x: 12, y: 0, z: 0 }, attackPhase: 'windup' })], 0.016);
      audio.updateStreams(0.2);
      expect(audio.mixerState.mix.boss).toBe(true);
      for (let i = 0; i < 40; i++) audio.updateStreams(0.2);
      expect(audio.mixerState.stems.boss!.state).toBe('playing');
      expect(audio.mixerState.stems.boss!.gain).toBeGreaterThan(0.8);
      audio.consumeActors([player(), actor({ id: 'koro', archetypeId: 'koro', position: { x: 12, y: 0, z: 0 }, downed: true })], 0.016);
      audio.updateStreams(0.2);
      expect(audio.mixerState.mix.boss).toBe(false);
      audio.dispose();
    });
  });

  it('voices a monster death once, with its family vocal, and a boss roar with the giant set', async () => {
    await withFakeAudio(async context => {
      const audio = create(context);
      await ready(audio);
      audio.startBiomeAmbience('greenwake');
      await settle(12);
      const boar = actor({ id: 'boar-1', archetypeId: 'corrupted-boar', species: 'boar', position: { x: 4, y: 0, z: 0 } });
      audio.consumeActors([player(), boar], 0.016);
      const before = audio.mixerState.samples!.player!.played;
      audio.consumeActors([player(), { ...boar, downed: true, vitality: 0 }], 0.016);
      expect(audio.mixerState.samples!.last!.group).toBe('vocal.beast.death');
      expect(audio.mixerState.samples!.player!.played).toBe(before + 1);
      audio.consumeActors([player(), { ...boar, downed: true, vitality: 0 }], 0.016);
      expect(audio.mixerState.samples!.player!.played).toBe(before + 1);
      const orun = actor({ id: 'orun', archetypeId: 'orun', position: { x: 5, y: 0, z: 0 } });
      audio.consumeActors([player(), orun], 0.016);
      await settle(12);
      audio.consumeActors([player(), { ...orun, roarProgress: 0.1 }], 0.016);
      expect(audio.mixerState.samples!.last!.group).toBe('vocal.giant.roar');
      audio.dispose();
    });
  });

  it('loops the stun ring for exactly as long as a hostile is stunned', async () => {
    await withFakeAudio(async context => {
      const audio = create(context);
      await ready(audio);
      audio.startBiomeAmbience('greenwake');
      const wolf = actor({ id: 'wolf-1', archetypeId: 'moonpine-frostfang', position: { x: 4, y: 0, z: 0 } });
      const stunned = { ...wolf, reaction: { kind: 'stun' as const, direction: { x: 1, y: 0, z: 0 }, side: 'front' as const, strength: 1, progress: 0.2, durationTicks: 120, serial: 1 } };
      audio.consumeActors([player(), wolf], 0.016);
      const sources = context.sources.length;
      audio.consumeActors([player(), stunned], 0.016);
      audio.consumeActors([player(), { ...stunned }], 0.016);
      const loops = context.sources.slice(sources).filter(source => source.loop);
      expect(loops).toHaveLength(1);
      expect(loops[0]!.stoppedAt).toBeUndefined();
      audio.consumeActors([player(), wolf], 0.016);
      expect(loops[0]!.stoppedAt).toBeGreaterThan(context.currentTime);
      audio.dispose();
    });
  });
});

describe('app audio facade', () => {
  it('plays the title score on title screens after the first gesture and hands over to the region score on scene screens', async () => {
    await withFakeAudio(async context => {
      const app = new AppAudio({ acquireContext: () => context as unknown as AudioContext, createMedia: () => new FakeMedia(), samples: { fetchBytes: async () => new ArrayBuffer(8), decode: bytes => context.decodeAudioData(bytes) as unknown as Promise<AudioBuffer> } });
      app.syncScreen('title');
      expect(app.mixer.mixerState.stems.title).toBeUndefined();
      await app.unlock();
      await settle(12);
      app.mixer.updateStreams(0.2);
      expect(app.mixer.mixerState.stems.title!.state).toBe('playing');
      expect(app.mixer.mixerState.mix.menu).toBe(true);
      app.syncScreen('settings');
      expect(app.mixer.mixerState.mix.menu).toBe(true);
      app.syncScreen('loading');
      for (let i = 0; i < 30; i++) app.mixer.updateStreams(0.2);
      expect(app.mixer.mixerState.stems.title!.state).toBe('paused');
      app.syncScreen('hero-select');
      app.mixer.updateStreams(0.2);
      expect(app.mixer.mixerState.stems.title!.state).toBe('playing');
      app.dispose();
    });
  });

  it('plays UI sounds for actions, throttles slider ticks, ducks the region score for dialogue and forwards stingers', async () => {
    await withFakeAudio(async context => {
      const options = { acquireContext: () => context as unknown as AudioContext, createMedia: () => new FakeMedia(), samples: { fetchBytes: async () => new ArrayBuffer(8), decode: (bytes: ArrayBuffer) => context.decodeAudioData(bytes) as unknown as Promise<AudioBuffer> } };
      const app = new AppAudio(options);
      await app.unlock();
      await settle(12);
      app.action('new-game', 0);
      expect(app.mixer.mixerState.samples!.last!.group).toBe('ui.confirm');
      app.action('close-screen', 0);
      expect(app.mixer.mixerState.samples!.last!.group).toBe('ui.back');
      const played = app.mixer.mixerState.samples!.player!.played;
      app.action('interact', 0);
      expect(app.mixer.mixerState.samples!.player!.played).toBe(played);
      app.action('update-settings', 1000);
      app.action('update-settings', 1000 + SETTINGS_TICK_GAP_MS / 2);
      expect(app.mixer.mixerState.samples!.player!.played).toBe(played + 1);
      app.action('update-settings', 1000 + SETTINGS_TICK_GAP_MS + 1);
      expect(app.mixer.mixerState.samples!.player!.played).toBe(played + 2);

      const region = create(context);
      await ready(region);
      region.setSettings({ ...DEFAULT_GAME_SETTINGS, musicVolume: 1 });
      app.attachRegion(region);
      app.syncScreen('dialogue');
      expect(region.mixerState.busGains.music).toBeCloseTo(DIALOGUE_DUCK.music, 6);
      app.syncScreen('game');
      expect(region.mixerState.busGains.music).toBeCloseTo(1, 6);
      region.startBiomeAmbience('greenwake');
      expect(app.playStinger('defeat')).toBe(true);
      expect(FakeMedia.instances[FakeMedia.instances.length - 1]!.src).toBe('/audio/music/stinger-defeat.ogg');
      region.dispose();
      app.dispose();
    });
  });
});
