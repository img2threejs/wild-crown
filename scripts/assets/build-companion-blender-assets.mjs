#!/usr/bin/env node
// Merge Blender-baked original-joint tracks into native assets; preserve original mesh/skin bytes.
// Run the two blender_companion_*.py authors first, then: node scripts/assets/build-companion-blender-assets.mjs
// Optional: --ids=asha,solkar merges and re-binds only those companions; without it every companion is merged
// (the default behaviour). An unknown id is refused.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGlb, encodeGlb } from './author-quadruped-clips.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const IDS = ['asha', 'koro', 'vara', 'sable', 'nyra', 'solkar'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const check = process.argv.includes('--check');
/** The companions to merge: every one by default, or only the ids named by --ids= (an unknown id is refused). */
const idsOption = process.argv.find(argument => argument.startsWith('--ids='));
/** The ids may be written bare (solkar) or with the asset prefix (actor-solkar). */
const selected = idsOption
  ? idsOption.slice('--ids='.length).split(',').map(id => id.trim().replace(/^actor-/, '')).filter(Boolean)
  : null;
if (selected) {
  const unknown = selected.filter(id => !IDS.includes(id));
  if (unknown.length) throw new Error(`Unknown companion id(s): ${unknown.join(', ')}; choose from ${IDS.join(', ')}`);
  if (!selected.length) throw new Error('--ids= names no companion');
}
const manifests = readdirSync(resolve(ROOT, 'asset-source/playtests')).filter(file => file.endsWith('.json')).map(file => `asset-source/playtests/${file}`);
// Vara already has a source-manifest runtime binding; update it without promoting blocked evidence.
manifests.push('asset-source/manifest.json');

