import { ConeGeometry, Quaternion, Vector3 } from 'three';
import type { KitSlot } from './ElementKits.js';
import { CRESCENT_CHORD } from './CrescentFx.js';
import { Footprint } from './footprint.js';
import { EMBER_IMPACT, SAKDA_LIMB_MASKS, type EmberKitId } from './HeroKits.js';
import { ContactLedger, crescentOrientation, cutSprite, directedSparks, headingOf, horizontalDirection, laneSparks, starFlash, tintSparks, type Tint } from './hero-fx.js';
import { CrystalSpikesFx } from './InstancedFx.js';
import { EMBER_GOLD, EMBER_RIM, EMBER_SMOKE, PALETTE } from './palette.js';
import { VFX_FRAME } from './VfxAtlas.js';
import { VFX_COLORS, type VfxSystem } from './VfxSystem.js';
import type { WardenFx } from './WardenFx.js';

const UP = new Vector3(0, 1, 0);
const ORANGE: Tint = { hot: PALETTE.ember.hot, body: PALETTE.ember.b };
const GOLD: Tint = EMBER_GOLD;
const RIM: Tint = EMBER_RIM;
/** Elbow hits that precede Hundred Elbows' uppercut (6 elbows), and the world ticks of silence after which a new barrage starts counting from zero. */
const ELBOW_BARRAGE = 6;
const ELBOW_GAP_TICKS = 40;
const TIGER_STRIPES = 4;

/**
 * Sakda (Ember Fist, `ember`) presentation: one kit per skill, resolved from the clip id by `resolveEmberKit`. Fist and foot strikes flare on contact and
 * leave limb trails (the trails themselves are snapshot-driven in `HeroStateFx`, opened here for the strikes the engine sends a cue for); the roundhouse is a
 * fire crescent with an ember ring; Echo Wave a fire-gold sonic blast marking the target with an echo ring; Resonating Strike a dash comet; Hundred Elbows a
 * rapid flare burst ending in an uppercut pillar; Tempest Stomp a ground fire ring with cracks and a cripple-chain decal; Flying Knee an arc trail ending in a
 * meteor-like impact; Guard Dash a flame dash (the flame shield bubble is snapshot-driven); Tiger's Wrath a roundhouse with a tiger-shaped fire flash, a knockback
 * streak and a heavy impact. Everything is pooled and tagged with the cue scope, so cancellation removes it.
 */
export class EmberCues {
  private readonly pillars = new CrystalSpikesFx(32);
  private readonly a = new Vector3();
  private readonly dir = new Vector3();
  private readonly right = new Vector3();
  private readonly quat = new Quaternion();
  private readonly footprint = new Footprint();
  private readonly ledger = new ContactLedger();
  private elbowTick = -Infinity;
  private elbowCount = 0;

  constructor(private readonly vfx: VfxSystem, private readonly warden?: WardenFx) {
    const mesh = this.pillars.mesh;
    mesh.name = 'vfx-ember-pillars';
    // Slim flame spires: dark orange body, the gold fresnel rim carries the glow.
    const geometry = new ConeGeometry(0.5, 1, 6, 3).translate(0, 0.5, 0).toNonIndexed();
    geometry.computeVertexNormals();
    mesh.geometry.dispose();
    mesh.geometry = geometry;
    mesh.material.uniforms.uDeep.value.setRGB(0.2, 0.03, 0);
    mesh.material.uniforms.uMid.value.setRGB(1.1, 0.3, 0.02);
    mesh.material.uniforms.uRim.value.copy(EMBER_GOLD.body);
    mesh.material.uniforms.uRimStrength.value = 0.8;
    mesh.material.uniforms.uOpacity.value = 1;
    vfx.addModule({ group: mesh, update: time => this.pillars.update(time), killOwner: owner => { this.pillars.killOwner(owner); this.ledger.forget(owner); }, clear: () => { this.pillars.clear(); this.ledger.forget(); }, dispose: () => this.pillars.dispose() });
  }

  begin(slot: KitSlot): void {
    const cue = slot.cue, kit = slot.kit as EmberKitId;
    slot.lastTime = this.vfx.time;
    switch (cue.kind) {
      case 'slash': this.slash(slot, kit); return;
      case 'blink': case 'perfect-dodge': this.blink(slot, kit); return;
      case 'beam': this.streak(slot, kit); return;
      case 'tether': this.clinch(slot); return;
      case 'sigil': this.charge(slot, kit); return;
      case 'projectile': this.launch(slot); return;
      case 'projectile-impact': this.echoImpact(slot); return;
      case 'cleanse': this.cleanseBegin(slot); return;
      case 'bloom': case 'root-eruption': this.stomp(slot); return;
      default: this.contact(slot, kit);
    }
  }

  update(slot: KitSlot): void {
    const kit = slot.kit as EmberKitId, vfx = this.vfx, w = this.warden, dt = Math.max(0, vfx.time - slot.lastTime);
    slot.lastTime = vfx.time;
    if (kit === 'ember-cleanse') { this.cleanseUpdate(slot, dt); return; }
    if (!slot.sigil) return;
    const player = w?.player;
    if (slot.tracked && player?.valid && slot.sigil.owner === slot.owner) {
      this.a.set(player.position.x, player.position.y + 0.05, player.position.z);
      w!.sigils.orient(slot.sigil, this.a, UP);
    } else this.a.copy(slot.sigil.center);
    if (slot.cue.phase !== 'sustain' && slot.cue.phase !== 'anticipation') return;
    // Charging: embers are drawn into the fists (elbows) or the knee, and the ring smoulders.
    const n = this.due(slot, 0, kit === 'ember-knee' ? 36 : 28, dt);
    if (n > 0) vfx.gather(this.a.x, this.a.y + (kit === 'ember-knee' ? 0.7 : 1.1), this.a.z, n, 1.2, 'ember', slot.owner);
    const m = this.due(slot, 1, 10, dt);
    if (m > 0) vfx.embers(this.a.x, this.a.y + 0.1, this.a.z, m, 1.1, 1.6, -0.4, slot.owner, 'ember');
  }

