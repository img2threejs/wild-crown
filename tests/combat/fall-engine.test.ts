import assert from "node:assert/strict";
import test from "node:test";
import { REGIONS } from "../../src/content/campaign.js";
import type { RegionDefinition, WorldEvent } from "../../src/game/contracts.js";
import { CombatEngine, type CombatInput } from "../../src/game/combat/CombatEngine.js";

/** Act II facts stay set on purpose: the Fall must never read the Bamboo Tali obligation. */
const FACTS = { "choice:asha-pact": true, taliInGrove: true, "interaction:warden-call": true, wardenCall: true, taliSafe: true, bamboo_tali_safe: true };
const GROVE = REGIONS.find((region) => region.id === "the-grove")!;

/** Drives the real engine with CombatInput frames; interactions go through `resolveInteraction` as GameApplication does on Interact. */
class FallRun {
  readonly engine = new CombatEngine();
  readonly events: WorldEvent[] = [];
  constructor(runId: string, companionId: "asha" | "sable" | undefined, region: RegionDefinition = GROVE, bondLevel = 0) {
    const present = region.entities.filter((entity) => entity.actorId && (!entity.visibleWhen || (FACTS as Record<string, boolean>)[entity.visibleWhen])).map((entity) => entity.id);
    const progress = companionId ? { [companionId]: { id: companionId, recruited: true, bondLevel, dominionLevel: 0, unlockedAbilityIds: [], storyFlags: {} } } : undefined;
    this.engine.loadRegion({ regionId: "the-grove", regionDefinition: region, runId, presentActorIds: present, companionId, chapter: 6, wardenCall: true, worldFacts: FACTS, playerPosition: { x: 17, y: 0, z: 0 }, ...(progress ? { companionProgress: progress as never } : {}) });
    this.engine.startEncounter({ encounterId: "encounter-fall", regionId: "the-grove", runId, companionId, worldFacts: FACTS });
    this.drain();
  }
  private drain(): void { this.events.push(...this.engine.consumeWorldEvents()); }
  actor(id: string) { return this.engine.snapshot().actors.find((actor) => actor.id === id || actor.archetypeId === id)!; }
  step(extra: Partial<CombatInput> = {}): void {
    this.engine.step({ tick: this.engine.simulationTick + 1, move: { x: 0, y: 0, z: 0 }, dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false, ...extra }, 1 / 60);
    this.drain();
  }
  idle(ticks: number, until: () => boolean = () => false): void { for (let i = 0; i < ticks && !until(); i++) this.step(); }
  /** Stick input in the default camera basis (forward -z, right +x). */
  move(dx: number, dz: number): void { const d = Math.hypot(dx, dz) || 1; this.step({ move: { x: dx / d, y: 0, z: -dz / d } }); }
  walkTo(x: number, z: number, radius = 0.8): void {
    for (let i = 0; i < 1500; i++) {
      const p = this.actor("aren").position;
      if (Math.hypot(x - p.x, z - p.z) <= radius) return;
      this.move(x - p.x, z - p.z);
    }
    assert.fail(`Aren never reached ${x},${z}`);
  }
  interact(interactionId: string, targetId: string): boolean { const ok = this.engine.resolveInteraction(interactionId, targetId); this.drain(); return ok; }
  count(predicate: (event: WorldEvent) => boolean): number { return this.events.filter(predicate).length; }
  escapes(): number { return this.count((event) => event.type === "semantic-interaction" && event.interactionId === "grove-collapse-escape"); }
  protectionCleared(): number { return this.count((event) => event.type === "encounter-phase" && event.encounterId === "encounter-fall" && event.phaseIndex === 0 && event.state === "cleared"); }
  /** Pillar, Tali's run to her shelter, then the lookout pad; asserts every premature attempt is refused. */
  finishFall(order: "pillar-first" | "tali-first"): void {
    const pillar = () => { this.walkTo(14, -2); assert.equal(this.interact("grove-pillar", "grove-pillar"), true); };
    const tali = () => {
      const at = this.actor("tali").position;
      this.walkTo(at.x, at.z, 1.2);
      assert.equal(this.interact("grove-tali-rescue", "tali"), true);
      assert.equal(this.count((event) => event.type === "rescue"), 0, "sending Tali is not the rescue");
      this.idle(600, () => this.count((event) => event.type === "rescue") > 0);
      const shelter = this.actor("tali").position;
      assert.ok(Math.hypot(shelter.x - 25, shelter.z - 11) <= 0.61, "Tali physically reached grove-tali-shelter");
      assert.deepEqual(this.events.filter((event) => event.type === "rescue").map((event) => event.type === "rescue" && [event.targetId, event.locationId, event.safe]), [["tali", "grove-tali-shelter", true]]);
    };
    const tryEscape = () => { this.walkTo(26, 4); this.idle(20); };
    (order === "pillar-first" ? pillar : tali)();
    tryEscape();
    assert.equal(this.escapes(), 0, "escape refused before every beat holds");
    (order === "pillar-first" ? tali : pillar)();
    this.walkTo(15, 0);
    assert.equal(this.escapes(), 0, "escape needs Aren on the lookout pad");
    tryEscape();
    this.walkTo(30, 10); tryEscape();
    assert.equal(this.escapes(), 1, "escape completes exactly once");
    assert.equal(this.count((event) => event.type === "encounter-resolved" && event.encounterId === "encounter-fall"), 1);
  }
}

