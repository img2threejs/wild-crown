import { Vector3, type Object3D } from 'three';
import type { ActorSnapshot } from '../../game/contracts.js';
import type { HeroId } from '../../game/heroes.js';
import { ActorBodies, DEFAULT_BODY, HandRig } from './ActorBounds.js';
import type { ImpactSink, SocketResolver } from './ElementKits.js';
import { Footprint } from './footprint.js';
import { PALETTE, UMBRAL_RIM, UMBRAL_SMOKE, type VfxElement } from './palette.js';
import type { BeamSlot } from './RibbonFx.js';
import { emitPetalRing, emitPetalSwirl } from './PetalFx.js';
import { BAMBOO_AURAS } from './BambooKits.js';
import { implode } from './hero-fx.js';
import { emitStormFeather, VENOM } from './CanopyKits.js';
import { GROVE_AURAS } from './GroveKits.js';
import { MISTVEIL_AURAS } from './MistveilKits.js';
import { MOONPINE_AURAS } from './MoonpineKits.js';
import { VFX_FRAME } from './VfxAtlas.js';
import { VFX_COLORS, type VfxSystem } from './VfxSystem.js';

/** Owner id for actor-driven particles: never matches a cue scope, cleared with the system. */
export const ACTOR_VFX_OWNER = 0x7fff0000;
const HEAVY_ACTION = /^aren-(charged-)?heavy$/;
/** Every shared dodge clip (dive rolls, Perfect Dodge, quick steps, rolls, handspring, cartwheels, pivot rolls, slide); the hero's own dash clip is mapped onto these ids. */
const DIVE_ACTION = /dive-roll|perfect-dodge|quick-step|shoulder-roll|back-handspring|cartwheel|pivot-roll|low-slide/;

/** Palette element of each hero's own effects (speed streaks, air steps). */
function heroElement(hero: HeroId): VfxElement { return hero === 'yara' ? 'heartroot' : hero === 'vesper' ? 'umbral' : hero === 'sakda' ? 'ember' : 'arcane'; }
/** Root Tether (Aren) and Binding Vines (Yara): the live lash is drawn while the action runs and a target is locked. */
const TETHER_ACTION = /^(aren-root-tether|yara-binding-vines)$/;
/** Boosted-jump air steps: the second step lands when the rising clip reaches this progress, at least `AIR_STEP_GAP` seconds after the first. */
const AIR_STEP_PROGRESS = 0.38;
const AIR_STEP_GAP = 0.1;
const GRAVITY = 9.8;
export type AuraTheme = 'ember' | 'frost' | 'earth' | 'howler' | 'storm' | 'toxic' | 'heartlight';
const AURAS: Readonly<Record<string, AuraTheme>> = {
  'corrupted-boar': 'ember', 'greenwake-sap-stalker': 'frost', 'greenwake-root-rammer': 'earth',
  'canopy-howler': 'howler', 'canopy-hornbill': 'storm', 'canopy-mire-viper': 'toxic',
  ...GROVE_AURAS, ...MOONPINE_AURAS, ...MISTVEIL_AURAS, ...BAMBOO_AURAS,
};

interface PlayerState {
  actionId: string; phase: string; landed: boolean; diving: boolean;
  /** Jump bookkeeping: air steps fired this jump, world time of the first, when the fall began (-1 = not yet) and the highest root y seen. */
  airSteps: number; lastStep: number; fallSince: number; peakY: number;
}

/**
 * Snapshot-driven presentation for actors: heavy slam, tether vine, dive and landing dust, plus
 * per-monster elemental auras. Reads snapshots and rendered bones only. The blade trail, hit impacts
 * and weapon glow live in the Warden arsenal (`WardenFx`).
 */
export class ActorVfx {
  private readonly bodies = new ActorBodies();
  private readonly hand = new HandRig();
  private readonly auraAcc = new Map<string, Float64Array>();
  private readonly player: PlayerState = { actionId: '', phase: '', landed: true, diving: false, airSteps: 0, lastStep: 0, fallSince: -1, peakY: 0 };
  private hero: HeroId = 'aren';
  /** Yaw of the player's facing, refreshed every frame (orients the umbral air-step crescent). */
  private heading = 0;
  /** Scale (0.6..1.8) of the most recent landing dust, derived from the fall height; exposed for presentation probes. */
  lastLandingScale = 0;
  private readonly position = new Vector3();
  private readonly a = new Vector3();
  private readonly slam = new Footprint();
  private tether: BeamSlot | undefined;
  private wind: BeamSlot | undefined;
  private readonly dir = new Vector3();
  private readonly side = new Vector3();
  private readonly up = new Vector3();
  private lastTime = 0;
  private streakAcc = 0;
  private tetherAcc = 0;

  constructor(
    private readonly vfx: VfxSystem,
    private readonly resolveSocket: SocketResolver | undefined,
    private readonly resolveActorRoot: ((actorId: string) => Object3D | undefined) | undefined,
    private readonly isCharging: (actorId: string) => boolean,
    private impact?: ImpactSink,
  ) {}

