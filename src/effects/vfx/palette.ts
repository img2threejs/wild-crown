import { Color } from 'three';
import { GROVE_OWNER_GLOW } from '../../game/combat/GroveContent.js';
import { MISTVEIL_OWNER_GLOW } from '../../game/combat/MistveilContent.js';
import { MOONPINE_OWNER_GLOW } from '../../game/combat/MoonpineContent.js';

/**
 * Presentation element: the four authored AttackElements plus physical earth/sap, Aren's Warden light and spirit vines,
 * and the Warden Arsenal looks: cyan `arcane` runes/blade, `lightning` strikes, warm `gold` heavy blows and cyan-violet `judgement`.
 */
export type VfxElement = 'fire' | 'ice' | 'poison' | 'wind' | 'earth' | 'sap' | 'spirit' | 'arcane' | 'lightning' | 'gold' | 'judgement' | 'heartroot' | 'umbral' | 'ember' | 'water';
export const ELEMENT_INDEX: Readonly<Record<VfxElement, number>> = { fire: 0, ice: 1, poison: 2, wind: 3, earth: 4, sap: 5, spirit: 6, arcane: 7, lightning: 8, gold: 9, judgement: 10, heartroot: 11, umbral: 12, ember: 13, water: 14 };

/** Hue-preserving HDR rule: no effect colour exceeds this on its dominant channel. */
export const HDR_DOMINANT_MAX = 4;
/** Near-neutral colours (min channel ≥ 70 % of max) are capped here so overlaps never read as white discs. */
export const HDR_NEUTRAL_MAX = 1.5;

export interface ElementPalette {
  /** Linear working-space colours: a = dim base, b = saturated body, hot = thin HDR core (dominant ≤ 4). */
  readonly a: Color; readonly b: Color; readonly hot: Color;
}
const linear = (r: number, g: number, b: number): Color => new Color().setRGB(r, g, b);
export const PALETTE: Readonly<Record<VfxElement, ElementPalette>> = {
  fire: { a: linear(0.8, 0.16, 0.02), b: linear(2.2, 0.6, 0.1), hot: linear(4, 1.6, 0.35) },
  ice: { a: linear(0.1, 0.36, 0.8), b: linear(0.35, 1.05, 2), hot: linear(1.1, 2.5, 3.6) },
  water: { a: linear(0.015, 0.28, 0.48), b: linear(0.06, 1.15, 1.7), hot: linear(0.45, 2.5, 3.4) },
  poison: { a: linear(0.1, 0.28, 0.03), b: linear(0.4, 1.15, 0.12), hot: linear(0.9, 2.6, 0.3) },
  wind: { a: linear(0.25, 0.55, 0.5), b: linear(0.55, 1.3, 1.1), hot: linear(1, 2.4, 1.9) },
  earth: { a: linear(0.42, 0.3, 0.17), b: linear(0.95, 0.62, 0.3), hot: linear(2.2, 1.25, 0.45) },
  /** Warden gold-green: Aren's staff and the root rammer's sap. */
  sap: { a: linear(0.3, 0.5, 0.1), b: linear(1.2, 1.6, 0.5), hot: linear(3, 2.4, 0.9) },
  /** Sap-green vines with gold sparks (root tether, story bonds). */
  spirit: { a: linear(0.15, 0.5, 0.12), b: linear(0.45, 1.7, 0.3), hot: linear(3, 2.4, 0.9) },
  /** Warden rune/blade cyan: razor edge is cyan-white, never a white disc. */
  arcane: { a: linear(0.05, 0.38, 0.6), b: linear(0.22, 1.25, 1.95), hot: linear(2.4, 3.4, 4) },
  lightning: { a: linear(0.18, 0.28, 0.85), b: linear(0.7, 1.5, 3.2), hot: linear(2.3, 3.2, 4) },
  /** Heavy / Thunder Cleave blade: gold-white. */
  gold: { a: linear(0.8, 0.42, 0.07), b: linear(2.4, 1.45, 0.38), hot: linear(4, 3.2, 1.5) },
  /** Warden's Judgement: deep cyan-violet. */
  judgement: { a: linear(0.14, 0.08, 0.6), b: linear(0.5, 0.7, 2.4), hot: linear(1.6, 2, 4) },
  heartroot: { a: linear(0.16, 0.45, 0.08), b: linear(1.6, 1.1, 0.22), hot: linear(3.8, 2.7, 1.1) },
  /** Vesper (Moonshade Blade): violet core #7b3cff; the crimson rim #ff2a55 is `UMBRAL_RIM`, the near-black smoke is `UMBRAL_SMOKE`. */
  umbral: { a: linear(0.09, 0.02, 0.5), b: linear(0.4, 0.09, 2), hot: linear(1.7, 0.7, 4) },
  /** Sakda (Ember Fist): flame orange #ff7a1a body, gold #ffd34d highlight in the hot core; the red rim #ff3b1f is `EMBER_RIM`. */
  ember: { a: linear(0.7, 0.1, 0.01), b: linear(2.4, 0.55, 0.04), hot: linear(4, 2.4, 0.4) },
};

/** Vesper's crimson rim #ff2a55 (linear HDR: a body and a thin hot core). */
export const UMBRAL_RIM = { body: linear(2.4, 0.05, 0.3), hot: linear(4, 0.5, 0.9) } as const;
/** Near-black violet smoke (alpha-blended, so it reads as ink, never as light). */
export const UMBRAL_SMOKE = linear(0.025, 0.012, 0.055);
/** Sakda's red-orange rim #ff3b1f and gold sparks #ffd34d. */
export const EMBER_RIM = { body: linear(2.4, 0.1, 0.03), hot: linear(4, 0.7, 0.2) } as const;
export const EMBER_GOLD = { body: linear(2.4, 1.5, 0.2), hot: linear(4, 3, 0.7) } as const;
/** Charred ember smoke (alpha-blended). */
export const EMBER_SMOKE = linear(0.06, 0.035, 0.025);

/** Monster/owner identity → the element its cracks, rims and decal embers glow with. */
export const OWNER_GLOW: Readonly<Record<string, VfxElement>> = {
  'corrupted-boar': 'fire', 'greenwake-sap-stalker': 'ice', 'greenwake-root-rammer': 'sap', aren: 'arcane',
  // Whispering Canopy: sap-bound howler, storm-blue hornbill, toxic viper.
  'canopy-howler': 'sap', 'canopy-hornbill': 'lightning', 'canopy-mire-viper': 'poison',
  // Blood Bamboo Valley: the sap-bound Branchbreaker and the corrupted Asha.
  koro: 'sap', asha: 'sap',
  ...GROVE_OWNER_GLOW, ...MOONPINE_OWNER_GLOW, ...MISTVEIL_OWNER_GLOW,
};

/**
 * Scales an HDR colour in place so its dominant channel stays ≤ HDR_DOMINANT_MAX and a near-neutral
 * colour stays ≤ HDR_NEUTRAL_MAX. Hue (channel ratios) is preserved exactly.
 */
export function capHdr(rgb: Float32Array | number[], offset = 0): void {
  const r = rgb[offset]!, g = rgb[offset + 1]!, b = rgb[offset + 2]!;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (!(max > 0)) { rgb[offset] = rgb[offset + 1] = rgb[offset + 2] = 0; return; }
  const limit = min >= max * 0.7 ? HDR_NEUTRAL_MAX : HDR_DOMINANT_MAX;
  if (max <= limit) return;
  const scale = limit / max;
  rgb[offset] = r * scale; rgb[offset + 1] = g * scale; rgb[offset + 2] = b * scale;
}
