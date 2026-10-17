import type { ActorSnapshot, Vec3 } from '../game/contracts.js';
import { isBossActor, vocalFamilyOf } from './CueSoundMap.js';
import type { FootSurface, VocalFamily } from './SampleCatalog.js';

/** What the snapshot pass asks the mixer to do; implemented by StoryAudio and by tests. */
export interface ActorAudioHooks {
  step(surface: FootSurface, position: Vec3, gain: number, rate: number): void;
  death(family: VocalFamily, position: Vec3): void;
  roar(actorId: string, family: VocalFamily, position: Vec3): void;
  stun(actorId: string, active: boolean, position: Vec3): void;
  /** Called once per pass with the combat presence (0..1) and whether a boss is engaged. */
  encounter(presence: number, boss: boolean): void;
  /** A family was seen for the first time: make sure its vocal pack is (being) loaded. */
  family(family: VocalFamily): void;
}

interface Track {
  distance: number;
  seen: number;
  down: boolean;
  roaring: boolean;
  stunned: boolean;
  family: VocalFamily;
  boss: boolean;
}

/** Hostiles within this many metres of the player count as engaged. */
export const ENGAGE_RADIUS = 22;
/** A boss within this many metres keeps the boss cue up even between attacks. */
export const BOSS_RADIUS = 40;
const MIN_STEP_SPEED = 0.6;
const MAX_STEPS_PER_PASS = 3;
const PRUNE_EVERY = 120;

/**
 * Snapshot-driven audio events that have no presentation cue: footsteps by surface, monster death and roar vocals, stun-loop lifetime and
 * the encounter state that drives the combat/boss music. Per-actor state lives in a map filled once per actor; a pass allocates nothing.
 */
export class ActorAudio {
  private readonly tracks = new Map<string, Track>();
  private surface: FootSurface = 'grass';
  private pass = 0;

  constructor(private readonly hooks: ActorAudioHooks) {}

  setSurface(surface: FootSurface): void { this.surface = surface; }

  reset(): void {
    this.tracks.clear();
    this.pass = 0;
  }

  update(actors: readonly ActorSnapshot[], dtSeconds: number): void {
    this.pass++;
    let player: ActorSnapshot | undefined;
    for (const actor of actors) if (actor.allegiance === 'player') { player = actor; break; }
    let engaged = 0;
    let boss = false;
    let steps = 0;
    for (const actor of actors) {
      let track = this.tracks.get(actor.id);
      if (!track) {
        const family = vocalFamilyOf(actor.archetypeId, actor.species);
        track = { distance: 0, seen: this.pass, down: actor.downed, roaring: false, stunned: false, family, boss: isBossActor(actor.archetypeId) || isBossActor(actor.id) };
        this.tracks.set(actor.id, track);
        if (actor.allegiance === 'hostile' || actor.allegiance === 'wild') this.hooks.family(track.boss ? 'giant' : family);
      }
      track.seen = this.pass;
      const hostile = actor.allegiance === 'hostile' || actor.allegiance === 'wild';
      const alive = !actor.downed && (actor.vitality === undefined || actor.vitality > 0);
      if (hostile) {
        if (alive && !track.down) {
          if (player) {
            const dx = actor.position.x - player.position.x, dz = actor.position.z - player.position.z;
            const distance2 = dx * dx + dz * dz;
            if (distance2 <= ENGAGE_RADIUS * ENGAGE_RADIUS && (actor.targetId === player.id || actor.attackPhase !== undefined || actor.reaction !== undefined)) engaged++;
            if (track.boss && distance2 <= BOSS_RADIUS * BOSS_RADIUS) boss = true;
          }
        }
        const nowDown = !alive;
        if (nowDown && !track.down) this.hooks.death(track.boss ? 'giant' : track.family, actor.position);
        track.down = nowDown;
        const roaring = actor.roarProgress !== undefined;
        if (roaring && !track.roaring) this.hooks.roar(actor.id, track.boss ? 'giant' : track.family, actor.position);
        track.roaring = roaring;
        const stunned = alive && actor.reaction?.kind === 'stun';
        if (stunned !== track.stunned) { track.stunned = stunned; this.hooks.stun(actor.id, stunned, actor.position); }
      } else track.down = actor.downed;
      if (steps < MAX_STEPS_PER_PASS && actor.visible && !actor.downed && alive && actor.jumpPhase !== 'rising' && actor.jumpPhase !== 'falling' && actor.jumpPhase !== 'takeoff') {
        const speed = Math.hypot(actor.velocity.x, actor.velocity.z);
        if (speed > MIN_STEP_SPEED && actor.reaction === undefined) {
          track.distance += speed * dtSeconds;
          const stride = 1.1 + speed * 0.18 + (track.boss ? 1 : 0);
          if (track.distance >= stride) {
            track.distance = Math.min(track.distance - stride, stride);
            steps++;
            this.hooks.step(this.surface, actor.position, actor.allegiance === 'player' ? 0.75 : track.boss ? 1.1 : 0.6, track.boss ? 0.8 : 1);
          }
        } else track.distance = 0;
      }
    }
    this.hooks.encounter(engaged === 0 ? 0 : Math.min(1, 0.55 + 0.2 * (engaged - 1)), boss);
    if (this.pass % PRUNE_EVERY === 0) {
      for (const [id, track] of this.tracks) {
        if (track.seen === this.pass) continue;
        if (track.stunned) this.hooks.stun(id, false, ORIGIN);
        this.tracks.delete(id);
      }
    }
  }
}
const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };
