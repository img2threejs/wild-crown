import { DEFAULT_INPUT_BINDINGS, type InputBindingMaps } from '../game/contracts.js';
export type GameAction = 'moveForward' | 'moveBack' | 'moveLeft' | 'moveRight' | 'dodge' | 'jump' | 'light' | 'heavy' | 'ranged' | 'ultimate' | 'interact' | 'ability' | 'map' | 'journal' | 'companions' | 'pause' | 'commandWheel';
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
  commandIndex: number | null;
}
const GAME_ACTIONS: readonly GameAction[] = ['moveForward', 'moveBack', 'moveLeft', 'moveRight', 'dodge', 'jump', 'light', 'heavy', 'ranged', 'ultimate', 'interact', 'ability', 'map', 'journal', 'companions', 'pause', 'commandWheel'];
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
    private wheelStart = 0;
    private commandSelection = 0;
    private wheelReleased = false;
    private bindingMaps: InputBindingMaps = {
        keyboard: { ...DEFAULT_INPUT_BINDINGS.keyboard },
        gamepad: { ...DEFAULT_INPUT_BINDINGS.gamepad },
    };
    private deadzone = 0.18;
    private disposed = false;
    private enabled = false;
    private readonly down = (event: KeyboardEvent) => {
        if (this.disposed || !this.enabled || event.repeat)
            return;
        const key = norm(event.key);
        this.keys.add(key);
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
            this.wheelReleased = true;
    };
    private readonly blur = () => this.clear();
    private readonly hidden = () => { if (document.hidden)
        this.clear(); };
    constructor(private readonly target: HTMLElement) {
        window.addEventListener('keydown', this.down);
        window.addEventListener('keyup', this.up);
        window.addEventListener('blur', this.blur);
        document.addEventListener('visibilitychange', this.hidden);
    }
    setBindings(bindings: InputBindingMaps): void {
        this.bindingMaps = { keyboard: { ...bindings.keyboard }, gamepad: { ...bindings.gamepad } };
        this.clear();
    }
    setDeadzone(value: number): void { this.deadzone = clamp(value, 0.05, 0.45); }
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
        this.wheelReleased = false;
    }
    sample(): ActionFrame {
        if (this.disposed || !this.enabled || document.hidden || !this.target.isConnected)
            return this.empty();
        this.previous = this.current;
        this.current = new Set<GameAction>();
        const pad = [...(navigator.getGamepads?.() ?? [])].find(item => item?.connected) ?? null;
        for (const action of GAME_ACTIONS) {
            const keyboardBinding = this.bindingMaps.keyboard[action];
            if ((keyboardBinding && this.keys.has(norm(keyboardBinding))) || this.keys.has(MOVEMENT_ARROWS[action] ?? ''))
                this.current.add(action);
            const gamepadBinding = this.bindingMaps.gamepad[action];
            const match = gamepadBinding ? /^Gamepad Button (\d+)$/i.exec(gamepadBinding) : null;
            const button = match ? Number(match[1]) - 1 : undefined;
            if (pad && button !== undefined && pad.buttons[button]?.pressed)
                this.current.add(action);
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
        let commandIndex: number | null = null;
        const wheelDown = this.current.has('commandWheel');
        if (wheelDown && !this.wheel) {
            this.wheel = true;
            this.wheelStart = performance.now();
            this.commandSelection = 0;
        }
        if (this.wheel) {
            let x = Number(this.current.has('moveRight')) - Number(this.current.has('moveLeft'));
            let y = Number(this.current.has('moveBack')) - Number(this.current.has('moveForward'));
            if (pad) {
                x += pad.axes[0] ?? 0;
                y += pad.axes[1] ?? 0;
            }
            if (Math.hypot(x, y) > this.deadzone) {
                const angle = Math.atan2(y, x);
                this.commandSelection = ((Math.round((angle + Math.PI) / (Math.PI / 4)) % 8) + 8) % 8;
            }
            moveX = 0;
            moveZ = 0;
            if (!wheelDown || this.wheelReleased) {
                if (performance.now() - this.wheelStart > 70)
                    commandIndex = this.commandSelection;
                this.wheel = false;
                this.wheelReleased = false;
            }
        }
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
            sprintHeld: this.keys.has('shift'),
            heavyReleased,
            rangedPressed: pressed('ranged'),
            rangedHeld: this.current.has('ranged'),
            rangedReleased,
            ultimatePressed: pressed('ultimate'),
            interactPressed: pressed('interact'),
            abilityPressed: pressed('ability'),
            commandWheelPressed: pressed('commandWheel'),
            commandWheelHeld: this.wheel,
            mapPressed: pressed('map'),
            journalPressed: pressed('journal'),
            companionsPressed: pressed('companions'),
            pausePressed: pressed('pause'),
            commandIndex,
        };
    }
    private empty(): ActionFrame {
        this.pressedEdges.clear();
        this.releasedEdges.clear();
        return { moveX: 0, moveZ: 0, dodgePressed: false, jumpPressed: false, sprintHeld: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, rangedPressed: false, rangedHeld: false, rangedReleased: false, ultimatePressed: false, interactPressed: false, abilityPressed: false, commandWheelPressed: false, commandWheelHeld: false, mapPressed: false, journalPressed: false, companionsPressed: false, pausePressed: false, commandIndex: null };
    }
    dispose(): void {
        if (this.disposed)
            return;
        this.disposed = true;
        this.clear();
        window.removeEventListener('keydown', this.down);
        window.removeEventListener('keyup', this.up);
        window.removeEventListener('blur', this.blur);
        document.removeEventListener('visibilitychange', this.hidden);
    }
}
