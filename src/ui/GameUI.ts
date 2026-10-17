import playerCopy from '../../docs/production/content/PLAYER-COPY.en.json' with { type: 'json' };
import type {
  ActorId,
  CompanionId,
  GameViewModel,
  ObjectiveId,
  QuestDefinition,
  RegionId,
  TutorialId,
  UIAction,
} from '../game/contracts';
import { settingsMarkup, settingPatch, toggleSetting } from './settings';
import { saveMarkup } from './save';
import { icon } from './icons';
import { areaLegendMarkup, areaMapMarkup, currentObjectiveMarkup, exitsMarkup, questStepsMarkup } from './survey';
import { loadingErrorActions, recoveryImportAllowed } from './loading-error-actions';
import { HEROES, heroById, isHeroId, type HeroDefinition, type HeroId } from '../game/heroes';
import { PLAYER_SKILLS, SIGIL } from '../game/combat/PlayerSkills';
import { isCompanionId } from '../game/companions/CompanionLoadout';
import { COMPANION_SPECIALIZATIONS } from '../game/companions/CompanionSkills';
import { REGION_PRESENTATION } from '../content/regionPresentation';
import { atmosphereMarkup, loadingSceneMarkup, mapIntroMarkup } from './regionScenes';
import { esc, clamp, button, checkpointLabel } from './markup';
import {
  chaptersMenuMarkup, objectiveHudMarkup, partyPanelMarkup, patchObjectiveDestination, relationshipMeterMarkup, scopeLabel, segmentLabel, slotDescription, wheelMarkup,
} from './chapterPanels';
import { hubMarkup, hubPracticeHudMarkup } from './hubPanels';
import '@fontsource/barlow/400.css';
import '@fontsource/barlow/500.css';
import '@fontsource/barlow/600.css';
import '@fontsource/barlow/700.css';
import '@fontsource/barlow-condensed/500.css';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/alegreya/400.css';
import '@fontsource/alegreya/400-italic.css';
import './game-ui.css';
import './chapter-ui.css';
import './ui-motion.css';
import { bindWorldMapSelect, worldMapPanels, worldMapSelectMarkup } from './worldMapSelect';
import './map-select.css';

const mapArt = '/ui/world-map-game.webp';
const PORTRAIT_ASSETS: Partial<Record<CompanionId, string>> = { vara: '/ui/portrait-vara.webp', koro: '/ui/portrait-koro.webp', asha: '/ui/portrait-asha.webp', sable: '/ui/portrait-sable.webp', nyra: '/ui/portrait-nyra.webp', solkar: '/ui/portrait-solkar.webp' };

/** Live hero preview mounted by the application on the hero-select stage host. */
export interface HeroPreviewController {
  show(heroId: HeroId): void;
  showcase(actionIds: readonly string[]): void;
  dispose(): void;
}

/** Live 3D diorama the application mounts behind the title card. */
export interface TitleStageController {
  update(dt: number): void;
  dispose(): void;
}

export interface GameUIOptions {
  onAction: (action: UIAction) => void;
  initialViewModel?: GameViewModel;
  /** Renderer integrations attach the real, animated character renderer here. */
  onPreviewHost?: (host: HTMLElement, companionId: CompanionId | null) => void | (() => void);
  /** Renderer integration for the hero-select stage; null when no 3D preview can be offered. */
  onHeroPreviewHost?: (host: HTMLElement) => HeroPreviewController | null;
  /** Renderer integration for the title-screen diorama; null when WebGL is unavailable. */
  onTitleStageHost?: (host: HTMLElement) => TitleStageController | null;
}

type HeroTab = 'role' | 'stats' | 'skills' | 'story';
const HERO_TABS: readonly { readonly id: HeroTab; readonly label: string }[] = [
  { id: 'role', label: 'Role & Power' }, { id: 'stats', label: 'Stats' }, { id: 'skills', label: 'Skills' }, { id: 'story', label: 'Story' },
];
const isHeroTab = (value: unknown): value is HeroTab => HERO_TABS.some(tab => tab.id === value);
const heroCrest = (hero: HeroDefinition, className: string) =>
  `<span class="${className}" style="background-image:url('${esc(hero.portraitUrl)}');background-position:${esc(hero.portraitCrop)}" aria-hidden="true"></span>`;

export interface GameUIInstance {
  render(viewModel: GameViewModel): void;
  updateGamepad(gamepad: Gamepad | null): void;
  destroy(): void;
  /**
   * Called every frame by the application: true while Aren stands within 1.5 m of a closed trial gate.
   * The notice names the monster that must be defeated to unseal the current gate.
   */
  setGateContact(active: boolean): void;
  /** Shows a short status line (a refused command's exact reason); it clears itself. */
  notify(message: string): void;
  readonly element: HTMLElement;
}

type Screen = GameViewModel['screen'];

const REGION_ORDER: readonly RegionId[] = [
  'whispering-canopy', 'blood-bamboo-valley', 'the-grove', 'greenwake',
  'moonpine-ridge', 'mistveil-basin', 'sunmane-expanse', 'refuge', 'heartroot-hollow',
];
const COMPANIONS: readonly { id: CompanionId; name: string; portrait: string }[] = [
  { id: 'asha', name: 'Asha', portrait: 'asha' },
  { id: 'koro', name: 'Koro', portrait: 'koro' },
  { id: 'vara', name: 'Vara', portrait: 'vara' },
  { id: 'sable', name: 'Sable', portrait: 'sable' },
  { id: 'nyra', name: 'Nyra', portrait: 'nyra' },
  { id: 'solkar', name: 'Solkar', portrait: 'solkar' },
];
const ABILITY_ICONS = ['leaf', 'root', 'spark'] as const;
const speakerName: Record<string, string> = {
  aren: 'Aren', yara: 'Yara', vara: 'Vara', koro: 'Koro', asha: 'Asha', tali: 'Tali',
  ruun: 'Ruun', luma: 'Luma', sable: 'Sable', nyra: 'Nyra', solkar: 'Solkar', ghor: 'Ghor',
  marek: 'Marek', orun: 'Orun', narrator: 'Narrator', echo: 'Echo',
};
/** How a screen enters and leaves: whole scenes cross-fade with staggered content, panels scale over a dimmed backdrop, the HUD only fades. */
type Motion = 'scene' | 'overlay' | 'hud';
/** Screens that open as panels over the world or another screen. */
const OVERLAY_KEYS: Record<string, true> = { pause: true, map: true, journal: true, companions: true, hub: true, settings: true, credits: true, save: true, load: true };
/** Full-bleed scenes whose DOM is patched in place on every update, so their CSS animations never restart. */
const SCENE_KEYS: Record<string, true> = { loading: true, 'map-intro': true, shot: true };
/** Outgoing layer exit animation in ms; mirrors `--wc-leave-ms` in ui-motion.css. */
const LEAVE_MS = 220;
/**
 * How long an incoming layer keeps `.wc-enter`. The layer itself animates for at most 380 ms; the longer scene window
 * lets staggered content (menu buttons, cards, title letters) finish before the class and its animations are removed.
 */
const ENTER_SETTLE_MS: Record<Motion, number> = { scene: 2700, overlay: 520, hud: 700 };
const LAYER_CONTROLS = 'button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]';
const motionOf = (key: string): Motion => key === 'game' ? 'hud' : OVERLAY_KEYS[key] ? 'overlay' : 'scene';
/** Identity of what the UI shows: a change of key is a screen change and plays a transition; the same key patches in place. */
function screenKey(viewModel: GameViewModel): string {
  const { screen } = viewModel;
  if (screen === 'map-intro' || screen === 'title' || screen === 'map-select' || screen === 'hero-select' || screen === 'chapters-menu' || screen === 'hub') return screen;
  if (viewModel.loading.active || screen === 'loading') return 'loading';
  return screen === 'game' && viewModel.scene?.establishingShot ? 'shot' : screen;
}
/**
 * Patches `target`'s children to match `source` without replacing nodes that already agree, so running CSS animations
 * keep their place. Preview hosts keep their live children: the renderer owns them.
 */
