import assert from "node:assert/strict";
import test from "node:test";
import { CHAPTER_RUNTIME, LAYOUT_MIGRATIONS, RELATIONSHIP_RULES } from "../../src/content/chapters.js";
import { CAMPAIGN_CHOICES, QUESTS } from "../../src/content/quests.js";
import { NARRATIVE_CUES, isCueBeatAuthored } from "../../src/content/narrative-cues.js";
import { STORY_DIALOGUE } from "../../src/content/story.js";
import { INTERACTIONS, REGIONS } from "../../src/content/world.js";
import { ACT_I_INTERACTIONS } from "../../src/content/act-i-interactions.js";
import { LATER_ACT_INTERACTIONS } from "../../src/content/later-act-interactions.js";
import { eventMatches } from "../../src/game/campaign/events.js";
import { resolveSafeNode } from "../../src/game/campaign/safeSpawn.js";
import { BOSS_ENCOUNTERS, WILDLIFE_ENCOUNTERS } from "../../src/game/combat/content.js";
import { CombatEngine } from "../../src/game/combat/CombatEngine.js";
import { commandCompanion, stepCompanions } from "../../src/game/companions/CompanionSystem.js";
import type { ObjectiveDefinition, QuestDefinition, RegionDefinition, WorldEvent } from "../../src/game/contracts.js";

const ACT_I_QUEST_IDS = [
  "prologue", "fallen-scout", "thief-in-the-branches", "empty-orchard", "tracks-without-blood", "the-ash-hunters", "a-mothers-roar",
] as const;
const quests: readonly QuestDefinition[] = ACT_I_QUEST_IDS.map((id) => QUESTS.find((quest) => quest.id === id)!);
const region = (id: string): RegionDefinition => REGIONS.find((candidate) => candidate.id === id)!;
const objectives: readonly (readonly [QuestDefinition, ObjectiveDefinition])[] = quests.flatMap((quest) => quest.objectives.map((objective) => [quest, objective] as const));
const FACT_FOR_ALL = new Set<string>();

/** Authored event grammar; companion events additionally come from their actual runtime producer. */
function producedEvents(): readonly { readonly source: string; readonly event: WorldEvent }[] {
  const events: { source: string; event: WorldEvent }[] = [];
  const base = { eventId: "e", idempotencyKey: "k" } as const;
  const position = { x: 0, y: 0, z: 0 };
  for (const interaction of ACT_I_INTERACTIONS) {
    const success = interaction.success;
    if (success.type === "semantic-interaction") events.push({ source: interaction.id, event: { ...base, type: "semantic-interaction", actorId: "aren", interactionId: interaction.id, kind: success.kind, targetId: success.targetId, position } });
    else if (success.type === "rescue") events.push({ source: interaction.id, event: { ...base, type: "rescue", targetId: success.targetId, locationId: success.locationId, safe: true } });
    else if (success.type === "fragment") events.push({ source: interaction.id, event: { ...base, type: "fragment", fragmentId: success.fragmentId, sourceId: success.sourceId } });
    else if (success.type === "restoration") events.push({ source: interaction.id, event: { ...base, type: "restoration", regionId: success.regionId, state: success.state, causeId: success.causeId } });
    else if (success.type === "choice") for (const optionId of success.optionIds) events.push({ source: interaction.id + ":" + optionId, event: { ...base, type: "choice", choiceId: success.choiceId, optionId } });
  }
  for (const region of REGIONS) {
    for (const encounterId of region.encounterIds) {
      events.push({ source: "encounter:" + encounterId, event: { ...base, type: "encounter-resolved", encounterId, resolution: encounterId === "camp-hunters" ? "subdued" : "cleansed", actorIds: region.encounterParticipants[encounterId]! } });
    }
  }
  events.push({ source: "encounter:greenwake-boar", event: { ...base, type: "encounter-resolved", encounterId: "greenwake-boar", resolution: "cleansed", actorIds: ["corrupted-boar"] } });
  for (const [encounterId, definition] of Object.entries(BOSS_ENCOUNTERS)) {
    definition.phases.forEach((phase, phaseIndex) => events.push({ source: "phase:" + encounterId + ":" + phase.id, event: { ...base, type: "encounter-phase", encounterId, actorId: definition.bossId, phaseId: phase.id, phaseIndex, state: "cleared", simulationTick: 1 } }));
  }
  const engine = new CombatEngine();
  engine.loadRegion({regionId: "greenwake", runId: "chapter-producers", presentActorIds: ["vara", "corrupted-boar"], companionId: "vara"});
  engine.startEncounter({encounterId: "greenwake-boar", regionId: "greenwake", runId: "chapter-producers", playerPosition: { x: 7, y: 0, z: -1 }, companionId: "vara"});
  const state = engine.snapshotState();
  const player = state.actors.find(actor => actor.id === state.playerId)!;
  const hostile = state.actors.find(actor => actor.id === "corrupted-boar")!;
  state.actors.find(actor => actor.id === "vara")!.visible = true;
  hostile.visible = true;
  hostile.position = { x: player.position.x - 3, y: player.position.y, z: player.position.z };
  player.facing = { x: -1, y: 0, z: 0 };
  assert.equal(commandCompanion(state, { companionId: "vara", command: "focus", target: { kind: "actor", instanceId: hostile.id } }), true);
  for (let tick = 0; tick < 60; tick++) {
    state.tick++; state.worldTick++;
    stepCompanions(state);
  }
  // A completed native mark and a rear-warning response are separate runtime producers.
  player.facing = { x: 1, y: 0, z: 0 };
  state.tick++; state.worldTick++; stepCompanions(state);
  player.facing = { x: -1, y: 0, z: 0 };
  state.tick++; state.worldTick++; stepCompanions(state);
  for (const event of state.worldEvents) events.push({ source: "companion:" + event.eventId, event });
  // Cage rescue at the shelter: the Tali shelter success event (simulated) at its authored location.
  events.push({ source: "engine:tali-shelter", event: { ...base, type: "rescue", targetId: "tali", locationId: "tali-shelter", safe: true } });
  return events;
}

