import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'bun:test';
import { mountGameUI, type GameUIInstance } from '../../src/ui/GameUI.js';
import { DEFAULT_GAME_SETTINGS, DEFAULT_INPUT_BINDINGS, type ActorSnapshot, type AssetManifestEntry, type GameViewModel, type UIAction } from '../../src/game/contracts.js';
import { CombatEngine, createEngineState } from '../../src/game/combat/CombatEngine.js';
import { DIALOGUE } from '../../src/content/dialogue.js';
import { REGION_PRESENTATION } from '../../src/content/regionPresentation.js';
import { HEROES, type HeroId } from '../../src/game/heroes.js';
import { PLAYER_SKILLS, SIGIL } from '../../src/game/combat/PlayerSkills.js';
import { settingsMarkup } from '../../src/ui/settings.js';
import { mountTitleStage } from '../../src/rendering/TitleStage.js';
import { installFakeDom, textOf, type FakeDom, FakeElement } from './fake-dom.js';

let dom: FakeDom | undefined;
afterEach(() => { dom?.restore(); dom = undefined; });

const bindings = { keyboard: { ...DEFAULT_INPUT_BINDINGS.keyboard }, gamepad: { ...DEFAULT_INPUT_BINDINGS.gamepad } };

function gameModel(exposed: boolean): GameViewModel {
  const target = { id: 'hunter-melee-west', weakPointExposed: exposed } as ActorSnapshot;
  return {
    screen: 'game', loading: { active: false, label: '', progress: null }, error: null, trackedObjectiveId: null,
    canOpenWorldPanels: true,
    hud: { vitality: 100, maxVitality: 100, mana: 100, maxMana: 100, skills: [], instinct: 20, boss: undefined, targetId: target.id, target },
    campaign: null, journal: { quests: [], region: null }, map: { currentRegion: null, regions: [] }, party: null, abilities: [], relationships: null,
    settings: { ...DEFAULT_GAME_SETTINGS }, bindings,
    saves: { slots: [], continueSlotId: null }, dialogue: null, dialogueLineIndex: 0, choice: null, ending: null,
  } as GameViewModel;
}
const screenModel = (screen: GameViewModel['screen'], extra: Partial<GameViewModel> = {}): GameViewModel => ({ ...gameModel(false), screen, ...extra });
const withSettings = (model: GameViewModel, settings: Partial<GameViewModel['settings']>): GameViewModel => ({ ...model, settings: { ...model.settings, ...settings } });

function loadingModel(progress: number | null, extra: Partial<GameViewModel['loading']> = {}): GameViewModel {
  return {
    ...gameModel(false), screen: 'loading',
    scene: { regionId: 'canopy', heroName: null, establishingShot: false },
    loading: { active: true, label: 'Loading Whispering Canopy', progress, operationId: 'region-load', detail: { stage: 'assets', phaseLabel: 'Gathering scene assets', message: 'Loaded 3 of 8 scene assets' }, ...extra },
  };
}
const playtestSelection: GameViewModel['playtestSelection'] = {
  selectedMapId: 'canopy', heroId: 'aren',
  maps: [{ id: 'canopy', label: 'Chapter 1', name: 'Whispering Canopy', setting: 'Canopy', thumbnailUrl: null, monsters: [], comingSoon: false, unlocked: true, cleared: false }],
};

function mount(model: GameViewModel): { ui: GameUIInstance; actions: UIAction[]; dom: FakeDom } {
  dom = installFakeDom();
  const actions: UIAction[] = [];
  const ui = mountGameUI(dom.root as unknown as HTMLElement, { onAction: action => actions.push(action), initialViewModel: model });
  return { ui, actions, dom };
}
const layersOf = (ui: GameUIInstance): FakeElement[] => dom!.layersOf(ui);
const frontOf = (ui: GameUIInstance): FakeElement => layersOf(ui).find(layer => layer.classList.contains('wc-layer--front'))!;
const htmlOf = (ui: GameUIInstance): string => frontOf(ui).innerHTML;

