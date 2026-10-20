import { ConeGeometry, Vector3 } from 'three';
import type { KitSlot } from './ElementKits.js';
import { isYaraHandCast, leftPalm } from './ActorBounds.js';
import { CrystalSpikesFx } from './InstancedFx.js';
import { Footprint } from './footprint.js';
import { HEARTROOT_IMPACT, HEARTROOT_TRAIL, type HeartrootKitId } from './HeroKits.js';
import { PALETTE } from './palette.js';
import { emitPetalSwirl } from './PetalFx.js';
import { VFX_FRAME } from './VfxAtlas.js';
import type { VfxSystem } from './VfxSystem.js';
import type { WardenFx } from './WardenFx.js';

const UP = new Vector3(0, 1, 0);
const CLEANSE_SECONDS = 0.8;
const CLEANSE_RISE = 1.5;
/** Recent bursts remembered for duplicate matching; sized for several impacts in one tick (twin thorns, seed storm). */
const LEDGER_SIZE = 16;
/** Spatial tolerance (m) when no target id is known, and beyond an area burst's radius when matching a struck target's position. */
const POINT_MARGIN = 1.6;
const AREA_MARGIN = 1.6;
const BLOOM_FAMILY: Readonly<Partial<Record<HeartrootKitId, true>>> = { 'heartroot-bloom': true, 'heartroot-meteor': true };
const BARK = { r: 0.55, g: 0.32, b: 0.12 };
const THORN = { r: 0.45, g: 0.95, b: 0.2 };

interface Burst { tick: number; kit: HeartrootKitId; owner: number; x: number; z: number; radius: number; target: string; area: boolean; used: boolean }

/**
 * Heartroot (Yara) presentation: one kit per skill, each with its own contact (thorn, seed, root spike, eruption, sap lance, seed storm,
 * vines, cleanse, bloom, meteor), a sap trail on the staff head (or, for the hand casts, on her casting hand), shake/rim/light scaled by `HEARTROOT_IMPACT`, and a Petal Step petal swirl.
 * A recent-burst ledger keys a projectile hit (impact cue + hit cue) or an area burst (bloom cue + per-target hit cues) to the engine's
 * same-tick duplicate cue of the same skill, so one contact draws one burst.
 */
export class HeartrootCues {
  private readonly roots = new CrystalSpikesFx(80);
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly footprint = new Footprint();
  private readonly ledger: Burst[] = Array.from({ length: LEDGER_SIZE }, () => ({ tick: -Infinity, kit: 'heartroot-thorn' as HeartrootKitId, owner: -1, x: 0, z: 0, radius: 0, target: '', area: false, used: false }));
  private ledgerCursor = 0;

  constructor(private readonly vfx: VfxSystem, private readonly warden?: WardenFx) {
    const mesh = this.roots.mesh;
    mesh.name = 'vfx-heartroot-roots';
    // A segmented, curling taper reads as living root; the shared single-segment crystal cone reads as ice.
    const geometry = new ConeGeometry(0.5, 1, 7, 8).translate(0, 0.5, 0).toNonIndexed();
    const points = geometry.getAttribute('position');
    for (let i = 0; i < points.count; i++) {
      const x = points.getX(i), y = points.getY(i), z = points.getZ(i);
      const twist = y * 1.6, cos = Math.cos(twist), sin = Math.sin(twist);
      const knot = 1 + 0.18 * Math.sin(y * 17 + Math.atan2(z, x) * 2);
      points.setXYZ(i, (x * cos - z * sin) * knot + y * y * 0.42, y, (x * sin + z * cos) * knot + Math.sin(y * Math.PI) * 0.14);
    }
    points.needsUpdate = true;
    geometry.computeVertexNormals();
    mesh.geometry.dispose();
    mesh.geometry = geometry;
    // Dark bark body; only the fresnel rim carries the amber sap-light.
    mesh.material.uniforms.uDeep.value.setRGB(.03, .018, .008);
    mesh.material.uniforms.uMid.value.setRGB(.2, .11, .045);
    mesh.material.uniforms.uRim.value.copy(PALETTE.heartroot.b);
    mesh.material.uniforms.uRimStrength.value = 0.45;
    mesh.material.uniforms.uOpacity.value = 1;
    vfx.addModule({ group: mesh, update: time => this.roots.update(time), killOwner: owner => { this.roots.killOwner(owner); this.forget(owner); }, clear: () => { this.roots.clear(); this.forget(); }, dispose: () => this.roots.dispose() });
  }

