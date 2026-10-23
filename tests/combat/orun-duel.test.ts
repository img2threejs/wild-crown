import assert from "node:assert/strict";
import test from "node:test";
import { REGIONS } from "../../src/content/campaign.js";
import type { CompanionCommandRequest, CompanionId, Vec3, WorldEvent } from "../../src/game/contracts.js";
import { CombatEngine, type CombatInput, type EngineState, type LiveHazard } from "../../src/game/combat/CombatEngine.js";

/**
 * The Heartroot Hollow duel is driven only through public engine inputs and companion commands. Observations
 * use the live read-only test seam for simulation state and the public Orun presentation snapshot, avoiding
 * a full arena serialization on every frame. Nothing sets a phase, a fact or a flag.
 */
const HOLLOW = REGIONS.find((region) => region.id === "heartroot-hollow")!;
type Bonds = Partial<Record<CompanionId, { bond: number; dominion: number }>>;

class Duel {
  readonly engine = new CombatEngine();
  readonly events: WorldEvent[] = [];
  constructor(runId: string, companionId?: CompanionId, bonds: Bonds = {}, formation: Partial<Record<CompanionId, Vec3>> = {}) {
    const party = companionId ? [companionId] : [];
    const projected = party.map(id => ({ id: `${id}__party_companion`, actorId: id, kind: "actor", position: formation[id] ?? { x: 14, y: -7, z: -37 }, assetId: `actor-${id}`, placement: "underground" }));
    const region = { ...HOLLOW, entities: [...HOLLOW.entities, ...projected] } as typeof HOLLOW;
    const present = region.entities.filter((entity) => entity.kind === "actor").map((entity) => entity.id);
    const progress = Object.fromEntries(party.map((id) => [id, { id, recruited: true, bondLevel: bonds[id]?.bond ?? 0, dominionLevel: bonds[id]?.dominion ?? 0, unlockedAbilityIds: [], storyFlags: {} }]));
    const at = { x: 17, y: -7, z: -40 };
    this.engine.loadRegion({ regionId: "heartroot-hollow", regionDefinition: region, runId, presentActorIds: present, playerPosition: at, companionId, chapter: 8, wardenCall: true, ...(party.length ? { companionProgress: progress as never } : {}) });
    this.engine.setPlayerHero("aren");
    this.engine.startEncounter({ encounterId: "encounter-orun", regionId: "heartroot-hollow", runId, playerPosition: at, companionId });
    this.drain();
  }
  private drain(): void { this.events.push(...this.engine.consumeWorldEvents()); }
  get s(): EngineState {
    // Known engine-owned state: this seam only observes it; all inputs remain public.
    const observed = this.engine as unknown as { readonly state: EngineState };
    return observed.state;
  }
  actor(id: string) { return this.s.actors.find((actor) => actor.id === id || actor.archetypeId === id)!; }
  step(extra: Partial<CombatInput> = {}): void {
    this.engine.step({ tick: this.engine.simulationTick + 1, move: { x: 0, y: 0, z: 0 }, dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false, ...extra }, 1 / 60);
    this.engine.consumeEvents();
    this.drain();
  }
  command(request: CompanionCommandRequest): boolean { return this.engine.commandCompanion(request); }
  count(predicate: (event: WorldEvent) => boolean): number { return this.events.filter(predicate).length; }
  phaseEvents(): string[] { return this.events.flatMap((event) => event.type === "encounter-phase" ? [`${event.phaseIndex}:${event.state}`] : event.type === "encounter-resolved" ? [`resolved:${event.resolution}`] : []); }
}

