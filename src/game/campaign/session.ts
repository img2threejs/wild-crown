import { migrateWorldV1 } from "../../../packages/campaign/src/index.js";
import { isRecord } from "../guards.js";
import { migrateCompanionParty } from "../companions/CompanionLoadout.js";
import { REGIONS } from "../../content/world.js";
import type {
  AssetPolicy,
  CampaignProgressCheckpoint,
  CampaignSafeCheckpoint,
  CampaignSafeSpawn,
  ChapterResumeState,
  ChapterRuntimeDefinition,
  ChapterSegmentId,
  ChapterSessionMetadata,
  LayoutRevisionMigration,
  RegionId,
  SaveScope,
  WorldEvent,
} from "../contracts.js";
import { assetPolicyForScope } from "../contracts.js";
import { DEFAULT_HERO_ID, isHeroId } from "../heroes.js";
import { pendingPactChoice } from "./authority.js";
import { resolveSafeNode } from "./safeSpawn.js";

/** Stable per-run autosave slot written in the same transaction as each committed event. */
export const AUTOSAVE_SLOT_PREFIX = "autosave:";
export const autosaveSlotId = (runId: string): string => AUTOSAVE_SLOT_PREFIX + runId;
export const isAutosaveSlotId = (slotId: string): boolean => slotId.startsWith(AUTOSAVE_SLOT_PREFIX);

export const SEGMENT_IDS: readonly ChapterSegmentId[] = [
  "prologue",
  "greenwake",
  "canopy",
  "bamboo",
  "grove",
  "moonpine",
  "mistveil",
  "sunmane",
  "grove-fall",
  "refuge",
  "return-canopy",
  "return-bamboo",
  "return-moonpine",
  "return-mistveil",
  "return-sunmane",
  "hollow",
];
/** Layout revision of every authored region before layout revisions existed (schema-1 saves). */
export const LEGACY_LAYOUT_REVISION = 0;

/** A content/format problem found while migrating or validating persisted session data. */
export class ChapterMigrationError extends Error {
  constructor(readonly code: "layout-revision" | "invalid-schema" | "corrupt", message: string) {
    super(message);
    this.name = "ChapterMigrationError";
  }
}

export interface MigrationContext {
  scope: SaveScope;
  chapters: readonly ChapterRuntimeDefinition[];
  layoutMigrations: readonly LayoutRevisionMigration[];
  /** Hero to stamp on a schema-1 record; schema-1 had no hero, so the default is Aren unless a live run knows better. */
  heroId?: ChapterSessionMetadata["heroId"];
}

/**
 * The story segment follows durable objective and dialogue progress. Greenwake begins after the Sky memory,
 * before the prologue quest's boar encounter; chapters 3–8 are each a region-bound segment with the Fall of the Grove,
 * Refuge-hosted return journeys and Heartroot Hollow remaining distinct authored segments.
 */
export function deriveSegmentId(
  chapter: number,
  regionId: RegionId,
  completedQuestIds: readonly string[],
  completedObjectiveIds: readonly string[],
  completedBeatIds: readonly string[],
): ChapterSegmentId | null {
  if (chapter >= 7 && regionId === "refuge") return "refuge";
  if (chapter === 8 && regionId === "heartroot-hollow") return "hollow";
  if (regionId === "the-grove") return chapter >= 6 ? "grove-fall" : "grove";
  if (regionId === "whispering-canopy") {
    return chapter >= 7 ? "return-canopy" : "canopy";
  }
  if (regionId === "blood-bamboo-valley") {
    return chapter >= 7 ? "return-bamboo" : "bamboo";
  }
  if (regionId === "moonpine-ridge") {
    return chapter >= 7 ? "return-moonpine" : "moonpine";
  }
  if (regionId === "mistveil-basin") {
    return chapter >= 7 ? "return-mistveil" : "mistveil";
  }
  if (regionId === "sunmane-expanse") {
    return chapter >= 7 ? "return-sunmane" : "sunmane";
  }
  if (regionId !== "greenwake") return null;
  if (chapter === 0) return completedQuestIds.includes("prologue") ||
    (completedObjectiveIds.includes("prologue:receive-sky") && completedBeatIds.includes("prologue-vision")) ? "greenwake" : "prologue";
  return "greenwake";
}

export function findSegmentDefinition(
  chapters: readonly ChapterRuntimeDefinition[],
  segmentId: ChapterSegmentId | null,
): ChapterRuntimeDefinition | undefined {
  return segmentId === null ? undefined : chapters.find((definition) => definition.segmentId === segmentId);
}

