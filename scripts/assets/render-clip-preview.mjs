#!/usr/bin/env node
// Renders contact sheets of a skinned GLB's clips for visual review without a browser: CPU skinning, a
// z-buffered orthographic triangle rasteriser, per-vertex base-colour sampling and a PNG encoder.
// Usage: node scripts/assets/render-clip-preview.mjs <model.glb> <out.png> [--clips=a,b,...] [--frames=8 | --times=0,0.5,1]
//          [--view=iso|side|front|top|play] [--cell=280] [--viewport=1080] [--scale=<manifest scale>]
// One row per clip, frames evenly spaced over the clip (or at the given normalised times); a horizontal line marks world y = 0.
// --view=play is the gameplay camera: perspective, FOV 48 deg, offset (10, 12, 14) m from the actor, the model scaled by its manifest scale
// (looked up in asset-source/playtests/*.json, or --scale), drawn at the pixel size it has in a `--viewport`-high (default 1080 px) frame and
// cropped to a `--cell` square around the actor, over a 1 m ground grid, so amplitude is judged at play distance.
// Static (unskinned) GLBs render one row of the views iso, side, front, top instead (pass --view=all).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';
import { Matrix4, Vector3 } from 'three';
import { Rig, parseGlb, readAccessorAny, readAnimation } from './creature-rig-kit.mjs';

const [glbPath, outPath] = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
if (!glbPath || !outPath) { console.error('Usage: render-clip-preview.mjs <model.glb> <out.png> [--clips=a,b] [--frames=8] [--view=iso|side|front|top] [--cell=280]'); process.exit(2); }
const option = (name, fallback) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const frameCount = Number(option('frames', 8)), view = option('view', 'iso'), cell = Number(option('cell', 280));
const times = option('times')?.split(',').map(Number);

const source = parseGlb(readFileSync(glbPath));
const { json, bin } = source;
const rig = isSkinnedGlb() ? new Rig(json) : undefined;
function isSkinnedGlb() { return Boolean(json.skins?.length); }
const clipNames = !rig ? [] : option('clips') ? option('clips').split(',') : (json.animations ?? []).map(a => a.name);

const accessor = id => readAccessorAny(json, bin, id);
const mesh = json.meshes[0], primitive = mesh.primitives[0];
const isSkinned = Boolean(json.skins?.length);
const positions = accessor(primitive.attributes.POSITION), joints = isSkinned ? accessor(primitive.attributes.JOINTS_0) : undefined, weights = isSkinned ? accessor(primitive.attributes.WEIGHTS_0) : undefined;
const uvs = primitive.attributes.TEXCOORD_0 === undefined ? undefined : accessor(primitive.attributes.TEXCOORD_0);
const indices = accessor(primitive.indices);
const inverseBind = isSkinned ? accessor(json.skins[0].inverseBindMatrices) : undefined;
const vertexCount = positions.length / 3;

