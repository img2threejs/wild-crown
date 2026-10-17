/**
 * Static catalogue of the licensed sample library under public/audio (provenance: public/audio/provenance.json, rebuilt by
 * scripts/audio/build-audio.mjs). Groups name variant files; packs decide what is fetched when:
 *  - `core`: UI, impacts, reactions, weapon whooshes and the always-needed footsteps (~0.2 MB), loaded on the first unlock;
 *  - `vocal-<family>`: monster roar/hurt/death sets, loaded when a region needing the family loads or its first actor appears;
 *  - `surface-<surface>`: the region's footstep surface when it is not in core (snow, mud, water);
 *  - music and ambience are streamed per region (never decoded to PCM), so they are not packs.
 */
import type { AudioBusName } from './StoryAudio.js';

export type SampleBus = Exclude<AudioBusName, 'master'>;
export type ImpactMaterial = 'flesh' | 'wood' | 'bark' | 'stone';
export type ImpactWeight = 'light' | 'medium' | 'heavy' | 'finisher';
export type WeaponKind = 'glaive' | 'katana' | 'staff' | 'fist' | 'monster';
export type FootSurface = 'grass' | 'dirt' | 'stone' | 'wood' | 'snow' | 'mud' | 'water';
export type VocalFamily = 'beast' | 'canine' | 'primate' | 'avian' | 'reptile' | 'rootling' | 'humanoid' | 'giant';
export type VocalKind = 'roar' | 'hurt' | 'death';
export type UiSound = 'click' | 'hover' | 'confirm' | 'back' | 'error' | 'open' | 'close' | 'toggle' | 'scroll' | 'transition';
export type ReactionSound = 'knockback' | 'knockdown' | 'getup' | 'stagger' | 'poise-break' | 'wall-impact' | 'stun-loop';

export interface SoundGroup {
  readonly id: string;
  /** Paths relative to the site root (`audio/...ogg`). */
  readonly files: readonly string[];
  readonly bus: SampleBus;
  /** Linear trim on top of the loudness-normalised files. */
  readonly gain: number;
  /** Concurrent voices of this group before the limiter steals the oldest. */
  readonly maxVoices: number;
  /** Limiter priority; a higher value may steal a lower one, never the reverse. */
  readonly priority: number;
  /** Random playback-rate spread (plus/minus), so repeated variants never sound identical. */
  readonly rateJitter: number;
  readonly pack: string;
}

const variants = (stem: string, count: number): readonly string[] => Array.from({ length: count }, (_, i) => `audio/${stem}-${i + 1}.ogg`);

export const IMPACT_MATERIALS: readonly ImpactMaterial[] = ['flesh', 'wood', 'bark', 'stone'];
export const IMPACT_WEIGHTS: readonly ImpactWeight[] = ['light', 'medium', 'heavy', 'finisher'];
export const WEAPON_KINDS: readonly WeaponKind[] = ['glaive', 'katana', 'staff', 'fist', 'monster'];
export const FOOT_SURFACES: readonly FootSurface[] = ['grass', 'dirt', 'stone', 'wood', 'snow', 'mud', 'water'];
export const VOCAL_FAMILIES: readonly VocalFamily[] = ['beast', 'canine', 'primate', 'avian', 'reptile', 'rootling', 'humanoid', 'giant'];
export const VOCAL_KINDS: readonly VocalKind[] = ['roar', 'hurt', 'death'];
export const UI_SOUNDS: readonly UiSound[] = ['click', 'hover', 'confirm', 'back', 'error', 'open', 'close', 'toggle', 'scroll', 'transition'];
export const REACTION_SOUNDS: readonly ReactionSound[] = ['knockback', 'knockdown', 'getup', 'stagger', 'poise-break', 'wall-impact', 'stun-loop'];

