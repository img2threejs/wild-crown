import { Color, Vector3, type Object3D } from 'three';
import { ATTACKS } from '../../game/combat/content.js';
import type { StoryCue } from '../story-cues.js';
import { BAMBOO_ATTACK_KITS, createBambooKits, type BambooKitId } from './BambooKits.js';
import { CanopyKits, isCanopyKit, type CanopyKitId } from './CanopyKits.js';
import { GROVE_ATTACK_KITS, createGroveKits, type GroveKitId } from './GroveKits.js';
import { MISTVEIL_ATTACK_KITS, createMistveilKits, type MistveilKitId } from './MistveilKits.js';
import { MOONPINE_ATTACK_KITS, createMoonpineKits, type MoonpineKitId } from './MoonpineKits.js';
import { LATE_BOSS_ATTACK_KITS, createLateBossKits, type LateBossKitId } from './LateBossKits';
import { enemyAttackPresentationForId } from '../../rendering/EnemyAttackPresentation';
import { Footprint } from './footprint.js';
import type { GroundSlot } from './GroundFx.js';
import type { BeamSlot } from './RibbonFx.js';
import { OWNER_GLOW, PALETTE, type VfxElement } from './palette.js';
import { VFX_COLORS, type VfxSystem } from './VfxSystem.js';
import type { RockSlot } from './LobbedRocksFx.js';
import type { SigilSlot } from './SigilFx.js';
import { CONTACT_PRE_AGE, HitImpactFx } from './HitImpactFx.js';
import type { WardenFx } from './WardenFx.js';
import { HeartrootCues } from './HeartrootCues.js';
import { EmberCues } from './EmberCues.js';
import { UmbralCues } from './UmbralCues.js';
import { AREN_CLEANSE_ACTION, AREN_TETHER_ACTION, isEmberKit, isHeartrootKit, isUmbralKit, resolveEmberKit, resolveHeartrootKit, resolveUmbralKit, type EmberKitId, type HeartrootKitId, type UmbralKitId } from './HeroKits.js';

/** Presentation-only impact feedback implemented by the renderer (camera shake, actor rim flash). */
export interface ImpactSink {
  shake(amplitude: number, durationSeconds: number, frequency: number): void;
  flashActor(actorId: string, color: Color, intensity: number, durationSeconds: number, mode: 'hit' | 'charge'): void;
  /** Brief full-screen radial blur / chromatic punch (0..1 strength); optional so older sinks keep working. */
  impulse?(strength: number, durationSeconds: number): void;
  /** Sap Lance: the actor's held Heartroot staff leaves the fist toward `to` (world) and returns by itself; optional so sinks without a staff keep working. */
  throwStaff?(actorId: string, to: { readonly x: number; readonly y: number; readonly z: number }): void;
}
export type SocketResolver = (actorId: string, socketName: string) => Object3D | undefined;

/**
 * One story map's monster kits (attack id = kit id, like CanopyKits), built by its factory with the same collaborators.
 * Per-slot state lives inside the family (e.g. a WeakMap keyed by slot); `begin` receives the phase length in seconds and
 * `update` the phase progress `t` in 0..1.
 */
export interface MapKitFamily {
  owns(kit: string): boolean;
  begin(slot: KitSlot, seconds: number): void;
  update(slot: KitSlot, worldTick: number, dt: number, t: number): void;
  end(slot: KitSlot, natural: boolean): void;
  setImpactSink(impact: ImpactSink | undefined): void;
}

export type KitId =
  | 'ember-lance' | 'cinder-burst' | 'frost-bloom' | 'venom-mist' | 'gale' | 'fissure' | 'charge' | 'slam' | 'sap-burst'
  | 'roar' | 'landing' | 'staff-hit' | 'contact' | 'gather' | 'beam' | 'pulse' | 'vein' | 'footprint'
  | 'sigil' | 'slash' | 'projectile' | 'projectile-impact' | 'lightning' | 'judgement' | 'judgement-mark' | 'player-hit'
  | 'cleanse' | 'root-lash' | HeartrootKitId | UmbralKitId | EmberKitId
  | CanopyKitId | GroveKitId | MoonpineKitId | MistveilKitId | BambooKitId | LateBossKitId;

/** Kits driven by the Warden arsenal (`WardenCues`) rather than the monster element kits. */
export const WARDEN_KITS: Readonly<Partial<Record<KitId, true>>> = {
  sigil: true, slash: true, projectile: true, 'projectile-impact': true, lightning: true, judgement: true, 'judgement-mark': true, 'player-hit': true, cleanse: true, 'root-lash': true,
};
const WARDEN_CUE_KITS: Readonly<Partial<Record<StoryCue['kind'], KitId>>> = {
  sigil: 'sigil', slash: 'slash', projectile: 'projectile', 'projectile-impact': 'projectile-impact', lightning: 'lightning', judgement: 'judgement', 'judgement-mark': 'judgement-mark',
};

const ATTACK_KITS: Readonly<Record<string, readonly [KitId, VfxElement]>> = {
  'boar-ember-lance': ['ember-lance', 'fire'],
  'root-rammer-cinder-burst': ['cinder-burst', 'fire'],
  'sap-stalker-frost-bloom': ['frost-bloom', 'ice'],
  'sap-stalker-venom-mist': ['venom-mist', 'poison'],
  'boar-gale-scythe': ['gale', 'wind'],
  'root-rammer-gale-sweep': ['gale', 'wind'],
  'root-rammer-low-wave': ['fissure', 'earth'],
  'sap-vein-snap': ['fissure', 'sap'],
  'boar-charge': ['charge', 'earth'],
  'boar-pounce': ['slam', 'earth'],
  'root-rammer-slam': ['slam', 'earth'],
  'boar-sap-thrash': ['sap-burst', 'sap'],
  'sap-vein-thrash': ['sap-burst', 'sap'],
  // Whispering Canopy playtest: the attack id is the kit id (see CanopyKits).
  'howler-rock-hurl': ['howler-rock-hurl', 'earth'],
  'howler-leap-slam': ['howler-leap-slam', 'earth'],
  'howler-branch-sweep': ['howler-branch-sweep', 'wind'],
  'hornbill-dive-bomb': ['hornbill-dive-bomb', 'wind'],
  'hornbill-feather-volley': ['hornbill-feather-volley', 'wind'],
  'hornbill-gale-flap': ['hornbill-gale-flap', 'wind'],
  'viper-venom-spit': ['viper-venom-spit', 'poison'],
  'viper-tail-lash': ['viper-tail-lash', 'poison'],
  'viper-strike-lunge': ['viper-strike-lunge', 'poison'],
  ...GROVE_ATTACK_KITS, ...MOONPINE_ATTACK_KITS, ...MISTVEIL_ATTACK_KITS, ...BAMBOO_ATTACK_KITS, ...LATE_BOSS_ATTACK_KITS,
};
export function enemyAttackKit(attackId: string): readonly [KitId, VfxElement] | undefined { return ATTACK_KITS[attackId]; }
const STORY_ELEMENTS: Readonly<Partial<Record<StoryCue['kind'], VfxElement>>> = {
  'restoration-water': 'ice', 'restoration-roots': 'earth', dominion: 'fire', possession: 'poison', grovebreak: 'fire', 'ending-dominion': 'fire', 'sap-vein': 'sap',
};
/** Detonation shake within 6 m of the player, scaled by kit weight. */
const SHAKE_WEIGHT: Readonly<Partial<Record<KitId, number>>> = {
  'cinder-burst': 0.3, 'frost-bloom': 0.2, 'ember-lance': 0.16, slam: 0.22, fissure: 0.16, 'sap-burst': 0.14, gale: 0.1, charge: 0.12, 'venom-mist': 0.05, roar: 0.2,
};
const SHAKE_RADIUS = 6;
const VENOM = new Color().setRGB(0.22, 0.42, 0.08);
const AMBER = new Color().setRGB(0.5, 0.36, 0.1);

