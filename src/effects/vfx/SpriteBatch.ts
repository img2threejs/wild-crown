import { AdditiveBlending, BufferAttribute, DynamicDrawUsage, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, ShaderMaterial, type Texture } from 'three';
import { ATLAS_COLUMNS, ATLAS_ROWS } from './VfxAtlas.js';
import { capHdr } from './palette.js';

const VERTEX = /* glsl */`
attribute vec3 iPos;
attribute vec3 iDir;
attribute vec4 iSize;
attribute vec4 iColor;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  vec2 corner = position.xy * 2.0;
  vec2 dir = (modelViewMatrix * vec4(iDir, 0.0)).xy;
  float len = length(dir);
  dir = len > 1e-5 ? dir / len : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);
  mv.xy += dir * corner.x * iSize.x + perp * corner.y * iSize.y;
  gl_Position = projectionMatrix * mv;
  float frame = iSize.z;
  vec2 cell = vec2(mod(frame, ${ATLAS_COLUMNS}.0), floor(frame / ${ATLAS_COLUMNS}.0));
  vUv = (cell + uv) / vec2(${ATLAS_COLUMNS}.0, ${ATLAS_ROWS}.0);
  vColor = iColor;
}`;

const FRAGMENT = /* glsl */`
uniform sampler2D uAtlas;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vec4 tex = texture2D(uAtlas, vUv);
  float alpha = vColor.a * tex.a;
  if (alpha < 0.002) discard;
  gl_FragColor = vec4(clamp(vColor.rgb * tex.rgb, vec3(0.0), vec3(4.0)), clamp(alpha, 0.0, 1.0));
}`;

/**
 * Immediate-mode additive billboards (projectile cores and glows, flares): the caller adds every live
 * sprite each frame. A non-zero direction stretches the quad along its screen projection (`halfLength`
 * along it, `halfWidth` across); a zero direction is a plain screen-aligned sprite.
 */
export class SpriteBatch {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  readonly capacity: number;
  private readonly geometry = new InstancedBufferGeometry();
  private readonly position: Float32Array;
  private readonly direction: Float32Array;
  private readonly size: Float32Array;
  private readonly color: Float32Array;
  private readonly attributes: InstancedBufferAttribute[] = [];
  private readonly scratch = [0, 0, 0];
  private count = 0;

  constructor(atlas: Texture, capacity = 64) {
    this.capacity = capacity;
    this.geometry.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    this.geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    this.geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const attribute = (name: string, size: number): Float32Array => {
      const array = new Float32Array(capacity * size), value = new InstancedBufferAttribute(array, size).setUsage(DynamicDrawUsage);
      this.geometry.setAttribute(name, value);
      this.attributes.push(value);
      return array;
    };
    this.position = attribute('iPos', 3); this.direction = attribute('iDir', 3); this.size = attribute('iSize', 4); this.color = attribute('iColor', 4);
    this.geometry.instanceCount = 0;
    const material = new ShaderMaterial({ name: 'vfx-sprite-batch', vertexShader: VERTEX, fragmentShader: FRAGMENT, uniforms: { uAtlas: { value: atlas } }, transparent: true, depthWrite: false, blending: AdditiveBlending });
    this.mesh = new Mesh(this.geometry, material);
    this.mesh.name = 'vfx-sprite-batch'; this.mesh.frustumCulled = false; this.mesh.visible = false; this.mesh.renderOrder = 17;
  }

  begin(): void { this.count = 0; }

  /** Returns false when the sprite was rejected (non-finite value or full batch). */
  add(x: number, y: number, z: number, dx: number, dy: number, dz: number, halfLength: number, halfWidth: number, frame: number, r: number, g: number, b: number, a: number): boolean {
    if (this.count >= this.capacity || !Number.isFinite(x + y + z + dx + dy + dz + halfLength + halfWidth + r + g + b + a)) return false;
    const i = this.count++;
    this.position[i * 3] = x; this.position[i * 3 + 1] = y; this.position[i * 3 + 2] = z;
    this.direction[i * 3] = dx; this.direction[i * 3 + 1] = dy; this.direction[i * 3 + 2] = dz;
    this.size[i * 4] = halfLength; this.size[i * 4 + 1] = halfWidth; this.size[i * 4 + 2] = frame; this.size[i * 4 + 3] = 0;
    this.scratch[0] = Math.max(0, r); this.scratch[1] = Math.max(0, g); this.scratch[2] = Math.max(0, b);
    capHdr(this.scratch);
    this.color[i * 4] = this.scratch[0]!; this.color[i * 4 + 1] = this.scratch[1]!; this.color[i * 4 + 2] = this.scratch[2]!; this.color[i * 4 + 3] = Math.min(1, Math.max(0, a));
    return true;
  }

  end(): void {
    this.geometry.instanceCount = this.count;
    this.mesh.visible = this.count > 0;
    if (this.count === 0) return;
    for (const attribute of this.attributes) { attribute.clearUpdateRanges(); attribute.addUpdateRange(0, this.count * attribute.itemSize); attribute.needsUpdate = true; }
  }

  get used(): number { return this.count; }
  dispose(): void { this.mesh.removeFromParent(); this.geometry.dispose(); this.mesh.material.dispose(); }
}