test("authored Act I event grammar maps each objective to its own event", () => {
  const produced = producedEvents();
  const claimed = new Map<string, string>();
  for (const [quest, objective] of objectives) {
    assert.equal(objective.requiredEvents.length, 1, `${objective.id} has one canonical event`);
    const requirement = objective.requiredEvents[0]!;
    const matching = produced.filter(({ event }) => eventMatches(requirement, event));
    assert.ok(matching.length >= 1, `${objective.id} requires ${requirement}, which nothing produces`);
    // Objectives complete from the whole event log: no producer event may satisfy a second Act I objective.
    for (const { source, event } of matching) {
      const satisfied = objectives.filter(([, other]) => other.requiredEvents.every((required) => eventMatches(required, event))).map(([, other]) => other.id);
      assert.deepEqual(satisfied, [objective.id], `${source} satisfies ${satisfied.join(", ")}, not only ${objective.id}`);
      claimed.set(objective.id, source);
    }
    // A placed interaction producer stands in the quest's own region.
    if (matching.every(({ source }) => ACT_I_INTERACTIONS.some((interaction) => source.startsWith(interaction.id)))) {
      for (const { source } of matching) {
        const interaction = ACT_I_INTERACTIONS.find((candidate) => source.startsWith(candidate.id))!;
        assert.equal(interaction.regionId, quest.region, `${source} is authored in ${quest.region}`);
        const placed = region(interaction.regionId).entities.filter((entity) => entity.interactionId === interaction.id);
        assert.equal(placed.length, 1, `${interaction.id} is placed exactly once`);
      }
    }
  }
  assert.equal(claimed.size, objectives.length);
});

test("exact event contracts: the placeholder ids are gone and phase ids match the encounter definitions", () => {
  const requirements = objectives.flatMap(([, objective]) => objective.requiredEvents);
  assert.ok(!requirements.includes("semantic:prologue-roars"), "the prologue asks for the event its interaction emits");
  assert.ok(!requirements.includes("encounter:asha-phase-clear"));
  assert.ok(!requirements.some((requirement) => requirement.startsWith("traversal:")), "no objective waits on a traversal event nothing emits");
  assert.ok(BOSS_ENCOUNTERS["encounter-asha"]!.phases.some((phase) => phase.id === "mother-roar"), "encounter:mother-roar names a real Asha phase");
  assert.ok(BOSS_ENCOUNTERS["encounter-koro"]!.phases.length > 0);
  assert.ok("greenwake-boar" in WILDLIFE_ENCOUNTERS);
  for (const interaction of ACT_I_INTERACTIONS) {
    if (interaction.success.type === "semantic-interaction") assert.equal(interaction.success.kind, interaction.kind, `${interaction.id} kind matches its emitted event kind`);
    // Mechanical kinds need a supported engine action; a plain press has none.
    if (["repair", "restore", "break"].includes(interaction.kind)) assert.ok(["staff-heavy", "cleanse-pulse"].includes(interaction.actionId ?? ""), `${interaction.id} names a supported action`);
    if (["tend", "collect", "track", "traverse", "rescue"].includes(interaction.kind) && interaction.success.type !== "rescue") assert.equal(interaction.actionId, undefined, `${interaction.id} is a plain press`);
  }
  assert.deepEqual(ACT_I_INTERACTIONS.map((interaction) => interaction.id).filter((id, index, ids) => ids.indexOf(id) !== index), []);
  for (const interaction of ACT_I_INTERACTIONS) assert.ok(INTERACTIONS.includes(interaction), `${interaction.id} is registered`);
});

