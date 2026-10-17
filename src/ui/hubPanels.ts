import type { GameViewModel, HubViewModel } from '../game/contracts';
import { esc, button } from './markup';

type Hub = HubViewModel;
type Phase = Hub['practice']['phase'];
const PHASE_LABEL: Record<Phase, string> = {
    idle: 'Idle',
    warning: 'Warning',
    strike: 'Strike',
    recovery: 'Recovery',
};
const PHASE_DESCRIPTION: Record<Phase, string> = {
    idle: 'No training in progress.',
    warning: 'Dodge at the end of the warning.',
    strike: 'Timing checked — no damage or rewards.',
    recovery: 'Recovering — a fresh warning will follow.',
};

export function hubMarkup(viewModel: GameViewModel): string {
    const hub = viewModel.hub;
    if (!hub) return '';
    const header = `<header class="wc-hub__head"><h1 id="wc-hub-name" class="wc-heading">${esc(hub.name)}</h1><p class="wc-hub__stage"><span class="wc-label">GROWTH STAGE</span> <strong>${esc(hub.stage)}</strong></p></header>`;
    const quick = `<div class="wc-hub__quick"><p class="wc-label">QUICK ACCESS</p><div class="wc-hub__quick-actions">${button('Companions', 'companions', `aria-current="false"`, 'wc-action--quiet')}${button('Journal', 'journal', `aria-current="false"`, 'wc-action--quiet')}</div></div>`;
    return `<section class="wc-panel wc-sheet wc-hub" aria-labelledby="wc-hub-name">${header}${quick}${practiceSection(hub)}${upgradesSection(hub)}${memoriesSection(hub)}<footer class="wc-hub__foot"><button type="button" class="wc-action wc-action--quiet" data-ui-action="close" data-focus-key="hub-close" aria-label="Back">Esc&nbsp;&nbsp; Back</button></footer></section>`;
}

/** Milestone-earned upgrade rows: title, description, learned/available/locked state, requirement text, dispatchable button. The disabled gate stays in CSS-attached state-attribute so the same row presents Locked and Learned without two builders. */
function upgradesSection(hub: Hub): string {
    const items = hub.upgrades.map(upgrade => {
        const stateAttr = upgrade.learned ? 'learned' : upgrade.available ? 'available' : 'locked';
        const stateLabel = upgrade.learned ? 'Learned' : upgrade.available ? 'Available' : 'Locked';
        const buttonLabel = upgrade.learned ? 'Learned' : 'Learn upgrade';
        const disabled = !(upgrade.available && !upgrade.learned);
        return `<li class="wc-hub__upgrade" data-state="${stateAttr}"><div class="wc-hub__upgrade-body"><h3 class="wc-hub__upgrade-title">${esc(upgrade.title)}</h3><p class="wc-state__copy">${esc(upgrade.description)}</p><p class="wc-hub__upgrade-meta" id="wc-hub-requirement-${esc(upgrade.id)}"><span class="wc-label">REQUIREMENT</span> <span>${esc(upgrade.requirement)}</span></p><p class="wc-hub__upgrade-state"><span class="wc-label">STATUS</span> <span data-state="${stateAttr}">${esc(stateLabel)}</span></p></div><div class="wc-hub__upgrade-action"><button type="button" class="wc-action wc-action--primary wc-hub__upgrade-button" data-ui-action="learn-upgrade" data-focus-key="learn-upgrade-${esc(upgrade.id)}" data-upgrade="${esc(upgrade.id)}" ${disabled ? `disabled aria-describedby="wc-hub-requirement-${esc(upgrade.id)}"` : ''} aria-label="${esc(buttonLabel + ' — ' + upgrade.title)}">${esc(buttonLabel)}</button></div></li>`;
    });
    const body = items.length ? items.join('') : '<li><p class="wc-state__copy">No upgrades are tracked for this hub yet.</p></li>';
    return `<section class="wc-hub__section wc-hub__upgrades" aria-labelledby="wc-hub-upgrades-heading"><header><h2 id="wc-hub-upgrades-heading" class="wc-heading">Milestone Upgrades</h2><p class="wc-state__copy">Upgrades unlocked by completed milestones. Choose an available upgrade to learn it; locked upgrades list what still needs to happen.</p></header><ul class="wc-hub__upgrade-list">${body}</ul></section>`;
}

