import playerCopy from '../../docs/production/content/PLAYER-COPY.en.json' with { type: 'json' };
import type {
  ActorId,
  CampaignSnapshot,
  CompanionId,
  GameViewModel,
  ObjectiveDefinition,
  ObjectiveId,
  QuestDefinition,
  RegionId,
  UIAction,
} from '../game/contracts';
import { settingsMarkup, settingPatch, toggleSetting } from './settings';
import { saveMarkup } from './save';
import { loadingErrorActions, recoveryImportAllowed } from './loading-error-actions';
import './game-ui.css';

const mapArt = '/ui/world-map-game.webp';
const PORTRAIT_ASSETS: Partial<Record<CompanionId, string>> = { vara: '/ui/portrait-vara.webp', koro: '/ui/portrait-koro.webp', asha: '/ui/portrait-asha.webp', sable: '/ui/portrait-sable.webp', nyra: '/ui/portrait-nyra.webp', solkar: '/ui/portrait-solkar.webp' };
const journalArt = '/ui/map-journal-illustration.webp';

export interface GameUIOptions {
  onAction: (action: UIAction) => void;
  initialViewModel?: GameViewModel;
  /** Renderer integrations attach the real, animated character renderer here. */
  onPreviewHost?: (host: HTMLElement, companionId: CompanionId | null) => void | (() => void);
}

export interface GameUIInstance {
  render(viewModel: GameViewModel): void;
  updateGamepad(gamepad: Gamepad | null): void;
  destroy(): void;
  readonly element: HTMLElement;
}

type Screen = GameViewModel['screen'];
type Slot = 'combat' | 'utility' | 'scout';

