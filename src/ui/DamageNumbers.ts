import { Vector3, type Camera } from 'three';
import type { WorldClockSnapshot } from '../game/contracts.js';
import type { CombatEvent } from '../game/combat/CombatEngine.js';
import { ScreenVignette } from '../effects/vfx/ScreenVignette.js';
import './combat-feel.css';

/** Producer-owned vitality-loss payload (optional on CombatEvent). */
type DamagePayload = NonNullable<CombatEvent['damage']>;

const POOL = 32;
const LIFETIME_TICKS = 48;
/** Mid-body anchor (m above the hit position): numbers rise beside the target, below its nameplate (head socket + 0.55 m). */
const ANCHOR_HEIGHT = 1.0;
const RISE_HEIGHT = 0.7;
/** Screen-space side offset (px) that keeps the number off the target's silhouette, plus a small per-hit stagger. */
const SIDE_OFFSET = 64;
const SIDE_STAGGER = 14;
const DEDUP_LIMIT = 128;

const OWNER_CLASS = 'wc-damage-numbers';
const LABEL_CLASS = 'wc-damage-number';
const PLAYER_MODIFIER = 'wc-damage-number--player';
/** Damage thresholds (vitality lost per hit) for the four size/colour tiers the number picks from at spawn. */
const TIER_SMALL_MAX = 6;
const TIER_HEAVY_MIN = 18;
/** Step "critical hit" — extra big gold (typically a backstab, mark-strike or finisher). */
const TIER_CRIT_MIN = 28;
const TIER_CLASSES = ['wc-damage-number--small', 'wc-damage-number--heavy', 'wc-damage-number--crit'] as const;
const PLAYER_ID = 'aren';

interface Slot {
  readonly element: HTMLDivElement;
  readonly anchor: Vector3;
  active: boolean;
  spawnTick: number;
  order: number;
  spread: number;
}

/**
 * Floating vitality-loss numbers plus the red screen-edge pulse when Aren is hurt. The component
 * owns a single absolute overlay attached to a host supplied by the caller; preallocated label
 * slots recycle deterministically and no per-frame DOM or Vector3 is allocated after construction.
 */
export class DamageNumbers {
  readonly element: HTMLDivElement;
  private readonly vignette: ScreenVignette;
  private readonly slots: Slot[] = [];
  private readonly recentIds: string[] = [];
  private readonly seenIds: Set<string> = new Set();
  private readonly scratch = new Vector3();
  private sequence = 0;
  private disposed = false;

  constructor(host: HTMLElement) {
    const owner = document.createElement('div');
    owner.className = OWNER_CLASS;
    owner.setAttribute('aria-hidden', 'true');
    this.element = owner;
    host.appendChild(owner);
    for (let i = 0; i < POOL; i++) {
      const label = document.createElement('div');
      label.className = LABEL_CLASS;
      label.style.opacity = '0';
      label.style.transform = 'translate(-9999px,-9999px)';
      owner.appendChild(label);
      this.slots.push({ element: label, anchor: new Vector3(), active: false, spawnTick: 0, spread: 0, order: 0 });
    }
    this.vignette = new ScreenVignette(host);
  }

  consume(events: readonly CombatEvent[]): void {
    if (this.disposed || events.length === 0) return;
    for (const raw of events) {
      const damage = raw.damage;
      if (!damage) continue;
      if (!Number.isFinite(damage.amount) || damage.amount <= 0) continue;
      const id = raw.id;
      if (id) {
        if (this.seenIds.has(id)) continue;
        this.seenIds.add(id);
        this.recentIds.push(id);
        if (this.recentIds.length > DEDUP_LIMIT) {
          const evicted = this.recentIds.shift();
          if (evicted !== undefined) this.seenIds.delete(evicted);
        }
      }
      this.spawn(damage);
      if (damage.targetId === PLAYER_ID) this.vignette.pulse(Math.min(1, 0.35 + damage.amount / 28), damage.worldTick);
    }
  }

