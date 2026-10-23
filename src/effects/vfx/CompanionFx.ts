import { Mesh, MeshBasicMaterial, SphereGeometry, Vector3, type Object3D } from 'three';
import type { ActorSnapshot, CompanionElement, CompanionId } from '../../game/contracts.js';
import type { StoryCue } from '../story-cues.js';
import { ActorBodies } from './ActorBounds.js';
import { CompanionSockets, type CompanionSocketName } from './CompanionSockets.js';
import type { ImpactSink } from './ElementKits.js';
import { Footprint } from './footprint.js';
import type { GroundSlot } from './GroundFx.js';
import type { VfxElement } from './palette.js';
import type { BeamSlot } from './RibbonFx.js';
import { VFX_COLORS, type VfxSystem } from './VfxSystem.js';
import { companionSkillByAction, type CompanionSkill } from '../../game/companions/CompanionSkills.js';
import { PALETTE, UMBRAL_SMOKE } from './palette.js';
import { VFX_FRAME } from './VfxAtlas.js';

/** Owner id of the persistent companion markers (snapshot-driven); cue-driven bursts carry their cue's scope owner. */
export const COMPANION_VFX_OWNER = 0x7fff0200;
/** Hard caps: marks (Vara marks one hostile at a time, two with a stacked effect), guards (Asha) and jobs (Koro, Vara); each takes manual ground slots of the shared pool. */
export const MAX_MARKS = 2, MAX_GUARDS = 1, MAX_JOBS = 2, MAX_SHELTERS = 1;
/** Live socket-driven skill jobs (one equipped companion at a time; the spare slots cover a guard arch overlapping a finishing skill) and the visible Mending Seed meshes. */
export const MAX_LIVE_JOBS = 4, SEED_POOL = 2;
/** Marks blink and fade over their last half second. */
const MARK_FADE_TICKS = 30;
const HEIGHT_OFFSET = 0.35;

const clamp01 = (value: number): number => value < 0 ? 0 : value > 1 ? 1 : value;

/** Feedback hue by field command: sky for a mark or focus, amber for the guard, spirit green for movement and search, earth for distraction. */
const COMMAND_ELEMENT: Readonly<Record<string, VfxElement>> = {
  follow: 'spirit', stay: 'spirit', recall: 'spirit', focus: 'wind', defend: 'gold', search: 'spirit', distract: 'earth', special: 'sap',
};
const MARK_ELEMENT: VfxElement = 'lightning';
const GUARD_ELEMENT: VfxElement = 'earth';
const SHELTER_ELEMENT: VfxElement = 'gold';
const SKILL_ELEMENT: Readonly<Record<CompanionElement, VfxElement>> = {
  fire: 'fire', water: 'water', ice: 'ice', lightning: 'lightning', wood: 'spirit',
  wind: 'wind', earth: 'earth', shadow: 'umbral', light: 'gold',
};

/** How a gesture's accent is drawn at one socket. Every kind is a pooled particle emitter (or a bounded ground quad); none keeps a handle past its call. */
type StreamKind = 'dust' | 'leaves' | 'smoke' | 'mist' | 'shards' | 'ring' | 'feathers' | 'print' | 'wake' | 'claw' | 'bolt' | 'afterimage' | 'roar';
/** An accent emitted at the animated sockets every `every` world ticks while the skill's normalized time lies in [from, to] (fractions of the skill's authored ticks). */
interface Stream { readonly sockets: readonly CompanionSocketName[]; readonly kind: StreamKind; readonly from: number; readonly to: number; readonly every: number; readonly count: number }
const PAWS: readonly CompanionSocketName[] = ['rightPaw', 'leftPaw'];
const HANDS: readonly CompanionSocketName[] = ['rightHand', 'leftHand'];
const WINGS: readonly CompanionSocketName[] = ['rightWing', 'leftWing'];
const TALONS: readonly CompanionSocketName[] = ['rightTalon', 'leftTalon'];
const MOUTH: readonly CompanionSocketName[] = ['mouth'];
const stream = (sockets: readonly CompanionSocketName[], kind: StreamKind, from: number, to: number, every: number, count: number): Stream => ({ sockets, kind, from, to, every, count });
const MAX_STREAMS = 3;
/**
 * Gesture accents by skill id. Windows are fractions of the skill's unchanged timing (release / contact in CompanionSkills) so each accent lives exactly while
 * its limb moves: Asha's pin claws only release→contact, Sable's wake through the flank, Nyra's pounce paws, Solkar's roar window, Koro's hands, Vara's wings and beak.
 */
const STREAMS: Readonly<Record<string, readonly Stream[]>> = {
  'sky-mark': [stream(WINGS, 'feathers', .1, .35, 4, 1), stream(MOUTH, 'ring', .3, .5, 5, 1)],
  'canopy-move': [stream(HANDS, 'dust', .2, .72, 7, 3)],
  'canopy-distract': [stream(HANDS, 'leaves', .26, .56, 8, 2)],
  'asha-distract': [stream(PAWS, 'dust', .3, .52, 6, 3)],
  'sable-distract': [stream(MOUTH, 'shards', .28, .52, 7, 2)],
  'nyra-distract': [stream(PAWS, 'smoke', .28, .52, 6, 2)],
  'solkar-distract': [stream(MOUTH, 'ring', .28, .5, 8, 1)],
  'vara-search': [stream(WINGS, 'feathers', .2, .9, 5, 1)],
  'koro-search': [stream(HANDS, 'leaves', .24, .9, 7, 2)],
  'asha-search': [stream(PAWS, 'dust', .24, .8, 7, 2)],
  'sable-search': [stream(PAWS, 'print', .2, .9, 9, 1), stream(MOUTH, 'mist', .2, .9, 10, 2)],
  'nyra-search': [stream(PAWS, 'smoke', .2, .9, 8, 2)],
  'solkar-search': [stream(MOUTH, 'ring', .2, .9, 14, 1)],
  'fang-pin': [stream(PAWS, 'dust', .12, .36, 8, 2), stream(['rightPaw'], 'claw', .36, .55, 1, 3)],
  'pack-flank': [stream(PAWS, 'wake', .15, .62, 3, 2)],
  'shadow-ambush': [stream(PAWS, 'bolt', .2, .56, 2, 2), stream([], 'afterimage', .2, .58, 3, 1)],
  'crown-rally': [stream(MOUTH, 'roar', .28, .48, 3, 1)],
};
/** Lightning ribbons trailing the pounce paws (Nyra); the live trail is a pooled beam from the paw to its lagging point. */
const TRAILS: Readonly<Record<string, { readonly sockets: readonly CompanionSocketName[]; readonly from: number; readonly to: number }>> = {
  'shadow-ambush': { sockets: PAWS, from: .2, to: .58 },
};
/** The one-shot accent a field search reveal adds at the searching body: socket set, kind and count. */
const REVEAL: Readonly<Record<CompanionId, { readonly sockets: readonly CompanionSocketName[]; readonly kind: StreamKind; readonly count: number }>> = {
  vara: { sockets: WINGS, kind: 'feathers', count: 6 }, koro: { sockets: HANDS, kind: 'leaves', count: 8 }, asha: { sockets: PAWS, kind: 'dust', count: 5 },
  sable: { sockets: MOUTH, kind: 'mist', count: 4 }, nyra: { sockets: PAWS, kind: 'smoke', count: 3 }, solkar: { sockets: MOUTH, kind: 'ring', count: 1 },
};
const REVEAL_RADIUS: Readonly<Record<CompanionId, number>> = { vara: 3.4, koro: 2.4, asha: 2.4, sable: 2.4, nyra: 2.2, solkar: 2.7 };

