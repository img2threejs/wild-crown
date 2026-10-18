import type { AssetManifestEntry, EnvironmentRecipeDefinition, RegionDefinition } from '../game/contracts.js';
import { ACTORS } from '../content/campaign.js';
import { HEROES } from '../game/heroes.js';
import { NativeAssetError } from '../rendering/NativeAssetLoader.js';
import { TRIAL_GATE_ASSET_ID } from '../game/combat/CombatTrials.js';
import { WAYSTONE_ASSET_ID } from '../rendering/WaystoneVisual.js';
import type { AssetPlaytest } from './AssetPlaytests.js';

export type Manifest = readonly AssetManifestEntry[];
/** The public, verified-evidence manifest; the only manifest the production gate accepts. */
export const PRODUCTION_MANIFEST_URL = '/assets/manifest.json';

/** A terminal asset-gate refusal (blocked, wrong hash, wrong identity, missing dependency): retrying cannot help. */
export class AssetGateError extends Error {
    constructor(message: string) { super(message); this.name = 'AssetGateError'; }
}
function isTransientAssetHttpFailure(error: NativeAssetError): boolean {
    const status = /\bHTTP (\d{3})\b/.exec(error.message)?.[1];
    if (!status) return false;
    const code = Number(status);
    return code === 408 || code === 429 || code >= 500;
}
export function isTerminalAssetError(error: unknown): boolean {
    return error instanceof AssetGateError || error instanceof NativeAssetError && !isTransientAssetHttpFailure(error);
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isStringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every(entry => typeof entry === 'string'); }
function isActionMap(value: unknown): value is Record<string, string | null> { return isRecord(value) && Object.values(value).every(clip => clip === null || typeof clip === 'string'); }
function isPlaytestAnimation(value: unknown): value is NonNullable<AssetManifestEntry['playtestAnimation']> {
    if (!isRecord(value) || !['biped', 'avian', 'quadruped'].includes(String(value.rigFamily))
        || !isStringArray(value.actionIds) || value.actionIds.length === 0
        || value.actionIds.some(actionId => actionId.length === 0) || new Set(value.actionIds).size !== value.actionIds.length
        || ['torsoBoneNames', 'armRootNames', 'legRootNames', 'wingRootNames', 'wingSecondaryBoneNames', 'limbRootNames'].some(key => key in value && !isStringArray(value[key]))
        || ('headBoneName' in value && typeof value.headBoneName !== 'string')) return false;
    if (value.rigFamily === 'biped') {
        const needsLegRoots = (value.actionIds as string[]).some(actionId => /run|jump/i.test(actionId));
        return Array.isArray(value.armRootNames) && value.armRootNames.length === 2
            && Array.isArray(value.torsoBoneNames) && value.torsoBoneNames.length > 0
            && (!needsLegRoots || Array.isArray(value.legRootNames) && value.legRootNames.length === 2);
    }
    if (value.rigFamily === 'avian') return Array.isArray(value.wingRootNames) && value.wingRootNames.length === 2;
    return Array.isArray(value.limbRootNames) && value.limbRootNames.length === 4;
}
function optionalNullableString(record: Record<string, unknown>, key: string): boolean { return !(key in record) || record[key] === null || typeof record[key] === 'string'; }
function isVector3Value(value: unknown): value is { x: number; y: number; z: number } {
    return isRecord(value) && typeof value.x === 'number' && Number.isFinite(value.x)
        && typeof value.y === 'number' && Number.isFinite(value.y)
        && typeof value.z === 'number' && Number.isFinite(value.z);
}
function isCoordinateTransform(value: unknown): boolean {
    return isRecord(value) && typeof value.scale === 'number' && Number.isFinite(value.scale) && value.scale > 0
        && isVector3Value(value.forward)
        && (!('originOffset' in value) || isVector3Value(value.originOffset));
}
function isManifestEntry(value: unknown): value is AssetManifestEntry {
    if (!isRecord(value))
        return false;
    return typeof value.id === 'string' && value.id.length > 0
        && ['native-glb', 'composed-recipe', 'procedural'].includes(String(value.sourceType))
        && ['character', 'environment', 'prop', 'vfx', 'audio', 'ui'].includes(String(value.kind))
        && isStringArray(value.lodIds) && isStringArray(value.sockets)
        && isStringArray(value.requiredActionIds) && isActionMap(value.actionToClipMapping)
        && typeof value.provenance === 'string' && value.provenance.length > 0
        && ['not-started', 'in-progress', 'verified', 'blocked'].includes(String(value.evidenceStatus))
        && optionalNullableString(value, 'runtimeUrl') && optionalNullableString(value, 'sourceHash')
        && optionalNullableString(value, 'sourceInputHash') && optionalNullableString(value, 'outputHash')
        && (!('playtestAnimation' in value) || isPlaytestAnimation(value.playtestAnimation))
        && (!('actorId' in value) || typeof value.actorId === 'string')
        && (!('variantOf' in value) || typeof value.variantOf === 'string')
        && (!('componentAssetIds' in value) || isStringArray(value.componentAssetIds))
        && (!('proceduralRecipeId' in value) || typeof value.proceduralRecipeId === 'string')
        && (!('coordinateTransform' in value) || value.coordinateTransform === null || isCoordinateTransform(value.coordinateTransform));
}
export function isManifest(value: unknown): value is Manifest { return Array.isArray(value) && value.every(isManifestEntry); }

