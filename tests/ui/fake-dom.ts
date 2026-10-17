/**
 * A small DOM stand-in for GameUI tests under Bun. It keeps real element identity, attributes, classes, children and
 * timers (so layer swaps, `inert`, generation tokens and cleanup can be asserted), while markup assigned through
 * `innerHTML` stays a single opaque string: GameUI's staging nodes are only ever moved, never parsed, in these tests.
 * Selectors therefore resolve to null, and clicking inside markup is out of scope (the browser run covers it).
 */
import type { GameViewModel } from '../../src/game/contracts.js';

/** Markup staged through `innerHTML`; it acts as a text node whose value is the markup string. */
class MarkupLeaf {
  readonly leaf = true;
  readonly nodeType = 3;
  constructor(public nodeValue: string) {}
  get markup(): string { return this.nodeValue; }
  remove(): void {}
  replaceWith(): void {}
}
type FakeNode = FakeElement | MarkupLeaf;
const isLeaf = (node: FakeNode): node is MarkupLeaf => 'leaf' in node;

export class FakeElement {
  readonly attributeMap = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly style = { setProperty: (_name: string, _value: string) => undefined };
  children: FakeNode[] = [];
  parent: FakeElement | null = null;
  hidden = false;
  disabled = false;
  textContent = '';
  private classes = new Set<string>();
  readonly classList = {
    add: (...names: string[]) => { for (const name of names) this.classes.add(name); },
    remove: (...names: string[]) => { for (const name of names) this.classes.delete(name); },
    toggle: (name: string, force?: boolean) => {
      const on = force ?? !this.classes.has(name);
      if (on) this.classes.add(name); else this.classes.delete(name);
      return on;
    },
    contains: (name: string) => this.classes.has(name),
  };
  constructor(readonly tagName = 'DIV') {}
  get className(): string { return [...this.classes].join(' '); }
  set className(value: string) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
  get childNodes(): FakeNode[] { return [...this.children]; }
  get attributes(): { name: string; value: string }[] { return [...this.attributeMap].map(([name, value]) => ({ name, value })); }
  set innerHTML(markup: string) { this.children = markup ? [new MarkupLeaf(markup)] : []; }
  get innerHTML(): string {
    return this.children.map(child => isLeaf(child) ? child.markup : child.outerHTML).join('');
  }
  get outerHTML(): string {
    const attributes = [...(this.classes.size ? [`class="${this.className}"`] : []), ...[...this.attributeMap].map(([name, value]) => `${name}="${value}"`), ...(this.hidden ? ['hidden'] : [])];
    return `<${this.tagName.toLowerCase()}${attributes.length ? ' ' + attributes.join(' ') : ''}>${this.innerHTML}</${this.tagName.toLowerCase()}>`;
  }
  setAttribute(name: string, value: string): void { this.attributeMap.set(name, value); }
  getAttribute(name: string): string | null { return this.attributeMap.get(name) ?? null; }
  hasAttribute(name: string): boolean { return this.attributeMap.has(name); }
  removeAttribute(name: string): void { this.attributeMap.delete(name); }
  append(...nodes: FakeNode[]): void {
    for (const node of nodes) {
      if (!isLeaf(node)) { node.remove(); node.parent = this; }
      this.children.push(node);
    }
  }
  replaceChildren(...nodes: FakeNode[]): void {
    for (const child of this.children) if (!isLeaf(child)) child.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
  contains(node: unknown): boolean {
    if (node === this) return true;
    return this.children.some(child => !isLeaf(child) && child.contains(node));
  }
  querySelector(_selector: string): FakeElement | null { return null; }
  querySelectorAll(_selector: string): FakeElement[] { return []; }
  matches(_selector: string): boolean { return false; }
  closest(_selector: string): FakeElement | null { return null; }
  getClientRects(): unknown[] { return []; }
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } { return { left: 0, top: 0, width: 0, height: 0 }; }
  focus(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}
class FakeInput extends FakeElement { type = ''; value = ''; checked = false; }
class FakeSelect extends FakeElement { value = ''; }
class FakeButton extends FakeElement {}

type Listener = (event: Event) => void;
interface Timer { readonly id: number; readonly at: number; readonly callback: () => void }

export interface FakeKeyEvent { key: string; target: null; defaultPrevented: boolean; propagationStopped: boolean; preventDefault(): void; stopImmediatePropagation(): void }

export interface FakeDom {
  /** A mount point for `mountGameUI`. */
  root: FakeElement;
  /** The two screen layers of a mounted UI, front layer first is not guaranteed: read `data-screen`. */
  layersOf(ui: { element: HTMLElement }): FakeElement[];
  /** The live region next to the UI container (`.wc-sr` with role=status). */
  announcerOf(): FakeElement;
  /** Timers that are scheduled and not yet due. */
  pendingTimers(): number;
  /** Advances the fake clock, firing due timers in order. */
  advance(milliseconds: number): void;
  /** Delivers a keydown to the capturing document listeners GameUI registered. */
  key(key: string): FakeKeyEvent;
  /** What `matchMedia('(prefers-reduced-motion: reduce)')` reports. */
  osReducedMotion: boolean;
  restore(): void;
}

/** Installs the fake document/window globals and returns controls; call `restore()` in `afterEach`. */
export function installFakeDom(): FakeDom {
  const saved = {
    document: globalThis.document, window: (globalThis as { window?: unknown }).window, Element: globalThis.Element, HTMLElement: globalThis.HTMLElement,
    HTMLInputElement: globalThis.HTMLInputElement, HTMLSelectElement: globalThis.HTMLSelectElement, HTMLButtonElement: globalThis.HTMLButtonElement,
    MouseEvent: (globalThis as { MouseEvent?: unknown }).MouseEvent,
    requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };
  let now = 0;
  let nextId = 1;
  let timers: Timer[] = [];
  const listeners: Record<string, Listener[]> = {};
  const fake: FakeDom = {
    root: new FakeElement(),
    layersOf: ui => (ui.element as unknown as FakeElement).children.filter((child): child is FakeElement => !isLeaf(child) && child.classList.contains('wc-layer')),
    announcerOf: () => {
      const feedback = fake.root.children.filter((child): child is FakeElement => !isLeaf(child)).find(child => child.classList.contains('wc-ui--feedback'));
      const announcer = feedback?.children.filter((child): child is FakeElement => !isLeaf(child)).find(child => child.getAttribute('aria-live') === 'polite');
      if (!announcer) throw new Error('GameUI did not create its dialogue live region.');
      return announcer;
    },
    pendingTimers: () => timers.length,
    advance: milliseconds => {
      const target = now + milliseconds;
      for (;;) {
        const due = timers.filter(timer => timer.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        timers = timers.filter(timer => timer !== due);
        now = due.at;
        due.callback();
      }
      now = target;
    },
    key: key => {
      const event: FakeKeyEvent = { key, target: null, defaultPrevented: false, propagationStopped: false, preventDefault() { event.defaultPrevented = true; }, stopImmediatePropagation() { event.propagationStopped = true; } };
      for (const listener of listeners.keydown ?? []) listener(event as unknown as Event);
      return event;
    },
    osReducedMotion: false,
    restore: () => {
      Object.assign(globalThis, saved);
      if (saved.window === undefined) delete (globalThis as { window?: unknown }).window;
      if (saved.MouseEvent === undefined) delete (globalThis as { MouseEvent?: unknown }).MouseEvent;
      if (saved.requestAnimationFrame === undefined) delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
      if (saved.cancelAnimationFrame === undefined) delete (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame;
    },
  };
  const doc = {
    hidden: false,
    activeElement: null as FakeElement | null,
    createElement: (tag: string) => new FakeElement(tag.toUpperCase()),
    addEventListener: (type: string, listener: Listener) => { (listeners[type] ??= []).push(listener); },
    removeEventListener: (type: string, listener: Listener) => { listeners[type] = (listeners[type] ?? []).filter(candidate => candidate !== listener); },
  };
  const win = {
    setTimeout: (callback: () => void, milliseconds = 0) => { const id = nextId++; timers.push({ id, at: now + milliseconds, callback }); return id; },
    clearTimeout: (id: number) => { timers = timers.filter(timer => timer.id !== id); },
    matchMedia: (_query: string) => ({ matches: fake.osReducedMotion }),
  };
  Object.assign(globalThis, {
    document: doc, window: win, Element: FakeElement, HTMLElement: FakeElement, HTMLInputElement: FakeInput, HTMLSelectElement: FakeSelect, HTMLButtonElement: FakeButton,
    MouseEvent: class {}, requestAnimationFrame: () => 1, cancelAnimationFrame: () => undefined,
  });
  return fake;
}

/** Strips tags so assertions can read the visible text of staged markup. */
export const textOf = (html: string): string => html.replace(/<[^>]*>/g, '').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

export type { GameViewModel };
