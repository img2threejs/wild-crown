import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CustomBlending,
  DoubleSide,
  DstColorFactor,
  Group,
  Mesh,
  MeshLambertMaterial,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector2,
  Vector3,
  ZeroFactor,
} from 'three';
import type { FeatureContext, GroundFeature } from './BiomeProfile';
import {
  ARENA_CENTRE, ARENA_WALK_RADIUS, blightAt, blightGrade, planBlight, type BlightPlan, type BranchPlan, type PuddlePlan, type RootPlan, type StonePlan, type VeinPlan,
} from './GroveBlight';
import { mulberry32 } from './GroundNoise';
import { MEMORY_POOL } from './GrovePond';

/**
 * What the Black Sap does to the Grove, as four draw calls: one merged solid mesh of dead trees, dead shrubs, sap-crusted roots and the Memory
 * Pool's ring of ancient standing stones (vertex-coloured, lit and shadowed like the props); one merged ground-decal mesh of sap puddles,
 * running veins and the glowing sap-mud floor of the arena; one multiply wash that grades the ground ochre round the hollow and violet
 * towards the pool; and the Memory Pool's corrupted surface (dark water with the cracked heart-light welling up through it). Presentation
 * only: nothing here is read by the simulation. Reduced effects stills the sap's pulse and the pool's ripples and keeps every shape and colour.
 */

type Field = Pick<FeatureContext['field'], 'sample' | 'walkDistance'>;

/** Collision-free plan-view radius (m) of the authored props at scale 1: the dressing keeps off them. */
const PROP_RADIUS: Readonly<Record<string, number>> = {
  'prop-ancient-canopy-shrine': 6.5, 'prop-root-cavern-mouth': 4.6, 'prop-heartroot-trunk': 3, 'prop-erya-edge-tree': 3.25, 'prop-canopy-cliff-rock': 2.2,
  'prop-mire-bank-rock': 1.8, 'prop-greenwake-boulder-cluster': 1.5, 'prop-canopy-fern-cluster': 1.2, 'prop-training-post': 0.8, 'prop-refuge-shelter': 2.6,
};
const DEFAULT_PROP_RADIUS = 1.4;

/** Extent of the ground wash (m): the hollow, the spur and the arena with the pool. */
const WASH = { minX: -64, maxX: 14, minZ: -138, maxZ: -34, cell: 2 } as const;

// ---------------------------------------------------------------------------------------------------------------------------------------
// Merged solid geometry
// ---------------------------------------------------------------------------------------------------------------------------------------

const scratchA = new Color();
const scratchB = new Color();
const mix = (a: number, b: number, t: number): Color => scratchA.setHex(a).lerp(scratchB.setHex(b), t);

class Mesher {
  readonly positions: number[] = [];
  readonly colors: number[] = [];
  readonly indices: number[] = [];

  vertex(x: number, y: number, z: number, color: Color): number {
    const index = this.positions.length / 3;
    this.positions.push(x, y, z);
    this.colors.push(color.r, color.g, color.b);
    return index;
  }

  /** A tapered tube along `path` (closed to a point at the end), `radius(t)` and `color(t, around)` evaluated per station. */
  tube(path: readonly Vector3[], radius: (t: number) => number, sides: number, color: (t: number, around: number) => Color): void {
    const stations = path.length;
    const first = this.positions.length / 3;
    const tangent = new Vector3(), normal = new Vector3(), binormal = new Vector3(), reference = new Vector3();
    for (let station = 0; station < stations; station++) {
      const t = station / (stations - 1);
      tangent.copy(path[Math.min(station + 1, stations - 1)]!).sub(path[Math.max(station - 1, 0)]!).normalize();
      reference.set(Math.abs(tangent.y) < 0.9 ? 0 : 1, Math.abs(tangent.y) < 0.9 ? 1 : 0, 0);
      normal.crossVectors(reference, tangent).normalize();
      binormal.crossVectors(tangent, normal);
      const r = radius(t);
      for (let side = 0; side < sides; side++) {
        const around = (side / sides) * Math.PI * 2;
        const c = Math.cos(around) * r, s = Math.sin(around) * r;
        const p = path[station]!;
        this.vertex(p.x + normal.x * c + binormal.x * s, p.y + normal.y * c + binormal.y * s, p.z + normal.z * c + binormal.z * s, color(t, side / sides));
      }
    }
    for (let station = 0; station < stations - 1; station++) {
      for (let side = 0; side < sides; side++) {
        const a = first + station * sides + side, b = first + station * sides + ((side + 1) % sides), c = a + sides, d = b + sides;
        this.indices.push(a, c, b, b, c, d);
      }
    }
    const end = path[stations - 1]!;
    const tip = this.vertex(end.x + tangent.x * 0.04, end.y + tangent.y * 0.04, end.z + tangent.z * 0.04, color(1, 0));
    const last = first + (stations - 1) * sides;
    for (let side = 0; side < sides; side++) this.indices.push(last + side, tip, last + ((side + 1) % sides));
  }

