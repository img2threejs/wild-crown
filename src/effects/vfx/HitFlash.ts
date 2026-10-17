import { Color, Mesh, type Material, type Object3D, type WebGLProgramParametersWithUniforms } from 'three';

type EmissiveMaterial = Material & { emissive: Color };
function hasEmissive(material: Material): material is EmissiveMaterial {
  return 'emissive' in material && material.emissive instanceof Color;
}

/** Rim emissive ceilings (linear HDR): enough to bloom the silhouette, never to whiten the body. */
const MAX_HIT_RIM = 2;
const MAX_CHARGE_RIM = 1.5;

/** Persistent per-actor state: compiled clone programs keep references to these uniform objects. */
interface FlashState {
  readonly color: { value: Color };
  readonly strength: { value: number };
  readonly base: { value: number };
  readonly clones: Map<Material, Material>;
  readonly cloneSet: Set<Material>;
  /** Mesh → material(s) it wore before the flash clone was assigned. */
  readonly swapped: Map<Mesh, Material | Material[]>;
  peak: number;
  elapsed: number;
  duration: number;
  mode: 'hit' | 'charge';
}

/**
 * Brief emissive rim flash on a damaged actor. Every source material gets one lazily cloned twin
 * per actor with a fresnel emissive term; the twin is worn only while flashing and the original is
 * restored afterwards unless another system replaced the material meanwhile.
 */
export class ActorHitFlash {
  private readonly states = new Map<Object3D, FlashState>();
  private enabled = true;

  setEnabled(enabled: boolean): void { this.enabled = enabled; if (!enabled) this.clear(); }

  /**
   * Tinted fresnel rim. The colour is normalised (only hue is used); the rim peaks at 2.0 HDR for
   * a hit and 1.5 for a charge glow, and only a hit adds a faint (0.08) body term, so albedo stays
   * readable and the body never whitens.
   */
  flash(root: Object3D, color: Color, intensity: number, durationSeconds: number, mode: 'hit' | 'charge'): void {
    if (!this.enabled || !(durationSeconds > 0) || !(intensity > 0)) return;
    const state = this.stateFor(root);
    // A hit overrides a charge glow; a charge never interrupts a fresh hit.
    if (state.swapped.size && state.mode === 'hit' && mode === 'charge') return;
    const dominant = Math.max(color.r, color.g, color.b, 1e-3);
    state.color.value.setRGB(color.r / dominant, color.g / dominant, color.b / dominant);
    state.peak = Math.min(mode === 'hit' ? MAX_HIT_RIM : MAX_CHARGE_RIM, intensity);
    state.elapsed = 0; state.duration = durationSeconds; state.mode = mode;
    state.base.value = mode === 'hit' ? 0.08 : 0;
    if (!state.swapped.size) this.wear(root, state);
    state.strength.value = mode === 'hit' ? state.peak : 0;
  }

  /** Real-time seconds (presentation only). */
  update(dtSeconds: number): void {
    for (const state of this.states.values()) {
      if (!state.swapped.size) continue;
      state.elapsed += dtSeconds;
      const t = state.elapsed / state.duration;
      if (t >= 1) { this.restore(state); continue; }
      state.strength.value = state.mode === 'hit'
        ? state.peak * Math.pow(1 - t, 2)
        : state.peak * Math.min(1, t * 1.4) * (0.8 + 0.2 * Math.sin(state.elapsed * 12));
    }
  }

  /** Compiles flash programs ahead of the first hit by wearing every twin for one compile call. */
  prewarm(roots: readonly Object3D[], compile: () => void): void {
    const worn: FlashState[] = [];
    for (const root of roots) {
      const state = this.stateFor(root);
      if (state.swapped.size) continue;
      this.wear(root, state);
      worn.push(state);
    }
    try { compile(); } finally { for (const state of worn) this.restore(state); }
  }

  clear(): void { for (const state of this.states.values()) this.restore(state); }

  /** Drops actors that left the scene (region change) and their twins. */
  forget(keep: (root: Object3D) => boolean): void {
    for (const [root, state] of this.states) {
      if (keep(root)) continue;
      this.restore(state);
      for (const clone of state.cloneSet) clone.dispose();
      this.states.delete(root);
    }
  }

  dispose(): void { this.forget(() => false); }

  get activeCount(): number { let count = 0; for (const state of this.states.values()) if (state.swapped.size) count++; return count; }

  private stateFor(root: Object3D): FlashState {
    let state = this.states.get(root);
    if (!state) {
      state = { color: { value: new Color() }, strength: { value: 0 }, base: { value: 0 }, clones: new Map(), cloneSet: new Set(), swapped: new Map(), peak: 0, elapsed: 0, duration: 1, mode: 'hit' };
      this.states.set(root, state);
    }
    return state;
  }

  private wear(root: Object3D, state: FlashState): void {
    root.traverse(node => {
      if (!(node instanceof Mesh)) return;
      const current: Material | Material[] = node.material;
      const twin = (material: Material): Material => this.twin(material, state);
      node.material = Array.isArray(current) ? current.map(twin) : twin(current);
      state.swapped.set(node, current);
    });
  }

  private restore(state: FlashState): void {
    for (const [mesh, original] of state.swapped) {
      const current: Material | Material[] = mesh.material;
      const ours = Array.isArray(current) ? current.some(material => state.cloneSet.has(material)) : state.cloneSet.has(current);
      if (ours) mesh.material = original;
    }
    state.swapped.clear();
    state.strength.value = 0;
  }

  private twin(source: Material, state: FlashState): Material {
    if (!hasEmissive(source) || state.cloneSet.has(source)) return source;
    let clone = state.clones.get(source);
    if (clone) return clone;
    clone = source.clone();
    clone.name = `${source.name}:hit-flash`;
    clone.customProgramCacheKey = () => 'wild-crown-hit-rim';
    clone.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
      shader.uniforms.uHitColor = state.color;
      shader.uniforms.uHitStrength = state.strength;
      shader.uniforms.uHitBase = state.base;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uHitColor;\nuniform float uHitStrength;\nuniform float uHitBase;')
        .replace('#include <emissivemap_fragment>', [
          '#include <emissivemap_fragment>',
          '{',
          '  float hitNl = length(normal), hitVl = length(vViewPosition);',
          '  float hitFacing = (hitNl > 1e-4 && hitVl > 1e-4) ? abs(dot(normal / hitNl, vViewPosition / hitVl)) : 1.0;',
          '  float hitRim = 1.0 - saturate(hitFacing);',
          '  hitRim = hitRim * hitRim * hitRim;',
          '  totalEmissiveRadiance += uHitColor * clamp(uHitStrength, 0.0, 2.0) * (uHitBase + hitRim);',
          '}',
        ].join('\n'));
    };
    state.clones.set(source, clone);
    state.cloneSet.add(clone);
    return clone;
  }
}
