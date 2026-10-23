import { AdditiveBlending, Group, LessDepth, Mesh, MeshBasicMaterial, NormalBlending, SkinnedMesh, Vector3, type Object3D, type Scene } from 'three';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import type { ActorSnapshot, WorldClockSnapshot } from '../game/contracts';
import { VESPER_BLADE_CLIPS } from '../effects/vfx/HeroKits';

/** Pooled native poses for jump, Dive, run and the dash skills; the rest cover the dense dash/blink look. */
const GHOST_COUNT = 12;
const DASH_ACTION = 'aren-judgement';

/**
 * Silhouette look of each hero (`HeroDefinition.style`): ordinary tint pairs, dash colour, capture spacing, life and opacity.
 * Aren, Yara and Sakda keep additive HDR dashes. Vesper leaves dark violet/crimson native silhouettes, not a neon wash over his body.
 */
export type AfterimageStyle = 'warden' | 'heartroot' | 'umbral' | 'ember';
export interface AfterimageLook {
  readonly tint: readonly [number, number];
  readonly dash: readonly [number, number, number];
  /** Minimum world ticks between captures of ordinary / dash ghosts, and their life (ticks) and peak opacity. */
  readonly spacing: number; readonly dashSpacing: number;
  readonly life: number; readonly dashLife: number;
  readonly opacity: number; readonly dashOpacity: number;
  /** Dodges are blinks for this hero: they use the dash look. */
  readonly dodgeDash: boolean;
  /** Dodges leave silhouette ghosts (false: the dodge hides the body, so nothing of it trails). */
  readonly dodgeGhosts: boolean;
}
export const AFTERIMAGE_STYLES: Readonly<Record<AfterimageStyle, AfterimageLook>> = {
  warden: { tint: [0x8ee2be, 0xe7f0bf], dash: [0.5, 1.5, 2.4], spacing: 4, dashSpacing: 2, life: 18, dashLife: 14, opacity: 0.34, dashOpacity: 0.55, dodgeDash: false, dodgeGhosts: true },
  heartroot: { tint: [0xf1ba4a, 0xffd9c4], dash: [2.4, 1.4, 0.35], spacing: 4, dashSpacing: 2, life: 18, dashLife: 14, opacity: 0.34, dashOpacity: 0.55, dodgeDash: false, dodgeGhosts: false },
  umbral: { tint: [0x24104a, 0x7a1238], dash: [0.02, 0.004, 0.045], spacing: 3, dashSpacing: 2, life: 24, dashLife: 26, opacity: 0.42, dashOpacity: 0.38, dodgeDash: true, dodgeGhosts: true },
  ember: { tint: [0xff7a1a, 0xffd34d], dash: [1.15, 0.38, 0.06], spacing: 4, dashSpacing: 2, life: 18, dashLife: 16, opacity: 0.26, dashOpacity: 0.32, dodgeDash: false, dodgeGhosts: true },
};

/** Dash skills of Vesper and Sakda (they move the body through space), plus Aren's Judgement dash: each leaves ghosts even when the engine teleports the body. */
export const AFTERIMAGE_DASH_ACTIONS: Readonly<Record<string, true>> = {
  [DASH_ACTION]: true,
  'vesper-iai-4': true, 'vesper-shadow-step': true, 'vesper-thousand-cuts': true, 'vesper-shade-swap': true, 'vesper-requiem': true,
  'sakda-resonating-strike': true, 'sakda-flying-knee': true, 'sakda-hundred-elbows': true, 'sakda-tigers-wrath': true,
};
/** The shared dodge ids (every hero's own dash clip is mapped onto them). */
const DODGE_ACTION = /^aren-(forward-(left|right)-dive-roll|perfect-dodge-(left|right)|quick-step-(left|right)|forward-shoulder-roll|back-handspring|(left|right)-cartwheel|back-(left|right)-pivot-roll|low-slide)$/;

interface Ghost {
  readonly root: Object3D;
  readonly nodes: Object3D[];
  readonly material: MeshBasicMaterial;
  readonly skeletons: SkinnedMesh['skeleton'][];
  born: number;
  life: number;
  peak: number;
}

