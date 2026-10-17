/**
 * Establishing-shot geometry shared by `CameraDirector` (which poses the camera) and `GameRenderer` (which plans the start pose and
 * the fog). Pure numbers, no scene access, so the planner can be tested against synthetic regions.
 */
export interface Point3 { readonly x: number; readonly y: number; readonly z: number }

/** The fixed gameplay camera offset from its target, and the azimuth/horizontal radius it implies.
 * Closer and steeper than the previous (10, 12, 14) framing — ~14 m follow distance, ~30.5° elevation, ~35° azimuth.
 * The azimuth is preserved (`atan2(x, z)` matches the old value within ~0.5°), so the screen-relative input basis feel
 * is unchanged; the camera just sits closer and a little lower, and the lens is 1.5° wider to read impacts at the
 * shorter distance.
 */
export const GAMEPLAY_OFFSET: Point3 = { x: 7, y: 7.2, z: 10 };
export const GAMEPLAY_AZIMUTH = Math.atan2(GAMEPLAY_OFFSET.x, GAMEPLAY_OFFSET.z);
export const GAMEPLAY_RADIUS = Math.hypot(GAMEPLAY_OFFSET.x, GAMEPLAY_OFFSET.z);
/** Lens (deg) the gameplay view uses when nothing else is overriding it (establishing and reveal both delta this). */
export const GAMEPLAY_FOV = 49.5;
/** The sweep opens on a lens this many degrees narrower than gameplay and widens with the ease. */
export const SHOT_FOV_DELTA = -6;

/** Where the establishing shot starts. The camera ends on the gameplay offset around the gameplay target. */
export interface EstablishingFraming {
  /** Point on the ground the orbit looks at when it starts. */
  readonly center: Readonly<Point3>;
  /** Horizontal distance (m) from `center` and height (m) above it at the start of the sweep. */
  readonly radius: number;
  readonly height: number;
  /** Start azimuth minus the gameplay azimuth (rad, signed): the sweep turns the camera by this much around the target. */
  readonly sweep: number;
}

export interface ShotPose { px: number; py: number; pz: number; lx: number; ly: number; lz: number }

export const easeInOutCubic = (t: number): number => t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

/**
 * Camera position and look point at eased progress `eased` (0 = region orbit, 1 = gameplay). Azimuth, horizontal distance, height
 * above the look point and the look point itself interpolate from the framing to the gameplay offset around `target`.
 */
export function shotPose(framing: EstablishingFraming, target: Readonly<Point3>, eased: number, out: ShotPose): ShotPose {
  const azimuth = GAMEPLAY_AZIMUTH + framing.sweep * (1 - eased);
  const radius = framing.radius + (GAMEPLAY_RADIUS - framing.radius) * eased;
  const height = framing.height + (GAMEPLAY_OFFSET.y - framing.height) * eased;
  out.lx = framing.center.x + (target.x - framing.center.x) * eased;
  out.ly = framing.center.y + (target.y - framing.center.y) * eased;
  out.lz = framing.center.z + (target.z - framing.center.z) * eased;
  out.px = out.lx + Math.sin(azimuth) * radius;
  out.py = out.ly + height;
  out.pz = out.lz + Math.cos(azimuth) * radius;
  return out;
}

export interface FogRange { readonly near: number; readonly far: number }
/** Linear fog (smoothstep) reaches 90 % opacity at about 80.4 % of the way from near to far and 70 % at about 64 %; the edge check uses 82 % (about 92 % opacity) so the sampling between steps keeps the 90 % guarantee. */
const FOG_EDGE = 0.82;
const FOG_70 = 0.64;
export interface ShotPlanInput {
  /** The look point the orbit opens on (already leaned toward the player). */
  readonly look: Readonly<Point3>;
  /** The gameplay camera target (player root plus the torso offset). */
  readonly target: Readonly<Point3>;
  /** Horizontal diagonal (m) of the walkable surfaces. */
  readonly diagonal: number;
  /** Height (m) of the tallest static prop around the look point above the look point; 0 when none. */
  readonly tallest: number;
  /** Horizontal extents the drawn terrain covers; a ray landing outside them shows the edge of the world. */
  readonly terrain: { readonly minX: number; readonly maxX: number; readonly minZ: number; readonly maxZ: number };
  /** Ground plane height (m) the frame rays are cast against. */
  readonly groundY: number;
  readonly fovDegrees: number;
  readonly aspect: number;
  readonly fog: FogRange | null;
}

export interface ShotPlan { readonly framing: EstablishingFraming; readonly fogSpread: number; readonly distance: number }

const SAMPLES = 40;
/** The sweep is checked up to this eased progress; beyond it the pose is within 20 % of the gameplay framing, whose own view of the edge is not the shot's to change. */
const SAMPLE_SPAN = 0.8;
/** The opening orbit starts at least this far from its look point (m). With the closer 14 m gameplay pose the worst
 *  measured edge-fog coverage across the nine trial regions is 83 % (canopy); the contract is ≥70 %. */
const MIN_DISTANCE = 40;
/** The orbit never starts further than this from its look point. */
export const MAX_SHOT_DISTANCE = 80;
const MIN_SWEEP = 1.2;
const SWEEP_CHOICES = [1.2, 1.9, 2.6] as const;
const MAX_SPREAD = 3;

const pose: ShotPose = { px: 0, py: 0, pz: 0, lx: 0, ly: 0, lz: 0 };

export interface EdgeCheck {
  /** Largest fog spread that keeps every ray past the terrain at least 90 % fogged (below 1: even the authored fog is too thin; -Infinity: no fog can hide it; Infinity: no ray leaves the terrain). */
  readonly safeSpread: number;
  /** Frame rays that land past the terrain, summed over the sampled steps. */
  readonly exposedRays: number;
}