  geometry(): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(this.positions), 3));
    geometry.setAttribute('color', new BufferAttribute(new Float32Array(this.colors), 3));
    geometry.setIndex(this.indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }
}

const rotateYaw = (x: number, z: number, yaw: number): [number, number] => [x * Math.cos(yaw) - z * Math.sin(yaw), x * Math.sin(yaw) + z * Math.cos(yaw)];

/** One standing stone: a tapering seven-sided shaft with chipped top, black with sap at the foot, mossy grey above. */
function addStone(mesher: Mesher, stone: StonePlan, field: Field): void {
  const random = mulberry32(stone.seed * 977 + 5);
  const sides = 7;
  const ground = field.sample(stone.x, stone.z) - 0.35;
  const rings = [
    { y: 0, width: 1.1, from: 0x17131c, to: 0x24202a },
    { y: 0.4, width: 0.97, from: 0x2b2a30, to: 0x44463f },
    { y: 0.78, width: 0.76, from: 0x56594d, to: 0x70735f },
    { y: 1, width: 0.52, from: 0x70735f, to: 0x8b8e7a },
  ];
  const first = mesher.positions.length / 3;
  for (const ring of rings) {
    for (let side = 0; side < sides; side++) {
      const around = (side / sides) * Math.PI * 2 + stone.seed;
      const jitter = 0.86 + random() * 0.3;
      const lift = ring.y === 1 ? (random() - 0.5) * 0.14 * stone.height : (random() - 0.5) * 0.05 * stone.height;
      const y = ring.y * (stone.height + 0.35) + lift;
      const lx = Math.cos(around) * stone.halfWidth * ring.width * jitter + stone.leanX * y;
      const lz = Math.sin(around) * stone.halfDepth * ring.width * jitter + stone.leanZ * y;
      const [rx, rz] = rotateYaw(lx, lz, stone.yaw);
      mesher.vertex(stone.x + rx, ground + y, stone.z + rz, mix(ring.from, ring.to, random()).clone().multiplyScalar(0.9 + random() * 0.2));
    }
  }
  for (let ring = 0; ring < rings.length - 1; ring++) {
    for (let side = 0; side < sides; side++) {
      const a = first + ring * sides + side, b = first + ring * sides + ((side + 1) % sides), c = a + sides, d = b + sides;
      mesher.indices.push(a, c, b, b, c, d);
    }
  }
  const [cx, cz] = rotateYaw(stone.leanX * stone.height, stone.leanZ * stone.height, stone.yaw);
  const apex = mesher.vertex(stone.x + cx, ground + stone.height + 0.35 + stone.height * 0.04, stone.z + cz, scratchA.setHex(0x9a9c88));
  const top = first + (rings.length - 1) * sides;
  for (let side = 0; side < sides; side++) mesher.indices.push(top + side, apex, top + ((side + 1) % sides));
}

