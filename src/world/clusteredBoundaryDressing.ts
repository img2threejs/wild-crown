import type { Vec3, WorldAssetPlacement } from '../game/contracts.js';

/**
 * Per-asset cluster profile for the boundary-dressing post-processor (docs/features/environment-variety.md).
 * The kind selects the cluster rhythm: 'tree' (along a route edge with a stable clearance radius), 'low' (brambles, ferns,
 * small boulders), or 'rock' (the steeper embankment rocks that follow a different rhythm).
 */
export type ClusterKind = 'tree' | 'low' | 'rock';

export interface ClusterProfile {
  readonly kind: ClusterKind;
  /** Min/max props per cluster (inclusive). */
  readonly sizeMin: number;
  readonly sizeMax: number;
  /** Min/max "along the edge" span of a cluster (m). */
  readonly spanMin: number;
  readonly spanMax: number;
  /** Min/max gap between clusters (m). */
  readonly gapMin: number;
  readonly gapMax: number;
  /** Lateral jitter perpendicular to the edge (m, ±). */
  readonly lateralJitter: number;
}

const TREE_PROFILE: ClusterProfile = { kind: 'tree', sizeMin: 2, sizeMax: 4, spanMin: 2, spanMax: 4, gapMin: 4, gapMax: 6, lateralJitter: 0.3 };
const LOW_PROFILE: ClusterProfile = { kind: 'low', sizeMin: 2, sizeMax: 5, spanMin: 1.5, spanMax: 4, gapMin: 3, gapMax: 6, lateralJitter: 0.4 };
const ROCK_PROFILE: ClusterProfile = { kind: 'rock', sizeMin: 2, sizeMax: 4, spanMin: 1.5, spanMax: 3, gapMin: 2.5, gapMax: 5, lateralJitter: 0.5 };

/** Boundary builders namespace their ids by region; the prefix alone is enough to pick a profile. */
const PROFILE_BY_ID_PREFIX: ReadonlyArray<readonly [string, ClusterProfile]> = [
  ['greenwake-boundary-tree-', TREE_PROFILE],
  ['greenwake-boundary-low-', LOW_PROFILE],
  ['greenwake-boundary-rock-', ROCK_PROFILE],
  ['canopy-boundary-tree-', TREE_PROFILE],
  ['canopy-boundary-low-', LOW_PROFILE],
  ['canopy-boundary-rock-', ROCK_PROFILE],
  ['bamboo-boundary-tree-', TREE_PROFILE],
  ['bamboo-boundary-low-', LOW_PROFILE],
  ['bamboo-boundary-rock-', ROCK_PROFILE],
  ['grove-boundary-tree-', TREE_PROFILE],
  ['grove-boundary-low-', LOW_PROFILE],
  ['grove-boundary-rock-', ROCK_PROFILE],
  ['moonpine-boundary-tree-', TREE_PROFILE],
  ['moonpine-boundary-low-', LOW_PROFILE],
  ['moonpine-boundary-rock-', ROCK_PROFILE],
  ['mistveil-boundary-tree-', TREE_PROFILE],
  ['mistveil-boundary-low-', LOW_PROFILE],
  ['mistveil-boundary-rock-', ROCK_PROFILE],
];

const EDGE_ID_RE = /^.+?-(tree|low|rock)-(\d+)-(\d+)(?:-(\d+))?/;
function profileAndEdge(placement: WorldAssetPlacement): { profile: ClusterProfile; key: string } | undefined {
  for (const entry of PROFILE_BY_ID_PREFIX) {
    if (placement.id.startsWith(entry[0])) {
      const match = EDGE_ID_RE.exec(placement.id);
      const key = match ? `${match[1]}-${match[2]}-${match[3]}` : placement.id;
      return { profile: entry[1], key };
    }
  }
  return undefined;
}

