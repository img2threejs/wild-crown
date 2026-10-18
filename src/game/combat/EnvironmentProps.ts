import type { EnvironmentPropSnapshot, RegionColliderDefinition, RegionDefinition, Vec3, WorldAssetPlacement } from '../contracts.js';
import { groundHeightAt, isImpactPathClear, moveAerialCircle, pointInSector, type CombatArena } from './geometry.js';

export const LOOSE_PROP_PREFIX = 'environment-loose-';
export type EnvironmentMaterial = EnvironmentPropSnapshot['material'];
interface MaterialResponse { health: number; resistance: number; mobility: number; radius: number; height: number }
const MATERIALS: Record<EnvironmentMaterial, MaterialResponse> = {
  wood: { health: 140, resistance: .24, mobility: .025, radius: .65, height: 3 },
  structure: { health: 180, resistance: 1.1, mobility: .04, radius: 3, height: 5 },
  foliage: { health: 16, resistance: 1, mobility: .22, radius: .45, height: .9 },
  stone: { health: 220, resistance: .1, mobility: 0, radius: .8, height: 1.2 },
  'loose-stone': { health: 18, resistance: .8, mobility: 1, radius: .18, height: .32 },
  'loose-wood': { health: 80, resistance: .9, mobility: .72, radius: .43, height: .95 },
};
const ROOTED_WOOD: Record<string, true> = {
  'prop-erya-edge-tree': true, 'prop-moonpine-tree': true, 'prop-rainforest-canopy-tree': true,
  'prop-savanna-acacia': true, 'prop-heartroot-trunk': true, 'prop-bamboo-cluster': true, 'prop-bamboo-grove': true,
};
const STRUCTURES: Record<string, true> = { 'prop-greenwake-houses': true };
const FOLIAGE: Record<string, true> = { 'prop-canopy-fern-cluster': true, 'prop-mistveil-reed-cluster': true };
const STONE: Record<string, true> = {
  'prop-greenwake-boulder-cluster': true, 'prop-canopy-cliff-rock': true,
  'prop-snow-ridge-rock': true, 'prop-mire-bank-rock': true, 'prop-bamboo-stone': true,
};
const PROTECTED_ROUTE_PROPS: Record<string, true> = { 'greenwake-corridor-tree-cluster-visual': true };

type EnvironmentPose = { -readonly [K in keyof EnvironmentPropSnapshot]: EnvironmentPropSnapshot[K] };
type MutableVec3 = { -readonly [K in keyof Vec3]: Vec3[K] };
export interface EnvironmentProp extends Omit<EnvironmentPose, 'offset' | 'position'> {
  position: MutableVec3;
  origin: Vec3;
  velocity: MutableVec3;
  angularVelocity: { x: number; z: number };
  health: number;
  radius: number;
  sleeping: boolean;
  collisionHeight: number;
}
export interface EnvironmentState {
  props: EnvironmentProp[];
  sequence: number;
  actionKey?: string;
  /** A sustained contact may call resolution repeatedly; each prop receives that attack only once. */
  contacts: { key: string; touchedAtWorldTick: number; propIds: string[] }[];
}
export function emptyEnvironment(): EnvironmentState { return { props: [], contacts: [], sequence: 0 }; }

export function isLooseEnvironmentProp(prop: WorldAssetPlacement): boolean {
  if (!prop.id.startsWith(LOOSE_PROP_PREFIX)) return false;
  const scale = Math.max(prop.scale.x, prop.scale.y, prop.scale.z);
  return prop.assetId === 'prop-wooden-crate-stack' ? scale <= 1.25 : STONE[prop.assetId] === true && scale <= .16;
}

function materialFor(prop: WorldAssetPlacement): EnvironmentMaterial | undefined {
  if (isLooseEnvironmentProp(prop)) return prop.assetId === 'prop-wooden-crate-stack' ? 'loose-wood' : 'loose-stone';
  if (STRUCTURES[prop.assetId]) return 'structure';
  if (ROOTED_WOOD[prop.assetId]) return 'wood';
  if (FOLIAGE[prop.assetId]) return 'foliage';
  if (STONE[prop.assetId]) return 'stone';
  return undefined;
}

