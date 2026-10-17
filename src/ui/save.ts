import playerCopy from '../../docs/production/content/PLAYER-COPY.en.json' with { type: 'json' };
import type { GameViewModel } from '../game/contracts';
import { heroById } from '../game/heroes';
import { slotDescription } from './chapterPanels';
import { checkpointLabel, esc } from './markup';

/**
 * Save / Load screen. Candidate Chapters slots show their scope, hero, story segment and the named checkpoint they resume
 * at; unfinished encounters restart there. The per-run autosave slot can be loaded but not overwritten by hand.
 */
export function saveMarkup(viewModel: GameViewModel, load: boolean): string {
  const slots = viewModel.saves.slots;
  const regionName = (id: string) => viewModel.map.regions.find(region => region.id === id)?.name ?? id.replaceAll('-', ' ');
  const chapters = viewModel.session?.kind === 'chapters';
  const row = (slot: (typeof slots)[number]): string => {
    const detail = chapters || slot.scope === 'candidate-chapters'
      ? slotDescription(slot, slot.heroId ? heroById(slot.heroId).name : null, checkpointLabel(slot.checkpointId))
      : `${slot.kind === 'campaign' ? playerCopy.save.journey : playerCopy.title.first_pact}`;
    const meta = slot.exists
      ? `${esc(detail)} · ${esc(playerCopy.save.chapter)} ${slot.chapter} · ${esc(regionName(slot.regionId))} · ${esc(new Date(slot.updatedAt).toLocaleString())}`
      : esc(playerCopy.save.empty_slot);
    const label = slot.autosave ? `${esc(slot.label)} · ${esc(playerCopy.save.autosave)}` : esc(slot.label);
    const disabled = load ? !slot.exists : slot.autosave;
    return `<div class="wc-save-row" data-autosave="${slot.autosave}" data-scope="${slot.scope}"><div><strong>${label}</strong><div class="wc-save-meta">${meta}</div></div><button type="button" class="wc-action wc-action--primary" data-ui-action="${load ? 'load' : 'save'}" data-slot="${esc(slot.slotId)}" ${disabled ? 'disabled' : ''}>${esc(load ? playerCopy.title.load_game : playerCopy.save.manual_save)}</button></div>`;
  };
  const resumeNote = chapters && viewModel.session?.checkpointName
    ? `<p class="wc-state__copy" id="wc-save-resume">Saved at ${esc(viewModel.session.checkpointName)}. Unfinished encounters restart here.</p>` : '';
  const exportSlot = viewModel.saves.continueSlotId;
  return `<section class="wc-screen wc-state"><section class="wc-panel wc-sheet wc-state__card"><h1 class="wc-heading">${esc(load ? playerCopy.save.load_title : playerCopy.save.title)}</h1><p class="wc-state__copy">${esc(playerCopy.save.local_storage_notice)}</p>${resumeNote}<div class="wc-stack">${slots.map(row).join('') || `<p class="wc-state__copy">${esc(playerCopy.save.empty_slot)}</p>`}</div><div class="wc-actions"><button type="button" class="wc-action" data-ui-action="create-save-slot">${esc(playerCopy.save.slot)} +</button><button type="button" class="wc-action" data-ui-action="import-file">${esc(playerCopy.save.import)}</button><button type="button" class="wc-action" data-ui-action="export" ${exportSlot ? `data-slot="${esc(exportSlot)}"` : 'disabled'}>${esc(playerCopy.save.export)}</button><button type="button" class="wc-action wc-action--quiet" data-ui-action="close">${esc(playerCopy.common.back)}</button></div><input class="wc-file-input" type="file" accept="application/json,.json" hidden aria-label="${esc(playerCopy.save.import)}">${viewModel.error ? `<p class="wc-error" role="alert">${esc(viewModel.error.message)}</p>` : ''}</section></section>`;
}
