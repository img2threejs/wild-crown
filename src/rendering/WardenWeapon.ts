import { BufferAttribute, BufferGeometry, Color, Group, Matrix4, Mesh, MeshStandardMaterial, Object3D, Quaternion, Vector3, type Material } from 'three';
import { computeHandGrip, fitRigidNativeHand, referencedVertices, type HandGeometryEdit, type HandGrip, type HiltProfile } from './NativeHandGrip';
import { KATANA_GRIP } from './KatanaGrip.mjs';
export { KATANA_GRIP } from './KatanaGrip.mjs';

/** Manifest id of the Tripo glaive Aren carries (Greenwake playtest manifest; production manifests without it simply skip the weapon). */
export const WARDEN_WEAPON_ASSET_ID = 'prop-warden-glaive';
/** World length of the glaive at Aren's scale, metres. */
export const WARDEN_WEAPON_LENGTH = 1.85;
/** Share of the length between the pommel and the grip point. */
export const WARDEN_GRIP_FRACTION = 0.42;
/** Share of the length (from the blade end) that is the glowing blade: the pale crescent beyond the amber crystal. */
export const WARDEN_BLADE_FRACTION = 0.23;
export const WARDEN_EDGE_COLOR = 0x5fe3ff;
export const WARDEN_EDGE_IDLE_INTENSITY = 0.6;
/** Native blade aim shared with the Aren retargeter; palm placement and shaft thickness come from real hand anatomy. */
export const WARDEN_GRIP = Object.freeze({ tiltRadians: 0.5 });
/**
 * Heartroot staff fist: Yara's Mixamo rig has finger chains, so the staff is gripped like the glaive: the shaft lies along the knuckle line (index base −
 * pinky base, thumb end toward the staff head) and the four fingers wrap it every frame. `diagonalRadians` tips the shaft from the knuckle line toward the
 * wrist.
 */
export const HEARTROOT_GRIP = Object.freeze({ diagonalRadians: 0 });
/** Vesper uses the authoritative captured-motion rigid-fist fit in KatanaGrip.mjs.
 * Weapon +Z points pommel → kissaki; +Y is the spine, -Y the cutting edge.
 */
export const KATANA_EDGE_COLOR = 0x9b5cff;
export const KATANA_EDGE_TIP_COLOR = 0xff2a55;
export type WardenWeaponKind = 'warden' | 'heartroot' | 'katana';

interface WeaponProfile {
  readonly length: number;
  readonly gripFraction: number;
  /** Centre of the fitted handle band (fraction from the pommel); the hand may sit anywhere inside it. */
  readonly shaftFraction: number;
  readonly bladeFraction: number;
  readonly shaftCore: number;
  readonly shaftOuter: number;
  /** Native hand fit: the rigid fingerless fist (true) or the per-frame finger chain wrap (false). */
  readonly rigidFist: boolean;
  readonly tilt: number;
  readonly edgeColor: number;
  readonly name: string;
  /** Which end is the blade: the end with the wider cross-section (glaive crescent) or the long side of the guard (straight sword). */
  readonly orientation: 'crescent' | 'guard';
  /** Katana only: the slender handle runs up to a thin collar right behind the guard instead of flaring back to the native radius. */
  readonly fuchi?: { readonly backFromPommel: number; readonly length: number; readonly scale: number };
}
const WEAPON_PROFILES: Readonly<Record<WardenWeaponKind, WeaponProfile>> = Object.freeze({
  warden: { length: WARDEN_WEAPON_LENGTH, gripFraction: WARDEN_GRIP_FRACTION, shaftFraction: WARDEN_GRIP_FRACTION, bladeFraction: WARDEN_BLADE_FRACTION, shaftCore: .1, shaftOuter: .22, rigidFist: false, tilt: WARDEN_GRIP.tiltRadians, edgeColor: WARDEN_EDGE_COLOR, name: 'wc:warden-weapon', orientation: 'crescent' },
  heartroot: { length: WARDEN_WEAPON_LENGTH, gripFraction: WARDEN_GRIP_FRACTION, shaftFraction: WARDEN_GRIP_FRACTION, bladeFraction: WARDEN_BLADE_FRACTION, shaftCore: .12, shaftOuter: .26, rigidFist: false, tilt: HEARTROOT_GRIP.diagonalRadians, edgeColor: 0xf1ba4a, name: 'wc:heartroot-staff', orientation: 'crescent' },
  katana: { length: KATANA_GRIP.length, gripFraction: KATANA_GRIP.gripFromPommel / KATANA_GRIP.length, shaftFraction: KATANA_GRIP.handleFromPommel / KATANA_GRIP.length, bladeFraction: KATANA_GRIP.bladeLength / KATANA_GRIP.length, shaftCore: .15, shaftOuter: .2, rigidFist: true, tilt: KATANA_GRIP.diagonalRadians, edgeColor: KATANA_EDGE_COLOR, name: 'wc:vesper-katana', orientation: 'guard', fuchi: { backFromPommel: KATANA_GRIP.tsubaBackFromPommel, length: KATANA_GRIP.fuchi.length, scale: KATANA_GRIP.fuchi.scale } },
});