  setImpactSink(impact: ImpactSink | undefined): void { this.impact = impact; }

  /** The playable hero in the player slot (`snapshot.player.heroId`); Aren and Yara share the actor id and differ only in their effects. */
  setHero(hero: HeroId): void { this.hero = hero; }

  update(actors: readonly ActorSnapshot[]): void {
    const time = this.vfx.time, dt = Math.min(0.1, Math.max(0, time - this.lastTime));
    this.lastTime = time;
    let player: ActorSnapshot | undefined;
    for (const actor of actors) {
      if (actor.id === 'aren' || (!player && actor.allegiance === 'player')) player = actor;
      const theme = AURAS[actor.id];
      // A story boss's corruption aura ends with the cleanse: only a hostile, uncleansed body wears it.
      if (theme && actor.visible && !actor.downed && (!BAMBOO_AURAS[actor.id] || (actor.allegiance === 'hostile' && actor.chapterStatus !== 'cleansed' && actor.chapterStatus !== 'reunion'))) this.aura(actor, theme, dt);
    }
    if (player && player.visible && !player.downed) this.updatePlayer(player, dt);
    else this.releaseTether();
  }

  clear(): void {
    this.releaseTether();
    this.player.actionId = ''; this.player.phase = ''; this.player.diving = false; this.player.landed = true;
    this.player.airSteps = 0; this.player.fallSince = -1;
    this.hand.clear();
    this.auraAcc.clear();
  }

  dispose(): void { this.clear(); }

  // ---- Aren ----

  private updatePlayer(actor: ActorSnapshot, dt: number): void {
    const state = this.player, action = actor.actionId, phase = actor.phase;
    this.rootPosition(actor, this.position);
    this.heading = Math.atan2(actor.facing.x, actor.facing.z);
    const heavy = HEAVY_ACTION.test(action);
    if (heavy && phase === 'active' && state.phase !== 'active') this.heavySlam(actor, action === 'aren-charged-heavy');
    const diving = DIVE_ACTION.test(action);
    if (diving !== state.diving) this.diveDust(diving ? 1 : 0.8);
    if (diving) this.speedStreaks(actor, dt);
    this.updateJump(actor, state.actionId !== 'aren-jump');
    if (TETHER_ACTION.test(action) && actor.targetId) this.updateTether(actor, actor.targetId, dt);
    else this.releaseTether();
    state.actionId = action; state.phase = phase; state.diving = diving;
  }

  /**
   * Jump presentation from snapshot state only: take-off dust, the two air steps of a boosted jump (`jumpBoosted`; the second lands when the
   * rising clip passes `AIR_STEP_PROGRESS`) and landing dust scaled by the fall height.
   */
  private updateJump(actor: ActorSnapshot, entered: boolean): void {
    const state = this.player, time = this.vfx.time;
    if (actor.actionId !== 'aren-jump') {
      if (!state.landed) { this.landingDust(); state.landed = true; }
      state.airSteps = 0; state.fallSince = -1;
      return;
    }
    if (entered) { this.takeoffDust(); state.airSteps = 0; state.fallSince = -1; state.peakY = this.position.y; }
    if (actor.phase === 'active' || actor.jumpPhase === 'rising' || actor.jumpPhase === 'falling') state.landed = false;
    state.peakY = Math.max(state.peakY, this.position.y);
    if (actor.jumpPhase === 'falling' && state.fallSince < 0) state.fallSince = time;
    if (actor.jumpBoosted && actor.jumpPhase !== 'landing') {
      if (state.airSteps === 0) { this.airStep(0); state.airSteps = 1; state.lastStep = time; }
      else if (state.airSteps === 1 && time - state.lastStep >= AIR_STEP_GAP && (actor.jumpPhase === 'falling' || (actor.jumpPhase === 'rising' && (actor.jumpPhaseProgress ?? 0) >= AIR_STEP_PROGRESS))) { this.airStep(1); state.airSteps = 2; }
    }
    if (!state.landed && (actor.phase === 'recovery' || actor.jumpPhase === 'landing')) { this.landingDust(); state.landed = true; }
  }

