#!/usr/bin/env node
// Brings the monster entries of the DEV asset playtest manifests (asset-source/playtests/*.json) in line with the runtime GLBs and clips
// reports written by author-quadruped-clips.mjs / author-creature-clips.mjs:
//   - outputHash          = sha256 of the animated runtime GLB
//   - actionToClipMapping = every slot the clips report lists but the entry does not map yet is added (the optional `monster-tail`, and the
//                           one-shot lifecycle slots `monster-death` / `monster-spawn`; never a slot the report lacks, e.g. no tail on a tail-less
//                           body), and `monster-walk` is rebound from the raw Tripo `preset:quadruped:walk` to the authored ikGait `monster-walk`
//                           clip once the report lists one (the preset stays in the GLB; the report's walkClip records it)
//   - rootMotion          = an in-place entry for every newly mapped slot
// Nothing else changes. The manifests are patched as text (greenwake.json is hand-formatted, the builders' output is not), so no unrelated
// line is rewritten; the result is parsed again and compared with the intended object before anything is written. The script is idempotent,
// byte-stable and the single writer for the Greenwake monster entries (no builder generates greenwake.json); for Canopy / Grove / Moonpine /
// Mistveil it is a hash + slot catch-up that makes the result independent of which builder produced the entry last.
// Any other mapping that disagrees with the clips report is not patched: it means a builder has to run first, and the script says so.
//
// Usage: node scripts/assets/sync-monster-manifest-entries.mjs [--check] [--manifest=path.json,path2.json]
//   --check  writes nothing; prints every difference and exits 1 when a manifest is out of date.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { MONSTER_SLOTS } from './creature-rig-kit.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TAIL_SLOT = 'monster-tail';
const SLOTS = [...MONSTER_SLOTS, TAIL_SLOT];
const PRESET_WALK = 'preset:quadruped:walk';
const DEFAULT_MANIFESTS = ['greenwake', 'canopy', 'grove', 'moonpine', 'mistveil'].map(name => `asset-source/playtests/${name}.json`);
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const check = process.argv.includes('--check');
const manifests = option('manifest')?.split(',') ?? DEFAULT_MANIFESTS;

/** Same slot -> clip resolution as playtest-manifest-kit.mjs: creature reports list `slots`, quadruped reports list `clips` (+ the preserved walk preset). */
const clipFor = (report, slot) => (report.slots ? report.slots[slot]?.clip : report.clips?.[slot] ? slot : slot === 'monster-walk' ? report.walkClip?.name : undefined);
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const once = (text, pattern, replace, what) => {
  const matches = text.match(new RegExp(pattern.source, 'g')) ?? [];
  if (matches.length !== 1) throw new Error(`expected exactly one ${what}, found ${matches.length}`);
  return text.replace(pattern, replace);
};
/** Index of the brace closing the object that opens at `open`. */
const closeOf = (text, open) => {
  for (let depth = 0, i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i;
  }
  throw new Error('unbalanced braces');
};
/** Appends `"slot": value` lines after the last entry of the object `"key": { ... }` inside `slice`, indented like that entry. */
function appendEntries(slice, key, entries, what) {
  const keyAt = slice.indexOf(`"${key}": {`);
  if (keyAt < 0) throw new Error(`no "${key}" object in ${what}`);
  const open = slice.indexOf('{', keyAt), close = closeOf(slice, open), body = slice.slice(open + 1, close);
  const trailing = /\s*$/.exec(body)[0], content = body.slice(0, body.length - trailing.length);
  const indent = /^\s*/.exec(content.slice(content.lastIndexOf('\n') + 1))[0];
  return slice.slice(0, open + 1) + content + entries.map(([slot, value]) => `,\n${indent}"${slot}": ${value(indent, body)}`).join('') + trailing + slice.slice(close);
}