/** Weapon kind for a hero's `weaponGrip` (a hero without a grip declaration carries the Warden glaive). */
export function weaponKindForGrip(grip: 'glaive' | 'staff' | 'katana' | undefined): WardenWeaponKind {
  return grip === 'katana' ? 'katana' : grip === 'staff' ? 'heartroot' : 'warden';
}
export const WARDEN_SOCKET_NAMES = ['weapon', 'weapon-base', 'weapon-tip', 'weapon-pommel'] as const;
export type WardenSocketName = typeof WARDEN_SOCKET_NAMES[number];


/** Long-axis frame of the glaive in its own mesh space (all vectors/points in mesh coordinates). */
export interface GlaiveFrame {
  /** Unit vector from the pommel to the blade. */
  readonly axis: Vector3;
  /** Unit vector (⟂ axis) toward which the blade tip bends away from the shaft line. */
  readonly curl: Vector3;
  /** Shaft-line point at the pommel end of the extent. */
  readonly origin: Vector3;
  readonly length: number;
  /** Extreme vertex at the blade end / the pommel end. */
  readonly tip: Vector3;
  readonly pommel: Vector3;
}

const scratchA = new Vector3(), scratchB = new Vector3();

/**
 * Finds the glaive's long axis (principal component of the vertices), which end is the blade (the end whose outer fifth reaches farthest
 * from the shaft line: the crescent versus the spike pommel) and the direction the blade bends.
 */