/** Fetches and schema-checks one manifest file. 4xx (except 408/429), invalid JSON and wrong shapes are terminal gate errors. */
export async function fetchManifest(url: string, label: string, fetchImpl: typeof fetch = fetch): Promise<Manifest> {
    const response = await fetchImpl(url, { cache: 'no-store' });
    if (!response.ok) {
        const message = label + ' ' + url + ' is unavailable (HTTP ' + response.status + ').';
        if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) throw new AssetGateError(message);
        throw new Error(message);
    }
    let json: unknown;
    try { json = await response.json(); }
    catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        throw new AssetGateError(label + ' ' + url + ' contains invalid JSON.');
    }
    if (!isManifest(json)) throw new AssetGateError(label + ' ' + url + ' is not an AssetManifestEntry array.');
    return json;
}

/** The region's composed environment recipe must list exactly its authored prop assets and placements; movable props must be unambiguous. */
export function assertRegionComposition(region: RegionDefinition, byId: ReadonlyMap<string, AssetManifestEntry>, recipe: EnvironmentRecipeDefinition): void {
    const recipeEntry = byId.get(recipe.id);
    if (!recipeEntry || recipeEntry.sourceType !== 'composed-recipe' || recipeEntry.kind !== 'environment') {
        throw new AssetGateError('Environment recipe ' + recipe.id + ' is not a normalized composed-recipe entry.');
    }
    const expectedComponents = [...new Set(region.props.map(prop => prop.assetId))].sort();
    const actualComponents = recipeEntry.componentAssetIds?.slice().sort();
    if (!actualComponents || new Set(actualComponents).size !== actualComponents.length || actualComponents.length !== expectedComponents.length || actualComponents.some((id, index) => id !== expectedComponents[index])) {
        throw new AssetGateError('Environment recipe ' + recipe.id + ' componentAssetIds do not exactly match the region’s authored prop assets.');
    }
    const expectedPlacements = region.props.map(prop => prop.id).sort();
    const actualPlacements = recipe.assetPlacementIds.slice().sort();
    if (new Set(actualPlacements).size !== actualPlacements.length || actualPlacements.length !== expectedPlacements.length || actualPlacements.some((id, index) => id !== expectedPlacements[index])) {
        throw new AssetGateError('Environment recipe ' + recipe.id + ' assetPlacementIds do not exactly match the region’s authored placements.');
    }
    const movableIds = new Set<string>();
    for (const movable of region.movableObjects) {
        if (movableIds.has(movable.id)) throw new AssetGateError('Region ' + region.id + ' repeats movable prop instance ' + movable.id + '.');
        movableIds.add(movable.id);
        const placements = region.props.filter(prop => prop.id === movable.id);
        if (placements.length !== 1 || placements[0]!.assetId !== movable.assetId) {
            throw new AssetGateError('Movable prop ' + movable.id + ' must match exactly one authored placement and asset.');
        }
        if (!region.ground.surfaces.some(surface => surface.id === movable.supportSurfaceId)) {
            throw new AssetGateError('Movable prop ' + movable.id + ' references missing support surface ' + movable.supportSurfaceId + '.');
        }
    }
}

/** Asset ids every region needs regardless of policy: its recipe, props, placed actors and the base player actor. */
export function regionAssetIds(region: RegionDefinition): Set<string> {
    return new Set<string>([
        region.environmentRecipeId,
        ...region.props.map(prop => prop.assetId),
        ...region.entities.filter(entity => entity.actorId).map(entity => entity.assetId ?? ACTORS[entity.actorId!]?.assetId).filter((id): id is string => Boolean(id)),
        ACTORS.aren?.assetId ?? 'actor-aren',
    ]);
}

/** Candidate GLBs stay unverified; required clip mappings are load contracts, checked against actual GLB clips by NativeAssetLoader. */
export function assertCandidateEntry(entry: AssetManifestEntry, expectedKind: 'prop' | 'character', label: string): void {
    const id = entry.id;
    if (entry.evidenceStatus === 'verified') throw new AssetGateError('Candidate ' + label + ' asset ' + id + ' must remain explicitly unverified.');
    if (entry.kind !== expectedKind || entry.sourceType !== 'native-glb') throw new AssetGateError('Candidate ' + label + ' asset ' + id + ' must be a native ' + expectedKind + ' GLB.');
    if (!entry.runtimeUrl?.startsWith('/asset-source/generated/') || entry.runtimeUrl.includes('..')) throw new AssetGateError('Candidate ' + label + ' asset ' + id + ' must load from a local generated GLB.');
    if (!entry.outputHash || !/^[a-f0-9]{64}$/i.test(entry.outputHash)) throw new AssetGateError('Candidate ' + label + ' asset ' + id + ' requires the SHA-256 of its actual GLB bytes.');
    if (entry.kind === 'character') {
        if (!entry.actorId) throw new AssetGateError('Candidate ' + label + ' character ' + id + ' must identify its actor.');
        for (const actionId of entry.requiredActionIds) {
            if (!entry.actionToClipMapping[actionId]) throw new AssetGateError('Candidate ' + label + ' character ' + id + ' requires an exact native clip mapping for ' + actionId + '.');
        }
    }
    if (entry.playtestAnimation && entry.evidenceStatus !== 'blocked') throw new AssetGateError('Playtest animation profiles must remain explicitly blocked from production acceptance.');
}

