import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTORS,
  INTERACTIONS,
  REGIONS,
} from "../../src/content/world.js";
import {
  ACT_I_REGIONS,
  ACT_I_REGION_AUTHORING_STATUS,
  FIRST_PACT_LOCATIONS,
} from "../../src/content/levels/act-i.js";
import { CHAPTERS } from "../../src/content/story.js";
import { distanceToWalkMesh } from "../../src/world/GreenwakeBoundary.js";

const epsilon = 1e-5;

function triangleHeightAt(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
  c: { x: number; y: number; z: number },
  x: number,
  z: number,
): number | undefined {
  const denominator = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
  if (Math.abs(denominator) < epsilon) return undefined;
  const wa = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / denominator;
  const wb = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / denominator;
  const wc = 1 - wa - wb;
  if (wa < -epsilon || wb < -epsilon || wc < -epsilon) return undefined;
  return wa * a.y + wb * b.y + wc * c.y;
}

function surfaceContains(
  surface: (typeof ACT_I_REGIONS)[number]["ground"]["surfaces"][number],
  position: { x: number; y: number; z: number },
): boolean {
  for (let index = 1; index < surface.points.length - 1; index += 1) {
    const height = triangleHeightAt(
      surface.points[0]!,
      surface.points[index]!,
      surface.points[index + 1]!,
      position.x,
      position.z,
    );
    if (height !== undefined && Math.abs(height - position.y) <= 0.15) return true;
  }
  return false;
}

function surfaceAt(
  region: (typeof ACT_I_REGIONS)[number],
  position: { x: number; y: number; z: number },
) {
  return region.ground.surfaces.find(
    (surface) => surface.walkable && surfaceContains(surface, position),
  );
}

function regionById(id: string) {
  const result = REGIONS.find((entry) => entry.id === id);
  assert.ok(result, `missing registered region ${id}`);
  return result;
}

function directedNodeReachable(
  region: (typeof ACT_I_REGIONS)[number],
  from: string,
  to: string,
  facts: ReadonlySet<string>,
): boolean {
  const nodes = new Map(region.navigation.nodes.map((node) => [node.id, node]));
  const pending = [from];
  const visited = new Set<string>();
  while (pending.length) {
    const id = pending.shift()!;
    if (id === to) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = nodes.get(id);
    if (!node) continue;
    for (const link of node.links) {
      const next = nodes.get(link);
      if (next && (!next.requirement || facts.has(next.requirement))) pending.push(link);
    }
  }
  return false;
}

function directedRegionReachable(from: string, to: string, facts: ReadonlySet<string>): boolean {
  const pending = [from];
  const visited = new Set<string>();
  while (pending.length) {
    const id = pending.shift()!;
    if (id === to) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    const region = regionById(id);
    for (const route of region.exits) {
      if (!route.unlockFact || facts.has(route.unlockFact)) pending.push(route.destinationRegionId);
    }
  }
  return false;
}

function restoreFacts(): ReadonlySet<string> {
  return new Set(REGIONS.flatMap((region) => [
    `restoration:${region.id}:partial`,
    `restoration:${region.id}:restored`,
  ]));
}
function completeCampaignFacts(): ReadonlySet<string> {
  const facts = new Set(restoreFacts());
  facts.add("refugeOpen");
  return facts;
}

function polygonAreaXZ(points: readonly { x: number; z: number }[]): number {
  let doubledArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const next = points[(index + 1) % points.length]!;
    const current = points[index]!;
    doubledArea += current.x * next.z - next.x * current.z;
  }
  return Math.abs(doubledArea) / 2;
}

