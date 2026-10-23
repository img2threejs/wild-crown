import { BufferAttribute, BufferGeometry, InterleavedBufferAttribute, Matrix4, Object3D, PropertyBinding, Quaternion, SkinnedMesh, Vector3, type Bone, type Skeleton } from 'three';

const HAND_NAME = 'mixamorig:RightHand';
const FINGERS = ['Index', 'Middle', 'Ring', 'Pinky', 'Thumb'] as const;

interface FingerJoint { readonly bone: Bone; readonly grip: Quaternion }
/** The finger grip quaternions (same order as `HandGrip.joints`) for a shaft turned `radians` from the knuckle line toward the fingers. */
export interface GripTurn { readonly radians: number; readonly grips: readonly Quaternion[] }
interface GripThumb {
  readonly pivot: Vector3;
  readonly axis: Vector3;
  readonly length: number;
  readonly radius: number;
  readonly rotation: Quaternion;
}
interface FingerWrap {
  readonly centres: Float64Array;
  readonly acrossMin: number;
  readonly acrossSpan: number;
  readonly reach: number;
  readonly core: number;
  readonly rotation: Quaternion;
  thumb?: GripThumb;
}
const GRIP_COLUMNS = 12, GRIP_ROWS = 10, GRIP_CURL = 4.6, GRIP_RAMP = .5;
/** Fitted skin keeps this much air (metres) over the tsuka, and the guard is applied within this distance (metres) of the seat along the hilt. */
const HILT_SKIN_CLEARANCE = .0015, HILT_SKIN_REACH = .1;
/**
 * Radius of the fitted hilt along its axis, measured on the real fitted weapon mesh: `radius[i]` (metres) holds for the slice `from + i * step` (metres from the grip
 * seat, + toward the blade). The fist skin keeps `HILT_SKIN_CLEARANCE` over this profile, so a collar right behind the guard lifts the fingers over it.
 */
export interface HiltProfile { readonly from: number; readonly step: number; readonly radius: Float32Array }
function hiltRadiusAt(profile: HiltProfile, along: number): number {
  const position = Math.max(0, Math.min(profile.radius.length - 1, (along - profile.from) / profile.step)), low = Math.floor(position), high = Math.min(profile.radius.length - 1, low + 1);
  return profile.radius[low]! + (profile.radius[high]! - profile.radius[low]!) * (position - low);
}
interface RigidHandShape {
  readonly mesh: SkinnedMesh;
  readonly toHand: Matrix4;
  readonly direction: Vector3;
  readonly axis: Vector3;
  readonly normal: Vector3;
  readonly hinge: number;
  readonly plane: number;
  readonly radius: number;
  readonly wrap?: FingerWrap;
}
export interface HandGrip {
  readonly hand: Bone;
  readonly axis: Vector3;
  readonly curl: Vector3;
  /** Shaft centre outside the native palm surface, not inside its flesh. */
  readonly palm: Vector3;
  readonly shaftRadius: number;
  readonly joints: readonly FingerJoint[];
  /** Finger-chain hands: unit knuckle line (index base − pinky base) and finger direction (wrist → middle base, knuckle component removed), in hand space. */
  readonly knuckles?: Vector3;
  readonly direction?: Vector3;
  /** Finger-chain hands: the fist precomputed for each requested shaft turn, ascending. */
  readonly turns?: readonly GripTurn[];
  readonly rigid?: RigidHandShape;
}
export interface HandGeometryEdit { readonly mesh: SkinnedMesh; readonly original: BufferGeometry; readonly edited: BufferGeometry }

/** Only vertices referenced by rendered triangles contribute to anatomy or weapon fitting. */
export function referencedVertices(geometry: BufferGeometry): number[] {
  const index = geometry.getIndex(), count = geometry.getAttribute('position').count;
  if (!index) return Array.from({ length: count }, (_, vertex) => vertex);
  const seen = new Uint8Array(count), vertices: number[] = [];
  // Preserve first-reference order without hashing every triangle corner.
  for (const vertex of index.array) {
    if (seen[vertex]) continue;
    seen[vertex] = 1;
    vertices.push(vertex);
  }
  return vertices;
}
function named(skeleton: Skeleton, name: string): Bone {
  const result = skeleton.getBoneByName(PropertyBinding.sanitizeNodeName(name)) ?? skeleton.getBoneByName(name);
  if (!result) throw new Error('Native hand rig has no bone ' + name);
  return result;
}
function principalAxis(points: readonly Vector3[], seed: Vector3, perpendicular?: Vector3): Vector3 {
  const mean = new Vector3();
  for (const point of points) mean.add(point);
  mean.divideScalar(points.length);
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const point of points) {
    const x = point.x - mean.x, y = point.y - mean.y, z = point.z - mean.z;
    xx += x * x; xy += x * y; xz += x * z; yy += y * y; yz += y * z; zz += z * z;
  }
  const axis = seed.clone().normalize();
  for (let iteration = 0; iteration < 32; iteration++) {
    axis.set(xx * axis.x + xy * axis.y + xz * axis.z, xy * axis.x + yy * axis.y + yz * axis.z, xz * axis.x + yz * axis.y + zz * axis.z);
    if (perpendicular) axis.addScaledVector(perpendicular, -axis.dot(perpendicular));
    axis.normalize();
  }
  if (axis.dot(seed) < 0) axis.negate();
  return axis;
}

/** Local finger centre and its along/across derivatives. The native fingers are not a flat slab. */
function fingerCentre(shape: RigidHandShape, along: number, across: number, out: Vector3): Vector3 {
  const wrap = shape.wrap!;
  const rawX = (across - wrap.acrossMin) / wrap.acrossSpan * GRIP_COLUMNS - .5;
  const rawY = (along - shape.hinge) / wrap.reach * GRIP_ROWS - .5;
  const x = Math.max(0, Math.min(GRIP_COLUMNS - 1, rawX)), y = Math.max(0, Math.min(GRIP_ROWS - 1, rawY));
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(GRIP_COLUMNS - 1, x0 + 1), y1 = Math.min(GRIP_ROWS - 1, y0 + 1);
  const tx = x - x0, ty = y - y0, values = wrap.centres;
  const a = values[y0 * GRIP_COLUMNS + x0]!, b = values[y0 * GRIP_COLUMNS + x1]!;
  const c = values[y1 * GRIP_COLUMNS + x0]!, d = values[y1 * GRIP_COLUMNS + x1]!;
  const low = a + (b - a) * tx, high = c + (d - c) * tx;
  return out.set(low + (high - low) * ty,
    rawY > 0 && rawY < GRIP_ROWS - 1 ? (high - low) * GRIP_ROWS / wrap.reach : 0,
    rawX > 0 && rawX < GRIP_COLUMNS - 1 ? ((b - a) * (1 - ty) + (d - c) * ty) * GRIP_COLUMNS / wrap.acrossSpan : 0);
}