export function resolveKit(cue: StoryCue): { kit: KitId; element: VfxElement; attack: boolean } {
  const attackId = cue.attackId;
  if (attackId && ATTACKS[attackId]) {
    const authored = ATTACK_KITS[attackId];
    if (!authored) throw new Error(`Missing authored enemy VFX kit: ${attackId}`);
    return { kit: cue.phase === 'hit' ? 'contact' : authored[0], element: authored[1], attack: true };
  }
  if (cue.element === 'heartroot') return { kit: resolveHeartrootKit(cue), element: 'heartroot', attack: false };
  if (cue.element === 'umbral') return { kit: resolveUmbralKit(cue), element: 'umbral', attack: false };
  if (cue.element === 'ember') return { kit: resolveEmberKit(cue), element: 'ember', attack: false };
  if (cue.kind === 'roar-cone') return { kit: 'roar', element: 'earth', attack: true };
  if (cue.kind === 'landing') return { kit: 'landing', element: 'earth', attack: false };
  if (cue.kind === 'cleanse' && cue.actionId === AREN_CLEANSE_ACTION) return { kit: 'cleanse', element: 'arcane', attack: false };
  if (cue.kind === 'tether' && cue.actionId === AREN_TETHER_ACTION) return { kit: 'root-lash', element: 'spirit', attack: false };
  const warden = WARDEN_CUE_KITS[cue.kind];
  if (warden) return { kit: warden, element: cue.element ?? 'arcane', attack: false };
  if (cue.kind === 'hit' && cue.actorId === 'aren' && (cue.element === 'arcane' || cue.element === 'lightning')) return { kit: 'player-hit', element: cue.element, attack: false };
  if (attackId?.startsWith('aren-')) return { kit: cue.phase === 'hit' ? 'staff-hit' : 'gather', element: attackId.includes('tether') ? 'spirit' : 'arcane', attack: false };
  const element = STORY_ELEMENTS[cue.kind] ?? 'spirit';
  if (cue.kind === 'pounce') return { kit: 'slam', element: 'earth', attack: false };
  if (cue.kind === 'low-wave') return { kit: 'fissure', element: 'earth', attack: false };
  if (cue.kind === 'sap-vein') return { kit: 'vein', element, attack: false };
  if (cue.kind === 'footprint') return { kit: 'footprint', element: 'earth', attack: false };
  if (cue.kind === 'hit') return { kit: 'contact', element, attack: false };
  if (cue.kind === 'anticipation' || cue.kind === 'commit') return { kit: 'gather', element, attack: false };
  const shape = cue.shape;
  if (shape === 'beam' || shape === 'trail' || cue.kind === 'tether' || cue.kind === 'heartroot' || cue.kind === 'bond') return { kit: 'beam', element, attack: false };
  return { kit: 'pulse', element, attack: false };
}

/** Per-cue runtime state, preallocated per StoryEffects slot and reused across cues. */
export class KitSlot {
  cue!: StoryCue;
  kit: KitId = 'pulse';
  element: VfxElement = 'spirit';
  /** Owner identity tint for cracks, ember specks and the caster's charge rim. */
  glow: VfxElement = 'spirit';
  attack = false;
  owner = 0;
  readonly footprint = new Footprint();
  readonly aux = new Footprint();
  hasFootprint = false;
  phaseStart = 0;
  end = 1;
  readonly origin = new Vector3();
  readonly target = new Vector3();
  socket: Object3D | undefined;
  ground: GroundSlot | undefined;
  beam: BeamSlot | undefined;
  /** Fractional emission carry per continuous stream (1-based stream ids in `due`). */
  readonly acc = new Float64Array(4);
  lastTime = 0;
  pulses = 0;
  /** Warden sigil handles (vertical rune circle, ground circle) and whether they track Aren's facing. */
  sigil: SigilSlot | undefined;
  sigilGround: SigilSlot | undefined;
  tracked = false;
  /** Whispering Canopy: the sap-bound rock a Howler holds (anticipation) or hurls (commit). */
  rock: RockSlot | undefined;
}

/** Drives one cue's three-phase look (anticipation → active → decay) from authored cue geometry. */
export class CueKits {
  readonly focus = new Vector3();
  hasFocus = false;
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly c = new Vector3();

  private readonly canopy: CanopyKits;
  private readonly hitImpact: HitImpactFx;
  private readonly mapKits: readonly MapKitFamily[];
  private readonly heartroot: HeartrootCues;
  private readonly umbral: UmbralCues;
  private readonly ember: EmberCues;

  constructor(private readonly vfx: VfxSystem, private readonly resolveSocket?: SocketResolver, private impact?: ImpactSink, private readonly warden?: WardenFx) {
    this.canopy = new CanopyKits(vfx, resolveSocket, impact, this);
    this.mapKits = [createGroveKits, createMoonpineKits, createMistveilKits, createBambooKits, createLateBossKits].map(create => create(vfx, resolveSocket, impact, this));
    this.heartroot = new HeartrootCues(vfx, warden);
    this.umbral = new UmbralCues(vfx, warden);
    this.ember = new EmberCues(vfx, warden);
    this.hitImpact = new HitImpactFx(vfx, id => this.warden?.resolveActorRoot?.(id), warden?.bodies);
  }

  setImpactSink(impact: ImpactSink | undefined): void {
    this.impact = impact;
    this.canopy.setImpactSink(impact);
    for (const family of this.mapKits) family.setImpactSink(impact);
  }

  private mapFamily(kit: KitId): MapKitFamily | undefined {
    return this.mapKits.find(family => family.owns(kit));
  }