describe('GameUI HUD render cache', () => {
  it('updates WEAK POINT EXPOSED on the mounted UI when only target exposure changes', () => {
    const { ui } = mount(gameModel(true));
    expect(htmlOf(ui)).toContain('WEAK POINT EXPOSED');
    ui.render(gameModel(false));
    expect(htmlOf(ui)).not.toContain('WEAK POINT EXPOSED');
    expect(htmlOf(ui)).toContain('AREN');
    expect(htmlOf(ui)).toContain('Vitality 100%');
    ui.destroy();
  });

  it('updates world toolbar availability when only the required capability changes', () => {
    const model = screenModel('settings', { canOpenWorldPanels: false });
    const { ui } = mount(model);
    for (const action of ['map', 'journal', 'companions']) expect(htmlOf(ui)).not.toContain(`data-ui-action="${action}"`);
    ui.render({ ...model, canOpenWorldPanels: true });
    for (const action of ['map', 'journal', 'companions']) expect(htmlOf(ui)).toContain(`data-ui-action="${action}"`);
    ui.render(model);
    for (const action of ['map', 'journal', 'companions']) expect(htmlOf(ui)).not.toContain(`data-ui-action="${action}"`);
    expect(htmlOf(ui)).toContain('data-ui-action="settings"');
    ui.destroy();
  });
});

describe('GameUI dialogue', () => {
  const beat = DIALOGUE['prologue-vision'];
  const dialogueModel = (index: number): GameViewModel => screenModel('dialogue', { dialogue: beat, dialogueLineIndex: index });

  it('re-renders the active line when only dialogueLineIndex changes against the same beat', () => {
    expect(beat.lines.length).toBeGreaterThanOrEqual(2);
    const { ui } = mount(dialogueModel(0));
    expect(textOf(htmlOf(ui))).toContain(textOf(beat.lines[0]!.text));
    expect(textOf(htmlOf(ui))).not.toContain(textOf(beat.lines[1]!.text));
    ui.render(dialogueModel(1));
    expect(textOf(htmlOf(ui))).toContain(textOf(beat.lines[1]!.text));
    expect(textOf(htmlOf(ui))).not.toContain(textOf(beat.lines[0]!.text));
    ui.destroy();
  });

  it('announces each line once through a live region that outlives the layers, and clears it when the dialogue ends', () => {
    const { ui, dom: fake } = mount(dialogueModel(0));
    expect(fake.announcerOf().getAttribute('aria-live')).toBe('polite');
    expect(fake.announcerOf().textContent).toContain(textOf(beat.lines[0]!.text));
    ui.render(dialogueModel(1));
    expect(fake.announcerOf().textContent).toContain(textOf(beat.lines[1]!.text));
    ui.render(gameModel(false));
    expect(fake.announcerOf().textContent).toBe('');
    ui.destroy();
  });

  it('fades text in by word groups and plain text when motion is reduced', () => {
    const animated = mount(dialogueModel(0));
    expect(htmlOf(animated.ui)).toContain('class="wc-wg"');
    animated.ui.destroy();
    const reduced = mount(withSettings(dialogueModel(0), { reducedMotion: true }));
    expect(htmlOf(reduced.ui)).not.toContain('wc-wg');
    expect(textOf(htmlOf(reduced.ui))).toContain(textOf(beat.lines[0]!.text));
    reduced.ui.destroy();
  });

  it('honours subtitle size, background and speaker-label settings', () => {
    const styled = mount(withSettings(dialogueModel(0), { subtitleSize: 'large', subtitleBackground: 'solid', subtitleSpeakerLabels: false }));
    expect(htmlOf(styled.ui)).toContain('data-size="large"');
    expect(htmlOf(styled.ui)).toContain('data-background="solid"');
    expect(htmlOf(styled.ui)).not.toContain('wc-dialogue__name');
    styled.ui.destroy();
    const labelled = mount(withSettings(dialogueModel(0), { subtitleSize: 'small', subtitleBackground: 'off', subtitleSpeakerLabels: true }));
    expect(htmlOf(labelled.ui)).toContain('data-size="small"');
    expect(htmlOf(labelled.ui)).toContain('data-background="off"');
    expect(htmlOf(labelled.ui)).toContain('wc-dialogue__name');
    labelled.ui.destroy();
  });
});