/** Close the native fingers first, then align that grasp to the captured sword axis without changing blade heading. */
function katanaHandGrip(mesh: SkinnedMesh, hand: Bone, toHand: Matrix4, points: readonly Vector3[], direction: Vector3, axis: Vector3, curl: Vector3, handScale: number): HandGrip {
  const lengths = points.map(point => point.dot(direction)).sort((a, b) => a - b);
  const length = lengths[Math.floor(lengths.length * .98)]!, hinge = length * .42;
  const naturalAxis = axis.clone().addScaledVector(direction, -axis.dot(direction)).normalize();
  const fingers = points.filter(point => point.dot(direction) > hinge);
  const laterals = points.filter(point => point.dot(direction) > hinge + (length - hinge) * .25)
    .map(point => point.dot(naturalAxis)).sort((a, b) => a - b);
  const middle = laterals[Math.floor(laterals.length / 2)]!;
  let positive = 0, negative = 0;
  for (const point of points) {
    const along = point.dot(direction);
    if (along <= length * .15 || along >= hinge) continue;
    const lateral = point.dot(naturalAxis) - middle;
    positive = Math.max(positive, lateral); negative = Math.max(negative, -lateral);
  }
  // Vesper's thumb protrudes below the knuckles. Whole-hand skew incorrectly identifies the opposite side.
  // Right hand: thumb × fingers is the palm normal; the fingers curl toward it and the hilt sits in that palm.
  const normal = naturalAxis.clone().multiplyScalar(positive > negative ? 1 : -1).cross(direction).normalize();
  const fingerLengths = fingers.map(point => point.dot(direction)).sort((a, b) => a - b);
  const reach = fingerLengths[Math.floor(fingerLengths.length * .98)]! - hinge;
  let acrossMin = Infinity, acrossMax = -Infinity, surface = -Infinity;
  for (const point of fingers) {
    const across = point.dot(naturalAxis);
    acrossMin = Math.min(acrossMin, across); acrossMax = Math.max(acrossMax, across);
    surface = Math.max(surface, point.dot(normal));
  }
  const acrossSpan = acrossMax - acrossMin;
  const low = new Float64Array(GRIP_COLUMNS * GRIP_ROWS).fill(Infinity), high = new Float64Array(low.length).fill(-Infinity);
  for (const point of fingers) {
    const x = Math.max(0, Math.min(GRIP_COLUMNS - 1, Math.floor((point.dot(naturalAxis) - acrossMin) / acrossSpan * GRIP_COLUMNS)));
    const y = Math.max(0, Math.min(GRIP_ROWS - 1, Math.floor((point.dot(direction) - hinge) / reach * GRIP_ROWS)));
    const index = y * GRIP_COLUMNS + x, depth = point.dot(normal);
    low[index] = Math.min(low[index]!, depth); high[index] = Math.max(high[index]!, depth);
  }
  const centres = new Float64Array(low.length), measured: number[] = [];
  for (let index = 0; index < low.length; index++) {
    centres[index] = (low[index]! + high[index]!) / 2;
    if (Number.isFinite(centres[index])) measured.push(index);
  }
  if (!measured.length || !(reach > 0 && acrossSpan > 0)) throw new Error('The native katana hand has no measurable fingers.');
  // Empty cells lie between fingers, not on their skin. Extend the nearest measured section into those gaps.
  for (let index = 0; index < centres.length; index++) {
    if (Number.isFinite(centres[index])) continue;
    let nearest = measured[0]!, distance = Infinity;
    for (const candidate of measured) {
      const delta = (index % GRIP_COLUMNS - candidate % GRIP_COLUMNS) ** 2
        + (Math.floor(index / GRIP_COLUMNS) - Math.floor(candidate / GRIP_COLUMNS)) ** 2;
      if (delta < distance) { distance = delta; nearest = candidate; }
    }
    centres[index] = centres[nearest]!;
  }
  const core = Math.min(acrossSpan * .09, reach * .18);
  const rotation = new Quaternion().setFromUnitVectors(naturalAxis, axis);
  const wrap: FingerWrap = { centres, acrossMin, acrossSpan, reach, core, rotation };
  const shape: RigidHandShape = { mesh, toHand, direction, axis: naturalAxis, normal, hinge, plane: 0, radius: 0, wrap };
  const sample = new Vector3();
  let half = 0;
  for (const point of fingers) {
    const along = point.dot(direction);
    if (along <= hinge + reach * .25) continue;
    fingerCentre(shape, along, point.dot(naturalAxis), sample);
    half = Math.max(half, Math.abs(point.dot(normal) - sample.x));
  }
  const radius = Math.max(reach / GRIP_CURL, core * 1.3), center = surface + core;
  const palm = direction.clone().multiplyScalar(hinge).addScaledVector(naturalAxis, (acrossMin + acrossMax) / 2)
    .addScaledVector(normal, center).applyQuaternion(rotation);
  const fitted: RigidHandShape = { ...shape, radius, plane: center - radius };
  wrap.thumb = opposedGripThumb(points, fitted, middle, positive > negative ? 1 : -1);
  return { hand, axis, curl, palm, shaftRadius: core * handScale, joints: [], rigid: fitted };
}

function gripThumbWeight(thumb: GripThumb, point: Vector3, scratch: Vector3): number {
  scratch.copy(point).sub(thumb.pivot);
  const along = scratch.dot(thumb.axis), off = scratch.addScaledVector(thumb.axis, -along).length();
  return smoothstep(0, thumb.length * .5, along) * (1 - smoothstep(thumb.radius, thumb.radius * 1.8, off));
}

/** Rigid thumb opposition preserves its volume; fitting its actual pad avoids a floating conservative bounding sphere. */
function opposedGripThumb(points: readonly Vector3[], shape: RigidHandShape, middle: number, sign: number): GripThumb {
  const { direction, axis, normal, hinge, wrap } = shape;
  const lower = points.filter(point => point.dot(direction) > hinge * .35 && point.dot(direction) < hinge)
    .sort((a, b) => sign * (b.dot(axis) - a.dot(axis)));
  if (lower.length < 10) throw new Error('The native katana hand has no measurable thumb.');
  const tip = new Vector3(), count = Math.max(10, Math.floor(lower.length * .04));
  for (let index = 0; index < count; index++) tip.add(lower[index]!);
  tip.divideScalar(count);
  let plane = 0, palmCount = 0;
  for (const point of points) if (point.dot(direction) < hinge) { plane += point.dot(normal); palmCount++; }
  plane /= palmCount;
  const pivot = axis.clone().multiplyScalar(middle + sign * wrap!.acrossSpan * .15)
    .addScaledVector(direction, hinge * .3).addScaledVector(normal, plane);
  const thumbAxis = tip.clone().sub(pivot), length = thumbAxis.length();
  thumbAxis.divideScalar(length);
  const point = new Vector3(), scratch = new Vector3(), spreads: number[] = [];
  for (const source of points) {
    if (source.distanceTo(tip) >= length * .4) continue;
    point.copy(source).sub(pivot);
    const along = point.dot(thumbAxis);
    spreads.push(point.addScaledVector(thumbAxis, -along).length());
  }
  spreads.sort((a, b) => a - b);
  const radius = spreads[Math.floor(spreads.length * .9)]!;
  if (!(length > 0 && radius > 0)) throw new Error('The native katana thumb has no measurable pad.');
  const thumb: GripThumb = { pivot, axis: thumbAxis, length, radius, rotation: new Quaternion() };
  const center = shape.plane + shape.radius, pivotD = pivot.dot(direction), pivotN = pivot.dot(normal);
  let outer = wrap!.core + radius;
  for (let pass = 0; pass < 3; pass++) {
    let d = hinge - outer, n = center;
    let remaining = length * length - (d - pivotD) ** 2 - (n - pivotN) ** 2;
    if (remaining < 0) {
      const pd = pivotD - hinge, pn = pivotN - center, distance = Math.hypot(pd, pn);
      d = hinge + pd / distance * outer; n = center + pn / distance * outer;
      remaining = length * length - (d - pivotD) ** 2 - (n - pivotN) ** 2;
    }
    point.copy(axis).multiplyScalar(pivot.dot(axis) - sign * Math.sqrt(Math.max(0, remaining)))
      .addScaledVector(direction, d).addScaledVector(normal, n).sub(pivot).normalize();
    thumb.rotation.setFromUnitVectors(thumbAxis, point);
    if (pass === 2) break;
    let clearance = Infinity;
    for (const source of points) {
      if (gripThumbWeight(thumb, source, scratch) < .95) continue;
      point.copy(source).sub(pivot).applyQuaternion(thumb.rotation).add(pivot);
      clearance = Math.min(clearance, Math.hypot(point.dot(direction) - hinge, point.dot(normal) - center));
    }
    outer = Math.max(wrap!.core, outer - (clearance - wrap!.core - .0005));
  }
  return thumb;
}

/**
 * Native bind anatomy; Aren's finger chains wrap a fitted shaft, Yara's existing hand vertices acquire a fixed grasp. `edgeRadians` (rigid fist only, the katana)
 * places the weapon's cutting edge (-Y; `curl` is +Y, the spine) about the shaft: the edge direction is cos(edge)·(back of the hand) + sin(edge)·`bend` (the
 * finger direction without its shaft component); otherwise the staff convention applies (`curl` = -palm normal).
 */
