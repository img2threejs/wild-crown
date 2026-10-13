import { BufferAttribute, BufferGeometry, DataTexture, Group, LinearFilter, LinearMipmapLinearFilter, Mesh, MeshPhysicalMaterial, RepeatWrapping, SRGBColorSpace, UnsignedByteType, RGBAFormat } from 'three';
import type { FeatureContext, GroundFeature } from './BiomeProfile';
import { hash3 } from './GroundNoise';
import { LAKE, lakeOutline, MOONPINE_LAKE_MATERIAL } from './MoonpineTerrain';

/**
 * The frozen lake (docs/features/moonpine-playtest.md): one flat ice sheet drawn over the lake north of the shore shelf and over
 * the walkable shelf itself (every surface with the lake material), so Aren walks on the same glossy ice the lake is made of.
 * Purely presentational: walkability stays with the walk-mesh, the terrain dish under the sheet only keeps the ground out of it.
 * The sheet lies a hair above the ground (y = 0 on the shelf) with polygon offset against the terrain, and uses one tiling
 * procedural texture (irregular crack networks, deep patches, frost drifts, trapped bubbles); vertex colours darken the lake towards its centre and frost its rim, generated once at 512 x 512.
 */
export const ICE_TEXTURE_SIZE = 512;
/** Metres the lake sheet and the shelf sheet float above y = 0 (the shelf one slightly higher, so it wins the overlap). */
export const ICE_LAKE_Y = 0.008;
export const ICE_SHELF_Y = 0.012;
/** The texture tiles every 12 m. */
export const ICE_TILE_METERS = 12;
const OUTLINE_POINTS = 72;
const SEED = 7013;

