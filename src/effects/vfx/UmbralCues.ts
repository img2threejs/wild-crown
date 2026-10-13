import { ConeGeometry, Quaternion, Vector3 } from 'three';
import type { KitSlot } from './ElementKits.js';
import { CRESCENT_CHORD } from './CrescentFx.js';
import { Footprint } from './footprint.js';
import { UMBRAL_IMPACT, UMBRAL_TRAIL, type UmbralKitId } from './HeroKits.js';
import { ContactLedger, crescentOrientation, cutSprite, directedSparks, headingOf, horizontalDirection, implode, laneSparks, silhouette, starFlash, tintSparks, type Tint } from './hero-fx.js';
import { CrystalSpikesFx } from './InstancedFx.js';
import { PALETTE, UMBRAL_RIM, UMBRAL_SMOKE } from './palette.js';
import type { VfxSystem } from './VfxSystem.js';
import type { WardenFx } from './WardenFx.js';

const UP = new Vector3(0, 1, 0);
const VIOLET: Tint = { hot: PALETTE.umbral.hot, body: PALETTE.umbral.b };
const CRIMSON: Tint = UMBRAL_RIM;
/** Slash look of the three iai steps: leading-edge tilt (rad), blade bank (rad) and whether a second, mirrored blade crosses the first (an X cut). */
const IAI_STYLE: Readonly<Record<string, { readonly tilt: number; readonly roll: number; readonly cross: boolean }>> = {
  'vesper-iai-1': { tilt: 0.12, roll: 0, cross: false },
  'vesper-iai-2': { tilt: 0.55, roll: 0.7, cross: false },
  'vesper-iai-3': { tilt: 0.3, roll: -0.6, cross: true },
};
const CAGE_CRESCENTS = 6;
const REQUIEM_MARK_SPAN = 1.7;

/**
 * Vesper (Moonshade Blade, `umbral`) presentation: one kit per skill, resolved from the clip id by `resolveUmbralKit`. Razor-thin violet crescents with a
 * crimson rim and black smoke wisps for the iai steps, a lingering slit for Crescent Rift, implosion/explosion pairs for Shadow Step, a crescent cage for
 * Thousand Cuts, kunai streaks, the Shade Swap lane and flash, ink-smoke Mist Blink with a fading silhouette, and the Crimson Requiem marks and detonation.
 * Death Mark pips and the Shadow Execution burst are snapshot-driven (`HeroStateFx`). A recent-contact ledger keys a kunai impact to the engine's same-tick
 * duplicate `hit` cue so one contact draws one burst. Everything is pooled and tagged with the cue scope, so cancellation removes it.
 */
export class UmbralCues {
  private readonly shadows = new CrystalSpikesFx(48);
  private readonly a = new Vector3();
  private readonly dir = new Vector3();
  private readonly quat = new Quaternion();
  private readonly footprint = new Footprint();
  private readonly ledger = new ContactLedger();

  constructor(private readonly vfx: VfxSystem, private readonly warden?: WardenFx) {
    const mesh = this.shadows.mesh;
    mesh.name = 'vfx-umbral-shadows';
    // Four-sided tapering blades: thin shadow daggers rather than the shared six-sided crystal cone.
    const geometry = new ConeGeometry(0.5, 1, 4, 1).translate(0, 0.5, 0).toNonIndexed();
    geometry.computeVertexNormals();
    mesh.geometry.dispose();
    mesh.geometry = geometry;
    // Black-violet blades: only the fresnel rim carries the crimson light.
    mesh.material.uniforms.uDeep.value.setRGB(0.008, 0.004, 0.02);
    mesh.material.uniforms.uMid.value.setRGB(0.07, 0.025, 0.14);
    mesh.material.uniforms.uRim.value.copy(UMBRAL_RIM.body);
    mesh.material.uniforms.uRimStrength.value = 0.6;
    mesh.material.uniforms.uOpacity.value = 1;
    vfx.addModule({ group: mesh, update: time => this.shadows.update(time), killOwner: owner => { this.shadows.killOwner(owner); this.ledger.forget(owner); }, clear: () => { this.shadows.clear(); this.ledger.forget(); }, dispose: () => this.shadows.dispose() });
  }

  begin(slot: KitSlot): void {
    const cue = slot.cue, kit = slot.kit as UmbralKitId;
    slot.lastTime = this.vfx.time;
    switch (cue.kind) {
      case 'slash': this.slash(slot, kit); return;
      case 'blink': case 'perfect-dodge': this.blink(slot, kit); return;
      case 'beam': this.lane(slot, kit); return;
      case 'tether': this.severing(slot); return;
      case 'sigil': this.charge(slot, kit); return;
      case 'projectile': this.launch(slot, kit); return;
      case 'projectile-impact': this.projectileImpact(slot, kit); return;
      case 'cleanse': this.cleanseBegin(slot); return;
      case 'judgement': case 'judgement-mark': this.requiem(slot); return;
      default: this.contact(slot, kit);
    }
  }

