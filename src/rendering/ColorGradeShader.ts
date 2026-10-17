import { Vector3 } from 'three';

/**
 * Final pre-output color-grade pass: lift / gamma / gain, gentle S-curve contrast, saturation, warm-highlight + cool-shadow
 * split toning, soft vignette. Operates in linear HDR, so additive over-drive (ImpactFlash, hit rim, sun glare) survives
 * intact and the tone mapper is only responsible for mapping the graded linear HDR to sRGB.
 */
export const COLOR_GRADE_VERTEX = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

export const COLOR_GRADE_FRAGMENT = /* glsl */`
uniform sampler2D tDiffuse;
uniform vec3 uLift;
uniform vec3 uGamma;
uniform vec3 uGain;
uniform float uSaturation;
uniform vec3 uWarmHighlight;
uniform vec3 uCoolShadow;
uniform float uVignette;
uniform float uExposure;
varying vec2 vUv;

float wcLuma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

/** Smooth S-curve centred on 0.5, controlled by strength in [0,1]. 0 = identity, 1 = strong S. */
float wcSCurve(float x, float strength) {
  // Symmetric S-curve: x - sin(2 pi x) / (2 pi) scaled by strength/2 around 0.5.
  float s = clamp(strength, 0.0, 1.0);
  float t = x - 0.5;
  float curve = t - (sin(t * 6.2831853) / 6.2831853) * 0.5;
  return clamp(0.5 + mix(t, curve, s), 0.0, 1.0);
}

void main() {
  vec3 src = texture2D(tDiffuse, vUv).rgb * uExposure;
  vec3 graded = src;
  // Lift: additive offset that damps toward bright pixels (lift * (1 - color)) so highlights do not get pushed.
  graded = graded + uLift * (1.0 - graded);
  // Gamma: per-channel exponent.
  graded = pow(max(graded, vec3(0.0)), 1.0 / max(uGamma, vec3(0.0001)));
  // Gain: per-channel multiplier.
  graded = graded * uGain;
  // S-curve contrast: pivot on the current luma and apply the same curve to each channel.
  float lumaPre = wcLuma(graded);
  // Strength follows how far the gamma deviates from 1.0 — a warm/cool split (gamma [1.02, 1, 0.96]) implies a
  // subtle S-curve even when no explicit contrast term is set.
  float sCurveStrength = clamp(0.55 * (max(max(uGamma.r, uGamma.g), uGamma.b) - min(min(uGamma.r, uGamma.g), uGamma.b))
                              + 0.35 * (1.0 - abs(1.0 - dot(uGamma, vec3(0.3333)))), 0.0, 1.0);
  float sCurve = wcSCurve(lumaPre, sCurveStrength);
  vec3 gradedS = mix(graded * (sCurve / max(lumaPre, 0.0001)), graded, smoothstep(0.0001, 0.01, lumaPre));
  graded = gradedS;
  // Saturation: lerp between luma and the colour by saturation.
  float luma = wcLuma(graded);
  graded = mix(vec3(luma), graded, uSaturation);
  // Split toning: warm tint in the highlights, cool tint in the shadows. uWarmHighlight and uCoolShadow are 0..1
  // tints that ARE the colour we add; their magnitude is the strength of the effect.
  float highlightMask = smoothstep(0.45, 1.0, luma);
  float shadowMask = smoothstep(0.45, 0.0, luma);
  graded += uWarmHighlight * highlightMask * 0.25;
  graded += uCoolShadow * shadowMask * 0.18;
  // Vignette (radial darkening) — never touches the centre 30 %.
  vec2 ndc = vUv * 2.0 - 1.0;
  float radius = dot(ndc, ndc);
  float vignette = 1.0 - uVignette * smoothstep(0.18, 0.95, radius);
  graded *= vignette;
  gl_FragColor = vec4(max(graded, vec3(0.0)), 1.0);
}`;

/** Named namespace re-export so tests can import `ColorGradeShader.COLOR_GRADE_FRAGMENT` as a single identifier. */
export const ColorGradeShader = { COLOR_GRADE_VERTEX, COLOR_GRADE_FRAGMENT };

export interface ColorGradeSettings {
  readonly lift: Vector3;
  readonly gamma: Vector3;
  readonly gain: Vector3;
  readonly saturation: number;
  readonly warmHighlight: Vector3;
  readonly coolShadow: Vector3;
  readonly vignette: number;
  /** Tone-map exposure multiplier (post-graded linear HDR). 1.0 = no change. */
  readonly exposure: number;
}

export function neutralGradeSettings(): ColorGradeSettings {
  return {
    lift: new Vector3(0, 0, 0),
    gamma: new Vector3(1, 1, 1),
    gain: new Vector3(1, 1, 1),
    saturation: 1,
    warmHighlight: new Vector3(0, 0, 0),
    coolShadow: new Vector3(0, 0, 0),
    vignette: 0,
    exposure: 1,
  };
}

export function hexTuple(value: number): Vector3 {
  return new Vector3(((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255);
}

/**
 * Picks the grade triple (r,g,b in 0..1) into a Vector3 the shader can consume. The profile's lift/gain/gamma are
 * authored as small floats (e.g. `lift: [0.04, 0.02, 0.0]`) so we don't scale them; saturation/vignette are passed
 * through `tint` directly with no scale.
 */
export function tintedVector(tint: readonly [number, number, number], scale: number): Vector3 {
  return new Vector3(tint[0] * scale, tint[1] * scale, tint[2] * scale);
}
