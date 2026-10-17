export const HUB_UPGRADES = [
  {
    id: "root-resilience",
    title: "Root Resilience",
    description: "Increase maximum Vitality by 20.",
    requiredQuestId: "a-mothers-roar",
    requiredFact: null,
    requirement: "Complete A Mother's Roar, then train at the Grove or Refuge.",
    fact: "upgrade:root-resilience",
    vitalityBonus: 20,
    manaBonus: 0,
    counterWindowBonusTicks: 0,
  },
  {
    id: "trail-reserves",
    title: "Trail Reserves",
    description: "Increase maximum Mana by 20. Movement still restores Mana; waiting does not.",
    requiredQuestId: "winter-stores",
    requiredFact: "side:winter-cache",
    requirement: "Complete Winter Stores, then train at the Grove or Refuge.",
    fact: "upgrade:trail-reserves",
    vitalityBonus: 0,
    manaBonus: 20,
    counterWindowBonusTicks: 0,
  },
  {
    id: "counter-discipline",
    title: "Counter Discipline",
    description: "Keep the counter opportunity open for 0.2 seconds longer after a Perfect Dodge.",
    requiredQuestId: "the-silent-hunter",
    requiredFact: "side:protected-corridor",
    requirement: "Complete The Silent Hunter, then train at the Grove or Refuge.",
    fact: "upgrade:counter-discipline",
    vitalityBonus: 0,
    manaBonus: 0,
    counterWindowBonusTicks: 12,
  },
] as const;

export const HUB_REGION_IDS = ["the-grove", "refuge"] as const;
export const HUB_SERVICE_INTERACTION_IDS = ["grove-yara-tent", "grove-training", "refuge-training"] as const;
