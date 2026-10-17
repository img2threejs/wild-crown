import { DoubleSide, DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, MathUtils, Matrix4, Mesh, PlaneGeometry, Quaternion, ShaderMaterial, SkinnedMesh, Vector3, type Object3D } from 'three';

/** Body footprint in actor space (+Z forward): centre offset and half extents of the part of the body near the ground. */
export interface ContactFootprint { readonly cx: number; readonly cz: number; readonly rx: number; readonly rz: number }
/** Clearance range (m) over which a shadow fades from full to nothing as its actor rises above the ground. */
export interface ContactFade { readonly start: number; readonly end: number }

/** Darkest the shadow gets where it is densest; it is ambient occlusion, not a cast shadow. */
export const CONTACT_SHADOW_PEAK = 0.42;
export const CONTACT_SHADOW_CAPACITY = 64;
/** Walkers fade across a jump; hovering flyers only keep one while they settle onto the ground. */
export const GROUNDED_FADE: ContactFade = { start: 0.03, end: 0.8 };
export const HOVER_FADE: ContactFade = { start: 0.02, end: 0.25 };
/** Quad half extent as a multiple of the footprint radius: the soft falloff reaches out to here. */
const EXTENT = 1.5;
const MIN_RADIUS = 0.18;
const MAX_RADIUS = 3;
/** Only vertices in the lowest share of the body height count, so spread arms or a raised weapon never widen the shadow. */
const LOW_BAND = 0.5;
const MAX_SAMPLES = 4096;
/** Lift along the ground normal (m) that keeps the quad above terrain within the walk-surface tolerance; polygonOffset covers the rest. */
const LIFT = 0.02;
const MAX_TILT = 35 * Math.PI / 180;

const UP = new Vector3(0, 1, 0);
const yawQ = new Quaternion(), tiltQ = new Quaternion(), orientQ = new Quaternion();
const positionV = new Vector3(), offsetV = new Vector3(), scaleV = new Vector3(), normalV = new Vector3(), pointV = new Vector3();
const matrix = new Matrix4();

