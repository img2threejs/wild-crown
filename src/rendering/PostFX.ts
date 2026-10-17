import { ACESFilmicToneMapping, HalfFloatType, Mesh, PlaneGeometry, SRGBColorSpace, Scene as ThreeScene, ShaderMaterial, Vector2, Vector3, Vector4, WebGLRenderTarget, type Camera, type Scene, type WebGLRenderer } from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { COLOR_GRADE_FRAGMENT, COLOR_GRADE_VERTEX, neutralGradeSettings, type ColorGradeSettings } from './ColorGradeShader.js';
import { HEIGHT_FOG_FRAGMENT, HEIGHT_FOG_VERTEX, IDENTITY_HEIGHT_FOG, type HeightFogSettings } from './HeightFogShader.js';
import { DEFAULT_LIGHT_SHAFTS, LIGHT_SHAFTS_FRAGMENT, LIGHT_SHAFTS_VERTEX } from './LightShaftsShader.js';

export interface PostFXOptions {
  /** Device pixel ratio ceiling for the HDR chain (default 1). Greenwake measured 47 fps at 1440×900 on M1 with ×4 MSAA, 57 fps with ×2 (both at ratio 1). */
  readonly pixelRatioCap?: number;
  readonly bloomStrength?: number;
  readonly bloomRadius?: number;
  /** Linear HDR luminance above which pixels bloom; 1.0 means only emissive/additive overdrive glows. */
  readonly bloomThreshold?: number;
  /** HDR target MSAA sample count (default 2; ×4 costs ~10 fps on the dense Greenwake ground at 1440×900). */
  readonly msaaSamples?: number;
  readonly exposure?: number;
}

/** Scene HDR ceiling: anything brighter is an authoring error, never a feature. */
export const HDR_CEILING = 64;

/**
 * NaN → 0, ±Inf/overshoot → [0, ceiling]. Comparisons with NaN are false, so this survives
 * fast-math drivers that fold away isnan()/isinf().
 */
const SANITIZE = /* glsl */`
float wcSanitizeChannel(float v) { return (v >= 0.0 && v <= ${HDR_CEILING.toFixed(1)}) ? v : (v > ${HDR_CEILING.toFixed(1)} ? ${HDR_CEILING.toFixed(1)} : 0.0); }
vec4 wcSanitize(vec4 c) {
  return vec4(wcSanitizeChannel(c.r), wcSanitizeChannel(c.g), wcSanitizeChannel(c.b), (c.a >= 0.0 && c.a <= 1.0) ? c.a : 1.0);
}
`;

/** Wraps one exact texture read of a library pass in `wcSanitize`; fails loudly if three's source changed. */
function sanitizeRead(material: ShaderMaterial, read: string): void {
  const source = material.fragmentShader;
  const main = source.indexOf('void main()');
  if (main < 0 || !source.includes(read)) throw new Error(`PostFX cannot install the HDR sanitizer into ${material.name || 'a post pass'}: shader source changed.`);
  // A pass may wrap several reads; the sanitizer functions are declared once.
  const prelude = source.includes('wcSanitizeChannel') ? '' : SANITIZE;
  material.fragmentShader = source.slice(0, main) + prelude + source.slice(main).replace(read, `wcSanitize(${read})`);
  material.needsUpdate = true;
}

/** Strength ceiling of the impact impulse and the longest a single impulse may last. */
export const IMPULSE_MAX_STRENGTH = 1;
export const IMPULSE_MAX_SECONDS = 0.6;

/**
 * Decaying 0..1 envelope behind the screen impulse. Framework-free: `addImpulse` keeps the stronger of the current
 * remaining level and the new request, strength is capped, and `active` is false at rest so the pass can be skipped.
 */
export class ImpulseEnvelope {
  private peak = 0;
  private duration = 0;
  private elapsed = 0;

  add(strength: number, seconds: number): boolean {
    if (!(strength > 0) || !(seconds > 0) || !Number.isFinite(strength) || !Number.isFinite(seconds)) return false;
    const capped = Math.min(IMPULSE_MAX_STRENGTH, strength);
    if (capped < this.level) return false;
    this.peak = capped; this.duration = Math.min(IMPULSE_MAX_SECONDS, seconds); this.elapsed = 0;
    return true;
  }

