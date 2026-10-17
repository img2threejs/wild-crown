import { Group, Vector3, type Object3D } from 'three';
import type { CombatSnapshot, PlayerProjectileSnapshot } from '../../game/contracts.js';
import type { HeroId } from '../../game/heroes.js';
import { ActorBodies, HandRig } from './ActorBounds.js';
import type { VfxElement } from './palette.js';
import { BladeTrailFx } from './BladeTrailFx.js';
import { CleanseDissolveFx } from './CleanseDissolveFx.js';
import { CrescentFx } from './CrescentFx.js';
import type { ImpactSink, SocketResolver } from './ElementKits.js';
import { LineBatch } from './LineBatch.js';
import { SigilFx, type SigilSlot } from './SigilFx.js';
import { SpriteBatch } from './SpriteBatch.js';
import { HeroStateFx } from './HeroStateFx.js';
import { WardenCombat } from './WardenCombat.js';
import { WardenCues } from './WardenCues.js';
import type { VfxModule, VfxSystem } from './VfxSystem.js';

/** Owner id for Warden effects that belong to no cue scope (ambient motes, streaks); cleared with the system. */
export const WARDEN_OWNER = 0x7ffe0000;

export interface WardenOptions {
  readonly resolveSocket?: SocketResolver;
  readonly resolveActorRoot?: (actorId: string) => Object3D | undefined;
  readonly impact?: ImpactSink;
}

/** Aren as the latest snapshot saw him; never written back to the simulation. */
export class PlayerView {
  valid = false;
  readonly position = new Vector3();
  /** Horizontal unit facing. */
  readonly facing = new Vector3(0, 0, 1);
  /** Playable hero in the player slot (`snapshot.player.heroId`); the actor id is always `aren`. */
  hero: HeroId = 'aren';
  actionId = '';
  phase = '';
}

/** Electric arc crawling over a struck body: two capsule-local anchors, regenerated jagged path. */
export interface ArcState {
  active: boolean;
  actorId: string;
  owner: number;
  start: number;
  until: number;
  strength: number;
  lightning: boolean;
  nextRegen: number;
  readonly a: Vector3;
  readonly b: Vector3;
  readonly path: Float32Array;
}

/** A Thunder Cleave strike: trunk, branches and radial ground arcs, regenerated every 2–3 frames for flicker. */
export interface BoltState {
  active: boolean;
  owner: number;
  start: number;
  end: number;
  nextRegen: number;
  readonly strike: Vector3;
  readonly trunk: Float32Array;
  readonly branches: Float32Array[];
  readonly radial: Float32Array[];
}

/** One Judgement mark: an X of two crescent slashes in the air over a small ground rune. */
export interface MarkVisual {
  id: string;
  owner: number;
  crescentA: number;
  crescentB: number;
  ground: SigilSlot | undefined;
  createdAt: number;
  expiresAt: number;
  readonly position: Vector3;
}

/** A snapshot projectile as drawn: interpolated position, wave scar bookkeeping. */
export interface ProjectileVisual {
  id: string;
  kind: PlayerProjectileSnapshot['kind'];
  seen: boolean;
  simTick: number;
  hasPrev: boolean;
  radius: number;
  crescent: number;
  owner: number;
  emitAcc: number;
  scarDistance: number;
  readonly prev: Vector3;
  readonly cur: Vector3;
  readonly display: Vector3;
  readonly direction: Vector3;
  readonly scarFrom: Vector3;
}

export const BOLT_TRUNK_LEVELS = 5;
export const BOLT_BRANCH_LEVELS = 3;
export const BOLT_BRANCHES = 4;
export const BOLT_RADIALS = 6;
export const ARC_LEVELS = 3;
export const MAX_ARCS = 12;
export const MAX_BOLTS = 3;
/** Seconds a Thunder Cleave strike flickers, and a hit's electric arcs crawl over the target. */
export const THUNDER_SECONDS = 0.3;
export const ARC_SECONDS = 0.35;

/**
 * Warden Arsenal presentation: blade trail, hit impacts, rune sigils, projectiles, Thunder Cleave,
 * Judgement and the cleansed finish. Cue-driven parts live in `WardenCues`, snapshot-driven parts in
 * `WardenCombat`; this class owns the pooled GPU resources and shared state. Everything ages on the
 * authoritative world clock (`vfx.time`), so pause, hit-stop and Perfect Dodge slow motion apply uniformly.
 */