export function computeHandGrip(root: Object3D, staff: boolean, tiltRadians: number, edgeRadians?: number, wrapTurns: readonly number[] = [], shaftScale = 1): HandGrip {
  let mesh: SkinnedMesh | undefined;
  root.traverse(node => { if (!mesh && node instanceof SkinnedMesh && node.skeleton.getBoneByName(PropertyBinding.sanitizeNodeName(HAND_NAME))) mesh = node; });
  if (!mesh) throw new Error('The hero has no native skinned right hand.');
  const skeleton = mesh.skeleton, hand = named(skeleton, HAND_NAME);
  const bindWorld = (target: Bone): Matrix4 => skeleton.boneInverses[skeleton.bones.indexOf(target)]!.clone().invert();
  const handInverse = skeleton.boneInverses[skeleton.bones.indexOf(hand)]!;
  const local = (target: Bone): Vector3 => new Vector3().setFromMatrixPosition(bindWorld(target)).applyMatrix4(handInverse);
  const toHand = handInverse.clone().multiply(mesh.bindMatrix);
  const position = mesh.geometry.getAttribute('position'), skinIndex = mesh.geometry.getAttribute('skinIndex'), skinWeight = mesh.geometry.getAttribute('skinWeight');
  const handIndex = skeleton.bones.indexOf(hand), points: Vector3[] = [], palmPoints: Vector3[] = [];
  const point = new Vector3();
  for (const vertex of referencedVertices(mesh.geometry)) {
    let total = 0, palmWeight = 0;
    for (let component = 0; component < 4; component++) {
      const index = skinIndex.getComponent(vertex, component), weight = skinWeight.getComponent(vertex, component);
      if (skeleton.bones[index]?.name.includes('RightHand')) total += weight;
      if (index === handIndex) palmWeight += weight;
    }
    if (total < .6) continue;
    point.fromBufferAttribute(position, vertex).applyMatrix4(toHand);
    points.push(point.clone());
    if (palmWeight > .6) palmPoints.push(point.clone());
  }
  root.updateWorldMatrix(true, true);
  const handScale = hand.getWorldScale(new Vector3()).x;
  if (staff) {
    // This native 23-joint rig has no finger chains. Bend its real hand mesh once;
    // do not add synthetic fingers or mutate the shared source asset. The shaft lies in the palm crease along the knuckle line (tilted
    // `tiltRadians` toward the fingertips), thumb end up, so the staff orientation in locomotion comes from the arm pose, never from wrist twisting.
    const forearm = local(named(skeleton, 'mixamorig:RightForeArm')).negate().normalize();
    const direction = principalAxis(points, forearm);
    const knuckles = principalAxis(points, new Vector3(0, 1, 0).transformDirection(handInverse), direction);
    // Keep the calibrated weapon frame stable; the katana resolves the anatomical thumb separately.
    let meanAcross = 0;
    for (const point of points) meanAcross += point.dot(knuckles);
    meanAcross /= points.length;
    let skew = 0;
    for (const point of points) skew += (point.dot(knuckles) - meanAcross) ** 3;
    const thumbSide = knuckles.clone().multiplyScalar(skew > 0 ? 1 : -1);
    // This reference normal also defines the captured blade-edge calibration.
    const normal = thumbSide.clone().cross(direction).normalize();
    const axis = thumbSide.clone().multiplyScalar(Math.cos(tiltRadians)).addScaledVector(direction, Math.sin(tiltRadians)).normalize();
    // Fingers curl about the shaft in the plane perpendicular to it: `bend` is the metacarpal direction without its shaft component.
    const bend = direction.clone().addScaledVector(axis, -direction.dot(axis)).normalize();
    if (edgeRadians !== undefined) {
      const curl = normal.clone().multiplyScalar(Math.cos(edgeRadians)).addScaledVector(bend, -Math.sin(edgeRadians));
      return katanaHandGrip(mesh, hand, toHand, points, direction, axis, curl, handScale);
    }
    const lengths = points.map(point => point.dot(bend)).sort((a, b) => a - b);
    const length = lengths[Math.floor(lengths.length * .98)]!;
    const hinge = length * .42;
    const palm = points.filter(point => point.dot(bend) < hinge);
    let plane = 0, across = 0;
    for (const point of palm) { plane += point.dot(normal); across += point.dot(axis); }
    plane /= palm.length; across /= palm.length;
    let low = Infinity, high = -Infinity, fingerDepth = 0;
    for (const point of points) {
      low = Math.min(low, point.dot(axis)); high = Math.max(high, point.dot(axis));
      if (point.dot(bend) > hinge) fingerDepth = Math.max(fingerDepth, point.dot(normal) - plane);
    }
    const shaftRadius = (high - low) * handScale * .16;
    const radius = Math.max((length - hinge) / 2.7, fingerDepth + shaftRadius / handScale);
    return { hand, axis, curl: normal.clone().negate(), palm: bend.clone().multiplyScalar(hinge).addScaledVector(axis, across).addScaledVector(normal, plane + radius), shaftRadius, joints: [], rigid: { mesh, toHand, direction: bend, axis, normal, hinge, plane, radius } };
  }
  const finger = (name: string, joint: number): Bone => named(skeleton, `mixamorig:RightHand${name}${joint}`);
  const index = local(finger('Index', 1)), pinky = local(finger('Pinky', 1)), middle = local(finger('Middle', 1)), thumb = local(finger('Thumb', 1));
  const width = index.clone().sub(pinky), knuckles = width.clone().normalize();
  const direction = middle.clone().addScaledVector(knuckles, -middle.dot(knuckles)).normalize();
  const normal = knuckles.clone().cross(direction).normalize();
  if (normal.dot(thumb) < 0) normal.negate();
  const axis = knuckles.clone().multiplyScalar(Math.cos(tiltRadians)).addScaledVector(direction, -Math.sin(tiltRadians)).normalize();
  // `shaftScale` > 1: a thicker shaft than the anatomical fist (the Heartroot staff keeps a full, even shaft); palm and finger wrap follow it.
  const shaftRadius = width.length() * handScale * .16 * shaftScale;
  let surface = 0;
  for (const point of palmPoints) if (point.dot(direction) > middle.dot(direction) * .5 && point.dot(direction) < middle.dot(direction)) surface = Math.max(surface, point.dot(normal));
  const palm = middle.clone().multiplyScalar(.92).addScaledVector(normal, surface + shaftRadius / handScale);
  const handRotation = new Quaternion().setFromRotationMatrix(bindWorld(hand));
  /** The grip quaternion of every finger joint that closes the four fingers and the thumb around a shaft lying along `axis` (hand space). */
  const fingerGrips = (axis: Vector3): FingerJoint[] => {
    const joints: FingerJoint[] = [];
    const shaftWorld = axis.clone().applyQuaternion(handRotation);
    for (const name of FINGERS) {
      const bones = [1, 2, 3, 4].map(joint => finger(name, joint));
      const positions = bones.map(local);
      const center = palm.clone().addScaledVector(axis, positions[0]!.clone().sub(palm).dot(axis));
      const radial = positions[0]!.clone().sub(center);
      const xAxis = direction.clone().addScaledVector(axis, -direction.dot(axis)).normalize(), yAxis = normal;
      const kx = radial.dot(xAxis), ky = radial.dot(yAxis), distance = Math.hypot(kx, ky);
      const links = positions.slice(1).map((position, index) => position.clone().sub(positions[index]!));
      const lengths = links.map(link => link.clone().addScaledVector(axis, -link.dot(axis)).length());
      // A tangent proximal phalanx and circular distal phalanges keep flesh outside
      // the shaft. Bone lengths and native axial components remain unchanged.
      const clearance = (shaftRadius + .002) / handScale + lengths[1]! * .35;
      const tangent = Math.sqrt(Math.max(0, distance * distance - clearance * clearance));
      let radius = Math.max(Math.hypot(clearance, Math.max(0, lengths[0]! - tangent)), Math.hypot(clearance, lengths[1]! / 2), Math.hypot(clearance, lengths[2]! / 2), distance - lengths[0]! + 1e-5);
      radius = Math.min(radius, distance + lengths[0]! - 1e-5);
      const base = (distance * distance + radius * radius - lengths[0]! * lengths[0]!) / (2 * distance);
      const offset = Math.sqrt(Math.max(0, radius * radius - base * base));
      const bx = kx / distance * base, by = ky / distance * base;
      const candidates = [[bx - ky / distance * offset, by + kx / distance * offset], [bx + ky / distance * offset, by - kx / distance * offset]] as const;
      const firstLink = links[0]!;
      const score = (candidate: readonly [number, number]): number => (candidate[0] - kx) * firstLink.dot(xAxis) + (candidate[1] - ky) * firstLink.dot(yAxis);
      const first = score(candidates[0]) > score(candidates[1]) ? candidates[0] : candidates[1];
      let angle = Math.atan2(first[1], first[0]), px = kx, py = ky, cumulative = 0;
      const turn = (kx * first[1] - ky * first[0]) >= 0 ? 1 : -1;
      for (let joint = 0; joint < 3; joint++) {
        if (joint > 0) angle += turn * 2 * Math.asin(Math.min(1, lengths[joint]! / (2 * radius)));
        const nx = Math.cos(angle) * radius, ny = Math.sin(angle) * radius;
        const desired = xAxis.clone().multiplyScalar(nx - px).addScaledVector(yAxis, ny - py).normalize();
        const original = links[joint]!.clone().addScaledVector(axis, -links[joint]!.dot(axis)).normalize();
        const next = Math.atan2(axis.dot(original.clone().cross(desired)), original.dot(desired));
        const target = bones[joint]!, parent = target.parent as Bone;
        const rotation = new Quaternion().setFromRotationMatrix(bindWorld(target));
        const parentRotation = parent === hand ? handRotation : new Quaternion().setFromRotationMatrix(bindWorld(parent));
        const bindLocal = parentRotation.clone().invert().multiply(rotation);
        const boneAxis = shaftWorld.clone().applyQuaternion(rotation.clone().invert());
        joints.push({ bone: target, grip: bindLocal.multiply(new Quaternion().setFromAxisAngle(boneAxis, next - cumulative)) });
        cumulative = next; px = nx; py = ny;
      }
    }
    return joints;
  };
  const joints = fingerGrips(axis);
  // The same fist for each shaft turn (knuckle line → fingers) a per-clip staff profile asks for; the weapon blends between the nearest two.
  const turns = [...new Set(wrapTurns)].sort((a, b) => a - b).map((radians): GripTurn => ({
    radians,
    grips: fingerGrips(knuckles.clone().multiplyScalar(Math.cos(radians)).addScaledVector(direction, Math.sin(radians)).normalize()).map(joint => joint.grip),
  }));
  return { hand, axis, curl: normal.negate(), palm, shaftRadius, joints, knuckles, direction, turns };
}