const differences = [];
for (const manifestPath of manifests) {
  const absolute = resolve(ROOT, manifestPath);
  const original = readFileSync(absolute, 'utf8');
  const intended = JSON.parse(original);
  let text = original;
  const marks = [...original.matchAll(/"id": "([^"]+)"/g)].map(match => ({ id: match[1], index: match.index }));
  const patches = [];
  for (const entry of intended) {
    const match = /^\/(asset-source\/generated\/(actor-[a-z-]+)-runtime-\d+)\/\2-(animated|combat)\.glb$/.exec(entry.runtimeUrl ?? '');
    if (!match || entry.kind !== 'character') continue;
    const glb = resolve(ROOT, entry.runtimeUrl.slice(1)), reportPath = resolve(ROOT, match[1], match[3] === 'combat' ? 'combat-clips-report.json' : 'clips-report.json');
    if (!existsSync(glb) || !existsSync(reportPath)) throw new Error(`${manifestPath} ${entry.id}: runtime GLB or clip report is missing`);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    if (!report.slots && !report.clips) continue; // not a monster clip report (heroes, props)
    const mapping = entry.actionToClipMapping ?? {};
    const authoredWalk = mapping['monster-walk'] === PRESET_WALK && clipFor(report, 'monster-walk') === 'monster-walk';
    for (const slot of SLOTS) {
      if (slot in mapping && clipFor(report, slot) !== mapping[slot] && !(slot === 'monster-walk' && authoredWalk)) {
        throw new Error(`${manifestPath} ${entry.id}: ${slot} maps ${mapping[slot]} but the clips report says ${clipFor(report, slot)}; run the manifest builder first`);
      }
    }
    const hash = sha256(glb), added = SLOTS.filter(slot => !(slot in mapping) && clipFor(report, slot)).map(slot => [slot, clipFor(report, slot)]);
    if (report.attacks && report.output.sha256 !== hash) throw new Error(`${manifestPath} ${entry.id}: native attack artifact does not match its measured report; rebake before syncing`);
    const patch = { id: entry.id, hash: entry.outputHash !== hash ? { from: entry.outputHash, to: hash } : undefined, added, authoredWalk };
    if (!patch.hash && !added.length && !authoredWalk) continue;
    if (patch.hash) { differences.push(`${manifestPath} ${entry.id}: outputHash ${patch.hash.from} -> ${hash}`); entry.outputHash = hash; }
    if (authoredWalk) { differences.push(`${manifestPath} ${entry.id}: monster-walk ${PRESET_WALK} -> monster-walk (authored ikGait)`); entry.actionToClipMapping = { ...entry.actionToClipMapping, 'monster-walk': 'monster-walk' }; }
    for (const [slot, clip] of added) {
      differences.push(`${manifestPath} ${entry.id}: ${slot} (unmapped) -> ${clip}`);
      entry.actionToClipMapping = { ...entry.actionToClipMapping, [slot]: clip };
      entry.rootMotion = { ...(entry.rootMotion ?? {}), [slot]: { mode: 'in-place', evidenceStatus: 'verified' } };
    }
    patches.push(patch);
  }
  for (const patch of patches) {
    const at = marks.findIndex(mark => mark.id === patch.id);
    if (at < 0) throw new Error(`${manifestPath}: no "id": "${patch.id}" marker`);
    const start = marks[at].index, end = at + 1 < marks.length ? marks[at + 1].index : text.length;
    // Offsets stay valid because every patch only grows the slice it owns and later marks are re-found by id from the shifted text.
    let slice = text.slice(start, end);
    if (patch.hash) slice = once(slice, new RegExp(`"outputHash": "${patch.hash.from}"`), `"outputHash": "${patch.hash.to}"`, `outputHash of ${patch.id}`);
    if (patch.authoredWalk) slice = once(slice, new RegExp(`"monster-walk": "${PRESET_WALK}"`), '"monster-walk": "monster-walk"', `${PRESET_WALK} mapping of ${patch.id}`);
    if (patch.added.length) {
      slice = appendEntries(slice, 'actionToClipMapping', patch.added.map(([slot, clip]) => [slot, () => JSON.stringify(clip)]), patch.id);
      // rootMotion entries follow the layout the object already uses: one line each (greenwake.json) or expanded (the builders' output).
      const inPlace = (indent, body) => (/"mode": "in-place",\s*\n/.test(body)
        ? `{\n${indent}  "mode": "in-place",\n${indent}  "evidenceStatus": "verified"\n${indent}}`
        : '{ "mode": "in-place", "evidenceStatus": "verified" }');
      slice = appendEntries(slice, 'rootMotion', patch.added.map(([slot]) => [slot, inPlace]), patch.id);
    }
    text = text.slice(0, start) + slice + text.slice(end);
    const delta = slice.length - (end - start);
    for (let k = at + 1; k < marks.length; k++) marks[k].index += delta;
  }
  if (text !== original) {
    if (!isDeepStrictEqual(JSON.parse(text), intended)) throw new Error(`${manifestPath}: patched text does not parse to the intended manifest`);
    if (!check) writeFileSync(absolute, text);
  }
}
if (differences.length) console.log(differences.join('\n'));
console.log(differences.length ? `${check ? 'out of date' : 'updated'}: ${differences.length} difference(s)` : 'monster manifest entries are up to date');
process.exit(check && differences.length ? 1 : 0);
