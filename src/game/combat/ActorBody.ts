const LARGE = { radius: 1.1, height: 2.4 } as const;
/** Hornbill-shaped companion body (Vara's prior species). */
const AERIAL = { radius: .42, height: .8 } as const;
/** Storm Harpy eagle body: ~1.3 m standing, fits a 2.6 m wingspan without breaking the supported-capsule spawn check. */
const HARPY = { radius: .55, height: 1.3 } as const;
const MACAQUE = { radius: .42, height: 1 } as const;
const STANDARD = { radius: .42, height: 1.6 } as const;

export function isLargeSpecies(species: string): boolean {
  return species === "tiger" || species === "lion" || species === "boar" || species === "crocodile";
}

/** True for avian companions that take off and use aerial positions in combat (Vara's species). Storm Hornbill is a separate, ground-bodied monster. */
export function isAerialSpecies(species: string): boolean {
  return species === "hornbill" || species === "harpy-eagle";
}

/** Shared by simulation bodies and pre-load party placement; explicit boss overrides remain authoritative. */
export function actorCollisionBody(species: string, large = isLargeSpecies(species), aerial = isAerialSpecies(species)): Readonly<{ radius: number; height: number }> {
  if (large) return LARGE;
  if (aerial) return species === "harpy-eagle" ? HARPY : AERIAL;
  return species === "macaque" ? MACAQUE : STANDARD;
}
