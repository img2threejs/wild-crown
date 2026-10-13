import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { DEFAULT_INPUT_BINDINGS, normalizeInputBindings, type InputBindingMaps } from '../../src/game/contracts.js';
import { RuntimeInput } from '../../src/input/RuntimeInput.js';

type KeyboardHandler = (event: KeyboardEvent) => void;
type MockKeyboardEvent = {
  key: string;
  repeat: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
};
type MockButton = { pressed: boolean; touched: boolean; value: number };

type TestEnvironment = {
  input: RuntimeInput;
  handlers: Map<string, KeyboardHandler[]>;
  buttons: MockButton[];
  axes: number[];
  setGamepadConnected(connected: boolean): void;
  keyDown(key: string, repeat?: boolean): MockKeyboardEvent;
  keyUp(key: string): MockKeyboardEvent;
  setNow(milliseconds: number): void;
};

const globalNames = ['window', 'document', 'navigator', 'performance'] as const;
let originalGlobals = new Map<string, PropertyDescriptor | undefined>();
let environment: TestEnvironment | undefined;

function restoreGlobals(): void {
  for (const name of globalNames) {
    const descriptor = originalGlobals.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originalGlobals.clear();
}

function makeBindings(): InputBindingMaps {
  return {
    keyboard: { ...DEFAULT_INPUT_BINDINGS.keyboard },
    gamepad: { ...DEFAULT_INPUT_BINDINGS.gamepad },
  };
}

function makeEnvironment(): TestEnvironment {
  const handlers = new Map<string, KeyboardHandler[]>();
  const buttons = Array.from({ length: 16 }, () => ({ pressed: false, touched: false, value: 0 }));
  const axes = [0, 0];
  let connected = false;
  let now = 1000;
  const gamepad = {
    connected: true,
    buttons,
    axes,
    id: 'synthetic-test-pad',
    index: 0,
    mapping: 'standard',
    timestamp: 0,
  } as unknown as Gamepad;
  const listeners = {
    addEventListener(type: string, listener: KeyboardHandler) {
      const entries = handlers.get(type) ?? [];
      entries.push(listener);
      handlers.set(type, entries);
    },
    removeEventListener(type: string, listener: KeyboardHandler) {
      handlers.set(type, (handlers.get(type) ?? []).filter(entry => entry !== listener));
    },
  };

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: listeners,
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { hidden: false, addEventListener: listeners.addEventListener, removeEventListener: listeners.removeEventListener },
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { getGamepads: () => connected ? [gamepad] : [] },
  });
  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    value: { now: () => now },
  });

  const input = new RuntimeInput({ isConnected: true } as HTMLElement);
  input.setBindings(makeBindings());
  input.setEnabled(true);

  const dispatch = (type: 'keydown' | 'keyup', key: string, repeat = false): MockKeyboardEvent => {
    const event: MockKeyboardEvent = {
      key,
      repeat,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
    };
    for (const handler of handlers.get(type) ?? []) handler(event as unknown as KeyboardEvent);
    return event;
  };

  return {
    input,
    handlers,
    buttons,
    axes,
    setGamepadConnected(value) { connected = value; },
    keyDown(key, repeat = false) { return dispatch('keydown', key, repeat); },
    keyUp(key) { return dispatch('keyup', key); },
    setNow(value) { now = value; },
  };
}