/** Copy only referenced vertices: Yara's source has 1,014,289 slots but just 62,494 rendered vertices. */
function editableGeometry(source: BufferGeometry): BufferGeometry {
  const used = referencedVertices(source), remap = new Uint32Array(source.getAttribute('position').count);
  for (let index = 0; index < used.length; index++) remap[used[index]!] = index;
  const geometry = new BufferGeometry();
  for (const name of Object.keys(source.attributes)) {
    const attribute = source.getAttribute(name);
    if (!(attribute instanceof BufferAttribute)) throw new Error('Native hand editing requires non-interleaved attributes.');
    const array = new (attribute.array.constructor as typeof Float32Array)(used.length * attribute.itemSize);
    for (let index = 0; index < used.length; index++) for (let component = 0; component < attribute.itemSize; component++) array[index * attribute.itemSize + component] = attribute.array[used[index]! * attribute.itemSize + component]!;
    geometry.setAttribute(name, new BufferAttribute(array, attribute.itemSize, attribute.normalized));
  }
  const sourceIndex = source.getIndex();
  if (sourceIndex) {
    const indices = used.length > 65535 ? new Uint32Array(sourceIndex.count) : new Uint16Array(sourceIndex.count);
    for (let index = 0; index < sourceIndex.count; index++) indices[index] = remap[sourceIndex.getX(index)]!;
    geometry.setIndex(new BufferAttribute(indices, 1));
  }
  for (const group of source.groups) geometry.addGroup(group.start, group.count, group.materialIndex);
  geometry.setDrawRange(source.drawRange.start, source.drawRange.count);
  return geometry;
}

function fitWrappedNativeHand(grip: HandGrip, shape: RigidHandShape, hilt: HiltProfile | undefined): HandGeometryEdit {
  const wrap = shape.wrap!, original = shape.mesh.geometry, edited = editableGeometry(original);
  const positions = edited.getAttribute('position'), normals = edited.getAttribute('normal'), tangents = edited.getAttribute('tangent');
  const indices = edited.getAttribute('skinIndex'), weights = edited.getAttribute('skinWeight');
  const handIndex = shape.mesh.skeleton.bones.indexOf(grip.hand), fromHand = shape.toHand.clone().invert();
  const point = new Vector3(), vector = new Vector3(), rotated = new Vector3(), centre = new Vector3();
  const sourcePoint = new Vector3(), thumbPoint = new Vector3(), thumbVector = new Vector3(), offset = new Vector3();
  const { direction, axis, normal, radius, hinge } = shape;
  // Skin rigidly carried by the hand never enters the hilt: the fitted surface stays 1.5 mm outside the tsuka within a hand's length of the seat.
  const handScale = grip.shaftRadius / wrap.core, hiltReach = HILT_SKIN_REACH / handScale;
  // The fitted surface at `z` (hand units from the seat along the hilt) stands 1.5 mm outside the real hilt there (never inside the nominal tsuka radius).
  const skinAt = (z: number): number => Math.max(wrap.core, hilt ? hiltRadiusAt(hilt, z * handScale) / handScale : 0) + HILT_SKIN_CLEARANCE / handScale;
  const rigid: number[] = [];
  for (let vertex = 0; vertex < positions.count; vertex++) {
    let weight = 0;
    for (let component = 0; component < 4; component++) if (indices.getComponent(vertex, component) === handIndex) weight += weights.getComponent(vertex, component);
    if (weight <= 0) continue;
    point.fromBufferAttribute(positions, vertex).applyMatrix4(shape.toHand);
    const along = point.dot(direction), across = point.dot(axis), depth = point.dot(normal);
    sourcePoint.copy(point);
    const opposition = wrap.thumb ? gripThumbWeight(wrap.thumb, point, rotated) : 0;
    let xd = 1, xa = 0, xn = 0, yd = 0, ya = 0, yn = 1;
    if (weight >= .6 && along > hinge && opposition < 1) {
      fingerCentre(shape, along, across, centre);
      const angle = (along - hinge) / radius, sine = Math.sin(angle), cosine = Math.cos(angle);
      const t = Math.max(0, Math.min(1, angle / GRIP_RAMP)), ramp = t * t * (3 - 2 * t);
      const rampD = 6 * t * (1 - t) / (GRIP_RAMP * radius);
      const raw = radius - (depth - centre.x), gap = raw - wrap.core;
      // Smooth contact projects palm-side skin onto the handle without flattening the entire finger.
      const soft = Math.sqrt(gap * gap + .0003 ** 2), contact = wrap.core + (gap + soft) / 2;
      const gain = 1 + (.5 * (1 + gap / soft) - 1) * ramp;
      const radial = raw + (contact - raw) * ramp;
      const rd = gain * centre.y + (contact - raw) * rampD, ra = gain * centre.z, rn = -gain;
      const cd = centre.y * (1 - ramp) + (shape.plane - centre.x) * rampD, ca = centre.z * (1 - ramp);
      xd = rd * sine + radial * cosine / radius; xa = ra * sine; xn = rn * sine;
      yd = cd - rd * cosine + radial * sine / radius; ya = ca - ra * cosine; yn = -rn * cosine;
      point.copy(direction).multiplyScalar(hinge + radial * sine)
        .addScaledVector(normal, centre.x + (shape.plane - centre.x) * ramp + radius - radial * cosine)
        .addScaledVector(axis, across);
    }
    if (wrap.thumb && opposition > 0) {
      thumbPoint.copy(sourcePoint).sub(wrap.thumb.pivot).applyQuaternion(wrap.thumb.rotation).add(wrap.thumb.pivot);
      point.lerp(thumbPoint, opposition);
    }
    // Native thumb vertices carried up to 12% forearm influence: that moved the grasp away from a hand-mounted hilt.
    // Pin the distal grasp to the existing hand bone, retaining a smooth native-weight transition through the wrist.
    const t = weight >= .6 ? Math.max(0, Math.min(1, along / (hinge * .5))) : 0;
    const pin = t * t * (3 - 2 * t), fittedWeight = Math.min(1, weight + (1 - weight) * pin);
    if (pin > 0) {
      let assigned = false;
      for (let component = 0; component < 4; component++) {
        if (indices.getComponent(vertex, component) === handIndex) {
          weights.setComponent(vertex, component, assigned ? 0 : fittedWeight); assigned = true;
        } else weights.setComponent(vertex, component, weights.getComponent(vertex, component) * (1 - pin));
      }
    }
    rotated.copy(point).applyQuaternion(wrap.rotation);
    point.lerp(rotated, fittedWeight);
    if (fittedWeight > .9999) {
      rigid.push(vertex);
      offset.copy(point).sub(grip.palm);
      const alongHilt = offset.dot(grip.axis);
      offset.addScaledVector(grip.axis, -alongHilt);
      const distance = offset.length();
      const skinRadius = skinAt(alongHilt);
      if (Math.abs(alongHilt) < hiltReach && distance < skinRadius) {
        if (distance < 1e-9) offset.copy(grip.curl).addScaledVector(grip.axis, -grip.curl.dot(grip.axis)); else offset.divideScalar(distance);
        point.copy(grip.palm).addScaledVector(grip.axis, alongHilt).addScaledVector(offset.normalize(), skinRadius);
      }
    }
    point.applyMatrix4(fromHand);
    positions.setXYZ(vertex, point.x, point.y, point.z);
    if (normals) {
      vector.fromBufferAttribute(normals, vertex).transformDirection(shape.toHand);
      if (wrap.thumb && opposition > 0) thumbVector.copy(vector).applyQuaternion(wrap.thumb.rotation);
      const d = vector.dot(direction), a = vector.dot(axis), n = vector.dot(normal), determinant = xd * yn - xn * yd;
      vector.copy(direction).multiplyScalar(yn * d - yd * n)
        .addScaledVector(axis, -(xa * yn - xn * ya) * d + determinant * a + (xa * yd - xd * ya) * n)
        .addScaledVector(normal, -xn * d + xd * n).normalize();
      if (opposition > 0) vector.lerp(thumbVector, opposition).normalize();
      rotated.copy(vector).applyQuaternion(wrap.rotation);
      vector.lerp(rotated, fittedWeight).normalize().transformDirection(fromHand);
      normals.setXYZ(vertex, vector.x, vector.y, vector.z);
    }
    if (tangents) {
      vector.fromBufferAttribute(tangents, vertex).transformDirection(shape.toHand);
      if (wrap.thumb && opposition > 0) thumbVector.copy(vector).applyQuaternion(wrap.thumb.rotation);
      const d = vector.dot(direction), a = vector.dot(axis), n = vector.dot(normal);
      vector.copy(direction).multiplyScalar(xd * d + xa * a + xn * n)
        .addScaledVector(axis, a).addScaledVector(normal, yd * d + ya * a + yn * n).normalize();
      if (opposition > 0) vector.lerp(thumbVector, opposition).normalize();
      rotated.copy(vector).applyQuaternion(wrap.rotation);
      vector.lerp(rotated, fittedWeight).normalize().transformDirection(fromHand);
      tangents.setXYZ(vertex, vector.x, vector.y, vector.z);
    }
  }
  closeFistOnHilt(grip, shape, positions, normals, tangents, rigid, skinAt, hiltReach);
  edited.computeBoundingBox(); edited.computeBoundingSphere();
  shape.mesh.geometry = edited;
  return { mesh: shape.mesh, original, edited };
}