  begin(slot: KitSlot): void {
    const cue = slot.cue, kit = slot.kit as HeartrootKitId, vfx = this.vfx, w = this.warden;
    const point = cue.position ?? cue.from ?? cue.to;
    if (!point) return;
    const owner = slot.owner, life = Math.max(.1, (cue.durationTicks ?? 30) / 60), radius = (cue.footprint?.width ?? 2) / 2;
    this.a.set(point.x, point.y, point.z);
    slot.lastTime = vfx.time;
    switch (cue.kind) {
      case 'sigil': case 'bloom':
        if (cue.kind === 'sigil' || cue.phase === 'anticipation') {
          slot.sigil = w?.sigils.spawn(owner, 'ground', vfx.time, this.a.set(point.x, point.y + .05, point.z), UP, cue.kind === 'sigil' ? 1.6 : radius, .45, .8, 'heartroot');
          slot.tracked = cue.kind === 'sigil';
          this.petals(owner, point.x, point.y + .1, point.z, 18, radius);
          if (cue.kind === 'sigil') vfx.lights.pulse(point.x, point.y + .5, point.z, PALETTE.heartroot.hot, HEARTROOT_IMPACT['heartroot-sigil'].light, 5, .3, vfx.time, owner);
          else this.openTrail(kit, 40);
          return;
        }
        this.areaBurst(slot, kit, point.x, point.y, point.z, radius);
        return;
      case 'beam': case 'tether':
        if (kit === 'heartroot-meteor') this.meteorFall(slot);
        else if (kit === 'heartroot-vines') this.vinesSnap(slot);
        else this.lanceBeam(slot, life);
        return;
      case 'blink': this.petalStep(slot); return;
      case 'root-eruption': this.rootEruption(slot, kit, point.x, point.y, point.z, radius, life); return;
      case 'projectile': this.launch(slot, kit, point.x, point.y, point.z); return;
      case 'projectile-impact': this.projectileImpact(slot, kit, point.x, point.y, point.z); return;
      case 'cleanse': this.cleanseBegin(slot, point.x, point.y, point.z); return;
      default: this.contact(slot, kit, point.x, point.y, point.z);
    }
  }

  update(slot: KitSlot): void {
    const kit = slot.kit as HeartrootKitId, vfx = this.vfx, w = this.warden, dt = Math.max(0, vfx.time - slot.lastTime);
    slot.lastTime = vfx.time;
    if (kit === 'heartroot-cleanse') { this.cleanseUpdate(slot, dt); return; }
    if (kit === 'heartroot-lance' && slot.beam && slot.beam.owner === slot.owner) {
      const tip = w?.resolveSocket?.('aren', 'weapon-tip');
      if (tip) { tip.updateWorldMatrix(true, false); tip.getWorldPosition(slot.beam.a); }
      slot.beam.alpha = Math.min(1, .35 + Math.sin(Math.PI * Math.min(1, Math.max(0, (vfx.time - slot.cue.worldTimeSeconds) / Math.max(.1, (slot.cue.durationTicks ?? 30) / 60)))) * .65);
      const n = this.due(slot, 1, 40, dt);
      for (let i = 0; i < n; i++) {
        this.a.lerpVectors(slot.beam.a, slot.beam.b, vfx.random());
        vfx.sparks(this.a.x, this.a.y, this.a.z, 1, 1.4, 'heartroot', slot.owner, .5);
        if (i % 2) this.drops(slot.owner, this.a.x, this.a.y, this.a.z, 1, 1.2);
      }
    }
    if (!slot.sigil) return;
    const player = w?.player;
    if (slot.tracked && player?.valid && slot.sigil.owner === slot.owner) {
      this.a.set(player.position.x, player.position.y + .05, player.position.z);
      w!.sigils.orient(slot.sigil, this.a, UP);
    } else this.a.copy(slot.sigil.center);
    const n = this.due(slot, 0, 24, dt);
    if (n > 0) this.petals(slot.owner, this.a.x, this.a.y, this.a.z, n, slot.cue.kind === 'bloom' ? 6 : 1.2);
  }