const stick = (v: { x: number; z: number }): Vec3 => { const length = Math.hypot(v.x, v.z) || 1; return { x: v.x / length, y: 0, z: -v.z / length }; };
const lateralTo = (h: LiveHazard, p: Vec3) => (p.x - h.target.x) * -h.direction.z + (p.z - h.target.z) * h.direction.x;
const alongTo = (h: LiveHazard, p: Vec3) => (p.x - h.target.x) * h.direction.x + (p.z - h.target.z) * h.direction.z;
function escape(h: LiveHazard, p: Vec3): Vec3 {
  if (h.kind === "sweep" || h.kind === "wave") { const side = lateralTo(h, p) >= 0 ? 1 : -1; return stick({ x: -h.direction.z * side, z: h.direction.x * side }); }
  const from = h.kind === "cone" ? h.origin : h.target, away = { x: p.x - from.x, z: p.z - from.z };
  return Math.hypot(away.x, away.z) < 0.3 ? stick({ x: -h.direction.z, z: h.direction.x }) : stick(away);
}
function near(h: LiveHazard, p: Vec3): boolean {
  if (h.kind === "cone") return Math.hypot(p.x - h.origin.x, p.z - h.origin.z) <= (h.range ?? h.depth) + 1;
  return Math.hypot(p.x - h.target.x, p.z - h.target.z) <= Math.max(h.width, h.depth, h.radius * 2) / 2 + 1.5;
}

/** The Last Warden (and any open core): dodge commits, counter in the window, tether windups, then Cleanse an open core or chip at him. */
function wardenInput(duel: Duel, extra: Partial<CombatInput>, cleanse = false): Partial<CombatInput> {
  const s = duel.s, p = duel.actor("aren").position, o = duel.actor("orun").position, dist = Math.hypot(o.x - p.x, o.z - p.z);
  const hostile = s.hazards.filter((h) => h.sourceId !== s.playerId);
  const threat = hostile.find((h) => h.activeFrom > s.worldTick && h.activeFrom - s.worldTick <= (h.kind === "sweep" || h.kind === "wave" ? 9 : 2.5) && near(h, p));
  if (threat && (s.tick >= s.actionUntil || s.actionCancelable)) return { ...extra, dodgePressed: true, move: escape(threat, p) };
  if (s.counterUntil > s.tick && !hostile.some((h) => s.worldTick >= h.activeFrom && s.worldTick < h.activeUntil && near(h, p))) return { ...extra, lightPressed: true };
  if ((s.skillReadyAt.root_tether ?? 0) <= s.tick && s.player.mana >= 20 && s.tick >= s.actionRecoveryUntil && dist <= 5.5 && s.telegraphs.some((t) => t.sourceId === "orun" && t.phase === "windup")) return { ...extra, tetherPressed: true };
  if (cleanse && s.tick >= s.actionRecoveryUntil) return dist > 3 ? { ...extra, move: stick({ x: o.x - p.x, z: o.z - p.z }) } : { ...extra, cleansePressed: true };
  if (dist > 2.6) return { ...extra, move: stick({ x: o.x - p.x, z: o.z - p.z }) };
  return { ...extra, lightPressed: !hostile.some((h) => h.activeFrom > s.worldTick) && s.tick % 20 === 0 };
}

