import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { SOUND_GROUPS, allCatalogFiles, packGroups } from '../../src/audio/SampleCatalog.js';

const publicRoot = resolve(import.meta.dir, '../../public');
const audioRoot = join(publicRoot, 'audio');

interface Provenance {
  readonly allowedLicenses: readonly string[];
  readonly totals: { readonly files: number; readonly bytes: number };
  readonly files: readonly {
    readonly path: string; readonly kind: 'sfx' | 'music' | 'stinger' | 'ambience'; readonly bytes: number; readonly sha256: string;
    readonly durationSeconds: number; readonly channels: number; readonly measuredLufs: number; readonly targetLufs: number; readonly truePeakDbfs: number | null;
    readonly source: {
      readonly packId: string; readonly title: string; readonly author: string; readonly pageUrl: string; readonly downloadUrl: string; readonly license: string;
      readonly licenseUrl: string; readonly downloadedAt: string; readonly originalFilename: string; readonly sourceSha256: string; readonly archiveSha256?: string;
    };
    readonly edits: readonly string[];
  }[];
}
const provenance = JSON.parse(readFileSync(join(audioRoot, 'provenance.json'), 'utf8')) as Provenance;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => (entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]));
}
const onDisk = walk(audioRoot).map(file => relative(publicRoot, file)).filter(file => file !== 'audio/provenance.json').sort();
const sha256 = (file: string): string => createHash('sha256').update(readFileSync(join(publicRoot, file))).digest('hex');

describe('audio provenance manifest', () => {
  it('lists every audio file on disk, and only files that exist', () => {
    expect(provenance.files.map(entry => entry.path).sort()).toEqual(onDisk);
    expect(new Set(provenance.files.map(entry => entry.path)).size).toBe(provenance.files.length);
    expect(provenance.totals.files).toBe(provenance.files.length);
    expect(provenance.totals.bytes).toBe(provenance.files.reduce((sum, entry) => sum + entry.bytes, 0));
  });

  it('matches the SHA-256 and size of every shipped file', () => {
    for (const entry of provenance.files) {
      expect(sha256(entry.path), entry.path).toBe(entry.sha256);
      expect(statSync(join(publicRoot, entry.path)).size, entry.path).toBe(entry.bytes);
    }
  });

  it('records source, author, licence and URL, download date, original filename, source hash and edits for every file', () => {
    for (const entry of provenance.files) {
      const { source } = entry;
      expect(source.author.length, entry.path).toBeGreaterThan(0);
      expect(source.title.length, entry.path).toBeGreaterThan(0);
      expect(source.pageUrl, entry.path).toMatch(/^https:\/\/(kenney\.nl|opengameart\.org|freesound\.org)\//);
      expect(source.downloadUrl, entry.path).toMatch(/^https:\/\//);
      expect(source.licenseUrl, entry.path).toMatch(/^https?:\/\/(creativecommons\.org)\//);
      expect(source.downloadedAt, entry.path).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(source.originalFilename.length, entry.path).toBeGreaterThan(0);
      expect(source.sourceSha256, entry.path).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.sha256, entry.path).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.edits.length, entry.path).toBeGreaterThan(0);
      expect(entry.edits.some(edit => edit.startsWith('encoded Opus')), entry.path).toBe(true);
      expect(entry.edits.some(edit => edit.startsWith('loudness normalised')), entry.path).toBe(true);
    }
  });

  it('only ships CC0 / CC-BY material (no NC, ND or unclear licences)', () => {
    expect(provenance.allowedLicenses.sort()).toEqual(['CC-BY-3.0', 'CC-BY-4.0', 'CC0-1.0']);
    for (const entry of provenance.files) {
      expect(provenance.allowedLicenses, entry.path).toContain(entry.source.license);
      expect(entry.source.license, entry.path).not.toMatch(/NC|ND|unknown|unclear/i);
      // The licence URL must belong to the declared licence.
      if (entry.source.license === 'CC0-1.0') expect(entry.source.licenseUrl, entry.path).toContain('publicdomain/zero/1.0');
    }
  });

  it('is a clean one-to-one mapping with the runtime catalogue', () => {
    const catalogue = allCatalogFiles();
    expect([...catalogue]).toEqual(provenance.files.map(entry => entry.path).sort());
    for (const group of Object.values(SOUND_GROUPS)) expect(group.files.length, group.id).toBeGreaterThan(0);
  });
});

describe('audio library mastering and payload', () => {
  it('hits the loudness targets (music -16 LUFS, one-shots -14..-18 LUFS or the peak ceiling)', () => {
    for (const entry of provenance.files) {
      if (entry.kind === 'sfx') {
        expect(entry.targetLufs, entry.path).toBeGreaterThanOrEqual(-18);
        expect(entry.targetLufs, entry.path).toBeLessThanOrEqual(-13);
        // Very peaky clips stop at the -1.5 dBFS limiter before they reach the target; everything else must be within 3 LU of it.
        const peakLimited = entry.truePeakDbfs !== null && entry.truePeakDbfs >= -2.2;
        if (!peakLimited) expect(Math.abs(entry.measuredLufs - entry.targetLufs), entry.path).toBeLessThanOrEqual(3);
        expect(entry.measuredLufs, entry.path).toBeGreaterThanOrEqual(peakLimited ? -30 : -22);
      } else if (entry.kind === 'ambience') {
        expect(Math.abs(entry.measuredLufs - entry.targetLufs), entry.path).toBeLessThanOrEqual(2.5);
      } else {
        expect(entry.targetLufs, entry.path).toBe(-16);
        expect(Math.abs(entry.measuredLufs - -16), entry.path).toBeLessThanOrEqual(1);
      }
      // The build limits to -1.5 dBFS and re-encodes until the decoded Opus true peak is at most -1.0 dBFS.
      if (entry.truePeakDbfs !== null) expect(entry.truePeakDbfs, entry.path).toBeLessThanOrEqual(-1);
    }
  });

  it('keeps the initial (core) download small and the whole library bounded', () => {
    const size = (path: string): number => provenance.files.find(entry => entry.path === path)!.bytes;
    const coreFiles = [...new Set(packGroups('core').flatMap(group => group.files))];
    const coreBytes = coreFiles.reduce((sum, path) => sum + size(path), 0);
    expect(coreBytes).toBeGreaterThan(0);
    expect(coreBytes).toBeLessThan(400 * 1024);
    expect(provenance.totals.bytes).toBeLessThan(13 * 1024 * 1024);
    // Music is streamed per region; no single stream exceeds 1.2 MB.
    for (const entry of provenance.files.filter(item => item.kind !== 'sfx')) expect(entry.bytes, entry.path).toBeLessThan(1.2 * 1024 * 1024);
  });

  it('decodes to a bounded PCM footprint for the one-shot packs (mono, short)', () => {
    for (const entry of provenance.files.filter(item => item.kind === 'sfx')) {
      expect(entry.channels, entry.path).toBe(1);
      expect(entry.durationSeconds, entry.path).toBeLessThan(4);
    }
    const pcm = provenance.files.filter(item => item.kind === 'sfx').reduce((sum, entry) => sum + entry.durationSeconds * 48000 * 4, 0);
    expect(pcm).toBeLessThan(40 * 1024 * 1024);
  });
});
