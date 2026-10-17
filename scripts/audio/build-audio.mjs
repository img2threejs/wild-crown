#!/usr/bin/env node
// Rebuilds public/audio/** (Opus-in-Ogg) and public/audio/provenance.json from the licensed source packs in sources.mjs.
// Usage: node scripts/audio/build-audio.mjs [--cache <dir>] [--only <path-prefix>]
// Needs ffmpeg (libopus), ffprobe, curl and unzip on PATH. Source packs are downloaded into the cache when missing.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOWNLOAD_DATE, PACKS } from './sources.mjs';
import { ITEMS } from './items.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const argValue = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const cache = resolve(argValue('--cache') ?? join(tmpdir(), 'wc-audio-cache'));
const only = argValue('--only');
const outRoot = join(root, 'public', 'audio');
const work = join(cache, '_work');
mkdirSync(cache, { recursive: true });
mkdirSync(work, { recursive: true });

const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...opts });
const ff = (...argv) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...argv]);
const probe = file => {
  const j = JSON.parse(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=sample_rate,channels', '-of', 'json', file]));
  return { duration: Number(j.format.duration), sampleRate: Number(j.streams[0].sample_rate), channels: Number(j.streams[0].channels) };
};

/**
 * Integrated loudness and peak of a file. One-shots shorter than the 3 s tile are repeated back to back first, so the number is the
 * loudness of the clip played continuously (a 100 ms click padded with silence would otherwise read 15 dB too quiet under BS.1770 gating).
 * ffmpeg prints the ebur128 summary to stderr.
 */
function loudness(file) {
  const { duration, sampleRate } = probe(file);
  const tile = Math.max(3, duration);
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-t', String(tile), '-af', `aloop=loop=-1:size=${Math.ceil(duration * sampleRate) + 1},ebur128=peak=true`, '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const summary = r.stderr.slice(r.stderr.lastIndexOf('Summary:'));
  const i = /\n\s+I:\s+(-?[\d.]+|-inf) LUFS/.exec(summary);
  const p = /Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(summary);
  if (!i) throw new Error('could not parse ebur128 summary for ' + file + '\n' + r.stderr.slice(-400));
  return { lufs: Number(i[1]), truePeak: p ? Number(p[1]) : null };
}

function ensurePack(id) {
  const pack = PACKS[id];
  if (!pack) throw new Error('unknown source pack ' + id);
  const file = join(cache, pack.file);
  if (!existsSync(file)) {
    console.log('downloading', pack.url);
    run('curl', ['-sS', '-L', '-m', '600', '-A', 'Mozilla/5.0', '-o', file, pack.url]);
  }
  let dir;
  if (pack.archive) {
    dir = join(cache, id);
    if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); run('unzip', ['-qo', file, '-d', dir]); }
  }
  return { pack, file, dir, archiveSha256: sha256(file) };
}

const packCache = new Map();
const getPack = id => { if (!packCache.has(id)) packCache.set(id, ensurePack(id)); return packCache.get(id); };