/** One live cue-scoped effect that follows its companion's animated sockets on the world clock until its window ends, its scope is cancelled or it is cleared. */
interface Job {
  active: boolean;
  /** skill: a command-cue skill; guard: Asha's braced-paw arch; storm: Vara's Storm Talon phases. */
  kind: 'skill' | 'guard' | 'storm';
  skill: CompanionSkill | undefined;
  companionId: CompanionId;
  actorId: string;
  targetId: string | undefined;
  scopeId: string | undefined;
  owner: number;
  element: VfxElement;
  /** World ticks: the skill's start (anticipation), the last tick driven, and the hard end of the job. */
  start: number;
  last: number;
  end: number;
  streams: readonly Stream[];
  readonly next: number[];
  trail: { readonly sockets: readonly CompanionSocketName[]; readonly from: number; readonly to: number } | undefined;
  readonly beams: (BeamSlot | undefined)[];
  readonly follow: Vector3[];
  readonly followed: boolean[];
  /** Mending Seed: the commit cue detaches it exactly once; it then flies `flight` ticks from `origin` to `aim` and is released at arrival. */
  seed: number;
  committed: boolean;
  commitTick: number;
  flight: number;
  readonly origin: Vector3;
  readonly aim: Vector3;
  /** Previous paw sample for velocity-aligned claw streaks. */
  readonly prev: Vector3;
  hasPrev: boolean;
  prevTick: number;
  /** Storm Talon: 0 idle, 1 takeoff (wing feathers), 2 dive (talon trails), and the world tick the current mode ends. */
  stormMode: 0 | 1 | 2;
  stormEnd: number;
}
function createJob(): Job {
  return {
    active: false, kind: 'skill', skill: undefined, companionId: 'vara', actorId: '', targetId: undefined, scopeId: undefined, owner: 0, element: 'spirit',
    start: 0, last: 0, end: 0, streams: [], next: new Array<number>(MAX_STREAMS).fill(0), trail: undefined,
    beams: [undefined, undefined], follow: [new Vector3(), new Vector3()], followed: [false, false],
    seed: -1, committed: false, commitTick: 0, flight: 1, origin: new Vector3(), aim: new Vector3(),
    prev: new Vector3(), hasPrev: false, prevTick: 0, stormMode: 0, stormEnd: 0,
  };
}
/** Seed trail spacing, the guard arch's safety ceiling when its resolve cue never arrives, and the grace a Storm Talon job waits after its last phase window for the next cue. */
const FLIGHT_TRAIL_TICKS = 2, GUARD_ARCH_TICKS = 240, STORM_JOB_TICKS = 60;

interface Marker {
  readonly kind: 'mark' | 'guard' | 'job';
  readonly ring: GroundSlot | undefined;
  /** Second quad: the committed landing point of a marked boss. */
  readonly landing: GroundSlot | undefined;
  readonly beam: BeamSlot | undefined;
  /** Vertical chevron over a marked head. */
  readonly pillar: BeamSlot | undefined;
  seen: boolean;
  /** Guard state at the previous frame, to brighten the ring on the frame a block lands. */
  state: string | undefined;
}
interface Shelter { readonly ground: GroundSlot | undefined; readonly endTick: number; readonly scopeId: string | undefined }

/**
 * Companion field-verb feedback, presentation only. Persistent markers are driven from the authoritative snapshot, so they exist exactly as long
 * as the engine reports them: Vara's mark ring, head chevron and landing hint follow `ActorSnapshot.mark`, Asha's guard ring and line follow
 * `guard`, and a finite job's line follows `job`; expiry, a recall, a death or a load removes the snapshot field (and `clear` on any
 * transition removes the rest), so nothing outlives its cause. One-shot cues add the moment: the mark landing, the block, the command ring and
 * Tali's shelter. Quads are manual ground slots and beams are pooled, so the family adds no draw call; reduced effects draw them steady
 * (no pulse, no blink).
 */
export class CompanionFx {
  private readonly markers = new Map<string, Marker>();
  private readonly shelters: Shelter[] = [];
  private readonly bodies = new ActorBodies();
  private readonly fp = new Footprint();
  private readonly at = new Vector3();
  private readonly to = new Vector3();
  /** Anatomical socket lookup (cached per drawn root); the preview reuses it so both draw the same joints. */
  readonly sockets = new CompanionSockets();
  private readonly jobs: Job[] = Array.from({ length: MAX_LIVE_JOBS }, createJob);
  private readonly p = new Vector3();
  private readonly q = new Vector3();
  private readonly d = new Vector3();
  private seedMeshes: Mesh[] | undefined;
  private readonly seedUsed: boolean[] = new Array<boolean>(SEED_POOL).fill(false);
  private actors: readonly ActorSnapshot[] = [];
  private destroyed = false;

  constructor(
    private readonly vfx: VfxSystem,
    private readonly resolveRoot: ((actorId: string) => Object3D | undefined) | undefined,
    private impact?: ImpactSink,
  ) {}

  setImpactSink(impact: ImpactSink | undefined): void { this.impact = impact; }

  /** Number of live persistent markers and shelters (probe for tests and the debug overlay). */
  get activeCount(): number { return this.markers.size + this.shelters.length; }

  /** Number of live socket-driven jobs and visible seed meshes (probes for tests and the debug overlay). */
  get liveJobCount(): number { let n = 0; for (const job of this.jobs) if (job.active) n++; return n; }
  get visibleSeedCount(): number { let n = 0; if (this.seedMeshes) for (const mesh of this.seedMeshes) if (mesh.visible) n++; return n; }

  /** Feeds one companion cue ('mark' | 'guard' | 'command' | 'shelter'). Returns false for any other kind. */
  play(cue: StoryCue, owner: number): boolean {
    if (this.destroyed) return false;
    const vfx = this.vfx, time = vfx.time;
    switch (cue.kind) {
      case 'mark': {
        // Vara's mark lands: a sky ring and flash on the target (the persistent marker follows the snapshot).
        const at = cue.position ?? cue.to;
        if (!at) return false;
        this.fp.set('disk', at.x, at.y, at.z, 0, 1.2, 1.2);
        vfx.ground.spawn('shock', this.fp, MARK_ELEMENT, owner, time, 0.45);
        vfx.flash(at.x, at.y + 1, at.z, 1.4, MARK_ELEMENT, owner, 0.2);
        vfx.sparks(at.x, at.y + 1, at.z, 10, 2.6, MARK_ELEMENT, owner, 0.5);
        // The screech leaves Vara's actual beak as expanding rings along its bite direction.
        this.socketBurst(cue.actorId, 'vara', MOUTH, 'ring', 3, owner, MARK_ELEMENT);
        return true;
      }
      case 'guard': return this.playGuard(cue, owner);
      case 'command': {
        const skill = companionSkillByAction(String(cue.actionId));
        if (skill) return this.playSkill(cue, owner, skill);
        // A ring where the command lands (the target, else the companion), in the command's hue.
        const at = cue.position ?? cue.to;
        if (!at) return false;
        const element = COMMAND_ELEMENT[String(cue.actionId)] ?? 'spirit';
        this.fp.set('disk', at.x, at.y, at.z, 0, 0.9, 0.9);
        vfx.ground.spawn('shock', this.fp, element, owner, time, 0.4);
        vfx.glow(at.x, at.y + 0.5, at.z, 0.8, 0.3, element, 0.45, owner, 0.4);
        return true;
      }
      case 'shelter': {
        const at = cue.position;
        if (!at) return false;
        if (cue.phase === 'sustain') {
          if (this.shelters.length >= MAX_SHELTERS) return false;
          const w = (cue.footprint?.width ?? 4) / 2, l = (cue.footprint?.length ?? 4) / 2;
          this.fp.set('disk', at.x, at.y, at.z, 0, w, l);
          const ground = vfx.ground.spawn('fill', this.fp, SHELTER_ELEMENT, COMPANION_VFX_OWNER, time, 0, 1);
          this.shelters.push({ ground, endTick: cue.worldTick + (cue.durationTicks ?? 0), scopeId: cue.scopeId });
          if (ground) vfx.ground.drive(ground, 1, 0.9, 0.7, 0.4);
        } else {
          // Resolved (safe or reset): the ring is released with the scope; a soft gold bloom settles where it stood.
          this.releaseShelters(cue.scopeId);
          vfx.glow(at.x, at.y + 0.6, at.z, 1.6, 0.6, SHELTER_ELEMENT, 0.4, owner, 0.3);
        }
        return true;
      }
      case 'storm-talon': return this.playStorm(cue, owner);
      default:
        return false;
    }
  }

