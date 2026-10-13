import { AdditiveBlending, BufferAttribute, BufferGeometry, DynamicDrawUsage, Mesh, ShaderMaterial, Vector3 } from 'three';
import { capHdr } from './palette.js';

const VERTEX = /* glsl */`
attribute vec4 aCore;
attribute vec3 aGlow;
varying vec2 vUv;
varying vec4 vCore;
varying vec3 vGlow;
void main() { vUv = uv; vCore = aCore; vGlow = aGlow; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// uv.y runs -1..1 across the strip: a razor-thin HDR core plus a soft saturated glow; colours are
// pre-capped on the CPU (palette rule) and clamped again here.
const FRAGMENT = /* glsl */`
varying vec2 vUv;
varying vec4 vCore;
varying vec3 vGlow;
void main() {
  float d = abs(vUv.y);
  float core = exp(-d * d * 30.0);
  float glow = exp(-d * d * 4.2) * (1.0 - smoothstep(0.82, 1.0, d));
  vec3 color = vCore.rgb * core + vGlow * glow;
  float alpha = clamp(vCore.a, 0.0, 1.0);
  if (alpha < 0.003) discard;
  gl_FragColor = vec4(clamp(color, vec3(0.0), vec3(4.0)), alpha);
}`;

/** Per-polyline look. `width` is the full strip width (metres); `taper` 0..1 narrows it towards the far end. */
export class LineStyle {
  width = 0.1; taper = 0;
  /** Core colour (thin, bright) and glow colour (wide, saturated), linear HDR. */
  cr = 1; cg = 1; cb = 1; gr = 0; gg = 0; gb = 0;
  /** Opacity at the first and last point. */
  alpha0 = 1; alpha1 = 1;
  reset(): this { this.width = 0.1; this.taper = 0; this.cr = this.cg = this.cb = 1; this.gr = this.gg = this.gb = 0; this.alpha0 = this.alpha1 = 1; return this; }
}

/**
 * Immediate-mode camera-facing polyline renderer: callers `begin()`, `add()` every live polyline each
 * frame and `end()`. One draw call for every bolt, arc and ribbon; capacity is a hard cap (extra lines
 * are dropped, never reallocated).
 */
export class LineBatch {
  readonly mesh: Mesh<BufferGeometry, ShaderMaterial>;
  readonly style = new LineStyle();
  readonly capacityPoints: number;
  private readonly positions: Float32Array;
  private readonly uvs: Float32Array;
  private readonly core: Float32Array;
  private readonly glow: Float32Array;
  private readonly indices: Uint16Array;
  private readonly attributes: BufferAttribute[] = [];
  private readonly indexAttribute: BufferAttribute;
  private readonly camera = new Vector3(10, 12, 14);
  private readonly tangent = new Vector3();
  private readonly side = new Vector3();
  private readonly view = new Vector3();
  private readonly colorScratch: number[] = [0, 0, 0];
  private points = 0;
  private indexCount = 0;

  constructor(capacityPoints = 640) {
    this.capacityPoints = capacityPoints;
    this.positions = new Float32Array(capacityPoints * 2 * 3);
    this.uvs = new Float32Array(capacityPoints * 2 * 2);
    this.core = new Float32Array(capacityPoints * 2 * 4);
    this.glow = new Float32Array(capacityPoints * 2 * 3);
    this.indices = new Uint16Array(capacityPoints * 6);
    const geometry = new BufferGeometry();
    const attribute = (name: string, array: Float32Array, size: number): void => {
      const value = new BufferAttribute(array, size).setUsage(DynamicDrawUsage);
      geometry.setAttribute(name, value);
      this.attributes.push(value);
    };
    attribute('position', this.positions, 3); attribute('uv', this.uvs, 2); attribute('aCore', this.core, 4); attribute('aGlow', this.glow, 3);
    this.indexAttribute = new BufferAttribute(this.indices, 1).setUsage(DynamicDrawUsage);
    geometry.setIndex(this.indexAttribute);
    geometry.setDrawRange(0, 0);
    const material = new ShaderMaterial({ name: 'vfx-line-batch', vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthWrite: false, blending: AdditiveBlending });
    this.mesh = new Mesh(geometry, material);
    this.mesh.name = 'vfx-line-batch'; this.mesh.frustumCulled = false; this.mesh.visible = false; this.mesh.renderOrder = 16;
  }

  begin(camera: Vector3): void { this.camera.copy(camera); this.points = 0; this.indexCount = 0; this.style.reset(); }

  /** Strip through `count` (x, y, z) triples. Returns false when the polyline was rejected (non-finite or out of capacity). */
  add(points: ArrayLike<number>, count: number): boolean {
    if (count < 2 || this.points + count > this.capacityPoints) return false;
    for (let i = 0; i < count * 3; i++) if (!Number.isFinite(points[i])) return false;
    const style = this.style, base = this.points;
    for (let i = 0; i < count; i++) {
      const x = points[i * 3]!, y = points[i * 3 + 1]!, z = points[i * 3 + 2]!;
      const prev = Math.max(0, i - 1) * 3, next = Math.min(count - 1, i + 1) * 3;
      this.tangent.set(points[next]! - points[prev]!, points[next + 1]! - points[prev + 1]!, points[next + 2]! - points[prev + 2]!);
      this.view.set(this.camera.x - x, this.camera.y - y, this.camera.z - z);
      this.side.crossVectors(this.tangent, this.view);
      const length = this.side.length();
      if (length < 1e-6) this.side.set(1, 0, 0); else this.side.multiplyScalar(1 / length);
      const u = count > 1 ? i / (count - 1) : 0, half = 0.5 * style.width * Math.max(0.08, 1 - style.taper * u), alpha = style.alpha0 + (style.alpha1 - style.alpha0) * u;
      const v = (base + i) * 2;
      const p = v * 3, t = v * 2, sx = this.side.x * half, sy = this.side.y * half, sz = this.side.z * half;
      this.positions[p] = x - sx; this.positions[p + 1] = y - sy; this.positions[p + 2] = z - sz;
      this.positions[p + 3] = x + sx; this.positions[p + 4] = y + sy; this.positions[p + 5] = z + sz;
      this.uvs[t] = u; this.uvs[t + 1] = -1; this.uvs[t + 2] = u; this.uvs[t + 3] = 1;
      this.colorScratch[0] = style.cr; this.colorScratch[1] = style.cg; this.colorScratch[2] = style.cb; capHdr(this.colorScratch);
      const cr = this.colorScratch[0]!, cg = this.colorScratch[1]!, cb = this.colorScratch[2]!;
      this.colorScratch[0] = style.gr; this.colorScratch[1] = style.gg; this.colorScratch[2] = style.gb; capHdr(this.colorScratch);
      for (let side = 0; side < 2; side++) {
        const o = (v + side) * 4, g = (v + side) * 3;
        this.core[o] = cr; this.core[o + 1] = cg; this.core[o + 2] = cb; this.core[o + 3] = alpha;
        this.glow[g] = this.colorScratch[0]!; this.glow[g + 1] = this.colorScratch[1]!; this.glow[g + 2] = this.colorScratch[2]!;
      }
      if (i < count - 1) {
        const a = base * 2 + i * 2, o = this.indexCount;
        this.indices[o] = a; this.indices[o + 1] = a + 1; this.indices[o + 2] = a + 2; this.indices[o + 3] = a + 1; this.indices[o + 4] = a + 3; this.indices[o + 5] = a + 2;
        this.indexCount += 6;
      }
    }
    this.points += count;
    return true;
  }

  /** Uploads the touched range and hides the mesh when nothing was added. */
  end(): void {
    const verts = this.points * 2;
    this.mesh.visible = this.indexCount > 0;
    this.mesh.geometry.setDrawRange(0, this.indexCount);
    if (verts === 0) return;
    for (const attribute of this.attributes) { attribute.clearUpdateRanges(); attribute.addUpdateRange(0, verts * attribute.itemSize); attribute.needsUpdate = true; }
    this.indexAttribute.clearUpdateRanges(); this.indexAttribute.addUpdateRange(0, this.indexCount); this.indexAttribute.needsUpdate = true;
  }

  get usedPoints(): number { return this.points; }
  get usedIndices(): number { return this.indexCount; }
  dispose(): void { this.mesh.removeFromParent(); this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}