  advance(deltaSeconds: number): void { if (this.active) this.elapsed += Math.max(0, deltaSeconds); }
  clear(): void { this.peak = 0; this.duration = 0; this.elapsed = 0; }
  get active(): boolean { return this.peak > 0 && this.elapsed < this.duration; }
  /** Current strength 0..1 (quadratic decay). */
  get level(): number { return this.active ? this.peak * (1 - this.elapsed / this.duration) ** 2 : 0; }
}

const IMPULSE_VERTEX = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// Radial blur toward the screen centre, a subtle chromatic split growing with radius, and a brief exposure
// lift; every texel read is sanitized like the bloom and output reads.
const IMPULSE_FRAGMENT = /* glsl */`
uniform sampler2D tDiffuse;
uniform float uStrength;
varying vec2 vUv;
${SANITIZE}
vec3 wcRead(vec2 uv) { return wcSanitize(texture2D(tDiffuse, clamp(uv, vec2(0.001), vec2(0.999)))).rgb; }
void main() {
  vec2 d = vUv - 0.5;
  float s = clamp(uStrength, 0.0, 1.0);
  vec2 stride = d * (0.05 * s);
  vec2 split = d * (0.014 * s);
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 6; i++) {
    vec2 uv = vUv - stride * (float(i) / 5.0);
    sum += vec3(wcRead(uv - split).r, wcRead(uv).g, wcRead(uv + split).b);
  }
  gl_FragColor = vec4(sum / 6.0 * (1.0 + 0.2 * s), 1.0);
}`;

/**
 * HDR pipeline: RenderPass into a half-float MSAA target → UnrealBloomPass (internally starts
 * at half resolution) → impact impulse pass (disabled, and therefore skipped, unless an impulse is live)
 * → OutputPass (ACES Filmic tone mapping + sRGB). Every consumer of the scene buffer sanitizes each texel,
 * so a single non-finite or runaway pixel can neither spread through the bloom mips nor black out the frame.
 */
export class PostFX {
  readonly composer: EffectComposer;
  private readonly renderPass: RenderPass;
  private readonly bloom: UnrealBloomPass;
  private readonly output: OutputPass;
  private readonly impulsePass: ShaderPass;
  private readonly lightShaftsPass: ShaderPass;
  private readonly gradePass: ShaderPass;
  private readonly heightFogPass: ShaderPass;
  private readonly impulse = new ImpulseEnvelope();
  private readonly warmScene = new ThreeScene();
  private readonly warmMesh: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly warmViewport = new Vector4();
  private readonly warmScissor = new Vector4();
  private readonly pixelRatioCap: number;
  private readonly bloomStrength: number;
  private lastRenderMs = 0;
  private reduced = false;
  /** When false, the screen impulse (radial blur / chromatic split) is disabled at the source even if reduced motion is off. */
  private motionBlur = true;
  private disposed = false;