  /** Authoritative world tick: ages shelters and drives every live socket job (sockets are read at the drawn pose of this frame); called from StoryEffects.update. */
  tick(worldTick: number): void {
    if (this.destroyed) return;
    for (let i = this.shelters.length - 1; i >= 0; i--) if (worldTick >= this.shelters[i]!.endTick) this.releaseShelter(i);
    for (const shelter of this.shelters) if (shelter.ground) this.vfx.ground.drive(shelter.ground, 1, 0.9, this.vfx.reducedEffects ? 0.7 : 0.6 + 0.15 * Math.sin(worldTick / 60 * 4), 0.4);
    for (const job of this.jobs) if (job.active) this.driveLiveJob(job, worldTick);
  }

  /** Snapshot pass: creates, moves and drives the persistent markers of the actors that carry a mark, guard or job; releases every marker whose field is gone. */
  update(actors: readonly ActorSnapshot[]): void {
    if (this.destroyed) return;
    this.actors = actors;
    // A companion that is downed or out of view (recall, death, hidden) ends its live effects at once; absence from the list alone is left to the cancel cues.
    for (const job of this.jobs) {
      if (!job.active) continue;
      const owner = this.find(actors, job.actorId);
      if (owner && (owner.downed || !owner.visible)) this.releaseJob(job);
    }
    for (const marker of this.markers.values()) marker.seen = false;
    let marks = 0, guards = 0, jobs = 0;
    for (const actor of actors) {
      if (!actor.visible) continue;
      if (actor.mark && marks < MAX_MARKS) { marks++; this.driveMark(actor); }
      if (actor.guard && guards < MAX_GUARDS) { guards++; this.driveGuard(actor, actors); }
      if (actor.job && jobs < MAX_JOBS) { const driven = this.driveJob(actor, actors); if (driven) jobs++; }
    }
    for (const [key, marker] of this.markers) if (!marker.seen) { this.releaseMarker(marker); this.markers.delete(key); }
  }

  /** Releases everything (death, retry, load, region unload, cinematic skip). */
  clear(): void {
    for (const marker of this.markers.values()) this.releaseMarker(marker);
    this.markers.clear();
    this.actors = [];
    for (let i = this.shelters.length - 1; i >= 0; i--) this.releaseShelter(i);
    for (const job of this.jobs) if (job.active) this.releaseJob(job);
  }

  /** Releases the shelter and every live job (seed, trails, streams) of a cancelled cue scope. */
  cancelScope(scopeId: string): void {
    this.releaseShelters(scopeId);
    for (const job of this.jobs) if (job.active && job.scopeId === scopeId) this.releaseJob(job);
  }

  dispose(): void {
    if (this.destroyed) return;
    this.clear();
    this.destroyed = true;
    if (this.seedMeshes) {
      const geometry = this.seedMeshes[0]!.geometry, material = this.seedMeshes[0]!.material as MeshBasicMaterial;
      for (const mesh of this.seedMeshes) mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
      this.seedMeshes = undefined;
    }
  }

  // ---- markers ----

  private driveMark(actor: ActorSnapshot): void {
    const mark = actor.mark!;
    const key = 'mark:' + actor.id;
    let marker = this.markers.get(key);
    if (!marker) {
      const vfx = this.vfx, radius = this.radiusOf(actor);
      this.fp.set('disk', actor.position.x, actor.position.y, actor.position.z, 0, radius, radius);
      const ring = vfx.ground.spawn('fill', this.fp, MARK_ELEMENT, COMPANION_VFX_OWNER, vfx.time, 0, 1);
      this.fp.set('disk', mark.landing?.x ?? 0, mark.landing?.y ?? 0, mark.landing?.z ?? 0, 0, 1.2, 1.2);
      const landing = mark.landing ? vfx.ground.spawn('fill', this.fp, MARK_ELEMENT, COMPANION_VFX_OWNER, vfx.time, 0, 1) : undefined;
      const pillar = vfx.beams.acquire(COMPANION_VFX_OWNER, vfx.time, 0, 0.14, 0.01, MARK_ELEMENT);
      const beam = mark.landing ? vfx.beams.acquire(COMPANION_VFX_OWNER, vfx.time, 0, 0.1, 0.02, MARK_ELEMENT) : undefined;
      marker = { kind: 'mark', ring, landing, beam, pillar, seen: true, state: undefined };
      this.markers.set(key, marker);
    }
    marker.seen = true;
    const position = this.positionOf(actor, this.at), height = this.heightOf(actor);
    const fade = clamp01(mark.remainingTicks / MARK_FADE_TICKS);
    const pulse = this.vfx.reducedEffects ? 0.85 : 0.65 + 0.25 * Math.sin(this.vfx.time * 7) * (mark.remainingTicks < MARK_FADE_TICKS * 2 ? 1.6 : 1);
    const alpha = clamp01(pulse) * fade;
    if (marker.ring) { this.place(marker.ring, position.x, actor.position.y, position.z); this.vfx.ground.drive(marker.ring, 1, 1.1, alpha, 0.5); }
    if (marker.pillar) {
      marker.pillar.a.set(position.x, position.y + height + HEIGHT_OFFSET, position.z);
      marker.pillar.b.set(position.x, position.y + height + HEIGHT_OFFSET + 1.1, position.z);
      marker.pillar.alpha = alpha;
    }
    if (mark.landing) {
      // The committed landing point of the marked boss, with a low line from the boss to it.
      if (marker.landing) { this.place(marker.landing, mark.landing.x, mark.landing.y, mark.landing.z); this.vfx.ground.drive(marker.landing, 1, 1.2, alpha, 0.6); }
      if (marker.beam) {
        marker.beam.a.set(position.x, actor.position.y + 0.2, position.z);
        marker.beam.b.set(mark.landing.x, mark.landing.y + 0.2, mark.landing.z);
        marker.beam.alpha = alpha * 0.6;
      }
    }
  }