/** A sap-crusted root arching out of the ground, over and back in: a bezier tube that flares into the earth at both ends. */
function addRoot(mesher: Mesher, root: RootPlan, field: Field): void {
  const random = mulberry32(root.seed * 613 + 9);
  const stations = 11;
  const along = [Math.cos(root.yaw), Math.sin(root.yaw)] as const;
  const inward = [-Math.sin(root.yaw), Math.cos(root.yaw)] as const;
  const bulge = (random() - 0.5) * 0.8;
  const path: Vector3[] = [];
  for (let station = 0; station < stations; station++) {
    const t = station / (stations - 1);
    const offset = (t - 0.5) * root.length;
    const x = root.x + along[0] * offset + inward[0] * Math.sin(t * Math.PI) * bulge, z = root.z + along[1] * offset + inward[1] * Math.sin(t * Math.PI) * bulge;
    path.push(new Vector3(x, field.sample(x, z) - 0.25 + Math.sin(t * Math.PI) ** 0.8 * (root.height + 0.25), z));
  }
  const crustAt = (t: number, around: number): number => (Math.sin(t * 17 + root.seed * 3 + around * 5) > 0.2 ? 1 : 0) * (0.5 + 0.5 * Math.cos(root.seed + around * 9));
  mesher.tube(path, t => root.radius * (1 + 0.9 * (1 - Math.sin(t * Math.PI)) ** 2), 6, (t, around) => mix(0x4a3a2c, 0x151218, Math.min(1, crustAt(t, around) * 0.9 + (1 - Math.sin(t * Math.PI)) * 0.55)).clone());
}

const DEAD_BARK_DARK = 0x3b3228, DEAD_BARK_LIGHT = 0x786c59, SAP_BLACK = 0x15111a;

/** A dead, bare tree: a swaying forked trunk with sap-black foot and a crown of bare upswept branches with one fork each. */
function addDeadTree(mesher: Mesher, tree: BranchPlan, field: Field): void {
  const random = mulberry32(tree.seed * 131 + 17);
  const base = field.sample(tree.x, tree.z) - 0.2;
  const point = (x: number, y: number, z: number): Vector3 => {
    const [rx, rz] = rotateYaw(x, z, tree.yaw);
    return new Vector3(tree.x + rx, base + y, tree.z + rz);
  };
  const height = tree.height, radius = 0.17 + height * 0.03;
  const sway = (random() - 0.5) * 0.9, twist = random() * 6;
  const trunk: Vector3[] = [];
  const trunkAt = (t: number): [number, number, number] => [Math.sin(t * 3 + twist) * 0.35 * t + sway * t * t, height * t, Math.cos(t * 2.4 + twist) * 0.3 * t];
  for (let station = 0; station <= 6; station++) trunk.push(point(...trunkAt(station / 6)));
  mesher.tube(trunk, t => radius * (1 + 0.7 * (1 - t) ** 5) * (1 - 0.72 * t), 7, (t, around) => mix(SAP_BLACK, DEAD_BARK_DARK, Math.min(1, t * 2.6 + around * 0.1 - 0.15)).lerp(scratchB.setHex(DEAD_BARK_LIGHT), Math.max(0, t - 0.5)).clone());
  const branches = 5 + Math.floor(random() * 3);
  for (let branch = 0; branch < branches; branch++) {
    const t0 = 0.38 + 0.5 * (branch / branches) + random() * 0.08;
    const heading = branch * 2.4 + random() * 0.8;
    const length = height * (0.2 + 0.18 * random()) * (1.1 - 0.55 * t0);
    const [bx, by, bz] = trunkAt(t0);
    const dx = Math.cos(heading), dz = Math.sin(heading);
    const path = [point(bx, by - 0.05, bz), point(bx + dx * length * 0.45, by + length * 0.28, bz + dz * length * 0.45), point(bx + dx * length * 0.85, by + length * 0.62, bz + dz * length * 0.85), point(bx + dx * length, by + length * 0.8, bz + dz * length)];
    const r0 = radius * (1 - 0.72 * t0) * 0.55;
    mesher.tube(path, t => r0 * (1 - 0.9 * t), 5, t => mix(DEAD_BARK_DARK, DEAD_BARK_LIGHT, t).clone());
    const fork = [path[1]!.clone(), path[1]!.clone().add(new Vector3(-dz * length * 0.3, length * 0.4, dx * length * 0.3)), path[1]!.clone().add(new Vector3(-dz * length * 0.5, length * 0.75, dx * length * 0.5))];
    mesher.tube(fork, t => r0 * 0.55 * (1 - 0.9 * t), 4, t => mix(DEAD_BARK_DARK, DEAD_BARK_LIGHT, 0.4 + 0.6 * t).clone());
  }
}

