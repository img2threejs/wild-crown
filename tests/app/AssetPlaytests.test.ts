import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { AssetGateError, assertCandidateEntry } from '../../src/app/AssetGate.js';
import enemySources from '../../asset-source/animation/enemy-attack-sources.json';
import { CANOPY_PLAYTEST, GREENWAKE_PLAYTEST, assetPlaytestFromSearch, type AssetPlaytest } from '../../src/app/AssetPlaytests.js';
import { GameApplication } from '../../src/app/GameApplication.js';
import { PRODUCTION_SESSION, trialsSession } from '../../src/app/SessionConfig.js';
import { appDefaults } from './fakeApp.js';
import { ENVIRONMENT_RECIPES, REGIONS } from '../../src/content/campaign.js';
import { CampaignDirector } from '../../src/game/campaign/CampaignDirector.js';
import { CombatEngine } from '../../src/game/combat/CombatEngine.js';
import { TRIAL_GATE_ASSET_ID } from '../../src/game/combat/CombatTrials.js';
import { createCombatTrialRegion } from '../../src/game/combat/TrialRegions.js';
import { WARDEN_WEAPON_ASSET_ID } from '../../src/rendering/WardenWeapon.js';
import { createFakeAppAudio } from './fakeAppAudio.js';
import { HEROES, HEARTROOT_STAFF_ASSET_ID, SAKDA_HERO_ASSET_ID, VESPER_HERO_ASSET_ID, VESPER_KATANA_ASSET_ID, YARA_HERO_ASSET_ID } from '../../src/game/heroes.js';
import { WAYSTONE_ASSET_ID } from '../../src/rendering/WaystoneVisual.js';
import type { AssetManifestEntry, EnvironmentRecipeDefinition, RegionDefinition } from '../../src/game/contracts.js';

type AppFields = Record<string, any>;
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const authoredRegion = (id: string) => REGIONS.find(region => region.id === id)!;
const playtestRegion = (playtest: AssetPlaytest): RegionDefinition => createCombatTrialRegion(authoredRegion(playtest.regionId));
const bareApp = (fields: AppFields): AppFields => Object.assign(Object.create(GameApplication.prototype), appDefaults(), fields);
const sessionOf = (playtest: AssetPlaytest | null) => playtest ? trialsSession(playtest.id) : PRODUCTION_SESSION;

describe('?assetPlaytest selection', () => {
  it('opens the selector for any assetPlaytest query and leaves ordinary URLs in campaign mode', () => {
    expect(assetPlaytestFromSearch('?assetPlaytest=greenwake')).toBe(GREENWAKE_PLAYTEST);
    expect(assetPlaytestFromSearch('?foo=1&assetPlaytest=canopy')).toBe(CANOPY_PLAYTEST);
    for (const search of ['', '?', '?other=canopy']) expect(assetPlaytestFromSearch(search)).toBeNull();
    for (const search of ['?assetPlaytest=', '?assetPlaytest=whispering-canopy', '?assetPlaytest=Canopy']) expect(assetPlaytestFromSearch(search)).toBe(GREENWAKE_PLAYTEST);
  });


  it('starts New Game directly in the canopy through a replay-isolated run, and in Greenwake through the regular run', () => {
    const director = new CampaignDirector({ runId: 'selection' });
    expect(director.startNewRun('selection-greenwake').regionId).toBe('greenwake');
    const direct = director.startShowcase('selection-canopy');
    expect(direct.regionId).toBe('whispering-canopy');
    expect(direct.regionId).toBe(CANOPY_PLAYTEST.regionId);
  });
});