test("Canopy sequencing: the chase ends at Koro's trail and the fragment is received only after the cleanse", () => {
  const thief = QUESTS.find((quest) => quest.id === "thief-in-the-branches")!;
  assert.deepEqual(thief.objectives.map((objective) => objective.id), ["thief-in-the-branches:vine-route", "thief-in-the-branches:vault-branch", "thief-in-the-branches:koro-trail"]);
  assert.ok(thief.objectives.every((objective) => !objective.requiredEvents.some((event) => event.startsWith("fragment:"))), "no fragment is needed to leave the chase");
  const orchard = QUESTS.find((quest) => quest.id === "empty-orchard")!;
  const ids = orchard.objectives.map((objective) => objective.id.split(":")[1]);
  assert.deepEqual(ids, ["water-flow", "monkey-rescue", "share-seeds", "koro-thorn", "cleanse-koro", "canopy-fragment", "koro-pact", "restore-canopy"]);
  const fragment = INTERACTIONS.find((interaction) => interaction.id === "canopy-fragment")!;
  assert.deepEqual(fragment.requiresFacts, ["encounter-koro-cleansed"]);
  const pact = INTERACTIONS.find((interaction) => interaction.id === "koro-pact")!;
  assert.deepEqual(pact.requiresFacts, ["encounter-koro-cleansed"]);
});

test("earned restoration: only the final interaction after every prerequisite emits regional restoration", () => {
  const restorations = ACT_I_INTERACTIONS.filter((interaction) => interaction.success.type === "restoration");
  assert.deepEqual(restorations.map((interaction) => interaction.id).sort(), ["canopy-restoration", "snare-source"]);
  const canopy = restorations.find((interaction) => interaction.id === "canopy-restoration")!;
  for (const fact of ["interaction:canopy-waterwheel", "interaction:monkey-rescue", "interaction:orchard-seeds", "encounter-koro-cleansed", "choice:koro-pact"]) assert.ok(canopy.requiresFacts.includes(fact), `Canopy restoration needs ${fact}`);
  const bamboo = restorations.find((interaction) => interaction.id === "snare-source")!;
  for (const fact of ["interaction:camp-disable", "bamboo_tali_safe", "encounter-asha-cleansed", "choice:asha-pact"]) assert.ok(bamboo.requiresFacts.includes(fact), `Bamboo restoration needs ${fact}`);
  // The route unlocks of the forward exits are those earned facts, never a boss resolution.
  assert.equal(region("whispering-canopy").exits.find((route) => route.id === "canopy-bamboo-out")!.unlockFact, "restoration:whispering-canopy:restored");
  assert.equal(region("blood-bamboo-valley").exits.find((route) => route.id === "bamboo-grove-out")!.unlockFact, "restoration:blood-bamboo-valley:restored");
  assert.equal(region("greenwake").exits.find((route) => route.id === "greenwake-canopy-out")!.unlockFact, "interaction:greenwake-gate");
});

