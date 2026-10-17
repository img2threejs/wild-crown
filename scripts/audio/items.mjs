// Output file table: output path (without extension, under public/audio) <- source pack member + edits.
// Edit options: start/end (seconds, trim), pitch (semitones, resample-based so duration scales), lp/hp (Hz), fadeIn/fadeOut (s),
// lufs (target integrated loudness), mono (default true for sfx, false for music/ambience), kbps (Opus bitrate).
// The runtime catalogue (src/audio/SampleCatalog.ts) names the same output paths; tests/audio/audio-library.test.ts enforces both agree.

const items = [];
// Foley-like, very peaky groups get the hard compressor so they reach their loudness target (see build-audio.mjs).
const HARD = /^(ui|foot|weapon)\/|^react\/(getup|stagger)|^impact\/stone-|^impact\/(wood|bark)-(light|medium)/;
const add = (out, pack, member, opts = {}) => { items.push({ out, pack, member, kind: opts.kind ?? 'sfx', ...(HARD.test(out) ? { compress: 'hard' } : {}), ...opts }); };
const K = { impact: 'kenney-impact-sounds', rpg: 'kenney-rpg-audio', ui: 'kenney-interface-sounds' };
const pad = (n, w = 3) => String(n).padStart(w, '0');
/** add N outputs `<out>-1..N` from `member(i)` for each i in `indices`. */
const series = (out, pack, indices, member, opts = {}) => indices.forEach((src, i) => add(`${out}-${i + 1}`, pack, member(src), opts));

// ---- UI ----
series('ui/click', K.ui, [1, 2, 3], i => `Audio/click_${pad(i)}.ogg`, { lufs: -18 });
series('ui/hover', K.ui, [1, 2], i => `Audio/tick_${pad(i)}.ogg`, { lufs: -18 });
series('ui/confirm', K.ui, [1, 2], i => `Audio/confirmation_${pad(i)}.ogg`, { lufs: -18 });
add('ui/back-1', K.ui, 'Audio/back_001.ogg', { lufs: -18 });
add('ui/error-1', K.ui, 'Audio/error_001.ogg', { lufs: -18 });
add('ui/open-1', K.ui, 'Audio/open_001.ogg', { lufs: -18 });
add('ui/close-1', K.ui, 'Audio/close_001.ogg', { lufs: -18 });
add('ui/toggle-1', K.ui, 'Audio/toggle_001.ogg', { lufs: -18 });
add('ui/scroll-1', K.ui, 'Audio/scroll_001.ogg', { lufs: -18 });
add('ui/transition-1', K.ui, 'Audio/maximize_003.ogg', { lufs: -17 });
add('ui/transition-2', K.ui, 'Audio/minimize_003.ogg', { lufs: -17 });