test("Act I walks authored grounded polygons with exact linked surface colliders", () => {
  assert.equal(ACT_I_REGION_AUTHORING_STATUS, "unaccepted");
  assert.deepEqual(ACT_I_REGIONS.map((region) => region.id), [
    "greenwake",
    "whispering-canopy",
    "blood-bamboo-valley",
    "the-grove",
  ]);

  for (const authored of ACT_I_REGIONS) {
    const region = regionById(authored.id);
    assert.equal(region.authoringStatus, "unaccepted");
    const colliders = new Map(region.ground.colliders.map((collider) => [collider.id, collider]));
    const surfaceIds = new Set(region.ground.surfaces.map((surface) => surface.id));
    const entityInstanceIds = region.entities.map((entity) => entity.id);
    assert.equal(new Set(entityInstanceIds).size, entityInstanceIds.length, "each placed actor/entity instance ID is unique");

    assert.ok(region.ground.surfaces.length >= 5, `${region.id} has authored traversal spaces`);
    for (const surface of region.ground.surfaces) {
      assert.ok(surface.walkable, `${region.id}/${surface.id} is navigable`);
      assert.ok(surface.points.length >= 4, `${surface.id} has a polygon boundary`);
      assert.ok(polygonAreaXZ(surface.points) > epsilon, `${surface.id} is non-degenerate`);
      const collider = colliders.get(surface.colliderId);
      assert.ok(collider, `${surface.id} resolves its exact colliderId`);
      assert.equal(collider!.walkSurfaceId, surface.id, `${surface.id} collider points back to that surface`);
      assert.ok(collider!.blocksMovement || collider!.kind === "segment", `${surface.id} has a traversable physical proxy`);
    }
    for (const collider of region.ground.colliders) {
      if (collider.walkSurfaceId) {
        assert.ok(surfaceIds.has(collider.walkSurfaceId), `${collider.id} refers to a real walk polygon`);
        assert.equal(
          region.ground.surfaces.find((surface) => surface.id === collider.walkSurfaceId)?.colliderId,
          collider.id,
          `${collider.id} and its surface keep a bidirectional link`,
        );
      }
    }

    const facts = completeCampaignFacts();
    for (const node of region.navigation.nodes) {
      assert.ok(surfaceAt(authored, node.position), region.id + "/" + node.id + " must be on an authored walk polygon");
      for (const nextId of node.links) {
        assert.ok(region.navigation.nodes.some((next) => next.id === nextId), `${node.id} links to ${nextId}`);
      }
      if (node.requirement) {
        assert.ok(facts.has(node.requirement), `${node.id} uses a campaign restoration fact, not a local invented flag`);
      }
    }
    const start = region.navigation.nodes[0];
    assert.ok(start, `${region.id} has a navigation root`);
    for (const node of region.navigation.nodes) {
      assert.ok(
        directedNodeReachable(authored, start!.id, node.id, facts),
        `${region.id} directed navigation reaches ${node.id}`,
      );
    }
    assert.ok(region.navigation.ribbons.every((ribbon) => ribbon.points.length >= 2), "each navigation ribbon has route anchors");
    for (const routeRibbon of region.navigation.ribbons) {
      for (let index = 0; index < routeRibbon.points.length - 1; index += 1) {
        const startPoint = routeRibbon.points[index]!;
        const endPoint = routeRibbon.points[index + 1]!;
        for (let step = 0; step <= 8; step += 1) {
          const fraction = step / 8;
          const point = {
            x: startPoint.x + (endPoint.x - startPoint.x) * fraction,
            y: startPoint.y + (endPoint.y - startPoint.y) * fraction,
            z: startPoint.z + (endPoint.z - startPoint.z) * fraction,
          };
          assert.ok(surfaceAt(authored, point), region.id + "/" + routeRibbon.id + " segment " + index + " step " + step + " is on a walk surface");
        }
      }
    }

    for (const route of [...region.exits, ...region.traversalArcs]) {
      assert.ok(route.anchors.length >= 2, `${route.id} has route anchors`);
      assert.ok(route.anchors.every((point) => Number.isFinite(point.x + point.y + point.z)));
      assert.ok(route.colliderIds.length > 0, `${route.id} uses physical source geometry`);
      for (const colliderId of route.colliderIds) {
        assert.ok(colliders.has(colliderId), `${route.id} resolves source collider ${colliderId}`);
      }
      assert.ok(surfaceAt(authored, route.from), "route begins on its authored surface");
      if (route.destinationRegionId === region.id) {
        assert.ok(surfaceAt(authored, route.to), "local route ends on its authored surface");
      } else if (ACT_I_REGIONS.some((candidate) => candidate.id === route.destinationRegionId)) {
        const destinationRegion = ACT_I_REGIONS.find((candidate) => candidate.id === route.destinationRegionId);
        assert.ok(destinationRegion, "route targets another authored Act I region");
        assert.ok(surfaceAt(destinationRegion!, route.to), "route arrives on the destination region surface");
      }
      if (route.unlockFact === "refugeOpen") {
        assert.ok(CHAPTERS.some((chapter) => chapter.number === 6 && chapter.requiredBeats.includes("refuge-opening")));
      } else if (route.unlockFact) {
        assert.ok(facts.has(route.unlockFact), "route unlock facts are produced by a campaign restoration event");
        assert.ok(route.unlockFact === "restoration:" + region.id + ":partial" || route.unlockFact === "restoration:" + region.id + ":restored", "route gates use an existing environment restoration fact");
      }
    }

    for (const entity of region.entities) {
      if (entity.kind === "interaction") {
        const interaction = INTERACTIONS.find((entry) => entry.id === entity.interactionId);
        assert.ok(interaction, `${region.id}/${entity.id} is a registered gameplay interaction`);
        assert.equal(interaction!.regionId, region.id);
        assert.equal(entity.id, entity.interactionId);
        assert.ok(surfaceAt(authored, entity.position), "interaction occupies its authored target position");
      } else if (entity.kind === "actor") {
        const actor = entity.actorId ? ACTORS[entity.actorId] : undefined;
        assert.ok(actor, `${region.id}/${entity.id} uses a canonical ACTORS archetype`);
        assert.equal(actor!.assetId, entity.assetId, `${entity.id} uses the archetype's manifest asset`);
      }
    }
    assert.equal(region.encounterIds.length, Object.keys(region.encounterParticipants).length);
    for (const encounterId of region.encounterIds) {
      const participantIds = region.encounterParticipants[encounterId];
      assert.ok(participantIds && participantIds.length > 0, "encounter has concrete participant instances");
      assert.equal(new Set(participantIds).size, participantIds.length);
      for (const participantId of participantIds) {
        assert.ok(region.entities.some((entity) => entity.id === participantId && entity.kind === "actor"));
      }
    }
    for (const placement of region.props) {
      if (region.id === "greenwake") {
        // The Greenwake route is sealed: a placement is either authored route furniture standing on the walk-mesh or
        // visual-only dressing whose centre stays at least 0.5 m off it; nothing straddles the route edge.
        const onRoute = surfaceAt(authored, placement.position) !== undefined;
        assert.ok(onRoute || distanceToWalkMesh(authored, placement.position.x, placement.position.z) >= 0.5, `${placement.id} neither stands on nor clears the walk-mesh`);
        if (/^greenwake-(corridor-)?edge-tree-/.test(placement.id)) assert.ok(!onRoute, `${placement.id} is off-route dressing`);
      } else {
        assert.ok(surfaceAt(authored, placement.position), "canonical asset placement sits on visible authored terrain");
      }
    }

    for (const route of region.exits) {
      assert.ok(
        REGIONS.some((destination) => destination.id === route.destinationRegionId),
        `${route.id} has a registered destination region`,
      );
    }
  }
});