describe('GameUI loading scene', () => {
  it('renders the selected region scene with an integer 0 percent bar before any asset has loaded', () => {
    const { ui } = mount(loadingModel(0));
    const html = htmlOf(ui);
    expect(html).toContain('data-region="canopy"');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="100"');
    expect(html).toContain('aria-valuenow="0"');
    expect(html).toContain('aria-valuetext="0 percent loaded"');
    expect(html).toContain('aria-label="Loading progress"');
    expect(html).toContain('Gathering scene assets');
    expect(html).toContain('Loaded 3 of 8 scene assets');
    expect(html).toContain('Loading Whispering Canopy');
    ui.destroy();
  });

  it('reports a non-trivial percentage and exposes the exact ratio to the scene', () => {
    const { ui } = mount(loadingModel(0.375));
    expect(htmlOf(ui)).toContain('aria-valuenow="38"');
    expect(htmlOf(ui)).toContain('aria-valuetext="38 percent loaded"');
    expect(htmlOf(ui)).toContain('--p:0.375');
    ui.destroy();
  });

  it('is indeterminate while the amount of work is unknown', () => {
    const { ui } = mount(loadingModel(null, { detail: { stage: 'manifest', phaseLabel: 'Checking required native assets' } }));
    expect(htmlOf(ui)).toContain('Checking required native assets');
    expect(htmlOf(ui)).toContain('is-indeterminate');
    expect(htmlOf(ui)).not.toContain('aria-valuenow');
    ui.destroy();
  });

  it('rotates the lore line with real progress and nothing else', () => {
    const loreAt = (progress: number) => {
      const { ui } = mount(loadingModel(progress));
      const lore = REGION_PRESENTATION.canopy.loadingLore.find(line => textOf(htmlOf(ui)).includes(textOf(line)));
      ui.destroy();
      dom!.restore();
      return lore;
    };
    const early = loreAt(0), again = loreAt(0), late = loreAt(0.99);
    expect(early).toBeDefined();
    expect(again).toBe(early);
    expect(late).toBeDefined();
    expect(late).not.toBe(early);
  });

  it('patches progress in place: same layer, same scene, no new transition timers', () => {
    const { ui, dom: fake } = mount(loadingModel(0.1));
    const layer = frontOf(ui);
    fake.advance(5000);
    expect(fake.pendingTimers()).toBe(0);
    ui.render(loadingModel(0.5));
    expect(frontOf(ui)).toBe(layer);
    expect(htmlOf(ui)).toContain('aria-valuenow="50"');
    expect(htmlOf(ui)).not.toContain('aria-valuenow="10"');
    expect(fake.pendingTimers()).toBe(0);
    ui.destroy();
  });

  it('puts the error and its actions inside the scene action slot, without saves in a playtest', () => {
    const model: GameViewModel = {
      ...loadingModel(null, { active: false, label: 'Operation failed', detail: undefined }),
      playtestSelection,
      campaign: {} as GameViewModel['campaign'],
      error: { code: 'application', message: 'Boom <b>', recoverable: true },
    };
    const { ui } = mount(model);
    const html = htmlOf(ui);
    expect(html).toMatch(/data-scene-actions[^>]*>.*wc-error.*Boom &lt;b&gt;.*data-ui-action="retry-load"/);
    expect(html).toContain('data-ui-action="return-title"');
    expect(html).not.toContain('data-ui-action="save-screen"');
    expect(html).not.toContain('data-ui-action="load-screen"');
    ui.destroy();
    const campaignRun = mount({ ...model, playtestSelection: undefined });
    expect(htmlOf(campaignRun.ui)).toContain('data-ui-action="save-screen"');
    expect(htmlOf(campaignRun.ui)).toContain('data-ui-action="load-screen"');
    campaignRun.ui.destroy();
  });
});