/** Explicit material allowlist. Story props and conditional/native support placements never become loose bodies. */
export function createEnvironment(region: RegionDefinition, protectedIds: ReadonlySet<string>): EnvironmentState {
  const protectedProps = new Set(protectedIds);
  // A static house can flex/scuff even when it is an NPC interaction target. It never moves, collapses or changes a support.
  // Explicitly moved/delivered structures remain protected by the ownership checks below.
  for (const prop of region.props) if (STRUCTURES[prop.assetId]) protectedProps.delete(prop.id);
  for (const prop of region.movableObjects) protectedProps.add(prop.id);
  for (const delivery of region.deliveries ?? []) protectedProps.add(delivery.id);
  for (const collider of region.ground.colliders) {
    // Route dressing stays aligned; a house's bounded cosmetic flex never changes its authored blocker.
    for (const prop of region.props) if (!STRUCTURES[prop.assetId] && collider.id.includes(prop.id.replace(/-visual$/, ''))) protectedProps.add(prop.id);
  }
  const props: EnvironmentProp[] = [];
  for (const placement of region.props) {
    const material = materialFor(placement);
    if (!material || protectedProps.has(placement.id) || PROTECTED_ROUTE_PROPS[placement.id] || placement.visibleWhen) continue;
    const profile = MATERIALS[material];
    props.push({ id: placement.id, material, position: { ...placement.position }, origin: { ...placement.position }, velocity: { x: 0, y: 0, z: 0 }, angularVelocity: { x: 0, z: 0 }, sleeping: true, tiltX: 0, tiltZ: 0, health: profile.health, damage: 0, broken: false, radius: profile.radius, collisionHeight: profile.height, impactSerial: 0, impactWorldTick: -1 });
  }
  return { props, contacts: [], sequence: 0 };
}

/** Measured native bodies, rather than canopy size or guessed GLB coordinates, define physical contact. */
export function measureEnvironment(environment: EnvironmentState, colliders: readonly RegionColliderDefinition[]): void {
  for (const prop of environment.props) {
    let radius = 0, top = prop.origin.y;
    const prefix = `native:${prop.id}:`;
    for (const collider of colliders) {
      if (!collider.id.startsWith(prefix)) continue;
      const half = collider.halfExtents;
      radius = Math.max(radius, Math.hypot(collider.from.x - prop.origin.x, collider.from.z - prop.origin.z) + (half ? Math.hypot(half.x, half.z) : collider.radius ?? 0));
      top = Math.max(top, collider.from.y + (half?.y ?? collider.radius ?? 0));
    }
    if (radius > 0) prop.radius = radius;
    if (top > prop.origin.y) prop.collisionHeight = top - prop.origin.y;
  }
}

export function environmentDisk(prop: EnvironmentProp, center: Vec3, radius: number): boolean {
  return prop.position.y <= center.y + 1.1 && prop.position.y + prop.collisionHeight >= center.y - .2
    && Math.hypot(prop.position.x - center.x, prop.position.z - center.z) <= radius + prop.radius;
}
export function environmentCone(prop: EnvironmentProp, origin: Vec3, direction: Vec3, reach: number, angleDegrees: number): boolean {
  return prop.position.y <= origin.y + 1.1 && prop.position.y + prop.collisionHeight >= origin.y - .2
    && (Math.hypot(prop.position.x - origin.x, prop.position.z - origin.z) <= prop.radius
      || pointInSector(prop.position, origin, direction, reach + prop.radius, angleDegrees));
}
export function environmentLane(prop: EnvironmentProp, from: Vec3, to: Vec3, width: number): boolean {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z, lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((prop.position.x - from.x) * dx + (prop.position.z - from.z) * dz) / lengthSquared)) : 0;
  const y = from.y + dy * t;
  return prop.position.y <= y + width / 2 && prop.position.y + prop.collisionHeight >= y - width / 2
    && Math.hypot(prop.position.x - from.x - dx * t, prop.position.z - from.z - dz * t) <= width / 2 + prop.radius;
}

