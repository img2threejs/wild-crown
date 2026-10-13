import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  DoubleSide,
  Euler,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Material,
  Matrix4,
  MeshLambertMaterial,
  type MeshLambertMaterialParameters,
  OctahedronGeometry,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  SphereGeometry,
  TubeGeometry,
  Vector3,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { groundExtent, type BiomeProfile, type ClutterGeometryKind, type ClutterRecipe, type InstanceSink, type ScatterContext, type UnderstoryProfile } from './BiomeProfile';
import type { RegionDefinition } from '../game/contracts';
import { hash3, smoothstep, valueNoise } from './GroundNoise';
import { CORE_CLEAR_WEIGHT } from './GroundScatter';
import { withCheapShadows } from './GroundShadow';
import { createMaskSample, sampleMask, type GroundMask } from './GroundMask';
import type { TerrainField } from './GroundTerrain';

/** Mask weights above which clutter is skipped: channel bed / water, bridge underside, steep rock. */
const BLOCK_BED = 0.1;
const BLOCK_DECK = 0.05;
const BLOCK_ROCK = 0.7;
/** Glowing mushrooms are authored HDR (> 1.0) so the bloom pass picks them up; kept subtle. */
export const GLOW_EMISSIVE_INTENSITY = 1.9;
const GLOW_SPACING = 14;

class InstanceBuilder implements InstanceSink {
  readonly data: number[] = [];
  count = 0;

  push(x: number, y: number, z: number, yaw: number, sx: number, sy: number, sz: number, tint: number): void {
    this.data.push(x, y, z, yaw, sx, sy, sz, tint);
    this.count++;
  }
}

function bakeColor(geometry: BufferGeometry, hex: number): BufferGeometry {
  const color = new Color(hex);
  const count = geometry.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let index = 0; index < count; index++) {
    colors[index * 3] = color.r;
    colors[index * 3 + 1] = color.g;
    colors[index * 3 + 2] = color.b;
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  return geometry;
}

function makeMushroomGeometry(capHex: number, stemHex: number): BufferGeometry {
  const stem = new CylinderGeometry(0.011, 0.016, 0.07, 5, 1, false).toNonIndexed();
  stem.translate(0, 0.035, 0);
  const cap = new SphereGeometry(0.045, 6, 2, 0, Math.PI * 2, 0, Math.PI / 2).toNonIndexed();
  cap.scale(1, 0.62, 1);
  cap.translate(0, 0.066, 0);
  const merged = mergeGeometries([bakeColor(stem, stemHex), bakeColor(cap, capHex)]);
  stem.dispose();
  cap.dispose();
  return merged;
}

const LEAF_TINTS = [0x7a4a22, 0x9a6128, 0x5c3a1c, 0x6b5a2a, 0x884b2a] as const;

function makeLeafPileGeometry(): BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const color = new Color();
  for (let leaf = 0; leaf < 6; leaf++) {
    const around = hash3(leaf, 1, 0, 311) * Math.PI * 2;
    const radius = 0.32 * Math.sqrt(hash3(leaf, 2, 0, 311));
    const cx = Math.cos(around) * radius;
    const cz = Math.sin(around) * radius;
    const cy = 0.008 + leaf * 0.004;
    const yaw = hash3(leaf, 3, 0, 311) * Math.PI * 2;
    const tilt = (hash3(leaf, 4, 0, 311) - 0.5) * 0.7;
    const ax = Math.cos(yaw);
    const az = Math.sin(yaw);
    const length = 0.05 + hash3(leaf, 5, 0, 311) * 0.04;
    const half = length * 0.42;
    color.setHex(LEAF_TINTS[leaf % LEAF_TINTS.length]!);
    positions.push(
      cx - ax * length, cy - tilt * length, cz - az * length,
      cx - az * half, cy, cz + ax * half,
      cx + ax * length, cy + tilt * length, cz + az * length,
      cx + az * half, cy, cz - ax * half,
      cx - az * half, cy, cz + ax * half,
      cx - ax * length, cy - tilt * length, cz - az * length,
    );
    for (let vertex = 0; vertex < 6; vertex++) colors.push(color.r, color.g, color.b);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  geometry.computeVertexNormals();
  return geometry;
}