describe('GameUI screen transitions', () => {
  const titleModel = () => screenModel('title');
  const mapSelectModel = () => screenModel('map-select', { playtestSelection });

  it('plays exit → swap → enter: the old layer turns inert and leaves, the new layer takes the front and enters', () => {
    const { ui, dom: fake } = mount(titleModel());
    const title = frontOf(ui);
    expect(title.getAttribute('data-screen')).toBe('title');
    expect(title.classList.contains('wc-enter')).toBe(true);
    expect(title.getAttribute('data-from')).toBe('none');
    ui.render(mapSelectModel());
    const mapSelect = frontOf(ui);
    expect(mapSelect).not.toBe(title);
    expect(mapSelect.getAttribute('data-screen')).toBe('map-select');
    expect(mapSelect.getAttribute('data-from')).toBe('title');
    expect(mapSelect.classList.contains('wc-enter')).toBe(true);
    expect(mapSelect.hasAttribute('inert')).toBe(false);
    expect(title.hasAttribute('inert')).toBe(true);
    expect(title.getAttribute('aria-hidden')).toBe('true');
    expect(title.classList.contains('wc-leave')).toBe(true);
    expect(title.classList.contains('wc-layer--front')).toBe(false);
    expect(title.innerHTML).toContain('wc-title__letter');
    // Exit ends within 220 ms (+ slack); the entrance class outlives the staggered content, then goes.
    fake.advance(260);
    expect(title.hidden).toBe(true);
    expect(title.innerHTML).toBe('');
    expect(title.className).toBe('wc-layer');
    expect(title.hasAttribute('inert')).toBe(false);
    expect(mapSelect.classList.contains('wc-enter')).toBe(true);
    fake.advance(2500);
    expect(mapSelect.classList.contains('wc-enter')).toBe(false);
    expect(fake.pendingTimers()).toBe(0);
    ui.destroy();
  });

  it('cancels a superseded transition: its ghost is dropped at once and its timers never touch the newer screen', () => {
    const { ui, dom: fake } = mount(titleModel());
    const [first, second] = layersOf(ui);
    ui.render(mapSelectModel());
    ui.render(screenModel('settings'));
    const settings = frontOf(ui);
    expect(settings.getAttribute('data-screen')).toBe('settings');
    // The layer that still held the title ghost was retired and reused for the newest screen.
    const leaving = layersOf(ui).find(layer => layer !== settings)!;
    expect(leaving.getAttribute('data-screen')).toBe('map-select');
    expect(leaving.classList.contains('wc-leave')).toBe(true);
    expect(leaving.hasAttribute('inert')).toBe(true);
    expect([first, second]).toContain(settings);
    // Only the newest swap's two timers remain: the older swaps' timers were cancelled.
    expect(fake.pendingTimers()).toBe(2);
    fake.advance(300);
    expect(leaving.hidden).toBe(true);
    expect(settings.innerHTML).toContain('wc-settings-columns');
    expect(settings.hidden).toBe(false);
    fake.advance(5000);
    expect(settings.classList.contains('wc-enter')).toBe(false);
    expect(settings.getAttribute('data-screen')).toBe('settings');
    expect(fake.pendingTimers()).toBe(0);
    ui.destroy();
  });

  it('does not replay entrances for same-screen re-renders', () => {
    const { ui, dom: fake } = mount(gameModel(false));
    fake.advance(5000);
    const hud = frontOf(ui);
    expect(fake.pendingTimers()).toBe(0);
    const changed = gameModel(false);
    ui.render({ ...changed, hud: { ...changed.hud, vitality: 40 } });
    expect(frontOf(ui)).toBe(hud);
    expect(hud.classList.contains('wc-enter')).toBe(false);
    expect(hud.classList.contains('wc-leave')).toBe(false);
    expect(hud.innerHTML).toContain('Vitality 40%');
    expect(fake.pendingTimers()).toBe(0);
    expect(layersOf(ui).filter(layer => !layer.hidden)).toHaveLength(1);
    ui.destroy();
  });

  it('gives the gameplay HUD a fade-only motion and panels an overlay motion', () => {
    const { ui } = mount(loadingModel(1));
    ui.render(gameModel(false));
    expect(frontOf(ui).getAttribute('data-motion')).toBe('hud');
    expect(frontOf(ui).getAttribute('data-from')).toBe('loading');
    const hud = frontOf(ui);
    ui.render(screenModel('pause'));
    expect(frontOf(ui).getAttribute('data-motion')).toBe('overlay');
    expect(hud.getAttribute('data-motion')).toBe('hud');
    expect(hud.classList.contains('wc-leave')).toBe(true);
    ui.destroy();
  });

  it('swaps instantly with a one-frame cross-fade when reduced motion is set', () => {
    const { ui, dom: fake } = mount(withSettings(titleModel(), { reducedMotion: true }));
    expect(ui.element.classList.contains('wc-reduced-motion')).toBe(true);
    const title = frontOf(ui);
    expect(title.classList.contains('wc-enter')).toBe(false);
    expect(title.classList.contains('wc-crossfade')).toBe(true);
    ui.render(withSettings(mapSelectModel(), { reducedMotion: true }));
    const mapSelect = frontOf(ui);
    expect(title.hidden).toBe(true);
    expect(title.innerHTML).toBe('');
    expect(title.hasAttribute('inert')).toBe(false);
    expect(layersOf(ui).filter(layer => layer.classList.contains('wc-leave'))).toHaveLength(0);
    expect(mapSelect.classList.contains('wc-crossfade')).toBe(true);
    expect(mapSelect.classList.contains('wc-enter')).toBe(false);
    fake.advance(60);
    expect(mapSelect.classList.contains('wc-crossfade')).toBe(false);
    ui.destroy();
  });

  it('follows the operating-system reduced-motion preference too', () => {
    dom = installFakeDom();
    dom.osReducedMotion = true;
    const ui = mountGameUI(dom.root as unknown as HTMLElement, { onAction: () => undefined, initialViewModel: titleModel() });
    expect(ui.element.classList.contains('wc-reduced-motion')).toBe(true);
    expect(frontOf(ui).classList.contains('wc-crossfade')).toBe(true);
    ui.destroy();
  });
});