/**
 * Checks one candidate against the edge of the drawn terrain: how many frame rays (the four corners and the middle of the top edge,
 * cast against the ground plane) land past it over the sampled steps of the sweep (eased progress 0 to 0.8), and the largest fog spread (scale of near/far at
 * the start of the sweep, eased back to 1) for which all of them are still at least 90 % fogged at their step.
 */
export function checkShotEdge(framing: EstablishingFraming, input: ShotPlanInput): EdgeCheck {
  let safe = Infinity, exposedRays = 0;
  const { target, terrain, groundY, aspect, fog } = input;
  const fogEdge = fog ? fog.near + FOG_EDGE * (fog.far - fog.near) : 0;
  for (let step = 0; step < SAMPLES; step++) {
    const eased = step / SAMPLES * SAMPLE_SPAN;
    shotPose(framing, target, eased, pose);
    let fx = pose.lx - pose.px, fy = pose.ly - pose.py, fz = pose.lz - pose.pz;
    const length = Math.hypot(fx, fy, fz);
    fx /= length; fy /= length; fz /= length;
    // right = forward × up (no vertical component), up' = right × forward
    let rx = -fz, rz = fx;
    const rLength = Math.hypot(rx, rz);
    rx /= rLength; rz /= rLength;
    const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
    const tanV = Math.tan((input.fovDegrees + SHOT_FOV_DELTA * (1 - eased)) * Math.PI / 360), tanH = tanV * aspect;
    for (let ray = 0; ray < 5; ray++) {
      const sx = ray === 4 ? 0 : ray % 2 === 0 ? -1 : 1, sy = ray === 4 ? 1 : ray < 2 ? 1 : -1;
      const dx = fx + sx * tanH * rx + sy * tanV * ux, dy = fy + sy * tanV * uy, dz = fz + sx * tanH * rz + sy * tanV * uz;
      if (dy >= -1e-6) return { safeSpread: -Infinity, exposedRays: Infinity };
      const t = (groundY - pose.py) / dy;
      const hitX = pose.px + dx * t, hitZ = pose.pz + dz * t;
      if (hitX >= terrain.minX && hitX <= terrain.maxX && hitZ >= terrain.minZ && hitZ <= terrain.maxZ) continue;
      exposedRays++;
      if (!fog) { safe = -Infinity; continue; }
      const depth = t * (dx * fx + dy * fy + dz * fz);
      const ratio = depth / fogEdge;
      // k(e) = 1 + (spread - 1)(1 - e) must not push the edge-fog distance beyond this ray's depth.
      safe = Math.min(safe, eased < 1 ? 1 + (ratio - 1) / (1 - eased) : Infinity);
    }
  }
  return { safeSpread: safe, exposedRays };
}

/**
 * Chooses the opening orbit. Candidates are a few distances (44–80 m, the largest fitting the walkable diagonal), sweeps (±1.2, ±1.9,
 * ±2.6 rad) and two pitches (the base pitch and 8° steeper); each is checked with `checkShotEdge`. A candidate is acceptable when the
 * spread it allows reaches the spread needed to keep the look point legible (fog 70 % distance ≥ 1.3× the start distance, at most 3×).
 * Among acceptable candidates the one with the fewest rays past the terrain wins, then the larger distance and the first frame that
 * looks most toward the region's middle; with none acceptable the candidate that leaves the most headroom wins and the fog is spread
 * only as far as it allows.
 */
export function planEstablishingShot(input: ShotPlanInput, middle: Readonly<Point3>): ShotPlan {
  const basePitch = 32 + Math.max(0, Math.min(22, input.tallest - 12));
  const pitches = [basePitch, Math.min(62, basePitch + 8)];
  const widest = Math.max(MIN_DISTANCE, Math.min(MAX_SHOT_DISTANCE, input.diagonal * 0.3 / Math.tan(input.fovDegrees * Math.PI / 360)));
  const distances = [...new Set([widest, widest * 0.85, widest * 0.7, MIN_DISTANCE].map((value) => Math.max(MIN_DISTANCE, Math.round(value * 10) / 10)))].sort((a, b) => b - a);
  const fog = input.fog;
  const fog70 = fog ? fog.near + FOG_70 * (fog.far - fog.near) : Infinity;
  const towardMiddle = Math.atan2(middle.x - input.look.x, middle.z - input.look.z);
  let best: { plan: ShotPlan; acceptable: boolean; score: number } | undefined;
  for (const pitchDegrees of pitches) {
    const pitch = pitchDegrees * Math.PI / 180;
    for (const distance of distances) {
      const needed = Math.max(1, Math.min(MAX_SPREAD, distance * 1.3 / fog70));
      for (const mag of SWEEP_CHOICES) {
        for (const sign of [1, -1]) {
          const framing: EstablishingFraming = { center: input.look, radius: distance * Math.cos(pitch), height: distance * Math.sin(pitch), sweep: sign * Math.max(MIN_SWEEP, mag) };
          const { safeSpread, exposedRays } = checkShotEdge(framing, input);
          const acceptable = safeSpread >= needed - 1e-9;
          // The camera sits on the far side of the look point from where it faces: facing = start azimuth + π.
          const inward = Math.cos(GAMEPLAY_AZIMUTH + framing.sweep + Math.PI - towardMiddle);
          const score = acceptable ? -2 * exposedRays + distance / 10 + 3 * inward - (pitchDegrees - basePitch) / 8 : safeSpread - needed;
          const plan: ShotPlan = { framing, distance, fogSpread: Math.max(1, Math.min(needed, safeSpread, MAX_SPREAD)) };
          if (!best || (acceptable && !best.acceptable) || (acceptable === best.acceptable && score > best.score)) best = { plan, acceptable, score };
        }
      }
    }
  }
  return best!.plan;
}