test("Hunter Camp stages a distinct grounded loose snare and preserves the tracking snare", () => {
  const camp = ACT_I_REGIONS.find((region) => region.id === "blood-bamboo-valley");
  assert.ok(camp);
  const looseSnare = camp!.props.filter((placement) => placement.id === "camp-loose-snare");
  assert.equal(looseSnare.length, 1);
  assert.equal(looseSnare[0]!.assetId, "prop-broken-snare");
  assert.deepEqual(looseSnare[0]!.position, { x: -26, y: 0, z: -22 });
  assert.equal(surfaceAt(camp!, looseSnare[0]!.position)?.id, "bamboo-camp-terrace");

  const koro = camp!.entities.find((entity) => entity.id === "bamboo-koro");
  assert.ok(koro);
  assert.equal(Math.hypot(koro!.position.x - looseSnare[0]!.position.x, koro!.position.z - looseSnare[0]!.position.z), 2);

  const trackingSnare = camp!.props.find((placement) => placement.id === "bamboo-broken-snare");
  assert.ok(trackingSnare);
  assert.equal(trackingSnare!.assetId, "prop-broken-snare");
  assert.deepEqual(trackingSnare!.position, { x: 22, y: 0, z: 8 });
  assert.equal(surfaceAt(camp!, trackingSnare!.position)?.id, "bamboo-tracking-floor");
  const looseSnareMove = camp!.movableObjects.filter((object) => object.id === "camp-loose-snare");
  assert.equal(looseSnareMove.length, 1);
  const movement = looseSnareMove[0]!;
  assert.deepEqual(movement, {
    id: "camp-loose-snare",
    assetId: "prop-broken-snare",
    from: { x: -26, y: 0, z: -22 },
    to: { x: -15, y: 0, z: -27 },
    supportSurfaceId: "bamboo-camp-terrace",
    radiusMeters: 2.5,
    animationTicks: 24,
    requiredCompanionId: "koro",
    koroInteractionId: "koro-drop-object",
    playerInteractionId: "player-drop-object",
    movedFactId: "objectMoved:camp-loose-snare",
    requiredFacts: [],
    effect: { kind: "distraction", targetActorInstanceId: "hunter-ranged", radiusMeters: 2.5, interruptRangedWindupTicks: 24 },
  });
  assert.equal(surfaceAt(camp!, movement.from)?.id, movement.supportSurfaceId);
  assert.equal(surfaceAt(camp!, movement.to)?.id, movement.supportSurfaceId);
  for (const other of ACT_I_REGIONS.filter((region) => region.id !== camp!.id)) {
    assert.deepEqual(other.movableObjects, []);
  }

  for (const interactionId of [movement.koroInteractionId, movement.playerInteractionId]) {
    const entity: (typeof ACT_I_REGIONS)[number]["entities"][number] | undefined = camp!.entities.find((entry) => entry.id === interactionId);
    assert.ok(entity);
    assert.equal(entity!.kind, "interaction");
    assert.equal(entity!.interactionId, interactionId);
    assert.deepEqual(entity!.position, movement.from);
    const interaction = INTERACTIONS.find((entry) => entry.id === interactionId);
    assert.ok(interaction);
    assert.equal(interaction!.regionId, camp!.id);
    assert.equal(interaction!.targetId, movement.id);
    assert.equal(interaction!.kind, "move-object");
    assert.deepEqual(interaction!.requiresFacts, []);
  }
  const koroInteraction = INTERACTIONS.find((entry) => entry.id === movement.koroInteractionId);
  assert.ok(koroInteraction);
  assert.deepEqual(koroInteraction!.requiresActors, ["koro"]);
  assert.deepEqual(koroInteraction!.requiresCompanionCommand, { companionId: "koro", slot: "utility", command: "special" });
  const playerInteraction = INTERACTIONS.find((entry) => entry.id === movement.playerInteractionId);
  assert.ok(playerInteraction);
  assert.deepEqual(playerInteraction!.requiresActors, []);
  assert.equal(playerInteraction!.playerActionId, "staff-heavy");
});

