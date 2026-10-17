/**
 * Deterministic in-memory IDBFactory for repository unit tests. It models what the SaveRepository relies on: named
 * databases that survive close/reopen, versioned upgrades, readwrite transactions that apply atomically on commit and
 * roll back on abort, ordered request execution, and request/commit fault injection. It is a behavioural fixture, not
 * browser evidence: real transactions are exercised by tests/storage/browser-smoke.html.
 */
import { isRecord } from "../../src/game/guards.js";

type Row = unknown;
const keyOf = (row: Row, keyPath: string): unknown => (isRecord(row) ? row[keyPath] : undefined);
export interface FaultContext {
  database: string;
  store: string;
  operation: "get" | "getAll" | "put" | "delete" | "openCursor" | "commit";
  /** 1-based index of this request among the transaction's requests (0 for commit). */
  requestIndex: number;
  /** 1-based index of the readwrite transaction opened on this factory. */
  transactionIndex: number;
}
export type Fault = "error" | "quota" | "abort";

class FakeRequest<T> {
  result!: T;
  error: DOMException | Error | null = null;
  onsuccess: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  transaction: FakeTransaction | null = null;
}

class FakeCursor {
  constructor(private readonly store: FakeStore, private readonly keys: unknown[], private index: number, private readonly request: FakeRequest<FakeCursor | null>) {}
  get value(): Row { return structuredClone(this.store.rows.get(this.keys[this.index])); }
  update(value: Row): void { this.store.put(value); }
  continue(): void { this.index += 1; this.request.result = this.index < this.keys.length ? this : null; this.store.transaction.dispatchSuccess(this.request); }
}

class FakeStore {
  readonly rows: Map<unknown, Row>;
  constructor(readonly name: string, readonly keyPath: string, rows: Map<unknown, Row>, readonly transaction: FakeTransaction) { this.rows = rows; }
  private enqueue<T>(operation: FaultContext["operation"], run: () => T): FakeRequest<T> {
    const request = new FakeRequest<T>();
    this.transaction.enqueue(this.name, operation, request, run);
    return request;
  }
  get(key: unknown): FakeRequest<Row> { return this.enqueue("get", () => structuredClone(this.rows.get(key))); }
  getAll(): FakeRequest<Row[]> { return this.enqueue("getAll", () => [...this.rows.values()].map((row) => structuredClone(row))); }
  put(value: Row): FakeRequest<unknown> {
    return this.enqueue("put", () => {
      const key = keyOf(value, this.keyPath);
      this.rows.set(key, structuredClone(value));
      return key;
    });
  }
  delete(key: unknown): FakeRequest<undefined> { return this.enqueue("delete", () => { this.rows.delete(key); return undefined; }); }
  openCursor(): FakeRequest<FakeCursor | null> {
    const request = new FakeRequest<FakeCursor | null>();
    this.transaction.enqueue(this.name, "openCursor", request, () => {
      const keys = [...this.rows.keys()];
      return keys.length ? new FakeCursor(this, keys, 0, request) : null;
    });
    return request;
  }
}

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onerror: (() => void) | null = null;
  error: DOMException | Error | null = null;
  private readonly working = new Map<string, Map<unknown, Row>>();
  private pending = 0;
  private requests = 0;
  private finished = false;
  private checking = false;
  constructor(
    private readonly database: FakeDatabase,
    private readonly names: readonly string[],
    private readonly mode: IDBTransactionMode,
    private readonly transactionIndex: number,
  ) {
    for (const name of names) this.working.set(name, new Map(structuredClone([...database.stores.get(name)!.rows])));
    this.scheduleCheck();
  }
  objectStore(name: string): FakeStore {
    const definition = this.database.stores.get(name);
    if (!definition || (this.mode !== "versionchange" && !this.names.includes(name))) {
      throw new DOMException("Store not in transaction scope", "NotFoundError");
    }
    let rows = this.working.get(name);
    if (!rows) {
      // A versionchange transaction edits the live store directly.
      rows = definition.rows;
      this.working.set(name, rows);
    }
    return new FakeStore(name, definition.keyPath, rows, this);
  }
  enqueue<T>(store: string, operation: FaultContext["operation"], request: FakeRequest<T>, run: () => T): void {
    if (this.finished) throw new DOMException("The transaction has finished.", "TransactionInactiveError");
    if (this.mode === "readonly" && (operation === "put" || operation === "delete")) throw new DOMException("Read-only transaction", "ReadOnlyError");
    this.pending += 1;
    this.requests += 1;
    const index = this.requests;
    request.transaction = this;
    setTimeout(() => {
      if (this.finished) return;
      const fault = this.database.factory.faultFor({ database: this.database.name, store, operation, requestIndex: index, transactionIndex: this.transactionIndex });
      if (fault) { this.fail(request, fault); return; }
      request.result = run();
      this.dispatchSuccess(request);
    }, 0);
  }
  dispatchSuccess<T>(request: FakeRequest<T>): void {
    request.onsuccess?.({ target: request } as unknown as Event);
    if (request instanceof FakeRequest && !(request.result instanceof FakeCursor)) this.pending -= 1;
    else if (request.result === null) this.pending -= 1;
    this.scheduleCheck();
  }
  private fail(request: FakeRequest<unknown>, fault: Fault): void {
    request.error = fault === "quota" ? new DOMException("quota", "QuotaExceededError") : new DOMException("injected request failure", "AbortError");
    request.onerror?.({ target: request, preventDefault() {} } as unknown as Event);
    this.error = request.error;
    this.finished = true;
    this.onerror?.();
    this.onabort?.();
  }
  abort(): void {
    if (this.finished) return;
    this.finished = true;
    this.error = this.error ?? new DOMException("aborted", "AbortError");
    queueMicrotask(() => this.onabort?.());
  }
  private scheduleCheck(): void {
    if (this.checking) return;
    this.checking = true;
    setTimeout(() => {
      this.checking = false;
      if (this.finished) return;
      if (this.pending > 0) { this.scheduleCheck(); return; }
      const fault = this.mode === "readwrite"
        ? this.database.factory.faultFor({ database: this.database.name, store: this.names[0]!, operation: "commit", requestIndex: 0, transactionIndex: this.transactionIndex })
        : undefined;
      this.finished = true;
      if (fault) {
        this.error = new DOMException("injected commit failure", "AbortError");
        this.onabort?.();
        return;
      }
      if (this.mode !== "readonly") for (const [name, rows] of this.working) this.database.stores.get(name)!.rows = rows;
      this.oncomplete?.();
    }, 0);
  }
}