  end(slot: KitSlot, natural: boolean): void {
    if (!natural) { this.ledger.forget(slot.owner); this.elbowCount = 0; }
    if (slot.sigil?.owner === slot.owner) this.warden?.sigils.finish(slot.sigil, this.vfx.time, natural ? 0.3 : 0.12);
    slot.sigil = undefined;
    if (!natural && slot.beam?.owner === slot.owner) this.vfx.beams.release(slot.beam);
    slot.beam = undefined;
  }

  // ---- strikes ----

  /**
   * Swing cues. Steps 1–3 open their limb trails and leave a small strike flare; the roundhouse (step 4) and Tiger's Wrath add a fire crescent on the
   * swing path and an ember ring on the ground; Tiger's Wrath also flashes the tiger.
   */
  private slash(slot: KitSlot, kit: EmberKitId): void {
    const w = this.warden, vfx = this.vfx, cue = slot.cue, owner = slot.owner, action = cue.actionId ?? '';
    const at = cue.position ?? w?.player.position;
    if (!at) return;
    const ticks = cue.durationTicks ?? 8, mask = SAKDA_LIMB_MASKS[action] ?? 3;
    w?.hero.openLimbs(mask, vfx.time + (ticks + 4) / 60);
    if (kit === 'ember-tempest') { this.stomp(slot); return; }
    if (kit === 'ember-knee') { this.meteor(owner, at.x, at.y + 0.9, at.z, Math.min(2, Math.max(0.5, cue.intensity ?? 1))); return; }
    const yaw = cue.footprint?.angleRadians ?? (w ? headingOf(w.player.facing.x, w.player.facing.z) : 0), dx = Math.sin(yaw), dz = Math.cos(yaw);
    if (kit === 'ember-roundhouse' || kit === 'ember-wrath') { this.roundhouse(slot, at, yaw, ticks, kit); return; }
    const reach = Math.max(1, cue.footprint?.length ?? 2), y = at.y + (action === 'sakda-limb-3' ? 0.9 : 1.2);
    const x = at.x + dx * reach * 0.7, z = at.z + dz * reach * 0.7;
    // A short flame flick at the strike point, lifted for the rising elbow.
    const rising = action === 'sakda-limb-2';
    if (this.warden) this.warden.crescents.spawn(owner, vfx.time, 0.16, x, y, z, crescentOrientation(this.quat, yaw, rising ? 0.7 : 0.1, rising ? 0.6 : 0), 0.7 / CRESCENT_CHORD * 1.5, 0.45, 1.2, 0.1, 'ember', 'ember');
    directedSparks(vfx, owner, x, y, z, dx, rising ? 0.7 : 0.1, dz, 8, 7, 0.35, ORANGE);
    vfx.embers(x, y, z, 3, 0.2, 1.2, -0.5, owner, 'ember');
    vfx.lights.pulse(x, y, z, PALETTE.ember.hot, EMBER_IMPACT[kit].light, 4, 0.16, vfx.time, owner);
  }

  /** Roundhouse / Tiger's Wrath kick: a big fire crescent, an ember ring, flame licks round the footprint and a ring of sparks. */
  private roundhouse(slot: KitSlot, at: { x: number; y: number; z: number }, yaw: number, ticks: number, kit: EmberKitId): void {
    const vfx = this.vfx, cue = slot.cue, owner = slot.owner, wrath = kit === 'ember-wrath';
    const reach = Math.max(1.6, cue.footprint?.length ?? (wrath ? 3 : 2.6)), life = (ticks + 10) / 60, y = at.y + 1.05;
    const scale = Math.min(5, 2 * reach * Math.sin(1.35)) / CRESCENT_CHORD;
    this.warden?.crescents.spawn(owner, vfx.time, life, at.x + Math.sin(yaw) * reach * 0.82, y, at.z + Math.cos(yaw) * reach * 0.82, crescentOrientation(this.quat, yaw, 0.12, 0), scale, 1, 1.6, 0.14, 'ember', 'ember');
    const ring = wrath ? 3.4 : 3;
    this.shock(owner, at.x, at.y + 0.05, at.z, ring, 0.45, 0);
    this.shock(owner, at.x, at.y + 0.05, at.z, ring * 0.6, 0.35, 0.06);
    this.footprint.set('disk', at.x, at.y, at.z, 0, ring * 0.7, ring * 0.7);
    vfx.ground.spawn('decal', this.footprint, 'ember', owner, vfx.time, 3, 0.9);
    for (let i = vfx.count(10); i > 0; i--) {
      const angle = vfx.random() * Math.PI * 2;
      vfx.flames(at.x + Math.cos(angle) * ring * 0.8, at.y, at.z + Math.sin(angle) * ring * 0.8, 1, 0.2, 0.9, owner, 'ember');
    }
    tintSparks(vfx, owner, at.x, at.y + 0.2, at.z, 22, 6.5, ORANGE, 0.3);
    vfx.flash(at.x, y, at.z, 2, 'ember', owner, 0.2);
    vfx.lights.pulse(at.x, y, at.z, PALETTE.ember.hot, EMBER_IMPACT[kit].light, 6, 0.28, vfx.time, owner);
    if (wrath) this.tiger(owner, at.x + Math.sin(yaw) * 1.2, y + 0.2, at.z + Math.cos(yaw) * 1.2);
  }

