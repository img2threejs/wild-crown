import { Vector3, type Scene } from 'three';
import type { ActionId } from '../game/contracts';
import { VESPER } from '../game/combat/VesperSkills';
import { TARGETED_STRIKES } from '../game/combat/PlayerSkills';
import { StoryEffects } from '../effects/StoryEffects';
import type { StoryCue } from '../effects/story-cues';
import type { NativeAssetInstance } from './NativeAssetLoader';
import type { WardenWeapon } from './WardenWeapon';
import { PoseAfterimages } from './PoseAfterimages';

interface Beat { readonly at: number; readonly kind: StoryCue['kind']; readonly phase: StoryCue['phase']; readonly intensity?: number }
const beat = (at: number, kind: Beat['kind'], phase: Beat['phase'], intensity = 1): Beat => ({ at, kind, phase, intensity });
/** The same simulation phase ratios drive the native showcase; no preview damage or second combat engine. */
const BEATS: Readonly<Record<string, readonly Beat[]>> = {
  ...Object.fromEntries(VESPER.iai.steps.map((step, i) => [`vesper-iai-${i + 1}`, [beat((i === 3 ? VESPER.iai.riftDashFrom : step.activeAt) / step.ticks, i === 3 ? 'beam' : 'slash', 'active', 1 + i * 0.15)]])),
  'vesper-shadow-step': [beat(VESPER.shadowStep.blinkAt / VESPER.shadowStep.ticks, 'blink', 'commit'), beat(VESPER.shadowStep.strikeAt / VESPER.shadowStep.ticks, 'slash', 'active', 1.4)],
  'vesper-cuts-charge': [beat(0, 'sigil', 'sustain')],
  'vesper-thousand-cuts': [beat(VESPER.thousandCuts.strikeAt[0]! / VESPER.thousandCuts.ticks, 'slash', 'active', 1.2), ...[...VESPER.thousandCuts.strikeAt, VESPER.thousandCuts.finisherAt].map(at => beat(at / VESPER.thousandCuts.ticks, 'blink', 'commit'))],
  'vesper-kunai-fan': [beat(VESPER.kunaiFan.releaseAt / VESPER.kunaiFan.ticks, 'projectile', 'commit')],
  'vesper-shade-charge': [beat(0, 'sigil', 'sustain')],
  'vesper-shade-swap': [beat(VESPER.shadeSwap.cloneLaunchAt / VESPER.shadeSwap.ticks, 'beam', 'active'), beat(VESPER.shadeSwap.swapAt / VESPER.shadeSwap.ticks, 'blink', 'commit')],
  'vesper-severing-shadow': [beat(VESPER.severingShadow.strikeAt / VESPER.severingShadow.ticks, 'tether', 'commit')],
  'vesper-cleanse': [beat(VESPER.cleanse.activeAt / (VESPER.cleanse.lockTicks + TARGETED_STRIKES.cleanse.recoveryTicks), 'cleanse', 'active')],
  'vesper-mist-blink': [beat(VESPER.mistBlink.hideFrom, 'blink', 'commit')],
  'vesper-requiem': [beat(0, 'judgement', 'anticipation'), beat(VESPER.requiem.markAt / VESPER.requiem.ticks, 'judgement', 'commit'), ...Array.from({ length: VESPER.requiem.slashCount }, (_, i) => beat((VESPER.requiem.slashFrom + i * VESPER.requiem.slashInterval) / VESPER.requiem.ticks, 'blink', 'commit')), beat(VESPER.requiem.detonationAt / VESPER.requiem.ticks, 'judgement', 'resolve', 1.8)],
};

/** Reuses the live umbral cue renderer and the actual fitted blade sockets on the hero-select stage. */
export class VesperShowcaseFx {
  private readonly effects: StoryEffects;
  private readonly afterimages: PoseAfterimages | null;
  private readonly pose = { actionId: 'aren-idle' as ActionId, phase: 'active' as 'active' | 'idle', visible: true, downed: false, velocity: { x: 0, y: 0, z: 0 } };
  private readonly clock = { simulationTick: 0, worldTick: 0, worldTimeSeconds: 0, timeScale: 1, policy: 'normal' as const };
  private readonly base = new Vector3();
  private readonly tip = new Vector3();
  private readonly origin = new Vector3();
  private readonly from = new Vector3();
  private readonly to = new Vector3();
  private readonly facing = new Vector3();
  private action = '';
  private nextBeat = 0;
  private serial = 0;
  private seconds = 0;
  private durationSeconds = 0;

