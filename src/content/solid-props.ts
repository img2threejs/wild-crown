import { GREENWAKE_BOUNDARY_ID_PREFIX } from '../world/GreenwakeBoundary.js';
import { CANOPY_BOUNDARY_ID_PREFIX } from '../world/CanopyBoundary.js';
import { GROVE_BOUNDARY_ID_PREFIX, GROVE_SOLID_PROFILES } from '../game/combat/GroveContent.js';
import { MISTVEIL_BOUNDARY_ID_PREFIX, MISTVEIL_SOLID_PROFILES } from '../game/combat/MistveilContent.js';
import { MOONPINE_BOUNDARY_ID_PREFIX, MOONPINE_SOLID_PROFILES } from '../game/combat/MoonpineContent.js';
import type { WorldAssetPlacement } from '../game/contracts.js';
import { isLooseEnvironmentProp } from '../game/combat/EnvironmentProps.js';

export type SolidPropKind = 'trunk' | 'solid' | 'arch' | 'platform' | 'decoration';
const PROFILES: Readonly<Record<string, SolidPropKind>> = {
  'prop-erya-edge-tree': 'trunk', 'prop-moonpine-tree': 'trunk',
  'prop-rainforest-canopy-tree': 'trunk', 'prop-savanna-acacia': 'trunk',
  'prop-heartroot-trunk': 'trunk', 'prop-bamboo-cluster': 'trunk',
  'prop-root-arch': 'arch', 'prop-plains-stone-arch': 'arch',
  'prop-migration-gate': 'arch', 'prop-water-allotment-gate': 'arch',
  'prop-greenwake-rope-bridge': 'platform', 'prop-grove-platform': 'platform',
  'prop-monkey-rope-platform': 'platform', 'prop-bamboo-footbridge': 'platform',
  'prop-moonpine-log-bridge': 'platform', 'prop-vine-bridge': 'platform',
  'prop-sunmane-stone-terrace': 'solid',
  'prop-mistveil-reed-cluster': 'decoration',
  ...GROVE_SOLID_PROFILES, ...MOONPINE_SOLID_PROFILES, ...MISTVEIL_SOLID_PROFILES,
};
const DECORATION_PREFIXES = [GREENWAKE_BOUNDARY_ID_PREFIX, CANOPY_BOUNDARY_ID_PREFIX, GROVE_BOUNDARY_ID_PREFIX, MOONPINE_BOUNDARY_ID_PREFIX, MISTVEIL_BOUNDARY_ID_PREFIX];

/** Only explicitly soft vegetation is passable; unknown props remain physical. Boundary dressing of the playtest regions is visual only. */
export function solidPropKind(placement: WorldAssetPlacement): SolidPropKind {
  if (DECORATION_PREFIXES.some(prefix => placement.id.startsWith(prefix))) return 'decoration';
  // Small loose rubble can be stepped over; it must never contribute a stationary collider or standable top.
  if (isLooseEnvironmentProp(placement)) return 'decoration';
  return PROFILES[placement.assetId] ?? 'solid';
}

export type SupportKind = 'deck' | 'top' | 'none';
/** Solid props whose measured top is a combat step: rocks, drums and the Grove basin, whose 0.6 m rim is the one flat native top. Trees, arches, houses, rails and foliage are never stood on. */
const TOP_SUPPORT_ASSETS: Readonly<Record<string, true>> = {
  'prop-snow-ridge-rock': true, 'prop-mire-bank-rock': true, 'prop-greenwake-boulder-cluster': true,
  'prop-canopy-cliff-rock': true, 'prop-black-sap-filter-drum': true, 'prop-water-basin': true,
  'prop-sunmane-stone-terrace': true,
};

/** What a placement offers to stand on: a bridge/platform deck, a solid prop's top, or nothing. */
export function supportKind(placement: WorldAssetPlacement): SupportKind {
  const kind = solidPropKind(placement);
  if (kind === 'platform') return 'deck';
  return kind === 'solid' && TOP_SUPPORT_ASSETS[placement.assetId] === true ? 'top' : 'none';
}