  private driveGuard(actor: ActorSnapshot, actors: readonly ActorSnapshot[]): void {
    const guard = actor.guard!;
    const key = 'guard:' + actor.id;
    const protectee = this.find(actors, guard.protecteeId);
    if (!protectee) return;
    let marker = this.markers.get(key);
    if (!marker) {
      const vfx = this.vfx;
      this.fp.set('disk', protectee.position.x, protectee.position.y, protectee.position.z, 0, 1.5, 1.5);
      const ring = vfx.ground.spawn('fill', this.fp, GUARD_ELEMENT, COMPANION_VFX_OWNER, vfx.time, 0, 1);
      const beam = vfx.beams.acquire(COMPANION_VFX_OWNER, vfx.time, 0, 0.12, 0.02, GUARD_ELEMENT);
      marker = { kind: 'guard', ring, landing: undefined, beam, pillar: undefined, seen: true, state: guard.state };
      this.markers.set(key, marker);
    }
    marker.seen = true;
    const blocking = guard.state === 'blocking', recovering = guard.state === 'recovery';
    const alpha = recovering ? 0.35 : blocking ? 1 : this.vfx.reducedEffects ? 0.7 : 0.55 + 0.2 * Math.sin(this.vfx.time * 6);
    if (marker.ring) {
      this.place(marker.ring, protectee.position.x, protectee.position.y, protectee.position.z);
      this.vfx.ground.drive(marker.ring, 1, blocking ? 1.6 : 1, alpha, 0.5);
    }
    if (marker.beam) {
      // Asha's line to the one she shields; it ends once she has moved into the intercept.
      const from = this.positionOf(actor, this.at), to = this.positionOf(protectee, this.to);
      marker.beam.a.set(from.x, from.y + 0.9, from.z); marker.beam.b.set(to.x, to.y + 0.9, to.z);
      marker.beam.alpha = guard.state === 'moving' ? alpha * 0.7 : 0;
    }
    marker.state = guard.state;
  }

  /** Returns true when a marker is drawn (the job targets a live actor in view). */
  private driveJob(actor: ActorSnapshot, actors: readonly ActorSnapshot[]): boolean {
    const job = actor.job!;
    const target = job.targetId ? this.find(actors, job.targetId) : undefined;
    if (!target || !target.visible) return false;
    const key = 'job:' + actor.id;
    let marker = this.markers.get(key);
    const element = COMMAND_ELEMENT[job.command] ?? 'spirit';
    if (!marker) {
      const vfx = this.vfx, radius = Math.max(0.7, this.radiusOf(target) * 0.9);
      this.fp.set('disk', target.position.x, target.position.y, target.position.z, 0, radius, radius);
      const ring = vfx.ground.spawn('fill', this.fp, element, COMPANION_VFX_OWNER, vfx.time, 0, 1);
      marker = { kind: 'job', ring, landing: undefined, beam: undefined, pillar: undefined, seen: true, state: job.command };
      this.markers.set(key, marker);
    }
    marker.seen = true;
    const alpha = this.vfx.reducedEffects ? 0.6 : 0.45 + 0.15 * Math.sin(this.vfx.time * 5), fade = clamp01(job.remainingTicks / MARK_FADE_TICKS);
    if (marker.ring) { this.place(marker.ring, target.position.x, target.position.y, target.position.z); this.vfx.ground.drive(marker.ring, 1, 0.9, alpha * fade, 0.4); }
    return true;
  }

  private playSkill(cue: StoryCue, owner: number, skill: CompanionSkill): boolean {
    if (cue.phase === 'resolve') { this.releaseJobsOf(cue.scopeId, 'skill'); return true; }
    const at = cue.position ?? cue.to;
    if (!at) return false;
    const element = SKILL_ELEMENT[skill.element];
    if (cue.phase === 'hit') this.skillHit(cue, owner, skill, element, at);
    else if (cue.phase === 'anticipation' || cue.phase === 'commit') {
      const tick = cue.phaseStartedAtWorldTick ?? cue.worldTick;
      const job = this.skillJob(cue, owner, skill, element, tick);
      if (cue.phase === 'commit') this.commitSeed(job, cue, at, tick);
    }
    return true;
  }

  /** The job of this skill scope; created by the first anticipation or commit cue, with its windows taken from the skill's unchanged authored timing. */
  private skillJob(cue: StoryCue, owner: number, skill: CompanionSkill, element: VfxElement, tick: number): Job {
    const existing = this.findJob(cue.scopeId, 'skill');
    if (existing) return existing;
    const start = cue.phase === 'commit' ? tick - skill.ticks * skill.release : tick;
    const job = this.beginJob('skill', skill.companionId, cue.actorId ?? skill.companionId, cue.scopeId, owner, element, start, start + skill.ticks + 6);
    job.skill = skill; job.targetId = cue.targetId; job.streams = STREAMS[skill.id] ?? []; job.trail = TRAILS[skill.id];
    if (skill.id === 'canopy-route') job.seed = this.acquireSeed();
    return job;
  }

  /** The commit cue detaches the Mending Seed from Koro's hand exactly once; repeated commits for the scope do nothing. */
  private commitSeed(job: Job, cue: StoryCue, at: Readonly<{ x: number; y: number; z: number }>, tick: number): void {
    if (job.committed) return;
    job.committed = true; job.commitTick = tick; job.flight = Math.max(1, cue.durationTicks ?? 1);
    job.aim.set(at.x, at.y + (cue.targetId ? .7 : .12), at.z);
    job.targetId = cue.targetId ?? job.targetId;
    if (job.seed < 0) return;
    const root = this.resolveRoot?.(job.actorId), mesh = this.seedMeshes![job.seed]!;
    if (root && this.sockets.position(root, job.companionId, 'rightHand', job.origin)) mesh.position.copy(job.origin);
    else if (mesh.visible) job.origin.copy(mesh.position);
    else this.releaseSeed(job);
  }

  /** Confirmed contact of a skill: the target-side impact and the owner's benefit. Nothing here runs from time expiry alone. */
  private skillHit(cue: StoryCue, owner: number, skill: CompanionSkill, element: VfxElement, at: Readonly<{ x: number; y: number; z: number }>): void {
    const vfx = this.vfx, tx = at.x, tz = at.z, ty = at.y + (cue.targetId ? .7 : .12);
    if (skill.command === 'search') {
      // The reveal: a ground ring where the search resolved and one accent from the body part that searched.
      const radius = REVEAL_RADIUS[skill.companionId], accent = REVEAL[skill.companionId];
      this.fp.set('disk', tx, at.y, tz, 0, radius, radius);
      vfx.ground.spawn('shock', this.fp, element, owner, vfx.time, .8);
      this.socketBurst(cue.actorId, skill.companionId, accent.sockets, accent.kind, accent.count, owner, element);
      return;
    }
    if (skill.command === 'distract') {
      // Shared attention punctuation, small and on the target; the casting gesture above identifies its owner.
      vfx.glow(tx, ty + .4, tz, .5, .6, element, .5, owner);
      this.fp.set('disk', tx, at.y, tz, 0, .8, .8);
      vfx.ground.spawn('shock', this.fp, element, owner, vfx.time, .5);
      return;
    }
    // Contact marker and sky flash of Mark Weakness belong to the actual mark cue; Ember Rally buffs only its owner, so neither gets a plume on the hostile.
    if (skill.id === 'sky-mark') return;
    if (skill.id === 'crown-rally') { this.ownerBenefit(cue, element, owner); return; }
    this.elementMotion(tx, at.y + .12, tz, element, owner);
    switch (skill.id) {
      case 'canopy-route': {
        // The seed has arrived: it vanishes into a blossom on the target and the heal reaches the owner.
        const job = this.findJob(cue.scopeId, 'skill');
        if (job) this.releaseSeed(job);
        vfx.leaves(tx, ty, tz, 14, .25, 0, 0, owner);
        vfx.glow(tx, ty, tz, .9, .5, element, .45, owner, .3);
        this.fp.set('disk', tx, at.y, tz, 0, 1.1, 1.1);
        vfx.ground.spawn('shock', this.fp, element, owner, vfx.time, .6);
        this.ownerBenefit(cue, element, owner);
        return;
      }
      case 'canopy-move': vfx.dustRing(tx, at.y, tz, .9, 10, owner); return;
      case 'fang-guard': vfx.sparks(tx, ty, tz, 14, 3, element, owner); return;
      case 'fang-pin': {
        // Stun ring: a ground ring under the pinned enemy and a halo at its head.
        const root = cue.targetId ? this.resolveRoot?.(cue.targetId) : undefined;
        this.fp.set('disk', tx, at.y, tz, 0, 1.2, 1.2);
        vfx.ground.spawn('shock', this.fp, element, owner, vfx.time, .7);
        this.p.set(tx, at.y + (root ? this.bodies.get(root).height : 1.2) + .15, tz);
        this.d.set(0, 0, 0);
        this.ring(0, .9, .7, element, owner);
        vfx.sparks(tx, ty, tz, 10, 1.8, element, owner);
        this.impact?.shake(.07, .14, 20);
        return;
      }
      case 'pack-flank':
        this.fp.set('disk', tx, at.y, tz, 0, 1.7, 1.7);
        vfx.ground.spawn('shock', this.fp, element, owner, vfx.time, 1.2);
        // The bite: a splash at the drawn jaw, wherever the flank has carried it.
        this.socketBurst(cue.actorId, 'sable', MOUTH, 'wake', 5, owner, element);
        return;
      case 'shadow-ambush':
        this.ownerBenefit(cue, element, owner);
        vfx.sparks(tx, ty, tz, 8, 2.5, element, owner);
        return;
      // crown-rally is handled before the generic target plume.
      default: return;
    }
  }

