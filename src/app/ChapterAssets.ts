import type { AssetManifestEntry, AssetPolicy, EnvironmentRecipeDefinition, RegionDefinition } from '../game/contracts.js';
import { ACTORS } from '../content/campaign.js';
import { CHAPTER_ASSET_BINDINGS, type CandidateAssetBinding } from '../content/chapter-assets.js';
import { HEROES, heroById, type HeroId } from '../game/heroes.js';
import {
    AssetGateError, PRODUCTION_MANIFEST_URL, assertCandidateEntry, assertRegionComposition, assertVerifiedAssets, fetchManifest, regionAssetIds,
    type Manifest,
} from './AssetGate.js';

const CATALOG_LABEL = 'Candidate chapter asset catalog';

/** Where bindings and catalogs come from; tests inject both, the application uses the authored table and `fetch`. */
export interface ChapterAssetSource {
    readonly bindings: Readonly<Partial<Record<string, readonly CandidateAssetBinding[]>>>;
    fetchManifest(url: string, label: string): Promise<Manifest>;
}
const DEFAULT_SOURCE: ChapterAssetSource = { bindings: CHAPTER_ASSET_BINDINGS, fetchManifest: (url, label) => fetchManifest(url, label) };

/** The hero's Yara-style NPC counterpart cannot meet the player: the NPC entity is removed from the region the run plays. */
export function regionForHero(region: RegionDefinition, heroId: HeroId): RegionDefinition {
    const npcActorId = heroById(heroId).npcActorId;
    return npcActorId ? { ...region, entities: region.entities.filter(entity => entity.actorId !== npcActorId) } : region;
}

/** Hero kit assets the selected hero's run draws: its variant body and weapon prop (the base actor is a region asset). */
function heroKitIds(heroId: HeroId): string[] {
    const hero = heroById(heroId);
    return [...(hero.variantAssetId ? [hero.variantAssetId] : []), ...(hero.weaponAssetId ? [hero.weaponAssetId] : [])];
}

/** The region's own dependencies plus the selected hero's kit, before authored variants are added. */
function baseChapterAssetIds(region: RegionDefinition, heroId: HeroId): Set<string> {
    const base = regionAssetIds(region);
    for (const id of heroKitIds(heroId)) base.add(id);
    const wardenWeapon = heroById('aren').weaponAssetId;
    if (wardenWeapon && region.entities.some(entity => entity.kind === 'actor' && entity.actorId === 'orun')) base.add(wardenWeapon);
    return base;
}

/**
 * Every asset a candidate chapter in `region` needs: the region's own dependencies, the selected hero's kit, and the
 * authored variants (boss bodies, the hero's variant) of any of those assets.
 */
export function requiredChapterAssetIds(region: RegionDefinition, heroId: HeroId, bindings: readonly CandidateAssetBinding[]): Set<string> {
    const required = baseChapterAssetIds(region, heroId);
    const base = new Set(required);
    const otherHeroKits = otherHeroKitIds(heroId);
    for (const binding of bindings) if (binding.variantOf !== undefined && base.has(binding.variantOf) && !otherHeroKits.has(binding.assetId)) required.add(binding.assetId);
    return required;
}

/**
 * The asset id a binding projects to. A catalog entry that is itself a dependency keeps its id (trial monsters carry their
 * own asset ids); an entry rebound to a canonical actor whose canonical asset is the dependency takes that canonical id
 * (the catalog's `actor-camp-hunter-melee` stands behind `actor-poacher-hunter`); a variant keeps its own id.
 */
export function projectedIdOf(binding: CandidateAssetBinding, base: ReadonlySet<string>): string {
    if (binding.variantOf !== undefined || base.has(binding.assetId)) return binding.assetId;
    const canonical = binding.actorId !== undefined ? ACTORS[binding.actorId]?.assetId : undefined;
    return canonical !== undefined && base.has(canonical) ? canonical : binding.assetId;
}

/** Kit assets of the heroes this run did not choose: legitimately present in catalogs, never part of the run's manifest. */
function otherHeroKitIds(heroId: HeroId): Set<string> {
    const own = new Set(heroKitIds(heroId));
    return new Set(HEROES.filter(hero => hero.id !== heroId).flatMap(hero => [hero.variantAssetId, hero.weaponAssetId]).filter((id): id is string => id !== undefined && !own.has(id)));
}

function expectedKindOf(region: RegionDefinition, heroId: HeroId, id: string): 'prop' | 'character' {
    return region.props.some(prop => prop.assetId === id) || heroById(heroId).weaponAssetId === id || heroById('aren').weaponAssetId === id ? 'prop' : 'character';
}

