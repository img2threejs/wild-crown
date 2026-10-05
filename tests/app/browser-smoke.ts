import { mountGameApplication, type GameApplication } from '../../src/app/GameApplication.js';
import type { GameViewModel, UIAction } from '../../src/game/contracts.js';
import type { GameUIInstance } from '../../src/ui/GameUI.js';

// Coordinator-only browser fixture. These observers retain native constructors,
// listener dispatch, RAF scheduling, manifest fetch and all asset gates.
type ObservedApplication = {
  frame: FrameRequestCallback;
  initializationPromise: Promise<void>;
  disposed: boolean;
  screen: GameViewModel['screen'];
  error: GameViewModel['error'];
  renderer: unknown;
  region: unknown;
  slots: readonly unknown[];
  ui: GameUIInstance;
  dispatch(action: UIAction): Promise<void>;
  model(): GameViewModel;
};
const observe = (app: GameApplication) => app as unknown as ObservedApplication;
// In-process diagnostic seam: no production fields or behavior are replaced.
const diagnosticWindow = window as unknown as { __applicationLifecycleSmoke: unknown };
const root = document.querySelector<HTMLElement>('#application-root')!;
const status = document.querySelector<HTMLPreElement>('#test-status')!;
const checks: { name: string; result: 'pass' | 'fail'; detail?: string }[] = [];
const samples: { label: string; applicationFrames: number; totalFrames: number; listeners: number; databaseHandles: number }[] = [];
const startedAt = new Date().toISOString();
const databaseName = `wild-crown-m01-${crypto.randomUUID()}`;
const nativeFactory = globalThis.indexedDB;
const factoryDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
const nativeRequestFrame = window.requestAnimationFrame;
const nativeCancelFrame = window.cancelAnimationFrame;
const nativeAdd = EventTarget.prototype.addEventListener;
const nativeRemove = EventTarget.prototype.removeEventListener;
const nativeClose = IDBDatabase.prototype.close;
const pendingFrames = new Map<number, FrameRequestCallback>();
const handles = new Set<IDBDatabase>();
type Registration = { target: EventTarget; type: string; callback: EventListenerOrEventListenerObject; capture: boolean };
const listeners: Registration[] = [];
const applications: GameApplication[] = [];
const capture = (options?: boolean | AddEventListenerOptions | EventListenerOptions) => typeof options === 'boolean' ? options : options?.capture ?? false;
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function countFrames(app?: GameApplication): number {
  return app ? [...pendingFrames.values()].filter(callback => callback === observe(app).frame).length : pendingFrames.size;
}
function sample(label: string, app?: GameApplication): void {
  samples.push({ label, applicationFrames: countFrames(app), totalFrames: pendingFrames.size, listeners: listeners.length, databaseHandles: handles.size });
}
function publish(failure: string | null = null, cleanup = false): void {
  const report = { startedAt, endedAt: new Date().toISOString(), databaseName, checks, samples, failure, cleanup,
    limitations: ['Synthetic pagehide/pageshow is not evidence of real BFCache restoration.', 'Required native assets still gate initialized gameplay; this fixture never supplies substitute assets.'] };
  status.textContent = JSON.stringify(report, null, 2);
  diagnosticWindow.__applicationLifecycleSmoke = report;
}
async function check(name: string, exercise: () => Promise<void>): Promise<void> {
  try { await exercise(); checks.push({ name, result: 'pass' }); }
  catch (error) { checks.push({ name, result: 'fail', detail: String(error) }); throw error; }
  publish();
}
const nextFrame = () => new Promise<void>(resolve => nativeRequestFrame.call(window, () => resolve()));
async function settle(): Promise<void> { await nextFrame(); await nextFrame(); }
function key(value: string): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
}
function click(action: string): void {
  const button = root.querySelector<HTMLButtonElement>(`button[data-ui-action="${action}"]:not(:disabled)`);
  assert(button, `Missing enabled ${action} button on the real UI`);
  button.click();
}
async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = performance.now() + 15000;
  while (!predicate() && performance.now() < deadline) await nextFrame();
  assert(predicate(), message);
}
async function assertUnavailableWorldPanels(app: GameApplication): Promise<void> {
  const runtime = observe(app);
  const originError = runtime.error;
  assert(runtime.screen === 'settings' && !runtime.model().canOpenWorldPanels, 'No-world Settings was projected as world-panel capable');
  for (const action of ['map', 'journal', 'companions']) {
    assert(!root.querySelector(`[data-ui-action="${action}"]`), `No-world Settings exposes ${action}`);
  }
  for (const type of ['open-map', 'open-journal', 'open-companions', 'pause'] as const) {
    await runtime.dispatch({ type });
    assert(runtime.screen === 'settings' && runtime.error === originError, `${type} escaped the no-world Settings origin`);
  }
  for (const action of ['map', 'journal', 'companions']) {
    const binding = runtime.model().bindings.keyboard[action];
    if (binding) key(binding);
    await settle();
    assert(runtime.screen === 'settings' && runtime.error === originError, `Keyboard ${action} shortcut escaped the no-world Settings origin`);
  }
  // Exercise the production UI's gamepad click route against stale/forged menu
  // controls; the controller must reject them even when presentation is bypassed.
  for (const action of ['map', 'journal', 'companions']) {
    const stale = document.createElement('button');
    stale.dataset.uiAction = action;
    stale.textContent = `Stale ${action} control (boundary probe)`;
    runtime.ui.element.append(stale);
    try {
      stale.focus();
      runtime.ui.updateGamepad(null);
      runtime.ui.updateGamepad({ connected: true, buttons: [{ pressed: true }] } as Gamepad);
      await settle();
      assert(runtime.screen === 'settings' && runtime.error === originError, `Gamepad activation of stale ${action} bypassed the controller guard`);
      assert(!runtime.renderer && !runtime.region && !root.querySelector('.wc-hud'), `Rejected ${action} constructed an empty world`);
    } finally { stale.remove(); runtime.ui.updateGamepad(null); }
  }
}
function mount(): GameApplication {
  const app = mountGameApplication(root);
  applications.push(app);
  return app;
}