test("First Pact's six directed mission beats occupy real reachable region nodes", () => {
  assert.deepEqual(FIRST_PACT_LOCATIONS.map((location) => location.segment), [
    "Forest Entry",
    "Monkey Chase",
    "Hunter Camp",
    "Tiger Tracking",
    "Asha Boss",
    "The First Pact",
  ]);
  assert.equal(FIRST_PACT_LOCATIONS.length, 6);
  const facts = completeCampaignFacts();

  for (const location of FIRST_PACT_LOCATIONS) {
    const authored = ACT_I_REGIONS.find((entry) => entry.id === location.regionId);
    assert.ok(authored, `${location.segment} has an Act I region`);
    const node = authored!.navigation.nodes.find((entry) => entry.id === location.nodeId);
    assert.ok(node, `${location.segment} references a real navigation node`);
    assert.ok(surfaceAt(authored!, node!.position), "mission node starts on a grounded authored location");
    assert.ok(location.entityIds.length > 0, `${location.segment} references concrete gameplay entities`);
    for (const entityId of location.entityIds) {
      const entity: (typeof ACT_I_REGIONS)[number]["entities"][number] | undefined =
        authored!.entities.find((entry) => entry.id === entityId);
      assert.ok(entity, `${location.segment} resolves entity instance ${entityId}`);
      if (entity!.kind === "actor") {
        assert.ok(entity!.actorId && ACTORS[entity!.actorId], `${entityId} is a real actor instance`);
      } else if (entity!.kind === "interaction") {
        assert.ok(INTERACTIONS.some((interaction) => interaction.id === entity!.interactionId), `${entityId} is a real interaction`);
      }
    }
  }

  for (let index = 0; index < FIRST_PACT_LOCATIONS.length; index += 1) {
    const current = FIRST_PACT_LOCATIONS[index]!;
    const region = ACT_I_REGIONS.find((entry) => entry.id === current.regionId)!;
    const start = region.navigation.nodes[0]!;
    assert.ok(directedNodeReachable(region, start.id, current.nodeId, facts), `${current.segment} is locally reachable`);
    const next = FIRST_PACT_LOCATIONS[index + 1];
    if (!next) continue;
    if (current.regionId === next.regionId) {
      assert.ok(directedNodeReachable(region, current.nodeId, next.nodeId, facts), `${current.segment} reaches ${next.segment}`);
    } else {
      assert.ok(directedRegionReachable(current.regionId, next.regionId, facts), `${current.segment} can travel to ${next.segment}`);
    }
  }

  const canopy = regionById("whispering-canopy");
  const lowRoute = canopy.navigation.nodes.find((node) => node.id === "canopy-monkey-ground-alternative");
  const highRoute = canopy.navigation.nodes.find((node) => node.id === "canopy-upper-bough");
  assert.ok(lowRoute && highRoute, "Monkey Chase authors both grounded and canopy routes");
  assert.ok(directedNodeReachable(canopy as (typeof ACT_I_REGIONS)[number], "canopy-monkey-launch", lowRoute!.id, facts));
  assert.ok(directedNodeReachable(canopy as (typeof ACT_I_REGIONS)[number], "canopy-monkey-launch", highRoute!.id, facts));

  const bamboo = regionById("blood-bamboo-valley");
  const campEncounter = bamboo.encounterParticipants["camp-hunters"];
  assert.deepEqual(campEncounter, ["hunter-melee-west", "hunter-melee-east", "hunter-ranged"]);
  const refugeLift = INTERACTIONS.find((interaction) => interaction.id === "refuge-lift");
  assert.ok(refugeLift);
  assert.equal(refugeLift!.success.type, "traversal");
  if (refugeLift!.success.type === "traversal") assert.equal(refugeLift!.success.routeId, "grove-refuge");
  const pillar = INTERACTIONS.find((interaction) => interaction.id === "grove-pillar");
  assert.ok(pillar);
  assert.equal(pillar!.regionId, "the-grove");
  assert.equal(pillar!.kind, "coordinate");
  assert.deepEqual(bamboo.encounterParticipants["encounter-asha"], ["asha"]);
  assert.ok(bamboo.encounterIds.includes("camp-hunters") && bamboo.encounterIds.includes("encounter-asha"));
  assert.equal(ACTORS[bamboo.entities.find((entity) => entity.id === "hunter-melee-west")!.actorId!].assetId, "actor-poacher-hunter");
  assert.equal(ACTORS[bamboo.entities.find((entity) => entity.id === "hunter-melee-east")!.actorId!].assetId, "actor-poacher-hunter");
  assert.equal(ACTORS[bamboo.entities.find((entity) => entity.id === "hunter-ranged")!.actorId!].assetId, "actor-poacher-scout");

  const ashaEncounter = ACT_I_REGIONS.find((entry) => entry.id === "blood-bamboo-valley")!;
  assert.equal(ashaEncounter.encounterParticipants["encounter-asha"]?.[0], "asha");
  const grove = regionById("the-grove");
  assert.ok(grove.entities.some((entity) => entity.kind === "actor" && entity.id === "asha" && entity.visibleWhen === "restoration:the-grove:partial"));
  assert.ok(grove.entities.some((entity) => entity.kind === "actor" && entity.id === "tali" && entity.visibleWhen === "restoration:the-grove:restored"));
  const refugeRoute = grove.exits.find((route) => route.id === "grove-refuge-out");
  assert.ok(refugeRoute);
  assert.equal(refugeRoute!.unlockFact, "refugeOpen");
  assert.deepEqual(refugeRoute!.from, { x: 29, y: 0, z: -10 });
  assert.deepEqual(refugeRoute!.to, { x: -27, y: 0, z: -20 });
  assert.ok(surfaceAt(grove as (typeof ACT_I_REGIONS)[number], refugeRoute!.from));
  const refugeArc = grove.traversalArcs.find((route) => route.id === "grove-refuge");
  assert.ok(refugeArc);
  assert.deepEqual(refugeArc!.from, refugeRoute!.from);
  assert.deepEqual(refugeArc!.to, refugeRoute!.to);
  assert.equal(refugeArc!.unlockFact, "refugeOpen");
  assert.ok(refugeArc!.colliderIds.includes("grove-refuge-passage-collider"));
  const passage = grove.navigation.nodes.find((node) => node.id === "grove-refuge-passage");
  assert.ok(passage);
  assert.equal(passage!.requirement, "refugeOpen");
  assert.equal(directedNodeReachable(grove as (typeof ACT_I_REGIONS)[number], "grove-services", passage!.id, restoreFacts()), false);
  assert.equal(directedNodeReachable(grove as (typeof ACT_I_REGIONS)[number], "grove-services", passage!.id, completeCampaignFacts()), true);
  assert.equal(directedRegionReachable("the-grove", "refuge", restoreFacts()), false);
  assert.equal(directedRegionReachable("the-grove", "refuge", completeCampaignFacts()), true);
  const refuge = regionById("refuge");
  assert.ok(refuge.ground.surfaces.some((surface) => surface.walkable && surfaceContains(surface, refugeRoute!.to)));
  const reciprocal = refuge.entrances.find((entry) => entry.id === "grove-refuge-in");
  assert.ok(reciprocal);
  assert.deepEqual(reciprocal!.from, refugeRoute!.to);
  assert.deepEqual(reciprocal!.to, refugeRoute!.from);
  assert.equal(reciprocal!.traversalEvent, "grove-refuge");
});