// ---- Impacts: material x weight ----
const imp = (name, i) => `Audio/impact${name}_${pad(i)}.ogg`;
const LUFS = { light: -18, medium: -17, heavy: -16, finisher: -14 };
// flesh
series('impact/flesh-light', K.impact, [0, 1], i => imp('Punch_medium', i), { lufs: LUFS.light });
series('impact/flesh-medium', K.impact, [0, 1, 2], i => imp('Soft_medium', i), { lufs: LUFS.medium });
series('impact/flesh-heavy', K.impact, [0, 1], i => imp('Punch_heavy', i), { lufs: LUFS.heavy });
series('impact/flesh-finisher', K.impact, [0, 1], i => imp('Soft_heavy', i), { lufs: LUFS.finisher });
// wood
series('impact/wood-light', K.impact, [0, 1], i => imp('Wood_light', i), { lufs: LUFS.light });
series('impact/wood-medium', K.impact, [0, 1], i => imp('Wood_medium', i), { lufs: LUFS.medium });
series('impact/wood-heavy', K.impact, [0, 1], i => imp('Wood_heavy', i), { lufs: LUFS.heavy });
series('impact/wood-finisher', K.impact, [2, 3], i => imp('Wood_heavy', i), { lufs: LUFS.finisher });
// bark: living trunk, the wood hits dropped in pitch so they read as denser, softer timber
series('impact/bark-light', K.impact, [2, 3], i => imp('Wood_light', i), { lufs: LUFS.light, pitch: -4 });
series('impact/bark-medium', K.impact, [2, 3], i => imp('Wood_medium', i), { lufs: LUFS.medium, pitch: -4 });
series('impact/bark-heavy', K.impact, [3, 4], i => imp('Wood_heavy', i), { lufs: LUFS.heavy, pitch: -5 });
series('impact/bark-finisher', K.impact, [0, 1], i => imp('Plank_medium', i), { lufs: LUFS.finisher, pitch: -7, lp: 5200 });
// stone
series('impact/stone-light', K.impact, [0, 1], i => `Audio/impactMining_${pad(i)}.ogg`, { lufs: LUFS.light });
series('impact/stone-medium', K.impact, [2, 3], i => `Audio/impactMining_${pad(i)}.ogg`, { lufs: LUFS.medium });
series('impact/stone-heavy', 'oga-rpg-sfx-80', [1, 2], i => `stones_${pad(i, 2)}.ogg`, { lufs: LUFS.heavy });
series('impact/stone-finisher', 'oga-rpg-sfx-80', [3, 4], i => `stones_${pad(i, 2)}.ogg`, { lufs: LUFS.finisher });
// finisher sub-layer (played with every finisher, any material): low plate boom
series('impact/finisher-layer', K.impact, [0, 1], i => imp('Plate_heavy', i), { lufs: -16, pitch: -8, lp: 1800 });

// ---- Physical reactions ----
series('react/knockback', 'oga-swishes', [9, 7], i => `swishes/swish-${i}.wav`, { lufs: -17, pitch: -5 });
series('react/knockdown', K.impact, [2, 3], i => imp('Soft_heavy', i), { lufs: -15, pitch: -3 });
add('react/getup-1', K.rpg, 'Audio/clothBelt.ogg', { lufs: -18 });
add('react/getup-2', K.rpg, 'Audio/handleSmallLeather.ogg', { lufs: -18 });
add('react/stagger-1', K.rpg, 'Audio/cloth1.ogg', { lufs: -18 });
add('react/stagger-2', K.impact, imp('Punch_medium', 3), { lufs: -18, pitch: -2 });
add('react/poise-break-1', K.impact, imp('Glass_heavy', 0), { lufs: -14 });
add('react/poise-break-2', K.impact, imp('Metal_heavy', 1), { lufs: -14, pitch: -3 });
add('react/wall-impact-1', K.impact, 'Audio/impactMining_004.ogg', { lufs: -14, pitch: -6, lp: 6000 });
add('react/wall-impact-2', 'oga-rpg-sfx-80', 'item_stone_01.ogg', { lufs: -14, pitch: -4 });
// Dazed ring: a struck bell pitched down and softened; the catalogue loops it while the victim is stunned.
add('react/stun-loop-1', K.impact, imp('Bell_heavy', 1), { lufs: -18, pitch: -3, lp: 2600, end: 1.5, fadeOut: 0.3, loopXfade: 0.4 });

// ---- Weapon whooshes (active phase of player melee, and monster swipes) ----
add('weapon/glaive-1', 'oga-swishes', 'swishes/swish-9.wav', { lufs: -18, pitch: -4 });
add('weapon/glaive-2', 'oga-swishes', 'swishes/swish-7.wav', { lufs: -18, pitch: -4 });
add('weapon/glaive-3', 'oga-swishes', 'swishes/swish-8.wav', { lufs: -18, pitch: -3 });
add('weapon/katana-1', 'oga-melee-sounds', 'melee sounds/sword sound.wav', { lufs: -17 });
add('weapon/katana-2', K.rpg, 'Audio/knifeSlice.ogg', { lufs: -18 });
add('weapon/katana-3', K.rpg, 'Audio/knifeSlice2.ogg', { lufs: -18 });
add('weapon/staff-1', 'oga-swishes', 'swishes/swish-3.wav', { lufs: -18, pitch: -2 });
add('weapon/staff-2', 'oga-swishes', 'swishes/swish-6.wav', { lufs: -18, pitch: -2 });
add('weapon/staff-3', 'oga-melee-sounds', 'melee sounds/melee sound.wav', { lufs: -18 });
add('weapon/fist-1', 'oga-swishes', 'swishes/swish-1.wav', { lufs: -18 });
add('weapon/fist-2', 'oga-swishes', 'swishes/swish-10.wav', { lufs: -18 });
add('weapon/fist-3', 'oga-swishes', 'swishes/swish-11.wav', { lufs: -18 });
add('weapon/monster-1', 'oga-melee-sounds', 'melee sounds/animal melee sound.wav', { lufs: -17 });
add('weapon/monster-2', 'oga-swishes', 'swishes/swish-4.wav', { lufs: -17, pitch: -6 });