/** Value noise on a lattice that wraps every `period` cells, so the texture tiles seamlessly. */
function periodicNoise(x: number, y: number, period: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const wrap = (value: number): number => ((value % period) + period) % period;
  const a = hash3(wrap(ix), wrap(iy), 0, seed), b = hash3(wrap(ix + 1), wrap(iy), 0, seed), c = hash3(wrap(ix), wrap(iy + 1), 0, seed), d = hash3(wrap(ix + 1), wrap(iy + 1), 0, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/**
 * Domain-warped periodic noise: the warp offsets are periodic in (u, v) too, so the field still tiles. Its n = 0.5 contours are
 * irregular wandering curves (never a regular cell grid), which is what the crack networks follow.
 */
function warpedNoise(u: number, v: number, period: number, seed: number, warp: number): number {
  const wx = (periodicNoise(u * period * 0.5, v * period * 0.5, period / 2, seed + 11) - 0.5) * 2 * warp;
  const wy = (periodicNoise(u * period * 0.5 + 3, v * period * 0.5 + 5, period / 2, seed + 17) - 0.5) * 2 * warp;
  return periodicNoise(u * period + wx, v * period + wy, period, seed);
}

/** 1 on the n = 0.5 contour of a warped noise field, falling to 0 over `width`: one connected, irregular crack network. */
function crackLine(u: number, v: number, period: number, seed: number, warp: number, width: number): number {
  const distance = Math.abs(warpedNoise(u, v, period, seed, warp) - 0.5);
  const line = 1 - Math.min(1, distance / width);
  return line * line * (3 - 2 * line);
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/**
 * RGBA8 pixels of the ice texture: blue-white body with large darker deep-water patches and frosty white drifts, three crack
 * networks at different scales (long dark fractures, mid white cracks, faint hairlines; all following wandering contours, so no
 * repeating cells), and trapped bubbles.
 */
export function buildIcePixels(): Uint8Array {
  const size = ICE_TEXTURE_SIZE, pixels = new Uint8Array(size * size * 4);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const u = (col + 0.5) / size, v = (row + 0.5) / size;
      const broad = warpedNoise(u, v, 4, SEED + 1, 0.9), fine = periodicNoise(u * 32, v * 32, 32, SEED + 2), frost = warpedNoise(u, v, 8, SEED + 4, 0.7);
      const deep = clamp01((broad - 0.3) * 2.4);
      const drift = clamp01((frost - 0.62) * 4);
      const major = crackLine(u, v, 2, SEED + 5, 0.8, 0.022) * (0.7 + 0.3 * fine);
      const mid = crackLine(u, v, 5, SEED + 6, 1.4, 0.03) * (0.5 + 0.5 * fine);
      const hair = crackLine(u, v, 13, SEED + 7, 1.8, 0.05) * fine * 0.8;
      const bubble = Math.max(0, periodicNoise(u * 64, v * 64, 64, SEED + 3) - 0.88) * 5;
      let r = 0.74 - 0.3 * deep + 0.05 * fine, g = 0.86 - 0.22 * deep + 0.05 * fine, b = 0.98 - 0.08 * deep;
      // Frosty drifts and white cracks lift towards white; the long fractures are deep blue.
      r += (0.95 - r) * (0.55 * drift + 0.45 * mid + 0.3 * hair) + 0.1 * bubble;
      g += (0.98 - g) * (0.55 * drift + 0.45 * mid + 0.3 * hair) + 0.1 * bubble;
      b += (1 - b) * (0.45 * drift + 0.4 * mid + 0.25 * hair) + 0.08 * bubble;
      r = r * (1 - 0.7 * major) + 0.05 * major;
      g = g * (1 - 0.6 * major) + 0.12 * major;
      b = b * (1 - 0.3 * major) + 0.3 * major;
      const index = (row * size + col) * 4;
      pixels[index] = Math.round(255 * clamp01(r));
      pixels[index + 1] = Math.round(255 * clamp01(g));
      pixels[index + 2] = Math.round(255 * clamp01(b));
      pixels[index + 3] = 255;
    }
  }
  return pixels;
}

/** Radii of the lake rings (fractions of the shoreline) and their vertex colour: dark deep water at the centre, frosted white at the rim. */
export const ICE_LAKE_RINGS: readonly (readonly [number, readonly [number, number, number]])[] = [
  [0, [0.5, 0.64, 0.86]], [0.4, [0.58, 0.72, 0.92]], [0.75, [0.78, 0.88, 1]], [0.92, [0.96, 0.99, 1]], [1, [1, 1, 1]],
];
/** Vertex colour of the walkable shelf sheet: lighter, frosted ice, distinct from the darker lake behind it. */
export const ICE_SHELF_COLOR: readonly [number, number, number] = [0.94, 0.98, 1];

/** Sheet geometry: the lake as concentric rings of the outline (darker towards the centre, frosted at the rim) at y = ICE_LAKE_Y, plus every lake-material walkable as a fan at y = ICE_SHELF_Y; uv = world xz / tile. */
export function buildIceGeometry(shelves: readonly (readonly { readonly x: number; readonly z: number }[])[]): BufferGeometry {
  const positions: number[] = [], uvs: number[] = [], colors: number[] = [], indices: number[] = [];
  const vertex = (x: number, y: number, z: number, color: readonly number[]): number => {
    positions.push(x, y, z); uvs.push(x / ICE_TILE_METERS, z / ICE_TILE_METERS); colors.push(color[0]!, color[1]!, color[2]!);
    return positions.length / 3 - 1;
  };
  const shoelace = (points: readonly { readonly x: number; readonly z: number }[]): number => {
    let area = 0;
    for (let index = 0; index < points.length; index++) { const a = points[index]!, b = points[(index + 1) % points.length]!; area += a.x * b.z - b.x * a.z; }
    return area;
  };
  // Lake: centre vertex, then one ring of OUTLINE_POINTS vertices per radius (the last ring is exactly the shoreline).
  const outline = lakeOutline(OUTLINE_POINTS), flip = shoelace(outline) < 0;
  const centre = vertex(LAKE.x, ICE_LAKE_Y, LAKE.z, ICE_LAKE_RINGS[0]![1]);
  let previous: number[] = [];
  ICE_LAKE_RINGS.forEach(([fraction, color], ringIndex) => {
    if (ringIndex === 0) return;
    const ring = outline.map(point => vertex(LAKE.x + (point.x - LAKE.x) * fraction, ICE_LAKE_Y, LAKE.z + (point.z - LAKE.z) * fraction, color));
    for (let index = 0; index < OUTLINE_POINTS; index++) {
      const next = (index + 1) % OUTLINE_POINTS;
      const innerA = ringIndex === 1 ? centre : previous[index]!, innerB = ringIndex === 1 ? centre : previous[next]!;
      // Faces up (+y) for a positive shoelace area: (inner, outer next, outer current) then (inner, inner next, outer next).
      if (!flip) indices.push(innerA, ring[next]!, ring[index]!, innerA, innerB, ring[next]!);
      else indices.push(innerA, ring[index]!, ring[next]!, innerA, ring[next]!, innerB);
    }
    previous = ring;
  });
  for (const points of shelves) {
    const cx = points.reduce((sum, point) => sum + point.x, 0) / points.length, cz = points.reduce((sum, point) => sum + point.z, 0) / points.length;
    const first = vertex(cx, ICE_SHELF_Y, cz, ICE_SHELF_COLOR);
    const ring = points.map(point => vertex(point.x, ICE_SHELF_Y, point.z, ICE_SHELF_COLOR));
    const shelfFlip = shoelace(points) < 0;
    for (let index = 0; index < points.length; index++) {
      const current = ring[index]!, next = ring[(index + 1) % points.length]!;
      if (!shelfFlip) indices.push(first, next, current); else indices.push(first, current, next);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/** The ice sheet as a ground feature: static, so it ignores the world clock and the reduced-effects setting. */
export class MoonpineIce implements GroundFeature {
  readonly group = new Group();
  readonly mesh: Mesh<BufferGeometry, MeshPhysicalMaterial>;
  private readonly texture: DataTexture;
  private disposed = false;

  constructor(context: FeatureContext) {
    this.group.name = 'moonpine-ice-feature';
    const shelves = context.region.ground.surfaces.filter(surface => surface.walkable && surface.material === MOONPINE_LAKE_MATERIAL).map(surface => surface.points.map(point => ({ x: point.x, z: point.z })));
    this.texture = new DataTexture(buildIcePixels(), ICE_TEXTURE_SIZE, ICE_TEXTURE_SIZE, RGBAFormat, UnsignedByteType);
    this.texture.wrapS = this.texture.wrapT = RepeatWrapping;
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.magFilter = LinearFilter;
    this.texture.minFilter = LinearMipmapLinearFilter;
    this.texture.generateMipmaps = true;
    this.texture.anisotropy = 4;
    this.texture.needsUpdate = true;
    // Cold glossy ice: low roughness picks up the sun's glint, a faint blue emissive keeps the shade side from going black.
    const material = new MeshPhysicalMaterial({ map: this.texture, vertexColors: true, roughness: 0.14, metalness: 0, clearcoat: 0.7, clearcoatRoughness: 0.12, emissive: 0x16304a, emissiveIntensity: 0.45, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    material.name = 'moonpine-ice';
    this.mesh = new Mesh(buildIceGeometry(shelves), material);
    this.mesh.name = 'moonpine-ice';
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
  }

  update(): void {}

  setReducedEffects(): void {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.texture.dispose();
  }
}

export function createMoonpineIce(context: FeatureContext): GroundFeature {
  return new MoonpineIce(context);
}
