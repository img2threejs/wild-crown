import { mountGameApplication } from '../../src/app/GameApplication.js';

type InputActions = { moveZ: number; dodgePressed: boolean };
type TestInput = { setEnabled(enabled: boolean): void; sample(): InputActions };
type SmokeResult = { passed: boolean; moveZ: number; dodgePressed: boolean; message: string };

declare global {
  interface Window { __inputHostSmoke?: SmokeResult }
}

const root = document.querySelector<HTMLElement>('#application-root');
const status = document.querySelector<HTMLElement>('#test-status');
if (!root || !status) throw new Error('Input smoke page is missing its application root or status node.');

const app = mountGameApplication(root);
try {
  // This smoke intentionally observes the private adapter on the real mounted application.
  const observedApp = app as unknown as { input: TestInput };
  const input = observedApp.input;
  input.setEnabled(true);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', bubbles: true, cancelable: true }));
  window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true }));
  const actions = input.sample();
  window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true, cancelable: true }));
  window.dispatchEvent(new KeyboardEvent('keyup', { key: 'w', code: 'KeyW', bubbles: true, cancelable: true }));
  if (actions.moveZ !== 1 || !actions.dodgePressed) throw new Error('Mounted game input did not deliver forward movement and dodge.');
  const result: SmokeResult = { passed: true, moveZ: actions.moveZ, dodgePressed: actions.dodgePressed, message: 'Mounted game input delivers movement and dodge.' };
  status.textContent = 'PASS ' + result.message;
  window.__inputHostSmoke = result;
} catch (error) {
  const result: SmokeResult = { passed: false, moveZ: 0, dodgePressed: false, message: error instanceof Error ? error.message : String(error) };
  status.textContent = 'FAIL ' + result.message;
  window.__inputHostSmoke = result;
  throw error;
} finally {
  app.dispose();
}