test("manual alternatives: no objective needs Koro, and each Koro move has a player-only twin", () => {
  const needsKoro = INTERACTIONS.filter((interaction) => interaction.requiresActors.includes("koro") || interaction.requiresCompanionCommand);
  assert.deepEqual(needsKoro.map((interaction) => interaction.id).sort(), ["koro-bundle-drop", "koro-drop-object"]);
  const bamboo = region("blood-bamboo-valley");
  for (const movable of bamboo.movableObjects) {
    const player = INTERACTIONS.find((interaction) => interaction.id === movable.playerInteractionId)!;
    assert.equal(player.playerActionId, "staff-heavy");
    assert.deepEqual(player.requiresActors, []);
  }
  // No objective, interaction, checkpoint or exit waits on a moved-object fact: the encounter-resettable bundle is never permanent progress.
  const gated = [...INTERACTIONS.flatMap((interaction) => interaction.requiresFacts), ...CHAPTER_RUNTIME.flatMap((segment) => [...segment.exitRequirements, ...segment.checkpoints.flatMap((point) => point.requiresFacts)])];
  assert.ok(!gated.some((fact) => fact.startsWith("objectMoved:")), "moved-object facts gate nothing");
  assert.notEqual(bamboo.movableObjects[0]!.movedFactId, bamboo.movableObjects[1]!.movedFactId);
  // Koro is absent before recruitment: his Bamboo placement waits for the cleansed fact.
  assert.equal(bamboo.entities.find((entity) => entity.id === "bamboo-koro")!.visibleWhen, "encounter-koro-cleansed");
});

test("the full chapter runtime names real nodes, cameras, encounters, requirements and beats", () => {
  const segmentIds = CHAPTER_RUNTIME.map((segment) => segment.segmentId);
  // The expected segment IDs of every authored chapter region, including later-act and return segments.
  const expectedSegments = new Set([
    "prologue", "greenwake", "canopy", "bamboo", "grove",
    "moonpine", "mistveil", "sunmane", "grove-fall", "refuge",
    "return-canopy", "return-bamboo", "return-moonpine", "return-mistveil", "return-sunmane", "hollow",
  ]);
  for (const segmentId of segmentIds) assert.ok(expectedSegments.has(segmentId), `${segmentId} is a known segment`);
  const questIds = new Set(QUESTS.map((quest) => quest.id));
  const objectiveIds = new Set(QUESTS.flatMap((quest) => quest.objectives.map((objective) => objective.id as string)));
  for (const segment of CHAPTER_RUNTIME) {
    const layout = region(segment.regionId);
    const checkpointIds = new Set(segment.checkpoints.map((point) => point.id));
    assert.equal(checkpointIds.size, segment.checkpoints.length);
    for (const point of segment.checkpoints) {
      assert.equal(point.regionId, segment.regionId);
      assert.ok(layout.cameraAnchors.some((anchor) => anchor.id === point.cameraAnchorId), `${point.id} camera ${point.cameraAnchorId}`);
      const facts = Object.fromEntries([...point.requiresFacts, ...layout.navigation.nodes.flatMap((node) => (node.requirement ? [node.requirement] : []))].map((fact) => [fact, true]));
      assert.ok(resolveSafeNode(layout, point.nodeId, facts, point.cameraAnchorId), `${point.id} resolves a safe spawn at ${point.nodeId}`);
      if (point.encounterId) assert.ok(layout.encounterIds.includes(point.encounterId) || point.encounterId === "greenwake-boar", `${point.id} resets a real encounter`);
    }
    for (const trigger of segment.encounterEntries) {
      assert.ok(checkpointIds.has(trigger.checkpointId), `${trigger.id} names its pre-fight checkpoint`);
      assert.equal(segment.checkpoints.find((point) => point.id === trigger.checkpointId)!.encounterId, trigger.encounterId);
      assert.ok(objectiveIds.has(trigger.objectiveId), `${trigger.id} serves a real objective`);
      const objective = QUESTS.flatMap((quest) => quest.objectives).find((candidate) => candidate.id === trigger.objectiveId)!;
      assert.ok(objective.requiredEvents.includes("encounter:" + trigger.encounterId), `${trigger.id} objective completes with its encounter`);
      assert.ok(trigger.radius > 0 && layout.ground.surfaces.some((surface) => surface.walkable && surface.points.length > 2), `${trigger.id} has a trigger radius`);
      assert.ok(layout.navigation.nodes.some((node) => Math.hypot(node.position.x - trigger.center.x, node.position.z - trigger.center.z) <= trigger.radius + 12), `${trigger.id} trigger sits near the route`);
    }
    for (const requirement of segment.exitRequirements) {
      if (requirement.startsWith("quest:")) assert.ok(questIds.has(requirement.slice(6) as never), requirement);
      else if (requirement.startsWith("objective:")) assert.ok(objectiveIds.has(requirement.slice(10)), requirement);
      else if (requirement.startsWith("choice:")) assert.ok(CAMPAIGN_CHOICES[requirement.split(":")[1]!], requirement);
      else if (requirement.startsWith("beat:")) assert.ok(STORY_DIALOGUE[requirement.slice(5)], requirement);
      else FACT_FOR_ALL.add(requirement);
    }
  }
  const produced = [...producedEvents(), ...producedLaterEvents()];
  for (const fact of FACT_FOR_ALL) {
    const requirement = fact.startsWith("rescued:") ? "rescue:" + fact.slice("rescued:".length) : fact;
    const available = fact === "bamboo_tali_safe"
      ? produced.some(({ event }) => event.type === "rescue" && event.targetId === "tali" && event.safe && (event.locationId === "tali-cage" || event.locationId === "tali-shelter"))
      : /^(interaction|restoration|rescued):/.test(fact) && produced.some(({ event }) => eventMatches(requirement, event));
    assert.ok(available, `${fact} has a canonical event producer, not an unavailable chapter barrier`);
  }
  // Spatial triggers stay inside their region and are placed on authored ground.
  const koroEntry = CHAPTER_RUNTIME.flatMap((segment) => segment.encounterEntries).find((trigger) => trigger.id === "koro-entry")!;
  assert.ok(Math.hypot(koroEntry.center.x - 47, koroEntry.center.z + 22) < 4, "Koro's trigger is the temple courtyard");
});

