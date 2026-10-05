export { CampaignDirector, CampaignChoiceRejectedError } from "./CampaignDirector.js";
export type { CampaignDirectorOptions } from "./CampaignDirector.js";
export {
  SaveRepository,
  SaveRepositoryError,
  SAVE_DATABASE_NAME,
  SAVE_DATABASE_VERSION,
  SAVE_FORMAT_SCHEMA_VERSION,
} from "../storage/SaveRepository.js";
export type {
  GameSaveEnvelope,
  CampaignProgressRecord,
  SaveErrorCode,
  SaveSettingsRecord,
  SaveSlotRecord,
  SaveSlotSummary,
} from "../storage/SaveRepository.js";
export {
  QUESTS,
  REGIONS,
  REGION_PROP_PLACEMENTS,
  REGION_AUTHORING_STATUS,
  DIALOGUE,
  CAMPAIGN_CHOICES,
  COMPANION_COPY,
  CANONICAL_CAMPAIGN_IDS,
  ACTORS,
  ENVIRONMENT_RECIPES,
  INTERACTIONS,
  SETTINGS_COPY,
} from "../../content/campaign.js";
export {
  CHAPTERS,
  ALL_QUESTS,
  ABSENCE_HISTORY_VARIANTS,
  BRANCH_HISTORIES,
  ENDINGS,
  RETURN_BEATS,
  STORY_DIALOGUE,
} from "../../content/story.js";
export type { BranchHistory, ChapterDefinition } from "../../content/story.js";