/**
 * Pure projection of candidate catalogs into the exact manifest of one chapter region: explicit canonical actor
 * bindings (catalog `grove-koro`/`bamboo-*` aliases become `koro`/`asha`/...), the composed environment recipe, hash-preserving
 * entries. Rejects unsupported regions, unknown or unneeded bindings, duplicate ids with different hashes, missing
 * required entries, and any verified claim.
 */
export function projectChapterManifest(region: RegionDefinition, heroId: HeroId, catalogs: readonly Manifest[], bindings: readonly CandidateAssetBinding[] | undefined): Manifest {
    if (!bindings || bindings.length === 0) {
        throw new AssetGateError('No candidate chapter asset bindings exist for ' + region.name + '; other regions remain gated by production evidence.');
    }
    const catalog = new Map<string, AssetManifestEntry>();
    for (const entry of catalogs.flat()) {
        const previous = catalog.get(entry.id);
        if (previous && (previous.outputHash !== entry.outputHash || previous.runtimeUrl !== entry.runtimeUrl)) {
            throw new AssetGateError('Candidate catalogs disagree about ' + entry.id + ' (different hash or runtime URL).');
        }
        catalog.set(entry.id, entry);
    }
    const base = baseChapterAssetIds(region, heroId);
    const otherHeroKits = otherHeroKitIds(heroId);
    const bound = new Map<string, { binding: CandidateAssetBinding; entry: AssetManifestEntry }>();
    for (const binding of bindings) {
        const entry = catalog.get(binding.assetId);
        if (!entry) throw new AssetGateError('Candidate chapter binding names unknown asset ' + binding.assetId + '.');
        if (binding.actorId !== undefined && !Object.hasOwn(ACTORS, binding.actorId)) {
            throw new AssetGateError('Candidate chapter binding ' + binding.assetId + ' names unknown canonical actor ' + binding.actorId + '.');
        }
        // Bindings of dependencies this region/hero does not have (another hero's kit, an absent NPC) are simply not part of its manifest.
        if (otherHeroKits.has(binding.assetId) && !base.has(binding.assetId)) continue;
        const id = projectedIdOf(binding, base);
        if (bound.has(id)) throw new AssetGateError('Candidate chapter bindings repeat projected asset ' + id + '.');
        bound.set(id, { binding, entry });
    }
    const required = requiredChapterAssetIds(region, heroId, bindings);
    const projected: AssetManifestEntry[] = [];
    for (const id of required) {
        const source = bound.get(id);
        const entry = source?.entry ?? catalog.get(id);
        if (!entry) throw new AssetGateError('Candidate chapter catalogs are missing required asset ' + id + ' for ' + region.name + '.');
        if (id === region.environmentRecipeId) {
            if (entry.sourceType !== 'composed-recipe' || entry.kind !== 'environment') throw new AssetGateError('Environment recipe ' + id + ' is not a composed-recipe entry in its catalog.');
            projected.push({ ...entry, componentAssetIds: [...new Set(region.props.map(prop => prop.assetId))].sort() });
            continue;
        }
        const binding = source?.binding;
        projected.push({ ...entry, id, ...(binding?.actorId !== undefined ? { actorId: binding.actorId } : {}), ...(binding?.variantOf !== undefined ? { variantOf: binding.variantOf } : {}) });
    }
    return projected;
}

/**
 * Final gate on a projected candidate chapter manifest: exact dependency set, native hashed local GLBs, canonical actor
 * identity for every placed actor, consistent variants, no verified claim. The composition check shares the production code.
 */
export function assertChapterAssets(region: RegionDefinition, manifest: Manifest, recipe: EnvironmentRecipeDefinition, heroId: HeroId, bindings: readonly CandidateAssetBinding[]): void {
    const byId = new Map(manifest.map(entry => [entry.id, entry]));
    if (byId.size !== manifest.length) throw new AssetGateError('Candidate chapter manifest repeats an asset id.');
    assertRegionComposition(region, byId, recipe);
    const required = requiredChapterAssetIds(region, heroId, bindings);
    if (manifest.length !== required.size || [...byId.keys()].some(id => !required.has(id))) {
        throw new AssetGateError(region.name + ' candidate chapter manifest must contain exactly the authored ' + region.name + ' dependencies, including the player asset.');
    }
    for (const id of required) {
        const entry = byId.get(id);
        if (!entry) throw new AssetGateError(region.name + ' candidate chapter manifest is missing ' + id + '.');
        if (entry.evidenceStatus === 'verified') throw new AssetGateError('Candidate chapter asset ' + id + ' must remain explicitly unverified.');
        if (id === region.environmentRecipeId) continue;
        assertCandidateEntry(entry, expectedKindOf(region, heroId, id), 'chapter');
        if (entry.variantOf !== undefined) {
            const base = byId.get(entry.variantOf);
            if (!base || base.actorId !== entry.actorId) throw new AssetGateError('Candidate chapter variant ' + id + ' must share the actor identity of ' + entry.variantOf + '.');
        }
    }
    for (const entity of region.entities) {
        if (!entity.actorId) continue;
        const assetId = entity.assetId ?? ACTORS[entity.actorId]?.assetId;
        const entry = assetId ? byId.get(assetId) : undefined;
        if (!entry || entry.actorId !== entity.actorId) {
            throw new AssetGateError('Candidate chapter asset ' + assetId + ' does not carry canonical actor identity ' + entity.actorId + ' for ' + entity.id + '.');
        }
    }
}

