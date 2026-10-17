import { SOUND_GROUPS, packGroups } from './SampleCatalog.js';

export interface SampleBankDeps {
  /** Fetches the encoded bytes of one catalogue path. */
  readonly fetchBytes: (path: string) => Promise<ArrayBuffer>;
  /** Decodes off the main thread (`AudioContext.decodeAudioData`); the bank never decodes synchronously. */
  readonly decode: (bytes: ArrayBuffer) => Promise<AudioBuffer>;
}

export interface SampleBankStats {
  readonly loadedFiles: number;
  readonly encodedBytes: number;
  /** Float32 PCM bytes held by decoded buffers. */
  readonly decodedBytes: number;
  readonly failedFiles: readonly string[];
  readonly loadedPacks: readonly string[];
}

/**
 * Decode-once cache of the one-shot samples. Packs load lazily and concurrently; a path is fetched and decoded at most once even when
 * several packs list it. Failures are recorded (never swallowed silently): `stats.failedFiles` lists them and `loadPack` reports them.
 */
export class SampleBank {
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly packs = new Map<string, Promise<readonly string[]>>();
  private readonly failed = new Set<string>();
  private readonly donePacks: string[] = [];
  private encodedBytes = 0;
  private decodedBytes = 0;

  constructor(private readonly deps: SampleBankDeps, private readonly onFailure?: (path: string, error: unknown) => void) {}

  get(path: string): AudioBuffer | undefined { return this.buffers.get(path); }

  /** Loads every file of a pack (idempotent). Resolves with the paths that failed to load. */
  loadPack(pack: string): Promise<readonly string[]> {
    const existing = this.packs.get(pack);
    if (existing) return existing;
    const paths = [...new Set(packGroups(pack).flatMap(group => group.files))];
    const task = Promise.all(paths.map(path => this.loadFile(path))).then(() => {
      this.donePacks.push(pack);
      return paths.filter(path => this.failed.has(path));
    });
    this.packs.set(pack, task);
    return task;
  }

  isPackLoaded(pack: string): boolean { return this.donePacks.includes(pack); }

  /** Path of the variant returned by the last successful `pick` (diagnostics only). */
  lastPickedPath = '';

  /** Resolves a sound group to a decoded variant, or undefined while its pack is still loading. Allocation-free. */
  pick(groupId: string, random: number): AudioBuffer | undefined {
    const group = SOUND_GROUPS[groupId];
    if (!group) return undefined;
    let ready = 0;
    for (const file of group.files) if (this.buffers.has(file)) ready++;
    if (ready === 0) return undefined;
    let skip = Math.min(ready - 1, Math.floor(random * ready));
    for (const file of group.files) {
      const buffer = this.buffers.get(file);
      if (!buffer) continue;
      if (skip-- === 0) { this.lastPickedPath = file; return buffer; }
    }
    return undefined;
  }

  get stats(): SampleBankStats {
    return { loadedFiles: this.buffers.size, encodedBytes: this.encodedBytes, decodedBytes: this.decodedBytes, failedFiles: [...this.failed], loadedPacks: [...this.donePacks] };
  }

  clear(): void {
    this.buffers.clear();
    this.inflight.clear();
    this.packs.clear();
    this.failed.clear();
    this.donePacks.length = 0;
    this.encodedBytes = 0;
    this.decodedBytes = 0;
  }

  private loadFile(path: string): Promise<void> {
    if (this.buffers.has(path)) return Promise.resolve();
    const pending = this.inflight.get(path);
    if (pending) return pending;
    const task = this.deps.fetchBytes(path).then(async bytes => {
      this.encodedBytes += bytes.byteLength;
      const buffer = await this.deps.decode(bytes);
      this.buffers.set(path, buffer);
      this.decodedBytes += buffer.length * buffer.numberOfChannels * 4;
      this.failed.delete(path);
    }).catch((error: unknown) => {
      this.failed.add(path);
      this.onFailure?.(path, error);
    }).finally(() => { this.inflight.delete(path); });
    this.inflight.set(path, task);
    return task;
  }
}