test("layout migrations map every revision-0 safe node to a safe revision-1 node", () => {
  const revisions = new Map(CHAPTER_RUNTIME.map((segment) => [segment.regionId, segment.layoutRevision]));
  for (const migration of LAYOUT_MIGRATIONS) {
    const layout = region(migration.regionId);
    assert.equal(migration.fromRevision, 0);
    assert.equal(migration.toRevision, revisions.get(migration.regionId));
    const every = Object.fromEntries([...layout.navigation.nodes, ...layout.entrances].flatMap((node) => ("requirement" in node && node.requirement ? [[node.requirement, true]] : []))) as Record<string, boolean>;
    for (const fact of ["restoration:blood-bamboo-valley:restored", "bamboo_tali_safe", "greenwake-boar-cleansed", "refugeOpen"]) every[fact] = true;
    for (const [oldId, newId] of Object.entries(migration.nodeMap)) assert.ok(resolveSafeNode(layout, newId, every), `${migration.regionId}: ${oldId} → ${newId} is a safe authored node`);
    assert.ok(resolveSafeNode(layout, migration.fallbackNodeId, every), `${migration.regionId} fallback ${migration.fallbackNodeId} is safe`);
  }
  // Region ordering reflects the chapter runtime insertion order, not alphabetical; preserve the meaningful invariants only.
  assert.equal(revisions.size, 9);
  const expectedRegions: Record<string, true> = {
    "blood-bamboo-valley": true, "greenwake": true, "heartroot-hollow": true, "mistveil-basin": true, "moonpine-ridge": true,
    refuge: true, "sunmane-expanse": true, "the-grove": true, "whispering-canopy": true,
  };
  for (const regionId of revisions.keys()) assert.ok(expectedRegions[regionId], `${regionId} is a known authored region`);
  assert.deepEqual(LAYOUT_MIGRATIONS.map((migration) => migration.regionId).sort(), Object.keys(expectedRegions).sort());
});

test("relationship rules key one-shot awards to producible authored events; the pacts are explicit irreversible Bond or Dominion ceremonies", () => {
  const produced = [...producedEvents(), ...producedLaterEvents()];
  assert.equal(new Set(RELATIONSHIP_RULES.map((rule) => rule.id)).size, RELATIONSHIP_RULES.length);
  const allowed = new Set(["vara", "koro", "asha", "ruun", "luma", "nyra", "solkar"]);
  for (const rule of RELATIONSHIP_RULES) {
    assert.ok(allowed.has(rule.companionId), rule.id);
    assert.ok(produced.some(({ event }) => eventMatches(rule.requiredEvent, event)) || rule.requiredEvent === "tend:vara" || rule.requiredEvent === "tend:canopy-vara", `${rule.id} waits on a producible event ${rule.requiredEvent}`);
    assert.ok((rule.bond ?? 0) >= 0 && (rule.bond ?? 0) <= 100);
  }
  for (const choiceId of ["koro-pact", "asha-pact"]) {
    const options = CAMPAIGN_CHOICES[choiceId]!;
    assert.deepEqual(options.map((option) => option.id), ["bond", "dominion"]);
    for (const option of options) {
      assert.equal(option.irreversible, true);
    }
    const interaction = INTERACTIONS.find((candidate) => candidate.id === choiceId)!;
    assert.equal(interaction.success.type, "choice");
    if (interaction.success.type === "choice") assert.deepEqual(interaction.success.optionIds, ["bond", "dominion"]);
  }
});