/** A dead shrub: a handful of bare, drooping stems from one stool, each with a twig. */
function addDeadShrub(mesher: Mesher, shrub: BranchPlan, field: Field): void {
  const random = mulberry32(shrub.seed * 59 + 3);
  const base = field.sample(shrub.x, shrub.z) - 0.05;
  const stems = 4 + Math.floor(random() * 3);
  for (let stem = 0; stem < stems; stem++) {
    const heading = ((stem + random() * 0.7) / stems) * Math.PI * 2;
    const length = shrub.height * (0.7 + 0.5 * random());
    const dx = Math.cos(heading), dz = Math.sin(heading);
    const lift = shrub.height * (0.8 + 0.4 * random());
    const at = (t: number, spread: number, rise: number): Vector3 => new Vector3(shrub.x + dx * length * spread * t, base + lift * rise * t, shrub.z + dz * length * spread * t);
    const path = [at(0, 0, 0), at(0.33, 0.45, 1), at(0.66, 0.85, 1.05), at(1, 1.1, 0.78)];
    const r0 = 0.03 + random() * 0.018;
    mesher.tube(path, t => r0 * (1 - 0.88 * t), 4, t => mix(SAP_BLACK, DEAD_BARK_LIGHT, 0.25 + 0.75 * t).clone());
    const twig = [path[1]!.clone(), path[1]!.clone().add(new Vector3(-dz * 0.25, 0.28, dx * 0.25)), path[1]!.clone().add(new Vector3(-dz * 0.5, 0.42, dx * 0.5))];
    mesher.tube(twig, t => r0 * 0.5 * (1 - 0.85 * t), 3, t => mix(DEAD_BARK_DARK, DEAD_BARK_LIGHT, 0.5 + 0.5 * t).clone());
  }
}

