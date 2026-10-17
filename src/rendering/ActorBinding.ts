import type { ActorSnapshot, AssetManifestEntry, RegionEntityDefinition } from '../game/contracts';

/**
 * Canonical actor binding rules of the native renderer. A placed actor instance (`entity.id`) is bound to exactly one manifest
 * (`entity.assetId`) whose `actorId` is the canonical actor of the instance; a variant is a native character that names the same canonical
 * actor and the loaded base asset. Nothing here relaxes either identity: a manifest keyed by an alias (`bamboo-koro-branchbreaker`,
 * `grove-koro`) must be projected onto the canonical actor by the chapter asset projection, never accepted by the renderer.
 */

/** Throws unless `manifest` is the exact native character asset of the placed actor instance `entity` in region `regionId`. */
export function assertRegionActorBinding(regionId: string, entity: Pick<RegionEntityDefinition, 'id' | 'actorId' | 'assetId'>, manifest: AssetManifestEntry | undefined): asserts manifest is AssetManifestEntry {
  const manifestId = entity.assetId;
  if (!manifestId) throw new Error('Actor instance ' + entity.id + ' has no explicit native character assetId.');
  if (!manifest || manifest.id !== manifestId || manifest.actorId !== entity.actorId) throw new Error('Region ' + regionId + ' actor instance ' + entity.id + ' does not map to a manifest for canonical actor ' + entity.actorId + '.');
  if (manifest.kind !== 'character' || manifest.sourceType !== 'native-glb') throw new Error('Actor ' + entity.actorId + ' requires exact native-glb character asset ' + manifestId + '.');
}

/** Throws unless `manifest` is a native character variant of the loaded `base` asset and of the same canonical actor. */
export function assertActorVariantBinding(base: AssetManifestEntry, manifest: AssetManifestEntry | undefined, assetId: string): asserts manifest is AssetManifestEntry {
  if (!manifest || manifest.kind !== 'character' || manifest.sourceType !== 'native-glb' || manifest.actorId !== base.actorId || manifest.variantOf !== base.id) {
    throw new Error('Variant ' + assetId + ' is not a native character variant of canonical actor ' + base.actorId + '.');
  }
}

export type DisplayedAssetKind = 'base' | 'variant' | 'missing';
/**
 * Which loaded asset an actor snapshot is drawn with. `base`: the base asset of the instance; `variant`: a preloaded variant;
 * `missing`: the requested variant is not loaded (the actor is hidden and reported missing).
 */
export interface DisplayedAsset { kind: DisplayedAssetKind; assetId: string }

/**
 * Resolves the drawn asset into `out` (reused by the renderer: no allocation per frame). `baseManifest` is the manifest loaded for the placed
 * instance; a snapshot whose canonical `archetypeId` differs from it (a different actor now occupying the instance) has no valid asset
 * (returns undefined), and a requested variant counts only when it was preloaded for this instance.
 */
export function resolveDisplayedAsset(
  actor: Pick<ActorSnapshot, 'archetypeId' | 'renderVariantId'>,
  baseManifest: Pick<AssetManifestEntry, 'id' | 'actorId'> | undefined,
  loadedVariants: ReadonlyMap<string, unknown> | undefined,
  out: DisplayedAsset = { kind: 'base', assetId: '' },
): DisplayedAsset | undefined {
  if (!baseManifest || baseManifest.actorId !== actor.archetypeId) return undefined;
  const requested = actor.renderVariantId;
  if (!requested || requested === baseManifest.id) { out.kind = 'base'; out.assetId = baseManifest.id; }
  else { out.kind = loadedVariants?.has(requested) ? 'variant' : 'missing'; out.assetId = requested; }
  return out;
}