/** Per-vertex base colour from the first material's base-colour texture (via macOS sips -> BMP). */
function vertexColors() {
  const colors = new Uint8Array(vertexCount * 3).fill(170);
  const material = json.materials?.[primitive.material ?? 0];
  const textureIndex = material?.pbrMetallicRoughness?.baseColorTexture?.index;
  if (textureIndex === undefined || !uvs) return colors;
  const image = json.images[json.textures[textureIndex].source], view = json.bufferViews[image.bufferView];
  const work = mkdtempSync(join(tmpdir(), 'wc-preview-'));
  try {
    const input = join(work, image.mimeType === 'image/png' ? 'in.png' : 'in.jpg'), output = join(work, 'out.bmp');
    writeFileSync(input, bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength));
    execFileSync('sips', ['-Z', '1024', '-s', 'format', 'bmp', input, '--out', output], { stdio: 'ignore' });
    const bmp = readFileSync(output), offset = bmp.readUInt32LE(10), width = bmp.readInt32LE(18), height = bmp.readInt32LE(22), bpp = bmp.readUInt16LE(28);
    const rowBytes = Math.floor((bpp * width + 31) / 32) * 4, step = bpp / 8, topDown = height < 0, h = Math.abs(height);
    for (let i = 0; i < vertexCount; i++) {
      const u = ((uvs[i * 2] % 1) + 1) % 1, v = ((uvs[i * 2 + 1] % 1) + 1) % 1;
      const px = Math.min(width - 1, Math.floor(u * width)), py = Math.min(h - 1, Math.floor(v * h));
      const row = topDown ? py : h - 1 - py, o = offset + row * rowBytes + px * step;
      colors[i * 3] = bmp[o + 2]; colors[i * 3 + 1] = bmp[o + 1]; colors[i * 3 + 2] = bmp[o];
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
  return colors;
}
const colors = vertexColors();

/** CPU skinning for one local pose; returns world-space positions. */
function skin(locals) {
  const { P, Q } = rig.world(locals);
  const matrices = rig.joints.map((joint, k) => {
    const world = new Matrix4().compose(P[joint], Q[joint], new Vector3(1, 1, 1));
    return world.multiply(new Matrix4().fromArray(Array.from(inverseBind.subarray(k * 16, k * 16 + 16))));
  });
  const out = new Float32Array(vertexCount * 3), v = new Vector3(), acc = new Vector3();
  for (let i = 0; i < vertexCount; i++) {
    acc.set(0, 0, 0);
    for (let k = 0; k < 4; k++) {
      const w = weights[i * 4 + k];
      if (w <= 0) continue;
      v.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]).applyMatrix4(matrices[joints[i * 4 + k]]);
      acc.addScaledVector(v, w);
    }
    out.set([acc.x, acc.y, acc.z], i * 3);
  }
  return out;
}

const CAMERAS = { iso: new Vector3(-10, -12, -14), play: new Vector3(-10, -12, -14), side: new Vector3(-1, 0, 0), front: new Vector3(0, 0, -1), top: new Vector3(0, -1, -0.001) };
function camera(name) {
  const forward = CAMERAS[name]?.clone().normalize();
  if (!forward) throw new Error(`Unknown view ${name}`);
  const right = new Vector3().crossVectors(forward, new Vector3(0, 1, 0)).normalize();
  const up = new Vector3().crossVectors(right, forward).normalize();
  const light = new Vector3().addScaledVector(forward, -0.6).addScaledVector(up, 0.7).addScaledVector(right, 0.35).normalize();
  return { name, forward, right, up, light };
}

/** Gameplay-camera framing (view=play): manifest scale / forward of this GLB, turned to face screen-right (+X, a three-quarter view toward the camera). */
function manifestPlacement() {
  let scale = option('scale') === undefined ? undefined : Number(option('scale')), forward = { x: 0, z: -1 };
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../../asset-source/playtests');
  for (const file of readdirSync(dir).filter(name => name.endsWith('.json'))) {
    const entries = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    const hit = (Array.isArray(entries) ? entries : entries.assets ?? []).find(entry => entry.runtimeUrl?.endsWith(basename(glbPath)));
    if (!hit) continue;
    scale ??= hit.coordinateTransform?.scale ?? 1;
    forward = hit.coordinateTransform?.forward ?? forward;
    break;
  }
  // Match the loader's corrective yaw, then turn the actor's +Z forward to screen-right (+X).
  const yaw = Math.atan2(forward.x, forward.z) + Math.PI / 2 + Number(option('facing', 0)) * Math.PI / 180;
  return { scale: scale ?? 1, cos: Math.cos(yaw), sin: Math.sin(yaw) };
}
const placement = view === 'play' ? manifestPlacement() : { scale: 1, cos: 1, sin: 0 };
const place = set => {
  if (view !== 'play') return set;
  const out = new Float32Array(set.length);
  for (let i = 0; i < set.length; i += 3) {
    out[i] = (set[i] * placement.cos + set[i + 2] * placement.sin) * placement.scale; out[i + 1] = set[i + 1] * placement.scale; out[i + 2] = (set[i + 2] * placement.cos - set[i] * placement.sin) * placement.scale;
  }
  return out;
};
const PLAY_FOV = 48 * Math.PI / 180, viewportHeight = Number(option('viewport', 1080)), focal = viewportHeight / 2 / Math.tan(PLAY_FOV / 2);
const playTarget = (() => {
  const rest = place(Float32Array.from(positions));
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, maxY = -Infinity;
  for (let i = 0; i < vertexCount; i++) { minX = Math.min(minX, rest[i * 3]); maxX = Math.max(maxX, rest[i * 3]); minZ = Math.min(minZ, rest[i * 3 + 2]); maxZ = Math.max(maxZ, rest[i * 3 + 2]); maxY = Math.max(maxY, rest[i * 3 + 1]); }
  return new Vector3((minX + maxX) / 2, 0.4 * maxY, (minZ + maxZ) / 2);
})();