/** Angular sectors and axial rows (metres) of the inner-envelope map the fist closing uses, and the reach (metres from the hilt surface) it moves. */
const CLOSE_SECTORS = 48, CLOSE_ROW = .01, CLOSE_REACH = .07, CLOSE_FADE = .01, CLOSE_SHELL = .025;
const closeQuaternion = new Quaternion();

/**
 * Shuts the fitted fist on the hilt. In the hilt's cylindrical frame, every rigidly carried skin point within `CLOSE_REACH` of the tsuka is moved by
 * its row's inner envelope: palm and finger walls that stand off the handle are pulled onto it (outer layers follow with a smooth falloff, so
 * the hand is compressed, never folded), and the open sector between the fingertips and the thumb/palm is closed by turning its two edges
 * halfway in from either side (neighbours spread smoothly). Rows blend linearly along the hilt and fade out at the ends of the fist.
 */
function closeFistOnHilt(grip: HandGrip, shape: RigidHandShape, positions: BufferAttribute | InterleavedBufferAttribute, normals: BufferAttribute | InterleavedBufferAttribute | undefined, tangents: BufferAttribute | InterleavedBufferAttribute | undefined, vertices: readonly number[], skinAt: (z: number) => number, hiltReach: number): void {
  const handScale = grip.shaftRadius / shape.wrap!.core, reachOver = CLOSE_REACH / handScale, row = CLOSE_ROW / handScale;
  const axis = grip.axis, u = grip.curl.clone().addScaledVector(axis, -grip.curl.dot(axis)).normalize(), w = axis.clone().cross(u);
  const fromHand = shape.toHand.clone().invert(), point = new Vector3(), vector = new Vector3();
  const near: { vertex: number; z: number; r: number; theta: number }[] = [];
  let zLow = Infinity, zHigh = -Infinity;
  for (const vertex of vertices) {
    point.fromBufferAttribute(positions, vertex).applyMatrix4(shape.toHand).sub(grip.palm);
    const z = point.dot(axis), x = point.dot(u), y = point.dot(w), r = Math.hypot(x, y);
    if (Math.abs(z) >= hiltReach || r >= skinAt(z) + reachOver) continue;
    near.push({ vertex, z, r, theta: Math.atan2(y, x) });
    if (r < skinAt(z) + CLOSE_SHELL / handScale) { zLow = Math.min(zLow, z); zHigh = Math.max(zHigh, z); }
  }
  if (!near.length || !(zHigh > zLow)) return;
  const rows = Math.max(1, Math.ceil((zHigh - zLow) / row)), sectorOf = (theta: number) => (Math.floor((theta + Math.PI) / (2 * Math.PI) * CLOSE_SECTORS) % CLOSE_SECTORS + CLOSE_SECTORS) % CLOSE_SECTORS;
  const envelope = new Float64Array(rows * CLOSE_SECTORS).fill(Infinity);
  const rowOf = (z: number) => Math.max(0, Math.min(rows - 1, Math.floor((z - zLow) / row)));
  for (const item of near) { const cell = rowOf(item.z) * CLOSE_SECTORS + sectorOf(item.theta); envelope[cell] = Math.min(envelope[cell]!, item.r); }
  // Per row: the radial gap of each sector (circularly smoothed) and the widest empty run, which is the opening to shut.
  const sectorWidth = 2 * Math.PI / CLOSE_SECTORS, gaps = new Float64Array(rows * CLOSE_SECTORS), windows: { centre: number; half: number }[] = [];
  for (let r = 0; r < rows; r++) {
    const base = r * CLOSE_SECTORS, rowSkin = skinAt(zLow + (r + .5) * row), rowReach = rowSkin + reachOver, open = (s: number) => !(envelope[base + ((s % CLOSE_SECTORS) + CLOSE_SECTORS) % CLOSE_SECTORS]! < rowReach);
    for (let s = 0; s < CLOSE_SECTORS; s++) {
      let sum = 0, count = 0;
      for (const k of [-1, 0, 1]) { const e = envelope[base + (s + k + CLOSE_SECTORS) % CLOSE_SECTORS]!; if (e < rowReach) { sum += Math.max(0, e - rowSkin); count++; } }
      gaps[base + s] = count ? sum / count : 0;
    }
    let bestStart = -1, bestLength = 0;
    for (let s = 0; s < CLOSE_SECTORS; s++) {
      if (!open(s) || open(s - 1)) continue;
      let length = 0;
      while (length < CLOSE_SECTORS && open(s + length)) length++;
      if (length > bestLength) { bestLength = length; bestStart = s; }
    }
    windows.push(bestLength > 0 && bestLength < CLOSE_SECTORS / 2
      ? { centre: -Math.PI + (bestStart + bestLength / 2) * sectorWidth, half: bestLength * sectorWidth / 2 } : { centre: 0, half: 0 });
  }
  const angularShift = (r: number, theta: number): number => {
    const { centre, half } = windows[r]!;
    if (half <= 0) return 0;
    const span = Math.max(2.2 * half, Math.PI / 3), offset = Math.atan2(Math.sin(theta - centre), Math.cos(theta - centre));
    const distance = Math.abs(offset) - half;
    if (distance < 0 || distance >= span) return 0;
    const t = 1 - distance / span;
    return -Math.sign(offset) * half * t * t;
  };
  for (const item of near) {
    const position = Math.max(0, Math.min(rows - 1, (item.z - zLow) / row - .5)), r0 = Math.floor(position), r1 = Math.min(rows - 1, r0 + 1), f = position - r0;
    const fade = smoothstep(0, CLOSE_FADE / handScale, item.z - zLow + CLOSE_FADE / handScale * .5) * smoothstep(0, CLOSE_FADE / handScale, zHigh - item.z + CLOSE_FADE / handScale * .5);
    const sector = sectorOf(item.theta);
    const rawShift = (angularShift(r0, item.theta) * (1 - f) + angularShift(r1, item.theta) * f) * fade;
    const gap = (gaps[r0 * CLOSE_SECTORS + sector]! * (1 - f) + gaps[r1 * CLOSE_SECTORS + sector]! * f) * fade;
    const inner = Math.min(envelope[r0 * CLOSE_SECTORS + sector]!, envelope[r1 * CLOSE_SECTORS + sector]!, item.r);
    const span = Math.max(1.6 * gap, CLOSE_SHELL / handScale);
    const radius = Math.max(skinAt(item.z), item.r - gap * (1 - smoothstep(0, span, item.r - inner)));
    // Only the inner shell turns into the opening; outer layers (back of the hand, plate) stay put, so nothing shears.
    const shift = rawShift * (1 - smoothstep(0, 2 * CLOSE_SHELL / handScale, item.r - inner));
    const theta = item.theta + shift;
    point.copy(grip.palm).addScaledVector(axis, item.z).addScaledVector(u, Math.cos(theta) * radius).addScaledVector(w, Math.sin(theta) * radius).applyMatrix4(fromHand);
    positions.setXYZ(item.vertex, point.x, point.y, point.z);
    if (shift === 0) continue;
    closeQuaternion.setFromAxisAngle(axis, shift);
    for (const attribute of [normals, tangents]) {
      if (!attribute) continue;
      vector.fromBufferAttribute(attribute, item.vertex).transformDirection(shape.toHand).applyQuaternion(closeQuaternion).transformDirection(fromHand);
      attribute.setXYZ(item.vertex, vector.x, vector.y, vector.z);
    }
  }
}