// ---- Footsteps by surface ----
const foot = (surface, pack, indices, member, opts = {}) => series(`foot/${surface}`, pack, indices, member, { lufs: -18, ...opts });
foot('grass', K.impact, [0, 1, 2, 3], i => `Audio/footstep_grass_${pad(i)}.ogg`);
foot('wood', K.impact, [0, 1, 2], i => `Audio/footstep_wood_${pad(i)}.ogg`);
foot('stone', K.impact, [0, 1, 2, 3], i => `Audio/footstep_concrete_${pad(i)}.ogg`);
foot('dirt', K.rpg, [0, 1, 2, 3], i => `Audio/footstep${pad(i, 2)}.ogg`);
foot('snow', K.impact, [0, 1, 2], i => `Audio/footstep_snow_${pad(i)}.ogg`);
foot('mud', 'oga-mud-sfx', [1, 2, 3], i => `mud_${pad(i, 2)}.ogg`);
foot('water', 'oga-water-slime-sfx', [1, 2, 3], i => `splash_${pad(i, 2)}.ogg`, { end: 0.45, fadeOut: 0.12, pitch: 3 });
series('foot/land', K.impact, [3, 4], i => imp('Soft_heavy', i), { lufs: -18, lp: 3800 });

// ---- Monster vocals (roar / hurt / death) by family ----
const voc = (family, kind, pack, members, opts = {}) => series(`vocal/${family}-${kind}`, pack, members, m => m, { lufs: { roar: -14, hurt: -16, death: -15 }[kind], ...opts });
const C1 = 'oga-creature-sfx-1', C2 = 'oga-creature-sfx-2';
voc('beast', 'roar', C1, ['roar_01.ogg', 'roar_02.ogg']);
voc('beast', 'hurt', C1, ['hurt_01.ogg', 'hurt_02.ogg']);
voc('beast', 'death', C2, ['die_01.ogg', 'die_02.ogg']);
voc('canine', 'roar', C1, ['howl.ogg', 'barking_01.ogg']);
voc('canine', 'hurt', C1, ['barking_02.ogg', 'hurt_04.ogg'], { pitch: 2 });
voc('canine', 'death', C2, ['die_03.ogg'], { pitch: 3 });
voc('primate', 'roar', C1, ['scream_01.ogg', 'scream_02.ogg']);
voc('primate', 'hurt', C1, ['hurt_05.ogg', 'hurt_03.ogg'], { pitch: 4 });
voc('primate', 'death', C2, ['die_04.ogg'], { pitch: 4 });
voc('avian', 'roar', 'oga-bat-screeches', ['ogg/bat_01.ogg', 'ogg/bat_02.ogg']);
voc('avian', 'hurt', 'oga-bat-screeches', ['ogg/bat_03.ogg'], { pitch: 2 });
voc('avian', 'death', 'oga-bat-screeches', ['ogg/bat_01.ogg'], { pitch: -5, fadeOut: 0.15 });
voc('reptile', 'roar', C2, ['attack_01.ogg', 'attack_02.ogg']);
voc('reptile', 'hurt', C1, ['spit_01.ogg', 'spit_02.ogg']);
voc('reptile', 'death', C2, ['slime_01.ogg', 'slime_02.ogg']);
voc('rootling', 'roar', C1, ['troll_01.ogg', 'troll_02.ogg'], { pitch: -3, lp: 4200 });
voc('rootling', 'hurt', K.rpg, ['Audio/creak1.ogg', 'Audio/creak2.ogg'], { lufs: -17 });
voc('rootling', 'death', K.rpg, ['Audio/creak3.ogg', 'Audio/creak2.ogg'], { pitch: -4, lufs: -16 });
voc('humanoid', 'roar', C2, ['human_01.ogg', 'human_02.ogg']);
voc('humanoid', 'hurt', C2, ['human_03.ogg', 'human_04.ogg']);
voc('humanoid', 'death', C2, ['human_05.ogg', 'human_06.ogg']);
voc('giant', 'roar', C2, ['roar_04.ogg', 'roar_05.ogg', 'roar_06.ogg'], { pitch: -2 });
add('vocal/giant-roar-4', 'oga-deep-monster-roar', 'monster_roar.wav', { lufs: -13, end: 3.2, fadeOut: 0.6 });
voc('giant', 'hurt', C1, ['grunt_01.ogg', 'grunt_03.ogg'], { pitch: -4 });
voc('giant', 'death', C2, ['die_02.ogg', 'die_04.ogg'], { pitch: -6 });