/** Frozen native skeletal poses; capture never changes the live rig or shared geometry. */
export class PoseAfterimages {
  readonly group = new Group();
  private readonly sourceNodes: Object3D[] = [];
  private readonly ghosts: Ghost[] = [];
  private readonly position = new Vector3();
  private readonly lastPosition = new Vector3();
  private readonly tipPosition = new Vector3();
  private readonly lastTip = new Vector3();
  private readonly bladeTip: Object3D | undefined;
  private lastTick = -Infinity;
  private lastCapture = -Infinity;
  private cursor = 0;
  private disposed = false;
  private styleName: AfterimageStyle = 'warden';
  /** When false, no new ghost is captured; any live ghosts are dropped. Reduced motion wins over motion-blur. */
  private motionBlur = true;

  get style(): AfterimageStyle { return this.styleName; }

  /** Switches the ghost palette (called by the renderer when the hero is equipped); live ghosts of the old style are dropped. */
  setStyle(style: AfterimageStyle): void {
    if (style === this.styleName) return;
    this.styleName = style;
    this.clear();
  }

  /**
   * Routes the in-game motion-blur accessibility setting. When off, no new pose-afterimage is captured
   * and any live ghost is dropped (the next `update` call returns early). Reduced motion still wins
   * — when both are off, the effect is silent; when only motion-blur is off, dashes/jumps feel crisper
   * without losing the dash HDR silhouettes that come from the cue-driven VFX (those run elsewhere).
   */
  setMotionBlur(enabled: boolean): void {
    if (this.motionBlur === enabled) return;
    this.motionBlur = enabled;
    if (!enabled) this.clear();
  }

  constructor(scene: Scene, private readonly source: Object3D) {
    this.group.name = 'aren:pose-afterimages';
    scene.add(this.group);
    source.traverse(node => this.sourceNodes.push(node));
    this.bladeTip = source.getObjectByName('wc:weapon-tip');
    for (let i = 0; i < GHOST_COUNT; i++) {
      const root = clone(source);
      // Strict depth test: a ghost captured this tick coincides with the live body and must not wash over it; displaced ghosts still draw.
      const material = new MeshBasicMaterial({ color: AFTERIMAGE_STYLES[this.styleName].tint[i % 2 ? 1 : 0], transparent: true, opacity: AFTERIMAGE_STYLES[this.styleName].opacity, depthWrite: false, depthFunc: LessDepth, toneMapped: false });
      const nodes: Object3D[] = [], skeletons: SkinnedMesh['skeleton'][] = [];
      root.traverse(node => {
        nodes.push(node);
        if (node instanceof Mesh) { node.material = material; node.castShadow = false; node.receiveShadow = false; }
        if (node instanceof SkinnedMesh) skeletons.push(node.skeleton);
      });
      root.name = `aren-afterimage-${i}`;
      root.visible = false;
      root.matrixAutoUpdate = false;
      this.group.add(root);
      this.ghosts.push({ root, nodes, material, skeletons, born: -Infinity, life: AFTERIMAGE_STYLES[this.styleName].life, peak: AFTERIMAGE_STYLES[this.styleName].opacity });
    }
  }