  private playGuard(cue: StoryCue, owner: number): boolean {
    if (cue.phase === 'resolve') { this.releaseJobsOf(cue.scopeId, 'guard'); return true; }
    const at = cue.position ?? cue.to;
    if (!at) return false;
    const vfx = this.vfx, time = vfx.time;
    if (cue.phase === 'hit') {
      // The block lands: an amber ring, a flash and sparks at the contact point, dust at the braced paws, and a short shake for the player.
      this.fp.set('disk', at.x, at.y, at.z, 0, 1.4, 1.4);
      vfx.ground.spawn('shock', this.fp, GUARD_ELEMENT, owner, time, 0.4);
      vfx.flash(at.x, at.y + 0.9, at.z, 1.6, GUARD_ELEMENT, owner, 0.22);
      vfx.sparks(at.x, at.y + 0.9, at.z, 18, 4, GUARD_ELEMENT, owner, 0.5);
      this.socketBurst(cue.actorId, 'asha', PAWS, 'dust', 4, owner, GUARD_ELEMENT);
      this.impact?.shake(0.12, 0.2, 24);
    } else if (cue.phase === 'anticipation') {
      this.fp.set('disk', at.x, at.y, at.z, 0, 1.1, 1.1);
      vfx.ground.spawn('shock', this.fp, GUARD_ELEMENT, owner, time, 0.35);
      // The arch rises from Asha's own braced forepaws (not from the remote guard point) and lasts until the guard resolves.
      if (!this.findJob(cue.scopeId, 'guard')) {
        const tick = cue.phaseStartedAtWorldTick ?? cue.worldTick;
        this.beginJob('guard', 'asha', cue.actorId ?? 'asha', cue.scopeId, owner, GUARD_ELEMENT, tick, tick + GUARD_ARCH_TICKS);
      }
    } else vfx.glow(at.x, at.y + 0.8, at.z, 1, 0.4, GUARD_ELEMENT, 0.4, owner, 0.3);
    return true;
  }

  private playStorm(cue: StoryCue, owner: number): boolean {
    const at = cue.position ?? cue.to;
    if (!at) return false;
    const vfx = this.vfx, time = vfx.time, tick = cue.phaseStartedAtWorldTick ?? cue.worldTick;
    const job = () => this.findJob(cue.scopeId, 'storm') ?? this.beginJob('storm', 'vara', cue.actorId ?? 'vara', cue.scopeId, owner, 'wind', tick, tick + STORM_JOB_TICKS);
    switch (cue.phase) {
      case 'anticipation': case 'commit': {
        // Takeoff: a dust ring where she leaves the ground, and the wing feathers that follow her wings through the climb.
        this.fp.set('disk', at.x, at.y, at.z, 0, 1.4, 1.4);
        vfx.ground.spawn('shock', this.fp, 'wind', owner, time, 0.5);
        vfx.flash(at.x, at.y + 1, at.z, 1.4, 'wind', owner, 0.25);
        vfx.sparks(at.x, at.y + 1, at.z, 12, 2.6, 'wind', owner, 0.5);
        const live = job();
        live.stormMode = 1; live.stormEnd = tick + (cue.durationTicks ?? 18); live.end = Math.max(live.end, live.stormEnd + STORM_JOB_TICKS);
        break;
      }
      case 'active': {
        // Dive: talon ribbons and sparks follow her actual talons through the swept dive (no remote lane).
        const live = job();
        live.stormMode = 2; live.stormEnd = tick + (cue.durationTicks ?? 21); live.end = Math.max(live.end, live.stormEnd + STORM_JOB_TICKS);
        break;
      }
      case 'hit': {
        // Strike: wind shock ring and crackle at the confirmed contact, sparks at her talons, the tailwind benefit at the owner, bounded shake.
        this.fp.set('disk', at.x, at.y, at.z, 0, 1.6, 1.6);
        vfx.ground.spawn('shock', this.fp, 'wind', owner, time, 0.45);
        vfx.flash(at.x, at.y + 1.0, at.z, 1.6, 'wind', owner, 0.3);
        vfx.sparks(at.x, at.y + 1.0, at.z, 18, 4, 'wind', owner, 0.6);
        this.elementMotion(at.x, at.y + .4, at.z, 'wind', owner);
        this.socketBurst(cue.actorId, 'vara', TALONS, 'bolt', 3, owner, 'wind');
        this.ownerBenefit(cue, 'wind', owner);
        this.impact?.shake(0.06, 0.14, 20);
        this.releaseJobsOf(cue.scopeId, 'storm');
        break;
      }
      case 'sustain':
        // Mark screech: expanding wind-ring at the mark landing point and rings leaving the actual beak.
        this.fp.set('disk', at.x, at.y, at.z, 0, 1.2, 1.2);
        vfx.ground.spawn('shock', this.fp, 'wind', owner, time, 0.5);
        this.socketBurst(cue.actorId, 'vara', MOUTH, 'ring', 3, owner, 'wind');
        break;
      case 'landing':
        // Landing: dust at the talons that touch the perch, and a settling flash; the dive job ends.
        this.fp.set('disk', at.x, at.y, at.z, 0, 1.0, 1.0);
        vfx.ground.spawn('shock', this.fp, 'wind', owner, time, 0.4);
        vfx.flash(at.x, at.y + 0.6, at.z, 1.0, 'wind', owner, 0.18);
        this.socketBurst(cue.actorId, 'vara', TALONS, 'dust', 3, owner, 'wind');
        this.releaseJobsOf(cue.scopeId, 'storm');
        break;
      default: break;
    }
    return true;
  }