const rayStart = { x: 0, y: 0, z: 0 }, rayEnd = { x: 0, y: 0, z: 0 };
export function environmentReachable(prop: EnvironmentProp, arena: CombatArena, from: Vec3): boolean {
  const dx = prop.position.x - from.x, dz = prop.position.z - from.z, distance = Math.hypot(dx, dz);
  if (distance <= prop.radius + .12) return true;
  // End just before the target's own measured solid. Other props, walls, terrain and decks still occlude it.
  const t = (distance - prop.radius - .12) / distance;
  rayStart.x = from.x; rayStart.y = from.y + .35; rayStart.z = from.z;
  rayEnd.x = from.x + dx * t; rayEnd.y = prop.position.y + .35; rayEnd.z = from.z + dz * t;
  return isImpactPathClear(arena, rayStart, rayEnd);
}

/** Called exclusively by offensive simulation resolution. No StoryCue or render frame can award damage. */
export function impactEnvironment(environment: EnvironmentState, arena: CombatArena, worldTick: number, key: string, damage: number, origin: Vec3, contains: (prop: EnvironmentProp) => boolean, direction?: Vec3): boolean {
  if (!(damage > 0)) return false;
  let contact = environment.contacts.find(contact => contact.key === key);
  if (contact) contact.touchedAtWorldTick = worldTick;
  let changedCollider = false;
  for (const prop of environment.props) {
    if (prop.broken && prop.material === 'loose-wood') continue;
    if (contact?.propIds.includes(prop.id) || !contains(prop) || !environmentReachable(prop, arena, origin)) continue;
    if (!contact) { contact = { key, touchedAtWorldTick: worldTick, propIds: [] }; environment.contacts.push(contact); }
    contact.propIds.push(prop.id);
    const profile = MATERIALS[prop.material];
    const dx = direction?.x ?? prop.position.x - origin.x, dz = direction?.z ?? prop.position.z - origin.z;
    const length = Math.hypot(dx, dz), nx = length > .001 ? dx / length : 0, nz = length > .001 ? dz / length : -1;
    const distance = Math.max(0, Math.hypot(prop.position.x - origin.x, prop.position.z - origin.z) - prop.radius);
    const transferredDamage = damage / (1 + .18 * distance);
    const force = Math.min(4.5, .45 + Math.sqrt(transferredDamage) * .48);
    prop.health = Math.max(prop.material === 'structure' ? profile.health * .45 : 0, prop.health - transferredDamage * profile.resistance);
    prop.damage = 1 - prop.health / profile.health;
    if (prop.health === 0 && !prop.broken) { prop.broken = true; changedCollider ||= prop.material === 'foliage' || prop.material === 'loose-wood'; }
    if (prop.material === 'loose-wood' && prop.broken) {
      prop.sleeping = true;
      prop.velocity.x = prop.velocity.y = prop.velocity.z = 0;
    } else if (prop.material === 'loose-stone' || prop.material === 'loose-wood') {
      prop.sleeping = false;
      prop.velocity.x += nx * force * profile.mobility; prop.velocity.z += nz * force * profile.mobility;
      const speed = Math.hypot(prop.velocity.x, prop.velocity.z);
      if (speed > 4.5) { prop.velocity.x *= 4.5 / speed; prop.velocity.z *= 4.5 / speed; }
      prop.velocity.y = Math.min(2.2, prop.velocity.y + force * .36 * profile.mobility);
      // Crate stacks use upright swept bodies: no visual rotation below a floor that their collision body cannot represent.
      if (prop.material === 'loose-stone') { prop.angularVelocity.x += nz * force; prop.angularVelocity.z -= nx * force; }
    } else {
      prop.angularVelocity.x += nz * force * profile.mobility;
      prop.angularVelocity.z -= nx * force * profile.mobility;
    }
    prop.impactSerial++; prop.impactWorldTick = worldTick;
  }
  return changedCollider;
}