  end(slot: KitSlot, natural: boolean): void {
    if (!natural) this.forget(slot.owner);
    if (slot.sigil?.owner === slot.owner) this.warden?.sigils.finish(slot.sigil, this.vfx.time, natural ? .35 : .12);
    slot.sigil = undefined;
    if (slot.beam?.owner === slot.owner) this.vfx.beams.release(slot.beam);
    slot.beam = undefined;
  }

  // ---- launch and projectile impacts ----

  /** Thornshot / seed / storm-seed launch: a flare where the spell leaves her (the palm for the hand casts, the staff head for her staff strikes and Seed Storm) and a short sap trail. */
  private launch(slot: KitSlot, kit: HeartrootKitId, x: number, y: number, z: number): void {
    const vfx = this.vfx, owner = slot.owner;
    // The flare sits on what casts the spell, not on the simulation's spawn point ahead of the chest.
    if (this.castingPalm()) { x = this.a.x; y = this.a.y; z = this.a.z; }
    else if (this.warden?.player.hero === 'yara') {
      const tip = this.warden.resolveSocket?.('aren', 'weapon-tip');
      if (tip) { tip.updateWorldMatrix(true, false); tip.getWorldPosition(this.a); x = this.a.x; y = this.a.y; z = this.a.z; }
    }
    this.openTrail(kit, kit === 'heartroot-storm' ? 8 : 10);
    vfx.gather(x, y, z, kit === 'heartroot-seed' ? 12 : 8, .5, 'heartroot', owner);
    vfx.flash(x, y, z, kit === 'heartroot-seed' ? 1.2 : .8, 'heartroot', owner, .14);
    if (kit !== 'heartroot-storm') vfx.lights.pulse(x, y, z, PALETTE.heartroot.hot, 1.8, 4, .2, vfx.time, owner);
  }

  /** Writes the left palm into `this.a` (direction into `this.b`) while Yara plays a hand-cast skill; false otherwise. */
  private castingPalm(): boolean {
    const w = this.warden;
    if (!w || w.player.hero !== 'yara' || !isYaraHandCast(w.player.actionId)) return false;
    w.hand.resolve(w.resolveActorRoot?.('aren'));
    return leftPalm(w.hand, this.a, this.b);
  }

  private projectileImpact(slot: KitSlot, kit: HeartrootKitId, x: number, y: number, z: number): void {
    const cue = slot.cue, w = this.warden, visual = cue.scopeId ? w?.combat.findProjectile(cue.scopeId) : undefined;
    if (visual) w!.combat.endProjectile(visual);
    // A lobbed seed bursts through the `bloom` hit cue the engine queues right after this one.
    if (kit === 'heartroot-seed') return;
    this.record(cue.worldTick, kit, slot.owner, x, z, 0, cue.targetId ?? '', false);
    this.contact(slot, kit, x, y, z, true);
  }

  // ---- per-skill contact (one kit, one look) ----

  private contact(slot: KitSlot, kit: HeartrootKitId, x: number, y: number, z: number, fromImpact = false): void {
    const cue = slot.cue, owner = slot.owner, vfx = this.vfx;
    if (!fromImpact && this.claimed(cue.worldTick, kit, x, z, cue.targetId ?? '')) return;
    switch (kit) {
      case 'heartroot-thorn':
        // Thorn: bark-green shards fan out, a few sap droplets, a small amber flash.
        this.shards(owner, x, y, z, 8, 5);
        this.drops(owner, x, y, z, 5, 3);
        vfx.flash(x, y, z, .9, 'heartroot', owner, .14);
        this.shockDisk(owner, x, y - .9, z, .55, .35);
        break;
      case 'heartroot-storm':
        // Storm seed: a small pollen pop, soft and quick.
        vfx.sparks(x, y, z, 8, 3, 'heartroot', owner, .4);
        this.petals(owner, x, y, z, 6, .3);
        this.shockDisk(owner, x, y - .9, z, .5, .3);
        break;
      case 'heartroot-spike':
        // Root spike: living roots burst up from under the target and bark chips fly.
        this.rootRing(owner, x, y - .9, z, 4, .55, .9, 1.7);
        this.shards(owner, x, y - .5, z, 6, 4.5);
        this.shockDisk(owner, x, y - .9, z, .9, .4);
        break;
      case 'heartroot-lance':
        // Sap lance: a bright amber star with a forward spray of sap, along the beam heading.
        vfx.flash(x, y, z, 1.6, 'heartroot', owner, .18);
        vfx.sparks(x, y, z, 22, 7, 'heartroot', owner, .35);
        this.drops(owner, x, y, z, 8, 4.5);
        this.star(owner, x, y, z, 1.8);
        break;
      case 'heartroot-vines':
        this.rootRing(owner, x, y - .9, z, 5, .6, 1, 1.5);
        this.petals(owner, x, y - .5, z, 10, .7);
        break;
      default:
        // Contact accents of area skills (eruption, bloom, meteor) when no burst claimed them: a plain sap puff.
        this.drops(owner, x, y, z, 6, 3);
        this.petals(owner, x, y, z, 8, .5);
        break;
    }
    this.sink(kit, cue.targetId, x, y, z, owner);
  }

