// Shared entry builders for the DEV asset playtest manifests (asset-source/playtests/*.json): used by
// build-canopy-manifest.mjs and build-story-map-manifest.mjs. Every entry is derived from the measured runtime GLB (sha256, bounds)
// and the clips report written by the authoring scripts, so a manifest never claims more than the files show.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Vector3 } from 'three';
import { MONSTER_SLOTS, Rig, parseGlb, readAccessorAny } from './creature-rig-kit.mjs';

export const ROOT = resolve(new URL('../..', import.meta.url).pathname);
export const read = path => JSON.parse(readFileSync(resolve(ROOT, path), 'utf8'));
export const sha256 = path => createHash('sha256').update(readFileSync(resolve(ROOT, path))).digest('hex');
export const round = (value, digits) => Number(value.toFixed(digits));

/** Looks an entry up in the given playtest manifests (first match wins); carried entries are copied verbatim. */
export function carriedFrom(manifests) {
  return id => {
    const found = manifests.map(manifest => manifest.find(entry => entry.id === id)).find(Boolean);
    if (!found) throw new Error(`No carried manifest entry ${id}`);
    return found;
  };
}

/**
 * Top surface height of the model along its centre line at mid length: the deck of a bridge. `lengthAxis` names the model axis the
 * bridge runs along ('z' by default); the centre line is the other ground axis at 0.
 */
export function deckHeight(glbPath, lengthAxis = 'z') {
  const { json, bin } = parseGlb(readFileSync(resolve(ROOT, glbPath)));
  const primitive = json.meshes[0].primitives[0];
  const positions = readAccessorAny(json, bin, primitive.attributes.POSITION), indices = readAccessorAny(json, bin, primitive.indices);
  const along = lengthAxis === 'x' ? 0 : 2, across = lengthAxis === 'x' ? 2 : 0;
  const point = vertex => new Vector3(...positions.subarray(vertex * 3, vertex * 3 + 3));
  const heights = [];
  for (const s of Array.from({ length: 33 }, (_, k) => -0.4 + 0.8 * k / 32)) {
    let best = -Infinity;
    for (let t = 0; t < indices.length; t += 3) {
      const a = point(indices[t]), b = point(indices[t + 1]), c = point(indices[t + 2]);
      const pa = [a.getComponent(along), a.getComponent(across)], pb = [b.getComponent(along), b.getComponent(across)], pc = [c.getComponent(along), c.getComponent(across)];
      if (Math.max(pa[0], pb[0], pc[0]) < s || Math.min(pa[0], pb[0], pc[0]) > s || Math.max(pa[1], pb[1], pc[1]) < 0 || Math.min(pa[1], pb[1], pc[1]) > 0) continue;
      const d = (pb[0] - pc[0]) * (pa[1] - pc[1]) + (pc[1] - pb[1]) * (pa[0] - pc[0]);
      if (Math.abs(d) < 1e-12) continue;
      const l1 = ((pb[0] - pc[0]) * (0 - pc[1]) + (pc[1] - pb[1]) * (s - pc[0])) / d, l2 = ((pc[0] - pa[0]) * (0 - pc[1]) + (pa[1] - pc[1]) * (s - pc[0])) / d, l3 = 1 - l1 - l2;
      if (l1 < 0 || l2 < 0 || l3 < 0) continue;
      best = Math.max(best, l1 * a.y + l2 * b.y + l3 * c.y);
    }
    if (Number.isFinite(best)) heights.push(best); // planks / logs are separated by gaps
  }
  if (heights.length < 24) throw new Error(`Only ${heights.length} of 33 centre-line samples hit the deck`);
  return heights.reduce((a, b) => a + b, 0) / heights.length;
}

/**
 * NativeAssetLoader applies the manifest's corrective heading on an inner node: atan2(forward.x, forward.z).
 * A model whose native head points along h needs forward = (-h.x, h.z); the outer root owns simulation yaw.
 */
export function forwardFromHead(head) {
  const length = Math.hypot(head.x, head.z);
  const x = round(-head.x / length, 4), z = round(head.z / length, 4);
  return { x: x === 0 ? 0 : x, y: 0, z: z === 0 ? 0 : z };
}

/**
 * spec.measure: y = height, x / z = length along that axis, horizontal = larger ground extent, axis = body length along the head
 * direction (clips report), shoulder = height of the front legs' top joints plus 5% of the model height for hide / fur (quadruped
 * reports; "1.1 m at the shoulder" is not the height of the raised head). spec.sizes = [{ measure, size }, ...] fits several stated sizes at once (geometric mean of the scales).
 */