  constructor(scene: Scene, private readonly actor: NativeAssetInstance, private readonly weapon: WardenWeapon | null, private readonly reduced: boolean, motionBlur: boolean) {
    this.effects = new StoryEffects({
      scene, capacity: 16, reducedEffects: reduced,
      resolveActorRoot: id => id === 'aren' ? actor.root : undefined,
      resolveSocket: (id, name) => {
        if (id !== 'aren') return undefined;
        if (name === 'weapon' || name === 'weapon-base' || name === 'weapon-tip' || name === 'weapon-pommel') return weapon?.sockets[name];
        return actor.sockets[name];
      },
    });
    this.afterimages = motionBlur && !reduced ? new PoseAfterimages(scene, actor.root) : null;
    this.afterimages?.setStyle('umbral');
    const player = this.effects.warden.player;
    player.valid = true;
    player.hero = 'vesper';
  }

  reset(): void {
    this.effects.cancelAll('skip');
    this.afterimages?.clear();
    this.action = '';
    this.nextBeat = 0;
  }

  update(actionId: string, progress: number, durationSeconds: number, dt: number, camera: Vector3): void {
    if (actionId !== this.action) {
      this.effects.cancelAll('skip');
      this.afterimages?.clear();
      this.action = actionId;
      this.nextBeat = 0;
    }
    this.durationSeconds = durationSeconds;
    this.seconds += dt;
    const tick = this.seconds * 60;
    this.clock.simulationTick = this.clock.worldTick = tick;
    this.clock.worldTimeSeconds = this.seconds;
    this.actor.root.updateWorldMatrix(true, true);
    this.actor.root.getWorldPosition(this.origin);
    this.facing.set(0, 0, 1).transformDirection(this.actor.root.matrixWorld);
    const player = this.effects.warden.player;
    player.position.copy(this.origin); player.facing.copy(this.facing); player.actionId = actionId; player.phase = progress < 1 ? 'active' : 'idle';
    const beats = BEATS[actionId];
    if (beats) while (this.nextBeat < beats.length && progress >= beats[this.nextBeat]!.at) this.emit(beats[this.nextBeat++]!, tick);
    const w = this.effects.warden;
    if (!this.reduced && this.weapon && tick / 60 >= w.trailFrom && tick / 60 <= w.trailUntil) {
      this.weapon.sockets['weapon-base'].getWorldPosition(this.base);
      this.weapon.sockets['weapon-tip'].getWorldPosition(this.tip);
      w.trail.push(this.base.x, this.base.y, this.base.z, this.tip.x, this.tip.y, this.tip.z, this.seconds, 0.85);
    }
    this.effects.update(this.clock, camera);
    this.pose.actionId = actionId as ActionId;
    this.pose.phase = progress < 1 ? 'active' : 'idle';
    this.afterimages?.update(this.pose, this.clock, this.reduced);
  }

  private emit(event: Beat, tick: number): void {
    // Local stage geometry stays compact; only the presentation is demonstrated, never a fictitious target or damage.
    this.from.copy(this.origin).addScaledVector(this.facing, -0.45);
    this.to.copy(this.origin).addScaledVector(this.facing, event.kind === 'beam' ? 1.5 : 0.75);
    const position = event.kind === 'tether' ? this.to : this.origin;
    const chest = event.kind === 'judgement' && event.phase === 'resolve';
    const lifetime = event.kind === 'sigil' ? this.durationSeconds * 60
      : event.kind === 'cleanse' ? (1 - event.at) * this.durationSeconds * 60
      : event.kind === 'slash' && this.action === 'vesper-thousand-cuts' ? this.durationSeconds * 60 * (1 - event.at)
      : event.kind === 'judgement' && event.phase === 'anticipation' ? this.durationSeconds * 60 * VESPER.requiem.markAt / VESPER.requiem.ticks
      : 9;
    const cue: StoryCue = {
      instanceId: `vesper-showcase:${++this.serial}`, scopeId: 'vesper-showcase', tick, worldTick: tick, worldTimeSeconds: this.seconds,
      actorId: 'aren', actionId: this.action as ActionId, element: 'umbral', priority: 'essential', kind: event.kind, phase: event.phase,
      position: { x: position.x, y: position.y + (chest ? 0.9 : 0), z: position.z },
      from: { x: this.from.x, y: this.from.y, z: this.from.z }, to: { x: this.to.x, y: this.to.y, z: this.to.z },
      footprint: { width: 1.2, length: event.kind === 'slash' ? 1.35 : 1.5, angleRadians: Math.atan2(this.facing.x, this.facing.z), sectorRadians: 2.44 },
      durationTicks: Math.max(1, lifetime),
      intensity: event.intensity,
    };
    this.effects.emit(cue);
  }

  dispose(): void { this.afterimages?.dispose(); this.effects.dispose(); }
}
