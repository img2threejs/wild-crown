/** World ticks for a damage pulse to fall to ~1/e; ages with the scaled world clock like the damage numbers. */
const DECAY_TICKS = 16;

/** Red screen-edge pulse on player damage; a single pointer-transparent overlay element. */
export class ScreenVignette {
  readonly element: HTMLDivElement;
  private level = 0;
  private pulseTick = 0;
  private written = 0;
  private disposed = false;

  constructor(host: HTMLElement) {
    const element = document.createElement('div');
    element.className = 'wc-damage-vignette';
    element.setAttribute('aria-hidden', 'true');
    const style = element.style;
    style.position = 'absolute';
    style.inset = '0';
    style.pointerEvents = 'none';
    style.zIndex = '10';
    // No pulse yet: the overlay must not tint title/menu screens before the first real hit.
    style.opacity = '0';
    style.background = 'radial-gradient(ellipse at center, rgba(120,0,0,0) 52%, rgba(150,12,8,0.45) 78%, rgba(190,16,10,0.85) 100%)';
    host.appendChild(element);
    this.element = element;
  }

  /** `strength` in 0..1 at the damage world tick; overlapping hits keep the strongest remaining pulse. */
  pulse(strength: number, worldTick: number): void {
    if (this.disposed) return;
    const remaining = this.level * Math.exp(-Math.max(0, worldTick - this.pulseTick) / DECAY_TICKS);
    this.level = Math.min(1, Math.max(remaining, strength));
    this.pulseTick = worldTick;
  }

  /** Reduced motion keeps the vignette off (no flashing overlays). */
  update(worldTick: number, reducedMotion: boolean): void {
    if (this.disposed) return;
    const value = reducedMotion ? 0 : Math.round(this.level * Math.exp(-Math.max(0, worldTick - this.pulseTick) / DECAY_TICKS) * 100) / 100;
    if (value === this.written) return;
    this.written = value;
    this.element.style.opacity = String(value);
  }

  clear(): void {
    this.level = 0;
    this.written = 0;
    this.element.style.opacity = '0';
  }

  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    this.element.remove();
  }
}
