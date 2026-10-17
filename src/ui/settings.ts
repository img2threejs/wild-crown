import playerCopy from '../../docs/production/content/PLAYER-COPY.en.json' with { type: 'json' };
import type { GameSettings, GameViewModel } from '../game/contracts';
import { DEFAULT_KEYBOARD_BINDINGS } from '../game/contracts';
import './game-ui.css';
import './settings.css';

type SettingId = keyof GameSettings;

const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

/** Build settings exclusively from persisted settings and bindings in the shared view model. */
export function settingsMarkup(viewModel: GameViewModel): string {
  const { settings, bindings } = viewModel;
  const volume = (id: 'masterVolume' | 'musicVolume' | 'effectsVolume' | 'ambienceVolume' | 'dialogueVolume', label: string) =>
    `<label class="wc-setting-row"><span>${escape(label)}</span><input type="range" min="0" max="1" step="0.05" value="${settings[id]}" data-setting="${id}" data-focus-key="setting-${id}" aria-label="${escape(label)}"></label>`;
  const toggle = (id: 'subtitles' | 'subtitleSpeakerLabels' | 'echoSubtitles' | 'motionBlur' | 'reducedMotion' | 'reducedCameraShake' | 'highContrastTarget', label: string) =>
    // A switch named by its setting and its visible state ("Reduced Motion On"), so assistive tech never hears a bare "On".
    `<div class="wc-setting-row"><span id="wc-setting-${id}-label">${escape(label)}</span><button type="button" role="switch" class="wc-action wc-action--quiet" id="wc-setting-${id}" data-ui-action="toggle-setting" data-setting="${id}" data-focus-key="setting-${id}" aria-checked="${settings[id]}" aria-labelledby="wc-setting-${id}-label wc-setting-${id}">${settings[id] ? playerCopy.common.on : playerCopy.common.off}</button></div>`;
  const select = (id: 'subtitleSize' | 'subtitleBackground' | 'telegraphIntensity' | 'offscreenWarningStrength' | 'autoTargetAssist' | 'perfectDodgeWindow' | 'lockOnMode' | 'controlGlyphs', label: string, options: readonly string[]) =>
    `<label class="wc-setting-row"><span>${escape(label)}</span><select data-setting="${id}" data-focus-key="setting-${id}" aria-label="${escape(label)}">${options.map(option => `<option value="${option}" ${settings[id] === option ? 'selected' : ''}>${escape(option.replaceAll('-', ' '))}</option>`).join('')}</select></label>`;
  const audio = [
    volume('masterVolume', playerCopy.audio.master),
    volume('musicVolume', playerCopy.audio.music),
    volume('effectsVolume', playerCopy.audio.effects),
    volume('ambienceVolume', playerCopy.audio.ambience),
    volume('dialogueVolume', playerCopy.audio.dialogue),
  ].join('');
  const accessibility = [
    toggle('subtitles', playerCopy.accessibility.subtitles),
    toggle('echoSubtitles', playerCopy.accessibility.echo_subtitles),
    select('subtitleSize', playerCopy.accessibility.subtitle_size, ['small', 'medium', 'large']),
    select('subtitleBackground', playerCopy.accessibility.subtitle_background, ['off', 'translucent', 'solid']),
    toggle('subtitleSpeakerLabels', playerCopy.accessibility.speaker_labels),
    toggle('motionBlur', playerCopy.accessibility.motion_blur),
    toggle('reducedMotion', 'Reduced Motion'),
    toggle('reducedCameraShake', playerCopy.accessibility.camera_shake),
    select('telegraphIntensity', playerCopy.accessibility.telegraph_intensity, ['standard', 'high']),
    select('offscreenWarningStrength', playerCopy.accessibility.offscreen_warning_strength, ['low', 'standard', 'high']),
    toggle('highContrastTarget', playerCopy.accessibility.high_contrast_target_ring),
    select('autoTargetAssist', playerCopy.accessibility.auto_target_assist, ['off', 'subtle', 'strong']),
    select('perfectDodgeWindow', playerCopy.accessibility.perfect_dodge_window, ['standard', 'wide']),
    select('lockOnMode', playerCopy.accessibility.lock_on_mode, ['hold', 'toggle']),
    select('controlGlyphs', 'Control Glyphs', ['keyboard-mouse', 'gamepad']),
    `<div class="wc-setting-row"><span id="wc-setting-tutorials-label">How-to-play cards</span><button type="button" class="wc-action wc-action--quiet" data-ui-action="reset-tutorials" data-focus-key="reset-tutorials" aria-labelledby="wc-setting-tutorials-label" ${settings.seenTutorials.length ? '' : 'disabled'}>Show again</button></div>`,
  ].join('');
  const deadzone = `<label class="wc-setting-row"><span>${escape(playerCopy.input.deadzone)}</span><input type="range" min="0.05" max="0.45" step="0.01" value="${settings.gamepadDeadzone.toFixed(2)}" data-setting="gamepadDeadzone" data-focus-key="setting-gamepadDeadzone" title="${escape(playerCopy.input.deadzone_description)}" aria-label="${escape(playerCopy.input.deadzone)}"></label>`;
  const bindingRows = (device: 'keyboard' | 'gamepad', deviceBindings: Readonly<Record<string, string>>) =>
    Object.keys({ ...DEFAULT_KEYBOARD_BINDINGS, ...deviceBindings }).map(id => {
      const binding = deviceBindings[id] ?? '';
      const label = id.replace(/([a-z])([A-Z])/g, '$1 $2');
      const readOnly = device === 'gamepad' ? 'readonly' : '';
      return `<label class="wc-setting-row"><span>${escape(label)}</span><input type="text" value="${escape(binding)}" placeholder="Unbound" data-remap="${escape(id)}" data-remap-device="${device}" data-focus-key="binding-${device}-${escape(id)}" aria-label="${escape(`${playerCopy.input.remap} ${label} ${device}`)}" ${readOnly}></label>`;
    }).join('');
  const remaps = `${deadzone}<section class="wc-settings-section"><h3>Keyboard and Mouse</h3><p class="wc-state__copy">${escape(playerCopy.input.press_binding)}</p>${bindingRows('keyboard', bindings.keyboard)}</section><section class="wc-settings-section"><h3>Gamepad</h3><p class="wc-state__copy">Focus a binding and press a controller button.</p>${bindingRows('gamepad', bindings.gamepad)}</section>`;
  return `<div class="wc-settings-columns"><section class="wc-sheet wc-menu__side"><h1 class="wc-heading">${escape(playerCopy.settings.title)}</h1><section class="wc-settings-section"><h2>${escape(playerCopy.settings.audio)}</h2>${audio}</section><section class="wc-settings-section"><h2>${escape(playerCopy.accessibility.title)}</h2>${accessibility}</section></section><section class="wc-sheet wc-menu__side"><h2 class="wc-heading">${escape(playerCopy.input.remap)}</h2>${remaps}</section></div>`;
}

