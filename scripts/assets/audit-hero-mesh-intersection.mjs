#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs';
import { parseGlb } from './import-aren-animation-set.mjs';
import { Rig, readClipFrames } from './retarget-aren-tripo-clips.mjs';
import { interpolateFrame } from './vesper-blade-clearance.mjs';
import { Occupancy, REGIONS, runtimeMesh, skin, vertexNormals } from './hero-mesh-collision.mjs';
import { HEROES } from './hero-assets.mjs';
import { ThreeSkeleton } from './hero-harmony-harness.mjs';

const root = new URL('../../', import.meta.url).pathname;
/** Excess burial depth that counts as a penetration (rig units, ≈ 2.5 cm). */
export const BURY_THRESHOLD = 0.015;

/** Articulated neighbours fold into each other legitimately (knee, elbow, wrist, ankle, neck, shoulder, hip): only pairs outside this set are collisions. */
const ADJACENT = new Set(['head|torso', 'torso|uarmL', 'torso|uarmR', 'uarmL|farmL', 'uarmR|farmR', 'farmL|handL', 'farmR|handR', 'torso|thighL', 'torso|thighR', 'thighL|shinL', 'thighR|shinR', 'shinL|footL', 'shinR|footR']);
/** Legs sit 1-3 cm apart in every gait, below the 2 cm voxel that seals the gap, so leg-versus-leg is not measurable here (feet are owned by FootGrounding). */
const LEG = /^(thigh|shin|foot)[LR]$/;
const adjacent = (a, b) => a === b || ADJACENT.has(`${a}|${b}`) || ADJACENT.has(`${b}|${a}`) || (LEG.test(a) && LEG.test(b));

/** Loads a hero's runtime mesh and its rest-pose burial baseline (coat layers, shoulders and hips are buried in the bind pose). */
export async function openHero(name, glbPath) {
  const hero = HEROES[name], source = parseGlb(readFileSync(glbPath ?? root + hero.glb)), rig = new Rig(source);
  const mesh = await runtimeMesh(source, rig), posed = new Float32Array(mesh.count * 3), normals = new Float32Array(mesh.count * 3), occupancy = new Occupancy();
  rig.resetPose(); skin(mesh, rig.evaluate(), posed); vertexNormals(mesh, posed, normals); occupancy.build(mesh, posed);
  const base = new Float32Array(mesh.count);
  for (let v = 0; v < mesh.count; v += 1) base[v] = occupancy.depth(posed[v * 3], posed[v * 3 + 1], posed[v * 3 + 2], normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]);
  return { name, hero, source, rig, mesh, posed, normals, occupancy, base };
}

/** Buried vertices of the current posed state (`world` = rig world matrices): `{ pair, excess, verts }` per own>host region pair. */
export function penetrations(ctx, world) {
  const { mesh, posed, normals, occupancy, base } = ctx;
  skin(mesh, world, posed); vertexNormals(mesh, posed, normals); occupancy.build(mesh, posed);
  const pairs = new Map();
  for (let v = 0; v < mesh.count; v += 1) {
    const px = posed[v * 3], py = posed[v * 3 + 1], pz = posed[v * 3 + 2], nx = normals[v * 3], ny = normals[v * 3 + 1], nz = normals[v * 3 + 2];
    const excess = occupancy.depth(px, py, pz, nx, ny, nz) - base[v];
    if (excess <= BURY_THRESHOLD) continue;
    const own = mesh.region[v], host = occupancy.hostRegion(px, py, pz, nx, ny, nz, own);
    if (host < 0 || adjacent(REGIONS[own], REGIONS[host])) continue;
    const key = `${REGIONS[own]}>${REGIONS[host]}`;
    const entry = pairs.get(key) ?? { pair: key, excess: 0, verts: 0 };
    entry.excess = Math.max(entry.excess, excess); entry.verts += 1; pairs.set(key, entry);
  }
  return [...pairs.values()].sort((a, b) => b.excess - a.excess);
}

export async function auditMesh(name, { only, frameBudget = 24, log = false, corrected = false, glb } = {}) {
  const ctx = await openHero(name, glb), { rig, source, hero } = ctx, clips = {}, skeleton = corrected ? new ThreeSkeleton(rig) : undefined;
  for (const animation of source.json.animations) {
    if (only && !only.includes(animation.name)) continue;
    const { frames, count, times } = readClipFrames(rig, animation.name), scratch = interpolateFrame(frames, 0), total = count * 2 - 1, picks = new Set();
    for (let i = 0; i < Math.min(frameBudget, total); i += 1) picks.add(Math.round(i * (total - 1) / Math.max(1, Math.min(frameBudget, total) - 1)) / 2);
    const perPair = new Map();
    let peakVerts = 0, sumVerts = 0, sampled = 0;
    for (const frame of [...picks].sort((a, b) => a - b)) {
      interpolateFrame(frames, frame, scratch);
      let world;
      if (skeleton) { skeleton.setFrame(scratch, 0); world = skeleton.solve(); } else world = rig.poseFrame(scratch, 0);
      const found = penetrations(ctx, world), total = found.reduce((n, e) => n + e.verts, 0);
      peakVerts = Math.max(peakVerts, total); sumVerts += total; sampled += 1;
      for (const e of found) {
        const previous = perPair.get(e.pair);
        if (!previous || e.excess > previous.excess) perPair.set(e.pair, { ...e, frame, time: times[Math.min(count - 1, Math.round(frame))] });
      }
    }
    const top = [...perPair.values()].sort((a, b) => b.excess - a.excess).slice(0, 4).map((e) => ({ pair: e.pair, cm: +(e.excess * hero.scale * 100).toFixed(1), verts: e.verts, frame: e.frame, t: +(e.time ?? 0).toFixed(3) }));
    clips[animation.name] = { worstCm: top[0]?.cm ?? 0, peakVerts, meanVerts: Math.round(sumVerts / Math.max(1, sampled)), top };
    if (log) console.log(name, animation.name, JSON.stringify(clips[animation.name]));
  }
  return { hero: name, triangles: ctx.mesh.tris.length / 3, vertices: ctx.mesh.count, clips };
}

if (process.argv[1]?.endsWith('audit-hero-mesh-intersection.mjs')) {
  const glb = process.argv.find((a) => a.startsWith('--glb='))?.slice(6), corrected = process.argv.includes('--corrected'), args = process.argv.slice(2).filter((a) => a !== '--corrected' && !a.startsWith('--glb=')), names = args.filter((a) => HEROES[a]), only = args.filter((a) => !HEROES[a]), out = [];
  for (const n of names.length ? names : Object.keys(HEROES)) {
    const t0 = performance.now();
    out.push(await auditMesh(n, { only: only.length ? only : undefined, log: true, corrected, glb }));
    console.log(n, 'seconds', ((performance.now() - t0) / 1000).toFixed(1));
  }
  writeFileSync(`/tmp/hero-mesh-intersection-${names.join('-') || 'all'}${corrected ? '-corrected' : ''}.json`, JSON.stringify(out, null, 1));
}