export class WardenFx implements VfxModule {
  readonly group = new Group();
  readonly sigils = new SigilFx();
  readonly lines = new LineBatch();
  readonly sprites: SpriteBatch;
  readonly crescents = new CrescentFx(40);
  readonly trail = new BladeTrailFx();
  readonly dissolve: CleanseDissolveFx;
  readonly bodies = new ActorBodies();
  readonly hand = new HandRig();
  readonly player = new PlayerView();
  readonly arcs: ArcState[] = [];
  readonly bolts: BoltState[] = [];
  readonly marks: MarkVisual[] = [];
  readonly projectiles: ProjectileVisual[] = [];
  readonly cues: WardenCues;
  readonly combat: WardenCombat;
  /** Snapshot-driven Vesper/Sakda pass: hero marks, shield, flurry, limb trails, kunai/echo/shade projectiles. */
  readonly hero: HeroStateFx;
  resolveSocket: SocketResolver | undefined;
  resolveActorRoot: ((actorId: string) => Object3D | undefined) | undefined;
  impact: ImpactSink | undefined;
  /** World time the blade trail window is open (active ± 2 frames), and the trail style key. */
  trailFrom = Infinity;
  trailUntil = -Infinity;
  /** Palette element of the current blade/staff trail window (drives the trail sparks and drips). */
  trailElement: VfxElement = 'arcane';
  /** Weapon edge boost (0..1 of the swing peak) and the swing peak emissive intensity. */
  edgeBoost = 0;
  edgePeak = 3;
  /** World time until which the Judgement dash streaks and trail run. */
  dashUntil = -Infinity;
  frame = 0;

  constructor(readonly vfx: VfxSystem, options: WardenOptions = {}) {
    this.resolveSocket = options.resolveSocket;
    this.resolveActorRoot = options.resolveActorRoot;
    this.impact = options.impact;
    this.sprites = new SpriteBatch(vfx.atlas, 160);
    this.dissolve = new CleanseDissolveFx(vfx);
    this.group.name = 'vfx-warden';
    this.group.add(this.sigils.group, this.crescents.mesh, this.trail.mesh, this.lines.mesh, this.sprites.mesh);
    for (let i = 0; i < MAX_ARCS; i++) this.arcs.push({ active: false, actorId: '', owner: -1, start: 0, until: 0, strength: 1, lightning: false, nextRegen: 0, a: new Vector3(), b: new Vector3(), path: new Float32Array(((1 << ARC_LEVELS) + 1) * 3) });
    for (let i = 0; i < MAX_BOLTS; i++) {
      this.bolts.push({
        active: false, owner: -1, start: 0, end: 0, nextRegen: 0, strike: new Vector3(), trunk: new Float32Array(((1 << BOLT_TRUNK_LEVELS) + 1) * 3),
        branches: Array.from({ length: BOLT_BRANCHES }, () => new Float32Array(((1 << BOLT_BRANCH_LEVELS) + 1) * 3)),
        radial: Array.from({ length: BOLT_RADIALS }, () => new Float32Array(((1 << BOLT_BRANCH_LEVELS) + 1) * 3)),
      });
    }
    this.cues = new WardenCues(this);
    this.combat = new WardenCombat(this);
    this.hero = new HeroStateFx(this);
  }

  setImpact(impact: ImpactSink | undefined): void { this.impact = impact; }

  /** Per-frame animation of the pooled meshes (the snapshot pass refreshes them again after it moves things). */
  update(time: number): void {
    this.sigils.update(time);
    this.crescents.update(time);
    this.trail.update(time);
  }

  /** Snapshot-driven pass; call every rendered frame after `StoryEffects.update`. */
  updateCombat(snapshot: CombatSnapshot, alpha: number): void { this.combat.update(snapshot, alpha); }

  killOwner(owner: number): void {
    this.sigils.killOwner(owner); this.crescents.killOwner(owner); this.dissolve.killOwner(owner);
    for (const arc of this.arcs) if (arc.active && arc.owner === owner) arc.active = false;
    for (const bolt of this.bolts) if (bolt.active && bolt.owner === owner) bolt.active = false;
    for (let i = this.marks.length - 1; i >= 0; i--) if (this.marks[i]!.owner === owner) this.releaseMark(i);
    for (let i = this.projectiles.length - 1; i >= 0; i--) if (this.projectiles[i]!.owner === owner) this.combat.endProjectile(this.projectiles[i]!);
  }

  clear(): void {
    this.sigils.clear(); this.crescents.clear(); this.trail.clear(); this.dissolve.clear();
    for (const arc of this.arcs) arc.active = false;
    for (const bolt of this.bolts) bolt.active = false;
    while (this.marks.length) this.releaseMark(this.marks.length - 1);
    for (let i = this.projectiles.length - 1; i >= 0; i--) this.combat.endProjectile(this.projectiles[i]!);
    this.combat.reset();
    this.hero.reset();
    this.trailFrom = Infinity; this.trailUntil = -Infinity; this.dashUntil = -Infinity; this.edgeBoost = 0;
    this.lines.begin(this.vfx.cameraPosition); this.lines.end();
    this.sprites.begin(); this.sprites.end();
    this.vfx.lights.untrack();
  }

  releaseMark(index: number): void {
    const mark = this.marks[index]!;
    this.crescents.release(mark.crescentA); this.crescents.release(mark.crescentB);
    if (mark.ground) this.sigils.release(mark.ground);
    this.marks.splice(index, 1);
  }

  dispose(): void {
    this.clear();
    this.group.removeFromParent();
    this.sigils.dispose(); this.lines.dispose(); this.sprites.dispose(); this.crescents.dispose(); this.trail.dispose(); this.dissolve.dispose();
  }
}
