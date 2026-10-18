import * as THREE from 'three';
import type { AudioListener } from 'three';
import type { ActorSnapshot, CombatSnapshot, GameSettings, WorldClockSnapshot } from '../game/contracts.js';
import { StoryAudio, type AudioListenerPose, type StoryAudioOptions } from '../audio/StoryAudio.js';
import type { CueCancellationReason, StoryCue } from './story-cues.js';
import { StoryEffects, type StoryEffectsOptions } from './StoryEffects.js';
import { ActorVfx } from './vfx/ActorVfx.js';
import type { ImpactSink } from './vfx/ElementKits.js';
import { EnemyAttackFx } from './vfx/EnemyAttackFx';

export interface StoryPresentationOptions {
  readonly scene: THREE.Scene;
  readonly resolveSocket?: StoryEffectsOptions['resolveSocket'];
  /** Rendered actor root (skeleton owner) for bone-following effects such as the staff trail. */
  readonly resolveActorRoot?: (actorId: string) => THREE.Object3D | undefined;
  readonly impact?: ImpactSink;
  readonly audioListener?: AudioListener;
  readonly reducedEffects?: boolean;
  readonly capacity?: number;
  readonly onPlayback?: StoryAudioOptions['onPlayback'];
}

/** Combines presentation consumers without granting them simulation or campaign authority. */
export class StoryPresentation {
  readonly effects: StoryEffects;
  readonly actors: ActorVfx;
  readonly audio: StoryAudio;
  readonly enemies: EnemyAttackFx;
  private pending: StoryCue[] = [];
  private spare: StoryCue[] = [];
  private readonly resolveSocket?: StoryPresentationOptions['resolveSocket'];
  private readonly audioAnchor = new THREE.Vector3();
  private disposed = false;

  constructor(options: StoryPresentationOptions) {
    this.resolveSocket = options.resolveSocket;
    this.effects = new StoryEffects({ scene: options.scene, resolveSocket: options.resolveSocket, resolveActorRoot: options.resolveActorRoot, reducedEffects: options.reducedEffects, capacity: options.capacity, impact: options.impact });
    this.actors = new ActorVfx(this.effects.vfx, options.resolveSocket, options.resolveActorRoot, actorId => this.effects.isCharging(actorId), options.impact);
    this.audio = new StoryAudio({ listener: options.audioListener, onPlayback: options.onPlayback });
    this.enemies = new EnemyAttackFx(this.effects.vfx, options.resolveSocket, options.resolveActorRoot);
  }

  /** Call from a real pointer or keyboard activation; gamepad polling alone may not unlock WebAudio. */
  async unlockAudio(): Promise<boolean> { return this.audio.unlock(); }

  consumeTick(cues: readonly StoryCue[]): { effects: number; sounds: number } {
    if (this.disposed) return { effects: 0, sounds: 0 };
    let effects = 0;
    let sounds = 0;
    for (const cue of cues) {
      const accepted = this.consume(cue);
      if (accepted & 1) effects++;
      if (accepted & 2) sounds++;
    }
    return { effects, sounds };
  }
  /** Fixed steps enqueue immutable facts. Bone-dependent consumers run only after renderer.sync has posed the final snapshot. */
  queueTick(cues: readonly StoryCue[]): void {
    if (!this.disposed) for (const cue of cues) this.pending.push(cue);
  }

  presentFrame(snapshot: CombatSnapshot, alpha: number, listenerPose?: AudioListenerPose): void {
    if (this.disposed) return;
    if (listenerPose) this.audio.setListenerPose(listenerPose);
    const queued = this.pending;
    this.pending = this.spare; this.spare = queued;
    try { for (const cue of queued) this.consume(cue); } finally { queued.length = 0; }
    // Cue births retain their original tick, but current-pose emitters must not inherit an earlier queued cue's birth clock.
    this.effects.vfx.time = snapshot.worldClock.worldTick / 60;
    this.actors.setHero(snapshot.player.heroId);
    this.updateActors(snapshot.actors);
    this.effects.warden.updateCombat(snapshot, alpha);
    this.enemies.update(snapshot.actors, snapshot.worldClock.worldTick);
    // Last: age cue resources and upload every emitter written on this frame, including actor/weapon effects.
    this.effects.update(snapshot.worldClock, listenerPose?.position);
  }