/** Fixed native mesh grasp follows the original hand skin weights through every native animation. */
export function fitRigidNativeHand(grip: HandGrip, hilt?: HiltProfile): HandGeometryEdit | undefined {
  const shape = grip.rigid;
  if (!shape) return undefined;
  if (shape.wrap) return fitWrappedNativeHand(grip, shape, hilt);
  const original = shape.mesh.geometry, edited = editableGeometry(original);
  const positions = edited.getAttribute('position'), normals = edited.getAttribute('normal'), tangents = edited.getAttribute('tangent');
  const indices = edited.getAttribute('skinIndex'), weights = edited.getAttribute('skinWeight');
  const handIndex = shape.mesh.skeleton.bones.indexOf(grip.hand), fromHand = shape.toHand.clone().invert();
  const point = new Vector3(), vector = new Vector3();
  for (let vertex = 0; vertex < positions.count; vertex++) {
    let weight = 0;
    for (let component = 0; component < 4; component++) if (indices.getComponent(vertex, component) === handIndex) weight += weights.getComponent(vertex, component);
    if (weight < .6) continue;
    point.fromBufferAttribute(positions, vertex).applyMatrix4(shape.toHand);
    const length = point.dot(shape.direction) - shape.hinge;
    if (length <= 0) continue;
    const angle = length / shape.radius, cosine = Math.cos(angle), sine = Math.sin(angle);
    const depth = point.dot(shape.normal) - shape.plane;
    const radial = shape.radius - depth;
    const along = point.dot(shape.axis);
    point.copy(shape.direction).multiplyScalar(shape.hinge + radial * sine).addScaledVector(shape.normal, shape.plane + shape.radius - radial * cosine).addScaledVector(shape.axis, along).applyMatrix4(fromHand);
    positions.setXYZ(vertex, point.x, point.y, point.z);
    if (normals) {
      vector.fromBufferAttribute(normals, vertex).transformDirection(shape.toHand);
      const forward = vector.dot(shape.direction) * shape.radius / radial, normal = vector.dot(shape.normal), across = vector.dot(shape.axis);
      vector.copy(shape.direction).multiplyScalar(forward * cosine - normal * sine).addScaledVector(shape.normal, forward * sine + normal * cosine).addScaledVector(shape.axis, across).transformDirection(fromHand);
      normals.setXYZ(vertex, vector.x, vector.y, vector.z);
    }
    if (tangents) {
      vector.fromBufferAttribute(tangents, vertex).transformDirection(shape.toHand);
      const forward = vector.dot(shape.direction) * radial / shape.radius, normal = vector.dot(shape.normal), across = vector.dot(shape.axis);
      vector.copy(shape.direction).multiplyScalar(forward * cosine - normal * sine).addScaledVector(shape.normal, forward * sine + normal * cosine).addScaledVector(shape.axis, across).transformDirection(fromHand);
      tangents.setXYZ(vertex, vector.x, vector.y, vector.z);
    }
  }
  edited.computeBoundingBox(); edited.computeBoundingSphere();
  shape.mesh.geometry = edited;
  return { mesh: shape.mesh, original, edited };
}

export type HandSide = 'Left' | 'Right';
const HAND_SIDES: readonly HandSide[] = ['Left', 'Right'];
/** Curl of the finger-centre line at the farthest fingertip (radians): a Muay Thai fist closes the fingers well past a right angle at every knuckle. */
const FIST_CURL = 4;
/** The fingers' inner (palm-side) surface never gets closer than this to the curl axis (rig units), and flesh thins at most to what that allows. */
const FIST_CORE = .003;
/** Curl angle over which the finger flesh reaches its curled thickness (keeps the knuckle line free of a crease). */
const FIST_RAMP = .5;
const FIST_COLUMNS = 10;
/** Oppose the thumb across the curled fingers, keeping its flesh outside their palm-side surface (rig units). */
const THUMB_SWING = 1.7, THUMB_CLEARANCE = .003, THUMB_SCALE_RAMP = .3;
/**
 * Proportions of the folded thumb against the native one (Sakda's stylised thumb is bulky across the fist): `length` along its axis from the point where it
 * leaves the palm, `girth` across it. Both fade in with the fold weight, so the thenar base keeps its native surface without a seam.
 */
export interface ThumbProportions { readonly length: number; readonly girth: number }
export const FIST_THUMB: ThumbProportions = Object.freeze({ length: .82, girth: .87 });

/** A vertex mask: 1 where at least one rendered triangle uses the vertex (no Set of millions of indices). */
function referencedMask(geometry: BufferGeometry): Uint8Array {
  const count = geometry.getAttribute('position').count, mask = new Uint8Array(count), index = geometry.getIndex();
  if (!index) return mask.fill(1);
  const array = index.array;
  for (let item = 0; item < array.length; item++) mask[array[item]!] = 1;
  return mask;
}

/** The `fraction` quantile of `values` (sorted in place). */
function quantile(values: number[], fraction: number): number {
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.floor(values.length * fraction))]!;
}

/**
 * One native hand in its own bind frame: `direction` along the fingers, `across` the knuckle line (thumb side positive), `normal` out of the palm.
 * The palm normal is thumb × fingers on a right hand and fingers × thumb on a left hand (a mirrored hand has the opposite handedness).
 */
interface FistShape {
  readonly side: HandSide;
  readonly handIndex: number;
  readonly toHand: Matrix4;
  readonly fromHand: Matrix4;
  readonly direction: Vector3;
  readonly across: Vector3;
  readonly normal: Vector3;
  /** Knuckle line: the fingers bend where their along-coordinate passes `hinge`. */
  readonly hinge: number;
  /** Lateral limit of the four fingers; the thumb lies beyond it, low on the hand. */
  readonly edge: number;
  readonly inner: number;
  /** Thumb pivot (lateral, along) where it leaves the palm, its axis towards the tip, the tip's palm-normal coordinate; absent without a thumb. */
  readonly thumb?: { readonly lateral: number; readonly along: number; readonly axisLateral: number; readonly axisAlong: number; readonly length: number; readonly depth: number; readonly radius: number };
  /** Palm-normal coordinate of the finger flesh's centre at the knuckle line, in `FIST_COLUMNS` columns across the fingers (`inner`..`edge`). */
  readonly centre: readonly number[];
  readonly reach: number;
  readonly radius: number;
  readonly squeeze: number;
}

