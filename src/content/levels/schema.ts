import type { Vec3 } from "../../game/contracts.js";

export type { RegionAuthoringStatus, RegionDefinition } from "../../game/contracts.js";

export const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
