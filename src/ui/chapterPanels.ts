import type { CompanionId, FieldCommand, GameViewModel, SaveSlotViewModel } from '../game/contracts.js';
import { esc, button } from './markup.js';
import { icon, type IconName } from './icons.js';

type Wheel = NonNullable<GameViewModel['wheel']>;
type ObjectiveHud = NonNullable<GameViewModel['objectiveHud']>;
const COMMAND_ICON: Record<FieldCommand, IconName> = { follow: 'follow', stay: 'stay', focus: 'focus', defend: 'defend', search: 'search', distract: 'distract', special: 'special', recall: 'recall' };
const PORTRAIT: Partial<Record<CompanionId, string>> = { vara: '/ui/portrait-vara.webp', koro: '/ui/portrait-koro.webp', asha: '/ui/portrait-asha.webp', sable: '/ui/portrait-sable.webp', nyra: '/ui/portrait-nyra.webp', solkar: '/ui/portrait-solkar.webp' };

/**
 * The equipped companion's eight verb sectors, with simulation-owned availability and cooldown reasons. The hub shows
 * the companion, target, tokens and current selection. Pointer, keyboard
 * and gamepad all drive the same `wheel` view model; sectors are real buttons so assistive tech reads the reasons.
 */
export function wheelMarkup(wheel: Wheel): string {
    const active = wheel.companion;
    const selected = wheel.selectedSector !== null ? active.commands[wheel.selectedSector] : undefined;
    const sectors = active.commands.map((command, index) => {
        const reason = command.available ? '' : command.reason ?? 'Unavailable.';
        return `<button type="button" class="wc-wheel__sector" style="--i:${index}" data-ui-action="wheel-sector" data-sector="${index}" data-command="${command.command}" data-focus-key="wheel-sector-${index}" data-selected="${wheel.selectedSector === index}" data-available="${command.available}" aria-disabled="${!command.available}"${reason ? ` title="${esc(reason)}"` : ''} aria-label="${esc(command.label)}${reason ? ' — ' + esc(reason) : ''}"><span class="wc-wheel__glyph">${icon(COMMAND_ICON[command.command])}</span><span class="wc-wheel__label"><kbd>${index + 1}</kbd> ${esc(command.label)}</span></button>`;
    }).join('');
    const portrait = active?.companionId ? PORTRAIT[active.companionId] : undefined;
    const reason = selected ? (selected.available ? 'Release to command' : selected.reason ?? 'Unavailable.') : 'Aim at a command, then release';
    const hub = `<div class="wc-wheel__hub" aria-live="polite">${portrait ? `<span class="wc-portrait wc-wheel__portrait" style="background-image:url('${portrait}')" aria-hidden="true"></span>` : ''}<strong>${esc(active?.companionId ? active.name : 'No companion')}</strong><span class="wc-wheel__target">Target: ${esc(wheel.target ?? 'none')}</span><span class="wc-wheel__tokens">Command tokens: ${wheel.tokens}</span><em class="wc-wheel__reason" data-available="${selected?.available ?? true}">${esc(reason)}</em></div>`;
    return `<div class="wc-wheel" role="dialog" aria-label="Companion command wheel" data-companion="${active.companionId}"><div class="wc-wheel__backdrop" data-ui-action="wheel-cancel" aria-hidden="true"></div><div class="wc-wheel__ring" role="group" aria-label="Commands">${sectors}${hub}</div><p class="wc-wheel__hint">Hold to open · aim with move keys or stick · 1–8 select · release to command · Esc / B cancels</p></div>`;
}

/** Destination text under the objective: a search hint when the target is undiscovered, else the distance. */
export function destinationText(destination: NonNullable<ObjectiveHud['destination']>): string {
    if (destination.hint !== null && destination.distanceMeters === null) return destination.hint;
    return destination.distanceMeters === null ? '' : 'Follow the trail · ' + Math.ceil(destination.distanceMeters) + ' m';
}

/** Chapter objective HUD: quest, step position, the tracked objective, optional counter, interaction hint and destination arrow. */
export function objectiveHudMarkup(hud: ObjectiveHud, interactKey: string): string {
    const destination = hud.destination;
    const arrow = destination && destination.bearingDegrees !== null
        ? `<svg viewBox="0 0 24 24" aria-hidden="true" style="transform:rotate(${destination.bearingDegrees}deg)"><path d="M12 2 21 21 12 16 3 21Z" fill="currentColor"/></svg>` : '';
    return `<aside class="wc-panel wc-objective wc-objective--chapter" aria-label="Current objective"><p class="wc-objective__quest"><strong>${esc(hud.questTitle)}</strong>${hud.step ? `<span>Step ${hud.step.index} of ${hud.step.total}</span>` : ''}</p><p class="wc-objective__title">${esc(hud.objectiveTitle)}${hud.counter ? ` <span class="wc-objective__counter">${esc(hud.counter)}</span>` : ''}</p>${hud.interaction ? `<p class="wc-objective__hint">${interactKey ? `<kbd>${esc(interactKey)}</kbd> ` : ''}${esc(hud.interaction)}</p>` : ''}${destination ? `<div class="wc-objective__dest" aria-label="Objective destination">${arrow}<p data-dest-text>${esc(destinationText(destination))}</p></div>` : ''}<p class="wc-objective__chapter">${esc(hud.chapterLabel)}</p></aside>`;
}

