import { Matrix4, Mesh, Quaternion, Vector3, type Material } from 'three';
import type { ActorSnapshot, CombatSnapshot, JudgementMarkSnapshot, PlayerProjectileSnapshot } from '../../game/contracts.js';
import { TARGETED_STRIKES, THUNDER_CLEAVE } from '../../game/combat/PlayerSkills.js';
import { CRESCENT_CHORD } from './CrescentFx.js';
import { Footprint } from './footprint.js';
import { PALETTE, type VfxElement } from './palette.js';
import { jaggedPath } from './LightningGen.js';
import { VFX_FRAME } from './VfxAtlas.js';
import { VFX_COLORS } from './VfxSystem.js';
import { ARC_LEVELS, BOLT_BRANCH_LEVELS, BOLT_TRUNK_LEVELS, MAX_ARCS, THUNDER_SECONDS, WARDEN_OWNER, type ProjectileVisual, type WardenFx } from './WardenFx.js';

/** Monsters whose corruption burns away when Aren cleanses them (hostile → not hostile). */
const CLEANSE_ACTORS: Readonly<Record<string, true>> = { 'corrupted-boar': true, 'greenwake-sap-stalker': true, 'greenwake-root-rammer': true };
const IDLE_EDGE = 0.6;
const REDUCED_EDGE_MAX = 1.5;
const WAVE_SCAR_STEP = 2.2;
const SPIRAL_POINTS = 24;
const SPIRAL_LENGTH = 2.4;
const UP = new Vector3(0, 1, 0);
/** Glaive lightning crackle: path subdivision (9 points) and the Aren swings that carry it (combo lights, heavy, Thunder Cleave). */
const CRACKLE_LEVELS = 3;
const CRACKLE_STRANDS = 3;
const CLEAVE = TARGETED_STRIKES.charged_heavy;
const CLEAVE_TOTAL = CLEAVE.ticks + CLEAVE.recoveryTicks;
const CLEAVE_TRAIL_FROM = (CLEAVE.activeAt - 10) / CLEAVE_TOTAL;
const CLEAVE_CONTACT = CLEAVE.activeAt / CLEAVE_TOTAL;
const CRACKLE_ACTIONS = /^aren-(light-\d|heavy|charged-heavy)/;
const MOTE = { r: 0.8, g: 0.72, b: 0.5 };
const FLECK = { r: 0.3, g: 0.46, b: 0.16 };
/** Aren's action while Heavy is held; the release becomes a Thunder Cleave after `THUNDER_CLEAVE.holdTicks`. */
const HEAVY_CHARGE_ACTION = 'aren-charged-heavy-charge';

type EdgeMaterial = Material & { emissiveIntensity: number };

/** Snapshot-driven Warden presentation: blade sampling, projectiles, marks, bolts, arcs, the cleansed finish and ambient motes. */
export class WardenCombat {
  private lastTime = 0;
  private readonly allegiance = new Map<string, string>();
  private readonly hitReact = new Map<string, number>();
  private readonly positions = new Map<string, Vector3>();
  private readonly edgeMaterials: EdgeMaterial[] = [];
  private edgeRoot: unknown;
  private moteAcc = 0;
  private fleckAcc = 0;
  private streakAcc = 0;
  /** Simulation tick the current Heavy hold was first seen (-1 while not charging), and whether the ready burst fired. */
  private chargeStart = -1;
  private chargeReady = false;
  private chargeAcc = 0;
  private chargeArcAcc = 0;
  private readonly base = new Vector3();
  private readonly tip = new Vector3();
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly c = new Vector3();
  private readonly e1 = new Vector3();
  private readonly e2 = new Vector3();
  private readonly quat = new Quaternion();
  private readonly basis = new Matrix4();
  private readonly footprint = new Footprint();
  private readonly spiral = new Float32Array(SPIRAL_POINTS * 3);
  private readonly crackles = Array.from({ length: CRACKLE_STRANDS }, () => new Float32Array(((1 << CRACKLE_LEVELS) + 1) * 3));
  private readonly crackleAlpha = new Float32Array(CRACKLE_STRANDS);
  private lastCrackleTime = -Infinity;
  private cleaveWindupTrail = false;
  private readonly random = (): number => this.w.vfx.random();

  constructor(private readonly w: WardenFx) {}

  reset(): void {
    this.allegiance.clear(); this.hitReact.clear(); this.positions.clear();
    this.edgeMaterials.length = 0; this.edgeRoot = undefined;
    this.moteAcc = this.fleckAcc = this.streakAcc = 0;
    this.chargeStart = -1; this.chargeReady = false; this.chargeAcc = this.chargeArcAcc = 0;
    this.lastCrackleTime = -Infinity; this.cleaveWindupTrail = false;
    this.w.player.valid = false;
  }

  /** One rendered frame of the snapshot-driven effects; `alpha` interpolates projectile positions between sim ticks. */
  update(snapshot: CombatSnapshot, alpha: number): void {
    const w = this.w, vfx = w.vfx, time = vfx.time, dt = Math.max(0, Math.min(0.1, time - this.lastTime));
    this.lastTime = time;
    w.frame++;
    w.player.hero = snapshot.player?.heroId ?? 'aren';
    this.syncActors(snapshot.actors, time);
    w.lines.begin(vfx.cameraPosition); w.sprites.begin();
    this.chargeUp(snapshot.worldClock.simulationTick, dt);
    this.driveBlade(time, dt);
    this.updateProjectiles(snapshot.playerProjectiles, Math.min(1, Math.max(0, alpha)), time, dt);
    this.updateMarks(snapshot.judgementMarks, snapshot.worldClock.simulationTick, time);
    w.hero.update(snapshot, time, dt);
    this.drawBolts(time);
    this.drawArcs(time);
    w.dissolve.update(time);
    this.ambient(dt);
    w.lines.end(); w.sprites.end();
    w.update(time);
  }