// ---- Music, streamed (not decoded to PCM): per region exploration + combat, shared boss, title, stingers, restoration layers ----
const music = (out, pack, member, opts = {}) => add(out, pack, member, { kind: 'music', kbps: 64, lufs: -16, mono: false, ...opts });
music('music/greenwake-explore', 'oga-lost-in-the-meadows', 'lost in the meadows_0.flac');
music('music/canopy-explore', 'oga-forest-whisper', 'Forest Whisper Theme/Forest Whisper.ogg', { end: 110, fadeOut: 2 });
music('music/grove-explore', 'oga-beautiful-forest', 'beautiful_forest_16bit_44.1khz_1.ogg');
music('music/moonpine-explore', 'oga-rising-moon', 'Rising_Moon.mp3', { end: 120, fadeOut: 3 });
music('music/mistveil-explore', 'oga-echoes-of-the-past', 'echoes_of_the_past.wav');
music('music/refuge-explore', 'oga-at-home', 'cinematic-calm.mp3');
music('music/hollow-explore', 'oga-exploration-theme', 'exploration_theme.ogg', { end: 110, fadeOut: 3 });
music('music/combat-a', 'oga-battle-theme-a', 'battleThemeA.mp3');
music('music/combat-b', 'oga-battle-theme-b', 'battleThemeB.mp3');
music('music/combat-c', 'oga-determined-pursuit', 'determined_pursuit_loop.wav');
music('music/boss', 'oga-boss-battle-theme', 'CleytonRX - Battle RPG Theme Var.ogg');
music('music/title', 'oga-adventure-intro', 'Adventure Theme Intro.wav');
music('music/layer-restored', 'oga-piano-loop', 'Piano Loop.wav');
music('music/layer-corrupted', 'oga-dungeon-ambience', 'dungeon002.ogg', { end: 75, fadeOut: 2 });
add('music/stinger-victory', 'oga-fanfare', 'fanfare.ogg', { kind: 'stinger', lufs: -16, mono: false, kbps: 64, end: 9, fadeOut: 1.5 });
add('music/stinger-defeat', 'oga-defeat-theme', 'defeat.mp3', { kind: 'stinger', lufs: -16, mono: false, kbps: 64, end: 14, fadeOut: 3 });

// ---- Ambience beds, streamed ----
const amb = (out, pack, member, opts = {}) => add(out, pack, member, { kind: 'ambience', kbps: 48, lufs: -20, mono: false, ...opts });
amb('ambience/forest', 'oga-forest-ambience', 'Forest_Ambience.mp3');
amb('ambience/wind', 'oga-icy-heights-wind', 'wind.ogg');
amb('ambience/swamp', 'oga-swamp-theme-loop', 'swamp_in_game.ogg');
amb('ambience/water', 'oga-water-slime-sfx', 'loop_water_01.ogg', { lufs: -22 });

export const ITEMS = items;