  update(slot: KitSlot): void {
    const kit = slot.kit as UmbralKitId, vfx = this.vfx, w = this.warden, dt = Math.max(0, vfx.time - slot.lastTime);
    slot.lastTime = vfx.time;
    if (kit === 'umbral-cleanse') { this.cleanseUpdate(slot, dt); return; }
    if (!slot.sigil) return;
    const player = w?.player;
    if (slot.tracked && player?.valid && slot.sigil.owner === slot.owner) {
      this.a.set(player.position.x, player.position.y + 0.05, player.position.z);
      w!.sigils.orient(slot.sigil, this.a, UP);
    } else this.a.copy(slot.sigil.center);
    const charging = slot.cue.phase === 'sustain' || slot.cue.phase === 'anticipation';
    if (!charging) return;
    if (kit === 'umbral-shade') {
      // The shade forms: ink rises off the ring and crimson motes are drawn in.
      const n = this.due(slot, 0, 22, dt);
      if (n > 0) vfx.smoke(this.a.x, this.a.y + 0.1, this.a.z, n, 0.9, 1.1, 0.9, 0.9, UMBRAL_SMOKE, 0.5, slot.owner, 0.2);
      const m = this.due(slot, 1, 26, dt);
      if (m > 0) vfx.gather(this.a.x, this.a.y + 0.9, this.a.z, m, 1, 'umbral', slot.owner);
    } else {
      const n = this.due(slot, 0, 34, dt);
      if (n > 0) vfx.gather(this.a.x, this.a.y + 0.9, this.a.z, n, 1.5, 'umbral', slot.owner);
      const m = this.due(slot, 1, 8, dt);
      if (m > 0) tintSparks(vfx, slot.owner, this.a.x, this.a.y + 0.2, this.a.z, m, 2.2, CRIMSON, 0.2);
    }
  }

  end(slot: KitSlot, natural: boolean): void {
    if (!natural) this.ledger.forget(slot.owner);
    if (slot.sigil?.owner === slot.owner) this.warden?.sigils.finish(slot.sigil, this.vfx.time, natural ? 0.3 : 0.12);
    slot.sigil = undefined;
    if (!natural && slot.beam?.owner === slot.owner) this.vfx.beams.release(slot.beam);
    slot.beam = undefined;
  }

  // ---- iai steps, Thousand Cuts and Requiem slashes ----

  private slash(slot: KitSlot, kit: UmbralKitId): void {
    const w = this.warden, vfx = this.vfx, cue = slot.cue, owner = slot.owner, action = cue.actionId ?? '';
    const at = cue.position ?? w?.player.position;
    if (!at) return;
    const ticks = cue.durationTicks ?? 6;
    this.openTrail(kit, ticks + 4);
    const yaw = cue.footprint?.angleRadians ?? (w ? headingOf(w.player.facing.x, w.player.facing.z) : 0), dx = Math.sin(yaw), dz = Math.cos(yaw), y = at.y + 1.05;
    if (kit === 'umbral-cuts') { this.cage(owner, at.x, at.y, at.z, ticks); return; }
    const reach = Math.max(1.2, cue.footprint?.length ?? 2.6), sector = Math.min(Math.PI * 1.2, cue.footprint?.sectorRadians ?? 2.44);
    const style = IAI_STYLE[action] ?? IAI_STYLE['vesper-iai-1']!;
    const scale = Math.min(4.4, 2 * reach * Math.sin(Math.min(sector, 2.8) / 2)) / CRESCENT_CHORD, life = (ticks + 10) / 60;
    const apexX = at.x + dx * reach * 0.82, apexZ = at.z + dz * reach * 0.82;
    this.crescent(owner, apexX, y, apexZ, yaw, style.tilt, style.roll, scale, 0.2, 1.4, life);
    if (style.cross) this.crescent(owner, apexX, y, apexZ, yaw, style.tilt, -style.roll, scale * 0.9, 0.2, 1.3, life);
    for (let side = -1; side <= 1; side += 2) {
      const h = yaw + side * sector * 0.5;
      vfx.smoke(at.x + Math.sin(h) * reach * 0.8, y - 0.1, at.z + Math.cos(h) * reach * 0.8, 2, 0.15, 0.5, 0.7, 0.6, UMBRAL_SMOKE, 0.5, owner, 0.4);
    }
    directedSparks(vfx, owner, apexX, y, apexZ, dx, 0.1, dz, 8, 6, 0.35, CRIMSON);
    vfx.lights.pulse(apexX, y, apexZ, PALETTE.umbral.hot, UMBRAL_IMPACT[kit].light, 5, 0.18, vfx.time, owner);
  }

  /** Thousand Cuts: six vertical crescents bulging inward around the target, each banked a little differently so they criss-cross like a cage. */
  private cage(owner: number, x: number, y: number, z: number, ticks: number): void {
    const vfx = this.vfx, life = Math.max(0.3, (ticks + 6) / 60), radius = 1.25, start = vfx.random() * Math.PI * 2;
    for (let i = 0; i < CAGE_CRESCENTS; i++) {
      const angle = start + (i / CAGE_CRESCENTS) * Math.PI * 2;
      this.crescent(owner, x + Math.sin(angle) * radius, y + 1, z + Math.cos(angle) * radius, angle + Math.PI, 0, Math.PI / 2 + (i % 2 ? 0.45 : -0.45), 1.05, 0.18, 1.3, life);
    }
    vfx.flash(x, y + 1, z, 1.6, 'umbral', owner, 0.18);
    tintSparks(vfx, owner, x, y + 1, z, 14, 4, CRIMSON, 0.2);
    this.shock(owner, x, y + 0.05, z, 1.5, 0.4, 0);
  }

  // ---- blinks ----