export function analyzeGlaive(positions: ArrayLike<number>, orientation: 'crescent' | 'guard' = 'crescent'): GlaiveFrame {
  const count = Math.floor(positions.length / 3);
  if (count < 8) throw new Error('The glaive mesh has too few vertices to find its axis.');
  const centre = new Vector3();
  for (let i = 0; i < count; i += 1) centre.add(scratchA.set(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!));
  centre.divideScalar(count);
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (let i = 0; i < count; i += 1) {
    const x = positions[i * 3]! - centre.x, y = positions[i * 3 + 1]! - centre.y, z = positions[i * 3 + 2]! - centre.z;
    xx += x * x; xy += x * y; xz += x * z; yy += y * y; yz += y * z; zz += z * z;
  }
  const axis = new Vector3(0.577, 0.331, 0.749).normalize();
  for (let i = 0; i < 48; i += 1) axis.set(xx * axis.x + xy * axis.y + xz * axis.z, xy * axis.x + yy * axis.y + yz * axis.z, xz * axis.x + yz * axis.y + zz * axis.z).normalize();
  const along = new Float64Array(count);
  let low = Infinity, high = -Infinity;
  for (let i = 0; i < count; i += 1) {
    along[i] = scratchA.set(positions[i * 3]! - centre.x, positions[i * 3 + 1]! - centre.y, positions[i * 3 + 2]! - centre.z).dot(axis);
    low = Math.min(low, along[i]!); high = Math.max(high, along[i]!);
  }
  const span = high - low;
  if (!(span > 0)) throw new Error('The glaive mesh has no extent along its axis.');
  // Shaft centre line: mean perpendicular offset of the middle of the length (never the blade or pommel).
  const shaft = new Vector3();
  let shaftCount = 0;
  for (let i = 0; i < count; i += 1) {
    const t = (along[i]! - low) / span;
    if (t < 0.3 || t > 0.7) continue;
    shaft.add(perpendicular(positions, i, centre, axis, along[i]!, scratchA));
    shaftCount += 1;
  }
  if (shaftCount) shaft.divideScalar(shaftCount);
  let bladeAtLow: boolean;
  if (orientation === 'guard') {
    // A straight sword: the guard is the widest cross-section away from the extremes; the blade is the longer side of it.
    const BINS = 32, binReach = new Float64Array(BINS);
    for (let i = 0; i < count; i += 1) {
      const t = (along[i]! - low) / span;
      const bin = Math.min(BINS - 1, Math.floor(t * BINS));
      binReach[bin] = Math.max(binReach[bin]!, perpendicular(positions, i, centre, axis, along[i]!, scratchA).sub(shaft).length());
    }
    let guardBin = Math.floor(BINS * 0.1), guardReach = -1;
    for (let bin = Math.floor(BINS * 0.1); bin < Math.ceil(BINS * 0.9); bin += 1) if (binReach[bin]! > guardReach) { guardReach = binReach[bin]!; guardBin = bin; }
    bladeAtLow = (guardBin + 0.5) / BINS > 0.5;
  } else {
    let lowReach = 0, highReach = 0;
    for (let i = 0; i < count; i += 1) {
      const t = (along[i]! - low) / span;
      if (t > 0.22 && t < 0.78) continue;
      const reach = perpendicular(positions, i, centre, axis, along[i]!, scratchA).sub(shaft).length();
      if (t <= 0.22) lowReach = Math.max(lowReach, reach); else highReach = Math.max(highReach, reach);
    }
    bladeAtLow = lowReach > highReach;
  }
  if (bladeAtLow) { axis.negate(); for (let i = 0; i < count; i += 1) along[i] = -along[i]!; [low, high] = [-high, -low]; }
  let tipIndex = 0, pommelIndex = 0;
  for (let i = 0; i < count; i += 1) {
    if (along[i]! > along[tipIndex]!) tipIndex = i;
    if (along[i]! < along[pommelIndex]!) pommelIndex = i;
  }
  const origin = centre.clone().add(shaft).addScaledVector(axis, low);
  const tip = new Vector3(positions[tipIndex * 3]!, positions[tipIndex * 3 + 1]!, positions[tipIndex * 3 + 2]!);
  const pommel = new Vector3(positions[pommelIndex * 3]!, positions[pommelIndex * 3 + 1]!, positions[pommelIndex * 3 + 2]!);
  const curl = tip.clone().sub(origin);
  curl.addScaledVector(axis, -curl.dot(axis));
  if (curl.lengthSq() < 1e-12) curl.set(1, 0, 0).addScaledVector(axis, -axis.x);
  if (curl.lengthSq() < 1e-12) curl.set(0, 1, 0).addScaledVector(axis, -axis.y);
  return { axis, curl: curl.normalize(), origin, length: span, tip, pommel };
}

function perpendicular(positions: ArrayLike<number>, i: number, centre: Vector3, axis: Vector3, along: number, out: Vector3): Vector3 {
  return out.set(positions[i * 3]! - centre.x, positions[i * 3 + 1]! - centre.y, positions[i * 3 + 2]! - centre.z).addScaledVector(axis, -along);
}

/** Orthonormal basis (x = y × z) whose z is `axis` and y the part of `curl` perpendicular to it. */
function basisOf(axis: Vector3, curl: Vector3): Matrix4 {
  const z = axis.clone().normalize(), y = curl.clone().addScaledVector(z, -curl.dot(z)).normalize(), x = new Vector3().crossVectors(y, z);
  return new Matrix4().makeBasis(x, y, z);
}

const FUCHI_BLEND = .003, FUCHI_GUARD_BLEED = .0005, FUCHI_RADIUS_FULL = .041, FUCHI_RADIUS_NONE = .05;
const smoothUnit = (t: number): number => { const u = Math.max(0, Math.min(1, t)); return u * u * (3 - 2 * u); };
/** Radial gain of the katana hilt `metres` from the pommel and its derivative per metre: the fitted `reduction` up to the fuchi, the fuchi's thin collar behind the guard, native again beyond it. */
function fuchiGain(fuchi: NonNullable<WeaponProfile['fuchi']>, reduction: number, metres: number, slope: { value: number }): number {
  const start = fuchi.backFromPommel - fuchi.length, peak = Math.min(1, reduction * fuchi.scale), end = fuchi.backFromPommel + FUCHI_GUARD_BLEED;
  let t: number;
  if (metres <= start) { slope.value = 0; return reduction; }
  if (metres < start + FUCHI_BLEND) { t = (metres - start) / FUCHI_BLEND; slope.value = (peak - reduction) * 6 * t * (1 - t) / FUCHI_BLEND; return reduction + (peak - reduction) * smoothUnit(t); }
  if (metres <= end) { slope.value = 0; return peak; }
  if (metres < end + FUCHI_BLEND) { t = (metres - end) / FUCHI_BLEND; slope.value = (1 - peak) * 6 * t * (1 - t) / FUCHI_BLEND; return peak + (1 - peak) * smoothUnit(t); }
  slope.value = 0;
  return 1;
}
const fuchiSlope = { value: 0 };