function fistShape(mesh: SkinnedMesh, side: HandSide, used: Uint8Array): FistShape {
  const skeleton = mesh.skeleton, hand = named(skeleton, `mixamorig:${side}Hand`);
  const handIndex = skeleton.bones.indexOf(hand);
  const handInverse = skeleton.boneInverses[handIndex]!;
  const toHand = handInverse.clone().multiply(mesh.bindMatrix), fromHand = toHand.clone().invert();
  const position = mesh.geometry.getAttribute('position'), skinIndex = mesh.geometry.getAttribute('skinIndex'), skinWeight = mesh.geometry.getAttribute('skinWeight');
  const points: Vector3[] = [];
  for (let vertex = 0; vertex < position.count; vertex++) {
    if (!used[vertex]) continue;
    let weight = 0;
    for (let component = 0; component < 4; component++) if (skinIndex.getComponent(vertex, component) === handIndex) weight += skinWeight.getComponent(vertex, component);
    if (weight >= .6) points.push(new Vector3().fromBufferAttribute(position, vertex).applyMatrix4(toHand));
  }
  if (points.length < 100) throw new Error(`The native ${side.toLowerCase()} hand has no skinned surface.`);
  // The native hand bone's own frame: +Y runs along the fingers (a bone points at its child, here the fingers), X across the hand, Z through it.
  const direction = new Vector3(0, 1, 0), knuckles = new Vector3(1, 0, 0);
  const length = quantile(points.map(point => point.dot(direction)), .98);
  const hinge = length * .43;
  // The thumb is the lateral protrusion below the knuckles: the side on which the lower hand reaches farthest from the centre line of the four fingers.
  const fingers = points.filter(point => point.dot(direction) > hinge + (length - hinge) * .25).map(point => point.dot(knuckles));
  const centreLine = quantile(fingers, .5);
  let thumbward = 0, pinkyward = 0;
  for (const point of points) { const along = point.dot(direction), lateral = point.dot(knuckles) - centreLine; if (along > length * .15 && along < hinge) { thumbward = Math.max(thumbward, lateral); pinkyward = Math.max(pinkyward, -lateral); } }
  const across = knuckles.clone().multiplyScalar(thumbward > pinkyward ? 1 : -1);
  const normal = side === 'Right' ? across.clone().cross(direction).normalize() : direction.clone().cross(across).normalize();
  // The four fingers end laterally where the beyond-knuckle flesh ends; whatever lies farther across below the knuckles is the thumb.
  const reach = length;
  const fingerLateral = points.filter(point => point.dot(direction) > hinge + (reach - hinge) * .25).map(point => point.dot(across));
  const edge = Math.max(...fingerLateral) + 1e-4, inner = Math.min(...fingerLateral);
  // Each finger curls about an axis through the centre of its own flesh at the knuckle line, wherever the rest pose holds that finger (palm-normal coordinate per column across the hand).
  const columns: number[][] = Array.from({ length: FIST_COLUMNS }, () => []);
  const column = (lateral: number): number => Math.max(0, Math.min(FIST_COLUMNS - 1, Math.floor((lateral - inner) / (edge - inner) * FIST_COLUMNS)));
  for (const point of points) {
    const along = point.dot(direction), lateral = point.dot(across);
    if (along >= hinge && along < hinge + (reach - hinge) * .3 && lateral <= edge) columns[column(lateral)]!.push(point.dot(normal));
  }
  const centre = columns.map(values => values.length > 8 ? (quantile(values, .03) + quantile(values, .97)) / 2 : NaN);
  for (let pass = 0; pass < FIST_COLUMNS; pass++) {
    const before = centre.slice();
    for (let item = 0; item < FIST_COLUMNS; item++) {
      if (!Number.isNaN(before[item]!)) continue;
      const near = [before[item - 1], before[item + 1]].filter((value): value is number => value !== undefined && !Number.isNaN(value));
      if (near.length) centre[item] = near.reduce((sum, value) => sum + value, 0) / near.length;
    }
  }
  let half = 0;
  for (const point of points) {
    const along = point.dot(direction), lateral = point.dot(across);
    if (along >= hinge && lateral <= edge) half = Math.max(half, Math.abs(point.dot(normal) - centre[column(lateral)]!));
  }
  const beyond = points.filter(point => point.dot(across) > edge + .003 && point.dot(direction) > hinge * .25).sort((a, b) => b.dot(direction) - a.dot(direction));
  let thumb: FistShape['thumb'];
  if (beyond.length > 50) {
    const tip = new Vector3();
    const count = Math.max(10, Math.floor(beyond.length * .04));
    for (let item = 0; item < count; item++) tip.add(beyond[item]!);
    tip.divideScalar(count);
    const lateral = edge + .006, along = hinge * .3, tipLateral = tip.dot(across), tipAlong = tip.dot(direction);
    const length = Math.hypot(tipLateral - lateral, tipAlong - along);
    const axisLateral = (tipLateral - lateral) / length, axisAlong = (tipAlong - along) / length, depth = tip.dot(normal);
    // Thumb radius: how far the thumb's own flesh (beyond the first third of its length) lies from its axis.
    const spread = beyond.map(point => {
      const dLateral = point.dot(across) - lateral, dAlong = point.dot(direction) - along, reachAlong = dLateral * axisLateral + dAlong * axisAlong;
      return reachAlong > length * .3 && reachAlong < length * 1.2 ? Math.hypot(dLateral - reachAlong * axisLateral, dAlong - reachAlong * axisAlong, point.dot(normal) - depth) : NaN;
    }).filter(value => !Number.isNaN(value));
    thumb = { lateral, along, axisLateral, axisAlong, length, depth, radius: quantile(spread, .9) };
  }
  const radius = (reach - hinge) / FIST_CURL;
  const squeeze = Math.min(1, (radius - FIST_CORE) / half);
  return { side, handIndex, toHand, fromHand, direction, across, normal, hinge, edge, inner, thumb, centre, reach, radius, squeeze };
}

const smoothstep = (edge0: number, edge1: number, value: number): number => { const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0))); return t * t * (3 - 2 * t); };

function centreAt(shape: FistShape, lateral: number): number {
  const position = Math.min(FIST_COLUMNS - 1, Math.max(0, (lateral - shape.inner) / (shape.edge - shape.inner) * FIST_COLUMNS - .5)), low = Math.floor(position), high = Math.min(FIST_COLUMNS - 1, low + 1), fraction = position - low;
  return shape.centre[low]! * (1 - fraction) + shape.centre[high]! * fraction;
}

/** Copy of `source` that owns only the attributes a hand edit rewrites; the index and every untouched attribute stay shared with the source. */
function ownedGeometry(source: BufferGeometry, owned: readonly string[]): BufferGeometry {
  const geometry = new BufferGeometry();
  for (const name of Object.keys(source.attributes)) {
    const attribute = source.getAttribute(name);
    if (!owned.includes(name)) { geometry.setAttribute(name, attribute); continue; }
    if (!(attribute instanceof BufferAttribute)) throw new Error('Native hand editing requires non-interleaved attributes.');
    geometry.setAttribute(name, new BufferAttribute(attribute.array.slice(), attribute.itemSize, attribute.normalized));
  }
  geometry.setIndex(source.getIndex());
  for (const group of source.groups) geometry.addGroup(group.start, group.count, group.materialIndex);
  geometry.setDrawRange(source.drawRange.start, source.drawRange.count);
  return geometry;
}

/** How much of the thumb's swing a point of the hand takes: 0 in the palm and the fingers, 1 at the thumb tip, fading along and around the thumb axis (a capsule from the pivot to the tip); `ramp` is the share of the thumb's length over which it rises from the palm. */
function thumbWeight(shape: FistShape, lateral: number, along: number, depth: number, ramp = .45): number {
  const thumb = shape.thumb!;
  const dLateral = lateral - thumb.lateral, dAlong = along - thumb.along;
  const reachAlong = dLateral * thumb.axisLateral + dAlong * thumb.axisAlong, off = Math.hypot(dLateral - reachAlong * thumb.axisLateral, dAlong - reachAlong * thumb.axisAlong, depth - thumb.depth);
  return smoothstep(0, ramp, reachAlong / thumb.length) * smoothstep(shape.edge - .004, shape.edge + .004, lateral) * (1 - smoothstep(thumb.radius, thumb.radius * 2, off));
}

/**
 * Swings the thumb across the palm about the point where it leaves it, after scaling it to `proportions` (length along its axis about the pivot, girth about the axis);
 * weights fade it into the palm (behind the pivot) and away from the index finger.
 */