describe('playtest manifest requests', () => {
  it('fetches the manifest of the selected playtest, and the production manifest otherwise', async () => {
    const requested: string[] = [];
    globalThis.fetch = (async (url: string) => { requested.push(url); return new Response('[]', { status: 200 }); }) as unknown as typeof fetch;
    for (const playtest of [GREENWAKE_PLAYTEST, CANOPY_PLAYTEST, null]) await bareApp({ session: sessionOf(playtest) }).readManifest();
    expect(requested).toEqual(['/asset-source/playtests/greenwake.json', '/asset-source/playtests/canopy.json', '/assets/manifest.json']);
  });

  it('names the playtest in the gate error when its manifest is missing', async () => {
    globalThis.fetch = (async () => new Response('missing', { status: 404 })) as unknown as typeof fetch;
    await expect(bareApp({ session: sessionOf(CANOPY_PLAYTEST) }).readManifest()).rejects.toThrow('Whispering Canopy candidate asset playtest manifest /asset-source/playtests/canopy.json is unavailable (HTTP 404).');
  });
});

/** A playtest manifest in the exact shape the gate demands for `region`: native unverified GLBs plus the composed environment recipe. */
function playtestManifest(region: RegionDefinition): AssetManifestEntry[] {
  const hash = 'a'.repeat(64), props = [...new Set(region.props.map(prop => prop.assetId))];
  const actors = [...new Set(region.entities.filter(entity => entity.actorId).map(entity => entity.assetId!)), 'actor-aren'];
  const native = (id: string, kind: 'prop' | 'character'): AssetManifestEntry => ({
    id, kind, sourceType: 'native-glb', lodIds: [], sockets: [], requiredActionIds: [], actionToClipMapping: {}, provenance: 'test fixture', evidenceStatus: 'blocked',
    runtimeUrl: `/asset-source/generated/${id}/runtime.glb`, outputHash: hash, ...(kind === 'character' ? { actorId: id.replace('actor-', '') } : {}),
  });
  return [
    { id: region.environmentRecipeId, kind: 'environment', sourceType: 'composed-recipe', lodIds: [], sockets: [], requiredActionIds: [], actionToClipMapping: {}, provenance: 'test fixture', evidenceStatus: 'blocked', componentAssetIds: props, proceduralRecipeId: region.environmentRecipeId },
    // Weapons exist only for armed heroes (Aren glaive, Yara staff, Vesper katana); Sakda fights unarmed.
    ...[...props, TRIAL_GATE_ASSET_ID, WAYSTONE_ASSET_ID, WARDEN_WEAPON_ASSET_ID, HEARTROOT_STAFF_ASSET_ID, VESPER_KATANA_ASSET_ID].map(id => native(id, 'prop')),
    ...actors.map(id => native(id, 'character')),
    ...[YARA_HERO_ASSET_ID, VESPER_HERO_ASSET_ID, SAKDA_HERO_ASSET_ID].map(id => ({ ...native(id, 'character'), actorId: 'aren', variantOf: 'actor-aren' })),
  ];
}
function recipeFor(region: RegionDefinition): EnvironmentRecipeDefinition {
  const authored = ENVIRONMENT_RECIPES.find(item => item.id === region.environmentRecipeId)!;
  return { ...authored, assetPlacementIds: region.props.map(prop => prop.id), groundSurfaceIds: region.ground.surfaces.map(surface => surface.id) };
}