  // ---- actors ----

  private syncActors(actors: readonly ActorSnapshot[], time: number): void {
    const w = this.w, player = w.player;
    let aren: ActorSnapshot | undefined;
    for (const actor of actors) {
      if (actor.id === 'aren' || (!aren && actor.allegiance === 'player')) aren = actor;
      let position = this.positions.get(actor.id);
      if (!position) { position = new Vector3(); this.positions.set(actor.id, position); }
      position.set(actor.position.x, actor.position.y, actor.position.z);
      const previous = this.allegiance.get(actor.id);
      if (previous === 'hostile' && actor.allegiance !== 'hostile' && CLEANSE_ACTORS[actor.id] && actor.visible) this.cleanse(actor, time);
      this.allegiance.set(actor.id, actor.allegiance);
      this.hitReact.set(actor.id, actor.reaction?.progress ?? 0);
    }
    if (!aren || !aren.visible || aren.downed) { player.valid = false; return; }
    const root = w.resolveSocket?.('aren', 'root');
    if (root) { root.updateWorldMatrix(true, false); root.getWorldPosition(player.position); } else player.position.set(aren.position.x, aren.position.y, aren.position.z);
    const length = Math.hypot(aren.facing.x, aren.facing.z);
    if (length > 1e-6) player.facing.set(aren.facing.x / length, 0, aren.facing.z / length);
    player.actionId = aren.actionId; player.phase = aren.phase; player.valid = true;
    player.normalizedTime = aren.normalizedTime;
  }

  /** The cleansed finish: burn the corruption shell away and flare embers; the animal itself is untouched. */
  private cleanse(actor: ActorSnapshot, time: number): void {
    const w = this.w, vfx = w.vfx, root = w.resolveActorRoot?.(actor.id), hero = w.player.hero;
    if (!root) return;
    const body = w.bodies.get(root);
    if (!w.dissolve.start(actor.id, root, time, WARDEN_OWNER + 1, body.height, body.radius)) return;
    const p = actor.position, element: VfxElement = hero === 'yara' ? 'heartroot' : hero === 'vesper' ? 'umbral' : hero === 'sakda' ? 'ember' : 'fire';
    vfx.flash(p.x, p.y + body.height * 0.55, p.z, 2.6, element, WARDEN_OWNER + 1, 0.3);
    vfx.embers(p.x, p.y + 0.2, p.z, 34, body.radius * 0.7, 2.6, -0.7, WARDEN_OWNER + 1, element);
    vfx.lights.pulse(p.x, p.y + body.height * 0.6, p.z, PALETTE[element].hot, 4, 8, 0.6, vfx.time, WARDEN_OWNER + 1);
    w.impact?.shake(0.08, 0.35, 16);
  }

  // ---- Thunder Cleave hold ----

  /**
   * Heavy held: lightning gathers into the blade tip, the edge brightens with the hold, arcs start crawling
   * over Aren past a third of the hold, and one burst marks the tick a release becomes a Thunder Cleave.
   * Presentation only: progress is read from the simulation clock, so pause freezes it.
   */
  private chargeUp(simTick: number, dt: number): void {
    const w = this.w, vfx = w.vfx;
    const heartroot = w.player.actionId === 'yara-root-charge', element = heartroot ? 'heartroot' : 'lightning';
    if (!w.player.valid || !heartroot && w.player.actionId !== HEAVY_CHARGE_ACTION) { this.chargeStart = -1; this.chargeReady = false; return; }
    if (this.chargeStart < 0) { this.chargeStart = simTick; this.chargeAcc = this.chargeArcAcc = 0; }
    const progress = Math.min(1, Math.max(0, (simTick - this.chargeStart) / THUNDER_CLEAVE.holdTicks));
    w.edgePeak = 1.3 + 2.3 * progress; w.edgeBoost = 1;
    if (dt <= 0 || !this.bladePose()) return;
    const tip = this.tip;
    this.chargeAcc += dt * (14 + 46 * progress);
    for (; this.chargeAcc >= 1; this.chargeAcc--) vfx.gather(tip.x, tip.y, tip.z, 1, 0.55 + 0.5 * progress, element, WARDEN_OWNER);
    vfx.glow(tip.x, tip.y, tip.z, 0.18 + 0.3 * progress, 0.08, element, 0.2 + 0.3 * progress, WARDEN_OWNER);
    if (progress > 0.35 && !heartroot) {
      this.chargeArcAcc += dt * (2 + 9 * progress);
      for (; this.chargeArcAcc >= 1; this.chargeArcAcc--) this.startArcs('aren', WARDEN_OWNER, 1, true, 0.2);
    }
    if (progress < 1 || this.chargeReady) return;
    this.chargeReady = true;
    const p = w.player.position;
    vfx.flash(tip.x, tip.y, tip.z, 1.2, element, WARDEN_OWNER, 0.16);
    vfx.sparks(tip.x, tip.y, tip.z, 18, 6, element, WARDEN_OWNER, 0.4);
    vfx.dustRing(p.x, p.y + 0.05, p.z, 0.8, 14, WARDEN_OWNER);
    vfx.lights.pulse(tip.x, tip.y, tip.z, PALETTE[element].hot, 3, 6, 0.3, vfx.time, WARDEN_OWNER);
    w.impact?.flashActor('aren', PALETTE[element].b, 1.1, 0.3, 'charge');
    w.impact?.shake(0.02, 0.15, 30);
  }

  // ---- blade ----

