import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { assertActorVariantBinding, assertRegionActorBinding, resolveDisplayedAsset, type DisplayedAsset } from '../../src/rendering/ActorBinding.js';
import type { ActorSnapshot, AssetManifestEntry, RegionEntityDefinition } from '../../src/game/contracts.js';

const character = (id: string, actorId: string, extra: Partial<AssetManifestEntry> = {}): AssetManifestEntry =>
  ({ id, actorId, kind: 'character', sourceType: 'native-glb', ...extra }) as unknown as AssetManifestEntry;
const entity = (id: string, actorId: string, assetId?: string): Pick<RegionEntityDefinition, 'id' | 'actorId' | 'assetId'> => ({ id, actorId, assetId });

describe('canonical actor binding of a placed instance', () => {
  it('accepts exactly the manifest of the instance whose canonical actor matches', () => {
    const manifest = character('actor-koro-branchbreaker', 'koro');
    expect(() => assertRegionActorBinding('canopy', entity('koro', 'koro', 'actor-koro-branchbreaker'), manifest)).not.toThrow();
  });

  it('rejects an alias actor id: the chapter projection must bind the native asset to the canonical actor, the renderer never relaxes it', () => {
    // The standalone playtest manifests name the bamboo assets by alias (`bamboo-koro-branchbreaker`, `grove-koro`).
    const aliased = character('actor-koro-branchbreaker', 'bamboo-koro-branchbreaker');
    expect(() => assertRegionActorBinding('bamboo', entity('koro', 'koro', 'actor-koro-branchbreaker'), aliased)).toThrow('does not map to a manifest for canonical actor koro');
  });

  it('rejects a missing manifest, a different asset id, a missing explicit asset id and a non-native or non-character asset', () => {
    expect(() => assertRegionActorBinding('r', entity('h', 'hunter', 'actor-hunter'), undefined)).toThrow('does not map to a manifest');
    expect(() => assertRegionActorBinding('r', entity('h', 'hunter', 'actor-hunter'), character('actor-other', 'hunter'))).toThrow('does not map to a manifest');
    expect(() => assertRegionActorBinding('r', entity('h', 'hunter'), character('actor-hunter', 'hunter'))).toThrow('has no explicit native character assetId');
    expect(() => assertRegionActorBinding('r', entity('h', 'hunter', 'actor-hunter'), character('actor-hunter', 'hunter', { sourceType: 'procedural' }))).toThrow('requires exact native-glb character asset');
    expect(() => assertRegionActorBinding('r', entity('h', 'hunter', 'actor-hunter'), character('actor-hunter', 'hunter', { kind: 'prop' }))).toThrow('requires exact native-glb character asset');
  });

  it('keeps the repeated instances of one archetype distinct: two hunters share an actor id and are bound by their own instance entities', () => {
    const melee = character('actor-camp-hunter-melee', 'hunter-melee');
    expect(() => assertRegionActorBinding('bamboo', entity('hunter-1', 'hunter-melee', 'actor-camp-hunter-melee'), melee)).not.toThrow();
    expect(() => assertRegionActorBinding('bamboo', entity('hunter-2', 'hunter-melee', 'actor-camp-hunter-melee'), melee)).not.toThrow();
    expect(() => assertRegionActorBinding('bamboo', entity('hunter-3', 'hunter-ranged', 'actor-camp-hunter-melee'), melee)).toThrow();
  });
});