function buildItem(item) {
  const { pack, file, dir, archiveSha256 } = getPack(item.pack);
  const src = pack.archive ? join(dir, item.member) : file;
  if (!existsSync(src)) throw new Error(`missing source member ${item.member} in ${item.pack}`);
  const meta = probe(src);
  const mono = item.mono ?? (item.kind === 'sfx');
  const target = item.lufs ?? -16;
  const edits = [];
  const filters = [];
  if (item.start !== undefined || item.end !== undefined) {
    const parts = [];
    if (item.start !== undefined) parts.push(`start=${item.start}`);
    if (item.end !== undefined) parts.push(`end=${item.end}`);
    filters.push(`atrim=${parts.join(':')}`, 'asetpts=PTS-STARTPTS');
    edits.push(`trimmed to ${item.start ?? 0}s-${item.end ?? 'end'}s`);
  }
  if (item.pitch) {
    filters.push(`asetrate=${Math.round(meta.sampleRate * 2 ** (item.pitch / 12))}`, 'aresample=48000');
    edits.push(`resample pitch shift ${item.pitch > 0 ? '+' : ''}${item.pitch} semitones (duration scales)`);
  }
  if (item.hp) { filters.push(`highpass=f=${item.hp}`); edits.push(`high-pass ${item.hp} Hz`); }
  if (item.lp) { filters.push(`lowpass=f=${item.lp}`); edits.push(`low-pass ${item.lp} Hz`); }
  const trimmedDuration = Math.min(meta.duration, item.end ?? meta.duration) - (item.start ?? 0);
  const playedDuration = trimmedDuration * (item.pitch ? 2 ** (-item.pitch / 12) : 1);
  if (item.fadeIn) { filters.push(`afade=t=in:st=0:d=${item.fadeIn}`); edits.push(`${item.fadeIn}s fade-in`); }
  if (item.fadeOut) { filters.push(`afade=t=out:st=${Math.max(0, playedDuration - item.fadeOut).toFixed(3)}:d=${item.fadeOut}`); edits.push(`${item.fadeOut}s fade-out`); }
  if (item.kind === 'sfx' && item.compress !== false) {
    // One-shots are peaky; compression lets them reach their loudness target under the -1.5 dBFS peak ceiling. 'hard' is for foley (footsteps, UI ticks).
    if (item.compress === 'hard') {
      filters.push('acompressor=threshold=0.03:ratio=6:attack=1:release=60:makeup=4');
      edits.push('compressed 6:1 above -30 dBFS (attack 1 ms, release 60 ms)');
    } else {
      filters.push('acompressor=threshold=0.1:ratio=3:attack=2:release=80:makeup=1');
      edits.push('compressed 3:1 above -20 dBFS (attack 2 ms, release 80 ms)');
    }
  }
  if (mono && meta.channels > 1) edits.push('downmixed to mono');
  const stage1 = join(work, 'stage1.wav');
  ff('-i', src, ...(filters.length ? ['-af', filters.join(',')] : []), '-ar', '48000', '-ac', mono ? '1' : '2', '-c:a', 'pcm_f32le', stage1);
  let stage = stage1;
  if (item.loopXfade) {
    const x = item.loopXfade;
    const t = probe(stage1).duration;
    const stage2 = join(work, 'stage2.wav');
    ff('-i', stage1, '-filter_complex',
      `[0:a]asplit=3[a][b][c];[a]atrim=start=${x}:end=${(t - x).toFixed(4)},asetpts=PTS-STARTPTS[body];` +
      `[b]atrim=start=${(t - x).toFixed(4)},asetpts=PTS-STARTPTS[tail];[c]atrim=start=0:end=${x},asetpts=PTS-STARTPTS[head];` +
      `[tail][head]acrossfade=d=${x}:c1=qsin:c2=qsin[x];[body][x]concat=n=2:v=0:a=1[out]`, '-map', '[out]', '-c:a', 'pcm_f32le', stage2);
    stage = stage2;
    edits.push(`seamless loop: ${x}s equal-power crossfade of the tail into the head`);
  }
  const before = loudness(stage);
  const gain = Math.max(-30, Math.min(30, target - before.lufs));
  const out = join(outRoot, item.out + '.ogg');
  mkdirSync(dirname(out), { recursive: true });
  const kbps = item.kbps ?? 48;
  // Limiter ceiling starts at -1.5 dBFS; Opus reconstruction can overshoot it, so lower the ceiling and re-encode until the decoded true peak is <= -1.0 dBFS.
  let ceiling = 0.84;
  let after;
  for (let attempt = 0; attempt < 5; attempt++) {
    ff('-i', stage, '-af', `volume=${gain.toFixed(3)}dB,alimiter=limit=${ceiling.toFixed(4)}:level=disabled:attack=2:release=40`, '-c:a', 'libopus', '-b:a', kbps + 'k', '-vbr', 'on', '-application', 'audio', '-ar', '48000', '-ac', mono ? '1' : '2', out);
    after = loudness(out);
    if (after.truePeak === null || after.truePeak <= -1.0) break;
    ceiling *= 10 ** ((-1.0 - after.truePeak - 0.3) / 20);
  }
  edits.push(`loudness normalised to ${target} LUFS integrated (gain ${gain >= 0 ? '+' : ''}${gain.toFixed(2)} dB, peak-limited to ${(20 * Math.log10(ceiling)).toFixed(1)} dBFS before encoding)`);
  edits.push(`encoded Opus in Ogg, ${kbps} kbps ${mono ? 'mono' : 'stereo'}, 48 kHz`);
  const info = probe(out);
  return {
    path: 'audio/' + item.out + '.ogg',
    kind: item.kind,
    bytes: statSync(out).size,
    sha256: sha256(out),
    durationSeconds: Number(info.duration.toFixed(3)),
    channels: info.channels,
    measuredLufs: Number(after.lufs.toFixed(1)),
    targetLufs: target,
    truePeakDbfs: after.truePeak,
    source: {
      packId: item.pack,
      title: pack.title,
      author: pack.author,
      pageUrl: pack.page,
      downloadUrl: pack.url,
      license: pack.license.id,
      licenseUrl: pack.license.url,
      downloadedAt: DOWNLOAD_DATE,
      originalFilename: pack.archive ? item.member : pack.original ?? pack.file,
      archiveFilename: pack.archive ? decodeURIComponent(pack.url.split('/').pop()) : undefined,
      archiveSha256: pack.archive ? archiveSha256 : undefined,
      sourceSha256: sha256(src),
    },
    edits,
  };
}

const selected = ITEMS.filter(item => !only || item.out.startsWith(only));
const existing = existsSync(join(outRoot, 'provenance.json')) && only ? JSON.parse(readFileSync(join(outRoot, 'provenance.json'), 'utf8')).files : [];
const built = [];
for (const item of selected) {
  const entry = buildItem(item);
  built.push(entry);
  console.log(entry.path, entry.bytes + ' B', entry.measuredLufs + ' LUFS');
}
const builtPaths = new Set(built.map(entry => entry.path));
const files = [...existing.filter(entry => !builtPaths.has(entry.path)), ...built].sort((a, b) => a.path.localeCompare(b.path));
const manifest = {
  schema: 1,
  description: 'Provenance of every file under public/audio. Regenerate with scripts/audio/build-audio.mjs; tests/audio/audio-library.test.ts verifies licences, hashes and catalogue coverage.',
  allowedLicenses: ['CC0-1.0', 'CC-BY-3.0', 'CC-BY-4.0'],
  totals: { files: files.length, bytes: files.reduce((sum, f) => sum + f.bytes, 0) },
  files,
};
writeFileSync(join(outRoot, 'provenance.json'), JSON.stringify(manifest, null, 1) + '\n');
rmSync(work, { recursive: true, force: true });
console.log(`wrote ${files.length} files, ${manifest.totals.bytes} bytes`);