describe('per-region playtest asset gate', () => {
  for (const playtest of [GREENWAKE_PLAYTEST, CANOPY_PLAYTEST]) {
    it(`${playtest.name}: rejects a missing dependency, an extra asset, a verified asset and a non-native prop`, () => {
      const region = playtestRegion(playtest), run = (manifest: AssetManifestEntry[]) => () => bareApp({ session: sessionOf(playtest) }).assertAssets(region, manifest, recipeFor(region));
      const full = playtestManifest(region);
      expect(run(full.filter(entry => entry.id !== WARDEN_WEAPON_ASSET_ID))).toThrow(playtest.name + ' candidate playtest manifest must contain exactly');
      expect(run(full.filter(entry => entry.id !== WAYSTONE_ASSET_ID))).toThrow(playtest.name + ' candidate playtest manifest must contain exactly');
      expect(run([...full, { ...full[1]!, id: 'prop-unrelated' }])).toThrow('must contain exactly');
      expect(run(full.map(entry => entry.id === TRIAL_GATE_ASSET_ID ? { ...entry, evidenceStatus: 'verified' as const } : entry))).toThrow('must remain explicitly unverified');
      expect(run(full.map(entry => entry.id === TRIAL_GATE_ASSET_ID ? { ...entry, sourceType: 'procedural' as const } : entry))).toThrow('must be a native prop GLB');
    });
  }

  it('refuses a region that does not belong to the selected playtest', () => {
    const canopy = playtestRegion(CANOPY_PLAYTEST), greenwake = playtestRegion(GREENWAKE_PLAYTEST);
    expect(() => bareApp({ session: sessionOf(GREENWAKE_PLAYTEST) }).assertAssets(canopy, playtestManifest(canopy), recipeFor(canopy))).toThrow('only supports Greenwake');
    expect(() => bareApp({ session: sessionOf(CANOPY_PLAYTEST) }).assertAssets(greenwake, playtestManifest(greenwake), recipeFor(greenwake))).toThrow('only supports Whispering Canopy');
  });

  it('keeps the production gate closed to playtest animations and unverified assets when no playtest is selected', () => {
    const region = authoredRegion('blood-bamboo-valley'), recipe = ENVIRONMENT_RECIPES.find(item => item.id === region.environmentRecipeId)!;
    const manifest = playtestManifest(playtestRegion(CANOPY_PLAYTEST));
    expect(() => bareApp({ session: PRODUCTION_SESSION }).assertAssets(region, manifest, recipe)).toThrow();
  });

  it('requires every armed hero\u2019s weapon and every hero variant, and never a weapon for the unarmed hero', () => {
    const playtest = GREENWAKE_PLAYTEST, region = playtestRegion(playtest), full = playtestManifest(region);
    const run = (manifest: AssetManifestEntry[]) => () => bareApp({ session: sessionOf(playtest) }).assertAssets(region, manifest, recipeFor(region));
    expect(run(full)).not.toThrow();
    expect(HEROES.map(hero => hero.id)).toEqual(['aren', 'yara', 'vesper', 'sakda']);
    expect(HEROES.filter(hero => !hero.weaponAssetId).map(hero => hero.id)).toEqual(['sakda']);
    expect(run(full.filter(entry => entry.id !== VESPER_KATANA_ASSET_ID))).toThrow('must contain exactly');
    expect(run(full.filter(entry => entry.id !== VESPER_HERO_ASSET_ID))).toThrow('must contain exactly');
    expect(run(full.filter(entry => entry.id !== SAKDA_HERO_ASSET_ID))).toThrow('must contain exactly');
    expect(run([...full, { ...full[1]!, id: 'prop-sakda-weapon' }])).toThrow('must contain exactly');
  });

  it('builds the canopy variant for the recipe with matching placement and surface ids', () => {
    const region = playtestRegion(CANOPY_PLAYTEST), recipe = recipeFor(region);
    expect(recipe.id).toBe('whispering-canopy-environment');
    expect(recipe.regionId).toBe('whispering-canopy');
    expect(recipe.assetPlacementIds.slice().sort()).toEqual(region.props.map(prop => prop.id).sort());
    expect(recipe.groundSurfaceIds).toHaveLength(9);
  });

  it('loads authored native clip contracts without admitting unmapped clips or claiming release verification', () => {
    const entries = new Map<string, AssetManifestEntry>();
    for (const map of ['greenwake', 'canopy', 'grove', 'moonpine', 'mistveil', 'bamboo', 'later']) {
      const manifest = JSON.parse(readFileSync(new URL(`../../asset-source/playtests/${map}.json`, import.meta.url), 'utf8')) as AssetManifestEntry[];
      for (const entry of manifest) entries.set(entry.id, entry);
    }
    for (const assetId of Object.keys(enemySources.nativeSources)) {
      const entry = entries.get(assetId)!;
      assertCandidateEntry(entry, 'character', 'native attack');
      const action = entry.requiredActionIds[0]!, missingMapping = { ...entry.actionToClipMapping, [action]: null };
      expect(() => assertCandidateEntry({ ...entry, actionToClipMapping: missingMapping }, 'character', 'native attack')).toThrow(AssetGateError);
      expect(() => assertCandidateEntry({ ...entry, evidenceStatus: 'verified' }, 'character', 'native attack')).toThrow(AssetGateError);
    }
  });
});

