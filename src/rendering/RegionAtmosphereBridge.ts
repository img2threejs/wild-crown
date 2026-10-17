import { Vector2, Vector3, type Camera } from 'three';
import { hexTuple, tintedVector, type ColorGradeSettings } from './ColorGradeShader';
import { projectSunScreen } from './LightShaftsShader';
import type { HeightFogProfile, RegionGradeProfile } from '../world/BiomeProfile';
import type { AtmosphericSky } from '../world/AtmosphericSky';
import type { PostFX } from './PostFX';

/** Fallback shafts sun colour when a profile does not ship an explicit sunGlowColor. */
const DEFAULT_SHAFTS_SUN = 0xffe6b0;
/** Strength × threshold scalar passed in for the late golden-hour region (Greenwake reads warm and visible). */
const GOLDEN_HOUR_THRESHOLD = 0.55;
const DEFAULT_SHAFTS_THRESHOLD = 0.6;

/**
 * Bridges a `RegionEnvironment` to a `PostFX` instance without creating a circular import: the world module must not
 * pull from `rendering/PostFX`, so we sit the wiring layer here. `applyRegionAtmosphere` reads the live sky + grade + height
 * fog state off the environment and pushes each one into PostFX every frame. GameRenderer only needs to call it once per
 * frame (or simply after `setSceneAtmosphere`) to keep the post chain fed.
 */
export interface RegionAtmosphereBindings {
  readonly sky: AtmosphericSky;
  readonly heightFog: HeightFogProfile | undefined;
  readonly grade: RegionGradeProfile | undefined;
  readonly lightShafts: number;
  /** World-space focus (the camera focus / player position). */
  getFocus(): Vector3;
}

/** Pushes identity settings into the grade pass; the unified builder prefers a profile. Exported for tests. */
export function gradeSettingsFromProfile(profile: RegionGradeProfile): ColorGradeSettings {
  return {
    lift: tintedVector(profile.lift, 1),
    gamma: tintedVector(profile.gamma, 1),
    gain: tintedVector(profile.gain, 1),
    saturation: profile.saturation,
    warmHighlight: tintedVector(profile.warmHighlight, 1),
    coolShadow: tintedVector(profile.coolShadow, 1),
    vignette: profile.vignette,
    exposure: 1,
  };
}

/**
 * One-shot setup — pushes the per-region grade once into the post chain. Safe to call repeatedly (idempotent). The shafts
 * pass needs the screen-space sun position, so it is updated per-frame separately via `updateRegionShafts`.
 */
export function configureRegionAtmosphere(postFx: PostFX, bindings: RegionAtmosphereBindings): void {
  if (bindings.grade) postFx.setRegionGrade(gradeSettingsFromProfile(bindings.grade));
  else postFx.setRegionGrade({});
  if (bindings.heightFog) {
    postFx.setRegionHeightFog({
      color: hexTuple(bindings.heightFog.color),
      density: bindings.heightFog.density,
      falloff: bindings.heightFog.falloff,
      sunMix: bindings.heightFog.sunTint,
      sunTintColor: hexTuple(bindings.heightFog.sunTintColor),
      groundBias: bindings.heightFog.groundBias ?? 0.65,
      nearFloor: bindings.heightFog.nearFloor ?? 0.32,
    });
  } else {
    postFx.setRegionHeightFog({ density: 0 });
  }
  // Shafts sun colour: prefer the profile's own sunGlowColor (warm/cool matches the dome) and fall back to a soft amber.
  // Threshold drops from 0.85 to 0.6 so the bloom-diluted sun disc actually feeds the radial blur.
  const shaftsSun = bindings.sky.current.sunGlowColor ?? DEFAULT_SHAFTS_SUN;
  const threshold = bindings.sky.current.sunGlowColor && bindings.sky.current.sunGlowColor !== DEFAULT_SHAFTS_SUN
    ? GOLDEN_HOUR_THRESHOLD
    : DEFAULT_SHAFTS_THRESHOLD;
  postFx.setRegionShafts({ strength: bindings.lightShafts, sunColor: hexTuple(shaftsSun), threshold });
}

const SUN_SCREEN = new Vector2();
/** Shafts fade to nothing once the sun is this far (screen UV) outside the frame. */
const SHAFTS_EDGE_FADE = 0.25;
/**
 * Per-frame shafts update (allocation free): projects the sun to screen-UV and pushes the position into the shafts pass.
 * Strength fades with the sun's distance outside the frame, so the pass is disabled (zero cost) whenever the sun is well
 * out of view — the usual case for the elevated gameplay camera. Reduced mode is handled by PostFX.
 */
export function updateRegionShafts(postFx: PostFX, bindings: RegionAtmosphereBindings, camera: Camera): void {
  if (bindings.lightShafts <= 0) { postFx.setRegionShafts({ strength: 0 }); return; }
  const screen = projectSunScreen(bindings.sky.sunDirectionRead, bindings.getFocus(), camera, SUN_SCREEN);
  const outside = Math.max(0, -screen.x, screen.x - 1, -screen.y, screen.y - 1);
  const fade = Math.max(0, 1 - outside / SHAFTS_EDGE_FADE);
  postFx.setRegionShafts({ sunScreen: screen, strength: bindings.lightShafts * fade });
}
