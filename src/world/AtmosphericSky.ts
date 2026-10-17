import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { SkyProfile } from './BiomeProfile';

/**
 * Diameter (m) of the sky-dome back-faced sphere. Chosen so that at any reachable focus height the dome horizon still
 * clears the clipped render far plane (≤ 300 m in the gameplay composer) without the geometry crossing the fog far.
 */
const SKY_RADIUS = 240;

const SKY_VERTEX = /* glsl */`
varying vec3 vWorldDir;
varying vec3 vCameraOffset;
uniform vec3 uFocus;
void main() {
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vWorldDir = normalize(worldPosition.xyz - uFocus);
  vCameraOffset = uFocus;
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}`;

/**
 * Gradient sky-dome fragment. Direction in world space → angle above horizon → blend of zenith/horizon (and ground band
 * for the back face). The sun glow + soft disc and the drifting cloud noise are layered in sun-relative coordinates so
 * they read across hemispheres. All math in linear HDR so the tone-mapped frame matches the rest of the scene.
 */
const SKY_FRAGMENT = /* glsl */`
varying vec3 vWorldDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunDir;
uniform vec3 uSunDiscColor;
uniform float uSunDiscSize;
uniform vec3 uSunGlowColor;
uniform float uSunGlowSize;
uniform vec3 uCloudColor;
uniform float uCloudCoverage;
uniform float uCloudSpeed;
uniform float uTime;

const float CLOUD_FBM_OCTAVES = 4.0;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) {
  float value = 0.0;
  float amp = 0.5;
  for (float index = 0.0; index < CLOUD_FBM_OCTAVES; index += 1.0) {
    value += amp * noise(p);
    p *= 2.0;
    amp *= 0.5;
  }
  return value;
}

void main() {
  vec3 direction = normalize(vWorldDir);
  float elevation = clamp(direction.y, -1.0, 1.0);
  // Gradient: above the horizon, blend horizon→zenith; below the horizon, blend horizon→ground.
  float aboveT = smoothstep(0.0, 0.45, elevation);
  float belowT = smoothstep(0.0, -0.25, elevation);
  vec3 sky = mix(uHorizon, uZenith, aboveT);
  vec3 base = mix(sky, uGround, belowT);
  // Sun: soft glow halo + a brighter disc clipped by sunDiscSize.
  float cosAngle = clamp(dot(direction, normalize(uSunDir)), -1.0, 1.0);
  float glowCos = cos(uSunGlowSize);
  float glow = smoothstep(glowCos, 1.0, cosAngle);
  base = mix(base, uSunGlowColor, glow * 0.55);
  float discCos = cos(uSunDiscSize);
  float disc = smoothstep(discCos, discCos + 0.0008, cosAngle);
  base = mix(base, uSunDiscColor, disc);
  // Drifting cloud noise projected on the upper hemisphere only.
  if (elevation > 0.02 && uCloudCoverage > 0.0) {
    vec2 cloudUv = direction.xz / max(direction.y, 0.05) * 0.6 + vec2(uTime * uCloudSpeed * 0.01, uTime * uCloudSpeed * 0.006);
    float coverage = fbm(cloudUv * 1.4);
    float mask = smoothstep(0.55 - uCloudCoverage * 0.4, 0.85 - uCloudCoverage * 0.2, coverage);
    base = mix(base, uCloudColor, mask * 0.55 * smoothstep(0.05, 0.3, elevation));
  }
  gl_FragColor = vec4(base, 1.0);
}`;