  /**
   * A confirmed hit is drawn at the contact point on the frame the engine reports it: every particle starts with a little age (the world
   * clock freezes during hit-stop), then the kit's own accent and the shared blood/material/ground layer follow.
   */
  begin(slot: KitSlot, worldTick: number): void {
    const cue = slot.cue;
    if (cue.kind !== 'hit' && cue.kind !== 'projectile-impact') { this.beginKit(slot, worldTick); return; }
    this.vfx.beginContact(CONTACT_PRE_AGE);
    try { this.beginKit(slot, worldTick); } finally { this.vfx.endContact(); }
    if (cue.kind === 'hit') this.hitImpact.play(cue, slot.element, slot.owner);
  }

  private beginKit(slot: KitSlot, worldTick: number): void {
    const cue = slot.cue, vfx = this.vfx, time = vfx.time;
    slot.phaseStart = cue.phaseStartedAtWorldTick ?? cue.worldTick;
    slot.acc.fill(0); slot.pulses = 0; slot.lastTime = time;
    slot.glow = (cue.actorId ? OWNER_GLOW[cue.actorId] : undefined) ?? slot.element;
    const anatomy = cue.attackId ? enemyAttackPresentationForId(cue.attackId) : undefined;
    const weapon = cue.actorId && anatomy?.socket.startsWith('weapon-') ? this.resolveSocket?.(cue.actorId, 'weapon-tip') : undefined;
    slot.socket = cue.actorId ? weapon ?? (anatomy ? this.resolveSocket?.(cue.actorId, `enemy:${anatomy.socket}:tip`) : this.resolveSocket?.(cue.actorId, 'cast')) : undefined;
    slot.hasFootprint = Boolean(cue.footprint && (cue.position || cue.to));
    slot.footprint.setFromCue(cue, slot.kit === 'pulse' ? 1.6 : 1.2);
    const target = cue.to ?? cue.position;
    slot.target.set(target?.x ?? slot.footprint.cx, target?.y ?? slot.footprint.cy, target?.z ?? slot.footprint.cz);
    this.socketPosition(slot, slot.origin);
    const phase = cue.phase, seconds = Math.max(0.05, (slot.end - worldTick) / 60);
    slot.sigil = undefined; slot.sigilGround = undefined; slot.tracked = false;
    if (isHeartrootKit(slot.kit)) { this.heartroot.begin(slot); return; }
    if (isUmbralKit(slot.kit)) { this.umbral.begin(slot); return; }
    if (isEmberKit(slot.kit)) { this.ember.begin(slot); return; }
    if (WARDEN_KITS[slot.kit]) { this.warden?.cues.begin(slot); return; }
    if (isCanopyKit(slot.kit)) { this.canopy.begin(slot, seconds); return; }
    const family = this.mapFamily(slot.kit);
    if (family) { family.begin(slot, seconds); return; }
    if (slot.kit === 'roar' && cue.kind === 'roar-cone') { this.beginRoarCone(slot, seconds); return; }
    if (slot.kit === 'landing') { this.landing(slot); return; }
    if (slot.kit === 'staff-hit') { this.staffHit(slot); return; }
    if (slot.kit === 'contact') { this.contact(slot); return; }
    if (slot.kit === 'footprint') { vfx.smoke(slot.footprint.cx, slot.footprint.cy, slot.footprint.cz, 4, 0.3, 0.3, 0.5, 0.8, VFX_COLORS.dust, 0.4, slot.owner, 0.6); return; }
    if (slot.kit === 'beam') {
      slot.beam = vfx.beams.acquire(slot.owner, time, 0, 0.2, 0.14, slot.element);
      return;
    }
    if (slot.kit === 'vein') { slot.ground = vfx.ground.spawn('fill', slot.footprint, slot.element, slot.owner, time, 0, 0.6); return; }
    if (slot.kit === 'pulse') {
      vfx.ground.spawn('shock', this.disk(slot, 1.6), slot.element, slot.owner, time, Math.min(0.7, seconds));
      vfx.glow(slot.footprint.cx, slot.footprint.cy + 0.6, slot.footprint.cz, 1.6, 0.5, slot.element, 0.6, slot.owner);
      return;
    }
    if (slot.kit === 'gather') return;
    if (phase === 'anticipation' || phase === 'commit') {
      if (slot.hasFootprint) slot.ground = vfx.ground.spawn('fill', slot.footprint, slot.element, slot.owner, time, 0);
      if (phase === 'anticipation' && cue.actorId) this.impact?.flashActor(cue.actorId, PALETTE[slot.glow].b, slot.element === 'earth' ? 0.9 : 1.3, seconds, 'charge');
      if (phase === 'commit' && slot.kit === 'gale') this.launchBlades(slot, seconds);
      return;
    }
    if (phase === 'active') this.detonate(slot, seconds);
  }

