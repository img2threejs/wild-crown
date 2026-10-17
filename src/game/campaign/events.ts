import type { ActorId, WorldEvent } from "../contracts.js";
import { REGIONS } from "../../content/campaign.js";

/**
 * The objective/requirement event grammar: `kind:target[:option]`, with `|` separating alternatives.
 * `rescue:<targetId>[:<locationId>]` optionally pins the rescue location. One definition shared by objective completion,
 * relationship rules, pact prerequisites and save migration.
 */
export function eventMatches(requirement: string, event: WorldEvent): boolean {
  if (requirement.includes("|")) {
    return requirement
      .split("|")
      .some((alternative) => eventMatches(alternative, event));
  }
  const [kind, target, option] = requirement.split(":");
  switch (event.type) {
    case "semantic-interaction":
      return (
        (kind === "tend" &&
          event.kind === "tend" &&
          event.targetId === target) ||
        (kind === "semantic" &&
          (event.interactionId === target || event.targetId === target)) ||
        (kind === "interaction" && event.interactionId === target) ||
        (kind === "investigate" &&
          event.kind === "inspect" &&
          event.targetId === target) ||
        (kind === "ecology" &&
          ["repair", "restore", "cleanse", "coordinate", "break"].includes(
            event.kind,
          ) &&
          event.targetId === target) ||
        (kind === "coordinate" &&
          event.kind === "coordinate" &&
          event.targetId === target)
      );
    case "encounter-phase":
      return (
        kind === "encounter" &&
        event.phaseId === target &&
        event.state === "cleared"
      );
    case "encounter-resolved": {
      let expectedParticipants: readonly ActorId[] | undefined;
      if (target !== undefined) {
        for (const region of REGIONS) {
          expectedParticipants = region.encounterParticipants[target];
          if (expectedParticipants) break;
        }
      }
      return (
        kind === "encounter" &&
        event.encounterId === target &&
        (event.resolution === "cleansed" ||
          (target === "camp-hunters" && event.resolution === "subdued") ||
          (target === "encounter-fall" && event.resolution === "escaped")) &&
        (!expectedParticipants ||
          expectedParticipants.every((actorId) => event.actorIds.includes(actorId)))
      );
    }
    case "rescue":
      return (
        (kind === "rescue" && event.targetId === target && event.safe && (!option || event.locationId === option)) ||
        (kind === "tend" && event.targetId === target && event.safe)
      );
    case "restoration":
      return (
        kind === "restoration" &&
        event.regionId === target &&
        event.state === "restored"
      );
    case "fragment":
      return kind === "fragment" && event.fragmentId === target;
    case "choice":
      return (
        kind === "choice" &&
        event.choiceId === target &&
        (!option || event.optionId === option)
      );
    case "traversal":
      return kind === "traversal" && event.routeId === target;
    case "chapter-transition":
      return kind === "chapter" && event.toChapter === Number(target);
    default:
      return false;
  }
}