const IMPACT_COUNTS: Readonly<Record<ImpactMaterial, Readonly<Record<ImpactWeight, number>>>> = {
  flesh: { light: 2, medium: 3, heavy: 2, finisher: 2 },
  wood: { light: 2, medium: 2, heavy: 2, finisher: 2 },
  bark: { light: 2, medium: 2, heavy: 2, finisher: 2 },
  stone: { light: 2, medium: 2, heavy: 2, finisher: 2 },
};
const IMPACT_GAIN: Readonly<Record<ImpactWeight, number>> = { light: 0.55, medium: 0.75, heavy: 0.95, finisher: 1 };
const IMPACT_PRIORITY: Readonly<Record<ImpactWeight, number>> = { light: 3, medium: 4, heavy: 5, finisher: 6 };
const UI_COUNTS: Readonly<Record<UiSound, number>> = { click: 3, hover: 2, confirm: 2, back: 1, error: 1, open: 1, close: 1, toggle: 1, scroll: 1, transition: 2 };
const REACTION_COUNTS: Readonly<Record<ReactionSound, number>> = { knockback: 2, knockdown: 2, getup: 2, stagger: 2, 'poise-break': 2, 'wall-impact': 2, 'stun-loop': 1 };
const WEAPON_COUNTS: Readonly<Record<WeaponKind, number>> = { glaive: 3, katana: 3, staff: 3, fist: 3, monster: 2 };
const FOOT_COUNTS: Readonly<Record<FootSurface, number>> = { grass: 4, dirt: 4, stone: 4, wood: 3, snow: 3, mud: 3, water: 3 };
const VOCAL_COUNTS: Readonly<Record<VocalFamily, Readonly<Record<VocalKind, number>>>> = {
  beast: { roar: 2, hurt: 2, death: 2 },
  canine: { roar: 2, hurt: 2, death: 1 },
  primate: { roar: 2, hurt: 2, death: 1 },
  avian: { roar: 2, hurt: 1, death: 1 },
  reptile: { roar: 2, hurt: 2, death: 2 },
  rootling: { roar: 2, hurt: 2, death: 2 },
  humanoid: { roar: 2, hurt: 2, death: 2 },
  giant: { roar: 4, hurt: 2, death: 2 },
};

/** Surfaces that ship in the core pack; the rest load with the region that uses them. */
export const CORE_SURFACES: Readonly<Record<FootSurface, boolean>> = { grass: true, dirt: true, stone: true, wood: true, snow: false, mud: false, water: false };

export const impactGroupId = (material: ImpactMaterial, weight: ImpactWeight): string => `impact.${material}.${weight}`;
export const uiGroupId = (sound: UiSound): string => `ui.${sound}`;
export const reactionGroupId = (sound: ReactionSound): string => `react.${sound}`;
export const weaponGroupId = (weapon: WeaponKind): string => `weapon.${weapon}`;
export const footGroupId = (surface: FootSurface): string => `foot.${surface}`;
export const vocalGroupId = (family: VocalFamily, kind: VocalKind): string => `vocal.${family}.${kind}`;
export const FINISHER_LAYER_GROUP = 'impact.finisher-layer';
export const LAND_GROUP = 'foot.land';