  private blink(slot: KitSlot, kit: UmbralKitId): void {
    const cue = slot.cue, from = cue.from, to = cue.to;
    if (!from || !to) { this.contact(slot, kit); return; }
    switch (kit) {
      case 'umbral-step': case 'umbral-sever': this.shadowStep(slot, from, to, kit === 'umbral-sever'); return;
      case 'umbral-cuts': this.cutsBlink(slot, from, to); return;
      case 'umbral-shade': this.shadeSwap(slot, from, to); return;
      case 'umbral-requiem': this.requiemBlink(slot, from, to); return;
      case 'umbral-rift': this.lane(slot, kit); return;
      default: this.mistBlink(slot, from, to);
    }
  }

  /** Shadow Step: the shadow implodes into the start point; at the end point it explodes into a violet-crimson burst with a crossed cut. */
  private shadowStep(slot: KitSlot, from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, severing: boolean): void {
    const vfx = this.vfx, owner = slot.owner, kit = slot.kit as UmbralKitId, tint = severing ? CRIMSON : VIOLET;
    implode(vfx, owner, from.x, from.y + 0.9, from.z, 18, 1.3, 0.6, UMBRAL_SMOKE, 0.6);
    vfx.gather(from.x, from.y + 0.9, from.z, 22, 1.2, 'umbral', owner);
    starFlash(vfx, owner, from.x, from.y + 0.9, from.z, 0.9, 0.16, VIOLET);
    laneSparks(vfx, owner, from.x, from.y + 0.9, from.z, to.x, to.y + 0.9, to.z, 24, 0.15, tint);
    this.openTrail(kit, 14);
    vfx.flash(to.x, to.y + 0.9, to.z, 2.2, 'umbral', owner, 0.2);
    tintSparks(vfx, owner, to.x, to.y + 0.9, to.z, 22, 7, CRIMSON, 0.2);
    vfx.smoke(to.x, to.y + 0.5, to.z, 10, 0.5, 0.8, 1.1, 0.8, UMBRAL_SMOKE, 0.55, owner, 1.4);
    this.shock(owner, to.x, to.y + 0.05, to.z, 1.6, 0.4, 0);
    const heading = headingOf(to.x - from.x, to.z - from.z);
    this.crescent(owner, to.x, to.y + 1, to.z, heading, 0.35, 0.8, 0.8, 0.2, 1.3, 0.3);
    this.crescent(owner, to.x, to.y + 1, to.z, heading, 0.35, -0.8, 0.8, 0.2, 1.3, 0.3);
    vfx.lights.pulse(to.x, to.y + 1, to.z, PALETTE.umbral.hot, UMBRAL_IMPACT[kit].light, 6, 0.25, vfx.time, owner);
    this.feedback(kit, undefined, to.x, to.y + 1, to.z, owner);
  }

  /** Mist Blink: a fading silhouette stays at the start, ink-smoke bursts at both ends and trails along the path. */
  private mistBlink(slot: KitSlot, from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): void {
    const vfx = this.vfx, owner = slot.owner;
    silhouette(vfx, owner, from.x, from.y, from.z, 1.8, 0.55, UMBRAL_SMOKE, 0.55, CRIMSON);
    vfx.smoke(from.x, from.y + 0.8, from.z, 16, 0.5, 0.9, 1.2, 0.9, UMBRAL_SMOKE, 0.6, owner, 1.2);
    for (let i = 1; i < 6; i++) {
      const t = i / 6;
      vfx.smoke(from.x + (to.x - from.x) * t, from.y + 0.9, from.z + (to.z - from.z) * t, 2, 0.25, 0.4, 0.8, 0.7, UMBRAL_SMOKE, 0.45, owner, 0.3);
    }
    vfx.smoke(to.x, to.y + 0.8, to.z, 16, 0.5, 0.9, 1.2, 0.9, UMBRAL_SMOKE, 0.6, owner, 1.2);
    vfx.flash(to.x, to.y + 0.9, to.z, 1.3, 'umbral', owner, 0.18);
    tintSparks(vfx, owner, to.x, to.y + 0.9, to.z, 10, 4, CRIMSON, 0.3);
    laneSparks(vfx, owner, from.x, from.y + 0.9, from.z, to.x, to.y + 0.9, to.z, 12, 0.2, CRIMSON);
  }

  /** One of the Thousand Cuts blinks: a small implosion at the foe, a crossed pair of cuts and a crimson spark burst. */
  private cutsBlink(slot: KitSlot, from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): void {
    const vfx = this.vfx, owner = slot.owner, heading = headingOf(to.x - from.x, to.z - from.z);
    implode(vfx, owner, to.x, to.y + 0.9, to.z, 8, 0.9, 0.4, UMBRAL_SMOKE, 0.5);
    this.crescent(owner, to.x, to.y + 1, to.z, heading, 0.3, 0.9, 0.7, 0.18, 1.3, 0.22);
    cutSprite(vfx, owner, to.x, to.y + 1, to.z, Math.cos(heading), 0.4, -Math.sin(heading), 1.8, 0.14, VIOLET);
    tintSparks(vfx, owner, to.x, to.y + 1, to.z, 9, 4.5, CRIMSON, 0.2);
    laneSparks(vfx, owner, from.x, from.y + 0.9, from.z, to.x, to.y + 0.9, to.z, 8, 0.12, VIOLET);
  }