describe('variant binding (hostile Koro and cleansed ally)', () => {
  const hostile = character('actor-koro-branchbreaker', 'koro');
  const ally = character('actor-koro', 'koro', { variantOf: 'actor-koro-branchbreaker' });

  it('accepts the ally body as a native variant of the hostile base of the same canonical actor', () => {
    expect(() => assertActorVariantBinding(hostile, ally, 'actor-koro')).not.toThrow();
    // ...and the reverse direction, when the placed instance carries the ally body as its base.
    expect(() => assertActorVariantBinding(ally, character('actor-koro-branchbreaker', 'koro', { variantOf: 'actor-koro' }), 'actor-koro-branchbreaker')).not.toThrow();
  });

  it('rejects a variant of another actor, of another base, a missing one and a non-native one', () => {
    expect(() => assertActorVariantBinding(hostile, character('actor-asha', 'asha', { variantOf: 'actor-koro-branchbreaker' }), 'actor-asha')).toThrow('not a native character variant of canonical actor koro');
    expect(() => assertActorVariantBinding(hostile, character('actor-koro', 'koro', { variantOf: 'actor-other' }), 'actor-koro')).toThrow('not a native character variant');
    expect(() => assertActorVariantBinding(hostile, undefined, 'actor-koro')).toThrow('not a native character variant');
    expect(() => assertActorVariantBinding(hostile, { ...ally, sourceType: 'procedural' }, 'actor-koro')).toThrow('not a native character variant');
  });
});

describe('which asset an actor snapshot is drawn with', () => {
  const base = { id: 'actor-koro-branchbreaker', actorId: 'koro' };
  const snapshot = (partial: Partial<ActorSnapshot>): Pick<ActorSnapshot, 'archetypeId' | 'renderVariantId'> => ({ archetypeId: 'koro', renderVariantId: undefined, ...partial } as Pick<ActorSnapshot, 'archetypeId' | 'renderVariantId'>);
  const resolve = (partial: Partial<ActorSnapshot>, variants?: ReadonlyMap<string, unknown>): DisplayedAsset | undefined => {
    const result = resolveDisplayedAsset(snapshot(partial), base, variants);
    return result && { ...result };
  };

  it('draws the base for the hostile body, the preloaded variant after the cleanse, and reports an unloaded variant as missing', () => {
    expect(resolve({ renderVariantId: 'actor-koro-branchbreaker' })).toEqual({ kind: 'base', assetId: 'actor-koro-branchbreaker' });
    expect(resolve({})).toEqual({ kind: 'base', assetId: 'actor-koro-branchbreaker' });
    expect(resolve({ renderVariantId: 'actor-koro' }, new Map([['actor-koro', {}]]))).toEqual({ kind: 'variant', assetId: 'actor-koro' });
    expect(resolve({ renderVariantId: 'actor-koro' })).toEqual({ kind: 'missing', assetId: 'actor-koro' });
    expect(resolve({ renderVariantId: 'actor-koro' }, new Map([['actor-other', {}]]))).toEqual({ kind: 'missing', assetId: 'actor-koro' });
  });

  it('has no asset for an instance now occupied by a different canonical actor (an invalid binding is never drawn with the old body)', () => {
    expect(resolveDisplayedAsset(snapshot({ archetypeId: 'asha' }), base, undefined)).toBeUndefined();
    expect(resolveDisplayedAsset(snapshot({}), undefined, undefined)).toBeUndefined();
  });

  it('reuses the caller\'s output record (no allocation per frame)', () => {
    const out: DisplayedAsset = { kind: 'base', assetId: '' };
    expect(resolveDisplayedAsset(snapshot({ renderVariantId: 'actor-koro' }), base, new Map([['actor-koro', {}]]), out)).toBe(out);
    expect(out).toEqual({ kind: 'variant', assetId: 'actor-koro' });
  });
});

describe('the renderer keeps the identity checks', () => {
  const renderer = readFileSync(`${process.cwd()}/src/rendering/GameRenderer.ts`, 'utf8');
  it('loads regions and variants only through the canonical binding assertions and never compares to an alias', () => {
    expect(renderer).toContain('assertRegionActorBinding(region.id, entity, manifest)');
    expect(renderer).toContain('assertActorVariantBinding(baseManifest, manifest, assetId)');
    expect(renderer).toContain('resolveDisplayedAsset(actor, baseManifest, variants, this.displayedScratch)');
    expect(renderer).not.toMatch(/bamboo-(koro|asha|tali|marek)|grove-koro/);
  });
});
