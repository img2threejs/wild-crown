import type { CompanionId, FieldCommand } from '../game/contracts.js';
/** Sector 0 is straight up; sectors run clockwise in 45° steps. */
export const WHEEL_COMMANDS: readonly FieldCommand[] = ['follow', 'stay', 'focus', 'defend', 'search', 'distract', 'special', 'recall'];
export const WHEEL_SECTORS = WHEEL_COMMANDS.length;
/** Pointer/stick vectors shorter than this select nothing (the wheel's dead centre). */
export const WHEEL_DEADZONE = 0.35;
/** World-time scale while the wheel is open: the app scales its fixed-step accumulator, the simulation stays deterministic. */
export const WHEEL_TIME_SCALE = 0.15;

/** Sector of a screen-space vector (x right, y down), or null inside the dead centre. */
export function sectorFromVector(x: number, y: number, deadzone = WHEEL_DEADZONE): number | null {
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.hypot(x, y) < deadzone) return null;
    const angle = Math.atan2(x, -y);
    const turn = (angle + 2 * Math.PI) % (2 * Math.PI);
    return Math.floor(((turn + Math.PI / WHEEL_SECTORS) % (2 * Math.PI)) / (2 * Math.PI / WHEEL_SECTORS)) % WHEEL_SECTORS;
}

export type WheelOutcome =
    | { readonly kind: 'commit'; readonly companionId: CompanionId; readonly sector: number; readonly command: FieldCommand }
    /** A deliberate selection that the simulation refuses: nothing is spent, the reason is shown. */
    | { readonly kind: 'rejected'; readonly companionId: CompanionId; readonly sector: number; readonly command: FieldCommand }
    | { readonly kind: 'cancel' };

/**
 * Selection state of the companion command wheel. Pure and wall-clock free: the caller feeds gestures (pointer hover,
 * keys, stick, shoulder buttons) and decides when a release or cancel happens. A release commits only when a sector was
 * deliberately selected (pointer, stick, digit or arrow), so an accidental tap never becomes a default "Follow".
 */
export class CommandWheel {
    private isOpen = false;
    private currentCompanion: CompanionId | null = null;
    private selected: number | null = null;
    get open(): boolean { return this.isOpen; }
    get companionId(): CompanionId | null { return this.currentCompanion; }
    get selectedSector(): number | null { return this.selected; }
    /** Opens for the sole equipped companion with nothing selected. Reopening is a no-op. */
    openFor(companionId: CompanionId): void {
        if (this.isOpen) return;
        this.isOpen = true;
        this.currentCompanion = companionId;
        this.selected = null;
    }
    /** Pointer hover / stick aim: vector from the wheel centre (x right, y down). Dead centre clears the selection. */
    aim(x: number, y: number): void {
        if (!this.isOpen) return;
        this.selected = sectorFromVector(x, y);
    }
    selectSector(sector: number | null): void {
        if (!this.isOpen) return;
        this.selected = sector !== null && Number.isInteger(sector) && sector >= 0 && sector < WHEEL_SECTORS ? sector : null;
    }
    /** Keyboard arrows: steps the selection clockwise (+1) or counter-clockwise (-1); the first step selects sector 0 / the last. */
    step(delta: number): void {
        if (!this.isOpen) return;
        this.selected = this.selected === null ? (delta >= 0 ? 0 : WHEEL_SECTORS - 1) : ((this.selected + delta) % WHEEL_SECTORS + WHEEL_SECTORS) % WHEEL_SECTORS;
    }
    /** Escape, B, blur, another panel, a transition or an invalidated target: closes without commanding. */
    cancel(): WheelOutcome {
        this.close();
        return { kind: 'cancel' };
    }
    /** Closes on release. Availability is the simulation's answer for the captured companion and command. */
    release(isAvailable: (companionId: CompanionId, sector: number, command: FieldCommand) => boolean): WheelOutcome {
        const companionId = this.currentCompanion, sector = this.selected;
        const wasOpen = this.isOpen;
        this.close();
        if (!wasOpen || companionId === null || sector === null) return { kind: 'cancel' };
        const command = WHEEL_COMMANDS[sector]!;
        return isAvailable(companionId, sector, command) ? { kind: 'commit', companionId, sector, command } : { kind: 'rejected', companionId, sector, command };
    }
    private close(): void {
        this.isOpen = false;
        this.currentCompanion = null;
        this.selected = null;
    }
}