describe('GameUI map intro and establishing shot', () => {
  const introModel = (progress: number): GameViewModel => screenModel('map-intro', {
    scene: { regionId: 'canopy', heroName: 'Aren', establishingShot: false },
    loading: { active: true, label: 'Loading Whispering Canopy', progress, operationId: 'region-load' },
  });
  const shotModel = (active: boolean): GameViewModel => screenModel('game', { canOpenWorldPanels: !active, scene: active ? { regionId: 'canopy', heroName: 'Aren', establishingShot: true } : undefined });

  it('shows the region intro while the world loads, and keeps it through progress updates', () => {
    const { ui, dom: fake } = mount(introModel(0.2));
    const intro = frontOf(ui);
    expect(intro.getAttribute('data-screen')).toBe('map-intro');
    expect(intro.innerHTML).toContain('data-region="canopy"');
    expect(intro.innerHTML).toContain('data-ui-action="intro-continue"');
    expect(intro.innerHTML).toContain('data-focus-key="intro-continue"');
    expect(intro.innerHTML).toContain('data-ui-action="intro-skip"');
    expect(intro.innerHTML).toContain('Aren enters Whispering Canopy');
    fake.advance(5000);
    ui.render(introModel(0.9));
    ui.render({ ...introModel(1), loading: { active: false, label: '', progress: null } });
    expect(frontOf(ui)).toBe(intro);
    expect(fake.pendingTimers()).toBe(0);
    ui.destroy();
  });

  it('Enter, Space, Esc leave the intro; other keys do not', () => {
    const { ui, actions, dom: fake } = mount(introModel(0.2));
    for (const key of ['Enter', ' ', 'Escape']) expect(fake.key(key).defaultPrevented).toBe(true);
    expect(actions).toEqual([{ type: 'leave-map-intro' }, { type: 'leave-map-intro' }, { type: 'leave-map-intro' }]);
    actions.length = 0;
    expect(fake.key('x').defaultPrevented).toBe(false);
    expect(actions).toEqual([]);
    ui.destroy();
  });

  it('renders a letterboxed region title with a Skip hint during the shot, then fades the HUD in', () => {
    const { ui } = mount(shotModel(true));
    const shot = frontOf(ui);
    expect(shot.getAttribute('data-screen')).toBe('shot');
    expect(shot.innerHTML).toContain('wc-shot__bar--top');
    expect(shot.innerHTML).toContain('wc-shot__bar--bottom');
    expect(shot.innerHTML).toContain(REGION_PRESENTATION.canopy.title);
    expect(shot.innerHTML).toContain('data-ui-action="skip-establishing"');
    expect(shot.innerHTML).toContain('<kbd>Space</kbd> Skip');
    expect(shot.innerHTML).not.toContain('wc-hud');
    ui.render(shotModel(false));
    const hud = frontOf(ui);
    expect(hud.getAttribute('data-screen')).toBe('game');
    expect(hud.getAttribute('data-motion')).toBe('hud');
    expect(hud.getAttribute('data-from')).toBe('shot');
    expect(hud.innerHTML).toContain('wc-hud');
    expect(shot.hasAttribute('inert')).toBe(true);
    ui.destroy();
  });

  it('skips the shot with Esc, Enter or Space and ignores every other key, including Pause', () => {
    const { ui, actions, dom: fake } = mount(shotModel(true));
    for (const key of ['Escape', 'Enter', ' ']) expect(fake.key(key).defaultPrevented).toBe(true);
    expect(actions).toEqual(Array.from({ length: 3 }, () => ({ type: 'skip-establishing-shot' })));
    actions.length = 0;
    for (const key of ['w', 'j', 'm']) fake.key(key);
    expect(actions).toEqual([]);
    ui.destroy();
  });

  it('skips the shot from the gamepad (A, B, Start) and polls without acting while nothing changes', () => {
    const { ui, actions } = mount(shotModel(true));
    const pad = (pressed: number[]) => ({ connected: true, buttons: Array.from({ length: 16 }, (_, index) => ({ pressed: pressed.includes(index) })) }) as unknown as Gamepad;
    ui.updateGamepad(pad([]));
    ui.updateGamepad(pad([0]));
    expect(actions).toEqual([{ type: 'skip-establishing-shot' }]);
    ui.updateGamepad(pad([0]));
    ui.updateGamepad(pad([0]));
    expect(actions).toHaveLength(1);
    ui.destroy();
  });
});

