import { afterEach, describe, expect, it } from 'bun:test';
import { mountGameUI } from '../../src/ui/GameUI.js';
import { DEFAULT_GAME_SETTINGS, DEFAULT_INPUT_BINDINGS, type ActorSnapshot, type GameViewModel } from '../../src/game/contracts.js';
import { CombatEngine, createEngineState } from '../../src/game/combat/CombatEngine.js';
import { DIALOGUE } from '../../src/content/dialogue.js';
import { HEROES, type HeroId } from '../../src/game/heroes.js';
import { PLAYER_SKILLS, SIGIL } from '../../src/game/combat/PlayerSkills.js';

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
    hud: { vitality: 100, maxVitality: 100, mana: 100, maxMana: 100, skills: [], instinct: 20, boss: undefined, targetId: target.id, target },
    campaign: null, journal: { quests: [], region: null }, map: { currentRegion: null, regions: [] }, party: null, abilities: [], relationships: null,
    settings: { reducedMotion: false, controlGlyphs: 'keyboard' } as GameViewModel['settings'],
    bindings: { keyboard: {}, gamepad: {} }, saves: { slots: [], continueSlotId: null }, dialogue: null, dialogueLineIndex: 0, choice: null, ending: null,
  } as GameViewModel;
}

function loadingModel(progress: number | null, stage: 'checking-assets' | 'loading-scene-assets'): GameViewModel {
  const base = gameModel(false);
  return {
    ...base,
    screen: 'loading',
    loading: {
      active: true,
      label: 'Loading Greenwake',
      progress,
      operationId: 'region-load',
      detail: {
        stage,
        message: stage === 'loading-scene-assets' && progress !== null ? `Loaded ${Math.round(progress * 100)} percent` : 'Reading the manifest and confirming the forest\'s required native assets.',
      },
    },
  } satisfies GameViewModel;
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

describe('GameUI dialogue line progression', () => {
  it('re-renders the active line when only dialogueLineIndex changes against the same beat', () => {
    const doc = {
      activeElement: null as TestHTMLElement | null,
      createElement: (_tag: string) => new TestHTMLElement(),
      addEventListener: (_type: string, _listener: EventListenerOrEventListenerObject, _options?: boolean | AddEventListenerOptions) => {},
      removeEventListener: (_type: string, _listener: EventListenerOrEventListenerObject, _options?: boolean | AddEventListenerOptions) => {},
    };
    Object.assign(globalThis, { document: doc, Element: TestElement, HTMLElement: TestHTMLElement, HTMLInputElement: TestHTMLInputElement, HTMLSelectElement: TestHTMLSelectElement, HTMLButtonElement: TestHTMLButtonElement, requestAnimationFrame: () => 1, cancelAnimationFrame: () => {} });
    const beat = DIALOGUE['prologue-vision'];
    expect(beat).toBeDefined();
    expect(beat.lines.length).toBeGreaterThanOrEqual(2);
    const firstLine = beat.lines[0];
    const secondLine = beat.lines[1];
    const baseModel = { ...gameModel(false), screen: 'dialogue', dialogue: beat, dialogueLineIndex: 0 } satisfies GameViewModel;
    const root = new TestHTMLElement();
    const ui = mountGameUI(root as unknown as HTMLElement, { onAction: () => {}, initialViewModel: baseModel });
    expect(ui.element.innerHTML).toContain(firstLine.text);
    expect(ui.element.innerHTML).not.toContain(secondLine.text);
    ui.render({ ...baseModel, dialogueLineIndex: 1 });
    expect(ui.element.innerHTML).toContain(secondLine.text);
    expect(ui.element.innerHTML).not.toContain(firstLine.text);
    ui.destroy();
  });
});

describe('GameUI loading progress', () => {
  function mountLoading(progress: number | null, stage: 'checking-assets' | 'loading-scene-assets') {
    const doc = {
      activeElement: null as TestHTMLElement | null,
      createElement: (_tag: string) => new TestHTMLElement(),
      addEventListener: (_type: string, _listener: EventListenerOrEventListenerObject, _options?: boolean | AddEventListenerOptions) => {},
      removeEventListener: (_type: string, _listener: EventListenerOrEventListenerObject, _options?: boolean | AddEventListenerOptions) => {},
    };
    Object.assign(globalThis, { document: doc, Element: TestElement, HTMLElement: TestHTMLElement, HTMLInputElement: TestHTMLInputElement, HTMLSelectElement: TestHTMLSelectElement, HTMLButtonElement: TestHTMLButtonElement, requestAnimationFrame: () => 1, cancelAnimationFrame: () => {} });
    const root = new TestHTMLElement();
    const ui = mountGameUI(root as unknown as HTMLElement, { onAction: () => {}, initialViewModel: loadingModel(progress, stage) });
    return ui;
  }

  it('renders an integer 0 percent when asset checking has not started asset loads', () => {
    const ui = mountLoading(0, 'loading-scene-assets');
    const html = ui.element.innerHTML;
    expect(html).toContain('<div class="wc-progress"');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="100"');
    expect(html).toContain('aria-valuenow="0"');
    expect(html).toContain('aria-valuetext="0 percent loaded"');
    expect(html).toContain('aria-label="Loading progress"');
    expect(html).toContain('<strong>0%</strong>');
    ui.destroy();
  });

  it('renders a non-trivial percentage and accessible aria-valuenow as scene assets load', () => {
    const ui = mountLoading(0.375, 'loading-scene-assets');
    const html = ui.element.innerHTML;
    expect(html).toContain('aria-valuenow="38"');
    expect(html).toContain('aria-valuetext="38 percent loaded"');
    expect(html).toContain('--wc-progress:0.375');
    expect(html).toContain('<strong>38%</strong>');
    expect(html).toContain('Loading scene assets');
    ui.destroy();
  });

  it('reports asset checking stage text before any scene asset progress is reported', () => {
    const ui = mountLoading(null, 'checking-assets');
    const html = ui.element.innerHTML;
    expect(html).toContain('Checking required native assets');
    expect(html).toContain('Preparing</strong>');
    expect(html).not.toContain('role="progressbar"');
    ui.destroy();
  });
});

describe('GameUI skill bar', () => {
  function mountSkills(instinct: number) {
    const doc = {
      activeElement: null as TestHTMLElement | null,
      createElement: (_tag: string) => new TestHTMLElement(),
      addEventListener: (_type: string, _listener: EventListenerOrEventListenerObject, _options?: boolean | AddEventListenerOptions) => {},
      removeEventListener: (_type: string, _listener: EventListenerOrEventListenerObject, _options?: boolean | AddEventListenerOptions) => {},
    };
    Object.assign(globalThis, { document: doc, Element: TestElement, HTMLElement: TestHTMLElement, HTMLInputElement: TestHTMLInputElement, HTMLSelectElement: TestHTMLSelectElement, HTMLButtonElement: TestHTMLButtonElement, requestAnimationFrame: () => 1, cancelAnimationFrame: () => {} });
    const seed = createEngineState();
    seed.player.instinct = instinct;
    const base = gameModel(false);
    const model = { ...base, hud: { ...base.hud, skills: new CombatEngine(seed).snapshot().skills }, bindings: { keyboard: { ...DEFAULT_INPUT_BINDINGS.keyboard }, gamepad: { ...DEFAULT_INPUT_BINDINGS.gamepad } } } satisfies GameViewModel;
    return mountGameUI(new TestHTMLElement() as unknown as HTMLElement, { onAction: () => {}, initialViewModel: model });
  }

  it('shows Sigil Bolt on L with both mana costs and Judgement on U gated by Instinct', () => {
    const ui = mountSkills(20);
    const html = ui.element.innerHTML;
    expect(html).toContain('data-skill="sigil_bolt" data-ready="true"');
    expect(html).toContain('<kbd>L</kbd><span>15 / 35 MP</span></div><strong>Sigil Bolt</strong>');
    expect(html).toContain('data-skill="judgement" data-ready="false"');
    expect(html).toContain('<kbd>U</kbd><span>INSTINCT</span></div><strong>Judgement</strong><small>Need full Instinct</small>');
    expect(html).toContain('<strong>Warden Blade</strong>');
    ui.destroy();
  });

  it('marks Judgement ready once Instinct is full so the stylesheet can glow the tile', () => {
    const ui = mountSkills(100);
    const html = ui.element.innerHTML;
    expect(html).toContain('data-skill="judgement" data-ready="true"');
    expect(html).toContain('<strong>Judgement</strong><small>Ready</small>');
    ui.destroy();
  });
});

describe('GameUI monster vitality', () => {
  function mount(model: GameViewModel) {
    const doc = {
      activeElement: null as TestHTMLElement | null,
      createElement: (_tag: string) => new TestHTMLElement(),
      addEventListener: (_type: string, _listener: EventListenerOrEventListenerObject, _options?: boolean | AddEventListenerOptions) => {},
      removeEventListener: (_type: string, _listener: EventListenerOrEventListenerObject, _options?: boolean | EventListenerOptions) => {},
    };
    Object.assign(globalThis, { document: doc, Element: TestElement, HTMLElement: TestHTMLElement, HTMLInputElement: TestHTMLInputElement, HTMLSelectElement: TestHTMLSelectElement, HTMLButtonElement: TestHTMLButtonElement, requestAnimationFrame: () => 1, cancelAnimationFrame: () => {} });
    return mountGameUI(new TestHTMLElement() as unknown as HTMLElement, { onAction: () => {}, initialViewModel: model });
  }
  const canopyStage = { exitName: 'Temple Exit', completeKicker: 'THE CANOPY OPENS', completeCopy: 'You reached the Whispering Canopy temple exit.' };
  const trialModel = (complete: boolean): GameViewModel => ({
    ...gameModel(false), playtestStage: canopyStage,
    hud: {
      ...gameModel(false).hud,
      encounterStatus: {
        title: complete ? 'Canopy trials cleared' : "Howler's Pool",
        monsters: [
          { id: 'canopy-howler', name: 'Thornback Howler', skills: ['rock hurl', 'leap slam', 'branch sweep'], active: !complete, cleared: complete },
          { id: 'canopy-hornbill', name: 'Storm Hornbill', skills: ['dive bomb', 'feather volley', 'gale flap'], active: false, cleared: complete },
          { id: 'canopy-mire-viper', name: 'Mire Viper', skills: ['venom spit', 'tail lash', 'strike lunge'], active: false, cleared: complete },
        ],
        trial: { stage: complete ? 3 : 1, totalStages: 3, status: complete ? 'complete' : 'fighting', complete, boss: false, level: 0 },
      },
    },
  });

  it('updates changing HP, clamps damaged/overfilled values and hides unknown vitality instead of inventing a full bar', () => {
    const healthModel = (vitality: number | undefined, maxVitality: number | undefined): GameViewModel => {
      const model = trialModel(false), encounter = model.hud.encounterStatus!;
      return { ...model, hud: { ...model.hud, encounterStatus: { ...encounter, monsters: [{ ...encounter.monsters[0]!, vitality, maxVitality }] } } };
    };
    const ui = mount(healthModel(17.2, 100));
    expect(ui.element.innerHTML).toContain('<progress value="17.2" max="100"');
    expect(ui.element.innerHTML).toContain('18 / 100');
    ui.render(healthModel(-5, 100));
    expect(ui.element.innerHTML).toContain('<progress value="0" max="100"');
    ui.render(healthModel(205, 100));
    expect(ui.element.innerHTML).toContain('<progress value="100" max="100"');
    for (const [value, maximum] of [[undefined, 100], [20, undefined], [20, 0], [NaN, 100]] as const) {
      ui.render(healthModel(value, maximum));
      expect(ui.element.innerHTML).not.toContain('wc-enemy-vitality');
    }
    ui.destroy();
  });

});

describe('GameUI with four heroes', () => {
  function mount(model: GameViewModel) {
    const doc = {
      activeElement: null as TestHTMLElement | null,
      createElement: (_tag: string) => new TestHTMLElement(),
      addEventListener: (_type: string, _listener: EventListenerOrEventListenerObject, _options?: boolean | AddEventListenerOptions) => {},
      removeEventListener: (_type: string, _listener: EventListenerOrEventListenerObject, _options?: boolean | EventListenerOptions) => {},
    };
    Object.assign(globalThis, { document: doc, Element: TestElement, HTMLElement: TestHTMLElement, HTMLInputElement: TestHTMLInputElement, HTMLSelectElement: TestHTMLSelectElement, HTMLButtonElement: TestHTMLButtonElement, requestAnimationFrame: () => 1, cancelAnimationFrame: () => {} });
    return mountGameUI(new TestHTMLElement() as unknown as HTMLElement, { onAction: () => {}, initialViewModel: model });
  }
  const bindings = { keyboard: { ...DEFAULT_INPUT_BINDINGS.keyboard }, gamepad: { ...DEFAULT_INPUT_BINDINGS.gamepad } };
  const hudModel = (heroId: HeroId): GameViewModel => {
    const base = gameModel(false), seed = createEngineState();
    seed.player.instinct = 100;
    return { ...base, bindings, hud: { ...base.hud, heroId, skills: new CombatEngine(seed).snapshot().skills } };
  };
  const withTrial = (model: GameViewModel, boss: boolean, monsterBoss?: boolean): GameViewModel => ({
    ...model,
    hud: {
      ...model.hud,
      encounterStatus: {
        title: 'Final trial',
        monsters: [{ id: 'canopy-howler', name: 'Thornback Howler', skills: ['rock hurl'], active: true, cleared: false, vitality: 300, maxVitality: 385, ...(monsterBoss === undefined ? {} : { boss: monsterBoss }) }],
        trial: { stage: 3, totalStages: 3, status: 'fighting', complete: false, boss, level: 5 },
      },
    },
  });

  it('lists the four heroes in the select roster and focuses the first', () => {
    const base = gameModel(false);
    const model = {
      ...base, screen: 'hero-select', bindings,
      playtestSelection: { selectedMapId: 'greenwake', heroId: 'aren', maps: [{ id: 'greenwake', label: 'I', name: 'Greenwake', setting: 'Forest', thumbnailUrl: null, monsters: [], comingSoon: false, unlocked: true, cleared: false }] },
    } as GameViewModel;
    const ui = mount(model);
    const html = ui.element.innerHTML;
    expect(HEROES.map(hero => hero.id)).toEqual(['aren', 'yara', 'vesper', 'sakda']);
    expect(html.match(/data-ui-action="hero-focus"/g)).toHaveLength(HEROES.length);
    for (const hero of HEROES) {
      expect(html).toContain(`data-hero="${hero.id}" data-focus-key="hero-focus-${hero.id}"`);
      expect(html).toContain(`--wc-hero-accent:${hero.accent}`);
    }
    expect(html).toContain(`aria-pressed="true" style="--wc-hero-accent:${HEROES[0]!.accent}"`);
    ui.destroy();
  });

  for (const hero of HEROES) {
    it(`${hero.name}: HUD names the hero, its dodge label and the shared skill costs`, () => {
      const ui = mount(hudModel(hero.id));
      const html = ui.element.innerHTML;
      expect(html).toContain(`data-hero="${hero.id}"`);
      expect(html).toContain(hero.name.toUpperCase());
      expect(html).toContain(hero.dodgeLabel);
      expect(html).toContain(`${PLAYER_SKILLS.heavy.manaCost} / ${PLAYER_SKILLS.charged_heavy.manaCost} MP`);
      expect(html).toContain(`${SIGIL.boltMana} / ${SIGIL.barrageMana} MP`);
      expect(html).toContain('<span>INSTINCT</span>');
      expect(html).toContain('data-skill="judgement" data-ready="true"');
      ui.destroy();
    });
  }

  it('shows the Boss chip and the larger boss bar only for a boss trial stage or a boss monster entry', () => {
    const regular = mount(withTrial(hudModel('aren'), false));
    expect(regular.element.innerHTML).not.toContain('wc-boss-chip');
    expect(regular.element.innerHTML).toContain('data-boss="false"');
    regular.destroy();
    const bossStage = mount(withTrial(hudModel('vesper'), true));
    expect(bossStage.element.innerHTML).toContain('<span class="wc-boss-chip">Boss</span>');
    expect(bossStage.element.innerHTML).toContain('<div class="wc-enemy-vitality" data-boss="true">');
    bossStage.destroy();
    const bossMonster = mount(withTrial(hudModel('sakda'), false, true));
    expect(bossMonster.element.innerHTML).toContain('wc-boss-chip');
    bossMonster.destroy();
  });

  it('re-renders the encounter panel when only the boss flag changes', () => {
    const ui = mount(withTrial(hudModel('aren'), false));
    expect(ui.element.innerHTML).not.toContain('wc-boss-chip');
    ui.render(withTrial(hudModel('aren'), true));
    expect(ui.element.innerHTML).toContain('wc-boss-chip');
    ui.render(withTrial(hudModel('aren'), false));
    expect(ui.element.innerHTML).not.toContain('wc-boss-chip');
    ui.destroy();
  });
});