const REGION_ORDER: readonly RegionId[] = [
  'whispering-canopy', 'blood-bamboo-valley', 'the-grove', 'greenwake',
  'moonpine-ridge', 'mistveil-basin', 'sunmane-expanse', 'refuge', 'heartroot-hollow',
];
const COMPANIONS: readonly { id: CompanionId; name: string; role: string; portrait: string }[] = [
  { id: 'asha', name: 'Asha', role: 'COMBAT', portrait: 'asha' },
  { id: 'koro', name: 'Koro', role: 'UTILITY', portrait: 'koro' },
  { id: 'vara', name: 'Vara', role: 'SCOUT', portrait: 'vara' },
  { id: 'sable', name: 'Sable', role: 'PACK ENVOY', portrait: 'sable' },
  { id: 'nyra', name: 'Nyra', role: 'SHADOW GUIDE', portrait: 'nyra' },
  { id: 'solkar', name: 'Solkar', role: 'CROWN LEADER', portrait: 'solkar' },
];
const ROLE_COPY: Record<CompanionId, { role: string; abilityIds: readonly string[] }> = {
  asha: { role: 'Fang Protector', abilityIds: ['fang-guard'] },
  koro: { role: 'Canopy Guide', abilityIds: ['canopy-route'] },
  vara: { role: 'Sky Scout', abilityIds: ['sky-mark'] },
  sable: { role: 'Pack Envoy', abilityIds: ['pack-flank'] },
  nyra: { role: 'Shadow Guide', abilityIds: ['shadow-ambush'] },
  solkar: { role: 'Crown Leader', abilityIds: ['crown-rally'] },
};
const FACTION_BY_COMPANION: Record<CompanionId, 'sky' | 'canopy' | 'fang' | 'pack' | 'shadow' | 'crown'> = { asha: 'fang', koro: 'canopy', vara: 'sky', sable: 'pack', nyra: 'shadow', solkar: 'crown' };
const speakerName: Record<string, string> = {
  aren: 'Aren', yara: 'Yara', vara: 'Vara', koro: 'Koro', asha: 'Asha', tali: 'Tali',
  ruun: 'Ruun', luma: 'Luma', sable: 'Sable', nyra: 'Nyra', solkar: 'Solkar', ghor: 'Ghor',
  marek: 'Marek', orun: 'Orun', narrator: 'Narrator', echo: 'Echo',
};
const clamp = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
const esc = (s: string | number | null | undefined) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
function controlBindingLabel(viewModel: GameViewModel, actionId: string): string {
  const device = viewModel.settings.controlGlyphs === 'gamepad' ? 'gamepad' : 'keyboard';
  const binding = viewModel.bindings[device][actionId];
  if (!binding) return '';
  return device === 'gamepad' ? binding.replace(/^Gamepad /, '') : binding === 'space' ? 'SPACE' : binding.toUpperCase();
}
function controlHints(viewModel: GameViewModel): string {
  const move = ['moveForward', 'moveLeft', 'moveBack', 'moveRight'].map(id => controlBindingLabel(viewModel, id)).filter(Boolean).join(' ');
  const dodge = controlBindingLabel(viewModel, 'dodge');
  const pause = controlBindingLabel(viewModel, 'pause');
  return [move && move + ' MOVE', dodge && dodge + ' DODGE', pause && 'PAUSE ' + pause].filter((hint): hint is string => Boolean(hint)).join(' · ');
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
const activeObjectives = (quest: QuestDefinition | null, snapshot: CampaignSnapshot | null): ObjectiveDefinition[] => {
  if (!quest || !snapshot) return [];
  const active = new Set(snapshot.activeObjectiveIds);
  return quest.objectives.filter(objective => active.has(objective.id));
};
const firstActiveQuest = (quests: readonly QuestDefinition[], snapshot: CampaignSnapshot | null) =>
  quests.find(quest => snapshot?.activeQuestIds.includes(quest.id)) ?? quests[0] ?? null;
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
    viewModel.screen, viewModel.loading, viewModel.error,
    [hud.vitality, hud.maxVitality, hud.dodgeCharges, hud.maxDodgeCharges, hud.instinct, hud.boss, hud.targetId, hud.target?.id, hud.target?.weakPointExposed, hud.interaction],
    viewModel.trackedObjectiveId,
    campaign && [campaign.runId, campaign.revision, campaign.chapter, campaign.chapterId, campaign.regionId, campaign.activeQuestIds, campaign.completedQuestIds, campaign.activeObjectiveIds, campaign.completedObjectiveIds, campaign.fragments, campaign.ending],
    viewModel.journal.region, viewModel.journal.quests.map(quest => [quest.id, quest.title, quest.description, quest.objectives.map(objective => [objective.id, objective.title, objective.description, objective.optional])]),
    [map.currentRegion, map.regions.map(region => [region.id, region.name, region.unlocked, region.restoration, region.entrances])],
    viewModel.party, viewModel.abilities, viewModel.relationships, viewModel.settings, viewModel.bindings,
    viewModel.dialogue, viewModel.choice, viewModel.ending,
    [viewModel.saves.continueSlotId, viewModel.saves.slots.map(slot => [slot.slotId, slot.label, slot.exists, slot.updatedAt, slot.chapter, slot.regionId])],
  ]);
}
/** DOM-only game UI. Renders shared GameViewModel data and emits typed runtime actions. */
export function mountGameUI(root: HTMLElement, options: GameUIOptions): GameUIInstance {
  const container = document.createElement('div');
  container.className = 'wc-ui';
  container.setAttribute('aria-label', 'Wild Crown game interface');
  root.append(container);
  let vm: GameViewModel | null = null;
  let lastRenderSignature = '';
  let destroyed = false;
  let focusedIndex = 0;
  let keyListener: ((event: KeyboardEvent) => void) | null = null;
  let lastGamepadButtons = new Set<number>();
  let selectedCompanion: CompanionId | null = null;
  let previewCleanup: (() => void) | null = null;
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
  const dispatch = (action: UIAction) => options.onAction(action);
  const button = (label: string, action: string, attrs = '', variant = '') => {
    const focusKey = `${action}-${label.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()}`;
    return `<button type="button" class="wc-action ${variant}" data-ui-action="${esc(action)}" data-focus-key="${esc(focusKey)}" ${attrs}>${label}</button>`;
  };
  const toolbar = (active: Screen, pause = false) => `
    <nav class="wc-tabs" aria-label="Game menu">
      ${button('Map', 'map', `aria-current="${active === 'map' ? 'page' : 'false'}"`)}
      ${button('Journal', 'journal', `aria-current="${active === 'journal' ? 'page' : 'false'}"`)}
      ${button('Companions', 'companions', `aria-current="${active === 'companions' ? 'page' : 'false'}"`)}
      ${button('Settings', 'settings', `aria-current="${active === 'settings' ? 'page' : 'false'}"`)}
      ${pause ? button('Resume', 'resume', '', 'wc-action--quiet') : ''}
    </nav>`;
  const wordmark = (screen: Screen, pause = false) => `<header class="wc-menu__bar"><div class="wc-wordmark">${esc(playerCopy.title.name)}</div>${toolbar(screen, pause)}</header>`;
  const backButton = () => button('Esc&nbsp;&nbsp; Back', 'close', 'aria-label="Back"', 'wc-action--quiet');
  const containerScreen = (className: string, content: string) => `<section class="wc-screen ${className}">${content}</section>`;

  function currentObjective(): ObjectiveDefinition | null {
    if (!vm) return null;
    const quest = firstActiveQuest(vm.journal.quests, vm.campaign);
    return activeObjectives(quest, vm.campaign)[0] ?? null;
  }

  function playerHud(): string {
    if (!vm) return '';
    const { hud, campaign } = vm;
    const party = vm.party ?? campaign?.party ?? null;
    const objective = currentObjective();
    const quest = firstActiveQuest(vm.journal.quests, campaign);
    const boss = hud.boss;
    const controlsHint = controlHints(vm);
    const companions = [party?.combat, party?.utility, party?.scout].filter(Boolean) as CompanionId[];
    const portraitClass = (id: CompanionId) => COMPANIONS.find(x => x.id === id)?.portrait ?? id;
    return containerScreen('wc-screen--game', `<div class="wc-hud" aria-label="Exploration and combat HUD">
      <section class="wc-panel wc-vitals" aria-label="Aren's resources">
        <div class="wc-vitals__name">AREN</div>
        ${meter(playerCopy.hud.vitality, hud.vitality, hud.maxVitality, 'vitality', playerCopy.hud.vitality_description)}
        <div class="wc-meter" title="${esc(playerCopy.hud.dodge_description)}"><span>${esc(playerCopy.hud.dodge)}</span><span class="wc-dodges" aria-label="${hud.dodgeCharges} of ${hud.maxDodgeCharges} ${esc(playerCopy.hud.dodge)} charges">${Array.from({ length: Math.max(0, hud.maxDodgeCharges) }, (_, i) => `<i class="wc-dodge ${i < hud.dodgeCharges ? '' : 'wc-dodge--empty'}" aria-hidden="true"></i>`).join('')}<span>${hud.dodgeCharges} / ${hud.maxDodgeCharges}</span></span></div>
        ${meter(playerCopy.hud.instinct, hud.instinct, 100, 'instinct', playerCopy.hud.instinct_description)}
      </section>
      ${boss ? `<section class="wc-panel wc-boss" aria-label="Boss status"><p class="wc-boss__title">${boss.actorId === 'asha' ? 'ASHA — THE BROKEN FANG' : esc(boss.actorId.toString().replaceAll('-', ' ').toUpperCase())}</p>${meter(playerCopy.hud.ferocity, boss.ferocity, boss.maxFerocity, 'ferocity', playerCopy.hud.ferocity_description)}${meter(playerCopy.hud.corruption, boss.corruption, 100, 'corruption', playerCopy.hud.corruption_description)}<div class="wc-boss__cores">${boss.exposed ? playerCopy.hud.corruption_exposed : ''}</div></section>` : ''}
      ${vm.hud.target?.weakPointExposed ? `<aside class="wc-panel wc-target-exposure" role="status"><strong>${esc(vm.hud.target.id.toString().replaceAll('-', ' ').toUpperCase())}</strong><span>WEAK POINT EXPOSED</span></aside>` : ''}
      ${objective && !boss ? `<aside class="wc-panel wc-objective"><strong>${esc(quest?.title ?? 'Current Objective')}</strong><p>${esc(objective.title)}</p></aside>` : ''}
      ${boss ? `<div class="wc-brand-mark">${esc(playerCopy.title.name)}</div>` : ''}
      ${interactionPrompt(vm)}
      <div class="wc-party-hud" aria-label="Traveling companions">${companions.map(id => `<div class="wc-party-hud__item"><span class="wc-portrait wc-portrait--${portraitClass(id)}" ${PORTRAIT_ASSETS[id] ? `style="background-image:url('${PORTRAIT_ASSETS[id]}')"` : ''} role="img" aria-label="${esc(COMPANIONS.find(x => x.id === id)?.name ?? id)} portrait"></span><span>${esc(COMPANIONS.find(x => x.id === id)?.name ?? id)}</span></div>`).join('')}</div>
      ${controlsHint ? `<span class="wc-controls-hint">${esc(controlsHint)}</span>` : ''}
    </div>`);
  }

  function titleState(): string {
    return containerScreen('wc-state', `<section class="wc-panel wc-state__card"><p class="wc-kicker">THE BROKEN PACT</p><h1 class="wc-state__title">WILD<br>CROWN</h1><p class="wc-state__copy">Walk with the living world of Erya. Every bond is freely chosen, and every path leaves a mark.</p>${vm?.error ? `<p class="wc-error" role="alert">${esc(vm.error.message)}</p>` : ''}<div class="wc-stack">
      ${button(playerCopy.title.new_game, 'new-game', '', 'wc-action--primary')}
      ${button(playerCopy.title.continue, 'continue', vm?.saves.continueSlotId ? '' : 'disabled')}
      ${button(playerCopy.title.load_game, 'load-screen')}
      ${button(playerCopy.title.settings, 'settings')}
      ${button(playerCopy.title.credits, 'credits')}
    </div><p class="wc-label">Single-player story adventure · English</p></section>`);
  }

  function loadingState(): string {
    const loading = vm?.loading;
    const error = vm?.error ?? null;
    const actionMarkup = loadingErrorActions(error, loading?.operationId, Boolean(vm?.campaign)).map(action => {
      if (action.type === 'retry-load') return button('Retry', 'retry-load', 'data-operation-id="' + esc(action.operationId) + '"', 'wc-action--primary');
      if (action.type === 'save-screen') return button('Save Game', 'save-screen');
      if (action.type === 'load-screen') return button('Load Game', 'load-screen');
      if (action.type === 'open-settings') return button('Settings', 'open-settings');
      return button('Return to Title', 'return-title', '', 'wc-action--quiet');
    }).join('');
    return containerScreen('wc-state', `<section class="wc-panel wc-state__card" role="status" aria-live="polite"><p class="wc-kicker">WILD CROWN</p><h1 class="wc-heading">${esc(loading?.label || 'Loading Wild Crown...')}</h1><p class="wc-state__copy">Preparing the forest...</p>${loading?.progress === null || loading?.progress === undefined ? '' : `<div class="wc-progress" aria-label="Loading progress"><i style="width:${Math.round(clamp(loading.progress) * 100)}%"></i></div>`}${error ? `<p class="wc-error" role="alert">${esc(error.message)}</p><div class="wc-actions">${actionMarkup}</div>` : ''}</section>`);
  }

  function pauseState(): string {
    const card = `<section class="wc-panel wc-state__card"><p class="wc-kicker">WILD CROWN</p><h1 class="wc-heading">Paused</h1><p class="wc-state__copy">The game is paused. Resume when you are ready.</p><div class="wc-actions">${button('Resume', 'resume', '', 'wc-action--primary')}${button('Save Game', 'save-screen')}${button('Load Game', 'load-screen')}${button('Return to Title', 'title-screen')}</div></section>`;
    return containerScreen('wc-state', card);
  }

  function mapState(): string {
    if (!vm) return '';
    const quest = firstActiveQuest(vm.journal.quests, vm.campaign);
    const objectives = activeObjectives(quest, vm.campaign);
    const tracked = vm.trackedObjectiveId;
    const destination = vm!.map.regions.find(region => region.id !== vm!.map.currentRegion && region.unlocked && region.entrances.some(entrance => entrance.unlocked));
    const regions = REGION_ORDER.map(id => {
      const region = vm!.map.regions.find(x => x.id === id);
      if (!region) return '';
      return `<button class="wc-region-chip ${region.id === vm!.map.currentRegion ? 'wc-region-chip--current' : ''}" type="button" data-ui-action="travel" data-focus-key="region-${esc(region.id)}" data-region="${esc(region.id)}" data-entrance="${esc(region.entrances.find(entrance => entrance.unlocked)?.id ?? '')}" ${region.unlocked && region.entrances.some(entrance => entrance.unlocked) ? '' : 'disabled'} aria-label="${esc(region.name)}${region.unlocked ? '' : ', Locked'}" title="${esc(region.name)}">${region.unlocked ? '<span aria-hidden="true">◇</span>' : '<span aria-hidden="true">·</span>'}${region.unlocked ? '' : 'Locked'}</button>`;
    }).join('');
    const trackedObjective = quest?.objectives.find(objective => objective.id === tracked);
    return containerScreen('wc-menu', `${wordmark('map')}<div class="wc-menu__body">
      <div class="wc-map-art"><img class="wc-map-art__image" src="${mapArt}" alt="Approved illustrated world map of Erya with named regions and Heartroot Hollow beneath the Grove"> <div class="wc-map-regions" aria-label="Known regions">${regions}</div><div class="wc-map-legend" aria-label="Map legend"><span>Aren's Position</span><span>Objective</span><span>Locked</span></div></div>
      <aside class="wc-menu__side"><p class="wc-kicker">${esc(activeRegionName(vm))}</p><h1 class="wc-heading">${esc(quest?.title ?? 'The Living Forest')}</h1><img class="wc-side-illustration" src="${journalArt}" alt="Approved illustrated journal map and quest concept"><section class="wc-quest-card"><h3>${esc(quest?.title ?? 'Current Objective')}</h3><p class="wc-label">TRACKED OBJECTIVE</p>${trackedObjective ? `<p>${esc(trackedObjective.title)}</p>` : `<p class="wc-state__copy">No objective is being tracked. Select one in the Journal.</p>`}<ul class="wc-objective-list">${objectives.map(objective => `<li data-active="${objective.id === tracked}"><span>${esc(objective.title)}</span>${button(objective.id === tracked ? 'TRACKED' : 'TRACK', 'track-objective', `data-objective="${esc(objective.id)}" aria-pressed="${objective.id === tracked}"`, objective.id === tracked ? 'wc-action--primary' : '')}</li>`).join('')}</ul>${destination ? button(`Travel to ${esc(destination.name)}`, 'travel', `data-region="${esc(destination.id)}"`, 'wc-action--primary') : ''}</section>${backButton()}</aside>
      </div><footer class="wc-map-footer"><span>Esc&nbsp; Back</span><span>W A S D&nbsp; Pan Map</span><span>Current Region · ${esc(activeRegionName(vm))}</span></footer>`);
  }

  function journalState(): string {
    if (!vm) return '';
    const qActive = firstActiveQuest(vm.journal.quests, vm.campaign);
    const all = vm.journal.quests;
    return containerScreen('wc-menu', `${wordmark('journal')}<div class="wc-menu__body"><div class="wc-menu__side"><p class="wc-kicker">CHAPTER ${vm.campaign?.chapter ?? ''} · ${esc(activeRegionName(vm))}</p><h1 class="wc-heading">Journal</h1><div class="wc-settings-section"><h2>Main Story</h2><p class="wc-state__copy">${esc(qActive?.description ?? 'No active story entry.')}</p></div><div class="wc-settings-section"><h2>Side Quests</h2><p class="wc-state__copy">Side quests and discovered memories are recorded here.</p></div><div class="wc-settings-section"><h2>World State</h2><p class="wc-state__copy">${vm.campaign?.fragments.length ?? 0} Heartroot Fragments received. Regional restoration and political commitments are separate responsibilities.</p></div></div><aside class="wc-menu__side"><p class="wc-kicker">QUEST LOG</p><h2 class="wc-heading">${all.length} ${all.length === 1 ? 'Journey' : 'Entries'}</h2>${all.map(quest => `<article class="wc-quest-card"><h3>${esc(quest.title)}</h3><p>${esc(quest.description)}</p><ul class="wc-objective-list">${quest.objectives.map(objective => {
      const complete = vm!.campaign?.completedObjectiveIds.includes(objective.id) ?? false;
      const isTracked = vm!.trackedObjectiveId === objective.id;
      return `<li data-active="${isTracked}"><span>${esc(objective.title)}${objective.optional ? ' · Optional' : ''}</span><span>${complete ? 'Complete' : 'Incomplete'}</span>${button(isTracked ? 'Stop Tracking' : 'Track Objective', 'track-objective', `data-objective="${isTracked ? '' : esc(objective.id)}" aria-pressed="${isTracked}"`)}</li>`;
    }).join('')}</ul></article>`).join('') || '<p class="wc-state__copy">Your discoveries will appear here.</p>'}${backButton()}</aside></div><footer class="wc-map-footer"><span>Esc&nbsp; Back</span><span>W A S D&nbsp; Navigate</span><span>Journal</span></footer>`);
  }

  function selectedCompanionId(): CompanionId | null {
    const party = vm?.party ?? vm?.campaign?.party;
    if (!party) return selectedCompanion;
    if (selectedCompanion && [party.combat, party.utility, party.scout].includes(selectedCompanion)) return selectedCompanion;
    return party.combat ?? party.utility ?? party.scout ?? null;
  }

  function companionState(): string {
    if (!vm) return '';
    const party = vm.party ?? vm.campaign?.party ?? null;
    const selected = selectedCompanionId();
    const definition = selected ? COMPANIONS.find(item => item.id === selected) : null;
    const role = selected ? ROLE_COPY[selected] : null;
    const abilities = selected ? vm.abilities.filter(ability => role?.abilityIds.includes(ability.id)) : [];
    const factionId = selected ? FACTION_BY_COMPANION[selected] : null;
    const tier = factionId ? vm!.relationships?.[factionId] : undefined;
    const bondTiers = ['WARY', 'COOPERATING', 'TRUSTED', 'COVENANT'];
    const tierText = tier && typeof tier === 'object' && 'bondTier' in tier ? bondTiers[tier.bondTier] ?? 'Bond data unavailable' : 'Bond data unavailable';
    return containerScreen('wc-menu', `${wordmark('companions')}<div class="wc-companions">
      <div class="wc-preview-host" data-preview-host data-companion="${esc(selected ?? '')}" aria-label="3D companion preview host"><div class="wc-preview-empty" data-preview-placeholder><strong>3D COMPANION PREVIEW</strong><span>Waiting for character renderer</span></div></div>
      <aside class="wc-companion-details"><p class="wc-kicker">COMPANIONS · ${esc(role?.role ?? '')}</p><h1>${esc(definition?.name ?? 'Traveling Companions').toUpperCase()}</h1><p>${esc(role?.role ?? 'Companion roles and abilities')}</p><div class="wc-bond"><span class="wc-label">BOND</span><span>${esc(tierText.toUpperCase())}</span><span class="wc-bond__leaf" aria-label="Bond tier">❧ ❧ ❧</span></div><hr class="wc-rule"><p class="wc-label">COMPANION ABILITIES</p><div class="wc-abilities">${abilities.map((ability, i) => `<article class="wc-ability"><span class="wc-ability__mark" aria-hidden="true">${['⌁','◇','✧'][i % 3]}</span><div><strong>${esc(ability.label)}</strong><p>${esc(ability.reason ?? '')}</p>${button(ability.available ? 'Use Ability' : 'Unavailable', 'ability', `data-ability="${esc(ability.id)}" ${ability.available ? '' : 'disabled'}`)}</div></article>`).join('') || `<p class="wc-state__copy">${'Companion ability data unavailable.'}</p>`}</div><section class="wc-party"><p class="wc-label">PARTY</p><div class="wc-party__grid">${[party?.combat, party?.utility, party?.scout].filter((id): id is CompanionId => Boolean(id)).map(id => COMPANIONS.find(companion => companion.id === id)!).map(companion => {
      const slot: Slot = companion.id === party?.scout ? 'scout' : companion.id === party?.utility ? 'utility' : 'combat';
      return `<button type="button" class="wc-party-card" data-ui-action="select-companion" data-focus-key="companion-${companion.id}" data-companion="${companion.id}" data-slot="${slot}" aria-pressed="${selected === companion.id}"><span class="wc-portrait wc-party-card__portrait wc-portrait--${companion.portrait}" ${PORTRAIT_ASSETS[companion.id] ? `style="background-image:url('${PORTRAIT_ASSETS[companion.id]}')"` : ''} role="img" aria-label="${companion.name} portrait"></span><strong>${companion.name}</strong><small>${slot.toUpperCase()}</small></button>`;
    }).join('')}</div></section>${backButton()}</aside></div><footer class="wc-map-footer"><span>Esc&nbsp; Back</span><span>Choose a companion to inspect or assign</span><span>U04 · Companion View</span></footer>`);
  }

  function settingsState(): string {
    if (!vm) return '';
    return containerScreen('wc-menu', wordmark('settings') + '<div class="wc-menu__body">' + settingsMarkup(vm) + (vm.error ? '<p class="wc-error" role="alert">' + esc(vm.error.message) + '</p>' : '') + '</div><footer class="wc-map-footer"><span>Esc&nbsp; Back</span><span>Enter to capture a binding</span><span>Settings</span></footer>');
  }
  function dialogueState(): string {
    const beat = vm?.dialogue ? { ...vm.dialogue, choices: vm.choice?.options ?? [] } : undefined;
    const line = beat?.lines[0];
    return containerScreen('wc-state', `<section class="wc-panel wc-state__card"><p class="wc-kicker">${esc(line ? speakerName[line.speaker] ?? line.speaker : 'STORY')}</p><h1 class="wc-heading">Dialogue</h1><p class="wc-dialogue-text">${esc(line?.text ?? '')}</p>${beat?.choices?.length ? `<div class="wc-choice">${beat.choices.map(choice => button(`<strong>${esc(choice.title)}</strong><small>${esc(choice.description)}</small>`, 'choose', `data-choice="${esc(choice.id)}" data-option="${esc(choice.id)}"`)).join('')}</div>` : ''}<div class="wc-actions">${button('Continue', 'dialogue-next', `data-beat="${esc(beat?.next ?? '')}"`, 'wc-action--primary')}${button('Skip Cinematic', 'skip-cinematic')}</div></section>`);
  }

  function choiceState(): string {
    const choice = vm?.choice;
    return containerScreen('wc-state', `<section class="wc-panel wc-state__card"><p class="wc-kicker">CHOOSE YOUR RESPONSE</p><h1 class="wc-heading">${esc(choice?.title ?? 'Choose Your Response')}</h1><p class="wc-state__copy">Consider the immediate result and the commitment that follows.</p><div class="wc-choice">${(choice?.options ?? []).map(option => button(`<strong>${esc(option.title)}</strong><small>${esc(option.description)}</small>`, 'choose', `data-choice="${esc(choice?.id)}" data-option="${esc(option.id)}"`, 'wc-action--primary')).join('')}</div>${vm?.error ? `<p class="wc-error" role="alert">${esc(vm.error.message)}</p>` : ''}</section>`);
  }

  function endingState(): string {
    const ending = vm?.ending;
    return containerScreen('wc-state wc-ending', `<section class="wc-panel wc-state__card"><p class="wc-kicker">THE FOREST YOU LEAVE BEHIND</p><h1 class="wc-state__title">${esc(ending?.title ?? 'Epilogue')}</h1><p class="wc-dialogue-text">${esc(ending?.summary ?? '')}</p><hr class="wc-rule"><h2 class="wc-heading">Epilogue</h2><p class="wc-state__copy">The living world remembers what was chosen.</p><div class="wc-actions">${button('View Credits', 'credits', '', 'wc-action--primary')}${button('Return to Title', 'title-screen')}</div></section>`);
  }

  function saveState(load: boolean): string { return vm ? saveMarkup(vm, load) : ''; }

  function creditsState(): string {
    return containerScreen('wc-state', `<section class="wc-panel wc-state__card"><p class="wc-kicker">WILD CROWN</p><h1 class="wc-heading">Credits</h1><div class="wc-settings-section"><h2>Created by</h2><p>Hoai-Nho Nguyen</p></div><div class="wc-settings-section"><h2>Story and Game Design · Engineering</h2><p>Wild Crown: The Broken Pact</p></div><p class="wc-state__copy">Thank you for walking with Erya.</p>${button('Return to Title', 'title-screen', '', 'wc-action--primary')}</section>`);
  }

  function renderMarkup(): string {
    if (!vm) return '';
    if (vm.screen === 'title') return titleState();
    if (vm.loading.active || vm.screen === 'loading') return loadingState();
    if (vm.screen === 'game') return playerHud();
    if (vm.screen === 'pause') return pauseState();
    if (vm.screen === 'map') return mapState();
    if (vm.screen === 'journal') return journalState();
    if (vm.screen === 'companions') return companionState();
    if (vm.screen === 'settings') return settingsState();
    if (vm.screen === 'dialogue') return dialogueState();
    if (vm.screen === 'choice') return choiceState();
    if (vm.screen === 'credits') return creditsState();
    return endingState();
  }

  function actionFor(buttonElement: HTMLElement): UIAction | null {
    if (!vm) return null;
    const action = buttonElement.dataset.uiAction;
    switch (action) {
      case 'new-game': return { type: 'new-game', runId: crypto.randomUUID() };
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
      case 'track-objective': return { type: 'track-objective', objectiveId: (buttonElement.dataset.objective || null) as ObjectiveId | null };
      case 'select-companion': {
        const id = buttonElement.dataset.companion as CompanionId | undefined;
        const slot = buttonElement.dataset.slot as Slot | undefined;
        if (!id || !slot) return null;
        selectedCompanion = id;
        return { type: 'select-companion', slot, companionId: id };
      }
      case 'ability': return { type: 'use-ability', abilityId: buttonElement.dataset.ability ?? '', targetId: vm.hud.targetId };
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
    if (item.dataset.uiAction === 'title-screen') { dispatch({ type: 'return-title' }); return; }
    if (item.dataset.uiAction === 'credits') { dispatch({ type: 'view-credits', endingId }); return; }
    if (item.dataset.uiAction === 'save-screen') { renderLocal(saveState(false)); return; }
    if (item.dataset.uiAction === 'load-screen') {
      renderLocal(saveState(true));
      if (!recoveryImportAllowed(vm?.loading.operationId)) {
        for (const control of container.querySelectorAll<HTMLElement>('[data-ui-action="import-file"], .wc-file-input')) control.remove();
        const recoveryControl = [...container.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)')].find(control => control.getClientRects().length > 0);
        recoveryControl?.focus({ preventScroll: true });
      }
      return;
    }
    if (item.dataset.uiAction === 'import-file') { container.querySelector<HTMLInputElement>('.wc-file-input')?.click(); return; }
    const resolvedAction = actionResolved ? action : actionFor(item);
    if (resolvedAction) dispatch(resolvedAction);
  }

  function renderLocal(markup: string) {
    previewCleanup?.();
    previewCleanup = null;
    lastRenderSignature = '';
    container.innerHTML = markup;
    const controls = [...container.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)')].filter(control => control.getClientRects().length > 0);
    focusedIndex = 0;
    controls[0]?.focus({ preventScroll: true });
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
    const host = container.querySelector<HTMLElement>('[data-preview-host]');
    if (!host) return;
    const companion = (host.dataset.companion || null) as CompanionId | null;
    const cleanup = options.onPreviewHost?.(host, companion);
    previewCleanup = typeof cleanup === 'function' ? cleanup : null;
  }

  function render(next: GameViewModel) {
    if (destroyed) return;
    const signature = gameUiSignature(next);
    if (signature === lastRenderSignature) return;
    if (pointerControl) {
      deferredViewModel = next;
      return;
    }
    if (deferredRenderFrame) cancelAnimationFrame(deferredRenderFrame);
    deferredRenderFrame = 0;
    deferredViewModel = null;
    lastRenderSignature = signature;
    const activeControl = document.activeElement instanceof HTMLElement && container.contains(document.activeElement)
      ? document.activeElement : null;
    const focus = activeControl?.dataset.focusKey ?? null;
    const previousScreen = vm?.screen;
    const existingPreview = container.querySelector<HTMLElement>('[data-preview-host]');
    vm = next;
    const keepPreview = Boolean(existingPreview && next.screen === 'companions' && existingPreview.dataset.companion === selectedCompanionId());
    if (!keepPreview) {
      previewCleanup?.();
      previewCleanup = null;
    }
    const staging = document.createElement('div');
    staging.innerHTML = renderMarkup();
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
    if (keepPreview && existingPreview) staging.querySelector('[data-preview-host]')?.replaceWith(existingPreview);
    const nextFocusedControl = focus
      ? [...staging.querySelectorAll<HTMLElement>('[data-focus-key]')].find(control => control.dataset.focusKey === focus) ?? null
      : null;
    if (activeControl && nextFocusedControl) reconcileFocusedControl(activeControl, nextFocusedControl);
    container.replaceChildren(...staging.childNodes);

    container.classList.toggle('wc-reduced-motion', next.settings.reducedMotion);
    if (!keepPreview) bindPreview();
    const controls = [...container.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')].filter(control => control.getClientRects().length > 0);
    const restored = activeControl && container.contains(activeControl)
      ? activeControl
      : focus ? [...container.querySelectorAll<HTMLElement>('[data-focus-key]')].find(control => control.dataset.focusKey === focus) ?? null : null;
    const focusTarget = restored ?? (activeControl !== null || previousScreen !== next.screen ? controls[0] ?? null : null);
    focusTarget?.focus({ preventScroll: true });
    const index = focusTarget ? controls.indexOf(focusTarget) : -1;
    if (index >= 0) focusedIndex = index;
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
    const pauseBinding = vm?.bindings.keyboard.pause?.toLowerCase();
    if (vm && (vm.screen === 'game' || vm.screen === 'pause') && pauseBinding && pauseBinding === event.key.toLowerCase()) {
      dispatch({ type: vm.screen === 'game' ? 'pause' : 'resume' });
      event.preventDefault();
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
      if (vm?.screen === 'pause') dispatch({ type: 'resume' });
      else dispatch({ type: 'close-screen' });
      event.preventDefault();
      return;
    }
    if (!container.contains(document.activeElement)) return;
    const controls = [...container.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')].filter(control => control.getClientRects().length > 0);
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
    const pressed = new Set(gamepad.buttons.flatMap((button, index) => button.pressed ? [index] : []));
    const newButton = gamepad.buttons.findIndex((button, index) => button.pressed && !lastGamepadButtons.has(index));
    const controls = [...container.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)')].filter(control => control.getClientRects().length > 0);
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const activeIndex = active ? controls.indexOf(active) : -1;
    if (vm?.screen === 'game') {
      if (gamepadActionJustPressed(vm.bindings, 'pause', pressed, lastGamepadButtons)) dispatch({ type: 'pause' });
      else if (gamepadActionJustPressed(vm.bindings, 'map', pressed, lastGamepadButtons)) dispatch({ type: 'open-map' });
      else if (gamepadActionJustPressed(vm.bindings, 'journal', pressed, lastGamepadButtons)) dispatch({ type: 'open-journal' });
      else if (gamepadActionJustPressed(vm.bindings, 'companions', pressed, lastGamepadButtons)) dispatch({ type: 'open-companions' });
    } else if (newButton >= 0 && active instanceof HTMLInputElement && active.dataset.remap && active.dataset.remapDevice === 'gamepad') {
      const binding = 'Gamepad Button ' + (newButton + 1);
      active.value = binding;
      active.dataset.captured = 'true';
      dispatch({ type: 'remap', device: 'gamepad', actionId: active.dataset.remap, binding });
    } else if ((pressed.has(12) && !lastGamepadButtons.has(12)) || (pressed.has(15) && !lastGamepadButtons.has(15))) {
      focusedIndex = activeIndex >= 0 ? (activeIndex + 1) % Math.max(controls.length, 1) : Math.min(focusedIndex, Math.max(controls.length - 1, 0));
      controls[focusedIndex]?.focus();
    } else if ((pressed.has(13) && !lastGamepadButtons.has(13)) || (pressed.has(14) && !lastGamepadButtons.has(14))) {
      focusedIndex = activeIndex >= 0 ? (activeIndex - 1 + controls.length) % Math.max(controls.length, 1) : Math.max(focusedIndex - 1, 0);
      controls[focusedIndex]?.focus();
    } else if (newButton === 0 && active && container.contains(active)) {
      focusedIndex = Math.max(0, activeIndex);
      active.click();
    } else if (newButton === 1) {
      if (vm?.screen === 'pause') dispatch({ type: 'resume' });
      else dispatch({ type: 'close-screen' });
    }
    lastGamepadButtons = pressed;
  }

  container.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('pointerup', onPointerEnd, true);
  document.addEventListener('pointercancel', onPointerEnd, true);
  container.addEventListener('click', onClick);
  container.addEventListener('input', handleChange);
  container.addEventListener('change', handleChange);
  document.addEventListener('keydown', escKey, true);
  keyListener = escKey;
  if (options.initialViewModel) render(options.initialViewModel);

  return {
    get element() { return container; },
    render,
    updateGamepad,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      previewCleanup?.();
      previewCleanup = null;
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
      if (keyListener) document.removeEventListener('keydown', keyListener, true);
      container.replaceChildren();
      container.remove();
      vm = null;
    },
  };
}