test("Greenwake winds through authored collision geometry with three serialized corrupted-boar instances", () => {
  const greenwake = ACT_I_REGIONS.find((region) => region.id === "greenwake")!;

  // The Forest Entry mission beat now enumerates every Greenwake hostile archetype instance.
  const forestEntry = FIRST_PACT_LOCATIONS.find((entry) => entry.segment === "Forest Entry")!;
  assert.ok(forestEntry);
  for (const hostileId of ["corrupted-boar", "greenwake-sap-stalker", "greenwake-root-rammer"]) {
    assert.ok(forestEntry.entityIds.includes(hostileId), `${hostileId} is referenced by the Forest Entry beat`);
  }

  // All three hostile instances reuse the same authored candidate and asset.
  const hostileIds = ["corrupted-boar", "greenwake-sap-stalker", "greenwake-root-rammer"];
  const instances = hostileIds.map((id) => greenwake.entities.find((entry) => entry.id === id));
  assert.ok(instances.every((entity) => entity !== undefined), "every authored instance is placed");
  for (const entity of instances) {
    assert.equal(entity!.kind, "actor");
    assert.equal(entity!.actorId, "corrupted-boar");
    assert.equal(entity!.assetId, ACTORS["corrupted-boar"]!.assetId, "the instance keeps the same manifest asset as the archetype");
  }

  // Sequential proximity pressure: instances must be at least 6 m apart on the XZ plane so that
  // combat serialization can keep at most one enemy telegraph live at a time, while still pacing
  // pressure along the winding trail.
  const minimumSpacing = 6;
  for (let i = 0; i < instances.length; i += 1) {
    for (let j = i + 1; j < instances.length; j += 1) {
      const distance = Math.hypot(
        instances[i]!.position.x - instances[j]!.position.x,
        instances[i]!.position.z - instances[j]!.position.z,
      );
      assert.ok(distance >= minimumSpacing, `${instances[i]!.id} and ${instances[j]!.id} should be spaced for combat serialization`);
    }
  }

  // The authored route must visit a wider selection of walk polygons and reach the existing
  // grove exit; this catches accidental regressions that collapse the trail to the original
  // clearing.
  const newSurfaceIds = ["greenwake-stream-bend", "greenwake-sap-pools", "greenwake-boar-thicket"];
  for (const surfaceId of newSurfaceIds) {
    const surface = greenwake.ground.surfaces.find((entry) => entry.id === surfaceId);
    assert.ok(surface, `${surfaceId} is authored`);
    assert.ok(surface!.walkable);
    assert.ok(surface!.points.length >= 4);
    const collider = greenwake.ground.colliders.find((entry) => entry.id === surface!.colliderId);
    assert.ok(collider, `${surfaceId} has a paired collider`);
    assert.equal(collider!.walkSurfaceId, surfaceId);
  }

  const obstaclePlacements = [
    ["greenwake-fallen-bough", "greenwake-fallen-bough-visual"],
    ["greenwake-sap-pantry", "greenwake-sap-pantry-visual"],
    ["greenwake-root-buttress", "greenwake-root-buttress-visual"],
  ] as const;
  for (const [obstacleId, placementId] of obstaclePlacements) {
    const obstacle = greenwake.ground.colliders.find((entry) => entry.id === obstacleId);
    assert.ok(obstacle, `${obstacleId} is authored collision geometry`);
    assert.ok(obstacle!.blocksMovement, `${obstacleId} blocks player movement`);
    const visual = greenwake.props.find((placement) => placement.id === placementId);
    assert.ok(visual, `${obstacleId} has a visible authored obstacle prop`);
    assert.equal(visual!.position.x, obstacle!.from.x, `${placementId} is aligned to its collider`);
    assert.equal(visual!.position.z, obstacle!.from.z, `${placementId} is aligned to its collider`);
  }

  // The stream-detour ribbon should sample only walk polygons along every leg.
  const detour = greenwake.navigation.ribbons.find((ribbon) => ribbon.id === "greenwake-stream-detour");
  assert.ok(detour, "stream-detour ribbon is authored");
  for (let i = 0; i < detour!.points.length - 1; i += 1) {
    const startPoint = detour!.points[i]!;
    const endPoint = detour!.points[i + 1]!;
    for (let step = 0; step <= 8; step += 1) {
      const fraction = step / 8;
      const point = {
        x: startPoint.x + (endPoint.x - startPoint.x) * fraction,
        y: startPoint.y + (endPoint.y - startPoint.y) * fraction,
        z: startPoint.z + (endPoint.z - startPoint.z) * fraction,
      };
      assert.ok(surfaceAt(greenwake, point), `greenwake-stream-detour segment ${i} step ${step} stays on a walk polygon`);
    }
  }

  // The new nodes must remain reachable from the existing navigation root so spawn-to-exit
  // navigation still resolves.
  const facts = completeCampaignFacts();
  const start = greenwake.navigation.nodes[0]!;
  const requiredNodes = [
    "greenwake-stream-meander",
    "greenwake-stream-ford",
    "greenwake-sap-pools",
    "greenwake-boar-thicket-edge",
    "greenwake-grove-gateway",
  ];
  for (const nodeId of requiredNodes) {
    assert.ok(
      directedNodeReachable(greenwake, start.id, nodeId, facts),
      `${nodeId} is reachable from the navigation root`,
    );
  }

  // The route is sealed: no region-wide floor, and each trial arena pocket is a flat, collider-paired octagon.
  assert.ok(!greenwake.ground.surfaces.some((surface) => surface.id === "greenwake-canopy-floor"), "the region-wide canopy floor is gone");
  assert.ok(!greenwake.ground.colliders.some((collider) => collider.id === "greenwake-canopy-floor-collider"));
  for (const pocketId of ["greenwake-frost-hollow", "greenwake-root-watch"]) {
    const pocket = greenwake.ground.surfaces.find((entry) => entry.id === pocketId);
    assert.ok(pocket && pocket.walkable && pocket.points.length >= 5 && pocket.points.every((point) => point.y === 0), `${pocketId} is a flat y=0 arena pocket`);
    const collider = greenwake.ground.colliders.find((entry) => entry.id === pocket!.colliderId);
    assert.equal(collider?.kind, "box");
    assert.equal(collider?.walkSurfaceId, pocketId);
  }
  // The Forest Exit ring (2.2 m) lies completely on the final corridor.
  const forestExit = greenwake.exits.find((exit) => exit.id === "greenwake-grove-out")!;
  for (let step = 0; step < 24; step += 1) {
    const angle = (step / 24) * Math.PI * 2;
    assert.ok(
      surfaceAt(greenwake, { x: forestExit.from.x + Math.cos(angle) * 2.2, y: 0, z: forestExit.from.z + Math.sin(angle) * 2.2 }),
      "the Forest Exit goal ring is fully walkable",
    );
  }

  // The exploration camera anchors must continue to drive CameraDirector while it remains the
  // sole gameplay-camera writer: every non-encounter anchor should frame ahead of the player
  // (camera offset's z component is positive on the exploration rails).
  const explorationAnchors = greenwake.cameraAnchors.filter((anchor) => anchor.mode === "exploration");
  assert.ok(explorationAnchors.length >= 1, "exploration rails frame the winding trail");
  for (const anchor of explorationAnchors) {
    assert.ok(anchor.position.z - anchor.lookAt.z >= 4, `${anchor.id} frames forward of the player`);
  }
});
