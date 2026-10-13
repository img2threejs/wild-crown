import { Vector3, type Camera } from 'three';
import type { WorldClockSnapshot } from '../game/contracts.js';
import type { CombatEvent } from '../game/combat/CombatEngine.js';
import { ScreenVignette } from '../effects/vfx/ScreenVignette.js';

/** Producer-owned vitality-loss payload (optional on CombatEvent). */
type DamagePayload = NonNullable<CombatEvent['damage']>;

const POOL = 32;
const LIFETIME_TICKS = 48;
const ANCHOR_HEIGHT = 1.7;
const RISE_HEIGHT = 0.7;
const SPREAD_BUDGET = 64;
const DEDUP_LIMIT = 128;

const OWNER_CLASS = 'wc-damage-numbers';
const LABEL_CLASS = 'wc-damage-number';
const PLAYER_MODIFIER = 'wc-damage-number--player';
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
        continue;
      }
      const t = age / LIFETIME_TICKS;
      this.scratch.copy(slot.anchor);
      if (!reducedMotion) this.scratch.y += t * RISE_HEIGHT;
      this.scratch.project(camera);
      const hide =
        !Number.isFinite(this.scratch.x) ||
        !Number.isFinite(this.scratch.y) ||
        !Number.isFinite(this.scratch.z) ||
        this.scratch.z < -1 || this.scratch.z > 1 ||
        this.scratch.x < -1.05 || this.scratch.x > 1.05 ||
        this.scratch.y < -1.05 || this.scratch.y > 1.05;
      if (hide) {
        slot.element.style.opacity = '0';
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
    slot.spread = ((seed - 3) / 3) * (SPREAD_BUDGET / 2);
    const el = slot.element;
    el.textContent = `-${damage.amount}`;
    el.dataset['targetId'] = damage.targetId;
    el.dataset['amount'] = String(damage.amount);
    el.classList.toggle(PLAYER_MODIFIER, damage.targetId === PLAYER_ID);
  }
}
