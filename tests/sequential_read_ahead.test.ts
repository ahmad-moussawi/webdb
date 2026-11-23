import "fake-indexeddb/auto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WebDB,
  DataType,
  IdbStorage,
  MemoryStorage,
  Io,
  BufferPoolDriver,
  CorruptPageError,
  createWasmMemory,
  createVmContext,
  VmStatus,
  col,
} from "../src/index.js";
import { NodeFsStorage } from "../src/host/storage/node_fs.ts";
import { ReadOnlyOverlayVfs } from "../src/host/storage/read_only_overlay.ts";
import { computePage1Checksum } from "../src/host/storage/crc32.ts";
import { page_init } from "../src/core/index.js";
import {
  PAGE_SIZE,
  PAGE_TYPE_CATALOG_PAGE,
  PAGE_TYPE_FREE,
  PAGE_TYPE_INDEX_INTERIOR,
  PAGE_TYPE_INDEX_LEAF,
  PAGE_TYPE_LEAF_DATA,
  PAGE_TYPE_OVERFLOW,
  PAGE_TYPE_TABLE_INTERIOR,
  HEADER_OFFSET_TOTAL_PAGES,
  HEADER_OFFSET_PAGE_CHECKSUM,
} from "../src/constants.js";
import { testEngine } from "./helpers/test_engine.js";

let openedDbs: WebDB[] = [];
let tempDirs: string[] = [];
let dbSeq = 0;

function uniqueName(prefix: string): string {
  return `${prefix}_${Date.now()}_${dbSeq++}_${Math.random().toString(36).slice(2, 7)}`;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(openedDbs.map((d) => d.close().catch(() => {})));
  openedDbs = [];
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})),
  );
  tempDirs = [];
});

interface IdbSpyStats {
  readonlyTxs: number;
  readwriteTxs: number;
  getAllRangeCalls: Array<{ lower: any; upper: any }>;
  clear: () => void;
}

function spyIdbReadActivity(): IdbSpyStats {
  const stats: IdbSpyStats = {
    readonlyTxs: 0,
    readwriteTxs: 0,
    getAllRangeCalls: [],
    clear: () => {
      stats.readonlyTxs = 0;
      stats.readwriteTxs = 0;
      stats.getAllRangeCalls = [];
    },
  };

  const origTx = IDBDatabase.prototype.transaction;
  vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (
    this: IDBDatabase,
    storeNames: string | Iterable<string>,
    mode?: IDBTransactionMode,
    options?: IDBTransactionOptions,
  ) {
    if (mode === "readwrite") {
      stats.readwriteTxs++;
    } else {
      stats.readonlyTxs++;
    }
    return origTx.call(this, storeNames as any, mode, options);
  });

  const origGetAll = IDBObjectStore.prototype.getAll;
  vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(function (
    this: IDBObjectStore,
    query?: IDBValidKey | IDBKeyRange | null,
    count?: number,
  ) {
    if (query && typeof query === "object" && "lower" in query) {
      stats.getAllRangeCalls.push({
        lower: (query as IDBKeyRange).lower,
        upper: (query as IDBKeyRange).upper,
      });
    }
    return origGetAll.call(this, query as any, count);
  });

  return stats;
}

function initRawPage(
  pageType: number,
  nextPageId: number = 0,
  markerByte?: number,
): Uint8Array {
  const buf = new Uint8Array(PAGE_SIZE);
  const view = new DataView(buf.buffer);
  page_init(view, 0, pageType, nextPageId);
  if (markerByte !== undefined) {
    buf[20] = markerByte;
  }
  return buf;
}

