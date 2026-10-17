import './boss-intro.css';

/** Browser timer handle used by the intro card timing. */
type TimerId = ReturnType<typeof setTimeout>;

/**
 * DOM title card that announces a boss: the boss's name in Barlow Condensed uppercase, an italic Alegreya
 * epithet line below, and a route-colour rule line between them. The card fades in then out over the duration
 * the caller passes; reduced motion holds it static for the same duration. Animation timing lives in `boss-intro.css`.
 *
 *  - `show(name, epithet, durationSeconds)` mounts a single overlay on the supplied host, animates it, and self-disposes.
 *  - `dispose()` removes the overlay immediately. Idempotent.
 *  - aria-live polite: the boss name + epithet are announced to assistive tech on show.
 *  - The simulation is paused by the caller (the chapter encounter path already holds `timePolicy = 'paused'`
 *    while the intro runs); this class never touches the world clock.
 */
export class BossIntro {
  private root: HTMLDivElement | undefined;
  private card: HTMLDivElement | undefined;
  private timeout: TimerId | undefined;
  private disposed = false;

  constructor(private readonly host: HTMLElement) {}

  show(name: string, epithet: string, durationSeconds: number, reducedMotion = false): void {
    if (this.disposed) return;
    const seconds = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0;
    this.dispose();
    const root = document.createElement('div');
    root.className = 'wc-boss-intro';
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');
    if (reducedMotion) root.setAttribute('data-reduced-motion', 'true');
    const card = document.createElement('div');
    card.className = 'wc-boss-intro__card';
    const rule = document.createElement('hr');
    rule.className = 'wc-boss-intro__rule';
    const title = document.createElement('h2');
    title.className = 'wc-boss-intro__name';
    title.textContent = name;
    const ep = document.createElement('p');
    ep.className = 'wc-boss-intro__epithet';
    ep.textContent = epithet;
    card.append(title, rule, ep);
    root.append(card);
    this.host.append(root);
    this.root = root;
    this.card = card;
    // Force the browser to commit the initial state before adding the in-animation class so the keyframe runs.
    void card.offsetWidth;
    card.classList.add('wc-boss-intro__card--in');
    if (seconds > 0) {
      // Hold on screen for `seconds` (reduced motion never animates, so this is the only timing).
      this.timeout = setTimeout(() => {
        if (this.disposed || !this.card) return;
        if (reducedMotion) { this.dispose(); return; }
        this.card.classList.remove('wc-boss-intro__card--in');
        this.card.classList.add('wc-boss-intro__card--out');
        this.timeout = setTimeout(() => { if (!this.disposed) this.dispose(); }, 320);
      }, seconds * 1000);
    }
  }

  dispose(): void {
    if (this.timeout) { clearTimeout(this.timeout); this.timeout = undefined; }
    if (this.card) { this.card.classList.remove('wc-boss-intro__card--in', 'wc-boss-intro__card--out'); }
    if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
    this.card = undefined;
    this.root = undefined;
  }
}