  /** Bounded moving silhouettes: rising embers/leaves, falling droplets, and tangential wind wisps. */
  private elementMotion(x: number, y: number, z: number, element: VfxElement, owner: number): void {
    const vfx = this.vfx, count = vfx.reducedEffects ? 4 : 16, color = PALETTE[element].b;
    for (let i = 0; i < count; i++) {
      const angle = i * Math.PI * 2 / count, c = Math.cos(angle), s = Math.sin(angle), p = vfx.spec();
      const water = element === 'water', earth = element === 'earth', wind = element === 'wind', wood = element === 'spirit';
      p.x = x + c * .45; p.y = y + (water ? .35 : .1); p.z = z + s * .45;
      p.vx = wind || water ? -s * 1.5 + c * .5 : c * .65;
      p.vz = wind || water ? c * 1.5 + s * .5 : s * .65;
      p.vy = earth ? 1.8 : water ? 1.1 : wood ? .85 : 1.5;
      p.gravity = earth ? 7 : water ? 3.2 : -.25; p.drag = .4;
      p.life = earth ? .65 : .9; p.size0 = wood ? .16 : .09; p.size1 = .025;
      p.frame = water ? VFX_FRAME.drop : wood ? VFX_FRAME.leaf : VFX_FRAME.spark;
      p.spin = wind ? 5 : wood ? 2.5 : .8;
      p.r0 = p.r1 = color.r; p.g0 = p.g1 = color.g; p.b0 = p.b1 = color.b;
      p.a0 = .75; p.fadeIn = .05; p.fadeOut = .7;
      vfx.emit(water || wood || earth ? vfx.particles.alpha : vfx.particles.additive, owner);
    }
  }

  /** Owner-only benefit at the real player (motes, a ring, and an ember aura for fire); never implies that every nearby NPC gained a buff. Callers invoke it only from a confirmed hit cue. */
  private ownerBenefit(cue: StoryCue, element: VfxElement, owner: number): void {
    const root = cue.actorId ? this.resolveRoot?.(cue.actorId) : undefined;
    const source = root ? root.getWorldPosition(this.at) : cue.from ?? cue.position;
    if (!source) return;
    const player = this.actors.find(actor => actor.allegiance === 'player' && actor.visible && !actor.downed);
    if (!player || Math.hypot(player.position.x - source.x, player.position.z - source.z) > 12) return;
    const p = this.positionOf(player, this.to);
    this.elementMotion(p.x, p.y + .1, p.z, element, owner);
    this.fp.set('disk', p.x, p.y, p.z, 0, 1.1, 1.1);
    this.vfx.ground.spawn('shock', this.fp, element, owner, this.vfx.time, .9);
    if (element === 'fire') this.vfx.embers(p.x, p.y + .2, p.z, 12, .55, .8, -.35, owner, 'fire');
  }

  // ---- live socket jobs ----

  private findJob(scopeId: string | undefined, kind: Job['kind']): Job | undefined {
    if (scopeId === undefined) return undefined;
    for (const job of this.jobs) if (job.active && job.kind === kind && job.scopeId === scopeId) return job;
    return undefined;
  }

  /** Takes a free job (the oldest is retired when all are busy, releasing its beams and seed) and resets it; nothing is allocated. */
  private beginJob(kind: Job['kind'], companionId: CompanionId, actorId: string, scopeId: string | undefined, owner: number, element: VfxElement, start: number, end: number): Job {
    let job = this.jobs.find(candidate => !candidate.active);
    if (!job) {
      job = this.jobs[0]!;
      for (const candidate of this.jobs) if (candidate.start < job.start) job = candidate;
      this.releaseJob(job);
    }
    job.active = true; job.kind = kind; job.skill = undefined; job.companionId = companionId; job.actorId = actorId; job.targetId = undefined;
    job.scopeId = scopeId; job.owner = owner; job.element = element; job.start = start; job.last = start; job.end = end;
    job.streams = []; job.next.fill(0); job.trail = undefined;
    job.beams[0] = job.beams[1] = undefined; job.followed[0] = job.followed[1] = false;
    job.seed = -1; job.committed = false; job.commitTick = 0; job.flight = 1; job.hasPrev = false; job.prevTick = 0; job.stormMode = 0; job.stormEnd = 0;
    return job;
  }

  /** Frees a job's pooled beams, seed mesh and scope; idempotent. */
  private releaseJob(job: Job): void {
    for (let i = 0; i < 2; i++) {
      const beam = job.beams[i];
      if (beam && beam.active && beam.owner === job.owner) this.vfx.beams.release(beam);
      job.beams[i] = undefined; job.followed[i] = false;
    }
    this.releaseSeed(job);
    job.active = false; job.scopeId = undefined; job.skill = undefined; job.streams = []; job.trail = undefined;
  }

  private releaseJobsOf(scopeId: string | undefined, kind: Job['kind']): void {
    const job = this.findJob(scopeId, kind);
    if (job) this.releaseJob(job);
  }

  private acquireSeed(): number {
    if (!this.seedMeshes) {
      const geometry = new SphereGeometry(1, 8, 6), material = new MeshBasicMaterial({ color: 0x8fb43c });
      this.seedMeshes = [];
      for (let i = 0; i < SEED_POOL; i++) {
        const mesh = new Mesh(geometry, material);
        mesh.name = 'companion-seed'; mesh.visible = false; mesh.frustumCulled = false; mesh.renderOrder = 12; mesh.scale.set(.1, .075, .13);
        this.vfx.group.add(mesh);
        this.seedMeshes.push(mesh);
      }
    }
    for (let i = 0; i < SEED_POOL; i++) if (!this.seedUsed[i]) { this.seedUsed[i] = true; return i; }
    return -1;
  }

  private releaseSeed(job: Job): void {
    if (job.seed < 0) return;
    this.seedMeshes![job.seed]!.visible = false;
    this.seedUsed[job.seed] = false;
    job.seed = -1;
  }

  private driveLiveJob(job: Job, worldTick: number): void {
    if (worldTick >= job.end) { this.releaseJob(job); return; }
    const dtTicks = Math.max(0, worldTick - job.last), root = this.resolveRoot?.(job.actorId);
    job.last = worldTick;
    if (job.kind === 'guard') this.driveArch(job, root, worldTick);
    else if (job.kind === 'storm') this.driveStorm(job, root, worldTick, dtTicks);
    else this.driveSkill(job, root, worldTick, dtTicks);
  }

  private driveSkill(job: Job, root: Object3D | undefined, worldTick: number, dtTicks: number): void {
    const skill = job.skill!, rel = (worldTick - job.start) / skill.ticks, slow = this.vfx.reducedEffects ? 2 : 1;
    if (job.seed >= 0) this.driveSeed(job, root, worldTick);
    if (job.trail) this.driveTrails(job, job.trail.sockets, root, dtTicks, rel >= job.trail.from && rel <= job.trail.to);
    if (!root) return;
    for (let i = 0; i < job.streams.length; i++) {
      const stream = job.streams[i]!;
      if (rel < stream.from || rel > stream.to || worldTick < job.next[i]!) continue;
      job.next[i] = worldTick + stream.every * slow;
      if (stream.kind === 'afterimage') {
        root.getWorldPosition(this.p);
        this.vfx.glow(this.p.x, this.p.y + this.bodies.get(root).height * .5, this.p.z, .8, .22, job.element, .35, job.owner);
      } else this.emitAtSockets(root, job.companionId, stream.sockets, stream.kind, stream.count, job.owner, job.element, job, worldTick);
    }
  }

  /** Held in Koro's right hand until the commit cue, then one flight from that hand to the target over the cue's own ticks; released at arrival or with the job. */
  private driveSeed(job: Job, root: Object3D | undefined, worldTick: number): void {
    const mesh = this.seedMeshes![job.seed]!, vfx = this.vfx;
    if (!job.committed) {
      mesh.visible = Boolean(root) && this.sockets.position(root!, job.companionId, 'rightHand', this.p);
      if (mesh.visible) mesh.position.copy(this.p);
      mesh.rotation.set(0, worldTick * .05, 0);
      return;
    }
    const u = (worldTick - job.commitTick) / job.flight;
    if (u >= 1) { this.releaseSeed(job); return; }
    // The seed flies to the endpoint committed by the cue and never re-aims: a target that moves away makes the simulation miss, and the seed must show it.
    const e = clamp01(u);
    this.p.lerpVectors(job.origin, job.aim, e);
    this.p.y += Math.min(.9, .22 * job.origin.distanceTo(job.aim)) * 4 * e * (1 - e);
    mesh.position.copy(this.p);
    mesh.rotation.set(e * 10, e * 14, 0);
    mesh.visible = true;
    if (worldTick >= job.next[0]!) {
      job.next[0] = worldTick + FLIGHT_TRAIL_TICKS * (vfx.reducedEffects ? 2 : 1);
      vfx.leaves(this.p.x, this.p.y, this.p.z, 1, .05, 0, 0, job.owner);
      vfx.glow(this.p.x, this.p.y, this.p.z, .28, .3, job.element, .4, job.owner);
    }
  }