  /** One treading-the-wind step: a flat wind/petal disc ripples out under the feet and a short spiral streak winds up the body. */
  private airStep(index: number): void {
    const vfx = this.vfx, p = this.position, owner = ACTOR_VFX_OWNER, yara = this.hero === 'yara', element = heroElement(this.hero);
    const radius = 1.25 + 0.2 * index;
    this.slam.set('disk', p.x, p.y + 0.05, p.z, 0, radius, radius);
    vfx.ground.spawn('shock', this.slam, element, owner, vfx.time, 0.45, 0.9);
    vfx.lights.pulse(p.x, p.y + 0.3, p.z, PALETTE[element].hot, 2.2, 4.5, 0.25, vfx.time, owner);
    if (this.hero === 'vesper') {
      // Shadow step: the shadow collapses under the feet and a crimson crescent of sparks flares open behind the step.
      implode(vfx, owner, p.x, p.y + 0.4, p.z, 10, 1, 0.5, UMBRAL_SMOKE, 0.5);
      vfx.smoke(p.x, p.y + 0.1, p.z, 6, 0.4, 0.4, 0.8, 0.7, UMBRAL_SMOKE, 0.5, owner, 1);
      const rimHot = UMBRAL_RIM.hot, rimBody = UMBRAL_RIM.body;
      for (let i = vfx.count(14); i > 0; i--) {
        const s = vfx.spec(), angle = this.heading + Math.PI + (i / 14 - 0.5) * 2.1, dx = Math.sin(angle), dz = Math.cos(angle);
        s.x = p.x + dx * 0.85; s.y = p.y + 0.15 + vfx.random() * 0.1; s.z = p.z + dz * 0.85;
        s.vx = dx * 1.4; s.vz = dz * 1.4; s.vy = vfx.range(0, 0.5); s.drag = 2.4; s.life = vfx.range(0.28, 0.42); s.size0 = 0.06; s.size1 = 0.02; s.frame = VFX_FRAME.spark; s.stretch = 0.2;
        s.r0 = rimHot.r; s.g0 = rimHot.g; s.b0 = rimHot.b; s.r1 = rimBody.r; s.g1 = rimBody.g; s.b1 = rimBody.b; s.a0 = 0.9; s.fadeIn = 0.05; s.fadeOut = 0.5;
        vfx.emit(vfx.particles.additive, owner);
      }
      return;
    }
    if (this.hero === 'sakda') {
      // Fire ring: flames stand up around the feet and gold-orange sparks scatter outward.
      vfx.flash(p.x, p.y + 0.2, p.z, 1.3, 'ember', owner, 0.18);
      for (let i = vfx.count(8); i > 0; i--) {
        const angle = (i / 8) * Math.PI * 2 + vfx.random() * 0.4;
        vfx.flames(p.x + Math.cos(angle) * radius * 0.6, p.y, p.z + Math.sin(angle) * radius * 0.6, 1, 0.05, 0.7, owner, 'ember');
      }
      vfx.sparks(p.x, p.y + 0.12, p.z, 16, 5, 'ember', owner, 0.15);
      vfx.embers(p.x, p.y + 0.1, p.z, 6, radius * 0.6, 1.4, -0.4, owner, 'ember');
      return;
    }
    if (yara) {
      emitPetalRing(vfx, owner, p.x, p.y, p.z, 14, radius);
      emitPetalSwirl(vfx, owner, p.x, p.y, p.z, 14, 0.5, 2.6, index % 2 ? -1 : 1);
      return;
    }
    const hot = PALETTE.arcane.hot, body = PALETTE.arcane.b;
    for (let i = vfx.count(16); i > 0; i--) {
      const s = vfx.spec(), angle = (i / 16) * Math.PI * 2 + vfx.random() * 0.3;
      s.x = p.x + Math.cos(angle) * 0.3; s.y = p.y + 0.12; s.z = p.z + Math.sin(angle) * 0.3;
      s.vx = Math.cos(angle) * 5.5; s.vz = Math.sin(angle) * 5.5; s.drag = 3; s.life = vfx.range(0.28, 0.4); s.size0 = 0.06; s.size1 = 0.02; s.frame = VFX_FRAME.spark; s.stretch = 0.3;
      s.r0 = hot.r; s.g0 = hot.g; s.b0 = hot.b; s.r1 = body.r; s.g1 = body.g; s.b1 = body.b; s.a0 = 0.8; s.fadeIn = 0.05; s.fadeOut = 0.5;
      vfx.emit(vfx.particles.additive, owner);
    }
    const spiral = vfx.count(18);
    for (let i = 0; i < spiral; i++) {
      const s = vfx.spec(), angle = i * 0.7 + index * Math.PI;
      s.x = p.x + Math.cos(angle) * 0.5; s.y = p.y + 0.1 + i * 0.09; s.z = p.z + Math.sin(angle) * 0.5;
      s.vx = -Math.sin(angle) * 5; s.vz = Math.cos(angle) * 5; s.vy = 1.4; s.drag = 2; s.life = vfx.range(0.22, 0.32); s.size0 = 0.05; s.size1 = 0.02; s.frame = VFX_FRAME.spark; s.stretch = 0.22;
      s.r0 = hot.r; s.g0 = hot.g; s.b0 = hot.b; s.r1 = body.r; s.g1 = body.g; s.b1 = body.b; s.a0 = 0.85; s.fadeIn = 0.05; s.fadeOut = 0.5;
      vfx.emit(vfx.particles.additive, owner);
    }
  }