/** Fit the native handle continuously; the measurement band excludes decorative collars and the blade. */
function fitShaft(geometry: BufferGeometry, frame: GlaiveFrame, radius: number, profile: WeaponProfile): void {
  const position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal');
  const scale = profile.length / frame.length;
  const center = frame.origin.clone().addScaledVector(frame.axis, profile.shaftFraction * frame.length);
  const core = profile.shaftCore / scale, outer = profile.shaftOuter / scale;
  const measureCore = Math.min(core, .1 / scale);
  let maximum = 0;
  for (const vertex of referencedVertices(geometry)) {
    scratchA.fromBufferAttribute(position, vertex).sub(center);
    const along = scratchA.dot(frame.axis);
    if (Math.abs(along) > measureCore) continue;
    maximum = Math.max(maximum, scratchA.addScaledVector(frame.axis, -along).length() * scale);
  }
  const reduction = Math.min(1, radius / maximum);
  if (reduction >= 1) return;
  const fuchi = profile.fuchi, fromPommel = profile.shaftFraction * profile.length;
  for (let vertex = 0; vertex < position.count; vertex++) {
    scratchA.fromBufferAttribute(position, vertex).sub(center);
    const along = scratchA.dot(frame.axis);
    const front = fuchi !== undefined && along > 0;
    if (!front && Math.abs(along) >= outer) continue;
    scratchA.addScaledVector(frame.axis, -along);
    let gain: number, derivative: number;
    if (front) {
      // The tube of the handle and fuchi is radius-selected: the guard disc itself (radius beyond FUCHI_RADIUS_NONE) never moves.
      const weight = 1 - smoothUnit((scratchA.length() * scale - FUCHI_RADIUS_FULL) / (FUCHI_RADIUS_NONE - FUCHI_RADIUS_FULL));
      const raw = fuchiGain(fuchi, reduction, fromPommel + along * scale, fuchiSlope);
      gain = 1 + (raw - 1) * weight;
      derivative = fuchiSlope.value * weight * scale;
    } else {
      const t = Math.max(0, Math.min(1, (Math.abs(along) - core) / (outer - core)));
      gain = reduction + (1 - reduction) * t * t * (3 - 2 * t);
      derivative = (1 - reduction) * 6 * t * (1 - t) / (outer - core) * Math.sign(along);
    }
    if (gain === 1 && derivative === 0) continue;
    if (normal) {
      scratchB.fromBufferAttribute(normal, vertex);
      const axial = scratchB.dot(frame.axis);
      scratchB.addScaledVector(frame.axis, -axial);
      const corrected = axial - derivative / gain * scratchB.dot(scratchA);
      scratchB.multiplyScalar(1 / gain).addScaledVector(frame.axis, corrected).normalize();
      normal.setXYZ(vertex, scratchB.x, scratchB.y, scratchB.z);
    }

    scratchA.multiplyScalar(gain).addScaledVector(frame.axis, along).add(center);
    position.setXYZ(vertex, scratchA.x, scratchA.y, scratchA.z);
  }
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
}