async function run(): Promise<void> {
  let failure: string | null = null;
  let cleanup = false;
  window.requestAnimationFrame = callback => {
    const id = nativeRequestFrame.call(window, now => { pendingFrames.delete(id); callback(now); });
    pendingFrames.set(id, callback);
    return id;
  };
  window.cancelAnimationFrame = id => { pendingFrames.delete(id); nativeCancelFrame.call(window, id); };
  EventTarget.prototype.addEventListener = function(this: EventTarget, type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
    if (callback && (this === window || this === document || this instanceof Node && root.contains(this)) && !listeners.some(entry => entry.target === this && entry.type === type && entry.callback === callback && entry.capture === capture(options))) {
      listeners.push({ target: this, type, callback, capture: capture(options) });
    }
    nativeAdd.call(this, type, callback, options);
  };
  EventTarget.prototype.removeEventListener = function(this: EventTarget, type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
    const index = listeners.findIndex(entry => entry.target === this && entry.type === type && entry.callback === callback && entry.capture === capture(options));
    if (index >= 0) listeners.splice(index, 1);
    nativeRemove.call(this, type, callback, options);
  };
  IDBDatabase.prototype.close = function(this: IDBDatabase) { handles.delete(this); nativeClose.call(this); };
  const isolatedFactory = new Proxy(nativeFactory, {
    get(target, property) {
      if (property === 'open') return (_name: string, version?: number) => {
        const request = version === undefined ? target.open(databaseName) : target.open(databaseName, version);
        request.addEventListener('success', () => handles.add(request.result));
        return request;
      };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: isolatedFactory });
  try {
    let app = mount();
    await observe(app).initializationPromise;
    await settle();
    const expectedListeners = listeners.length;
    assert(expectedListeners > 0, 'Listener observer captured no native application listeners');
    await check('untouched title Escape/Backspace stays title with no world or HUD', async () => {
      for (const value of ['Escape', 'Backspace']) {
        key(value);
        await settle();
        assert(observe(app).screen === 'title', `${value} left the root title`);
        assert(root.querySelector('.wc-state__title') && !root.querySelector('.wc-hud'), 'Title DOM was replaced by an empty gameplay HUD');
        assert(!observe(app).renderer && !observe(app).region, 'Untouched title constructed a world');
      }
      sample('title keyboard recovery', app);
    });
    await check('Title Settings hides world controls and rejects direct or stale gamepad navigation without changing Back origin', async () => {
      click('settings');
      await settle();
      await assertUnavailableWorldPanels(app);
      key('Backspace');
      await settle();
      assert(observe(app).screen === 'title' && !root.querySelector('.wc-hud'), 'Rejected world panels changed Title Settings Back');
    });
    await check('genuine asset error and Settings/back/title loops remain navigable without an initialized world', async () => {
      for (let iteration = 0; iteration < 10; iteration++) {
        click('new-game');
        await waitFor(() => !!observe(app).error, 'New Game did not reach the genuine current asset gate');
        const assetError = observe(app).error!;
        assert(assetError.code === 'asset-unavailable' && !assetError.recoverable && assetError.message.includes('greenwake-environment'), `Expected real greenwake gate, got ${JSON.stringify(assetError)}`);
        assert(!observe(app).renderer && !observe(app).region, 'Asset-blocked New Game initialized a world');
        for (const value of ['Escape', 'Backspace']) {
          key(value);
          await settle();
          assert(observe(app).screen === 'loading' && observe(app).error === assetError, `${value} escaped the honest asset error`);
        }
        click('load-screen');
        await settle();
        key('Backspace');
        await settle();
        assert(observe(app).screen === 'loading' && observe(app).error === assetError && root.querySelector('[data-ui-action="return-title"]'), 'Local Load Back lost the error recovery UI');
        click('open-settings');
        await settle();
        assert(observe(app).screen === 'settings', 'Settings was not reachable from the asset error');
        await assertUnavailableWorldPanels(app);
        key(iteration % 2 ? 'Backspace' : 'Escape');
        await settle();
        assert(observe(app).screen === 'loading' && observe(app).error === assetError, 'Settings Back lost its exact error origin');
        click('return-title');
        await settle();
        assert(observe(app).screen === 'title', 'Return to Title did not recover');
        click('settings');
        await settle();
        key('Escape');
        await settle();
        assert(observe(app).screen === 'title', 'Title Settings Back entered uninitialized gameplay');
        assert(countFrames(app) === 1 && listeners.length === expectedListeners, 'Recovery loop accumulated scheduler or listener owners');
      }
      sample('ten native recovery loops', app);
    });
    await check('persisted transition resume is idempotent and requires prior suspension', async () => {
      const transition = (name: 'pagehide' | 'pageshow', persisted: boolean) => window.dispatchEvent(new PageTransitionEvent(name, { persisted }));
      transition('pageshow', true);
      transition('pageshow', true);
      assert(countFrames(app) === 1, 'Unpaired pageshow duplicated the running application scheduler');
      transition('pagehide', true);
      transition('pagehide', true);
      await settle();
      assert(countFrames(app) === 0, 'Persisted hide left an active application frame');
      transition('pageshow', false);
      assert(countFrames(app) === 0, 'Non-persisted show resumed a suspended page');
      transition('pageshow', true);
      transition('pageshow', true);
      await settle();
      assert(countFrames(app) === 1, 'Repeated persisted show failed to resume exactly one scheduler');
      sample('synthetic persisted resume invariant', app);
    });
    await check('same-root native replacement retires old RAF/listeners/database, and stale dispose preserves new DOM', async () => {
      for (let iteration = 0; iteration < 10; iteration++) {
        const previous = app;
        app = mount();
        await observe(app).initializationPromise;
        await observe(previous).initializationPromise;
        await settle();
        assert(observe(previous).disposed && countFrames(previous) === 0, 'Replaced application retained its scheduler');
        assert(countFrames(app) === 1 && listeners.length === expectedListeners, 'Replacement accumulated application owners');
        assert(handles.size === 1, 'Replacement leaked a native IndexedDB connection');
        const children = [...root.childNodes];
        previous.dispose();
        previous.dispose();
        assert(children.length === root.childNodes.length && children.every((node, index) => root.childNodes[index] === node), 'Stale disposal erased the new mount DOM');
      }
      sample('ten same-root native replacements', app);
      app.dispose();
      app.dispose();
      await settle();
      assert(root.childNodes.length === 0 && pendingFrames.size === 0 && listeners.length === 0 && handles.size === 0, 'Idempotent disposal left owned DOM, frames, listeners or storage resources');
      sample('idempotent native disposal', app);
    });
    await check('immediate replacement and disposal during native initialization cannot leave late owners', async () => {
      const retired = mount();
      app = mount();
      await Promise.all([observe(retired).initializationPromise, observe(app).initializationPromise]);
      await settle();
      assert(countFrames(retired) === 0 && countFrames(app) === 1 && listeners.length === expectedListeners && handles.size === 1, 'Late initialization revived a retired owner');
      app.dispose();
      const pending = mount();
      pending.dispose();
      pending.dispose();
      await observe(pending).initializationPromise;
      await settle();
      assert(root.childNodes.length === 0 && pendingFrames.size === 0 && listeners.length === 0 && handles.size === 0, 'Pending initialization committed after disposal or leaked its database');
      sample('native pending-initialization disposal', pending);
    });
    await check('non-persisted hide disposes the native mount and later persisted show cannot revive it', async () => {
      app = mount();
      await observe(app).initializationPromise;
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      await settle();
      assert(observe(app).disposed && root.childNodes.length === 0 && pendingFrames.size === 0 && listeners.length === 0 && handles.size === 0, 'Non-persisted hide left or revived an application owner');
      sample('synthetic non-persisted disposal invariant', app);
    });
  } catch (error) { failure = String(error); }
  finally {
    for (const app of applications) app.dispose();
    await Promise.all(applications.map(app => observe(app).initializationPromise));
    for (const handle of handles) handle.close();
    window.requestAnimationFrame = nativeRequestFrame;
    window.cancelAnimationFrame = nativeCancelFrame;
    EventTarget.prototype.addEventListener = nativeAdd;
    EventTarget.prototype.removeEventListener = nativeRemove;
    IDBDatabase.prototype.close = nativeClose;
    if (factoryDescriptor) Object.defineProperty(globalThis, 'indexedDB', factoryDescriptor);
    else Reflect.deleteProperty(globalThis, 'indexedDB');
    try {
      await new Promise<void>((resolve, reject) => {
        const deletion = nativeFactory.deleteDatabase(databaseName);
        deletion.onsuccess = () => resolve();
        deletion.onerror = () => reject(deletion.error);
        deletion.onblocked = () => reject(new Error('Isolated smoke database cleanup was blocked'));
      });
      cleanup = true;
    } catch (error) { failure ??= String(error); }
    publish(failure, cleanup);
    document.body.dataset.applicationLifecycle = failure ? 'failed' : 'passed';
  }
}
void run();