  /** Shade Swap: Vesper vanishes from the start in black smoke, leaving a shade, and appears at the clone with a violet flash and a crimson ring. */
  private shadeSwap(slot: KitSlot, from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): void {
    const vfx = this.vfx, owner = slot.owner, kit = slot.kit as UmbralKitId;
    silhouette(vfx, owner, from.x, from.y, from.z, 1.8, 0.45, UMBRAL_SMOKE, 0.5, VIOLET);
    implode(vfx, owner, from.x, from.y + 0.9, from.z, 14, 1.2, 0.55, UMBRAL_SMOKE, 0.55);
    this.openTrail(kit, 10);
    vfx.flash(to.x, to.y + 1, to.z, 3, 'umbral', owner, 0.24);
    this.shock(owner, to.x, to.y + 0.05, to.z, 2.2, 0.5, 0);
    this.shock(owner, to.x, to.y + 0.05, to.z, 1.2, 0.35, 0.08);
    tintSparks(vfx, owner, to.x, to.y + 0.9, to.z, 26, 7, CRIMSON, 0.3);
    vfx.smoke(to.x, to.y + 0.5, to.z, 12, 0.6, 0.9, 1.2, 0.9, UMBRAL_SMOKE, 0.55, owner, 1.5);
    vfx.lights.pulse(to.x, to.y + 1, to.z, PALETTE.umbral.hot, UMBRAL_IMPACT[kit].light, 7, 0.3, vfx.time, owner);
    this.feedback(kit, undefined, to.x, to.y + 1, to.z, owner);
  }

  /** One Requiem blink-slash: a crimson cut and crescent at the foe, sparks along the path. */
  private requiemBlink(slot: KitSlot, from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): void {
    const vfx = this.vfx, owner = slot.owner, heading = headingOf(to.x - from.x, to.z - from.z);
    this.openTrail('umbral-requiem', 8);
    this.crescent(owner, to.x, to.y + 1, to.z, heading, 0.25, 0.7 + vfx.random() * 0.5, 0.9, 0.2, 1.4, 0.24);
    cutSprite(vfx, owner, to.x, to.y + 1, to.z, Math.cos(heading), 0.3, -Math.sin(heading), 2.2, 0.15, CRIMSON);
    tintSparks(vfx, owner, to.x, to.y + 1, to.z, 12, 5, CRIMSON, 0.3);
    laneSparks(vfx, owner, from.x, from.y + 0.9, from.z, to.x, to.y + 0.9, to.z, 10, 0.15, CRIMSON);
    vfx.smoke(from.x, from.y + 0.8, from.z, 3, 0.3, 0.6, 0.8, 0.6, UMBRAL_SMOKE, 0.5, owner, 0.6);
  }

  // ---- lanes ----

  /**
   * Beam cues: Crescent Rift is a thin violet slit through the foe that lingers (beam plus a cracked ground decal, tall crimson sparks along it);
   * the Shade Swap clone lane is a wide ink-black ground band; Requiem and Severing Shadow draw a crimson line.
   */
  private lane(slot: KitSlot, kit: UmbralKitId): void {
    const cue = slot.cue, vfx = this.vfx, owner = slot.owner, from = cue.from ?? cue.position, to = cue.to ?? cue.position;
    if (!from || !to) return;
    const life = Math.max(0.1, (cue.durationTicks ?? 12) / 60), length = Math.hypot(to.x - from.x, to.z - from.z), heading = headingOf(to.x - from.x, to.z - from.z);
    const width = cue.footprint?.width ?? (kit === 'umbral-shade' ? 1.4 : 0.5);
    this.footprint.set('rect', (from.x + to.x) / 2, Math.min(from.y, to.y), (from.z + to.z) / 2, heading, width / 2, Math.max(0.2, length / 2), 0, 1);
    if (kit === 'umbral-shade') {
      vfx.ground.spawn('fill', this.footprint, 'umbral', owner, vfx.time, life + 0.5, 0.8);
      slot.beam = vfx.beams.acquire(owner, vfx.time, life + 0.2, 0.18, 0.08, 'umbral');
    } else {
      this.openTrail(kit, Math.round(life * 60) + 6);
      vfx.ground.spawn('decal', this.footprint, 'umbral', owner, vfx.time, 2.2, 0.9);
      slot.beam = vfx.beams.acquire(owner, vfx.time, life + 0.9, kit === 'umbral-rift' ? 0.1 : 0.14, 0.015, 'umbral');
    }
    if (slot.beam) { slot.beam.a.set(from.x, from.y + 1, from.z); slot.beam.b.set(to.x, to.y + 1, to.z); }
    laneSparks(vfx, owner, from.x, from.y + 1, from.z, to.x, to.y + 1, to.z, kit === 'umbral-rift' ? 30 : 16, 0.25, kit === 'umbral-shade' ? VIOLET : CRIMSON);
    vfx.smoke(from.x, from.y + 0.6, from.z, 6, 0.4, 0.6, 0.9, 0.7, UMBRAL_SMOKE, 0.5, owner, 0.8);
    vfx.flash(from.x, from.y + 1, from.z, 1.2, 'umbral', owner, 0.16);
    if (kit === 'umbral-rift') {
      // The through-cut: a long crescent along the lane and a crimson burst where the dash exits.
      this.crescent(owner, to.x, to.y + 1, to.z, heading, 0.2, 0.3, Math.min(3.6, 1 + length * 0.4) / CRESCENT_CHORD * 1.2, 0.2, 1.5, 0.4);
      tintSparks(vfx, owner, to.x, to.y + 1, to.z, 22, 7, CRIMSON, 0.2);
      vfx.flash(to.x, to.y + 1, to.z, 2.2, 'umbral', owner, 0.2);
      this.feedback(kit, undefined, to.x, to.y + 1, to.z, owner);
    }
    vfx.lights.pulse(to.x, to.y + 1, to.z, PALETTE.umbral.hot, UMBRAL_IMPACT[kit].light, 6, 0.3, vfx.time, owner);
  }