/** Hilt radius per 2 mm slice behind the guard's back face, measured on the fitted mesh (metres from the seat along the blade axis); the fist keeps its skin outside it. */
const HILT_PROFILE_FROM = -.16, HILT_PROFILE_STEP = .002;
function measureHiltProfile(geometry: BufferGeometry, frame: GlaiveFrame, profile: WeaponProfile): HiltProfile | undefined {
  const fuchi = profile.fuchi;
  if (!fuchi) return undefined;
  const position = geometry.getAttribute('position'), scale = profile.length / frame.length, seat = profile.gripFraction * profile.length;
  const to = fuchi.backFromPommel - seat - FUCHI_GUARD_BLEED, bins = Math.ceil((to - HILT_PROFILE_FROM) / HILT_PROFILE_STEP) + 1, radius = new Float32Array(bins);
  for (const vertex of referencedVertices(geometry)) {
    scratchA.fromBufferAttribute(position, vertex).sub(frame.origin);
    const along = scratchA.dot(frame.axis), z = along * scale - seat;
    if (z < HILT_PROFILE_FROM || z > to) continue;
    const r = scratchA.addScaledVector(frame.axis, -along).length() * scale;
    if (r > FUCHI_RADIUS_FULL) continue;
    const bin = Math.max(0, Math.min(bins - 1, Math.round((z - HILT_PROFILE_FROM) / HILT_PROFILE_STEP)));
    radius[bin] = Math.max(radius[bin]!, r);
  }
  // A slice a vertex fell between takes its widest neighbour; every slice also takes its neighbours' widest value, so the profile is a safe envelope.
  const envelope = new Float32Array(bins);
  for (let bin = 0; bin < bins; bin++) envelope[bin] = Math.max(radius[Math.max(0, bin - 1)]!, radius[bin]!, radius[Math.min(bins - 1, bin + 1)]!);
  return { from: HILT_PROFILE_FROM, step: HILT_PROFILE_STEP, radius: envelope };
}

/**
 * The glaive geometry cut in two draw groups by the long axis: everything from the blade start to the tip (group 1, the glowing edge) and the
 * rest (group 0). The result owns all its buffers.
 */
export function splitBladeGeometry(source: BufferGeometry, frame: GlaiveFrame, bladeFraction: number = WARDEN_BLADE_FRACTION): BufferGeometry {
  const position = source.getAttribute('position'), normal = source.getAttribute('normal'), uv = source.getAttribute('uv');
  const vertices = position.count, copy = (attribute: typeof position | undefined, size: number): BufferAttribute | undefined => {
    if (!attribute) return undefined;
    const values = new Float32Array(vertices * size);
    for (let i = 0; i < vertices; i += 1) for (let c = 0; c < size; c += 1) values[i * size + c] = c === 0 ? attribute.getX(i) : c === 1 ? attribute.getY(i) : attribute.getZ(i);
    return new BufferAttribute(values, size);
  };
  const geometry = new BufferGeometry();
  const positions = copy(position, 3)!;
  geometry.setAttribute('position', positions);
  const normals = copy(normal, 3);
  if (normals) geometry.setAttribute('normal', normals);
  if (uv) {
    const uvs = new Float32Array(vertices * 2);
    for (let i = 0; i < vertices; i += 1) { uvs[i * 2] = uv.getX(i); uvs[i * 2 + 1] = uv.getY(i); }
    geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  }
  const triangles = source.index ? source.index.count / 3 : vertices / 3;
  const read = (corner: number): number => (source.index ? source.index.getX(corner) : corner);
  const bladeStart = (1 - bladeFraction) * frame.length;
  const body: number[] = [], edge: number[] = [];
  for (let triangle = 0; triangle < triangles; triangle += 1) {
    const a = read(triangle * 3), b = read(triangle * 3 + 1), c = read(triangle * 3 + 2);
    const centroid = scratchA.set(0, 0, 0).add(scratchB.fromBufferAttribute(positions, a)).add(scratchB.fromBufferAttribute(positions, b)).add(scratchB.fromBufferAttribute(positions, c)).divideScalar(3);
    ((centroid.sub(frame.origin).dot(frame.axis) >= bladeStart ? edge : body)).push(a, b, c);
  }
  const index = new (vertices > 65535 ? Uint32Array : Uint16Array)(body.length + edge.length);
  index.set(body); index.set(edge, body.length);
  geometry.setIndex(new BufferAttribute(index, 1));
  geometry.addGroup(0, body.length, 0);
  if (edge.length) geometry.addGroup(body.length, edge.length, 1);
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}


/** The part of the glaive instance the weapon uses; a `NativeAssetInstance` satisfies it. */
export interface WeaponSource { readonly root: Object3D; dispose(): void }
export interface WeaponOwner { readonly root: Object3D; readonly animation: { setPostPose(hook: (() => void) | undefined): void } }

const KATANA_EDGE_TINT = new Vector3();

/**
 * Blade profile of the katana, relative to the model's own proportions. Tripo's blade is a stylised slab (about 6 cm wide and 3 cm thick at 1.25 m); this
 * reshapes it once at load into a slender wedge: narrower, with the thickness falling from `spineThickness` at the spine to `edgeThickness` at the cutting
 * edge, faded in over `ramp` of the length around the blade start so the tsuba and habaki keep their authored shape. UVs and topology are untouched.
 */
