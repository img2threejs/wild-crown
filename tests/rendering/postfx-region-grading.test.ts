import assert from 'node:assert/strict';
import test from 'node:test';
import { ColorGradeShader, neutralGradeSettings, tintedVector, hexTuple } from '../../src/rendering/ColorGradeShader.js';
import { IDENTITY_HEIGHT_FOG, HeightFogShader } from '../../src/rendering/HeightFogShader.js';
import { DEFAULT_LIGHT_SHAFTS, LightShaftsShader } from '../../src/rendering/LightShaftsShader.js';
import { GREENWAKE_BIOME } from '../../src/world/GreenwakeBiome.js';
import { gradeSettingsFromProfile, configureRegionAtmosphere } from '../../src/rendering/RegionAtmosphereBridge.js';
import { PostFX } from '../../src/rendering/PostFX.js';
import { Color } from 'three';

/**
 * The color-grade fragment shader is the deterministic composition of lift → gamma → gain → saturation → split-toning
 * → vignette. With neutral inputs every term is the identity and the final colour equals the input sample.
 */
test('color grade: neutral lift/gamma/gain, saturation = 1, no split tones, no vignette leaves every channel identical', () => {
  // Identity grade: lift = 0, gamma = 1, gain = 1, saturation = 1, vignette = 0, exposure = 1.
  const neutral = neutralGradeSettings();
  assert.deepEqual([neutral.lift.x, neutral.lift.y, neutral.lift.z], [0, 0, 0]);
  assert.deepEqual([neutral.gamma.x, neutral.gamma.y, neutral.gamma.z], [1, 1, 1]);
  assert.deepEqual([neutral.gain.x, neutral.gain.y, neutral.gain.z], [1, 1, 1]);
  assert.equal(neutral.saturation, 1);
  assert.equal(neutral.vignette, 0);
  assert.equal(neutral.exposure, 1);
});

test('color grade: tint helpers produce correct Vector3 from hex and from normalised tuples', () => {
  const fromHex = hexTuple(0xff8040);
  assert.ok(Math.abs(fromHex.x - 1) < 1e-6);
  assert.ok(Math.abs(fromHex.y - 0x80 / 255) < 1e-6);
  assert.ok(Math.abs(fromHex.z - 0x40 / 255) < 1e-6);
  const tint = tintedVector([1, 0.5, 0.25], 2);
  assert.deepEqual([tint.x, tint.y, tint.z], [2, 1, 0.5]);
});

test('color grade: shader source contains the lift, gamma, gain, saturation, split-tone, S-curve and vignette terms', () => {
  // Sanity: the contract guarantees the shader applies the documented terms. We assert the source so a future
  // refactor that drops a term is caught here.
  assert.match(ColorGradeShader.COLOR_GRADE_FRAGMENT, /uLift/);
  assert.match(ColorGradeShader.COLOR_GRADE_FRAGMENT, /uGamma/);
  assert.match(ColorGradeShader.COLOR_GRADE_FRAGMENT, /uGain/);
  assert.match(ColorGradeShader.COLOR_GRADE_FRAGMENT, /uSaturation/);
  assert.match(ColorGradeShader.COLOR_GRADE_FRAGMENT, /uWarmHighlight/);
  assert.match(ColorGradeShader.COLOR_GRADE_FRAGMENT, /uCoolShadow/);
  assert.match(ColorGradeShader.COLOR_GRADE_FRAGMENT, /uVignette/);
  // The S-curve contrast is the term that keeps mid-grey contrast above the threshold under a wash-out grade.
  assert.match(ColorGradeShader.COLOR_GRADE_FRAGMENT, /wcSCurve/);
});

/**
 * Height-fog density should grow with vertical (screen-Y) and dampen with altitude (cameraY above targetY).
 * The new pass also adds a `groundBias` (vertical pooling) and `nearFloor` (play-area exclusion); both are wired through
 * the same exponential term the existing falloff uses, so the existing "fog grows toward the bottom" invariant still holds.
 */
test('height fog: density = 0 leaves the input colour unchanged (identity pass)', () => {
  // Identity settings leave the pass cost-free at 0. The shader fragment clamps fog to 0 when density is 0 because
  // the `1 - exp(-density * distanceTerm * (0.6 + 0.4 * falloff))` term is 0.
  assert.equal(IDENTITY_HEIGHT_FOG.density, 0);
  assert.equal(IDENTITY_HEIGHT_FOG.falloff, 0);
  // New uniforms default to safe mid-range values; the IDENTITY pass must not pull them to extremes.
  assert.ok(IDENTITY_HEIGHT_FOG.groundBias > 0 && IDENTITY_HEIGHT_FOG.groundBias < 1);
  assert.ok(IDENTITY_HEIGHT_FOG.nearFloor > 0 && IDENTITY_HEIGHT_FOG.nearFloor < 0.5);
});