/** One frame of play. `extra` carries companion input (a Vara signal, the vine Interact). */
function playFrame(duel: Duel, extra: Partial<CombatInput> = {}): void {
  const s = duel.s, view = duel.engine.snapshot().orun, p = duel.actor("aren").position, o = duel.actor("orun").position;
  const away = { x: p.x - o.x, z: p.z - o.z }, dist = Math.hypot(away.x, away.z), cast = s.chapter.orun?.cast;
  if (s.traversal) { duel.step(extra); return; }
  // An open core: keep answering live threats, walk into reach and Cleanse it.
  if (s.worldTick < (s.chapter.orun?.coreOpenUntil ?? 0)) { duel.step(wardenInput(duel, extra, true)); return; }
  if (s.phaseIndex === 0 || !cast && s.actors.some((actor) => actor.possessed)) { duel.step(wardenInput(duel, extra)); return; }
  if (!cast) { duel.step({ ...extra, move: dist < 5 ? stick(away) : dist > 8 ? stick({ x: -away.x, z: -away.z }) : { x: 0, y: 0, z: 0 } }); return; }
  const live = s.hazards.filter((h) => cast.hazardIds.includes(h.id)), pending = live.some((h) => h.activeFrom > s.worldTick);
  switch (cast.aspect) {
    case "sky": case "fang": {
      if (Object.values(s.companionState.slots).some((slot) => slot?.guard && live.some((h) => h.id === slot.guard!.hazardId))) { duel.step(extra); return; }
      const lane = live.find((h) => h.activeFrom > s.worldTick && Math.abs(lateralTo(h, p)) < h.width / 2 + 1.2 && Math.abs(alongTo(h, p)) < h.depth / 2 + 1);
      if (lane) { duel.step({ ...extra, sprintHeld: true, move: escape(lane, p) }); return; }
      duel.step({ ...extra, move: dist < 4 ? stick(away) : { x: 0, y: 0, z: 0 } });
      return;
    }
    case "canopy": {
      const centre = live.find((h) => h.attackId === "orun-canopy-aspect");
      if (!extra.interactPressed && pending && centre && Math.hypot(p.x - centre.target.x, p.z - centre.target.z) < 3.4) { duel.step({ ...extra, sprintHeld: true, move: stick(away) }); return; }
      duel.step(extra);
      return;
    }
    case "pack": {
      if (!pending) { duel.step(extra); return; }
      // Read the rows: they sit on a 2 m grid along the beast's line, one grid band empty.
      const dir = live[0]!.direction, offsets = live.map((h) => (h.target.x - p.x) * dir.x + (h.target.z - p.z) * dir.z);
      const slot = offsets.flatMap((offset) => [offset - 2, offset + 2]).filter((k) => offsets.every((offset) => Math.abs(offset - k) > 1.6)).sort((a, b) => Math.abs(a) - Math.abs(b))[0];
      const goal = view?.safeGap ?? (slot === undefined ? undefined : { x: p.x + dir.x * slot, y: p.y, z: p.z + dir.z * slot });
      duel.step(goal && Math.hypot(goal.x - p.x, goal.z - p.z) > 0.25 ? { ...extra, move: stick({ x: goal.x - p.x, z: goal.z - p.z }) } : extra);
      return;
    }
    case "shadow": {
      const veil = live[0];
      if (pending && veil) {
        // Behind the veil's forward reach while it gathers.
        const behind = { x: o.x - veil.direction.x * 2.6 - p.x, z: o.z - veil.direction.z * 2.6 - p.z };
        duel.step({ ...extra, sprintHeld: true, move: Math.hypot(behind.x, behind.z) > 0.3 ? stick(behind) : { x: 0, y: 0, z: 0 } });
        return;
      }
      if (view?.coreExposed) { duel.step(dist > 2.4 ? { ...extra, sprintHeld: true, move: stick({ x: -away.x, z: -away.z }) } : { ...extra, lightPressed: s.tick % 12 === 0 }); return; }
      duel.step(extra);
      return;
    }
    case "crown":
      duel.step(pending && dist < 8 ? { ...extra, sprintHeld: true, move: stick(away) } : extra);
      return;
  }
}
function play(duel: Duel, maxTicks: number, companions: (duel: Duel) => Partial<CombatInput> | void = () => {}): void {
  for (let i = 0; i < maxTicks && !duel.s.rewardEmitted && duel.s.player.vitality > 0; i++) playFrame(duel, companions(duel) ?? {});
}

test("ordinary damage never subdues the Last Warden and an early Cleanse is refused before any core opens", () => {
  const duel = new Duel("orun-bypass");
  const at = { x: 17, y: -7, z: -42.6 };
  for (let i = 0; i < 2400 && duel.s.player.vitality > 0; i++) {
    const p = duel.actor("aren").position;
    duel.step({ move: stick({ x: at.x - p.x, z: at.z - p.z }), lightPressed: i % 12 === 0, cleansePressed: i % 97 === 0 });
  }
  const orun = duel.actor("orun");
  assert.equal(orun.ferocity, 0, "the blows landed and wore his ferocity out");
  assert.equal(orun.downed, false);
  assert.equal(orun.corruption, 100, "no Cleanse eased a core");
  assert.equal(duel.count((event) => event.type === "encounter-resolved"), 0);
  assert.ok(!duel.phaseEvents().includes("1:cleared"), "the beast core was never opened, let alone cleared");
});