const KATANA_BLADE = Object.freeze({ widthScale: 0.62, edgeThickness: 0.05, spineThickness: 0.27, rampBefore: 0.012, rampAfter: 0.04, bins: 48, quantile: 0.08 });

/**
 * Thins and narrows the katana blade into a wedge and writes `wcEdgeSide` (0 on the cutting edge, 1 on the spine, per slice along the blade) for every vertex
 * (1 outside the blade). The frame's `curl` points at the spine (the tip bends toward it), so the edge lies on the -curl side.
 */
function sharpenKatanaBlade(geometry: BufferGeometry, frame: GlaiveFrame, profile: WeaponProfile): void {
  const position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal');
  const count = position.count, bins = KATANA_BLADE.bins;
  const bladeStart = (1 - profile.bladeFraction) * frame.length;
  const from = bladeStart - KATANA_BLADE.rampBefore * frame.length, rampSpan = (KATANA_BLADE.rampBefore + KATANA_BLADE.rampAfter) * frame.length;
  const thickness = scratchB.copy(frame.curl).cross(frame.axis).normalize().clone();
  const low = new Float64Array(bins).fill(Infinity), high = new Float64Array(bins).fill(-Infinity), flatLow = new Float64Array(bins), flatHigh = new Float64Array(bins);
  const flats: number[][] = Array.from({ length: bins }, () => []);
  const along = new Float64Array(count), width = new Float64Array(count), flat = new Float64Array(count), slot = new Int32Array(count);
  for (let vertex = 0; vertex < count; vertex += 1) {
    scratchA.fromBufferAttribute(position, vertex).sub(frame.origin);
    along[vertex] = scratchA.dot(frame.axis); width[vertex] = scratchA.dot(frame.curl); flat[vertex] = scratchA.dot(thickness);
    const t = (along[vertex]! - from) / (frame.length - from);
    if (t < 0) { slot[vertex] = -1; continue; }
    const bin = Math.min(bins - 1, Math.floor(t * bins));
    slot[vertex] = bin;
    low[bin] = Math.min(low[bin]!, width[vertex]!); high[bin] = Math.max(high[bin]!, width[vertex]!);
    flats[bin]!.push(flat[vertex]!);
  }
  // Thickness limits per slice are quantiles, not extremes: the Tripo blade carries a few nicks and bumps that would otherwise skew the centre line and survive the thinning.
  for (let bin = 0; bin < bins; bin += 1) {
    const sorted = flats[bin]!.sort((a, b) => a - b);
    flatLow[bin] = sorted[Math.floor(sorted.length * KATANA_BLADE.quantile)] ?? 0;
    flatHigh[bin] = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * (1 - KATANA_BLADE.quantile)))] ?? 0;
  }
  const side = new Float32Array(count).fill(1);
  for (let vertex = 0; vertex < count; vertex += 1) {
    const bin = slot[vertex]!;
    if (bin < 0 || !(high[bin]! - low[bin]! > 1e-9)) continue;
    const s = (width[vertex]! - low[bin]!) / (high[bin]! - low[bin]!);
    side[vertex] = s;
    const u = Math.max(0, Math.min(1, (along[vertex]! - from) / rampSpan)), ramp = u * u * (3 - 2 * u);
    const widthGain = 1 + (KATANA_BLADE.widthScale - 1) * ramp;
    const flatGain = 1 + (KATANA_BLADE.edgeThickness + (KATANA_BLADE.spineThickness - KATANA_BLADE.edgeThickness) * s - 1) * ramp;
    const widthMid = (low[bin]! + high[bin]!) / 2, flatMid = (flatLow[bin]! + flatHigh[bin]!) / 2;
    const flatTrimmed = flat[vertex]! + (Math.max(flatLow[bin]!, Math.min(flatHigh[bin]!, flat[vertex]!)) - flat[vertex]!) * ramp;
    scratchA.fromBufferAttribute(position, vertex)
      .addScaledVector(frame.curl, (width[vertex]! - widthMid) * (widthGain - 1))
      .addScaledVector(thickness, flatMid + (flatTrimmed - flatMid) * flatGain - flat[vertex]!);
    position.setXYZ(vertex, scratchA.x, scratchA.y, scratchA.z);
    if (normal) {
      scratchB.fromBufferAttribute(normal, vertex);
      const across = scratchB.dot(thickness);
      scratchB.addScaledVector(thickness, across / flatGain - across).normalize();
      normal.setXYZ(vertex, scratchB.x, scratchB.y, scratchB.z);
    }
  }
  geometry.setAttribute('wcEdgeSide', new BufferAttribute(side, 1));
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
}