  constructor(private readonly renderer: WebGLRenderer, scene: Scene, camera: Camera, options: PostFXOptions = {}) {
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = options.exposure ?? 1;
    renderer.outputColorSpace = SRGBColorSpace;
    this.pixelRatioCap = options.pixelRatioCap ?? 1;
    this.bloomStrength = options.bloomStrength ?? 0.7;
    const samples = renderer.capabilities.isWebGL2 ? Math.min(options.msaaSamples ?? 2, renderer.capabilities.maxSamples) : 0;
    const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples });
    target.texture.name = 'postfx-hdr';
    this.composer = new EffectComposer(renderer, target);
    this.renderPass = new RenderPass(scene, camera);
    this.bloom = new UnrealBloomPass(new Vector2(1, 1), this.bloomStrength, options.bloomRadius ?? 0.45, options.bloomThreshold ?? 1);
    sanitizeRead(this.bloom.materialHighPassFilter, 'texture2D( tDiffuse, vUv )');
    this.output = new OutputPass();
    sanitizeRead(this.output.material, 'texture2D( tDiffuse, vUv )');
    this.output.needsSwap = false;
    this.composer.addPass(this.renderPass);
    const impulseMaterial = new ShaderMaterial({ name: 'postfx-impulse', vertexShader: IMPULSE_VERTEX, fragmentShader: IMPULSE_FRAGMENT, uniforms: { tDiffuse: { value: null }, uStrength: { value: 0 } } });
    this.impulsePass = new ShaderPass(impulseMaterial);
    this.impulsePass.enabled = false;
    this.warmMesh = new Mesh(new PlaneGeometry(2, 2), impulseMaterial);
    this.warmMesh.frustumCulled = false;
    this.warmScene.add(this.warmMesh);
    this.composer.addPass(this.bloom);
    // Screen-space height-fog pass: density grows toward the bottom of the frame and damps when the camera sits above the focus.
    const fogMaterial = new ShaderMaterial({
      name: 'postfx-height-fog',
      vertexShader: HEIGHT_FOG_VERTEX,
      fragmentShader: HEIGHT_FOG_FRAGMENT,
      uniforms: {
        tDiffuse: { value: null },
        uColor: { value: IDENTITY_HEIGHT_FOG.color.clone() },
        uDensity: { value: IDENTITY_HEIGHT_FOG.density },
        uFalloff: { value: IDENTITY_HEIGHT_FOG.falloff },
        uSunMix: { value: IDENTITY_HEIGHT_FOG.sunMix },
        uSunTintColor: { value: IDENTITY_HEIGHT_FOG.sunTintColor.clone() },
        uCameraY: { value: 0 },
        uTargetY: { value: 0 },
        uGroundBias: { value: IDENTITY_HEIGHT_FOG.groundBias },
        uNearFloor: { value: IDENTITY_HEIGHT_FOG.nearFloor },
      },
    });
    sanitizeRead(fogMaterial, 'texture2D(tDiffuse, vUv)');
    this.heightFogPass = new ShaderPass(fogMaterial);
    this.composer.addPass(this.heightFogPass);
    // Screen-space god rays: cheap radial-blur pass after bloom (which provides the bright sun pixels).
    const shaftsMaterial = new ShaderMaterial({
      name: 'postfx-light-shafts',
      vertexShader: LIGHT_SHAFTS_VERTEX,
      fragmentShader: LIGHT_SHAFTS_FRAGMENT,
      uniforms: {
        tDiffuse: { value: null },
        uSunScreen: { value: new Vector2(2, 2) },
        uSunColor: { value: new Vector3(1, 0.85, 0.55) },
        uStrength: { value: DEFAULT_LIGHT_SHAFTS.strength },
        uThreshold: { value: DEFAULT_LIGHT_SHAFTS.threshold },
        uDecay: { value: DEFAULT_LIGHT_SHAFTS.decay },
        uDensity: { value: DEFAULT_LIGHT_SHAFTS.density },
        uWeight: { value: DEFAULT_LIGHT_SHAFTS.weight },
      },
    });
    sanitizeRead(shaftsMaterial, 'texture2D(tDiffuse, vUv)');
    sanitizeRead(shaftsMaterial, 'texture2D(tDiffuse, coord)');
    this.lightShaftsPass = new ShaderPass(shaftsMaterial);
    this.lightShaftsPass.enabled = false;
    this.composer.addPass(this.lightShaftsPass);
    this.composer.addPass(this.impulsePass);
    // Final colour grade: identity defaults; per-region settings are pushed in via setRegionGrade.
    const neutralGrade = neutralGradeSettings();
    const gradeMaterial = new ShaderMaterial({
      name: 'postfx-color-grade',
      vertexShader: COLOR_GRADE_VERTEX,
      fragmentShader: COLOR_GRADE_FRAGMENT,
      uniforms: {
        tDiffuse: { value: null },
        uLift: { value: neutralGrade.lift },
        uGamma: { value: neutralGrade.gamma },
        uGain: { value: neutralGrade.gain },
        uSaturation: { value: neutralGrade.saturation },
        uWarmHighlight: { value: neutralGrade.warmHighlight },
        uCoolShadow: { value: neutralGrade.coolShadow },
        uVignette: { value: neutralGrade.vignette },
        uExposure: { value: neutralGrade.exposure },
      },
    });
    sanitizeRead(gradeMaterial, 'texture2D(tDiffuse, vUv)');
    this.gradePass = new ShaderPass(gradeMaterial);
    this.composer.addPass(this.gradePass);
    this.composer.addPass(this.output);
  }

  /** CSS-pixel size; the HDR chain runs at min(devicePixelRatio, cap). */
  setSize(width: number, height: number, devicePixelRatio: number): void {
    if (this.disposed) return;
    const ratio = Math.min(devicePixelRatio || 1, this.pixelRatioCap);
    this.renderer.setPixelRatio(ratio);
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(Math.max(1, width), Math.max(1, height));
  }

  /** Reduced effects keeps tone mapping identical but softens bloom so flashes never strobe. */
  setReducedEffects(reduced: boolean): void {
    this.reduced = reduced;
    this.bloom.strength = reduced ? this.bloomStrength * 0.45 : this.bloomStrength;
    if (reduced) {
      this.impulse.clear();
      this.impulsePass.enabled = false;
      // God rays are skipped under reduced effects; the rest of the chain (grade, bloom, output) keeps running cheaply.
      this.lightShaftsPass.enabled = false;
    }
  }

  /**
   * Routes the in-game motion-blur accessibility setting: when off, the screen impulse (the existing radial-blur
   * / chromatic-split / exposure-lift pass) is suppressed at its source. Reduced motion takes precedence — `false`
   * here just disables motion-blur cues from the impulse; the impact-exposure feedback on a confirmed contact can
   * still play (it survives within reason, see `IMPULSE_MAX_SECONDS`). Does not compile or rebuild any shader.
   */
  setMotionBlur(enabled: boolean): void {
    this.motionBlur = enabled;
    if (!enabled) { this.impulse.clear(); this.impulsePass.enabled = false; }
  }

  /**
   * Brief full-screen impact punch (radial blur toward the centre, subtle chromatic split, exposure lift).
   * `strength` is capped at 1 and `seconds` at 0.6; overlapping calls keep the stronger remaining level. Ignored
   * in reduced-effects mode or when the motion-blur setting is off. The pass stays disabled (zero cost) whenever
   * no impulse is live.
   */
  addImpulse(strength: number, seconds: number): void {
    if (this.disposed || this.reduced || !this.motionBlur) return;
    if (this.impulse.add(strength, seconds)) this.impulsePass.enabled = true;
  }

  get reducedEffects(): boolean { return this.reduced; }
  /** True while motion-blur cues (screen impulse, pose-afterimage trails) are enabled. */
  get motionBlurEnabled(): boolean { return this.motionBlur; }

  /** `deltaSeconds` of 0 means "measure it": the impulse envelope ages on real time, not the (hit-stopped) world clock. */
  render(deltaSeconds: number): void {
    if (this.disposed) return;
    const now = performance.now(), elapsed = this.lastRenderMs > 0 ? Math.min(0.1, Math.max(0, (now - this.lastRenderMs) / 1000)) : 0;
    this.lastRenderMs = now;
    if (this.impulse.active) {
      this.impulse.advance(deltaSeconds > 0 ? deltaSeconds : elapsed);
      this.impulsePass.uniforms.uStrength!.value = this.impulse.level;
    }
    this.impulsePass.enabled = this.impulse.active;
    this.composer.render(deltaSeconds);
  }

  /**
   * Update the per-region screen-space light-shafts uniforms. Pass `strength <= 0` (or the reduced-effects setting is
   * already off) to disable the pass without rebuilding any shader. The pass is auto-enabled when `strength > 0` and the
   * reduced-effects mode is off.
   */
  setRegionShafts(settings: Partial<{ strength: number; sunScreen: Vector2; sunColor: Vector3; threshold: number; decay: number; density: number; weight: number }> = {}): void {
    if (this.disposed) return;
    const u = this.lightShaftsPass.uniforms;
    if (settings.strength !== undefined) u.uStrength!.value = settings.strength;
    if (settings.sunScreen) u.uSunScreen!.value.copy(settings.sunScreen);
    if (settings.sunColor) u.uSunColor!.value.copy(settings.sunColor);
    if (settings.threshold !== undefined) u.uThreshold!.value = settings.threshold;
    if (settings.decay !== undefined) u.uDecay!.value = settings.decay;
    if (settings.density !== undefined) u.uDensity!.value = settings.density;
    if (settings.weight !== undefined) u.uWeight!.value = settings.weight;
    const strength = u.uStrength!.value as number;
    this.lightShaftsPass.enabled = !this.reduced && strength > 0;
  }

  /** Push the per-region color grade into the grade pass uniforms. Defaults to identity (the constructor baseline). */
  setRegionGrade(settings: Partial<ColorGradeSettings> = {}): void {
    if (this.disposed) return;
    const u = this.gradePass.uniforms;
    if (settings.lift) u.uLift!.value.copy(settings.lift);
    if (settings.gamma) u.uGamma!.value.copy(settings.gamma);
    if (settings.gain) u.uGain!.value.copy(settings.gain);
    if (settings.saturation !== undefined) u.uSaturation!.value = settings.saturation;
    if (settings.warmHighlight) u.uWarmHighlight!.value.copy(settings.warmHighlight);
    if (settings.coolShadow) u.uCoolShadow!.value.copy(settings.coolShadow);
    if (settings.vignette !== undefined) u.uVignette!.value = settings.vignette;
    if (settings.exposure !== undefined) u.uExposure!.value = settings.exposure;
  }

  /** Push the per-region height-fog values into the height-fog pass uniforms. Caller updates `cameraY`/`targetY` per frame. */
  setRegionHeightFog(settings: Partial<HeightFogSettings> = {}): void {
    if (this.disposed) return;
    const u = this.heightFogPass.uniforms;
    if (settings.color) u.uColor!.value.copy(settings.color);
    if (settings.density !== undefined) u.uDensity!.value = settings.density;
    if (settings.falloff !== undefined) u.uFalloff!.value = settings.falloff;
    if (settings.sunMix !== undefined) u.uSunMix!.value = settings.sunMix;
    if (settings.sunTintColor) u.uSunTintColor!.value.copy(settings.sunTintColor);
    if (settings.cameraY !== undefined) u.uCameraY!.value = settings.cameraY;
    if (settings.targetY !== undefined) u.uTargetY!.value = settings.targetY;
    if (settings.groundBias !== undefined) u.uGroundBias!.value = settings.groundBias;
    if (settings.nearFloor !== undefined) u.uNearFloor!.value = settings.nearFloor;
  }

  /** True while the shafts pass is currently active (reduced off + strength > 0). Test seams. */
  get lightShaftsActive(): boolean { return !this.disposed && this.lightShaftsPass.enabled; }
  get gradeActive(): boolean { return !this.disposed; }

  /** Compile scene programs for the HDR target (tone mapping is applied only by the output pass). */
  compile(scene: Scene, camera: Camera): void {
    if (this.disposed) return;
    const previous = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.composer.readBuffer);
    try { this.renderer.compile(scene, camera); this.renderer.compile(this.warmScene, camera); } finally { this.renderer.setRenderTarget(previous); }
  }

  /** One-pixel HDR draws use the real target format/MSAA. Drain them before exposing gameplay, never inside the frame loop. */
  warmGpu(scene: Scene, camera: Camera): void {
    if (this.disposed) return;
    const previous = this.renderer.getRenderTarget(), target = this.composer.readBuffer, scissorTest = target.scissorTest;
    this.warmViewport.copy(target.viewport);
    this.warmScissor.copy(target.scissor);
    try {
      // Shadow rendering restores the target, so its own viewport/scissor must also stay one pixel.
      target.viewport.set(0, 0, 1, 1);
      target.scissor.set(0, 0, 1, 1);
      target.scissorTest = true;
      this.renderer.setRenderTarget(target);
      this.renderer.render(scene, camera);
      this.renderer.render(this.warmScene, camera);
      this.renderer.getContext().finish();
    } finally {
      target.viewport.copy(this.warmViewport);
      target.scissor.copy(this.warmScissor);
      target.scissorTest = scissorTest;
      this.renderer.setRenderTarget(previous);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderPass.dispose();
    this.bloom.dispose();
    this.impulsePass.dispose();
    this.lightShaftsPass.dispose();
    this.gradePass.dispose();
    this.heightFogPass.dispose();
    this.warmMesh.geometry.dispose();
    this.output.dispose();
    this.composer.dispose();
  }
}