export function settingPatch(id: string, value: string | number | boolean): Partial<GameSettings> | null {
  switch (id as SettingId) {
    case 'gamepadDeadzone': return typeof value === 'number' && value >= 0.05 && value <= 0.45 ? { gamepadDeadzone: value } : null;
    case 'masterVolume': case 'musicVolume': case 'effectsVolume': case 'ambienceVolume': case 'dialogueVolume':
      return typeof value === 'number' ? { [id]: value } : null;
    case 'subtitles': case 'subtitleSpeakerLabels': case 'echoSubtitles': case 'motionBlur': case 'reducedMotion': case 'reducedCameraShake': case 'highContrastTarget':
      return typeof value === 'boolean' ? { [id]: value } : null;
    case 'subtitleSize': return value === 'small' || value === 'medium' || value === 'large' ? { subtitleSize: value } : null;
    case 'subtitleBackground': return value === 'off' || value === 'translucent' || value === 'solid' ? { subtitleBackground: value } : null;
    case 'telegraphIntensity': return value === 'standard' || value === 'high' ? { telegraphIntensity: value } : null;
    case 'offscreenWarningStrength': return value === 'low' || value === 'standard' || value === 'high' ? { offscreenWarningStrength: value } : null;
    case 'autoTargetAssist': return value === 'off' || value === 'subtle' || value === 'strong' ? { autoTargetAssist: value } : null;
    case 'perfectDodgeWindow': return value === 'standard' || value === 'wide' ? { perfectDodgeWindow: value } : null;
    case 'lockOnMode': return value === 'hold' || value === 'toggle' ? { lockOnMode: value } : null;
    case 'controlGlyphs': return value === 'keyboard-mouse' || value === 'gamepad' ? { controlGlyphs: value } : null;
    default: return null;
  }
}

export function toggleSetting(id: string, settings: GameSettings): Partial<GameSettings> | null {
  switch (id as SettingId) {
    case 'subtitles': return { subtitles: !settings.subtitles };
    case 'subtitleSpeakerLabels': return { subtitleSpeakerLabels: !settings.subtitleSpeakerLabels };
    case 'echoSubtitles': return { echoSubtitles: !settings.echoSubtitles };
    case 'motionBlur': return { motionBlur: !settings.motionBlur };
    case 'reducedMotion': return { reducedMotion: !settings.reducedMotion };
    case 'reducedCameraShake': return { reducedCameraShake: !settings.reducedCameraShake };
    case 'highContrastTarget': return { highContrastTarget: !settings.highContrastTarget };
    default: return null;
  }
}
