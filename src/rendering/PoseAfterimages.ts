import { AdditiveBlending, Group, LessDepth, Mesh, MeshBasicMaterial, NormalBlending, SkinnedMesh, Vector3, type Object3D, type Scene } from 'three';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import type { ActorSnapshot, WorldClockSnapshot } from '../game/contracts';

/** Pooled native poses for jump, Dive, run and the dash skills; the rest cover the dense dash/blink look. */
const GHOST_COUNT = 12;
const DASH_ACTION = 'aren-judgement';

/**
 * Silhouette look of each hero (`HeroDefinition.style`): the two tints ordinary ghosts alternate between, the additive HDR colour of dash/blink
 * ghosts, the capture spacing and life of both kinds and their opacity. Warden is Aren's jade/ivory with a cyan dash, Heartroot Yara's amber/petal-ivory with
 * an amber dash, Umbral Vesper's violet-black with a crimson rim (denser, longer-lived and used for every blink), Ember Sakda's flame orange/gold with a molten dash.
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
}
export const AFTERIMAGE_STYLES: Readonly<Record<AfterimageStyle, AfterimageLook>> = {
  warden: { tint: [0x8ee2be, 0xe7f0bf], dash: [0.5, 1.5, 2.4], spacing: 4, dashSpacing: 2, life: 18, dashLife: 14, opacity: 0.34, dashOpacity: 0.55, dodgeDash: false },
  heartroot: { tint: [0xf1ba4a, 0xffd9c4], dash: [2.4, 1.4, 0.35], spacing: 4, dashSpacing: 2, life: 18, dashLife: 14, opacity: 0.34, dashOpacity: 0.55, dodgeDash: false },
  umbral: { tint: [0x24104a, 0x7a1238], dash: [0.85, 0.1, 1.8], spacing: 3, dashSpacing: 2, life: 24, dashLife: 26, opacity: 0.42, dashOpacity: 0.48, dodgeDash: true },
  ember: { tint: [0xff7a1a, 0xffd34d], dash: [1.15, 0.38, 0.06], spacing: 4, dashSpacing: 2, life: 18, dashLife: 16, opacity: 0.26, dashOpacity: 0.32, dodgeDash: false },
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
  private lastTick = -Infinity;
  private lastCapture = -Infinity;
  private cursor = 0;
  private disposed = false;
  private styleName: AfterimageStyle = 'warden';

  get style(): AfterimageStyle { return this.styleName; }

  /** Switches the ghost palette (called by the renderer when the hero is equipped); live ghosts of the old style are dropped. */
  setStyle(style: AfterimageStyle): void {
    if (style === this.styleName) return;
    this.styleName = style;
    this.clear();
  }

  constructor(scene: Scene, private readonly source: Object3D) {
    this.group.name = 'aren:pose-afterimages';
    scene.add(this.group);
    source.traverse(node => this.sourceNodes.push(node));
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

  update(actor: ActorSnapshot, clock: WorldClockSnapshot, reducedMotion: boolean): void {
    if (this.disposed) return;
    if (reducedMotion || !actor.visible || actor.downed) { this.clear(); return; }
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
    const displaced = this.lastCapture === -Infinity || this.position.distanceToSquared(this.lastPosition) >= (skill ? 0.01 : 0.04);
    const moving = Math.hypot(actor.velocity.x, jump ? actor.velocity.y : 0, actor.velocity.z) > 0.5 || (skill && displaced);
    const eligible = jump || skill || dodge || action === 'aren-run';
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
    ghost.life = dash ? look.dashLife : look.life; ghost.peak = dash ? look.dashOpacity : look.opacity;
    // Dash/blink ghosts: an HDR silhouette in the hero's colour added over the scene (run, jump and ordinary dodges keep the soft tint).
    if (dash) ghost.material.color.setRGB(look.dash[0], look.dash[1], look.dash[2]); else ghost.material.color.set(look.tint[index % 2 ? 1 : 0]);
    ghost.material.blending = dash ? AdditiveBlending : NormalBlending;
    ghost.material.opacity = ghost.peak;
    this.lastCapture = clock.worldTick;
    this.lastPosition.copy(this.position);
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
