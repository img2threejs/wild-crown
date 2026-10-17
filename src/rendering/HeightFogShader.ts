import { Vector3 } from 'three';

/**
 * Screen-space height-fog pass. Reads the HDR scene buffer and mixes a per-region fog body whose density grows toward
 * the bottom of the frame and whose body tints toward the sun (in-scatter). Camera/target heights drive the falloff so
 * deep hollows stay readable while hilltops stay clear.
 *
 * The pass stays cheap (1 texture read, ~10 ALU per fragment, no extra render target). It runs after bloom / shafts and
 * before the colour grade, so the grade finalises the look. Without a real depth buffer, the per-pixel world Y is
 * approximated by the screen-Y gradient (the lower the fragment, the more fog); the height term further dampens the
 * effect when the camera is above the focus.
 */
export const HEIGHT_FOG_VERTEX = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

export const HEIGHT_FOG_FRAGMENT = /* glsl */`
uniform sampler2D tDiffuse;
uniform vec3 uColor;
uniform float uDensity;
uniform float uFalloff;
uniform float uSunMix;
uniform vec3 uSunTintColor;
uniform float uCameraY;
uniform float uTargetY;
/** Strength of the screen-Y bias that pools the fog in the lower / distant half of the frame (0 = uniform, 1 = pools at the bottom). */
uniform float uGroundBias;
/** Multiplier on the play-area exclusion: the bottom ~30 % of the frame stays nearly clear of fog. */
uniform float uNearFloor;
varying vec2 vUv;

void main() {
  vec3 base = texture2D(tDiffuse, vUv).rgb;
  // Approximate per-pixel world Y: bottom of the frame is near the focus, top is the sky.
  float vertical = clamp(1.0 - vUv.y, 0.0, 1.0);
  // Power-shaped vertical falloff: 0 at the top (sky stays clean) → 1 at the bottom. uGroundBias (0..1) tightens or widens
  // the band, so a low bias keeps the haze thin near the horizon and pushes it to the lower third of the frame; a high
  // bias pools it all the way down to the bottom edge.
  float vPow = pow(vertical, mix(2.4, 1.1, clamp(uGroundBias, 0.0, 1.0)));
  // Near-camera exclusion: the lowest 30 % of the frame is the play area; we dampen fog there so the player / enemies /
  // telegraphs stay at full contrast. The dampening falls off smoothly past uNearFloor.
  float nearDampen = smoothstep(0.0, clamp(uNearFloor, 0.05, 0.6), vertical);
  float distanceTerm = vPow * nearDampen;
  float heightDelta = uTargetY - uCameraY;
  float falloff = exp(-uFalloff * max(0.0, heightDelta));
  float fog = 1.0 - exp(-uDensity * distanceTerm * (0.6 + 0.4 * falloff));
  // The horizontal component is dominant at low altitude, so the fog feels thicker near the ground.
  vec3 fogColor = mix(uColor, uSunTintColor, clamp(uSunMix, 0.0, 1.0));
  vec3 graded = mix(base, fogColor, clamp(fog, 0.0, 0.85));
  gl_FragColor = vec4(graded, 1.0);
}`;

export interface HeightFogSettings {
  readonly color: Vector3;
  readonly density: number;
  readonly falloff: number;
  readonly sunMix: number;
  readonly sunTintColor: Vector3;
  readonly cameraY: number;
  readonly targetY: number;
  /** 0..1 strength of the vertical pooling (0 = uniform across the frame, 1 = pools at the bottom). */
  readonly groundBias: number;
  /** Bottom-N share of the frame kept nearly fog-free so the play area stays at full contrast. */
  readonly nearFloor: number;
}

export const IDENTITY_HEIGHT_FOG: Omit<HeightFogSettings, 'cameraY' | 'targetY'> = {
  color: new Vector3(0.85, 0.86, 0.88),
  density: 0,
  falloff: 0,
  sunMix: 0,
  sunTintColor: new Vector3(1, 0.95, 0.85),
  groundBias: 0.7,
  nearFloor: 0.3,
};

/** Named namespace re-export so tests can import `HeightFogShader.HEIGHT_FOG_FRAGMENT` as a single identifier. */
export const HeightFogShader = { HEIGHT_FOG_VERTEX, HEIGHT_FOG_FRAGMENT };