describe("Sequential Page Read Detection & Adaptive Read-Ahead", () => {
  it("batches cold IdbStorage full table, filtered, and ORDER BY scans via IDBKeyRange fast-path", async () => {
    const dbName = uniqueName("seq_idb_full_scan");
    const db = await WebDB.open({
      name: dbName,
      engine: testEngine(),
      storage: new IdbStorage(dbName),
      crossTabSync: false,
    });

    await db.createTable("events", [
      { name: "id", type: DataType.INT32, notNull: true },
      { name: "kind", type: DataType.TEXT, notNull: true },
      { name: "payload", type: DataType.TEXT, notNull: true },
    ]);

    const rowsToInsert = Array.from({ length: 500 }, (_, i) => ({
      id: i + 1,
      kind: i % 2 === 0 ? "even" : "odd",
      payload: `event-payload-row-${i + 1}-` + "x".repeat(160),
    }));
    await db.insertMany("events", rowsToInsert);
    await db.close();

    // Reopen cold against IdbStorage
    const coldDb = await WebDB.open({
      name: dbName,
      engine: testEngine(),
      storage: new IdbStorage(dbName),
      crossTabSync: false,
    });
    openedDbs.push(coldDb);

    const totalPages = coldDb.pool
      .getSlotDataView(0)
      .getUint32(HEADER_OFFSET_TOTAL_PAGES, true);
    expect(totalPages).toBeGreaterThanOrEqual(25);

    const readBatches: number[][] = [];
    const origReadPages = coldDb.vfs.readPages.bind(coldDb.vfs);
    vi.spyOn(coldDb.vfs, "readPages").mockImplementation(async (ids) => {
      readBatches.push([...ids]);
      return origReadPages(ids);
    });
    const idbStats = spyIdbReadActivity();

    const allRows = await coldDb.from("events").toArray();
    expect(allRows).toHaveLength(500);
    expect(allRows[0].id).toBe(1);
    expect(allRows[499].id).toBe(500);

    // Cold scan over 25+ pages collapses from ~25+ IDB transactions down to <= 6
    expect(idbStats.readonlyTxs).toBeLessThanOrEqual(6);
    expect(idbStats.getAllRangeCalls.length).toBeGreaterThan(0);
    expect(readBatches.some((b) => b.length >= 4)).toBe(true);

    // Reopen a second cold instance to verify filtered & ORDER BY scans also benefit
    await coldDb.close();
    openedDbs.pop();

    const coldDb2 = await WebDB.open({
      name: dbName,
      engine: testEngine(),
      storage: new IdbStorage(dbName),
      crossTabSync: false,
    });
    openedDbs.push(coldDb2);
    idbStats.clear();

    const filteredSorted = await coldDb2
      .from("events")
      .where(col("kind").eq("even"))
      .orderBy("id", "desc")
      .toArray();
    expect(filteredSorted).toHaveLength(250);
    expect(filteredSorted[0].id).toBe(499);
    expect(filteredSorted[249].id).toBe(1);
    expect(idbStats.readonlyTxs).toBeLessThanOrEqual(6);
  });

  it("handles indexed table interleaving and secondary index range scans on cold IdbStorage", async () => {
    const dbName = uniqueName("seq_idb_indexed_interleave");
    const db = await WebDB.open({
      name: dbName,
      engine: testEngine(),
      storage: new IdbStorage(dbName),
      crossTabSync: false,
    });

    await db.createTable("orders", [
      { name: "id", type: DataType.INT32, primaryKey: true },
      { name: "customer_tier", type: DataType.INT32, notNull: true },
      { name: "notes", type: DataType.TEXT, notNull: true },
    ]);
    await db.createIndex("orders", ["customer_tier"], {
      name: "idx_orders_tier",
    });

    const batch = Array.from({ length: 450 }, (_, i) => ({
      id: i + 1,
      customer_tier: i < 200 ? 1 : 2,
      notes: `order-details-${i + 1}-` + "y".repeat(170),
    }));
    await db.insertMany("orders", batch);
    await db.close();

    // 1. Cold full table scan across interleaved data + index pages
    const cold1 = await WebDB.open({
      name: dbName,
      engine: testEngine(),
      storage: new IdbStorage(dbName),
      crossTabSync: false,
    });
    openedDbs.push(cold1);
    const idbStats = spyIdbReadActivity();

    const full = await cold1.from("orders").toArray();
    expect(full).toHaveLength(450);
    expect(idbStats.readonlyTxs).toBeLessThanOrEqual(8);

    await cold1.close();
    openedDbs.pop();

    // 2. Cold secondary index range scan
    const cold2 = await WebDB.open({
      name: dbName,
      engine: testEngine(),
      storage: new IdbStorage(dbName),
      crossTabSync: false,
    });
    openedDbs.push(cold2);
    idbStats.clear();

    const tier1Rows = await cold2
      .from("orders")
      .where("customer_tier", "=", 1)
      .toArray();
    expect(tier1Rows).toHaveLength(200);
    expect(idbStats.readonlyTxs).toBeLessThanOrEqual(8);
  });

  it("batches large overflow chains (> 60 KB payload) on cold IdbStorage", async () => {
    const dbName = uniqueName("seq_idb_overflow_chain");
    const db = await WebDB.open({
      name: dbName,
      engine: testEngine(),
      storage: new IdbStorage(dbName),
      crossTabSync: false,
    });

    await db.createTable("docs", [
      { name: "id", type: DataType.INT32, primaryKey: true },
      { name: "body", type: DataType.TEXT, notNull: true },
    ]);

    const hugeBody = "Z".repeat(66_000); // ~17 overflow pages
    await db.insert("docs", { id: 1, body: hugeBody });
    await db.close();

    const coldDb = await WebDB.open({
      name: dbName,
      engine: testEngine(),
      storage: new IdbStorage(dbName),
      crossTabSync: false,
    });
    openedDbs.push(coldDb);

    const idbStats = spyIdbReadActivity();
    const res = await coldDb.from("docs").toArray();
    expect(res).toHaveLength(1);
    expect((res[0].body as string).length).toBe(66_000);
    expect(res[0].body).toBe(hugeBody);
    // 1 data page + 1st overflow page + batched overflow windows (<= 5 total readonly txs)
    expect(idbStats.readonlyTxs).toBeLessThanOrEqual(5);
  });

  it("issues zero speculative reads for indexed point lookups", async () => {
    const dbName = uniqueName("seq_idb_point_lookup");
    const db = await WebDB.open({
      name: dbName,
      engine: testEngine(),
      storage: new IdbStorage(dbName),
      crossTabSync: false,
    });

    await db.createTable("accounts", [
      { name: "id", type: DataType.INT32, primaryKey: true },
      { name: "bio", type: DataType.TEXT, notNull: true },
    ]);
    await db.insertMany(
      "accounts",
      Array.from({ length: 400 }, (_, i) => ({
        id: i + 1,
        bio: `account-profile-${i + 1}-` + "p".repeat(180),
      })),
    );
    await db.close();

    const coldDb = await WebDB.open({
      name: dbName,
      engine: testEngine(),
      storage: new IdbStorage(dbName),
      crossTabSync: false,
    });
    openedDbs.push(coldDb);

    const batches: number[][] = [];
    const origReadPages = coldDb.vfs.readPages.bind(coldDb.vfs);
    vi.spyOn(coldDb.vfs, "readPages").mockImplementation(async (ids) => {
      batches.push([...ids]);
      return origReadPages(ids);
    });

    const found = await coldDb.from("accounts").where("id", "=", 250).toArray();
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(250);
    expect(batches.length).toBeGreaterThan(0);
    expect(batches.every((b) => b.length === 1)).toBe(true);
  });

  it("isolates multiple concurrent sequential streams across joins and interleaved random faults", async () => {
    // 1. Interleaved random point faults and dual concurrent sequential streams
    const vfs = new MemoryStorage();
    const pagesToWrite: Array<{ pageId: number; data: Uint8Array }> = [];
    for (let p = 2; p <= 80; p++) {
      pagesToWrite.push({
        pageId: p,
        data: initRawPage(PAGE_TYPE_TABLE_INTERIOR, 0, p & 0xff),
      });
    }
    await vfs.writePages(pagesToWrite);

    const memory = createWasmMemory(128);
    const io = new Io({ vfs, memory });
    const driver = new BufferPoolDriver({ io, memory, slotCount: 128, readAhead: true });
    driver.getSlotDataView(0).setUint32(HEADER_OFFSET_TOTAL_PAGES, 80, true);

    const batches: number[][] = [];
    const origReadPages = vfs.readPages.bind(vfs);
    vfs.readPages = async (ids) => {
      batches.push([...ids]);
      return origReadPages(ids);
    };

    // Prime ascending sequential stream on 2..30 interleaved with random reads (75, 78) and a second sequential stream on 40..65
    await driver.acquirePage(2);
    await driver.acquirePage(75);
    await driver.acquirePage(40);
    await driver.acquirePage(3);
    await driver.acquirePage(41);
    await driver.acquirePage(78);
    await driver.acquirePage(4); // Triggers stream A batch [4, 5, 6, 7]
    await driver.acquirePage(42); // Triggers stream B batch [42, 43, 44, 45]
    for (let p = 5; p <= 25; p++) {
      await driver.acquirePage(p);
      await driver.acquirePage(38 + p);
    }

    expect(batches.some((b) => b[0] === 4 && b.length >= 4)).toBe(true);
    expect(batches.some((b) => b[0] === 42 && b.length >= 4)).toBe(true);
    expect(batches.some((b) => b.length >= 8)).toBe(true);

    // 2. Two-table indexed join on cold IdbStorage prefetches both sequential streams cleanly
    const dbName = uniqueName("seq_idb_join_streams");
    const db = await WebDB.open({
      name: dbName,
      engine: testEngine(),
      storage: new IdbStorage(dbName),
      crossTabSync: false,
    });
    await db.createTable("users", [
      { name: "id", type: DataType.INT32, primaryKey: true },
      { name: "name", type: DataType.TEXT, notNull: true },
    ]);
    await db.createTable("tasks", [
      { name: "id", type: DataType.INT32, primaryKey: true },
      { name: "user_id", type: DataType.INT32, notNull: true },
      { name: "title", type: DataType.TEXT, notNull: true },
    ]);
    await db.insertMany(
      "users",
      Array.from({ length: 150 }, (_, i) => ({
        id: i + 1,
        name: `user-${i + 1}-` + "u".repeat(150),
      })),
    );
    await db.insertMany(
      "tasks",
      Array.from({ length: 150 }, (_, i) => ({
        id: i + 1,
        user_id: i + 1,
        title: `task-${i + 1}-` + "t".repeat(150),
      })),
    );
    await db.close();

    const coldJoinDb = await WebDB.open({
      name: dbName,
      engine: testEngine(),
      storage: new IdbStorage(dbName),
      crossTabSync: false,
    });
    openedDbs.push(coldJoinDb);

    const idbStats = spyIdbReadActivity();
    const joined = await coldJoinDb
      .from("tasks")
      .join("users", "tasks.user_id", "=", "users.id")
      .select(["tasks.id", "users.name", "tasks.title"])
      .orderBy("tasks.id", "asc")
      .toArray();
    expect(joined).toHaveLength(150);
    expect(idbStats.readonlyTxs).toBeLessThanOrEqual(10);
    expect(idbStats.getAllRangeCalls.length).toBeGreaterThan(0);
  });

  it("supports unchained ascending & descending strides and respects readAhead configuration options", async () => {
    const vfs = new MemoryStorage();
    const seed: Array<{ pageId: number; data: Uint8Array }> = [];
    for (let p = 2; p <= 35; p++) {
      seed.push({
        pageId: p,
        data: initRawPage(PAGE_TYPE_TABLE_INTERIOR, 0, p),
      });
    }
    await vfs.writePages(seed);

    // Default MemoryStorage disables readAhead
    const defaultMemDriver = new BufferPoolDriver({
      vfs,
      memory: createWasmMemory(64),
      slotCount: 64,
    });
    expect(defaultMemDriver.readAheadEnabled).toBe(false);

    // Invalid maxPages throws RangeError
    expect(
      () =>
        new BufferPoolDriver({
          vfs,
          memory: createWasmMemory(64),
          slotCount: 64,
          readAhead: { maxPages: -1 },
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        new BufferPoolDriver({
          vfs,
          memory: createWasmMemory(64),
          slotCount: 64,
          readAhead: { maxPages: 2.5 },
        }),
    ).toThrow(RangeError);

    // Descending stride + capped { maxPages: 8 }
    const batches: number[][] = [];
    const origReadPages = vfs.readPages.bind(vfs);
    vfs.readPages = async (ids) => {
      batches.push([...ids]);
      return origReadPages(ids);
    };

    const descDriver = new BufferPoolDriver({
      vfs,
      memory: createWasmMemory(128),
      slotCount: 128,
      readAhead: { maxPages: 8 },
    });
    descDriver.getSlotDataView(0).setUint32(HEADER_OFFSET_TOTAL_PAGES, 35, true);

    for (let p = 35; p >= 2; p--) {
      const slot = await descDriver.acquirePage(p);
      expect(descDriver.getPageBytesInSlot(slot)[20]).toBe(p);
    }

    expect(batches.some((b) => b.length === 4)).toBe(true);
    expect(batches.some((b) => b.length === 8)).toBe(true);
    expect(batches.every((b) => b.length <= 8)).toBe(true);
    // Ascending key order preserved even for descending strides
    for (const b of batches) {
      for (let i = 1; i < b.length; i++) {
        expect(b[i]).toBeGreaterThan(b[i - 1]);
      }
    }

    // Explicit readAhead: false forces 1 page per readPages call
    batches.length = 0;
    const disabledDriver = new BufferPoolDriver({
      vfs,
      memory: createWasmMemory(128),
      slotCount: 128,
      readAhead: false,
    });
    disabledDriver
      .getSlotDataView(0)
      .setUint32(HEADER_OFFSET_TOTAL_PAGES, 35, true);
    for (let p = 2; p <= 20; p++) {
      await disabledDriver.acquirePage(p);
    }
    expect(batches).toHaveLength(19);
    expect(batches.every((b) => b.length === 1)).toBe(true);
  });

  it("isolates corrupt speculative pages from demand reads while still rejecting explicit reads", async () => {
    const vfs = new MemoryStorage();
    const pages: Array<{ pageId: number; data: Uint8Array }> = [];
    for (let p = 2; p <= 10; p++) {
      const page = initRawPage(PAGE_TYPE_LEAF_DATA, p < 10 ? p + 1 : 0, p);
      // Stamp valid checksum by going through Io.writeSlot or leave checksum != 0 on page 6
      pages.push({ pageId: p, data: page });
    }
    // Give page 6 a non-zero bogus checksum so CRC32 verification fails on page 6
    new DataView(pages[4].data.buffer).setUint32(12, 0xdeadbeef, true);
    await vfs.writePages(pages);

    const memory = createWasmMemory(32);
    const io = new Io({ vfs, memory });
    const driver = new BufferPoolDriver({
      io,
      memory,
      slotCount: 32,
      readAhead: true,
    });
    driver.getSlotDataView(0).setUint32(HEADER_OFFSET_TOTAL_PAGES, 10, true);

    // Page 2 sets expectedChainNext = 3; page 3 triggers batch [3, 4, 5, 6]
    await driver.acquirePage(2);
    const slot3 = await driver.acquirePage(3);
    expect(driver.getPageBytesInSlot(slot3)[20]).toBe(3);

    // Corrupt speculative page 6 must NOT be placed into cache, and must NOT fail acquirePage(3)
    expect(driver.getResidentSlot(6)).toBe(-1);

    // Explicitly acquiring page 6 must validate CRC32 and throw CorruptPageError
    await expect(driver.acquirePage(6)).rejects.toThrow(CorruptPageError);
  });

  it("never overwrites uncheckpointed WAL pages with stale disk pages during read-ahead", async () => {
    const dbName = uniqueName("seq_idb_wal_freshness");
    const db = await WebDB.open({
      name: dbName,
      engine: testEngine(),
      storage: new IdbStorage(dbName),
      crossTabSync: false,
    });
    openedDbs.push(db);

    await db.createTable("ledger", [
      { name: "id", type: DataType.INT32, primaryKey: true },
      { name: "tag", type: DataType.TEXT, notNull: true },
    ]);
    await db.insertMany(
      "ledger",
      Array.from({ length: 180 }, (_, i) => ({
        id: i + 1,
        tag: `initial-${i + 1}-` + "a".repeat(160),
      })),
    );
    await db.checkpoint();

    // Update a row near the middle in an explicit uncheckpointed transaction (lives in committedWalPages)
    await db.transaction(async (tx) => {
      await tx.update(
        "ledger",
        { id: 90 },
        { tag: "updated-in-wal-90-" + "w".repeat(150) },
      );
    });
    expect(await db.vfs.getWalFrameCount()).toBeGreaterThan(0);

    // Evict all unpinned data/index slots to force a full cold scan with read-ahead across WAL-resident pages
    for (let s = 1; s < db.pool.slotCount; s++) {
      if (!db.pool.isSlotPinned(s) && !db.pool.isDirty(s)) {
        db.pool.unassignSlot(s);
      }
    }
    db.pool.resetReadAhead();

    const rows = await db.from("ledger").orderBy("id", "asc").toArray();
    expect(rows).toHaveLength(180);
    const row90 = rows.find((r) => r.id === 90);
    expect(row90?.tag).toBe("updated-in-wal-90-" + "w".repeat(150));
  });

  it("never evicts dirty, pinned, or catalog slots during speculative prefetch and coalesces concurrent acquires", async () => {
    const vfs = new MemoryStorage();
    const pages: Array<{ pageId: number; data: Uint8Array }> = [];
    for (let p = 2; p <= 20; p++) {
      pages.push({
        pageId: p,
        data: initRawPage(PAGE_TYPE_LEAF_DATA, p < 20 ? p + 1 : 0, p),
      });
    }
    await vfs.writePages(pages);

    const memory = createWasmMemory(16);
    const io = new Io({ vfs, memory });
    const driver = new BufferPoolDriver({
      io,
      memory,
      slotCount: 16,
      readAhead: true,
    });
    driver.getSlotDataView(0).setUint32(HEADER_OFFSET_TOTAL_PAGES, 20, true);

    // Occupy slots with a catalog page (slot 1), a pinned page (slot 2), and a dirty page (slot 3)
    const catSlot = 1;
    driver.getPageBytesInSlot(catSlot).set(initRawPage(PAGE_TYPE_CATALOG_PAGE, 0, 0xca));
    driver.assignSlot(catSlot, 18);

    const pinnedSlot = 2;
    driver.getPageBytesInSlot(pinnedSlot).set(initRawPage(PAGE_TYPE_LEAF_DATA, 0, 0xbb));
    driver.assignSlot(pinnedSlot, 19);
    driver.pinSlot(pinnedSlot);

    const dirtySlot = 3;
    driver.getPageBytesInSlot(dirtySlot).set(initRawPage(PAGE_TYPE_LEAF_DATA, 0, 0xdd));
    driver.assignSlot(dirtySlot, 20);
    driver.markDirty(dirtySlot);

    // Scan pages 2..15 sequentially
    for (let p = 2; p <= 15; p++) {
      const s = await driver.acquirePage(p);
      expect(driver.getPageBytesInSlot(s)[20]).toBe(p);
    }

    // Catalog, pinned, and dirty slots must all remain untouched
    expect(driver.getAssignedPage(catSlot)).toBe(18);
    expect(driver.getAssignedPage(pinnedSlot)).toBe(19);
    expect(driver.getAssignedPage(dirtySlot)).toBe(20);
    expect(driver.isDirty(dirtySlot)).toBe(true);

    // Concurrent acquire coalescing onto an in-flight read-ahead batch
    for (let s = 4; s < 16; s++) {
      driver.unassignSlot(s);
    }
    driver.resetReadAhead();

    let batch3Calls = 0;
    let releaseRead!: () => void;
    const gate = new Promise<void>((r) => {
      releaseRead = r;
    });
    const origRead = vfs.readPages.bind(vfs);
    vfs.readPages = async (ids) => {
      if (ids.includes(3)) {
        batch3Calls++;
        if (ids.length > 1) {
          await gate;
        }
      }
      return origRead(ids);
    };

    // Prime chain on page 2
    await driver.acquirePage(2);
    // Start acquirePage(3) which prefetches [3, 4, 5, 6]
    const p3 = driver.acquirePage(3);
    await new Promise((r) => setTimeout(r, 10));
    // Concurrent acquirePage(4) while [3, 4, 5, 6] is in flight must coalesce onto the same VFS batch
    const p4 = driver.acquirePage(4);
    releaseRead();
    const [s3, s4] = await Promise.all([p3, p4]);
    expect(batch3Calls).toBe(1);
    expect(driver.getPageBytesInSlot(s3)[20]).toBe(3);
    expect(driver.getPageBytesInSlot(s4)[20]).toBe(4);
  });
});

describe("Io.readPagesBatch — Edge Cases, Concurrency & Validation", () => {
  it("validates demandPageId, deduplicates pageIds, enforces page 1 checksums, and handles byte-length errors and missing pages", async () => {
    const vfs = new MemoryStorage();
    const memory = createWasmMemory(16);
    const io = new Io({ vfs, memory });

    await expect(io.readPagesBatch([0], 0)).rejects.toThrow(/Invalid page ID/);
    await expect(io.readPagesBatch([-1], -1)).rejects.toThrow(/Invalid page ID/);
    await expect(io.readPagesBatch([2], Number.NaN)).rejects.toThrow(
      /Invalid page ID/,
    );

    // Page 1 CRC32 validation (pass valid, reject corrupt)
    const p1Valid = initRawPage(PAGE_TYPE_LEAF_DATA, 0, 0x11);
    const p1Chk = computePage1Checksum(p1Valid);
    new DataView(p1Valid.buffer).setUint32(
      HEADER_OFFSET_PAGE_CHECKSUM,
      p1Chk,
      true,
    );
    const p2Valid = initRawPage(PAGE_TYPE_LEAF_DATA, 0, 0x22);
    // Page 3 has wrong byte length (speculative) -> must be omitted without failing demand read
    const p3BadLen = new Uint8Array(2048);
    await vfs.writePages([
      { pageId: 1, data: p1Valid },
      { pageId: 2, data: p2Valid },
      { pageId: 3, data: p3BadLen },
    ]);

    const seenBatches: number[][] = [];
    const origRead = vfs.readPages.bind(vfs);
    vfs.readPages = async (ids) => {
      seenBatches.push([...ids]);
      return origRead(ids);
    };

    const res = await io.readPagesBatch([-5, 1, 1, 2, 2, 3, 4], 1);
    expect(seenBatches).toEqual([[1, 2, 3, 4]]);
    expect(res.get(1)?.[20]).toBe(0x11);
    expect(res.get(2)?.[20]).toBe(0x22);
    expect(res.has(3)).toBe(false);
    expect(res.has(4)).toBe(false); // missing null speculative page omitted

    // Unexpected length on demand page throws CorruptPageError
    await expect(io.readPagesBatch([3], 3)).rejects.toThrow(CorruptPageError);

    // Corrupt checksum on Page 1 throws CorruptPageError
    const p1Tampered = new Uint8Array(p1Valid);
    p1Tampered[50] ^= 0xff;
    await vfs.writePages([{ pageId: 1, data: p1Tampered }]);
    await expect(io.readPagesBatch([1, 2], 1)).rejects.toThrow(
      CorruptPageError,
    );

    // Missing (null) demand page returns null in map and zeroes slot on BufferPoolDriver
    const driver = new BufferPoolDriver({
      io,
      memory,
      slotCount: 16,
      readAhead: true,
    });
    driver.getSlotDataView(0).setUint32(HEADER_OFFSET_TOTAL_PAGES, 10, true);
    const missingBatch = await io.readPagesBatch([8, 9], 8);
    expect(missingBatch.get(8)).toBeNull();
    const s8 = await driver.acquirePage(8);
    expect(driver.getPageBytesInSlot(s8)[0]).toBe(0);
  });

  it("trims leading/trailing spilled pages while keeping interior spilled gaps contiguous and handles spilled demand transitions", async () => {
    const vfs = new MemoryStorage();
    for (let p = 2; p <= 7; p++) {
      await vfs.writePages([
        { pageId: p, data: initRawPage(PAGE_TYPE_LEAF_DATA, 0, p) },
      ]);
    }
    const memory = createWasmMemory(16);
    const io = new Io({ vfs, memory });

    const spilled = new Map<number, Uint8Array>();
    const makeSpilled = (val: number) =>
      initRawPage(PAGE_TYPE_LEAF_DATA, 0, val);
    spilled.set(2, makeSpilled(0xe2));
    spilled.set(4, makeSpilled(0xe4));
    spilled.set(6, makeSpilled(0xe6));
    io.setTransactionCoordinator({
      isInTransaction: () => true,
      spillUncommittedSlot: async () => {},
      hasSpilledPage: (id: number) => spilled.has(id),
      getSpilledPage: (id: number) => new Uint8Array(spilled.get(id)!),
      onDirectPageWrite: () => {},
      hasCommittedWalPage: () => false,
      commitDirectPagesViaWal: async () => {},
    });

    const vfsCalls: number[][] = [];
    const origRead = vfs.readPages.bind(vfs);
    vfs.readPages = async (ids) => {
      vfsCalls.push([...ids]);
      return origRead(ids);
    };

    // Leading (2) and trailing (6) trimmed -> [3, 4, 5]; interior spilled (4) preserved in VFS call for contiguity, omitted from map
    const batch = await io.readPagesBatch([2, 3, 4, 5, 6], 3);
    expect(vfsCalls).toEqual([[3, 4, 5]]);
    expect(batch.get(3)?.[20]).toBe(3);
    expect(batch.has(4)).toBe(false);
    expect(batch.get(5)?.[20]).toBe(5);

    // All-spilled batch makes zero VFS calls
    vfsCalls.length = 0;
    spilled.set(3, makeSpilled(0xe3));
    const allSpilled = await io.readPagesBatch([2, 3, 4], 3);
    expect(vfsCalls).toHaveLength(0);
    expect(allSpilled.get(3)?.[20]).toBe(0xe3);

    // Demand page becomes spilled while batchReadPromise is awaiting VFS -> returns fresh spilled image
    spilled.delete(3);
    let releaseRead!: () => void;
    const readGate = new Promise<void>((r) => {
      releaseRead = r;
    });
    vfs.readPages = async (ids) => {
      await readGate;
      return origRead(ids);
    };
    const pending = io.readPagesBatch([3, 5], 3);
    await new Promise((r) => setTimeout(r, 5));
    spilled.set(3, makeSpilled(0xf3));
    releaseRead();
    const afterSpill = await pending;
    expect(afterSpill.get(3)?.[20]).toBe(0xf3);
  });

  it("handles in_flight_flushes, write-gen invalidation against pre-flush coalescing, existingDemandRead, fallback single read, and VFS rejection cleanup", async () => {
    const vfs = new MemoryStorage();
    for (let p = 2; p <= 6; p++) {
      await vfs.writePages([
        { pageId: p, data: initRawPage(PAGE_TYPE_LEAF_DATA, 0, p) },
      ]);
    }
    const memory = createWasmMemory(16);
    const io = new Io({ vfs, memory });

    // 1. Demand read awaits in-flight flush, and speculative flushing pages are skipped
    let releaseFlush2!: () => void;
    let releaseFlush4!: () => void;
    let flush2Gate!: () => void;
    const flush2Started = new Promise<void>((r) => {
      flush2Gate = r;
    });
    let flush4Gate!: () => void;
    const flush4Started = new Promise<void>((r) => {
      flush4Gate = r;
    });

    const origWrite = vfs.writePages.bind(vfs);
    vfs.writePages = async (pages) => {
      if (pages.some((p) => p.pageId === 2)) {
        flush2Gate();
        await new Promise<void>((r) => {
          releaseFlush2 = r;
        });
      } else if (pages.some((p) => p.pageId === 4)) {
        flush4Gate();
        await new Promise<void>((r) => {
          releaseFlush4 = r;
        });
      }
      return origWrite(pages);
    };

    io.uint8[io.slotsBaseOffset + 1 * PAGE_SIZE + 20] = 0x72;
    const f2 = io.writeSlot(1, 2);
    await flush2Started;

    io.uint8[io.slotsBaseOffset + 2 * PAGE_SIZE + 20] = 0x74;
    const f4 = io.writeSlot(2, 4);
    await flush4Started;

    const batchCalls: number[][] = [];
    const origRead = vfs.readPages.bind(vfs);
    vfs.readPages = async (ids) => {
      batchCalls.push([...ids]);
      return origRead(ids);
    };

    const batchPromise = io.readPagesBatch([2, 3, 4, 5], 2);
    await new Promise((r) => setTimeout(r, 10));
    expect(batchCalls).toHaveLength(0); // Awaits flush on demand page 2
    releaseFlush2();
    await f2;
    const batchRes = await batchPromise;
    expect(batchRes.get(2)?.[20]).toBe(0x72);
    expect(batchRes.get(3)?.[20]).toBe(3);
    expect(batchRes.has(4)).toBe(false); // Skipped because page 4 was flushing
    releaseFlush4();
    await f4;

    // 2. Write started during an in-flight batch read invalidates pre-flush in_flight_reads for concurrent readSlot()
    batchCalls.length = 0;
    let releaseBatch!: () => void;
    let batchStarted!: () => void;
    const batchStartedPromise = new Promise<void>((r) => {
      batchStarted = r;
    });
    vfs.readPages = async (ids) => {
      batchCalls.push([...ids]);
      if (ids.length > 1) {
        batchStarted();
        await new Promise<void>((r) => {
          releaseBatch = r;
        });
      }
      return origRead(ids);
    };
    vfs.writePages = origWrite;

    const staleBatch = io.readPagesBatch([3, 4, 5], 3);
    await batchStartedPromise;
    // Write new value to page 4 while batch [3, 4, 5] is still in flight
    io.uint8[io.slotsBaseOffset + 3 * PAGE_SIZE + 20] = 0x99;
    await io.writeSlot(3, 4);
    // Concurrent readSlot into slot 4 must NOT read pre-flush bytes
    await io.readSlot(4, 4);
    expect(io.uint8[io.slotsBaseOffset + 4 * PAGE_SIZE + 20]).toBe(0x99);
    releaseBatch();
    const staleRes = await staleBatch;
    expect(staleRes.has(4)).toBe(false);

    // 3. existingDemandRead coalescing and fallback single-page read when demandPageId is absent from pageIds
    vfs.readPages = async (ids) => {
      batchCalls.push([...ids]);
      if (ids.length === 1 && ids[0] === 5) {
        await new Promise((r) => setTimeout(r, 15));
      }
      return origRead(ids);
    };
    batchCalls.length = 0;
    const slotRead5 = io.readSlot(5, 5);
    await new Promise((r) => setTimeout(r, 2));
    const coalescedBatch = await io.readPagesBatch([5, 6], 5);
    await slotRead5;
    expect(coalescedBatch.get(5)?.[20]).toBe(5);
    expect(batchCalls).toEqual([[5], [6]]);

    const fallback = await io.readPagesBatch([3], 6);
    expect(fallback.get(6)?.[20]).toBe(6);

    // 4. VFS rejection cleanup: clears in_flight_reads, propagates to coalesced readSlot, no unhandled rejection
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      vfs.readPages = async () => {
        await new Promise((r) => setTimeout(r, 10));
        throw new Error("VFS_BOOM");
      };
      const failingBatch = io.readPagesBatch([3, 4, 5], 3);
      await new Promise((r) => setTimeout(r, 2));
      const coalescedFail = io.readSlot(6, 4);
      await expect(failingBatch).rejects.toThrow("VFS_BOOM");
      await expect(coalescedFail).rejects.toThrow("VFS_BOOM");
      await new Promise((r) => setTimeout(r, 5));
      expect(unhandled).toHaveLength(0);
      expect(io.hasInFlightRead(3)).toBe(false);
      expect(io.hasInFlightRead(4)).toBe(false);
      expect(io.hasInFlightRead(5)).toBe(false);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    // 5. resolvePageFault awaits in_flight_flushes BEFORE reading WAL/spilled image
    let commitWalResolve!: () => void;
    let commitWalStarted!: () => void;
    const walStartPromise = new Promise<void>((r) => {
      commitWalStarted = r;
    });
    const committedWal = new Map<number, Uint8Array>([
      [2, initRawPage(PAGE_TYPE_LEAF_DATA, 0, 0x11)],
    ]);
    io.setTransactionCoordinator({
      isInTransaction: () => false,
      spillUncommittedSlot: async () => {},
      hasSpilledPage: (id: number) => committedWal.has(id),
      getSpilledPage: (id: number) => new Uint8Array(committedWal.get(id)!),
      onDirectPageWrite: () => {},
      hasCommittedWalPage: (id: number) => committedWal.has(id),
      commitDirectPagesViaWal: async (pages) => {
        commitWalStarted();
        await new Promise<void>((r) => {
          commitWalResolve = r;
        });
        for (const p of pages) {
          committedWal.set(p.pageId, new Uint8Array(p.data));
        }
      },
    });
    io.uint8[io.slotsBaseOffset + 1 * PAGE_SIZE + 20] = 0x55;
    const walWrite = io.writeSlot(1, 2);
    await walStartPromise;
    const faultRead = io.resolvePageFault(7, 2, 0);
    await new Promise((r) => setTimeout(r, 10));
    commitWalResolve();
    await Promise.all([walWrite, faultRead]);
    expect(io.uint8[io.slotsBaseOffset + 7 * PAGE_SIZE + 20]).toBe(0x55);
  });
});

describe("BufferPoolDriver Read-Ahead — State Machine, Concurrency Races & Eviction", () => {
  it("skips speculative placement on pool_epoch invalidation, preserves stream across resetReadAhead race, and never clobbers evicted pages", async () => {
    const vfs = new MemoryStorage();
    for (let p = 2; p <= 20; p++) {
      await vfs.writePages([
        { pageId: p, data: initRawPage(PAGE_TYPE_LEAF_DATA, p + 1, p) },
      ]);
    }
    const memory = createWasmMemory(16);
    const io = new Io({ vfs, memory });
    const driver = new BufferPoolDriver({
      io,
      memory,
      slotCount: 16,
      readAhead: true,
    });
    driver.getSlotDataView(0).setUint32(HEADER_OFFSET_TOTAL_PAGES, 20, true);

    await driver.acquirePage(2); // primes expectedChainNext = 3
    // Assign page 15 so we can bump pool_epoch via unassignSlot while batch [3,4,5,6] is in flight
    const s15 = await driver.acquirePage(15);

    let releaseBatch!: () => void;
    const origRead = vfs.readPages.bind(vfs);
    vfs.readPages = async (ids) => {
      if (ids.includes(3) && ids.length > 1) {
        await new Promise<void>((r) => {
          releaseBatch = r;
        });
      }
      return origRead(ids);
    };

    const p3 = driver.acquirePage(3);
    await new Promise((r) => setTimeout(r, 5));
    driver.unassignSlot(s15); // bumps pool_epoch
    releaseBatch();
    const slot3 = await p3;
    expect(driver.getPageBytesInSlot(slot3)[20]).toBe(3);
    expect(driver.getResidentSlot(4)).toBe(-1);
    expect(driver.getResidentSlot(5)).toBe(-1);

    // Concurrent acquire of evicted old_page_id during candidate_slot I/O on a 2-slot pool
    const smallVfs = new MemoryStorage();
    await smallVfs.writePages([
      { pageId: 2, data: initRawPage(PAGE_TYPE_LEAF_DATA, 0, 0x22) },
      { pageId: 3, data: initRawPage(PAGE_TYPE_LEAF_DATA, 0, 0x33) },
    ]);
    const smallMem = createWasmMemory(2);
    const smallDriver = new BufferPoolDriver({
      vfs: smallVfs,
      memory: smallMem,
      slotCount: 2,
      readAhead: false,
    });
    await smallDriver.acquirePage(2); // resident in slot 1 (unpinned)
    let releaseRead3!: () => void;
    const origSmallRead = smallVfs.readPages.bind(smallVfs);
    smallVfs.readPages = async (ids) => {
      if (ids.includes(3)) {
        await new Promise<void>((r) => {
          releaseRead3 = r;
        });
      }
      return origSmallRead(ids);
    };
    const acq3 = smallDriver.acquirePage(3);
    await new Promise((r) => setTimeout(r, 5));
    // Page 2 was evicted before async read(3); acquiring page 2 while slot 1 is pinned must deadlock safely instead of hitting clobbered slot 1
    expect(smallDriver.getResidentSlot(2)).toBe(-1);
    await expect(smallDriver.acquirePage(2, true)).rejects.toThrow(
      /all slots are pinned/,
    );
    releaseRead3();
    expect(await acq3).toBe(1);

    // Coalesced acquirePage(p, true) + acquirePage(p, false) leaves no pin=0 gap
    const coalVfs = new MemoryStorage();
    await coalVfs.writePages([
      { pageId: 2, data: initRawPage(PAGE_TYPE_LEAF_DATA, 0, 0xaa) },
    ]);
    const origCoalRead = coalVfs.readPages.bind(coalVfs);
    let releaseCoal!: () => void;
    coalVfs.readPages = async (ids) => {
      await new Promise<void>((r) => {
        releaseCoal = r;
      });
      return origCoalRead(ids);
    };
    const coalDriver = new BufferPoolDriver({
      vfs: coalVfs,
      memory: createWasmMemory(4),
      slotCount: 4,
      readAhead: false,
    });
    const unpinnedInit = coalDriver.acquirePage(2, false);
    const pinnedJoin = coalDriver.acquireAndPinPage(2);
    releaseCoal();
    const [uSlot, pSlot] = await Promise.all([unpinnedInit, pinnedJoin]);
    expect(uSlot).toBe(pSlot);
    expect(coalDriver.getPinCount(pSlot)).toBe(1);
    coalDriver.unpinSlot(pSlot);
    expect(coalDriver.getPinCount(pSlot)).toBe(0);

    // resetReadAhead() during in-flight acquire prevents stale stream commit
    const resetVfs = new MemoryStorage();
    for (let p = 2; p <= 10; p++) {
      await resetVfs.writePages([
        { pageId: p, data: initRawPage(PAGE_TYPE_LEAF_DATA, p + 1, p) },
      ]);
    }
    const origResetRead = resetVfs.readPages.bind(resetVfs);
    const resetBatches: number[][] = [];
    let release2!: () => void;
    resetVfs.readPages = async (ids) => {
      resetBatches.push([...ids]);
      if (ids.includes(2)) {
        await new Promise<void>((r) => {
          release2 = r;
        });
      }
      return origResetRead(ids);
    };
    const resetDriver = new BufferPoolDriver({
      vfs: resetVfs,
      memory: createWasmMemory(16),
      slotCount: 16,
      readAhead: true,
    });
    resetDriver.getSlotDataView(0).setUint32(HEADER_OFFSET_TOTAL_PAGES, 10, true);
    const p2 = resetDriver.acquirePage(2);
    await new Promise((r) => setTimeout(r, 5));
    resetDriver.resetReadAhead();
    release2();
    await p2;
    // Page 2 completed AFTER resetReadAhead(), so expectedChainNext=3 was NOT written back -> acquiring 3 reads [3] alone
    resetBatches.length = 0;
    await resetDriver.acquirePage(3);
    expect(resetBatches).toEqual([[3]]);
  });

  it("handles dirty victim eviction during batch read-ahead, failed acquire rollback, free/catalog filtering, and Clock fallback", async () => {
    const vfs = new MemoryStorage();
    for (let p = 2; p <= 20; p++) {
      const pageType =
        p === 5
          ? PAGE_TYPE_FREE
          : p === 6
            ? PAGE_TYPE_CATALOG_PAGE
            : PAGE_TYPE_LEAF_DATA;
      await vfs.writePages([
        { pageId: p, data: initRawPage(pageType, p < 20 ? p + 1 : 0, p) },
      ]);
    }

    const memory = createWasmMemory(16);
    const io = new Io({ vfs, memory });
    const driver = new BufferPoolDriver({
      io,
      memory,
      slotCount: 16,
      readAhead: true,
    });
    driver.getSlotDataView(0).setUint32(HEADER_OFFSET_TOTAL_PAGES, 20, true);

    // Fill slots 1..15 with clean cold pages (10..15) and 1 dirty victim
    const dirtyVictims: number[] = [];
    const origWrite = vfs.writePages.bind(vfs);
    vfs.writePages = async (pages) => {
      for (const p of pages) dirtyVictims.push(p.pageId);
      return origWrite(pages);
    };

    // Occupy slots 1..15 cleanly first (disable readAhead temporarily via allocate/read or direct fill)
    for (let s = 1; s < 16; s++) {
      const pid = 20 + s;
      await vfs.writePages([
        { pageId: pid, data: initRawPage(PAGE_TYPE_LEAF_DATA, 0, pid) },
      ]);
      driver.getPageBytesInSlot(s).set(initRawPage(PAGE_TYPE_LEAF_DATA, 0, pid));
      driver.assignSlot(s, pid);
      driver.setRefBit(s, 0);
    }
    // Make slot 1 (first Clock victim after slot 0) dirty
    driver.markDirty(1);
    (driver as any).clock_hand = 0; // ref_bits are all 0 so slot 1 is selected next

    // Prime chain on page 2 (evicts dirty slot 1 -> page 21 flushed!)
    await driver.acquirePage(2);
    expect(dirtyVictims).toContain(21);

    // Make the next Clock victim dirty too so batch read [3, 4, 5, 6] hits flush_page_id > 0
    const nextVictim = (driver as any).clock_hand === 1 ? 2 : 1;
    driver.markDirty(nextVictim);
    const dirtyVictimPage = driver.getAssignedPage(nextVictim);

    await driver.acquirePage(3); // batches [3, 4, 5, 6]
    expect(dirtyVictims).toContain(dirtyVictimPage);
    // PAGE_TYPE_FREE (5) and PAGE_TYPE_CATALOG_PAGE (6) were NOT installed in cache
    expect(driver.getResidentSlot(4)).not.toBe(-1);
    expect(driver.getResidentSlot(5)).toBe(-1);
    expect(driver.getResidentSlot(6)).toBe(-1);

    // Failed acquire (CorruptPageError) must NOT inflate/wipe stream state and must unpin candidate_slot
    const corruptVfs = new MemoryStorage();
    for (let p = 2; p <= 8; p++) {
      const page = initRawPage(PAGE_TYPE_LEAF_DATA, p + 1, p);
      if (p === 3) {
        new DataView(page.buffer).setUint32(12, 0xbadc0de, true);
      }
      await corruptVfs.writePages([{ pageId: p, data: page }]);
    }
    const corruptDriver = new BufferPoolDriver({
      vfs: corruptVfs,
      memory: createWasmMemory(16),
      slotCount: 16,
      readAhead: true,
    });
    corruptDriver
      .getSlotDataView(0)
      .setUint32(HEADER_OFFSET_TOTAL_PAGES, 8, true);
    await corruptDriver.acquirePage(2);
    await expect(corruptDriver.acquirePage(3)).rejects.toThrow(
      CorruptPageError,
    );
    // Every non-zero slot must be unpinned after failure
    for (let s = 1; s < 16; s++) {
      expect(corruptDriver.getPinCount(s)).toBe(0);
    }

    // cleanSlots <= 3 throttles speculative prefetching down to 1 page
    const tightVfs = new MemoryStorage();
    for (let p = 2; p <= 10; p++) {
      await tightVfs.writePages([
        { pageId: p, data: initRawPage(PAGE_TYPE_LEAF_DATA, p + 1, p) },
      ]);
    }
    const tightBatches: number[][] = [];
    const origTightRead = tightVfs.readPages.bind(tightVfs);
    tightVfs.readPages = async (ids) => {
      tightBatches.push([...ids]);
      return origTightRead(ids);
    };
    const tightDriver = new BufferPoolDriver({
      vfs: tightVfs,
      memory: createWasmMemory(8),
      slotCount: 8,
      readAhead: true,
    });
    tightDriver.getSlotDataView(0).setUint32(HEADER_OFFSET_TOTAL_PAGES, 10, true);
    // Pin slots 1..4 leaving only 3 clean slots (5, 6, 7) -> cleanSlots - 2 = 1 -> no prefetch!
    for (let s = 1; s <= 4; s++) {
      tightDriver.assignSlot(s, 50 + s);
      tightDriver.pinSlot(s);
    }
    await tightDriver.acquirePage(2);
    await tightDriver.acquirePage(3);
    expect(tightBatches).toEqual([[2], [3]]);
  });

  it("handles chain heuristics (INDEX_LEAF, OVERFLOW, non-chain types, jumps, cycles, warm islands), 8-stream LRU, allocate/free isolation, maxPages options, and stepVm()", async () => {
    // 1. INDEX_LEAF & OVERFLOW trigger on 2nd page; TABLE_INTERIOR & INDEX_INTERIOR do NOT prime chains; cycles terminate safely
    const vfs = new MemoryStorage();
    const pages: Array<{ pageId: number; data: Uint8Array }> = [
      // Index leaf chain 2 -> 3 -> 4 -> 5 -> 6
      { pageId: 2, data: initRawPage(PAGE_TYPE_INDEX_LEAF, 3, 2) },
      { pageId: 3, data: initRawPage(PAGE_TYPE_INDEX_LEAF, 4, 3) },
      { pageId: 4, data: initRawPage(PAGE_TYPE_INDEX_LEAF, 5, 4) },
      { pageId: 5, data: initRawPage(PAGE_TYPE_INDEX_LEAF, 6, 5) },
      { pageId: 6, data: initRawPage(PAGE_TYPE_INDEX_LEAF, 0, 6) },
      // Overflow chain 8 -> 9 -> 10 -> 11 -> 12
      { pageId: 8, data: initRawPage(PAGE_TYPE_OVERFLOW, 9, 8) },
      { pageId: 9, data: initRawPage(PAGE_TYPE_OVERFLOW, 10, 9) },
      { pageId: 10, data: initRawPage(PAGE_TYPE_OVERFLOW, 11, 10) },
      { pageId: 11, data: initRawPage(PAGE_TYPE_OVERFLOW, 12, 11) },
      { pageId: 12, data: initRawPage(PAGE_TYPE_OVERFLOW, 0, 12) },
      // Interior page 14 with right_child = 15 must NOT prime expectedChainNext
      { pageId: 14, data: initRawPage(PAGE_TYPE_TABLE_INTERIOR, 15, 14) },
      { pageId: 15, data: initRawPage(PAGE_TYPE_INDEX_INTERIOR, 16, 15) },
      { pageId: 16, data: initRawPage(PAGE_TYPE_TABLE_INTERIOR, 17, 16) },
      // Cycle 20 -> 21 -> 20
      { pageId: 20, data: initRawPage(PAGE_TYPE_LEAF_DATA, 21, 20) },
      { pageId: 21, data: initRawPage(PAGE_TYPE_LEAF_DATA, 20, 21) },
      // Distant jump 24 -> 40 (throttled back to 1 on 40)
      { pageId: 24, data: initRawPage(PAGE_TYPE_LEAF_DATA, 25, 24) },
      { pageId: 25, data: initRawPage(PAGE_TYPE_LEAF_DATA, 40, 25) },
      { pageId: 40, data: initRawPage(PAGE_TYPE_LEAF_DATA, 0, 40) },
    ];
    await vfs.writePages(pages);

    const batches: number[][] = [];
    const origRead = vfs.readPages.bind(vfs);
    vfs.readPages = async (ids) => {
      batches.push([...ids]);
      return origRead(ids);
    };

    const driver = new BufferPoolDriver({
      vfs,
      memory: createWasmMemory(64),
      slotCount: 64,
      readAhead: true,
    });
    driver.getSlotDataView(0).setUint32(HEADER_OFFSET_TOTAL_PAGES, 45, true);

    await driver.acquirePage(2);
    await driver.acquirePage(3);
    expect(batches).toEqual([[2], [3, 4, 5, 6]]);

    batches.length = 0;
    await driver.acquirePage(8);
    await driver.acquirePage(9);
    expect(batches).toEqual([[8], [9, 10, 11, 12]]);

    batches.length = 0;
    await driver.acquirePage(14);
    await driver.acquirePage(15); // NOT chained (TABLE_INTERIOR) -> single page read
    expect(batches).toEqual([[14], [15]]);

    // Cycle 20 -> 21 -> 20 terminates cleanly without hanging
    batches.length = 0;
    await driver.acquirePage(20);
    await driver.acquirePage(21);
    expect(driver.getPageBytesInSlot(driver.getResidentSlot(21))[20]).toBe(21);

    // Distant jump 24 -> 25 -> 40 throttles windowSize to 1 after 25->40 mismatch
    batches.length = 0;
    await driver.acquirePage(24);
    await driver.acquirePage(25); // reads [25, 26, 27, 28]; sees 25->40 (>4 jump) -> throttles windowSize=1
    await driver.acquirePage(40);
    expect(batches[batches.length - 1]).toEqual([40]);

    // 2. Warm cache island preserves unchained ascending stream (4 warm 5..7 -> miss on 8 reads [8..15])
    const islandVfs = new MemoryStorage();
    const islandPages: Array<{ pageId: number; data: Uint8Array }> = [];
    for (let p = 2; p <= 20; p++) {
      islandPages.push({
        pageId: p,
        data: initRawPage(PAGE_TYPE_TABLE_INTERIOR, 0, p),
      });
    }
    await islandVfs.writePages(islandPages);
    const islandBatches: number[][] = [];
    const origIslandRead = islandVfs.readPages.bind(islandVfs);
    islandVfs.readPages = async (ids) => {
      islandBatches.push([...ids]);
      return origIslandRead(ids);
    };
    const islandDriver = new BufferPoolDriver({
      vfs: islandVfs,
      memory: createWasmMemory(64),
      slotCount: 64,
      readAhead: true,
    });
    islandDriver.getSlotDataView(0).setUint32(HEADER_OFFSET_TOTAL_PAGES, 20, true);
    await islandDriver.acquirePage(2);
    await islandDriver.acquirePage(3);
    // Warm pages 5, 6, 7 into pool out-of-band before faulting on 4
    for (const wp of [5, 6, 7]) {
      const ws = 40 + wp;
      islandDriver
        .getPageBytesInSlot(ws)
        .set(initRawPage(PAGE_TYPE_TABLE_INTERIOR, 0, wp));
      islandDriver.assignSlot(ws, wp);
    }
    await islandDriver.acquirePage(4); // batch collapses to [4] since 5..7 are warm, but advances frontierEnd to 7
    await islandDriver.acquirePage(8); // must resume and batch [8..15] (or up to 15)
    expect(islandBatches.some((b) => b[0] === 8 && b.length >= 4)).toBe(true);

    // 3. 8-stream LRU prefers evicting inactive streams over active sequential streams
    const lruVfs = new MemoryStorage();
    for (let p = 2; p <= 120; p++) {
      await lruVfs.writePages([
        { pageId: p, data: initRawPage(PAGE_TYPE_LEAF_DATA, p + 1, p & 0xff) },
      ]);
    }
    const lruBatches: number[][] = [];
    const origLruRead = lruVfs.readPages.bind(lruVfs);
    lruVfs.readPages = async (ids) => {
      lruBatches.push([...ids]);
      return origLruRead(ids);
    };
    const lruDriver = new BufferPoolDriver({
      vfs: lruVfs,
      memory: createWasmMemory(128),
      slotCount: 128,
      readAhead: true,
    });
    lruDriver.getSlotDataView(0).setUint32(HEADER_OFFSET_TOTAL_PAGES, 120, true);

    // Stream 1 active on page 2 -> 3..6 (windowSize=8, expectedChainNext=7)
    await lruDriver.acquirePage(2);
    await lruDriver.acquirePage(3);
    // Flood 9 isolated single-page misses (which are inactive: windowSize=1, expectedChainNext=0 if interior)
    for (let p = 50; p <= 90; p += 5) {
      // Write unchained interior so expectedChainNext=0
      await lruVfs.writePages([
        { pageId: p, data: initRawPage(PAGE_TYPE_TABLE_INTERIOR, 0, p) },
      ]);
      await lruDriver.acquirePage(p);
    }
    lruBatches.length = 0;
    await lruDriver.acquirePage(7); // Active stream 1 must still be intact and read 8 pages [7..14]!
    expect(lruBatches).toEqual([[7, 8, 9, 10, 11, 12, 13, 14]]);

    // 4. allocatePage & freePage isolation + maxPages edge values + ReadOnlyOverlayVfs defaults + TypeError check
    const allocBatches: number[][] = [];
    const allocVfs = new MemoryStorage();
    const origAllocRead = allocVfs.readPages.bind(allocVfs);
    allocVfs.readPages = async (ids) => {
      allocBatches.push([...ids]);
      return origAllocRead(ids);
    };
    const allocDriver = new BufferPoolDriver({
      vfs: allocVfs,
      memory: createWasmMemory(32),
      slotCount: 32,
      readAhead: true,
    });
    allocDriver.getSlotDataView(0).setUint32(HEADER_OFFSET_TOTAL_PAGES, 1, true);
    const a2 = await allocDriver.allocatePage();
    const a3 = await allocDriver.allocatePage();
    const a4 = await allocDriver.allocatePage();
    await allocDriver.freePage(a2);
    await allocDriver.freePage(a3);
    await allocDriver.freePage(a4);
    expect(allocBatches.every((b) => b.length === 1)).toBe(true);

    expect(
      () =>
        new BufferPoolDriver({
          vfs: allocVfs,
          memory: createWasmMemory(16),
          slotCount: 16,
          readAhead: "bad" as any,
        }),
    ).toThrow(TypeError);
    expect(
      () =>
        new BufferPoolDriver({
          vfs: allocVfs,
          memory: createWasmMemory(16),
          slotCount: 16,
          readAhead: [] as any,
        }),
    ).toThrow(TypeError);

    expect(
      new BufferPoolDriver({
        vfs: allocVfs,
        memory: createWasmMemory(16),
        slotCount: 16,
        readAhead: { maxPages: 0 },
      }).readAheadEnabled,
    ).toBe(false);
    expect(
      new BufferPoolDriver({
        vfs: allocVfs,
        memory: createWasmMemory(16),
        slotCount: 16,
        readAhead: { maxPages: 1 },
      }).readAheadEnabled,
    ).toBe(false);
    const d2 = new BufferPoolDriver({
      vfs: allocVfs,
      memory: createWasmMemory(16),
      slotCount: 16,
      readAhead: { maxPages: 2 },
    });
    expect(d2.readAheadEnabled).toBe(true);
    expect(d2.maxReadAheadPages).toBe(2);
    expect(
      new BufferPoolDriver({
        vfs: allocVfs,
        memory: createWasmMemory(16),
        slotCount: 16,
        readAhead: { maxPages: 999 },
      }).maxReadAheadPages,
    ).toBe(256);
    expect(
      new BufferPoolDriver({
        vfs: allocVfs,
        memory: createWasmMemory(16),
        slotCount: 16,
        readAhead: {},
      }).maxReadAheadPages,
    ).toBe(32);

    expect(
      new BufferPoolDriver({
        vfs: new ReadOnlyOverlayVfs(new MemoryStorage()),
        memory: createWasmMemory(16),
        slotCount: 16,
      }).readAheadEnabled,
    ).toBe(false);
    expect(
      new BufferPoolDriver({
        vfs: new ReadOnlyOverlayVfs(new IdbStorage(uniqueName("ro_idb_def"))),
        memory: createWasmMemory(16),
        slotCount: 16,
      }).readAheadEnabled,
    ).toBe(true);

    // 5. BufferPoolDriver.stepVm() pins active cursor pages across fault_page_id != cursor.pageId and resets fault_page_id
    const vmVfs = new MemoryStorage();
    for (let p = 2; p <= 10; p++) {
      await vmVfs.writePages([
        { pageId: p, data: initRawPage(PAGE_TYPE_LEAF_DATA, p + 1, p) },
      ]);
    }
    const vmDriver = new BufferPoolDriver({
      vfs: vmVfs,
      memory: createWasmMemory(16),
      slotCount: 16,
      readAhead: true,
    });
    vmDriver.getSlotDataView(0).setUint32(HEADER_OFFSET_TOTAL_PAGES, 10, true);
    await vmDriver.acquirePage(2); // cursor sits on page 2
    const vmCtx = createVmContext();
    vmCtx.cursor.pageId = 2;
    let stepCalls = 0;
    const finalStatus = await vmDriver.stepVm(vmCtx, new Uint8Array([0]), (c) => {
      stepCalls++;
      if (stepCalls === 1) {
        // Fault on overflow page 5 while cursor sits on page 2 (must pin page 2 during acquire!)
        expect(vmDriver.getResidentSlot(2)).toBeGreaterThan(0);
        c.fault_page_id = 5;
        return VmStatus.PAGE_FAULT;
      }
      if (stepCalls === 2) {
        // After resolving 5, verify fault_page_id was cleared and page 2 remained resident; test fallback to cursor.pageId when fault_page_id===0
        expect(c.fault_page_id).toBe(0);
        expect(vmDriver.getResidentSlot(2)).toBeGreaterThan(0);
        expect(vmDriver.getResidentSlot(5)).toBeGreaterThan(0);
        c.cursor.pageId = 6;
        c.fault_page_id = 0;
        return VmStatus.PAGE_FAULT;
      }
      expect(vmDriver.getResidentSlot(6)).toBeGreaterThan(0);
      return VmStatus.DONE;
    });
    expect(finalStatus).toBe(VmStatus.DONE);
    expect(stepCalls).toBe(3);
  });
});

describe("Lifecycle Resets, WebDB Options & Cross-Adapter Integration", () => {
  it("resets read-ahead cleanly across rollback, nested savepoints, cross-tab sync, and importBinary()", async () => {
    const dbName = uniqueName("seq_lifecycle_reset");
    const db = await WebDB.open({
      name: dbName,
      engine: testEngine(),
      storage: new IdbStorage(dbName),
      crossTabSync: true,
    });
    openedDbs.push(db);

    await db.createTable("items", [
      { name: "id", type: DataType.INT32, primaryKey: true },
      { name: "note", type: DataType.TEXT, notNull: true },
    ]);
    await db.insertMany(
      "items",
      Array.from({ length: 120 }, (_, i) => ({
        id: i + 1,
        note: `base-${i + 1}-` + "n".repeat(160),
      })),
    );
    await db.checkpoint();

    // 1. Nested savepoint + full rollback clears read-ahead & speculative state
    await expect(
      db.transaction(async (tx) => {
        await tx.insert("items", { id: 200, note: "outer-tx-" + "o".repeat(160) });
        await expect(
          tx.transaction(async (nested) => {
            await nested.insert("items", {
              id: 201,
              note: "nested-tx-" + "x".repeat(160),
            });
            await nested.from("items").toArray();
            throw new Error("abort-nested");
          }),
        ).rejects.toThrow("abort-nested");
        throw new Error("abort-outer");
      }),
    ).rejects.toThrow("abort-outer");

    const afterAbort = await db.from("items").orderBy("id", "asc").toArray();
    expect(afterAbort).toHaveLength(120);
    expect(afterAbort.some((r) => r.id >= 200)).toBe(false);

    // 2. Cross-tab sync invalidates Tab B's buffer pool and resets read-ahead
    const tabB = await WebDB.open({
      name: dbName,
      engine: testEngine(),
      storage: new IdbStorage(dbName),
      crossTabSync: true,
    });
    openedDbs.push(tabB);

    // Prime sequential read-ahead on Tab B
    expect(await tabB.from("items").toArray()).toHaveLength(120);

    // Tab A inserts more rows causing new pages
    await db.insertMany(
      "items",
      Array.from({ length: 60 }, (_, i) => ({
        id: 300 + i,
        note: `tabA-${i}-` + "a".repeat(160),
      })),
    );
    await tabB.coordinator.syncCrossTabState(true);
    const seenByB = await tabB.from("items").orderBy("id", "asc").toArray();
    expect(seenByB).toHaveLength(180);

    // 3. importBinary() resets read-ahead and allows clean cold batched scan of imported DB
    const src = await WebDB.open({
      name: uniqueName("seq_imp_src"),
      engine: testEngine(),
      storage: new MemoryStorage(),
      crossTabSync: false,
    });
    openedDbs.push(src);
    await src.createTable("docs", [
      { name: "id", type: DataType.INT32, primaryKey: true },
      { name: "val", type: DataType.TEXT, notNull: true },
    ]);
    await src.insertMany(
      "docs",
      Array.from({ length: 160 }, (_, i) => ({
        id: i + 1,
        val: `imported-${i + 1}-` + "m".repeat(160),
      })),
    );
    const snapshot = await src.exportBinary();

    await db.importBinary(snapshot);
    // Evict imported data slots so next scan runs cold from IdbStorage
    for (let s = 1; s < db.pool.slotCount; s++) {
      if (!db.pool.isSlotPinned(s) && !db.pool.isDirty(s)) {
        db.pool.unassignSlot(s);
      }
    }
    db.pool.resetReadAhead();
    const impBatches: number[][] = [];
    const origRead = db.vfs.readPages.bind(db.vfs);
    vi.spyOn(db.vfs, "readPages").mockImplementation(async (ids) => {
      impBatches.push([...ids]);
      return origRead(ids);
    });
    const importedRows = await db.from("docs").orderBy("id", "asc").toArray();
    expect(importedRows).toHaveLength(160);
    expect(impBatches.some((b) => b.length >= 4)).toBe(true);
  });

  it("supports WebDB.open({ readAhead }) options and integrates end-to-end with NodeFsStorage & ReadOnlyOverlayVfs", async () => {
    // 1. WebDB.open({ readAhead: false }) and { readAhead: { maxPages: 4 } } on IdbStorage
    const idbName = uniqueName("seq_webdb_opts");
    const seedDb = await WebDB.open({
      name: idbName,
      engine: testEngine(),
      storage: new IdbStorage(idbName),
      crossTabSync: false,
    });
    await seedDb.createTable("logs", [
      { name: "id", type: DataType.INT32, notNull: true },
      { name: "msg", type: DataType.TEXT, notNull: true },
    ]);
    await seedDb.insertMany(
      "logs",
      Array.from({ length: 300 }, (_, i) => ({
        id: i + 1,
        msg: `log-entry-${i + 1}-` + "l".repeat(170),
      })),
    );
    await seedDb.close();

    const noRaDb = await WebDB.open({
      name: idbName,
      engine: testEngine(),
      storage: new IdbStorage(idbName),
      crossTabSync: false,
      readAhead: false,
    });
    openedDbs.push(noRaDb);
    expect(noRaDb.driver.readAheadEnabled).toBe(false);
    const noRaBatches: number[][] = [];
    const origNoRa = noRaDb.vfs.readPages.bind(noRaDb.vfs);
    vi.spyOn(noRaDb.vfs, "readPages").mockImplementation(async (ids) => {
      noRaBatches.push([...ids]);
      return origNoRa(ids);
    });
    expect(await noRaDb.from("logs").toArray()).toHaveLength(300);
    expect(noRaBatches.every((b) => b.length === 1)).toBe(true);

    const cap4Db = await WebDB.open({
      name: idbName,
      engine: testEngine(),
      storage: new IdbStorage(idbName),
      crossTabSync: false,
      readAhead: { maxPages: 4 },
    });
    openedDbs.push(cap4Db);
    expect(cap4Db.driver.maxReadAheadPages).toBe(4);
    const cap4Batches: number[][] = [];
    const origCap4 = cap4Db.vfs.readPages.bind(cap4Db.vfs);
    vi.spyOn(cap4Db.vfs, "readPages").mockImplementation(async (ids) => {
      cap4Batches.push([...ids]);
      return origCap4(ids);
    });
    expect(await cap4Db.from("logs").toArray()).toHaveLength(300);
    expect(cap4Batches.some((b) => b.length === 4)).toBe(true);
    expect(cap4Batches.every((b) => b.length <= 4)).toBe(true);

    // 2. WebDB.open({ readAhead: { maxPages: 8 } }) on MemoryStorage
    const memRaDb = await WebDB.open({
      engine: testEngine(),
      storage: new MemoryStorage(),
      crossTabSync: false,
      readAhead: { maxPages: 8 },
    });
    openedDbs.push(memRaDb);
    expect(memRaDb.driver.readAheadEnabled).toBe(true);
    expect(memRaDb.driver.maxReadAheadPages).toBe(8);

    // 3. NodeFsStorage & ReadOnlyOverlayVfs (with uncheckpointed WAL frames) end-to-end
    const dir = await mkdtemp(join(tmpdir(), "webdb-seq-nodefs-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "store.db");

    const fsSeed = await WebDB.open({
      engine: testEngine(),
      storage: new NodeFsStorage(dbPath),
      crossTabSync: false,
    });
    await fsSeed.createTable("records", [
      { name: "id", type: DataType.INT32, primaryKey: true },
      { name: "body", type: DataType.TEXT, notNull: true },
    ]);
    await fsSeed.insertMany(
      "records",
      Array.from({ length: 220 }, (_, i) => ({
        id: i + 1,
        body: `nodefs-row-${i + 1}-` + "f".repeat(160),
      })),
    );
    await fsSeed.checkpoint();
    // Leave an uncheckpointed WAL transaction on disk before closing raw handles without checkpoint
    await fsSeed.transaction(async (tx) => {
      await tx.update(
        "records",
        { id: 100 },
        { body: "wal-overlaid-100-" + "w".repeat(160) },
      );
    });
    await fsSeed.vfs.close?.();

    // Reopen NodeFsStorage read-write with cold read-ahead
    const fsRead = await WebDB.open({
      engine: testEngine(),
      storage: new NodeFsStorage(dbPath),
      crossTabSync: false,
    });
    openedDbs.push(fsRead);
    expect(fsRead.driver.readAheadEnabled).toBe(true);
    const fsBatches: number[][] = [];
    const origFsRead = fsRead.vfs.readPages.bind(fsRead.vfs);
    vi.spyOn(fsRead.vfs, "readPages").mockImplementation(async (ids) => {
      fsBatches.push([...ids]);
      return origFsRead(ids);
    });
    const fsRows = await fsRead.from("records").orderBy("id", "asc").toArray();
    expect(fsRows).toHaveLength(220);
    expect(fsRows.find((r) => r.id === 100)?.body).toBe(
      "wal-overlaid-100-" + "w".repeat(160),
    );
    expect(fsBatches.some((b) => b.length >= 4)).toBe(true);
    await fsRead.close();
    openedDbs.pop();

    // Leave another uncheckpointed WAL edit, then inspect via ReadOnlyOverlayVfs("node-fs-ro")
    const fsWrite2 = await WebDB.open({
      engine: testEngine(),
      storage: new NodeFsStorage(dbPath),
      crossTabSync: false,
    });
    await fsWrite2.transaction(async (tx) => {
      await tx.update(
        "records",
        { id: 50 },
        { body: "ro-overlay-wal-50-" + "r".repeat(160) },
      );
    });
    await fsWrite2.vfs.close?.();

    const roOverlay = new ReadOnlyOverlayVfs(
      new NodeFsStorage(dbPath, { readOnly: true }),
    );
    const roDb = await WebDB.open({
      engine: testEngine(),
      storage: roOverlay,
      crossTabSync: false,
    });
    openedDbs.push(roDb);
    expect(roDb.driver.readAheadEnabled).toBe(true);
    const roBatches: number[][] = [];
    const origRoRead = roDb.vfs.readPages.bind(roDb.vfs);
    vi.spyOn(roDb.vfs, "readPages").mockImplementation(async (ids) => {
      roBatches.push([...ids]);
      return origRoRead(ids);
    });
    const roRows = await roDb.from("records").orderBy("id", "asc").toArray();
    expect(roRows).toHaveLength(220);
    expect(roRows.find((r) => r.id === 50)?.body).toBe(
      "ro-overlay-wal-50-" + "r".repeat(160),
    );
    expect(roBatches.some((b) => b.length >= 4)).toBe(true);
  });
});