test("Grove actors are present on both pacts and the hub exposes the service, rest and training points", () => {
  const grove = region("the-grove");
  const visible = (id: string) => grove.entities.find((entity) => entity.id === id)!.visibleWhen;
  assert.equal(visible("asha"), "choice:asha-pact", "Asha appears after either pact option");
  assert.equal(visible("koro"), "choice:koro-pact", "Koro appears after either pact option");
  assert.equal(visible("tali"), "taliInGrove");
  for (const id of ["grove-heartroot-rest", "grove-yara-tent", "grove-training"]) assert.ok(grove.entities.some((entity) => entity.interactionId === id), id);
  const rest = INTERACTIONS.find((interaction) => interaction.id === "grove-heartroot-rest")!;
  assert.deepEqual(rest.success, { type: "checkpoint", checkpointId: "grove-heartroot-rest" });
  assert.ok(CHAPTER_RUNTIME.find((segment) => segment.segmentId === "grove")!.checkpoints.some((point) => point.id === "grove-heartroot-rest"));
  assert.ok(grove.exits.filter((route) => route.destinationRegionId === "moonpine-ridge" || route.destinationRegionId === "refuge").every((route) => route.unlockFact), "Act II exits stay locked");
  // The peaceful hub has no gates, no blight stages. `encounter-fall` (chapter 6) is the only encounter registered in this region;
  // its participant is Orun, whose placement already sits in the glade. The Grove authoring never introduces trial-only stages.
  const groveEncountersExceptFall = grove.encounterIds.filter((id) => id !== "encounter-fall");
  assert.deepEqual(groveEncountersExceptFall, [], "the Grove hosts only the chapter-6 `encounter-fall`");
  assert.deepEqual(grove.encounterParticipants["encounter-fall"], ["orun"], "encounter-fall participant is the Orun actor");
  assert.ok(!grove.ground.surfaces.some((surface) => /blight|memory-pool|ridge-trail|pool-/.test(surface.id)));
});

test("every narrative cue beat is authored and the prologue opens with its own beat", () => {
  assert.equal(NARRATIVE_CUES.prologue!.onActivate, "prologue-opening");
  for (const cue of Object.values(NARRATIVE_CUES)) {
    for (const beat of [cue.onActivate, cue.onComplete, ...(cue.onObjective ?? []).map((item) => item.beatId)]) if (beat) assert.ok(isCueBeatAuthored(beat), `${cue.questId} cue ${beat} is authored`);
    for (const item of cue.onObjective ?? []) assert.ok(QUESTS.find((quest) => quest.id === cue.questId)!.objectives.some((objective) => objective.id === item.objectiveId), `${item.objectiveId} is a real objective`);
  }
  for (const beat of ["prologue-opening", "greenwake-cleanse", "koro-thorn-reveal", "koro-cleanse", "koro-pact-close", "marek-escape", "tali-shelter-warning", "asha-phase-three", "asha-pact-close"]) assert.ok(STORY_DIALOGUE[beat], beat);
});


const LATER_ACT_QUEST_IDS = [
  "the-third-howl", "two-packs", "the-alpha-below",
  "eyes-in-the-mist", "the-black-river", "the-mire-maw",
  "the-silent-plains", "tribute-of-teeth", "the-lions-offer",
  "fall-of-the-grove", "wild-march", "heartroot-hollow", "orun-the-hollow-king",
] as const;
const laterQuests: readonly QuestDefinition[] = LATER_ACT_QUEST_IDS.map((id) => QUESTS.find((quest) => quest.id === id)!);
const laterObjectives: readonly (readonly [QuestDefinition, ObjectiveDefinition])[] = laterQuests.flatMap((quest) => quest.objectives.map((objective) => [quest, objective] as const));