/** Writes the continuous destination values in place (the HUD is not rebuilt per frame to rotate an arrow). */
export function patchObjectiveDestination(container: Pick<HTMLElement, 'querySelector'>, destination: ObjectiveHud['destination'] | undefined): void {
    if (!destination) return;
    const panel = container.querySelector<HTMLElement>('.wc-objective__dest');
    if (!panel) return;
    const arrow = panel.querySelector<SVGElement>('svg');
    if (arrow && destination.bearingDegrees !== null) {
        const transform = `rotate(${destination.bearingDegrees}deg)`;
        if (arrow.style.transform !== transform) arrow.style.transform = transform;
    }
    const copy = panel.querySelector<HTMLElement>('[data-dest-text]');
    const text = destinationText(destination);
    if (copy && copy.textContent !== text) copy.textContent = text;
}

const SEGMENT_LABEL: Record<string, string> = { prologue: 'Prologue', greenwake: 'Greenwake', canopy: 'Whispering Canopy', bamboo: 'Blood Bamboo Valley', grove: 'The Grove' };
const SCOPE_LABEL: Record<SaveSlotViewModel['scope'], string> = { production: 'Production', 'candidate-chapters': 'Candidate Chapters' };
export const segmentLabel = (segmentId: string | null | undefined): string => (segmentId && SEGMENT_LABEL[segmentId]) || '';
export const scopeLabel = (scope: SaveSlotViewModel['scope']): string => SCOPE_LABEL[scope];

/** One-line description of a slot: scope, hero, story segment and the named checkpoint it resumes at. */
export function slotDescription(slot: SaveSlotViewModel, heroName: string | null, checkpoint: string | null): string {
    return [scopeLabel(slot.scope), heroName, segmentLabel(slot.segmentId), checkpoint ? 'Saved at ' + checkpoint : ''].filter(Boolean).join(' · ');
}

/** Candidate Chapters menu: New Journey, Continue Journey (latest autosave or manual slot of the candidate scope), Load Journey. */
export function chaptersMenuMarkup(vm: GameViewModel, latest: string | null): string {
    const hasContinue = Boolean(vm.saves.continueSlotId);
    return `<section class="wc-panel wc-sheet wc-state__card wc-chapters__card"><h1 class="wc-heading">Candidate Journey</h1><p class="wc-state__copy">Act I from the Prologue to the Grove with generated, not release-verified assets. Progress is saved in a separate candidate save database and never touches production saves or Trials.</p><div class="wc-actions">${button('New Journey', 'begin-journey', '', 'wc-action--primary')}${button('Continue Journey', 'continue', hasContinue ? '' : 'disabled aria-describedby="wc-chapters-latest"')}${button('Load Journey', 'load-screen', vm.saves.slots.length ? '' : 'disabled')}${button('Return to Title', 'return-title', '', 'wc-action--quiet')}</div><p class="wc-meta" id="wc-chapters-latest">${esc(latest ?? 'No candidate journey has been saved yet.')}</p></section>`;
}

type PartyPanel = NonNullable<GameViewModel['partyPanel']>;

/** Replacing the sole companion never adds a second ally or clears the hero's remembered choice. */
export function partyPanelMarkup(entry: PartyPanel): string {
    const options = entry.options.map(option => {
        const assigned = entry.companionId === option.companionId;
        return `<button type="button" class="wc-party-option" data-ui-action="select-companion" data-companion="${option.companionId}" data-focus-key="party-${option.companionId}" aria-pressed="${assigned}" ${option.available ? '' : 'disabled'}${option.reason ? ` title="${esc(option.reason)}"` : ''}>${esc(option.name)}${!option.available && !assigned && option.reason ? `<small>${esc(option.reason)}</small>` : ''}</button>`;
    }).join('');
    return `<section class="wc-party-panel" aria-label="Choose one companion"><div class="wc-party-slot" role="group" aria-label="Equipped companion"><h3>One companion · ${entry.companionId ? '1 / 1' : '0 / 1'}</h3><div class="wc-party-slot__options">${options}</div></div></section>`;
}

/** Individual Bond and Dominion levels (0–100) of one companion; faction covenants are a separate section. */
export function relationshipMeterMarkup(progress: NonNullable<GameViewModel['companionProgress']>[CompanionId] | undefined): string {
    if (!progress) return '';
    const story = progress.recruited ? 'Story alliance established.' : 'Available now. Story choices build Bond independently.';
    const meter = (label: string, value: number, kind: string) => `<div class="wc-meter wc-meter--${kind}" aria-label="${label} ${value} of 100"><span>${label}</span><span class="wc-meter__track" aria-hidden="true"><i class="wc-meter__fill" style="width:${Math.max(0, Math.min(100, value))}%"></i></span><span>${value}</span></div>`;
    return `<div class="wc-relationship" data-recruited="${progress.recruited}"><p class="wc-meta">${story}</p>${meter('Bond', progress.bond, 'bond')}${meter('Dominion', progress.dominion, 'dominion')}</div>`;
}