/** An application whose world is loaded from the playtest variant exactly like prepareWorld does, ready to start its encounter. */
function readyApp(playtest: AssetPlaytest | null, regionId: string) {
  const region = playtest ? playtestRegion(playtest) : authoredRegion(regionId);
  const director = new CampaignDirector({ runId: 'encounter-start' });
  const campaign = regionId === 'whispering-canopy' ? director.startShowcase('encounter-start') : director.snapshot();
  const combat = new CombatEngine();
  combat.loadRegion({ regionId: region.id, regionDefinition: region, runId: campaign.runId, presentActorIds: region.entities.filter(entity => entity.actorId && region.id === 'whispering-canopy').map(entity => entity.id) });
  const calls: string[] = [];
  const input = { enabled: true, clear() {}, setEnabled(value: boolean) { this.enabled = value; } };
  const app = bareApp({
    session: sessionOf(playtest), region, campaign, combat, input, screen: 'loading', screenHistory: [], worldReady: true, ready: true, disposed: false, suspended: false,
    loading: { active: false }, error: null, sceneBlocked: false, stageCompleted: false, playerOutcome: null, activeCompanionId: undefined, lifecycleGeneration: 0, worldGeneration: 0,
    renderer: { async prepareCombatTrialGates() { calls.push('gates'); }, sync() {}, render() {} }, render() {},
  });
  return { app, combat, calls };
}

describe('starting the playtest encounter', () => {
  it('starts the canopy trial encounter with trials enabled, once', async () => {
    const { app, combat, calls } = readyApp(CANOPY_PLAYTEST, 'whispering-canopy');
    await app.startWildlifeEncounterIfReady();
    const snapshot = combat.snapshot();
    expect(snapshot.encounterId).toBe('canopy-trials');
    expect(snapshot.encounterStatus!.trial).toMatchObject({ stage: 1, totalStages: 3, complete: false });
    expect(snapshot.encounterStatus!.monsters.map(monster => monster.id)).toEqual(['canopy-howler', 'canopy-hornbill', 'canopy-mire-viper']);
    expect(snapshot.trialGates!.map(gate => gate.id)).toEqual(['howler-pool', 'hornbill-roost', 'viper-temple']);
    expect(snapshot.actors.find(actor => actor.id === 'aren')!.position).toEqual({ x: -58, y: 0, z: -20 });
    expect(app.screen).toBe('game');
    expect(calls).toEqual(['gates']);
    await app.startWildlifeEncounterIfReady();
    expect(calls).toEqual(['gates']);
    expect(combat.snapshot().encounterStatus!.trial!.stage).toBe(1);
  });

  it('starts the Greenwake encounter exactly as before', async () => {
    const { app, combat, calls } = readyApp(GREENWAKE_PLAYTEST, 'greenwake');
    await app.startWildlifeEncounterIfReady();
    const snapshot = combat.snapshot();
    expect(snapshot.encounterId).toBe('greenwake-boar');
    expect(snapshot.encounterStatus!.trial).toMatchObject({ stage: 1, totalStages: 3 });
    expect(snapshot.trialGates!.map(gate => gate.id)).toEqual(['ember-crossing', 'frost-hollow', 'root-watch']);
    expect(calls).toEqual(['gates']);
  });

  it('does not start trials in the canopy of the regular game', async () => {
    const { app, combat, calls } = readyApp(null, 'whispering-canopy');
    await app.startWildlifeEncounterIfReady();
    expect(combat.snapshot().encounterId).toBeUndefined();
    expect(calls).toEqual([]);
  });
});