  /** Burst of an area skill at ground level (`bloom` hit cue): eruption, seed, meteor impact or the Bloom pulse. */
  private areaBurst(slot: KitSlot, kit: HeartrootKitId, x: number, y: number, z: number, radius: number): void {
    const cue = slot.cue, vfx = this.vfx, owner = slot.owner;
    this.record(cue.worldTick, kit, slot.owner, x, z, radius, '', true);
    switch (kit) {
      case 'heartroot-eruption':
        this.shockDisk(owner, x, y, z, radius, .6);
        vfx.dustRing(x, y, z, radius * .7, 18, owner);
        this.footprint.set('disk', x, y, z, 0, radius, radius);
        vfx.chunks(x, y + .1, z, 10, 4, .2, owner, false, this.footprint);
        vfx.flash(x, y + .4, z, Math.min(3, radius), 'heartroot', owner, .2);
        vfx.sparks(x, y + .3, z, 22, 5, 'heartroot', owner, .6);
        this.petals(owner, x, y + .2, z, 30, radius * .8);
        break;
      case 'heartroot-seed':
        // Seed: pollen cloud and a soft amber ring at the burst radius.
        this.shockDisk(owner, x, y, z, radius, .55);
        vfx.flash(x, y + .3, z, Math.min(3, radius * 1.2), 'heartroot', owner, .18);
        this.pollen(owner, x, y + .2, z, 22, radius * .7);
        this.petals(owner, x, y + .3, z, 26, radius * .8);
        vfx.sparks(x, y + .3, z, 14, 4, 'heartroot', owner, .5);
        break;
      case 'heartroot-bloom':
        // Bloom pulse: two expanding rings, a wide petal burst and a rising column of pollen.
        this.shockDisk(owner, x, y, z, radius, .7);
        this.shockDisk(owner, x, y, z, radius * .6, .55, .16);
        vfx.flash(x, y + .5, z, Math.min(5, radius * .6), 'heartroot', owner, .3);
        this.pollen(owner, x, y + .2, z, 40, radius * .6);
        this.petals(owner, x, y + .3, z, 56, radius * .85);
        vfx.sparks(x, y + .4, z, 36, 7, 'heartroot', owner, .6);
        break;
      default:
        // Meteor seed impact: a small ring, sap droplets and a leaf puff.
        this.shockDisk(owner, x, y, z, radius, .4);
        vfx.flash(x, y + .3, z, Math.min(2, radius * 1.2), 'heartroot', owner, .14);
        this.drops(owner, x, y + .1, z, 10, 4);
        vfx.leaves(x, y + .2, z, 6, radius * .5, 0, 0, owner);
        vfx.sparks(x, y + .2, z, 12, 4, 'heartroot', owner, .6);
        break;
    }
    this.sink(kit, undefined, x, y + .6, z, owner);
  }

  // ---- lanes, roots, beams ----