function buildGroups(): Readonly<Record<string, SoundGroup>> {
  const groups: Record<string, SoundGroup> = {};
  const add = (group: SoundGroup): void => { groups[group.id] = group; };
  for (const sound of UI_SOUNDS) add({ id: uiGroupId(sound), files: variants(`ui/${sound}`, UI_COUNTS[sound]), bus: 'effects', gain: sound === 'hover' || sound === 'scroll' ? 0.35 : 0.6, maxVoices: 3, priority: 1, rateJitter: 0.03, pack: 'core' });
  for (const material of IMPACT_MATERIALS) {
    for (const weight of IMPACT_WEIGHTS) {
      add({ id: impactGroupId(material, weight), files: variants(`impact/${material}-${weight}`, IMPACT_COUNTS[material][weight]), bus: 'effects', gain: IMPACT_GAIN[weight], maxVoices: 4, priority: IMPACT_PRIORITY[weight], rateJitter: 0.06, pack: 'core' });
    }
  }
  add({ id: FINISHER_LAYER_GROUP, files: variants('impact/finisher-layer', 2), bus: 'effects', gain: 0.7, maxVoices: 2, priority: 6, rateJitter: 0.04, pack: 'core' });
  for (const sound of REACTION_SOUNDS) add({ id: reactionGroupId(sound), files: variants(`react/${sound}`, REACTION_COUNTS[sound]), bus: 'effects', gain: sound === 'getup' || sound === 'stagger' ? 0.6 : 0.9, maxVoices: sound === 'stun-loop' ? 2 : 4, priority: sound === 'poise-break' || sound === 'wall-impact' ? 6 : 4, rateJitter: 0.05, pack: 'core' });
  for (const weapon of WEAPON_KINDS) add({ id: weaponGroupId(weapon), files: variants(`weapon/${weapon}`, WEAPON_COUNTS[weapon]), bus: 'effects', gain: weapon === 'monster' ? 0.8 : 0.65, maxVoices: 4, priority: 2, rateJitter: 0.07, pack: 'core' });
  for (const surface of FOOT_SURFACES) add({ id: footGroupId(surface), files: variants(`foot/${surface}`, FOOT_COUNTS[surface]), bus: 'effects', gain: 0.5, maxVoices: 4, priority: 1, rateJitter: 0.08, pack: surfacePackId(surface) });
  add({ id: LAND_GROUP, files: variants('foot/land', 2), bus: 'effects', gain: 0.7, maxVoices: 2, priority: 2, rateJitter: 0.05, pack: 'core' });
  for (const family of VOCAL_FAMILIES) {
    for (const kind of VOCAL_KINDS) {
      add({ id: vocalGroupId(family, kind), files: variants(`vocal/${family}-${kind}`, VOCAL_COUNTS[family][kind]), bus: 'effects', gain: kind === 'roar' ? 0.9 : 0.8, maxVoices: kind === 'roar' ? 3 : 4, priority: kind === 'death' ? 7 : kind === 'roar' ? 5 : 3, rateJitter: 0.05, pack: `vocal-${family}` });
    }
  }
  return groups;
}

export const SOUND_GROUPS: Readonly<Record<string, SoundGroup>> = buildGroups();

/** Streamed (never PCM-decoded) tracks. */
export const MUSIC_TRACKS = {
  'greenwake-explore': 'audio/music/greenwake-explore.ogg',
  'canopy-explore': 'audio/music/canopy-explore.ogg',
  'grove-explore': 'audio/music/grove-explore.ogg',
  'moonpine-explore': 'audio/music/moonpine-explore.ogg',
  'mistveil-explore': 'audio/music/mistveil-explore.ogg',
  'refuge-explore': 'audio/music/refuge-explore.ogg',
  'hollow-explore': 'audio/music/hollow-explore.ogg',
  'combat-a': 'audio/music/combat-a.ogg',
  'combat-b': 'audio/music/combat-b.ogg',
  'combat-c': 'audio/music/combat-c.ogg',
  boss: 'audio/music/boss.ogg',
  title: 'audio/music/title.ogg',
  'layer-restored': 'audio/music/layer-restored.ogg',
  'layer-corrupted': 'audio/music/layer-corrupted.ogg',
} as const;
export type MusicTrackId = keyof typeof MUSIC_TRACKS;

export const STINGERS = { victory: 'audio/music/stinger-victory.ogg', defeat: 'audio/music/stinger-defeat.ogg' } as const;
export type StingerId = keyof typeof STINGERS;

export const AMBIENCE_TRACKS = {
  forest: 'audio/ambience/forest.ogg',
  wind: 'audio/ambience/wind.ogg',
  swamp: 'audio/ambience/swamp.ogg',
  water: 'audio/ambience/water.ogg',
} as const;
export type AmbienceId = keyof typeof AMBIENCE_TRACKS;