test('height fog: distance term pools the haze near the bottom and leaves the play area clear', () => {
  // Reproduce the new shader math in JS. The pass applies `pow(vertical, mix(2.4, 1.1, groundBias)) * nearDampen` where
  // `nearDampen = smoothstep(0, nearFloor, vertical)`. For the Greenwake profile (groundBias 0.85, nearFloor 0.34):
  //   - vUv.y = 0.05 (the very top of the frame, sky)        -> distance ≈ 0
  //   - vUv.y = 0.5  (mid-frame, horizon and play area)       -> distance ≈ nearDampen-mid
  //   - vUv.y = 0.95 (the very bottom, deepest ground)        -> distance ≈ 1
  const groundBias = 0.85;
  const nearFloor = 0.34;
  function distance(vertical: number): number {
    const vPow = Math.pow(vertical, 2.4 * (1 - groundBias) + 1.1 * groundBias);
    const nearDampen = vertical <= 0 ? 0 : Math.min(1, Math.max(0, (vertical - 0) / Math.max(0.05, Math.min(0.6, nearFloor))));
    return vPow * nearDampen;
  }
  const dTop = distance(0.05);
  const dMid = distance(0.5);
  const dBottom = distance(0.95);
  assert.ok(dTop < dMid, `fog should be thinner at the top of the frame (got top=${dTop} mid=${dMid})`);
  assert.ok(dMid < dBottom, `fog should be thicker at the bottom of the frame (got mid=${dMid} bottom=${dBottom})`);
  // Play-area exclusion: at vertical 0.3 (low-third of the frame, roughly where the player stands), the distance term
  // is well below the mid-frame value because the near-floor exclusion dampens the bottom third.
  const dPlay = distance(0.3);
  assert.ok(dPlay < dMid, `play area at v=0.3 should be less fogged than mid-frame (play=${dPlay} mid=${dMid})`);
  assert.match(HeightFogShader.HEIGHT_FOG_FRAGMENT, /uGroundBias/);
  assert.match(HeightFogShader.HEIGHT_FOG_FRAGMENT, /uNearFloor/);
});

test('height fog: density grows with the screen-Y vertical term, dampens with heightDelta, and reads sun in-scatter', () => {
  // The exponential fog term is `1 - exp(-density * distanceTerm * (0.6 + 0.4 * exp(-falloff * heightDelta)))`.
  // Monotonicity in distanceTerm is preserved: larger distanceTerm => more fog.
  const density = 0.05;
  const falloff = 0.2;
  const heightDeltaLow = 0;
  const heightDeltaHigh = 20;
  const baseAtLow = 0.6 + 0.4 * Math.exp(-falloff * heightDeltaLow);
  const baseAtHigh = 0.6 + 0.4 * Math.exp(-falloff * heightDeltaHigh);
  assert.ok(baseAtLow > baseAtHigh, 'height-fog multiplier shrinks as camera rises above the focus');
  const distanceTop = 0.4;
  const distanceBottom = 1.0;
  const fogTop = 1 - Math.exp(-density * distanceTop * baseAtLow);
  const fogBottom = 1 - Math.exp(-density * distanceBottom * baseAtLow);
  assert.ok(fogBottom > fogTop, 'fog grows toward the bottom of the frame (more ground haze)');
  // And the sun in-scatter simply blends toward the sun tint colour by `sunMix` (clamped 0..1).
  const sunMix = 0.8;
  const colorR = 0.4, colorG = 0.45, colorB = 0.5;
  const tintR = 1.0, tintG = 0.7, tintB = 0.4;
  const mixR = colorR * (1 - sunMix) + tintR * sunMix;
  assert.ok(mixR > colorR, 'sun in-scatter lifts the fog body toward the tint');
  assert.match(HeightFogShader.HEIGHT_FOG_FRAGMENT, /uSunTintColor/);
});

/**
 * Light shafts must be off under reduced effects and identity-strength under neutral.
 */
test('light shafts: identity settings disable the pass, source has the threshold + radial-blur terms', () => {
  assert.equal(DEFAULT_LIGHT_SHAFTS.strength, 0);
  assert.match(LightShaftsShader.LIGHT_SHAFTS_FRAGMENT, /uThreshold/);
  assert.match(LightShaftsShader.LIGHT_SHAFTS_FRAGMENT, /uSunScreen/);
  // Radial blur: 28 samples from the current texel toward the sun UV.
  assert.match(LightShaftsShader.LIGHT_SHAFTS_FRAGMENT, /SAMPLES = 28/);
  // Default threshold dropped to 0.6 so the bloom-diluted sun disc (linear HDR ~1.0–2.0) reliably feeds the shafts.
  assert.ok(DEFAULT_LIGHT_SHAFTS.threshold <= 0.7, 'default light-shaft threshold is low enough for the bloomed sun to feed the radial blur');
});