beforeEach(() => {
  originalGlobals = new Map(globalNames.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  environment = makeEnvironment();
});

afterEach(() => {
  environment?.input.dispose();
  environment = undefined;
  restoreGlobals();
});

const harness = (): TestEnvironment => {
  if (!environment) throw new Error('RuntimeInput test environment was not initialized.');
  return environment;
};

describe('RuntimeInput sampled edge and binding semantics', () => {
  it('keeps arrows alongside remapped movement and clears them across menus', () => {
    const test = harness(), bindings = makeBindings();
    bindings.keyboard.moveForward = 'i';
    test.input.setBindings(bindings);
    test.input.setEnabled(true);
    expect(test.keyDown('ArrowUp').defaultPrevented).toBe(true);
    test.keyDown('ArrowRight');
    const diagonal = test.input.sample();
    expect(diagonal.moveX).toBeCloseTo(Math.SQRT1_2);
    expect(diagonal.moveZ).toBeCloseTo(Math.SQRT1_2);
    test.keyDown('i');
    test.keyUp('ArrowUp');
    expect(test.input.sample().moveZ).toBeCloseTo(Math.SQRT1_2);
    test.keyUp('ArrowRight');
    test.keyDown('ArrowDown');
    expect(test.input.sample()).toMatchObject({ moveX: 0, moveZ: 0 });
    test.input.setEnabled(false);
    test.input.setEnabled(true);
    expect(test.input.sample()).toMatchObject({ moveX: 0, moveZ: 0 });
  });

  it('delivers a complete key tap between fixed samples exactly once', () => {
    const test = harness();
    test.keyDown('j');
    test.keyUp('j');

    expect(test.input.sample().lightPressed).toBe(true);
    expect(test.input.sample().lightPressed).toBe(false);
  });

  it('preserves both Heavy edges for a tap while distinguishing a held charge', () => {
    const test = harness();
    test.keyDown('k');
    test.keyUp('k');
    const tap = test.input.sample();
    expect(tap.heavyPressed).toBe(true);
    expect(tap.heavyHeld).toBe(false);
    expect(tap.heavyReleased).toBe(true);
    expect(test.input.sample().heavyReleased).toBe(false);

    test.keyDown('k');
    const held = test.input.sample();
    expect(held.heavyPressed).toBe(true);
    expect(held.heavyHeld).toBe(true);
    expect(held.heavyReleased).toBe(false);
    expect(test.input.sample().heavyPressed).toBe(false);
    test.keyUp('k');
    expect(test.input.sample().heavyReleased).toBe(true);
    expect(test.input.sample().heavyReleased).toBe(false);
  });

  it('emits a Heavy release edge when the gamepad disconnects mid-hold', () => {
    const test = harness();
    test.setGamepadConnected(true);
    test.buttons[5]!.pressed = true;
    expect(test.input.sample()).toMatchObject({ heavyPressed: true, heavyHeld: true, heavyReleased: false });

    test.setGamepadConnected(false);
    expect(test.input.sample()).toMatchObject({ heavyHeld: false, heavyReleased: true });
    expect(test.input.sample().heavyReleased).toBe(false);
  });

  it('uses remapped movement for command-wheel sectors and preserves mapped browser keys', () => {
    const test = harness();
    const bindings = makeBindings();
    bindings.keyboard.moveRight = 'l';
    bindings.keyboard.commandWheel = 'x';
    bindings.keyboard.moveForward = 'PageDown';
    test.input.setBindings(bindings);
    test.input.setEnabled(true);

    expect(test.keyDown('PageDown').defaultPrevented).toBe(true);
    expect(test.input.sample().moveZ).toBe(1);
    test.keyUp('PageDown');

    test.keyDown('x');
    test.keyDown('l');
    expect(test.input.sample().commandWheelHeld).toBe(true);
    test.setNow(1101);
    test.keyUp('x');
    const released = test.input.sample();
    expect(released.commandWheelHeld).toBe(false);
    expect(released.commandIndex).toBe(4);
  });

  it('keeps keyboard and gamepad bindings independent and removes no-op fallback buttons', () => {
    const test = harness();
    const bindings = makeBindings();
    bindings.keyboard.dodge = 'f';
    test.input.setBindings(bindings);
    test.input.setEnabled(true);
    test.setGamepadConnected(true);
    test.buttons[0]!.pressed = true;
    expect(test.input.sample().dodgePressed).toBe(true);

    const explicitlyRemapped = makeBindings();
    explicitlyRemapped.keyboard.dodge = 'f';
    explicitlyRemapped.gamepad.dodge = 'Gamepad Button 2';
    test.input.setBindings(explicitlyRemapped);
    test.input.setEnabled(true);
    expect(test.input.sample().dodgePressed).toBe(false);

    test.buttons[0]!.pressed = false;
    test.buttons[1]!.pressed = true;
    expect(test.input.sample().dodgePressed).toBe(true);
    test.keyDown('f');
    expect(test.input.sample().dodgePressed).toBe(true);
  });

  it('routes Space to Jump and the default keyboard key to Dive, with Shift still selecting run', () => {
    const test = harness();
    test.keyDown('space');
    expect(test.input.sample()).toMatchObject({ dodgePressed: false, jumpPressed: true });
    test.keyUp('space');
    expect(test.input.sample()).toMatchObject({ dodgePressed: false, jumpPressed: false });

    test.keyDown('f');
    expect(test.input.sample()).toMatchObject({ dodgePressed: true, jumpPressed: false });
    test.keyUp('f');
    expect(test.input.sample()).toMatchObject({ dodgePressed: false, jumpPressed: false });

    test.keyDown('shift');
    test.keyDown('w');
    expect(test.input.sample()).toMatchObject({ moveZ: 1, sprintHeld: true, jumpPressed: false });
    test.keyDown('space');
    test.keyUp('space');
    test.keyUp('w');
    test.keyUp('shift');
    expect(test.input.sample()).toMatchObject({ dodgePressed: false, jumpPressed: true, sprintHeld: false });
    expect(test.input.sample()).toMatchObject({ dodgePressed: false, jumpPressed: false });

    test.setGamepadConnected(true);
    test.buttons[0]!.pressed = true;
    test.keyDown('shift');
    expect(test.input.sample()).toMatchObject({ dodgePressed: true, jumpPressed: false, sprintHeld: true });
  });

  it('reserves Space for Jump and migrates legacy Dodge bindings without discarding custom keys', () => {
    const test = harness();
    test.keyDown('space');
    expect(test.input.sample()).toMatchObject({ dodgePressed: false, jumpPressed: true });
    test.keyUp('space');

    test.keyDown('f');
    expect(test.input.sample()).toMatchObject({ dodgePressed: true, jumpPressed: false });
    test.keyUp('f');

    const legacy = normalizeInputBindings({
      keyboard: { dodge: 'space', light: 'j' },
      gamepad: { ...DEFAULT_INPUT_BINDINGS.gamepad },
    });
    expect(legacy.keyboard.jump).toBe('space');
    expect(legacy.keyboard.dodge).toBe('f');
    expect(legacy.keyboard.light).toBe('j');

    const custom = normalizeInputBindings({
      keyboard: { ...DEFAULT_INPUT_BINDINGS.keyboard, dodge: 'g' },
      gamepad: { ...DEFAULT_INPUT_BINDINGS.gamepad },
    });
    expect(custom.keyboard.dodge).toBe('g');
  });
  it('normalizes diagonal keyboard movement and applies the analog deadzone continuously', () => {
    const test = harness();
    test.keyDown('w');
    test.keyDown('d');
    const diagonal = test.input.sample();
    expect(diagonal.moveX).toBeCloseTo(Math.SQRT1_2);
    expect(diagonal.moveZ).toBeCloseTo(Math.SQRT1_2);
    test.keyUp('w');
    test.keyUp('d');
    test.keyDown('w');
    test.keyDown('s');
    expect(test.input.sample()).toMatchObject({ moveX: 0, moveZ: 0 });

    test.keyUp('w');
    test.keyUp('s');
    test.setGamepadConnected(true);
    test.axes[0] = 0.1;
    expect(test.input.sample().moveX).toBe(0);
    test.axes[0] = 0.5;
    expect(test.input.sample().moveX).toBeCloseTo(0.3902439, 6);
  });

  it('clears held state while disabled and requires a fresh key gesture after re-enable', () => {
    const test = harness();
    test.keyDown('k');
    expect(test.input.sample().heavyHeld).toBe(true);
    test.input.setEnabled(false);
    test.input.setEnabled(true);
    expect(test.input.sample().heavyHeld).toBe(false);
    test.keyDown('k', true);
    expect(test.input.sample().heavyHeld).toBe(false);
    test.keyUp('k');
    test.keyDown('k');
    expect(test.input.sample()).toMatchObject({ heavyPressed: true, heavyHeld: true });
  });

  it('binds Sigil (L) and Judgement (U) with Heavy-style tap, hold and release edges', () => {
    const test = harness();
    expect(DEFAULT_INPUT_BINDINGS.keyboard).toMatchObject({ ranged: 'l', ultimate: 'u' });
    test.keyDown('l');
    test.keyUp('l');
    const tap = test.input.sample();
    expect(tap).toMatchObject({ rangedPressed: true, rangedHeld: false, rangedReleased: true, ultimatePressed: false });
    expect(test.input.sample()).toMatchObject({ rangedPressed: false, rangedReleased: false });

    test.keyDown('l');
    expect(test.input.sample()).toMatchObject({ rangedPressed: true, rangedHeld: true, rangedReleased: false });
    expect(test.input.sample()).toMatchObject({ rangedPressed: false, rangedHeld: true, rangedReleased: false });
    test.keyUp('l');
    expect(test.input.sample()).toMatchObject({ rangedHeld: false, rangedReleased: true });
    expect(test.input.sample().rangedReleased).toBe(false);

    test.keyDown('u');
    expect(test.input.sample()).toMatchObject({ ultimatePressed: true, rangedPressed: false });
    expect(test.input.sample().ultimatePressed).toBe(false);
  });

  it('reads the default gamepad buttons for Sigil and Judgement and releases on disconnect', () => {
    const test = harness();
    expect(DEFAULT_INPUT_BINDINGS.gamepad).toMatchObject({ ranged: 'Gamepad Button 12', ultimate: 'Gamepad Button 11' });
    const used = Object.entries(DEFAULT_INPUT_BINDINGS.gamepad).filter(([action]) => action !== 'ranged' && action !== 'ultimate').map(([, binding]) => binding);
    expect(used).not.toContain('Gamepad Button 12');
    expect(used).not.toContain('Gamepad Button 11');
    test.setGamepadConnected(true);
    test.buttons[11]!.pressed = true;
    expect(test.input.sample()).toMatchObject({ rangedPressed: true, rangedHeld: true, heavyPressed: false });
    test.buttons[10]!.pressed = true;
    expect(test.input.sample()).toMatchObject({ ultimatePressed: true, rangedPressed: false, rangedHeld: true });
    test.setGamepadConnected(false);
    expect(test.input.sample()).toMatchObject({ rangedHeld: false, rangedReleased: true });
  });

  it('keeps remaps of the new actions and normalisation of reserved keys working', () => {
    const test = harness();
    const bindings = makeBindings();
    bindings.keyboard.ranged = 'g';
    test.input.setBindings(bindings);
    test.input.setEnabled(true);
    test.keyDown('l');
    expect(test.input.sample().rangedPressed).toBe(false);
    test.keyUp('l');
    test.keyDown('g');
    expect(test.input.sample()).toMatchObject({ rangedPressed: true, rangedHeld: true });

    const normalized = normalizeInputBindings({ keyboard: { ranged: 'space', ultimate: 'f' }, gamepad: { ...DEFAULT_INPUT_BINDINGS.gamepad } });
    expect(normalized.keyboard).toMatchObject({ ranged: 'l', ultimate: 'u', jump: 'space', dodge: 'f' });
  });
});