class FakeDatabase {
  readonly stores = new Map<string, { keyPath: string; rows: Map<unknown, Row> }>();
  version = 0;
  onversionchange: (() => void) | null = null;
  constructor(readonly name: string, readonly factory: FakeIDBFactory) {}
  get objectStoreNames(): { contains(name: string): boolean } { return { contains: (name) => this.stores.has(name) }; }
  createObjectStore(name: string, options: { keyPath: string }): void { this.stores.set(name, { keyPath: options.keyPath, rows: new Map() }); }
  transaction(names: string | string[], mode: IDBTransactionMode = "readonly"): FakeTransaction {
    const list = typeof names === "string" ? [names] : names;
    return new FakeTransaction(this, list, mode, mode === "readwrite" ? this.factory.nextTransactionIndex() : 0);
  }
  close(): void { /* committed data persists in the factory; handles are stateless */ }
}

/** Create one factory per simulated browser profile; reopening a database name returns its committed data. */
export class FakeIDBFactory {
  private readonly databases = new Map<string, FakeDatabase>();
  private transactions = 0;
  /** Return a fault for the matching request/commit; transactions roll back as in IndexedDB. */
  fault: ((context: FaultContext) => Fault | undefined) | null = null;
  readonly opened: string[] = [];
  faultFor(context: FaultContext): Fault | undefined { return this.fault?.(context); }
  nextTransactionIndex(): number { this.transactions += 1; return this.transactions; }
  /** Number of readwrite transactions opened so far, so a test can fault exactly the next write. */
  get transactionCount(): number { return this.transactions; }
  asFactory(): IDBFactory { return this as unknown as IDBFactory; }
  /** Committed rows of a store, for assertions that bypass the repository. */
  rows(database: string, store: string): Row[] {
    return [...(this.databases.get(database)?.stores.get(store)?.rows.values() ?? [])].map((row) => structuredClone(row));
  }
  /** Seeds committed rows directly (legacy-format fixtures). */
  seed(database: string, store: string, keyPath: string, rows: readonly Row[], version = 2): void {
    const db = this.databases.get(database) ?? new FakeDatabase(database, this);
    db.version = version;
    if (!db.stores.has(store)) db.stores.set(store, { keyPath, rows: new Map() });
    for (const row of rows) db.stores.get(store)!.rows.set(keyOf(row, keyPath), structuredClone(row));
    this.databases.set(database, db);
  }
  open(name: string, version: number): FakeRequest<FakeDatabase> & { onupgradeneeded: ((event: { oldVersion: number }) => void) | null; onblocked: (() => void) | null } {
    this.opened.push(name);
    const request = Object.assign(new FakeRequest<FakeDatabase>(), { onupgradeneeded: null as ((event: { oldVersion: number }) => void) | null, onblocked: null as (() => void) | null });
    setTimeout(() => {
      let db = this.databases.get(name);
      const oldVersion = db?.version ?? 0;
      if (oldVersion > version) {
        request.error = new DOMException("version", "VersionError");
        request.onerror?.({ target: request } as unknown as Event);
        return;
      }
      if (!db) { db = new FakeDatabase(name, this); this.databases.set(name, db); }
      request.result = db;
      if (oldVersion < version) {
        const upgrade = new FakeTransaction(db, [...db.stores.keys()], "versionchange" as IDBTransactionMode, 0);
        (request as unknown as { transaction: FakeTransaction }).transaction = upgrade;
        db.version = version;
        request.onupgradeneeded?.({ oldVersion });
      }
      request.onsuccess?.({ target: request } as unknown as Event);
    }, 0);
    return request;
  }
}