/** Production verified gate: every dependency verified, native GLBs hashed with evidenced clips, no playtest-only profiles. */
export function assertVerifiedAssets(region: RegionDefinition, manifest: Manifest, recipe: EnvironmentRecipeDefinition): void {
    const byId = new Map(manifest.map(entry => [entry.id, entry]));
    assertRegionComposition(region, byId, recipe);
    const required = regionAssetIds(region);
    if (region.id === 'heartroot-hollow') required.add('actor-orun-crowned-beast');
    if (manifest.some(entry => entry.playtestAnimation)) throw new AssetGateError('Playtest-only animation profiles cannot enter the production asset manifest.');
    for (const id of required) {
        const entry = byId.get(id);
        if (!entry) throw new AssetGateError('Required asset ' + id + ' is missing from ' + PRODUCTION_MANIFEST_URL + '.');
        if (entry.evidenceStatus !== 'verified') {
            throw new AssetGateError('Required asset ' + id + ' is not verified (' + entry.evidenceStatus + '); gameplay is blocked.');
        }
        if (entry.sourceType === 'native-glb') {
            if (!entry.runtimeUrl) throw new AssetGateError('Required native asset ' + id + ' has no runtimeUrl in ' + PRODUCTION_MANIFEST_URL + '.');
            if (!entry.outputHash) throw new AssetGateError('Required native asset ' + id + ' has no immutable outputHash in ' + PRODUCTION_MANIFEST_URL + '.');
            if (entry.kind === 'character') {
                const missing = entry.requiredActionIds.filter(actionId => !entry.actionToClipMapping[actionId]);
                if (missing.length) throw new AssetGateError('Required character asset ' + id + ' is missing evidenced animation clips for ' + missing.join(', ') + '.');
            }
        }
    }
    if (region.id === 'heartroot-hollow') {
        const variant = byId.get('actor-orun-crowned-beast');
        if (variant?.actorId !== 'orun' || variant.variantOf !== 'actor-orun' || variant.kind !== 'character' || variant.sourceType !== 'native-glb') {
            throw new AssetGateError('Orun crowned-beast phase requires exact verified actor variant actor-orun-crowned-beast.');
        }
    }
}

/** Trials gate: exactly the one region's candidate catalog (all four hero kits, trial gate, waystone), explicitly unverified. */
export function assertTrialAssets(region: RegionDefinition, manifest: Manifest, recipe: EnvironmentRecipeDefinition, playtest: AssetPlaytest): void {
    const byId = new Map(manifest.map(entry => [entry.id, entry]));
    assertRegionComposition(region, byId, recipe);
    if (region.id !== playtest.regionId) throw new AssetGateError('The real-asset candidate playtest only supports ' + playtest.name + '; other regions remain gated by production evidence.');
    const required = regionAssetIds(region);
    // Every playable kit is an explicit candidate dependency; variants remain character assets and an unarmed hero (Sakda) has no weapon prop.
    const standaloneProps = [TRIAL_GATE_ASSET_ID, WAYSTONE_ASSET_ID, ...HEROES.flatMap(hero => hero.weaponAssetId ? [hero.weaponAssetId] : [])];
    for (const id of standaloneProps) required.add(id);
    for (const hero of HEROES) if (hero.variantAssetId) required.add(hero.variantAssetId);
    if (region.id === 'heartroot-hollow') required.add('actor-orun-crowned-beast');
    if (manifest.length !== required.size || byId.size !== required.size || [...byId.keys()].some(id => !required.has(id))) {
        throw new AssetGateError(playtest.name + ' candidate playtest manifest must contain exactly the authored ' + playtest.name + ' dependencies, including the player asset.');
    }
    for (const id of required) {
        const entry = byId.get(id);
        if (!entry) throw new AssetGateError(playtest.name + ' candidate playtest manifest is missing ' + id + '.');
        if (entry.evidenceStatus === 'verified') throw new AssetGateError('Candidate playtest asset ' + id + ' must remain explicitly unverified.');
        if (id === region.environmentRecipeId) continue;
        const expectedKind = region.props.some(prop => prop.assetId === id) || standaloneProps.includes(id) ? 'prop' : 'character';
        assertCandidateEntry(entry, expectedKind, 'playtest');
    }
}