describe('GameUI rough edges', () => {
  it('stops the Pause key from also reaching gameplay input, so resuming cannot pause again', () => {
    const { ui, actions, dom: fake } = mount(gameModel(false));
    expect(fake.key('Escape').propagationStopped).toBe(true);
    expect(actions).toEqual([{ type: 'pause' }]);
    actions.length = 0;
    ui.render(screenModel('pause'));
    expect(fake.key('Escape').propagationStopped).toBe(true);
    expect(actions).toEqual([{ type: 'resume' }]);
    actions.length = 0;
    ui.render(screenModel('map'));
    expect(fake.key('Escape').propagationStopped).toBe(true);
    expect(actions).toEqual([{ type: 'close-screen' }]);
    ui.destroy();
  });

  it('disables Save and Load in the pause menu of a playtest and says why', () => {
    const playtest = mount(screenModel('pause', { playtestSelection }));
    const html = htmlOf(playtest.ui);
    expect(html).toMatch(/data-ui-action="save-screen"[^>]*disabled aria-describedby="wc-pause-saves"/);
    expect(html).toMatch(/data-ui-action="load-screen"[^>]*disabled aria-describedby="wc-pause-saves"/);
    expect(html).toContain('id="wc-pause-saves"');
    expect(textOf(html)).toContain('do not write campaign saves');
    playtest.ui.destroy();
    const campaign = mount(screenModel('pause'));
    expect(htmlOf(campaign.ui)).not.toContain('wc-pause-saves');
    expect(htmlOf(campaign.ui)).not.toMatch(/data-ui-action="save-screen"[^>]*disabled/);
    campaign.ui.destroy();
  });

  it('names every settings switch by its setting and shows its state', () => {
    const html = settingsMarkup(screenModel('settings'));
    const toggles = html.match(/<button[^>]*data-ui-action="toggle-setting"[^>]*>/g) ?? [];
    expect(toggles).toHaveLength(7);
    for (const toggle of toggles) {
      const id = /data-setting="(\w+)"/.exec(toggle)![1]!;
      expect(toggle).toContain('role="switch"');
      expect(toggle).toMatch(/aria-checked="(true|false)"/);
      expect(toggle).toContain(`aria-labelledby="wc-setting-${id}-label wc-setting-${id}"`);
      expect(html).toMatch(new RegExp(`<span id="wc-setting-${id}-label">[^<]+</span>`));
    }
  });

  it('shows the title with letter-by-letter crest markup and an accessible name', () => {
    const { ui } = mount(screenModel('title'));
    expect(htmlOf(ui)).toContain('aria-label="Wild Crown"');
    expect(htmlOf(ui).match(/wc-title__letter/g)).toHaveLength(9);
    ui.destroy();
  });

  it('exposes the 3D title stage host on the title screen and keeps the focusable action order', () => {
    const { ui } = mount(screenModel('title'));
    const html = htmlOf(ui);
    // The host sits behind the title card; it carries its own state dataset so CSS can cross-fade the canvas in.
    expect(html).toContain('data-title-stage="true"');
    expect(html).toContain('data-title-stage-state="loading"');
    expect(html).toContain('data-title-stage-placeholder');
    // The keyboard focus order hasn't changed: New Game still leads, Continue/Settings/Credits follow the same sequence.
    const order = ['new-game', 'continue', 'load-screen', 'settings', 'credits'];
    let cursor = 0;
    for (const action of order) {
      const index = html.indexOf(`data-ui-action="${action}"`);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeGreaterThanOrEqual(cursor);
      cursor = index;
    }
    ui.destroy();
  });

  it('keeps the title diorama hidden when the production manifest offers no usable assets, so the painted fallback image stays visible', async () => {
    dom = installFakeDom();
    // Build a host element that mirrors the title markup: the diorama host carries the placeholder child.
    const placeholder = new FakeElement('DIV');
    placeholder.setAttribute('data-title-stage-placeholder', '');
    const host = new FakeElement('DIV');
    host.setAttribute('data-title-stage', 'true');
    host.setAttribute('data-title-stage-state', 'loading');
    host.append(placeholder);
    // Production manifest: every entry is blocked (runtimeUrl: null) so the diorama has nothing to compose with.
    const productionManifest: AssetManifestEntry[] = [
      { id: 'actor-aren', sourceType: 'native-glb', kind: 'character', runtimeUrl: null, lodIds: [], requiredActionIds: [], actionToClipMapping: {} },
      { id: 'actor-vara', sourceType: 'native-glb', kind: 'character', runtimeUrl: null, lodIds: [], requiredActionIds: [], actionToClipMapping: {} },
      { id: 'prop-erya-edge-tree', sourceType: 'native-glb', kind: 'prop', runtimeUrl: null, lodIds: [], requiredActionIds: [], actionToClipMapping: {} },
    ];
    const handle = mountTitleStage(host as unknown as HTMLElement, { assets: productionManifest, reducedMotion: false });
    // The early-return path flips the dataset to 'error' so the CSS keeps the host at opacity 0 and the painted
    // fallback image (`.wc-title::before`) stays visible. The fake DOM keeps `dataset` and `attributeMap` separate,
    // so we read the dataset directly.
    expect(host.dataset.titleStageState).toBe('error');
    // No canvas was appended because the renderer was never constructed.
    const canvas = host.children.find(child => child instanceof FakeElement && child.tagName === 'CANVAS');
    expect(canvas).toBeUndefined();
    // The handle is a safe no-op so the application's per-frame tick never touches a disposed renderer.
    expect(() => handle.stage.update(0.016)).not.toThrow();
    expect(() => handle.dispose()).not.toThrow();
    await handle.ready;
  });
});