  update(slot: KitSlot, worldTick: number): void {
    if (isHeartrootKit(slot.kit)) { this.heartroot.update(slot); return; }
    if (isUmbralKit(slot.kit)) { this.umbral.update(slot); return; }
    if (isEmberKit(slot.kit)) { this.ember.update(slot); return; }
    if (WARDEN_KITS[slot.kit]) { this.warden?.cues.update(slot); return; }
    const vfx = this.vfx, time = vfx.time, dt = Math.max(0, time - slot.lastTime);
    slot.lastTime = time;
    const span = Math.max(1e-6, slot.end - slot.phaseStart), t = Math.min(1, Math.max(0, (worldTick - slot.phaseStart) / span));
    const cue = slot.cue, fp = slot.footprint, owner = slot.owner;
    const family = isCanopyKit(slot.kit) ? undefined : this.mapFamily(slot.kit);
    if (cue.phase === 'anticipation' && (family || isCanopyKit(slot.kit))) this.chargeCore(slot, t);
    if (isCanopyKit(slot.kit)) { this.canopy.update(slot, worldTick, dt, t); return; }
    if (family) { family.update(slot, worldTick, dt, t); return; }
    switch (slot.kit) {
      case 'beam': {
        if (!slot.beam) return;
        this.beamEndpoint(cue.actorId, cue.from, slot.beam.a, 1.1);
        this.beamEndpoint(cue.targetId, cue.to ?? cue.position, slot.beam.b, 1);
        slot.beam.alpha = Math.sin(Math.PI * Math.min(1, t * 1.02)) * 0.9 + 0.1;
        for (let n = this.due(slot, 14, dt); n > 0; n--) {
          this.a.lerpVectors(slot.beam.a, slot.beam.b, vfx.random());
          vfx.sparks(this.a.x, this.a.y, this.a.z, 1, 1.2, slot.element, owner, 0.6);
        }
        return;
      }
      case 'vein': if (slot.ground) vfx.ground.drive(slot.ground, Math.min(1, t * 1.5), 0.55, Math.min(1, (1 - t) * 4)); return;
      case 'pulse':
        for (let n = this.due(slot, 10, dt); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.2); vfx.glow(this.a.x, this.a.y, this.a.z, 0.22, 1.1, slot.element, 0.45, owner, 0.7); }
        return;
      case 'gather':
        this.socketPosition(slot, this.a);
        vfx.gather(this.a.x, this.a.y, this.a.z, this.due(slot, 30, dt), 0.6, slot.element, owner);
        return;
      case 'roar': if (cue.kind === 'roar-cone') { this.updateRoarCone(slot, t, dt); return; } break;
      default: break;
    }
    if (cue.phase === 'anticipation' || cue.phase === 'commit') {
      const progress = cue.phase === 'anticipation' ? t * 0.8 : 0.8 + 0.2 * t;
      const flicker = cue.phase === 'commit' && !vfx.reducedEffects ? 1 + 0.3 * Math.sin(time * 34) * t : 1;
      if (slot.ground) vfx.ground.drive(slot.ground, progress, (0.8 + 0.3 * progress) * flicker, Math.min(1, (worldTick - cue.worldTick) / 6 + 0.25));
      this.socketPosition(slot, this.a);
      if (cue.phase === 'anticipation') {
        vfx.gather(this.a.x, this.a.y, this.a.z, this.due(slot, slot.element === 'earth' ? 18 : 36, dt), 0.75, slot.element, owner);
        for (let n = this.due(slot, 6, dt, 2); n > 0; n--) vfx.glow(this.a.x, this.a.y, this.a.z, 0.35 + 0.35 * t, 0.3, slot.element, 0.35, owner);
        this.telegraphParticles(slot, t, dt);
        if (slot.element === 'earth' || slot.element === 'sap') for (let n = this.due(slot, 8, dt, 3); n > 0; n--) vfx.smoke(this.a.x, fp.cy, this.a.z, 1, 0.7, 0.4, 0.6, 0.7, VFX_COLORS.dust, 0.35, owner, 0.5);
      } else this.updateCommit(slot, t, dt);
      return;
    }
    if (cue.phase === 'active') this.updateActive(slot, t, dt);
  }

  /** Releases manual resources; natural expiry also emits the decay phase. */
  end(slot: KitSlot, natural: boolean): void {
    if (isHeartrootKit(slot.kit)) { this.heartroot.end(slot, natural); return; }
    if (isUmbralKit(slot.kit)) { this.umbral.end(slot, natural); return; }
    if (isEmberKit(slot.kit)) { this.ember.end(slot, natural); return; }
    if (WARDEN_KITS[slot.kit]) { this.warden?.cues.end(slot, natural); return; }
    if (isCanopyKit(slot.kit)) { this.canopy.end(slot, natural); return; }
    const family = this.mapFamily(slot.kit);
    if (family) { family.end(slot, natural); return; }
    if (slot.ground) { this.vfx.ground.release(slot.ground); slot.ground = undefined; }
    if (slot.beam) { this.vfx.beams.release(slot.beam); slot.beam = undefined; }
    slot.socket = undefined;
    if (natural && slot.cue.phase === 'active') this.decay(slot);
  }

  /**
   * Windup charge core: an element-coloured glow that swells on the monster's real `cast` socket (re-read from the rendered bone every
   * frame), so the telegraph reads from the body part that will strike. Short-lived blobs, one per frame, no pooled resources.
   */
  private chargeCore(slot: KitSlot, t: number): void {
    const point = this.socketPosition(slot, this.c);
    this.vfx.glow(point.x, point.y, point.z, 0.22 + 0.5 * t * t, 0.06, slot.element, 0.3 + 0.3 * t, slot.owner);
  }

  // ---- phases ----

  private detonate(slot: KitSlot, seconds: number): void {
    const vfx = this.vfx, time = vfx.time, fp = slot.footprint, owner = slot.owner, el = slot.element;
    const center = this.areaCenter(fp, this.c);
    const hw = fp.halfWidth, hl = fp.halfLength;
    const weight = SHAKE_WEIGHT[slot.kit] ?? 0.1;
    if (this.hasFocus) {
      const distance = Math.hypot(this.focus.x - center.x, this.focus.z - center.z);
      if (distance < SHAKE_RADIUS) this.impact?.shake(weight * (1 - distance / SHAKE_RADIUS), 0.32, 22);
    }
    switch (slot.kit) {
      case 'ember-lance': {
        fp.toWorld(0, -hl * 0.65, this.a, 0.6);
        vfx.flash(this.a.x, this.a.y, this.a.z, 2.4, 'fire', owner);
        vfx.ground.spawn('shock', fp, 'fire', owner, time, 0.45);
        vfx.ground.spawn('decal', fp, 'fire', owner, time, 5, 1, slot.glow);
        slot.ground = vfx.ground.spawn('burn', fp, 'fire', owner, time, 0, 1);
        for (let i = 0; i < 6; i++) { fp.toWorld(0, -hl + (2 * hl * (i + 0.5)) / 6, this.a, 0.2); vfx.sparks(this.a.x, this.a.y, this.a.z, 9, 6, 'fire', owner); }
        vfx.lights.pulse(center.x, center.y + 1.2, center.z, PALETTE.fire.hot, 6, 8, 0.55, time, owner);
        break;
      }
      case 'cinder-burst': {
        const r = Math.max(hw, hl);
        vfx.flash(center.x, center.y + 0.8, center.z, r * 3.2, 'fire', owner, 0.26);
        vfx.flames(center.x, center.y, center.z, 26, r * 0.55, 1.5, owner);
        for (let i = 0; i < 3; i++) vfx.glow(center.x + vfx.range(-0.4, 0.4) * r, center.y + vfx.range(0.4, 1.4), center.z + vfx.range(-0.4, 0.4) * r, r * 1.3, 0.45, 'fire', 0.3, owner, 1.2);
        vfx.ground.spawn('shock', fp, 'fire', owner, time, 0.5);
        vfx.ground.spawn('decal', fp, 'fire', owner, time, 5.5, 1, slot.glow);
        vfx.embers(center.x, center.y + 0.4, center.z, 50, r * 0.45, 4.2, 6.5, owner);
        vfx.sparks(center.x, center.y + 0.3, center.z, 30, 8, 'fire', owner, 0.4);
        vfx.chunks(center.x, center.y + 0.1, center.z, 8, 4.2, 0.24, owner, false, fp);
        vfx.smoke(center.x, center.y + 0.6, center.z, 10, r * 0.5, 1.3, 1.6, 1.6, VFX_COLORS.smoke, 0.55, owner, 0.8);
        vfx.lights.pulse(center.x, center.y + 1.3, center.z, PALETTE.fire.hot, 8, 9, 0.65, time, owner);
        break;
      }
      case 'frost-bloom': {
        const r = Math.max(hw, hl);
        vfx.flash(center.x, center.y + 0.7, center.z, r * 2.2, 'ice', owner, 0.22);
        const spikes = vfx.reducedEffects ? 6 : 14, life = Math.max(1.3, seconds + 0.8);
        for (let i = 0; i < spikes; i++) {
          fp.sample(vfx.random(), vfx.random(), this.a, 0, 0.82);
          vfx.spikes.spawn(this.a.x, fp.cy - 0.05, this.a.z, vfx.range(0.7, 1.55), vfx.range(0.11, 0.22), vfx.range(-0.28, 0.28), vfx.range(-0.28, 0.28), time + i * 0.012, life, owner);
        }
        vfx.shards(center.x, center.y + 0.4, center.z, 40, 5.5, owner);
        vfx.smoke(center.x, center.y, center.z, 16, r * 0.7, 0.3, 1.5, 1.8, VFX_COLORS.steam, 0.45, owner, 1.3);
        vfx.ground.spawn('shock', fp, 'ice', owner, time, 0.45);
        vfx.ground.spawn('decal', fp, 'ice', owner, time, 6, 1, slot.glow);
        vfx.chunks(center.x, center.y + 0.1, center.z, 6, 3.4, 0.16, owner, true, fp);
        vfx.lights.pulse(center.x, center.y + 1.2, center.z, PALETTE.ice.hot, 6, 8, 0.55, time, owner);
        break;
      }
      case 'venom-mist': {
        const r = Math.max(hw, hl);
        vfx.glow(center.x, center.y + 0.4, center.z, r * 1.4, 0.4, 'poison', 0.22, owner);
        vfx.smoke(center.x, center.y, center.z, 20, r * 0.7, 0.25, 1.9, 2, VENOM, 0.45, owner, 1.6);
        vfx.bubbles(center.x, center.y, center.z, 20, r * 0.75, owner, 'poison');
        vfx.ground.spawn('decal', fp, 'poison', owner, time, seconds + 4, 1, slot.glow);
        slot.ground = vfx.ground.spawn('burn', fp, 'poison', owner, time, 0, 0.3);
        break;
      }
      case 'gale': {
        const life = Math.max(0.32, Math.min(0.6, seconds));
        for (let i = 0; i < 3; i++) {
          fp.toWorld(0, -hl - 0.4, this.a, 0.3 + i * 0.12); fp.toWorld(0, hl + 0.4, this.b, 0.3 + i * 0.12);
          vfx.blades.spawn(this.a, this.b, hw * 2 * (0.95 - i * 0.12), fp.angle, time + i * 0.07, life, owner, 'wind');
        }
        vfx.ground.spawn('shock', fp, 'wind', owner, time, 0.35);
        vfx.ground.spawn('decal', fp, 'wind', owner, time, 4);
        for (let i = 0; i < 12; i++) {
          fp.sample(vfx.random(), vfx.random(), this.a, 0.05);
          vfx.smoke(this.a.x, this.a.y, this.a.z, 2, 0.2, 0.5, 0.8, 0.9, VFX_COLORS.dust, 0.4, owner, 0.4);
        }
        fp.toWorld(0, 0, this.a, 0.2);
        vfx.leaves(this.a.x, this.a.y, this.a.z, 18, hw * 0.8, fp.forwardX * 3.2, fp.forwardZ * 3.2, owner);
        this.windStreaks(slot, 30);
        break;
      }
      case 'fissure': {
        vfx.ground.spawn('decal', fp, el, owner, time, 5, 1, slot.glow);
        vfx.ground.spawn('shock', fp, el, owner, time, 0.42);
        vfx.chunks(center.x, center.y + 0.05, center.z, 10, 3.6, 0.22, owner, false, fp);
        for (let i = 0; i < 8; i++) {
          fp.toWorld((i / 7 - 0.5) * 2 * hw * 0.85, 0, this.a, 0.05);
          vfx.smoke(this.a.x, this.a.y, this.a.z, 2, 0.25, 0.8, 0.9, 1, VFX_COLORS.dust, 0.5, owner, 0.5);
          if (el === 'sap') vfx.sparks(this.a.x, this.a.y + 0.1, this.a.z, 4, 3.5, 'sap', owner, 0.8);
        }
        if (el === 'sap') vfx.bubbles(center.x, center.y, center.z, 14, hw * 0.8, owner, 'sap');
        break;
      }
      case 'charge': {
        this.actorRoot(slot.cue.actorId, this.a, slot.footprint);
        vfx.dustRing(this.a.x, fp.cy, this.a.z, 0.9, 14, owner);
        vfx.sparks(this.a.x, fp.cy + 0.1, this.a.z, 10, 3, slot.glow, owner, 0.3);
        break;
      }
      case 'slam': {
        vfx.ground.spawn('shock', fp, 'earth', owner, time, 0.45);
        vfx.ground.spawn('decal', fp, 'earth', owner, time, 5, 1, slot.glow);
        vfx.chunks(center.x, center.y + 0.05, center.z, 12, 4, 0.24, owner, false, fp);
        vfx.dustRing(center.x, center.y, center.z, Math.min(hw, hl), 22, owner);
        break;
      }
      case 'sap-burst': {
        vfx.ground.spawn('shock', fp, 'sap', owner, time, 0.42);
        vfx.ground.spawn('decal', fp, 'sap', owner, time, 5, 1, slot.glow);
        vfx.sparks(center.x, center.y + 0.1, center.z, 40, 4.5, 'sap', owner, 0.75);
        vfx.bubbles(center.x, center.y, center.z, 20, Math.min(hw, hl) * 0.8, owner, 'sap');
        vfx.smoke(center.x, center.y, center.z, 8, Math.min(hw, hl) * 0.6, 0.4, 1, 1.2, AMBER, 0.4, owner, 1);
        break;
      }
      case 'roar': {
        vfx.ground.spawn('shock', fp, 'wind', owner, time, 0.45);
        this.coneDust(slot, 26);
        break;
      }
      default: break;
    }
  }

  /**
   * Anticipation particles that make the danger readable inside the footprint (the ground fill is
   * deliberately faint): rolling venom clouds, frost glints and mist, travelling dust on waves,
   * rising embers on fire, wind streaks on gales. Samples spread outward with the windup.
   */
  private telegraphParticles(slot: KitSlot, t: number, dt: number): void {
    const vfx = this.vfx, fp = slot.footprint, owner = slot.owner, reach = 0.35 + 0.55 * t;
    switch (slot.kit) {
      case 'venom-mist':
        for (let n = this.due(slot, 14, dt, 4); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * reach, this.a, 0.05, 0.8); vfx.smoke(this.a.x, this.a.y, this.a.z, 1, 0.25, 0.08, vfx.range(1.4, 2.2), 1.6, VENOM, 0.3, owner, 0.35); }
        return;
      case 'frost-bloom':
        for (let n = this.due(slot, 18, dt, 4); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * reach, this.a, 0.05, 0.85); vfx.glow(this.a.x, this.a.y, this.a.z, 0.12, 0.6, 'ice', 0.5, owner, 0.25); }
        return;
      case 'fissure': {
        for (let n = this.due(slot, 18, dt, 4); n > 0; n--) {
          // Dust kicked up along a band that travels across the wave's depth.
          const travel = ((vfx.time * 0.7) % 1) * 2 - 1;
          fp.toWorld((vfx.random() - 0.5) * 2 * fp.halfWidth * 0.8, travel * fp.halfLength * 0.7, this.a, 0.05);
          vfx.smoke(this.a.x, this.a.y, this.a.z, 1, 0.15, 0.35, 0.7, 0.8, VFX_COLORS.dust, 0.4, owner, 0.3);
        }
        return;
      }
      case 'ember-lance': case 'cinder-burst':
        for (let n = this.due(slot, 16, dt, 4); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * reach, this.a, 0, 0.8); vfx.embers(this.a.x, this.a.y, this.a.z, 1, 0.05, 0.6, -0.4, owner); }
        return;
      case 'gale': this.windStreaks(slot, this.due(slot, 14, dt, 4)); return;
      case 'slam': case 'charge': case 'sap-burst':
        for (let n = this.due(slot, 8, dt, 4); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * reach, this.a, 0.05, 0.8); vfx.smoke(this.a.x, this.a.y, this.a.z, 1, 0.15, 0.3, 0.6, 0.7, VFX_COLORS.dust, 0.3, owner, 0.2); }
        return;
      default: return;
    }
  }

  private updateCommit(slot: KitSlot, t: number, dt: number): void {
    const vfx = this.vfx, owner = slot.owner, fp = slot.footprint;
    if (slot.kit === 'gale') { this.windStreaks(slot, this.due(slot, 28, dt)); return; }
    if (!slot.cue.element && slot.kit !== 'ember-lance') return;
    const head = this.a;
    if (slot.kit === 'ember-lance') {
      if (t < 0.35) { fp.toWorld(0, -fp.halfLength, this.b, 0.3); this.flight(slot.origin, this.b, t / 0.35, head); }
      else fp.toWorld(0, -fp.halfLength + 2 * fp.halfLength * ((t - 0.35) / 0.65), head, 0.25);
    } else this.flight(slot.origin, slot.target, t, head);
    vfx.glow(head.x, head.y, head.z, 0.55, 0.1, slot.element, 0.5, owner);
    const n = this.due(slot, 80, dt);
    if (slot.element === 'fire') vfx.flames(head.x, head.y - 0.15, head.z, Math.ceil(n * 0.6), 0.12, 0.7, owner);
    else if (slot.element === 'ice') vfx.shards(head.x, head.y, head.z, Math.ceil(n * 0.4), 1.2, owner);
    else if (slot.element === 'poison') vfx.bubbles(head.x, head.y - 0.1, head.z, Math.ceil(n * 0.4), 0.15, owner, 'poison');
    vfx.sparks(head.x, head.y, head.z, Math.ceil(n * 0.4), 1.6, slot.element, owner, 0.2);
  }

  private updateActive(slot: KitSlot, t: number, dt: number): void {
    const vfx = this.vfx, owner = slot.owner, fp = slot.footprint;
    const envelope = Math.min(1, t * 8) * Math.min(1, (1 - t) * 4);
    switch (slot.kit) {
      case 'ember-lance':
        if (slot.ground) vfx.ground.drive(slot.ground, 1, 0.6 + 0.4 * envelope, envelope);
        for (let n = this.due(slot, 95, dt); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0, 0.7); vfx.flames(this.a.x, this.a.y, this.a.z, 1, 0.05, 0.9, owner); }
        for (let n = this.due(slot, 30, dt, 2); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.1, 0.6); vfx.sparks(this.a.x, this.a.y, this.a.z, 1, 4, 'fire', owner, 0.8); }
        for (let n = this.due(slot, 6, dt, 3); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.5, 0.6); vfx.smoke(this.a.x, this.a.y, this.a.z, 1, 0.2, 1, 1.2, 1.4, VFX_COLORS.smoke, 0.35, owner); }
        return;
      case 'venom-mist':
        if (slot.ground) vfx.ground.drive(slot.ground, 1, 0.3, Math.min(1, t * 20) * Math.min(1, (1 - t) * 10));
        for (let n = this.due(slot, 16, dt); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.05, 0.75); vfx.smoke(this.a.x, this.a.y, this.a.z, 1, 0.3, 0.12, vfx.range(1.8, 2.8), 2.2, VENOM, 0.38, owner, 0.25); }
        for (let n = this.due(slot, 22, dt, 2); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0, 0.8); vfx.bubbles(this.a.x, this.a.y, this.a.z, 1, 0.05, owner, 'poison'); }
        return;
      case 'charge':
        this.actorRoot(slot.cue.actorId, this.a, fp);
        for (let n = this.due(slot, 40, dt); n > 0; n--) vfx.smoke(this.a.x - fp.forwardX * 0.6, fp.cy, this.a.z - fp.forwardZ * 0.6, 1, 0.35, 0.5, 0.9, 0.9, VFX_COLORS.dust, 0.5, owner, 0.6);
        for (let n = this.due(slot, 14, dt, 2); n > 0; n--) vfx.sparks(this.a.x, fp.cy + 0.05, this.a.z, 1, 2.5, slot.glow, owner, 0.3);
        return;
      case 'frost-bloom':
        for (let n = this.due(slot, 10, dt); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0, 0.8); vfx.smoke(this.a.x, this.a.y, this.a.z, 1, 0.2, 0.15, 1.2, 1.6, VFX_COLORS.steam, 0.35, owner, 0.3); }
        return;
      case 'cinder-burst':
        for (let n = this.due(slot, 14, dt); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0, 0.7); vfx.embers(this.a.x, this.a.y, this.a.z, 1, 0.1, 1.2, -0.6, owner); }
        return;
      case 'gale':
        for (let n = this.due(slot, 20, dt); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.1); vfx.leaves(this.a.x, this.a.y, this.a.z, 1, 0.2, fp.forwardX * 3, fp.forwardZ * 3, owner); }
        return;
      case 'roar': this.coneDust(slot, this.due(slot, 30, dt)); return;
      default:
        for (let n = this.due(slot, 6, dt); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0, 0.8); vfx.smoke(this.a.x, this.a.y, this.a.z, 1, 0.2, 0.4, 0.8, 1, VFX_COLORS.dust, 0.35, owner, 0.3); }
    }
  }

  private decay(slot: KitSlot): void {
    const vfx = this.vfx, owner = slot.owner, fp = slot.footprint;
    const center = this.areaCenter(fp, this.c), r = Math.min(fp.halfWidth, fp.halfLength);
    switch (slot.element) {
      case 'fire':
        for (let i = 0; i < 6; i++) { fp.sample(vfx.random(), vfx.random(), this.a, 0.2, 0.7); vfx.smoke(this.a.x, this.a.y, this.a.z, 2, 0.3, 0.9, 1.3, 2, VFX_COLORS.smoke, 0.4, owner); }
        vfx.embers(center.x, center.y, center.z, 12, r * 0.8, 1, -0.4, owner);
        break;
      case 'ice': vfx.smoke(center.x, center.y, center.z, 8, r * 0.8, 0.2, 1.3, 1.8, VFX_COLORS.steam, 0.3, owner, 0.4); break;
      case 'poison': vfx.smoke(center.x, center.y, center.z, 8, r * 0.8, 0.35, 2, 1.6, VENOM, 0.25, owner, 0.6); break;
      case 'wind': fp.toWorld(0, fp.halfLength, this.a, 0.2); vfx.leaves(this.a.x, this.a.y, this.a.z, 6, r, fp.forwardX * 1.5, fp.forwardZ * 1.5, owner); break;
      default: vfx.smoke(center.x, center.y, center.z, 6, r * 0.8, 0.4, 1, 1.4, VFX_COLORS.dust, 0.3, owner, 0.3); break;
    }
    if (slot.kit === 'charge') {
      // Impact at the far end of the committed lane, kept inside the lane footprint.
      const radius = Math.min(fp.halfWidth, 1.1);
      fp.toWorld(0, Math.max(0, fp.halfLength - radius), this.a);
      slot.aux.set('disk', this.a.x, fp.cy, this.a.z, fp.angle, radius, radius);
      vfx.ground.spawn('shock', slot.aux, 'earth', owner, vfx.time, 0.4);
      vfx.ground.spawn('decal', slot.aux, 'earth', owner, vfx.time, 4, 1, slot.glow);
      vfx.dustRing(this.a.x, fp.cy, this.a.z, radius, 18, owner);
      vfx.chunks(this.a.x, fp.cy + 0.05, this.a.z, 6, 3.4, 0.2, owner, false, slot.aux);
      if (this.hasFocus && Math.hypot(this.focus.x - this.a.x, this.focus.z - this.a.z) < SHAKE_RADIUS) this.impact?.shake(0.16, 0.28, 20);
    }
  }

  // ---- special cue kinds ----

  private beginRoarCone(slot: KitSlot, seconds: number): void {
    const cue = slot.cue, intensity = Math.min(1.5, Math.max(0.4, cue.intensity ?? 1));
    if (!cue.footprint || cue.shape !== 'sector') {
      this.actorRoot(cue.actorId, this.a, undefined, cue.position);
      const root = cue.actorId ? this.resolveSocket?.(cue.actorId, 'root') : undefined;
      let yaw = cue.footprint?.angleRadians ?? 0;
      if (root && cue.footprint?.angleRadians === undefined) { root.getWorldDirection(this.b); yaw = Math.atan2(this.b.x, this.b.z); }
      slot.footprint.set('sector', this.a.x, this.a.y, this.a.z, yaw, 5 * intensity, 5 * intensity, (70 * Math.PI) / 180);
    }
    this.impact?.shake(0.12 + 0.12 * intensity, Math.min(1.2, seconds), 14);
    this.socketPosition(slot, this.a);
    this.vfx.glow(this.a.x, this.a.y, this.a.z, 1.1, 0.4, 'wind', 0.35, slot.owner);
    slot.pulses = 0;
  }

  private updateRoarCone(slot: KitSlot, t: number, dt: number): void {
    const age = this.vfx.time - slot.cue.worldTimeSeconds;
    const wanted = Math.min(3, 1 + Math.floor(Math.max(0, age) / 0.33));
    while (slot.pulses < wanted) { this.vfx.ground.spawn('shock', slot.footprint, 'wind', slot.owner, this.vfx.time, 0.5); slot.pulses++; }
    if (t < 0.85) this.coneDust(slot, this.due(slot, 36, dt));
  }

  private landing(slot: KitSlot): void {
    const vfx = this.vfx, cue = slot.cue, owner = slot.owner, intensity = Math.min(1.5, Math.max(0.2, cue.intensity ?? 0.6));
    this.actorRoot(cue.actorId, this.a, undefined, cue.position);
    const radius = cue.footprint ? Math.min(cue.footprint.width, cue.footprint.length) / 2 : 0.9 + 1.1 * intensity;
    slot.footprint.set('disk', this.a.x, this.a.y, this.a.z, 0, radius, radius);
    vfx.ground.spawn('shock', slot.footprint, 'earth', owner, vfx.time, 0.4);
    if (intensity >= 0.7) vfx.ground.spawn('decal', slot.footprint, 'earth', owner, vfx.time, 4.5, 1, slot.glow);
    vfx.dustRing(this.a.x, this.a.y, this.a.z, radius * 0.8, Math.round(12 + 16 * intensity), owner);
    vfx.chunks(this.a.x, this.a.y + 0.05, this.a.z, Math.round(2 + 5 * intensity), 3, 0.2, owner, false, slot.footprint);
    this.impact?.shake(0.08 + 0.2 * intensity, 0.25 + 0.15 * intensity, 20);
  }

  private staffHit(slot: KitSlot): void {
    const vfx = this.vfx, cue = slot.cue, owner = slot.owner, attackId = cue.attackId ?? '';
    const heavy = attackId.includes('charged') ? 2 : attackId.includes('heavy') ? 1 : 0;
    // The engine reports the contact point (on the struck body, already at hit height); the root lift is only the fallback.
    const contact = cue.position;
    if (contact) this.a.set(contact.x, contact.y, contact.z); else this.actorRoot(cue.targetId, this.a);
    const y = contact ? this.a.y : this.a.y + 0.9;
    if (slot.element === 'spirit') {
      vfx.leaves(this.a.x, y, this.a.z, 10, 0.3, 0, 0, owner);
      vfx.sparks(this.a.x, y, this.a.z, 14, 3.5, 'spirit', owner, 0.3);
      return;
    }
    vfx.flash(this.a.x, y, this.a.z, 0.9 + heavy * 0.5, 'arcane', owner, 0.14);
    vfx.sparks(this.a.x, y, this.a.z, 18 + heavy * 14, 5.5 + heavy, 'arcane', owner, 0.3);
    this.impact?.shake(heavy === 2 ? 0.24 : heavy === 1 ? 0.15 : 0.05, heavy ? 0.24 : 0.12, 26);
  }

  private contact(slot: KitSlot): void {
    const vfx = this.vfx, cue = slot.cue, owner = slot.owner;
    const contact = cue.position;
    if (contact) this.a.set(contact.x, contact.y, contact.z); else this.actorRoot(cue.targetId, this.a);
    const y = contact ? this.a.y : this.a.y + 1;
    vfx.sparks(this.a.x, y, this.a.z, 12, 3.5, slot.element, owner, 0.4);
    vfx.glow(this.a.x, y, this.a.z, 0.8, 0.18, slot.element, 0.45, owner);
    if (slot.element === 'poison' || slot.element === 'sap') vfx.bubbles(this.a.x, y - 0.4, this.a.z, 6, 0.3, owner, slot.element);
    if (slot.element === 'ice') vfx.shards(this.a.x, y, this.a.z, 8, 2.5, owner);
  }

  private launchBlades(slot: KitSlot, seconds: number): void {
    const fp = slot.footprint;
    fp.toWorld(0, -fp.halfLength - 0.4, this.b, 0.35);
    this.a.set(slot.origin.x, fp.cy + 0.35, slot.origin.z);
    for (let i = 0; i < 2; i++) this.vfx.blades.spawn(this.a, this.b, fp.halfWidth * 1.2 * (1 - i * 0.2), fp.angle, this.vfx.time + i * seconds * 0.25, seconds * (1 - i * 0.25), slot.owner, 'wind');
  }

  private windStreaks(slot: KitSlot, count: number): void {
    const vfx = this.vfx, fp = slot.footprint, hot = PALETTE.wind.hot;
    for (let i = vfx.count(count); i > 0; i--) {
      fp.sample(vfx.random(), vfx.random(), this.a, vfx.range(0.15, 0.9));
      const p = vfx.spec(), speed = vfx.range(5, 9);
      p.x = this.a.x - fp.forwardX * 1.2; p.y = this.a.y; p.z = this.a.z - fp.forwardZ * 1.2;
      p.vx = fp.forwardX * speed; p.vz = fp.forwardZ * speed; p.drag = 2; p.life = vfx.range(0.25, 0.45);
      p.size0 = 0.07; p.size1 = 0.03; p.frame = 2; p.stretch = 0.16;
      p.r0 = p.r1 = hot.r; p.g0 = p.g1 = hot.g; p.b0 = p.b1 = hot.b; p.a0 = 0.6; p.fadeIn = 0.15; p.fadeOut = 0.5;
      vfx.emit(vfx.particles.additive, slot.owner);
    }
  }

  private coneDust(slot: KitSlot, count: number): void {
    const vfx = this.vfx, fp = slot.footprint;
    for (let i = 0; i < count; i++) {
      const angle = fp.angle + vfx.range(-0.5, 0.5) * fp.aperture, speed = fp.halfLength * vfx.range(1.4, 2.2);
      const p = vfx.spec();
      p.x = fp.cx + Math.sin(angle) * 0.6; p.y = fp.cy + 0.2; p.z = fp.cz + Math.cos(angle) * 0.6;
      p.vx = Math.sin(angle) * speed; p.vy = vfx.range(0.1, 0.6); p.vz = Math.cos(angle) * speed;
      p.drag = 2.6; p.life = vfx.range(0.6, 1); p.size0 = 0.4; p.size1 = vfx.range(1, 1.5); p.frame = 1;
      p.spin = vfx.random() * 6.28; p.spinRate = vfx.range(-1, 1);
      p.r0 = p.r1 = VFX_COLORS.dust.r; p.g0 = p.g1 = VFX_COLORS.dust.g; p.b0 = p.b1 = VFX_COLORS.dust.b; p.a0 = 0.5; p.fadeIn = 0.05; p.fadeOut = 0.45;
      vfx.emit(vfx.particles.alpha, slot.owner);
    }
  }

  // ---- geometry helpers ----

  /** Integer emissions due this frame for a continuous rate (per second of world time). */
  private due(slot: KitSlot, rate: number, dt: number, stream: 1 | 2 | 3 | 4 = 1): number {
    const scaled = rate * dt * (this.vfx.reducedEffects ? 0.35 : 1);
    const value = slot.acc[stream - 1]! + scaled;
    const whole = Math.floor(value);
    slot.acc[stream - 1] = value - whole;
    return whole;
  }

  /** Monster cast socket (head bone), else the authored source point lifted to chest height. */
  private socketPosition(slot: KitSlot, out: Vector3): Vector3 {
    if (slot.socket) { slot.socket.updateWorldMatrix(true, false); return slot.socket.getWorldPosition(out); }
    const from = slot.cue.from ?? slot.cue.position;
    return out.set(from?.x ?? 0, (from?.y ?? 0) + 1.1, from?.z ?? 0);
  }

  private actorRoot(actorId: string | undefined, out: Vector3, footprint?: Footprint, fallback?: { x: number; y: number; z: number }): Vector3 {
    const root = actorId ? this.resolveSocket?.(actorId, 'root') : undefined;
    if (root) { root.updateWorldMatrix(true, false); return root.getWorldPosition(out); }
    if (fallback) return out.set(fallback.x, fallback.y, fallback.z);
    return footprint ? footprint.toWorld(0, -footprint.halfLength, out) : out.set(0, 0, 0);
  }

  /**
   * Actor-bound beams run from body to body (cast socket, else root lifted to chest height) so a
   * vine never lies on the ground; actor-less story beams use their authored points exactly.
   */
  private beamEndpoint(actorId: string | undefined, point: { x: number; y: number; z: number } | undefined, out: Vector3, lift: number): void {
    const cast = actorId ? this.resolveSocket?.(actorId, 'cast') : undefined;
    const anchor = cast ?? (actorId ? this.resolveSocket?.(actorId, 'root') : undefined);
    if (anchor) {
      anchor.updateWorldMatrix(true, false);
      anchor.getWorldPosition(out);
      if (!cast) out.y += lift;
      return;
    }
    if (point) out.set(point.x, point.y + (actorId ? lift : 0), point.z);
  }

  private flight(from: Vector3, to: Vector3, t: number, out: Vector3): Vector3 {
    out.lerpVectors(from, to, t);
    out.y += Math.sin(Math.PI * t) * Math.min(1.6, 0.35 + Math.hypot(to.x - from.x, to.z - from.z) * 0.12);
    return out;
  }

  private areaCenter(fp: Footprint, out: Vector3): Vector3 {
    return fp.shape === 'sector' ? fp.toWorld(0, fp.halfLength * 0.5, out) : out.set(fp.cx, fp.cy, fp.cz);
  }

  /** Disk inscribed in the cue footprint (or a default radius for point cues). */
  private disk(slot: KitSlot, size: number): Footprint {
    const fp = slot.footprint;
    if (slot.cue.footprint) return fp;
    return slot.aux.set('disk', fp.cx, fp.cy, fp.cz, 0, size / 2, size / 2);
  }
}
