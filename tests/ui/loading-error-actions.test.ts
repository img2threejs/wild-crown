import { expect, it } from 'bun:test';
import { loadingErrorActions, recoveryImportAllowed } from '../../src/ui/loading-error-actions.js';

const blockedAssetError = {
  code: 'asset-unavailable',
  message: 'Required asset greenwake-environment is not verified (blocked); gameplay is blocked.',
  recoverable: false,
};

it('projects safe exits and no Retry for a terminal blocked-asset error', () => {
  expect(loadingErrorActions(blockedAssetError, 'greenwake-load', true)).toEqual([
    { type: 'save-screen' },
    { type: 'load-screen' },
    { type: 'open-settings' },
    { type: 'return-title' },
  ]);
});

it('preserves Retry for recoverable failures with an operation and keeps escape actions', () => {
  const networkError = { code: 'network-error', message: 'Network request failed.', recoverable: true };
  expect(loadingErrorActions(networkError, 'greenwake-load', false)).toEqual([
    { type: 'retry-load', operationId: 'greenwake-load' },
    { type: 'load-screen' },
    { type: 'open-settings' },
    { type: 'return-title' },
  ]);
});

it('does not project Retry without an operation id and only offers Save for an active campaign', () => {
  expect(loadingErrorActions({ ...blockedAssetError, recoverable: true }, undefined, false)).toEqual([
    { type: 'load-screen' },
    { type: 'open-settings' },
    { type: 'return-title' },
  ]);
});

it('keeps durable-event recovery limited to Retry, Load Game, and Return to Title', () => {
  const writeError = { code: 'transaction', message: 'Campaign write failed.', recoverable: true };
  expect(loadingErrorActions(writeError, 'durable-event', true)).toEqual([
    { type: 'retry-load', operationId: 'durable-event' },
    { type: 'load-screen' },
    { type: 'return-title' },
  ]);
});

it('blocks Save Import by the durable operation id, not the storage error code', () => {
  expect(recoveryImportAllowed('durable-event')).toBe(false);
  expect(recoveryImportAllowed('asset-load')).toBe(true);
  expect(recoveryImportAllowed(undefined)).toBe(true);
});