  /** Pooled lightning/wind ribbons from each socket back to a lagging follower of itself; the beams exist only while `active`. */
  private driveTrails(job: Job, sockets: readonly CompanionSocketName[], root: Object3D | undefined, dtTicks: number, active: boolean): void {
    for (let i = 0; i < sockets.length && i < 2; i++) {
      let beam = job.beams[i];
      if (beam && (!beam.active || beam.owner !== job.owner)) { beam = undefined; job.beams[i] = undefined; }
      if (!active) {
        if (beam) this.vfx.beams.release(beam);
        job.beams[i] = undefined; job.followed[i] = false;
        continue;
      }
      if (!root || !this.sockets.position(root, job.companionId, sockets[i]!, this.p)) { if (beam) beam.alpha = 0; continue; }
      const follow = job.follow[i]!;
      if (!job.followed[i]) { follow.copy(this.p); job.followed[i] = true; } else follow.lerp(this.p, 1 - Math.pow(.55, dtTicks));
      if (!beam) { beam = this.vfx.beams.acquire(job.owner, this.vfx.time, 0, .05, .02, job.element); job.beams[i] = beam; }
      if (beam) { beam.a.copy(this.p); beam.b.copy(follow); beam.alpha = this.vfx.reducedEffects ? .55 : .85; }
    }
  }

  /** Asha's guard arch: a brace line between her actual planted forepaws and a glow arc rising from them, rebuilt on the world clock. */
  private driveArch(job: Job, root: Object3D | undefined, worldTick: number): void {
    let beam = job.beams[0];
    if (beam && (!beam.active || beam.owner !== job.owner)) { beam = undefined; job.beams[0] = undefined; }
    if (!root || !this.sockets.position(root, 'asha', 'rightPaw', this.p) || !this.sockets.position(root, 'asha', 'leftPaw', this.q)) { if (beam) beam.alpha = 0; return; }
    const vfx = this.vfx, reduced = vfx.reducedEffects;
    if (!beam) { beam = vfx.beams.acquire(job.owner, vfx.time, 0, .07, .01, job.element); job.beams[0] = beam; }
    if (beam) { beam.a.copy(this.q); beam.b.copy(this.p); beam.alpha = reduced ? .5 : .75; }
    if (worldTick < job.next[0]!) return;
    job.next[0] = worldTick + (reduced ? 8 : 4);
    const height = this.bodies.get(root).height * .4, step = reduced ? 2 : 1;
    for (let k = 0; k < 5; k += step) {
      const u = (k + .5) / 5;
      vfx.glow(this.q.x + (this.p.x - this.q.x) * u, this.q.y + (this.p.y - this.q.y) * u + Math.sin(Math.PI * u) * height, this.q.z + (this.p.z - this.q.z) * u, .16, .2, job.element, .5, job.owner);
    }
  }

  /** Vara's takeoff (wing feathers) and dive (talon ribbons and sparks), each only inside its cue's phase window. */
  private driveStorm(job: Job, root: Object3D | undefined, worldTick: number, dtTicks: number): void {
    if (job.stormMode !== 0 && worldTick >= job.stormEnd) job.stormMode = 0;
    const slow = this.vfx.reducedEffects ? 2 : 1;
    if (root && job.stormMode !== 0 && worldTick >= job.next[0]!) {
      job.next[0] = worldTick + (job.stormMode === 1 ? 2 : 3) * slow;
      this.emitAtSockets(root, 'vara', WINGS, 'feathers', 1, job.owner, job.element, job, worldTick);
    }
    if (root && job.stormMode === 2 && worldTick >= job.next[1]!) {
      job.next[1] = worldTick + 2 * slow;
      this.emitAtSockets(root, 'vara', TALONS, 'bolt', 1, job.owner, job.element, job, worldTick);
    }
    this.driveTrails(job, TALONS, root, dtTicks, job.stormMode === 2);
  }

  private emitAtSockets(root: Object3D, companionId: CompanionId, names: readonly CompanionSocketName[], kind: StreamKind, count: number, owner: number, element: VfxElement, job: Job | undefined, worldTick: number): void {
    for (const name of names) if (this.sockets.position(root, companionId, name, this.p)) this.streamFx(kind, name, root, companionId, count, owner, element, job, worldTick);
  }

  /** One-shot accent at the named sockets of a drawn companion; nothing when the body or a socket is not there. */
  private socketBurst(actorId: string | undefined, companionId: CompanionId, names: readonly CompanionSocketName[], kind: StreamKind, count: number, owner: number, element: VfxElement): void {
    const root = actorId ? this.resolveRoot?.(actorId) : undefined;
    if (root) this.emitAtSockets(root, companionId, names, kind, count, owner, element, undefined, 0);
  }

  /** Draws one accent at `this.p` (the socket's world position); mouth kinds also read the bite direction into `this.d`. */
  private streamFx(kind: StreamKind, socket: CompanionSocketName, root: Object3D, companionId: CompanionId, count: number, owner: number, element: VfxElement, job: Job | undefined, worldTick: number): void {
    const vfx = this.vfx, p = this.p;
    switch (kind) {
      // Repeated limb accents must not reuse the metre-wide impact cloud that hides the pose.
      case 'dust': vfx.smoke(p.x, p.y, p.z, count, .04, .06, .2, .32, VFX_COLORS.dust, .22, owner, .12); break;
      case 'leaves': vfx.leaves(p.x, p.y, p.z, count, .1, 0, 0, owner); break;
      case 'smoke': vfx.smoke(p.x, p.y, p.z, count, .1, .12, .26, .6, UMBRAL_SMOKE, .3, owner); break;
      case 'mist': vfx.smoke(p.x, p.y, p.z, count, .1, .12, .26, .55, VFX_COLORS.steam, .28, owner); break;
      case 'shards': vfx.shards(p.x, p.y, p.z, count, 1.1, owner); break;
      case 'print': vfx.glow(p.x, p.y + .04, p.z, .2, .7, element, .5, owner); break;
      case 'bolt': vfx.sparks(p.x, p.y, p.z, count * 2, 1.8, element, owner, .35); break;
      case 'wake': this.wake(count, owner); break;
      case 'feathers': this.feathers(count, owner, element); break;
      case 'ring':
        if (!this.sockets.direction(root, companionId, socket, this.d)) break;
        for (let i = 0; i < count; i++) this.ring(1.1 + i * .6, .9 + i * .3, .42, element, owner);
        break;
      case 'roar':
        if (!this.sockets.direction(root, companionId, socket, this.d)) break;
        this.ring(2.4, 1.6, .5, element, owner);
        this.ring(1.6, 1, .42, element, owner);
        this.roarCone(element, owner);
        break;
      case 'claw': if (job) this.claw(job, worldTick, owner, element); break;
      case 'afterimage': break;
    }
  }

