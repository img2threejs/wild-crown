import assert from 'node:assert/strict';
import test from 'node:test';
import type { AudioListener } from 'three';
import { StoryPresentation } from '../../src/effects/StoryPresentation.js';
import * as THREE from 'three';
import { startDangerScenario } from './danger-scenario.js';

// Scheduler-only instrument. This does not measure browser output or audible quality.
class Parameter {
  value = 0;
  setValueAtTime(value: number): void { this.value = value; }
  setTargetAtTime(value: number): void { this.value = value; }
  linearRampToValueAtTime(): void {}
  exponentialRampToValueAtTime(): void {}
}
class Node {
  gain = new Parameter(); frequency = new Parameter(); positionX = new Parameter(); positionY = new Parameter(); positionZ = new Parameter();
  type = ''; onended?: () => void; stopped = false; disconnected = false;
  connect(node: Node): Node { return node; }
  disconnect(): void { this.disconnected = true; }
  start(): void {}
  stop(): void { this.stopped = true; }
  getFloatTimeDomainData(samples: Float32Array): void { samples.fill(0); }
}
class Context {
  state = 'suspended'; currentTime = 1; destination = new Node(); oscillators: Node[] = []; closed = false;
  createGain(): Node { return new Node(); }
  createAnalyser(): Node { return new Node(); }
  createPanner(): Node { return new Node(); }
  createOscillator(): Node { const node = new Node(); this.oscillators.push(node); return node; }
  async resume(): Promise<void> { this.state = 'running'; }
  async close(): Promise<void> { this.closed = true; this.state = 'closed'; }
}

test('real-family sound schedules are distinct, phase-sensitive, one-shot and scoped without closing the borrowed context', async () => {
  const previous = globalThis.AudioContext;
  globalThis.AudioContext = Context as unknown as typeof AudioContext;
  const context = new Context();
  const presentation = new StoryPresentation({ scene: new THREE.Scene(), audioListener: { context } as unknown as AudioListener });
  try {
    const signatures = new Set<string>();
    for (let index = 0; index < 5; index++) {
      const { anticipation } = startDangerScenario(index);
      if (index === 0) {
        assert.equal(presentation.audio.play(anticipation), false, 'no playback before user-gesture unlock');
        assert.ok(await presentation.unlockAudio());
      }
      const start = context.oscillators.length;
      assert.equal(presentation.audio.play(anticipation), true);
      const voices = context.oscillators.slice(start);
      const signature = voices.map(node => [node.type, node.frequency.value]);
      signatures.add(JSON.stringify(signature));
      for (let tick = 0; tick < 4; tick++) {
        presentation.update({ simulationTick: tick, worldTick: 1, worldTimeSeconds: 1 / 60, timeScale: 0, policy: 'paused' });
        assert.equal(presentation.audio.play(anticipation), false);
      }
      const commit = { ...anticipation, instanceId: anticipation.instanceId + ':commit', kind: 'commit' as const, phase: 'commit' as const };
      assert.ok(presentation.audio.play(commit));
      assert.ok(context.oscillators.slice(start + voices.length).every((node, i) => node.frequency.value < voices[i]!.frequency.value), 'commit shifts the same family motif lower without replaying the windup');
      const commitVoices = context.oscillators.slice(start + voices.length);
      const active = { ...anticipation, instanceId: anticipation.instanceId + ':active', kind: 'active' as const, phase: 'active' as const };
      assert.ok(presentation.audio.play(active));
      assert.ok(context.oscillators.slice(start + voices.length + commitVoices.length).every((node, i) => node.frequency.value < commitVoices[i]!.frequency.value), 'active retains its family motif with a distinct phase pitch even without hit');
      presentation.consumeTick([{ ...anticipation, instanceId: anticipation.instanceId + ':cancel', kind: 'cancel', cancellationReason: 'interrupt' }]);
      assert.ok(context.oscillators.slice(start).every(node => node.stopped && node.disconnected));
      assert.equal(presentation.audio.playbackMetadata.activeVoices, 0);
      await presentation.unlockAudio();
      assert.equal(presentation.audio.play(anticipation), false, 'unlock/menu transitions do not replay a consumed cue');
    }
    assert.equal(signatures.size, 5);
    presentation.dispose();
    assert.equal(context.closed, false);
  } finally {
    presentation.dispose(); globalThis.AudioContext = previous;
  }
});