  private takeoffDust(): void {
    const vfx = this.vfx, p = this.position, owner = ACTOR_VFX_OWNER;
    vfx.dustRing(p.x, p.y, p.z, 0.55, 10, owner);
    vfx.smoke(p.x, p.y, p.z, 3, 0.3, 0.3, 0.7, 0.7, VFX_COLORS.dust, 0.35, owner, 0.7);
    if (this.hero === 'yara') emitPetalRing(vfx, owner, p.x, p.y, p.z, 6, 0.5);
    else if (this.hero === 'vesper') { vfx.smoke(p.x, p.y + 0.2, p.z, 4, 0.3, 0.5, 0.7, 0.7, UMBRAL_SMOKE, 0.45, owner, 0.6); vfx.sparks(p.x, p.y + 0.1, p.z, 4, 2.5, 'umbral', owner, 0.3); }
    else if (this.hero === 'sakda') vfx.embers(p.x, p.y + 0.1, p.z, 5, 0.3, 1.2, -0.3, owner, 'ember');
    else vfx.sparks(p.x, p.y + 0.1, p.z, 4, 2.5, 'arcane', owner, 0.3);
  }

  private heavySlam(actor: ActorSnapshot, charged: boolean): void {
    const vfx = this.vfx, radius = charged ? 1.9 : 1.3, owner = ACTOR_VFX_OWNER;
    const x = this.position.x + actor.facing.x * 1.25, z = this.position.z + actor.facing.z * 1.25, y = this.position.y;
    this.slam.set('disk', x, y, z, 0, radius, radius);
    vfx.ground.spawn('shock', this.slam, 'gold', owner, vfx.time, 0.42);
    vfx.ground.spawn('decal', this.slam, 'earth', owner, vfx.time, charged ? 5 : 4, 1, 'gold');
    vfx.dustRing(x, y, z, radius * 0.7, charged ? 26 : 16, owner);
    vfx.chunks(x, y + 0.05, z, charged ? 9 : 5, 3.4, 0.2, owner, false, this.slam);
    vfx.sparks(x, y + 0.15, z, charged ? 26 : 14, 4.5, 'gold', owner, 0.6);
    this.groundCrackle(x, y, z, charged ? 8 : 5);
    vfx.flash(x, y + 0.3, z, charged ? 2 : 1.4, 'gold', owner, 0.16);
    if (charged) vfx.lights.pulse(x, y + 1, z, PALETTE.gold.hot, 6, 6, 0.4, vfx.time, owner);
    this.impact?.shake(charged ? 0.16 : 0.08, 0.22, 24);
  }

  /** Lightning racing outward over the ground from a slam: stretched violet-blue sparks on radial paths (earth + lightning). */
  private groundCrackle(x: number, y: number, z: number, count: number): void {
    const vfx = this.vfx, hot = PALETTE.lightning.hot, body = PALETTE.lightning.b;
    for (let i = vfx.count(count); i > 0; i--) {
      const s = vfx.spec(), angle = (i / count) * Math.PI * 2 + vfx.random() * 0.4, speed = vfx.range(9, 13);
      s.x = x + Math.cos(angle) * 0.3; s.y = y + 0.08 + vfx.random() * 0.05; s.z = z + Math.sin(angle) * 0.3;
      s.vx = Math.cos(angle) * speed; s.vz = Math.sin(angle) * speed; s.drag = 3.2; s.life = vfx.range(0.25, 0.38); s.size0 = 0.05; s.size1 = 0.02; s.frame = VFX_FRAME.spark; s.stretch = 0.35;
      s.r0 = hot.r; s.g0 = hot.g; s.b0 = hot.b; s.r1 = body.r; s.g1 = body.g; s.b1 = body.b; s.a0 = 0.9; s.fadeIn = 0.03; s.fadeOut = 0.5;
      vfx.emit(vfx.particles.additive, ACTOR_VFX_OWNER);
    }
  }

  private diveDust(scale: number): void {
    const vfx = this.vfx, p = this.position;
    if (this.hero === 'vesper') {
      // Mist Blink: the body dissolves into an ink-smoke burst with violet-crimson sparks.
      vfx.smoke(p.x, p.y + 0.8, p.z, Math.round(10 * scale), 0.45, 0.8, 1.1, 0.9, UMBRAL_SMOKE, 0.6, ACTOR_VFX_OWNER, 1.1);
      vfx.sparks(p.x, p.y + 0.9, p.z, Math.round(8 * scale), 4, 'umbral', ACTOR_VFX_OWNER, 0.3);
      return;
    }
    if (this.hero === 'sakda') {
      // Guard Dash: a flare of flame wraps the dash like a shield.
      vfx.flash(p.x, p.y + 0.9, p.z, 1.6 * scale, 'ember', ACTOR_VFX_OWNER, 0.2);
      vfx.sparks(p.x, p.y + 0.9, p.z, Math.round(14 * scale), 5, 'ember', ACTOR_VFX_OWNER, 0.3);
      vfx.flames(p.x, p.y, p.z, Math.round(5 * scale), 0.5, 0.9, ACTOR_VFX_OWNER, 'ember');
      return;
    }
    if (this.hero === 'yara') {
      // Petal Step's roll leaves petals, not wind dust.
      emitPetalRing(vfx, ACTOR_VFX_OWNER, p.x, p.y, p.z, Math.round(10 * scale), 0.6 * scale);
      emitPetalSwirl(vfx, ACTOR_VFX_OWNER, p.x, p.y, p.z, Math.round(8 * scale), 0.5, 1.6, 1);
      return;
    }
    vfx.dustRing(p.x, p.y, p.z, 0.6 * scale, Math.round(10 * scale), ACTOR_VFX_OWNER);
    vfx.smoke(p.x, p.y, p.z, Math.round(5 * scale), 0.35, 0.35, 0.8, 0.8, VFX_COLORS.dust, 0.45, ACTOR_VFX_OWNER, 1.1);
  }