function build(id) {
  const inputPath = resolve(ROOT, `asset-source/animation/companions-blender/${id}.json`);
  const baked = JSON.parse(readFileSync(inputPath, 'utf8'));
  const sourcePath = resolve(ROOT, baked.source);
  if (!sourcePath.startsWith(ROOT + '/asset-source/generated/')) throw new Error(`${id}: source is outside the generated asset directory`);
  const source = readFileSync(sourcePath);
  if (hash(source) !== baked.sourceSha256) throw new Error(`${id}: source changed since Blender authoring`);
  const { json, bin } = parseGlb(source);
  const jawRepair = json.extras?.companionJawRepair;
  if (!baked.clips.length) throw new Error(`${id}: no Blender clips`);
  const chunks = [bin];
  let offset = bin.length;
  const append = (values, width, type, extrema = false) => {
    if (values.length % width || !values.every(Number.isFinite)) throw new Error(`${id}: invalid ${type} samples`);
    const bytes = Buffer.alloc(values.length * 4);
    for (let i = 0; i < values.length; i++) bytes.writeFloatLE(values[i], i * 4);
    const view = json.bufferViews.length;
    json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
    chunks.push(bytes); offset += bytes.length;
    const accessor = { bufferView: view, componentType: 5126, count: values.length / width, type };
    if (extrema) { accessor.min = [Math.min(...values)]; accessor.max = [Math.max(...values)]; }
    const index = json.accessors.length; json.accessors.push(accessor);
    return index;
  };
  const names = new Set();
  for (const clip of baked.clips) {
    if (names.has(clip.name)) throw new Error(`${id}: duplicate clip ${clip.name}`);
    names.add(clip.name);
    if (clip.times[0] !== 0 || Math.abs(clip.times.at(-1) - clip.seconds) > 1e-6 || clip.times.some((t, i) => i && Math.fround(t) <= Math.fround(clip.times[i - 1]))) throw new Error(`${id}: invalid Float32 clip clock`);
    const time = append(clip.times, 1, 'SCALAR', true);
    const samplers = [], channels = [];
    for (const track of clip.channels) {
      if (json.nodes[track.node]?.name !== track.name || !['rotation', 'translation'].includes(track.path)) throw new Error(`${id}: track lost its original joint identity`);
      const width = track.path === 'rotation' ? 4 : 3;
      if (track.values.length !== clip.times.length || track.values.some(v => v.length !== width)) throw new Error(`${id}: sample count mismatch`);
      if (track.path === 'rotation' && track.values.some(q => Math.abs(Math.hypot(...q) - 1) > .0001)) throw new Error(`${id}: non-unit quaternion`);
      const sampler = samplers.length;
      samplers.push({ input: time, output: append(track.values.flat(), width, width === 4 ? 'VEC4' : 'VEC3'), interpolation: 'LINEAR' });
      channels.push({ sampler, target: { node: track.node, path: track.path } });
    }
    json.animations = json.animations.filter(animation => animation.name !== clip.name);
    json.animations.push({ name: clip.name, samplers, channels, extras: { authoring: 'Blender Python', markers: clip.markers } });
  }
  json.buffers[0].byteLength = offset;
  const bytes = encodeGlb(json, Buffer.concat(chunks));
  const output = sourcePath.replace(/-(?:combat|animated|companion-rig)\.glb$/, '-companion.glb');
  if (output === sourcePath) throw new Error(`${id}: source filename is not a supported native asset`);
  const url = '/' + relative(ROOT, output).replaceAll('\\', '/');
  const report = {
    assetId: `actor-${id}`, authoring: 'Blender Python keyframes (user-approved)', blenderVersion: baked.blenderVersion,
    source: { path: relative(ROOT, sourcePath), sha256: baked.sourceSha256 },
    output: { path: relative(ROOT, output), sha256: hash(bytes) },
    geometry: 'Surface positions, normals, UVs, indices and materials preserved; non-replaced original clips retained. Approved lower-jaw joint/weight repairs are recorded separately when present.',
    ...(jawRepair ? { jawRepair } : {}),
    clips: baked.clips.map(clip => ({ name: clip.name, seconds: clip.seconds, frames: clip.times.length, markers: clip.markers, channels: clip.channels.length })),
  };
  if (check) {
    if (hash(readFileSync(output)) !== report.output.sha256) throw new Error(`${id}: runtime output differs from Blender samples`);
  } else {
    writeFileSync(output, bytes);
    writeFileSync(resolve(dirname(output), 'companion-clips-report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  return { id: `actor-${id}`, oldUrl: '/' + (jawRepair?.source ?? relative(ROOT, sourcePath)), url, hash: report.output.sha256, names: [...names], report };
}

/** Locate the enclosing asset object without reformatting any unrelated manifest entries. */
function entryRange(text, id) {
  const needle = `"id": "${id}"`;
  const at = text.indexOf(needle);
  if (at < 0) return undefined;
  if (text.indexOf(needle, at + needle.length) >= 0) throw new Error(`Ambiguous manifest asset ${id}`);
  const stack = [];
  let quoted = false, escaped = false, start;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') { quoted = true; continue; }
    if (c === '{') stack.push(i);
    if (i >= at && start === undefined) start = stack.at(-1);
    if (c === '}') { const open = stack.pop(); if (open === start) return [start, i + 1]; }
  }
  throw new Error(`Unbalanced manifest asset ${id}`);
}

const outputs = IDS.filter(id => !selected || selected.includes(id)).map(build);
for (const path of manifests) {
  const absolute = resolve(ROOT, path), original = readFileSync(absolute, 'utf8');
  let text = original;
  for (const output of outputs) {
    const range = entryRange(text, output.id);
    if (!range) continue;
    const [start, end] = range;
    const entry = JSON.parse(text.slice(start, end));
    // Production entries without an authored runtime stay blocked; do not manufacture their missing contracts.
    if (entry.runtimeUrl !== output.oldUrl && entry.runtimeUrl !== output.url) continue;
    entry.runtimeUrl = output.url;
    entry.outputHash = output.hash;
    entry.provenance = relative(ROOT, resolve(ROOT, dirname(output.report.output.path), 'companion-clips-report.json')).replaceAll('\\', '/');
    for (const name of output.names) {
      entry.actionToClipMapping[name] = name;
      entry.rootMotion ??= {};
      entry.rootMotion[name] = { mode: 'in-place', evidenceStatus: 'verified' };
      if (!entry.requiredActionIds.includes(name)) entry.requiredActionIds.push(name);
    }
    const lineStart = text.lastIndexOf('\n', start) + 1;
    const indent = text.slice(lineStart, start).match(/^\s*/)[0];
    const replacement = JSON.stringify(entry, null, 2).split('\n').map((line, i) => i ? indent + line : line).join('\n');
    text = text.slice(0, start) + replacement + text.slice(end);
  }
  JSON.parse(text);
  if (check && text !== original) throw new Error(`${path}: companion bindings are stale`);
  if (!check && text !== original) writeFileSync(absolute, text);
}
for (const output of outputs) console.log(JSON.stringify({ assetId: output.id, runtimeUrl: output.url, sha256: output.hash, clips: output.names }));
console.log(check
  ? 'Companion Blender outputs and bindings match.'
  : selected
    ? `Merged ${selected.length} Blender-authored companion set(s) (${selected.join(', ')}) and synchronized their existing runtime bindings.`
    : 'Merged six Blender-authored companion sets and synchronized existing runtime bindings.');