  private rootEruption(slot: KitSlot, kit: HeartrootKitId, x: number, y: number, z: number, radius: number, life: number): void {
    const cue = slot.cue, vfx = this.vfx, owner = slot.owner;
    if (cue.phase === 'anticipation') {
      this.openTrail(kit, Math.round(life * 60) + 6);
      vfx.ground.spawn('decal', slot.footprint, 'heartroot', owner, vfx.time, life, .7);
      vfx.gather(x, y + .3, z, 20, radius, 'heartroot', owner);
      return;
    }
    const lane = kit === 'heartroot-spike', count = vfx.reducedEffects ? 7 : lane ? 14 : 18;
    for (let i = 0; i < count; i++) {
      if (cue.from && cue.to) this.a.lerpVectors(this.b.set(cue.from.x, cue.from.y - .8, cue.from.z), slot.target.set(cue.to.x, cue.to.y - .8, cue.to.z), (i + .5) / count);
      else slot.footprint.sample(vfx.random(), vfx.random(), this.a, 0, .85);
      // Spike: tall thin roots racing down the lane; eruption: thick short roots across the disk.
      this.roots.spawn(this.a.x, this.a.y - .06, this.a.z, lane ? vfx.range(1.2, 2.6) : vfx.range(.8, 2.2), lane ? vfx.range(.14, .24) : vfx.range(.2, .34), vfx.range(-.3, .3), vfx.range(-.3, .3), vfx.time + i * (lane ? .02 : .012), .9, owner);
    }
    vfx.ground.spawn('shock', slot.footprint, 'heartroot', owner, vfx.time, .5, .8);
    if (lane) this.drops(owner, x, y + .5, z, 10, 3);
    this.petals(owner, x, y + .2, z, lane ? 18 : 28, radius);
  }

  private lanceBeam(slot: KitSlot, life: number): void {
    const cue = slot.cue, vfx = this.vfx, owner = slot.owner;
    if (!cue.from || !cue.to) return;
    this.openTrail('heartroot-lance', 14);
    slot.beam = vfx.beams.acquire(owner, vfx.time, life, cue.footprint?.width ?? .65, .04, 'heartroot');
    if (slot.beam) { slot.beam.a.set(cue.from.x, cue.from.y, cue.from.z); slot.beam.b.set(cue.to.x, cue.to.y, cue.to.z); }
    vfx.flash(cue.from.x, cue.from.y, cue.from.z, 1.2, 'heartroot', owner, .16);
    vfx.sparks(cue.to.x, cue.to.y, cue.to.z, 22, 4, 'heartroot', owner);
    vfx.lights.pulse(cue.from.x, cue.from.y, cue.from.z, PALETTE.heartroot.hot, HEARTROOT_IMPACT['heartroot-lance'].light, 6, .3, vfx.time, owner);
  }

  /** Bloom meteor: a falling seed streak (thin beam) shedding petals; its ground impact is the following `bloom` hit cue. */
  private meteorFall(slot: KitSlot): void {
    const cue = slot.cue, vfx = this.vfx;
    if (!cue.from || !cue.to) return;
    slot.beam = vfx.beams.acquire(slot.owner, vfx.time, Math.max(.1, (cue.durationTicks ?? 18) / 60), .22, .12, 'heartroot');
    if (slot.beam) { slot.beam.a.set(cue.from.x, cue.from.y, cue.from.z); slot.beam.b.set(cue.to.x, cue.to.y, cue.to.z); }
    for (let i = 0; i < 6; i++) this.petals(slot.owner, cue.to.x, cue.to.y + vfx.range(1, 9), cue.to.z, 1, .25);
  }

  /** Binding Vines: roots curl up around the target's feet (the live tether beam is `ActorVfx`'s). */
  private vinesSnap(slot: KitSlot): void {
    const cue = slot.cue, to = cue.to ?? cue.position;
    if (!to) return;
    this.openTrail('heartroot-vines', 14);
    // The vines are flung from her raised hand: a sap flare and a short spray of leaves along the throw.
    if (this.castingPalm()) {
      this.vfx.flash(this.a.x, this.a.y, this.a.z, .7, 'heartroot', slot.owner, .12);
      this.drops(slot.owner, this.a.x, this.a.y, this.a.z, 6, 1.6);
    }
    this.contact(slot, 'heartroot-vines', to.x, to.y + .9, to.z, true);
  }

  // ---- cleanse ----

  private cleanseBegin(slot: KitSlot, x: number, y: number, z: number): void {
    const vfx = this.vfx, owner = slot.owner;
    slot.origin.set(x, y + .05, z);
    slot.sigil = this.warden?.sigils.spawn(owner, 'ground', vfx.time, slot.origin, UP, 1.4, CLEANSE_SECONDS, .95, 'heartroot');
    slot.tracked = false;
    slot.acc[0] = 0;
    vfx.flash(x, y + .5, z, 1, 'heartroot', owner, .2);
    // The healing light gathers in her open palm before the ring rises.
    if (this.castingPalm()) vfx.gather(this.a.x, this.a.y, this.a.z, 10, .45, 'heartroot', owner);
    this.pollen(owner, x, y + .1, z, 14, .9);
    this.sink('heartroot-cleanse', slot.cue.targetId, x, y + 1, z, owner);
  }