  /** Severing Shadow: a crimson chain of ink to the winding-up foe, an interrupt burst of shards and a crossed cut. */
  private severing(slot: KitSlot): void {
    const cue = slot.cue, vfx = this.vfx, owner = slot.owner, to = cue.to ?? cue.position, from = cue.from ?? this.warden?.player.position;
    if (!to) return;
    if (from) {
      slot.beam = vfx.beams.acquire(owner, vfx.time, 0.3, 0.12, 0.05, 'umbral');
      if (slot.beam) { slot.beam.a.set(from.x, from.y + 1.1, from.z); slot.beam.b.set(to.x, to.y + 1, to.z); }
      laneSparks(vfx, owner, from.x, from.y + 1.1, from.z, to.x, to.y + 1, to.z, 14, 0.12, CRIMSON);
    }
    const heading = headingOf(to.x - (from?.x ?? to.x), to.z - (from?.z ?? to.z - 1));
    this.crescent(owner, to.x, to.y + 1, to.z, heading, 0.3, 0.8, 0.8, 0.2, 1.3, 0.3);
    this.crescent(owner, to.x, to.y + 1, to.z, heading, 0.3, -0.8, 0.8, 0.2, 1.3, 0.3);
    vfx.flash(to.x, to.y + 1, to.z, 1.8, 'umbral', owner, 0.2);
    tintSparks(vfx, owner, to.x, to.y + 1, to.z, 20, 6, CRIMSON, 0.2);
    vfx.shards(to.x, to.y + 1, to.z, 8, 5, owner);
    this.feedback('umbral-sever', cue.targetId, to.x, to.y + 1, to.z, owner);
  }

  // ---- charge sigils (Thousand Cuts, Shade Swap) ----

  private charge(slot: KitSlot, kit: UmbralKitId): void {
    const w = this.warden, vfx = this.vfx, cue = slot.cue, owner = slot.owner, point = cue.position ?? cue.from ?? w?.player.position;
    if (!point) return;
    this.a.set(point.x, point.y + 0.05, point.z);
    const cuts = kit !== 'umbral-shade';
    slot.sigil = w?.sigils.spawn(owner, 'ground', vfx.time, this.a, UP, cuts ? 1.7 : 1.25, cue.phase === 'sustain' ? Infinity : Math.max(1 / 60, (cue.durationTicks ?? 24) / 60), cuts ? 1 : 0.85, 'umbral');
    slot.tracked = true;
    slot.acc.fill(0);
    vfx.flash(point.x, point.y + 0.5, point.z, 1, 'umbral', owner, 0.14);
    vfx.lights.pulse(point.x, point.y + 0.6, point.z, PALETTE.umbral.hot, UMBRAL_IMPACT[kit].light, 5, 0.3, vfx.time, owner);
    if (cuts) {
      // A ring of upright crescents orbits the caster while the cuts gather.
      const life = Math.max(0.3, (cue.durationTicks ?? 24) / 60);
      for (let i = 0; i < 4; i++) {
        const angle = (i / 4) * Math.PI * 2 + 0.4;
        this.crescent(owner, point.x + Math.sin(angle) * 1.3, point.y + 1, point.z + Math.cos(angle) * 1.3, angle + Math.PI, 0, Math.PI / 2 + 0.3, 0.7, 0.16, 0.9, life);
      }
    } else silhouette(vfx, owner, point.x, point.y, point.z, 1.8, 0.7, UMBRAL_SMOKE, 0.4, VIOLET);
  }

  // ---- kunai and the shade clone ----

  private launch(slot: KitSlot, kit: UmbralKitId): void {
    const vfx = this.vfx, cue = slot.cue, owner = slot.owner, from = cue.from ?? cue.position;
    if (!from) return;
    this.dir.set(0, 0, 0);
    const aim = cue.to, w = this.warden;
    horizontalDirection(from.x, from.z, aim?.x ?? from.x, aim?.z ?? from.z, w?.player.facing.x ?? 0, w?.player.facing.z ?? 1, this.dir);
    if (kit === 'umbral-shade') {
      vfx.smoke(from.x, from.y, from.z, 10, 0.5, 0.8, 1, 0.8, UMBRAL_SMOKE, 0.55, owner, 1.2);
      vfx.flash(from.x, from.y, from.z, 1.5, 'umbral', owner, 0.18);
      tintSparks(vfx, owner, from.x, from.y, from.z, 10, 4, CRIMSON, 0.3);
      return;
    }
    vfx.flash(from.x, from.y, from.z, 0.9, 'umbral', owner, 0.14);
    directedSparks(vfx, owner, from.x, from.y, from.z, this.dir.x, 0.05, this.dir.z, 12, 9, 0.4, VIOLET);
    tintSparks(vfx, owner, from.x, from.y, from.z, 4, 3, CRIMSON, 0.3);
    vfx.lights.pulse(from.x, from.y, from.z, PALETTE.umbral.hot, 1.4, 4, 0.18, vfx.time, owner);
  }