interface FrondSpec {
  readonly fronds: number;
  readonly stations: number;
  readonly reach: number;
  readonly reachJitter: number;
  readonly lift: number;
  readonly width: number;
  readonly dark: number;
  readonly light: number;
  readonly seed: number;
}

/** A rosette of arching fronds / blades: each is a ribbon of `stations` quads that widens and tapers like a leaf. */
function makeFrondGeometry(spec: FrondSpec): BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const dark = new Color(spec.dark);
  const light = new Color(spec.light);
  const mixed = new Color();
  for (let frond = 0; frond < spec.fronds; frond++) {
    const angle = (frond / spec.fronds) * Math.PI * 2 + hash3(frond, 0, 0, spec.seed) * 0.4;
    const dx = Math.cos(angle);
    const dz = Math.sin(angle);
    const reach = spec.reach + hash3(frond, 1, 0, spec.seed) * spec.reachJitter;
    const first = positions.length / 3;
    for (let station = 0; station <= spec.stations; station++) {
      const t = station / spec.stations;
      const radius = reach * Math.sin(t * Math.PI * 0.5) + 0.02;
      const height = Math.sin(t * Math.PI * 0.8) * spec.lift + 0.02;
      const half = spec.width * Math.pow(Math.sin(Math.min(1, t * 1.1 + 0.08) * Math.PI), 0.7) + 0.006;
      mixed.copy(dark).lerp(light, t * 0.9 + hash3(frond, station, 0, spec.seed + 1) * 0.1);
      for (const side of [-1, 1]) {
        positions.push(dx * radius - dz * half * side, height, dz * radius + dx * half * side);
        colors.push(mixed.r, mixed.g, mixed.b);
      }
    }
    for (let station = 0; station < spec.stations; station++) {
      const a = first + station * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** One broad leaf on an upright stem (elephant-ear style): a fan of triangles tilted away from the stem. */
function makeBigLeafGeometry(): BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const dark = new Color(0x1d4a1f);
  const light = new Color(0x4f8f3c);
  const mixed = new Color();
  const leaves = 3;
  for (let leaf = 0; leaf < leaves; leaf++) {
    const angle = (leaf / leaves) * Math.PI * 2 + hash3(leaf, 0, 0, 913) * 0.8;
    const dx = Math.cos(angle);
    const dz = Math.sin(angle);
    const stem = 0.55 + hash3(leaf, 1, 0, 913) * 0.35;
    const tilt = 0.5 + hash3(leaf, 2, 0, 913) * 0.4;
    const length = 0.5 + hash3(leaf, 3, 0, 913) * 0.25;
    const first = positions.length / 3;
    const base = new Vector3(dx * 0.05, stem, dz * 0.05);
    // Blade axis leans outward and droops; the blade is an oval of 5 stations.
    const stations = 5;
    for (let station = 0; station <= stations; station++) {
      const t = station / stations;
      const along = t * length;
      const droop = -Math.sin(t * Math.PI * 0.5) * tilt * 0.4;
      const half = 0.3 * Math.pow(Math.sin(t * Math.PI * 0.92 + 0.12), 0.8) * (length / 0.62);
      mixed.copy(dark).lerp(light, 0.25 + t * 0.7);
      for (const side of [-1, 1]) {
        positions.push(base.x + dx * along * tilt - dz * half * side, base.y + along * (1 - tilt) * 0.6 + droop * 0.4, base.z + dz * along * tilt + dx * half * side);
        colors.push(mixed.r, mixed.g, mixed.b);
      }
    }
    for (let station = 0; station < stations; station++) {
      const a = first + station * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    // Stem: a thin double-triangle strip from the ground to the blade base.
    const stemFirst = positions.length / 3;
    positions.push(0 - dz * 0.012, 0, 0 + dx * 0.012, 0 + dz * 0.012, 0, 0 - dx * 0.012, base.x - dz * 0.01, base.y, base.z + dx * 0.01, base.x + dz * 0.01, base.y, base.z - dx * 0.01);
    for (let vertex = 0; vertex < 4; vertex++) colors.push(0.2, 0.3, 0.12);
    indices.push(stemFirst, stemFirst + 1, stemFirst + 2, stemFirst + 1, stemFirst + 3, stemFirst + 2);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** A fallen log lying along local x: bark brown underneath, a moss carpet on top. */
function makeLogGeometry(): BufferGeometry {
  const log = new CylinderGeometry(0.2, 0.26, 2.4, 7, 1, false).rotateZ(Math.PI / 2).toNonIndexed();
  log.translate(0, 0.17, 0);
  const normal = log.getAttribute('normal');
  const count = normal.count;
  const colors = new Float32Array(count * 3);
  const bark = new Color(0x4a3524);
  const moss = new Color(0x4f7a32);
  const mixed = new Color();
  for (let index = 0; index < count; index++) {
    mixed.copy(bark).lerp(moss, smoothstep(0.05, 0.6, normal.getY(index)) * 0.9);
    colors[index * 3] = mixed.r;
    colors[index * 3 + 1] = mixed.g;
    colors[index * 3 + 2] = mixed.b;
  }
  log.setAttribute('color', new BufferAttribute(colors, 3));
  return log;
}

/** A surface root: a bent tube that arches out of the ground and dives back into it. */
function makeRootGeometry(): BufferGeometry {
  const curve = new CatmullRomCurve3([new Vector3(-0.7, -0.06, 0), new Vector3(-0.3, 0.1, 0.05), new Vector3(0.15, 0.13, -0.03), new Vector3(0.7, -0.07, 0.02)]);
  const tube = new TubeGeometry(curve, 8, 0.07, 5, false).toNonIndexed();
  const count = tube.getAttribute('position').count;
  const normal = tube.getAttribute('normal');
  const colors = new Float32Array(count * 3);
  const bark = new Color(0x3d2c1c);
  const moss = new Color(0x56803a);
  const mixed = new Color();
  for (let index = 0; index < count; index++) {
    mixed.copy(bark).lerp(moss, smoothstep(0.1, 0.8, normal.getY(index)) * 0.8);
    colors[index * 3] = mixed.r;
    colors[index * 3 + 1] = mixed.g;
    colors[index * 3 + 2] = mixed.b;
  }
  tube.setAttribute('color', new BufferAttribute(colors, 3));
  return tube;
}

function triangleCount(geometry: BufferGeometry): number {
  return (geometry.index ? geometry.index.count : geometry.getAttribute('position').count) / 3;
}

interface ClutterAsset {
  readonly geometry: BufferGeometry;
  readonly parameters: MeshLambertMaterialParameters;
  /** Wind sway of the vertex shader: the geometry height that reaches full sway and its amplitude along x / z. */
  readonly sway: { readonly height: number; readonly x: number; readonly z: number } | undefined;
}

const SWAY: Readonly<Record<'fern' | 'jungleFern' | 'broadleaf', { height: number; x: number; z: number }>> = {
  fern: { height: 0.32, x: 0.05, z: 0.04 },
  jungleFern: { height: 0.5, x: 0.08, z: 0.06 },
  broadleaf: { height: 0.95, x: 0.14, z: 0.11 },
};

const FERN: FrondSpec = { fronds: 6, stations: 4, reach: 0.45, reachJitter: 0.2, lift: 0.3, width: 0.075, dark: 0x1f3b1b, light: 0x5f8a3a, seed: 77 };
/** Rainforest fern: fewer, longer, broader fronds than the temperate fern (30 triangles), so it covers more ground per instance. */
const JUNGLE_FERN: FrondSpec = { fronds: 5, stations: 3, reach: 0.6, reachJitter: 0.3, lift: 0.46, width: 0.13, dark: 0x1b4a1d, light: 0x66a846, seed: 91 };
/** Canopy understory: tall, broad arching leaves (about 0.9 m high). */
const BROADLEAF: FrondSpec = { fronds: 7, stations: 4, reach: 0.55, reachJitter: 0.25, lift: 0.85, width: 0.17, dark: 0x16401c, light: 0x58a03f, seed: 131 };

function makeAsset(kind: ClutterGeometryKind): ClutterAsset {
  switch (kind) {
    case 'pebble':
      return { geometry: new OctahedronGeometry(1, 0), parameters: { color: 0xffffff, flatShading: true }, sway: undefined };
    case 'twig':
      return { geometry: new CylinderGeometry(0.5, 0.5, 1, 4, 1, true).rotateZ(Math.PI / 2), parameters: { color: 0xffffff }, sway: undefined };
    case 'leaf-pile':
      return { geometry: makeLeafPileGeometry(), parameters: { color: 0xffffff, vertexColors: true, side: DoubleSide }, sway: undefined };
    case 'mushroom':
      return { geometry: makeMushroomGeometry(0x7d3b24, 0xcfc4a6), parameters: { color: 0xffffff, vertexColors: true }, sway: undefined };
    case 'fern':
      return { geometry: makeFrondGeometry(FERN), parameters: { color: 0xffffff, vertexColors: true, side: DoubleSide }, sway: SWAY.fern };
    case 'jungle-fern':
      return { geometry: makeFrondGeometry(JUNGLE_FERN), parameters: { color: 0xffffff, vertexColors: true, side: DoubleSide }, sway: SWAY.jungleFern };
    case 'broadleaf':
      return { geometry: makeFrondGeometry(BROADLEAF), parameters: { color: 0xffffff, vertexColors: true, side: DoubleSide }, sway: SWAY.broadleaf };
    case 'big-leaf':
      return { geometry: makeBigLeafGeometry(), parameters: { color: 0xffffff, vertexColors: true, side: DoubleSide }, sway: SWAY.broadleaf };
    case 'log':
      return { geometry: makeLogGeometry(), parameters: { color: 0xffffff, vertexColors: true }, sway: undefined };
    case 'root':
      return { geometry: makeRootGeometry(), parameters: { color: 0xffffff, vertexColors: true }, sway: undefined };
    case 'edge-stone':
      return { geometry: new IcosahedronGeometry(1, 0), parameters: { color: 0xffffff, flatShading: true }, sway: undefined };
  }
}

/**
 * Deterministic instanced ground clutter and trail dressing, driven by the profile's recipes (Greenwake: pebbles, twigs, leaf
 * piles, mushrooms, ferns; canopy: ferns, broadleaf, big leaves, logs, roots, mushrooms…), small stones lining both trail edges and,
 * where the profile asks for it, a few softly glowing mushroom clusters guiding the eye along the ribbons. One draw call per kind;
 * static after construction apart from vertex sway driven by the shared wind clock.
 */
export class GroundClutter {
  readonly group = new Group();
  readonly drawCalls: number;
  readonly instanceCount: number;
  /** Triangles submitted per frame when everything is in view. */
  readonly triangleCount: number;
  private readonly meshes: InstancedMesh[] = [];
  private readonly geometries: BufferGeometry[] = [];
  private readonly materials: Material[] = [];
  private readonly scratch = createMaskSample();
  private triangles = 0;
  private disposed = false;

  constructor(
    private readonly region: RegionDefinition,
    private readonly field: TerrainField,
    private readonly mask: GroundMask,
    private readonly wind: { value: number },
    private readonly profile: BiomeProfile,
  ) {
    const understory = profile.understory;
    this.group.name = 'ground-clutter';
    const builders = new Map<ClutterGeometryKind, InstanceBuilder>();
    for (const recipe of understory.clutter) {
      const builder = new InstanceBuilder();
      builders.set(recipe.name, builder);
      for (const scatter of recipe.scatters) this.scatter(scatter.cell, scatter.seed, (context) => scatter.place(context, builder));
    }
    const stones = new InstanceBuilder();
    const glowSites: Array<{ x: number; z: number }> = [];
    this.dressTrail(stones, glowSites, understory);
    for (const recipe of understory.clutter) this.addRecipe(recipe, builders.get(recipe.name)!);
    this.addRecipe({ name: 'edge-stone', tints: understory.trailDressing.stoneTints, tilt: 0.35, receiveShadow: true, sway: undefined, scatters: [] }, stones);
    if (understory.trailDressing.glow) this.addGlow(glowSites);
    let instances = 0;
    for (const mesh of this.meshes) instances += mesh.count;
    this.drawCalls = this.meshes.length;
    this.instanceCount = instances;
    this.triangleCount = this.triangles;
  }

  /** World positions of every instance, for coverage assertions. */
  forEachInstance(visit: (name: string, x: number, z: number) => void): void {
    const matrix = new Matrix4();
    for (const mesh of this.meshes) {
      for (let index = 0; index < mesh.count; index++) {
        mesh.getMatrixAt(index, matrix);
        visit(mesh.name, matrix.elements[12]!, matrix.elements[14]!);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    for (const mesh of this.meshes) mesh.dispose();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.meshes.length = 0;
    this.geometries.length = 0;
    this.materials.length = 0;
    this.group.clear();
  }

  /** Lambert is enough for matte litter at this size; `shadows` materials swap PCFSoft for a one-fetch compare. */
  private material(parameters: MeshLambertMaterialParameters, shadows: boolean): MeshLambertMaterial {
    const material = new MeshLambertMaterial(parameters);
    if (shadows) {
      material.onBeforeCompile = (shader) => {
        shader.fragmentShader = withCheapShadows(shader.fragmentShader, 'hard');
      };
      material.customProgramCacheKey = () => 'ground-clutter-hard-shadow';
    }
    this.materials.push(material);
    return material;
  }

  /** Jittered-grid scatter over the ground extent; `place` receives the bilinear mask at the candidate. */
  private scatter(cell: number, seed: number, place: (context: ScatterContext) => void): void {
    const extent = groundExtent(this.region, this.profile);
    const nearFull = this.profile.understory.clutterNearFull;
    const nearNone = this.profile.understory.clutterNearNone;
    const field = this.field;
    const context = {
      x: 0, z: 0, h: 0, rng: 0, mask: this.scratch, field,
      near: () => 1 - smoothstep(nearFull, nearNone, field.walkDistance(context.x, context.z, nearNone)),
    };
    const cols = Math.floor((extent.maxX - extent.minX) / cell);
    const rows = Math.floor((extent.maxZ - extent.minZ) / cell);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const x = extent.minX + (col + hash3(col, row, 1, seed)) * cell;
        const z = extent.minZ + (row + hash3(col, row, 2, seed)) * cell;
        const sample = sampleMask(this.mask, x, z, this.scratch);
        // Nothing lies in the channel bed / water, on bare rock faces, or under the bridge (ferns and tufts still grow on the wet banks).
        if (sample.bed > BLOCK_BED || sample.deck > BLOCK_DECK || sample.rock > BLOCK_ROCK) continue;
        context.x = x;
        context.z = z;
        context.h = hash3(col, row, 3, seed);
        context.rng = hash3(col, row, 4, seed);
        place(context);
      }
    }
  }

  /** Edge stones along both sides of every ground ribbon plus glowing mushroom sites. */
  private dressTrail(stones: InstanceBuilder, glowSites: Array<{ x: number; z: number }>, understory: UnderstoryProfile): void {
    const sample = this.scratch;
    const spacing = 0.5;
    const glow = understory.trailDressing.glow;
    for (const segment of this.mask.segments) {
      const dx = (segment.bx - segment.ax) / segment.length;
      const dz = (segment.bz - segment.az) / segment.length;
      const count = Math.floor(segment.length / spacing);
      for (let step = 0; step < count; step++) {
        const t = (step + hash3(step, Math.floor(segment.startArc), 1, 401) * 1.6 - 0.3) * spacing;
        for (const side of [-1, 1]) {
          const rng = hash3(step, Math.floor(segment.startArc * 7) + side, 2, 401);
          // Clumps and gaps (noise along the trail) with a wide lateral scatter: no regular rows.
          const clump = valueNoise((segment.startArc + t) * 0.35, side * 7.3, 411);
          if (rng < 0.15 + 0.5 * (1 - clump)) continue;
          const lateral = side * (segment.halfWidth * 0.95 + 0.05 + 0.6 * hash3(step, side, 3, 401) * hash3(step, side, 5, 401));
          const x = segment.ax + dx * t - dz * lateral;
          const z = segment.az + dz * t + dx * lateral;
          const stoneMask = sampleMask(this.mask, x, z, sample);
          if (stoneMask.core > CORE_CLEAR_WEIGHT || stoneMask.bed > BLOCK_BED || stoneMask.deck > BLOCK_DECK || stoneMask.rock > BLOCK_ROCK) continue;
          const size = 0.05 + 0.08 * rng * rng;
          stones.push(x, this.field.sample(x, z) + size * 0.15, z, rng * 50, size * (1 + 0.5 * hash3(step, side, 4, 401)), size * 0.6, size, Math.floor(rng * 997));
        }
      }
      if (!glow) continue;
      // Glow clusters sit every GLOW_SPACING metres of ribbon arc, alternating sides, never within 4 m of another cluster.
      const segmentEnd = segment.startArc + segment.length;
      for (let arc = Math.ceil((segment.startArc - GLOW_SPACING * 0.5) / GLOW_SPACING) * GLOW_SPACING + GLOW_SPACING * 0.5; arc < segmentEnd; arc += GLOW_SPACING) {
        if (arc < segment.startArc) continue;
        const index = Math.round((arc - GLOW_SPACING * 0.5) / GLOW_SPACING);
        const lateral = (index % 2 === 0 ? 1 : -1) * (segment.halfWidth + 0.55 + 0.35 * hash3(index, Math.floor(segment.startArc), 5, 401));
        const t = arc - segment.startArc;
        const x = segment.ax + dx * t - dz * lateral;
        const z = segment.az + dz * t + dx * lateral;
        const glowMask = sampleMask(this.mask, x, z, sample);
        if (understory.excluded(x, z) || glowMask.core > CORE_CLEAR_WEIGHT || glowMask.bed > BLOCK_BED || glowMask.deck > BLOCK_DECK || glowMask.rock > BLOCK_ROCK) continue;
        if (glowSites.some((site) => Math.hypot(site.x - x, site.z - z) < 4)) continue;
        glowSites.push({ x, z });
      }
    }
  }

  private addRecipe(recipe: ClutterRecipe, builder: InstanceBuilder): void {
    const asset = makeAsset(recipe.name);
    const material = this.material(asset.parameters, recipe.receiveShadow);
    const sway = asset.sway;
    if (sway) {
      const hardShadow = recipe.receiveShadow;
      material.onBeforeCompile = (shader) => this.patchSwayShader(shader, sway, hardShadow);
      material.customProgramCacheKey = () => `ground-sway-${recipe.name}-${hardShadow ? 'hard' : 'stock'}`;
    }
    this.addMesh(recipe.name, builder, asset.geometry, material, recipe.tints, recipe.tilt, recipe.receiveShadow);
  }

  private addMesh(name: string, builder: InstanceBuilder, geometry: BufferGeometry, material: Material, tints: readonly number[], tilt: number, receiveShadow: boolean): void {
    this.geometries.push(geometry);
    if (builder.count === 0) return;
    const mesh = new InstancedMesh(geometry, material, builder.count);
    mesh.name = `ground-clutter-${name}`;
    mesh.receiveShadow = receiveShadow;
    mesh.castShadow = false;
    const position = new Vector3();
    const scale = new Vector3();
    const rotation = new Quaternion();
    const euler = new Euler();
    const matrix = new Matrix4();
    const color = new Color();
    for (let index = 0; index < builder.count; index++) {
      const o = index * 8;
      const d = builder.data;
      position.set(d[o]!, d[o + 1]!, d[o + 2]!);
      euler.set((hash3(index, 1, 0, 601) - 0.5) * tilt, d[o + 3]!, (hash3(index, 2, 0, 601) - 0.5) * tilt);
      rotation.setFromEuler(euler);
      scale.set(d[o + 4]!, d[o + 5]!, d[o + 6]!);
      matrix.compose(position, rotation, scale);
      mesh.setMatrixAt(index, matrix);
      color.setHex(tints[d[o + 7]! % tints.length]!).multiplyScalar(0.88 + 0.24 * hash3(index, 3, 0, 601));
      mesh.setColorAt(index, color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
    this.meshes.push(mesh);
    this.triangles += builder.count * triangleCount(geometry);
  }

  private addGlow(sites: ReadonlyArray<{ x: number; z: number }>): void {
    if (sites.length === 0) return;
    const caps = new InstanceBuilder();
    const halos = new InstanceBuilder();
    for (const [siteIndex, site] of sites.entries()) {
      const y = this.field.sample(site.x, site.z);
      const members = 3 + Math.floor(hash3(siteIndex, 0, 0, 701) * 3);
      for (let member = 0; member < members; member++) {
        const around = hash3(siteIndex, member, 1, 701) * Math.PI * 2;
        const radius = 0.05 + 0.22 * hash3(siteIndex, member, 2, 701);
        const size = 0.9 + 1.5 * hash3(siteIndex, member, 3, 701);
        caps.push(site.x + Math.cos(around) * radius, y - 0.005, site.z + Math.sin(around) * radius, around, size, size, size, 0);
      }
      halos.push(site.x, y + 0.03, site.z, hash3(siteIndex, 0, 4, 701) * 6, 1, 1, 1, 0);
    }
    const stemGeometry = new CylinderGeometry(0.011, 0.016, 0.07, 5, 1, false);
    stemGeometry.translate(0, 0.035, 0);
    const capGeometry = new SphereGeometry(0.045, 6, 2, 0, Math.PI * 2, 0, Math.PI / 2);
    capGeometry.scale(1, 0.62, 1);
    capGeometry.translate(0, 0.066, 0);
    const stemMaterial = this.material({ color: 0xcfe8dc, emissive: 0x2f6f62, emissiveIntensity: 0.35 }, false);
    const capMaterial = this.material({ color: 0x15423c, emissive: 0x58f2d0, emissiveIntensity: GLOW_EMISSIVE_INTENSITY }, false);
    this.addMesh('glow-stems', caps, stemGeometry, stemMaterial, [0xffffff], 0.2, false);
    this.addMesh('glow-caps', caps, capGeometry, capMaterial, [0xffffff], 0.2, false);

    const haloGeometry = new PlaneGeometry(1.7, 1.7).rotateX(-Math.PI / 2);
    const haloMaterial = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: { uColor: { value: new Color(0x2fe0b8).multiplyScalar(0.55) } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform vec3 uColor; varying vec2 vUv;
void main() {
  float d = clamp(length(vUv - 0.5) * 2.0, 0.0, 1.0);
  float a = pow(1.0 - d, 2.4);
  gl_FragColor = vec4(uColor * a, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
    });
    this.materials.push(haloMaterial);
    this.addMesh('glow-halos', halos, haloGeometry, haloMaterial, [0xffffff], 0, false);
    const halo = this.meshes[this.meshes.length - 1];
    if (halo) halo.renderOrder = 2;
  }

  private patchSwayShader(shader: WebGLProgramParametersWithUniforms, sway: { readonly height: number; readonly x: number; readonly z: number }, hardShadow: boolean): void {
    shader.uniforms.uWindTime = this.wind;
    if (hardShadow) shader.fragmentShader = withCheapShadows(shader.fragmentShader, 'hard');
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uWindTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
float swayHeight = clamp(position.y / ${sway.height.toFixed(3)}, 0.0, 1.0);
vec2 swayPhase = instanceMatrix[3].xz;
transformed.x += sin(uWindTime * 1.1 + swayPhase.x * 0.4 + swayPhase.y * 0.3) * ${sway.x.toFixed(3)} * swayHeight * swayHeight;
transformed.z += cos(uWindTime * 0.9 + swayPhase.x * 0.3 - swayPhase.y * 0.4) * ${sway.z.toFixed(3)} * swayHeight * swayHeight;`);
  }
}