/** Merged geometry of every solid blight shape in the plan. Exported for tests (counts, bounds). */
export function buildDressingGeometry(plan: BlightPlan, field: Field): BufferGeometry {
  const mesher = new Mesher();
  for (const stone of plan.stones) addStone(mesher, stone, field);
  for (const root of plan.roots) addRoot(mesher, root, field);
  for (const tree of plan.trees) addDeadTree(mesher, tree, field);
  for (const shrub of plan.shrubs) addDeadShrub(mesher, shrub, field);
  return mesher.geometry();
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Ground decals: sap puddles, running veins and the arena's glowing sap-mud floor (one draw call)
// ---------------------------------------------------------------------------------------------------------------------------------------

const KIND_PUDDLE = 0, KIND_VEIN = 1, KIND_FLOOR = 2;

const DECAL_VERTEX = `attribute vec4 aInfo;
varying vec2 vUv;
varying vec4 vInfo;
varying vec3 vWorld;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vInfo = aInfo;
  vWorld = position;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const DECAL_FRAGMENT = `uniform float uTime;
uniform float uMotion;
varying vec2 vUv;
varying vec4 vInfo;
varying vec3 vWorld;
#include <fog_pars_fragment>
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  float kind = vInfo.x;
  float seed = vInfo.y;
  vec3 color = vec3(0.02, 0.015, 0.03);
  float alpha = 0.0;
  float pulse = 0.5 + 0.5 * sin(uTime * 0.9 * uMotion + seed * 6.0);
  if (kind < 0.5) {
    // Puddle: a ragged blob of glossy black sap. Values are linear (the colour-space step lifts them): the sheen is a faint violet
    // reflection with a few amber glints and a bruised-green rim, never a grey or white patch.
    vec2 p = vUv - 0.5;
    float wobble = noise(p * 7.0 + seed) - 0.5 + 0.5 * (noise(p * 16.0 + seed * 3.0) - 0.5);
    float d = length(p) * 2.0 * (1.0 + 0.32 * wobble);
    alpha = (1.0 - smoothstep(0.8, 0.93, d)) * 0.97;
    color = vec3(0.0025, 0.0022, 0.0035);
    float inside = 1.0 - smoothstep(0.5, 0.85, d);
    float gloss = smoothstep(0.62, 0.86, noise(p * 6.0 + seed * 2.0 + uTime * 0.04 * uMotion));
    float glint = smoothstep(0.84, 0.95, noise(p * 11.0 + seed * 5.0 - uTime * 0.05 * uMotion));
    float rim = smoothstep(0.7, 0.86, d) * (1.0 - smoothstep(0.86, 0.93, d));
    color += vec3(0.011, 0.008, 0.026) * gloss * inside + vec3(0.02, 0.008, 0.001) * glint * inside + vec3(0.012, 0.016, 0.004) * rim;
  } else if (kind < 1.5) {
    // Vein: a black rivulet that thins towards its far end, with a slow sickly pulse running along it.
    float across = abs(vUv.x - 0.5) * 2.0;
    float along = vUv.y;
    float edge = 1.0 - smoothstep(0.35, 1.0, across + 0.25 * (noise(vec2(along * vInfo.z * 0.6, seed)) - 0.5));
    alpha = edge * (1.0 - smoothstep(0.78, 1.0, along)) * 0.95;
    float run = 0.5 + 0.5 * sin(along * vInfo.z * 0.9 - uTime * 1.3 * uMotion + seed * 4.0);
    float core = (1.0 - smoothstep(0.0, 0.45, across)) * smoothstep(0.55, 1.0, run);
    color += mix(vec3(0.18, 0.09, 0.26), vec3(0.2, 0.26, 0.07), step(0.5, fract(seed * 3.7))) * core * 0.55;
  } else {
    // Arena floor: soaked sap-mud with two rings of broken Warden runes, heart-light pulsing amber through them.
    vec2 p = vUv - 0.5;
    float angle = atan(p.y, p.x);
    float d = length(p) * 2.0;
    float grain = noise(p * 9.0 + 3.0);
    float soak = 1.0 - smoothstep(0.7, 1.0, d + 0.12 * (grain - 0.5) + 0.06 * (noise(p * 22.0) - 0.5));
    alpha = soak * (0.3 + 0.15 * smoothstep(0.0, 0.5, d)) * (0.85 + 0.3 * grain);
    color = vec3(0.07, 0.05, 0.045) + vec3(0.02, 0.012, 0.025) * noise(p * 14.0);
    float broken = step(0.42, noise(vec2(angle * 3.2, floor(d * 8.0)) + seed));
    float ringA = (1.0 - smoothstep(0.0, 0.0065, abs(d - 0.72))) * broken;
    float ringB = (1.0 - smoothstep(0.0, 0.005, abs(d - 0.905))) * step(0.3, noise(vec2(angle * 5.0, 7.0)));
    float rune = max(ringA, ringB);
    color += vec3(1.0, 0.58, 0.16) * rune * (0.25 + 0.4 * pulse);
    alpha = max(alpha, rune * 0.85 * soak);
  }
  gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

class DecalBuilder {
  private readonly positions: number[] = [];
  private readonly uvs: number[] = [];
  private readonly infos: number[] = [];
  private readonly indices: number[] = [];

  private vertex(x: number, y: number, z: number, u: number, v: number, kind: number, seed: number, extra: number): number {
    const index = this.positions.length / 3;
    this.positions.push(x, y, z);
    this.uvs.push(u, v);
    this.infos.push(kind, seed, extra, 0);
    return index;
  }

  /** A rotated rectangle of `sizeX` by `sizeZ` metres at (x, z), draped on the ground at its corners. */
  quad(field: Field, kind: number, x: number, z: number, sizeX: number, sizeZ: number, yaw: number, seed: number): void {
    const corners = [[-0.5, -0.5, 0, 0], [0.5, -0.5, 1, 0], [0.5, 0.5, 1, 1], [-0.5, 0.5, 0, 1]] as const;
    const ids = corners.map(([cx, cz, u, v]) => {
      const [rx, rz] = rotateYaw(cx * sizeX, cz * sizeZ, yaw);
      return this.vertex(x + rx, field.sample(x + rx, z + rz) + 0.05, z + rz, u, v, kind, seed, 0);
    });
    this.indices.push(ids[0]!, ids[2]!, ids[1]!, ids[0]!, ids[3]!, ids[2]!);
  }

  /** A strip along `points` (ground x, z), `width` metres at the wide end, tapering with distance. */
  strip(field: Field, vein: VeinPlan, seed: number): void {
    const { points, width } = vein;
    let length = 0;
    for (let index = 1; index < points.length; index++) length += Math.hypot(points[index]![0] - points[index - 1]![0], points[index]![1] - points[index - 1]![1]);
    const ids: [number, number][] = [];
    for (let index = 0; index < points.length; index++) {
      const previous = points[Math.max(index - 1, 0)]!, next = points[Math.min(index + 1, points.length - 1)]!;
      const dx = next[0] - previous[0], dz = next[1] - previous[1], norm = Math.hypot(dx, dz) || 1;
      const t = index / (points.length - 1), half = (width * (1 - 0.7 * t)) / 2;
      const nx = -dz / norm * half, nz = dx / norm * half, [x, z] = points[index]!;
      ids.push([this.vertex(x + nx, field.sample(x + nx, z + nz) + 0.05, z + nz, 0, t, KIND_VEIN, seed, length), this.vertex(x - nx, field.sample(x - nx, z - nz) + 0.05, z - nz, 1, t, KIND_VEIN, seed, length)]);
    }
    for (let index = 0; index < ids.length - 1; index++) {
      const [a, b] = ids[index]!, [c, d] = ids[index + 1]!;
      this.indices.push(a, c, b, b, c, d);
    }
  }

  geometry(): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(this.positions), 3));
    geometry.setAttribute('uv', new BufferAttribute(new Float32Array(this.uvs), 2));
    geometry.setAttribute('aInfo', new BufferAttribute(new Float32Array(this.infos), 4));
    geometry.setIndex(this.indices);
    geometry.computeBoundingSphere();
    return geometry;
  }
}