/** Unlocked memories as native <details>/<summary> blocks rendering the simulation-supplied speaker/text lines. */
function memoriesSection(hub: Hub): string {
    if (!hub.memories.length) {
        return `<section class="wc-hub__section wc-hub__memories" aria-labelledby="wc-hub-memories-heading"><header><h2 id="wc-hub-memories-heading" class="wc-heading">Unlocked Memories</h2></header><p class="wc-state__copy" data-empty="true">No memories have been unlocked here yet. Memories appear as milestones are earned across the regions you visit.</p></section>`;
    }
    const items = hub.memories.map(memory => {
        const lines = memory.lines.map(line =>
            `<li class="wc-hub__memory-line"><span class="wc-hub__memory-speaker">${esc(line.speaker)}</span><span class="wc-hub__memory-text">${esc(line.text)}</span></li>`,
        ).join('');
        return `<details class="wc-hub__memory"><summary class="wc-hub__memory-summary"><span class="wc-hub__memory-title">${esc(memory.title)}</span><span class="wc-label">SPOKEN LINES</span></summary><ol class="wc-hub__memory-lines">${lines}</ol></details>`;
    }).join('');
    return `<section class="wc-hub__section wc-hub__memories" aria-labelledby="wc-hub-memories-heading"><header><h2 id="wc-hub-memories-heading" class="wc-heading">Unlocked Memories</h2></header><details class="wc-hub__memory-list"><summary>Read ${hub.memories.length} completed conversations</summary>${items}</details></section>`;
}

/** The simulation owns availability and timing; this panel only dispatches controls. */
function practiceSection(hub: Hub): string {
    const practice = hub.practice;
    const reasonMarkup = practice.available
        ? `<p class="wc-hub__practice-reason" data-available="true">${esc(practice.reason || 'Train your timing here. Practice is available.')}</p>`
        : `<p class="wc-hub__practice-reason" data-available="false" id="wc-hub-practice-reason">${esc(practice.reason || 'Practice is not available right now.')}</p>`;
    const stopButton = practice.active
        ? `<button type="button" class="wc-action" data-ui-action="stop-dodge-training" data-focus-key="stop-dodge-training" aria-label="Stop dodge practice">Stop Practice</button>`
        : '';
    const startButton = practice.active ? '' : `<button type="button" class="wc-action wc-action--primary" data-ui-action="start-dodge-training" data-focus-key="start-dodge-training" ${!practice.available ? 'disabled aria-describedby="wc-hub-practice-reason"' : ''}>Start Practice</button>`;
    const sessionMarkup = practice.active
        ? `<dl class="wc-hub__practice-stats" aria-live="polite"><div><dt>Attempts</dt><dd>${practice.attempts}</dd></div><div><dt>Dodged</dt><dd>${practice.dodged}</dd></div><div><dt>Phase</dt><dd><span class="wc-hub__practice-phase" data-phase="${esc(practice.phase)}">${esc(PHASE_LABEL[practice.phase])}</span><small>${esc(PHASE_DESCRIPTION[practice.phase])}</small></dd></div></dl>`
        : '';
    return `<section class="wc-hub__section wc-hub__practice" aria-labelledby="wc-hub-practice-heading"><header><h2 id="wc-hub-practice-heading" class="wc-heading">Dodge Practice</h2><p class="wc-state__copy">Dodge as the warning ends. No damage or quest rewards.</p></header>${reasonMarkup}<div class="wc-hub__practice-actions">${startButton}${stopButton}</div>${sessionMarkup}</section>`;
}

/**
 * Gameplay HUD strip for an active dodge practice: phase, attempts, dodged, Stop. Renders empty outside an active
 * session so the world HUD never carries hidden chrome for it.
 */
export function hubPracticeHudMarkup(viewModel: GameViewModel): string {
    const practice = viewModel.hub?.practice;
    if (!practice?.active) return '';
    return `<aside class="wc-hub-practice-hud" aria-label="Active dodge practice" data-phase="${esc(practice.phase)}" role="status"><div class="wc-hub-practice-hud__phase"><span class="wc-label">PRACTICE</span><strong data-phase="${esc(practice.phase)}">${esc(PHASE_LABEL[practice.phase])}</strong><small>${esc(PHASE_DESCRIPTION[practice.phase])}</small></div><dl class="wc-hub-practice-hud__stats"><div><dt>Attempts</dt><dd>${practice.attempts}</dd></div><div><dt>Dodged</dt><dd>${practice.dodged}</dd></div></dl><button type="button" class="wc-action" data-ui-action="stop-dodge-training" data-focus-key="hub-hud-stop-dodge-training" aria-label="Stop dodge practice">Stop Practice</button></aside>`;
}
