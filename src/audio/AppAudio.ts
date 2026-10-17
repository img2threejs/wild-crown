import type { GameSettings, UIAction } from '../game/contracts.js';
import type { StingerId, UiSound } from './SampleCatalog.js';
import { StoryAudio, type StoryAudioOptions } from './StoryAudio.js';

/** Screens that carry the title score. */
export const TITLE_SCREENS: readonly string[] = ['title', 'map-select', 'hero-select'];
/** Screens that hand over to the region score; overlay panels (settings, journal, map, credits) leave the music alone. */
export const SCENE_SCREENS: readonly string[] = ['loading', 'map-intro', 'game', 'dialogue', 'choice', 'stage-complete', 'defeat', 'ending', 'pause'];
/** Screens whose spoken lines duck the region score. */
export const DIALOGUE_SCREENS: readonly string[] = ['dialogue', 'choice'];

const CONFIRM_ACTIONS: Readonly<Record<string, true>> = {
  'new-game': true, 'select-map': true, 'select-hero': true, continue: true, load: true, save: true, 'create-save-slot': true, import: true, export: true,
  'accept-quest': true, travel: true, choose: true, 'leave-map-intro': true, 'retry-load': true, remap: true,
};
const OPEN_ACTIONS: Readonly<Record<string, true>> = { 'open-map': true, 'open-journal': true, 'open-companions': true, 'open-settings': true, pause: true, 'map-select': true, 'view-credits': true };
const BACK_ACTIONS: Readonly<Record<string, true>> = { 'close-screen': true, 'return-title': true, resume: true };
/** In-world actions that already have their own cue sounds; the UI mixer stays silent for them. */
const SILENT_ACTIONS: Readonly<Record<string, true>> = { interact: true, 'use-ability': true, 'issue-command': true };
/** Slider drags fire `update-settings` continuously; ticks are spaced at least this many milliseconds apart. */
export const SETTINGS_TICK_GAP_MS = 90;

/** UI sound for a dispatched action, or undefined when the action is voiced elsewhere. */
export function uiSoundForAction(type: UIAction['type']): UiSound | undefined {
  if (SILENT_ACTIONS[type]) return undefined;
  if (CONFIRM_ACTIONS[type]) return 'confirm';
  if (OPEN_ACTIONS[type]) return 'open';
  if (BACK_ACTIONS[type]) return 'back';
  if (type === 'update-settings') return 'toggle';
  return 'click';
}

/**
 * App-level audio facade owned by the application shell: one shared-context mixer for the title score and UI sounds, plus forwarding to the
 * region mixer (dialogue ducking, victory/defeat stingers). The shell calls it from its existing hooks: user gesture, screen render,
 * dispatched UI actions, region load and outcome presentation. It never reads or mutates simulation state.
 */
export class AppAudio {
  readonly mixer: StoryAudio;
  private region: StoryAudio | undefined;
  private screen = '';
  private titleWanted = false;
  private unlocked = false;
  private lastTickAt = -Infinity;

  constructor(options: StoryAudioOptions = {}) {
    this.mixer = new StoryAudio(options);
  }

  setSettings(settings: GameSettings): void { this.mixer.setSettings(settings); }

  /** Call from a real pointer or key event. Starts the title score when the title screens are showing. */
  async unlock(): Promise<boolean> {
    const ok = await this.mixer.unlock();
    if (ok && !this.unlocked) {
      this.unlocked = true;
      this.applyTitle();
    }
    return ok;
  }

  /** Tracks the screen the shell is rendering: title score, hand-over to the region score and dialogue ducking. */
  syncScreen(screen: string): void {
    if (screen === this.screen) return;
    this.screen = screen;
    if (TITLE_SCREENS.includes(screen)) this.titleWanted = true;
    else if (SCENE_SCREENS.includes(screen)) this.titleWanted = false;
    this.applyTitle();
    this.region?.setDialogueActive(DIALOGUE_SCREENS.includes(screen));
  }

  /** Connects (or, with undefined, disconnects) the region mixer that owns the world's score. */
  attachRegion(region: StoryAudio | undefined): void {
    this.region = region;
    region?.setDialogueActive(DIALOGUE_SCREENS.includes(this.screen));
  }

  /** UI click/confirm/back sound for a dispatched action. */
  action(type: UIAction['type'], nowMs: number = typeof performance === 'object' ? performance.now() : 0): void {
    const sound = uiSoundForAction(type);
    if (!sound) return;
    if (type === 'update-settings') {
      if (nowMs - this.lastTickAt < SETTINGS_TICK_GAP_MS) return;
      this.lastTickAt = nowMs;
    }
    this.mixer.playUi(sound);
  }

  playStinger(id: StingerId): boolean { return this.region?.playStinger(id) ?? false; }

  dispose(): void {
    this.region = undefined;
    this.mixer.dispose();
  }

  private applyTitle(): void {
    if (!this.unlocked) return;
    if (this.titleWanted) this.mixer.startTitleMusic();
    else this.mixer.stopTitleMusic();
  }
}