test("no party: the whole duel is won with player input only, every phase event and the cleansed resolution exactly once", { timeout: 30_000 }, () => {
  const duel = new Duel("orun-solo");
  const fog: boolean[] = [], shown = new Set<string>();
  play(duel, 9000, (d) => {
    const view = d.engine.snapshot().orun!;
    fog.push(view.fog === (d.s.chapter.orun?.cast?.aspect === "shadow"));
    for (const hazard of d.s.hazards) if (hazard.sourceId === "orun") shown.add(hazard.attackId);
  });
  assert.equal(duel.s.rewardEmitted, true, `resolved (hp ${duel.s.player.vitality}, phase ${duel.s.phaseIndex})`);
  assert.deepEqual(duel.phaseEvents(), ["0:entered", "0:cleared", "1:entered", "1:cleared", "2:entered", "2:cleared", "resolved:cleansed"]);
  for (const attack of ["orun-root-tether", "orun-staff-combo", "orun-root-surge", "orun-dive-roll", "orun-companion-suppression", "orun-sky-aspect", "orun-canopy-aspect", "orun-fang-aspect", "orun-pack-aspect", "orun-shadow-aspect", "orun-crown-aspect"]) assert.ok(shown.has(attack), `${attack} was cast`);
  assert.deepEqual([...new Set(duel.s.chapter.orun!.answered)].sort(), ["canopy", "crown", "fang", "pack", "shadow", "sky"]);
  assert.equal(duel.count((event) => event.type === "possession"), 0, "nobody is seized when nobody came");
  assert.ok(fog.every(Boolean), "fog is shown exactly while the Shadow aspect obscures the arena");
  assert.ok(duel.s.actors.filter((actor) => actor.id.startsWith("hollow-sky-echo")).every((echo) => !echo.visible && echo.allegiance === "neutral"), "Sky echoes end hidden, never allies or rewards");
});

for (const id of ["vara", "koro", "asha"] as const) test(`one companion: ${id} retains its authored duel answer and possession rules`, { timeout: 30_000 }, () => {
  const duel = new Duel(`orun-single-${id}`, id, { asha: { bond: 30, dominion: 0 }, koro: { bond: 0, dominion: 20 }, vara: { bond: 10, dominion: 0 } });
  duel.command({ companionId: id, command: "stay" });
  let suppressed = false, varaWarned = false, vineArrived = false;
  let vineLanding: Vec3 | undefined;
  const heldAttacks = new Set<string>();
  play(duel, 9000, d => {
    const s = d.s, cast = s.chapter.orun?.cast;
    if (s.companionState.slots[id]?.mode === "follow") d.command({ companionId: id, command: "stay" });
    for (const hazard of s.hazards) if (hazard.sourceId.startsWith("koro") && s.actors.find(actor => actor.id === hazard.sourceId)?.possessed) heldAttacks.add(hazard.attackId);
    if (d.engine.snapshot().orun!.suppressedCompanionIds.includes(id)) suppressed ||= !d.engine.commandAvailability({ companionId: id, command: "focus", target: { kind: "actor", instanceId: "orun" } }).available;
    varaWarned ||= cast?.varaWarned === true;
    if (id === "vara" && !d.actor("orun").markState && (s.companionState.slots.vara?.suppressedUntil ?? 0) <= s.worldTick && s.phaseIndex <= 1 && !s.chapter.orun!.answered.includes("sky") && s.tick % 10 === 0) return { command: { companionId: "vara", command: "signal", targetId: "orun" } };
    if (id === "koro" && cast?.aspect === "canopy" && !cast.koroVine && !s.companionState.slots.koro?.job) d.command({ companionId: id, command: "special", target: { kind: "actor", instanceId: "orun" } });
    const vine = cast?.vine, p = d.actor("aren").position;
    if (s.traversal?.gate.id === "orun-canopy-vine") vineLanding = { ...s.traversal.gate.to };
    if (vineLanding && !s.traversal && Math.hypot(p.x - vineLanding.x, p.z - vineLanding.z) < .5) vineArrived = true;
    if (vine && Math.hypot(p.x - vine.from.x, p.z - vine.from.z) <= 2.4) return { interactPressed: true, traversalId: "orun-canopy-vine" };
  });
  assert.equal(duel.s.rewardEmitted, true, `resolved (hp ${duel.s.player.vitality}, phase ${duel.s.phaseIndex})`);
  assert.equal(Object.keys(duel.s.companionState.slots).length, 1);
  if (id === "vara") {
    assert.equal(varaWarned, true);
    assert.equal(duel.count(event => event.type === "possession"), 0);
  } else {
    assert.equal(suppressed, true);
    const possession = duel.events.flatMap(event => event.type === "possession" && event.targetId.startsWith(id) && event.state !== "telegraphed" ? [event.state] : []);
    if (id === "asha") assert.deepEqual(possession, ["began", "escaped"], "Bond resists possession");
    else {
      assert.equal(vineArrived, true);
      assert.equal(possession[0], "began");
      assert.ok(heldAttacks.has("koro-falling-branch"));
    }
    assert.deepEqual(duel.s.chapter.orun!.moments, [id]);
  }
  assert.equal(duel.count(event => event.type === "encounter-resolved"), 1);
});

