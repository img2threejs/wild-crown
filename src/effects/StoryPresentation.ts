import * as THREE from 'three';
import type { AudioListener } from 'three';
import type { GameSettings, WorldClockSnapshot } from '../game/contracts.js';
import { StoryAudio, type AudioListenerPose, type StoryAudioOptions } from '../audio/StoryAudio.js';
import type { CueCancellationReason, StoryCue } from './story-cues.js';
import { StoryEffects, type StoryEffectsOptions } from './StoryEffects.js';

export interface StoryPresentationOptions {
  readonly scene: THREE.Scene;
  readonly resolveSocket?: StoryEffectsOptions['resolveSocket'];
  readonly audioListener?: AudioListener;
  readonly reducedEffects?: boolean;
  readonly capacity?: number;
  readonly onPlayback?: StoryAudioOptions['onPlayback'];
}

/** Combines presentation consumers without granting them simulation or campaign authority. */
export class StoryPresentation {
  readonly effects: StoryEffects;
  readonly audio: StoryAudio;
  private readonly resolveSocket?: StoryPresentationOptions['resolveSocket'];
  private readonly audioAnchor = new THREE.Vector3();
  private disposed = false;

  constructor(options: StoryPresentationOptions) {
    this.resolveSocket = options.resolveSocket;
    this.effects = new StoryEffects({ scene: options.scene, resolveSocket: options.resolveSocket, reducedEffects: options.reducedEffects, capacity: options.capacity });
    this.audio = new StoryAudio({ listener: options.audioListener, onPlayback: options.onPlayback });
  }

  /** Call from a real pointer or keyboard activation; gamepad polling alone may not unlock WebAudio. */
  async unlockAudio(): Promise<boolean> { return this.audio.unlock(); }

  consumeTick(cues: readonly StoryCue[]): { effects: number; sounds: number } {
    if (this.disposed) return { effects: 0, sounds: 0 };
    let effects = 0;
    let sounds = 0;
    for (const cue of cues) {
      if (cue.kind === 'cancel') {
        if (!cue.cancellationReason) throw new Error('Cancellation cues require an authoritative reason.');
        if (cue.scopeId) this.cancelScope(cue.scopeId, cue.cancellationReason);
        else this.cancelAll(cue.cancellationReason);
        continue;
      }
      if (this.effects.emit(cue)) effects++;
      let position = cue.kind === 'anticipation' || cue.kind === 'commit' ? cue.from ?? cue.position : cue.position ?? cue.from;
      if (!position && cue.actorId) position = this.resolveSocket?.(cue.actorId, 'root')?.getWorldPosition(this.audioAnchor);
      if (this.audio.play(cue, position)) sounds++;
    }
    return { effects, sounds };
  }

  /** Pass the authoritative scaled world clock; never derive VFX time from renderer delta. */
  update(worldClock: WorldClockSnapshot, listenerPose?: AudioListenerPose): void {
    if (this.disposed) return;
    this.effects.update(worldClock);
    if (listenerPose) this.audio.setListenerPose(listenerPose);
  }

  setSettings(settings: GameSettings): void {
    this.effects.setReducedEffects(settings.reducedMotion);
    this.audio.setSettings(settings);
  }

  setStoryState(state: { corruption: number; restoration: number; bond: number; dominion: number }): void { this.audio.setStoryState(state); }
  startBiomeAmbience(regionId: string): boolean { return this.audio.startBiomeAmbience(regionId); }

  cancelScope(scopeId: string, reason: CueCancellationReason): void {
    this.effects.cancelScope(scopeId, reason);
    this.audio.cancelScope(scopeId, reason);
  }

  cancelAll(reason: CueCancellationReason): void {
    this.effects.cancelAll(reason);
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
    this.effects.dispose();
    this.audio.dispose();
  }

  get activeEffectCount(): number { return this.effects.activeCount; }
}