  /** Expanding billboard ring leaving `this.p` along `this.d` (zero speed: a static halo). */
  private ring(speed: number, size1: number, life: number, element: VfxElement, owner: number): void {
    const vfx = this.vfx, p = this.p, d = this.d, color = PALETTE[element].b, s = vfx.spec();
    s.x = p.x; s.y = p.y; s.z = p.z; s.vx = d.x * speed; s.vy = d.y * speed; s.vz = d.z * speed;
    s.drag = .6; s.life = life; s.size0 = .15; s.size1 = size1; s.frame = VFX_FRAME.ring;
    s.r0 = s.r1 = color.r; s.g0 = s.g1 = color.g; s.b0 = s.b1 = color.b; s.a0 = .45; s.fadeIn = .05; s.fadeOut = .7;
    vfx.emit(vfx.particles.additive, owner);
  }

  /** Streaks fanned along the mouth direction, so the roar reads as a cone from the animated jaw. */
  private roarCone(element: VfxElement, owner: number): void {
    const vfx = this.vfx, p = this.p, d = this.d, hot = PALETTE[element].hot, b = PALETTE[element].b;
    for (let i = vfx.count(5); i > 0; i--) {
      const s = vfx.spec();
      s.x = p.x; s.y = p.y; s.z = p.z;
      s.vx = d.x * 3.2 + vfx.range(-1, 1); s.vy = d.y * 3.2 + vfx.range(-.8, .8); s.vz = d.z * 3.2 + vfx.range(-1, 1);
      s.drag = .8; s.gravity = .6; s.life = vfx.range(.3, .5); s.size0 = .06; s.size1 = .02; s.frame = VFX_FRAME.spark; s.stretch = .07;
      s.r0 = hot.r; s.g0 = hot.g; s.b0 = hot.b; s.r1 = b.r; s.g1 = b.g; s.b1 = b.b; s.fadeIn = .02; s.fadeOut = .5;
      vfx.emit(vfx.particles.additive, owner);
    }
  }

  private feathers(count: number, owner: number, element: VfxElement): void {
    const vfx = this.vfx, p = this.p, color = PALETTE[element].b;
    for (let i = vfx.count(count); i > 0; i--) {
      const s = vfx.spec();
      s.x = p.x; s.y = p.y; s.z = p.z; s.vx = vfx.range(-.5, .5); s.vy = vfx.range(-.1, .5); s.vz = vfx.range(-.5, .5);
      s.gravity = .8; s.drag = 1.2; s.life = .8; s.size0 = .14; s.size1 = .1; s.spin = vfx.random() * 6.28; s.spinRate = vfx.range(-4, 4); s.frame = VFX_FRAME.leaf;
      s.r0 = s.r1 = color.r; s.g0 = s.g1 = color.g; s.b0 = s.b1 = color.b; s.a0 = .85; s.fadeIn = .05; s.fadeOut = .7;
      vfx.emit(vfx.particles.alpha, owner);
    }
  }

  /** Droplets kicked up and a thin steam puff at `this.p` (a foot, or the biting mouth). */
  private wake(count: number, owner: number): void {
    const vfx = this.vfx, p = this.p, color = PALETTE.water.b;
    for (let i = vfx.count(count * 2); i > 0; i--) {
      const s = vfx.spec();
      s.x = p.x + vfx.range(-.07, .07); s.y = p.y + .05; s.z = p.z + vfx.range(-.07, .07);
      s.vx = vfx.range(-.6, .6); s.vy = vfx.range(1, 1.9); s.vz = vfx.range(-.6, .6);
      s.gravity = 8; s.drag = .3; s.life = vfx.range(.4, .6); s.size0 = .07; s.size1 = .035; s.frame = VFX_FRAME.drop;
      s.r0 = s.r1 = color.r; s.g0 = s.g1 = color.g; s.b0 = s.b1 = color.b; s.a0 = .85; s.fadeIn = .02; s.fadeOut = .5;
      vfx.emit(vfx.particles.alpha, owner);
    }
    vfx.smoke(p.x, p.y, p.z, 1, .1, .1, .3, .5, VFX_COLORS.steam, .3, owner);
  }

  /** Three parallel streaks laid along the paw's measured path since the last sample; nothing while the paw is nearly still. */
  private claw(job: Job, worldTick: number, owner: number, element: VfxElement): void {
    const vfx = this.vfx, p = this.p, prev = job.prev;
    if (!job.hasPrev) { prev.copy(p); job.hasPrev = true; job.prevTick = worldTick; return; }
    const dt = (worldTick - job.prevTick) / 60;
    if (dt <= 0) return;
    let vx = (p.x - prev.x) / dt, vy = (p.y - prev.y) / dt, vz = (p.z - prev.z) / dt;
    prev.copy(p); job.prevTick = worldTick;
    const speed = Math.hypot(vx, vy, vz);
    if (speed < .4) return;
    const k = Math.min(1, 9 / speed), flat = Math.hypot(vx, vz);
    vx *= k; vy *= k; vz *= k;
    const lx = flat > .05 ? -vz / Math.hypot(vx, vz) : 1, lz = flat > .05 ? vx / Math.hypot(vx, vz) : 0;
    const hot = PALETTE[element].hot, b = PALETTE[element].b;
    for (let n = -1; n <= 1; n++) {
      const s = vfx.spec();
      s.x = p.x + lx * n * .09; s.y = p.y; s.z = p.z + lz * n * .09;
      s.vx = vx * .3; s.vy = vy * .3; s.vz = vz * .3;
      s.drag = 2; s.life = .22; s.size0 = .07; s.size1 = .02; s.frame = VFX_FRAME.spark; s.stretch = .14;
      s.r0 = hot.r; s.g0 = hot.g; s.b0 = hot.b; s.r1 = b.r; s.g1 = b.g; s.b1 = b.b; s.fadeIn = .02; s.fadeOut = .6;
      vfx.emit(vfx.particles.additive, owner);
    }
  }

  // ---- helpers ----

  private find(actors: readonly ActorSnapshot[], id: string): ActorSnapshot | undefined {
    for (const actor of actors) if (actor.id === id) return actor;
    return undefined;
  }

  /** Drawn root position when the actor has a rendered body (it trails a step the simulation already took), else the simulation position. */
  private positionOf(actor: ActorSnapshot, out: Vector3): Vector3 {
    const root = this.resolveRoot?.(actor.id);
    return root ? root.getWorldPosition(out) : out.set(actor.position.x, actor.position.y, actor.position.z);
  }

  private heightOf(actor: ActorSnapshot): number {
    const root = this.resolveRoot?.(actor.id);
    return root ? this.bodies.get(root).height : 1.4;
  }

  private radiusOf(actor: ActorSnapshot): number {
    const root = this.resolveRoot?.(actor.id);
    return Math.max(0.8, (root ? this.bodies.get(root).radius : 0.8) * 1.15);
  }

  private place(slot: GroundSlot, x: number, y: number, z: number): void {
    slot.mesh.position.set(x, y + 0.05, z);
    slot.mesh.updateMatrix();
  }

  private releaseMarker(marker: Marker): void {
    if (marker.ring) this.vfx.ground.release(marker.ring);
    if (marker.landing) this.vfx.ground.release(marker.landing);
    if (marker.beam) this.vfx.beams.release(marker.beam);
    if (marker.pillar) this.vfx.beams.release(marker.pillar);
  }

  private releaseShelter(index: number): void {
    const shelter = this.shelters[index]!;
    if (shelter.ground) this.vfx.ground.release(shelter.ground);
    this.shelters.splice(index, 1);
  }

  private releaseShelters(scopeId: string | undefined): void {
    for (let i = this.shelters.length - 1; i >= 0; i--) if (scopeId === undefined || this.shelters[i]!.scopeId === scopeId) this.releaseShelter(i);
  }
}
