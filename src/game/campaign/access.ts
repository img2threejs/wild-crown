import { FRAGMENT_IDS, type CampaignState } from "../../../packages/campaign/src/index.js";
import type {
  CampaignSnapshot,
  ChapterRuntimeDefinition,
  CompanionId,
  CompanionProgress,
  RegionDefinition,
  RegionId,
} from "../contracts.js";
import { deriveSegmentId, findSegmentDefinition } from "./session.js";

/**
 * One companion's access to the traveling party.
 *
 * `available` is the only authority: a companion may be equipped, spawned, commanded, previewed or trained with
 * exactly when it is available. `reason` is the plain-language refusal the UI shows; it is `null` when available.
 */
export interface CompanionAccess {
  readonly available: boolean;
  readonly reason: string | null;
}

/**
 * Immutable results for the fixed reasons. The common path returns one of these module constants instead of a fresh
 * object, so a per-render eligibility query allocates nothing.
 */
export const COMPANION_ACCESS_AVAILABLE: CompanionAccess = Object.freeze({ available: true, reason: null });
export const COMPANION_NOT_RECRUITED: Readonly<Record<CompanionId, CompanionAccess>> = Object.freeze({
  vara: Object.freeze({ available: false, reason: "Vara has not joined your journey yet. Tend to her in Greenwake." }),
  koro: Object.freeze({ available: false, reason: "Koro has not joined your journey yet. Cleanse him in Whispering Canopy." }),
  asha: Object.freeze({ available: false, reason: "Asha has not joined your journey yet. Cleanse her in Blood Bamboo Valley." }),
  sable: Object.freeze({ available: false, reason: "Sable has not joined your journey yet. Receive the Pack fragment in Moonpine Ridge." }),
  nyra: Object.freeze({ available: false, reason: "Nyra has not joined your journey yet. Receive the Shadow fragment in Mistveil Basin." }),
  solkar: Object.freeze({ available: false, reason: "Solkar has not joined your journey yet. Choose Bond in the Sunmane resolution." }),
});
export const COMPANION_EXILED: CompanionAccess = Object.freeze({
  available: false,
  reason: "Solkar left after your exile decision.",
});
export const COMPANION_ABSENT: CompanionAccess = Object.freeze({
  available: false,
  reason: "This companion is absent from the journey.",
});

/**
 * The faction whose leader status constrains a companion's presence. Vara (Sky) and Sable (Pack) travel as envoys, so
 * their faction's leader status never removes them; the four leaders are bound by their own faction's status.
 */
const COMPANION_FACTION: Readonly<Record<CompanionId, "sky" | "canopy" | "fang" | "pack" | "shadow" | "crown">> = {
  vara: "sky",
  koro: "canopy",
  asha: "fang",
  sable: "pack",
  nyra: "shadow",
  solkar: "crown",
};

/**
 * Whether a companion may be equipped and used, derived from the current campaign snapshot only.
 *
 * The authority is earned story progress: `snapshot.companions[id].recruited` — the committed outcome of the
 * recruitment rules — plus the narrative constraints that remove a companion from the journey (an exiled or absent
 * leader). Settings, map visits, the new ledger and chapter number are never consulted: a companion the player has not
 * recruited is unavailable, and a region the player has merely walked through grants nothing.
 */
export function companionAccess(
  snapshot: Pick<CampaignSnapshot, "companions" | "campaign" | "worldFacts">,
  id: CompanionId,
): CompanionAccess {
  return companionAccessOf(
    id,
    snapshot.companions[id],
    snapshot.campaign,
    snapshot.worldFacts["solkar-exiled"] === true,
    snapshot.worldFacts.solkarPresent === false,
  );
}

/**
 * The access rule over the campaign state alone, so the Director can ask the question without copying a snapshot.
 * `solkarExiled`/`solkarAbsent` carry the two world facts the crown faction does not already express.
 */
export function companionAccessOf(
  id: CompanionId,
  progress: CompanionProgress | undefined,
  campaign: CampaignState,
  solkarExiled: boolean,
  solkarAbsent: boolean,
): CompanionAccess {
  if (!progress || !progress.recruited) return COMPANION_NOT_RECRUITED[id];
  const crown = campaign.world.factions.crown;
  if (id === "solkar") {
    // Exile is permanent for Solkar: the Crown council may represent Crown, but it never restores him.
    if (crown.leaderStatus === "exiled" || solkarExiled || progress.storyFlags["solkar-exiled"] === true) return COMPANION_EXILED;
    if (crown.leaderStatus === "absent" || solkarAbsent) return COMPANION_ABSENT;
  }
  const faction = campaign.world.factions[COMPANION_FACTION[id]];
  if (faction && faction.leaderStatus === "absent" && faction.leaderId === id) return COMPANION_ABSENT;
  return COMPANION_ACCESS_AVAILABLE;
}