function foldThumb(shape: FistShape, source: BufferGeometry, positions: BufferAttribute, normals: BufferAttribute | undefined, tangents: BufferAttribute | undefined, indices: BufferAttribute, weights: BufferAttribute, used: Uint8Array, proportions: ThumbProportions): void {
  const thumb = shape.thumb;
  if (!thumb) return;
  const point = new Vector3(), vector = new Vector3(), from = source.getAttribute('position');
  const cosine = Math.cos(THUMB_SWING), sine = Math.sin(THUMB_SWING);
  const length = thumb.length * proportions.length, radius = thumb.radius * proportions.girth;
  const tipLateral = thumb.lateral + length * (thumb.axisLateral * cosine - thumb.axisAlong * sine);
  const forward = shape.hinge * .95 - thumb.along - length * (thumb.axisLateral * sine + thumb.axisAlong * cosine);
  const lift = Math.max(THUMB_CLEARANCE, centreAt(shape, tipLateral) + 2 * shape.radius + radius + THUMB_CLEARANCE - thumb.depth);
  const { direction, across, normal } = shape, attributes = [normals, tangents];
  for (let vertex = 0; vertex < positions.count; vertex++) {
    if (!used[vertex]) continue;
    let weight = 0;
    for (let component = 0; component < 4; component++) if (indices.getComponent(vertex, component) === shape.handIndex) weight += weights.getComponent(vertex, component);
    if (weight < .6) continue;
    point.fromBufferAttribute(from, vertex).applyMatrix4(shape.toHand);
    const lateral = point.dot(across), along = point.dot(direction), depth = point.dot(normal);
    const w = thumbWeight(shape, lateral, along, depth);
    if (w <= 0) continue;
    // Scale about the pivot and the thumb axis (at the pad's depth); the scale reaches full strength over the first 30% of the thumb, so the thenar base melts into the native palm.
    let dLateral = lateral - thumb.lateral, dAlong = along - thumb.along, dDepth = depth - thumb.depth;
    const reach = dLateral * thumb.axisLateral + dAlong * thumb.axisAlong, shrink = thumbWeight(shape, lateral, along, depth, THUMB_SCALE_RAMP);
    const stretch = 1 - (1 - proportions.length) * shrink, thick = 1 - (1 - proportions.girth) * shrink;
    dLateral = reach * stretch * thumb.axisLateral + (dLateral - reach * thumb.axisLateral) * thick;
    dAlong = reach * stretch * thumb.axisAlong + (dAlong - reach * thumb.axisAlong) * thick;
    dDepth *= thick;
    const newLateral = thumb.lateral + dLateral * cosine - dAlong * sine, newAlong = thumb.along + dLateral * sine + dAlong * cosine;
    point.copy(direction).multiplyScalar(newAlong + forward).addScaledVector(across, newLateral).addScaledVector(normal, thumb.depth + dDepth + lift).applyMatrix4(shape.fromHand);
    point.lerp(vector.fromBufferAttribute(from, vertex), 1 - w);
    positions.setXYZ(vertex, point.x, point.y, point.z);
    for (const attribute of attributes) {
      if (!attribute) continue;
      vector.fromBufferAttribute(source.getAttribute(attribute === normals ? 'normal' : 'tangent'), vertex).transformDirection(shape.toHand);
      const a = vector.dot(across), d = vector.dot(direction), n = vector.dot(normal);
      vector.copy(across).multiplyScalar(a * cosine - d * sine).addScaledVector(direction, a * sine + d * cosine).addScaledVector(normal, n).transformDirection(shape.fromHand);
      vector.lerp(point.fromBufferAttribute(source.getAttribute(attribute === normals ? 'normal' : 'tangent'), vertex), 1 - w).normalize();
      attribute.setXYZ(vertex, vector.x, vector.y, vector.z);
    }
  }
}

/** Puts the original geometry back and frees the edit's own buffers; whatever the edit shares with the original is detached first so its GPU buffers survive. */
export function releaseHandGeometry(edit: HandGeometryEdit): void {
  edit.mesh.geometry = edit.original;
  for (const name of Object.keys(edit.edited.attributes)) if (edit.edited.getAttribute(name) === edit.original.getAttribute(name)) edit.edited.deleteAttribute(name);
  if (edit.edited.getIndex() === edit.original.getIndex()) edit.edited.setIndex(null);
  edit.edited.dispose();
}

const frame = { forward: new Vector3(), up: new Vector3() };

/** Bends one hand's four fingers about the knuckle line, centre line on a circle of `shape.radius`, palm-side flesh squeezed to `shape.squeeze`; the palm and wrist are untouched. */
function curlFingers(shape: FistShape, source: BufferGeometry, positions: BufferAttribute, normals: BufferAttribute | undefined, tangents: BufferAttribute | undefined, indices: BufferAttribute, weights: BufferAttribute, used: Uint8Array): void {
  const point = new Vector3(), vector = new Vector3(), thumbPoint = new Vector3(), from = source.getAttribute('position');
  const { direction, across, normal, hinge, radius } = shape, attributes = [[normals, false], [tangents, true]] as const;
  for (let vertex = 0; vertex < positions.count; vertex++) {
    if (!used[vertex]) continue;
    let weight = 0;
    for (let component = 0; component < 4; component++) if (indices.getComponent(vertex, component) === shape.handIndex) weight += weights.getComponent(vertex, component);
    if (weight < .6) continue;
    point.fromBufferAttribute(from, vertex).applyMatrix4(shape.toHand);
    const along = point.dot(direction), lateral = point.dot(across), depth = point.dot(normal);
    if (along <= hinge) continue;
    const thumbBlend = shape.thumb ? thumbWeight(shape, lateral, along, depth) : 0;
    if (thumbBlend === 1) continue;
    thumbPoint.fromBufferAttribute(positions, vertex);
    const angle = (along - hinge) / radius, cosine = Math.cos(angle), sine = Math.sin(angle);
    const squeeze = 1 - (1 - shape.squeeze) * smoothstep(0, FIST_RAMP, angle);
    const base = centreAt(shape, lateral), offset = depth - base;
    const ring = radius - squeeze * offset;
    point.copy(direction).multiplyScalar(hinge + ring * sine).addScaledVector(normal, base + radius - ring * cosine).addScaledVector(across, lateral).applyMatrix4(shape.fromHand);
    point.lerp(thumbPoint, thumbBlend);
    positions.setXYZ(vertex, point.x, point.y, point.z);
    const stretch = ring / radius;
    for (const [attribute, covariant] of attributes) {
      if (!attribute) continue;
      vector.fromBufferAttribute(source.getAttribute(attribute === normals ? 'normal' : 'tangent'), vertex).transformDirection(shape.toHand);
      const forward = vector.dot(direction) * (covariant ? stretch : 1 / stretch), inward = vector.dot(normal) * (covariant ? squeeze : 1 / squeeze), sideways = vector.dot(across);
      frame.forward.copy(direction).multiplyScalar(cosine).addScaledVector(normal, sine);
      frame.up.copy(direction).multiplyScalar(-sine).addScaledVector(normal, cosine);
      vector.copy(frame.forward).multiplyScalar(forward).addScaledVector(frame.up, inward).addScaledVector(across, sideways).transformDirection(shape.fromHand);
      vector.lerp(thumbPoint.fromBufferAttribute(attribute, vertex), thumbBlend).normalize();
      attribute.setXYZ(vertex, vector.x, vector.y, vector.z);
    }
  }
}

/**
 * Closes both native hands into the fists of the model's martial-art stance by bending the existing finger geometry once (this rig has no finger bones).
 * The thumbs fold across the fingers at `thumb` proportions of the native thumb (default `FIST_THUMB`; `{ length: 1, girth: 1 }` is the native thumb).
 * The edit owns a copy of the position/normal/tangent buffers only; skin weights stay those of the hand bone, so the fists follow every animation, and the
 * source geometry is never touched. `releaseHandGeometry(edit)` restores the original.
 */
export function fitUnarmedFists(root: Object3D, thumb: ThumbProportions = FIST_THUMB): HandGeometryEdit {
  let mesh: SkinnedMesh | undefined;
  root.traverse(node => { if (!mesh && node instanceof SkinnedMesh && HAND_SIDES.every(side => node.skeleton.getBoneByName(PropertyBinding.sanitizeNodeName(`mixamorig:${side}Hand`)))) mesh = node; });
  if (!mesh) throw new Error('The hero has no native skinned hands.');
  const original = mesh.geometry, used = referencedMask(original);
  const shapes = HAND_SIDES.map(side => fistShape(mesh!, side, used));
  const edited = ownedGeometry(original, ['position', 'normal', 'tangent']);
  const positions = edited.getAttribute('position') as BufferAttribute, normals = edited.getAttribute('normal') as BufferAttribute | undefined, tangents = edited.getAttribute('tangent') as BufferAttribute | undefined;
  const indices = edited.getAttribute('skinIndex') as BufferAttribute, weights = edited.getAttribute('skinWeight') as BufferAttribute;
  const edit = { mesh, original, edited };
  try {
    for (const shape of shapes) {
      foldThumb(shape, original, positions, normals, tangents, indices, weights, used, thumb);
      curlFingers(shape, original, positions, normals, tangents, indices, weights, used);
    }
    edited.computeBoundingBox(); edited.computeBoundingSphere();
    mesh.geometry = edited;
    return edit;
  } catch (error) { releaseHandGeometry(edit); throw error; }
}