  private projectileImpact(slot: KitSlot, kit: UmbralKitId): void {
    const cue = slot.cue, w = this.warden, vfx = this.vfx, owner = slot.owner, at = cue.position;
    if (!at) return;
    const visual = cue.scopeId ? w?.combat.findProjectile(cue.scopeId) : undefined;
    if (visual) w!.combat.endProjectile(visual);
    this.ledger.record(cue.worldTick, cue.actionId ?? '', owner, at.x, at.z, cue.targetId ?? '');
    if (kit === 'umbral-shade') { this.shadeImpact(slot, at); return; }
    // Kunai bite: violet sparks fan out, a crimson star flares and a small slit stays on the target.
    starFlash(vfx, owner, at.x, at.y, at.z, 0.8, 0.14, CRIMSON);
    tintSparks(vfx, owner, at.x, at.y, at.z, 12, 5, VIOLET, 0.3);
    tintSparks(vfx, owner, at.x, at.y, at.z, 6, 3.5, CRIMSON, 0.3);
    this.shock(owner, at.x, at.y - 0.9, at.z, 0.6, 0.3, 0);
    this.feedback(kit, cue.targetId, at.x, at.y, at.z, owner);
  }

  private shadeImpact(slot: KitSlot, at: { x: number; y: number; z: number }): void {
    const vfx = this.vfx, owner = slot.owner;
    vfx.flash(at.x, at.y, at.z, 2.4, 'umbral', owner, 0.2);
    tintSparks(vfx, owner, at.x, at.y, at.z, 18, 6, CRIMSON, 0.3);
    vfx.smoke(at.x, at.y - 0.3, at.z, 8, 0.5, 0.8, 1.1, 0.8, UMBRAL_SMOKE, 0.55, owner, 1.2);
    this.shock(owner, at.x, at.y - 0.9, at.z, 1.5, 0.4, 0);
    this.feedback('umbral-shade', slot.cue.targetId, at.x, at.y, at.z, owner);
  }

  // ---- contact (hit cues) ----

  /** Contact accent of a Vesper strike; each kit has its own look. A kunai/clone point impact already drawn this tick adds only the target rim flash. */
  private contact(slot: KitSlot, kit: UmbralKitId): void {
    const cue = slot.cue, vfx = this.vfx, owner = slot.owner, at = cue.position ?? cue.to ?? cue.from;
    if (!at) return;
    if (this.ledger.claim(cue.worldTick, cue.actionId ?? '', at.x, at.z, cue.targetId ?? '')) {
      if (cue.targetId) this.warden?.impact?.flashActor(cue.targetId, PALETTE.umbral.hot, 1, 0.2, 'hit');
      return;
    }
    const w = this.warden, intensity = Math.min(2, Math.max(0.5, cue.intensity ?? 1));
    if (cue.to) this.dir.set(cue.to.x - at.x, 0, cue.to.z - at.z); else this.dir.set(w?.player.facing.x ?? 0, 0, w?.player.facing.z ?? 1);
    if (this.dir.lengthSq() < 1e-8) this.dir.set(w?.player.facing.x ?? 0, 0, w?.player.facing.z ?? 1);
    this.dir.normalize();
    const dx = this.dir.x, dz = this.dir.z;
    switch (kit) {
      case 'umbral-rift':
        // Two crossing razor cuts and a crimson burst.
        cutSprite(vfx, owner, at.x, at.y, at.z, dz, 0.6, -dx, 2.6, 0.17, VIOLET);
        cutSprite(vfx, owner, at.x, at.y, at.z, dz, -0.6, -dx, 2.6, 0.17, CRIMSON);
        tintSparks(vfx, owner, at.x, at.y, at.z, 24, 8, CRIMSON, 0.2);
        directedSparks(vfx, owner, at.x, at.y, at.z, dx, 0.1, dz, 14, 9, 0.3, VIOLET);
        vfx.flash(at.x, at.y, at.z, 2, 'umbral', owner, 0.2);
        this.shock(owner, at.x, at.y - 0.9, at.z, 1.2, 0.4, 0);
        break;
      case 'umbral-step': case 'umbral-sever':
        starFlash(vfx, owner, at.x, at.y, at.z, 1.4, 0.16, CRIMSON);
        tintSparks(vfx, owner, at.x, at.y, at.z, 16, 6, CRIMSON, 0.2);
        directedSparks(vfx, owner, at.x, at.y, at.z, dx, 0.1, dz, 8, 8, 0.3, VIOLET);
        vfx.flash(at.x, at.y, at.z, 1.4, 'umbral', owner, 0.16);
        break;
      case 'umbral-shade':
        vfx.flash(at.x, at.y, at.z, 1.8, 'umbral', owner, 0.18);
        tintSparks(vfx, owner, at.x, at.y, at.z, 14, 6, VIOLET, 0.3);
        vfx.smoke(at.x, at.y - 0.2, at.z, 5, 0.4, 0.7, 0.9, 0.7, UMBRAL_SMOKE, 0.5, owner, 1);
        break;
      case 'umbral-requiem':
        // Requiem slashes are cheap crimson ticks; a heavy final contact (the detonation) bursts wide.
        if (intensity >= 1.5) this.detonation(owner, at.x, at.y, at.z, cue.targetId);
        else { cutSprite(vfx, owner, at.x, at.y, at.z, dz, 0.4, -dx, 1.6, 0.14, CRIMSON); tintSparks(vfx, owner, at.x, at.y, at.z, 8, 5, CRIMSON, 0.3); }
        break;
      case 'umbral-cuts':
        cutSprite(vfx, owner, at.x, at.y, at.z, dz, vfx.range(-0.6, 0.6), -dx, 1.5, 0.12, VIOLET);
        tintSparks(vfx, owner, at.x, at.y, at.z, 6, 4.5, CRIMSON, 0.3);
        break;
      default:
        // Iai: a razor slit across the contact (aligned to the swing plane), violet sparks and a crimson glint.
        cutSprite(vfx, owner, at.x, at.y, at.z, dz, 0.35, -dx, 1.7 + 0.4 * intensity, 0.15, VIOLET);
        directedSparks(vfx, owner, at.x, at.y, at.z, dx, 0.1, dz, 10, 8, 0.35, VIOLET);
        tintSparks(vfx, owner, at.x, at.y, at.z, 5, 4, CRIMSON, 0.3);
        starFlash(vfx, owner, at.x, at.y, at.z, 0.6 + 0.3 * intensity, 0.12, CRIMSON);
        break;
    }
    this.feedback(kit, cue.targetId, at.x, at.y, at.z, owner);
  }

