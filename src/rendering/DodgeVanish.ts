import type { HeroStyle } from '../game/heroes';

/** Visible-fraction window of a dodge clip (share of its normalized time) during which the hero's body is hidden. */
export interface DodgeVanishWindow { readonly from: number; readonly to: number }

/** Yara's Petal Step is a blink: she travels for the first `travelTicks` of its `dodgeTicks`-tick span (authored dodge timing). */
export const PETAL_STEP_TICKS = Object.freeze({ travelTicks: 30, dodgeTicks: 56 });

const UMBRAL_WINDOW: DodgeVanishWindow = Object.freeze({ from: 0.1, to: 0.6 });
/** She vanishes the instant the step starts and reappears just as the travel ends, so the body is hidden for the whole blink. */
const PETAL_STEP_WINDOW: DodgeVanishWindow = Object.freeze({ from: 0.04, to: 0.54 });

/** Hidden window of a `dodgeVanish` hero's dodge: Vesper's umbral blink keeps its own, every other hero (Yara) is hidden for the whole travel. */
export function dodgeVanishWindow(style: HeroStyle): DodgeVanishWindow {
  return style === 'umbral' ? UMBRAL_WINDOW : PETAL_STEP_WINDOW;
}