  /** Rising heartroot circle with a column of petals and pollen climbing off the ring. */
  private cleanseUpdate(slot: KitSlot, dt: number): void {
    const vfx = this.vfx, ring = slot.sigil;
    if (!ring || ring.owner !== slot.owner) return;
    const age = Math.max(0, vfx.time - slot.cue.worldTimeSeconds), t = Math.min(1, age / CLEANSE_SECONDS), lift = CLEANSE_RISE * (1 - (1 - t) * (1 - t));
    this.warden!.sigils.orient(ring, this.a.set(slot.origin.x, slot.origin.y + lift, slot.origin.z), UP);
    const n = this.due(slot, 0, 30, dt);
    if (n > 0) this.petals(slot.owner, slot.origin.x, slot.origin.y + lift, slot.origin.z, n, 1.2 * (1 - .3 * t));
  }

  // ---- Petal Step ----

  /** Petal Step: a petal swirl lifts off at the start point, spirals along the path and blooms open at the destination (no wind dust). */
  private petalStep(slot: KitSlot): void {
    const cue = slot.cue, owner = slot.owner;
    if (!cue.from || !cue.to) return;
    const vfx = this.vfx;
    emitPetalSwirl(vfx, owner, cue.from.x, cue.from.y, cue.from.z, 24, .55, 2.4, 1);
    for (let i = 1; i < 6; i++) {
      const t = i / 6;
      emitPetalSwirl(vfx, owner, cue.from.x + (cue.to.x - cue.from.x) * t, cue.from.y + .2, cue.from.z + (cue.to.z - cue.from.z) * t, 5, .35, 1.4, i % 2 ? 1 : -1);
    }
    emitPetalSwirl(vfx, owner, cue.to.x, cue.to.y, cue.to.z, 28, .7, 2, -1);
    vfx.flash(cue.to.x, cue.to.y + .9, cue.to.z, 1.2, 'heartroot', owner, .18);
  }

  // ---- shared pieces ----

  /** Opens the staff-head sap trail window (the base→tip sockets sample the head) for `ticks` world ticks from now. */
  private openTrail(kit: HeartrootKitId, ticks: number): void {
    const w = this.warden, style = HEARTROOT_TRAIL[kit];
    if (!w || !style) return;
    const now = this.vfx.time;
    w.trailFrom = now - 2 / 60; w.trailUntil = now + ticks / 60;
    w.trailElement = 'heartroot';
    w.trail.setStyle('heartroot', style.intensity, style.life, style.width);
    w.edgePeak = 2.4 + style.intensity * .6; w.edgeBoost = 1;
  }

  /** Impact-sink feedback scaled by the skill: camera shake, target rim flash, light pulse and screen impulse (all optional, reduced-motion aware in the sink). */
  private sink(kit: HeartrootKitId, targetId: string | undefined, x: number, y: number, z: number, owner: number): void {
    const spec = HEARTROOT_IMPACT[kit], w = this.warden, impact = w?.impact, hot = PALETTE.heartroot.hot;
    if (spec.light > 0) this.vfx.lights.pulse(x, y, z, hot, spec.light, 5 + spec.light, .3, this.vfx.time, owner);
    if (!impact) return;
    if (spec.shake > 0) impact.shake(spec.shake, .12 + spec.shake * 1.2, 28);
    if (targetId && spec.rim > 0) impact.flashActor(targetId, hot, spec.rim, .2, kit === 'heartroot-cleanse' ? 'charge' : 'hit');
    if (spec.impulse > 0) impact.impulse?.(spec.impulse, .16 + spec.impulse * .2);
  }