function morphChildren(target: Element, source: Element): void {
  const have = [...target.childNodes];
  const want = [...source.childNodes];
  for (const [index, wanted] of want.entries()) {
    const current = have[index];
    if (!current) { target.append(wanted); continue; }
    if (current.nodeType !== wanted.nodeType || current instanceof Element && wanted instanceof Element && current.tagName !== wanted.tagName) {
      current.replaceWith(wanted);
    } else if (current instanceof Element && wanted instanceof Element) {
      morphElement(current, wanted);
    } else if (current.nodeValue !== wanted.nodeValue) current.nodeValue = wanted.nodeValue;
  }
  for (let index = want.length; index < have.length; index++) have[index]!.remove();
}
function morphElement(current: Element, wanted: Element): void {
  for (const attribute of [...current.attributes]) if (!wanted.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
  for (const attribute of [...wanted.attributes]) if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
  if (current.hasAttribute('data-preview-host')) return;
  if (current instanceof HTMLInputElement && wanted instanceof HTMLInputElement) {
    if (current.value !== wanted.value) current.value = wanted.value;
    current.checked = wanted.checked;
  } else if (current instanceof HTMLSelectElement && wanted instanceof HTMLSelectElement) {
    if (current.innerHTML !== wanted.innerHTML) current.innerHTML = wanted.innerHTML;
    current.value = wanted.value;
  } else morphChildren(current, wanted);
}
/** Dialogue text as groups of three words that fade in one after another (CSS only); plain text when motion is reduced. */
function wordGroups(text: string, reduced: boolean): string {
  if (reduced) return esc(text);
  const words = text.split(/\s+/).filter(Boolean);
  const groups: string[] = [];
  for (let index = 0; index < words.length; index += 3) groups.push(words.slice(index, index + 3).join(' '));
  return groups.map((group, index) => `<span class="wc-wg" style="--i:${Math.min(index, 14)}">${esc(group)}${index < groups.length - 1 ? ' ' : ''}</span>`).join('');
}
/** Circular crest of a speaker: companion portrait, hero crest, or a monogram. */
function speakerCrest(speaker: string): string {
  const portrait = PORTRAIT_ASSETS[speaker as CompanionId];
  if (portrait) return `<span class="wc-portrait wc-dialogue__crest" style="background-image:url('${portrait}')" aria-hidden="true"></span>`;
  if (isHeroId(speaker)) return heroCrest(heroById(speaker), 'wc-hero-crest wc-dialogue__crest');
  return `<span class="wc-dialogue__crest wc-dialogue__crest--mono" aria-hidden="true">${esc((speakerName[speaker] ?? speaker).charAt(0).toUpperCase())}</span>`;
}
function controlBindingLabel(viewModel: GameViewModel, actionId: string): string {
  const device = viewModel.settings.controlGlyphs === 'gamepad' ? 'gamepad' : 'keyboard';
  const binding = viewModel.bindings[device][actionId];
  if (!binding) return '';
  if (device === 'gamepad') return binding.replace(/^Gamepad /, '');
  const normalized = binding.toLowerCase();
  if (normalized === 'space' || normalized === ' ') return 'SPACE';
  if (normalized === 'escape' || normalized === 'esc') return 'ESC';
  if (normalized === 'tab') return 'TAB';
  return binding.toUpperCase();
}
/** One line telling the player what the current boss phase needs, with their own bindings and the real mana prices. */
function encounterStepMarkup(viewModel: GameViewModel, step: NonNullable<NonNullable<GameViewModel['hud']['encounterStatus']>['step']>): string {
  const key = (actionId: string) => { const label = controlBindingLabel(viewModel, actionId); return label ? ` <kbd>${esc(label)}</kbd>` : ''; };
  const attacks = `Attack${key('light')}${key('heavy')}${key('ranged')}`;
  const text = step.action === 'wear-down' ? `${attacks} to drain its Ferocity · Dodge${key('dodge')} the marked ground`
    : step.action === 'tether' ? step.done ? `Tethered · ${attacks} to drain its Ferocity`
      : `Root Tether${key('ability')} while it winds up · ${PLAYER_SKILLS.root_tether.manaCost} mana — keep moving to refill mana`
    : step.action === 'counter' ? step.done ? `Countered · ${attacks} to drain its Ferocity`
      : `Perfect-dodge${key('dodge')} its strike, then counter${key('light')}`
    : step.done ? 'Cleansed'
      : viewModel.hud.boss?.exposed ? `Cleanse${key('ability')} now — its corruption is exposed · ${PLAYER_SKILLS.cleanse.manaCost} mana`
      : `${attacks} to expose its corruption, then Cleanse${key('ability')} · ${PLAYER_SKILLS.cleanse.manaCost} mana`;
  return `<p class="wc-encounter__step" data-step="${step.action}" data-done="${step.done}">${text}</p>`;
}
/** A how-to-play card shown over the frozen world; every key comes from the player's current bindings. */
function tutorialMarkup(viewModel: GameViewModel, id: TutorialId): string {
  const key = (actionId: string) => `<kbd>${esc(controlBindingLabel(viewModel, actionId) || 'unbound')}</kbd>`;
  const move = ['moveForward', 'moveLeft', 'moveBack', 'moveRight'].map(key).join('');
  const cards: Record<TutorialId, { title: string; lines: string[] }> = {
    controls: { title: 'How to play', lines: [
      `${move} move · hold ${key('sprint')} to run · ${key('jump')} jump`,
      `${key('interact')} talk or use something when its prompt appears`,
      `${key('light')} light attack · ${key('heavy')} heavy · ${key('ranged')} ranged`,
      `${key('dodge')} dodge — costs ${PLAYER_SKILLS.dive.manaCost} mana`,
      `${key('ability')} Root Tether or Cleanse — the skill card shows which one is ready`,
      `Hold ${key('lockOn')} to lock onto a creature · ${key('pause')} pause`,
      'Mana refills only while you move — standing still does not restore it.',
      'Your current goal is always in the panel at the top right.',
    ] },
    'cleanse-boss': { title: 'Corrupted creatures are cleansed, not killed', lines: [
      'The bar at the top shows its <strong>Ferocity</strong> (its fight) and <strong>Corruption</strong> (the Black Sap in it).',
      'Your attacks drain Ferocity. Each time it falls past a mark, the fight enters a new phase.',
      'The panel at the top right names the phase and tells you exactly what that phase needs.',
      'Some phases need a skill, not more attacks. The fight ends when you cleanse all of its Corruption.',
    ] },
    tether: { title: 'Root Tether', lines: [
      'This phase cannot be passed by attacking alone: you must bind the creature with roots.',
      'Watch for its wind-up — the marked ground just before it strikes.',
      `Press ${key('ability')} during the wind-up. Costs ${PLAYER_SKILLS.root_tether.manaCost} mana.`,
      `If the ${key('ability')} card reads Cleanse, you just stunned it: wait for its next wind-up.`,
      'Out of mana? Keep moving around it — mana refills as you move.',
      'Once the tether lands, attack again to drain the rest of its Ferocity.',
    ] },
    counter: { title: 'Counter', lines: [
      `Dodge ${key('dodge')} just as its strike lands — a perfect dodge slows time.`,
      `Strike ${key('light')} straight away to counter. The phase only ends after a counter lands.`,
    ] },
    cleanse: { title: 'Cleanse', lines: [
      'Strike the creature until <strong>Corruption Exposed</strong> appears under its bars.',
      `Then press ${key('ability')} to Cleanse. Costs ${PLAYER_SKILLS.cleanse.manaCost} mana.`,
      'Each Cleanse removes part of the Corruption — repeat until the Corruption bar is empty.',
      'Out of mana? Keep moving — mana refills as you move.',
    ] },
  };
  const card = cards[id];
  return `<section class="wc-panel wc-sheet wc-tutorial" role="dialog" aria-modal="true" aria-labelledby="wc-tutorial-title" data-tutorial="${id}">
    <h2 id="wc-tutorial-title" class="wc-heading">${esc(card.title)}</h2>
    <ul>${card.lines.map(line => `<li>${line}</li>`).join('')}</ul>
    <footer><span class="wc-meta">Game paused</span><button type="button" class="wc-action wc-action--primary" data-ui-action="dismiss-tutorial" data-focus-key="dismiss-tutorial">Continue</button></footer></section>`;
}
function controlHints(viewModel: GameViewModel): string {
  const keyboardControls = viewModel.settings.controlGlyphs !== 'gamepad';
  const move = keyboardControls ? ['moveForward', 'moveLeft', 'moveBack', 'moveRight'].map(id => controlBindingLabel(viewModel, id)).filter(Boolean).join(' ') + ' / ARROWS' : 'LEFT STICK';
  const dodge = controlBindingLabel(viewModel, 'dodge');
  const jump = controlBindingLabel(viewModel, 'jump');
  const run = keyboardControls ? 'SHIFT RUN' : '';
  const dive = dodge ? `${dodge} ${heroById(viewModel.hud.heroId ?? 'aren').dodgeLabel}` : '';
  const jumpHint = jump ? `${jump} ×2 DOUBLE JUMP` : '';
  const pause = controlBindingLabel(viewModel, 'pause');
  return [move && move + ' MOVE', run, dive, jumpHint, pause && 'PAUSE ' + pause].filter((hint): hint is string => Boolean(hint)).join(' · ');
}
function interactionPrompt(viewModel: GameViewModel): string {
  const interaction = viewModel.hud.interaction;
  if (!interaction) return '';
  const explicitAction = Boolean(interaction.requiresCompanionCommand || interaction.playerActionId);
  const actionId = explicitAction
    ? interaction.inputHint && interaction.inputHint !== 'interact' ? interaction.inputHint : ''
    : interaction.inputHint ?? 'interact';
  const binding = actionId ? controlBindingLabel(viewModel, actionId) : '';
  const hint = binding ? '<kbd>' + esc(binding) + '</kbd> ' : '';
  const label = esc(interaction.label);
  if (explicitAction || interaction.activation === 'press-release' || Boolean(interaction.inputHint && interaction.inputHint !== 'interact')) {
    return '<div class="wc-interact" role="status" aria-live="polite">' + hint + label + '</div>';
  }
  const ariaLabel = binding ? binding + ' ' + interaction.label : interaction.label;
  return '<button type="button" class="wc-interact" data-ui-action="interact" data-focus-key="interact-' + esc(interaction.interactionId) + '" data-interaction="' + esc(interaction.interactionId) + '" data-target="' + esc(interaction.targetId) + '" aria-label="' + esc(ariaLabel) + '">' + hint + label + '</button>';
}
const meter = (label: string, value: number, max: number, style: string, description?: string) => {
  const percent = max > 0 ? Math.round(clamp(value / max) * 100) : 0;
  return `<div class="wc-meter wc-meter--${style}" aria-label="${esc(label)} ${percent}%" ${description ? `title="${esc(description)}"` : ''}><span>${esc(label)}</span><span class="wc-meter__track" aria-hidden="true"><i class="wc-meter__fill" style="width:${percent}%"></i></span></div>`;
};
const monsterHealth = (name: string, value: number | undefined, max: number | undefined, boss = false): string => {
  if (typeof value !== 'number' || typeof max !== 'number' || !Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return '';
  const health = Math.max(0, Math.min(max, value));
  return `<div class="wc-enemy-vitality" data-boss="${boss}"><progress value="${health}" max="${max}" aria-label="${esc(name)} vitality"></progress><span>${Math.ceil(health)} / ${Math.ceil(max)}</span></div>`;
};
const BOSS_CHIP = '<span class="wc-boss-chip">Boss</span>';
/** Mana or Instinct price printed on a skill card, from the shared skill constants every hero uses (tap price, then the hold price after the slash). */
function skillCardCost(skill: GameViewModel['hud']['skills'][number]): string {
  if (skill.id === 'judgement') return 'INSTINCT';
  if (skill.id === 'heavy') return `${PLAYER_SKILLS.heavy.manaCost} / ${PLAYER_SKILLS.charged_heavy.manaCost} MP`;
  if (skill.id === 'sigil_bolt' || skill.id === 'sigil_barrage') return `${SIGIL.boltMana} / ${SIGIL.barrageMana} MP`;
  return skill.manaCost ? `${skill.manaCost} MP` : 'FREE';
}
const activeRegionName = (vm: GameViewModel) => vm.map.regions.find(r => r.id === (vm.map.currentRegion ?? vm.campaign?.regionId))?.name ?? vm.campaign?.regionId.replaceAll('-', ' ') ?? 'Erya';

function gamepadActionJustPressed(bindings: GameViewModel['bindings'], actionId: string, pressed: ReadonlySet<number>, previous: ReadonlySet<number>): boolean {
  const binding = bindings.gamepad[actionId];
  const prefix = 'Gamepad Button ';
  if (!binding?.startsWith(prefix)) return false;
  const buttonNumber = Number(binding.slice(prefix.length));
  const index = buttonNumber - 1;
  return Number.isInteger(buttonNumber) && buttonNumber > 0 && pressed.has(index) && !previous.has(index);
}
function reconcileFocusedControl(current: HTMLElement, next: HTMLElement): void {
  const previousValue = current instanceof HTMLInputElement ? current.value : null;
  const selection = current instanceof HTMLInputElement && current.type === 'text'
    ? [current.selectionStart, current.selectionEnd, current.selectionDirection] as const
    : null;
  for (const attribute of [...current.attributes]) if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
  for (const attribute of [...next.attributes]) current.setAttribute(attribute.name, attribute.value);
  if (current instanceof HTMLInputElement && next instanceof HTMLInputElement) {
    current.value = next.value;
    current.checked = next.checked;
    if (previousValue === next.value && selection && selection[0] !== null && selection[1] !== null) {
      current.setSelectionRange(selection[0], selection[1], selection[2] ?? 'none');
    }
  } else if (current instanceof HTMLSelectElement && next instanceof HTMLSelectElement) {
    current.innerHTML = next.innerHTML;
    current.value = next.value;
  } else current.innerHTML = next.innerHTML;
  next.replaceWith(current);
}
function gameUiSignature(viewModel: GameViewModel): string {
  const { hud, campaign, map } = viewModel;
  return JSON.stringify([
    viewModel.screen, viewModel.canOpenWorldPanels, viewModel.loading, viewModel.error, viewModel.playtestStage, viewModel.playtestSelection, hud.heroId,
    [hud.vitality, hud.maxVitality, Math.floor(hud.mana), hud.maxMana, hud.skills, hud.instinct, hud.boss, hud.targetId, hud.target?.id, hud.target?.weakPointExposed, hud.interaction, hud.destination?.label,
      hud.encounterStatus && [hud.encounterStatus.title, hud.encounterStatus.step?.action, hud.encounterStatus.step?.done, hud.encounterStatus.monsters, hud.encounterStatus.trial]],
    viewModel.trackedObjectiveId, viewModel.tutorial,
    campaign && [campaign.runId, campaign.revision, campaign.chapter, campaign.chapterId, campaign.regionId, campaign.activeQuestIds, campaign.completedQuestIds, campaign.activeObjectiveIds, campaign.completedObjectiveIds, campaign.fragments, campaign.ending],
    viewModel.journal.region, viewModel.journal.quests.map(quest => [quest.id, quest.title, quest.description, quest.objectives.map(objective => [objective.id, objective.title, objective.description, objective.optional])]),
    [map.currentRegion, map.regions.map(region => [region.id, region.name, region.unlocked, region.restoration, region.entrances])],
    viewModel.party, viewModel.abilities, viewModel.relationships, viewModel.settings, viewModel.bindings,
    viewModel.dialogue, viewModel.dialogueLineIndex, viewModel.choice, viewModel.ending,
    [viewModel.saves.continueSlotId, viewModel.saves.slots.map(slot => [slot.slotId, slot.label, slot.exists, slot.updatedAt, slot.chapter, slot.regionId, slot.scope, slot.heroId, slot.segmentId, slot.checkpointId, slot.autosave])],
    viewModel.session, viewModel.dialogueChoice, viewModel.partyPanel, viewModel.companionProgress, viewModel.chapterAct, viewModel.hasCandidateSaves,
    viewModel.objectiveHud && [viewModel.objectiveHud.chapterLabel, viewModel.objectiveHud.questTitle, viewModel.objectiveHud.objectiveTitle, viewModel.objectiveHud.counter, viewModel.objectiveHud.interaction,
      viewModel.objectiveHud.destination && [viewModel.objectiveHud.destination.label, viewModel.objectiveHud.destination.hint, viewModel.objectiveHud.destination.distanceMeters === null, viewModel.objectiveHud.destination.bearingDegrees === null]],
    viewModel.hub && [viewModel.hub.name, viewModel.hub.stage, viewModel.hub.upgrades.map(u => [u.id, u.learned, u.available, u.requirement]),
      viewModel.hub.memories.map(m => [m.id, m.title, m.lines.map(l => [l.speaker, l.text])]),
      viewModel.hub.practice && [viewModel.hub.practice.available, viewModel.hub.practice.reason, viewModel.hub.practice.active, viewModel.hub.practice.attempts, viewModel.hub.practice.dodged, viewModel.hub.practice.phase]],
  ]);
}
/** What still keeps the active trial gate sealed, from the existing encounter status; null outside a running trial. */
function gateContactMessage(hud: GameViewModel['hud']): string | null {
  const trial = hud.encounterStatus?.trial;
  if (!trial || trial.complete) return null;
  const monster = hud.encounterStatus!.monsters.find(candidate => candidate.active)?.name ?? 'the monster';
  return `Sealed by ${monster} — defeat the monster to open the gate`;
}
/**
 * Destination compass text and arrow, written in place: the bearing and distance change every frame while Aren
 * walks, and a full HUD rebuild per frame measured 0.4 ms mean / 8 ms max. Presence and label stay in the render
 * signature; only the continuous values are patched here, with the same precision the markup renders.
 */
function patchDestination(container: HTMLElement, destination: GameViewModel['hud']['destination']): void {
  if (!destination) return;
  const panel = container.querySelector<HTMLElement>('.wc-destination');
  if (!panel) return;
  const arrow = panel.querySelector<SVGElement>('svg');
  const transform = `rotate(${destination.bearingDegrees}deg)`;
  if (arrow && arrow.style.transform !== transform) arrow.style.transform = transform;
  const copy = panel.querySelector<HTMLElement>('p');
  const text = `Follow the trail · ${Math.ceil(destination.distanceMeters)} m`;
  if (copy && copy.textContent !== text) copy.textContent = text;
}
/** DOM-only game UI. Renders shared GameViewModel data and emits typed runtime actions. */
export function mountGameUI(root: HTMLElement, options: GameUIOptions): GameUIInstance {
  const container = document.createElement('div');
  container.className = 'wc-ui';
  container.setAttribute('aria-label', 'Wild Crown game interface');
  root.append(container);
  // Two persistent layers: the front one shows the current screen; the other plays the outgoing screen's exit, then empties.
  const layers = [document.createElement('div'), document.createElement('div')] as const;
  for (const layer of layers) {
    layer.className = 'wc-layer';
    layer.hidden = true;
    container.append(layer);
  }
  let front = 0;
  let frontKey = '';
  let transitionGeneration = 0;
  let transitionTimers: number[] = [];
  let reducedMotion = false;
  // The OS preference is read once and kept current by the query's change event: asking per render forces a style flush.
  const motionQuery = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  let osReducedMotion = motionQuery?.matches ?? false;
  const onMotionPreference = (event: MediaQueryListEvent) => { osReducedMotion = event.matches; };
  motionQuery?.addEventListener?.('change', onMotionPreference);
  // Gate feedback lives in its own overlay so HUD re-renders never tear it down mid-pulse.
  const feedback = document.createElement('div');
  feedback.className = 'wc-ui wc-ui--feedback';
  const gateNotice = document.createElement('p');
  gateNotice.className = 'wc-panel wc-gate-contact';
  gateNotice.setAttribute('role', 'status');
  gateNotice.hidden = true;
  feedback.append(gateNotice);
  // Dialogue lines are announced here: a live region that exists before its text changes is announced reliably.
  const announcer = document.createElement('div');
  announcer.className = 'wc-sr';
  announcer.setAttribute('role', 'status');
  announcer.setAttribute('aria-live', 'polite');
  feedback.append(announcer);
  let announced = '';
  root.append(feedback);
  let gateContact = false;
  function syncGateNotice(): void {
    const message = gateContact && vm?.screen === 'game' ? gateContactMessage(vm.hud) : null;
    gateNotice.hidden = message === null;
    if (message !== null && gateNotice.textContent !== message) gateNotice.textContent = message;
  }
  // The companion command wheel and command notices live here too: wheel gestures patch this host in place and never rebuild the HUD.
  const wheelHost = document.createElement('div');
  wheelHost.className = 'wc-wheel-host';
  wheelHost.hidden = true;
  feedback.append(wheelHost);
  const commandNotice = document.createElement('p');
  commandNotice.className = 'wc-panel wc-command-notice';
  commandNotice.setAttribute('role', 'status');
  commandNotice.hidden = true;
  feedback.append(commandNotice);
  let noticeTimer = 0;
  let wheelSignature = '';
  let wheelOpen = false;
  let wheelSector: number | null = null;
  function notify(message: string): void {
    if (destroyed) return;
    window.clearTimeout(noticeTimer);
    commandNotice.textContent = message;
    commandNotice.hidden = message === '';
    if (message) noticeTimer = window.setTimeout(() => { commandNotice.hidden = true; }, 3200);
  }
  function syncWheel(next: GameViewModel): void {
    const wheel = next.screen === 'game' && !next.scene?.establishingShot ? next.wheel : undefined;
    wheelOpen = Boolean(wheel?.open);
    wheelSector = wheel?.selectedSector ?? null;
    if (!wheel?.open) {
      if (!wheelHost.hidden) { wheelHost.hidden = true; wheelHost.replaceChildren(); wheelSignature = ''; }
      return;
    }
    const signature = JSON.stringify(wheel);
    if (signature === wheelSignature) return;
    wheelSignature = signature;
    const staging = document.createElement('div');
    staging.innerHTML = wheelMarkup(wheel);
    if (wheelHost.hidden) { wheelHost.hidden = false; wheelHost.replaceChildren(...staging.childNodes); }
    else morphChildren(wheelHost, staging);
  }
  let vm: GameViewModel | null = null;
  let lastRenderSignature = '';
  let destroyed = false;
  let focusedIndex = 0;
  let keyListener: ((event: KeyboardEvent) => void) | null = null;
  let lastGamepadButtons = new Set<number>();
  let selectedCompanion: CompanionId | null = null;
  let previewCleanup: (() => void) | null = null;
  /** Active title-stage diorama and its release callback; null while the title screen is hidden. */
  let titleStageCleanup: (() => void) | null = null;
  /** Hover/focus inspection of the map-select regions; rebound whenever the screen's markup is replaced. */
  let mapSelectCleanup: (() => void) | null = null;
  let pendingPreviewCleanups: (() => void)[] = [];
  // Hero-select stage: UI-local browsing state; only the final choice is dispatched.
  let heroFocus: HeroId = HEROES[0]!.id;
  let heroTab: HeroTab = 'role';
  let heroSkillIndex: number | null = null;
  let heroPanelSlide: 'none' | 'fade' | 'next' | 'prev' = 'none';
  let heroPreview: HeroPreviewController | null = null;
  let pointerControl: HTMLElement | null = null;
  let releasedPointerControl: HTMLElement | null = null;
  let deferredViewModel: GameViewModel | null = null;
  let deferredRenderFrame = 0;
  const onPointerDown = (event: PointerEvent) => {
    const target = event.target;
    if (event.button !== 0 || !(target instanceof Element)) return;
    pointerControl = target.closest<HTMLElement>('button[data-ui-action],input[data-focus-key],select[data-focus-key]');
    releasedPointerControl = null;
  };
  const onPointerEnd = (event: PointerEvent) => {
    if (!pointerControl) return;
    if (event.type === 'pointerup') releasedPointerControl = pointerControl;
    pointerControl = null;
    if (deferredViewModel && !deferredRenderFrame) {
      deferredRenderFrame = requestAnimationFrame(() => {
        deferredRenderFrame = 0;
        const pending = deferredViewModel;
        deferredViewModel = null;
        if (pending) render(pending);
      });
    }
  };

  let mapPan = { x: 0, y: 0 };
  /** Map screen view: the survey sheet of the current region, or the illustrated world of Erya. */
  let mapView: 'area' | 'world' = 'area';
  const dispatch = (action: UIAction) => options.onAction(action);
  const toolbar = (active: Screen, pause = false) => `
    <nav class="wc-tabs" aria-label="Game menu">
      ${vm?.canOpenWorldPanels ? button('Map', 'map', `aria-current="${active === 'map' ? 'page' : 'false'}"`) : ''}
      ${vm?.canOpenWorldPanels ? button('Journal', 'journal', `aria-current="${active === 'journal' ? 'page' : 'false'}"`) : ''}
      ${vm?.canOpenWorldPanels ? button('Companions', 'companions', `aria-current="${active === 'companions' ? 'page' : 'false'}"`) : ''}
      ${vm?.canOpenWorldPanels && vm.hub ? button('Hub', 'open-hub', `aria-current="${active === 'hub' ? 'page' : 'false'}"`) : ''}
      ${button('Settings', 'settings', `aria-current="${active === 'settings' ? 'page' : 'false'}"`)}
      ${pause && vm?.canOpenWorldPanels ? button('Resume', 'resume', '', 'wc-action--quiet') : ''}
    </nav>`;
  /** Where the player is, set once in the bar instead of a label above every screen heading. */
  const location = () => vm?.campaign ? `${activeRegionName(vm)} · ${vm.campaign.chapter === 0 ? 'Prologue' : 'Chapter ' + vm.campaign.chapter}` : '';
  const wordmark = (screen: Screen, pause = false) => `<header class="wc-menu__bar"><div class="wc-wordmark"><span>${esc(playerCopy.title.name)}</span>${location() ? `<small>${esc(location())}</small>` : ''}</div>${toolbar(screen, pause)}</header>`;
  const backButton = () => button('Esc&nbsp;&nbsp; Back', 'close', 'aria-label="Back"', 'wc-action--quiet');
  const containerScreen = (className: string, content: string) => `<section class="wc-screen ${className}">${content}</section>`;

  /** The quest and objective the HUD shows when no chapter objective HUD exists: the same answer the Journal gives. */
  function currentObjective() {
    const log = vm?.questLog;
    const quest = log?.active.find(entry => entry.id === log.currentQuestId) ?? null;
    return { quest, objective: quest?.objectives.find(step => step.id === log?.currentObjectiveId) ?? null };
  }

  function playerHud(): string {
    if (!vm) return '';
    const { hud, campaign } = vm;
    const party = vm.party ?? campaign?.party ?? null;
    const { quest, objective } = currentObjective();
    const boss = hud.boss;
    const encounter = hud.encounterStatus;
    const trial = encounter?.trial;
    const activeMonster = encounter?.monsters.find(monster => monster.active);
    const controlsHint = controlHints(vm);
    const companions: CompanionId[] = party?.companionId ? [party.companionId] : [];
    const portraitClass = (id: CompanionId) => COMPANIONS.find(x => x.id === id)?.portrait ?? id;
    const hero = heroById(hud.heroId ?? 'aren');
    return containerScreen('wc-screen--game', `<div class="wc-hud" data-hero="${hero.id}" style="--wc-hero-accent:${esc(hero.accent)}" aria-label="Exploration and combat HUD">
      <section class="wc-panel wc-vitals" aria-label="${esc(hero.name)}'s resources">
        <div class="wc-vitals__identity">${heroCrest(hero, 'wc-hero-crest')}<div><div class="wc-vitals__name">${esc(hero.name.toUpperCase())}</div><div class="wc-vitals__title">${esc(hero.title)}</div></div></div>
        ${meter(playerCopy.hud.vitality, hud.vitality, hud.maxVitality, 'vitality', playerCopy.hud.vitality_description)}
        ${meter(playerCopy.hud.mana, hud.mana, hud.maxMana, 'mana', playerCopy.hud.mana_description)}
        <p class="wc-mana-value">${Math.floor(hud.mana)} / ${hud.maxMana} <span>${esc(playerCopy.hud.mana_empty)}</span></p>
        ${meter(playerCopy.hud.instinct, hud.instinct, 100, 'instinct', playerCopy.hud.instinct_description)}
      </section>
      ${boss && !trial ? `<section class="wc-panel wc-boss" aria-label="Boss status"><p class="wc-boss__title">${boss.actorId === 'asha' ? 'ASHA — THE BROKEN FANG' : esc(boss.actorId.toString().replaceAll('-', ' ').toUpperCase())}</p>${meter(playerCopy.hud.ferocity, boss.ferocity, boss.maxFerocity, 'ferocity', playerCopy.hud.ferocity_description)}${meter(playerCopy.hud.corruption, boss.corruption, 100, 'corruption', playerCopy.hud.corruption_description)}<div class="wc-boss__cores">${boss.exposed ? playerCopy.hud.corruption_exposed : ''}</div></section>` : ''}
      ${encounter ? `<aside class="wc-panel wc-encounter" aria-label="Combat stage"><h2>${esc(encounter.title)}</h2>${encounter.step && !trial ? encounterStepMarkup(vm, encounter.step) : ''}
        ${trial ? `<div class="wc-trial-progress" data-trial-status="${trial.status}"><strong>${trial.complete ? 'All gates open' : `Stage ${trial.stage} / ${trial.totalStages} · Defeat the monster`}</strong>
          ${trial.complete ? `<p>Reach the ${esc(vm.playtestStage?.exitName ?? 'exit')} waystone.</p>` : ''}</div>` : ''}
        ${activeMonster ? `<div class="wc-encounter__monster"><strong>${esc(activeMonster.name)}</strong>${activeMonster.boss || trial?.boss ? BOSS_CHIP : ''}${monsterHealth(activeMonster.name, activeMonster.vitality, activeMonster.maxVitality, Boolean(activeMonster.boss || trial?.boss))}<p title="${esc(activeMonster.skills.join(' · '))}">${esc(activeMonster.skills.join(' · '))}</p></div>` : ''}</aside>` : ''}
      ${vm.hud.target?.weakPointExposed ? `<aside class="wc-panel wc-target-exposure" role="status"><strong>${esc(vm.hud.target.id.toString().replaceAll('-', ' ').toUpperCase())}</strong><span>WEAK POINT EXPOSED</span></aside>` : ''}
      ${vm.objectiveHud && !boss && !encounter ? objectiveHudMarkup(vm.objectiveHud, controlBindingLabel(vm, 'interact')) : objective && !boss && !encounter ? `<aside class="wc-panel wc-objective"><strong>${esc(quest?.title ?? 'Current objective')}</strong><p>${esc(objective.title)}</p></aside>` : ''}
      ${vm.chapterAct?.actTwoNotice ? `<aside class="wc-panel wc-act-notice" role="status"><strong>Act II</strong><p>${esc(vm.chapterAct.actTwoNotice)}</p></aside>` : ''}
      ${vm.wheel ? `<button type="button" class="wc-wheel-open" data-ui-action="wheel-open" data-focus-key="wheel-open" aria-label="Open companion command wheel"><kbd>${esc(controlBindingLabel(vm, 'commandWheel'))}</kbd> Command</button>` : ''}
      ${boss && !encounter ? `<div class="wc-brand-mark">${esc(playerCopy.title.name)}</div>` : ''}
      ${interactionPrompt(vm)}
      ${hud.destination ? `<aside class="wc-panel wc-destination" aria-label="Stage destination"><svg viewBox="0 0 24 24" aria-hidden="true" style="transform:rotate(${hud.destination.bearingDegrees}deg)"><path d="M12 2 21 21 12 16 3 21Z" fill="currentColor"/></svg><div><strong>${esc(hud.destination.label)}</strong><p>Follow the trail · ${Math.ceil(hud.destination.distanceMeters)} m</p></div></aside>` : ''}
      <div class="wc-party-hud" aria-label="Traveling companions">${companions.map(id => `<div class="wc-party-hud__item"><span class="wc-portrait wc-portrait--${portraitClass(id)}" ${PORTRAIT_ASSETS[id] ? `style="background-image:url('${PORTRAIT_ASSETS[id]}')"` : ''} role="img" aria-label="${esc(COMPANIONS.find(x => x.id === id)?.name ?? id)} portrait"></span><span>${esc(COMPANIONS.find(x => x.id === id)?.name ?? id)}</span></div>`).join('')}</div>
      <section class="wc-skill-bar" aria-label="Player skills">${hud.skills.map(skill => `<div class="wc-skill" data-skill="${esc(skill.id)}" data-ready="${skill.available}" aria-disabled="${!skill.available}" title="${esc(skill.label)} — ${esc(skill.reason)} — ${skill.id === 'judgement' ? 'full Instinct' : skill.manaCost + ' mana'}"><div><kbd>${esc(controlBindingLabel(vm!, skill.binding))}</kbd><span>${skillCardCost(skill)}</span></div><strong>${esc(skill.label)}</strong><small>${esc(skill.reason)}</small></div>`).join('')}</section>
      ${hubPracticeHudMarkup(vm)}
      ${controlsHint ? `<span class="wc-controls-hint">${esc(controlsHint)}</span>` : ''}
      ${vm.tutorial ? tutorialMarkup(vm, vm.tutorial) : ''}
    </div>`);
  }

  const titleLetters = (word: string, start: number) =>
    Array.from(word).map((char, index) => `<span class="wc-title__letter" style="--i:${start + index}">${esc(char)}</span>`).join('');
  function titleState(): string {
    return containerScreen('wc-state wc-title', `${reducedMotion ? '' : atmosphereMarkup('fireflies')}<div class="wc-title-stage-host" data-title-stage="true" data-title-stage-state="loading" aria-hidden="true"><div class="wc-title-stage-placeholder" data-title-stage-placeholder>Preparing the world…</div></div><section class="wc-panel wc-state__card wc-title__card"><svg class="wc-title__crest" viewBox="0 0 64 44" aria-hidden="true" focusable="false"><path pathLength="1" d="M5 36 9 11l14 12L32 5l9 18 14-12 4 25Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path pathLength="1" d="M7 41h50" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><h1 class="wc-state__title wc-title__name" aria-label="Wild Crown"><span class="wc-title__word" aria-hidden="true">${titleLetters('WILD', 0)}</span><span class="wc-title__word" aria-hidden="true">${titleLetters('CROWN', 5)}</span></h1><p class="wc-title__subtitle">The Broken Pact</p><p class="wc-state__copy">Walk with the living world of Erya. Every bond is freely chosen, and every path leaves a mark.</p>${vm?.error ? `<p class="wc-error" role="alert">${esc(vm.error.message)}</p>` : ''}<div class="wc-stack">
      ${button(playerCopy.title.new_game, 'new-game', '', 'wc-action--primary')}
      ${vm?.session?.devModes ? `${button('Chapters (Candidate Assets)', 'enter-mode', 'data-mode="chapters"')}${button('Trials (Candidate Assets)', 'enter-mode', 'data-mode="trials"')}` : ''}
      ${button(playerCopy.title.continue, 'continue', vm?.saves.continueSlotId ? '' : 'disabled')}${button(playerCopy.title.load_game, 'load-screen')}
      ${button(playerCopy.title.settings, 'settings')}
      ${button(playerCopy.title.credits, 'credits')}
    </div><p class="wc-label">Single-player story adventure · English</p></section>`);
  }

  function mapSelectState(): string {
    const selection = vm?.playtestSelection;
    if (!selection) return '';
    return containerScreen('wc-state wc-selection', worldMapSelectMarkup({ maps: selection.maps, selectedMapId: selection.selectedMapId, reducedMotion }));
  }

  function heroPanel(hero: HeroDefinition): string {
    if (heroTab === 'stats') return `<ul class="wc-hero-ratings" aria-label="Playstyle ratings">${hero.ratings.map(rating => `<li><span>${esc(rating.label)}</span><span class="wc-rating" role="img" aria-label="${esc(rating.label)}: ${rating.value} of 5">${[1, 2, 3, 4, 5].map(level => `<i data-on="${level <= rating.value}"></i>`).join('')}</span></li>`).join('')}</ul>
      <p class="wc-hero-note">Ratings compare all heroes. The table lists live combat values.</p>
      <table class="wc-hero-stats"><tbody>${hero.stats.map(stat => `<tr><th scope="row">${esc(stat.label)}</th><td>${esc(stat.value)}</td></tr>`).join('')}</tbody></table>`;
    if (heroTab === 'skills') return `<p class="wc-hero-note">Choose a skill to watch ${esc(hero.name)} perform it.</p><ol class="wc-hero-skill-list">${hero.skills.map((skill, index) => `<li><button type="button" class="wc-hero-skill" data-ui-action="hero-skill" data-skill="${index}" data-focus-key="hero-skill-${hero.id}-${index}" aria-pressed="${heroSkillIndex === index}">
        <kbd>${esc(vm ? controlBindingLabel(vm, skill.action) || skill.action : skill.action)}</kbd><span class="wc-hero-skill__name">${esc(skill.name)}</span><span class="wc-hero-skill__cost">${esc(skill.cost)}</span>
        <span class="wc-hero-skill__desc">${esc(skill.description)}</span><span class="wc-hero-skill__detail">${esc(skill.detail)}</span></button></li>`).join('')}</ol>`;
    if (heroTab === 'story') return `${hero.biography.map(paragraph => `<p class="wc-hero-prose">${esc(paragraph)}</p>`).join('')}<figure class="wc-hero-quote"><blockquote>${esc(hero.quote.text)}</blockquote><figcaption>${esc(hero.quote.speaker)}</figcaption></figure>`;
    return `<dl class="wc-hero-facts">${[['Role', hero.role], ['Power', hero.power], ['Reach', hero.reach], ['Difficulty', hero.difficulty]].map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>
      <p class="wc-hero-prose">${esc(hero.playstyle)}</p>
      <div class="wc-hero-traits"><section><h3>Strengths</h3><ul>${hero.strengths.map(item => `<li>${esc(item)}</li>`).join('')}</ul></section><section data-trait="caution"><h3>Watch for</h3><ul>${hero.cautions.map(item => `<li>${esc(item)}</li>`).join('')}</ul></section></div>`;
  }

  function heroSelectState(): string {
    if (!vm) return '';
    const selection = vm?.playtestSelection;
    const chapters = vm?.session?.kind === 'chapters';
    if (!selection && !chapters) return '';
    const map = selection?.maps.find(item => item.id === selection.selectedMapId);
    const hero = heroById(heroFocus);
    const skill = heroSkillIndex === null ? undefined : hero.skills[heroSkillIndex];
    const companionId = vm.settings.heroCompanions[hero.id];
    const companion = COMPANIONS.find(candidate => candidate.id === companionId)!;
    const support = COMPANION_SPECIALIZATIONS[companionId];
    return containerScreen('wc-hero-select', `<div class="wc-hero-select__frame" data-hero="${hero.id}" style="--wc-hero-accent:${esc(hero.accent)}">
      <header class="wc-hero-select__head"><h1 class="wc-hero-select__title">Choose your hero &amp; companion</h1><p>${esc(chapters ? 'Candidate Journey · Act I' : map?.name ?? '')} · One hero, one companion. Each hero remembers their own choice.</p></header>
      <div class="wc-hero-rosters"><nav class="wc-hero-roster" aria-label="Heroes">${HEROES.map(candidate => `<button type="button" class="wc-hero-pick" data-ui-action="hero-focus" data-hero="${candidate.id}" data-focus-key="hero-focus-${candidate.id}" aria-pressed="${candidate.id === hero.id}" style="--wc-hero-accent:${esc(candidate.accent)}">
        ${heroCrest(candidate, 'wc-hero-pick__portrait')}<span class="wc-hero-pick__text"><strong>${esc(candidate.name)}</strong><span>${esc(candidate.title)}</span><span>${esc(candidate.role)}</span></span></button>`).join('')}</nav>
      <section class="wc-hero-companion" aria-label="Companion for ${esc(hero.name)}"><h2>Companion <span>1 / 1</span></h2>
        <div class="wc-hero-companion__choices">${COMPANIONS.map(candidate => {
          const role = COMPANION_SPECIALIZATIONS[candidate.id];
          return `<button type="button" class="wc-companion-pick" data-ui-action="select-hero-companion" data-hero="${hero.id}" data-companion="${candidate.id}" data-element="${role.element}" data-focus-key="hero-companion-${candidate.id}" aria-pressed="${candidate.id === companionId}" aria-label="${esc(candidate.name + ' · ' + role.role + ' · ' + role.element)}"><span class="wc-portrait wc-companion-pick__portrait" style="background-image:url('${PORTRAIT_ASSETS[candidate.id]}')" aria-hidden="true"></span><strong>${esc(candidate.name)}</strong><small>${esc(role.role)}</small></button>`;
        }).join('')}</div>
        <p class="wc-hero-companion__selected" aria-live="polite"><strong>${esc(companion.name)}</strong> · ${esc(support.role)} <span class="wc-element" data-element="${support.element}">${esc(support.element)}</span></p>
        <p class="wc-hero-companion__note">Saved for ${esc(hero.name)}. Replace outside encounters.</p>
      </section></div>
      <div class="wc-hero-stage" role="group" aria-label="Live 3D preview of ${esc(hero.name)}">
        <div class="wc-preview-host wc-hero-stage__view" data-preview-host data-hero-preview="true"><div class="wc-preview-empty" data-preview-placeholder>Bringing ${esc(hero.name)} forward…</div></div>
        <p class="wc-hero-stage__caption"><span aria-live="polite">${esc(skill ? 'Showing ' + skill.name : hero.name + ' at rest')}</span><span>Drag to turn</span></p>
      </div>
      <article class="wc-hero-dossier" aria-labelledby="wc-hero-name">
        <h2 id="wc-hero-name" class="wc-hero-dossier__name">${esc(hero.name)}</h2>
        <p class="wc-hero-dossier__title">${esc(hero.title)}</p>
        <p class="wc-hero-dossier__summary">${esc(hero.summary)}</p>
        <div class="wc-hero-tabs" role="tablist" aria-label="${esc(hero.name)} details">${HERO_TABS.map(tab => `<button type="button" role="tab" id="wc-hero-tab-${tab.id}" class="wc-hero-tab" data-ui-action="hero-tab" data-tab="${tab.id}" data-focus-key="hero-tab-${tab.id}" aria-selected="${tab.id === heroTab}" aria-controls="wc-hero-panel">${esc(tab.label)}</button>`).join('')}</div>
        <div id="wc-hero-panel" class="wc-hero-panel" data-slide="${heroPanelSlide}" role="tabpanel" aria-labelledby="wc-hero-tab-${heroTab}" tabindex="0">${heroPanel(hero)}</div>
      </article>
      <footer class="wc-hero-select__foot">${button(chapters ? 'Back' : 'Back to Maps', 'map-select')}<p>Arrow keys browse · Enter chooses · Esc goes back</p>${button(`Begin with ${hero.name} & ${companion.name}`, 'select-hero', `data-hero="${hero.id}" data-companion="${companionId}"`, 'wc-action--primary')}</footer>
    </div>`);
  }

  /** DEV Candidate Chapters entry: New / Continue / Load Journey, with the newest candidate slot described. */
  function chaptersMenuState(): string {
    const slot = vm!.saves.slots.find(item => item.slotId === vm!.saves.continueSlotId) ?? vm!.saves.slots[0];
    const latest = slot ? slotDescription(slot, slot.heroId ? heroById(slot.heroId).name : null, checkpointLabel(slot.checkpointId)) : null;
    return containerScreen('wc-state wc-chapters', chaptersMenuMarkup(vm!, latest));
  }

  /** Loading scene of the selected region; the error and its recovery actions go inside the scene's action slot. */
  function loadingState(): string {
    const loading = vm!.loading;
    const error = vm!.error;
    const regionId = vm!.scene?.regionId ?? 'greenwake';
    const loreCount = REGION_PRESENTATION[regionId].loadingLore.length;
    const progress = typeof loading.progress === 'number' ? clamp(loading.progress) : null;
    // Saving and loading campaign slots are rejected in local playtests, so recovery never offers them there.
    const playtest = Boolean(vm!.playtestSelection);
    const actionMarkup = loadingErrorActions(error, loading.operationId, Boolean(vm!.campaign) && !playtest)
      .filter(action => !playtest || action.type !== 'load-screen')
      .map(action => {
        if (action.type === 'retry-load') return button('Retry', 'retry-load', 'data-operation-id="' + esc(action.operationId) + '"', 'wc-action--primary');
        if (action.type === 'save-screen') return button('Save Game', 'save-screen');
        if (action.type === 'load-screen') return button('Load Game', 'load-screen');
        if (action.type === 'open-settings') return button('Settings', 'open-settings');
        return button('Return to Title', 'return-title', '', 'wc-action--quiet');
      }).join('');
    const scene = loadingSceneMarkup({
      regionId,
      label: loading.label || 'Loading Wild Crown...',
      progress,
      phaseLabel: loading.detail?.phaseLabel ?? (error ? 'Loading stopped' : 'Preparing the forest'),
      detail: loading.detail?.message ?? '',
      // Deterministic lore rotation: the line follows real progress, so there are no timers.
      loreIndex: progress === null ? 0 : Math.min(loreCount - 1, Math.floor(progress * loreCount)),
      reducedMotion,
    });
    const actions = error ? `<p class="wc-error" role="alert">${esc(error.message)}</p>${actionMarkup}` : '';
    return containerScreen('wc-screen--scene', scene.replace(/(data-scene-actions[^>]*>)(<\/div>)/, (_match, open: string, close: string) => open + actions + close));
  }

  function mapIntroState(): string {
    const scene = vm!.scene;
    return containerScreen('wc-screen--scene', mapIntroMarkup({ regionId: scene?.regionId ?? 'greenwake', heroName: scene?.heroName ?? 'Your hero', reducedMotion }));
  }

  /** Letterboxed region title shown while the establishing camera sweep runs; the whole overlay and its hint skip the shot. */
  function shotState(): string {
    const regionId = vm!.scene?.regionId ?? 'greenwake';
    const presentation = REGION_PRESENTATION[regionId];
    return `<section class="wc-screen wc-shot" data-ui-action="skip-establishing" data-region="${esc(regionId)}" style="--wc-shot-accent:${esc(presentation.palette.accent)}" role="group" aria-label="${esc(presentation.title)}">
      <div class="wc-shot__bar wc-shot__bar--top" aria-hidden="true"></div><div class="wc-shot__bar wc-shot__bar--bottom" aria-hidden="true"></div>
      <div class="wc-shot__title"><h1>${esc(presentation.title)}</h1><p class="wc-shot__chapter">${esc(presentation.chapterLabel)}</p><p class="wc-shot__tagline">${esc(presentation.tagline)}</p></div>
      <button type="button" class="wc-shot__skip" data-ui-action="skip-establishing" data-focus-key="skip-establishing"><kbd>Space</kbd> Skip</button>
    </section>`;
  }

  function pauseState(): string {
    const hero = vm ? heroById(vm.hud.heroId ?? 'aren') : null;
    const map = vm?.playtestSelection?.maps.find(item => item.id === vm?.playtestSelection?.selectedMapId);
    const chapterContext = vm?.session?.kind === 'chapters' ? [vm.session.saveScope ? scopeLabel(vm.session.saveScope) : '', segmentLabel(vm.session.segmentId)].filter(Boolean).join(' · ') : '';
    const context = hero ? `<p class="wc-pause__context">${heroCrest(hero, 'wc-hero-crest')}<span>${esc([map?.name, chapterContext, `${hero.name}, ${hero.title}`].filter(Boolean).join(' · '))}</span></p>` : '';
    // Local asset playtests never write campaign saves, so the controls stay visible but disabled, with the reason.
    const savesAvailable = !vm?.playtestSelection;
    const saveControls = savesAvailable
      ? `${button('Save Game', 'save-screen')}${button('Load Game', 'load-screen')}`
      : `${button('Save Game', 'save-screen', 'disabled aria-describedby="wc-pause-saves"')}${button('Load Game', 'load-screen', 'disabled aria-describedby="wc-pause-saves"')}`;
    const checkpointNote = vm?.session?.kind === 'chapters' && vm.session.checkpointName ? `<p class="wc-pause__note" id="wc-pause-checkpoint">Saved at ${esc(vm.session.checkpointName)}. Unfinished encounters restart here.</p>` : '';
    const savesNote = (savesAvailable ? '' : '<p class="wc-pause__note" id="wc-pause-saves">Local asset playtests do not write campaign saves, so saving and loading are unavailable here.</p>') + checkpointNote;
    const card = `<section class="wc-panel wc-sheet wc-state__card"><h1 class="wc-heading">Paused</h1>${context}<p class="wc-state__copy">The world holds still until you return.</p><div class="wc-actions">${button('Resume', 'resume', '', 'wc-action--primary')}${vm?.hub ? button('Hub Services', 'open-hub') : ''}${saveControls}${button('Return to Title', 'title-screen')}</div>${savesNote}</section>`;
    return containerScreen('wc-state wc-pause', card);
  }

  function mapState(): string {
    if (!vm) return '';
    const area = vm.areaMap;
    const view = area ? mapView : 'world';
    const log = vm.questLog;
    const current = log?.active.find(entry => entry.id === log.currentQuestId);
    const destination = vm.map.regions.find(region => region.id !== vm!.map.currentRegion && region.unlocked && region.entrances.some(entrance => entrance.unlocked));
    const regions = REGION_ORDER.map(id => {
      const region = vm!.map.regions.find(x => x.id === id);
      if (!region) return '';
      const reachable = region.unlocked && region.entrances.some(entrance => entrance.unlocked);
      const here = region.id === vm!.map.currentRegion;
      return `<button class="wc-region-chip" type="button" data-ui-action="travel" data-focus-key="region-${esc(region.id)}" data-region="${esc(region.id)}" data-here="${here}" data-entrance="${esc(region.entrances.find(entrance => entrance.unlocked)?.id ?? '')}" ${reachable ? '' : 'disabled'} aria-label="${esc(region.name)}${here ? ', you are here' : region.unlocked ? '' : ', locked'}" title="${esc(region.name)}">${icon(here ? 'pin' : region.unlocked ? 'exit' : 'lock')}</button>`;
    }).join('');
    const sheet = view === 'area' && area
      ? `${areaMapMarkup(area)}${areaLegendMarkup(area)}`
      : `<div class="wc-map-art"><img class="wc-map-art__image" src="${mapArt}" alt="Illustrated world map of Erya with its named regions and Heartroot Hollow beneath the Grove"><div class="wc-map-regions" aria-label="Regions of Erya">${regions}</div></div><ul class="wc-legend" aria-label="Map legend"><li data-kind="current">${icon('pin')}You are here</li><li>${icon('exit')}Reachable region</li><li>${icon('lock')}Locked region</li></ul>`;
    const viewSwitch = area ? `<div class="wc-segmented" role="group" aria-label="Map view">${button('Area', 'map-view', `data-view="area" aria-pressed="${view === 'area'}"`)}${button('World', 'map-view', `data-view="world" aria-pressed="${view === 'world'}"`)}</div>` : '';
    return containerScreen('wc-menu', `${wordmark('map')}<div class="wc-menu__body wc-survey">
      <section class="wc-sheet wc-survey__map" aria-labelledby="wc-map-title"><header class="wc-sheet__head"><h1 id="wc-map-title" class="wc-heading">${esc(view === 'area' && area ? area.regionName : 'Erya')}</h1>${area?.player && view === 'area' ? `<p class="wc-meta">You are in <span class="wc-grid-ref">${esc(area.player.grid)}</span></p>` : ''}${viewSwitch}</header>${sheet}</section>
      <aside class="wc-sheet wc-survey__side">${currentObjectiveMarkup(log, area)}${current ? `<section class="wc-steps-block" aria-label="${esc(current.title)} steps"><h3>${esc(current.title)}</h3>${questStepsMarkup(current, area, vm.trackedObjectiveId, true)}</section>` : ''}${exitsMarkup(vm.chapterAct)}${destination ? button(`Travel to ${esc(destination.name)}`, 'travel', `data-region="${esc(destination.id)}"`, 'wc-action--primary') : ''}</aside>
      </div><footer class="wc-map-footer"><span>Esc&nbsp; Back</span><span>${view === 'world' ? 'W A S D&nbsp; Pan map' : 'Route follows the trails to your objective'}</span><span>${esc(activeRegionName(vm))}</span></footer>`);
  }

  function canAcceptSideQuest(quest: QuestDefinition): boolean {
    const campaign = vm?.campaign;
    return !!campaign && quest.optional && quest.chapter <= campaign.chapter
      && !campaign.activeQuestIds.includes(quest.id) && !campaign.completedQuestIds.includes(quest.id)
      && (campaign.regionId === quest.region || campaign.worldFacts[`visited:${quest.region}`] === true)
      && quest.prerequisites.every(requirement =>
        requirement.startsWith('quest:') ? campaign.completedQuestIds.includes(requirement.slice(6))
          : !requirement.startsWith('region:') || campaign.regionId === requirement.slice(7) || campaign.worldFacts[`visited:${requirement.slice(7)}`] === true);
  }

  function journalState(): string {
    if (!vm) return '';
    const log = vm.questLog;
    const area = vm.areaMap;
    const story = log?.active.find(entry => !entry.optional) ?? log?.active[0];
    const available = vm.journal.quests.filter(canAcceptSideQuest);
    const entry = (quest: NonNullable<typeof log>['active'][number]) => `<article class="wc-log-entry" data-current="${quest.id === log?.currentQuestId}"><header><h3>${esc(quest.title)}</h3><span class="wc-tag" data-tone="${quest.optional ? 'side' : 'main'}">${quest.optional ? 'Side quest' : 'Main story'}</span></header><p class="wc-lore">${esc(quest.description)}</p>${questStepsMarkup(quest, area, vm!.trackedObjectiveId, true)}</article>`;
    const completed = log?.completed ?? [];
    return containerScreen('wc-menu', `${wordmark('journal')}<div class="wc-menu__body wc-journal">
      <section class="wc-sheet wc-journal__now" aria-labelledby="wc-journal-title"><h1 id="wc-journal-title" class="wc-heading">Journal</h1>${currentObjectiveMarkup(log, area)}
        <section class="wc-journal__block"><h2>The story so far</h2><p class="wc-lore">${esc(story?.description ?? 'Your journey has not begun.')}</p></section>
        <section class="wc-journal__block"><h2>Side quests</h2>${available.length ? `<p class="wc-meta">Offered in regions you have visited.</p><div class="wc-actions">${available.map(quest => button(`Accept ${quest.title}`, 'accept-quest', `data-quest="${esc(quest.id)}"`)).join('')}</div>` : '<p class="wc-meta">No side quests are waiting in the regions you have visited.</p>'}</section>
        <section class="wc-journal__block"><h2>The world</h2><p class="wc-meta">${vm.campaign?.fragments.length ?? 0} Heartroot fragment${vm.campaign?.fragments.length === 1 ? '' : 's'} received.</p></section>
      </section>
      <section class="wc-sheet wc-journal__log" aria-labelledby="wc-log-title"><h2 id="wc-log-title" class="wc-heading">Quest log</h2>${log?.active.length ? log.active.map(entry).join('') : '<p class="wc-meta">Your quests will be written here as they begin.</p>'}${completed.length ? `<details class="wc-log-done"><summary>Completed · ${completed.length}</summary><ul>${completed.map(quest => `<li>${icon('check')}<span>${esc(quest.title)}</span></li>`).join('')}</ul></details>` : ''}</section>
      </div><footer class="wc-map-footer"><span>Esc&nbsp; Back</span><span>Track a step to follow it on the map</span><span>Journal</span></footer>`);
  }

  function selectedCompanionId(): CompanionId {
    return selectedCompanion ?? vm?.party?.companionId ?? 'vara';
  }

  const inspectCard = (companion: (typeof COMPANIONS)[number], pressed: boolean, label: string) =>
    `<button type="button" class="wc-party-card" data-ui-action="inspect-companion" data-focus-key="companion-${companion.id}" data-companion="${companion.id}" aria-pressed="${pressed}"><span class="wc-portrait wc-party-card__portrait wc-portrait--${companion.portrait}" ${PORTRAIT_ASSETS[companion.id] ? `style="background-image:url('${PORTRAIT_ASSETS[companion.id]}')"` : ''} role="img" aria-label="${companion.name} portrait"></span><strong>${companion.name}</strong><small>${label}</small></button>`;
  function companionState(): string {
    if (!vm) return '';
    const party = vm.party ?? vm.campaign?.party ?? null;
    const selected = selectedCompanionId();
    const definition = selected ? COMPANIONS.find(item => item.id === selected) : null;
    const abilities = vm.abilities.filter(ability => ability.companionId === selected);
    const roster = COMPANIONS.map(companion => {
      const role = `${companion.id === party?.companionId ? 'EQUIPPED' : 'RESERVE'} · ${COMPANION_SPECIALIZATIONS[companion.id].role}`;
      return inspectCard(companion, selected === companion.id, role);
    }).join('');
    const skillRows = abilities.map((ability, index) => `<article class="wc-ability">
      <span class="wc-ability__mark" aria-hidden="true">${icon(ABILITY_ICONS[index % ABILITY_ICONS.length] ?? 'leaf')}</span>
      <div><h3>${esc(ability.label)}${ability.element ? ` <span class="wc-element" data-element="${ability.element}">${esc(ability.element)}</span>` : ''}</h3><p>${esc(ability.description ?? '')}</p>
      <p class="wc-meta">${esc(ability.automatic ?? '')}</p>
      <p class="wc-skill-status">${ability.tokenCost ? `${ability.tokenCost} command token` : 'Free'} · ${ability.cooldownSeconds ? `${ability.cooldownSeconds}s cooldown` : ability.available ? 'Ready' : esc(ability.reason ?? 'Equip this companion')}</p>
      <div class="wc-actions"><button type="button" class="wc-action" data-ui-action="preview-skill" data-focus-key="preview-skill-${esc(ability.id)}" data-ability="${esc(ability.id)}" aria-label="Preview ${esc(ability.label)} animation and VFX">Preview animation + VFX</button><button type="button" class="wc-action" data-ui-action="ability" data-focus-key="ability-${esc(ability.id)}" data-ability="${esc(ability.id)}" aria-label="Use ${esc(ability.label)} and return to game" ${ability.available ? '' : 'disabled'}>Use now · return to game</button></div>
      </div></article>`).join('');
    return containerScreen('wc-menu', `${wordmark('companions')}<div class="wc-companions">
      <div class="wc-preview-host" data-preview-host data-companion="${esc(selected)}" aria-label="Native companion animation preview"><div class="wc-preview-empty" data-preview-placeholder><strong>${esc(definition?.name ?? selected)}</strong><span>Loading native character…</span></div><p class="wc-preview-caption">Animation preview only · no tokens or story progress spent</p></div>
      <aside class="wc-sheet wc-companion-details"><h1 class="wc-heading">Traveling Companions</h1>
      <p>Bring exactly one companion. Each has a distinct support specialty, not a second hero’s damage output. Story choices build Bond independently of roster access.</p>
      <div class="wc-party__grid" aria-label="All companions">${roster}</div>
      ${vm.partyPanel ? partyPanelMarkup(vm.partyPanel) : ''}
      <h2 class="wc-heading">${esc(definition?.name ?? selected)}’s skills</h2>
      <p>Your equipped companion supports you automatically and reserves one command token for your orders. Strong support has its own cooldown; buffs expire and cannot stack by swapping companions. Hold <kbd>${esc(controlBindingLabel(vm, 'commandWheel'))}</kbd> to choose a command and target, then release. <kbd>${esc(controlBindingLabel(vm, 'companions'))}</kbd> opens this panel. “Use now” resumes the game and performs the real action.</p>
      <div class="wc-abilities">${skillRows}</div>
      ${relationshipMeterMarkup(vm.companionProgress?.[selected])}${backButton()}</aside></div>
      <footer class="wc-map-footer"><span>Esc&nbsp; Back</span><span>Choose one companion · preview or command a skill</span><span>Companions</span></footer>`);
  }

  function settingsState(): string {
    if (!vm) return '';
    return containerScreen('wc-menu', wordmark('settings') + '<div class="wc-menu__body">' + settingsMarkup(vm) + (vm.error ? '<p class="wc-error" role="alert">' + esc(vm.error.message) + '</p>' : '') + '</div><footer class="wc-map-footer"><span>Esc&nbsp; Back</span><span>Enter to capture a binding</span><span>Settings</span></footer>');
  }
  /** The spoken line currently on screen, with the speaker's display name. */
  function currentDialogueLine() {
    const beat = vm?.dialogue ? { ...vm.dialogue, choices: vm.choice?.options ?? [] } : undefined;
    const index = beat ? Math.max(0, Math.min(vm!.dialogueLineIndex, beat.lines.length - 1)) : 0;
    const line = beat ? beat.lines[index] : undefined;
    return { beat, line, index, name: line ? speakerName[line.speaker] ?? line.speaker : 'Story' };
  }
  function dialogueState(): string {
    const { beat, line, index, name } = currentDialogueLine();
    const settings = vm!.settings;
    const speakerLabels = settings.subtitleSpeakerLabels !== false;
    const total = beat?.lines.length ?? 0;
    return containerScreen('wc-state wc-dialogue', `<section class="wc-panel wc-state__card wc-dialogue__card" data-size="${esc(settings.subtitleSize ?? 'medium')}" data-background="${esc(settings.subtitleBackground ?? 'translucent')}" aria-labelledby="wc-dialogue-heading"><h1 class="wc-sr" id="wc-dialogue-heading">Dialogue</h1><div class="wc-dialogue__speaker">${line ? speakerCrest(line.speaker) : ''}${speakerLabels ? `<p class="wc-dialogue__name">${esc(name)}</p>` : ''}${total > 1 ? `<p class="wc-dialogue__count" aria-hidden="true">${index + 1} / ${total}</p>` : ''}</div><p class="wc-dialogue-text">${wordGroups(line?.text ?? '', reducedMotion)}</p>${beat?.choices?.length ? `<div class="wc-choice">${beat.choices.map(choice => button(`<strong>${esc(choice.title)}</strong><small>${esc(choice.description)}</small>`, 'choose', `data-choice="${esc(choice.id)}" data-option="${esc(choice.id)}"`)).join('')}</div>` : ''}<div class="wc-actions">${button('Continue', 'dialogue-next', `data-beat="${esc(beat?.next ?? '')}"`, 'wc-action--primary')}${button('Skip Cinematic', 'skip-cinematic')}</div></section>`);
  }

  function choiceState(): string {
    const choice = vm?.choice;
    const pact = Boolean(vm?.dialogueChoice?.required) && /-pact$/.test(choice?.id ?? '');
    const copy = pact ? 'This choice cannot be skipped or undone. It is written into the history of your journey.' : 'Consider the immediate result and the commitment that follows.';
    const options = (choice?.options ?? []).map(option => button(`<strong>${esc(option.title)}</strong><small>${esc(option.description)}</small>${option.irreversible || pact ? '<small class="wc-choice__final">Irreversible</small>' : ''}`, 'choose', `data-choice="${esc(choice?.id)}" data-option="${esc(option.id)}"`, 'wc-action--primary')).join('');
    return containerScreen(pact ? 'wc-state wc-pact' : 'wc-state', `<section class="wc-panel wc-sheet wc-state__card" data-ceremony="${pact}"><h1 class="wc-heading">${esc(choice?.title ?? 'Choose Your Response')}</h1><p class="wc-lore">${pact ? 'The Pact · ' : ''}${copy}</p><div class="wc-choice">${options}</div>${vm?.error ? `<p class="wc-error" role="alert">${esc(vm.error.message)}</p>` : ''}</section>`);
  }

  function endingState(): string {
    const ending = vm?.ending;
    const grove = ending?.grove ? `<p class="wc-state__copy wc-state__copy--grove">${esc(ending.grove)}</p>` : '';
    const lines = (ending?.lines ?? []).map(line => `<p class="wc-state__copy wc-state__copy--line">${esc(line)}</p>`).join('');
    return containerScreen('wc-state wc-ending', `<section class="wc-panel wc-sheet wc-state__card"><h1 class="wc-state__title">${esc(ending?.title ?? 'Epilogue')}</h1><p class="wc-lore">The forest you leave behind</p><p class="wc-dialogue-text">${esc(ending?.summary ?? '')}</p>${grove}<hr class="wc-rule"><h2 class="wc-heading">Epilogue</h2>${lines || '<p class="wc-state__copy">The living world remembers what was chosen.</p>'}<div class="wc-actions">${button('View Credits', 'credits', '', 'wc-action--primary')}${button('Return to Title', 'title-screen')}</div></section>`);
  }

  function stageCompleteState(): string {
    const stage = vm?.playtestStage;
    const selection = vm?.playtestSelection;
    const hero = vm ? heroById(vm.hud.heroId ?? 'aren') : null;
    const next = selection?.nextMapId ? selection.maps.find(item => item.id === selection.nextMapId) : undefined;
    const outcome = `${hero ? `<p class="wc-outcome__hero">${heroCrest(hero, 'wc-hero-crest')}<span>Cleared as ${esc(hero.name)}, ${esc(hero.title)}</span></p>` : ''}${next ? `<p class="wc-outcome__unlock" role="status">New path open: <strong>${esc(next.name)}</strong></p>` : ''}`;
    return containerScreen('wc-state wc-outcome wc-stage-complete', `<section class="wc-panel wc-state__card" aria-labelledby="stage-complete-title"${hero ? ` style="--wc-hero-accent:${esc(hero.accent)}"` : ''}><h1 id="stage-complete-title" class="wc-state__title">Stage Complete</h1><p class="wc-outcome__resolution">${esc(stage?.completeKicker ?? 'STAGE CLEARED')}</p><p class="wc-state__copy">${esc(stage?.completeCopy ?? 'You reached the stage exit.')}</p>${outcome}${selection?.progressWarning ? `<p role="status">${esc(selection.progressWarning)}</p>` : ''}<div class="wc-actions">${next ? button('Next Map', 'select-map', `data-map="${esc(next.id)}"`, 'wc-action--primary') : ''}${button('Play Again', 'new-game')}${selection ? button('Map Select', 'map-select') : ''}${button('Return to Title', 'return-title')}</div></section>`);
  }

  function defeatState(): string {
    const checkpoint = vm?.session?.kind === 'chapters' ? vm.session.checkpointName : null;
    const retry = checkpoint ? button('Retry from checkpoint', 'retry-checkpoint', '', 'wc-action--primary') : button('Try Again', 'new-game', '', 'wc-action--primary');
    const note = checkpoint ? `<p class="wc-state__copy">Your story progress is kept. Resume at ${esc(checkpoint)}; the unfinished encounter restarts.</p>` : '<p class="wc-state__copy">Take a breath. Find another way through.</p>';
    return containerScreen('wc-state wc-outcome wc-defeat', `<section class="wc-panel wc-sheet wc-state__card" aria-labelledby="defeat-title"><h1 id="defeat-title" class="wc-state__title">Defeat</h1><p class="wc-lore">The forest still waits.</p>${note}<div class="wc-actions">${retry}${button('Return to Title', 'return-title')}</div></section>`);
  }

  function saveState(load: boolean): string { return vm ? saveMarkup(vm, load) : ''; }

  function creditsState(): string {
    return containerScreen('wc-state', `<section class="wc-panel wc-sheet wc-state__card"><h1 class="wc-heading">Credits</h1><div class="wc-settings-section"><h2>Created by</h2><p>Hoai-Nho Nguyen</p></div><div class="wc-settings-section"><h2>Story and Game Design · Engineering</h2><p>Wild Crown: The Broken Pact</p></div><p class="wc-lore">Thank you for walking with Erya.</p>${button('Return to Title', 'title-screen', '', 'wc-action--primary')}</section>`);
  }

  function hubState(): string {
    if (!vm || !vm.hub) return '';
    const card = hubMarkup(vm);
    return containerScreen('wc-menu wc-hub-screen', `<div class="wc-menu__body wc-hub-screen__body">${card}</div><footer class="wc-map-footer"><span>Esc&nbsp; Back</span><span>Enter to learn · Up / Down arrows browse</span><span>${esc(vm.hub.name)}</span></footer>`);
  }

  function renderMarkup(key: string): string {
    if (!vm) return '';
    switch (key) {
      case 'title': return titleState();
      case 'chapters-menu': return chaptersMenuState();
      case 'map-select': return mapSelectState();
      case 'hero-select': return heroSelectState();
      case 'map-intro': return mapIntroState();
      case 'loading': return loadingState();
      case 'shot': return shotState();
      case 'game': return playerHud();
      case 'stage-complete': return stageCompleteState();
      case 'defeat': return defeatState();
      case 'pause': return pauseState();
      case 'map': return mapState();
      case 'journal': return journalState();
      case 'companions': return companionState();
      case 'settings': return settingsState();
      case 'dialogue': return dialogueState();
      case 'choice': return choiceState();
      case 'credits': return creditsState();
      case 'hub': return hubState();
      default: return endingState();
    }
  }

  function actionFor(buttonElement: HTMLElement): UIAction | null {
    if (!vm) return null;
    const action = buttonElement.dataset.uiAction;
    switch (action) {
      case 'new-game': return { type: 'new-game', runId: crypto.randomUUID() };
      case 'map-select': return { type: 'map-select' };
      case 'select-map': return buttonElement.dataset.map ? { type: 'select-map', mapId: buttonElement.dataset.map } : null;
      case 'select-hero': return isHeroId(buttonElement.dataset.hero) && isCompanionId(buttonElement.dataset.companion) ? { type: 'select-hero', heroId: buttonElement.dataset.hero, companionId: buttonElement.dataset.companion, runId: crypto.randomUUID() } : null;
      case 'select-hero-companion': return isHeroId(buttonElement.dataset.hero) && isCompanionId(buttonElement.dataset.companion) ? { type: 'select-hero-companion', heroId: buttonElement.dataset.hero, companionId: buttonElement.dataset.companion } : null;
      case 'continue': return vm.saves.continueSlotId ? { type: 'continue', slotId: vm.saves.continueSlotId } : null;
      case 'pause': return { type: 'pause' };
      case 'interact': {
        const interactionId = buttonElement.dataset.interaction;
        const targetId = buttonElement.dataset.target;
        return interactionId && targetId ? { type: 'interact', interactionId, targetId: targetId as ActorId } : null;
      }
      case 'resume': return { type: 'resume' };
      case 'map': return { type: 'open-map' };
      case 'journal': return { type: 'open-journal' };
      case 'companions': return { type: 'open-companions' };
      case 'settings': return { type: 'open-settings' };
      case 'open-settings': return { type: 'open-settings' };
      case 'open-hub': return vm.hub && vm.canOpenWorldPanels ? { type: 'open-hub' } : null;
      case 'learn-upgrade': {
        const upgradeId = buttonElement.dataset.upgrade;
        if (!upgradeId) return null;
        const upgrade = vm.hub?.upgrades.find(candidate => candidate.id === upgradeId);
        if (!upgrade || !upgrade.available || upgrade.learned) return null;
        return { type: 'learn-upgrade', upgradeId };
      }
      case 'start-dodge-training':
        if (!vm.hub?.practice.available || vm.hub.practice.active) return null;
        return { type: 'start-dodge-training' };
      case 'stop-dodge-training':
        if (!vm.hub?.practice.active) return null;
        return { type: 'stop-dodge-training' };
      case 'return-title': return { type: 'return-title' };
      case 'close': return { type: 'close-screen' };
      case 'save': {
        const slotId = buttonElement.dataset.slot;
        const label = vm.saves.slots.find(slot => slot.slotId === slotId)?.label;
        return slotId && label ? { type: 'save', slotId, label } : null;
      }
      case 'load': return buttonElement.dataset.slot ? { type: 'load', slotId: buttonElement.dataset.slot } : null;
      case 'create-save-slot': return { type: 'create-save-slot', label: `Save Slot ${vm.saves.slots.length + 1}` };
      case 'export': return { type: 'export', slotId: buttonElement.dataset.slot };
      case 'accept-quest': {
        const quest = vm.journal.quests.find(item => item.id === buttonElement.dataset.quest);
        return quest && canAcceptSideQuest(quest) ? { type: 'accept-quest', questId: quest.id } : null;
      }
      case 'track-objective': return { type: 'track-objective', objectiveId: (buttonElement.dataset.objective || null) as ObjectiveId | null };
      case 'select-companion': {
        const raw = buttonElement.dataset.companion;
        if (!isCompanionId(raw)) return null;
        selectedCompanion = raw;
        return { type: 'select-companion', companionId: raw };
      }
      case 'enter-mode': return buttonElement.dataset.mode === 'chapters' || buttonElement.dataset.mode === 'trials' ? { type: 'enter-mode', mode: buttonElement.dataset.mode } : null;
      case 'begin-journey': return { type: 'begin-journey' };
      case 'retry-checkpoint': return { type: 'retry-checkpoint' };
      case 'dismiss-tutorial': return { type: 'dismiss-tutorial' };
      case 'reset-tutorials': return { type: 'reset-tutorials' };
      case 'wheel-open': return { type: 'wheel', op: 'open' };
      case 'wheel-cancel': return { type: 'wheel', op: 'cancel' };
      case 'wheel-sector': return buttonElement.dataset.sector !== undefined ? { type: 'wheel', op: 'commit', sector: Number(buttonElement.dataset.sector) } : null;
      case 'ability': return { type: 'use-ability', abilityId: buttonElement.dataset.ability ?? '' };
      case 'preview-skill': return { type: 'preview-companion-skill', abilityId: buttonElement.dataset.ability ?? '' };
      case 'travel': {
        const id = buttonElement.dataset.region as RegionId | undefined;
        const entranceId = buttonElement.dataset.entrance;
        if (!id || !entranceId) return null;
        return { type: 'travel', regionId: id, entranceId };
      }
      case 'choose': {
        const choiceId = vm.choice?.id ?? buttonElement.dataset.choice;
        const optionId = buttonElement.dataset.option;
        return choiceId && optionId ? { type: 'choose', choiceId, optionId } : null;
      }
      case 'skip-cinematic': return { type: 'skip-cinematic', cinematicId: vm.dialogue?.id ?? 'current' };
      case 'dialogue-next': return vm.dialogue ? { type: 'advance-dialogue', beatId: vm.dialogue.id } : null;
      case 'toggle-setting': {
        const setting = buttonElement.dataset.setting;
        const patch = setting ? toggleSetting(setting, vm.settings) : null;
        return patch ? { type: 'update-settings', settings: patch } : null;
      }
      case 'retry-load': {
        const operationId = buttonElement.dataset.operationId;
        return operationId ? { type: 'retry-load', operationId } : null;
      }
      case 'skip-establishing': return { type: 'skip-establishing-shot' };
      case 'intro-continue':
      case 'intro-skip': return { type: 'leave-map-intro' };
      default: return null;
    }
  }

  function onClick(event: Event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const item = target.closest<HTMLElement>('[data-ui-action]');
    if (!item || item instanceof HTMLButtonElement && (item.disabled || item.getAttribute('aria-disabled') === 'true')) return;
    let action: UIAction | null = null;
    let actionResolved = false;
    const endingId = vm?.ending?.id;
    if (releasedPointerControl === item) {
      releasedPointerControl = null;
      if (deferredRenderFrame) cancelAnimationFrame(deferredRenderFrame);
      deferredRenderFrame = 0;
      const pending = deferredViewModel;
      deferredViewModel = null;
      if (pending && vm && pending.screen !== vm.screen) { render(pending); return; }
      if (pending) {
        action = actionFor(item);
        actionResolved = true;
        render(pending);
      }
    }
    if (item.dataset.uiAction === 'hero-focus' || item.dataset.uiAction === 'hero-tab' || item.dataset.uiAction === 'hero-skill') { browseHero(item); return; }
    if (item.dataset.uiAction === 'map-view') {
      const view = item.dataset.view === 'world' ? 'world' : 'area';
      if (vm && view !== mapView) { mapView = view; lastRenderSignature = ''; render(vm); }
      return;
    }
    if (item.dataset.uiAction === 'inspect-companion') {
      const id = item.dataset.companion as CompanionId | undefined;
      if (id && vm) { selectedCompanion = id; lastRenderSignature = ''; render(vm); }
      return;
    }
    if (item.dataset.uiAction === 'title-screen') { dispatch({ type: 'return-title' }); return; }
    if (item.dataset.uiAction === 'credits') { dispatch({ type: 'view-credits', endingId }); return; }
    if (item.dataset.uiAction === 'save-screen') { renderLocal('save'); return; }
    if (item.dataset.uiAction === 'load-screen') {
      renderLocal('load');
      if (!recoveryImportAllowed(vm?.loading.operationId)) {
        const layer = frontLayer();
        for (const control of layer.querySelectorAll<HTMLElement>('[data-ui-action="import-file"], .wc-file-input')) control.remove();
        const recoveryControl = controlsIn(layer).find(control => control.tagName !== 'DIV');
        recoveryControl?.focus({ preventScroll: true });
      }
      return;
    }
    if (item.dataset.uiAction === 'import-file') { frontLayer().querySelector<HTMLInputElement>('.wc-file-input')?.click(); return; }
    if (item.dataset.uiAction === 'select-hero' && !reducedMotion) item.closest('.wc-hero-select__frame')?.setAttribute('data-confirming', 'true');
    const resolvedAction = actionResolved ? action : actionFor(item);
    if (resolvedAction) dispatch(resolvedAction);
  }

  /** Pointer hover over a wheel sector selects it (disabled sectors too, so their reason shows); the application owns the selection. */
  function onWheelHover(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element) || !wheelOpen) return;
    const sector = target.closest<HTMLElement>('[data-ui-action="wheel-sector"]');
    if (!sector || sector.dataset.sector === undefined) return;
    const index = Number(sector.dataset.sector);
    if (index !== wheelSector) dispatch({ type: 'wheel', op: 'sector', sector: index });
  }
  /** A journal or map step under the pointer or focus lights its marker on the area map (the grid code links list and sheet). */
  function onLocate(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const layer = frontLayer();
    const id = target.closest<HTMLElement>('[data-locate]')?.dataset.locate ?? null;
    for (const marker of layer.querySelectorAll<HTMLElement>('[data-marker]')) marker.toggleAttribute('data-located', marker.dataset.marker === id);
  }
  /** Hero-select browsing is UI-local: it re-renders the dossier and drives the live preview, never the run. */
  function browseHero(item: HTMLElement): void {
    if (!vm || vm.screen !== 'hero-select') return;
    const action = item.dataset.uiAction;
    if (action === 'hero-focus') {
      const heroId = item.dataset.hero;
      if (!isHeroId(heroId) || heroId === heroFocus) return;
      heroFocus = heroId;
      heroSkillIndex = null;
      heroPanelSlide = 'fade';
    } else if (action === 'hero-tab') {
      const tab = item.dataset.tab;
      if (!isHeroTab(tab) || tab === heroTab) return;
      heroPanelSlide = HERO_TABS.findIndex(candidate => candidate.id === tab) > HERO_TABS.findIndex(candidate => candidate.id === heroTab) ? 'next' : 'prev';
      heroTab = tab;
    } else {
      const index = Number(item.dataset.skill);
      const skill = heroById(heroFocus).skills[index];
      if (!skill) return;
      heroSkillIndex = index;
      heroPreview?.showcase(skill.previewActionIds);
    }
    // Choosing a skill keeps the list where the player left it; switching hero or tab starts the panel at the top.
    const scrollTop = action === 'hero-skill' ? frontLayer().querySelector('.wc-hero-panel')?.scrollTop ?? 0 : 0;
    lastRenderSignature = '';
    render(vm);
    heroPanelSlide = 'none';
    const panel = frontLayer().querySelector<HTMLElement>('.wc-hero-panel');
    if (panel) panel.scrollTop = scrollTop;
  }

  /** Shows the UI-local Save or Load screen (not a view-model screen) through the same transition as any other. */
  function renderLocal(key: 'save' | 'load') {
    if (!vm || frontKey === key) return;
    // The previous screen's live preview is released by swapScreen once its layer has finished leaving.
    lastRenderSignature = '';
    const staging = document.createElement('div');
    staging.innerHTML = saveState(key === 'load');
    swapScreen(key, staging);
  }

  function handleChange(event: Event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
    if (target instanceof HTMLInputElement && target.type === 'file') {
      if (event.type !== 'change') return;
      const file = target.files?.[0];
      if (file) void file.text().then(payload => dispatch({ type: 'import', payload }));
      return;
    }
    if ((target instanceof HTMLInputElement || target instanceof HTMLSelectElement) && target.dataset.setting) {
      if (target instanceof HTMLInputElement && target.type === 'range') {
        if (event.type !== 'change') return;
      } else if (event.type !== 'change') return;
      const settingValue = target instanceof HTMLInputElement && target.type === 'range' ? Number(target.value) : target.value;
      const patch = settingPatch(target.dataset.setting, settingValue);
      if (patch) dispatch({ type: 'update-settings', settings: patch });
      return;
    }
    if (target instanceof HTMLInputElement && target.dataset.remap) {
      if (event.type !== 'change') return;
      if (target.dataset.captured) {
        delete target.dataset.captured;
        return;
      }
      const device = target.dataset.remapDevice;
      if ((device === 'keyboard' || device === 'gamepad') && target.value.trim()) {
        dispatch({ type: 'remap', device, actionId: target.dataset.remap, binding: target.value.trim().toLowerCase() });
      }
    }
  }

  function bindPreview() {
    const host = frontLayer().querySelector<HTMLElement>('[data-preview-host]');
    if (!host) return;
    if (host.dataset.heroPreview === 'true') {
      const controller = options.onHeroPreviewHost?.(host) ?? null;
      heroPreview = controller;
      previewCleanup = controller ? () => {
        controller.dispose();
        if (heroPreview === controller) heroPreview = null;
      } : null;
      return;
    }
    const companion = (host.dataset.companion || null) as CompanionId | null;
    const cleanup = options.onPreviewHost?.(host, companion);
    previewCleanup = typeof cleanup === 'function' ? cleanup : null;
  }
  /** Title-screen diorama: mounted when the title layer is present, released when the player leaves the screen. */
  function bindTitleStage(): void {
    const previous = titleStageCleanup;
    titleStageCleanup = null;
    if (previous) previous();
    const host = frontLayer().querySelector<HTMLElement>('[data-title-stage]');
    if (!host) return;
    const controller = options.onTitleStageHost?.(host) ?? null;
    titleStageCleanup = controller ? () => controller.dispose() : null;
  }

  function later(callback: () => void, milliseconds: number): void {
    transitionTimers.push(window.setTimeout(callback, milliseconds));
  }
  const frontLayer = () => layers[front]!;
  const controlsIn = (layer: HTMLElement) => [...layer.querySelectorAll<HTMLElement>(LAYER_CONTROLS)].filter(control => control.getClientRects().length > 0);
  /** Empties a layer and returns it to its idle, hidden state. */
  function retireLayer(layer: HTMLElement): void {
    layer.replaceChildren();
    layer.className = 'wc-layer';
    layer.hidden = true;
    for (const name of ['inert', 'aria-hidden', 'data-screen', 'data-motion', 'data-from']) layer.removeAttribute(name);
  }
  /**
   * Puts `staging` on screen under a new screen key with exit → swap → enter. The old layer turns inert and plays
   * `.wc-leave` (≤ 220 ms); the other layer takes the front with the new content and plays `.wc-enter`. Reduced motion
   * swaps instantly with a one-frame cross-fade. A newer swap bumps the generation token, which cancels the older swap's
   * timers and drops any layer still on its way out, so interrupted transitions never leave stale layers behind.
   * Focus moves to the matching control of the new screen (same focus key), else its first control.
   */
  function swapScreen(key: string, staging: HTMLElement, focusKey: string | null = null): void {
    const outgoing = layers[front]!;
    const incoming = layers[1 - front]!;
    const hadScreen = frontKey !== '';
    const generation = ++transitionGeneration;
    clearTransitionTimers();
    flushPreviewCleanups();
    retireLayer(incoming);
    // The leaving screen's live preview (3D canvas) stays up while its layer fades out, then is disposed with the layer.
    const leavingPreview = previewCleanup;
    previewCleanup = null;
    if (leavingPreview) {
      if (hadScreen && !reducedMotion) pendingPreviewCleanups.push(leavingPreview);
      else leavingPreview();
    }
    // Title stage lives only on the title screen; the cross-fade is the right moment to release it so a follow-up bindTitleStage runs cleanly.
    if (key !== 'title' && titleStageCleanup) { titleStageCleanup(); titleStageCleanup = null; }
    outgoing.classList.remove('wc-enter', 'wc-crossfade');
    const motion = motionOf(key);
    incoming.setAttribute('data-screen', key);
    incoming.setAttribute('data-motion', motion);
    incoming.setAttribute('data-from', frontKey || 'none');
    incoming.classList.add('wc-layer--front', reducedMotion ? 'wc-crossfade' : 'wc-enter');
    incoming.hidden = false;
    incoming.replaceChildren(...staging.childNodes);
    if (hadScreen) {
      if (reducedMotion) retireLayer(outgoing);
      else {
        outgoing.setAttribute('inert', '');
        outgoing.setAttribute('aria-hidden', 'true');
        outgoing.classList.remove('wc-layer--front');
        outgoing.classList.add('wc-leave');
        outgoing.querySelector('.wc-scene')?.classList.add('is-leaving');
        later(() => { if (generation === transitionGeneration) { retireLayer(outgoing); flushPreviewCleanups(); } }, LEAVE_MS + 40);
      }
    }
    later(() => { if (generation === transitionGeneration) incoming.classList.remove('wc-enter', 'wc-crossfade'); }, reducedMotion ? 60 : ENTER_SETTLE_MS[motion]);
    front = 1 - front;
    frontKey = key;
    const controls = controlsIn(incoming);
    const target = (focusKey ? controls.find(control => control.dataset.focusKey === focusKey) : null) ?? controls[0] ?? null;
    target?.focus({ preventScroll: true });
    const index = target ? controls.indexOf(target) : -1;
    focusedIndex = index >= 0 ? index : 0;
  }
  function clearTransitionTimers(): void {
    for (const timer of transitionTimers) window.clearTimeout(timer);
    transitionTimers = [];
  }
  /** Disposes live previews of layers that have left the screen. */
  function flushPreviewCleanups(): void {
    const cleanups = pendingPreviewCleanups;
    pendingPreviewCleanups = [];
    for (const cleanup of cleanups) cleanup();
  }
  /** Reads out the dialogue line when it changes; the live region lives outside the layers so line swaps never replace it. */
  function announceDialogue(key: string): void {
    const { line, name } = key === 'dialogue' ? currentDialogueLine() : { line: undefined, name: '' };
    const text = line ? `${name}: ${line.text}` : '';
    if (text === announced) return;
    announced = text;
    announcer.textContent = text;
  }

  function render(next: GameViewModel) {
    if (destroyed) return;
    const signature = gameUiSignature(next);
    patchDestination(frontLayer(), next.hud.destination);
    patchObjectiveDestination(frontLayer(), next.objectiveHud?.destination);
    syncWheel(next);
    if (signature === lastRenderSignature) return;
    if (pointerControl) {
      deferredViewModel = next;
      return;
    }
    if (deferredRenderFrame) cancelAnimationFrame(deferredRenderFrame);
    deferredRenderFrame = 0;
    deferredViewModel = null;
    lastRenderSignature = signature;
    const nextReduced = next.settings.reducedMotion || osReducedMotion;
    if (nextReduced !== reducedMotion || frontKey === '') container.classList.toggle('wc-reduced-motion', nextReduced);
    reducedMotion = nextReduced;
    const key = screenKey(next);
    const swapped = key !== frontKey;
    const layer = frontLayer();
    const activeControl = document.activeElement instanceof HTMLElement && layer.contains(document.activeElement)
      ? document.activeElement : null;
    const focus = activeControl?.dataset.focusKey ?? null;
    const previousScreen = vm?.screen;
    const existingPreview = swapped ? null : layer.querySelector<HTMLElement>('[data-preview-host]');
    vm = next;
    if (next.screen === 'hero-select' && previousScreen !== 'hero-select') { heroTab = 'role'; heroSkillIndex = null; }
    const keepPreview = Boolean(existingPreview && (
      next.screen === 'companions' && existingPreview.dataset.companion === selectedCompanionId()
      || next.screen === 'hero-select' && existingPreview.dataset.heroPreview === 'true'));
    if (!keepPreview && !swapped) {
      previewCleanup?.();
      previewCleanup = null;
    }
    const staging = document.createElement('div');
    staging.innerHTML = renderMarkup(key);
    const coreHost = staging.querySelector<HTMLElement>('.wc-boss__cores');
    const cores = vm?.hud.boss?.corruptionCores;
    if (coreHost && cores?.length) {
      let cleansedCount = 0;
      const indicators = document.createElement('span');
      indicators.className = 'wc-core-indicators';
      indicators.setAttribute('role', 'group');
      for (const [index, core] of cores.entries()) {
        const state = core.cleansed ? 'cleansed' : 'uncleansed';
        if (core.cleansed) cleansedCount++;
        const indicator = document.createElement('span');
        indicator.className = core.cleansed ? 'wc-core wc-core--cleansed' : 'wc-core';
        indicator.setAttribute('role', 'img');
        indicator.setAttribute('aria-label', 'Corruption core ' + (index + 1) + ' ' + state);
        indicator.textContent = core.cleansed ? '✓' : '';
        indicators.append(indicator);
      }
      indicators.setAttribute('aria-label', 'Corruption cores: ' + cleansedCount + ' of ' + cores.length + ' cleansed');
      coreHost.append(indicators);
    }
    if (swapped) swapScreen(key, staging, focus);
    else if (SCENE_KEYS[key] || key !== 'game' && layer.classList.contains('wc-enter')) {
      // Scenes and screens still entering patch in place so their running animations keep their place; the HUD has none.
      morphChildren(layer, staging);
    } else {
      if (keepPreview && existingPreview) staging.querySelector('[data-preview-host]')?.replaceWith(existingPreview);
      const nextFocusedControl = focus
        ? [...staging.querySelectorAll<HTMLElement>('[data-focus-key]')].find(control => control.dataset.focusKey === focus) ?? null
        : null;
      if (activeControl && nextFocusedControl) reconcileFocusedControl(activeControl, nextFocusedControl);
      layer.replaceChildren(...staging.childNodes);
    }
    if (!keepPreview) bindPreview();
    // Title stage: only the title screen has a [data-title-stage] host. Any other screen tears it down to free the GL context.
    if (next.screen === 'title') bindTitleStage();
    else if (titleStageCleanup) { titleStageCleanup(); titleStageCleanup = null; }
    // Map select: hover or focus on a region highlights it and swaps the side panel locally (no dispatch).
    mapSelectCleanup?.();
    mapSelectCleanup = null;
    const selection = next.screen === 'map-select' ? next.playtestSelection : undefined;
    if (selection) {
      mapSelectCleanup = bindWorldMapSelect(frontLayer(), { panels: worldMapPanels({ maps: selection.maps, selectedMapId: selection.selectedMapId, reducedMotion }) });
    }
    if (next.screen === 'hero-select') heroPreview?.show(heroFocus);
    announceDialogue(key);
    if (!swapped) {
      // Same screen: keep the user's place. Layout is only read when a control actually held focus.
      const restored = activeControl && layer.contains(activeControl)
        ? activeControl
        : focus ? [...layer.querySelectorAll<HTMLElement>('[data-focus-key]')].find(control => control.dataset.focusKey === focus) ?? null : null;
      const focusTarget = restored ?? (activeControl !== null ? controlsIn(layer)[0] ?? null : null);
      if (focusTarget) {
        focusTarget.focus({ preventScroll: true });
        const index = controlsIn(layer).indexOf(focusTarget);
        if (index >= 0) focusedIndex = index;
      }
    }
    if (next.screen === 'game' && next.tutorial) {
      // The card freezes play; put the keyboard/gamepad on its Continue button so Enter or A dismisses it.
      const dismiss = frontLayer().querySelector<HTMLElement>('[data-ui-action="dismiss-tutorial"]');
      if (dismiss && document.activeElement !== dismiss) dismiss.focus({ preventScroll: true });
    }
    syncGateNotice();
  }

  const escKey = (event: KeyboardEvent) => {
    const remapInput = event.target instanceof HTMLInputElement && event.target.dataset.remap ? event.target : null;
    if (remapInput && event.key !== 'Tab') {
      if (remapInput.dataset.remapDevice !== 'keyboard') {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      const actionId = remapInput.dataset.remap;
      if (!actionId) return;
      const binding = event.key === ' ' ? 'space' : event.key.toLowerCase();
      remapInput.value = binding;
      remapInput.dataset.captured = 'true';
      dispatch({ type: 'remap', device: 'keyboard', actionId, binding });
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const isNativeValueControl = event.target instanceof HTMLSelectElement || event.target instanceof HTMLInputElement && event.target.type === 'range';
    if (isNativeValueControl && (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End')) return;
    // The establishing shot is skippable and nothing else: Esc, Enter and Space end it, every other key is ignored.
    if (vm?.screen === 'game' && vm.scene?.establishingShot) {
      if (event.key === 'Escape' || event.key === 'Enter' || event.key === ' ') {
        dispatch({ type: 'skip-establishing-shot' });
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }
    if (vm?.screen === 'map-intro' && (event.key === 'Escape' || event.key === 'Enter' || event.key === ' ')) {
      dispatch({ type: 'leave-map-intro' });
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (wheelOpen && vm?.screen === 'game') {
      // The open wheel owns the keyboard: Escape cancels it (never pauses); every other key is read by the application's input.
      if (event.key === 'Escape') {
        dispatch({ type: 'wheel', op: 'cancel' });
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }
    const pauseBinding = vm?.bindings.keyboard.pause?.toLowerCase();
    if (vm && vm.canOpenWorldPanels && (vm.screen === 'game' || vm.screen === 'pause') && pauseBinding && pauseBinding === event.key.toLowerCase()) {
      dispatch({ type: vm.screen === 'game' ? 'pause' : 'resume' });
      event.preventDefault();
      // Resuming enables gameplay input synchronously; the same keydown must not then reach it and pause again.
      event.stopImmediatePropagation();
      return;
    }
    if (vm?.screen === 'map') {
      const key = event.key.toLowerCase();
      const keyboard = vm.bindings.keyboard;
      const moveRight = keyboard.moveRight?.toLowerCase();
      const moveLeft = keyboard.moveLeft?.toLowerCase();
      const moveBack = keyboard.moveBack?.toLowerCase();
      const moveForward = keyboard.moveForward?.toLowerCase();
      const dx = key === moveRight ? 24 : key === moveLeft ? -24 : 0;
      const dy = key === moveBack ? 24 : key === moveForward ? -24 : 0;
      if (dx || dy) {
        mapPan = { x: Math.max(-120, Math.min(120, mapPan.x + dx)), y: Math.max(-120, Math.min(120, mapPan.y + dy)) };
        container.style.setProperty('--wc-map-pan-x', String(mapPan.x) + 'px');
        container.style.setProperty('--wc-map-pan-y', String(mapPan.y) + 'px');
        event.preventDefault();
        return;
      }
    }
    if (vm?.screen === 'game') {
      if (!vm.canOpenWorldPanels) return;
      const shortcut = event.key.toLowerCase();
      const binding = Object.entries(vm.bindings.keyboard).find(([id, value]) => ['map', 'journal', 'companions'].some(name => id.toLowerCase().includes(name)) && value.toLowerCase() === shortcut);
      if (!binding) return;
      const action: UIAction['type'] | null = binding[0].toLowerCase().includes('map') ? 'open-map' : binding[0].toLowerCase().includes('journal') ? 'open-journal' : 'open-companions';
      if (action === 'open-map') dispatch({ type: 'open-map' });
      else if (action === 'open-journal') dispatch({ type: 'open-journal' });
      else dispatch({ type: 'open-companions' });
      event.preventDefault();
      return;
    }
    if (event.key === 'Escape' || event.key === 'Backspace') {
      if (vm?.screen === 'hero-select') dispatch({ type: 'map-select' });
      else if (vm?.screen === 'map-select' || vm?.screen === 'chapters-menu') dispatch({ type: 'return-title' });
      else if (vm?.screen === 'choice') { /* a story choice is never dismissed into a default */ }
      else if (vm?.screen === 'pause') dispatch({ type: 'resume' });
      else dispatch({ type: 'close-screen' });
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const layer = frontLayer();
    if (!layer.contains(document.activeElement)) return;
    const controls = controlsIn(layer);
    if (!controls.length) return;
    if (event.key === 'Tab') {
      const current = controls.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && current <= 0) controls[controls.length - 1]?.focus();
      else if (!event.shiftKey && current === controls.length - 1) controls[0]?.focus();
      else return;
      event.preventDefault();
      event.stopImmediatePropagation();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      focusedIndex = (controls.indexOf(document.activeElement as HTMLElement) + 1) % controls.length;
      controls[focusedIndex]?.focus(); event.preventDefault();
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      focusedIndex = (controls.indexOf(document.activeElement as HTMLElement) - 1 + controls.length) % controls.length;
      controls[focusedIndex]?.focus(); event.preventDefault();
    }
  };

  function updateGamepad(gamepad: Gamepad | null): void {
    if (destroyed) return;
    if (!gamepad?.connected) {
      lastGamepadButtons.clear();
      return;
    }
    // Compared with the previous frame without allocating: on almost every frame nothing changed and nothing else runs.
    const buttons = gamepad.buttons;
    let newButton = -1;
    let changed = false;
    for (let index = 0; index < buttons.length; index++) {
      const isDown = buttons[index]!.pressed;
      if (isDown === lastGamepadButtons.has(index)) continue;
      changed = true;
      if (isDown && newButton < 0) newButton = index;
    }
    if (!changed) return;
    const previous = new Set(lastGamepadButtons);
    lastGamepadButtons.clear();
    for (let index = 0; index < buttons.length; index++) if (buttons[index]!.pressed) lastGamepadButtons.add(index);
    const pressed = lastGamepadButtons;
    const gamepadControls = () => [...frontLayer().querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)')].filter(control => control.getClientRects().length > 0);
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (vm?.screen === 'game' && vm.scene?.establishingShot) {
      // A, B or Start skips the establishing shot.
      if (newButton === 0 || newButton === 1 || newButton === 9) dispatch({ type: 'skip-establishing-shot' });
    } else if (vm?.screen === 'game' && wheelOpen) {
      // The open wheel owns the gamepad: the stick aims and B cancels (read by the application's input).
    } else if (vm?.screen === 'game') {
      if (vm.canOpenWorldPanels) {
        if (gamepadActionJustPressed(vm.bindings, 'pause', pressed, previous)) dispatch({ type: 'pause' });
        else if (gamepadActionJustPressed(vm.bindings, 'map', pressed, previous)) dispatch({ type: 'open-map' });
        else if (gamepadActionJustPressed(vm.bindings, 'journal', pressed, previous)) dispatch({ type: 'open-journal' });
        else if (gamepadActionJustPressed(vm.bindings, 'companions', pressed, previous)) dispatch({ type: 'open-companions' });
      }
    } else if (newButton >= 0 && active instanceof HTMLInputElement && active.dataset.remap && active.dataset.remapDevice === 'gamepad') {
      const binding = 'Gamepad Button ' + (newButton + 1);
      active.value = binding;
      active.dataset.captured = 'true';
      dispatch({ type: 'remap', device: 'gamepad', actionId: active.dataset.remap, binding });
    } else if ((pressed.has(12) && !previous.has(12)) || (pressed.has(15) && !previous.has(15))) {
      const controls = gamepadControls();
      const activeIndex = active ? controls.indexOf(active) : -1;
      focusedIndex = activeIndex >= 0 ? (activeIndex + 1) % Math.max(controls.length, 1) : Math.min(focusedIndex, Math.max(controls.length - 1, 0));
      controls[focusedIndex]?.focus();
    } else if ((pressed.has(13) && !previous.has(13)) || (pressed.has(14) && !previous.has(14))) {
      const controls = gamepadControls();
      const activeIndex = active ? controls.indexOf(active) : -1;
      focusedIndex = activeIndex >= 0 ? (activeIndex - 1 + controls.length) % Math.max(controls.length, 1) : Math.max(focusedIndex - 1, 0);
      controls[focusedIndex]?.focus();
    } else if (newButton === 0 && active && frontLayer().contains(active)) {
      focusedIndex = Math.max(0, gamepadControls().indexOf(active));
      active.click();
    } else if (newButton === 1) {
      if (vm?.screen === 'pause') dispatch({ type: 'resume' });
      else if (vm?.screen === 'map-intro') dispatch({ type: 'leave-map-intro' });
      else dispatch({ type: 'close-screen' });
    }
  }

  /** Pauses every UI animation while the page is hidden, so ambient motion never runs where nobody can see it. */
  const onVisibility = () => { container.classList.toggle('wc-ui--paused', document.hidden); };

  container.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('pointerup', onPointerEnd, true);
  document.addEventListener('pointercancel', onPointerEnd, true);
  container.addEventListener('click', onClick);
  feedback.addEventListener('click', onClick);
  feedback.addEventListener('pointerover', onWheelHover);
  container.addEventListener('pointerover', onLocate);
  container.addEventListener('focusin', onLocate);
  container.addEventListener('input', handleChange);
  container.addEventListener('change', handleChange);
  document.addEventListener('keydown', escKey, true);
  keyListener = escKey;
  document.addEventListener('visibilitychange', onVisibility);
  if (options.initialViewModel) render(options.initialViewModel);

  return {
    get element() { return container; },
    render,
    setGateContact(active: boolean) {
      if (destroyed || gateContact === active) return;
      gateContact = active;
      syncGateNotice();
    },
    updateGamepad,
    notify,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      previewCleanup?.();
      previewCleanup = null;
      if (titleStageCleanup) { titleStageCleanup(); titleStageCleanup = null; }
      mapSelectCleanup?.();
      mapSelectCleanup = null;
      flushPreviewCleanups();
      container.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('pointerup', onPointerEnd, true);
      document.removeEventListener('pointercancel', onPointerEnd, true);
      if (deferredRenderFrame) cancelAnimationFrame(deferredRenderFrame);
      deferredRenderFrame = 0;
      deferredViewModel = null;
      pointerControl = null;
      releasedPointerControl = null;
      lastGamepadButtons.clear();
      container.removeEventListener('click', onClick);
      container.removeEventListener('input', handleChange);
      container.removeEventListener('change', handleChange);
      container.removeEventListener('pointerover', onLocate);
      container.removeEventListener('focusin', onLocate);
      if (keyListener) document.removeEventListener('keydown', keyListener, true);
      document.removeEventListener('visibilitychange', onVisibility);
      motionQuery?.removeEventListener?.('change', onMotionPreference);
      clearTransitionTimers();
      transitionGeneration++;
      for (const layer of layers) layer.replaceChildren();
      container.replaceChildren();
      container.remove();
      feedback.removeEventListener('click', onClick);
      feedback.removeEventListener('pointerover', onWheelHover);
      window.clearTimeout(noticeTimer);
      feedback.remove();
      vm = null;
    },
  };
}