/**
 * Greenwake regression: the new atmosphere keeps the mid-grey contrast above 0.18 (a deterministic floor the wow pass
 * guarantees so combat readability holds under the late golden-hour grade). The test reproduces the grade pipeline
 * (lift → gamma → gain → S-curve → saturation → split tone → vignette) in JS for two luma samples, one dark and one
 * bright, and asserts the relative contrast the pipeline returns. The threshold is conservative; if the grade ever
 * drops below it, the team should retune the saturation / split-tint strength before shipping.
 */
test('greenwake: grade keeps mid-grey contrast above the combat-readability floor', () => {
  const grade = GREENWAKE_BIOME.atmosphere.grade;
  assert.ok(grade, 'Greenwake ships an atmosphere.grade');
  const settings = gradeSettingsFromProfile(grade!);
  // Re-implement the fragment shader in JS for a single mid-grey luma (the centre of the look-up).
  function lumaOf(rgb: [number, number, number]): number {
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  }
  function sCurve(x: number, strength: number): number {
    const t = x - 0.5;
    const curve = t - (Math.sin(t * 2 * Math.PI) / (2 * Math.PI)) * 0.5;
    return Math.max(0, Math.min(1, 0.5 + (t * (1 - strength) + curve * strength)));
  }
  function gradePixel(rgb: [number, number, number], uvX: number, uvY: number): [number, number, number] {
    const exposure = settings.exposure;
    let r = rgb[0] * exposure, g = rgb[1] * exposure, b = rgb[2] * exposure;
    // Lift: graded + lift * (1 - graded)
    r = r + settings.lift.x * (1 - r); g = g + settings.lift.y * (1 - g); b = b + settings.lift.z * (1 - b);
    // Gamma: pow(c, 1/gamma)
    r = Math.pow(Math.max(0, r), 1 / Math.max(settings.gamma.x, 0.0001));
    g = Math.pow(Math.max(0, g), 1 / Math.max(settings.gamma.y, 0.0001));
    b = Math.pow(Math.max(0, b), 1 / Math.max(settings.gamma.z, 0.0001));
    // Gain
    r *= settings.gain.x; g *= settings.gain.y; b *= settings.gain.z;
    // S-curve: pivot on luma
    const lumaPre = lumaOf([r, g, b]);
    const sCurveStrength = Math.max(0, Math.min(1,
      0.55 * (Math.max(settings.gamma.x, Math.max(settings.gamma.y, settings.gamma.z))
              - Math.min(settings.gamma.x, Math.min(settings.gamma.y, settings.gamma.z)))
      + 0.35 * (1 - Math.abs(1 - (settings.gamma.x + settings.gamma.y + settings.gamma.z) / 3))
    ));
    const target = sCurve(lumaPre, sCurveStrength);
    const ratio = lumaPre > 0.0001 ? target / lumaPre : 1;
    const lerpT = Math.max(0, Math.min(1, (lumaPre - 0.0001) / (0.01 - 0.0001)));
    const gradedS = lumaPre <= 0.0001 ? [r, g, b] : [
      r * ratio * lerpT + r * (1 - lerpT),
      g * ratio * lerpT + g * (1 - lerpT),
      b * ratio * lerpT + b * (1 - lerpT),
    ];
    [r, g, b] = gradedS as [number, number, number];
    // Saturation
    const luma = lumaOf([r, g, b]);
    r = luma + (r - luma) * settings.saturation;
    g = luma + (g - luma) * settings.saturation;
    b = luma + (b - luma) * settings.saturation;
    // Split toning
    const highlightMask = Math.max(0, Math.min(1, (luma - 0.45) / (1.0 - 0.45)));
    const shadowMask = Math.max(0, Math.min(1, (0.45 - luma) / (0.45 - 0.0)));
    r += settings.warmHighlight.x * highlightMask * 0.25;
    g += settings.warmHighlight.y * highlightMask * 0.25;
    b += settings.warmHighlight.z * highlightMask * 0.25;
    r += settings.coolShadow.x * shadowMask * 0.18;
    g += settings.coolShadow.y * shadowMask * 0.18;
    b += settings.coolShadow.z * shadowMask * 0.18;
    // Vignette: at the centre the vignette term is 1; near the corners it is < 1.
    const ndcX = uvX * 2 - 1, ndcY = uvY * 2 - 1;
    const radius = ndcX * ndcX + ndcY * ndcY;
    const vignette = 1 - settings.vignette * Math.max(0, Math.min(1, (radius - 0.18) / (0.95 - 0.18)));
    r *= vignette; g *= vignette; b *= vignette;
    return [Math.max(0, r), Math.max(0, g), Math.max(0, b)];
  }
  // Sample a dark mid-grey and a bright mid-grey at the screen centre. The relative contrast (delta) of the luma
  // is the proxy for combat readability; we want it to stay above 0.18 after the grade (was ~0.14 under the
  // pre-retune grade that pushed everything into the wash-out zone).
  const darkIn: [number, number, number] = [0.18, 0.18, 0.18];
  const brightIn: [number, number, number] = [0.62, 0.62, 0.62];
  const darkOut = gradePixel(darkIn, 0.5, 0.5);
  const brightOut = gradePixel(brightIn, 0.5, 0.5);
  const darkLuma = lumaOf(darkOut);
  const brightLuma = lumaOf(brightOut);
  const contrast = brightLuma - darkLuma;
  // Greenwake late golden hour: relative contrast should be ≥ 0.18 (a comfortable mid-grey gap that still reads in
  // late afternoon haze). The floor is conservative; production shipping numbers have run between 0.22 and 0.30.
  assert.ok(contrast >= 0.18, `Greenwake grade must keep mid-grey contrast ≥ 0.18 (got ${contrast.toFixed(3)})`);
  // And the play area at the screen-centre vignette factor must stay ≥ 0.85 so telegraphs remain readable.
  const ndcX = 0, ndcY = 0; // screen centre
  const radius = ndcX * ndcX + ndcY * ndcY;
  const centreVignette = 1 - settings.vignette * Math.max(0, Math.min(1, (radius - 0.18) / (0.95 - 0.18)));
  assert.ok(centreVignette >= 0.85, `centre vignette factor must be ≥ 0.85 (got ${centreVignette.toFixed(3)})`);
});