  // ---- Crimson Requiem ----

  /**
   * Requiem cues: the cast is a wide umbral sigil with a black ring of smoke, the mark is a crimson X that hangs over the foe, and the final contact
   * is a crimson detonation with shadow blades bursting from the ground.
   */
  private requiem(slot: KitSlot): void {
    const cue = slot.cue, w = this.warden, vfx = this.vfx, owner = slot.owner, at = cue.position ?? w?.player.position;
    if (!at) return;
    if (cue.kind === 'judgement-mark') {
      if (cue.phase === 'hit') { this.detonation(owner, at.x, at.y, at.z, cue.targetId); return; }
      this.requiemMark(slot, at);
      return;
    }
    if (cue.phase === 'anticipation') {
      this.a.set(at.x, at.y + 0.05, at.z);
      slot.sigil = w?.sigils.spawn(owner, 'ground', vfx.time, this.a, UP, 3, Math.max(1 / 60, (cue.durationTicks ?? 12) / 60), 1.1, 'umbral');
      slot.tracked = true;
      vfx.gather(at.x, at.y + 1, at.z, 30, 1.8, 'umbral', owner);
      vfx.smoke(at.x, at.y + 0.2, at.z, 14, 1.8, 0.7, 1.2, 1, UMBRAL_SMOKE, 0.5, owner, 0.6);
    } else if (cue.phase === 'commit') {
      vfx.flash(at.x, at.y + 1, at.z, 2.6, 'umbral', owner, 0.22);
      tintSparks(vfx, owner, at.x, at.y + 1, at.z, 18, 6, CRIMSON, 0.2);
    } else this.detonation(owner, at.x, at.y, at.z, cue.targetId);
  }

  /** A crimson X (two crossed crescents) over a ground ring, hanging at the marked foe's chest for the cue's lifetime. */
  private requiemMark(slot: KitSlot, at: { x: number; y: number; z: number }): void {
    const vfx = this.vfx, owner = slot.owner, life = Math.max(0.3, (slot.cue.durationTicks ?? 90) / 60), scale = REQUIEM_MARK_SPAN / CRESCENT_CHORD, cam = vfx.cameraPosition;
    const heading = headingOf(cam.x - at.x, cam.z - at.z);
    this.crescent(owner, at.x, at.y + 1.15, at.z, heading + Math.PI, 0.9, Math.PI / 4, scale, 0.5, 1.2, life);
    this.crescent(owner, at.x, at.y + 1.15, at.z, heading + Math.PI, 0.9, -Math.PI / 4, scale, 0.5, 1.2, life);
    this.a.set(at.x, at.y + 0.05, at.z);
    this.warden?.sigils.spawn(owner, 'ground', vfx.time, this.a, UP, 1.1, Infinity, 0.6, 'umbral');
    vfx.flash(at.x, at.y + 1.15, at.z, 1.1, 'umbral', owner, 0.14);
    tintSparks(vfx, owner, at.x, at.y + 1.15, at.z, 8, 3, CRIMSON, 0.3);
  }

  /** The Requiem detonation: a crimson flash and ring, a spray of crimson sparks, black smoke and shadow blades bursting out of the ground. */
  private detonation(owner: number, x: number, y: number, z: number, targetId: string | undefined): void {
    const vfx = this.vfx, ground = y - 0.9;
    starFlash(vfx, owner, x, y, z, 2.4, 0.22, CRIMSON);
    vfx.flash(x, y, z, 3, 'umbral', owner, 0.26);
    tintSparks(vfx, owner, x, y, z, 34, 9, CRIMSON, 0.3);
    tintSparks(vfx, owner, x, y, z, 14, 6, VIOLET, 0.3);
    vfx.smoke(x, y - 0.3, z, 10, 0.7, 0.9, 1.3, 1, UMBRAL_SMOKE, 0.6, owner, 1.6);
    this.shock(owner, x, ground, z, 2.6, 0.5, 0);
    this.shock(owner, x, ground, z, 1.5, 0.4, 0.08);
    const start = vfx.random() * Math.PI * 2, count = vfx.reducedEffects ? 4 : 8;
    for (let i = 0; i < count; i++) {
      const angle = start + (i / count) * Math.PI * 2;
      this.shadows.spawn(x + Math.cos(angle) * 0.7, ground, z + Math.sin(angle) * 0.7, vfx.range(1.2, 2.2), vfx.range(0.09, 0.15), -Math.cos(angle) * 0.4, -Math.sin(angle) * 0.4, vfx.time + i * 0.012, 0.7, owner);
    }
    vfx.lights.pulse(x, y, z, UMBRAL_RIM.hot, UMBRAL_IMPACT['umbral-requiem'].light, 8, 0.4, vfx.time, owner);
    this.feedback('umbral-requiem', targetId, x, y, z, owner);
  }

