import { v, type RegionDefinition } from "./schema.js";
import { actor, prop, route, target } from "./story-kit.js";
import { createBambooChapterRegion } from "./bamboo-region.js";
import { createCanopyChapterRegion } from "./canopy-region.js";
import { createGroveChapterRegion } from "./grove-region.js";
export const ACT_I_REGION_AUTHORING_STATUS = "unaccepted" as const;

/** Six mission locations checked against the authored graph and concrete actor/interaction instances. */
export const FIRST_PACT_LOCATIONS = [
  { segment: "Forest Entry", regionId: "greenwake", nodeId: "greenwake-forest-entry", entityIds: ["vara", "tend-vara", "greenwake-roars", "vara-fragment", "warden-staff", "corrupted-boar", "greenwake-sap-stalker", "greenwake-root-rammer"] },
  { segment: "Monkey Chase", regionId: "whispering-canopy", nodeId: "canopy-trial-roost", entityIds: ["koro", "canopy-vine-route", "koro-trail", "monkey-rescue"] },
  { segment: "Hunter Camp", regionId: "blood-bamboo-valley", nodeId: "bamboo-hunter-camp", entityIds: ["hunter-melee-west", "hunter-melee-east", "hunter-ranged", "bamboo-vara", "bamboo-koro", "camp-disable", "koro-drop-object", "player-drop-object"] },
  { segment: "Tiger Tracking", regionId: "blood-bamboo-valley", nodeId: "bamboo-tiger-tracks", entityIds: ["bamboo-tracks", "tali-trail", "bamboo-vara"] },
  { segment: "Asha Boss", regionId: "blood-bamboo-valley", nodeId: "bamboo-asha-arena", entityIds: ["asha", "tali", "tali-cage", "asha-cleanse"] },
  { segment: "The First Pact", regionId: "the-grove", nodeId: "grove-trial-glade", entityIds: ["grove-heartroot", "asha", "tali", "grove-council"] },
] as const;

// The chapter overlays (actors, interaction targets, routes) come from the shared story kit.