  private bladePose(): boolean {
    const w = this.w, tip = w.resolveSocket?.('aren', 'weapon-tip'), base = w.resolveSocket?.('aren', 'weapon-base');
    if (tip && base) {
      base.updateWorldMatrix(true, false); tip.updateWorldMatrix(true, false);
      base.getWorldPosition(this.base); tip.getWorldPosition(this.tip);
      return true;
    }
    // No weapon rig yet: swing from the right hand along the forearm so the trail still follows the real pose.
    w.hand.resolve(w.resolveActorRoot?.('aren'));
    const hand = w.hand.hand;
    if (!hand) return false;
    hand.updateWorldMatrix(true, false);
    hand.getWorldPosition(this.a);
    if (w.hand.forearm) w.hand.forearm.getWorldPosition(this.b); else this.b.set(w.player.position.x, w.player.position.y + 1.2, w.player.position.z);
    this.tip.subVectors(this.a, this.b).normalize();
    this.c.set(this.a.x - w.player.position.x, this.a.y - w.player.position.y - 1.1, this.a.z - w.player.position.z).normalize();
    this.tip.addScaledVector(this.c, 0.6).normalize();
    this.base.copy(this.a).addScaledVector(this.tip, 0.12);
    this.tip.multiplyScalar(1.15).add(this.a);
    return true;
  }

  private driveBlade(time: number, dt: number): void {
    const w = this.w, vfx = w.vfx;
    const windup = w.player.actionId === 'aren-charged-heavy' && w.player.phase === 'anticipation'
      && w.player.normalizedTime >= CLEAVE_TRAIL_FROM && w.player.normalizedTime < CLEAVE_CONTACT;
    if (windup && !this.cleaveWindupTrail) { w.trailElement = 'gold'; w.trail.setStyle('gold', 1.15, 0.14, 0.65); }
    this.cleaveWindupTrail = windup;
    const open = windup || (time >= w.trailFrom && time <= w.trailUntil) || w.hero.bladeLive();
    if (w.player.valid && open && this.bladePose()) {
      w.trail.push(this.base.x, this.base.y, this.base.z, this.tip.x, this.tip.y, this.tip.z, time, 1);
      const element = w.trailElement, palette = PALETTE[element];
      if (w.player.hero === 'yara') { if (dt > 0) this.sapTrail(palette); }
      else {
        if (dt > 0) {
          for (let i = vfx.count(2); i > 0; i--) {
            const p = vfx.spec();
            p.x = this.tip.x + vfx.range(-0.04, 0.04); p.y = this.tip.y + vfx.range(-0.04, 0.04); p.z = this.tip.z + vfx.range(-0.04, 0.04);
            p.vx = vfx.range(-0.8, 0.8); p.vy = vfx.range(-0.2, 1); p.vz = vfx.range(-0.8, 0.8); p.gravity = 2.5; p.drag = 1.8; p.life = vfx.range(0.16, 0.3);
            p.size0 = 0.035; p.size1 = 0.015; p.frame = VFX_FRAME.spark; p.stretch = 0.07;
            p.r0 = palette.hot.r; p.g0 = palette.hot.g; p.b0 = palette.hot.b; p.r1 = palette.b.r; p.g1 = palette.b.g; p.b1 = palette.b.b; p.a0 = 0.8; p.fadeOut = 0.5;
            vfx.emit(vfx.particles.additive, WARDEN_OWNER);
          }
          if (element === 'gold' && vfx.random() < 0.5) vfx.sparks(this.tip.x, this.tip.y, this.tip.z, 1, 5, 'lightning', WARDEN_OWNER, 0.1);
        }
        this.glaiveCrackle(time);
      }
    }
    w.trail.update(time);
    this.driveEdge(open, dt);
    if (w.player.valid && time < w.dashUntil) this.dashStreaks(dt);
  }

  /** Glaive filaments are re-rolled only as the world clock advances; frozen frames redraw the same paths. */
  private glaiveCrackle(time: number): void {
    const w = this.w, vfx = w.vfx;
    if (!CRACKLE_ACTIONS.test(w.player.actionId)) return;
    const palette = PALETTE.lightning, fresh = time !== this.lastCrackleTime;
    this.lastCrackleTime = time;
    for (let n = 0, count = vfx.reducedEffects ? 1 : CRACKLE_STRANDS; n < count; n++) {
      const path = this.crackles[n]!;
      if (fresh) {
        const s0 = vfx.range(-0.05, 0.55), s1 = Math.min(1.12, s0 + vfx.range(0.35, 0.55)), lateral = vfx.range(0.02, 0.07);
        this.a.subVectors(this.tip, this.base);
        this.b.copy(this.base).addScaledVector(this.a, s0);
        this.c.copy(this.base).addScaledVector(this.a, s1);
        jaggedPath(path, this.b.x + lateral, this.b.y, this.b.z, this.c.x - lateral, this.c.y, this.c.z, CRACKLE_LEVELS, 0.3, this.random);
        this.crackleAlpha[n] = 0.55 + 0.4 * vfx.random();
      }
      const style = w.lines.style.reset();
      style.width = 0.038; style.taper = 0.6; style.cr = palette.hot.r; style.cg = palette.hot.g; style.cb = palette.hot.b; style.gr = palette.a.r * 2.4; style.gg = palette.a.g * 2.4; style.gb = palette.a.b * 2.4;
      style.alpha0 = style.alpha1 = this.crackleAlpha[n]!;
      w.lines.add(path, (1 << CRACKLE_LEVELS) + 1);
    }
  }

