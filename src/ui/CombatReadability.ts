import { Vector3, Vector4 } from 'three';
import type { Camera } from 'three';
import type { ActorId, ActorSnapshot, CombatSnapshot, GameSettings } from '../game/contracts.js';
import './combat-readability.css';

/** Maximum simultaneous off-screen telegraph arrows; the pool never grows. */
const POOL = 6;
/** Mid-body anchor (m above the target's position) for the ring draw height. */
const RING_ANCHOR_Y = 1.0;
/** Margin (px) the off-screen arrows keep from the viewport edge. */
const EDGE_PADDING = 56;
/** Bounded ring radius (px) on screen — a fixed, readable footprint for both default and high-contrast. */
const RING_RADIUS_PX = 56;
/** Source anchor raised above each off-screen hostile's position (m). */
const SOURCE_ANCHOR_Y = 1.2;
/** Phases that mean a live, undeniable threat: windup, commit, active. */
const ACTIVE_PHASES: Readonly<Record<string, true>> = { windup: true, commit: true, active: true };

const OWNER_CLASS = 'wc-combat-readability';
const RING_CLASS = 'wc-target-ring';
const ARROW_CLASS = 'wc-offscreen-arrow';
const PLAYER_ID = 'aren';

interface RingSlot {
  readonly element: HTMLDivElement;
  actorId: string | undefined;
}

interface ArrowSlot {
  readonly element: HTMLDivElement;
  sourceId: ActorId | undefined;
  seen: boolean;
}

interface Vec2 { x: number; y: number }

/** Target ring at the current hostile target plus an off-screen warning strip for live player-targeted telegraphs. */
export class CombatReadability {
  readonly element: HTMLDivElement;
  private readonly slots: RingSlot[] = [];
  private readonly arrows: ArrowSlot[] = [];
  private readonly scratch = new Vector3();
  private readonly clip = new Vector4();
  private readonly screen: Vec2 = { x: 0, y: 0 };
  private disposed = false;
  private highContrastTarget = false;
  private reducedMotion = false;
  private offscreenWarningStrength: 'low' | 'standard' | 'high' = 'standard';

  constructor(root: HTMLElement) {
    const owner = document.createElement('div');
    owner.className = OWNER_CLASS;
    owner.setAttribute('aria-hidden', 'true');
    owner.dataset['reducedMotion'] = 'false';
    owner.dataset['highContrast'] = 'false';
    this.element = owner;
    root.appendChild(owner);
    this.slots.push(this.createRing(owner));
    for (let i = 0; i < POOL; i++) {
      const arrow = document.createElement('div');
      arrow.className = ARROW_CLASS;
      arrow.hidden = true;
      arrow.dataset['strength'] = this.offscreenWarningStrength;
      owner.appendChild(arrow);
      this.arrows.push({ element: arrow, sourceId: undefined, seen: false });
    }
  }

  setSettings(settings: GameSettings): void {
    this.highContrastTarget = settings.highContrastTarget;
    this.reducedMotion = settings.reducedMotion;
    this.offscreenWarningStrength = settings.offscreenWarningStrength;
    this.element.dataset['highContrast'] = String(this.highContrastTarget);
    this.element.dataset['reducedMotion'] = String(this.reducedMotion);
    for (const arrow of this.arrows) arrow.element.dataset['strength'] = this.offscreenWarningStrength;
  }

  update(snapshot: CombatSnapshot, camera: Camera, width: number, height: number): void {
    if (this.disposed) return;
    if (width <= 0 || height <= 0) { this.clear(); return; }
    camera.updateMatrixWorld();
    const player = snapshot.actors.find(actor => actor.id === PLAYER_ID);
    if (!player || !player.visible || player.downed) { this.clear(); return; }
    this.updateRing(this.slots[0]!, snapshot, camera, width, height, player);
    this.updateArrows(snapshot, camera, width, height, player);
  }