export const ACT_I_REGIONS: readonly RegionDefinition[] = [
  {
    id: "greenwake", authoringStatus: "unaccepted", name: "Greenwake", biome: "Forest-edge settlement and the Erya boundary", bounds: { min: v(-56, -1, -52), max: v(108, 14, 88) }, environmentRecipeId: "greenwake-environment",
    props: [
      prop("greenwake-yara-courtyard", "prop-greenwake-houses", v(-12, 0, -4), "ground"),
      // Reused native river stones: small, non-blocking loose bodies beside the first combat pocket.
      prop("environment-loose-greenwake-west", "prop-mire-bank-rock", v(5.05, 0, -2.4), "ground", 0.3, v(0.12, 0.12, 0.12)),
      prop("environment-loose-greenwake-east", "prop-mire-bank-rock", v(7.15, 0, -3.1), "ground", 1.1, v(0.14, 0.12, 0.13)),
      prop("environment-loose-greenwake-north", "prop-mire-bank-rock", v(6.25, 0, -4.7), "ground", 2.2, v(0.11, 0.1, 0.12)),
      prop("greenwake-erya-edge", "prop-erya-edge-tree", v(17, 0, -9), "ground", -0.22, v(1.5, 1.5, 1.5)),
      prop("greenwake-entry-tree-west", "prop-erya-edge-tree", v(-19, 0, -14), "ground", -0.18, v(0.6, 0.6, 0.6)),
      prop("greenwake-entry-tree-center", "prop-erya-edge-tree", v(-13, 0, -14), "ground", 0.31, v(0.6, 0.6, 0.6)),
      prop("greenwake-entry-tree-east", "prop-erya-edge-tree", v(-10, 0, -14), "ground", -0.42, v(0.6, 0.6, 0.6)),
      prop("greenwake-entry-tree-west-front", "prop-erya-edge-tree", v(-19.5, 0, -8), "ground", -0.15, v(0.38, 0.38, 0.38)),
      prop("greenwake-entry-tree-east-front", "prop-erya-edge-tree", v(-14, 0, -7), "ground", 0.1, v(0.4, 0.4, 0.4)),
      prop("greenwake-stream-tree-north", "prop-erya-edge-tree", v(14, 0, -11), "ground", 0.45, v(0.7, 0.7, 0.7)),
      prop("greenwake-stream-tree-south", "prop-erya-edge-tree", v(20, 0, -5), "ground", -0.32, v(0.8, 0.8, 0.8)),
      prop("greenwake-sap-cabin", "prop-hunter-cage", v(11, 0, -4), "ground", 0.2, v(0.9, 0.9, 0.9)),
      prop("greenwake-thicket-stilt-cabin", "prop-greenwake-houses", v(16, 0, 11), "ground", -0.55, v(0.85, 0.85, 0.85)),
      prop("greenwake-thicket-tree", "prop-erya-edge-tree", v(17.5, 0, 11.5), "ground", 0.18, v(0.7, 0.7, 0.7)),
      prop("greenwake-fallen-bough-visual", "prop-root-arch", v(17.5, 0.7, 7.5), "ground", 0, v(0.45, 0.45, 0.45)),
      prop("greenwake-sap-pantry-visual", "prop-hunter-cage", v(13.4, 0, -3.6), "ground", 0, v(0.55, 0.55, 0.55)),
      prop("greenwake-root-buttress-visual", "prop-root-arch", v(8, 0.5, 6.5), "ground", 0, v(0.45, 0.45, 0.45)),
      // Rope bridge spanning the creek gully between the earthen ridge (x ≤ 13.5) and the gateway descent (x ≥ 17).
      // Local +z (the 6 m model length) maps to world +x; scale gives a 4.5 m span and a 3 m deck between rails.
      // The model's deck arches (its ends stand 1.05 m and its middle 0.57 m above the origin): y 1.17 puts the ends at 2.22 / 1.78,
      // within a 0.25 m step of the 2.0 m ridge and gateway the walk-mesh meets, and the measured deck supports the capsule.
      prop("greenwake-branch-bridge", "prop-greenwake-rope-bridge", v(15.05, 1.17, 18.5), "elevated", Math.PI / 2, v(1.667, 1, 0.75)),
      prop("greenwake-root-arch", "prop-root-arch", v(23, 0, 20), "ground"),
      prop("greenwake-empty-cage", "prop-hunter-cage", v(5, 0, 3), "ground"),
      // Long forest route: trail obstacles and edge trees appended after the existing gateway.
      prop("greenwake-corridor-low-root-visual", "prop-root-arch", v(36, 0, 24), "ground", 0.785, v(0.08, 0.17, 0.08)),
      prop("greenwake-corridor-cage-visual", "prop-hunter-cage", v(44, 0, 41), "ground", 0.35, v(0.6, 1.4, 0.6)),
      prop("greenwake-corridor-tree-cluster-visual", "prop-erya-edge-tree", v(60, 0, 49), "ground", 0.18, v(0.7, 0.7, 0.7)),
      // Dense forest dressing: deterministic cluster groups beside the forest route. The Greenwake route is sealed,
      // so every tree here is visual only: its centre stays off the walk-mesh (clusters that used to stand on the
      // corridors or in the arena pockets were removed). The playtest layout (createCombatTrialRegion) additionally
      // drops any tree whose canopy would overhang the path and adds the boundary ring.
      // Cluster Aa (12 trees) — north of corridor-1, below thicket/erya-edge row.
      prop("greenwake-edge-tree-Aa1", "prop-erya-edge-tree", v(21.00, 0, 13.50), "ground", 4.62, v(0.70, 0.70, 0.70)),
      prop("greenwake-edge-tree-Aa2", "prop-erya-edge-tree", v(22.50, 0, 12.00), "ground", 1.38, v(0.52, 0.52, 0.52)),
      prop("greenwake-edge-tree-Aa3", "prop-erya-edge-tree", v(24.00, 0, 13.00), "ground", 5.46, v(0.66, 0.66, 0.66)),
      prop("greenwake-edge-tree-Aa4", "prop-erya-edge-tree", v(25.50, 0, 11.50), "ground", 4.09, v(0.80, 0.80, 0.80)),
      prop("greenwake-edge-tree-Aa5", "prop-erya-edge-tree", v(27.00, 0, 13.00), "ground", 0.51, v(0.87, 0.87, 0.87)),
      prop("greenwake-edge-tree-Aa6", "prop-erya-edge-tree", v(28.50, 0, 11.50), "ground", 1.54, v(0.89, 0.89, 0.89)),
      prop("greenwake-edge-tree-Aa7", "prop-erya-edge-tree", v(30.00, 0, 13.00), "ground", 2.56, v(0.57, 0.57, 0.57)),
      prop("greenwake-edge-tree-Aa8", "prop-erya-edge-tree", v(31.50, 0, 12.00), "ground", 4.57, v(0.59, 0.59, 0.59)),
      prop("greenwake-edge-tree-Aa9", "prop-erya-edge-tree", v(33.00, 0, 13.50), "ground", 3.57, v(0.56, 0.56, 0.56)),
      prop("greenwake-edge-tree-Aa10", "prop-erya-edge-tree", v(34.00, 0, 11.50), "ground", 4.51, v(0.72, 0.72, 0.72)),
      prop("greenwake-edge-tree-Aa11", "prop-erya-edge-tree", v(26.00, 0, 14.50), "ground", 0.78, v(0.65, 0.65, 0.65)),
      prop("greenwake-edge-tree-Aa12", "prop-erya-edge-tree", v(29.00, 0, 14.00), "ground", 6.23, v(0.73, 0.73, 0.73)),
      // Cluster Bb (11 trees) — south of corridor-1, north of the gateway ramp cluster.
      prop("greenwake-edge-tree-Bb1", "prop-erya-edge-tree", v(21.00, 0, 27.00), "ground", 5.15, v(0.75, 0.75, 0.75)),
      prop("greenwake-edge-tree-Bb2", "prop-erya-edge-tree", v(22.00, 0, 25.00), "ground", 0.98, v(0.52, 0.52, 0.52)),
      prop("greenwake-edge-tree-Bb3", "prop-erya-edge-tree", v(23.00, 0, 28.00), "ground", 2.78, v(0.88, 0.88, 0.88)),
      prop("greenwake-edge-tree-Bb4", "prop-erya-edge-tree", v(24.50, 0, 26.50), "ground", 4.65, v(0.63, 0.63, 0.63)),
      prop("greenwake-edge-tree-Bb5", "prop-erya-edge-tree", v(26.00, 0, 29.00), "ground", 1.83, v(0.80, 0.80, 0.80)),
      prop("greenwake-edge-tree-Bb6", "prop-erya-edge-tree", v(27.50, 0, 26.00), "ground", 3.12, v(0.58, 0.58, 0.58)),
      prop("greenwake-edge-tree-Bb7", "prop-erya-edge-tree", v(29.00, 0, 28.50), "ground", 0.73, v(0.54, 0.54, 0.54)),
      prop("greenwake-edge-tree-Bb8", "prop-erya-edge-tree", v(30.00, 0, 26.50), "ground", 1.03, v(0.87, 0.87, 0.87)),
      prop("greenwake-edge-tree-Bb9", "prop-erya-edge-tree", v(31.50, 0, 29.50), "ground", 2.55, v(0.57, 0.57, 0.57)),
      prop("greenwake-edge-tree-Bb11", "prop-erya-edge-tree", v(25.00, 0, 30.00), "ground", 2.09, v(0.75, 0.75, 0.75)),
      // Cluster Cc (10 trees) — south of corridor-1 north margin, paving the gap with B/A.
      prop("greenwake-edge-tree-Cc1", "prop-erya-edge-tree", v(21.50, 0, 14.00), "ground", 5.84, v(0.82, 0.82, 0.82)),
      prop("greenwake-edge-tree-Cc2", "prop-erya-edge-tree", v(24.00, 0, 15.50), "ground", 1.19, v(0.68, 0.68, 0.68)),
      prop("greenwake-edge-tree-Cc3", "prop-erya-edge-tree", v(26.00, 0, 14.50), "ground", 5.61, v(0.71, 0.71, 0.71)),
      prop("greenwake-edge-tree-Cc4", "prop-erya-edge-tree", v(27.50, 0, 15.00), "ground", 1.66, v(0.85, 0.85, 0.85)),
      prop("greenwake-edge-tree-Cc5", "prop-erya-edge-tree", v(29.00, 0, 14.50), "ground", 2.04, v(0.76, 0.76, 0.76)),
      prop("greenwake-edge-tree-Cc6", "prop-erya-edge-tree", v(30.50, 0, 15.50), "ground", 1.89, v(0.65, 0.65, 0.65)),
      prop("greenwake-edge-tree-Cc7", "prop-erya-edge-tree", v(32.00, 0, 14.00), "ground", 0.79, v(0.89, 0.89, 0.89)),
      prop("greenwake-edge-tree-Cc8", "prop-erya-edge-tree", v(33.50, 0, 15.00), "ground", 0.40, v(0.50, 0.50, 0.50)),
      prop("greenwake-edge-tree-Cc9", "prop-erya-edge-tree", v(34.50, 0, 14.00), "ground", 1.24, v(0.51, 0.51, 0.51)),
      prop("greenwake-edge-tree-Cc10", "prop-erya-edge-tree", v(28.00, 0, 15.50), "ground", 4.70, v(0.69, 0.69, 0.69)),
      // Cluster Dd (11 trees) — west of corridor-3, around the jumpable low root.
      prop("greenwake-edge-tree-Dd1", "prop-erya-edge-tree", v(30.00, 0, 30.00), "ground", 0.08, v(0.87, 0.87, 0.87)),
      prop("greenwake-edge-tree-Dd2", "prop-erya-edge-tree", v(31.50, 0, 32.00), "ground", 5.69, v(0.62, 0.62, 0.62)),
      prop("greenwake-edge-tree-Dd5", "prop-erya-edge-tree", v(33.00, 0, 33.50), "ground", 3.26, v(0.68, 0.68, 0.68)),
      prop("greenwake-edge-tree-Dd6", "prop-erya-edge-tree", v(34.00, 0, 36.00), "ground", 0.01, v(0.83, 0.83, 0.83)),
      prop("greenwake-edge-tree-Dd7", "prop-erya-edge-tree", v(32.00, 0, 38.00), "ground", 4.02, v(0.66, 0.66, 0.66)),
      prop("greenwake-edge-tree-Dd8", "prop-erya-edge-tree", v(33.00, 0, 40.00), "ground", 3.52, v(0.56, 0.56, 0.56)),
      prop("greenwake-edge-tree-Dd9", "prop-erya-edge-tree", v(31.00, 0, 41.50), "ground", 3.17, v(0.58, 0.58, 0.58)),
      prop("greenwake-edge-tree-Dd10", "prop-erya-edge-tree", v(32.50, 0, 43.50), "ground", 6.23, v(0.69, 0.69, 0.69)),
      prop("greenwake-edge-tree-Dd11", "prop-erya-edge-tree", v(34.50, 0, 43.00), "ground", 3.82, v(0.55, 0.55, 0.55)),
      // Cluster Ff — east of corridor-3, between low-root-area and the cage obstacle.
      prop("greenwake-edge-tree-Ff4", "prop-erya-edge-tree", v(47.00, 0, 30.50), "ground", 1.60, v(0.89, 0.89, 0.89)),
      prop("greenwake-edge-tree-Ff5", "prop-erya-edge-tree", v(47.50, 0, 33.00), "ground", 1.77, v(0.54, 0.54, 0.54)),
      prop("greenwake-edge-tree-Ff6", "prop-erya-edge-tree", v(47.50, 0, 36.00), "ground", 1.01, v(0.88, 0.88, 0.88)),
      // Cluster Hh — north of corridor-5 axis row, kept short of the c6 endpoint.
      prop("greenwake-edge-tree-Hh3", "prop-erya-edge-tree", v(55.00, 0, 41.00), "ground", 1.87, v(0.72, 0.72, 0.72)),
      prop("greenwake-edge-tree-Hh4", "prop-erya-edge-tree", v(56.50, 0, 41.50), "ground", 4.38, v(0.82, 0.82, 0.82)),
      prop("greenwake-edge-tree-Hh5", "prop-erya-edge-tree", v(58.00, 0, 41.00), "ground", 2.95, v(0.63, 0.63, 0.63)),
      prop("greenwake-edge-tree-Hh6", "prop-erya-edge-tree", v(59.50, 0, 41.50), "ground", 1.39, v(0.56, 0.56, 0.56)),
      prop("greenwake-edge-tree-Hh7", "prop-erya-edge-tree", v(61.00, 0, 41.00), "ground", 5.78, v(0.50, 0.50, 0.50)),
      // Cluster Ii (10 trees) — south of corridor-5 axis row, between cage and the root cluster.
      prop("greenwake-edge-tree-Ii4", "prop-erya-edge-tree", v(54.50, 0, 52.00), "ground", 0.10, v(0.74, 0.74, 0.74)),
      prop("greenwake-edge-tree-Ii5", "prop-erya-edge-tree", v(56.00, 0, 50.50), "ground", 5.88, v(0.81, 0.81, 0.81)),
      prop("greenwake-edge-tree-Ii6", "prop-erya-edge-tree", v(57.50, 0, 52.00), "ground", 5.47, v(0.89, 0.89, 0.89)),
      prop("greenwake-edge-tree-Ii7", "prop-erya-edge-tree", v(52.00, 0, 53.50), "ground", 2.25, v(0.80, 0.80, 0.80)),
      prop("greenwake-edge-tree-Ii8", "prop-erya-edge-tree", v(55.00, 0, 53.50), "ground", 1.55, v(0.52, 0.52, 0.52)),
      prop("greenwake-edge-tree-Ii9", "prop-erya-edge-tree", v(58.00, 0, 51.00), "ground", 1.91, v(0.52, 0.52, 0.52)),
      prop("greenwake-edge-tree-Ii10", "prop-erya-edge-tree", v(62.00, 0, 51.00), "ground", 3.08, v(0.64, 0.64, 0.64)),
      // Cluster Jj (7 trees) — north-east of corridor-6 endpoint, the long exit thicket.
      prop("greenwake-edge-tree-Jj1", "prop-erya-edge-tree", v(66.50, 0, 50.50), "ground", 2.17, v(0.66, 0.66, 0.66)),
      prop("greenwake-edge-tree-Jj2", "prop-erya-edge-tree", v(68.00, 0, 50.50), "ground", 6.27, v(0.60, 0.60, 0.60)),
      prop("greenwake-edge-tree-Jj3", "prop-erya-edge-tree", v(69.50, 0, 49.00), "ground", 1.25, v(0.64, 0.64, 0.64)),
      prop("greenwake-edge-tree-Jj4", "prop-erya-edge-tree", v(70.00, 0, 47.00), "ground", 0.84, v(0.52, 0.52, 0.52)),
      prop("greenwake-edge-tree-Jj5", "prop-erya-edge-tree", v(71.00, 0, 45.50), "ground", 2.14, v(0.74, 0.74, 0.74)),
      prop("greenwake-edge-tree-Jj6", "prop-erya-edge-tree", v(72.21, 0, 44.02), "ground", 4.61, v(0.66, 0.66, 0.66)),
      prop("greenwake-edge-tree-Jj7", "prop-erya-edge-tree", v(74.50, 0, 34.00), "ground", 4.31, v(0.86, 0.86, 0.86)),
      // Cluster Kk — western village tree-line (north of roars box, west of cabin village) and a
      // small ESE strip behind the entry camera viewpoint; both stay off the entry/ground-route
      // ribbon at z ≥ -5, the village box (x -16..16, z -7..0) and the settlement wall.
      prop("greenwake-edge-tree-Kka1", "prop-erya-edge-tree", v(-23.00, 0, -16.00), "ground", 0.07, v(0.70, 0.70, 0.70)),
      prop("greenwake-edge-tree-Kka2", "prop-erya-edge-tree", v(-22.00, 0, -15.00), "ground", 0.98, v(0.66, 0.66, 0.66)),
      prop("greenwake-edge-tree-Kka6", "prop-erya-edge-tree", v(-14.00, 0, -17.00), "ground", 1.81, v(0.64, 0.64, 0.64)),
      prop("greenwake-edge-tree-Kka8", "prop-erya-edge-tree", v(-10.00, 0, -17.00), "ground", 2.81, v(0.76, 0.76, 0.76)),
      // Cluster Lm — second canopy row closer to the entry corridor to thicken the entry view
      // for the entry camera without occluding the courtyard; lives in x = -22..-3 and z ≤ -12.
      prop("greenwake-edge-tree-Lma1", "prop-erya-edge-tree", v(-22.00, 0, -14.00), "ground", 0.07, v(0.70, 0.70, 0.70)),
      prop("greenwake-edge-tree-Lma2", "prop-erya-edge-tree", v(-21.00, 0, -13.50), "ground", 0.98, v(0.66, 0.66, 0.66)),
      // Outer canopy patches keep the fixed camera inside the forest rather than above a cut-out board.
      ...[
        [-33, -9, .62], [-37, -15, .84], [-31, -20, .71], [-39, -25, .92],
        [-27, -26, .76], [-34, -32, .66], [-24, -34, .95], [-18, -29, .73],
        [-11, -28, .86], [-4, -24, .61], [3, -30, .82], [8, -23, .68],
        [-30, 1, .78], [-34, 8, .93], [-26, 13, .67], [-17, 12, .72],
        [3, 26, .83], [10, 32, .65], [19, 33, .79], [26, 38, .9],
        [38, 54, .77], [46, 59, .88], [56, 62, .71], [66, 58, .96],
        [76, 56, .68], [82, 48, .85], [85, 38, .74], [78, 27, .92],
      ].map(([x, z, scale], index) => prop(`greenwake-edge-tree-outer-${index}`, "prop-erya-edge-tree", v(x!, 0, z!), "ground", index * 2.399, v(scale!, scale!, scale!))),
    ],
    movableObjects: [],
    ground: {
      y: 0, profile: "terraced", navGraphId: "greenwake-nav",
      surfaces: [
        { id: "greenwake-courtyard", profile: "terrace", points: [v(-20, 0, -16), v(-2, 0, -16), v(-2, 0, -2), v(-20, 0, -2)], elevation: 0, thickness: 0.45, walkable: true, material: "greenwake-packed-earth", colliderId: "greenwake-courtyard-collider" },
        { id: "greenwake-forest-floor", profile: "plane", points: [v(-2, 0, -12), v(18, 0, -12), v(18, 0, 4), v(-2, 0, 4)], elevation: 0, thickness: 0.5, walkable: true, material: "erya-leaf-litter", colliderId: "greenwake-forest-collider" },
        // One continuous bank joins the forest and thicket to the root ramp; no lower flat floor remains inside that ramp.
        { id: "greenwake-forest-bank", profile: "ramp", points: [v(-2, 0, 4), v(18, 0, 4), v(18, 0.6, 7), v(-2, 0.6, 7)], elevation: 0.3, thickness: 0.5, walkable: true, material: "erya-leaf-litter", colliderId: "greenwake-forest-bank-collider" },
        { id: "greenwake-stream-bend", profile: "terrace", points: [v(12, 0, -12), v(22, 0, -12), v(22, 0, -3), v(12, 0, -3)], elevation: 0, thickness: 0.4, walkable: true, material: "erya-leaf-litter", colliderId: "greenwake-stream-bend-collider", traversalEvent: "greenwake-stream-meander" },
        { id: "greenwake-sap-pools", profile: "terrace", points: [v(10, 0, -7), v(18, 0, -7), v(18, 0, -2), v(10, 0, -2)], elevation: 0, thickness: 0.4, walkable: true, material: "erya-leaf-litter", colliderId: "greenwake-sap-pools-collider", traversalEvent: "greenwake-sap-pools" },
        { id: "greenwake-boar-clearing", profile: "terrace", points: [v(3, 0, -8), v(16, 0, -8), v(16, 0, 4), v(3, 0, 4)], elevation: 0, thickness: 0.45, walkable: true, material: "greenwake-boar-clearing", colliderId: "greenwake-boar-clearing-collider" },
        { id: "greenwake-boar-thicket", profile: "ramp", points: [v(13, 0.2, 5), v(18, 0.2, 5), v(18, 1, 9), v(13, 1, 9)], elevation: 0.6, thickness: 0.4, walkable: true, material: "greenwake-boar-thicket", colliderId: "greenwake-boar-thicket-collider", traversalEvent: "greenwake-thicket-weave" },
        { id: "greenwake-root-step", profile: "ramp", points: [v(6, 0, 4), v(13, 0, 4), v(13, 2, 14), v(6, 2, 14)], elevation: 1, thickness: 0.45, walkable: true, material: "greenwake-packed-earth", colliderId: "greenwake-root-ramp-collider", traversalEvent: "greenwake-canopy-step" },
        // Earthen ridge top; the creek gully at x 13.5–17 is crossed only on the rope bridge deck.
        { id: "greenwake-rope-landing", profile: "terrace", points: [v(2, 2, 14), v(13.5, 2, 14), v(13.5, 2, 20), v(2, 2, 20)], elevation: 2, thickness: 0.3, walkable: true, material: "greenwake-packed-earth", colliderId: "greenwake-rope-landing-collider", traversalEvent: "greenwake-grove" },
        { id: "greenwake-gully-bridge", profile: "terrace", points: [v(13.5, 2, 17), v(17, 2, 17), v(17, 2, 20), v(13.5, 2, 20)], elevation: 2, thickness: 0.2, walkable: true, material: "greenwake-bridge-deck", colliderId: "greenwake-gully-bridge-collider", traversalEvent: "greenwake-grove" },
        { id: "greenwake-grove-gateway", profile: "ramp", points: [v(17, 2, 17), v(23, 0, 17), v(23, 0, 23), v(17, 2, 23)], elevation: 1, thickness: 0.35, walkable: true, material: "greenwake-grove-path", colliderId: "greenwake-grove-gateway-collider" },
        // Long forest route: six 6–7 m wide overlapping packed-earth quads that
        // follow each centerline segment. Axis-aligned legs use a 7 m wide
        // rectangle; diagonal legs use a perpendicular ±half-width offset
        // quad so the corridor does not balloon into a wide plate.
        { id: "greenwake-forest-corridor-1", profile: "terrace", points: [v(23, 0, 16.5), v(35, 0, 16.5), v(35, 0, 23.5), v(23, 0, 23.5)], elevation: 0, thickness: 0.45, walkable: true, material: "greenwake-packed-earth", colliderId: "greenwake-forest-corridor-1-collider", traversalEvent: "greenwake-forest-corridor" },
        { id: "greenwake-forest-corridor-2", profile: "terrace", points: [v(34.475, 0, 17.525), v(42.475, 0, 25.525), v(37.525, 0, 30.475), v(29.525, 0, 22.475)], elevation: 0, thickness: 0.45, walkable: true, material: "greenwake-packed-earth", colliderId: "greenwake-forest-corridor-2-collider", traversalEvent: "greenwake-forest-corridor" },
        { id: "greenwake-forest-corridor-3", profile: "terrace", points: [v(36.5, 0, 25), v(43.5, 0, 25), v(43.5, 0, 42), v(36.5, 0, 42)], elevation: 0, thickness: 0.45, walkable: true, material: "greenwake-packed-earth", colliderId: "greenwake-forest-corridor-3-collider", traversalEvent: "greenwake-forest-corridor" },
        { id: "greenwake-forest-corridor-4", profile: "terrace", points: [v(38.324, 0, 43.073), v(49.324, 0, 49.073), v(52.676, 0, 42.927), v(41.676, 0, 36.927)], elevation: 0, thickness: 0.45, walkable: true, material: "greenwake-packed-earth", colliderId: "greenwake-forest-corridor-4-collider", traversalEvent: "greenwake-forest-corridor" },
        { id: "greenwake-forest-corridor-5", profile: "terrace", points: [v(48, 0, 42.5), v(66, 0, 42.5), v(66, 0, 49.5), v(48, 0, 49.5)], elevation: 0, thickness: 0.45, walkable: true, material: "greenwake-packed-earth", colliderId: "greenwake-forest-corridor-5-collider", traversalEvent: "greenwake-forest-corridor" },
        { id: "greenwake-forest-corridor-6", profile: "terrace", points: [v(60.675, 0, 43.384), v(69.675, 0, 35.384), v(74.325, 0, 40.616), v(65.325, 0, 48.616)], elevation: 0, thickness: 0.45, walkable: true, material: "greenwake-packed-earth", colliderId: "greenwake-forest-corridor-6-collider", traversalEvent: "greenwake-forest-corridor" },
        // Arena pockets for Trials 2 and 3: flat y=0 octagons (inradius 8.5 m) that overlap the
        // corridor ahead of their own gate and never reach the gate plane.
        { id: "greenwake-frost-hollow", profile: "terrace", points: [v(35.48, 0, 15.5), v(42.52, 0, 15.5), v(47.5, 0, 20.48), v(47.5, 0, 27.52), v(42.52, 0, 32.5), v(35.48, 0, 32.5), v(30.5, 0, 27.52), v(30.5, 0, 20.48)], elevation: 0, thickness: 0.45, walkable: true, material: "greenwake-packed-earth", colliderId: "greenwake-frost-hollow-collider", traversalEvent: "greenwake-forest-corridor" },
        { id: "greenwake-root-watch", profile: "terrace", points: [v(42.98, 0, 37.5), v(50.02, 0, 37.5), v(55, 0, 42.48), v(55, 0, 49.52), v(50.02, 0, 54.5), v(42.98, 0, 54.5), v(38, 0, 49.52), v(38, 0, 42.48)], elevation: 0, thickness: 0.45, walkable: true, material: "greenwake-packed-earth", colliderId: "greenwake-root-watch-collider", traversalEvent: "greenwake-forest-corridor" },
      ],
      colliders: [
        { id: "greenwake-courtyard-collider", kind: "box", from: v(-11, -0.23, -9), halfExtents: v(9, 0.23, 7), blocksMovement: true, blocksCamera: false, walkSurfaceId: "greenwake-courtyard" },
        { id: "greenwake-forest-collider", kind: "box", from: v(8, -0.25, -4), halfExtents: v(10, 0.25, 8), blocksMovement: true, blocksCamera: false, walkSurfaceId: "greenwake-forest-floor" },
        { id: "greenwake-forest-bank-collider", kind: "segment", from: v(8, 0, 4), to: v(8, 0.6, 7), radius: 10, blocksMovement: false, blocksCamera: false, walkSurfaceId: "greenwake-forest-bank" },
        { id: "greenwake-stream-bend-collider", kind: "box", from: v(17, -0.21, -7.5), halfExtents: v(5, 0.21, 4.5), blocksMovement: true, blocksCamera: false, walkSurfaceId: "greenwake-stream-bend" },
        { id: "greenwake-sap-pools-collider", kind: "box", from: v(14, -0.21, -4.5), halfExtents: v(4, 0.21, 2.5), blocksMovement: true, blocksCamera: false, walkSurfaceId: "greenwake-sap-pools" },
        { id: "greenwake-root-ramp-collider", kind: "segment", from: v(9.5, 0, 4), to: v(9.5, 2, 14), radius: 3.5, blocksMovement: false, blocksCamera: false, walkSurfaceId: "greenwake-root-step" },
        { id: "greenwake-rope-landing-collider", kind: "box", from: v(7.75, 1.85, 17), halfExtents: v(5.75, 0.15, 3), blocksMovement: true, blocksCamera: false, walkSurfaceId: "greenwake-rope-landing" },
        { id: "greenwake-gully-bridge-collider", kind: "box", from: v(15.25, 1.85, 18.5), halfExtents: v(1.75, 0.15, 1.5), blocksMovement: true, blocksCamera: false, walkSurfaceId: "greenwake-gully-bridge" },
        { id: "greenwake-boar-clearing-collider", kind: "box", from: v(9.5, -0.23, -2), halfExtents: v(6.5, 0.23, 6), blocksMovement: true, blocksCamera: false, walkSurfaceId: "greenwake-boar-clearing" },
        { id: "greenwake-boar-thicket-collider", kind: "segment", from: v(15.5, 0.2, 5), to: v(15.5, 1, 9), radius: 2.5, blocksMovement: false, blocksCamera: false, walkSurfaceId: "greenwake-boar-thicket" },
        { id: "greenwake-grove-gateway-collider", kind: "segment", from: v(17, 2, 20), to: v(23, 0, 20), radius: 3, blocksMovement: false, blocksCamera: false, walkSurfaceId: "greenwake-grove-gateway" },
        { id: "greenwake-settlement-wall-west", kind: "box", from: v(-22, 2, -7), halfExtents: v(1, 2, 5), blocksMovement: true, blocksCamera: true },
        { id: "greenwake-fallen-bough", kind: "box", from: v(17.5, 1.15, 7.5), halfExtents: v(0.5, 0.45, 1.4), blocksMovement: true, blocksCamera: true },
        { id: "greenwake-sap-pantry", kind: "box", from: v(13.4, 0.4, -3.6), halfExtents: v(0.8, 0.4, 0.8), blocksMovement: true, blocksCamera: false },
        { id: "greenwake-root-buttress", kind: "box", from: v(8, 0.55, 6.5), halfExtents: v(0.5, 0.55, 1.0), blocksMovement: true, blocksCamera: false },
        // Long forest route: walkable packed-earth colliders mirror each surface, plus
        // three blocking obstacles (low root, solid cage, root cluster) authored to
        // match the visible prop placement and leave >= 1.2 m side passage on the
        // corridor. The collider for each diagonal leg is a segment along the
        // centerline with a 3.5 m radius so the swept cylinder hugs the 7 m
        // corridor without ballooning into a wide plate.
        { id: "greenwake-forest-corridor-1-collider", kind: "box", from: v(29, -0.23, 20), halfExtents: v(6, 0.23, 3.5), blocksMovement: true, blocksCamera: false, walkSurfaceId: "greenwake-forest-corridor-1" },
        { id: "greenwake-forest-corridor-2-collider", kind: "segment", from: v(32, 0, 20), to: v(40, 0, 28), radius: 3.5, blocksMovement: false, blocksCamera: false, walkSurfaceId: "greenwake-forest-corridor-2" },
        { id: "greenwake-forest-corridor-3-collider", kind: "box", from: v(40, -0.23, 33.5), halfExtents: v(3.5, 0.23, 8.5), blocksMovement: true, blocksCamera: false, walkSurfaceId: "greenwake-forest-corridor-3" },
        { id: "greenwake-forest-corridor-4-collider", kind: "segment", from: v(40, 0, 40), to: v(51, 0, 46), radius: 3.5, blocksMovement: false, blocksCamera: false, walkSurfaceId: "greenwake-forest-corridor-4" },
        { id: "greenwake-forest-corridor-5-collider", kind: "box", from: v(57, -0.23, 46), halfExtents: v(9, 0.23, 3.5), blocksMovement: true, blocksCamera: false, walkSurfaceId: "greenwake-forest-corridor-5" },
        { id: "greenwake-forest-corridor-6-collider", kind: "segment", from: v(63, 0, 46), to: v(72, 0, 38), radius: 3.5, blocksMovement: false, blocksCamera: false, walkSurfaceId: "greenwake-forest-corridor-6" },
        { id: "greenwake-corridor-low-root", kind: "box", from: v(36, 0.25, 24), halfExtents: v(0.16, 0.25, 0.16), blocksMovement: true, blocksCamera: false },
        { id: "greenwake-corridor-cage", kind: "box", from: v(44, 1.25, 41), halfExtents: v(0.9, 1.25, 0.8), blocksMovement: true, blocksCamera: true },
        { id: "greenwake-corridor-root-cluster", kind: "box", from: v(60, 1, 48), halfExtents: v(0.5, 1, 0.5), blocksMovement: true, blocksCamera: true },
        { id: "greenwake-frost-hollow-collider", kind: "box", from: v(39, -0.23, 24), halfExtents: v(8.5, 0.23, 8.5), blocksMovement: true, blocksCamera: false, walkSurfaceId: "greenwake-frost-hollow" },
        { id: "greenwake-root-watch-collider", kind: "box", from: v(46.5, -0.23, 46), halfExtents: v(8.5, 0.23, 8.5), blocksMovement: true, blocksCamera: false, walkSurfaceId: "greenwake-root-watch" },
      ],
    },
    navigation: { nodes: [
      { id: "greenwake-forest-entry", position: v(-18, 0, -9), links: ["greenwake-village-edge", "greenwake-boar-approach"] },
      { id: "greenwake-village-edge", position: v(-7, 0, -9), links: ["greenwake-forest-entry", "greenwake-tutorial-yard", "greenwake-stream-meander"] },
      { id: "greenwake-tutorial-yard", position: v(-6, 0, -4), links: ["greenwake-village-edge", "greenwake-boar-approach"] },
      { id: "greenwake-boar-approach", position: v(4, 0, -4), links: ["greenwake-forest-entry", "greenwake-tutorial-yard", "greenwake-boar-clearing", "greenwake-stream-meander"] },
      { id: "greenwake-stream-meander", position: v(16, 0, -8), links: ["greenwake-village-edge", "greenwake-boar-approach", "greenwake-stream-ford"] },
      { id: "greenwake-stream-ford", position: v(15, 0, -5), links: ["greenwake-stream-meander", "greenwake-sap-pools"] },
      { id: "greenwake-sap-pools", position: v(13, 0, 1), links: ["greenwake-stream-ford", "greenwake-boar-clearing", "greenwake-bank-foot"] },
      { id: "greenwake-bank-foot", position: v(13.5, 0, 4), links: ["greenwake-sap-pools", "greenwake-boar-thicket-edge"] },
      { id: "greenwake-boar-clearing", position: v(10, 0, 0), links: ["greenwake-boar-approach", "greenwake-sap-pools", "greenwake-root-ramp"] },
      { id: "greenwake-boar-thicket-edge", position: v(14, 0.8, 8), links: ["greenwake-bank-foot", "greenwake-root-ramp"] },
      { id: "greenwake-root-ramp", position: v(9.5, 1.2, 10), links: ["greenwake-boar-clearing", "greenwake-boar-thicket-edge", "greenwake-grove-gate"] },
      { id: "greenwake-grove-gate", position: v(10, 2, 17), links: ["greenwake-root-ramp", "greenwake-gully-bridge-west"], requirement: "greenwake-boar-cleansed" },
      { id: "greenwake-gully-bridge-west", position: v(12.8, 2, 18.5), links: ["greenwake-grove-gate", "greenwake-gateway-ramp-entry"] },
      { id: "greenwake-gateway-ramp-entry", position: v(17, 2, 18), links: ["greenwake-gully-bridge-west", "greenwake-grove-gateway"] },
      { id: "greenwake-grove-gateway", position: v(21, 2 / 3, 20), links: ["greenwake-gateway-ramp-entry", "greenwake-forest-corridor-1"] },
      // Long forest route: navigation nodes along the centerline, all on the
      // authored packed-earth corridor surfaces.
      { id: "greenwake-forest-corridor-1", position: v(24, 0, 20), links: ["greenwake-grove-gateway", "greenwake-forest-corridor-2"] },
      { id: "greenwake-forest-corridor-2", position: v(32, 0, 20), links: ["greenwake-forest-corridor-1", "greenwake-forest-corridor-3"] },
      { id: "greenwake-forest-corridor-3", position: v(40, 0, 28), links: ["greenwake-forest-corridor-2", "greenwake-forest-corridor-3-bypass", "greenwake-forest-corridor-4"] },
      // Bypass node north of the jumpable low root so companions do not
      // straight-line through the obstacle; players can also walk around the
      // root via this node instead of jumping.
      { id: "greenwake-forest-corridor-3-bypass", position: v(38, 0, 23), links: ["greenwake-forest-corridor-2", "greenwake-forest-corridor-3", "greenwake-forest-corridor-4"] },
      { id: "greenwake-forest-corridor-4", position: v(40, 0, 40), links: ["greenwake-forest-corridor-3", "greenwake-forest-corridor-cage-bypass"] },
      { id: "greenwake-forest-corridor-cage-bypass", position: v(44, 0, 43), links: ["greenwake-forest-corridor-4", "greenwake-forest-corridor-5"] },
      { id: "greenwake-forest-corridor-5", position: v(51, 0, 46), links: ["greenwake-forest-corridor-cage-bypass", "greenwake-forest-corridor-6"] },
      { id: "greenwake-forest-corridor-6", position: v(63, 0, 46), links: ["greenwake-forest-corridor-5", "greenwake-forest-corridor-exit"] },
      { id: "greenwake-forest-corridor-exit", position: v(70.1, 0, 39.7), links: ["greenwake-forest-corridor-6"] },
    ], ribbons: [
      { id: "greenwake-ground-route", points: [v(-18, 0, -9), v(-7, 0, -9), v(-6, 0, -4), v(4, 0, -4), v(10, 0, 0)], width: 3.2, depthBand: "ground" },
      { id: "greenwake-stream-detour", points: [v(-7, 0, -9), v(16, 0, -8), v(15, 0, -5), v(13, 0, 1), v(13.5, 0, 4), v(14, 0.8, 8), v(13, 0, 4), v(9.5, 1.2, 10)], width: 2.4, depthBand: "ground" },
      { id: "greenwake-raised-route", points: [v(10, 0, 0), v(9.5, 0, 4), v(9.5, 1.2, 10), v(10, 2, 14), v(10, 2, 17), v(12.8, 2, 18.5), v(17, 2, 18), v(21, 2 / 3, 20)], width: 2.2, depthBand: "raised-root-and-rope" },
      // Long forest route ribbon: every interpolated anchor lands on the
      // overlapping packed-earth corridor surfaces above.
      { id: "greenwake-forest-corridor-route", points: [v(23, 0, 20), v(32, 0, 20), v(40, 0, 28), v(40, 0, 40), v(44, 0, 43), v(51, 0, 46), v(63, 0, 46), v(70.1, 0, 39.7)], width: 2.8, depthBand: "forest-floor" },
    ] },
    cameraAnchors: [
      { id: "greenwake-entry-rail", position: v(0, 5.5, 2), lookAt: v(6, 0, -7), mode: "exploration" },
      { id: "greenwake-stream-rail", position: v(6, 6, 4), lookAt: v(14, 0, -7), mode: "exploration" },
      { id: "greenwake-tutorial-rail", position: v(-4, 6, 5), lookAt: v(-6, 0, -3), mode: "story" },
      { id: "greenwake-boar-arena", position: v(10, 8, 10), lookAt: v(9, 0, -1), mode: "encounter" },
      { id: "greenwake-thicket-rail", position: v(6, 7, 17), lookAt: v(13, 1, 9), mode: "exploration" },
      { id: "greenwake-gate-rail", position: v(21, 8, 20), lookAt: v(10, 1, 15), mode: "story" },
      { id: "greenwake-exit-rail", position: v(76, 12, 58), lookAt: v(66, 0, 44), mode: "exploration" },
    ],
    entrances: [],
    exits: [route("greenwake-canopy-out", v(70.1, 0, 39.7), v(-58, 0, -20), "whispering-canopy", "path", "contextual-traverse", ["greenwake-forest-corridor-6-collider"], "greenwake-canopy", "interaction:greenwake-gate")],
    traversalArcs: [route("greenwake-grove-arc", v(17, 2, 18), v(21, 2 / 3, 20), "greenwake", "bridge", "contextual-traverse", ["greenwake-gully-bridge-collider", "greenwake-grove-gateway-collider"], "greenwake-grove")],
    entities: [
      actor("yara", "yara", "actor-yara", v(-9, 0, -5), "ground"),
      // Vara lies hurt on the courtyard floor: the prologue's first interaction is tending her.
      actor("vara", "vara", "actor-vara", v(-12, 0, -9), "ground"),
      actor("corrupted-boar", "corrupted-boar", "actor-ember-boar", v(10, 0, 0), "ground"),
      actor("greenwake-sap-stalker", "corrupted-boar", "actor-frost-sap-stalker", v(15, 0, -5), "ground"),
      actor("greenwake-root-rammer", "corrupted-boar", "actor-root-rammer", v(13, 1, 9), "ground"),
      target("greenwake-gate", v(10, 2, 17), "elevated"),
      target("greenwake-roars", v(-2, 0, -7)),
      target("tend-vara", v(-12, 0, -7.5)),
      target("boar-sap", v(10, 0, 0)),
      target("vara-fragment", v(-5, 0, -6)),
      target("warden-staff", v(-5, 0, -4)),
    ],
    encounterIds: [], encounterParticipants: {},
    restorationStates: ["unvisited", "corrupted", "partial", "restored"],
    assetIds: ["actor-yara", "actor-vara", "actor-corrupted-boar", "prop-greenwake-houses", "prop-erya-edge-tree", "prop-greenwake-rope-bridge", "prop-root-arch", "prop-hunter-cage"],
  },
  createCanopyChapterRegion(),
  createBambooChapterRegion(),
  createGroveChapterRegion(),
];