  /** Landing dust scaled by the fall: the larger of the height above the landing root and the free-fall height of the time spent falling. */
  private landingDust(): void {
    const vfx = this.vfx, p = this.position, state = this.player, fall = state.fallSince >= 0 ? Math.max(0, vfx.time - state.fallSince) : 0;
    const height = Math.max(0, state.peakY - p.y, 0.5 * GRAVITY * fall * fall), scale = Math.min(1.8, Math.max(0.6, 0.6 + 0.45 * height));
    this.lastLandingScale = scale;
    state.fallSince = -1;
    if (this.hero === 'yara') emitPetalRing(vfx, ACTOR_VFX_OWNER, p.x, p.y, p.z, Math.round(8 * scale), 0.7 * scale);
    else if (this.hero === 'sakda') vfx.embers(p.x, p.y + 0.1, p.z, Math.round(6 * scale), 0.5 * scale, 1.4, -0.3, ACTOR_VFX_OWNER, 'ember');
    else if (this.hero === 'vesper') vfx.sparks(p.x, p.y + 0.1, p.z, Math.round(5 * scale), 2.5, 'umbral', ACTOR_VFX_OWNER, 0.3);
    vfx.dustRing(p.x, p.y, p.z, 0.7 * scale, Math.round(12 * scale), ACTOR_VFX_OWNER);
    vfx.smoke(p.x, p.y, p.z, Math.round(4 * scale), 0.3 * scale, 0.3, 0.7, 0.7, VFX_COLORS.dust, 0.4, ACTOR_VFX_OWNER, 0.8 * scale);
  }

  private speedStreaks(actor: ActorSnapshot, dt: number): void {
    const vfx = this.vfx, yara = this.hero === 'yara', hot = this.hero === 'aren' || yara ? PALETTE.wind.hot : PALETTE[heroElement(this.hero)].hot;
    this.streakAcc += dt * (yara ? 22 : 60) * (vfx.reducedEffects ? 0.35 : 1);
    for (; this.streakAcc >= 1; this.streakAcc--) {
      const p = vfx.spec();
      p.x = this.position.x + vfx.range(-0.45, 0.45); p.y = this.position.y + vfx.range(0.25, 1.5); p.z = this.position.z + vfx.range(-0.45, 0.45);
      p.vx = -actor.velocity.x * 0.35; p.vz = -actor.velocity.z * 0.35;
      if (yara) {
        // Petal Step roll: amber/pink petals stream behind and drift down.
        p.vy = vfx.range(0.2, 0.9); p.gravity = 0.6; p.drag = 1.8; p.frame = VFX_FRAME.leaf; p.life = vfx.range(0.4, 0.7); p.size0 = vfx.range(0.1, 0.17); p.size1 = 0.04;
        p.spin = vfx.random() * 6; p.spinRate = vfx.range(-6, 6); p.r0 = p.r1 = 1; p.g0 = p.g1 = vfx.random() < 0.5 ? 0.55 : 0.88; p.b0 = p.b1 = vfx.random() < 0.5 ? 0.62 : 0.76; p.a0 = 0.85; p.fadeIn = 0.05; p.fadeOut = 0.6;
        vfx.emit(vfx.particles.alpha, ACTOR_VFX_OWNER);
        continue;
      }
      p.vy = 0; p.drag = 3;
      p.life = vfx.range(0.18, 0.3); p.size0 = 0.06; p.size1 = 0.02; p.frame = 2; p.stretch = 0.25;
      p.r0 = p.r1 = hot.r; p.g0 = p.g1 = hot.g; p.b0 = p.b1 = hot.b; p.a0 = 0.55; p.fadeIn = 0.1; p.fadeOut = 0.4;
      vfx.emit(vfx.particles.additive, ACTOR_VFX_OWNER);
    }
  }