  clear(): void {
    if (this.disposed) return;
    const ring = this.slots[0]!;
    ring.element.hidden = true;
    ring.actorId = undefined;
    for (const arrow of this.arrows) {
      arrow.element.hidden = true;
      arrow.sourceId = undefined;
      arrow.seen = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    this.element.remove();
  }

  private createRing(owner: HTMLDivElement): RingSlot {
    const ring = document.createElement('div');
    ring.className = RING_CLASS;
    ring.hidden = true;
    const inner = document.createElement('div');
    inner.className = 'wc-target-ring__inner';
    ring.appendChild(inner);
    owner.appendChild(ring);
    return { element: ring, actorId: undefined };
  }

  private updateRing(ring: RingSlot, snapshot: CombatSnapshot, camera: Camera, width: number, height: number, player: ActorSnapshot | undefined): void {
    const target = this.validHostileTarget(snapshot, player);
    if (!target) { ring.element.hidden = true; ring.actorId = undefined; return; }
    this.scratch.set(target.position.x, target.position.y + RING_ANCHOR_Y, target.position.z);
    this.scratch.project(camera);
    if (!Number.isFinite(this.scratch.z) || this.scratch.z < -1 || this.scratch.z > 1) {
      ring.element.hidden = true; ring.actorId = undefined; return;
    }
    const px = (this.scratch.x + 1) * width * 0.5;
    const py = (1 - this.scratch.y) * height * 0.5;
    if (px < 0 || py < 0 || px > width || py > height) { ring.element.hidden = true; ring.actorId = undefined; return; }
    if (ring.actorId !== target.id) { ring.actorId = target.id; ring.element.dataset['actor'] = target.id; }
    ring.element.dataset['highContrast'] = String(this.highContrastTarget);
    ring.element.dataset['reducedMotion'] = String(this.reducedMotion);
    ring.element.hidden = false;
    ring.element.style.transform = `translate(${px}px, ${py}px) translate(-50%, -50%)`;
    ring.element.style.setProperty('--wc-ring-radius', `${RING_RADIUS_PX}px`);
  }

  private updateArrows(snapshot: CombatSnapshot, camera: Camera, width: number, height: number, player: ActorSnapshot | undefined): void {
    for (const arrow of this.arrows) arrow.seen = false;
    if (player) for (const telegraph of snapshot.telegraphs) {
      if (!ACTIVE_PHASES[telegraph.phase] || telegraph.remainingTicks <= 0 || telegraph.targetActorId !== player.id) continue;
      let source: ActorSnapshot | undefined;
      for (const actor of snapshot.actors) if (actor.id === telegraph.sourceId) { source = actor; break; }
      if (!source || !source.visible || source.downed || source.allegiance !== 'hostile') continue;
      if (!this.projectSource(source.position.x, source.position.y + SOURCE_ANCHOR_Y, source.position.z, camera, width, height)) continue;
      let slot: ArrowSlot | undefined;
      for (const arrow of this.arrows) if (arrow.sourceId === source.id) { slot = arrow; break; }
      if (slot?.seen) continue;
      if (!slot) for (const arrow of this.arrows) if (!arrow.seen) { slot = arrow; break; }
      if (!slot) continue;
      slot.sourceId = source.id;
      slot.seen = true;
      this.drawArrow(slot, width, height);
    }
    for (const arrow of this.arrows) if (!arrow.seen) {
      arrow.element.hidden = true;
      arrow.sourceId = undefined;
    }
  }

  private drawArrow(arrow: ArrowSlot, width: number, height: number): void {
    const cx = width * 0.5, cy = height * 0.5;
    let dx = this.screen.x, dy = this.screen.y;
    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) { dx = 0; dy = 1; }
    const halfW = Math.max(0, cx - EDGE_PADDING), halfH = Math.max(0, cy - EDGE_PADDING);
    const k = Math.min(Math.abs(dx) > 1e-6 ? halfW / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-6 ? halfH / Math.abs(dy) : Infinity);
    // The CSS chevron points up; clockwise screen-space rotation preserves direction even in reduced motion.
    const angle = Math.atan2(dy, dx) * 180 / Math.PI + 90;
    arrow.element.style.transform = `translate(${cx + dx * k}px, ${cy + dy * k}px) translate(-50%, -50%) rotate(${angle}deg)`;
    arrow.element.hidden = false;
  }

  /** Stores the corrected screen-space direction; clip depth excludes far/near-plane sources without calling them behind the eye. */
  private projectSource(x: number, y: number, z: number, camera: Camera, width: number, height: number): boolean {
    this.scratch.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
    const behind = this.scratch.z >= 0;
    this.clip.set(this.scratch.x, this.scratch.y, this.scratch.z, 1).applyMatrix4(camera.projectionMatrix);
    if (!Number.isFinite(this.clip.x) || !Number.isFinite(this.clip.y) || !Number.isFinite(this.clip.z) || !Number.isFinite(this.clip.w)) return false;
    const divisor = Math.max(1e-6, Math.abs(this.clip.w));
    this.screen.x = this.clip.x / divisor * width * 0.5;
    this.screen.y = -this.clip.y / divisor * height * 0.5;
    const depth = this.clip.z / divisor;
    return behind || depth < -1 || depth > 1 || Math.abs(this.screen.x) > width * 0.5 || Math.abs(this.screen.y) > height * 0.5;
  }

  /**
   * The renderer must never invent a target — the simulation is authoritative. The HUD shows the ring only when
   * `snapshot.targetId` is a present, alive, visible, hostile actor. `lockStatus` is not consulted (it is informational
   * for other HUD layers); any valid current target draws the ring.
   */
  private validHostileTarget(snapshot: CombatSnapshot, player: ActorSnapshot | undefined): ActorSnapshot | undefined {
    if (!player) return undefined;
    const id = snapshot.targetId;
    if (!id) return undefined;
    const actor = snapshot.actors.find(candidate => candidate.id === id);
    if (!actor || !actor.visible || actor.downed) return undefined;
    if (actor.allegiance !== 'hostile') return undefined;
    return actor;
  }
}