  /**
   * The tiger-shaped fire flash of Tiger's Wrath, built from additive sprites that face the camera: a fire head disc, two ear spikes, two slit eyes,
   * fangs, whisker cuts and stripes raking across the face. It lives for a third of a second and is tinted from the ember palette (never white).
   */
  private tiger(owner: number, x: number, y: number, z: number): void {
    const vfx = this.vfx, cam = vfx.cameraPosition;
    this.right.set(cam.z - z, 0, -(cam.x - x));
    if (this.right.lengthSq() < 1e-6) this.right.set(1, 0, 0);
    this.right.normalize();
    const rx = this.right.x, rz = this.right.z, orange = PALETTE.ember.b, hot = PALETTE.ember.hot, rim = EMBER_RIM.body;
    const sprite = (ox: number, oy: number, frame: number, size0: number, size1: number, life: number, color: Tint['hot'], alpha: number, vx = 0, vy = 0): void => {
      const p = vfx.spec();
      p.x = x + rx * ox; p.y = y + oy; p.z = z + rz * ox; p.vx = rx * vx; p.vy = vy; p.vz = rz * vx; p.frame = frame; p.life = life;
      p.size0 = size0; p.size1 = size1; p.r0 = p.r1 = color.r; p.g0 = p.g1 = color.g; p.b0 = p.b1 = color.b; p.a0 = alpha; p.fadeIn = 0.06; p.fadeOut = 0.55;
      if (frame === VFX_FRAME.cut || frame === VFX_FRAME.spark) p.stretch = 0.04;
      vfx.emit(vfx.particles.additive, owner);
    };
    sprite(0, 0, VFX_FRAME.glow, 2.4, 2.9, 0.34, orange, 0.5);
    sprite(-0.85, 0.95, VFX_FRAME.shard, 0.6, 0.7, 0.3, rim, 0.8);
    sprite(0.85, 0.95, VFX_FRAME.shard, 0.6, 0.7, 0.3, rim, 0.8);
    sprite(-0.48, 0.18, VFX_FRAME.star, 0.4, 0.5, 0.34, hot, 0.95);
    sprite(0.48, 0.18, VFX_FRAME.star, 0.4, 0.5, 0.34, hot, 0.95);
    sprite(-0.28, -0.55, VFX_FRAME.shard, 0.34, 0.4, 0.3, hot, 0.8);
    sprite(0.28, -0.55, VFX_FRAME.shard, 0.34, 0.4, 0.3, hot, 0.8);
    for (let i = 0; i < TIGER_STRIPES; i++) {
      const oy = 0.75 - i * 0.34, side = i % 2 ? 1 : -1;
      sprite(side * 0.95, oy, VFX_FRAME.cut, 1.3, 1.6, 0.26, hot, 0.85, side * 0.4, -0.5);
      sprite(side * 0.55, oy - 0.1, VFX_FRAME.cut, 0.9, 1.1, 0.24, rim, 0.8, -side * 0.4, -0.5);
    }
    for (let side = -1; side <= 1; side += 2) { sprite(side * 1.2, -0.15, VFX_FRAME.cut, 1.2, 1.4, 0.24, rim, 0.7, side * 1, 0.1); sprite(side * 1.15, -0.4, VFX_FRAME.cut, 1.2, 1.4, 0.24, rim, 0.7, side * 1, -0.2); }
    vfx.sparks(x, y, z, 18, 6, 'ember', owner, 0.3);
  }

  // ---- blinks (dash skills) ----

  private blink(slot: KitSlot, kit: EmberKitId): void {
    const cue = slot.cue, from = cue.from, to = cue.to;
    if (!from || !to) { this.contact(slot, kit); return; }
    switch (kit) {
      case 'ember-knee': this.flyingKnee(slot, from, to); return;
      case 'ember-wrath': this.comet(slot, from, to, 0.6, 24); return;
      case 'ember-clinch': this.comet(slot, from, to, 0.35, 18); return;
      case 'ember-guard': this.guardDash(slot, from, to); return;
      case 'ember-elbows': this.comet(slot, from, to, 0.4, 16); return;
      default: this.comet(slot, from, to, 0.55, 30);
    }
  }

  /** Dash comet: a thick fire-gold ribbon from the start to the end, dense sparks and flames along it, a flare at both ends (Resonating Strike). */
  private comet(slot: KitSlot, from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, width: number, sparks: number): void {
    const vfx = this.vfx, owner = slot.owner, kit = slot.kit as EmberKitId, life = Math.max(0.1, (slot.cue.durationTicks ?? 14) / 60);
    slot.beam = vfx.beams.acquire(owner, vfx.time, life + 0.12, width, 0.04, 'ember');
    if (slot.beam) { slot.beam.a.set(from.x, from.y + 1, from.z); slot.beam.b.set(to.x, to.y + 1, to.z); }
    this.warden?.hero.openLimbs(SAKDA_LIMB_MASKS[slot.cue.actionId ?? ''] ?? 10, vfx.time + life);
    laneSparks(vfx, owner, from.x, from.y + 1, from.z, to.x, to.y + 1, to.z, sparks, 0.2, GOLD);
    laneSparks(vfx, owner, from.x, from.y + 0.9, from.z, to.x, to.y + 0.9, to.z, Math.round(sparks * 0.6), 0.3, ORANGE);
    for (let i = 0; i < 5; i++) {
      const t = (i + 0.5) / 5;
      vfx.flames(from.x + (to.x - from.x) * t, from.y + 0.7, from.z + (to.z - from.z) * t, 1, 0.2, 0.7, owner, 'ember');
    }
    vfx.flash(from.x, from.y + 1, from.z, 1.6, 'ember', owner, 0.18);
    vfx.flash(to.x, to.y + 1, to.z, 2, 'ember', owner, 0.2);
    tintSparks(vfx, owner, to.x, to.y + 1, to.z, 14, 6, GOLD, 0.3);
    vfx.lights.pulse(to.x, to.y + 1, to.z, PALETTE.ember.hot, EMBER_IMPACT[kit].light, 6, 0.28, vfx.time, owner);
    this.feedback(kit, undefined, to.x, to.y + 1, to.z, owner);
  }

  /** Guard Dash: a low flame dash with a flare burst at the start (the flame shield bubble follows the snapshot). */
  private guardDash(slot: KitSlot, from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): void {
    const vfx = this.vfx, owner = slot.owner;
    laneSparks(vfx, owner, from.x, from.y + 0.8, from.z, to.x, to.y + 0.8, to.z, 18, 0.25, ORANGE);
    for (let i = 0; i < 4; i++) {
      const t = (i + 0.5) / 4;
      vfx.flames(from.x + (to.x - from.x) * t, from.y + 0.4, from.z + (to.z - from.z) * t, 1, 0.25, 0.7, owner, 'ember');
    }
    vfx.flash(from.x, from.y + 0.9, from.z, 1.5, 'ember', owner, 0.2);
    vfx.dustRing(from.x, from.y, from.z, 0.8, 8, owner, VFX_COLORS.dust);
    tintSparks(vfx, owner, from.x, from.y + 0.9, from.z, 12, 4, GOLD, 0.3);
    vfx.flash(to.x, to.y + 0.9, to.z, 1.2, 'ember', owner, 0.16);
    vfx.lights.pulse(from.x, from.y + 1, from.z, PALETTE.ember.hot, EMBER_IMPACT['ember-guard'].light, 5, 0.3, vfx.time, owner);
  }