/** Emits the canonical WorldEvents for every later-act interaction (one per interaction; same shape as Act I). */
function producedLaterEvents(): readonly { readonly source: string; readonly event: WorldEvent }[] {
  const events: { source: string; event: WorldEvent }[] = [];
  const base = { eventId: "e", idempotencyKey: "k" } as const;
  const position = { x: 0, y: 0, z: 0 };
  const actIIds: Record<string, true> = Object.fromEntries(ACT_I_INTERACTIONS.map((interaction) => [interaction.id, true]));
  for (const interaction of INTERACTIONS) {
    if (actIIds[interaction.id]) continue;
    const success = interaction.success;
    if (success.type === "semantic-interaction") {
      events.push({ source: interaction.id, event: { ...base, type: "semantic-interaction", actorId: "aren", interactionId: interaction.id, kind: success.kind, targetId: success.targetId, position } });
    } else if (success.type === "rescue") {
      events.push({ source: interaction.id, event: { ...base, type: "rescue", targetId: success.targetId, locationId: success.locationId, safe: true } });
    } else if (success.type === "fragment") {
      events.push({ source: interaction.id, event: { ...base, type: "fragment", fragmentId: success.fragmentId, sourceId: success.sourceId } });
    } else if (success.type === "restoration") {
      events.push({ source: interaction.id, event: { ...base, type: "restoration", regionId: success.regionId, state: success.state, causeId: success.causeId } });
    } else if (success.type === "choice") {
      for (const optionId of success.optionIds) events.push({ source: interaction.id + ":" + optionId, event: { ...base, type: "choice", choiceId: success.choiceId, optionId } });
    } else if (success.type === "traversal") {
      events.push({ source: interaction.id, event: { ...base, type: "traversal", routeId: success.routeId, fromRegion: success.fromRegion, toRegion: success.toRegion, landmarkId: success.landmarkId } });
    }
  }
  // Each later-act encounter also emits its phase-cleared and final-resolved events.
  const laterEncounters = ["encounter-ruun", "encounter-ghor", "encounter-solkar", "encounter-orun", "encounter-fall"];
  for (const encounterId of laterEncounters) {
    const definition = BOSS_ENCOUNTERS[encounterId];
    if (!definition) continue;
    for (const phase of definition.phases) events.push({ source: "phase:" + encounterId + ":" + phase.id, event: { ...base, type: "encounter-phase", encounterId, actorId: definition.bossId, phaseId: phase.id, phaseIndex: definition.phases.indexOf(phase), state: "cleared", simulationTick: 1 } });
    events.push({ source: "resolved:" + encounterId, event: { ...base, type: "encounter-resolved", encounterId, resolution: "cleansed", actorIds: [definition.bossId] } });
  }
  return events;
}

test("later-act interactions are unique and registered in the world interaction table", () => {
  const ids = LATER_ACT_INTERACTIONS.map((interaction) => interaction.id);
  assert.deepEqual(ids.filter((id, index) => ids.indexOf(id) !== index), []);
  for (const interaction of LATER_ACT_INTERACTIONS) {
    assert.ok(INTERACTIONS.includes(interaction), `${interaction.id} is registered`);
    if (interaction.success.type === "semantic-interaction") assert.equal(interaction.success.kind, interaction.kind, `${interaction.id} kind matches its emitted event kind`);
  }
});

test("later-act interactions have exactly one authored placement in their region", () => {
  for (const interaction of LATER_ACT_INTERACTIONS) {
    const placements = REGIONS.flatMap((region) => region.entities).filter((entity) => entity.interactionId === interaction.id);
    assert.equal(placements.length, 1, `${interaction.id} has exactly one placement`);
    assert.equal(placements[0]!.placement !== undefined, true);
  }
});

test("every required later-act objective event has a canonical producer", () => {
  const produced = producedLaterEvents();
  for (const [, objective] of laterObjectives) {
    for (const requirement of objective.requiredEvents) {
      assert.ok(produced.some(({ event }) => eventMatches(requirement, event)), `${objective.id} requires ${requirement}, which nothing produces`);
    }
  }
});