test("Fall with a recruit: Orun seizes Asha, she attacks with her pounce, a timed in-reach Cleanse breaks the hold, then one escape", () => {
  const run = new FallRun("fall-asha", "asha");
  run.idle(2400, () => run.actor("asha").possessed);
  assert.equal(run.count((event) => event.type === "possession" && event.state === "began" && event.targetId === "asha"), 1);
  assert.equal(run.count((event) => event.type === "possession" && event.targetId === "tali"), 0);
  assert.ok(run.engine.snapshotState().hazards.some((hazard) => hazard.sourceId === "asha" && hazard.attackId === "asha-guarding-pounce"), "the held recruit attacks with its own authored move");
  let pressedAt = 0;
  for (let attempt = 0; attempt < 8 && run.actor("asha").possessed; attempt++) {
    const asha = run.actor("asha").position;
    run.walkTo(asha.x, asha.z, 1.8);
    run.idle(60, () => run.engine.snapshotState().tick >= run.engine.snapshotState().actionRecoveryUntil);
    pressedAt = run.engine.simulationTick + 1;
    run.step({ cleansePressed: true, interactionTargetId: "asha" });
    run.idle(90, () => !run.actor("asha").possessed);
  }
  const broken = run.events.find((event) => event.type === "possession" && event.state === "broken" && event.targetId === "asha");
  assert.ok(broken?.type === "possession" && broken.simulationTick > pressedAt, "the Cleanse breaks the hold on its active frame, not on the press");
  assert.equal(run.actor("asha").possessed, false);
  run.step();
  assert.equal(run.protectionCleared(), 1);
  assert.equal(run.actor("asha").allegiance, "ally");
  assert.deepEqual(run.engine.snapshotState().hazards, [], "every hostile attack is cleared with the hold");
  run.finishFall("pillar-first");
});

test("Fall without a recruit: only evading Orun's real root surge ends protection; no possession is staged", () => {
  const run = new FallRun("fall-solo", undefined);
  run.idle(10);
  const first = run.engine.snapshotState().hazards.find((hazard) => hazard.sourceId === "orun");
  assert.equal(first?.attackId, "orun-root-surge");
  run.idle(200, () => !run.engine.snapshotState().hazards.some((hazard) => hazard.id === first.id));
  assert.ok(run.engine.snapshotState().player.vitality < 100, "the first surge landed on Aren");
  assert.equal(run.protectionCleared(), 0, "taking the hit is not protection");
  run.idle(400, () => run.engine.snapshotState().hazards.some((hazard) => hazard.sourceId === "orun" && hazard.id !== first.id));
  const aren = run.actor("aren").position, orun = run.actor("orun").position;
  for (let i = 0; i < 70; i++) run.move(aren.x - orun.x, aren.z - orun.z);
  run.idle(120, () => run.protectionCleared() > 0);
  assert.equal(run.protectionCleared(), 1);
  assert.equal(run.count((event) => event.type === "possession"), 0);
  run.finishFall("tali-first");
});

