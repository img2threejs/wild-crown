import type { GameViewModel, UIAction } from '../game/contracts.js';

export type LoadingErrorAction =
  | Extract<UIAction, { type: 'retry-load' | 'open-settings' | 'return-title' }>
  | { type: 'load-screen' }
  | { type: 'save-screen' };

export function loadingErrorActions(
  error: GameViewModel['error'],
  operationId: string | undefined,
  hasActiveCampaign: boolean,
): LoadingErrorAction[] {
  if (!error) return [];

  const actions: LoadingErrorAction[] = [];
  if (error.recoverable && operationId) actions.push({ type: 'retry-load', operationId });
  if (operationId === 'durable-event') {
    actions.push({ type: 'load-screen' }, { type: 'return-title' });
    return actions;
  }
  if (hasActiveCampaign) actions.push({ type: 'save-screen' });
  actions.push({ type: 'load-screen' }, { type: 'open-settings' }, { type: 'return-title' });
  return actions;
}

export function recoveryImportAllowed(operationId: string | undefined): boolean {
  return operationId !== 'durable-event';
}