  /**
   * The live tether while the action runs and a target is locked. Aren: a root lash (spirit-green beam) from the hand wrapped in a second,
   * thin cyan wind beam, with leaves along the root and cyan motes spiralling round it. Yara: an amber vine lash from the staff head with petals.
   */
  private updateTether(actor: ActorSnapshot, targetId: string, dt: number): void {
    const vfx = this.vfx, yara = this.hero === 'yara', time = vfx.time;
    this.tether ??= vfx.beams.acquire(ACTOR_VFX_OWNER, time, 0, yara ? 0.2 : 0.16, yara ? 0.3 : 0.22, yara ? 'heartroot' : 'spirit');
    if (!this.tether) return;
    if (!yara) this.wind ??= vfx.beams.acquire(ACTOR_VFX_OWNER, time, 0, 0.07, 0.55, 'arcane');
    const tip = yara ? this.resolveSocket?.('aren', 'weapon-tip') : undefined;
    if (tip) { tip.updateWorldMatrix(true, false); tip.getWorldPosition(this.tether.a); } else {
      this.hand.resolve(this.resolveActorRoot?.(actor.id));
      const hand = this.hand.hand;
      if (hand) { hand.updateWorldMatrix(true, false); hand.getWorldPosition(this.tether.a); }
      else this.tether.a.set(this.position.x + actor.facing.x * 0.4, this.position.y + 1.2, this.position.z + actor.facing.z * 0.4);
    }
    const cast = this.resolveSocket?.(targetId, 'cast'), root = cast ? undefined : this.resolveSocket?.(targetId, 'root');
    const anchor = cast ?? root;
    if (anchor) {
      anchor.updateWorldMatrix(true, false);
      anchor.getWorldPosition(this.tether.b);
      if (!cast) this.tether.b.y += 0.9;
    } else this.tether.b.copy(this.tether.a).addScaledVector(this.a.set(actor.facing.x, 0, actor.facing.z), 4);
    if (this.wind) { this.wind.a.copy(this.tether.a); this.wind.b.copy(this.tether.b); }
    this.dir.subVectors(this.tether.b, this.tether.a);
    const length = this.dir.length();
    if (length < 1e-4) return;
    this.dir.divideScalar(length);
    this.side.crossVectors(this.dir, this.up.set(0, 1, 0));
    if (this.side.lengthSq() < 1e-6) this.side.set(1, 0, 0);
    this.side.normalize();
    this.up.crossVectors(this.dir, this.side);
    this.tetherAcc += dt * 42 * (vfx.reducedEffects ? 0.35 : 1);
    const hot = PALETTE.arcane.hot, body = PALETTE.arcane.b;
    for (; this.tetherAcc >= 1; this.tetherAcc--) {
      const s = vfx.random(), theta = time * 13 + s * length * 5, p = vfx.spec();
      this.a.lerpVectors(this.tether.a, this.tether.b, s);
      if (yara) {
        // Pollen and petals shed from the vine.
        p.x = this.a.x; p.y = this.a.y; p.z = this.a.z; p.vy = vfx.range(0.3, 0.9); p.vx = vfx.range(-0.3, 0.3); p.vz = vfx.range(-0.3, 0.3); p.gravity = 0.4; p.drag = 0.8;
        p.frame = VFX_FRAME.leaf; p.life = vfx.range(0.5, 0.9); p.size0 = vfx.range(0.09, 0.15); p.size1 = 0.03; p.spin = vfx.random() * 6; p.spinRate = vfx.range(-5, 5);
        p.r0 = p.r1 = 1; p.g0 = p.g1 = vfx.random() < 0.5 ? 0.55 : 0.88; p.b0 = p.b1 = vfx.random() < 0.5 ? 0.62 : 0.76; p.a0 = 0.85; p.fadeIn = 0.05; p.fadeOut = 0.6;
        vfx.emit(vfx.particles.alpha, ACTOR_VFX_OWNER);
        continue;
      }
      const cos = Math.cos(theta) * 0.2, sin = Math.sin(theta) * 0.2;
      p.x = this.a.x + this.side.x * cos + this.up.x * sin; p.y = this.a.y + this.side.y * cos + this.up.y * sin; p.z = this.a.z + this.side.z * cos + this.up.z * sin;
      p.life = 0.16; p.size0 = 0.07; p.size1 = 0.03; p.frame = VFX_FRAME.mote;
      p.r0 = hot.r; p.g0 = hot.g; p.b0 = hot.b; p.r1 = body.r; p.g1 = body.g; p.b1 = body.b; p.a0 = 0.85; p.fadeIn = 0.1; p.fadeOut = 0.6;
      vfx.emit(vfx.particles.additive, ACTOR_VFX_OWNER);
    }
    if (!yara && vfx.random() < 0.35) {
      this.a.lerpVectors(this.tether.a, this.tether.b, vfx.random());
      vfx.leaves(this.a.x, this.a.y - 0.2, this.a.z, 1, 0.1, 0, 0, ACTOR_VFX_OWNER);
    }
  }

  private releaseTether(): void {
    if (this.tether) { this.vfx.beams.release(this.tether); this.tether = undefined; }
    if (this.wind) { this.vfx.beams.release(this.wind); this.wind = undefined; }
    this.tetherAcc = 0;
  }

  // ---- monster auras ----