export interface RegionAudioPlan {
  readonly explore: MusicTrackId;
  readonly combat: MusicTrackId;
  readonly ambience: readonly AmbienceId[];
  readonly surface: FootSurface;
  /** Families preloaded with the region; any other family loads when its first actor is seen. */
  readonly families: readonly VocalFamily[];
}

/**
 * Every RegionId the campaign can enter. `blood-bamboo-valley` and `sunmane-expanse` have no authored region yet and reuse existing
 * pieces (no dedicated cue was licensed for them); they cost no extra payload.
 */
export const REGION_AUDIO: Readonly<Record<string, RegionAudioPlan>> = {
  greenwake: { explore: 'greenwake-explore', combat: 'combat-a', ambience: ['forest'], surface: 'grass', families: ['beast', 'humanoid', 'canine'] },
  'whispering-canopy': { explore: 'canopy-explore', combat: 'combat-b', ambience: ['forest'], surface: 'dirt', families: ['primate', 'avian', 'reptile'] },
  'the-grove': { explore: 'grove-explore', combat: 'combat-c', ambience: ['forest'], surface: 'grass', families: ['rootling', 'primate'] },
  'moonpine-ridge': { explore: 'moonpine-explore', combat: 'combat-a', ambience: ['wind'], surface: 'snow', families: ['canine', 'humanoid'] },
  'mistveil-basin': { explore: 'mistveil-explore', combat: 'combat-b', ambience: ['swamp', 'water'], surface: 'mud', families: ['reptile', 'canine'] },
  refuge: { explore: 'refuge-explore', combat: 'combat-b', ambience: ['forest'], surface: 'stone', families: ['beast'] },
  'heartroot-hollow': { explore: 'hollow-explore', combat: 'combat-c', ambience: ['forest'], surface: 'dirt', families: ['rootling', 'giant'] },
  'blood-bamboo-valley': { explore: 'canopy-explore', combat: 'combat-c', ambience: ['forest'], surface: 'wood', families: ['primate', 'reptile'] },
  'sunmane-expanse': { explore: 'hollow-explore', combat: 'combat-a', ambience: ['wind'], surface: 'dirt', families: ['beast', 'canine'] },
};

/** Every file path the runtime can request, for provenance coverage checks. */
export function allCatalogFiles(): readonly string[] {
  const files = new Set<string>();
  for (const group of Object.values(SOUND_GROUPS)) for (const file of group.files) files.add(file);
  for (const file of Object.values(MUSIC_TRACKS)) files.add(file);
  for (const file of Object.values(STINGERS)) files.add(file);
  for (const file of Object.values(AMBIENCE_TRACKS)) files.add(file);
  return [...files].sort();
}

/** Group ids in a pack. */
export function packGroups(pack: string): readonly SoundGroup[] {
  return Object.values(SOUND_GROUPS).filter(group => group.pack === pack);
}
export const vocalPackId = (family: VocalFamily): string => `vocal-${family}`;
export function surfacePackId(surface: FootSurface): string { return CORE_SURFACES[surface] ? 'core' : `surface-${surface}`; }

/**
 * Audio plan of a region id. Exact campaign/playtest ids first; legacy and unknown ids fall back by keyword and finally to the
 * Greenwake plan, so a region can never start without a score.
 */
export function regionPlanOf(regionId: string): RegionAudioPlan {
  const exact = REGION_AUDIO[regionId];
  if (exact) return exact;
  const id = regionId.toLowerCase();
  const key = id.includes('hollow') ? 'heartroot-hollow' : id.includes('grove') ? 'the-grove' : id.includes('canopy') || id.includes('forest') ? 'whispering-canopy'
    : id.includes('moonpine') ? 'moonpine-ridge' : id.includes('mist') || id.includes('marsh') || id.includes('wetland') ? 'mistveil-basin' : 'greenwake';
  return REGION_AUDIO[key]!;
}
