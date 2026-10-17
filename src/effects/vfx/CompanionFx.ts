import { Vector3, type Object3D } from 'three';
import type { ActorSnapshot, CompanionElement } from '../../game/contracts.js';
import type { StoryCue } from '../story-cues.js';
import { ActorBodies } from './ActorBounds.js';
import type { ImpactSink } from './ElementKits.js';
import { Footprint } from './footprint.js';
import type { GroundSlot } from './GroundFx.js';
import type { VfxElement } from './palette.js';
import type { BeamSlot } from './RibbonFx.js';
import type { VfxSystem } from './VfxSystem.js';
import { companionSkillByAction, type CompanionSkill } from '../../game/companions/CompanionSkills.js';
import { PALETTE, UMBRAL_SMOKE } from './palette.js';
import { VFX_FRAME } from './VfxAtlas.js';

/** Owner id of the persistent companion markers (snapshot-driven); cue-driven bursts carry their cue's scope owner. */
export const COMPANION_VFX_OWNER = 0x7fff0200;
/** Hard caps: marks (Vara marks one hostile at a time, two with a stacked effect), guards (Asha) and jobs (Koro, Vara); each takes manual ground slots of the shared pool. */
export const MAX_MARKS = 2, MAX_GUARDS = 1, MAX_JOBS = 2, MAX_SHELTERS = 1;
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
  private readonly sockets = new WeakMap<Object3D, Object3D | null>();
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
        return true;
      }
      case 'guard': {
        const at = cue.position ?? cue.to;
        if (!at) return false;
        if (cue.phase === 'anticipation') this.guardArch(at.x, at.y, at.z, owner);
        if (cue.phase === 'hit') {
          // The block lands: an amber ring, a flash and sparks at the contact point, and a short shake for the player.
          this.fp.set('disk', at.x, at.y, at.z, 0, 1.4, 1.4);
          vfx.ground.spawn('shock', this.fp, GUARD_ELEMENT, owner, time, 0.4);
          vfx.flash(at.x, at.y + 0.9, at.z, 1.6, GUARD_ELEMENT, owner, 0.22);
          vfx.sparks(at.x, at.y + 0.9, at.z, 18, 4, GUARD_ELEMENT, owner, 0.5);
          this.impact?.shake(0.12, 0.2, 24);
        } else if (cue.phase === 'anticipation') {
          this.fp.set('disk', at.x, at.y, at.z, 0, 1.1, 1.1);
          vfx.ground.spawn('shock', this.fp, GUARD_ELEMENT, owner, time, 0.35);
        } else vfx.glow(at.x, at.y + 0.8, at.z, 1, 0.4, GUARD_ELEMENT, 0.4, owner, 0.3);
        return true;
      }
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
      case 'storm-talon': {
        // Native raptor phases: lift feathers, a swept wind lane, three talon cuts, and the real contact burst.
        const at = cue.position ?? cue.to;
        if (!at) return false;
        if (cue.phase === 'anticipation' || cue.phase === 'commit') {
          // Takeoff / windup: dust-and-feather ring at the dive start point + a rising glow.
          this.fp.set('disk', at.x, at.y, at.z, 0, 1.4, 1.4);
          vfx.ground.spawn('shock', this.fp, 'wind', owner, time, 0.5);
          vfx.flash(at.x, at.y + 1, at.z, 1.4, 'wind', owner, 0.25);
          vfx.sparks(at.x, at.y + 1, at.z, 12, 2.6, 'wind', owner, 0.5);
        } else if (cue.phase === 'active') {
          const from = cue.from ?? at, to = cue.to ?? at;
          this.beam(from.x, from.y + .2, from.z, to.x, to.y, to.z, 'wind', owner, (cue.durationTicks ?? 21) / 60, .065);
          this.at.set(from.x, from.y, from.z); this.to.set(to.x, to.y, to.z);
          vfx.blades.spawn(this.at, this.to, .7, Math.atan2(to.x - from.x, to.z - from.z), time, (cue.durationTicks ?? 21) / 60, owner, 'wind');
        } else if (cue.phase === 'hit') {
          // Strike: feather burst, wind shock ring, small sky-lightning crackle, bounded camera shake.
          this.fp.set('disk', at.x, at.y, at.z, 0, 1.6, 1.6);
          vfx.ground.spawn('shock', this.fp, 'wind', owner, time, 0.45);
          vfx.flash(at.x, at.y + 1.0, at.z, 1.6, 'wind', owner, 0.3);
          vfx.sparks(at.x, at.y + 1.0, at.z, 18, 4, 'wind', owner, 0.6);
          this.elementMotion(at.x, at.y + .4, at.z, 'wind', owner);
          this.ownerFlourish(cue, 'wind', owner);
          for (let i = -1; i <= 1; i++) this.beam(at.x - .4 + i * .18, at.y + 1.2, at.z, at.x + .35 + i * .18, at.y + .45, at.z + .2, 'wind', owner, .22, .045);
          this.impact?.shake(0.06, 0.14, 20);
        } else if (cue.phase === 'sustain') {
          // Mark screech: expanding wind-ring at the mark landing point.
          this.fp.set('disk', at.x, at.y, at.z, 0, 1.2, 1.2);
          vfx.ground.spawn('shock', this.fp, 'wind', owner, time, 0.5);
        } else if (cue.phase === 'landing') {
          // Landing: dust-and-feather ring at the perch + settling glow.
          this.fp.set('disk', at.x, at.y, at.z, 0, 1.0, 1.0);
          vfx.ground.spawn('shock', this.fp, 'wind', owner, time, 0.4);
          vfx.flash(at.x, at.y + 0.6, at.z, 1.0, 'wind', owner, 0.18);
        }
        return true;
      }
      default:
        return false;
    }
  }

  /** Authoritative world tick (ages shelters); called from StoryEffects.update. */
  tick(worldTick: number): void {
    for (let i = this.shelters.length - 1; i >= 0; i--) if (worldTick >= this.shelters[i]!.endTick) this.releaseShelter(i);
    for (const shelter of this.shelters) if (shelter.ground) this.vfx.ground.drive(shelter.ground, 1, 0.9, this.vfx.reducedEffects ? 0.7 : 0.6 + 0.15 * Math.sin(worldTick / 60 * 4), 0.4);
  }

  /** Snapshot pass: creates, moves and drives the persistent markers of the actors that carry a mark, guard or job; releases every marker whose field is gone. */
  update(actors: readonly ActorSnapshot[]): void {
    if (this.destroyed) return;
    this.actors = actors;
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
  }

  /** Releases the shelter of a cancelled cue scope. */
  cancelScope(scopeId: string): void { this.releaseShelters(scopeId); }

  dispose(): void {
    if (this.destroyed) return;
    this.clear();
    this.destroyed = true;
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
      const beam = vfx.beams.acquire(COMPANION_VFX_OWNER, vfx.time, 0, 0.08, 0.02, element);
      marker = { kind: 'job', ring, landing: undefined, beam, pillar: undefined, seen: true, state: job.command };
      this.markers.set(key, marker);
    }
    marker.seen = true;
    const alpha = this.vfx.reducedEffects ? 0.6 : 0.45 + 0.15 * Math.sin(this.vfx.time * 5), fade = clamp01(job.remainingTicks / MARK_FADE_TICKS);
    if (marker.ring) { this.place(marker.ring, target.position.x, target.position.y, target.position.z); this.vfx.ground.drive(marker.ring, 1, 0.9, alpha * fade, 0.4); }
    if (marker.beam) {
      const from = this.positionOf(actor, this.at), to = this.positionOf(target, this.to);
      marker.beam.a.set(from.x, from.y + 0.7, from.z); marker.beam.b.set(to.x, to.y + 0.7, to.z);
      marker.beam.alpha = alpha * fade;
    }
    return true;
  }

  private playSkill(cue: StoryCue, owner: number, skill: CompanionSkill): boolean {
    const at = cue.position ?? cue.to, from = cue.from ?? at;
    if (!at || !from) return false;
    const root = cue.actorId ? this.resolveRoot?.(cue.actorId) : undefined;
    if (root) {
      let socket = this.sockets.get(root);
      if (socket === undefined) {
        socket = null;
        root.traverse(node => { if (!socket && (skill.companionId === 'koro' ? /(?:R_Hand|RightHand)$/.test(node.name) : /(?:Head_2|Head)$/.test(node.name))) socket = node; });
        this.sockets.set(root, socket);
      }
      if (socket) socket.getWorldPosition(this.at);
      else { root.getWorldPosition(this.at); this.at.y += this.bodies.get(root).height * .65; }
    } else this.at.set(from.x, from.y + .8, from.z);
    const sx = this.at.x, sy = this.at.y, sz = this.at.z;
    const tx = at.x, ty = at.y + (cue.targetId ? .7 : .12), tz = at.z;
    const vfx = this.vfx, hit = cue.phase === 'hit', commit = cue.phase === 'commit', anticipation = cue.phase === 'anticipation';
    if (cue.phase === 'resolve') return true;
    const element = SKILL_ELEMENT[skill.element];
    if (hit) this.elementMotion(tx, at.y + .12, tz, element, owner);
    const dx = tx - sx, dz = tz - sz, length = Math.hypot(dx, dz) || 1;
    const fx = dx / length, fz = dz / length, rx = fz, rz = -fx;
    if (skill.command === 'search') {
      // Geometry identifies the species; the skill's single element owns its palette.
      if (anticipation) vfx.gather(sx, sy, sz, 7, .5, element, owner);
      if (hit) {
        switch (skill.companionId) {
          case 'vara':
            // An aerial survey opens downwards onto four widely separated ground traces.
            for (let i = 0; i < 4; i++) {
              const angle = Math.atan2(fx, fz) + (i - 1.5) * .6;
              this.beam(sx, sy, sz, from.x + Math.sin(angle) * 3.4, from.y + .08, from.z + Math.cos(angle) * 3.4, element, owner, .65, .025);
            }
            vfx.sparks(sx, sy, sz, 6, 1.3, element, owner);
            break;
          case 'koro':
            for (let i = -1; i <= 1; i++) {
              const angle = Math.atan2(fx, fz) + i * .48;
              this.beam(from.x, from.y + .12, from.z, from.x + Math.sin(angle) * 2.7, from.y + .12, from.z + Math.cos(angle) * 2.7, element, owner, .65, .035);
            }
            vfx.leaves(sx, from.y, sz, 8, .6, 0, 0, owner);
            break;
          case 'asha':
            // Parallel claw tracks, rather than the other species' search fans.
            for (let i = -1; i <= 1; i++) this.beam(from.x + rx * i * .22, from.y + .07, from.z + rz * i * .22, from.x + fx * 2.5 + rx * i * .22, from.y + .07, from.z + fz * 2.5 + rz * i * .22, element, owner, .65, .045);
            vfx.dustRing(from.x + fx, from.y, from.z + fz, .45, 5, owner);
            break;
          case 'sable':
            this.beam(from.x, from.y + .08, from.z, from.x + fx * 2.6, from.y + .08, from.z + fz * 2.6, element, owner, .65, .02);
            for (let i = 1; i <= 3; i++) vfx.glow(from.x + fx * i * .7 + rx * (i % 2 ? .13 : -.13), from.y + .06, from.z + fz * i * .7 + rz * (i % 2 ? .13 : -.13), .16, .7, element, .5, owner);
            break;
          case 'nyra':
            for (let sign = -1; sign <= 1; sign += 2) this.beam(from.x + rx * sign * .4, from.y + .1, from.z + rz * sign * .4, from.x + fx * 2.2 + rx * sign * .85, from.y + .1, from.z + fz * 2.2 + rz * sign * .85, element, owner, .7, .06);
            vfx.smoke(from.x + fx, from.y + .1, from.z + fz, 5, .5, .15, .3, .7, UMBRAL_SMOKE, .35, owner);
            break;
          case 'solkar':
            this.fp.set('disk', from.x, from.y, from.z, 0, 2.7, 2.7);
            vfx.ground.spawn('shock', this.fp, element, owner, vfx.time, .8);
            for (let i = 0; i < 4; i++) {
              const angle = i * Math.PI / 2;
              this.beam(from.x, from.y + .08, from.z, from.x + Math.sin(angle) * 2.5, from.y + .08, from.z + Math.cos(angle) * 2.5, element, owner, .65, .025);
            }
            break;
        }
      }
      return true;
    }
    if (skill.command === 'distract') {
      // Distraction shares no combat benefit; each gesture still carries its authored element.
      if (anticipation) {
        if (skill.companionId === 'koro') vfx.leaves(sx, sy, sz, 6, .2, rx, rz, owner);
        else if (skill.companionId === 'nyra') vfx.smoke(sx, from.y + .12, sz, 4, .3, .2, .3, .55, UMBRAL_SMOKE, .4, owner);
        else if (skill.companionId === 'sable') vfx.shards(sx, sy, sz, 4, 1.2, owner);
        else if (skill.companionId === 'asha') vfx.dustRing(from.x, from.y, from.z, .45, 4, owner);
        else vfx.gather(sx, sy, sz, 7, .45, element, owner);
      }
      if (commit) {
        switch (skill.companionId) {
          case 'koro':
            this.beam(sx - .3, sy, sz, sx - .45, sy + .65, sz, element, owner, .35);
            this.beam(sx + .3, sy, sz, sx + .45, sy + .65, sz, element, owner, .35);
            break;
          case 'asha':
            for (let i = -1; i <= 1; i++) this.beam(sx - rx * .4, sy + i * .13, sz - rz * .4, sx + rx * .4 + fx * .3, sy + i * .13 + .15, sz + rz * .4 + fz * .3, element, owner, .35, .04);
            break;
          case 'sable':
            for (let sign = -1; sign <= 1; sign += 2) this.beam(sx + rx * sign * .15, sy + .12, sz + rz * sign * .15, sx + rx * sign * .65, sy + .4, sz + rz * sign * .65, element, owner, .4, .035);
            break;
          case 'nyra':
            for (let sign = -1; sign <= 1; sign += 2) this.beam(sx - fx * .4 + rx * sign * .3, from.y + .1, sz - fz * .4 + rz * sign * .3, sx + fx * .5 + rx * sign * .55, from.y + .25, sz + fz * .5 + rz * sign * .55, element, owner, .5, .07);
            break;
          case 'solkar':
            for (let i = -1; i <= 1; i++) this.beam(sx + rx * i * .12, sy + .1, sz + rz * i * .12, sx + rx * i * .4, sy + (i === 0 ? .85 : .6), sz + rz * i * .4, element, owner, .45, .045);
            break;
        }
      }
      if (hit) {
        // Shared attention punctuation stays legible; the casting gesture above identifies its owner.
        this.beam(tx, ty + .65, tz, tx, ty + 1.25, tz, element, owner, .6, .08);
        vfx.glow(tx, ty + .4, tz, .16, .6, element, .5, owner);
      }
      return true;
    }
    switch (skill.id) {
      case 'sky-mark':
        if (anticipation) vfx.gather(sx, sy, sz, 8, .65, element, owner);
        if (commit) this.beam(sx, sy, sz, tx, ty + .45, tz, element, owner, .3, .035);
        return true; // Contact marker and sky flash are owned by the actual mark cue.
      case 'canopy-route':
        if (anticipation) vfx.leaves(sx, sy, sz, 4, .12, 0, 0, owner);
        if (commit) {
          const flight = Math.max(.08, (cue.durationTicks ?? 16) / 60), p = vfx.spec(), color = PALETTE[element].b;
          p.x = sx; p.y = sy; p.z = sz; p.vx = dx / flight; p.vz = dz / flight; p.vy = (ty - sy) / flight + 4.9 * flight;
          p.gravity = 9.8; p.drag = 0; p.life = flight; p.size0 = .22; p.size1 = .18; p.frame = VFX_FRAME.drop;
          p.r0 = p.r1 = color.r; p.g0 = p.g1 = color.g; p.b0 = p.b1 = color.b; p.a0 = .95; p.fadeIn = .01; p.fadeOut = .08;
          vfx.emit(vfx.particles.alpha, owner);
        }
        if (hit) { vfx.leaves(tx, ty, tz, 14, .2, fx, fz, owner); this.ownerFlourish(cue, element, owner); }
        return true;
      case 'canopy-move':
        if (anticipation) vfx.dustRing(from.x, from.y, from.z, .45, 5, owner);
        if (commit) for (const sign of [-1, 1]) this.beam(sx + rx * sign * .16, sy, sz + rz * sign * .16, tx + rx * sign * .25, ty + .2, tz + rz * sign * .25, element, owner, .5, .06);
        if (hit) vfx.dustRing(tx, at.y, tz, .9, 10, owner);
        return true;
      case 'fang-guard':
        if (anticipation || commit) this.guardArch(tx, at.y, tz, owner);
        if (hit) vfx.sparks(tx, ty, tz, 14, 3, element, owner);
        return true;
      case 'fang-pin':
        if (anticipation) vfx.dustRing(from.x, from.y, from.z, .5, 5, owner);
        if (commit) {
          this.at.set(sx, sy - .3, sz); this.to.set(tx, ty, tz);
          vfx.blades.spawn(this.at, this.to, .9, Math.atan2(fx, fz), vfx.time, .23, owner, element);
        }
        if (hit) {
          for (let i = -1; i <= 1; i++) this.beam(tx - rx * .3 + fx * i * .16, ty + .45, tz - rz * .3 + fz * i * .16, tx + rx * .35 + fx * i * .16, ty - .3, tz + rz * .35 + fz * i * .16, element, owner, .2, .045);
          vfx.sparks(tx, ty, tz, 10, 1.8, element, owner);
          this.impact?.shake(.07, .14, 20);
        }
        return true;
      case 'pack-flank':
        if (anticipation) vfx.gather(sx, from.y + .15, sz, 6, .5, element, owner);
        if (commit) {
          this.at.set(sx - rx * .45, from.y + .12, sz - rz * .45); this.to.set(tx + rx * .75, at.y + .12, tz + rz * .75);
          vfx.blades.spawn(this.at, this.to, 1.1, Math.atan2(fx, fz) + .7, vfx.time, .35, owner, element);
        }
        if (hit) {
          this.fp.set('disk', tx, at.y, tz, 0, 1.7, 1.7);
          vfx.ground.spawn('shock', this.fp, element, owner, vfx.time, 1.2);
          vfx.ground.spawn('burn', this.fp, element, owner, vfx.time, 1.6);
        }
        return true;
      case 'shadow-ambush':
        if (anticipation) vfx.gather(sx, sy, sz, 8, .45, element, owner);
        if (commit) {
          for (let i = 0; i < 5; i++) {
            const u = i / 5, next = (i + 1) / 5, zig = i % 2 ? .22 : -.22;
            this.beam(sx + dx * u + rx * zig, sy + (ty - sy) * u, sz + dz * u + rz * zig, sx + dx * next - rx * zig, sy + (ty - sy) * next, sz + dz * next - rz * zig, element, owner, .18, .035);
          }
        }
        if (hit) {
          this.ownerFlourish(cue, element, owner);
          vfx.sparks(tx, ty, tz, 8, 2.5, element, owner);
        }
        return true;
      case 'crown-rally':
        if (anticipation) vfx.gather(sx, sy, sz, 9, .75, element, owner);
        if (commit) {
          const color = PALETTE[element].b;
          for (let i = 0; i < (vfx.reducedEffects ? 1 : 3); i++) {
            const p = vfx.spec(); p.x = sx + fx * i * .2; p.y = sy; p.z = sz + fz * i * .2;
            p.vx = fx * 1.5; p.vz = fz * 1.5; p.life = .45 + i * .08; p.size0 = .3 + i * .15; p.size1 = 1.4 + i * .5; p.frame = VFX_FRAME.ring; p.a0 = .42; p.fadeIn = .05; p.fadeOut = .7;
            p.r0 = p.r1 = color.r; p.g0 = p.g1 = color.g; p.b0 = p.b1 = color.b;
            vfx.emit(vfx.particles.additive, owner);
          }
        }
        if (hit) this.ownerFlourish(cue, element, owner);
        return true;
      default: return true;
    }
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

  /** Owner-only benefit feedback; never implies that every nearby NPC gained a buff. */
  private ownerFlourish(cue: StoryCue, element: VfxElement, owner: number): void {
    const source = cue.from ?? cue.position;
    if (!source) return;
    const player = this.actors.find(actor => actor.allegiance === 'player' && actor.visible && !actor.downed);
    if (!player || Math.hypot(player.position.x - source.x, player.position.z - source.z) > 12) return;
    const p = player.position;
    this.beam(source.x, source.y + .7, source.z, p.x, p.y + .75, p.z, element, owner, .5, .035);
    this.elementMotion(p.x, p.y + .1, p.z, element, owner);
    this.fp.set('disk', p.x, p.y, p.z, 0, 1.1, 1.1);
    this.vfx.ground.spawn('shock', this.fp, element, owner, this.vfx.time, .9);
  }

  private beam(ax: number, ay: number, az: number, bx: number, by: number, bz: number, element: VfxElement, owner: number, life = .25, width = .055): void {
    const beam = this.vfx.beams.acquire(owner, this.vfx.time, life, width, .015, element);
    if (beam) { beam.a.set(ax, ay, az); beam.b.set(bx, by, bz); beam.alpha = this.vfx.reducedEffects ? .55 : .8; }
  }

  private guardArch(x: number, y: number, z: number, owner: number): void {
    this.beam(x - .7, y + .25, z, x - .48, y + 1.25, z, GUARD_ELEMENT, owner, .6, .065);
    this.beam(x - .48, y + 1.25, z, x + .48, y + 1.25, z, GUARD_ELEMENT, owner, .6, .065);
    this.beam(x + .48, y + 1.25, z, x + .7, y + .25, z, GUARD_ELEMENT, owner, .6, .065);
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