/** The reason a route stays closed while its authored unlock fact has not been earned. */
export const ROUTE_NOT_DISCOVERED = "The selected route has not been discovered.";
/** The reason a region the campaign has not reached stays closed. */
export const REGION_NOT_UNLOCKED = "This region has not been unlocked by campaign progression.";
/** The reason Heartroot Hollow stays closed before the Hollow opens. */
export const HOLLOW_LOCKED = "Heartroot Hollow is not accessible before Chapter 8.";
/** The reason the Refuge stays closed before the Fall of the Grove. */
export const REFUGE_LOCKED = "The Refuge does not open before the Fall of the Grove.";
/** The reason a required story choice still blocks a route. */
export const PENDING_CHOICE = "A required story choice must be resolved before leaving.";

/**
 * One region of the world map: whether it is open, and why not when it is closed.
 */
export interface RegionAccess {
  readonly unlocked: boolean;
  readonly reason: string | null;
}

/** A region that is closed because no authored route from the current region reaches it. */
export const REGION_ROUTE_LOCKED: RegionAccess = Object.freeze({ unlocked: false, reason: ROUTE_NOT_DISCOVERED });
/** A region that is closed because the campaign has not reached its chapter. */
export const REGION_CHAPTER_LOCKED: RegionAccess = Object.freeze({ unlocked: false, reason: REGION_NOT_UNLOCKED });

/**
 * The authored chapter of each region, used when no authored segment describes it.
 */
export const REGION_ACCESS_CHAPTER: Readonly<Record<RegionId, number>> = {
  greenwake: 0,
  "whispering-canopy": 1,
  "blood-bamboo-valley": 2,
  "moonpine-ridge": 3,
  "mistveil-basin": 4,
  "sunmane-expanse": 5,
  "the-grove": 6,
  refuge: 7,
  "heartroot-hollow": 8,
};

/**
 * The read-only facts every access question is answered from. The projection is cheap to build and safe to share: it
 * holds references to live state and is never mutated.
 */
export interface AccessProjection {
  readonly chapter: number;
  readonly regionId: RegionId;
  readonly worldFacts: Readonly<Record<string, boolean | number | string>>;
  readonly choices: Readonly<Record<string, string>>;
  readonly completedQuestIds: readonly string[];
  readonly completedObjectiveIds: readonly string[];
  readonly completedBeatIds: readonly string[];
  readonly pendingChoiceId: string | null;
  readonly fragments: readonly string[];
}

/** The projection of a published snapshot; the app layer and the Director read the same facts through it. */
export function projectionOf(snapshot: CampaignSnapshot): AccessProjection {
  return {
    chapter: snapshot.chapter,
    regionId: snapshot.regionId,
    worldFacts: snapshot.worldFacts,
    choices: snapshot.choices,
    completedQuestIds: snapshot.completedQuestIds,
    completedObjectiveIds: snapshot.completedObjectiveIds,
    completedBeatIds: snapshot.session.resume.completedBeatIds,
    pendingChoiceId: snapshot.session.resume.pendingChoiceId,
    fragments: snapshot.fragments,
  };
}

/**
 * The exit-requirement grammar: fact | quest:<id> | objective:<id> | choice:<id>[:<option>] | beat:<id>.
 * The projection carries every term, so the same rule answers a map question and a transition question.
 */
export function requirementMetOf(projection: AccessProjection, requirement: string): boolean {
  const [kind, target, option] = requirement.split(":");
  switch (kind) {
    case "quest": return projection.completedQuestIds.includes(target ?? "");
    case "objective": return projection.completedObjectiveIds.includes(requirement.slice("objective:".length));
    case "choice":
      return target !== undefined && projection.choices[target] !== undefined &&
        (option === undefined || projection.choices[target] === option);
    case "beat": return projection.completedBeatIds.includes(target ?? "");
    default: return projection.worldFacts[requirement] === true;
  }
}

/**
 * The authored segment the journey is currently in, and the exit requirements that segment owns.
 *
 * The Director and the map projection both read it, so a route the map offers is exactly a route the journey accepts.
 */