  update(clock: WorldClockSnapshot, camera: Camera, width: number, height: number, reducedMotion: boolean): void {
    if (this.disposed) return;
    const worldTick = clock.worldTick;
    this.vignette.update(worldTick, reducedMotion);
    camera.updateMatrixWorld();
    for (const slot of this.slots) {
      if (!slot.active) continue;
      const age = worldTick - slot.spawnTick;
      if (age >= LIFETIME_TICKS) {
        slot.active = false;
        slot.element.style.opacity = '0';
        slot.element.style.transform = 'translate(-9999px,-9999px)';
        slot.element.textContent = '';
        delete slot.element.dataset['targetId'];
        delete slot.element.dataset['amount'];
        delete slot.element.dataset['tier'];
        slot.element.style.animation = '';
        for (const cls of TIER_CLASSES) slot.element.classList.remove(cls);
        continue;
      }
      const t = age / LIFETIME_TICKS;
      this.scratch.copy(slot.anchor);
      if (!reducedMotion) this.scratch.y += t * RISE_HEIGHT;
      this.scratch.project(camera);
      // Hide when the anchor projects to non-finite NDC, behind the camera, or outside the visible frame (with a
      // small margin so a label half off an edge still reads). Hidden labels are parked off the overlay.
      const hideX = 1.05, hideY = 1.05;
      const hide =
        !Number.isFinite(this.scratch.x) ||
        !Number.isFinite(this.scratch.y) ||
        !Number.isFinite(this.scratch.z) ||
        this.scratch.z < -1 || this.scratch.z > 1 ||
        this.scratch.x < -hideX || this.scratch.x > hideX ||
        this.scratch.y < -hideY || this.scratch.y > hideY;
      if (hide) {
        slot.element.style.opacity = '0';
        // Move the label off the overlay entirely so an unfavourable projection can never default to (0, 0)
        // (the overlay's anchor) on the next valid frame.
        slot.element.style.transform = 'translate(-9999px,-9999px)';
        continue;
      }
      const sx = (this.scratch.x * 0.5 + 0.5) * width + slot.spread;
      const sy = (-this.scratch.y * 0.5 + 0.5) * height;
      slot.element.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -100%)`;
      slot.element.style.opacity = String(reducedMotion ? (t < 0.85 ? 1 : Math.max(0, 1 - (t - 0.85) / 0.15)) : 1 - t * t);
    }
  }

  clear(): void {
    if (this.disposed) return;
    for (const slot of this.slots) {
      slot.active = false;
      slot.element.style.opacity = '0';
      slot.element.style.transform = 'translate(-9999px,-9999px)';
      slot.element.textContent = '';
      delete slot.element.dataset['targetId'];
      delete slot.element.dataset['amount'];
      delete slot.element.dataset['tier'];
      slot.element.style.animation = '';
      for (const cls of TIER_CLASSES) slot.element.classList.remove(cls);
    }
    this.recentIds.length = 0;
    this.seenIds.clear();
    this.sequence = 0;
    this.vignette.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    this.element.remove();
    this.vignette.dispose();
  }

  private spawn(damage: DamagePayload): void {
    let index = -1;
    for (let i = 0; i < this.slots.length; i++) {
      if (!this.slots[i]!.active) { index = i; break; }
    }
    if (index < 0) {
      let oldest = Infinity;
      for (let i = 0; i < this.slots.length; i++) {
        const order = this.slots[i]!.order;
        if (order < oldest) { oldest = order; index = i; }
      }
    }
    if (index < 0) return;
    const slot = this.slots[index]!;
    slot.anchor.set(damage.position.x, damage.position.y + ANCHOR_HEIGHT, damage.position.z);
    slot.spawnTick = damage.worldTick;
    slot.order = ++this.sequence;
    slot.active = true;
    const seed = (damage.worldTick * 131 + index * 17) % 7;
    slot.spread = (seed % 2 === 0 ? 1 : -1) * (SIDE_OFFSET + (seed % 3) * SIDE_STAGGER);
    const el = slot.element;
    el.textContent = `-${damage.amount}`;
    el.dataset['targetId'] = damage.targetId;
    el.dataset['amount'] = String(damage.amount);
    el.classList.toggle(PLAYER_MODIFIER, damage.targetId === PLAYER_ID);
    // Tier class: small (≤6), normal (default), heavy (≥18), crit-gold (≥28). combat-feel.css styles size + colour.
    for (const cls of TIER_CLASSES) el.classList.remove(cls);
    if (damage.amount >= TIER_CRIT_MIN) el.classList.add('wc-damage-number--crit');
    else if (damage.amount >= TIER_HEAVY_MIN) el.classList.add('wc-damage-number--heavy');
    else if (damage.amount <= TIER_SMALL_MAX) el.classList.add('wc-damage-number--small');
    // Short pop-in scale keyframe on each spawn (240 ms). The per-frame transform write still wins on each tick;
    // the animation adds a scale multiplier that interpolates from the visual origin (-50%, -100%).
    el.style.animation = 'wc-damage-pop-in 240ms cubic-bezier(.2,.8,.4,1) both';
    el.dataset['tier'] = damage.amount >= TIER_CRIT_MIN ? 'crit' : damage.amount >= TIER_HEAVY_MIN ? 'heavy' : damage.amount <= TIER_SMALL_MAX ? 'small' : 'normal';
  }
}
