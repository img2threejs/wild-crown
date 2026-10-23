import type { CampaignState } from "../../packages/campaign/src/index.js";
import type { CompanionId, CompanionParty, CompanionProgress, RegionDefinition, RegionEntityDefinition, Vec3 } from "../game/contracts.js";
import { ACTORS } from "../content/world.js";
import { arenaFromRegion, groundHeightAt, isCirclePathClear, isSupportedCapsulePose } from "../game/combat/geometry.js";
import { actorCollisionBody } from "../game/combat/ActorBody.js";
import { companionAccessOf } from "../game/campaign/access.js";

interface PartyProjectionInput {
  readonly region: RegionDefinition;
  readonly party: CompanionParty;
  readonly companions: Readonly<Record<CompanionId, CompanionProgress>>;
  readonly worldFacts: Readonly<Record<string, boolean | number | string>>;
  readonly spawnPosition: Vec3 | null;
  /** The campaign state the companions' earned progression belongs to; the access authority reads its faction state. */
  readonly campaign?: CampaignState;
}

const DIRECTIONS = [[1, 0], [-1, 0], [0, 1], [0, -1], [.707, .707], [-.707, .707], [.707, -.707], [-.707, -.707]] as const;
const FORMATION_RADII = [2.8, 4.4, 6] as const;

/**
 * Place the selected traveling party beside the real spawn, before native asset loading.
 * Positions use the simulation's supported-capsule/path checks. Failure aborts the load;
 * a partial party is never silently committed or parked across the region.
 */
export function projectPartyIntoRegion(input: PartyProjectionInput): { entities: readonly RegionEntityDefinition[]; assetIds: readonly string[] } {
  const { region, party, companions, worldFacts } = input;
  const origin = input.spawnPosition ?? region.entrances[0]?.from ?? region.navigation.nodes[0]?.position;
  if (!origin) throw new Error(`Region ${region.id} has no party arrival position.`);
  const arena = arenaFromRegion(region);
  const occupied: { position: Vec3; radius: number }[] = [{ position: origin, radius: .5 }];
  for (const entity of region.entities) {
    if (entity.kind === "actor" && (!entity.visibleWhen || worldFacts[entity.visibleWhen] === true)) {
      occupied.push({ position: entity.position, radius: 1.1 });
    }
  }
  const entities: RegionEntityDefinition[] = [];
  const assetIds = new Set<string>();
  if (party.companionId) {
    const id = party.companionId;
    const progress = companions[id];
    // Only an earned companion may be projected into the traveling party. The access authority is the same one the
    // map, the party panel and the equip action read, so an unearned companion is refused before any asset loads.
    if (input.campaign) {
      const access = companionAccessOf(
        id,
        progress,
        input.campaign,
        worldFacts["solkar-exiled"] === true,
        worldFacts.solkarPresent === false,
      );
      if (!access.available) throw new Error(access.reason ?? "This companion cannot join your party.");
    } else if (id === "solkar" && (worldFacts["solkar-exiled"] === true || progress?.storyFlags["solkar-exiled"] === true)) {
      // No campaign state to consult: the exile fact alone still refuses an exiled Solkar.
      throw new Error("An explicitly exiled Solkar cannot be projected into the traveling party.");
    }
    const definition = ACTORS[id];
    if (!definition) throw new Error(`Selected companion ${id} has no canonical actor definition.`);
    const { radius, height } = actorCollisionBody(definition.species);
    let position: Vec3 | undefined;
    for (const distance of FORMATION_RADII) {
      for (const [dx, dz] of DIRECTIONS) {
        const x = origin.x + dx * distance, z = origin.z + dz * distance;
        const y = groundHeightAt(arena, x, z, origin.y);
        if (y === null || Math.abs(y - origin.y) > 1.2) continue;
        const candidate = { x, y, z };
        if (occupied.some(other => Math.hypot(x - other.position.x, z - other.position.z) < radius + other.radius + .3)) continue;
        if (!isSupportedCapsulePose(arena, candidate, radius, height)) continue;
        // Followers stop beside the player; their larger capsule need not fit
        // the player's exact point at a ledge-side arrival.
        const separation = radius + .5 + .3;
        const length = Math.hypot(x - origin.x, z - origin.z);
        const approachX = origin.x + (x - origin.x) * separation / length;
        const approachZ = origin.z + (z - origin.z) * separation / length;
        const approachY = groundHeightAt(arena, approachX, approachZ, origin.y);
        if (approachY === null || !isCirclePathClear(arena, candidate, { x: approachX, y: approachY, z: approachZ }, radius, height)) continue;
        position = candidate;
        break;
      }
      if (position) break;
    }
    if (!position) throw new Error(`Cannot place selected companion ${id} safely beside the ${region.id} arrival.`);
    entities.push({ id: `${id}__party_companion`, actorId: id, assetId: definition.assetId, placement: "ground", position, kind: "actor" });
    occupied.push({ position, radius });
    assetIds.add(definition.assetId);
  }
  return { entities, assetIds: [...assetIds] };
}