  /** Remembers a burst so the engine's duplicate cue for the same contact (same world tick, same skill) draws nothing more. */
  private record(tick: number, kit: HeartrootKitId, owner: number, x: number, z: number, radius: number, target: string, area: boolean): void {
    const burst = this.ledger[this.ledgerCursor]!;
    this.ledgerCursor = (this.ledgerCursor + 1) % LEDGER_SIZE;
    burst.tick = tick; burst.kit = kit; burst.owner = owner; burst.x = x; burst.z = z; burst.radius = radius; burst.target = target; burst.area = area; burst.used = false;
  }

  /**
   * True when this contact is the engine's duplicate of a burst already drawn: same world tick and same skill kit, and either the same
   * struck target (point impact: covers one hit cue) or inside the burst radius (area burst: covers every struck target, each still gets its rim flash).
   * Independent contacts (other skill, other tick, other target) never match.
   */
  private claimed(tick: number, kit: HeartrootKitId, x: number, z: number, targetId: string): boolean {
    for (const burst of this.ledger) {
      // Meteor impacts and the Bloom pulse are both struck with the `yara-heartroot-bloom` clip, so their per-target hit cues route to the bloom kit.
      if (burst.tick !== tick || (burst.kit !== kit && !(BLOOM_FAMILY[burst.kit] && BLOOM_FAMILY[kit]))) continue;
      if (burst.area) {
        if (Math.hypot(x - burst.x, z - burst.z) > burst.radius + AREA_MARGIN) continue;
        if (targetId) this.warden?.impact?.flashActor(targetId, PALETTE.heartroot.hot, 1.1, .2, 'hit');
        return true;
      }
      if (burst.used || (burst.target && targetId ? burst.target !== targetId : Math.hypot(x - burst.x, z - burst.z) > POINT_MARGIN)) continue;
      burst.used = true;
      return true;
    }
    return false;
  }

  /** Forgets the bursts of one cue scope (cancellation) or of every scope. */
  private forget(owner?: number): void {
    for (const burst of this.ledger) if (owner === undefined || burst.owner === owner) burst.tick = -Infinity;
  }

  /** Whole emissions due this frame for a rate per second of world time (`dt` seconds), carried in `slot.acc[channel]`. */
  private due(slot: KitSlot, channel: 0 | 1 | 2 | 3, rate: number, dt: number): number {
    const amount = slot.acc[channel]! + dt * rate * (this.vfx.reducedEffects ? .35 : 1);
    slot.acc[channel] = amount % 1;
    return Math.floor(amount);
  }

  private shockDisk(owner: number, x: number, y: number, z: number, radius: number, seconds: number, delay = 0): void {
    this.footprint.set('disk', x, y, z, 0, radius, radius);
    this.vfx.ground.spawn('shock', this.footprint, 'heartroot', owner, this.vfx.time + delay, seconds, .8);
  }

  /** `count` roots curling out of the ground in a ring of `radius` around (x, z). */
  private rootRing(owner: number, x: number, y: number, z: number, count: number, radius: number, minHeight: number, maxHeight: number): void {
    const vfx = this.vfx, start = vfx.random() * Math.PI * 2;
    for (let i = 0; i < count; i++) {
      const angle = start + (i / count) * Math.PI * 2;
      this.roots.spawn(x + Math.cos(angle) * radius, y, z + Math.sin(angle) * radius, vfx.range(minHeight, maxHeight), vfx.range(.1, .17), -Math.cos(angle) * .35, -Math.sin(angle) * .35, vfx.time + i * .03, .8, owner);
    }
  }

  /** Amber sap droplets flung up and out (additive, falling). */
  private drops(owner: number, x: number, y: number, z: number, count: number, speed: number): void {
    const vfx = this.vfx, hot = PALETTE.heartroot.hot, body = PALETTE.heartroot.b;
    for (let i = vfx.count(count); i > 0; i--) {
      const p = vfx.spec(), angle = vfx.random() * Math.PI * 2, s = speed * vfx.range(.4, 1);
      p.x = x; p.y = y; p.z = z; p.vx = Math.cos(angle) * s; p.vy = vfx.range(.8, 1.6) * speed * .6; p.vz = Math.sin(angle) * s;
      p.gravity = 8; p.drag = .5; p.life = vfx.range(.4, .75); p.size0 = vfx.range(.05, .09); p.size1 = .03; p.frame = VFX_FRAME.drop;
      p.r0 = hot.r; p.g0 = hot.g; p.b0 = hot.b; p.r1 = body.r; p.g1 = body.g; p.b1 = body.b; p.a0 = .9; p.fadeOut = .6;
      vfx.emit(vfx.particles.additive, owner);
    }
  }