const motion = { x: 0, y: 0, z: 0 };
/** World time only: pause/hit-stop never advance this; slow motion supplies a smaller fixed step. */
export function stepEnvironment(environment: EnvironmentState, arena: CombatArena, worldTick: number, worldScale: number): void {
  const dt = worldScale / 60;
  if (dt <= 0) return;
  for (let i = environment.contacts.length - 1; i >= 0; i--) if (worldTick - environment.contacts[i]!.touchedAtWorldTick > 600) environment.contacts.splice(i, 1);
  for (const prop of environment.props) {
    if (!prop.impactSerial || prop.broken && prop.material === 'loose-wood') continue;
    if ((prop.material === 'loose-stone' || prop.material === 'loose-wood') && !prop.sleeping) {
      prop.velocity.y = Math.max(-8, prop.velocity.y - 9.8 * dt);
      motion.x = prop.velocity.x * dt; motion.y = prop.velocity.y * dt; motion.z = prop.velocity.z * dt;
      const moved = moveAerialCircle(arena, prop.position, motion, prop.radius, prop.collisionHeight);
      let x = moved.x, y = moved.y, z = moved.z;
      if (Math.abs(moved.x - prop.position.x - motion.x) > .005) prop.velocity.x *= -.2;
      if (Math.abs(moved.z - prop.position.z - motion.z) > .005) prop.velocity.z *= -.2;
      const floor = groundHeightAt(arena, x, z, prop.position.y);
      if (floor === null || Math.hypot(x - prop.origin.x, z - prop.origin.z) > 4) {
        // Loose bodies never escape playable support or cross a quest/traversal boundary.
        prop.velocity.x = prop.velocity.z = 0;
        x = prop.position.x; z = prop.position.z;
      }
      const landing = groundHeightAt(arena, x, z, prop.position.y) ?? prop.origin.y;
      if (y <= landing + .01 && prop.velocity.y <= 0) {
        y = landing;
        prop.velocity.y = Math.abs(prop.velocity.y) > .65 ? -prop.velocity.y * .18 : 0;
        const friction = Math.exp(-7 * dt);
        prop.velocity.x *= friction; prop.velocity.z *= friction;
      } else { prop.velocity.x *= Math.exp(-.7 * dt); prop.velocity.z *= Math.exp(-.7 * dt); }
      prop.position.x = x; prop.position.y = y; prop.position.z = z;
      if (y <= landing + .01 && Math.hypot(prop.velocity.x, prop.velocity.y, prop.velocity.z) < .035) {
        prop.velocity.x = prop.velocity.y = prop.velocity.z = 0;
        prop.sleeping = true;
      }
    }
    if (prop.material === 'loose-wood') continue;
    const loose = prop.material === 'loose-stone';
    const spring = loose ? 0 : 55, damping = loose ? 4 : 8;
    prop.angularVelocity.x += (-spring * prop.tiltX - damping * prop.angularVelocity.x) * dt;
    prop.angularVelocity.z += (-spring * prop.tiltZ - damping * prop.angularVelocity.z) * dt;
    const limit = loose ? Math.PI : prop.material === 'foliage' ? .55 : prop.material === 'structure' ? .008 : .045;
    prop.tiltX = Math.max(-limit, Math.min(limit, prop.tiltX + prop.angularVelocity.x * dt));
    prop.tiltZ = Math.max(-limit, Math.min(limit, prop.tiltZ + prop.angularVelocity.z * dt));
    if (loose) {
      if (Math.abs(prop.angularVelocity.x) < .0001) prop.angularVelocity.x = 0;
      if (Math.abs(prop.angularVelocity.z) < .0001) prop.angularVelocity.z = 0;
    } else if (Math.abs(prop.tiltX) + Math.abs(prop.tiltZ) + Math.abs(prop.angularVelocity.x) + Math.abs(prop.angularVelocity.z) < .0001) prop.tiltX = prop.tiltZ = prop.angularVelocity.x = prop.angularVelocity.z = 0;
  }
}

export function snapshotEnvironment(environment: EnvironmentState, presentationBaseline = -Infinity): EnvironmentPropSnapshot[] {
  const snapshots: EnvironmentPropSnapshot[] = [];
  for (const prop of environment.props) {
    if (!prop.impactSerial) continue;
    snapshots.push({ id: prop.id, material: prop.material, position: { ...prop.position }, offset: { x: prop.position.x - prop.origin.x, y: prop.position.y - prop.origin.y, z: prop.position.z - prop.origin.z }, tiltX: prop.tiltX, tiltZ: prop.tiltZ, damage: prop.damage, broken: prop.broken, impactSerial: prop.impactSerial, impactWorldTick: prop.impactWorldTick > presentationBaseline ? prop.impactWorldTick : -1 });
  }
  return snapshots;
}
