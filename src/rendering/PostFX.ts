import { ACESFilmicToneMapping, HalfFloatType, Mesh, PlaneGeometry, SRGBColorSpace, Scene as ThreeScene, ShaderMaterial, Vector2, WebGLRenderTarget, type Camera, type Scene, type WebGLRenderer } from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

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
  material.fragmentShader = source.slice(0, main) + SANITIZE + source.slice(main).replace(read, `wcSanitize(${read})`);
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
  private readonly impulse = new ImpulseEnvelope();
  private readonly warmScene = new ThreeScene();
  private readonly warmMesh: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly pixelRatioCap: number;
  private readonly bloomStrength: number;
  private lastRenderMs = 0;
  private reduced = false;
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
    this.warmScene.add(this.warmMesh);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.impulsePass);
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
    if (reduced) { this.impulse.clear(); this.impulsePass.enabled = false; }
  }

  /**
   * Brief full-screen impact punch (radial blur toward the centre, subtle chromatic split, exposure lift).
   * `strength` is capped at 1 and `seconds` at 0.6; overlapping calls keep the stronger remaining level. Ignored
   * in reduced-effects mode. The pass stays disabled (zero cost) whenever no impulse is live.
   */
  addImpulse(strength: number, seconds: number): void {
    if (this.disposed || this.reduced) return;
    if (this.impulse.add(strength, seconds)) this.impulsePass.enabled = true;
  }

  get reducedEffects(): boolean { return this.reduced; }

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

  /** Compile scene programs for the HDR target (tone mapping is applied only by the output pass). */
  compile(scene: Scene, camera: Camera): void {
    if (this.disposed) return;
    const previous = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.composer.readBuffer);
    try { this.renderer.compile(scene, camera); this.renderer.compile(this.warmScene, camera); } finally { this.renderer.setRenderTarget(previous); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderPass.dispose();
    this.bloom.dispose();
    this.impulsePass.dispose();
    this.warmMesh.geometry.dispose();
    this.output.dispose();
    this.composer.dispose();
  }
}