  update(actor: Pick<ActorSnapshot, 'actionId' | 'phase' | 'visible' | 'downed' | 'velocity' | 'jumpPhase'>, clock: WorldClockSnapshot, reducedMotion: boolean): void {
    if (this.disposed) return;
    if (reducedMotion || !this.motionBlur || !actor.visible || actor.downed) { this.clear(); return; }
    this.source.parent?.updateWorldMatrix(true, false);
    this.source.updateMatrixWorld(true);
    this.source.getWorldPosition(this.position);
    const action = actor.actionId, look = AFTERIMAGE_STYLES[this.styleName], skill = AFTERIMAGE_DASH_ACTIONS[action] === true;
    // A dash skill may teleport the body (blink strikes): its ghosts must survive the jump, everything else resets on a jump of more than 3 m.
    if (clock.worldTick < this.lastTick || (this.lastTick !== -Infinity && !skill && this.position.distanceToSquared(this.lastPosition) > 9)) this.clear();
    this.lastTick = clock.worldTick;
    if (clock.policy === 'paused') return;
    for (const ghost of this.ghosts) {
      const age = clock.worldTick - ghost.born;
      ghost.root.visible = age >= 0 && age < ghost.life;
      if (ghost.root.visible) ghost.material.opacity = ghost.peak * (1 - age / ghost.life) ** 2;
    }
    const jump = action === 'aren-jump' && (actor.jumpPhase === 'rising' || actor.jumpPhase === 'falling');
    const dodge = DODGE_ACTION.test(action), dash = skill || (dodge && look.dodgeDash);
    // In-place sword work has no root velocity. Capture its real skeletal change from the fitted kissaki,
    // not a fake offset of the live character; held poses and non-umbral heroes retain the old path.
    const bladeSwing = this.styleName === 'umbral' && actor.phase !== 'idle' && VESPER_BLADE_CLIPS[action] === true && this.bladeTip !== undefined;
    if (bladeSwing) this.bladeTip!.getWorldPosition(this.tipPosition);
    const poseDisplaced = bladeSwing && (this.lastCapture === -Infinity || this.tipPosition.distanceToSquared(this.lastTip) >= 0.04);
    const displaced = this.lastCapture === -Infinity || this.position.distanceToSquared(this.lastPosition) >= (skill ? 0.01 : 0.04) || poseDisplaced;
    const moving = Math.hypot(actor.velocity.x, jump ? actor.velocity.y : 0, actor.velocity.z) > 0.5 || (skill && displaced) || poseDisplaced;
    // Yara's Petal Step is a blink (her body is hidden for the whole travel): petals mark it, not a silhouette trail of the hidden body.
    const eligible = jump || skill || (dodge && look.dodgeGhosts) || action === 'aren-run' || bladeSwing;
    if (!eligible || !moving || !displaced || clock.worldTick - this.lastCapture < (dash ? look.dashSpacing : look.spacing)) return;
    const index = this.cursor, ghost = this.ghosts[index]!;
    this.cursor = (index + 1) % this.ghosts.length;
    ghost.root.matrix.copy(this.source.matrixWorld);
    for (let i = 1; i < this.sourceNodes.length; i++) {
      const source = this.sourceNodes[i]!, target = ghost.nodes[i]!;
      target.position.copy(source.position); target.quaternion.copy(source.quaternion); target.scale.copy(source.scale);
      target.matrix.copy(source.matrix);
    }
    ghost.root.updateMatrixWorld(true);
    for (const skeleton of ghost.skeletons) skeleton.update();
    ghost.born = clock.worldTick;
    ghost.root.visible = true;
    ghost.life = bladeSwing && !dash ? 12 : dash ? look.dashLife : look.life;
    ghost.peak = bladeSwing && !dash ? 0.26 : dash ? look.dashOpacity : look.opacity;
    // Umbral blinks absorb light; the other heroes retain their additive HDR dash silhouette.
    if (dash) ghost.material.color.setRGB(look.dash[0], look.dash[1], look.dash[2]); else ghost.material.color.set(look.tint[index % 2 ? 1 : 0]);
    ghost.material.blending = dash && this.styleName !== 'umbral' ? AdditiveBlending : NormalBlending;
    ghost.material.opacity = ghost.peak;
    this.lastCapture = clock.worldTick;
    this.lastPosition.copy(this.position);
    if (bladeSwing) this.lastTip.copy(this.tipPosition);
  }

  clear(): void {
    for (const ghost of this.ghosts) { ghost.root.visible = false; ghost.born = -Infinity; }
    this.lastTick = this.lastCapture = -Infinity;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear(); this.group.removeFromParent();
    for (const ghost of this.ghosts) { ghost.material.dispose(); for (const skeleton of ghost.skeletons) skeleton.dispose(); }
  }
}