  private aura(actor: ActorSnapshot, theme: AuraTheme, dt: number): void {
    const vfx = this.vfx, root = this.resolveActorRoot?.(actor.id);
    this.rootPosition(actor, this.position);
    const body = root ? this.bodies.get(root) : DEFAULT_BODY;
    let acc = this.auraAcc.get(actor.id);
    if (!acc) { acc = new Float64Array(5); this.auraAcc.set(actor.id, acc); }
    const boost = this.isCharging(actor.id) ? 3 : 1, scale = dt * boost * (vfx.reducedEffects ? 0.35 : 1);
    const p = this.position, r = body.radius, h = body.height, owner = ACTOR_VFX_OWNER;
    if (theme === 'ember') {
      for (let n = this.auraDue(acc, 0, 9 * scale); n > 0; n--) vfx.embers(p.x, p.y + h * vfx.range(0.3, 0.8), p.z, 1, r * 0.8, 0.7, -0.4, owner);
      for (let n = this.auraDue(acc, 1, 2.5 * scale); n > 0; n--) vfx.glow(p.x, p.y + h * 0.5, p.z, r * 1.5, 0.9, 'fire', 0.05 * Math.min(boost, 2), owner, 0.2);
    } else if (theme === 'frost') {
      for (let n = this.auraDue(acc, 0, 5 * scale); n > 0; n--) vfx.smoke(p.x, p.y, p.z, 1, r, 0.05, 1.1, 1.6, VFX_COLORS.steam, 0.22, owner, 0.25);
      for (let n = this.auraDue(acc, 1, 6 * scale); n > 0; n--) this.drip(p.x + vfx.range(-r, r) * 0.6, p.y + h * vfx.range(0.35, 0.65), p.z + vfx.range(-r, r) * 0.6, 'poison');
      for (let n = this.auraDue(acc, 2, 4 * scale); n > 0; n--) vfx.glow(p.x + vfx.range(-r, r), p.y + h * vfx.range(0.2, 1), p.z + vfx.range(-r, r), 0.12, 0.8, 'ice', 0.5, owner, 0.25);
    } else if (theme === 'howler') {
      // Black-sap howler: grit and dust at the feet, sap weeping from the hide, earth and sap glints.
      for (let n = this.auraDue(acc, 0, 5 * scale); n > 0; n--) vfx.smoke(p.x, p.y, p.z, 1, r, 0.12, 0.9, 1.2, VFX_COLORS.dust, 0.28, owner, 0.3);
      for (let n = this.auraDue(acc, 1, 5 * scale); n > 0; n--) this.drip(p.x + vfx.range(-r, r) * 0.6, p.y + h * vfx.range(0.3, 0.7), p.z + vfx.range(-r, r) * 0.6, 'sap');
      for (let n = this.auraDue(acc, 2, 5 * scale); n > 0; n--) vfx.glow(p.x + vfx.range(-r, r), p.y + vfx.range(0.1, h), p.z + vfx.range(-r, r), 0.1, 1, 'earth', 0.5, owner, 0.3);
      for (let n = this.auraDue(acc, 3, 2 * scale); n > 0; n--) vfx.bubbles(p.x, p.y + h * 0.3, p.z, 1, r * 0.6, owner, 'sap');
    } else if (theme === 'storm') {
      // Storm hornbill: wind streaks circle the body, storm-blue glints and sparks, loose slate feathers; the root is the drawn (hovering) body.
      const hot = PALETTE.wind.hot;
      for (let n = this.auraDue(acc, 0, 8 * scale); n > 0; n--) {
        const angle = vfx.random() * Math.PI * 2, radius = r * vfx.range(0.9, 1.4), s = vfx.spec();
        s.x = p.x + Math.cos(angle) * radius; s.y = p.y + h * vfx.range(0.2, 0.9); s.z = p.z + Math.sin(angle) * radius;
        s.vx = -Math.sin(angle) * 4.5; s.vz = Math.cos(angle) * 4.5; s.drag = 1.5; s.life = vfx.range(0.3, 0.5); s.size0 = 0.07; s.size1 = 0.03; s.frame = VFX_FRAME.spark; s.stretch = 0.16;
        s.r0 = s.r1 = hot.r; s.g0 = s.g1 = hot.g; s.b0 = s.b1 = hot.b; s.a0 = 0.5; s.fadeIn = 0.15; s.fadeOut = 0.5;
        vfx.emit(vfx.particles.additive, owner);
      }
      for (let n = this.auraDue(acc, 1, 4 * scale); n > 0; n--) vfx.glow(p.x + vfx.range(-r, r), p.y + h * vfx.range(0.2, 1), p.z + vfx.range(-r, r), 0.12, 0.7, 'lightning', 0.5, owner, 0.2);
      for (let n = this.auraDue(acc, 2, 2.5 * scale); n > 0; n--) emitStormFeather(vfx, owner, p.x + vfx.range(-r, r) * 0.7, p.y + h * vfx.range(0.2, 0.8), p.z + vfx.range(-r, r) * 0.7, 0, 0, 0);
      for (let n = this.auraDue(acc, 3, 2 * scale); n > 0; n--) vfx.sparks(p.x, p.y + h * 0.6, p.z, 1, 1.4, 'lightning', owner, 0.3);
    } else if (theme === 'toxic') {
      // Mire viper: low venom fume, poison drips and bubbles at the coils.
      for (let n = this.auraDue(acc, 0, 5 * scale); n > 0; n--) vfx.smoke(p.x, p.y, p.z, 1, r, 0.1, 1, 1.5, VENOM, 0.22, owner, 0.25);
      for (let n = this.auraDue(acc, 1, 6 * scale); n > 0; n--) this.drip(p.x + vfx.range(-r, r) * 0.6, p.y + h * vfx.range(0.3, 0.7), p.z + vfx.range(-r, r) * 0.6, 'poison');
      for (let n = this.auraDue(acc, 2, 4 * scale); n > 0; n--) vfx.bubbles(p.x, p.y, p.z, 1, r, owner, 'poison');
      for (let n = this.auraDue(acc, 3, 3 * scale); n > 0; n--) vfx.glow(p.x + vfx.range(-r, r), p.y + h * vfx.range(0.2, 0.9), p.z + vfx.range(-r, r), 0.1, 0.8, 'poison', 0.5, owner, 0.25);
    } else if (theme === 'heartlight') {
      // Hollowheart: the howler's grit and weeping sap, and the cracked heart-light in the chest: a warm amber glow that breathes (and flares while it charges) and embers lifting off it.
      for (let n = this.auraDue(acc, 0, 4 * scale); n > 0; n--) vfx.smoke(p.x, p.y, p.z, 1, r, 0.12, 0.9, 1.2, VFX_COLORS.dust, 0.28, owner, 0.3);
      for (let n = this.auraDue(acc, 1, 4 * scale); n > 0; n--) this.drip(p.x + vfx.range(-r, r) * 0.6, p.y + h * vfx.range(0.3, 0.7), p.z + vfx.range(-r, r) * 0.6, 'sap');
      const hx = p.x + actor.facing.x * r * 0.5, hz = p.z + actor.facing.z * r * 0.5, hy = p.y + h * 0.62;
      for (let n = this.auraDue(acc, 2, 6 * dt * (vfx.reducedEffects ? 0.6 : 1) * (1 + (boost - 1) * 0.25)); n > 0; n--) vfx.glow(hx, hy, hz, h * 0.3, 0.9, 'fire', 0.3 * Math.min(boost, 1.5), owner, 0);
      for (let n = this.auraDue(acc, 3, 5 * scale); n > 0; n--) vfx.embers(hx, hy, hz, 1, r * 0.35, 0.9, -0.5, owner);
      // A wide, very faint amber backlight of the heart-light round the body (low alpha, amber, never white): it lifts the guardian's silhouette off the dark sap-mud floor without veiling it.
      for (let n = this.auraDue(acc, 4, 2 * dt * (vfx.reducedEffects ? 0.6 : 1)); n > 0; n--) vfx.glow(p.x, p.y + h * 0.35, p.z, h * 1.3, 1.2, 'fire', 0.028, owner, 0);
    } else {
      for (let n = this.auraDue(acc, 0, 5 * scale); n > 0; n--) vfx.smoke(p.x, p.y, p.z, 1, r, 0.15, 0.9, 1.2, VFX_COLORS.dust, 0.28, owner, 0.3);
      for (let n = this.auraDue(acc, 1, 2.5 * scale); n > 0; n--) vfx.leaves(p.x, p.y + h * 0.5, p.z, 1, r, 0, 0, owner);
      for (let n = this.auraDue(acc, 2, 6 * scale); n > 0; n--) vfx.glow(p.x + vfx.range(-r, r), p.y + vfx.range(0.1, h), p.z + vfx.range(-r, r), 0.1, 1, 'earth', 0.5, owner, 0.35);
    }
  }

  /** Whole emissions due from one accumulator channel for `amount` fractional spawns. */
  private auraDue(acc: Float64Array, index: number, amount: number): number {
    const value = acc[index]! + amount, whole = Math.floor(value);
    acc[index] = value - whole;
    return whole;
  }

  private drip(x: number, y: number, z: number, element: VfxElement): void {
    const vfx = this.vfx, color = PALETTE[element].hot, p = vfx.spec();
    p.x = x; p.y = y; p.z = z; p.gravity = 6; p.life = 0.5; p.size0 = 0.06; p.size1 = 0.04; p.frame = 3;
    p.r0 = p.r1 = color.r; p.g0 = p.g1 = color.g; p.b0 = p.b1 = color.b; p.a0 = 0.9; p.fadeIn = 0.05; p.fadeOut = 0.7;
    vfx.emit(vfx.particles.additive, ACTOR_VFX_OWNER);
  }

  private rootPosition(actor: ActorSnapshot, out: Vector3): Vector3 {
    const root = this.resolveSocket?.(actor.id, 'root');
    if (root) { root.updateWorldMatrix(true, false); return root.getWorldPosition(out); }
    return out.set(actor.position.x, actor.position.y, actor.position.z);
  }
}
