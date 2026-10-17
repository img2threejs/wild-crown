/**
 * Name and epithet shown on the boss reveal card, keyed by the boss actor's archetype id. Names follow the authored story copy
 * (regionPresentation threat lines, chapter settings, quest titles). Trial monsters carry their own "Name, the Epithet" label.
 */
export const BOSS_TITLES: Readonly<Record<string, { readonly name: string; readonly epithet: string }>> = Object.freeze({
  koro: { name: 'Koro', epithet: 'The Branchbreaker' },
  asha: { name: 'Asha', epithet: 'The Broken Fang' },
  ruun: { name: 'Ruun', epithet: 'The Chained Howl' },
  ghor: { name: 'Ghor', epithet: 'The Mire Maw' },
  solkar: { name: 'Solkar', epithet: 'The Sunmane King' },
  orun: { name: 'Orun', epithet: 'The Hollow King' },
});

/** Splits a "Name, the Epithet" label; a label without an epithet keeps the fallback line. */
export function bossTitleFromLabel(label: string, fallbackEpithet: string): { readonly name: string; readonly epithet: string } {
  const comma = label.indexOf(', ');
  if (comma <= 0) return { name: label, epithet: fallbackEpithet };
  const epithet = label.slice(comma + 2);
  return { name: label.slice(0, comma), epithet: epithet.charAt(0).toUpperCase() + epithet.slice(1) };
}
