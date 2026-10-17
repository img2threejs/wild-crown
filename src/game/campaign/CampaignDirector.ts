import {
  awardCompanionBond,
  createCheckpoint,
  createNewRun,
  createShowcaseReplay,
  collectFragment,
  FRAGMENT_IDS,
  evaluateEnding,
  importCheckpoint,
  recordLeaderDominion,
  recruitCompanion,
  REGION_IDS,
  REGIONAL_OBLIGATION_IDS,
  RESPECTFUL_PACT_BOND,
  setCompanionStoryFlag,
  setCrownCouncilRepresentation,
  setPackLeader,
  type CampaignState,
  type CheckpointSnapshot,
  type FactionId,
  type LeaderId,
  type RegionId as CanonRegionId,
  type RestorationState,
} from "../../../packages/campaign/src/index.js";
import type {
  CampaignDirectorAPI,
  CampaignProgressCheckpoint,
  CampaignSafeCheckpoint,
  CampaignSafeSpawn,
  CampaignSnapshot,
  ChapterCheckpointDefinition,
  ChapterResumeState,
  ChapterRuntimeDefinition,
  ChapterSegmentId,
  ChapterSessionMetadata,
  ChoiceDefinition,
  CompanionId,
  CompanionRelationshipRule,
  DialogueBeat,
  LayoutRevisionMigration,
  ObjectiveId,
  QuestId,
  RegionId,
  SaveScope,
  WorldEvent,
} from "../contracts.js";
import {
  CAMPAIGN_CHOICES,
  CANONICAL_RESTORATION_FACT_IDS,
  INTERACTIONS,
  QUESTS,
  REGIONS,
  RESTORATION_PARTIAL_FACT_ID,
  RESTORATION_RESTORED_FACT_ID,
  RESTORATION_STATE_FACT_ID,
  RESTORATION_RANK,
  emptyWorldFacts,
  restorationStateFromFacts,
} from "../../content/campaign.js";
import { CHAPTERS, STORY_DIALOGUE } from "../../content/story.js";
import { isCueBeatAuthored, NARRATIVE_CUES } from "../../content/narrative-cues.js";
import { HUB_REGION_IDS, HUB_UPGRADES } from "../../content/hub.js";
import { DEFAULT_HERO_ID, isHeroId, type HeroId } from "../heroes.js";
import { DEFAULT_HERO_COMPANIONS, isCompanionId, isCompanionParty } from "../companions/CompanionLoadout.js";
import {
  SaveRepository,
  SaveRepositoryError,
  type CampaignProgressRecord,
} from "../storage/SaveRepository.js";
import { PACT_OPTION_IDS, pactForChoice, pendingPactChoice, RECRUITMENT_RULES } from "./authority.js";
import { eventMatches } from "./events.js";
import { hasSafeWalkSurface, liesOnSurface, resolveSafeNode, samePosition } from "./safeSpawn.js";
import {
  arrivalCheckpointId,
  createResumeState,
  createSessionMetadata,
  deriveSegmentId,
  findSegmentDefinition,
  isChapterSessionMetadata,
  migrateSafeCheckpoint,
  sessionContentProblem,
} from "./session.js";

import { BOSS_ENCOUNTERS, WILDLIFE_ENCOUNTERS } from "../combat/content.js";

const ENCOUNTER_DEFINITIONS = [...Object.values(BOSS_ENCOUNTERS), ...Object.values(WILDLIFE_ENCOUNTERS)];

export interface CampaignDirectorOptions {
  saves?: SaveRepository;
  runId?: string;
  /** Persistence scope; must equal `saves.scope` when a repository is supplied. Defaults to the repository's scope, else production. */
  saveScope?: SaveScope;
  /** Authored chapter runtime definitions (checkpoints, encounter entries, exit requirements); defaults to the repository's. */
  chapters?: readonly ChapterRuntimeDefinition[];
  /** Explicit old-layout → new-layout safe-spawn mappings; defaults to the repository's. */
  layoutMigrations?: readonly LayoutRevisionMigration[];
  /** Authored one-shot Bond/recruitment awards keyed to accepted events. */
  relationshipRules?: readonly CompanionRelationshipRule[];
  /** Choice presentation catalog; defaults to the authored campaign choices. Pact option ids are fixed by the Director. */
  choices?: Readonly<Record<string, readonly ChoiceDefinition[]>>;
}

/** An authored choice is permanently invalid, not a failed durable write to retry. */
export class CampaignChoiceRejectedError extends Error {
  constructor(
    readonly choiceId: string,
    readonly optionId: string,
    message: string,
  ) {
    super(message);
    this.name = "CampaignChoiceRejectedError";
  }
}

const REGION_CHAPTER: Partial<Record<RegionId, number>> = {
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
/** Regions a replay-isolated showcase (local playtest map) can start in directly, with the story state that region expects. */
export type ShowcaseRegionId = "whispering-canopy" | "the-grove" | "moonpine-ridge" | "mistveil-basin";
const SHOWCASE_STARTS: Readonly<Record<ShowcaseRegionId, { readonly chapter: number; readonly questIds: readonly string[]; readonly provisionalKoro: boolean }>> = {
  "whispering-canopy": { chapter: 1, questIds: ["fallen-scout", "thief-in-the-branches"], provisionalKoro: true },
  // The early sanctuary opens once the Canopy accord is struck (Vara and Koro have arrived), before Blood Bamboo Valley.
  "the-grove": { chapter: 1, questIds: [], provisionalKoro: false },
  "moonpine-ridge": { chapter: 3, questIds: ["the-third-howl", "two-packs"], provisionalKoro: false },
  "mistveil-basin": { chapter: 4, questIds: ["eyes-in-the-mist", "the-black-river"], provisionalKoro: false },
};
const LEADER_IDS: readonly LeaderId[] = [
  "koro",
  "asha",
  "ruun",
  "luma",
  "nyra",
  "solkar",
];

type StoryResume = Pick<
  ChapterResumeState,
  "checkpointId" | "activeEncounterId" | "requiredBeatQueue" | "dialogue" | "completedBeatIds" | "pendingChoiceId"
>;
const emptyStory = (): StoryResume => ({
  checkpointId: null,
  activeEncounterId: null,
  requiredBeatQueue: [],
  dialogue: null,
  completedBeatIds: [],
  pendingChoiceId: null,
});
const cloneStory = (story: StoryResume): StoryResume => ({
  ...story,
  requiredBeatQueue: [...story.requiredBeatQueue],
  dialogue: story.dialogue ? { ...story.dialogue } : null,
  completedBeatIds: [...story.completedBeatIds],
});
/** Extracts the Director-owned resume fields; segment and layout revision are derived from progress and content. */
const storyFromResume = (resume: ChapterResumeState): StoryResume => cloneStory({
  checkpointId: resume.checkpointId,
  activeEncounterId: resume.activeEncounterId,
  requiredBeatQueue: resume.requiredBeatQueue,
  dialogue: resume.dialogue,
  completedBeatIds: resume.completedBeatIds,
  pendingChoiceId: resume.pendingChoiceId,
});

/** A queued operation was discarded because a new run replaced the journey it was issued for. */
export class CampaignSupersededError extends Error {
  constructor() {
    super("The journey changed before this operation ran.");
    this.name = "CampaignSupersededError";
  }
}

const createId = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  "run-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);

function isCampaignEventHistory(value: unknown): boolean {
  return Array.isArray(value) && value.every((event) => {
    if (typeof event !== "object" || event === null || Array.isArray(event))
      return false;
    const entry = event as Record<string, unknown>;
    if (
      typeof entry.type !== "string" ||
      typeof entry.idempotencyKey !== "string"
    ) return false;
    if (entry.type !== "choice") return true;
    return (
      ["eventId", "idempotencyKey", "choiceId", "optionId"].every(
        (field) => typeof entry[field] === "string" &&
          (entry[field] as string).trim().length > 0,
      ) &&
      (entry.leaderId === undefined || typeof entry.leaderId === "string") &&
      (entry.dominion === undefined || typeof entry.dominion === "boolean")
    );
  });
}

function validateLoadedHistory(progress: CampaignProgressRecord | null): void {
  if (progress && !isCampaignEventHistory(progress.eventLog))
    throw new SaveRepositoryError("corrupt", "Campaign choice history is malformed.");
}

function isCampaignSafeCheckpoint(
  value: unknown,
): value is CampaignSafeCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  const progress = data.progress as Record<string, unknown> | null;
  const spawn = data.safeSpawn as Record<string, unknown> | null;
  const reset = data.encounterReset as Record<string, unknown> | null;
  if (
    data.kind !== "campaign-safe-checkpoint" ||
    data.schemaVersion !== 3 ||
    typeof data.runId !== "string" ||
    typeof data.checkpointId !== "string" ||
    !progress ||
    !spawn ||
    !reset
  )
    return false;
  return (
    Number.isInteger(progress.chapter) &&
    isCompanionParty(progress.party) &&
    typeof progress.regionId === "string" &&
    Array.isArray(progress.activeQuestIds) &&
    progress.activeQuestIds.every((id) => typeof id === "string") &&
    Array.isArray(progress.completedQuestIds) &&
    progress.completedQuestIds.every((id) => typeof id === "string") &&
    Array.isArray(progress.completedObjectiveIds) &&
    progress.completedObjectiveIds.every((id) => typeof id === "string") &&
    isCampaignEventHistory(progress.eventLog) &&
    Array.isArray(progress.eventKeys) &&
    progress.eventKeys.every((key) => typeof key === "string") &&
    Number.isInteger(progress.revision) &&
    isChapterSessionMetadata(progress.session) &&
    typeof spawn.regionId === "string" &&
    typeof spawn.routeId === "string" &&
    typeof spawn.cameraAnchorId === "string" &&
    typeof spawn.position === "object" &&
    typeof reset.policy === "string" &&
    (reset.encounterId === null || typeof reset.encounterId === "string") &&
    Array.isArray(reset.actorIds) &&
    reset.actorIds.every((id) => typeof id === "string")
  );
}

function factsWithMovableObjectDefaults(
  facts: Readonly<Record<string, boolean | number | string>>,
): Record<string, boolean | number | string> {
  const restored = { ...facts };
  for (const region of REGIONS) {
    for (const object of region.movableObjects) {
      if (restored[object.movedFactId] === undefined) restored[object.movedFactId] = false;
    }
  }
  return restored;
}

function factsWithRestorationDefaults(
  facts: Readonly<Record<string, boolean | number | string>>,
): Record<string, boolean | number | string> {
  const restored = factsWithMovableObjectDefaults(facts);
  for (const region of REGIONS) {
    const stateId = RESTORATION_STATE_FACT_ID(region.id);
    const partialId = RESTORATION_PARTIAL_FACT_ID(region.id);
    const restoredId = RESTORATION_RESTORED_FACT_ID(region.id);
    if (restored[stateId] === undefined) {
      // Legacy local-state migration: when a noncanonical region lacks the
      // explicit state fact, derive it from the persisted partial/restored
      // booleans BEFORE defaulting to "unvisited". An explicit valid state
      // fact already written by a newer envelope remains authoritative.
      const isNoncanonical = !REGION_IDS.includes(region.id as CanonRegionId);
      if (isNoncanonical && restored[restoredId] === true) {
        restored[stateId] = "restored";
      } else if (isNoncanonical && restored[partialId] === true) {
        restored[stateId] = "partial";
      } else {
        restored[stateId] = "unvisited";
      }
    }
    if (restored[partialId] === undefined) restored[partialId] = false;
    if (restored[restoredId] === undefined) restored[restoredId] = false;
  }
  return restored;
}

/**
 * Resolves the effective restoration state for any authored region. Canonical
 * regions always come from `campaign.world.regions`; noncanonical regions read
 * the persisted local fact (and fall back to booleans for legacy envelopes).
 */
function effectiveRestorationState(
  campaign: CampaignState,
  facts: Readonly<Record<string, boolean | number | string>>,
  region: RegionId,
): RestorationState {
  if (REGION_IDS.includes(region as CanonRegionId)) {
    return campaign.world.regions[region as CanonRegionId];
  }
  return restorationStateFromFacts(facts, region);
}

function applyRestorationBooleans(
  facts: Record<string, boolean | number | string>,
  region: RegionId,
  state: RestorationState,
): void {
  facts[RESTORATION_STATE_FACT_ID(region)] = state;
  facts[RESTORATION_PARTIAL_FACT_ID(region)] = state === "partial";
  facts[RESTORATION_RESTORED_FACT_ID(region)] = state === "restored";
}

/**
 * Reconciles canonical restoration facts and local-region booleans against
 * `campaign.world.regions`. Canonical regions are authoritative; noncanonical
 * regions keep the persisted state fact (or fall back to "unvisited" for
 * legacy envelopes that only carry booleans). The supplied owned facts map
 * is mutated in place; callers should already own it.
 */
