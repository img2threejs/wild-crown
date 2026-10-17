import { ENDINGS } from "../content/story.js";
import type { GameViewModel } from "../game/contracts.js";

/**
 * Authored ending view-model: includes the Grove epilogue line and (for Living Pact) the two-line epilogue so the
 * ending screen and the credits flow surface the full authored ending copy, not just the title and summary.
 */
export interface EndingViewModel extends NonNullable<GameViewModel["ending"]> {
  readonly grove: string;
  readonly lines: readonly string[];
}

export function createEndingViewModel(id: "dominion" | "severance" | "living_pact"): EndingViewModel {
  const ending = ENDINGS[id];
  const livingPact = (ENDINGS as Record<string, unknown>).living_pact;
  const lines = id === "living_pact" && livingPact && typeof livingPact === "object" && "lines" in livingPact
    ? Array.isArray((livingPact as { lines: unknown }).lines) ? (livingPact as { lines: readonly string[] }).lines : []
    : [];
  return {
    id: ending.id,
    title: ending.title,
    summary: ending.summary,
    grove: ending.grove,
    lines,
  };
}