/**
 * The manifest of one chapter region under an asset policy. `candidate`: the strict projection of the region's candidate
 * catalogs. `verified`: the public production manifest, accepted only by the verified gate (which still refuses blocked assets).
 */
export async function loadChapterManifest(region: RegionDefinition, policy: AssetPolicy, heroId: HeroId, source: ChapterAssetSource = DEFAULT_SOURCE): Promise<readonly AssetManifestEntry[]> {
    if (policy === 'verified') return source.fetchManifest(PRODUCTION_MANIFEST_URL, 'Required public asset manifest');
    const bindings = source.bindings[region.id];
    const urls = [...new Set((bindings ?? []).map(binding => binding.catalogUrl))];
    const catalogs = await Promise.all(urls.map(url => source.fetchManifest(url, CATALOG_LABEL)));
    return projectChapterManifest(region, heroId, catalogs, bindings);
}

/** Hero-select preview manifest: every hero kit and the base actor from the opening region's catalogs (candidate) or the public manifest (verified). */
export async function loadHeroKitManifest(policy: AssetPolicy, source: ChapterAssetSource = DEFAULT_SOURCE): Promise<readonly AssetManifestEntry[]> {
    if (policy === 'verified') return source.fetchManifest(PRODUCTION_MANIFEST_URL, 'Required public asset manifest');
    const bindings = source.bindings.greenwake;
    if (!bindings?.length) throw new AssetGateError('No candidate chapter asset bindings exist for the opening region.');
    const urls = [...new Set(bindings.map(binding => binding.catalogUrl))];
    const catalogs = (await Promise.all(urls.map(url => source.fetchManifest(url, CATALOG_LABEL)))).flat();
    const ids = new Set<string>([ACTORS.aren?.assetId ?? 'actor-aren', ...HEROES.flatMap(hero => [...(hero.variantAssetId ? [hero.variantAssetId] : []), ...(hero.weaponAssetId ? [hero.weaponAssetId] : [])])]);
    const kits = catalogs.filter(entry => ids.has(entry.id));
    const missing = [...ids].filter(id => !kits.some(entry => entry.id === id));
    if (missing.length) throw new AssetGateError('Candidate hero kit assets are missing from the opening region catalogs: ' + missing.join(', ') + '.');
    return kits;
}

/** Exact native roster bodies, independent of the currently equipped party. No production evidence is bypassed. */
export async function loadCompanionManifest(policy: AssetPolicy, source: ChapterAssetSource = DEFAULT_SOURCE): Promise<Manifest> {
    const ids = new Set(['vara', 'koro', 'asha', 'sable', 'nyra', 'solkar']);
    if (policy === 'verified') return (await source.fetchManifest(PRODUCTION_MANIFEST_URL, 'Required public asset manifest')).filter(entry => ids.has(entry.actorId ?? ''));
    const bindings = (source.bindings.greenwake ?? []).filter(binding => binding.actorId && ids.has(binding.actorId) && !binding.variantOf);
    if (bindings.length !== ids.size) throw new AssetGateError('The native companion roster bindings are incomplete.');
    const catalogs = await Promise.all([...new Set(bindings.map(binding => binding.catalogUrl))].map(url => source.fetchManifest(url, CATALOG_LABEL)));
    return bindings.map(binding => {
        const entry = catalogs.flat().find(candidate => candidate.id === binding.assetId);
        if (!entry) throw new AssetGateError('Missing native companion ' + binding.actorId + '.');
        assertCandidateEntry(entry, 'character', 'chapter');
        return { ...entry, id: ACTORS[binding.actorId!]!.assetId, actorId: binding.actorId! };
    });
}

/** The asset gate of a chapter session, for the region and its authored recipe. */
export function assertAssetsForPolicy(policy: AssetPolicy, region: RegionDefinition, manifest: Manifest, recipe: EnvironmentRecipeDefinition, heroId: HeroId, bindings: readonly CandidateAssetBinding[] | undefined = CHAPTER_ASSET_BINDINGS[region.id]): void {
    if (policy === 'verified') { assertVerifiedAssets(region, manifest, recipe); return; }
    if (!bindings?.length) throw new AssetGateError('No candidate chapter asset bindings exist for ' + region.name + '; other regions remain gated by production evidence.');
    assertChapterAssets(region, manifest, recipe, heroId, bindings);
}