function normalizeRestorationFacts(
  campaign: CampaignState,
  facts: Record<string, boolean | number | string>,
): void {
  for (const regionId of REGION_IDS) {
    const canonical = campaign.world.regions[regionId];
    facts[RESTORATION_STATE_FACT_ID(regionId)] = canonical;
    facts[RESTORATION_PARTIAL_FACT_ID(regionId)] = canonical === "partial";
    facts[RESTORATION_RESTORED_FACT_ID(regionId)] = canonical === "restored";
    facts[CANONICAL_RESTORATION_FACT_IDS[regionId]] = canonical === "restored";
  }
  for (const region of REGIONS) {
    if (REGION_IDS.includes(region.id as CanonRegionId)) continue;
    const state = restorationStateFromFacts(facts, region.id);
    facts[RESTORATION_STATE_FACT_ID(region.id)] = state;
    facts[RESTORATION_PARTIAL_FACT_ID(region.id)] = state === "partial";
    facts[RESTORATION_RESTORED_FACT_ID(region.id)] = state === "restored";
  }
}

interface QuestMarks {
  active: string[];
  completedQuests: string[];
  completedObjectives: string[];
}
interface DirectorRollbackState {
  campaign: CampaignState;
  region: RegionId;
  chapter: number;
  facts: Record<string, boolean | number | string>;
  choices: Record<string, string>;
  activeQuestIds: string[];
  completedQuestIds: string[];
  completedObjectiveIds: string[];
  trackedObjectiveId: ObjectiveId | null;
  party: CampaignSnapshot["party"];
  endingId: CampaignSnapshot["ending"];
  checkpoint: CheckpointSnapshot | null;
  lastSafeCheckpoint: CampaignSafeCheckpoint | null;
  safeSpawn: CampaignSafeSpawn;
  recoveryRequest: CampaignSnapshot["recoveryRequest"];
  lastEvent: WorldEvent | null;
  eventKeys: Set<string>;
  eventLog: WorldEvent[];
  revision: number;
  story: StoryResume;
}
export class CampaignDirector implements CampaignDirectorAPI {
  private campaign!: CampaignState;
  private runId = "";
  private heroId: HeroId = DEFAULT_HERO_ID;
  private region: RegionId = "greenwake";
  private chapter = 0;
  private replay = false;
  private revision = 0;
  private facts: Record<string, boolean | number | string> = {};
  private choices: Record<string, string> = {};
  private activeQuestIds: string[] = [];
  private completedQuestIds: string[] = [];
  private completedObjectiveIds: string[] = [];
  private trackedObjectiveId: ObjectiveId | null = null;
  private recoveryRequest: CampaignSnapshot["recoveryRequest"] = null;
  private lastEvent: WorldEvent | null = null;
  private party: CampaignSnapshot["party"] = {};
  private endingId: CampaignSnapshot["ending"] = null;
  private checkpoint: CheckpointSnapshot | null = null;
  private lastSafeCheckpoint: CampaignSafeCheckpoint | null = null;
  private safeSpawn!: CampaignSafeSpawn;
  private story: StoryResume = emptyStory();
  /** Incremented when a new run/showcase supersedes the journey, so queued operations never touch the new run. */
  private epoch = 0;
  private eventQueue: Promise<void> = Promise.resolve();
  private eventKeys = new Set<string>();
  private eventLog: WorldEvent[] = [];
  private listeners = new Set<(snapshot: CampaignSnapshot) => void>();
  private readonly saves?: SaveRepository;
  private readonly scope: SaveScope;
  private readonly chapters: readonly ChapterRuntimeDefinition[];
  private readonly layoutMigrations: readonly LayoutRevisionMigration[];
  private readonly relationshipRules: readonly CompanionRelationshipRule[];
  private readonly choiceCatalog: Readonly<Record<string, readonly ChoiceDefinition[]>>;
  constructor(options: CampaignDirectorOptions = {}) {
    this.saves = options.saves;
    const scope = options.saveScope ?? options.saves?.scope ?? "production";
    if (options.saves && options.saves.scope !== scope) {
      throw new Error("The save repository scope does not match the Director's save scope.");
    }
    this.scope = scope;
    // The repository validates every persisted checkpoint against the same definitions, so it is the single source of truth.
    if (options.saves && ((options.chapters !== undefined && options.chapters !== options.saves.chapters) ||
      (options.layoutMigrations !== undefined && options.layoutMigrations !== options.saves.layoutMigrations))) {
      throw new Error("Configure chapter definitions and layout migrations on the SaveRepository; the Director reads them from it.");
    }
    this.chapters = options.saves?.chapters ?? options.chapters ?? [];
    this.layoutMigrations = options.saves?.layoutMigrations ?? options.layoutMigrations ?? [];
    this.relationshipRules = options.relationshipRules ?? [];
    this.choiceCatalog = options.choices ?? CAMPAIGN_CHOICES;
    this.resetRun(options.runId ?? createId(), DEFAULT_HERO_ID);
  }

  private resetRun(runId: string, heroId: HeroId, companionId = DEFAULT_HERO_COMPANIONS[heroId]): void {
    if (!isHeroId(heroId) || !isCompanionId(companionId)) throw new Error("Unknown hero or companion.");
    this.epoch += 1;
    this.runId = runId;
    this.heroId = heroId;
    this.campaign = createNewRun(runId);
    this.region = "greenwake";
    this.chapter = 0;
    this.replay = false;
    this.revision = 0;
    this.facts = emptyWorldFacts(this.campaign);
    this.facts.prologueStarted = true;
    this.choices = {};
    this.activeQuestIds = ["prologue"];
    this.completedQuestIds = [];
    this.completedObjectiveIds = [];
    this.trackedObjectiveId = null;
    this.recoveryRequest = null;
    this.lastEvent = null;
    this.party = { companionId };
    this.endingId = null;
    this.eventKeys = new Set();
    this.eventLog = [];
    this.story = emptyStory();
    this.checkpoint = createCheckpoint(this.campaign);
    this.safeSpawn = this.safeSpawnFor("greenwake");
    this.enqueueActivationCues(this.activeQuestIds);
    this.normalizeStory();
    this.lastSafeCheckpoint = this.createSafeCheckpoint();
  }

  startChapterRun(input: { runId: string; heroId: HeroId; companionId?: CompanionId; saveScope: SaveScope }): CampaignSnapshot {
    if (input.saveScope !== this.scope) throw new Error("The run's save scope must match the Director's repository scope.");
    if (!isHeroId(input.heroId)) throw new Error("Unknown hero.");
    this.resetRun(input.runId, input.heroId, input.companionId);
    return this.publish();
  }

  startNewRun(runId = createId(), heroId: HeroId = DEFAULT_HERO_ID, companionId = DEFAULT_HERO_COMPANIONS[heroId]): CampaignSnapshot {
    this.resetRun(runId, heroId, companionId);
    return this.publish();
  }

  startShowcase(runId = "showcase-" + createId(), regionId: ShowcaseRegionId = "whispering-canopy", loadout?: { heroId: HeroId; companionId: CompanionId }): CampaignSnapshot {
    const heroId = loadout?.heroId ?? DEFAULT_HERO_ID;
    const companionId = loadout?.companionId ?? DEFAULT_HERO_COMPANIONS[heroId];
    if (!isHeroId(heroId) || !isCompanionId(companionId)) throw new Error("Unknown hero or companion.");
    const showcase = SHOWCASE_STARTS[regionId];
    const replayState = createShowcaseReplay();
    this.epoch += 1;
    this.runId = runId;
    this.heroId = heroId;
    this.campaign = recruitCompanion(
      recruitCompanion({ ...createNewRun(runId), world: replayState.world }, "vara"),
      "koro",
    );
    this.region = regionId;
    this.chapter = showcase.chapter;
    this.replay = true;
    this.revision = 0;
    this.facts = emptyWorldFacts(this.campaign);
    if (showcase.provisionalKoro) this.facts.provisionalKoro = true;
    this.activeQuestIds = [...showcase.questIds];
    this.completedQuestIds = [];
    this.completedObjectiveIds = [];
    this.trackedObjectiveId = null;
    this.recoveryRequest = null;
    this.lastEvent = null;
    this.party = { companionId };
    this.endingId = null;
    this.eventKeys = new Set();
    this.eventLog = [];
    this.story = emptyStory();
    this.checkpoint = createCheckpoint(this.campaign);
    this.safeSpawn = this.safeSpawnFor(regionId);
    this.normalizeStory();
    this.lastSafeCheckpoint = this.createSafeCheckpoint();
    return this.publish();
  }

  snapshot(): CampaignSnapshot {
    return {
      lastEvent: this.lastEvent ? structuredClone(this.lastEvent) : null,
      recoveryRequest: this.recoveryRequest,
      trackedObjectiveId: this.trackedObjectiveId,
      schemaVersion: this.campaign.schemaVersion,
      runId: this.runId,
      replay: this.replay,
      chapter: this.chapter,
      chapterId: this.chapter === 0 ? "prologue" : "chapter-" + this.chapter,
      regionId: this.region,
      activeQuestIds: [...this.activeQuestIds] as never,
      completedQuestIds: [...this.completedQuestIds] as never,
      activeObjectiveIds: this.activeQuestIds.flatMap((id) =>
        this.objectivesFor(id)
          .filter(
            (objective) => !this.completedObjectiveIds.includes(objective.id),
          )
          .map((objective) => objective.id),
      ),
      completedObjectiveIds: [...this.completedObjectiveIds] as never,
      campaign: structuredClone(this.campaign),
      fragments: [...this.campaign.world.fragments],
      factions: structuredClone(this.campaign.world.factions),
      party: structuredClone(this.party),
      // `groveFallPending` is a derived availability fact, not an earned quest fact: chapter 6 is active and the Refuge
      // has not yet opened. Authoritative producers (UI prompts, encounter triggers) read this from the snapshot rather
      // than inferring it from chapter alone; the value mirrors `this.region === "the-grove" && this.chapter === 6 &&
      // this.facts.refugeOpen !== true` and resets to false as soon as the Fall completes.
      worldFacts: {
        ...structuredClone(this.facts),
        groveFallPending: this.chapter === 6 && this.region === "the-grove" && this.facts.refugeOpen !== true,
      },
      lastSafeCheckpoint: this.lastSafeCheckpoint
        ? structuredClone(this.lastSafeCheckpoint)
        : null,
      choices: structuredClone(this.choices),
      ending: this.endingId,
      endingEvaluation: evaluateEnding(this.campaign),
      revision: this.revision,
      session: this.sessionMetadata(),
      segmentId: deriveSegmentId(this.chapter, this.region, this.completedQuestIds, this.completedObjectiveIds, this.story.completedBeatIds),
      companions: structuredClone(this.campaign.world.companions),
    };
  }