  /** Bark/thorn shards (opaque over-blend, so they read as wood and not as light). */
  private shards(owner: number, x: number, y: number, z: number, count: number, speed: number): void {
    const vfx = this.vfx;
    for (let i = vfx.count(count); i > 0; i--) {
      const p = vfx.spec(), angle = vfx.random() * Math.PI * 2, s = speed * vfx.range(.4, 1), thorn = i % 2 === 0, c = thorn ? THORN : BARK;
      p.x = x; p.y = y; p.z = z; p.vx = Math.cos(angle) * s; p.vy = vfx.range(.6, 2.4); p.vz = Math.sin(angle) * s;
      p.gravity = 9; p.drag = 1; p.life = vfx.range(.4, .8); p.size0 = vfx.range(.06, .12); p.size1 = .04; p.frame = VFX_FRAME.shard; p.spin = vfx.random() * 6; p.spinRate = vfx.range(-8, 8);
      p.r0 = p.r1 = c.r; p.g0 = p.g1 = c.g; p.b0 = p.b1 = c.b; p.a0 = .95; p.fadeOut = .55;
      vfx.emit(vfx.particles.alpha, owner);
    }
  }

  private star(owner: number, x: number, y: number, z: number, size: number): void {
    const vfx = this.vfx, p = vfx.spec(), hot = PALETTE.heartroot.hot;
    p.x = x; p.y = y; p.z = z; p.frame = VFX_FRAME.star; p.life = .18; p.size0 = size * .5; p.size1 = size; p.spin = vfx.random() * 6.28;
    p.r0 = p.r1 = hot.r; p.g0 = p.g1 = hot.g; p.b0 = p.b1 = hot.b; p.a0 = .9; p.fadeIn = .05; p.fadeOut = .5;
    vfx.emit(vfx.particles.additive, owner);
  }

  /** Soft amber pollen motes drifting up inside `radius`. */
  private pollen(owner: number, x: number, y: number, z: number, count: number, radius: number): void {
    const vfx = this.vfx, hot = PALETTE.heartroot.hot;
    for (let i = vfx.count(count); i > 0; i--) {
      const p = vfx.spec(), angle = vfx.random() * Math.PI * 2, r = Math.sqrt(vfx.random()) * radius;
      p.x = x + Math.cos(angle) * r; p.y = y + vfx.random() * .3; p.z = z + Math.sin(angle) * r;
      p.vx = vfx.range(-.3, .3); p.vy = vfx.range(.5, 1.6); p.vz = vfx.range(-.3, .3); p.drag = .5; p.life = vfx.range(.8, 1.5);
      p.size0 = vfx.range(.05, .1); p.size1 = .02; p.frame = VFX_FRAME.mote;
      p.r0 = p.r1 = hot.r; p.g0 = p.g1 = hot.g; p.b0 = p.b1 = hot.b; p.a0 = .8; p.fadeIn = .1; p.fadeOut = .6;
      vfx.emit(vfx.particles.additive, owner);
    }
  }

  private petals(owner: number, x: number, y: number, z: number, count: number, radius: number): void {
    const vfx = this.vfx;
    for (let i = vfx.count(count); i > 0; i--) {
      const p = vfx.spec(), angle = vfx.random() * Math.PI * 2, r = Math.sqrt(vfx.random()) * radius;
      p.x = x + Math.cos(angle) * r; p.y = y + vfx.range(0, .35); p.z = z + Math.sin(angle) * r;
      p.vx = Math.cos(angle) * .9; p.vz = Math.sin(angle) * .9; p.vy = vfx.range(.8, 2.3); p.gravity = .7; p.drag = .4;
      p.frame = VFX_FRAME.leaf; p.life = vfx.range(.65, 1.4); p.size0 = vfx.range(.12, .23); p.size1 = .04;
      p.spin = vfx.range(-5, 5); p.r0 = p.r1 = 1; p.g0 = p.g1 = i % 3 ? .5 : .9; p.b0 = p.b1 = i % 3 ? .68 : .76;
      p.a0 = .85; p.fadeIn = .04; p.fadeOut = .6;
      vfx.emit(vfx.particles.alpha, owner);
    }
  }
}