/** The arrival checkpoint of a segment: the one at the arrival node when given, otherwise the first whose facts hold. */
export function arrivalCheckpointId(
  definition: ChapterRuntimeDefinition | undefined,
  nodeId: string | undefined,
  facts: Readonly<Record<string, boolean | number | string>>,
): string | null {
  if (!definition) return null;
  const atNode = nodeId === undefined ? undefined : definition.checkpoints.find((item) => item.nodeId === nodeId && item.regionId === definition.regionId);
  const first = definition.checkpoints.find((item) => item.regionId === definition.regionId && item.requiresFacts.every((fact) => facts[fact] === true));
  return (atNode ?? first)?.id ?? null;
}

export interface ResumeInput {
  chapter: number;
  regionId: RegionId;
  completedQuestIds: readonly string[];
  completedObjectiveIds: readonly string[];
  chapters: readonly ChapterRuntimeDefinition[];
  facts: Readonly<Record<string, boolean | number | string>>;
  nodeId?: string;
  /** Overrides applied on top of a freshly derived resume state. */
  carry?: Partial<Pick<ChapterResumeState, "checkpointId" | "activeEncounterId" | "requiredBeatQueue" | "dialogue" | "completedBeatIds" | "pendingChoiceId">>;
}

export function createResumeState(input: ResumeInput): ChapterResumeState {
  const segmentId = deriveSegmentId(input.chapter, input.regionId, input.completedQuestIds, input.completedObjectiveIds, input.carry?.completedBeatIds ?? []);
  const definition = findSegmentDefinition(input.chapters, segmentId);
  return {
    segmentId,
    layoutRevision: definition?.layoutRevision ?? LEGACY_LAYOUT_REVISION,
    checkpointId: input.carry?.checkpointId !== undefined
      ? input.carry.checkpointId
      : arrivalCheckpointId(definition, input.nodeId, input.facts),
    activeEncounterId: input.carry?.activeEncounterId ?? null,
    requiredBeatQueue: [...(input.carry?.requiredBeatQueue ?? [])],
    dialogue: input.carry?.dialogue ? { ...input.carry.dialogue } : null,
    completedBeatIds: [...(input.carry?.completedBeatIds ?? [])],
    pendingChoiceId: input.carry?.pendingChoiceId ?? null,
  };
}