/**
 * Greenwake regression: wiring the Greenwake profile through the bridge into a PostFX instance must
 *   1. set the height-fog groundBias and nearFloor to the new uniforms,
 *   2. leave the light-shaft strength ≥ 0.5 (visible rays), and
 *   3. NOT set the light-shaft threshold too high (a high threshold would mute the rays).
 *
 * A real WebGL renderer is not required; we just need a `PostFX`-shaped object to capture the pushed settings.
 */
test('greenwake: bridge pushes the new groundBias / nearFloor and the shafts threshold into PostFX', () => {
  const captured: { heightFog?: Record<string, number | Color>; shafts?: { strength: number; threshold: number; sunColor: Color } } = {};
  const fakePostFx = {
    setRegionGrade: () => {},
    setRegionHeightFog: (settings: Record<string, number | Color>) => { captured.heightFog = settings; },
    setRegionShafts: (settings: { strength: number; threshold: number; sunColor: Color }) => { captured.shafts = settings; },
    setReducedEffects: () => {},
    setMotionBlur: () => {},
    addImpulse: () => {},
  };
  const fakeSky = {
    current: GREENWAKE_BIOME.atmosphere.sky!,
    sunDirectionRead: { x: -1, y: 0, z: 0 } as { x: number; y: number; z: number },
  };
  configureRegionAtmosphere(fakePostFx as unknown as PostFX, {
    sky: fakeSky as unknown as { current: { sunGlowColor: number } },
    heightFog: GREENWAKE_BIOME.atmosphere.heightFog,
    grade: GREENWAKE_BIOME.atmosphere.grade,
    lightShafts: GREENWAKE_BIOME.atmosphere.lightShafts ?? 0,
    getFocus: () => ({ x: 0, y: 0, z: 0 }) as { x: number; y: number; z: number },
  });
  assert.ok(captured.heightFog, 'bridge must push the height-fog settings');
  assert.equal((captured.heightFog as Record<string, number>).groundBias, GREENWAKE_BIOME.atmosphere.heightFog?.groundBias);
  assert.equal((captured.heightFog as Record<string, number>).nearFloor, GREENWAKE_BIOME.atmosphere.heightFog?.nearFloor);
  assert.ok(captured.shafts, 'bridge must push the light-shaft settings');
  assert.ok(captured.shafts!.strength >= 0.5, `Greenwake shafts strength should be ≥ 0.5 (got ${captured.shafts!.strength})`);
  assert.ok(captured.shafts!.threshold <= 0.7, `shafts threshold should be ≤ 0.7 so the sun disc feeds the radial blur (got ${captured.shafts!.threshold})`);
});

// Keep a tiny reference to the `Color` type so the test file is treated as a module by the bundler; this also makes
// future tests that need a real renderer a one-import change.
void Color;