/** Rows of cells: one row per clip (frames over time) for skinned GLBs, one row of fixed views for static ones. */
const rows = [];
if (rig) {
  const cam = camera(view);
  for (const name of clipNames) {
    const clip = readAnimation(rig, bin, name);
    const stamps = times ? times.map(u => clip.duration * u) : Array.from({ length: frameCount }, (_, f) => clip.duration * f / Math.max(1, frameCount - 1));
    rows.push(stamps.map(seconds => ({ set: place(skin(clip.sample(seconds))), cam })));
  }
} else {
  const set = place(Float32Array.from(positions));
  rows.push((view === 'all' ? ['iso', 'side', 'front', 'top'] : view.split(',')).map(name => ({ set, cam: camera(name) })));
}
const columns = Math.max(...rows.map(row => row.length));
// One fixed projection window per orthographic camera so motion is comparable between frames and clips.
const windows = new Map();
for (const { set, cam } of rows.flat()) {
  if (cam.name === 'play') continue;
  const w = windows.get(cam.name) ?? { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (let i = 0; i < vertexCount; i++) {
    const x = set[i * 3] * cam.right.x + set[i * 3 + 1] * cam.right.y + set[i * 3 + 2] * cam.right.z;
    const y = set[i * 3] * cam.up.x + set[i * 3 + 1] * cam.up.y + set[i * 3 + 2] * cam.up.z;
    w.minX = Math.min(w.minX, x); w.maxX = Math.max(w.maxX, x); w.minY = Math.min(w.minY, y); w.maxY = Math.max(w.maxY, y);
  }
  windows.set(cam.name, w);
}
const width = cell * columns, height = cell * rows.length;
const image = Buffer.alloc(width * height * 3, 246);
const depth = new Float32Array(cell * cell);
const SX = new Float32Array(vertexCount), SY = new Float32Array(vertexCount), SZ = new Float32Array(vertexCount);

function plot(ox, oy, x, y, grey) {
  const px = Math.round(x), py = Math.round(y);
  if (px < 0 || py < 0 || px >= cell || py >= cell) return;
  const o = ((oy + py) * width + ox + px) * 3;
  image[o] = grey; image[o + 1] = grey; image[o + 2] = grey;
}

function rasterise({ set, cam }, ox, oy) {
  const { right, up, forward, light } = cam;
  depth.fill(Infinity);
  if (cam.name === 'play') {
    // Perspective camera at actor + (10, 12, 14) looking at the aim point; screen scale = focal length in pixels of a viewport-high frame.
    const eye = playTarget.clone().add(new Vector3(10, 12, 14)), d = new Vector3();
    const project = (x, y, z, out) => {
      d.set(x, y, z).sub(eye);
      const zc = d.dot(forward);
      out[0] = cell / 2 + focal * d.dot(right) / zc; out[1] = cell / 2 - focal * d.dot(up) / zc; out[2] = zc;
    };
    const centre = [0, 0, 0], p = [0, 0, 0];
    project(playTarget.x, playTarget.y, playTarget.z, centre);
    const shiftX = centre[0] - cell / 2, shiftY = centre[1] - cell / 2;
    // 1 m ground grid (y = 0) around the actor, drawn first so the body overdraws it.
    for (let g = -6; g <= 6; g++) for (let s = -6; s <= 6; s += 0.02) {
      for (const [gx, gz] of [[g, s], [s, g]]) { project(gx, 0, gz, p); plot(ox, oy, p[0] - shiftX, p[1] - shiftY, g === 0 ? 170 : 215); }
    }
    for (let i = 0; i < vertexCount; i++) {
      project(set[i * 3], set[i * 3 + 1], set[i * 3 + 2], p);
      SX[i] = p[0] - shiftX; SY[i] = p[1] - shiftY; SZ[i] = p[2];
    }
  } else {
    const w = windows.get(cam.name), extent = Math.max(w.maxX - w.minX, w.maxY - w.minY), pad = 0.06 * extent, scale = (cell - 8) / (extent + 2 * pad);
    for (let i = 0; i < vertexCount; i++) {
      const x = set[i * 3], y = set[i * 3 + 1], z = set[i * 3 + 2];
      SX[i] = ((x * right.x + y * right.y + z * right.z) - w.minX + pad) * scale + 4;
      SY[i] = cell - 4 - (((x * up.x + y * up.y + z * up.z) - w.minY + pad) * scale);
      SZ[i] = x * forward.x + y * forward.y + z * forward.z;
    }
    // world y = 0 reference line (side-on views only)
    const gy = Math.round(cell - 4 - ((0 - w.minY + pad) * scale));
    if (cam.name !== 'top' && gy >= 0 && gy < cell) for (let x = 0; x < cell; x++) plot(ox, oy, x, gy, 205);
  }
  const e1 = new Vector3(), e2 = new Vector3(), n = new Vector3();
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    e1.set(set[b * 3] - set[a * 3], set[b * 3 + 1] - set[a * 3 + 1], set[b * 3 + 2] - set[a * 3 + 2]);
    e2.set(set[c * 3] - set[a * 3], set[c * 3 + 1] - set[a * 3 + 1], set[c * 3 + 2] - set[a * 3 + 2]);
    n.crossVectors(e1, e2).normalize();
    const shade = 0.85 + 0.9 * Math.abs(n.dot(light));
    const x0 = SX[a], y0 = SY[a], x1 = SX[b], y1 = SY[b], x2 = SX[c], y2 = SY[c];
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area) < 1e-6) continue;
    const minPx = Math.max(0, Math.floor(Math.min(x0, x1, x2))), maxPx = Math.min(cell - 1, Math.ceil(Math.max(x0, x1, x2)));
    const minPy = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxPy = Math.min(cell - 1, Math.ceil(Math.max(y0, y1, y2)));
    for (let py = minPy; py <= maxPy; py++) for (let px = minPx; px <= maxPx; px++) {
      const qx = px + 0.5, qy = py + 0.5;
      const w1 = ((qx - x0) * (y2 - y0) - (x2 - x0) * (qy - y0)) / area, w2 = ((x1 - x0) * (qy - y0) - (qx - x0) * (y1 - y0)) / area, w0 = 1 - w1 - w2;
      if (w0 < -0.001 || w1 < -0.001 || w2 < -0.001) continue;
      const z = w0 * SZ[a] + w1 * SZ[b] + w2 * SZ[c];
      if (z >= depth[py * cell + px]) continue;
      depth[py * cell + px] = z;
      const o = ((oy + py) * width + ox + px) * 3;
      for (let k = 0; k < 3; k++) image[o + k] = Math.min(255, Math.round((w0 * colors[a * 3 + k] + w1 * colors[b * 3 + k] + w2 * colors[c * 3 + k]) * shade));
    }
  }
}
rows.forEach((row, r) => row.forEach((item, f) => rasterise(item, f * cell, r * cell)));

function png(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body) >>> 0, 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(w, 0); header.writeUInt32BE(h, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
writeFileSync(outPath, png(width, height, image));
console.log(JSON.stringify({ out: outPath, clips: clipNames, frames: columns, view, size: [width, height] }));