  private consume(cue: StoryCue): number {
    if (cue.kind === 'cancel') {
      if (!cue.cancellationReason) throw new Error('Cancellation cues require an authoritative reason.');
      if (cue.scopeId) this.cancelScope(cue.scopeId, cue.cancellationReason);
      else this.cancelAll(cue.cancellationReason);
      return 0;
    }
    const accepted = this.effects.emit(cue);
    if (accepted) this.enemies.consume(cue);
    let position = cue.kind === 'anticipation' || cue.kind === 'commit' ? cue.from ?? cue.position : cue.position ?? cue.from;
    if (!position && cue.actorId) position = this.resolveSocket?.(cue.actorId, 'root')?.getWorldPosition(this.audioAnchor);
    return (accepted ? 1 : 0) | (this.audio.play(cue, position) ? 2 : 0);
  }

  /** Pass the authoritative scaled world clock; never derive VFX time from renderer delta. */
  update(worldClock: WorldClockSnapshot, listenerPose?: AudioListenerPose): void {
    if (this.disposed) return;
    this.effects.update(worldClock, listenerPose?.position);
    if (listenerPose) this.audio.setListenerPose(listenerPose);
  }

  /** Snapshot-driven actor effects (staff trail, slam, tether, dive/landing dust, monster auras). */
  updateActors(actors: readonly ActorSnapshot[]): void {
    if (this.disposed) return;
    let player: ActorSnapshot | undefined;
    for (const actor of actors) if (actor.id === 'aren' || (!player && actor.allegiance === 'player')) player = actor;
    this.effects.setFocus(player?.position);
    this.actors.update(actors);
    this.effects.reactions.update(actors);
    this.effects.companions.update(actors);
    this.audio.consumeActors(actors);
  }

  /**
   * Snapshot-driven Warden Arsenal pass: blade trail and weapon-edge glow, rune sigils, projectiles (interpolated by `alpha`
   * between sim ticks), Judgement marks, Thunder Cleave, electric arcs, the cleansed finish and ambient motes. Call every
   * rendered frame after `update` and `updateActors`; hit-stop needs no special handling because everything ages on the
   * (frozen) world clock.
   */
  updateCombat(snapshot: CombatSnapshot, alpha: number): void {
    if (this.disposed) return;
    this.actors.setHero(snapshot.player?.heroId ?? 'aren');
    this.effects.warden.updateCombat(snapshot, alpha);
  }

  setImpactSink(impact: ImpactSink | undefined): void { this.effects.setImpactSink(impact); this.actors.setImpactSink(impact); }

  setSettings(settings: GameSettings): void {
    this.effects.setReducedEffects(settings.reducedMotion);
    this.effects.setTelegraphIntensity(settings.telegraphIntensity);
    this.audio.setSettings(settings);
  }

  setStoryState(state: { corruption: number; restoration: number; bond: number; dominion: number }): void { this.audio.setStoryState(state); }
  startBiomeAmbience(regionId: string): boolean { return this.audio.startBiomeAmbience(regionId); }

  cancelScope(scopeId: string, reason: CueCancellationReason): void {
    let kept = 0;
    for (const cue of this.pending) if (cue.scopeId !== scopeId) this.pending[kept++] = cue;
    this.pending.length = kept;
    this.enemies.cancelScope(scopeId);
    this.effects.cancelScope(scopeId, reason);
    this.audio.cancelScope(scopeId, reason);
  }

  cancelAll(reason: CueCancellationReason): void {
    this.pending.length = 0;
    this.enemies.clear();
    this.effects.cancelAll(reason);
    this.actors.clear();
    this.audio.cancelAll(reason);
  }

  onDeath(): void { this.cancelAll('death'); }
  onInterrupt(scopeId: string): void { this.cancelScope(scopeId, 'interrupt'); }
  onRegionUnload(): void { this.cancelAll('unload'); }
  onCinematicSkip(scopeId?: string): void { if (scopeId) this.cancelScope(scopeId, 'skip'); else this.cancelAll('skip'); }
  onCampaignLoad(): void { this.cancelAll('load'); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending.length = this.spare.length = 0;
    this.enemies.dispose();
    this.actors.dispose();
    this.effects.dispose();
    this.audio.dispose();
  }

  get activeEffectCount(): number { return this.effects.activeCount; }
}