  /** Heartroot staff-head sap: amber droplets shed from the head and the odd petal, in the trail's element palette. */
  private sapTrail(palette: { readonly hot: { r: number; g: number; b: number }; readonly b: { r: number; g: number; b: number } }): void {
    const vfx = this.w.vfx;
    for (let i = vfx.count(2); i > 0; i--) {
      const p = vfx.spec(), f = vfx.random();
      p.x = this.base.x + (this.tip.x - this.base.x) * f; p.y = this.base.y + (this.tip.y - this.base.y) * f; p.z = this.base.z + (this.tip.z - this.base.z) * f;
      p.vx = vfx.range(-0.5, 0.5); p.vy = vfx.range(-0.1, 0.7); p.vz = vfx.range(-0.5, 0.5); p.gravity = 6.5; p.drag = 0.8; p.life = vfx.range(0.3, 0.6);
      p.size0 = vfx.range(0.05, 0.085); p.size1 = 0.03; p.frame = VFX_FRAME.drop;
      p.r0 = palette.hot.r; p.g0 = palette.hot.g; p.b0 = palette.hot.b; p.r1 = palette.b.r; p.g1 = palette.b.g; p.b1 = palette.b.b; p.a0 = 0.9; p.fadeOut = 0.6;
      vfx.emit(vfx.particles.additive, WARDEN_OWNER);
    }
    if (vfx.random() < 0.3) {
      const p = vfx.spec();
      p.x = this.tip.x; p.y = this.tip.y; p.z = this.tip.z; p.vx = vfx.range(-0.6, 0.6); p.vy = vfx.range(0.2, 0.9); p.vz = vfx.range(-0.6, 0.6); p.gravity = 0.5; p.drag = 0.9;
      p.frame = VFX_FRAME.leaf; p.life = vfx.range(0.5, 0.9); p.size0 = vfx.range(0.1, 0.16); p.size1 = 0.04; p.spin = vfx.random() * 6; p.spinRate = vfx.range(-5, 5);
      p.r0 = p.r1 = 1; p.g0 = p.g1 = vfx.random() < 0.5 ? 0.62 : 0.88; p.b0 = p.b1 = vfx.random() < 0.5 ? 0.5 : 0.7; p.a0 = 0.85; p.fadeOut = 0.6;
      vfx.emit(vfx.particles.alpha, WARDEN_OWNER);
    }
  }