export function currentSegmentOf(
  projection: AccessProjection,
  chapters: readonly ChapterRuntimeDefinition[],
): ChapterRuntimeDefinition | undefined {
  return findSegmentDefinition(chapters, deriveSegmentId(
    projection.chapter,
    projection.regionId,
    projection.completedQuestIds,
    projection.completedObjectiveIds,
    projection.completedBeatIds,
  ));
}

/**
 * The chapter a journey reaches when it travels to `regionId`, derived from a projection and the authored runtime.
 *
 * The Fall of the Grove needs the earned Sunmane resolution and every Heartroot fragment; the hub preserves the
 * current chapter; the chapter-7 return journeys never move the chapter backwards.
 */
export function destinationChapterFor(
  projection: AccessProjection,
  regionId: RegionId,
  chapters: readonly ChapterRuntimeDefinition[],
): number {
  const groveFallTriggered =
    Boolean(projection.choices["sunmane-resolution"]) &&
    FRAGMENT_IDS.every((fragment) => projection.fragments.includes(fragment));
  return destinationChapterOf(regionId, projection.chapter, chapters, groveFallTriggered);
}

/**
 * The chapter a journey reaches when it travels to `regionId`: authored definition first (a hub preserves the current
 * chapter), then the canonical mapping.
 */
export function destinationChapterOf(
  regionId: RegionId,
  currentChapter: number,
  chapters: readonly ChapterRuntimeDefinition[],
  groveFallTriggered: boolean,
): number {
  if (regionId === "the-grove") {
    // The Grove preserves the current chapter for ordinary visits. The Fall of the Grove is chapter 6 and is only
    // entered once the story has earned it.
    const groveFall = chapters.find((item) => item.segmentId === "grove-fall");
    if (groveFallTriggered && groveFall !== undefined) return Math.max(currentChapter, groveFall.chapter);
    return currentChapter;
  }
  if (currentChapter >= 7) {
    // A return journey never moves the chapter backwards: the return segments carry the chapter the player is in.
    const returnSegment = chapters.find(
      (item) => item.regionId === regionId && item.segmentId.startsWith("return-"),
    );
    if (returnSegment) return Math.max(returnSegment.chapter, currentChapter);
    if (regionId === "refuge") return Math.max(7, currentChapter);
  }
  const authored = chapters.find(
    (item) =>
      item.regionId === regionId &&
      item.segmentId !== "grove" &&
      item.segmentId !== "prologue" &&
      !item.segmentId.startsWith("return-"),
  );
  if (authored) return authored.chapter;
  return REGION_ACCESS_CHAPTER[regionId] ?? currentChapter;
}

/**
 * Whether a destination chapter is reachable from the current chapter.
 *
 * A journey advances one chapter at a time and may revisit any chapter it has already reached. It may never skip
 * ahead: the authored exit requirements of the current segment are the proof that the next chapter was earned.
 */
export function destinationReachable(currentChapter: number, destinationChapter: number): boolean {
  return destinationChapter <= currentChapter + 1;
}

/** The outcome of a route gate: allowed, or the exact reason the route stays closed. */
export interface GateResult {
  readonly allowed: boolean;
  readonly reason: string | null;
}

const ALLOWED: GateResult = Object.freeze({ allowed: true, reason: null });

/**
 * The chapter-transition authority: what `advanceChapter` accepts.
 *
 * A chapter transition leaves the current segment, so it needs the segment's own exit requirements to be met, no
 * pending required choice, a destination at most one chapter ahead and a discovered route. The map projection asks
 * the same question, so a map can never offer a transition the journey would refuse.
 */
export function transitionGateOf(input: {
  readonly projection: AccessProjection;
  readonly destinationRegionId: RegionId;
  readonly destinationChapter: number;
  readonly exitRequirements: readonly string[];
  readonly routeDiscovered?: boolean;
}): GateResult {
  const { projection, destinationChapter } = input;
  const unmet = input.exitRequirements.filter((requirement) => !requirementMetOf(projection, requirement));
  if (unmet.length) return { allowed: false, reason: "Chapter exit requirements are not met: " + unmet.join(", ") };
  if (projection.pendingChoiceId !== null) return { allowed: false, reason: PENDING_CHOICE };
  if (destinationChapter > projection.chapter && !destinationReachable(projection.chapter, destinationChapter)) {
    return { allowed: false, reason: REGION_NOT_UNLOCKED };
  }
  if (input.routeDiscovered === false) return { allowed: false, reason: ROUTE_NOT_DISCOVERED };
  return ALLOWED;
}