  /** Flying Knee leap: sparks and flames trace the airborne arc, a streak leaves the launch point (the meteor impact is the hit cue). */
  private flyingKnee(slot: KitSlot, from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): void {
    const vfx = this.vfx, owner = slot.owner, rise = Math.min(2.4, 0.6 + Math.hypot(to.x - from.x, to.z - from.z) * 0.18);
    this.warden?.hero.openLimbs(SAKDA_LIMB_MASKS['sakda-flying-knee']!, vfx.time + Math.max(0.1, (slot.cue.durationTicks ?? 26) / 60));
    const steps = vfx.reducedEffects ? 6 : 14;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, x = from.x + (to.x - from.x) * t, z = from.z + (to.z - from.z) * t, y = from.y + (to.y - from.y) * t + 4 * rise * t * (1 - t) + 0.9;
      tintSparks(vfx, owner, x, y, z, 2, 2.4, i % 2 ? GOLD : ORANGE, 0.1);
      if (i % 3 === 0) vfx.flames(x, y - 0.2, z, 1, 0.15, 0.6, owner, 'ember');
    }
    vfx.flash(from.x, from.y + 0.6, from.z, 1.8, 'ember', owner, 0.2);
    vfx.dustRing(from.x, from.y, from.z, 1, 10, owner, VFX_COLORS.dust);
    this.shock(owner, from.x, from.y + 0.05, from.z, 1.4, 0.35, 0);
  }

  /** Beam cues: the knockback streak of Tiger's Wrath and the Resonating Strike lane. */
  private streak(slot: KitSlot, kit: EmberKitId): void {
    const cue = slot.cue, from = cue.from ?? cue.position, to = cue.to ?? cue.position;
    if (!from || !to) return;
    this.comet(slot, from, to, kit === 'ember-wrath' ? 0.8 : 0.5, kit === 'ember-wrath' ? 30 : 22);
  }

  // ---- charge sigils (Hundred Elbows, Flying Knee) ----

  private charge(slot: KitSlot, kit: EmberKitId): void {
    const w = this.warden, vfx = this.vfx, cue = slot.cue, owner = slot.owner, point = cue.position ?? cue.from ?? w?.player.position;
    if (!point) return;
    this.a.set(point.x, point.y + 0.05, point.z);
    const knee = kit === 'ember-knee';
    slot.sigil = w?.sigils.spawn(owner, 'ground', vfx.time, this.a, UP, knee ? 1.6 : 1.4, cue.phase === 'sustain' ? Infinity : Math.max(1 / 60, (cue.durationTicks ?? 24) / 60), 1, 'ember');
    slot.tracked = true;
    slot.acc.fill(0);
    vfx.flash(point.x, point.y + 0.5, point.z, 1, 'ember', owner, 0.14);
    vfx.lights.pulse(point.x, point.y + 0.6, point.z, PALETTE.ember.hot, EMBER_IMPACT[kit].light, 5, 0.3, vfx.time, owner);
    vfx.flames(point.x, point.y, point.z, 6, 0.9, 0.9, owner, 'ember');
  }

  // ---- Echo Wave ----

  private launch(slot: KitSlot): void {
    const vfx = this.vfx, cue = slot.cue, owner = slot.owner, from = cue.from ?? cue.position, w = this.warden;
    if (!from) return;
    horizontalDirection(from.x, from.z, cue.to?.x ?? from.x, cue.to?.z ?? from.z, w?.player.facing.x ?? 0, w?.player.facing.z ?? 1, this.dir);
    w?.hero.openLimbs(3, vfx.time + 0.2);
    vfx.flash(from.x, from.y, from.z, 1.8, 'ember', owner, 0.2);
    directedSparks(vfx, owner, from.x, from.y, from.z, this.dir.x, 0.05, this.dir.z, 16, 9, 0.3, GOLD);
    // Three expanding sonic rings stacked along the throw direction.
    for (let i = 0; i < 3; i++) this.ring(owner, from.x + this.dir.x * (0.3 + i * 0.35), from.y, from.z + this.dir.z * (0.3 + i * 0.35), 0.5 + i * 0.3, 1.3 + i * 0.4, 0.22 + i * 0.03, GOLD, 0.8 - i * 0.2);
    vfx.lights.pulse(from.x, from.y, from.z, PALETTE.ember.hot, EMBER_IMPACT['ember-echo'].light, 5, 0.22, vfx.time, owner);
  }

  /** Echo Wave hit: the target is marked with a gold echo ring (rings that keep pulsing outward) and a burst of gold sparks. */
  private echoImpact(slot: KitSlot): void {
    const cue = slot.cue, w = this.warden, vfx = this.vfx, owner = slot.owner, at = cue.position;
    if (!at) return;
    const visual = cue.scopeId ? w?.combat.findProjectile(cue.scopeId) : undefined;
    if (visual) w!.combat.endProjectile(visual);
    this.ledger.record(cue.worldTick, cue.actionId ?? '', owner, at.x, at.z, cue.targetId ?? '');
    starFlash(vfx, owner, at.x, at.y, at.z, 1.3, 0.18, GOLD);
    vfx.flash(at.x, at.y, at.z, 1.8, 'ember', owner, 0.2);
    tintSparks(vfx, owner, at.x, at.y, at.z, 18, 6, GOLD, 0.3);
    for (let i = 0; i < 3; i++) this.ring(owner, at.x, at.y, at.z, 0.3, 1.5 + i * 0.5, 0.32 + i * 0.1, i === 1 ? ORANGE : GOLD, 0.9);
    this.shock(owner, at.x, at.y - 0.9, at.z, 1.3, 0.4, 0);
    this.feedback('ember-echo', cue.targetId, at.x, at.y, at.z, owner);
  }

  // ---- Iron Clinch / cleanse ----

  /** Iron Clinch: a flaming chain pulls Sakda to the winding-up foe; the interrupt bursts in gold and embers. */
  private clinch(slot: KitSlot): void {
    const cue = slot.cue, vfx = this.vfx, owner = slot.owner, to = cue.to ?? cue.position, from = cue.from ?? this.warden?.player.position;
    if (!to) return;
    this.warden?.hero.openLimbs(3, vfx.time + 0.3);
    if (from) {
      slot.beam = vfx.beams.acquire(owner, vfx.time, 0.3, 0.14, 0.05, 'ember');
      if (slot.beam) { slot.beam.a.set(from.x, from.y + 1.1, from.z); slot.beam.b.set(to.x, to.y + 1, to.z); }
      laneSparks(vfx, owner, from.x, from.y + 1.1, from.z, to.x, to.y + 1, to.z, 16, 0.12, GOLD);
    }
    starFlash(vfx, owner, to.x, to.y + 1, to.z, 1.6, 0.2, GOLD);
    vfx.flash(to.x, to.y + 1, to.z, 2, 'ember', owner, 0.2);
    tintSparks(vfx, owner, to.x, to.y + 1, to.z, 22, 6, ORANGE, 0.2);
    vfx.embers(to.x, to.y + 0.8, to.z, 8, 0.5, 1.6, -0.5, owner, 'ember');
    this.shock(owner, to.x, to.y + 0.05, to.z, 1.5, 0.4, 0);
    this.feedback('ember-clinch', cue.targetId, to.x, to.y + 1, to.z, owner);
  }

  private cleanseBegin(slot: KitSlot): void {
    const w = this.warden, vfx = this.vfx, owner = slot.owner, at = slot.cue.position ?? w?.player.position;
    if (!at) return;
    slot.origin.set(at.x, at.y + 0.05, at.z);
    slot.sigil = w?.sigils.spawn(owner, 'ground', vfx.time, slot.origin, UP, 1.5, 0.8, 1, 'ember');
    slot.tracked = false;
    slot.acc.fill(0);
    vfx.flash(at.x, at.y + 0.5, at.z, 1.1, 'ember', owner, 0.2);
    vfx.lights.pulse(at.x, at.y + 1, at.z, PALETTE.ember.hot, EMBER_IMPACT['ember-cleanse'].light, 5, 0.5, vfx.time, owner);
    if (slot.cue.targetId) w?.impact?.flashActor(slot.cue.targetId, PALETTE.ember.b, 0.8, 0.5, 'charge');
  }

  /** The ring rises in a column of climbing embers and gold motes. */
  private cleanseUpdate(slot: KitSlot, dt: number): void {
    const vfx = this.vfx, ring = slot.sigil;
    if (!ring || ring.owner !== slot.owner) return;
    const age = Math.max(0, vfx.time - slot.cue.worldTimeSeconds), t = Math.min(1, age / 0.8), lift = 1.6 * (1 - (1 - t) * (1 - t));
    this.warden!.sigils.orient(ring, this.a.set(slot.origin.x, slot.origin.y + lift, slot.origin.z), UP);
    const n = this.due(slot, 0, 32, dt);
    if (n > 0) vfx.embers(slot.origin.x, slot.origin.y + lift, slot.origin.z, n, 1.2 * (1 - 0.3 * t), 1.8, -0.6, slot.owner, 'ember');
    const m = this.due(slot, 1, 8, dt);
    if (m > 0) tintSparks(vfx, slot.owner, slot.origin.x, slot.origin.y + lift, slot.origin.z, m, 1.4, GOLD, 0.6);
  }

  // ---- Tempest Stomp ----

  /**
   * Area cues of the stomp: a ground fire ring of the footprint radius with glowing fracture cracks, geysers of flame at the rim, and a cripple-chain decal
   * (two concentric rings of chain links) that stays on the ground while the slow lasts.
   */
  private stomp(slot: KitSlot): void {
    const cue = slot.cue, vfx = this.vfx, owner = slot.owner, at = cue.position ?? this.warden?.player.position;
    if (!at) return;
    const radius = Math.max(1.5, (cue.footprint?.width ?? 8) / 2);
    this.warden?.hero.openLimbs(SAKDA_LIMB_MASKS['sakda-tempest']!, vfx.time + 0.3);
    this.shock(owner, at.x, at.y + 0.05, at.z, radius, 0.55, 0);
    this.shock(owner, at.x, at.y + 0.05, at.z, radius * 0.55, 0.4, 0.08);
    this.footprint.set('disk', at.x, at.y, at.z, 0, radius * 0.9, radius * 0.9);
    vfx.ground.spawn('decal', this.footprint, 'ember', owner, vfx.time, 4.5, 1);
    vfx.dustRing(at.x, at.y, at.z, radius * 0.7, 20, owner);
    vfx.flash(at.x, at.y + 0.4, at.z, Math.min(4, radius), 'ember', owner, 0.24);
    tintSparks(vfx, owner, at.x, at.y + 0.2, at.z, 30, 7, ORANGE, 0.4);
    const count = vfx.reducedEffects ? 4 : 10, start = vfx.random() * Math.PI * 2;
    for (let i = 0; i < count; i++) {
      const angle = start + (i / count) * Math.PI * 2;
      this.pillars.spawn(at.x + Math.cos(angle) * radius * 0.85, at.y, at.z + Math.sin(angle) * radius * 0.85, vfx.range(0.7, 1.4), vfx.range(0.12, 0.2), -Math.cos(angle) * 0.2, -Math.sin(angle) * 0.2, vfx.time + i * 0.015, 0.7, owner);
      vfx.flames(at.x + Math.cos(angle) * radius * 0.85, at.y, at.z + Math.sin(angle) * radius * 0.85, 1, 0.2, 0.9, owner, 'ember');
    }
    // Cripple-chain decal: chain links (ring sprites) laid in two concentric circles that linger and slowly settle.
    for (let ringIndex = 0; ringIndex < 2; ringIndex++) {
      const links = vfx.count(ringIndex ? 8 : 12), r = radius * (ringIndex ? 0.45 : 0.78);
      for (let i = 0; i < links; i++) {
        const angle = (i / links) * Math.PI * 2 + ringIndex * 0.3, p = vfx.spec();
        p.x = at.x + Math.cos(angle) * r; p.y = at.y + 0.12; p.z = at.z + Math.sin(angle) * r;
        p.vx = -Math.sin(angle) * 0.25; p.vz = Math.cos(angle) * 0.25; p.drag = 0.5; p.frame = VFX_FRAME.ring; p.life = 1.8; p.size0 = 0.28; p.size1 = 0.2;
        p.r0 = p.r1 = RIM.body.r; p.g0 = p.g1 = RIM.body.g; p.b0 = p.b1 = RIM.body.b; p.a0 = 0.8; p.fadeIn = 0.05; p.fadeOut = 0.7;
        vfx.emit(vfx.particles.additive, owner);
      }
    }
    vfx.lights.pulse(at.x, at.y + 0.6, at.z, PALETTE.ember.hot, EMBER_IMPACT['ember-tempest'].light, 8, 0.4, vfx.time, owner);
    this.feedback('ember-tempest', undefined, at.x, at.y + 0.6, at.z, owner);
  }

  // ---- contact (hit cues) ----

  /** Contact accent of a Sakda strike; each kit has its own look. A point impact already drawn this tick (echo wave) adds only the target rim flash. */
  private contact(slot: KitSlot, kit: EmberKitId): void {
    const cue = slot.cue, vfx = this.vfx, owner = slot.owner, at = cue.position ?? cue.to ?? cue.from, w = this.warden;
    if (!at) return;
    const action = cue.actionId ?? '';
    if (this.ledger.claim(cue.worldTick, action, at.x, at.z, cue.targetId ?? '')) {
      if (cue.targetId) w?.impact?.flashActor(cue.targetId, PALETTE.ember.hot, 1, 0.2, 'hit');
      return;
    }
    const intensity = Math.min(2, Math.max(0.5, cue.intensity ?? 1));
    if (cue.to) this.dir.set(cue.to.x - at.x, 0, cue.to.z - at.z); else this.dir.set(w?.player.facing.x ?? 0, 0, w?.player.facing.z ?? 1);
    if (this.dir.lengthSq() < 1e-8) this.dir.set(w?.player.facing.x ?? 0, 0, w?.player.facing.z ?? 1);
    this.dir.normalize();
    const dx = this.dir.x, dz = this.dir.z;
    switch (kit) {
      case 'ember-roundhouse':
        starFlash(vfx, owner, at.x, at.y, at.z, 2, 0.2, GOLD);
        vfx.flash(at.x, at.y, at.z, 2.2, 'ember', owner, 0.22);
        directedSparks(vfx, owner, at.x, at.y, at.z, dx, 0.2, dz, 20, 10, 0.4, ORANGE);
        vfx.flames(at.x, at.y - 0.4, at.z, 4, 0.3, 1, owner, 'ember');
        this.shock(owner, at.x, at.y - 0.9, at.z, 1.5, 0.4, 0);
        break;
      case 'ember-wrath':
        // Heavy kick: a fire burst with a knockback streak behind the target and a wide ground blast.
        starFlash(vfx, owner, at.x, at.y, at.z, 3, 0.26, GOLD);
        vfx.flash(at.x, at.y, at.z, 3.2, 'ember', owner, 0.28);
        directedSparks(vfx, owner, at.x, at.y, at.z, dx, 0.15, dz, 30, 13, 0.3, GOLD);
        vfx.flames(at.x, at.y - 0.4, at.z, 6, 0.4, 1.3, owner, 'ember');
        vfx.dustRing(at.x, at.y - 0.9, at.z, 1.8, 18, owner);
        this.shock(owner, at.x, at.y - 0.9, at.z, 2.4, 0.5, 0);
        cutSprite(vfx, owner, at.x, at.y, at.z, dx, 0.05, dz, 3.4, 0.22, GOLD);
        break;
      case 'ember-resonate':
        // The echo mark is consumed: gold motes collapse into the target and burst out as a ring.
        vfx.gather(at.x, at.y, at.z, 24, 1.4, 'ember', owner);
        starFlash(vfx, owner, at.x, at.y, at.z, 2.2, 0.22, GOLD);
        vfx.flash(at.x, at.y, at.z, 2.6, 'ember', owner, 0.24);
        for (let i = 0; i < 3; i++) this.ring(owner, at.x, at.y, at.z, 0.3, 1.8 + i * 0.5, 0.3 + i * 0.08, GOLD, 0.9);
        tintSparks(vfx, owner, at.x, at.y, at.z, 26, 8, GOLD, 0.3);
        this.shock(owner, at.x, at.y - 0.9, at.z, 1.8, 0.45, 0);
        break;
      case 'ember-elbows': this.elbowHit(slot, at, dx, dz); return;
      case 'ember-tempest':
        vfx.flash(at.x, at.y, at.z, 1.8, 'ember', owner, 0.2);
        tintSparks(vfx, owner, at.x, at.y, at.z, 14, 5, ORANGE, 0.3);
        for (let i = 0; i < 4; i++) this.chain(owner, at.x, at.y - 0.6, at.z, i);
        break;
      case 'ember-knee':
        // The meteor itself is the impact ring's slash cue; each struck target gets a hard flare.
        starFlash(vfx, owner, at.x, at.y, at.z, 1.8, 0.2, GOLD);
        directedSparks(vfx, owner, at.x, at.y, at.z, dx, 0.3, dz, 14, 9, 0.4, ORANGE);
        vfx.flames(at.x, at.y - 0.4, at.z, 3, 0.3, 0.9, owner, 'ember');
        break;
      case 'ember-clinch':
        starFlash(vfx, owner, at.x, at.y, at.z, 1.4, 0.18, GOLD);
        tintSparks(vfx, owner, at.x, at.y, at.z, 16, 6, ORANGE, 0.3);
        break;
      default: this.limbHit(owner, action, at, dx, dz, intensity); break;
    }
    this.feedback(kit, cue.targetId, at.x, at.y, at.z, owner);
  }

  /** Steps 1–3: jab/cross (small gold flare), rising elbow (sparks thrown up), clinch knee (round flare, ember burst and a puff of dust). */
  private limbHit(owner: number, action: string, at: { x: number; y: number; z: number }, dx: number, dz: number, intensity: number): void {
    const vfx = this.vfx;
    if (action === 'sakda-limb-2') {
      directedSparks(vfx, owner, at.x, at.y, at.z, dx * 0.4, 1, dz * 0.4, 14, 8, 0.3, ORANGE);
      vfx.embers(at.x, at.y, at.z, 5, 0.25, 1.8, -0.6, owner, 'ember');
      starFlash(vfx, owner, at.x, at.y, at.z, 0.9 + 0.3 * intensity, 0.14, GOLD);
    } else if (action === 'sakda-limb-3') {
      vfx.flash(at.x, at.y, at.z, 1.5 + 0.3 * intensity, 'ember', owner, 0.18);
      tintSparks(vfx, owner, at.x, at.y, at.z, 16, 6, ORANGE, 0.3);
      vfx.dustRing(at.x, at.y - 0.9, at.z, 0.7, 8, owner);
      this.shock(owner, at.x, at.y - 0.9, at.z, 1, 0.35, 0);
    } else {
      starFlash(vfx, owner, at.x, at.y, at.z, 0.8 + 0.3 * intensity, 0.13, GOLD);
      directedSparks(vfx, owner, at.x, at.y, at.z, dx, 0.1, dz, 10, 8, 0.35, ORANGE);
      vfx.flash(at.x, at.y, at.z, 1, 'ember', owner, 0.14);
    }
  }

  /**
   * One of the Hundred Elbows hits: a tiny flare at a jittered point on the target; the barrage counts hits and the closing uppercut raises a flame pillar
   * with a burst of embers thrown up and a bright flare. The count resets after `ELBOW_GAP_TICKS` of silence or when a barrage is cancelled.
   */
  private elbowHit(slot: KitSlot, at: { x: number; y: number; z: number }, dx: number, dz: number): void {
    const cue = slot.cue, vfx = this.vfx, owner = slot.owner;
    if (cue.worldTick - this.elbowTick > ELBOW_GAP_TICKS) this.elbowCount = 0;
    this.elbowTick = cue.worldTick;
    this.elbowCount++;
    const upper = this.elbowCount > ELBOW_BARRAGE || (cue.intensity ?? 1) >= 1.3;
    if (upper) {
      this.elbowCount = 0;
      this.pillar(owner, at.x, at.y - 0.9, at.z);
    } else {
      const jx = vfx.range(-0.35, 0.35), jy = vfx.range(-0.3, 0.4), jz = vfx.range(-0.35, 0.35);
      starFlash(vfx, owner, at.x + jx, at.y + jy, at.z + jz, 0.7, 0.1, GOLD);
      directedSparks(vfx, owner, at.x + jx, at.y + jy, at.z + jz, dx, 0.2, dz, 6, 7, 0.5, ORANGE);
    }
    this.feedback('ember-elbows', cue.targetId, at.x, at.y, at.z, owner);
  }

  /** The uppercut pillar: a column of flame spires and flames rising from the target, a gold flash at the top and an ember fountain. */
  private pillar(owner: number, x: number, ground: number, z: number): void {
    const vfx = this.vfx;
    this.pillars.spawn(x, ground, z, 3.2, 0.34, 0, 0, vfx.time, 0.8, owner);
    this.pillars.spawn(x + 0.25, ground, z, 2.2, 0.2, 0.15, 0, vfx.time + 0.02, 0.7, owner);
    this.pillars.spawn(x - 0.25, ground, z + 0.1, 2.4, 0.2, -0.15, 0, vfx.time + 0.03, 0.7, owner);
    vfx.flames(x, ground, z, 14, 0.35, 2.4, owner, 'ember');
    starFlash(vfx, owner, x, ground + 2.4, z, 2.6, 0.24, GOLD);
    vfx.flash(x, ground + 1.2, z, 2.6, 'ember', owner, 0.26);
    vfx.embers(x, ground + 0.4, z, 24, 0.5, 4, -1.2, owner, 'ember');
    tintSparks(vfx, owner, x, ground + 1.2, z, 28, 8, GOLD, 0.8);
    this.shock(owner, x, ground + 0.05, z, 1.8, 0.45, 0);
    vfx.lights.pulse(x, ground + 1.4, z, PALETTE.ember.hot, EMBER_IMPACT['ember-elbows'].light + 2, 7, 0.35, vfx.time, owner);
    this.warden?.impact?.shake(0.1, 0.22, 26);
  }

  /** Flying Knee impact: a meteor strike with a fireball, a flame column, a shock ring pair, rubble and radial embers. */
  private meteor(owner: number, x: number, y: number, z: number, intensity: number): void {
    const vfx = this.vfx, ground = y - 0.9, scale = 0.8 + 0.2 * intensity;
    starFlash(vfx, owner, x, y, z, 3 * scale, 0.26, GOLD);
    vfx.flash(x, y, z, 3.4 * scale, 'ember', owner, 0.3);
    vfx.glow(x, y + 0.2, z, 2.6 * scale, 0.4, 'ember', 0.6, owner, 0.6);
    vfx.flames(x, ground, z, 12, 0.7, 1.8 * scale, owner, 'ember');
    vfx.smoke(x, ground + 0.3, z, 8, 1, 1, 1.4, 1.2, EMBER_SMOKE, 0.5, owner, 1.4);
    this.shock(owner, x, ground + 0.05, z, 3, 0.55, 0);
    this.shock(owner, x, ground + 0.05, z, 1.6, 0.4, 0.08);
    this.footprint.set('disk', x, ground, z, 0, 1.6, 1.6);
    vfx.ground.spawn('decal', this.footprint, 'ember', owner, vfx.time, 4, 1);
    vfx.dustRing(x, ground, z, 2, 22, owner);
    vfx.chunks(x, ground + 0.05, z, 10, 5, 0.18, owner, false, this.footprint);
    vfx.embers(x, ground + 0.3, z, 30, 1.6, 3.4, 1.2, owner, 'ember');
    tintSparks(vfx, owner, x, y, z, 34, 9, ORANGE, 0.2);
    const count = vfx.reducedEffects ? 3 : 7, start = vfx.random() * Math.PI * 2;
    for (let i = 0; i < count; i++) {
      const angle = start + (i / count) * Math.PI * 2;
      this.pillars.spawn(x + Math.cos(angle) * 1.2, ground, z + Math.sin(angle) * 1.2, vfx.range(0.9, 1.7), vfx.range(0.1, 0.18), -Math.cos(angle) * 0.3, -Math.sin(angle) * 0.3, vfx.time + i * 0.015, 0.65, owner);
    }
    vfx.lights.pulse(x, y, z, PALETTE.ember.hot, EMBER_IMPACT['ember-knee'].light, 9, 0.4, vfx.time, owner);
  }

  // ---- shared pieces ----

  /** One flat-looking sonic ring (an additive ring sprite) at (x, y, z) that grows from `size0` to `size1`. */
  private ring(owner: number, x: number, y: number, z: number, size0: number, size1: number, life: number, tint: Tint, alpha: number): void {
    const vfx = this.vfx, p = vfx.spec();
    p.x = x; p.y = y; p.z = z; p.frame = VFX_FRAME.ring; p.life = life; p.size0 = size0; p.size1 = size1;
    p.r0 = p.r1 = tint.hot.r; p.g0 = p.g1 = tint.hot.g; p.b0 = p.b1 = tint.hot.b; p.a0 = alpha; p.fadeIn = 0.05; p.fadeOut = 0.6;
    vfx.emit(vfx.particles.additive, owner);
  }

  /** A short broken chain link flying off the target (cripple). */
  private chain(owner: number, x: number, y: number, z: number, index: number): void {
    const vfx = this.vfx, p = vfx.spec(), angle = index * 1.6 + vfx.random();
    p.x = x; p.y = y + 0.4; p.z = z; p.vx = Math.cos(angle) * 1.6; p.vy = vfx.range(1, 2); p.vz = Math.sin(angle) * 1.6; p.gravity = 7; p.drag = 0.5;
    p.frame = VFX_FRAME.ring; p.life = vfx.range(0.5, 0.8); p.size0 = 0.2; p.size1 = 0.14; p.spin = vfx.random() * 6; p.spinRate = vfx.range(-6, 6);
    p.r0 = p.r1 = EMBER_RIM.body.r; p.g0 = p.g1 = EMBER_RIM.body.g; p.b0 = p.b1 = EMBER_RIM.body.b; p.a0 = 0.9; p.fadeOut = 0.6;
    vfx.emit(vfx.particles.additive, owner);
  }

  /** Impact-sink feedback scaled by the kit: shake, target rim flash and screen impulse (the sink honours reduced motion). */
  private feedback(kit: EmberKitId, targetId: string | undefined, x: number, y: number, z: number, owner: number): void {
    const spec = EMBER_IMPACT[kit], impact = this.warden?.impact, hot = PALETTE.ember.hot;
    if (spec.light > 0) this.vfx.lights.pulse(x, y, z, hot, spec.light, 5 + spec.light, 0.3, this.vfx.time, owner);
    if (!impact) return;
    if (spec.shake > 0) impact.shake(spec.shake, 0.12 + spec.shake * 1.2, 28);
    if (targetId && spec.rim > 0) impact.flashActor(targetId, hot, spec.rim, 0.2, kit === 'ember-cleanse' ? 'charge' : 'hit');
    if (spec.impulse > 0) impact.impulse?.(spec.impulse, 0.16 + spec.impulse * 0.2);
  }

  private shock(owner: number, x: number, y: number, z: number, radius: number, seconds: number, delay: number): void {
    this.footprint.set('disk', x, y, z, 0, radius, radius);
    this.vfx.ground.spawn('shock', this.footprint, 'ember', owner, this.vfx.time + delay, seconds, 0.8);
  }

  /** Whole emissions due this frame for a rate per second of world time, carried in `slot.acc[channel]`. */
  private due(slot: KitSlot, channel: 0 | 1 | 2 | 3, rate: number, dt: number): number {
    const amount = slot.acc[channel]! + dt * rate * (this.vfx.reducedEffects ? 0.35 : 1);
    slot.acc[channel] = amount % 1;
    return Math.floor(amount);
  }
}