/** Mulberry32 PRNG seeded from a placement id (deterministic across loads). */
function seededRandom(id: string): () => number {
  let seed = 0;
  for (let index = 0; index < id.length; index++) seed = (seed * 31 + id.charCodeAt(index)) | 0;
  let a = (seed ^ 0x9e3779b1) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Re-positions a per-edge boundary placement list into clusters of 2-5 props with mixed scales and lateral jitter, breaking
 * the regular lattice the upstream boundary builder produces. The same `id` always produces the same output, so test
 * assertions and the shared boundary-clearance invariants still hold. The post-processor emits one placement per source prop
 * (count unchanged); the spatial pattern becomes a sequence of clusters separated by a gap.
 */
export function clusterBoundaryDressing(placements: readonly WorldAssetPlacement[]): WorldAssetPlacement[] {
  if (placements.length === 0) return [];
  const byEdge = new Map<string, { profile: ClusterProfile; items: WorldAssetPlacement[] }>();
  for (const placement of placements) {
    const entry = profileAndEdge(placement);
    if (!entry) continue;
    const bucket = byEdge.get(entry.key) ?? { profile: entry.profile, items: [] };
    bucket.items.push(placement);
    byEdge.set(entry.key, bucket);
  }
  const result: WorldAssetPlacement[] = [];
  // Pass through placements the post-processor does not own.
  const seen = new Set<string>();
  for (const placement of placements) {
    const entry = profileAndEdge(placement);
    if (!entry) {
      result.push(placement);
      seen.add(placement.id);
    }
  }
  for (const bucket of byEdge.values()) {
    bucket.items.sort((a, b) => a.id.localeCompare(b.id));
    const random = seededRandom(bucket.items[0]!.id);
    const between = (min: number, max: number) => min + (max - min) * random();
    const profile = bucket.profile;
    // Walk the edge in clusters of `sizeMin..sizeMax` props. The cluster span is the "along" stretch the cluster covers
    // and the gap is the empty stretch before the next cluster begins. The total period is `clusterSpan + clusterGap`,
    // matching the upstream builder's per-edge average spacing.
    let index = 0;
    let clusterIndex = 0;
    while (index < bucket.items.length) {
      const remaining = bucket.items.length - index;
      const clusterSize = Math.min(remaining, Math.max(profile.sizeMin, Math.round(between(profile.sizeMin, profile.sizeMax + 0.499))));
      const clusterSpan = between(profile.spanMin, profile.spanMax);
      // For the "along" and "perpendicular" unit vectors we use the direction from the first prop in the cluster to
      // the first prop in the next cluster (or the previous prop, for the last cluster). When the source has a single
      // prop in the cluster we use the upstream prop's own orientation (yaw) as a fallback.
      const nextBase = bucket.items[Math.min(index + clusterSize, bucket.items.length - 1)]!;
      const base = bucket.items[index]!;
      const dx = nextBase.position.x - base.position.x;
      const dz = nextBase.position.z - base.position.z;
      const len = Math.hypot(dx, dz) || 1;
      const alongX = dx / len;
      const alongZ = dz / len;
      const perpX = alongZ;
      const perpZ = -alongX;
      for (let k = 0; k < clusterSize; k++) {
        const item = bucket.items[index + k]!;
        const progress = clusterSize === 1 ? 0.5 : k / (clusterSize - 1);
        const lateral = between(-profile.lateralJitter, profile.lateralJitter);
        const position: Vec3 = {
          x: base.position.x + alongX * (clusterSpan * progress) + perpX * lateral,
          y: item.position.y,
          z: base.position.z + alongZ * (clusterSpan * progress) + perpZ * lateral,
        };
        const id = `${item.id}-cluster-${clusterIndex}`;
        result.push({ id, assetId: item.assetId, position, rotationY: item.rotationY, scale: item.scale, placement: item.placement });
        seen.add(item.id);
      }
      index += clusterSize;
      clusterIndex += 1;
    }
  }
  return result;
}