  // ---- cleanse ----

  private cleanseBegin(slot: KitSlot): void {
    const w = this.warden, vfx = this.vfx, owner = slot.owner, at = slot.cue.position ?? w?.player.position;
    if (!at) return;
    slot.origin.set(at.x, at.y + 0.05, at.z);
    slot.sigil = w?.sigils.spawn(owner, 'ground', vfx.time, slot.origin, UP, 1.5, 0.8, 1, 'umbral');
    slot.tracked = false;
    slot.acc.fill(0);
    vfx.flash(at.x, at.y + 0.5, at.z, 1.1, 'umbral', owner, 0.2);
    vfx.lights.pulse(at.x, at.y + 1, at.z, PALETTE.umbral.hot, UMBRAL_IMPACT['umbral-cleanse'].light, 5, 0.5, vfx.time, owner);
    if (slot.cue.targetId) w?.impact?.flashActor(slot.cue.targetId, PALETTE.umbral.b, 0.8, 0.5, 'charge');
  }

  /** The ring rises while violet motes climb off it and crimson embers are shed. */
  private cleanseUpdate(slot: KitSlot, dt: number): void {
    const vfx = this.vfx, ring = slot.sigil;
    if (!ring || ring.owner !== slot.owner) return;
    const age = Math.max(0, vfx.time - slot.cue.worldTimeSeconds), t = Math.min(1, age / 0.8), lift = 1.6 * (1 - (1 - t) * (1 - t));
    this.warden!.sigils.orient(ring, this.a.set(slot.origin.x, slot.origin.y + lift, slot.origin.z), UP);
    const n = this.due(slot, 0, 30, dt);
    if (n > 0) vfx.embers(slot.origin.x, slot.origin.y + lift, slot.origin.z, n, 1.2 * (1 - 0.3 * t), 1.6, -0.6, slot.owner, 'umbral');
    const m = this.due(slot, 1, 8, dt);
    if (m > 0) tintSparks(vfx, slot.owner, slot.origin.x, slot.origin.y + lift, slot.origin.z, m, 1.4, CRIMSON, 0.6);
  }

  // ---- shared pieces ----

  /** One crescent blade at (x, y, z); `heading`, `tilt` and `roll` as in `crescentOrientation`; violet body with a crimson edge. */
  private crescent(owner: number, x: number, y: number, z: number, heading: number, tilt: number, roll: number, scale: number, thickness: number, intensity: number, life: number): void {
    this.warden?.crescents.spawn(owner, this.vfx.time, life, x, y, z, crescentOrientation(this.quat, heading, tilt, roll), scale, thickness, intensity, 0.14, 'umbral', UMBRAL_RIM.hot);
  }

  /** Opens the katana trail window (base→tip sockets) for `ticks` world ticks from now in the umbral palette. */
  private openTrail(kit: UmbralKitId, ticks: number): void {
    const w = this.warden, style = UMBRAL_TRAIL[kit];
    if (!w || !style) return;
    const now = this.vfx.time;
    w.trailFrom = now - 2 / 60; w.trailUntil = now + ticks / 60;
    w.trailElement = 'umbral';
    w.trail.setStyle('umbral', style.intensity, style.life, style.width);
    w.edgePeak = 2.4 + style.intensity * 0.6; w.edgeBoost = 1;
  }

  /** Impact-sink feedback scaled by the kit: shake, target rim flash and screen impulse (the sink honours reduced motion). */
  private feedback(kit: UmbralKitId, targetId: string | undefined, x: number, y: number, z: number, owner: number): void {
    const spec = UMBRAL_IMPACT[kit], impact = this.warden?.impact, hot = PALETTE.umbral.hot;
    if (spec.light > 0) this.vfx.lights.pulse(x, y, z, hot, spec.light, 5 + spec.light, 0.3, this.vfx.time, owner);
    if (!impact) return;
    if (spec.shake > 0) impact.shake(spec.shake, 0.12 + spec.shake * 1.2, 28);
    if (targetId && spec.rim > 0) impact.flashActor(targetId, hot, spec.rim, 0.2, kit === 'umbral-cleanse' ? 'charge' : 'hit');
    if (spec.impulse > 0) impact.impulse?.(spec.impulse, 0.16 + spec.impulse * 0.2);
  }

  private shock(owner: number, x: number, y: number, z: number, radius: number, seconds: number, delay: number): void {
    this.footprint.set('disk', x, y, z, 0, radius, radius);
    this.vfx.ground.spawn('shock', this.footprint, 'umbral', owner, this.vfx.time + delay, seconds, 0.8);
  }

  /** Whole emissions due this frame for a rate per second of world time, carried in `slot.acc[channel]`. */
  private due(slot: KitSlot, channel: 0 | 1 | 2 | 3, rate: number, dt: number): number {
    const amount = slot.acc[channel]! + dt * rate * (this.vfx.reducedEffects ? 0.35 : 1);
    slot.acc[channel] = amount % 1;
    return Math.floor(amount);
  }
}