export function transformFor(id, spec, provenance, glbPath, report) {
  const min = provenance.output.boundsMin, max = provenance.output.boundsMax;
  const extent = { x: max[0] - min[0], y: max[1] - min[1], z: max[2] - min[2] };
  const modelSize = measure => {
    if (measure === 'y') return extent.y;
    if (measure === 'z') return extent.z;
    if (measure === 'x') return extent.x;
    if (measure === 'shoulder') {
      const { json } = parseGlb(readFileSync(resolve(ROOT, glbPath))), rig = new Rig(json);
      const tops = [report.rig.legs.FL[0], report.rig.legs.FR[0]].map(name => rig.restP[rig.index(name)].y);
      return (tops[0] + tops[1]) / 2 + 0.05 * extent.y;
    }
    if (measure === 'axis') return report.body.lengthUnits;
    return Math.max(extent.x, extent.z);
  };
  const sizes = spec.sizes ?? [{ measure: spec.measure, size: spec.size }];
  const ratios = sizes.map(({ measure, size }) => size / modelSize(measure));
  const scale = round(ratios.length === 1 ? ratios[0] : Math.exp(ratios.reduce((sum, ratio) => sum + Math.log(ratio), 0) / ratios.length), 3);
  const baseY = spec.deck ? deckHeight(glbPath, spec.lengthAxis) : min[1];
  const offsetY = round(-baseY * scale, 5);
  const transform = { forward: spec.forward === 'head' ? forwardFromHead(report.suggestedCoordinateTransformForward) : spec.forward, scale };
  if (Math.abs(offsetY) > 1e-4) transform.originOffset = { x: 0, y: offsetY, z: 0 };
  return transform;
}

export function propEntry(id, spec) {
  const dir = `asset-source/generated/${id}-runtime-${String(spec.revision).padStart(2, '0')}`;
  const glb = `${dir}/${id}.glb`, provenance = read(`${dir}/provenance.json`);
  return {
    id, sourceType: 'native-glb', kind: 'prop', tripoSourceTask: provenance.tasks.model, runtimeUrl: `/${glb}`, outputHash: sha256(glb), lodIds: [],
    coordinateTransform: transformFor(id, spec, provenance, glb), requiredActionIds: [], actionToClipMapping: {}, sockets: [], provenance: `${dir}/provenance.json`, evidenceStatus: 'blocked',
  };
}

/** Slot -> clip name from a clips report: creature reports list `slots`, quadruped reports list `clips` (+ the preserved walk preset). */
function slotMapping(id, report, slots) {
  return Object.fromEntries(slots.map(slot => {
    const clip = report.slots ? report.slots[slot]?.clip : report.clips[slot] ? slot : slot === 'monster-walk' ? report.walkClip?.name : undefined;
    if (!clip) throw new Error(`${id}: clips-report has no ${slot}`);
    return [slot, clip];
  }));
}

/** Character entry: explicit slots restrict non-combat actors; a native tail clip is mapped only when present. */
export function monsterEntry(id, spec) {
  const dir = `asset-source/generated/${id}-runtime-${String(spec.revision).padStart(2, '0')}`;
  const glb = `${dir}/${id}-animated.glb`, report = read(`${dir}/clips-report.json`), provenance = read(`${dir}/provenance.json`);
  const hasTail = Boolean(report.slots?.['monster-tail']?.clip ?? report.clips?.['monster-tail']);
  const slots = spec.slots ?? [...MONSTER_SLOTS, ...(hasTail ? ['monster-tail'] : [])];
  const mapping = slotMapping(id, report, slots);
  return {
    id, actorId: spec.actorId, sourceType: 'native-glb', kind: 'character', rigFamily: spec.rigFamily, castSocketBone: report.castSocketBone ?? report.rig.headTipJoint,
    tripoSourceTask: provenance.tasks.rig, runtimeUrl: `/${glb}`, outputHash: sha256(glb), lodIds: [], requiredActionIds: [],
    coordinateTransform: transformFor(id, spec, provenance, glb, report), actionToClipMapping: mapping,
    rootMotion: Object.fromEntries(slots.map(slot => [slot, { mode: 'in-place', evidenceStatus: 'verified' }])),
    sockets: [], provenance: `${dir}/clips-report.json`, evidenceStatus: 'blocked',
  };
}

export function environmentEntry(id, componentAssetIds) {
  return {
    id, sourceType: 'composed-recipe', kind: 'environment', proceduralRecipeId: id, componentAssetIds,
    runtimeUrl: null, lodIds: [], requiredActionIds: [], actionToClipMapping: {}, sockets: [], provenance: `asset-source/manifest.json#${id}`, evidenceStatus: 'blocked',
  };
}