/**
 * Violet-to-crimson edge: the base emissive is violet; a per-vertex 0..1 coordinate along the blade (hilt side → tip) scales its channels toward crimson in the
 * fragment shader, so animated `emissiveIntensity` still drives the whole gradient. Only a thin line hugging the cutting edge emits (`wcEdgeSide`, written
 * by `sharpenKatanaBlade`); the rest of the blade stays dark polished steel.
 */
function tintKatanaEdge(geometry: BufferGeometry, frame: GlaiveFrame, profile: WeaponProfile, edge: MeshStandardMaterial): void {
  const position = geometry.getAttribute('position');
  const bladeStart = (1 - profile.bladeFraction) * frame.length, bladeLength = profile.bladeFraction * frame.length;
  const values = new Float32Array(position.count);
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    scratchA.fromBufferAttribute(position, vertex).sub(frame.origin);
    values[vertex] = Math.max(0, Math.min(1, (scratchA.dot(frame.axis) - bladeStart) / bladeLength));
  }
  geometry.setAttribute('wcEdgeT', new BufferAttribute(values, 1));
  const violet = new Color(KATANA_EDGE_COLOR), crimson = new Color(KATANA_EDGE_TIP_COLOR);
  KATANA_EDGE_TINT.set(crimson.r / violet.r, crimson.g / violet.g, crimson.b / violet.b);
  edge.onBeforeCompile = (shader) => {
    shader.uniforms.wcEdgeTint = { value: KATANA_EDGE_TINT };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float wcEdgeT;\nattribute float wcEdgeSide;\nvarying float vWcEdgeT;\nvarying float vWcEdgeSide;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWcEdgeT = wcEdgeT;\nvWcEdgeSide = wcEdgeSide;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 wcEdgeTint;\nvarying float vWcEdgeT;\nvarying float vWcEdgeSide;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= mix(vec3(1.0), wcEdgeTint, vWcEdgeT) * (1.0 - smoothstep(0.03, 0.16, vWcEdgeSide));');
  };
  edge.customProgramCacheKey = () => 'wc-katana-edge';
}

/**
 * The native weapon follows the real right hand. Bind-derived fingers wrap its fitted handle; Yara's
 * existing hand mesh forms a grasp without synthetic bones. Native wrist/arm animation remains the carrier.
 */
export class WardenWeapon {
  /** Weapon root ('weapon' socket): origin at the palm, +Z along the blade, +Y toward the blade's curve, children in world metres. */
  readonly root = new Group();
  readonly sockets: Readonly<Record<WardenSocketName, Object3D>>;
  /** Materials of the glowing blade; `userData.wcWeaponEdge` is true. */
  readonly edgeMaterials: readonly MeshStandardMaterial[];
  /** Root of the model whose right hand carries the weapon. */
  readonly carrier: Object3D;
  private readonly grip: HandGrip;
  private readonly owner: WeaponOwner;
  private readonly glaive: WeaponSource;
  private readonly geometry: BufferGeometry;
  private readonly materials: Material[];
  private readonly handGeometry: HandGeometryEdit | undefined;
  private disposed = false;

