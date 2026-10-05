import { afterEach, describe, expect, it } from 'bun:test';
import { mountGameUI } from '../../src/ui/GameUI.js';
import { DEFAULT_GAME_SETTINGS, type ActorSnapshot, type GameViewModel } from '../../src/game/contracts.js';

class TestElement {
  readonly attributes: Array<{ name: string; value: string }> = [];
  readonly dataset: Record<string, string> = {};
  readonly classList = { toggle: (_name: string, _force?: boolean) => undefined };
  readonly style = { setProperty: (_name: string, _value: string) => undefined };
  get childNodes(): Array<{ markup?: string }> { return this.markup ? [{ markup: this.markup }] : []; }
  className = '';
  textContent = '';
  disabled = false;
  private markup = '';
  set innerHTML(value: string) { this.markup = value; }
  get innerHTML(): string { return this.markup; }
  setAttribute(name: string, value: string): void { this.attributes.push({ name, value }); }
  getAttribute(name: string): string | null { return this.attributes.find(item => item.name === name)?.value ?? null; }
  removeAttribute(name: string): void { const i = this.attributes.findIndex(item => item.name === name); if (i >= 0) this.attributes.splice(i, 1); }
  hasAttribute(name: string): boolean { return this.attributes.some(item => item.name === name); }
  append(_child: TestElement): void {}
  replaceChildren(...children: Array<{ markup?: string }>): void { this.markup = children.map(child => child.markup ?? '').join(''); }
  addEventListener(_type: string, _listener: EventListenerOrEventListenerObject, _options?: boolean | AddEventListenerOptions): void {}
  removeEventListener(_type: string, _listener: EventListenerOrEventListenerObject, _options?: boolean | EventListenerOptions): void {}
  querySelector<T extends TestElement>(_selector: string): T | null { return null; }
  querySelectorAll<T extends TestElement>(_selector: string): T[] { return []; }
  contains(_node: unknown): boolean { return false; }
  getClientRects(): DOMRectList { return [] as unknown as DOMRectList; }
  focus(_options?: FocusOptions): void {}
  remove(): void {}
}
class TestHTMLElement extends TestElement {}
class TestHTMLInputElement extends TestHTMLElement { type = ''; value = ''; checked = false; selectionStart: number | null = null; selectionEnd: number | null = null; selectionDirection: 'forward' | 'backward' | 'none' | null = null; setSelectionRange(): void {} }
class TestHTMLSelectElement extends TestHTMLElement { value = ''; }
class TestHTMLButtonElement extends TestHTMLElement {}
const oldGlobals = { document: globalThis.document, Element: globalThis.Element, HTMLElement: globalThis.HTMLElement, HTMLInputElement: globalThis.HTMLInputElement, HTMLSelectElement: globalThis.HTMLSelectElement, HTMLButtonElement: globalThis.HTMLButtonElement };
afterEach(() => {
  Object.assign(globalThis, oldGlobals);
  delete (globalThis as typeof globalThis & { requestAnimationFrame?: unknown }).requestAnimationFrame;
  delete (globalThis as typeof globalThis & { cancelAnimationFrame?: unknown }).cancelAnimationFrame;
});

function gameModel(exposed: boolean): GameViewModel {
  const target = { id: 'hunter-melee-west', weakPointExposed: exposed } as ActorSnapshot;
  return {
    screen: 'game', loading: { active: false, label: '', progress: null }, error: null, trackedObjectiveId: null,
    canOpenWorldPanels: true,
    hud: { vitality: 100, maxVitality: 100, dodgeCharges: 2, maxDodgeCharges: 2, instinct: 20, boss: undefined, targetId: target.id, target },
    campaign: null, journal: { quests: [], region: null }, map: { currentRegion: null, regions: [] }, party: null, abilities: [], relationships: null,
    settings: { reducedMotion: false, controlGlyphs: 'keyboard' } as GameViewModel['settings'],
    bindings: { keyboard: {}, gamepad: {} }, saves: { slots: [], continueSlotId: null }, dialogue: null, choice: null, ending: null,
  } as GameViewModel;
}

describe('GameUI HUD render cache', () => {
  it('updates WEAK POINT EXPOSED on the mounted UI when only target exposure changes', () => {
    const doc = {
      activeElement: null as TestHTMLElement | null,
      createElement: (_tag: string) => new TestHTMLElement(),
      addEventListener: (_type: string, _listener: EventListenerOrEventListenerObject, _options?: boolean | AddEventListenerOptions) => {},
      removeEventListener: (_type: string, _listener: EventListenerOrEventListenerObject, _options?: boolean | EventListenerOptions) => {},
    };
    Object.assign(globalThis, { document: doc, Element: TestElement, HTMLElement: TestHTMLElement, HTMLInputElement: TestHTMLInputElement, HTMLSelectElement: TestHTMLSelectElement, HTMLButtonElement: TestHTMLButtonElement, requestAnimationFrame: () => 1, cancelAnimationFrame: () => {} });
    const root = new TestHTMLElement();
    const ui = mountGameUI(root as unknown as HTMLElement, { onAction: () => {}, initialViewModel: gameModel(true) });
    expect(ui.element.innerHTML).toContain('WEAK POINT EXPOSED');
    const unchangedHud = gameModel(false);
    ui.render(unchangedHud);
    expect(ui.element.innerHTML).not.toContain('WEAK POINT EXPOSED');
    expect(ui.element.innerHTML).toContain('AREN');
    expect(ui.element.innerHTML).toContain('Vitality 100%');
    ui.destroy();
  });

  it('updates world toolbar availability when only the required capability changes', () => {
    const doc = {
      activeElement: null as TestHTMLElement | null,
      createElement: (_tag: string) => new TestHTMLElement(),
      addEventListener: (_type: string, _listener: EventListenerOrEventListenerObject, _options?: boolean | AddEventListenerOptions) => {},
      removeEventListener: (_type: string, _listener: EventListenerOrEventListenerObject, _options?: boolean | EventListenerOptions) => {},
    };
    Object.assign(globalThis, { document: doc, Element: TestElement, HTMLElement: TestHTMLElement, HTMLInputElement: TestHTMLInputElement, HTMLSelectElement: TestHTMLSelectElement, HTMLButtonElement: TestHTMLButtonElement, requestAnimationFrame: () => 1, cancelAnimationFrame: () => {} });
    const model = { ...gameModel(false), screen: 'settings', settings: { ...DEFAULT_GAME_SETTINGS }, canOpenWorldPanels: false } satisfies GameViewModel;
    const ui = mountGameUI(new TestHTMLElement() as unknown as HTMLElement, { onAction: () => {}, initialViewModel: model });
    for (const action of ['map', 'journal', 'companions']) expect(ui.element.innerHTML).not.toContain(`data-ui-action="${action}"`);
    ui.render({ ...model, canOpenWorldPanels: true });
    for (const action of ['map', 'journal', 'companions']) expect(ui.element.innerHTML).toContain(`data-ui-action="${action}"`);
    ui.render(model);
    for (const action of ['map', 'journal', 'companions']) expect(ui.element.innerHTML).not.toContain(`data-ui-action="${action}"`);
    expect(ui.element.innerHTML).toContain('data-ui-action="settings"');
    ui.destroy();
  });
});