test("Asha's guard intercepts the Fang pounce on its committed lane: Charge Block, no pounce damage, aspect answered", { timeout: 30_000 }, () => {
  // Stage Asha in the arena, then hold her for this manual interception rather than automatic Pin.
  const duel = new Duel("orun-guard", "asha", { asha: { bond: 30, dominion: 0 } }, { asha: { x: 17, y: -7, z: -44 } });
  duel.command({ companionId: "asha", command: "stay" });
  let guarded = 0, pounced = 0;
  for (let i = 0; i < 3200 && !duel.s.chapter.orun!.answered.includes("fang") && duel.s.player.vitality > 0; i++) {
    if (duel.s.companionState.slots.asha?.mode === "follow" && !duel.s.companionState.slots.asha?.guard) duel.command({ companionId: "asha", command: "stay" });
    const s = duel.s, cast = s.chapter.orun?.cast;
    const aspect = cast?.aspect;
    const live = cast?.aspect === "fang" ? s.hazards.filter((h) => cast.hazardIds.includes(h.id) && h.activeFrom > s.worldTick) : [];
    if (live.length && !s.companionState.slots.asha?.guard && duel.command({ companionId: "asha", command: "special", target: { kind: "hazard", hazardId: live[0]!.id, protecteeId: "aren" } })) guarded++;
    const before = s.player.vitality;
    playFrame(duel);
    if (aspect === "fang" && duel.s.player.vitality < before) pounced++;
  }
  assert.equal(guarded, 1, "the guard was accepted for the reachable charge");
  assert.equal(pounced, 0);
  assert.ok(duel.s.presentationCues.some((cue) => cue.kind === "guard" && cue.phase === "hit" && cue.actorId?.startsWith("asha")), "Asha reaches the charge and makes contact");
  assert.ok(duel.s.chapter.orun!.answered.includes("fang"));
});