  constructor(glaive: WeaponSource, owner: WeaponOwner, kind: WardenWeaponKind = 'warden', rigidHand = WEAPON_PROFILES[kind].rigidFist) {
    const meshes: Mesh[] = [];
    glaive.root.traverse((node) => { if (node instanceof Mesh) meshes.push(node); });
    const mesh = meshes[0];
    if (meshes.length !== 1 || !mesh) throw new Error('The Warden glaive must be a single mesh.');
    if (mesh.parent !== glaive.root || !mesh.matrix.equals(new Matrix4())) throw new Error('The Warden glaive mesh must sit at its root origin.');
    const source = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    this.carrier = owner.root;
    if (!(source instanceof MeshStandardMaterial)) throw new Error('The Warden glaive needs a standard PBR material.');
    this.glaive = glaive;
    this.owner = owner;
    const profile = WEAPON_PROFILES[kind];
    this.grip = computeHandGrip(owner.root, rigidHand, profile.tilt, kind === 'katana' ? KATANA_GRIP.edgeRadians : undefined);

    const position = mesh.geometry.getAttribute('position'), referenced = referencedVertices(mesh.geometry);
    let vertices: ArrayLike<number>;
    if (position instanceof BufferAttribute && !position.normalized && referenced.length === position.count) vertices = position.array;
    else {
      const selected = new Float32Array(referenced.length * 3);
      for (let index = 0; index < referenced.length; index++) { const vertex = referenced[index]!; selected[index * 3] = position.getX(vertex); selected[index * 3 + 1] = position.getY(vertex); selected[index * 3 + 2] = position.getZ(vertex); }
      vertices = selected;
    }
    const frame = analyzeGlaive(vertices, profile.orientation);
    this.geometry = splitBladeGeometry(mesh.geometry, frame, profile.bladeFraction);
    fitShaft(this.geometry, frame, this.grip.shaftRadius, profile);
    this.handGeometry = fitRigidNativeHand(this.grip, measureHiltProfile(this.geometry, frame, profile));
    if (kind === 'katana') sharpenKatanaBlade(this.geometry, frame, profile);
    const body = source.clone(), edge = source.clone();
    body.name = `${source.name}:body`;
    edge.name = `${source.name}:edge`;
    edge.emissive.setHex(profile.edgeColor);
    edge.emissiveIntensity = WARDEN_EDGE_IDLE_INTENSITY;
    edge.emissiveMap = kind === 'katana' ? null : edge.map;
    edge.userData.wcWeaponEdge = true;
    if (kind === 'katana') tintKatanaEdge(this.geometry, frame, profile, edge);
    this.materials = [body, edge];
    this.edgeMaterials = [edge];
    mesh.geometry = this.geometry;
    mesh.material = this.geometry.groups.length > 1 ? this.materials : body;
    mesh.castShadow = true;

    const { hand } = this.grip;
    owner.root.updateWorldMatrix(true, true);
    const handScale = hand.getWorldScale(scratchA).x;
    this.root.name = profile.name;
    this.root.position.copy(this.grip.palm);
    this.root.quaternion.setFromRotationMatrix(basisOf(this.grip.axis, this.grip.curl));
    this.root.scale.setScalar(1 / handScale);
    // The glaive's own frame (axis → +Z, curl → +Y) is rotated into the weapon frame, scaled to metres, and shifted so the grip point sits at the origin.
    const scale = profile.length / frame.length;
    const glaiveRotation = new Quaternion().setFromRotationMatrix(basisOf(frame.axis, frame.curl)).invert();
    const gripPoint = frame.origin.clone().addScaledVector(frame.axis, profile.gripFraction * frame.length);
    glaive.root.quaternion.copy(glaiveRotation);
    glaive.root.scale.setScalar(scale);
    glaive.root.position.copy(gripPoint).multiplyScalar(scale).applyQuaternion(glaiveRotation).negate();
    glaive.root.updateMatrix();
    this.root.add(glaive.root);

    const place = (name: string, point: Vector3): Object3D => {
      const socket = new Object3D();
      socket.name = `wc:${name}`;
      socket.position.copy(point).applyMatrix4(glaive.root.matrix);
      this.root.add(socket);
      return socket;
    };
    this.sockets = {
      weapon: this.root,
      'weapon-base': place('weapon-base', frame.origin.clone().addScaledVector(frame.axis, (1 - profile.bladeFraction) * frame.length)),
      'weapon-tip': place('weapon-tip', frame.tip),
      'weapon-pommel': place('weapon-pommel', frame.pommel),
    };
    hand.add(this.root);
    // Only finger-chain hands need per-frame posing; the fixed Yara fist is baked into the hand mesh and follows the native skin weights.
    if (this.grip.joints.length) owner.animation.setPostPose(() => this.applyGrip());
    this.applyGrip();
    hand.updateWorldMatrix(true, true);
  }

  /** Reapply the authored finger grasp after animation sampling. */
  applyGrip(): void {
    if (this.disposed) return;
    for (const joint of this.grip.joints) joint.bone.quaternion.copy(joint.grip);
  }

  setEdgeIntensity(intensity: number): void {
    for (const material of this.edgeMaterials) material.emissiveIntensity = intensity;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.grip.joints.length) this.owner.animation.setPostPose(undefined);
    if (this.handGeometry) { this.handGeometry.mesh.geometry = this.handGeometry.original; this.handGeometry.edited.dispose(); }
    this.root.removeFromParent();
    this.geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.glaive.dispose();
  }
}