/** Merged decal geometry (puddles, veins, arena floor). Exported for tests. */
export function buildDecalGeometry(plan: BlightPlan, field: Field): BufferGeometry {
  const decals = new DecalBuilder();
  decals.quad(field, KIND_FLOOR, ARENA_CENTRE.x, ARENA_CENTRE.z, ARENA_WALK_RADIUS * 2 + 3, ARENA_WALK_RADIUS * 2 + 3, 0, 1);
  plan.puddles.forEach((puddle: PuddlePlan, index) => decals.quad(field, KIND_PUDDLE, puddle.x, puddle.z, puddle.sizeX, puddle.sizeZ, puddle.yaw, index + 1.3));
  plan.veins.forEach((vein, index) => decals.strip(field, vein, index + 0.7));
  return decals.geometry();
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Ground wash and the corrupted Memory Pool surface
// ---------------------------------------------------------------------------------------------------------------------------------------

const WASH_VERTEX = `attribute vec4 aGrade;
varying vec4 vGrade;
#include <fog_pars_vertex>
void main() {
  vGrade = aGrade;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const WASH_FRAGMENT = `varying vec4 vGrade;
#include <fog_pars_fragment>
void main() {
  // Multiplied over the ground: the grade fades to neutral (white) with the fog, so distance never turns it into a dark smear.
  vec3 grade = mix(vec3(1.0), vGrade.rgb, vGrade.a);
  #ifdef USE_FOG
    grade = mix(grade, vec3(1.0), smoothstep(fogNear, fogFar, vFogDepth));
  #endif
  gl_FragColor = vec4(grade, 1.0);
}`;

/** Grid of vertex grades (rgb multiplier, strength) over the blighted ground. Exported for tests. */
export function buildWashGeometry(field: Field): BufferGeometry {
  const columns = Math.round((WASH.maxX - WASH.minX) / WASH.cell) + 1, rows = Math.round((WASH.maxZ - WASH.minZ) / WASH.cell) + 1;
  const positions = new Float32Array(columns * rows * 3), grades = new Float32Array(columns * rows * 4), indices: number[] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const x = WASH.minX + column * WASH.cell, z = WASH.minZ + row * WASH.cell, index = row * columns + column;
      positions.set([x, field.sample(x, z) + 0.06, z], index * 3);
      const [r, g, b] = blightGrade(z);
      grades.set([r, g, b, Math.min(1, blightAt(x, z) * 1.05)], index * 4);
    }
  }
  for (let row = 0; row < rows - 1; row++) {
    for (let column = 0; column < columns - 1; column++) {
      const a = row * columns + column, b = a + 1, c = a + columns, d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('aGrade', new BufferAttribute(grades, 4));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

const POOL_VERTEX = `varying vec2 vLocal;
#include <fog_pars_vertex>
void main() {
  vLocal = position.xz;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const POOL_FRAGMENT = `uniform float uTime;
uniform float uMotion;
uniform vec2 uRadius;
varying vec2 vLocal;
#include <fog_pars_fragment>
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  vec2 q = vLocal / uRadius;
  float d = length(q);
  float t = uTime * uMotion;
  // Ink-dark water churned slowly by the sap, with faint violet streaks of reflected sky. Colours are linear: the colour-space step lifts
  // them, so the brightest pixel here (the heart-light's core) lands at a saturated amber well below the HUD's white text.
  vec2 flow = vLocal * 0.35 + vec2(t * 0.05, -t * 0.04);
  float swirl = noise(flow * 2.0 + noise(flow * 4.0 + t * 0.06) * 1.6);
  vec3 color = mix(vec3(0.0025, 0.003, 0.006), vec3(0.01, 0.007, 0.02), swirl * swirl);
  // The cracked heart-light welling up from the pool's centre: a small amber core, a thin ring of broken light and a few faint rings of memory.
  float beat = 0.6 + 0.4 * sin(t * 1.1);
  float core = exp(-pow(d * 6.5, 2.0));
  float ring = exp(-pow((d - (0.3 + 0.04 * sin(t * 0.5))) * 12.0, 2.0)) * smoothstep(0.4, 0.8, noise(vec2(atan(q.y, q.x) * 3.0, t * 0.15)));
  float ripple = smoothstep(0.9, 1.0, sin(d * 15.0 - t * 1.2)) * (1.0 - smoothstep(0.1, 0.7, d));
  vec3 amber = vec3(0.42, 0.13, 0.016);
  color += amber * (core * (0.55 + 0.45 * beat) + ring * 0.3 + ripple * 0.08);
  color += vec3(0.02, 0.008, 0.032) * smoothstep(0.35, 0.75, swirl) * (1.0 - core);
  float alpha = 1.0 - smoothstep(0.84, 1.0, d + 0.06 * (noise(vLocal * 0.9) - 0.5));
  gl_FragColor = vec4(color, alpha * 0.97);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

// ---------------------------------------------------------------------------------------------------------------------------------------
// The feature
// ---------------------------------------------------------------------------------------------------------------------------------------

export class GroveBlightDressing implements GroundFeature {
  readonly group = new Group();
  readonly plan: BlightPlan;
  readonly solids: Mesh<BufferGeometry, MeshLambertMaterial>;
  readonly decals: Mesh<BufferGeometry, ShaderMaterial>;
  readonly wash: Mesh<BufferGeometry, ShaderMaterial>;
  readonly poolSurface: Mesh<BufferGeometry, ShaderMaterial>;
  private disposed = false;

  constructor(context: FeatureContext) {
    this.group.name = 'grove-blight';
    const field = context.field;
    const obstacles = context.region.props.map(prop => ({ x: prop.position.x, z: prop.position.z, radius: (PROP_RADIUS[prop.assetId] ?? DEFAULT_PROP_RADIUS) * Math.max(prop.scale.x, prop.scale.z) }));
    this.plan = planBlight(field, obstacles);

    const solidMaterial = new MeshLambertMaterial({ color: 0xffffff, vertexColors: true, side: DoubleSide, flatShading: true });
    solidMaterial.name = 'grove-blight-solids';
    this.solids = new Mesh(buildDressingGeometry(this.plan, field), solidMaterial);
    this.solids.name = 'grove-blight-solids';
    this.solids.castShadow = true;
    this.solids.receiveShadow = true;

    const decalMaterial = new ShaderMaterial({
      uniforms: UniformsUtils.merge([UniformsLib.fog, { uTime: { value: 0 }, uMotion: { value: 1 } }]),
      vertexShader: DECAL_VERTEX, fragmentShader: DECAL_FRAGMENT, transparent: true, depthWrite: false, fog: true, side: DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    decalMaterial.name = 'grove-sap-decals';
    this.decals = new Mesh(buildDecalGeometry(this.plan, field), decalMaterial);
    this.decals.name = 'grove-sap-decals';
    this.decals.renderOrder = 1;
    this.decals.frustumCulled = false;

    const washMaterial = new ShaderMaterial({
      uniforms: UniformsUtils.merge([UniformsLib.fog]), vertexShader: WASH_VERTEX, fragmentShader: WASH_FRAGMENT, transparent: true, depthWrite: false, fog: true, side: DoubleSide,
      blending: CustomBlending, blendSrc: DstColorFactor, blendDst: ZeroFactor, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    washMaterial.name = 'grove-blight-wash';
    this.wash = new Mesh(buildWashGeometry(field), washMaterial);
    this.wash.name = 'grove-blight-wash';
    this.wash.renderOrder = 0;
    this.wash.frustumCulled = false;

    const poolMaterial = new ShaderMaterial({
      uniforms: UniformsUtils.merge([UniformsLib.fog, { uTime: { value: 0 }, uMotion: { value: 1 }, uRadius: { value: new Vector2(MEMORY_POOL.radiusX * 1.12, MEMORY_POOL.radiusZ * 1.12) } }]),
      vertexShader: POOL_VERTEX, fragmentShader: POOL_FRAGMENT, transparent: true, depthWrite: false, fog: true, side: DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    });
    poolMaterial.name = 'grove-memory-pool-surface';
    this.poolSurface = new Mesh(buildPoolGeometry(), poolMaterial);
    this.poolSurface.name = 'grove-memory-pool-surface';
    this.poolSurface.position.set(MEMORY_POOL.x, MEMORY_POOL.waterY + 0.04, MEMORY_POOL.z);
    this.poolSurface.rotation.y = -MEMORY_POOL.rotation;
    this.poolSurface.renderOrder = 2;
    this.poolSurface.frustumCulled = false;

    this.group.add(this.solids, this.wash, this.decals, this.poolSurface);
  }

  update(worldTimeSeconds: number): void {
    if (this.disposed) return;
    this.decals.material.uniforms.uTime!.value = worldTimeSeconds;
    this.poolSurface.material.uniforms.uTime!.value = worldTimeSeconds;
  }

  setReducedEffects(reduced: boolean): void {
    this.decals.material.uniforms.uMotion!.value = reduced ? 0 : 1;
    this.poolSurface.material.uniforms.uMotion!.value = reduced ? 0 : 1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    for (const mesh of [this.solids, this.decals, this.wash, this.poolSurface]) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  }
}

/** A flat disc of one unit scaled to the pool's water ellipse (x, z) with a fine fan. */
function buildPoolGeometry(): BufferGeometry {
  const segments = 56, positions = new Float32Array((segments + 1) * 3), indices: number[] = [];
  const rx = MEMORY_POOL.radiusX * 1.12, rz = MEMORY_POOL.radiusZ * 1.12;
  for (let segment = 0; segment < segments; segment++) {
    const angle = (segment / segments) * Math.PI * 2;
    positions.set([Math.cos(angle) * rx * 1.1, 0, Math.sin(angle) * rz * 1.1], (segment + 1) * 3);
    indices.push(0, segment + 1, ((segment + 1) % segments) + 1);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

export function createGroveBlightDressing(context: FeatureContext): GroundFeature {
  return new GroveBlightDressing(context);
}