for (const id of ["sable", "nyra"] as const) test(`one companion: ${id} reveals its own aspect answer`, { timeout: 30_000 }, () => {
  const duel = new Duel(`orun-${id}`, id, { sable: { bond: 5, dominion: 30 }, nyra: { bond: 40, dominion: 0 } }, { [id]: { x: 12, y: -7, z: -46 } });
  duel.command({ companionId: id, command: "stay" });
  let gap: Vec3 | undefined, nyraOpenedCore = false;
  play(duel, 3200, d => {
    const s = d.s, cast = s.chapter.orun?.cast;
    if (s.companionState.slots[id]?.mode === "follow") d.command({ companionId: id, command: "stay" });
    gap ??= d.engine.snapshot().orun?.safeGap;
    nyraOpenedCore ||= cast?.aspect === "shadow" && cast.coreStruck && (d.actor("orun").weakPointUntil ?? 0) > s.worldTick;
    if (id === "sable" && cast?.aspect === "pack" && !cast.gapRevealed && !s.companionState.slots.sable?.job || id === "nyra" && cast?.aspect === "shadow" && !cast.coreStruck && !s.companionState.slots.nyra?.job) d.command({ companionId: id, command: "focus", target: { kind: "actor", instanceId: "orun" } });
  });
  if (id === "sable") assert.ok(gap, "Sable exposes the safe crossing");
  else assert.equal(nyraOpenedCore, true);
  assert.ok(duel.s.chapter.orun!.answered.includes(id === "sable" ? "pack" : "shadow"));
});

test("Solkar cancels the Dominion Roar before its hit only at high Bond", { timeout: 30_000 }, () => {
  for (const bond of [30, 5]) {
    const duel = new Duel(`orun-solkar-${bond}`, "solkar", { solkar: { bond, dominion: 0 } }, { solkar: { x: 12, y: -7, z: -45 } });
    duel.command({ companionId: "solkar", command: "stay" });
    let roar: { id: string; activeFrom: number } | undefined;
    let commanded = false;
    for (let i = 0; i < 3000 && duel.s.player.vitality > 0; i++) {
      const s = duel.s, cast = s.chapter.orun?.cast;
      if (s.companionState.slots.solkar?.mode === "follow") duel.command({ companionId: "solkar", command: "stay" });
      if (cast?.aspect === "crown") {
        const hazard = s.hazards.find(h => cast.hazardIds.includes(h.id) && h.activeFrom > s.worldTick);
        if (hazard) {
          roar ??= { id: hazard.id, activeFrom: hazard.activeFrom };
          if (!s.companionState.slots.solkar?.job) commanded = duel.command({ companionId: "solkar", command: "special", target: { kind: "actor", instanceId: "orun" } }) || commanded;
        }
      }
      if (roar && s.worldTick >= roar.activeFrom) break;
      playFrame(duel);
    }
    assert.ok(roar, "the Crown aspect was reached through play");
    assert.equal(commanded, true);
    const live = duel.s.hazards.find(h => h.id === roar.id && h.activeUntil > duel.s.worldTick);
    assert.equal(live === undefined, bond === 30, "only high Bond cancels the damaging hazard before its hit");
  }
});

test("a checkpoint retry after real progress restarts the duel without re-emitting a phase or reward event", { timeout: 30_000 }, () => {
  const duel = new Duel("orun-retry");
  play(duel, 1700);
  assert.equal(duel.s.phaseIndex, 1, "the Crowned Beast was reached by play");
  duel.engine.resetToCheckpoint();
  assert.equal(duel.s.phaseIndex, 0);
  assert.equal(duel.s.chapter.orun!.answered.length, 0);
  play(duel, 9000);
  assert.equal(duel.s.rewardEmitted, true);
  const keys = duel.events.filter((event) => event.type === "encounter-phase" || event.type === "encounter-resolved").map((event) => event.idempotencyKey);
  assert.equal(new Set(keys).size, keys.length, "every phase and the resolution are emitted once");
});

test("a restored save continues the live duel exactly as the uninterrupted run", { timeout: 30_000 }, () => {
  const straight = new Duel("orun-save");
  play(straight, 9000);
  const forked = new Duel("orun-save");
  play(forked, 1700);
  const saved = forked.engine.serialize();
  forked.engine.restore(saved);
  play(forked, 9000);
  assert.deepEqual(forked.events.map((event) => event.idempotencyKey), straight.events.map((event) => event.idempotencyKey));
  assert.equal(forked.s.tick, straight.s.tick);
});