  subscribe(listener: (snapshot: CampaignSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  /** Runs `operation` after every earlier write; a new run/showcase supersedes operations queued for the previous journey. */
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const epoch = this.epoch;
    const run = this.eventQueue.then(() => {
      if (epoch !== this.epoch) throw new CampaignSupersededError();
      return operation();
    });
    this.eventQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  processEvent(event: WorldEvent): Promise<CampaignSnapshot> {
    return this.serialize(() => this.applyBatch([event]));
  }

  /** Query the current accepted event ledger without copying checkpoint metadata. */
  isEventCommitted(idempotencyKey: string): boolean {
    return this.eventKeys.has(idempotencyKey);
  }

  committedEventKeys(): IterableIterator<string> {
    return this.eventKeys.values();
  }

  /** Persists the current committed progress to the run's autosave slot, serialized with event writes. */
  autosave(): Promise<void> {
    return this.serialize(() => this.persistAutosave());
  }

  /** The authored definition of the current story segment, or undefined outside authored chapters. */
  chapterDefinition(): ChapterRuntimeDefinition | undefined {
    return findSegmentDefinition(this.chapters, deriveSegmentId(this.chapter, this.region, this.completedQuestIds, this.completedObjectiveIds, this.story.completedBeatIds));
  }

  private async persistAutosave(): Promise<void> {
    if (!this.saves || this.replay) return;
    await this.saves.saveAutosave(
      createCheckpoint(this.campaign),
      this.campaign,
      this.chapter,
      this.region,
      [...this.eventKeys],
      this.progressRecord(),
    );
  }

  /**
   * One atomic write of slot + run ledger (a single IndexedDB transaction). A failure restores the previous in-memory
   * state and publishes nothing, so a failed durable write never awards progress.
   */
  private async commit(rollback: DirectorRollbackState, epoch: number): Promise<void> {
    try {
      await this.persistAutosave();
    } catch (error) {
      if (epoch === this.epoch) this.restoreRollbackState(rollback);
      if (error instanceof SaveRepositoryError) throw error;
      throw new SaveRepositoryError(
        "transaction",
        "The story progress could not be committed to the save.",
      );
    }
    if (epoch !== this.epoch) throw new CampaignSupersededError();
  }

  private assertCampaignRun(): void {
    if (this.replay) throw new Error("Replay runs have no chapter progression.");
  }

  private questMarks(): QuestMarks {
    return {
      active: [...this.activeQuestIds],
      completedQuests: [...this.completedQuestIds],
      completedObjectives: [...this.completedObjectiveIds],
    };
  }

  private enqueueBeat(beatId: string): void {
    if (!isCueBeatAuthored(beatId)) return;
    if (
      this.story.completedBeatIds.includes(beatId) ||
      this.story.requiredBeatQueue.includes(beatId) ||
      this.story.dialogue?.beatId === beatId
    ) return;
    this.story.requiredBeatQueue = [...this.story.requiredBeatQueue, beatId];
  }

  private enqueueActivationCues(questIds: readonly string[]): void {
    for (const questId of questIds) {
      const beat = NARRATIVE_CUES[questId]?.onActivate;
      if (beat) this.enqueueBeat(beat);
    }
  }

  /** Keeps checkpoint and active-encounter ids consistent with the segment derived from current progress. */
  private normalizeStory(): void {
    const definition = this.chapterDefinition();
    if (!definition) return;
    const known = this.story.checkpointId !== null &&
      definition.checkpoints.some((item) => item.id === this.story.checkpointId && item.regionId === this.region);
    if (!known) this.story.checkpointId = arrivalCheckpointId(definition, this.safeSpawn?.routeId, this.facts);
    if (
      this.story.activeEncounterId !== null &&
      !definition.encounterEntries.some((entry) => entry.encounterId === this.story.activeEncounterId)
    ) {
      this.story.activeEncounterId = null;
    }
  }

  private sessionMetadata(): ChapterSessionMetadata {
    return createSessionMetadata(this.scope, this.heroId, createResumeState({
      chapter: this.chapter,
      regionId: this.region,
      completedQuestIds: this.completedQuestIds,
      completedObjectiveIds: this.completedObjectiveIds,
      chapters: this.chapters,
      facts: this.facts,
      carry: cloneStory(this.story),
    }));
  }

  private encounterResolved(encounterId: string): boolean {
    return this.eventLog.some((event) =>
      event.type === "encounter-resolved" && event.encounterId === encounterId && event.resolution !== "escaped");
  }

  private isObjectiveActive(objectiveId: string): boolean {
    return this.activeQuestIds.some((questId) =>
      this.objectivesFor(questId).some((objective) => objective.id === objectiveId && !this.completedObjectiveIds.includes(objective.id)));
  }

  /** Exit requirement grammar: fact | quest:<id> | objective:<id> | choice:<id>[:<option>] | beat:<id>. */
  private requirementMet(requirement: string): boolean {
    const [kind, target, option] = requirement.split(":");
    switch (kind) {
      case "quest": return this.completedQuestIds.includes(target ?? "");
      case "objective": return this.completedObjectiveIds.includes(requirement.slice("objective:".length) as ObjectiveId);
      case "choice": return target !== undefined && this.choices[target] !== undefined && (option === undefined || this.choices[target] === option);
      case "beat": return this.story.completedBeatIds.includes(target ?? "");
      default: return this.facts[requirement] === true;
    }
  }

  /**
   * Recruitment and authored Bond awards are derived from the committed event log, never from presentation or producer tags.
   * Each rule applies once (recruitment is idempotent; relationship rules mark `relationship:<id>`).
   */
  private applyRelationshipAuthority(): void {
    let state = this.campaign;
    const matched = (requirement: string): boolean => this.eventLog.some((event) => eventMatches(requirement, event));
    for (const rule of RECRUITMENT_RULES) {
      if (!state.world.companions[rule.companionId].recruited && matched(rule.requiredEvent)) {
        state = recruitCompanion(state, rule.companionId);
      }
    }
    for (const rule of this.relationshipRules) {
      const key = "relationship:" + rule.id;
      if (this.facts[key] === true || !matched(rule.requiredEvent)) continue;
      if (rule.recruit) state = recruitCompanion(state, rule.companionId);
      if (rule.bond !== undefined) {
        if (!state.world.companions[rule.companionId].recruited) continue;
        state = awardCompanionBond(state, rule.companionId, rule.bond);
      }
      if (rule.storyFlag) state = setCompanionStoryFlag(state, rule.companionId, rule.storyFlag);
      this.facts[key] = true;
    }
    this.campaign = state;
  }

  private refreshSafeCheckpoint(): void {
    this.checkpoint = createCheckpoint(this.campaign);
    this.lastSafeCheckpoint = this.createSafeCheckpoint();
  }

  private async applyBatch(events: readonly WorldEvent[]): Promise<CampaignSnapshot> {
    for (const event of events) {
      if (!event.idempotencyKey.trim())
        throw new Error("World event requires a non-empty idempotencyKey.");
    }
    const rollback = this.rollbackState();
    const epoch = this.epoch;
    let applied: WorldEvent | null = null;
    try {
      for (const event of events) {
        if (
          event.type === "choice" &&
          this.validateChoice(event.choiceId, event.optionId, this.campaign)
        ) continue;
        if (this.eventKeys.has(event.idempotencyKey)) continue;
        this.reduceEvent(event);
        applied = event;
      }
    } catch (error) {
      this.restoreRollbackState(rollback);
      throw error;
    }
    if (!applied) return this.snapshot();
    await this.commit(rollback, epoch);
    this.lastEvent = structuredClone(applied);
    return this.publish();
  }

  reachCheckpoint(checkpointId: string): Promise<CampaignSnapshot> {
    return this.serialize(async () => {
      this.assertCampaignRun();
      const checkpoint = this.chapterDefinition()?.checkpoints.find((item) => item.id === checkpointId);
      if (!checkpoint) throw new Error("Unknown chapter checkpoint for the current story segment.");
      if (checkpoint.regionId !== this.region) throw new Error("This checkpoint belongs to a different region.");
      // A reached checkpoint never regresses the respawn point when the player backtracks through its radius.
      if (this.facts["checkpoint:" + checkpointId] === true) return this.snapshot();
      return this.commitCheckpoint(checkpoint, null);
    });
  }

  beginChapterEncounter(encounterId: string, checkpointId: string): Promise<CampaignSnapshot> {
    return this.serialize(async () => {
      this.assertCampaignRun();
      const definition = this.chapterDefinition();
      const entry = definition?.encounterEntries.find((item) => item.encounterId === encounterId && item.checkpointId === checkpointId);
      const checkpoint = definition?.checkpoints.find((item) => item.id === checkpointId);
      if (!entry || !checkpoint) throw new Error("Unknown chapter encounter entry.");
      if (entry.regionId !== this.region || checkpoint.regionId !== this.region) throw new Error("This encounter belongs to a different region.");
      if (checkpoint.encounterId !== null && checkpoint.encounterId !== encounterId) throw new Error("The checkpoint does not reset this encounter.");
      if (this.encounterResolved(encounterId)) throw new Error("This encounter is already resolved.");
      if (!this.isObjectiveActive(entry.objectiveId)) throw new Error("The encounter's objective is not active.");
      if (entry.requiresFacts.some((fact) => this.facts[fact] !== true)) throw new Error("Encounter prerequisites are not met.");
      if (this.story.activeEncounterId === encounterId && this.story.checkpointId === checkpointId) return this.snapshot();
      return this.commitCheckpoint(checkpoint, encounterId);
    });
  }

  /** Commits an authored checkpoint (and optional active-encounter intent) as the safe spawn, atomically with its save. */
  private async commitCheckpoint(checkpoint: ChapterCheckpointDefinition, encounterId: string | null): Promise<CampaignSnapshot> {
    if (checkpoint.requiresFacts.some((fact) => this.facts[fact] !== true)) throw new Error("Checkpoint prerequisites are not met.");
    const region = REGIONS.find((item) => item.id === checkpoint.regionId);
    if (!region?.cameraAnchors.some((anchor) => anchor.id === checkpoint.cameraAnchorId)) {
      throw new Error("Checkpoint camera anchor is not authored.");
    }
    const spawn = resolveSafeNode(region, checkpoint.nodeId, this.facts, checkpoint.cameraAnchorId);
    if (!spawn) throw new Error("Checkpoint node is not a safe authored position.");
    const rollback = this.rollbackState();
    const epoch = this.epoch;
    this.facts["checkpoint:" + checkpoint.id] = true;
    this.story.checkpointId = checkpoint.id;
    if (encounterId !== null) this.story.activeEncounterId = encounterId;
    this.safeSpawn = spawn;
    this.revision += 1;
    this.refreshSafeCheckpoint();
    await this.commit(rollback, epoch);
    return this.publish();
  }

  advanceChapter(input: { exitId: string; requestId: string }): Promise<CampaignSnapshot> {
    return this.serialize(async () => {
      this.assertCampaignRun();
      if (!input.requestId.trim()) throw new Error("A chapter transition requires a request id.");
      // One key set per transition request: a retry of this request is idempotent, a later return journey is a new request.
      const requestKey = "transition:" + input.requestId;
      if (this.eventKeys.has(requestKey + ":travel")) return this.snapshot();
      const definition = this.chapterDefinition();
      if (!definition) throw new Error("No authored chapter transition exists from this story segment.");
      const source = REGIONS.find((item) => item.id === this.region);
      const exit = source?.exits.find((route) => route.id === input.exitId);
      if (!exit) throw new Error("The requested exit is not authored in the current region.");
      const destination = REGIONS.find((item) => item.id === exit.destinationRegionId);
      const entrance = destination?.entrances.find(
        (route) => route.traversalEvent === exit.traversalEvent && route.destinationRegionId === exit.destinationRegionId,
      );
      if (!destination || !entrance) throw new Error("The exit has no authored destination entrance.");
      const unmet = definition.exitRequirements.filter((requirement) => !this.requirementMet(requirement));
      if (unmet.length) throw new Error("Chapter exit requirements are not met: " + unmet.join(", "));
      if (this.story.pendingChoiceId !== null) throw new Error("A required story choice must be resolved before leaving.");
      for (const route of [exit, entrance]) {
        if (route.unlockFact && this.facts[route.unlockFact] !== true) throw new Error("The selected route has not been discovered.");
      }
      const destinationChapter = this.chapterFor(destination.id);
      const events: WorldEvent[] = [];
      if (destinationChapter > this.chapter) {
        events.push({
          type: "chapter-transition",
          eventId: createId(),
          idempotencyKey: requestKey + ":chapter",
          fromChapter: this.chapter,
          toChapter: destinationChapter,
          triggerId: exit.id,
        });
      }
      events.push({
        type: "traversal",
        eventId: createId(),
        idempotencyKey: requestKey + ":travel",
        routeId: entrance.traversalEvent,
        fromRegion: this.region,
        toRegion: destination.id,
        landmarkId: entrance.id,
      });
      return this.applyBatch(events);
    });
  }

  /** Destination chapter of a region: authored definition first (a hub preserves the current chapter), then the legacy mapping. */
  private chapterFor(regionId: RegionId): number {
    if (regionId === "the-grove") {
      // The Grove preserves the current chapter for ordinary visits, but a return to the Grove after Sunmane / Moonpine /
      // Mistveil completion enters chapter 6 (the Fall of the Grove). The fallback of the authored `grove-fall` segment
      // names chapter 6 explicitly.
      const groveFall = this.chapters.find((item) => item.segmentId === "grove-fall");
      const sunmaneResolution = this.choices["sunmane-resolution"];
      const allFragments = FRAGMENT_IDS.every(fragment => this.campaign.world.fragments.includes(fragment));
      const triggered = Boolean(sunmaneResolution) && allFragments && groveFall !== undefined;
      if (triggered) return Math.max(this.chapter, groveFall.chapter);
      return this.chapter;
    }
    // Prefer the return segment when current chapter is at or above 7: a return journey to a previously visited region
    // never moves the chapter backwards. Return segments carry the same chapter as the chapter the player is in.
    if (this.chapter >= 7) {
      const returnSegment = this.chapters.find(
        (item) => item.regionId === regionId && item.segmentId.startsWith("return-"),
      );
      if (returnSegment) return Math.max(returnSegment.chapter, this.chapter);
      if (regionId === "refuge") return Math.max(7, this.chapter);
    }
    const authored = this.chapters.find(
      (item) => item.regionId === regionId && item.segmentId !== "grove" && item.segmentId !== "prologue" && !item.segmentId.startsWith("return-"),
    );
    if (authored) return authored.chapter;
    return REGION_CHAPTER[regionId] ?? this.chapter;
  }

  advanceStory(input: { beatId: string; lineIndex: number; skip: boolean }): Promise<CampaignSnapshot> {
    return this.serialize(async () => {
      const { beatId, lineIndex, skip } = input;
      if (!Number.isInteger(lineIndex) || lineIndex < 0) throw new Error("Dialogue line index must be a non-negative integer.");
      const beat = STORY_DIALOGUE[beatId];
      if (!beat) throw new Error("Unknown dialogue beat.");
      if (this.story.completedBeatIds.includes(beatId)) return this.snapshot();
      const current = this.story.dialogue?.beatId === beatId ? this.story.dialogue : null;
      if (!current && this.story.requiredBeatQueue[0] !== beatId) {
        throw new Error("This dialogue beat is not the required beat.");
      }
      const expected = current?.lineIndex ?? 0;
      if (!skip) {
        if (lineIndex < expected) return this.snapshot();
        if (lineIndex > expected || lineIndex >= beat.lines.length) throw new Error("Dialogue lines must be acknowledged in order.");
      }
      const rollback = this.rollbackState();
      const epoch = this.epoch;
      if (skip || lineIndex >= beat.lines.length - 1) {
        this.completeBeat(beatId, skip);
      } else {
        this.story.dialogue = { beatId, lineIndex: lineIndex + 1 };
      }
      this.normalizeStory();
      this.revision += 1;
      await this.commit(rollback, epoch);
      return this.publish();
    });
  }

  /** Acknowledges a beat. Chained `next` beats follow in order, or are all acknowledged on skip; a pending choice is never cleared. */
  private completeBeat(beatId: string, skip: boolean): void {
    const completed = new Set(this.story.completedBeatIds);
    let nextBeat: string | undefined = beatId;
    this.story.dialogue = null;
    while (nextBeat !== undefined) {
      const beat: DialogueBeat | undefined = STORY_DIALOGUE[nextBeat];
      completed.add(nextBeat);
      this.story.requiredBeatQueue = this.story.requiredBeatQueue.filter((id) => id !== nextBeat);
      const following: string | undefined = beat?.next && STORY_DIALOGUE[beat.next] && !completed.has(beat.next) ? beat.next : undefined;
      if (following !== undefined && !skip) {
        this.story.requiredBeatQueue = [following, ...this.story.requiredBeatQueue.filter((id) => id !== following)];
        this.story.dialogue = { beatId: following, lineIndex: 0 };
        break;
      }
      nextBeat = following;
    }
    this.story.completedBeatIds = [...completed];
  }

  /** Reduces one accepted event into in-memory state; throws before any mutation when the event is invalid. */
  private reduceEvent(event: WorldEvent): void {
    const before = this.questMarks();
    let nextCampaign = structuredClone(this.campaign);
    const nextFacts = { ...this.facts };
    const nextChoices = { ...this.choices };
    let nextRegion = this.region;
    let nextChapter = this.chapter;
    let nextEnding = this.endingId;
    const nextParty = { ...this.party };
    let nextSafeSpawn = this.safeSpawn;
    let nextRecoveryRequest = this.recoveryRequest;
    switch (event.type) {
      case "object-moved": {
        const region = REGIONS.find((item) => item.id === event.regionId);
        const movable = region?.movableObjects.find((item) => item.id === event.objectId);
        const propPlacements = region?.props.filter((item) => item.id === event.objectId) ?? [];
        if (!region || event.regionId !== this.region || !movable || propPlacements.length !== 1) {
          throw new Error("Moved object event is not registered in the active region.");
        }
        const prop = propPlacements[0]!;
        if (prop.assetId !== movable.assetId || !samePosition(prop.position, movable.from)) {
          throw new Error("Moved object event does not match its canonical prop placement.");
        }
        if (!samePosition(event.from, movable.from) || !samePosition(event.to, movable.to)) {
          throw new Error("Moved object event does not match its authored endpoints.");
        }
        if (
          !Number.isFinite(movable.radiusMeters) || movable.radiusMeters <= 0 ||
          !Number.isInteger(movable.animationTicks) || movable.animationTicks <= 0 ||
          !liesOnSurface(region, event.from, movable.supportSurfaceId) ||
          !liesOnSurface(region, event.to, movable.supportSurfaceId)
        ) {
          throw new Error("Moved object endpoints are outside their authored support surface.");
        }
        if (nextFacts[movable.movedFactId] === true) {
          throw new Error("This authored object has already been moved.");
        }
        if (movable.requiredFacts.some((fact) => nextFacts[fact] !== true)) {
          throw new Error("Moved object prerequisites are not met.");
        }
        const interaction = INTERACTIONS.find((item) => item.id === event.interactionId);
        const objectMove = interaction?.success.type === "object-move" &&
          interaction.success.objectId === movable.id;
        if (
          !interaction || interaction.regionId !== region.id || interaction.targetId !== movable.id ||
          interaction.kind !== "move-object" || !objectMove || interaction.repeatable ||
          [...interaction.requiresFacts, ...movable.requiredFacts].some((fact) => nextFacts[fact] !== true)
        ) {
          throw new Error("Moved object event does not match an available authored interaction.");
        }
        if (event.interactionId === movable.koroInteractionId) {
          const actor = region.entities.find((entity) => entity.id === event.actorId);
          const command = interaction.requiresCompanionCommand;
          const travelingCompanion = event.actorId === `${movable.requiredCompanionId}__party_companion`;
          if (
            !command || command.companionId !== movable.requiredCompanionId ||
            command.command !== "special" ||
            !interaction.requiresActors.includes(movable.requiredCompanionId) ||
            interaction.inputHint !== "ability" ||
            this.party.companionId !== movable.requiredCompanionId ||
            !(travelingCompanion || actor?.kind === "actor" && actor.actorId === movable.requiredCompanionId)
          ) {
            throw new Error("Moved object event requires the equipped companion special.");
          }
        } else if (event.interactionId === movable.playerInteractionId) {
          if (
            interaction.playerActionId !== "staff-heavy" ||
            interaction.inputHint !== "heavy" ||
            interaction.activation !== "press-release" ||
            event.actorId !== "aren" ||
            this.party.companionId === movable.requiredCompanionId
          ) {
            throw new Error("Moved object fallback requires an absent Koro and the staff-heavy player action.");
          }
        } else {
          throw new Error("Moved object event uses an unauthorized interaction.");
        }
        if (this.eventLog.some((prior) => prior.type === "object-moved" && prior.objectId === movable.id)) {
          throw new Error("This authored object already has a committed move event.");
        }
        nextFacts[movable.movedFactId] = true;
        break;
      }
      case "semantic-interaction":
        nextFacts["interaction:" + event.interactionId] = true;
        if (
          event.interactionId === "nyra-reveal-hidden-route" &&
          (event.actorId === "nyra" || this.party.companionId === "nyra" && event.actorId === "nyra__party_companion") &&
          event.kind === "signal" &&
          event.targetId === "mistveil-hidden-route"
        ) {
          nextFacts.mistveil_nyra_hidden_route = true;
        }
        // Earned Fall completion: gameplay author and emit this semantic interaction only after the current Fall's
        // three required beats committed in order: protection phase cleared (a possessed recruit's hold broken, OR Aren
        // evading Orun's orun-root-surge), Tali physically arrives at the grove-tali-shelter nav node, and Aren braces
        // the pillar. We do NOT trust interactionId alone as phase authority: the event log is the canonical source
        // of current-Fall truth, and we explicitly do NOT accept Act II's bamboo_tali_safe obligation or the global
        // taliSafe fact, both earned in Bamboo before the Fall ever began.
        if (
          this.chapter === 6 &&
          this.region === "the-grove" &&
          event.interactionId === "grove-collapse-escape" &&
          event.actorId === "aren" &&
          event.kind === "coordinate" &&
          event.targetId === "grove-collapse-escape"
        ) {
          const taliRescued = this.eventLog.some((entry) =>
            entry.type === "rescue" &&
            entry.targetId === "tali" &&
            entry.safe === true &&
            entry.locationId === "grove-tali-shelter"
          );
          const pillarBraced = nextFacts["interaction:grove-pillar"] === true
            || this.facts["interaction:grove-pillar"] === true;
          // Protection-phase completion: encounterPhase:encounter-fall:0:cleared is written by the existing
          // encounter-phase reducer (no new fact shape, no new reducer case). It is emitted exactly once per current
          // Fall after the protection branch completes (possessed recruit hold broken, or Aren evaded / countered
          // Orun's orun-root-surge).
          const protectionPhaseComplete = nextFacts["encounterPhase:encounter-fall:0:cleared"] === true
            || this.facts["encounterPhase:encounter-fall:0:cleared"] === true;
          if (!taliRescued || !pillarBraced || !protectionPhaseComplete) {
            throw new Error(
              "grove-collapse-escape requires current-Fall Tali safe at grove-tali-shelter, pillar bracing, and " +
              "encounterPhase:encounter-fall:0:cleared (protection branch). All three beats must be present in " +
              "the current run's event log."
            );
          }
          nextFacts.wardenCall = false;
          nextFacts.askSignal = false;
          nextFacts.refugeOpen = true;
        }
        if (
          event.interactionId === "warden-call" &&
          event.actorId === "aren" &&
          event.kind === "signal" &&
          event.targetId === "warden-call"
        ) {
          // Warden-call availability mirrors `groveFallPending`: chapter 6 in the Grove with the Refuge still locked.
          // Pre-Grove entries or post-Fall calls (when the Refuge is open) are rejected here so the player cannot
          // re-issue a coercive Call after the earned collapse-escape already severed it.
          if (this.chapter !== 6 || this.region !== "the-grove" || this.facts.refugeOpen === true) {
            throw new Error(
              "warden-call is only available during the Fall of the Grove, before the Refuge opens.",
            );
          }
          nextFacts.wardenCall = true;
          nextFacts.askSignal = false;
        }
        break;
      case "encounter-phase":
        nextFacts[
          "encounterPhase:" +
            event.encounterId +
            ":" +
            event.phaseIndex +
            ":" +
            event.state
        ] = true;
        break;
      case "possession":
        nextFacts[
          "possession:" +
            event.actorId +
            ":" +
            event.phaseId +
            ":" +
            event.state
        ] = true;
        break;
      case "encounter-resolved":
        if (event.resolution === "dominated") {
          for (const actorId of event.actorIds) {
            if (LEADER_IDS.includes(actorId as LeaderId)) {
              nextCampaign = recordLeaderDominion(
                nextCampaign,
                actorId as LeaderId,
              );
            }
          }
        }
        if (event.resolution === "cleansed") {
          if (event.encounterId === "encounter-orun") {
            if (eventMatches("encounter:encounter-orun", event)) {
              nextFacts["orun-cleansed"] = true;
              nextCampaign.world.hollowReady = true;
            }
          } else {
            nextFacts[event.encounterId + "-cleansed"] = true;
          }
        }
        break;
      case "rescue":
        nextFacts["rescued:" + event.targetId] = event.safe;
        // Location-scoped fact: a rescue at a specific authored location. This is what checkpoint/segment/exit
        // requirements reference when the rescue must be at the right place (Grove Tali shelter vs Bamboo Tali cage vs
        // a return-journey Tali safe corridor). Global `rescued:<target>` is too coarse: it stays true from any earlier
        // rescue in any region and would silently satisfy later checkpoints in unrelated regions.
        if (event.locationId) {
          nextFacts["rescued:" + event.targetId + ":" + event.locationId] = event.safe;
        }
        if (event.targetId === "tali" && event.safe) {
          // Bamboo Act II obligation: only set when the rescue happens in the Bamboo region. A current-Fall Tali
          // rescue at grove-tali-shelter does not retroactively satisfy Act II's bamboo_tali_safe obligation; the Act II
          // Bamboo rescue and the chapter 6 current-Fall rescue are distinct narrative beats.
          if (event.locationId === "tali-cage" || event.locationId === "tali-shelter") {
            nextFacts.bamboo_tali_safe = true;
          }
          nextFacts.taliSafe = true;
          nextFacts.taliNeedsRescue = false;
          nextFacts.taliCageOpen = true;
          if (event.locationId === "the-grove") {
            nextFacts.taliInBamboo = false;
            nextFacts.taliInGrove = true;
          }
        }
        if (
          event.targetId === "tali" &&
          !event.safe &&
          this.lastSafeCheckpoint
        ) {
          nextRecoveryRequest = {
            kind: "restart-checkpoint",
            reason: "tali-safety",
            checkpointId: this.lastSafeCheckpoint.checkpointId,
          };
        }
        break;
      case "restoration": {
        const eventRegion = event.regionId as RegionId;
        const authoredRegion = REGIONS.some((region) => region.id === eventRegion);
        if (!authoredRegion) break;
        const prior = effectiveRestorationState(nextCampaign, nextFacts, eventRegion);
        if (RESTORATION_RANK[event.state] < RESTORATION_RANK[prior]) break;
        if (REGION_IDS.includes(eventRegion as CanonRegionId)) {
          const domainCanon = eventRegion as CanonRegionId;
          nextCampaign = {
            ...nextCampaign,
            world: {
              ...nextCampaign.world,
              regions: {
                ...nextCampaign.world.regions,
                [domainCanon]: event.state,
              },
            },
          };
        }
        applyRestorationBooleans(nextFacts, eventRegion, event.state);
        for (const region of REGIONS) {
          const state = effectiveRestorationState(nextCampaign, nextFacts, region.id);
          applyRestorationBooleans(nextFacts, region.id, state);
        }
        if (REGION_IDS.includes(eventRegion as CanonRegionId)) {
          nextFacts[CANONICAL_RESTORATION_FACT_IDS[eventRegion as CanonRegionId]] =
            event.state === "restored";
        }
        break;
      }
      case "fragment":
        nextCampaign = collectFragment(nextCampaign, event.fragmentId);
        break;
      case "choice": {
        nextChoices[event.choiceId] = event.optionId;
        nextFacts["choice:" + event.choiceId] = true;
        // Authored choice and domain identity own history, never producer labels.
        const pact = pactForChoice(event.choiceId);
        const leaderId = pact
          ? pact.leaderId
          : event.choiceId === "sunmane-resolution"
            ? nextCampaign.world.factions.crown.leaderId ?? undefined
            : event.choiceId === "pack-leadership"
              ? event.optionId.endsWith("luma") ? "luma" : "ruun"
              : undefined;
        if (event.optionId.includes("dominion") && leaderId) {
          nextCampaign = recordLeaderDominion(nextCampaign, leaderId);
          nextFacts["dominion:" + leaderId] = true;
        }
        if (pact) {
          if (event.optionId === "bond") {
            nextCampaign = awardCompanionBond(nextCampaign, pact.companionId, RESPECTFUL_PACT_BOND);
          }
          nextFacts["pact:" + pact.choiceId] = event.optionId;
        }
        nextCampaign = this.applyChoice(
          nextCampaign,
          event.choiceId,
          event.optionId,
          leaderId,
          nextFacts,
        );
        if (nextCampaign.world.factions.crown.leaderStatus === "exiled") {
          nextFacts.solkarPresent = false;
          nextFacts["solkar-exiled"] = true;
          nextFacts.crownCouncilAvailable = true;
          if (nextParty.companionId === "solkar") delete nextParty.companionId;
        }
        if (event.choiceId === "final-ending") {
          // validateChoice already checked the encounter and package predicate.
          if (
            event.optionId === "dominion" ||
            event.optionId === "severance" ||
            event.optionId === "living_pact"
          ) {
            nextEnding = event.optionId;
          }
        }
        break;
      }
      case "traversal": {
        const targetRegion = REGIONS.find(
          (region) => region.id === event.toRegion,
        );
        const sourceRegion = REGIONS.find(
          (region) => region.id === event.fromRegion,
        );
        // An authored local arc is intra-region traversal: it changes no region, chapter or safe spawn.
        const localArc = event.fromRegion === event.toRegion && event.fromRegion === this.region
          ? sourceRegion?.traversalArcs.find(
            (arc) =>
              arc.traversalEvent === event.routeId &&
              arc.id === event.landmarkId &&
              arc.destinationRegionId === event.toRegion,
          )
          : undefined;
        if (localArc) {
          if (localArc.unlockFact && nextFacts[localArc.unlockFact] !== true) {
            throw new Error("The authored local route has not been discovered.");
          }
          nextFacts["traversed:" + event.routeId] = true;
          break;
        }
        const localMarker = event.fromRegion === this.region && event.toRegion === this.region
          ? INTERACTIONS.find(definition => {
            const result = definition.success;
            return definition.regionId === this.region && result.type === "traversal" &&
              result.routeId === event.routeId && result.fromRegion === event.fromRegion &&
              result.toRegion === event.toRegion && result.landmarkId === event.landmarkId &&
              sourceRegion?.entities.some(entity => entity.interactionId === definition.id);
          })
          : undefined;
        if (localMarker) {
          if (localMarker.requiresFacts.some(fact => nextFacts[fact] !== true)) {
            throw new Error("The authored traversal marker is not available.");
          }
          nextFacts["traversed:" + event.routeId] = true;
          break;
        }
        const targetEntrance = targetRegion?.entrances.find(
          (route) =>
            route.traversalEvent === event.routeId &&
            route.destinationRegionId === event.toRegion &&
            route.id === event.landmarkId,
        );
        const sourceExit = sourceRegion?.exits.find(
          (route) =>
            route.destinationRegionId === event.toRegion &&
            route.traversalEvent === event.routeId,
        );
        if (
          event.fromRegion !== this.region ||
          !targetEntrance ||
          !sourceExit
        ) {
          throw new Error(
            "Traversal event does not match an authored region route.",
          );
        }
        nextRegion = event.toRegion;
        nextFacts["visited:" + event.toRegion] = true;
        if (
          event.toRegion === "the-grove" &&
          nextFacts.taliSafe === true &&
          this.completedQuestIds.includes("a-mothers-roar")
        ) {
          nextFacts.taliInBamboo = false;
          nextFacts.taliInGrove = true;
        }
        nextSafeSpawn = this.safeSpawnFor(event.toRegion, event.landmarkId);
        break;
      }
      case "chapter-transition":
        if (pendingPactChoice(this.eventLog, nextChoices) !== null) {
          throw new Error("A required story choice must be resolved before the chapter transition.");
        }
        if (event.toChapter < nextChapter + 1 || event.toChapter > 8) {
          throw new Error("Invalid campaign chapter transition.");
        }
        if (
          event.toChapter === 1 &&
          !this.completedQuestIds.includes("prologue")
        ) {
          throw new Error("The prologue must be completed before Chapter 1.");
        }
        if (
          event.toChapter > 1 &&
          QUESTS.some(
            (quest) =>
              !quest.optional &&
              quest.chapter > 0 &&
              quest.chapter < event.toChapter &&
              !this.completedQuestIds.includes(quest.id),
          )
        ) {
          throw new Error(
            "Required quests from the previous chapter must be completed before transition.",
          );
        }
        nextChapter = event.toChapter;
        nextFacts.chapter = nextChapter;
        // Note: chapter-transition to chapter 6 (grove-fall) does NOT open the Refuge nor reset the Warden Call. The
        // Refuge opens only after the player actually completes the Fall sequence — Tali safety, pillar bracing and a
        // successful grove-collapse-escape semantic interaction — which gameplay author and emits. The Ask/Signal
        // choice becomes available after the Call is severed by that same completion event, never on chapter entry.
        break;
    }
    const nextKeys = new Set(this.eventKeys);
    nextKeys.add(event.idempotencyKey);
    const nextEventLog = [...this.eventLog, cloneEvent(event)];
    this.campaign = {
      ...nextCampaign,
      dominionHistory: mergeHistory(
        this.campaign.dominionHistory,
        nextCampaign.dominionHistory,
      ),
    };
    this.facts = nextFacts;
    this.choices = nextChoices;
    this.region = nextRegion;
    this.chapter = nextChapter;
    this.endingId = nextEnding;
    this.party = nextParty;
    this.eventKeys = nextKeys;
    this.eventLog = nextEventLog;
    this.recoveryRequest = nextRecoveryRequest;
    this.safeSpawn = nextSafeSpawn;
    this.updateQuestProgress();
    if (event.type === "chapter-transition")
      this.ensureChapterQuest(nextChapter);
    normalizeRestorationFacts(this.campaign, this.facts);
    this.applyRelationshipAuthority();
    this.syncStoryState(before, event);
    this.revision += 1;
    const checkpointEvent =
      event.type === "object-moved" ||
      event.type === "chapter-transition" ||
      event.type === "restoration" ||
      event.type === "choice" ||
      event.type === "traversal" ||
      (event.type === "rescue" && event.safe) ||
      (event.type === "encounter-resolved" && event.resolution !== "escaped");
    if (checkpointEvent) {
      this.checkpoint = createCheckpoint(this.campaign);
      this.lastSafeCheckpoint = this.createSafeCheckpoint();
    }
  }

  /** Required-beat entitlement, pending ceremony choice, encounter bookkeeping and checkpoint ids follow committed state only. */
  private syncStoryState(before: QuestMarks, event: WorldEvent): void {
    for (const objectiveId of this.completedObjectiveIds) {
      if (before.completedObjectives.includes(objectiveId)) continue;
      const owner = [...this.activeQuestIds, ...this.completedQuestIds].find((questId) =>
        this.objectivesFor(questId).some((objective) => objective.id === objectiveId));
      const cue = owner ? NARRATIVE_CUES[owner]?.onObjective?.find((item) => item.objectiveId === objectiveId) : undefined;
      if (cue) this.enqueueBeat(cue.beatId);
    }
    for (const questId of this.completedQuestIds) {
      if (before.completedQuests.includes(questId)) continue;
      const beat = NARRATIVE_CUES[questId]?.onComplete;
      if (beat) this.enqueueBeat(beat);
    }
    this.enqueueActivationCues(this.activeQuestIds.filter((questId) => !before.active.includes(questId)));
    this.story.pendingChoiceId = pendingPactChoice(this.eventLog, this.choices);
    if (event.type === "encounter-resolved" && event.resolution !== "escaped" && this.story.activeEncounterId === event.encounterId) {
      this.story.activeEncounterId = null;
    }
    this.normalizeStory();
  }

  choose(choiceId: string, optionId: string): Promise<CampaignSnapshot> {
    return this.processEvent({
      type: "choice",
      eventId: createId(),
      idempotencyKey: "choice:" + choiceId + ":" + optionId,
      choiceId,
      optionId,
    });
  }

  trackObjective(objectiveId: ObjectiveId | null): CampaignSnapshot {
    if (
      objectiveId &&
      !this.snapshot().activeObjectiveIds.includes(objectiveId)
    ) {
      throw new Error("Only an active objective can be tracked.");
    }
    this.trackedObjectiveId = objectiveId;
    this.revision += 1;
    return this.publish();
  }

  acceptQuest(questId: QuestId): Promise<CampaignSnapshot> {
    return this.serialize(async () => {
      this.assertCampaignRun();
      const quest = QUESTS.find((item) => item.id === questId);
      if (!quest || !quest.optional)
        throw new Error("Only authored optional quests can be accepted.");
      if (this.activeQuestIds.includes(quest.id) || this.completedQuestIds.includes(quest.id))
        return this.snapshot();
      if (quest.chapter > this.chapter)
        throw new Error("This quest is not unlocked yet.");
      if (this.region !== quest.region && this.facts["visited:" + quest.region] !== true)
        throw new Error("Travel to this region before accepting its quest.");
      for (const requirement of quest.prerequisites) {
        if (requirement.startsWith("quest:") && !this.completedQuestIds.includes(requirement.slice(6)))
          throw new Error("A prerequisite quest is incomplete.");
        if (requirement.startsWith("region:") && this.region !== requirement.slice(7) && this.facts["visited:" + requirement.slice(7)] !== true)
          throw new Error("Travel to this region before accepting its quest.");
      }
      const rollback = this.rollbackState(), epoch = this.epoch;
      this.activeQuestIds.push(quest.id);
      this.facts["quest:" + quest.id + ":accepted"] = true;
      this.enqueueActivationCues([quest.id]);
      this.updateQuestProgress();
      if (this.completedQuestIds.includes(quest.id)) {
        const beat = NARRATIVE_CUES[quest.id]?.onComplete;
        if (beat) this.enqueueBeat(beat);
      }
      this.normalizeStory();
      this.revision += 1;
      this.refreshSafeCheckpoint();
      await this.commit(rollback, epoch);
      return this.publish();
    });
  }

  learnUpgrade(upgradeId: string): Promise<CampaignSnapshot> {
    return this.serialize(async () => {
      this.assertCampaignRun();
      if (!HUB_REGION_IDS.some(id => id === this.region))
        throw new Error("Train at the Grove or Refuge to learn an upgrade.");
      const upgrade = HUB_UPGRADES.find(item => item.id === upgradeId);
      if (!upgrade) throw new Error("Unknown hub upgrade.");
      if (this.facts[upgrade.fact] === true) return this.snapshot();
      if (!this.completedQuestIds.includes(upgrade.requiredQuestId) ||
          (upgrade.requiredFact !== null && this.facts[upgrade.requiredFact] !== true))
        throw new Error(upgrade.requirement);
      const rollback = this.rollbackState(), epoch = this.epoch;
      this.facts[upgrade.fact] = true;
      this.revision += 1;
      this.refreshSafeCheckpoint();
      await this.commit(rollback, epoch);
      return this.publish();
    });
  }
  selectParty(companionId: CompanionId): Promise<CampaignSnapshot> {
    return this.serialize(async () => {
      if (!isCompanionId(companionId)) throw new Error("Unknown companion.");
      if (this.story.activeEncounterId !== null)
        throw new Error("The companion cannot change during an active encounter.");
      if (companionId === "solkar" && this.campaign.world.factions.crown.leaderStatus === "exiled")
        throw new Error("Solkar cannot return after your exile decision.");
      const party = { companionId };
      const rollback = this.rollbackState();
      const epoch = this.epoch;
      this.party = party;
      this.revision += 1;
      this.refreshSafeCheckpoint();
      await this.commit(rollback, epoch);
      return this.publish();
    });
  }

  async travel(
    regionId: RegionId,
    entranceId: string,
  ): Promise<CampaignSnapshot> {
    const chapter = REGION_CHAPTER[regionId];
    if (chapter === undefined) throw new Error("Unknown campaign region.");
    if (regionId === "heartroot-hollow" && this.chapter < 8)
      throw new Error("Heartroot Hollow is not accessible before Chapter 8.");
    if (
      regionId === "refuge" &&
      (this.chapter < 6 || this.facts.refugeOpen !== true)
    ) {
      throw new Error("The Refuge does not open before the Fall of the Grove.");
    }
    const refugeOpenOnFall =
      regionId === "refuge" && this.chapter === 6 && this.facts.refugeOpen === true;
    if (chapter > this.chapter && regionId !== "the-grove" && !refugeOpenOnFall)
      throw new Error(
        "This region has not been unlocked by campaign progression.",
      );
    const target = REGIONS.find((item) => item.id === regionId);
    const entrance = target?.entrances.find(
      (route) =>
        route.id === entranceId && route.destinationRegionId === regionId,
    );
    const source = REGIONS.find((item) => item.id === this.region);
    const exit = source?.exits.find(
      (route) =>
        route.destinationRegionId === regionId &&
        route.traversalEvent === entrance?.traversalEvent,
    );
    if (!entrance || !exit)
      throw new Error(
        "The selected route is not an authored connection from the current region.",
      );
    if (entrance.unlockFact && this.facts[entrance.unlockFact] !== true) {
      throw new Error("The selected route has not been discovered.");
    }
    // One key per transition request: a return journey to a previously visited region is a new request, never a consumed key.
    const priorJourneys = this.eventLog.filter(
      (event) =>
        event.type === "traversal" &&
        event.fromRegion === this.region &&
        event.toRegion === regionId &&
        event.landmarkId === entrance.id,
    ).length;
    return this.processEvent({
      type: "traversal",
      eventId: createId(),
      idempotencyKey:
        "travel:" + this.region + ":" + regionId + ":" + entrance.id + ":" + priorJourneys,
      routeId: entrance.traversalEvent,
      fromRegion: this.region,
      toRegion: regionId,
      landmarkId: entrance.id,
    });
  }

  /**
   * Test seam used by durable regression tests and inventory reports: a pure traversal that records the journey but
   * does not require a live encounter or active pact. Travels through an authored chapter exit (with its unlock fact)
   * and never raises on a return to a previously visited region. The Director's own `travel` is preferred for gameplay.
   */
  async travelThroughSegmentExit(segmentId: ChapterSegmentId, requestId: string): Promise<CampaignSnapshot> {
    const definition = this.chapters.find((item) => item.segmentId === segmentId);
    if (!definition) throw new Error("No authored chapter segment: " + segmentId);
    const exit = REGIONS.find((item) => item.id === definition.regionId)?.exits[0];
    if (!exit) throw new Error("The authored chapter segment has no exit route: " + segmentId);
    return this.advanceChapter({ exitId: exit.id, requestId });
  }

  async captureCheckpoint(): Promise<CampaignSafeCheckpoint> {
    if (this.replay)
      throw new Error("Replay data cannot be saved as a campaign checkpoint.");
    this.checkpoint = createCheckpoint(this.campaign);
    this.lastSafeCheckpoint = this.createSafeCheckpoint();
    return structuredClone(this.lastSafeCheckpoint);
  }

  restoreCheckpoint(input: unknown): Promise<boolean> {
    return this.serialize(async () => {
      if (this.replay) return false;
      let migrated: CampaignSafeCheckpoint | "future" | null;
      try {
        migrated = migrateSafeCheckpoint(input, {
          scope: this.scope,
          chapters: this.chapters,
          layoutMigrations: this.layoutMigrations,
          heroId: this.heroId,
        });
      } catch {
        return false;
      }
      if (
        migrated === null ||
        migrated === "future" ||
        !isCampaignSafeCheckpoint(migrated) ||
        migrated.runId !== this.runId ||
        migrated.worldCheckpoint.runId !== this.runId ||
        migrated.progress.session.saveScope !== this.scope ||
        migrated.progress.session.heroId !== this.heroId ||
        sessionContentProblem(migrated.progress.session, migrated.progress.regionId, this.chapters) !== null
      ) {
        return false;
      }
      const checkpoint = migrated;
      const runHistory = this.campaign.dominionHistory;
      const imported = importCheckpoint(this.campaign, checkpoint.worldCheckpoint);
      if (imported.accepted === false) return false;
      const rollback = this.rollbackState();
      const epoch = this.epoch;
      this.campaign = {
        ...imported.state,
        dominionHistory: mergeHistory(runHistory, imported.state.dominionHistory),
      };
      this.restoreProgress(checkpoint.progress);
      this.safeSpawn = structuredClone(checkpoint.safeSpawn);
      this.checkpoint = createCheckpoint(this.campaign);
      this.lastSafeCheckpoint = structuredClone(checkpoint);
      this.recoveryRequest = null;
      this.story.pendingChoiceId = pendingPactChoice(this.eventLog, this.choices);
      this.normalizeStory();
      // The stored autosave must not keep progress newer than the restored safe boundary.
      await this.commit(rollback, epoch);
      this.publish();
      return true;
    });
  }

  ending() {
    return evaluateEnding(this.campaign);
  }

  async save(slotId: string, label: string): Promise<void> {
    if (!this.saves)
      throw new SaveRepositoryError(
        "unavailable",
        "No SaveRepository was configured.",
      );
    if (this.replay) {
      throw new SaveRepositoryError("replay-isolated", "Replay data cannot be saved as a campaign checkpoint.");
    }
    const safe = this.createSafeCheckpoint();
    const campaign = this.campaign;
    const party = this.party;
    const recoveryCheckpoint = this.lastSafeCheckpoint;
    await this.saves.saveCheckpoint(
      slotId,
      label,
      safe.worldCheckpoint,
      campaign,
      safe.progress.chapter,
      safe.progress.regionId,
      safe.progress.eventKeys,
      "campaign",
      this.progressRecord(),
    );
    // Party selection and checkpoint capture can leave the campaign/revision unchanged.
    // Compare owned object identities, not the revision-derived checkpoint ID.
    if (
      this.campaign === campaign &&
      this.revision === safe.progress.revision &&
      this.party === party &&
      this.lastSafeCheckpoint === recoveryCheckpoint &&
      !this.replay
    ) {
      this.checkpoint = safe.worldCheckpoint;
      this.lastSafeCheckpoint = safe;
    }
  }

  async saveNewSlot(label: string): Promise<string> {
    if (!this.saves)
      throw new SaveRepositoryError(
        "unavailable",
        "No SaveRepository was configured.",
      );
    const slotId = "slot-" + createId();
    await this.save(slotId, label);
    return slotId;
  }

  async exportSave(slotId: string): Promise<string> {
    if (!this.saves)
      throw new SaveRepositoryError(
        "unavailable",
        "No SaveRepository was configured.",
      );
    return this.saves.exportSlot(slotId);
  }

  importSave(
    input: string,
    slotId: string,
    label: string,
  ): Promise<CampaignSnapshot> {
    return this.serialize(() => this.importSaveNow(input, slotId, label));
  }

  private async importSaveNow(
    input: string,
    slotId: string,
    label: string,
  ): Promise<CampaignSnapshot> {
    if (!this.saves)
      throw new SaveRepositoryError(
        "unavailable",
        "No SaveRepository was configured.",
      );
    // A showcase identity may be caller-supplied; even an equal ID cannot make
    // its transient history authoritative campaign history.
    const current = this.replay ? createNewRun(this.runId) : this.campaign;
    const imported = await this.saves.importSave(input, current);
    const progress = imported.envelope.progress;
    validateLoadedHistory(progress ?? null);
    await this.saves.commitImported(
      slotId,
      label,
      imported.envelope,
      progress?.chapter ?? 0,
      progress?.regionId ?? "greenwake",
    );
    const loaded = await this.saves.loadCampaign(slotId, current);
    this.applyLoadedState(
      loaded.campaign,
      loaded.checkpoint,
      loaded.eventKeys,
      loaded.progress,
      loaded.chapter,
      loaded.regionId,
    );
    return this.publish();
  }

  load(slotId: string): Promise<CampaignSnapshot> {
    return this.serialize(() => this.loadNow(slotId));
  }

  private async loadNow(slotId: string): Promise<CampaignSnapshot> {
    if (!this.saves)
      throw new SaveRepositoryError(
        "unavailable",
        "No SaveRepository was configured.",
      );
    const loaded = await this.saves.loadCampaign(
      slotId,
      this.replay ? createNewRun(this.runId) : this.campaign,
    );
    this.applyLoadedState(
      loaded.campaign,
      loaded.checkpoint,
      loaded.eventKeys,
      loaded.progress,
      loaded.chapter,
      loaded.regionId,
    );
    return this.publish();
  }

  private applyLoadedState(
    campaign: CampaignState,
    checkpoint: CheckpointSnapshot,
    eventKeys: readonly string[],
    progress: CampaignProgressRecord | null,
    fallbackChapter: number,
    fallbackRegionId: string,
  ): void {
    validateLoadedHistory(progress);
    if (progress && progress.session.saveScope !== this.scope) {
      throw new SaveRepositoryError("scope-mismatch", "The save belongs to a different persistence scope and was not loaded.");
    }
    // Validate legacy metadata and resolve an authored fallback before replacing
    // any live state; a rejected load must leave the current journey intact.
    const fallbackRegion = REGIONS.find((item) => item.id === fallbackRegionId);
    if (!progress && (!fallbackRegion || !Number.isInteger(fallbackChapter) ||
      fallbackChapter < 0 || fallbackChapter > 8)) {
      throw new SaveRepositoryError("corrupt", "Legacy save location is invalid.");
    }
    const nextSafeSpawn = progress?.safeSpawn
      ? structuredClone(progress.safeSpawn)
      : this.safeSpawnFor(progress?.regionId ?? fallbackRegion!.id);
    this.campaign = campaign;
    this.checkpoint = checkpoint;
    this.eventKeys = new Set(eventKeys);
    if (progress) {
      this.heroId = progress.session.heroId;
      this.story = storyFromResume(progress.session.resume);
      this.chapter = progress.chapter;
      this.region = progress.regionId as RegionId;
      this.activeQuestIds = [...progress.activeQuestIds];
      this.completedQuestIds = [...progress.completedQuestIds];
      this.completedObjectiveIds =
        progress.completedObjectiveIds as ObjectiveId[];
      this.trackedObjectiveId =
        progress.trackedObjectiveId as ObjectiveId | null;
      this.party = { ...progress.party } as typeof this.party;
      this.choices = { ...progress.choices };
      this.facts = factsWithRestorationDefaults(progress.worldFacts);
      normalizeRestorationFacts(campaign, this.facts);
      this.endingId = progress.ending;
      this.eventLog = progress.eventLog as WorldEvent[];
      this.eventKeys = new Set([
        ...eventKeys,
        ...(progress.eventKeys ?? []),
        ...progress.eventLog.map(
          (event) => (event as { idempotencyKey: string }).idempotencyKey,
        ),
      ]);
      this.safeSpawn = nextSafeSpawn;
      this.revision = progress.revision ?? 0;
    } else {
      this.heroId = DEFAULT_HERO_ID;
      this.story = emptyStory();
      const region = fallbackRegion!;
      this.chapter = fallbackChapter;
      this.region = region.id;
      this.completedQuestIds = QUESTS.filter(
        (quest) => !quest.optional && quest.chapter < fallbackChapter,
      ).map((quest) => quest.id);
      const firstQuest = CHAPTERS.find(
        (chapter) => chapter.number === fallbackChapter,
      )?.questIds.find((id) => {
        const quest = QUESTS.find((candidate) => candidate.id === id);
        return quest && !quest.optional && !this.completedQuestIds.includes(id);
      });
      this.activeQuestIds = firstQuest ? [firstQuest] : [];
      this.completedObjectiveIds = [];
      this.trackedObjectiveId = null;
      this.party = { companionId: DEFAULT_HERO_COMPANIONS[this.heroId] };
      this.choices = {};
      this.facts = emptyWorldFacts(campaign);
      this.facts.chapter = fallbackChapter;
      this.facts["visited:" + region.id] = true;
      normalizeRestorationFacts(campaign, this.facts);
      if (campaign.world.regionalObligations.bamboo_tali_safe) {
        this.facts.taliSafe = true;
        this.facts.taliNeedsRescue = false;
      }
      if (campaign.world.factions.crown.leaderStatus === "exiled")
        this.facts.solkarPresent = false;
      this.endingId = null;
      this.eventLog = [];
      this.eventKeys.clear();
      this.revision = 0;
      this.safeSpawn = nextSafeSpawn;
    }
    this.runId = campaign.runId;
    this.replay = false;
    if (campaign.world.factions.crown.leaderStatus === "exiled") {
      this.facts.solkarPresent = false;
      this.facts["solkar-exiled"] = true;
      this.facts.crownCouncilAvailable = true;
      if (this.party.companionId === "solkar") delete this.party.companionId;
    }
    // Preserve the persisted `refugeOpen` (and `wardenCall`/`askSignal`) from the load. The Director never infers them
    // from chapter alone; gameplay author and emit the earned `grove-collapse-escape` semantic interaction that flips
    // the bit transactionally, and save/import carries it forward.
    this.recoveryRequest = null;
    this.lastEvent = null;
    this.story.pendingChoiceId = pendingPactChoice(this.eventLog, this.choices);
    this.normalizeStory();
    this.lastSafeCheckpoint = this.createSafeCheckpoint();
  }

  private restoreProgress(progress: CampaignProgressCheckpoint): void {
    this.chapter = progress.chapter;
    this.region = progress.regionId;
    this.activeQuestIds = [...progress.activeQuestIds];
    this.completedQuestIds = [...progress.completedQuestIds];
    this.completedObjectiveIds = [...progress.completedObjectiveIds];
    this.trackedObjectiveId = progress.trackedObjectiveId;
    this.party = structuredClone(progress.party);
    this.choices = { ...progress.choices };
    this.facts = factsWithRestorationDefaults(progress.worldFacts);
    normalizeRestorationFacts(this.campaign, this.facts);
    // Preserve the persisted `refugeOpen` (and `wardenCall`/`askSignal`) from the checkpoint. Save/restore never
    // reopens the Refuge based on chapter number; the bit was set by the earned `grove-collapse-escape` event.
    this.endingId = progress.ending;
    this.eventLog = progress.eventLog.map((event) => structuredClone(event));
    this.eventKeys = new Set(progress.eventKeys);
    this.revision = progress.revision;
    this.story = storyFromResume(progress.session.resume);
    this.recoveryRequest = null;
    this.lastEvent = null;
  }

  private rollbackState(): DirectorRollbackState {
    return {
      campaign: this.campaign,
      region: this.region,
      chapter: this.chapter,
      facts: { ...this.facts },
      choices: { ...this.choices },
      activeQuestIds: [...this.activeQuestIds],
      completedQuestIds: [...this.completedQuestIds],
      completedObjectiveIds: [...this.completedObjectiveIds],
      trackedObjectiveId: this.trackedObjectiveId,
      party: { ...this.party },
      endingId: this.endingId,
      checkpoint: this.checkpoint,
      lastSafeCheckpoint: this.lastSafeCheckpoint,
      safeSpawn: this.safeSpawn,
      recoveryRequest: this.recoveryRequest,
      lastEvent: this.lastEvent,
      eventKeys: new Set(this.eventKeys),
      eventLog: [...this.eventLog],
      revision: this.revision,
      story: cloneStory(this.story),
    };
  }

  private restoreRollbackState(rollback: DirectorRollbackState): void {
    this.campaign = rollback.campaign;
    this.region = rollback.region;
    this.chapter = rollback.chapter;
    this.facts = { ...rollback.facts };
    this.choices = { ...rollback.choices };
    this.activeQuestIds = [...rollback.activeQuestIds];
    this.completedQuestIds = [...rollback.completedQuestIds];
    this.completedObjectiveIds = [...rollback.completedObjectiveIds];
    this.trackedObjectiveId = rollback.trackedObjectiveId;
    this.party = { ...rollback.party };
    this.endingId = rollback.endingId;
    this.checkpoint = rollback.checkpoint;
    this.lastSafeCheckpoint = rollback.lastSafeCheckpoint;
    this.safeSpawn = rollback.safeSpawn;
    this.recoveryRequest = rollback.recoveryRequest;
    this.lastEvent = rollback.lastEvent;
    this.eventKeys = new Set(rollback.eventKeys);
    this.eventLog = [...rollback.eventLog];
    this.revision = rollback.revision;
    this.story = cloneStory(rollback.story);
  }

  private progressRecord(): CampaignProgressRecord {
    return {
      chapter: this.chapter,
      regionId: this.region,
      activeQuestIds: [...this.activeQuestIds],
      completedQuestIds: [...this.completedQuestIds],
      completedObjectiveIds: [...this.completedObjectiveIds],
      trackedObjectiveId: this.trackedObjectiveId,
      party: { ...this.party },
      choices: { ...this.choices },
      worldFacts: { ...this.facts },
      ending: this.endingId,
      eventLog: this.eventLog.map((event) => structuredClone(event)),
      eventKeys: [...this.eventKeys],
      revision: this.revision,
      safeSpawn: structuredClone(this.safeSpawn),
      session: this.sessionMetadata(),
    };
  }

  private checkpointProgress(): CampaignProgressCheckpoint {
    return {
      chapter: this.chapter,
      regionId: this.region,
      activeQuestIds: [...this.activeQuestIds] as never,
      completedQuestIds: [...this.completedQuestIds] as never,
      completedObjectiveIds: [...this.completedObjectiveIds] as never,
      trackedObjectiveId: this.trackedObjectiveId,
      party: structuredClone(this.party),
      choices: { ...this.choices },
      worldFacts: { ...this.facts },
      ending: this.endingId,
      eventLog: this.eventLog.map((event) => structuredClone(event)),
      eventKeys: [...this.eventKeys],
      revision: this.revision,
      session: this.sessionMetadata(),
    };
  }

  private createSafeCheckpoint(): CampaignSafeCheckpoint {
    // The authored active encounter wins; otherwise derive the unresolved encounter of an active objective in this region.
    let encounter: (typeof ENCOUNTER_DEFINITIONS)[number] | undefined = this.story.activeEncounterId
      ? ENCOUNTER_DEFINITIONS.find((definition) => definition.id === this.story.activeEncounterId)
      : undefined;
    for (const questId of encounter ? [] : this.activeQuestIds) {
      const quest = QUESTS.find((item) => item.id === questId);
      for (const objective of quest?.objectives ?? []) {
        if (objective.mechanic !== "encounter" || this.completedObjectiveIds.includes(objective.id)) continue;
        encounter = ENCOUNTER_DEFINITIONS.find((definition) =>
          definition.regionId === this.region &&
          (objective.targetIds.includes(definition.bossId) ||
            objective.requiredEvents.some((required) => required.split("|").includes("encounter:" + definition.id))) &&
          !this.eventLog.some((event) =>
            event.type === "encounter-resolved" && event.encounterId === definition.id,
          ),
        );
        if (encounter) break;
      }
      if (encounter) break;
    }
    const region = REGIONS.find((item) => item.id === this.region)!;
    const encounterId = this.story.activeEncounterId ?? encounter?.id ?? null;
    const actorIds = encounterId
      ? region.encounterParticipants[encounterId] ?? encounter?.actorIds.filter((id) => id !== "aren") ?? []
      : [];
    return {
      kind: "campaign-safe-checkpoint",
      schemaVersion: 3,
      runId: this.runId,
      checkpointId: this.runId + ":safe:" + this.revision,
      worldCheckpoint: createCheckpoint(this.campaign),
      progress: this.checkpointProgress(),
      safeSpawn: structuredClone(this.safeSpawn),
      encounterReset: {
        policy: "restart-from-entry",
        encounterId,
        actorIds: [...actorIds],
      },
    };
  }
  private safeSpawnFor(regionId: RegionId, entranceId?: string): CampaignSafeSpawn {
    const region = REGIONS.find((item) => item.id === regionId);
    if (!region) throw new Error("No authored region exists for safe spawn.");

    const entrance = entranceId
      ? region.entrances.find((item) => item.id === entranceId)
      : undefined;
    let position: CampaignSafeSpawn["position"] | undefined;
    let spawnRouteId: string | undefined;
    if (
      entrance &&
      (!entrance.unlockFact || this.facts[entrance.unlockFact] === true) &&
      hasSafeWalkSurface(region, entrance.from)
    ) {
      position = entrance.from;
      spawnRouteId = entrance.id;
    }
    if (!position) {
      const root = region.navigation.nodes[0];
      if (
        root &&
        (!root.requirement || this.facts[root.requirement] === true) &&
        hasSafeWalkSurface(region, root.position)
      ) {
        position = root.position;
        spawnRouteId = root.id;
      }
    }
    if (!position || !spawnRouteId) {
      throw new Error("Region has no authored safe root on a walkable surface clear of blocking colliders.");
    }
    const camera =
      region.cameraAnchors.find(
        (anchor) => anchor.id === regionId + "-explore",
      ) ?? region.cameraAnchors[0];
    if (!camera) throw new Error("Region has no authored camera anchor.");
    return {
      regionId,
      position: { ...position },
      routeId: spawnRouteId,
      cameraAnchorId: camera.id,
    };
  }

  private objectivesFor(questId: string) {
    return QUESTS.find((quest) => quest.id === questId)?.objectives ?? [];
  }

  private updateQuestProgress(): void {
    const pending = [...this.activeQuestIds];
    for (const questId of pending) {
      const quest = QUESTS.find((item) => item.id === questId);
      const objectives = quest?.objectives ?? [];
      for (const objective of objectives) {
        if (!this.completedObjectiveIds.includes(objective.id) &&
          objective.requiredEvents.every(requirement => this.eventLog.some(event => eventMatches(requirement, event)))) {
          this.completedObjectiveIds.push(objective.id);
        }
      }
      if (
        !objectives.length ||
        !objectives
          .filter((objective) => !objective.optional)
          .every((objective) =>
            this.completedObjectiveIds.includes(objective.id),
          )
      )
        continue;
      this.activeQuestIds = this.activeQuestIds.filter((id) => id !== questId);
      if (!this.completedQuestIds.includes(questId))
        this.completedQuestIds.push(questId);
      for (const fact of quest?.consequenceFacts ?? []) this.facts[fact] = true;
      this.applyQuestConsequences(questId, quest?.consequenceFacts ?? []);
      const chapter = quest?.chapter ?? 0;
      const sequence =
        CHAPTERS.find((item) => item.number === chapter)?.questIds ?? [];
      const nextQuestId = sequence.find((id) => {
        const nextQuest = QUESTS.find((item) => item.id === id);
        return Boolean(
          nextQuest &&
            !nextQuest.optional &&
            !this.completedQuestIds.includes(id),
        );
      });
      if (nextQuestId && !this.activeQuestIds.includes(nextQuestId)) {
        this.activeQuestIds.push(nextQuestId);
        pending.push(nextQuestId);
      }
    }
  }

  private applyQuestConsequences(
    questId: string,
    facts: readonly string[],
  ): void {
    const obligations = facts.filter(
      (fact): fact is (typeof REGIONAL_OBLIGATION_IDS)[number] =>
        REGIONAL_OBLIGATION_IDS.includes(
          fact as (typeof REGIONAL_OBLIGATION_IDS)[number],
        ),
    );
    if (questId === "eyes-in-the-mist") obligations.push("mistveil_nyra_truth");
    if (questId === "the-lions-offer")
      obligations.push("sunmane_tribute_ended");
    if (questId === "a-mothers-roar")
      obligations.push("bamboo_tali_safe", "bamboo_snare_source");
    if (obligations.length) {
      const regionalObligations = {
        ...this.campaign.world.regionalObligations,
      };
      for (const obligation of obligations)
        regionalObligations[obligation] = true;
      this.campaign = {
        ...this.campaign,
        world: { ...this.campaign.world, regionalObligations },
      };
    }
    if (questId === "the-mire-maw") {
      this.campaign = {
        ...this.campaign,
        world: {
          ...this.campaign.world,
          regions: {
            ...this.campaign.world.regions,
            "mistveil-basin": "restored",
          },
        },
      };
      applyRestorationBooleans(this.facts, "mistveil-basin", "restored");
      this.facts.mistveil_restored = true;
    }
    if (questId === "river-of-black-sap") {
      this.facts["side:river-flood-detour"] = this.choices["river-route"] === "break-dam";
      this.facts["side:river-bank-open"] = this.choices["river-route"] === "repair";
    }
    if (questId === "orun-the-hollow-king") {
      this.campaign = {
        ...this.campaign,
        world: { ...this.campaign.world, hollowReady: true },
      };
    }
  }

  private applyChoice(
    campaign: CampaignState,
    choice: string,
    option: string,
    leaderId: string | undefined,
    facts: Record<string, boolean | number | string>,
  ): CampaignState {
    if (choice === "pack-leadership") {
      if (option === "ruun" || option === "luma") {
        campaign = setPackLeader(campaign, option);
        campaign = {
          ...campaign,
          world: {
            ...campaign.world,
            regionalObligations: {
              ...campaign.world.regionalObligations,
              moonpine_settlement: true,
            },
          },
        };
      }
      if (option === "dominion-ruun" || option === "dominion-luma") {
        campaign = setPackLeader(
          campaign,
          (leaderId ?? "ruun") as "ruun" | "luma",
        );
      }
    }
    if (choice === "sunmane-resolution") {
      if (option === "bond") {
        facts.sunmane_tribute_ended = true;
        facts.sunmane_voluntary_governance = true;
        campaign = this.markWilling(campaign, "crown");
        campaign = {
          ...campaign,
          world: {
            ...campaign.world,
            regionalObligations: {
              ...campaign.world.regionalObligations,
              sunmane_tribute_ended: true,
              sunmane_voluntary_governance: true,
            },
          },
        };
      } else if (option === "exile") {
        const crown = campaign.world.factions.crown;
        campaign = {
          ...campaign,
          world: {
            ...campaign.world,
            factions: {
              ...campaign.world.factions,
              crown: {
                ...crown,
                leaderStatus: "exiled",
                representative: {
                  id: "solkar",
                  source: "leader",
                  present: false,
                  willing: false,
                },
              },
            },
          },
        };
        campaign = setCrownCouncilRepresentation(campaign, false);
        facts.sunmane_tribute_ended = true;
        facts.sunmane_voluntary_governance = true;
        campaign = {
          ...campaign,
          world: {
            ...campaign.world,
            regionalObligations: {
              ...campaign.world.regionalObligations,
              sunmane_tribute_ended: true,
              sunmane_voluntary_governance: true,
            },
          },
        };
      } else if (option === "dominion") {
        facts.sunmane_tribute_ended = true;
        campaign = {
          ...campaign,
          world: {
            ...campaign.world,
            regionalObligations: {
              ...campaign.world.regionalObligations,
              sunmane_tribute_ended: true,
            },
          },
        };
      }
    }
    if (choice === "faction-covenant") {
      const faction = option as FactionId;
      const eligible: Record<FactionId, boolean> = {
        sky: campaign.world.fragments.includes("heartroot-sky"),
        canopy:
          campaign.world.regionalObligations.canopy_water_seed_accord &&
          campaign.world.fragments.includes("heartroot-canopy"),
        fang:
          campaign.world.regionalObligations.bamboo_tali_safe &&
          campaign.world.regionalObligations.bamboo_snare_source &&
          campaign.world.fragments.includes("heartroot-fang"),
        pack:
          campaign.world.regionalObligations.moonpine_settlement &&
          campaign.world.fragments.includes("heartroot-pack"),
        shadow:
          campaign.world.regionalObligations.mistveil_river_source &&
          campaign.world.regionalObligations.mistveil_nyra_truth &&
          campaign.world.fragments.includes("heartroot-shadow"),
        crown:
          campaign.world.regionalObligations.sunmane_voluntary_governance &&
          campaign.world.fragments.includes("heartroot-crown"),
      };
      if (!eligible[faction])
        throw new CampaignChoiceRejectedError(
          choice, option,
          "This faction covenant is not available until its story commitments are fulfilled.",
        );
      // A covenant records willingness, not a return of an absent representative.
      // In particular, it must not overturn the council's committed refusal.
      const current = campaign.world.factions[faction];
      campaign = {
        ...campaign,
        world: {
          ...campaign.world,
          factions: {
            ...campaign.world.factions,
            [faction]: {
              ...current,
              bondTier: 3,
              representative: {
                ...current.representative,
                willing: current.representative.present &&
                  !(faction === "crown" && this.choices["crown-council"] === "decline"),
              },
            },
          },
        },
      };
    }
    if (
      choice === "chapter-seven-commitment" &&
      option in campaign.world.renewedCommitments
    ) {
      const faction = option as FactionId;
      campaign = {
        ...campaign,
        world: {
          ...campaign.world,
          renewedCommitments: {
            ...campaign.world.renewedCommitments,
            [faction]: true,
          },
        },
      };
    }
    if (choice === "wild-march-formation") {
      facts.wildMarchFormed = true;
      // Derive the Hollow route unlock fact from the authorized formation choice. The Wild March forms the coalition
      // route with whichever factions agreed to march (the others may decline without blocking formation), so Hollow
      // opens only after the player has chosen the formation option. We do not open Hollow based on chapter number
      // alone; the route-side unlockFact gate (`hollow-opening`) holds the path closed until this fact flips.
      facts["hollow-opening"] = true;
    }
    if (choice === "river-route") facts["riverRoute:" + option] = true;
    if (choice === "marek-fate") {
      campaign = {
        ...campaign,
        world: { ...campaign.world, marekPresent: option === "cleanse" },
      };
      facts.marekPresent = option === "cleanse";
    }
    if (choice === "crown-council")
      campaign = setCrownCouncilRepresentation(campaign, option === "willing");
    if (choice === "chapter-six-response") {
      facts.askSignal = true;
      facts.wardenResponse = option;
    }
    if (choice === "final-ending" && option === "living_pact")
      facts.circleOfTheWild = true;
    return campaign;
  }

  private validateChoice(
    choiceId: string,
    optionId: string,
    campaign: CampaignState,
  ): boolean {
    const pact = pactForChoice(choiceId);
    const optionIds: readonly string[] | undefined = pact
      ? PACT_OPTION_IDS
      : this.choiceCatalog[choiceId]?.map((option) => option.id);
    if (!optionIds || !optionIds.includes(optionId))
      throw new CampaignChoiceRejectedError(choiceId, optionId, "Unknown campaign choice or option.");
    // Most choices settle one outcome. These two are authored once per faction.
    const factionScoped =
      choiceId === "faction-covenant" ||
      choiceId === "chapter-seven-commitment";
    const faction = optionId.replace(/^decline-/, "");
    const prior = this.eventLog.find(
      (event) =>
        event.type === "choice" &&
        event.choiceId === choiceId &&
        (!factionScoped || event.optionId.replace(/^decline-/, "") === faction),
    );
    const committed = prior?.type === "choice"
      ? prior.optionId
      : factionScoped ? undefined : this.choices[choiceId];
    if (committed !== undefined) {
      if (committed !== optionId)
        throw new CampaignChoiceRejectedError(choiceId, optionId, "This campaign choice already has a committed resolution.");
      return true;
    }
    if (choiceId === "solkar-listens") {
      if (this.facts["quest:a-king-without-subjects:accepted"] !== true
        || this.facts["interaction:a-king-without-subjects-evidence"] !== true
        || this.choices["sunmane-resolution"] === undefined)
        throw new CampaignChoiceRejectedError(choiceId, optionId, "Examine the refusal after settling Sunmane's governance.");
      const crown = campaign.world.factions.crown;
      if (optionId === "listen" && (crown.leaderId !== "solkar" || crown.leaderStatus !== "active" || this.facts.solkarPresent === false))
        throw new CampaignChoiceRejectedError(choiceId, optionId, "Absent or exiled Solkar cannot hear the refusal; use council mediation.");
    }
    if (pact) {
      if (this.chapter !== pact.chapter)
        throw new CampaignChoiceRejectedError(choiceId, optionId, "This pact is only decided in its own chapter.");
      if (!this.eventLog.some((event) => event.type === "encounter-resolved" && eventMatches("encounter:" + pact.encounterId, event)))
        throw new CampaignChoiceRejectedError(choiceId, optionId, "The pact is not available until the guardian has been cleansed.");
      if (!campaign.world.companions[pact.companionId].recruited)
        throw new CampaignChoiceRejectedError(choiceId, optionId, "The pact requires a recruited companion.");
    }
    if (
      choiceId === "sunmane-resolution" &&
      campaign.world.factions.crown.leaderStatus === "exiled" &&
      optionId !== "exile"
    ) {
      throw new CampaignChoiceRejectedError(choiceId, optionId, "Exiled Solkar cannot return through a new resolution.");
    }
     if (choiceId === "chapter-six-response") {
       if (this.chapter !== 6)
         throw new CampaignChoiceRejectedError(choiceId, optionId, "Ask or Signal is only available in Chapter 6.");
       // The Fall must be completed in fact, not just by chapter entry. Gameplay author and emit
       // `grove-collapse-escape` after possessed-ally protection, Tali safety, and pillar resolution; that event
       // transactionally sets `refugeOpen=true` and `wardenCall=false`. Until then the player cannot decide between
       // Ask and Signal (the Call is still on, there is nothing voluntary to choose yet).
       const fallCompleted = this.facts.refugeOpen === true && this.facts.wardenCall === false;
       if (!fallCompleted)
         throw new CampaignChoiceRejectedError(choiceId, optionId, "The Warden Call must be severed by completing the Grove before Ask or Signal.");
     }
    if (
      choiceId === "final-ending" &&
      optionId === "living_pact" &&
      !evaluateEnding(campaign).available
    ) {
      throw new CampaignChoiceRejectedError(choiceId, optionId, "Living Pact requirements are not met for this run.");
    }
    if (
      choiceId === "final-ending" &&
      !this.eventLog.some(
        (event) =>
          event.type === "encounter-resolved" &&
          eventMatches("encounter:encounter-orun", event),
      )
    ) {
      throw new CampaignChoiceRejectedError(choiceId, optionId, "Orun must be resolved before the final choice.");
    }
    if (
      choiceId === "wild-march-formation" &&
      !this.completedObjectiveIds.includes(
        "wild-march:commitments" as ObjectiveId,
      )
    ) {
      throw new CampaignChoiceRejectedError(
        choiceId, optionId,
        "Each faction must receive a Chapter 7 choice before the coalition route is formed.",
      );
    }
    if (choiceId === "faction-covenant" && this.chapter < 1)
      throw new CampaignChoiceRejectedError(
        choiceId, optionId,
        "Faction covenants are not available before regional commitments.",
      );
    if (choiceId === "sunmane-resolution" && this.chapter !== 5)
      throw new CampaignChoiceRejectedError(choiceId, optionId, "Sunmane governance is only decided in Chapter 5.");
    if (choiceId === "pack-leadership" && this.chapter !== 3)
      throw new CampaignChoiceRejectedError(choiceId, optionId, "Pack leadership is only decided in Chapter 3.");
    const guardian = choiceId === "pack-leadership" ? "encounter-ruun" : choiceId === "sunmane-resolution" ? "encounter-solkar" : undefined;
    if (guardian && !this.eventLog.some(event => event.type === "encounter-resolved" && event.encounterId === guardian && event.resolution === "cleansed"))
      throw new CampaignChoiceRejectedError(choiceId, optionId, "The guardian must be cleansed before deciding regional leadership.");
    if (choiceId === "marek-fate" && this.chapter !== 4)
      throw new CampaignChoiceRejectedError(choiceId, optionId, "Marek’s fate is only decided in Chapter 4.");
    if (choiceId === "chapter-seven-commitment" && this.chapter !== 7)
      throw new CampaignChoiceRejectedError(choiceId, optionId, "Faction recommitments are only available in Chapter 7.");
    return false;
  }

  private markWilling(
    campaign: CampaignState,
    faction: FactionId,
  ): CampaignState {
    const current = campaign.world.factions[faction];
    return {
      ...campaign,
      world: {
        ...campaign.world,
        factions: {
          ...campaign.world.factions,
          [faction]: {
            ...current,
            representative: {
              ...current.representative,
              present: true,
              willing: true,
            },
          },
        },
      },
    };
  }

  private ensureChapterQuest(chapter: number): void {
    if (
      this.activeQuestIds.some(
        (id) => QUESTS.find((quest) => quest.id === id)?.chapter === chapter,
      )
    )
      return;
    const sequence =
      CHAPTERS.find((item) => item.number === chapter)?.questIds ?? [];
    const nextQuestId = sequence.find((id) => {
      const quest = QUESTS.find((item) => item.id === id);
      return Boolean(
        quest && !quest.optional && !this.completedQuestIds.includes(id),
      );
    });
    if (nextQuestId) this.activeQuestIds.push(nextQuestId);
  }

  private publish(): CampaignSnapshot {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
    return snapshot;
  }
}

function cloneEvent(event: WorldEvent): WorldEvent {
  return structuredClone(event);
}

function mergeHistory(
  existing: CampaignState["dominionHistory"],
  incoming: CampaignState["dominionHistory"],
): CampaignState["dominionHistory"] {
  const merged = existing.map((event) => ({ ...event }));
  for (const event of incoming) {
    if (
      merged.some(
        (saved) =>
          saved.sequence === event.sequence &&
          saved.leaderId === event.leaderId,
      )
    )
      continue;
    merged.push({ ...event, sequence: (merged.at(-1)?.sequence ?? 0) + 1 });
  }
  return merged;
}