test("Fall resolves a projected party instance by its canonical recruit and honours its Bond level", () => {
  const projected = { id: "sable__party_grove-trial-glade-east", actorId: "sable", kind: "actor", position: { x: 17, y: 0, z: 1.5 }, assetId: "actor-sable", placement: "ground" };
  const run = new FallRun("fall-sable", "sable", { ...GROVE, entities: [...GROVE.entities, projected as never] }, 30);
  run.idle(1200, () => run.actor("sable").possessed);
  const began = run.engine.snapshotState().worldTick;
  assert.equal(run.count((event) => event.type === "possession" && event.state === "began" && event.targetId === projected.id), 1);
  assert.equal(run.engine.snapshotState().actors.find((actor) => actor.id === projected.id)!.possessedUntil - began, 120, "Bond 30 halves the 240-tick hold");
  run.idle(60, () => run.engine.snapshotState().hazards.some((hazard) => hazard.sourceId === projected.id));
  assert.ok(run.engine.snapshotState().hazards.some((hazard) => hazard.sourceId === projected.id && hazard.attackId === "ruun-track-charge"));
  run.idle(400, () => run.protectionCleared() > 0);
  assert.equal(run.count((event) => event.type === "possession" && event.state === "escaped" && event.targetId === projected.id), 1);
  assert.equal(run.protectionCleared(), 1);
});

test("Fall Cleanse is the real ranged action: an out-of-reach press spends mana and leaves the hold intact", () => {
  const projected = { id: "sable__party_grove-trial-glade-east", actorId: "sable", kind: "actor", position: { x: 17, y: 0, z: 1.5 }, assetId: "actor-sable", placement: "ground" };
  const run = new FallRun("fall-sable-far", "sable", { ...GROVE, entities: [...GROVE.entities, projected as never] });
  run.idle(1200, () => run.actor("sable").possessed);
  const held = run.actor("sable").position;
  for (let i = 0; i < 90 && Math.hypot(run.actor("aren").position.x - held.x, run.actor("aren").position.z - held.z) < 5; i++) run.move(run.actor("aren").position.x - held.x, run.actor("aren").position.z - held.z);
  const mana = run.engine.snapshotState().player.mana;
  run.step({ cleansePressed: true, interactionTargetId: projected.id });
  assert.equal(run.engine.snapshotState().actionId, "cleanse");
  assert.ok(run.engine.snapshotState().player.mana < mana, "Cleanse spends its mana cost");
  run.idle(60, () => run.engine.snapshotState().actionId === "idle");
  assert.equal(run.actor("sable").possessed, true);
  assert.equal(run.count((event) => event.type === "possession" && event.state === "broken"), 0, "an out-of-reach Cleanse breaks nothing");
  assert.equal(run.protectionCleared(), 0);
});

test("Fall beats are refused outside the live Fall", () => {
  const engine = new CombatEngine();
  const present = GROVE.entities.filter((entity) => entity.actorId && (!entity.visibleWhen || (FACTS as Record<string, boolean>)[entity.visibleWhen])).map((entity) => entity.id);
  engine.loadRegion({ regionId: "the-grove", runId: "pre-fall", presentActorIds: present, worldFacts: FACTS, playerPosition: { x: 14, y: 0, z: -2 } });
  assert.equal(engine.resolveInteraction("grove-pillar", "grove-pillar"), false);
  assert.deepEqual(engine.consumeWorldEvents(), []);
});