export function createSessionMetadata(
  saveScope: SaveScope,
  heroId: ChapterSessionMetadata["heroId"],
  resume: ChapterResumeState,
): ChapterSessionMetadata {
  return { saveScope, assetPolicy: assetPolicyForScope(saveScope), heroId, resume };
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

/** Structural validation of persisted session metadata (content-independent). */
export function isChapterSessionMetadata(value: unknown): value is ChapterSessionMetadata {
  if (!isRecord(value) || !isRecord(value.resume)) return false;
  const resume = value.resume;
  const dialogue = resume.dialogue;
  const scopeOk = value.saveScope === "production" || value.saveScope === "candidate-chapters";
  const assetOk = value.assetPolicy === "verified" || value.assetPolicy === "candidate";
  if (!scopeOk || !assetOk || assetPolicyForScope(value.saveScope as SaveScope) !== (value.assetPolicy as AssetPolicy)) return false;
  return isHeroId(value.heroId)
    && (resume.segmentId === null || SEGMENT_IDS.includes(resume.segmentId as ChapterSegmentId))
    && typeof resume.layoutRevision === "number" && Number.isInteger(resume.layoutRevision) && resume.layoutRevision >= 0
    && (resume.checkpointId === null || (typeof resume.checkpointId === "string" && resume.checkpointId.length > 0))
    && (resume.activeEncounterId === null || (typeof resume.activeEncounterId === "string" && resume.activeEncounterId.length > 0))
    && isStringArray(resume.requiredBeatQueue) && new Set(resume.requiredBeatQueue).size === resume.requiredBeatQueue.length
    && isStringArray(resume.completedBeatIds) && new Set(resume.completedBeatIds).size === resume.completedBeatIds.length
    && (dialogue === null || (isRecord(dialogue) && typeof dialogue.beatId === "string" && dialogue.beatId.length > 0
      && typeof dialogue.lineIndex === "number" && Number.isInteger(dialogue.lineIndex) && dialogue.lineIndex >= 0))
    && (resume.pendingChoiceId === null || (typeof resume.pendingChoiceId === "string" && resume.pendingChoiceId.length > 0));
}

/**
 * Cross-checks persisted resume state against the authored chapter definitions. Returns a problem description or null.
 * A segment without a definition (later acts, partial content) has nothing to cross-check; a segment with one must
 * agree on the layout revision, checkpoint and region.
 */
export function sessionContentProblem(
  session: ChapterSessionMetadata,
  regionId: RegionId,
  chapters: readonly ChapterRuntimeDefinition[],
): string | null {
  const resume = session.resume;
  const definition = findSegmentDefinition(chapters, resume.segmentId);
  if (!definition) {
    return resume.checkpointId !== null || resume.activeEncounterId !== null
      ? "A checkpoint or active encounter requires an authored segment definition."
      : null;
  }
  if (definition.regionId !== regionId) return "The chapter segment does not belong to the saved region.";
  if (resume.layoutRevision !== definition.layoutRevision) return "The save uses a different layout revision than the installed content.";
  if (resume.checkpointId !== null) {
    const checkpoint = definition.checkpoints.find((item) => item.id === resume.checkpointId);
    if (!checkpoint || checkpoint.regionId !== regionId) return "The saved checkpoint is not defined for this region.";
  }
  if (resume.activeEncounterId !== null && !definition.encounterEntries.some((entry) => entry.encounterId === resume.activeEncounterId)) {
    return "The saved active encounter is not defined for this segment.";
  }
  return null;
}

type FactMap = Readonly<Record<string, boolean | number | string>>;
interface SpawnCarrier { regionId: RegionId; safeSpawn?: CampaignSafeSpawn; worldFacts: FactMap; session: ChapterSessionMetadata }

/**
 * Applies explicit layout-revision migrations to a safe spawn and its checkpoint id. Old ids survive only when the node
 * is unchanged and still safe; otherwise the step's nodeMap or authored fallback applies. A missing migration step or an
 * unsafe result fails; a player position is never guessed.
 */
export function migrateLayout<T extends SpawnCarrier>(carrier: T, chapters: readonly ChapterRuntimeDefinition[], migrations: readonly LayoutRevisionMigration[]): T {
  const resume = carrier.session.resume;
  const definition = findSegmentDefinition(chapters, resume.segmentId);
  if (!definition || definition.regionId !== carrier.regionId) return carrier;
  const from = resume.layoutRevision;
  const target = definition.layoutRevision;
  if (from === target) return carrier;
  if (from > target) throw new ChapterMigrationError("layout-revision", `Layout revision ${from} is newer than the installed revision ${target}.`);
  const region = REGIONS.find((item) => item.id === carrier.regionId);
  if (!region) throw new ChapterMigrationError("corrupt", "The saved region does not exist.");
  let revision = from;
  let nodeId = carrier.safeSpawn?.routeId;
  let fallback: string | undefined;
  while (revision < target) {
    const step = migrations.find((item) => item.regionId === carrier.regionId && item.fromRevision === revision);
    if (!step || step.toRevision <= revision || step.toRevision > target) {
      throw new ChapterMigrationError("layout-revision", `No layout migration from revision ${revision} to ${target} for ${carrier.regionId}.`);
    }
    if (nodeId !== undefined) nodeId = step.nodeMap[nodeId] ?? nodeId;
    fallback = step.fallbackNodeId;
    revision = step.toRevision;
  }
  let safeSpawn: CampaignSafeSpawn | undefined;
  if (carrier.safeSpawn !== undefined) {
    const preferred = carrier.safeSpawn.cameraAnchorId;
    const resolved = (nodeId === undefined ? null : resolveSafeNode(region, nodeId, carrier.worldFacts, preferred))
      ?? (fallback === undefined ? null : resolveSafeNode(region, fallback, carrier.worldFacts, preferred));
    if (!resolved) throw new ChapterMigrationError("layout-revision", "No safe node exists in the revised layout for the saved spawn.");
    safeSpawn = resolved;
  }
  const checkpointKept = resume.checkpointId !== null && definition.checkpoints.some((item) => item.id === resume.checkpointId);
  const checkpointId = checkpointKept ? resume.checkpointId : arrivalCheckpointId(definition, safeSpawn?.routeId, carrier.worldFacts);
  const encounterKept = resume.activeEncounterId !== null && definition.encounterEntries.some((entry) => entry.encounterId === resume.activeEncounterId);
  const migrated: ChapterSessionMetadata = {
    ...carrier.session,
    resume: { ...resume, layoutRevision: target, checkpointId, activeEncounterId: encounterKept ? resume.activeEncounterId : null },
  };
  return { ...carrier, ...(safeSpawn ? { safeSpawn } : {}), session: migrated };
}

/** Schema-1 progress had no session: derive one conservatively (production-by-default scope, Aren, safe-boundary resume). */
export function deriveLegacySession(
  raw: Record<string, unknown>,
  context: MigrationContext,
): ChapterSessionMetadata | null {
  const chapter = raw.chapter;
  const regionId = raw.regionId;
  const completed = raw.completedQuestIds;
  const choices = raw.choices;
  const eventLog = raw.eventLog;
  const facts = raw.worldFacts;
  if (typeof chapter !== "number" || typeof regionId !== "string" || !isStringArray(completed) || !isRecord(facts)
    || !isRecord(choices) || !Array.isArray(eventLog)) return null;
  const spawn = raw.safeSpawn;
  const nodeId = isRecord(spawn) && typeof spawn.routeId === "string" ? spawn.routeId : undefined;
  const base = createResumeState({
    chapter, regionId: regionId as RegionId, completedQuestIds: completed, chapters: context.chapters,
    completedObjectiveIds: isStringArray(raw.completedObjectiveIds) ? raw.completedObjectiveIds : [],
    facts: facts as FactMap, ...(nodeId === undefined ? {} : { nodeId }),
    carry: { pendingChoiceId: pendingPactChoice(eventLog as WorldEvent[], choices as Record<string, string>) },
  });
  // Legacy records predate layout revisions: they always carry revision 0 so an authored migration is required to move them.
  const resume: ChapterResumeState = { ...base, layoutRevision: LEGACY_LAYOUT_REVISION };
  return createSessionMetadata(context.scope, context.heroId ?? DEFAULT_HERO_ID, resume);
}

/** Adds the derived session to a schema-1 progress object (never touches an object that already has one). */
export function withLegacySession<T extends Record<string, unknown>>(raw: T, context: MigrationContext): T & { session?: ChapterSessionMetadata } {
  if (raw.session !== undefined) return raw;
  const session = deriveLegacySession(raw, context);
  return session ? { ...raw, session } : raw;
}

/** Application safe checkpoints 1/2 → 3; the campaign package's world format remains version 2. */
export function migrateSafeCheckpoint(
  input: unknown,
  context: MigrationContext,
): CampaignSafeCheckpoint | "future" | null {
  if (!isRecord(input) || input.kind !== "campaign-safe-checkpoint" || typeof input.schemaVersion !== "number") return null;
  if (input.schemaVersion > 3) return "future";
  if (input.schemaVersion === 3) return input as unknown as CampaignSafeCheckpoint;
  if (![1, 2].includes(input.schemaVersion) || !isRecord(input.progress) || !isRecord(input.worldCheckpoint) || !isRecord(input.safeSpawn)) return null;
  const party = migrateCompanionParty(input.progress.party);
  if (!party) return null;
  if (input.schemaVersion === 2) return {
    ...(input as unknown as CampaignSafeCheckpoint), schemaVersion: 3,
    progress: { ...(input.progress as unknown as CampaignProgressCheckpoint), party },
  };
  const world = migrateWorldV1(input.worldCheckpoint.world, []);
  if (!world || typeof input.worldCheckpoint.runId !== "string") return null;
  const progress = withLegacySession(
    { ...input.progress, safeSpawn: input.safeSpawn, regionId: input.progress.regionId },
    context,
  );
  const session = progress.session;
  if (!session) return null;
  const { safeSpawn: _discard, ...progressFields } = progress;
  const migrated = migrateLayout(
    { regionId: input.progress.regionId as RegionId, safeSpawn: input.safeSpawn as unknown as CampaignSafeSpawn, worldFacts: input.progress.worldFacts as FactMap, session },
    context.chapters,
    context.layoutMigrations,
  );
  return {
    ...(input as unknown as CampaignSafeCheckpoint),
    schemaVersion: 3,
    worldCheckpoint: { ...(input.worldCheckpoint as unknown as CampaignSafeCheckpoint["worldCheckpoint"]), schemaVersion: 2, world },
    progress: { ...(progressFields as unknown as CampaignProgressCheckpoint), party, session: migrated.session },
    safeSpawn: migrated.safeSpawn!,
  };
}
