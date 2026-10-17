import { Vector2, Vector3, type Camera } from 'three';

/**
 * Screen-space god-rays (light shafts) shader. Reads the previous HDR pass and radially blurs toward the sun's projected
 * screen position. Only taps close to the sun feed the rays (`SUN_FEED_RADIUS` in UV), so bright gameplay VFX, sigils and
 * glowing actors are never smeared into discs. When the sun leaves the frame the bridge fades `uStrength` to 0 and the
 * pass is disabled; there is no fallback pull toward the screen centre.
 */
export const LIGHT_SHAFTS_VERTEX = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

export const LIGHT_SHAFTS_FRAGMENT = /* glsl */`
uniform sampler2D tDiffuse;
uniform vec2 uSunScreen;
uniform vec3 uSunColor;
uniform float uStrength;
uniform float uThreshold;
uniform float uDecay;
uniform float uDensity;
uniform float uWeight;
varying vec2 vUv;

const float SAMPLES = 28.0;
const float SUN_FEED_RADIUS = 0.28;

void main() {
  vec3 base = texture2D(tDiffuse, vUv).rgb;
  vec2 sunUV = uSunScreen;
  vec2 stepUv = (sunUV - vUv) / SAMPLES * uDensity;
  vec2 coord = vUv;
  float illuminationDecay = 1.0;
  vec3 sum = vec3(0.0);
  for (float i = 0.0; i < SAMPLES; i += 1.0) {
    coord = clamp(coord + stepUv, vec2(0.001), vec2(0.999));
    vec3 tap = texture2D(tDiffuse, coord).rgb;
    // Only bright sky around the sun disc feeds a ray: a tap's weight falls to zero SUN_FEED_RADIUS away from the sun.
    float bright = max(tap.r, max(tap.g, tap.b));
    float near = 1.0 - smoothstep(0.0, SUN_FEED_RADIUS, length(coord - sunUV));
    tap *= max(0.0, bright - uThreshold) * near;
    tap *= illuminationDecay * uWeight;
    sum += tap;
    illuminationDecay *= uDecay;
  }
  vec3 shafts = max(sum * uSunColor * uStrength * 0.26, vec3(0.0));
  gl_FragColor = vec4(base + shafts, 1.0);
}`;

export interface LightShaftsSettings {
  /** Sun screen UV in [0,1]; `Vector2(2, 2)` means off-screen — the pass still runs in case the player pans. */
  readonly sunScreen: Vector2;
  /** Strength 0..1; 0 means the pass output is zero (caller disables the pass for cleanliness). */
  readonly strength: number;
  /** Linear-HDR luminance threshold above which a pixel feeds into the shafts (post-bloom sun disc ≈ 8). */
  readonly threshold?: number;
  /** Sun tint multiplied into the radial accumulation (default = profile sunColor). */
  readonly sunColor?: Vector3;
  /** Decay per sample (0..1). 0.94 looks like canopy shafts, 0.98 like open sky. */
  readonly decay?: number;
  /** Step density; controls how far each sample reaches toward the sun. */
  readonly density?: number;
  /** Per-sample weight. */
  readonly weight?: number;
}

export interface ResolvedLightShaftsSettings {
  readonly sunScreen: Vector2;
  readonly strength: number;
  readonly threshold: number;
  readonly sunColor: Vector3;
  readonly decay: number;
  readonly density: number;
  readonly weight: number;
}

export const DEFAULT_LIGHT_SHAFTS: Omit<ResolvedLightShaftsSettings, 'sunScreen' | 'sunColor'> = {
  strength: 0,
  // Threshold dropped from 0.85 to 0.6 so the bloom-diluted sun disc (linear HDR ~1.0–2.0 after bloom) reliably feeds
  // the shafts; the existing `mask` term is non-additive so lower thresholds are not a false positive on mid-tone sky.
  threshold: 0.6,
  decay: 0.965,
  density: 0.78,
  weight: 0.42,
};

const SUN_PROJECTION = new Vector3();
/** Computes the screen-UV sun position from a world-space sun direction and a camera into `out` (allocation free).
 *  A sun behind the camera (its projection would mirror onto the screen) is reported far off-screen at (9, 9). */
export function projectSunScreen(sunDirection: Readonly<Vector3>, focus: Readonly<Vector3>, camera: Camera, out: Vector2): Vector2 {
  SUN_PROJECTION.set(sunDirection.x, sunDirection.y, sunDirection.z).multiplyScalar(180).add(focus).project(camera);
  if (SUN_PROJECTION.z > 1) return out.set(9, 9);
  return out.set(SUN_PROJECTION.x * 0.5 + 0.5, SUN_PROJECTION.y * 0.5 + 0.5);
}

/** Named namespace re-export so tests can import `LightShaftsShader.LIGHT_SHAFTS_FRAGMENT` as a single identifier. */
export const LightShaftsShader = { LIGHT_SHAFTS_VERTEX, LIGHT_SHAFTS_FRAGMENT };