  /** Weapon edge emissive: idle 0.6, up to the swing peak on a slash or hit, decaying with the world clock. */
  private driveEdge(open: boolean, dt: number): void {
    const w = this.w, weapon = w.resolveSocket?.('aren', 'weapon');
    if (weapon !== this.edgeRoot) {
      this.edgeRoot = weapon; this.edgeMaterials.length = 0;
      weapon?.traverse(node => {
        if (!(node instanceof Mesh)) return;
        for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
          if (material.userData?.wcWeaponEdge === true && 'emissiveIntensity' in material && !this.edgeMaterials.includes(material as EdgeMaterial)) this.edgeMaterials.push(material as EdgeMaterial);
        }
      });
    }
    w.edgeBoost = open ? Math.max(w.edgeBoost * Math.exp(-dt / 0.6), 0.85) : w.edgeBoost * Math.exp(-dt / 0.28);
    if (this.edgeMaterials.length === 0) return;
    const peak = w.vfx.reducedEffects ? Math.min(REDUCED_EDGE_MAX, w.edgePeak) : w.edgePeak;
    const level = IDLE_EDGE + (peak - IDLE_EDGE) * Math.min(1, w.edgeBoost);
    for (const material of this.edgeMaterials) material.emissiveIntensity = level;
  }

  private dashStreaks(dt: number): void {
    const w = this.w, vfx = w.vfx, hot = PALETTE.judgement.hot, player = w.player;
    this.streakAcc += dt * 90 * (vfx.reducedEffects ? 0.35 : 1);
    for (; this.streakAcc >= 1; this.streakAcc--) {
      const p = vfx.spec();
      p.x = player.position.x + vfx.range(-0.5, 0.5); p.y = player.position.y + vfx.range(0.2, 1.7); p.z = player.position.z + vfx.range(-0.5, 0.5);
      p.vx = -player.facing.x * 3; p.vz = -player.facing.z * 3; p.drag = 3; p.life = vfx.range(0.2, 0.34); p.size0 = 0.07; p.size1 = 0.02; p.frame = VFX_FRAME.spark; p.stretch = 0.25;
      p.r0 = p.r1 = hot.r; p.g0 = p.g1 = hot.g; p.b0 = p.b1 = hot.b; p.a0 = 0.6; p.fadeIn = 0.1; p.fadeOut = 0.4;
      vfx.emit(vfx.particles.additive, WARDEN_OWNER);
    }
  }

  findProjectile(id: string): ProjectileVisual | undefined {
    for (const visual of this.w.projectiles) if (visual.id === id) return visual;
    return undefined;
  }

  // ---- projectiles ----

  private updateProjectiles(list: readonly PlayerProjectileSnapshot[] | undefined, alpha: number, time: number, dt: number): void {
    const w = this.w;
    for (const visual of w.projectiles) visual.seen = false;
    let lit = false;
    if (list) for (const snapshot of list) {
      let visual = this.findProjectile(snapshot.id);
      if (!visual) visual = this.beginProjectile(snapshot, time);
      visual.seen = true;
      if (!visual.hasPrev || snapshot.ageTicks !== visual.simTick) {
        visual.prev.copy(visual.hasPrev ? visual.cur : this.a.set(snapshot.position.x, snapshot.position.y, snapshot.position.z));
        visual.cur.set(snapshot.position.x, snapshot.position.y, snapshot.position.z);
        visual.simTick = snapshot.ageTicks; visual.hasPrev = true;
      }
      visual.display.lerpVectors(visual.prev, visual.cur, alpha);
      const d = snapshot.direction, length = Math.hypot(d.x, d.y, d.z);
      if (length > 1e-6) visual.direction.set(d.x / length, d.y / length, d.z / length);
      if (visual.kind === 'sigil-bolt') { const wantLight: boolean = !lit; this.drawBolt(visual, time, dt, wantLight); lit = lit || wantLight; }
      else if (visual.kind === 'crescent-wave') this.drawWave(visual, dt);
      else if (visual.kind === 'kunai' || visual.kind === 'echo-wave' || visual.kind === 'shade-clone') { const wantLight: boolean = !lit; lit = w.hero.drawProjectile(visual, time, dt, wantLight) || lit; }
      else { const wantLight: boolean = !lit; this.drawSeed(visual, time, dt, wantLight); lit = lit || wantLight; }
    }
    if (!lit) w.vfx.lights.untrack();
    for (let i = w.projectiles.length - 1; i >= 0; i--) if (!w.projectiles[i]!.seen) this.endProjectile(w.projectiles[i]!, true);
  }

  private beginProjectile(snapshot: PlayerProjectileSnapshot, time: number): ProjectileVisual {
    const w = this.w;
    const visual: ProjectileVisual = {
      id: snapshot.id, kind: snapshot.kind, seen: true, simTick: -1, hasPrev: false, radius: snapshot.radius, crescent: -1, owner: WARDEN_OWNER + 2,
      emitAcc: 0, scarDistance: 0, prev: new Vector3(), cur: new Vector3(), display: new Vector3(), direction: new Vector3(snapshot.direction.x, snapshot.direction.y, snapshot.direction.z),
      scarFrom: new Vector3(snapshot.position.x, snapshot.position.y, snapshot.position.z),
    };
    if (visual.kind === 'crescent-wave') {
      const dx = visual.direction.x, dz = visual.direction.z, length = Math.hypot(dx, dz) || 1, fx = dx / length, fz = dz / length, tilt = 0.5;
      // Basis: X across the wave, Y forward (the convex edge), Z up-and-back; tilted 0.5 rad so it reads from the locked camera.
      this.a.set(fx * Math.cos(tilt), Math.sin(tilt), fz * Math.cos(tilt));
      this.b.set(-fx * Math.sin(tilt), Math.cos(tilt), -fz * Math.sin(tilt));
      this.c.crossVectors(this.a, this.b);
      this.basis.makeBasis(this.c, this.a, this.b);
      this.quat.setFromRotationMatrix(this.basis);
      const width = Math.max(1.4, snapshot.radius * 2), scale = width / CRESCENT_CHORD;
      visual.crescent = w.crescents.spawn(visual.owner, time, 4, snapshot.position.x, snapshot.position.y, snapshot.position.z, this.quat, scale, 1, 1.35, 0.12, 'arcane');
    } else w.hero.beginProjectile(visual, snapshot, time);
    w.projectiles.push(visual);
    return visual;
  }

  /** Releases a projectile's visuals. Expiry without an impact cue (`expired`) dissipates with a small spark puff. */
  endProjectile(visual: ProjectileVisual, expired = false): void {
    const w = this.w, vfx = w.vfx;
    if (visual.kind === 'crescent-wave') {
      if (visual.crescent >= 0) w.crescents.release(visual.crescent);
      this.layScar(visual, true);
      if (expired) { vfx.sparks(visual.display.x, visual.display.y, visual.display.z, 14, 5, 'arcane', visual.owner, 0.4); vfx.dustRing(visual.display.x, visual.display.y - 0.5, visual.display.z, 1, 8, visual.owner); }
    } else if (visual.kind === 'kunai' || visual.kind === 'echo-wave' || visual.kind === 'shade-clone') w.hero.endProjectile(visual, expired);
    else if (expired) vfx.sparks(visual.display.x, visual.display.y, visual.display.z, 10, 4, visual.kind === 'sigil-bolt' ? 'arcane' : 'heartroot', visual.owner, 0.3);
    const index = w.projectiles.indexOf(visual);
    if (index >= 0) w.projectiles.splice(index, 1);
  }

  private drawSeed(visual: ProjectileVisual, time: number, dt: number, light: boolean): void {
    const w = this.w, vfx = w.vfx, at = visual.display, dir = visual.direction;
    const palette = PALETTE.heartroot, seed = visual.kind !== 'thorn-bolt', size = seed ? .4 : .18;
    w.sprites.add(at.x, at.y, at.z, dir.x, dir.y, dir.z, seed ? size : .7, size, seed ? VFX_FRAME.drop : VFX_FRAME.shard, palette.hot.r, palette.hot.g, palette.hot.b, .9);
    w.sprites.add(at.x, at.y, at.z, 0, 0, 0, size * 2, size * 2, VFX_FRAME.glow, palette.b.r, palette.b.g, palette.b.b, .4);
    // A living vine trails the seed: one thin amber→leaf-green ribbon that snakes behind it (Aren's bolt has two rune helices instead).
    this.e1.crossVectors(dir, UP);
    if (this.e1.lengthSq() < 1e-6) this.e1.set(1, 0, 0);
    this.e1.normalize();
    for (let i = 0; i < SPIRAL_POINTS; i++) {
      const s = (i / (SPIRAL_POINTS - 1)) * 1.6, sway = Math.sin(s * 6 - time * 14) * 0.07 * (s / 1.6 + 0.2);
      this.spiral[i * 3] = at.x - dir.x * s + this.e1.x * sway;
      this.spiral[i * 3 + 1] = at.y - dir.y * s + this.e1.y * sway + Math.cos(s * 5 - time * 11) * 0.04;
      this.spiral[i * 3 + 2] = at.z - dir.z * s + this.e1.z * sway;
    }
    const style = w.lines.style.reset();
    style.width = seed ? 0.07 : 0.045; style.taper = 0.6; style.cr = palette.hot.r; style.cg = palette.hot.g; style.cb = palette.hot.b; style.gr = 0.3; style.gg = 0.8; style.gb = 0.15; style.alpha0 = 0.9; style.alpha1 = 0;
    w.lines.add(this.spiral, SPIRAL_POINTS);
    if (light) vfx.lights.track(at.x, at.y, at.z, palette.hot, 1.8, 4.5);
    visual.emitAcc += dt * (vfx.reducedEffects ? 8 : 30);
    for (; visual.emitAcc >= 1; visual.emitAcc--) {
      const p = vfx.spec();
      p.x = at.x; p.y = at.y; p.z = at.z; p.vx = -dir.x; p.vy = .5; p.vz = -dir.z;
      p.life = .45; p.size0 = .12; p.size1 = .02; p.frame = VFX_FRAME.leaf; p.spin = Math.sin(time * 10) * 4;
      p.r0 = p.r1 = seed ? 1 : .35; p.g0 = p.g1 = seed ? .55 : .85; p.b0 = p.b1 = seed ? .7 : .2; p.a0 = .75; p.fadeOut = .6;
      vfx.emit(vfx.particles.alpha, visual.owner);
    }
  }

  /** Sigil Bolt: HDR core + velocity-stretched glow + flare sprites, two spiral rune ribbons, spark/mist trail and the tracked light. */
  private drawBolt(visual: ProjectileVisual, time: number, dt: number, light: boolean): void {
    const w = this.w, vfx = w.vfx, at = visual.display, dir = visual.direction, palette = PALETTE.arcane;
    const pulse = 0.85 + 0.15 * Math.sin(time * 38);
    w.sprites.add(at.x, at.y, at.z, dir.x, dir.y, dir.z, 0.7, 0.3, VFX_FRAME.glow, palette.b.r, palette.b.g, palette.b.b, 0.5 * pulse);
    w.sprites.add(at.x, at.y, at.z, dir.x, dir.y, dir.z, 0.24, 0.13, VFX_FRAME.mote, palette.hot.r, palette.hot.g, palette.hot.b, 1);
    w.sprites.add(at.x, at.y, at.z, 0, 0, 0, 0.34 * pulse, 0.34 * pulse, VFX_FRAME.star, palette.hot.r, palette.hot.g, palette.hot.b, 0.45);
    // Two counter-phased helices behind the head: points step back along the flight line and screw around it over time.
    this.e1.crossVectors(dir, UP);
    if (this.e1.lengthSq() < 1e-6) this.e1.set(1, 0, 0);
    this.e1.normalize();
    this.e2.crossVectors(dir, this.e1);
    for (let ribbon = 0; ribbon < 2; ribbon++) {
      for (let i = 0; i < SPIRAL_POINTS; i++) {
        const s = (i / (SPIRAL_POINTS - 1)) * SPIRAL_LENGTH, radius = 0.05 + 0.15 * Math.pow(1 - s / SPIRAL_LENGTH, 0.7), phase = s * 5.2 + time * 24 + ribbon * Math.PI;
        const cos = Math.cos(phase) * radius, sin = Math.sin(phase) * radius;
        this.spiral[i * 3] = at.x - dir.x * s + this.e1.x * cos + this.e2.x * sin;
        this.spiral[i * 3 + 1] = at.y - dir.y * s + this.e1.y * cos + this.e2.y * sin;
        this.spiral[i * 3 + 2] = at.z - dir.z * s + this.e1.z * cos + this.e2.z * sin;
      }
      const style = w.lines.style.reset();
      style.width = 0.07; style.taper = 0.5; style.cr = palette.hot.r; style.cg = palette.hot.g; style.cb = palette.hot.b; style.gr = palette.b.r * 0.6; style.gg = palette.b.g * 0.6; style.gb = palette.b.b * 0.6; style.alpha0 = 0.95; style.alpha1 = 0;
      w.lines.add(this.spiral, SPIRAL_POINTS);
    }
    // Spark and mist trail along the segment travelled since the last frame.
    visual.emitAcc += dt * 110 * (vfx.reducedEffects ? 0.35 : 1);
    for (; visual.emitAcc >= 1; visual.emitAcc--) {
      const f = vfx.random();
      this.a.lerpVectors(visual.prev, at, f);
      const p = vfx.spec();
      p.x = this.a.x + vfx.range(-0.05, 0.05); p.y = this.a.y + vfx.range(-0.05, 0.05); p.z = this.a.z + vfx.range(-0.05, 0.05);
      p.vx = -dir.x * 1.5 + vfx.range(-0.7, 0.7); p.vy = -dir.y * 1.5 + vfx.range(-0.4, 0.7); p.vz = -dir.z * 1.5 + vfx.range(-0.7, 0.7);
      p.drag = 2; p.gravity = 1.5; p.life = vfx.range(0.2, 0.42);
      if (vfx.random() < 0.3) {
        p.size0 = 0.28; p.size1 = 0.5; p.frame = VFX_FRAME.glow; p.a0 = 0.16; p.r0 = p.r1 = palette.b.r; p.g0 = p.g1 = palette.b.g; p.b0 = p.b1 = palette.b.b; p.fadeIn = 0.2;
      } else {
        p.size0 = 0.035; p.size1 = 0.015; p.frame = VFX_FRAME.spark; p.stretch = 0.07; p.a0 = 0.85;
        p.r0 = palette.hot.r; p.g0 = palette.hot.g; p.b0 = palette.hot.b; p.r1 = palette.b.r; p.g1 = palette.b.g; p.b1 = palette.b.b;
      }
      vfx.emit(vfx.particles.additive, visual.owner);
    }
    if (light) vfx.lights.track(at.x, at.y, at.z, palette.hot, 2.6, 6.5);
  }

  /** Crescent Wave: the instanced crescent follows the snapshot; dust, edge sparks and a ground scar trail behind it. */
  private drawWave(visual: ProjectileVisual, dt: number): void {
    const w = this.w, vfx = w.vfx, at = visual.display, dir = visual.direction;
    w.crescents.place(visual.crescent, at.x, at.y + 0.55, at.z);
    visual.emitAcc += dt * 90 * (vfx.reducedEffects ? 0.35 : 1);
    const length = Math.hypot(dir.x, dir.z) || 1, fx = dir.x / length, fz = dir.z / length;
    for (; visual.emitAcc >= 1; visual.emitAcc--) {
      const side = vfx.range(-1, 1) * visual.radius;
      const x = at.x - fz * side - fx * Math.abs(side) * 0.45, z = at.z + fx * side - fz * Math.abs(side) * 0.45;
      if (vfx.random() < 0.55) vfx.smoke(x, at.y - 0.45, z, 1, 0.1, 0.5, 0.7, 0.8, VFX_COLORS.dust, 0.38, visual.owner, 0.5);
      else vfx.sparks(x, at.y + 0.3, z, 1, 3, 'arcane', visual.owner, 0.5);
    }
    this.a.set(at.x - visual.scarFrom.x, 0, at.z - visual.scarFrom.z);
    visual.scarDistance = this.a.length();
    if (visual.scarDistance >= WAVE_SCAR_STEP) this.layScar(visual, false);

  }

  /** Scorch decal along the path the wave has travelled since the last scar. */
  private layScar(visual: ProjectileVisual, final: boolean): void {
    const w = this.w, vfx = w.vfx, from = visual.scarFrom, at = visual.display;
    const dx = at.x - from.x, dz = at.z - from.z, distance = Math.hypot(dx, dz);
    if (distance < (final ? 0.4 : WAVE_SCAR_STEP)) return;
    const root = w.resolveSocket?.('aren', 'root');
    const y = (root ? root.getWorldPosition(this.c).y : w.player.position.y) + 0.04;
    this.footprint.set('rect', (from.x + at.x) / 2, y, (from.z + at.z) / 2, Math.atan2(dx, dz), Math.max(0.45, visual.radius * 0.28), distance / 2 + 0.1, 0, 1);
    vfx.ground.spawn('decal', this.footprint, 'fire', visual.owner, vfx.time, 3, 0.9, 'arcane');
    from.set(at.x, at.y, at.z);
    visual.scarDistance = 0;
  }

  // ---- judgement marks ----

  private updateMarks(list: readonly JudgementMarkSnapshot[] | undefined, simTick: number, time: number): void {
    const w = this.w;
    if (list) for (const mark of list) {
      let known = false;
      for (const visual of w.marks) if (visual.id === mark.id) { known = true; break; }
      if (!known) w.cues.placeMark(mark.id, WARDEN_OWNER + 3, mark.position.x, mark.position.y, mark.position.z, mark.angleRadians, Math.max(0.3, (mark.detonateAtTick - simTick) / 60 + 0.6));
    }
    for (let i = w.marks.length - 1; i >= 0; i--) {
      const visual = w.marks[i]!;
      let listed = !list;
      if (list) for (const mark of list) if (mark.id === visual.id) { listed = true; break; }
      if (time >= visual.expiresAt || (!listed && time - visual.createdAt > 0.25)) w.releaseMark(i);
    }
  }

  // ---- lightning and arcs ----

  private drawBolts(time: number): void {
    const w = this.w, vfx = w.vfx, palette = PALETTE.lightning;
    for (const bolt of w.bolts) {
      if (!bolt.active) continue;
      const age = time - bolt.start;
      if (age >= THUNDER_SECONDS) { bolt.active = false; continue; }
      if (age < 0) continue;
      if (!vfx.reducedEffects && time >= bolt.nextRegen) {
        w.cues.regenerateBolt(bolt); bolt.nextRegen = time + (2 + (vfx.random() < 0.5 ? 1 : 0)) / 60;
        bolt.flicker = 0.7 + 0.3 * vfx.random();
      }
      const envelope = age < 0.05 ? 1 : Math.pow(Math.max(0, 1 - (age - 0.05) / (THUNDER_SECONDS - 0.05)), 1.4);
      let style = w.lines.style.reset();
      style.width = vfx.reducedEffects ? 0.16 : 0.38; style.taper = 0.45; style.cr = palette.hot.r; style.cg = palette.hot.g; style.cb = palette.hot.b; style.gr = palette.b.r; style.gg = palette.b.g; style.gb = palette.b.b;
      style.alpha0 = style.alpha1 = envelope * (vfx.reducedEffects ? 0.65 : bolt.flicker);
      w.lines.add(bolt.trunk, (1 << BOLT_TRUNK_LEVELS) + 1);
      if (!vfx.reducedEffects) for (const branch of bolt.branches) {
        style = w.lines.style.reset();
        style.width = 0.17; style.taper = 0.85; style.cr = palette.hot.r * 0.8; style.cg = palette.hot.g * 0.8; style.cb = palette.hot.b * 0.8; style.gr = palette.b.r * 0.8; style.gg = palette.b.g * 0.8; style.gb = palette.b.b * 0.8;
        style.alpha0 = envelope * bolt.flicker * 0.85; style.alpha1 = 0;
        w.lines.add(branch, (1 << BOLT_BRANCH_LEVELS) + 1);
      }
      if (!vfx.reducedEffects && age < 0.2) for (const radial of bolt.radial) {
        style = w.lines.style.reset();
        style.width = 0.13; style.taper = 0.7; style.cr = palette.hot.r * 0.8; style.cg = palette.hot.g * 0.8; style.cb = palette.hot.b * 0.8; style.gr = palette.b.r; style.gg = palette.b.g; style.gb = palette.b.b;
        style.alpha0 = envelope * 0.9; style.alpha1 = 0;
        w.lines.add(radial, (1 << BOLT_BRANCH_LEVELS) + 1);
      }
    }
  }

  /** Starts `count` arcs crawling over `actorId` for `seconds`: capsule anchors, jagged paths regenerated every 2–3 world ticks. */
  startArcs(actorId: string, owner: number, count: number, lightning: boolean, seconds: number): void {
    const w = this.w, vfx = w.vfx;
    if (vfx.reducedEffects) return;
    const root = w.resolveActorRoot?.(actorId), body = root ? w.bodies.get(root) : { height: 1.2, radius: 0.8 };
    for (let i = 0; i < count; i++) {
      let arc = w.arcs.find(candidate => !candidate.active);
      if (!arc) { arc = w.arcs[0]!; for (const candidate of w.arcs) if (candidate.start < arc.start) arc = candidate; }
      const angle = vfx.random() * Math.PI * 2, radius = body.radius * vfx.range(0.3, 0.75), y = body.height * vfx.range(0.12, 0.88);
      arc.a.set(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
      const sweep = vfx.random() * Math.PI * 2, reach = vfx.range(0.5, 1.2);
      arc.b.set(arc.a.x + Math.cos(sweep) * reach * 0.6, Math.min(body.height, Math.max(body.height * 0.05, y + vfx.range(-0.6, 0.6) * reach)), arc.a.z + Math.sin(sweep) * reach * 0.6);
      arc.active = true; arc.actorId = actorId; arc.owner = owner; arc.start = vfx.time; arc.until = vfx.time + seconds; arc.strength = 1; arc.lightning = lightning; arc.nextRegen = 0;
    }
  }

  private drawArcs(time: number): void {
    const w = this.w, vfx = w.vfx, count = (1 << ARC_LEVELS) + 1;
    for (let i = 0; i < MAX_ARCS; i++) {
      const arc = w.arcs[i]!;
      if (!arc.active) continue;
      if (vfx.reducedEffects || time >= arc.until) { arc.active = false; continue; }
      const root = w.resolveSocket?.(arc.actorId, 'root');
      if (root) { root.updateWorldMatrix(true, false); root.getWorldPosition(this.a); } else {
        const cached = this.positions.get(arc.actorId);
        if (!cached) { arc.active = false; continue; }
        this.a.copy(cached);
      }
      if (time >= arc.nextRegen) { w.cues.regenerateArc(arc, this.a); arc.nextRegen = time + (2 + (vfx.random() < 0.5 ? 1 : 0)) / 60; arc.strength = 0.55 + 0.45 * vfx.random(); }
      const life = (arc.until - time) / Math.max(1e-3, arc.until - arc.start), react = this.hitReact.get(arc.actorId) ?? 0;
      const palette = arc.lightning ? PALETTE.lightning : PALETTE.arcane, style = w.lines.style.reset();
      style.width = 0.09; style.taper = 0.3; style.cr = palette.hot.r; style.cg = palette.hot.g; style.cb = palette.hot.b; style.gr = palette.b.r; style.gg = palette.b.g; style.gb = palette.b.b;
      style.alpha0 = style.alpha1 = arc.strength * Math.min(1, life * 2.2) * (react > 0 ? 1 - 0.35 * react : 0.8);
      w.lines.add(arc.path, count);
    }
  }

  // ---- ambient ----

  /** Sparse drifting dust motes and leaf flecks near Aren (one shared pool, no extra draw calls). */
  private ambient(dt: number): void {
    const w = this.w, vfx = w.vfx, player = w.player;
    if (!player.valid || dt <= 0) return;
    const scale = vfx.reducedEffects ? 0.35 : 1;
    this.moteAcc += dt * 6 * scale; this.fleckAcc += dt * 1.3 * scale;
    for (; this.moteAcc >= 1; this.moteAcc--) {
      const angle = vfx.random() * Math.PI * 2, r = Math.sqrt(vfx.random()) * 7, p = vfx.spec();
      p.x = player.position.x + Math.cos(angle) * r; p.y = player.position.y + vfx.range(0.2, 3.4); p.z = player.position.z + Math.sin(angle) * r;
      p.vx = vfx.range(0.05, 0.22); p.vy = vfx.range(-0.02, 0.1); p.vz = vfx.range(-0.12, 0.1); p.drag = 0.1; p.life = vfx.range(5, 8);
      p.size0 = p.size1 = vfx.range(0.035, 0.07); p.frame = VFX_FRAME.mote; p.a0 = 0.5; p.fadeIn = 0.25; p.fadeOut = 0.6;
      p.r0 = p.r1 = MOTE.r; p.g0 = p.g1 = MOTE.g; p.b0 = p.b1 = MOTE.b;
      vfx.emit(vfx.particles.additive, WARDEN_OWNER);
    }
    for (; this.fleckAcc >= 1; this.fleckAcc--) {
      const angle = vfx.random() * Math.PI * 2, r = Math.sqrt(vfx.random()) * 7, p = vfx.spec();
      p.x = player.position.x + Math.cos(angle) * r; p.y = player.position.y + vfx.range(1, 3.5); p.z = player.position.z + Math.sin(angle) * r;
      p.vx = vfx.range(0.3, 0.8); p.vy = vfx.range(-0.2, 0.05); p.vz = vfx.range(-0.2, 0.3); p.gravity = 0.25; p.drag = 0.4; p.life = vfx.range(4, 6.5);
      p.size0 = p.size1 = vfx.range(0.07, 0.11); p.spin = vfx.random() * 6.28; p.spinRate = vfx.range(-3, 3); p.frame = VFX_FRAME.leaf; p.a0 = 0.8; p.fadeIn = 0.15; p.fadeOut = 0.7;
      p.r0 = p.r1 = FLECK.r; p.g0 = p.g1 = FLECK.g; p.b0 = p.b1 = FLECK.b;
      vfx.emit(vfx.particles.alpha, WARDEN_OWNER);
    }
  }
}
