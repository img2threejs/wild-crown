import assert from "node:assert/strict";
import test from "node:test";
import { ACT_I_REGIONS } from "../../src/content/levels/act-i.js";
import { LATER_ACT_REGIONS, LATER_ACT_REGION_AUTHORING_STATUS } from "../../src/content/levels/later-acts.js";
function insidePolygon(x: number, z: number, points: readonly { x: number; z: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!, b = points[j]!;
    const crosses = (a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function surfaceAt(region: (typeof LATER_ACT_REGIONS)[number], p: { x: number; y: number; z: number }) {
  return region.ground.surfaces.find((surface) =>
    surface.walkable && surface.elevation === p.y && surface.points.every((point) => point.y === surface.elevation) &&
    insidePolygon(p.x, p.z, surface.points),
  );
}

function canReach(region: (typeof LATER_ACT_REGIONS)[number], from: string, to: string, facts: ReadonlySet<string> = new Set()): boolean {
  const nodes = new Map(region.navigation.nodes.map((node) => [node.id, node]));
  const visited = new Set<string>([from]);
  const pending = [from];
  while (pending.length) {
    const node = nodes.get(pending.shift()!);
    if (!node) return false;
    if (node.id === to) return true;
    for (const link of node.links) {
      const next = nodes.get(link);
      if (!next || (next.requirement && !facts.has(next.requirement)) || visited.has(link)) continue;
      visited.add(link);
      pending.push(link);
    }
  }
  return false;
}

const region = (id: string) => {
  const found = LATER_ACT_REGIONS.find((entry) => entry.id === id);
  assert.ok(found, `missing region ${id}`);
  return found;
};

test("later regions have authored connected travel graphs and collider-backed absolute-height polygons", () => {
  assert.equal(LATER_ACT_REGION_AUTHORING_STATUS, "unaccepted");
  assert.deepEqual(LATER_ACT_REGIONS.map((entry) => entry.id), ["moonpine-ridge", "mistveil-basin", "sunmane-expanse", "refuge", "heartroot-hollow"]);
  for (const level of LATER_ACT_REGIONS) {
    assert.equal(level.authoringStatus, "unaccepted");
    assert.deepEqual(level.movableObjects, []);
    const colliders = new Map(level.ground.colliders.map((collider) => [collider.id, collider]));
    assert.deepEqual(level.restorationStates, ["unvisited", "corrupted", "partial", "restored"]);
    const instanceIds = new Set<string>();
    for (const entity of level.entities) {
      assert.ok(!instanceIds.has(entity.id), `${entity.id} is a unique placement instance`);
      instanceIds.add(entity.id);
      if (entity.kind === "actor") assert.ok(entity.actorId && entity.assetId, `${entity.id} keeps its archetype and explicit asset`);
    }
    assert.ok(level.ground.surfaces.length >= 5, `${level.id} needs distinct authored walk spaces`);
    for (const surface of level.ground.surfaces) {
      assert.ok(surface.walkable);
      assert.ok(surface.points.length >= 5, `${surface.id} must be a designed polygon`);
      assert.ok(surface.points.every((point) => point.y === surface.elevation), `${surface.id} vertices use absolute Y`);
      const collider = colliders.get(surface.colliderId);
      assert.ok(collider, `${surface.id} must link its collider`);
      assert.equal(collider!.walkSurfaceId, surface.id);
      assert.ok(collider!.blocksMovement);
    }
    for (const node of level.navigation.nodes) {
      assert.ok(surfaceAt(level, node.position), `${level.id}/${node.id} sits on a walk surface`);
      for (const link of node.links) assert.ok(level.navigation.nodes.some((candidate) => candidate.id === link), `${node.id} has a valid directed link`);
    }
    for (const route of [...level.entrances, ...level.exits, ...level.traversalArcs]) {
      assert.ok(route.anchors.length >= 2, `${route.id} has a physical route`);
      assert.ok(route.anchors.every((point) => Number.isFinite(point.x + point.y + point.z)));
      assert.ok(route.colliderIds.length > 0);
    }
    for (const route of [...level.exits, ...level.traversalArcs]) {
      for (const id of route.colliderIds) assert.ok(colliders.has(id), `${route.id} references authored collider ${id}`);
    }
    for (const prop of level.props) assert.ok(surfaceAt(level, prop.position), `${level.id}/${prop.assetId} must stand on authored terrain`);
    for (const entity of level.entities) assert.ok(surfaceAt(level, entity.position), `${level.id}/${entity.id} must occupy an authored landing`);
    for (const arc of level.traversalArcs) {
      assert.ok(surfaceAt(level, arc.from), `${arc.id} starts on a walk surface`);
      assert.ok(surfaceAt(level, arc.to), `${arc.id} lands on a walk surface`);
    }
  }
  assert.ok(canReach(region("moonpine-ridge"), "entry", "summit"));
  assert.ok(canReach(region("mistveil-basin"), "west-bank", "ghor-arena"));
  assert.ok(canReach(region("sunmane-expanse"), "plains-entry", "high-terrace"));
  assert.ok(canReach(region("refuge"), "refuge-entry", "lift-landing"));
  assert.ok(canReach(region("heartroot-hollow"), "hollow-mouth", "orun-arena"));
});

test("chapter routes meet reciprocal region endpoints and gate the Hollow opening", () => {
  const pairs = [
    ["moonpine-ridge", "ridge-mist-out", "mistveil-basin", "ridge-mist-in"],
    ["mistveil-basin", "mist-sunmane-out", "sunmane-expanse", "mist-sunmane-in"],
    ["sunmane-expanse", "sunmane-refuge-out", "refuge", "sunmane-refuge-in"],
    ["refuge", "refuge-hollow-out", "heartroot-hollow", "refuge-hollow-in"],
    ["sunmane-expanse", "sunmane-hollow-out", "heartroot-hollow", "sunmane-hollow-in"],
  ] as const;
  for (const [sourceId, exitId, destinationId, entranceId] of pairs) {
    const exit = region(sourceId).exits.find((route) => route.id === exitId);
    const entrance = region(destinationId).entrances.find((route) => route.id === entranceId);
    assert.ok(exit && entrance);
    assert.deepEqual([entrance!.from, entrance!.to], [exit!.to, exit!.from]);
    assert.deepEqual(entrance!.colliderIds, exit!.colliderIds);
    assert.equal(entrance!.unlockFact, exit!.unlockFact);
    assert.deepEqual(entrance!.anchors, [...exit!.anchors].reverse());
    assert.ok(surfaceAt(region(sourceId), exit!.from), `${exitId} starts on its source walk surface`);
    assert.ok(surfaceAt(region(destinationId), exit!.to), `${exitId} lands on its destination walk surface`);
  }
  const actOnePairs = [
    ["the-grove", "grove-ridge-out", "moonpine-ridge", "grove-ridge-in"],
    ["blood-bamboo-valley", "bamboo-ridge-out", "moonpine-ridge", "bamboo-ridge-in"],
    ["the-grove", "grove-refuge-out", "refuge", "grove-refuge-in"],
  ] as const;
  for (const [sourceId, exitId, destinationId, entranceId] of actOnePairs) {
    const source = ACT_I_REGIONS.find((candidate) => candidate.id === sourceId);
    const exit = source?.exits.find((route) => route.id === exitId);
    const entrance = region(destinationId).entrances.find((route) => route.id === entranceId);
    assert.ok(source && exit && entrance);
    assert.deepEqual([entrance!.from, entrance!.to], [exit!.to, exit!.from]);
    assert.deepEqual(entrance!.anchors, [...exit!.anchors].reverse());
    assert.deepEqual(entrance!.colliderIds, exit!.colliderIds);
    assert.equal(entrance!.unlockFact, exit!.unlockFact);
    assert.ok(surfaceAt(source!, exit!.from), `${exitId} starts on its Act I walk surface`);
    assert.ok(surfaceAt(region(destinationId), exit!.to), `${exitId} lands on its later-act walk surface`);
  }
  const refugeGate = region("refuge").exits.find((route) => route.id === "refuge-hollow-out");
  const hollow = region("heartroot-hollow");
  assert.equal(refugeGate?.unlockFact, "hollow-opening");
  assert.ok(hollow.entrances.every((route) => route.unlockFact === "hollow-opening"));
});
test("Nyra reveal is actor-proximate and the fact-gated rootway remains navigable without a companion", () => {
  const basin = region("mistveil-basin");
  const nyra = basin.entities.find((entity) => entity.actorId === "nyra");
  const reveal = basin.entities.find((entity) => entity.interactionId === "nyra-reveal-hidden-route");
  assert.ok(nyra && reveal);
  assert.equal(reveal!.interactionId, "nyra-reveal-hidden-route");
  const actorDistance = Math.hypot(nyra!.position.x - reveal!.position.x, nyra!.position.y - reveal!.position.y, nyra!.position.z - reveal!.position.z);
  assert.ok(actorDistance <= 2, "Nyra's actor must remain inside the catalog's 2-meter interaction radius");

  const fact = "mistveil_nyra_hidden_route";
  const route = basin.exits.find((entry) => entry.id === "mistveil-hidden-route-out");
  const marker = basin.entities.find((entry) => entry.id === "mistveil-hidden-route-marker");
  assert.equal(route?.unlockFact, fact);
  const routeArc = basin.traversalArcs.find((entry) => entry.id === "mistveil-hidden-rootway");
  assert.equal(routeArc?.unlockFact, fact);
  assert.equal(marker?.visibleWhen, fact);
  assert.ok(route?.colliderIds.every((id) => basin.ground.colliders.some((collider) => collider.id === id)));
  assert.equal(canReach(basin, "player-route-start", "rootway-end"), false, "the alternate path stays concealed before its story fact");
  assert.equal(canReach(basin, "player-route-start", "rootway-end", new Set([fact])), true, "Aren can traverse the route after its fact without a companion requirement");
  assert.equal(canReach(basin, "west-bank", "ghor-arena"), true, "the main basin path does not depend on Nyra");
});

test("Sunmane and Refuge transitions retain political and post-collapse world state", () => {
  const savanna = region("sunmane-expanse");
  const envoy = savanna.entities.find((entity) => entity.actorId === "council-envoy");
  const solkar = savanna.entities.find((entity) => entity.actorId === "solkar");
  assert.ok(envoy && solkar);
  assert.equal(envoy!.visibleWhen, undefined);
  assert.equal(solkar!.visibleWhen, "solkarPresent", "an exiled Solkar is never summoned by regional authoring");
  assert.ok(savanna.navigation.nodes.some((node) => node.id === "migration-gate"));
  assert.ok(savanna.props.some((prop) => prop.assetId === "prop-migration-gate" && prop.position.y === 2));
  assert.ok(savanna.entities.some((entity) => entity.interactionId === "migration-gate"));
  assert.ok(savanna.traversalArcs.some((arc) => arc.id === "migration-gate-crossing" && arc.kind === "gate"));
  assert.ok(savanna.navigation.nodes.some((node) => node.id === "allotment"));
  assert.ok(savanna.navigation.nodes.some((node) => node.id === "crown-court"));

  const refuge = region("refuge");
  assert.match(refuge.biome, /sanctuary|refuge/i);
  assert.ok(refuge.ground.surfaces.some((surface) => surface.id === "refuge-collapse-rim"));
  assert.ok(refuge.exits.some((exit) => exit.id === "refuge-hollow-out" && exit.destinationRegionId === "heartroot-hollow"));
  assert.ok(refuge.entities.some((entity) => entity.interactionId === "refuge-council"));
  assert.ok(!refuge.entities.some((entity) => entity.actorId === "solkar"));
});

test("Hollow memories span six species spaces and every prop lands on its absolute authored floor", () => {
  const hollow = region("heartroot-hollow");
  assert.equal(hollow.ground.y, -36, "Hollow floor height is absolute, not compounded into its prop positions");
  assert.deepEqual(hollow.ground.surfaces.map((surface) => surface.elevation), [-36, -32, -27, -22, -13, -7]);
  for (const id of ["sky", "canopy", "fang", "pack", "shadow", "crown"]) {
    const memory = hollow.entities.find((entity) => entity.interactionId === `hollow-memory-${id}`);
    assert.ok(memory, `missing ${id} memory placement`);
    assert.ok(surfaceAt(hollow, memory!.position), `${id} memory uses the absolute surface height`);
  }
  for (const prop of hollow.props) {
    assert.ok(surfaceAt(hollow, prop.position), `${prop.assetId} is placed on an authored Hollow landing`);
  }
  const choice = hollow.entities.find((entity) => entity.interactionId === "hollow-crown-choice");
  assert.ok(choice && surfaceAt(hollow, choice.position));
});