describe('GameUI skill bar', () => {
  function mountSkills(instinct: number) {
    const seed = createEngineState();
    seed.player.instinct = instinct;
    const base = gameModel(false);
    return mount({ ...base, hud: { ...base.hud, skills: new CombatEngine(seed).snapshot().skills } });
  }

  it('shows Sigil Bolt on L with both mana costs and Judgement on U gated by Instinct', () => {
    const { ui } = mountSkills(20);
    const html = htmlOf(ui);
    expect(html).toContain('data-skill="sigil_bolt" data-ready="true"');
    expect(html).toContain('<kbd>L</kbd><span>15 / 35 MP</span></div><strong>Sigil Bolt</strong>');
    expect(html).toContain('data-skill="judgement" data-ready="false"');
    expect(html).toContain('<kbd>U</kbd><span>INSTINCT</span></div><strong>Judgement</strong><small>Need full Instinct</small>');
    expect(html).toContain('<strong>Warden Blade</strong>');
    ui.destroy();
  });

  it('marks Judgement ready once Instinct is full so the stylesheet can glow the tile', () => {
    const { ui } = mountSkills(100);
    expect(htmlOf(ui)).toContain('data-skill="judgement" data-ready="true"');
    expect(htmlOf(ui)).toContain('<strong>Judgement</strong><small>Ready</small>');
    ui.destroy();
  });
});

