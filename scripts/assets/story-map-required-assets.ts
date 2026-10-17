// Derives, from the real authored regions, exactly what the DEV asset playtest gate (src/app/GameApplication.ts, "required" set)
// demands of each story map's candidate manifest: the composed environment recipe, every region prop asset, every entity asset,
// the shared trial gate, every hero weapon that exists (an unarmed hero has none), every hero kit and actor-aren, plus the actor ids the monsters / NPCs are placed under
// (the trial monsterId in src/game/combat/<Map>Content.ts, or the region entity's actorId).
//
// Usage (Bun runs the TypeScript sources directly): bun scripts/assets/story-map-required-assets.ts [grove|moonpine|mistveil ...]
// Prints one JSON object keyed by map id. scripts/assets/build-story-map-manifest.mjs calls this script.
import { ACTORS } from '../../src/content/campaign.js';
import { REGIONS } from '../../src/game/campaign/index.js';
import { createCombatTrialRegion } from '../../src/game/combat/TrialRegions.js';
import { TRIAL_GATE_ASSET_ID } from '../../src/game/combat/CombatTrials.js';
import { GROVE_TRIAL_SET } from '../../src/game/combat/GroveContent.js';
import { MISTVEIL_TRIAL_SET } from '../../src/game/combat/MistveilContent.js';
import { MOONPINE_TRIAL_SET } from '../../src/game/combat/MoonpineContent.js';
import { HEROES } from '../../src/game/heroes.js';
import { WAYSTONE_ASSET_ID } from '../../src/rendering/WaystoneVisual.js';

const MAPS = {
  grove: { regionId: 'the-grove', trials: GROVE_TRIAL_SET.trials },
  moonpine: { regionId: 'moonpine-ridge', trials: MOONPINE_TRIAL_SET.trials },
  mistveil: { regionId: 'mistveil-basin', trials: MISTVEIL_TRIAL_SET.trials },
} as const;

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(MAPS);
const out: Record<string, unknown> = {};
for (const map of wanted) {
  const config = (MAPS as Record<string, (typeof MAPS)[keyof typeof MAPS]>)[map];
  if (!config) throw new Error(`Unknown story map ${map}`);
  const authored = REGIONS.find(region => region.id === config.regionId);
  if (!authored) throw new Error(`No authored region ${config.regionId}`);
  // The gate is evaluated per hero: a hero's NPC twin is filtered out of the variant, so the sets must agree across heroes.
  const perHero = HEROES.map(hero => {
    const region = createCombatTrialRegion(authored, hero.id);
    const entities = region.entities.filter(entity => entity.actorId).map(entity => ({ actorId: entity.actorId as string, assetId: (entity.assetId ?? ACTORS[entity.actorId as keyof typeof ACTORS]?.assetId) as string }));
    const required = new Set<string>([region.environmentRecipeId, ...region.props.map(prop => prop.assetId), ...entities.map(entity => entity.assetId).filter(Boolean), ACTORS.aren?.assetId ?? 'actor-aren']);
    for (const id of [TRIAL_GATE_ASSET_ID, WAYSTONE_ASSET_ID, ...HEROES.flatMap(other => other.weaponAssetId ? [other.weaponAssetId] : [])]) required.add(id);
    for (const other of HEROES) if (other.variantAssetId) required.add(other.variantAssetId);
    return { hero: hero.id, environmentId: region.environmentRecipeId, componentAssetIds: [...new Set(region.props.map(prop => prop.assetId))].sort(), required: [...required].sort(), entities };
  });
  const first = perHero[0]!;
  for (const other of perHero) if (JSON.stringify(other.required) !== JSON.stringify(first.required)) throw new Error(`${map}: required assets differ between heroes ${first.hero} and ${other.hero}`);
  out[map] = {
    regionId: config.regionId, environmentId: first.environmentId, componentAssetIds: first.componentAssetIds, required: first.required, entities: first.entities,
    trialMonsters: config.trials.map(trial => ({ monsterId: trial.monsterId, assetId: trial.monsterAssetId })),
  };
}
console.log(JSON.stringify(out, null, 2));