const VERTEX = `attribute float aOpacity;
varying vec2 vUv;
varying float vOpacity;
void main() {
  vUv = uv;
  vOpacity = aOpacity;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;
const FRAGMENT = `uniform float uPeak;
uniform vec3 uColor;
varying vec2 vUv;
varying float vOpacity;
void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float f = max(1.0 - dot(p, p), 0.0);
  float a = f * f * uPeak * vOpacity;
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor, a);
}`;

/** Share of the lowest-band vertices trimmed from each end of both axes. */
const TRIM = 0.04;

/**
 * Footprint of a loaded actor from its bind-pose vertices (a sampled subset, measured once per instance, never per frame): the extent
 * in actor space of the vertices in the lowest half of the body, so legs and hips (or a quadruped's whole trunk) size the shadow. Skinned
 * body meshes only when the rig has any (a scabbard or prop hanging on a bone is not the body); the outermost few percent of vertices
 * are trimmed so a stray strap or tail tip never stretches the shadow.
 */
export function measureFootprint(root: Object3D): ContactFootprint | null {
  root.updateWorldMatrix(true, true);
  const inverse = new Matrix4().copy(root.matrixWorld).invert();
  const meshes: { geometry: Mesh['geometry']; matrix: Matrix4; step: number; skinned: boolean }[] = [];
  root.traverse(node => {
    if (!(node instanceof Mesh)) return;
    const position = node.geometry.getAttribute('position');
    if (position) meshes.push({ geometry: node.geometry, matrix: new Matrix4().multiplyMatrices(inverse, node.matrixWorld), step: Math.max(1, Math.floor(position.count / MAX_SAMPLES)), skinned: node instanceof SkinnedMesh });
  });
  const bodies = meshes.some(entry => entry.skinned) ? meshes.filter(entry => entry.skinned) : meshes;
  let minY = Infinity, maxY = -Infinity;
  for (const { geometry, matrix: transform, step } of bodies) {
    const position = geometry.getAttribute('position');
    for (let i = 0; i < position.count; i += step) { const y = pointV.fromBufferAttribute(position, i).applyMatrix4(transform).y; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  if (!(maxY >= minY)) return null;
  const limit = minY + (maxY - minY) * LOW_BAND;
  const xs: number[] = [], zs: number[] = [];
  for (const { geometry, matrix: transform, step } of bodies) {
    const position = geometry.getAttribute('position');
    for (let i = 0; i < position.count; i += step) {
      pointV.fromBufferAttribute(position, i).applyMatrix4(transform);
      if (pointV.y <= limit) { xs.push(pointV.x); zs.push(pointV.z); }
    }
  }
  if (xs.length === 0) return null;
  xs.sort((a, b) => a - b); zs.sort((a, b) => a - b);
  const last = xs.length - 1, low = Math.floor(TRIM * last), high = Math.ceil((1 - TRIM) * last);
  const clampRadius = (value: number) => MathUtils.clamp(value, MIN_RADIUS, MAX_RADIUS);
  return { cx: (xs[low]! + xs[high]!) / 2, cz: (zs[low]! + zs[high]!) / 2, rx: clampRadius((xs[high]! - xs[low]!) / 2), rz: clampRadius((zs[high]! - zs[low]!) / 2) };
}

/** Full size (m) of the shadow quad for a footprint at the given actor scale. */
export function contactShadowSize(footprint: ContactFootprint, scale = 1, out: { x: number; z: number } = { x: 0, z: 0 }): { x: number; z: number } {
  out.x = footprint.rx * EXTENT * 2 * scale;
  out.z = footprint.rz * EXTENT * 2 * scale;
  return out;
}

/** 1 on the ground, easing to 0 across `fade`: the share of the shadow still shown at this height above it. */
export function contactShadowOpacity(clearance: number, fade: ContactFade): number {
  const t = MathUtils.clamp((clearance - fade.start) / (fade.end - fade.start), 0, 1);
  return 1 - t * t * (3 - 2 * t);
}

/** Soft ground-contact occlusion under every grounded actor: one instanced draw call over a fixed pool, no texture reads. */
export class ContactShadows {
  readonly mesh: InstancedMesh;
  private readonly opacity: InstancedBufferAttribute;
  private readonly geometry: PlaneGeometry;
  private readonly material: ShaderMaterial;
  private used = 0;
  private readonly size = { x: 0, z: 0 };

  constructor(readonly capacity = CONTACT_SHADOW_CAPACITY) {
    this.geometry = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.opacity = new InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('aOpacity', this.opacity);
    this.material = new ShaderMaterial({
      name: 'contact-shadow', vertexShader: VERTEX, fragmentShader: FRAGMENT,
      uniforms: { uPeak: { value: CONTACT_SHADOW_PEAK }, uColor: { value: new Vector3(0.02, 0.016, 0.012) } },
      transparent: true, depthWrite: false, side: DoubleSide, toneMapped: false, fog: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    });
    this.mesh = new InstancedMesh(this.geometry, this.material, capacity);
    this.mesh.name = 'contact-shadows';
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    // After water, before transparent props: a shadow is hidden by water above it and by trunks or decks in front of it.
    this.mesh.renderOrder = -0.5;
    this.mesh.count = 0;
  }

  get count(): number { return this.used; }

  begin(): void { this.used = 0; }

  /**
   * Queues one shadow centred on the ground point (x, y, z): `yaw` is the actor heading, (nx, ny, nz) the unit ground normal, `scale`
   * the actor's uniform scale and `opacity` its 0..1 height fade. Returns false when invisible or the pool is full.
   */
  add(footprint: ContactFootprint, x: number, y: number, z: number, yaw: number, nx: number, ny: number, nz: number, scale: number, opacity: number): boolean {
    if (this.used >= this.capacity || !(opacity > 0.003)) return false;
    yawQ.setFromAxisAngle(UP, yaw);
    normalV.set(nx, ny, nz);
    tiltQ.setFromUnitVectors(UP, normalV);
    const angle = 2 * Math.acos(MathUtils.clamp(tiltQ.w, -1, 1));
    if (angle > MAX_TILT) tiltQ.slerp(orientQ.identity(), 1 - MAX_TILT / angle);
    orientQ.multiplyQuaternions(tiltQ, yawQ);
    offsetV.set(footprint.cx * scale, LIFT, footprint.cz * scale).applyQuaternion(orientQ);
    positionV.set(x, y, z).add(offsetV);
    contactShadowSize(footprint, scale, this.size);
    matrix.compose(positionV, orientQ, scaleV.set(this.size.x, 1, this.size.z));
    this.mesh.setMatrixAt(this.used, matrix);
    this.opacity.setX(this.used, opacity);
    this.used += 1;
    return true;
  }

  end(): void {
    this.mesh.count = this.used;
    if (this.used === 0) return;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.opacity.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