describe('GameUI monster vitality', () => {
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
    const { ui } = mount(healthModel(17.2, 100));
    expect(htmlOf(ui)).toContain('<progress value="17.2" max="100"');
    expect(htmlOf(ui)).toContain('18 / 100');
    ui.render(healthModel(-5, 100));
    expect(htmlOf(ui)).toContain('<progress value="0" max="100"');
    ui.render(healthModel(205, 100));
    expect(htmlOf(ui)).toContain('<progress value="100" max="100"');
    for (const [value, maximum] of [[undefined, 100], [20, undefined], [20, 0], [NaN, 100]] as const) {
      ui.render(healthModel(value, maximum));
      expect(htmlOf(ui)).not.toContain('wc-enemy-vitality');
    }
    ui.destroy();
  });
});

describe('GameUI with four heroes', () => {
  const hudModel = (heroId: HeroId): GameViewModel => {
    const base = gameModel(false), seed = createEngineState();
    seed.player.instinct = 100;
    return { ...base, hud: { ...base.hud, heroId, skills: new CombatEngine(seed).snapshot().skills } };
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
    const model = screenModel('hero-select', { playtestSelection: { ...playtestSelection!, selectedMapId: 'greenwake' } });
    const { ui } = mount(model);
    const html = htmlOf(ui);
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
      const { ui } = mount(hudModel(hero.id));
      const html = htmlOf(ui);
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
    expect(htmlOf(regular.ui)).not.toContain('wc-boss-chip');
    expect(htmlOf(regular.ui)).toContain('data-boss="false"');
    regular.ui.destroy();
    const bossStage = mount(withTrial(hudModel('vesper'), true));
    expect(htmlOf(bossStage.ui)).toContain('<span class="wc-boss-chip">Boss</span>');
    expect(htmlOf(bossStage.ui)).toContain('<div class="wc-enemy-vitality" data-boss="true">');
    bossStage.ui.destroy();
    const bossMonster = mount(withTrial(hudModel('sakda'), false, true));
    expect(htmlOf(bossMonster.ui)).toContain('wc-boss-chip');
    bossMonster.ui.destroy();
  });

  it('re-renders the encounter panel when only the boss flag changes', () => {
    const { ui } = mount(withTrial(hudModel('aren'), false));
    expect(htmlOf(ui)).not.toContain('wc-boss-chip');
    ui.render(withTrial(hudModel('aren'), true));
    expect(htmlOf(ui)).toContain('wc-boss-chip');
    ui.render(withTrial(hudModel('aren'), false));
    expect(htmlOf(ui)).not.toContain('wc-boss-chip');
    ui.destroy();
  });
});

describe('establishing-shot overlay geometry', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

  it('renders two full-width letterbox bars and the title inside one full-screen section, for every scene id', () => {
    for (const regionId of ['greenwake', 'canopy', 'grove', 'moonpine', 'mistveil'] as const) {
      const { ui } = mount(screenModel('game', { scene: { regionId, heroName: 'Aren', establishingShot: true } }));
      const shot = frontOf(ui).innerHTML;
      expect(shot).toMatch(/<section class="wc-screen wc-shot"[^>]*data-region="/);
      expect(shot.match(/class="wc-shot__bar wc-shot__bar--(top|bottom)"/g)).toHaveLength(2);
      expect(shot).toContain('wc-shot__title');
      ui.destroy();
      dom!.restore();
    }
  });

  it('keeps the map chip positions from capturing scene sections that carry data-region (greenwake is both a chip id and a scene id)', () => {
    const css = read('../../src/ui/game-ui.css');
    // An unscoped `[data-region=…] { left; top }` once moved the greenwake shot overlay to 47% / 83% and shrank it to a corner.
    expect(css).not.toMatch(/^\[data-region/m);
    for (const id of ['whispering-canopy', 'blood-bamboo-valley', 'the-grove', 'greenwake', 'moonpine-ridge', 'mistveil-basin', 'sunmane-expanse', 'refuge', 'heartroot-hollow']) {
      expect(css).toContain(`.wc-region-chip[data-region=${id}]`);
    }
  });

  it('pins the shot section and both bars to the full viewport width', () => {
    const motion = read('../../src/ui/ui-motion.css');
    expect(motion).toMatch(/\.wc-shot__bar \{[^}]*position: absolute; left: 0; right: 0;/);
    expect(motion).toMatch(/\.wc-shot__bar--top \{[^}]*top: 0;/);
    expect(motion).toMatch(/\.wc-shot__bar--bottom \{[^}]*bottom: 0;/);
    expect(read('../../src/ui/game-ui.css')).toMatch(/\.wc-screen \{ position: absolute; inset: 0;/);
  });
});
