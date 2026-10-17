import { DEFAULT_INPUT_BINDINGS, type InputBindingMaps } from '../game/contracts.js';
export type GameAction = 'moveForward' | 'moveBack' | 'moveLeft' | 'moveRight' | 'dodge' | 'jump' | 'sprint' | 'light' | 'heavy' | 'ranged' | 'ultimate' | 'interact' | 'ability' | 'map' | 'journal' | 'companions' | 'pause' | 'commandWheel' | 'lockOn';
export interface ActionFrame {
  moveX: number;
  moveZ: number;
  dodgePressed: boolean;
  jumpPressed: boolean;
  sprintHeld: boolean;
  lightPressed: boolean;
  heavyPressed: boolean;
  heavyHeld: boolean;
  heavyReleased: boolean;
  rangedPressed: boolean;
  rangedHeld: boolean;
  rangedReleased: boolean;
  ultimatePressed: boolean;
  interactPressed: boolean;
  abilityPressed: boolean;
  commandWheelPressed: boolean;
  commandWheelHeld: boolean;
  mapPressed: boolean;
  journalPressed: boolean;
  companionsPressed: boolean;
  pausePressed: boolean;
  /** Edge of the Lock-On key/button (default T, gamepad D-pad Right / Button 16). The simulation decides hold vs toggle. */
  lockOnPressed: boolean;
  /** True while the Lock-On key/button is held (same sample as the press edge). */
  lockOnHeld: boolean;
  /** True for exactly one sample: the wheel key/button was released (the application decides commit versus cancel). */
  commandWheelReleased: boolean;
  /** Wheel aim while held: direction keys and left stick as a screen-space vector (x right, y down); (0,0) when nothing is aimed. */
  wheelAimX: number;
  wheelAimY: number;
  /** Direct sector selection by digit key 1–8 (sector 0–7), once per press. */
  wheelDigit: number | null;
  /** Escape or B while the wheel is held. */
  wheelCancelPressed: boolean;
}
const GAME_ACTIONS: readonly GameAction[] = ['moveForward', 'moveBack', 'moveLeft', 'moveRight', 'dodge', 'jump', 'sprint', 'light', 'heavy', 'ranged', 'ultimate', 'interact', 'ability', 'map', 'journal', 'companions', 'pause', 'commandWheel', 'lockOn'];
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const norm = (key: string) => key.toLowerCase() === 'space' ? ' ' : key.toLowerCase();
const MOVEMENT_ARROWS: Partial<Record<GameAction, string>> = {
    moveForward: 'arrowup', moveBack: 'arrowdown', moveLeft: 'arrowleft', moveRight: 'arrowright',
};
export class RuntimeInput {
    private keys = new Set<string>();
    private previous = new Set<GameAction>();
    private current = new Set<GameAction>();
    private pressedEdges = new Set<GameAction>();
    private releasedEdges = new Set<GameAction>();
    private wheel = false;
    private wheelKeyEdges: string[] = [];
    private wheelPadBack = false;
    private wheelReleasedEdge = false;
    /** The wheel was opened by pointer/UI rather than a held key: the key-release edge must not close it. */
    private externalWheel = false;
    private bindingMaps: InputBindingMaps = {
        keyboard: { ...DEFAULT_INPUT_BINDINGS.keyboard },
        gamepad: { ...DEFAULT_INPUT_BINDINGS.gamepad },
    };
    private deadzone = 0.18;
    private disposed = false;
    private enabled = false;
    private focused = true;
    /** Buttons held across a reset must be released before they can drive gameplay again. */
    private readonly blockedGamepadButtons = new Set<number>();
    private readonly down = (event: KeyboardEvent) => {
        if (this.disposed || !this.enabled || !this.focused || document.hidden || event.repeat)
            return;
        const key = norm(event.key);
        this.keys.add(key);
        if (/^[1-8]$/.test(key) || key === 'escape') this.wheelKeyEdges.push(key);
        for (const action of GAME_ACTIONS) {
            const binding = this.bindingMaps.keyboard[action];
            if (binding && norm(binding) === key)
                this.pressedEdges.add(action);
        }
        if (Object.values(MOVEMENT_ARROWS).includes(key) || Object.values(this.bindingMaps.keyboard).some(binding => typeof binding === 'string' && norm(binding) === key))
            event.preventDefault();
    };
    private readonly up = (event: KeyboardEvent) => {
        const key = norm(event.key);
        const wasHeld = this.keys.delete(key);
        if (!wasHeld || !this.enabled || this.disposed)
            return;
        for (const action of GAME_ACTIONS) {
            const binding = this.bindingMaps.keyboard[action];
            if (binding && norm(binding) === key)
                this.releasedEdges.add(action);
        }
        const commandWheelBinding = this.bindingMaps.keyboard.commandWheel;
        if (commandWheelBinding && key === norm(commandWheelBinding))
            this.wheelReleasedEdge = true;
    };
    private readonly blur = () => { this.focused = false; this.clear(); };
    private readonly focus = () => { this.focused = true; this.clear(); };
    private readonly hidden = () => { if (document.hidden)
        this.clear(); };
    constructor(private readonly target: HTMLElement) {
        this.focused = document.hasFocus?.() ?? true;
        window.addEventListener('keydown', this.down);
        window.addEventListener('keyup', this.up);
        window.addEventListener('blur', this.blur);
        window.addEventListener('focus', this.focus);
        document.addEventListener('visibilitychange', this.hidden);
    }
    setBindings(bindings: InputBindingMaps): void {
        this.bindingMaps = { keyboard: { ...bindings.keyboard }, gamepad: { ...bindings.gamepad } };
        this.clear();
    }
    setDeadzone(value: number): void { this.deadzone = clamp(value, 0.05, 0.45); }
    /** Holds the wheel open from the UI (pointer-opened wheel): the key-release edge no longer closes it. Gameplay input stays frozen until released. */
    setExternalWheel(open: boolean): void { this.externalWheel = open; }
    setEnabled(enabled: boolean): void {
        if (this.enabled === enabled)
            return;
        this.enabled = enabled;
        this.clear();
    }
    clear(): void {
        this.keys.clear();
        this.previous.clear();
        this.current.clear();
        this.pressedEdges.clear();
        this.releasedEdges.clear();
        this.wheel = false;
        this.externalWheel = false;
        this.wheelReleasedEdge = false;
        this.wheelKeyEdges.length = 0;
        this.wheelPadBack = false;
        this.blockedGamepadButtons.clear();
        const pad = this.connectedGamepad();
        if (pad) for (let i = 0; i < pad.buttons.length; i++) {
            if (pad.buttons[i]?.pressed) this.blockedGamepadButtons.add(i);
        }
    }
    private connectedGamepad(): Gamepad | null {
        for (const pad of navigator.getGamepads?.() ?? []) if (pad?.connected) return pad;
        return null;
    }
    sample(): ActionFrame {
        if (this.disposed || !this.enabled || !this.focused || document.hidden || !this.target.isConnected)
            return this.empty();
        const previous = this.previous;
        this.previous = this.current;
        this.current = previous;
        this.current.clear();
        const pad = this.connectedGamepad();
        for (const button of this.blockedGamepadButtons) {
            if (!pad?.buttons[button]?.pressed) this.blockedGamepadButtons.delete(button);
        }
        for (const action of GAME_ACTIONS) {
            const keyboardBinding = this.bindingMaps.keyboard[action];
            if ((keyboardBinding && this.keys.has(norm(keyboardBinding))) || this.keys.has(MOVEMENT_ARROWS[action] ?? ''))
                this.current.add(action);
            const gamepadBinding = this.bindingMaps.gamepad[action];
            const match = gamepadBinding ? /^Gamepad Button (\d+)$/i.exec(gamepadBinding) : null;
            const button = match ? Number(match[1]) - 1 : undefined;
            if (pad && button !== undefined && !this.blockedGamepadButtons.has(button) && pad.buttons[button]?.pressed) {
                this.current.add(action);
            }
        }
        let moveX = Number(this.current.has('moveRight')) - Number(this.current.has('moveLeft'));
        let moveZ = Number(this.current.has('moveForward')) - Number(this.current.has('moveBack'));
        if (pad) {
            const x = pad.axes[0] ?? 0;
            const y = pad.axes[1] ?? 0;
            const magnitude = Math.hypot(x, y);
            if (magnitude > this.deadzone) {
                const scale = Math.min(1, (magnitude - this.deadzone) / (1 - this.deadzone)) / magnitude;
                moveX += x * scale;
                moveZ -= y * scale;
            }
        }
        const magnitude = Math.hypot(moveX, moveZ);
        if (magnitude > 1) {
            moveX /= magnitude;
            moveZ /= magnitude;
        }
        const pressed = (action: GameAction) => {
            const edge = this.pressedEdges.has(action) || this.current.has(action) && !this.previous.has(action);
            this.pressedEdges.delete(action);
            return edge;
        };
        const jumpPressed = pressed('jump');
        let commandWheelReleased = false;
        let wheelAimX = 0, wheelAimY = 0, wheelDigit: number | null = null, wheelCancelPressed = false;
        const wheelDown = this.current.has('commandWheel') || this.externalWheel;
        if (wheelDown && !this.wheel) {
            this.wheel = true;
            this.wheelKeyEdges.length = 0;
        }
        if (this.wheel) {
            wheelAimX = Number(this.current.has('moveRight')) - Number(this.current.has('moveLeft'));
            wheelAimY = Number(this.current.has('moveBack')) - Number(this.current.has('moveForward'));
            const back = !this.blockedGamepadButtons.has(1) && Boolean(pad?.buttons[1]?.pressed);
            if (pad) {
                const ax = pad.axes[0] ?? 0, ay = pad.axes[1] ?? 0;
                if (Math.hypot(ax, ay) > this.deadzone) { wheelAimX += ax; wheelAimY += ay; }
            }
            if (back && !this.wheelPadBack) wheelCancelPressed = true;
            this.wheelPadBack = back;
            for (const key of this.wheelKeyEdges) {
                if (key === 'escape') wheelCancelPressed = true;
                else wheelDigit = Number(key) - 1;
            }
            this.wheelKeyEdges.length = 0;
            // Gameplay remains frozen while the single-companion wheel owns input.
            this.pressedEdges.delete('map'); this.pressedEdges.delete('heavy'); this.pressedEdges.delete('interact'); this.pressedEdges.delete('ability');
            moveX = 0;
            moveZ = 0;
            if (!wheelDown || this.wheelReleasedEdge && !this.externalWheel) {
                commandWheelReleased = true;
                this.wheel = false;
                this.wheelReleasedEdge = false;
            }
        } else this.wheelKeyEdges.length = 0;
        const heavyReleased = this.releasedEdges.has('heavy') || this.previous.has('heavy') && !this.current.has('heavy');
        this.releasedEdges.delete('heavy');
        const rangedReleased = this.releasedEdges.has('ranged') || this.previous.has('ranged') && !this.current.has('ranged');
        this.releasedEdges.delete('ranged');
        this.pressedEdges.delete('moveForward');
        this.pressedEdges.delete('moveBack');
        this.pressedEdges.delete('moveLeft');
        this.pressedEdges.delete('moveRight');
        this.releasedEdges.clear();
        return {
            moveX, moveZ,
            dodgePressed: pressed('dodge'),
            jumpPressed,
            lightPressed: pressed('light'),
            heavyPressed: pressed('heavy'),
            heavyHeld: this.current.has('heavy'),
            sprintHeld: this.current.has('sprint'),
            heavyReleased,
            rangedPressed: pressed('ranged'),
            rangedHeld: this.current.has('ranged'),
            rangedReleased,
            ultimatePressed: pressed('ultimate'),
            interactPressed: pressed('interact'),
            abilityPressed: pressed('ability'),
            commandWheelPressed: pressed('commandWheel'),
            commandWheelHeld: this.wheel,
            lockOnPressed: pressed('lockOn'),
            lockOnHeld: this.current.has('lockOn'),
            commandWheelReleased, wheelAimX, wheelAimY, wheelDigit, wheelCancelPressed,
            mapPressed: pressed('map'),
            journalPressed: pressed('journal'),
            companionsPressed: pressed('companions'),
            pausePressed: pressed('pause'),
        };
    }
    private empty(): ActionFrame {
        this.pressedEdges.clear();
        this.releasedEdges.clear();
        return { moveX: 0, moveZ: 0, dodgePressed: false, jumpPressed: false, sprintHeld: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, rangedPressed: false, rangedHeld: false, rangedReleased: false, ultimatePressed: false, interactPressed: false, abilityPressed: false, commandWheelPressed: false, commandWheelHeld: false, commandWheelReleased: false, lockOnPressed: false, lockOnHeld: false, wheelAimX: 0, wheelAimY: 0, wheelDigit: null, wheelCancelPressed: false, mapPressed: false, journalPressed: false, companionsPressed: false, pausePressed: false };
    }
    dispose(): void {
        if (this.disposed)
            return;
        this.disposed = true;
        this.clear();
        window.removeEventListener('keydown', this.down);
        window.removeEventListener('keyup', this.up);
        window.removeEventListener('blur', this.blur);
        window.removeEventListener('focus', this.focus);
        document.removeEventListener('visibilitychange', this.hidden);
    }
}