test("Fall of the Grove has the real Tali rescue producer and the genuine player-selected chapter-six response choice", () => {
  const taliRescue = INTERACTIONS.find((candidate) => candidate.id === "grove-tali-rescue")!;
  assert.ok(taliRescue);
  assert.equal(taliRescue.regionId, "the-grove");
  const chapterSixResponse = INTERACTIONS.find((candidate) => candidate.id === "chapter-six-response")!;
  assert.ok(chapterSixResponse);
  assert.equal(chapterSixResponse.regionId, "the-grove");
  if (chapterSixResponse.success.type === "choice") {
    assert.equal(chapterSixResponse.success.choiceId, "chapter-six-response");
    assert.deepEqual(chapterSixResponse.success.optionIds, ["ask", "signal"]);
  }
});

test("the five Living-Pact return beats have evidence inspects and the canonical action event producers", () => {
  const pairs: ReadonlyArray<readonly [string, string, string]> = [
    ["seeds-on-the-wind", "whispering-canopy", "seed-route"],
    ["a-path-for-the-young", "blood-bamboo-valley", "nursery-return"],
    ["one-howl-two-generations", "moonpine-ridge", "two-generation-howl"],
    ["witness-in-the-reeds", "mistveil-basin", "reed-corridor"],
    ["the-open-crossing", "sunmane-expanse", "open-crossing"],
  ];
  for (const [evidenceId, regionId, actionId] of pairs) {
    const evidence = INTERACTIONS.find((candidate) => candidate.id === evidenceId)!;
    assert.ok(evidence, `${evidenceId} is registered`);
    assert.equal(evidence.regionId, regionId, `${evidenceId} is authored in ${regionId}`);
    assert.equal(evidence.success.type, "semantic-interaction");
    if (evidence.success.type === "semantic-interaction") assert.equal(evidence.success.targetId, evidenceId);

    const action = INTERACTIONS.find((candidate) => candidate.id === actionId)!;
    assert.ok(action, `${actionId} is registered`);
    assert.equal(action.regionId, regionId, `${actionId} is authored in ${regionId}`);
  }
});

test("the Orun quest objectives use the actual phase ids, not aliases", () => {
  const orun = QUESTS.find((quest) => quest.id === "orun-the-hollow-king")!;
  assert.equal(orun.objectives.length >= 1, true);
  // The Orun quest must not introduce phantom phase ids.
  for (const objective of orun.objectives) {
    for (const requirement of objective.requiredEvents) {
      if (requirement.startsWith("encounter:")) assert.ok(requirement !== "encounter:orun-phase-clear", "Orun does not use a placeholder phase id");
    }
  }
  // The Hollow quest must require six real aspect interactions (not memory inspections).
  const hollow = QUESTS.find((quest) => quest.id === "heartroot-hollow")!;
  assert.equal(hollow.objectives.length, 6);
  for (const objective of hollow.objectives) {
    for (const requirement of objective.requiredEvents) {
      assert.ok(requirement.startsWith("semantic:hollow-memory-"), `${objective.id} uses a memory semantic`);
    }
  }
});

test("the five Living-Pact return quests have one action producer per quest and at least one consequence fact", () => {
  const returns = ["seeds-on-the-wind", "a-path-for-the-young", "one-howl-two-generations", "witness-in-the-reeds", "the-open-crossing"];
  for (const id of returns) {
    const quest = QUESTS.find((candidate) => candidate.id === id)!;
    assert.ok(quest, `${id} is registered`);
    assert.equal(quest.optional, false, `${id} is required`);
    assert.equal(quest.chapter, 7);
    assert.ok(quest.consequenceFacts.length > 0, `${id} writes at least one consequence fact`);
  }
});

test("wild-march-formation is a genuine player-selected choice interaction in the Refuge", () => {
  const catalog = CAMPAIGN_CHOICES["wild-march-formation"];
  assert.ok(catalog, "wild-march-formation choice catalog exists");
  assert.ok(QUESTS.find((quest) => quest.id === "wild-march"), "wild-march quest exists");
  const formationObjective = QUESTS.find((quest) => quest.id === "wild-march")!.objectives.find((objective) => objective.id === "wild-march:formation")!;
  assert.deepEqual(formationObjective.requiredEvents, ["choice:wild-march-formation"]);
  const formation = INTERACTIONS.find((interaction) => interaction.id === "wild-march-formation")!;
  assert.ok(formation, "wild-march-formation choose interaction is registered");
  assert.equal(formation.regionId, "refuge");
  if (formation.success.type === "choice") {
    assert.equal(formation.success.choiceId, "wild-march-formation");
    assert.deepEqual(formation.success.optionIds, ["form"]);
  }
});