/**
 * The plain-traversal authority: what `travel` accepts.
 *
 * A traversal moves between regions without leaving the story segment, so it needs the route discovered and a
 * destination the journey has already reached — a traversal never advances the chapter, that is a chapter
 * transition. A hub visit and an earned revisit stay open; a future region does not.
 */
export function travelGateOf(input: {
  readonly projection: AccessProjection;
  readonly destinationRegionId: RegionId;
  readonly destinationChapter: number;
  readonly routeDiscovered: boolean;
  readonly refugeOpen: boolean;
}): GateResult {
  const { projection, destinationRegionId } = input;
  if (destinationRegionId === "heartroot-hollow" && projection.chapter < 8) {
    return { allowed: false, reason: HOLLOW_LOCKED };
  }
  if (destinationRegionId === "refuge" && (projection.chapter < 6 || !input.refugeOpen)) {
    return { allowed: false, reason: REFUGE_LOCKED };
  }
  const refugeOpenOnFall =
    destinationRegionId === "refuge" && projection.chapter === 6 && input.refugeOpen;
  if (
    input.destinationChapter > projection.chapter &&
    destinationRegionId !== "the-grove" &&
    !refugeOpenOnFall
  ) {
    // The one shared next-chapter policy: a plain traversal never advances the chapter, so a destination ahead of
    // the current chapter stays closed. A chapter transition is the operation that moves the chapter on.
    return { allowed: false, reason: REGION_NOT_UNLOCKED };
  }
  if (!input.routeDiscovered) return { allowed: false, reason: ROUTE_NOT_DISCOVERED };
  return ALLOWED;
}

/**
 * The earned access of one world-map region and of every authored route from the current region into it.
 *
 * This is the single map authority: it owns the route pairing, the authored unlock facts, the chapter reach and the
 * story gates, so the map can never offer a route the journey would refuse. The route pairing is the authored one —
 * an exit and its entrance share a traversal event — and every authored entrance is preserved with its own reason,
 * so a closed route is visible as closed rather than missing.
 *
 * A region is open when the journey may travel there now: the region the player stands in, an earned revisit, a hub
 * visit, or a route whose gate the journey has satisfied. `visited:<region>` is never consulted — a walked-through
 * region is not an earned route, so it opens nothing on its own.
 *
 * The caller passes the snapshot it already holds, so nine region queries cost one snapshot rather than nine copies.
 */
export function mapRegionAccessOf(
  snapshot: CampaignSnapshot,
  regionId: RegionId,
  regions: readonly RegionDefinition[],
  chapters: readonly ChapterRuntimeDefinition[],
): { region: RegionAccess; entrances: readonly { id: string; unlocked: boolean; reason: string | null }[] } {
  const projection = projectionOf(snapshot);
  const target = regions.find((region) => region.id === regionId);
  const source = regions.find((region) => region.id === projection.regionId);
  // The authored pairing is the traversal event, exactly as `advanceChapter` pairs an exit with its entrance.
  const routes = (source?.exits ?? [])
    .filter((route) => route.destinationRegionId === regionId)
    .map((route) => {
      const entrance = target?.entrances.find(
        (item) => item.traversalEvent === route.traversalEvent && item.destinationRegionId === regionId,
      );
      const discovered = (!route.unlockFact || projection.worldFacts[route.unlockFact] === true) &&
        (!entrance?.unlockFact || projection.worldFacts[entrance.unlockFact] === true);
      return { id: entrance?.id ?? route.id, discovered };
    });
  const destinationChapter = destinationChapterFor(projection, regionId, chapters);
  const gate = travelGateOf({
    projection,
    destinationRegionId: regionId,
    destinationChapter,
    routeDiscovered: routes.some((route) => route.discovered),
    refugeOpen: projection.worldFacts.refugeOpen === true,
  });
  if (projection.regionId === regionId) {
    return {
      region: { unlocked: true, reason: null },
      entrances: routes.map((route) => ({
        id: route.id,
        unlocked: route.discovered,
        reason: route.discovered ? null : ROUTE_NOT_DISCOVERED,
      })),
    };
  }
  const open = routes.some((route) => route.discovered);
  return {
    region: gate.allowed && open
      ? { unlocked: true, reason: null }
      : gate.allowed
        ? REGION_ROUTE_LOCKED
        : { unlocked: false, reason: gate.reason },
    entrances: routes.map((route) => ({
      id: route.id,
      unlocked: route.discovered && gate.allowed,
      reason: route.discovered ? gate.reason : ROUTE_NOT_DISCOVERED,
    })),
  };
}