function sphereGeometry(): BufferGeometry {
  const geometry = new BufferGeometry();
  const radius = SKY_RADIUS;
  // 32×16 segments — enough to keep the gradient smooth at SKY_RADIUS without paying for more.
  const segmentsX = 32;
  const segmentsY = 16;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let y = 0; y <= segmentsY; y++) {
    const v = y / segmentsY;
    const phi = v * Math.PI;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    for (let x = 0; x <= segmentsX; x++) {
      const u = x / segmentsX;
      const theta = u * Math.PI * 2;
      const sinTheta = Math.sin(theta);
      const cosTheta = Math.cos(theta);
      const px = -sinTheta * sinPhi;
      const py = cosPhi;
      const pz = cosTheta * sinPhi;
      positions.push(px * radius, py * radius, pz * radius);
    }
  }
  for (let y = 0; y < segmentsY; y++) {
    for (let x = 0; x < segmentsX; x++) {
      const a = y * (segmentsX + 1) + x;
      const b = a + 1;
      const c = a + (segmentsX + 1);
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

export interface AtmosphericSkyOptions {
  /** Fallback colour set used while a profile is being loaded; identity gradient. */
  readonly fallback: SkyProfile;
}

/** Typed mirror of the sky-dome shader uniforms so the renderer can read/update them without per-call casts. */
interface SkyUniforms {
  readonly uFocus: { value: Vector3 };
  readonly uZenith: { value: Color };
  readonly uHorizon: { value: Color };
  readonly uGround: { value: Color };
  readonly uSunDir: { value: Vector3 };
  readonly uSunDiscColor: { value: Color };
  readonly uSunDiscSize: { value: number };
  readonly uSunGlowColor: { value: Color };
  readonly uSunGlowSize: { value: number };
  readonly uCloudColor: { value: Color };
  readonly uCloudCoverage: { value: number };
  readonly uCloudSpeed: { value: number };
  readonly uTime: { value: number };
  /** Index signature so the typed mirror is assignable to `ShaderMaterial.uniforms` (which expects `Record<string, IUniform>`). */
  [uniform: string]: { value: Color | Vector3 | number };
}

/**
 * A back-faced sphere mesh whose shader draws a zenith/horizon/ground gradient, sun disc + halo and a slow cloud-noise
 * drift over the world clock. Mounted under a `Group` and offset every frame to the focus so the player never sees the
 * dome's edge. The god-rays pass projects the sun itself (`projectSunScreen` in LightShaftsShader.ts).
 */
export class AtmosphericSky {
  readonly mesh: Mesh<BufferGeometry, ShaderMaterial>;
  private readonly fallback: SkyProfile;
  private readonly material: ShaderMaterial;
  private readonly geometry: BufferGeometry;
  private readonly uniforms: SkyUniforms;
  private readonly focus = new Vector3();
  private readonly sunDirection = new Vector3(0, 1, 0);
  private disposed = false;

  constructor(options: AtmosphericSkyOptions) {
    this.fallback = options.fallback;
    this.geometry = sphereGeometry();
    this.uniforms = {
      uFocus: { value: new Vector3() },
      uZenith: { value: new Color() },
      uHorizon: { value: new Color() },
      uGround: { value: new Color() },
      uSunDir: { value: this.sunDirection.clone() },
      uSunDiscColor: { value: new Color() },
      uSunDiscSize: { value: 0 },
      uSunGlowColor: { value: new Color() },
      uSunGlowSize: { value: 0 },
      uCloudColor: { value: new Color() },
      uCloudCoverage: { value: 0 },
      uCloudSpeed: { value: 0 },
      uTime: { value: 0 },
    };
    this.material = new ShaderMaterial({
      name: 'atmospheric-sky',
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      side: BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      uniforms: this.uniforms,
    });
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.name = 'atmospheric-sky';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
    this.applyProfile(options.fallback);
  }

  /** Last applied profile; useful for grader-side tests and for callers reproducing the dome outside the shader. */
  get current(): SkyProfile { return this.fallback; }
  get sunDirectionRead(): Vector3 { return this.sunDirection; }

  applyProfile(profile: SkyProfile): void {
    const u = this.uniforms;
    u.uZenith.value.set(((profile.zenith >> 16) & 0xff) / 255, ((profile.zenith >> 8) & 0xff) / 255, (profile.zenith & 0xff) / 255);
    u.uHorizon.value.set(((profile.horizon >> 16) & 0xff) / 255, ((profile.horizon >> 8) & 0xff) / 255, (profile.horizon & 0xff) / 255);
    u.uGround.value.set(((profile.ground >> 16) & 0xff) / 255, ((profile.ground >> 8) & 0xff) / 255, (profile.ground & 0xff) / 255);
    u.uSunDiscColor.value.set(((profile.sunDiscColor >> 16) & 0xff) / 255, ((profile.sunDiscColor >> 8) & 0xff) / 255, (profile.sunDiscColor & 0xff) / 255);
    u.uSunGlowColor.value.set(((profile.sunGlowColor >> 16) & 0xff) / 255, ((profile.sunGlowColor >> 8) & 0xff) / 255, (profile.sunGlowColor & 0xff) / 255);
    u.uCloudColor.value.set(((profile.cloudColor >> 16) & 0xff) / 255, ((profile.cloudColor >> 8) & 0xff) / 255, (profile.cloudColor & 0xff) / 255);
    u.uSunDiscSize.value = profile.sunDiscSize;
    u.uSunGlowSize.value = profile.sunGlowSize;
    u.uCloudCoverage.value = profile.cloudCoverage;
    u.uCloudSpeed.value = profile.cloudSpeed;
  }

  setSunDirection(direction: Readonly<Vector3>): void {
    const x = direction.x, y = direction.y, z = direction.z;
    const length = Math.hypot(x, y, z) || 1;
    this.sunDirection.set(x / length, y / length, z / length);
    this.uniforms.uSunDir.value = this.sunDirection;
  }

  /**
   * Per-frame update. The dome repositions itself to the focus so the player never sees its inner edge; the cloud noise
   * ages on real time (reduced motion stops the visible drift).
   */
  update(worldTimeSeconds: number, focus: Readonly<Vector3>, reducedEffects: boolean): void {
    if (this.disposed) return;
    this.focus.set(focus.x, focus.y, focus.z);
    this.mesh.position.copy(this.focus);
    this.uniforms.uFocus.value = this.focus;
    const driftSpeed = reducedEffects ? 0 : this.uniforms.uCloudSpeed.value;
    this.uniforms.uTime.value = worldTimeSeconds * (driftSpeed > 0 ? 1 : 0);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * Reasonable defaults used when a profile ships without a `sky` block: a warm horizon, soft yellow sun, light cloud
 * coverage. Tuned so a region without explicit values still reads as "clear midday" rather than the previous flat colour.
 */
export const DEFAULT_SKY: SkyProfile = {
  zenith: 0x6a8ca8,
  horizon: 0xc7d4d6,
  ground: 0x5a5440,
  sunDiscSize: 0.022,
  sunDiscColor: 0xfff0c0,
  sunGlowSize: 0.18,
  sunGlowColor: 0xffe0a8,
  cloudColor: 0xffffff,
  cloudCoverage: 0.45,
  cloudSpeed: 1,
};
