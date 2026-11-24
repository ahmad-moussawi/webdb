import { describe, it, expect } from "vitest";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WebDB,
  UlidCodec,
  UuidCodec,
  CorruptPageError,
  PAGE_SIZE,
  OVERFLOW_HEADER_SIZE,
  HEADER_OFFSET_CHANGE_COUNTER,
  type TableChangeEvent,
} from "@ahmadmoussawi/webdb/slim";
import { computePageChecksum, computePage1Checksum } from "../src/host/storage/crc32.ts";
import { page_get_cell_offset, page_extract_overflow_descriptors } from "../src/core/js/page.c.ts";
import {
  catalog_read_table_descriptor,
  catalog_write_table_descriptor,
  catalog_update_page1_checksum,
} from "../src/core/js/catalog.c.ts";
import { OpfsStorage } from "../src/host/storage/opfs.ts";
import { MemoryStorage } from "@ahmadmoussawi/webdb/storage/memory";
import { NodeFsStorage } from "@ahmadmoussawi/webdb/storage/node";
import { ReadOnlyOverlayVfs } from "../src/host/storage/read_only_overlay.ts";
import { testEngine } from "./helpers/test_engine.js";

describe("WebDB.compact()", () => {
  it("reclaims free/fragmented pages after heavy deletes and preserves rows, types, overflows, indexes, autoInc, and versions", async () => {
    const db = await WebDB.open({
      storage: new MemoryStorage(),
      engine: testEngine(),
      crossTabSync: false,
    });

    await db.createTable("items", [
      { name: "id", type: "INT32", primaryKey: true, autoInc: true },
      { name: "uid", type: "ULID", notNull: true },
      { name: "gid", type: "UUID" },
      { name: "big_i64", type: "INT64" },
      { name: "price", type: "FLOAT64" },
      { name: "sku", type: "TEXT", notNull: true },
      { name: "note", type: "TEXT" },
      { name: "payload", type: "BLOB" },
    ]);
    await db.createIndex("items", "sku", { name: "idx_items_sku", unique: true });
    await db.createIndex("items", ["price", "sku"], { name: "idx_items_price_sku" });

    // Table with composite primary key and no auto_inc
    await db.createTable("composite_tbl", [
      { name: "tenant", type: "TEXT", primaryKey: true, notNull: true },
      { name: "seq", type: "INT32", primaryKey: true, notNull: true },
      { name: "label", type: "TEXT" },
    ]);

    // Temporary table that will be dropped before compaction
    await db.createTable("temp_drop", [
      { name: "id", type: "INT32", primaryKey: true },
      { name: "body", type: "TEXT" },
    ]);
    const tempRows = Array.from({ length: 120 }, (_, i) => ({
      id: i + 1,
      body: `temp-row-${i}-${"x".repeat(120)}`,
    }));
    await db.insertMany("temp_drop", tempRows);

    const bigOverflowText = "OVF_TEXT_".repeat(600); // > 4 KB (overflow pages)
    const bigBlob = new Uint8Array(5100);
    for (let i = 0; i < bigBlob.length; i++) bigBlob[i] = (i * 17 + 3) & 0xff;

    const uid1Str = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
    const uid2Str = "01ARZ3NDEKTSV4RRFFQ69G5FA2";
    const gid1Str = "550e8400-e29b-41d4-a716-446655440000";

    const itemRows = Array.from({ length: 180 }, (_, i) => ({
      uid:
        i === 0
          ? uid1Str
          : i === 179
            ? uid2Str
            : `01ARZ3NDEKTSV4RRFFQ69G${String(i).padStart(4, "0")}`,
      gid: i === 0 ? gid1Str : null,
      big_i64: i === 0 ? 9_007_199_254_740_995n : BigInt(i) * 1_000_000n,
      price: i * 1.5,
      sku: `SKU-${String(i).padStart(4, "0")}`,
      note: i === 0 ? bigOverflowText : i % 3 === 0 ? null : `note-${i}-${"n".repeat(160)}`,
      payload: i === 0 ? bigBlob : null,
    }));
    await db.insertMany("items", itemRows);
    await db.insertMany("composite_tbl", [
      { tenant: "acme", seq: 1, label: "first" },
      { tenant: "acme", seq: 2, label: "second" },
      { tenant: "beta", seq: 1, label: "third" },
    ]);

    // Fragment the DB: drop `temp_drop` and delete most of `items` INCLUDING highest autoInc ID (180)
    await db.dropTable("temp_drop");
    const deletedCount = await db.from("items").where("id", ">", 5).delete();
    expect(deletedCount).toBe(175);

    // Advance one more table to check schemaVersion preservation
    const syncBefore = db.getSyncState();
    const tableBefore = await db.getTable("items");
    expect(tableBefore.autoIncNext).toBe(181n);

    // Dry-run must not mutate sync state or storage
    const dryRes = await db.compact({ dryRun: true });
    expect(dryRes.dryRun).toBe(true);
    expect(dryRes.compacted).toBe(false);
    expect(dryRes.pagesAfter).toBeLessThan(dryRes.pagesBefore);
    expect(dryRes.pagesReclaimed).toBeGreaterThan(0);
    expect(dryRes.bytesReclaimed).toBe(dryRes.pagesReclaimed * PAGE_SIZE);
    expect(dryRes.freePagesBefore).toBeGreaterThan(0);
    expect(dryRes.rowsCopied).toBe(8); // 5 items + 3 composite_tbl
    expect(dryRes.tablesCompacted).toBe(2);
    expect(dryRes.indexesRebuilt).toBe(2);
    expect(db.getSyncState()).toEqual(syncBefore);

    // Track subscribe event
    const events: TableChangeEvent[] = [];
    const unsub = db.subscribe("*", (ev) => events.push(ev));

    // Threshold higher than reclaimable skips compaction
    const skippedRes = await db.compact({
      minReclaimPages: dryRes.pagesReclaimed + 1,
    });
    expect(skippedRes.compacted).toBe(false);
    expect(skippedRes.dryRun).toBe(false);
    expect(events).toHaveLength(0);

    // Full compaction
    const res = await db.compact({ batchSize: 2 });
    unsub();

    expect(res.compacted).toBe(true);
    expect(res.dryRun).toBe(false);
    expect(res.pagesBefore).toBe(dryRes.pagesBefore);
    expect(res.pagesAfter).toBe(dryRes.pagesAfter);
    expect(res.pagesReclaimed).toBe(dryRes.pagesReclaimed);
    expect(res.rowsCopied).toBe(8);

    // Schema version stays identical; changeCounter advances by 1; origin === "compact"
    const syncAfter = db.getSyncState();
    expect(syncAfter.schemaVersion).toBe(syncBefore.schemaVersion);
    expect(syncAfter.changeCounter).toBe(syncBefore.changeCounter + 1);
    expect(events).toHaveLength(1);
    expect(events[0].origin).toBe("compact");
    expect(events[0].tables.sort()).toEqual(["composite_tbl", "items"]);

    // Verify all rows, types, NULLs, and overflow columns survived identically
    const itemsAfter = await db.from("items").orderBy("id", "asc").toArray();
    expect(itemsAfter).toHaveLength(5);
    expect(itemsAfter[0].id).toBe(1);
    expect(
      itemsAfter[0].uid instanceof Uint8Array
        ? UlidCodec.decode(itemsAfter[0].uid)
        : itemsAfter[0].uid,
    ).toBe(uid1Str);
    expect(
      itemsAfter[0].gid instanceof Uint8Array
        ? UuidCodec.decode(itemsAfter[0].gid)
        : itemsAfter[0].gid,
    ).toBe(gid1Str);
    expect(itemsAfter[0].big_i64).toBe(9_007_199_254_740_995n);
    expect(itemsAfter[0].note).toBe(bigOverflowText);
    expect(itemsAfter[0].payload).toEqual(bigBlob);
    expect(itemsAfter[3].note).toBeNull(); // id=4 => index 3 => i%3===0

    // Verify autoIncNext was preserved (even though id=6..180 were deleted!)
    const tableAfter = await db.getTable("items");
    expect(tableAfter.autoIncNext).toBe(181n);
    await db.insert("items", {
      uid: uid2Str,
      gid: null,
      big_i64: 42n,
      price: 9.5,
      sku: "SKU-NEW-181",
      note: "fresh",
      payload: null,
    });
    const inserted = await db.from("items").where("sku", "=", "SKU-NEW-181").toArray();
    expect(inserted).toHaveLength(1);
    expect(inserted[0].id).toBe(181);

    // Verify secondary & unique indexes continue working after compaction
    await expect(
      db.insert("items", {
        uid: uid2Str,
        gid: null,
        big_i64: 1n,
        price: 1.0,
        sku: "SKU-0000",
        note: null,
        payload: null,
      }),
    ).rejects.toThrow();

    const compRows = await db.from("composite_tbl").orderBy("tenant", "asc").orderBy("seq", "asc").toArray();
    expect(compRows).toEqual([
      { tenant: "acme", seq: 1, label: "first" },
      { tenant: "acme", seq: 2, label: "second" },
      { tenant: "beta", seq: 1, label: "third" },
    ]);

    // Exported binary matches compacted byte count
    const bin = await db.exportBinary();
    expect(bin.byteLength).toBe(res.bytesAfter);
    expect((await db.compact({ dryRun: true })).freePagesBefore).toBe(0);

    await db.close();
  });

  it("handles overflow catalogs (>16 tables, >8 indexes), readOnly errors, active tx errors, and shrinks NodeFsStorage files", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "webdb-compact-test-"));
    const dbPath = join(workDir, "compact.db");

    try {
      const storage = new NodeFsStorage(dbPath);
      const db = await WebDB.open({
        storage,
        engine: testEngine(),
        crossTabSync: false,
      });

      // Create 18 tables (> MAX_TABLES_PAGE1 = 16) and 10 indexes (> MAX_INDEXES_PAGE1 = 8)
      for (let t = 1; t <= 18; t++) {
        await db.createTable(`tbl_${t}`, [
          { name: "id", type: "INT32", primaryKey: true, autoInc: true },
          { name: "val", type: "TEXT", notNull: true },
        ]);
        if (t <= 10) {
          await db.createIndex(`tbl_${t}`, "val", { name: `idx_tbl_${t}_val` });
        }
      }

      await db.insertMany(
        "tbl_1",
        Array.from({ length: 150 }, (_, i) => ({
          val: `value-${i}-${"z".repeat(150)}`,
        })),
      );
      expect(await db.from("tbl_1").where("id", ">", 3).delete()).toBe(147);

      // Reject inside active transaction
      await db.transaction(async () => {
        await expect(db.compact()).rejects.toThrow(/transaction is active/i);
      });

      // Compact on NodeFsStorage and verify physical file truncation
      const sizeBefore = (await stat(dbPath)).size;
      const res = await db.compact();
      const sizeAfter = (await stat(dbPath)).size;

      expect(res.compacted).toBe(true);
      expect(res.tablesCompacted).toBe(18);
      expect(res.indexesRebuilt).toBe(10);
      expect(sizeAfter).toBe(res.bytesAfter);
      expect(sizeAfter).toBeLessThan(sizeBefore);

      await db.close();

      // Re-open strictly read-only: compact() rejects unless dryRun: true
      const roOverlay = new ReadOnlyOverlayVfs(new NodeFsStorage(dbPath, { readOnly: true }));
      const roDb = await WebDB.open({
        storage: roOverlay,
        engine: testEngine(),
        crossTabSync: false,
      });
      await expect(roDb.compact()).rejects.toThrow(/read-only/i);
      const roDry = await roDb.compact({ dryRun: true });
      expect(roDry.dryRun).toBe(true);
      expect(roDry.tablesCompacted).toBe(18);
      expect(roDry.rowsCopied).toBe(3);
      await roDb.close();
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("handles nullable AUTO_INC nulls, dropped PKs, tight slotCount, INT64 > 2^53, FLOAT64 NaN, case-variant names, dryRun WAL preservation, >56 cols, multi-page UTF-8 overflow, and empty DB events", async () => {
    // 1. Tight slotCount = 3 on a 1-table PK DB (H4)
    {
      const seed = await WebDB.open({
        storage: new MemoryStorage(),
        engine: testEngine(),
        crossTabSync: false,
      });
      await seed.createTable("tight", [{ name: "id", type: "INT32", primaryKey: true }]);
      await seed.insert("tight", { id: 1 });
      const bin = await seed.exportBinary();
      await seed.close();

      const tightDb = await WebDB.open({
        storage: new MemoryStorage(),
        engine: testEngine(),
        slotCount: 3,
        initialData: bin,
        crossTabSync: false,
      });
      const res = await tightDb.compact();
      expect(res.compacted).toBe(true);
      expect(await tightDb.from("tight").toArray()).toEqual([{ id: 1 }]);
      await tightDb.close();
    }

    // 2. Empty DB wildcard subscribe notification (L4)
    {
      const emptyDb = await WebDB.open({
        storage: new MemoryStorage(),
        engine: testEngine(),
        crossTabSync: false,
      });
      const events: TableChangeEvent[] = [];
      emptyDb.subscribe("*", (ev) => events.push(ev));
      const res = await emptyDb.compact();
      expect(res.compacted).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0].origin).toBe("compact");
      await emptyDb.close();
    }

    // 3. Combined feature/edge-case test
    const db = await WebDB.open({
      storage: new MemoryStorage(),
      engine: testEngine(),
      crossTabSync: false,
    });

    // H2: nullable AUTO_INC column
    await db.createTable("null_autoinc", [
      { name: "id", type: "INT32", primaryKey: true },
      { name: "seq", type: "INT32", autoInc: true },
    ]);
    await db.insert("null_autoinc", { id: 1 });
    await db.update("null_autoinc", 1, { seq: null });

    // H3: dropped PK index with duplicate keys
    await db.createTable("dropped_pk", [
      { name: "id", type: "INT32", primaryKey: true },
      { name: "tag", type: "TEXT" },
    ]);
    await db.dropIndex("pk_dropped_pk");
    await db.insertMany("dropped_pk", [
      { id: 7, tag: "a" },
      { id: 7, tag: "b" },
    ]);

    // M1: INT64 > 2^53 PK + FLOAT64 NaN / -0 / Infinity unique/boundary
    await db.createTable("precision_tbl", [
      { name: "id", type: "INT64", primaryKey: true },
      { name: "val", type: "FLOAT64" },
      { name: "txt", type: "TEXT" },
      { name: "raw", type: "BLOB" },
    ]);
    await db.createIndex("precision_tbl", "val", {
      name: "idx_prec_val_u",
      unique: true,
    });
    const utf8Chunk = "🚀é".repeat(3200); // > 8 KB multi-byte UTF-8 spanning 4080B overflow boundaries
    await db.insertMany("precision_tbl", [
      {
        id: 9007199254740992n,
        val: Number.NaN,
        txt: utf8Chunk,
        raw: new Uint8Array(0),
      },
      {
        id: 9007199254740993n,
        val: -0,
        txt: "",
        raw: new Uint8Array([1, 2, 3]),
      },
      {
        id: 9007199254740994n,
        val: Number.POSITIVE_INFINITY,
        txt: "inf",
        raw: null,
      },
      {
        id: -9007199254740993n,
        val: Number.NEGATIVE_INFINITY,
        txt: "ninf",
        raw: null,
      },
    ]);

    // M2: Case-variant table names
    await db.createTable("Users", [{ name: "a", type: "INT32", primaryKey: true }]);
    await db.createTable("users", [{ name: "b", type: "INT32", primaryKey: true }]);
    await db.insert("Users", { a: 10 });
    await db.insert("users", { b: 20 });

    // > 56 columns (2 chained column catalog pages) on table without PK
    const wideCols = Array.from({ length: 60 }, (_, i) => ({
      name: `c_${i}`,
      type: (i === 0 ? "INT32" : "TEXT") as "INT32" | "TEXT",
    }));
    await db.createTable("wide_nopk", wideCols);
    await db.insert("wide_nopk", { c_0: 42, c_59: "tail" });

    // Bump changeCounter to 0xFFFFFFFF in binary and reopen to test wraparound to 0
    const preBin = await db.exportBinary();
    await db.close();
    new DataView(preBin.buffer, preBin.byteOffset, PAGE_SIZE).setUint32(
      HEADER_OFFSET_CHANGE_COUNTER,
      0xffffffff,
      true,
    );
    const p1Chk = computePage1Checksum(preBin.subarray(0, PAGE_SIZE));
    new DataView(preBin.buffer, preBin.byteOffset, PAGE_SIZE).setUint32(
      28,
      p1Chk,
      true,
    );

    const db2 = await WebDB.open({
      storage: new MemoryStorage(),
      engine: testEngine(),
      initialData: preBin,
      crossTabSync: false,
    });

    const compactRes = await db2.compact({ batchSize: 1 });
    expect(compactRes.compacted).toBe(true);
    expect(db2.getSyncState().changeCounter).toBe(0); // 0xFFFFFFFF + 1 >>> 0 === 0

    // H2 check
    expect(await db2.from("null_autoinc").toArray()).toEqual([{ id: 1, seq: null }]);
    // H3 check
    expect(await db2.from("dropped_pk").toArray()).toHaveLength(2);
    expect((await db2.getTable("dropped_pk")).pkRootPageId).toBeUndefined();
    // M1 & boundary values check
    const prec = await db2.from("precision_tbl").orderBy("id", "asc").toArray();
    expect(prec).toHaveLength(4);
    expect(prec.find((r) => r.id === 9007199254740992n)?.txt).toBe(utf8Chunk);
    expect(prec.find((r) => r.id === 9007199254740992n)?.raw).toEqual(new Uint8Array(0));
    expect(Number.isNaN(prec.find((r) => r.id === 9007199254740992n)?.val as number)).toBe(true);
    expect(prec.find((r) => r.id === 9007199254740993n)?.txt).toBe("");
    expect(prec.find((r) => r.id === 9007199254740994n)?.val).toBe(Number.POSITIVE_INFINITY);
    expect(prec.find((r) => r.id === -9007199254740993n)?.val).toBe(Number.NEGATIVE_INFINITY);
    // M2 check
    expect(await db2.from("Users").toArray()).toEqual([{ a: 10 }]);
    expect(await db2.from("users").toArray()).toEqual([{ b: 20 }]);
    // Wide >56 col table check
    const wide = await db2.from("wide_nopk").toArray();
    expect(wide[0].c_0).toBe(42);
    expect(wide[0].c_59).toBe("tail");
    await db2.close();

    // M3: dryRun: true must not checkpoint or mutate disk/WAL on NodeFsStorage
    const workDir = await mkdtemp(join(tmpdir(), "webdb-dry-wal-"));
    try {
      const dbPath = join(workDir, "drywal.db");
      const walStorage = new NodeFsStorage(dbPath);
      const wdb = await WebDB.open({
        storage: walStorage,
        engine: testEngine(),
        crossTabSync: false,
      });
      await wdb.createTable("t", [{ name: "id", type: "INT32", primaryKey: true }]);
      await wdb.insert("t", { id: 1 });
      await wdb.insert("t", { id: 2 });
      const framesBeforeDry = await walStorage.getWalFrameCount();
      const dbSizeBeforeDry = (await stat(dbPath)).size;
      const dry = await wdb.compact({ dryRun: true });
      expect(dry.dryRun).toBe(true);
      expect(dry.rowsCopied).toBe(2);
      expect(await walStorage.getWalFrameCount()).toBe(framesBeforeDry);
      expect((await stat(dbPath)).size).toBe(dbSizeBeforeDry);
      await wdb.close();
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("rejects corrupted disk pages in exportBinary(), corrupted cells/overflow in compact(), and preserves DB on atomic write errors", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "webdb-corrupt-"));
    try {
      // C1: bit-flipped data page on disk causes exportBinary() to throw CorruptPageError
      const dbPath = join(workDir, "bitflip.db");
      const st1 = new NodeFsStorage(dbPath);
      const db1 = await WebDB.open({
        storage: st1,
        engine: testEngine(),
        crossTabSync: false,
      });
      await db1.createTable("docs", [
        { name: "id", type: "INT32", primaryKey: true },
        { name: "body", type: "TEXT" },
      ]);
      await db1.insert("docs", { id: 1, body: "hello-world" });
      await db1.insert("docs", { id: 2, body: "B".repeat(5000) }); // spills to overflow
      const docsMeta = await db1.getTable("docs");
      await db1.close();

      // Flip a byte on docs' leaf page cleanly on disk
      const raw = new Uint8Array(await readFile(dbPath));
      const leafOff = (docsMeta.rootPageId - 1) * PAGE_SIZE;
      raw[leafOff + PAGE_SIZE - 2] ^= 0xff;
      await writeFile(dbPath, raw);

      const dbRo = await WebDB.open({
        storage: new ReadOnlyOverlayVfs(new NodeFsStorage(dbPath, { readOnly: true })),
        engine: testEngine(),
        crossTabSync: false,
      });
      await expect(dbRo.exportBinary()).rejects.toThrow(CorruptPageError);
      await dbRo.close();

      // H1a: broken overflow chain (page type zeroed with valid CRC32) throws CorruptPageError in compact()
      const db2 = await WebDB.open({
        storage: new MemoryStorage(),
        engine: testEngine(),
        crossTabSync: false,
      });
      await db2.createTable("ovf", [
        { name: "id", type: "INT32", primaryKey: true },
        { name: "big", type: "TEXT" },
      ]);
      await db2.insert("ovf", { id: 1, big: "X".repeat(6000) });
      const ovfMeta = await db2.getTable("ovf");
      const bin2 = await db2.exportBinary();
      await db2.close();

      const ovfLeafView = new DataView(
        bin2.buffer,
        bin2.byteOffset + (ovfMeta.rootPageId - 1) * PAGE_SIZE,
        PAGE_SIZE,
      );
      const firstCellOff = page_get_cell_offset(ovfLeafView, 0, 0);
      const ovIds = page_extract_overflow_descriptors(ovfMeta.columns, ovfLeafView, firstCellOff);
      expect(ovIds.length).toBeGreaterThan(0);
      const brokenOvPageId = ovIds[0];
      const ovSlice = bin2.subarray(
        (brokenOvPageId - 1) * PAGE_SIZE,
        brokenOvPageId * PAGE_SIZE,
      );
      ovSlice[0] = 0x00; // corrupt page type
      new DataView(ovSlice.buffer, ovSlice.byteOffset, PAGE_SIZE).setUint32(
        12,
        computePageChecksum(ovSlice),
        true,
      );
      const dbBrokenOvf = await WebDB.open({
        storage: new MemoryStorage(),
        engine: testEngine(),
        initialData: bin2,
        crossTabSync: false,
      });
      await expect(dbBrokenOvf.compact()).rejects.toThrow(CorruptPageError);
      await dbBrokenOvf.close();

      // H1b: malformed row cell (flags/length broken with valid CRC32) throws CorruptPageError in compact()
      const db3 = await WebDB.open({
        storage: new MemoryStorage(),
        engine: testEngine(),
        crossTabSync: false,
      });
      await db3.createTable("cells", [
        { name: "id", type: "INT32", primaryKey: true },
        { name: "s", type: "TEXT" },
      ]);
      await db3.insert("cells", { id: 1, s: "ok" });
      const cellsMeta = await db3.getTable("cells");
      const bin3 = await db3.exportBinary();
      await db3.close();

      const cellsLeafSlice = bin3.subarray(
        (cellsMeta.rootPageId - 1) * PAGE_SIZE,
        cellsMeta.rootPageId * PAGE_SIZE,
      );
      const cOff = page_get_cell_offset(
        new DataView(cellsLeafSlice.buffer, cellsLeafSlice.byteOffset, PAGE_SIZE),
        0,
        0,
      );
      cellsLeafSlice[cOff] = 0x00; // clear ROW_FLAG_ACTIVE so page_deserialize_row returns null
      new DataView(cellsLeafSlice.buffer, cellsLeafSlice.byteOffset, PAGE_SIZE).setUint32(
        12,
        computePageChecksum(cellsLeafSlice),
        true,
      );
      const dbBadCell = await WebDB.open({
        storage: new MemoryStorage(),
        engine: testEngine(),
        initialData: bin3,
        crossTabSync: false,
      });
      await expect(dbBadCell.compact()).rejects.toThrow(CorruptPageError);
      await dbBadCell.close();

      // C2: NodeFsStorage.replaceDatabaseAtomic error preserves existing on-disk DB cleanly
      const atomicPath = join(workDir, "atomic-fail.db");
      const stAtomic = new NodeFsStorage(atomicPath);
      const dbAtomic = await WebDB.open({
        storage: stAtomic,
        engine: testEngine(),
        crossTabSync: false,
      });
      await dbAtomic.createTable("keep", [{ name: "id", type: "INT32", primaryKey: true }]);
      await dbAtomic.insert("keep", { id: 99 });
      await dbAtomic.close();
      const beforeBytes = new Uint8Array(await readFile(atomicPath));

      const stFail = new NodeFsStorage(atomicPath);
      await expect(
        stFail.replaceDatabaseAtomic(
          [{ pageId: 2, data: new Uint8Array(PAGE_SIZE) }], // invalid non-1 start page triggers pre-swap error
          new Uint8Array(32),
        ),
      ).rejects.toThrow();
      await stFail.close();
      expect(new Uint8Array(await readFile(atomicPath))).toEqual(beforeBytes);
      // Verify file permissions preserved on successful replaceDatabaseAtomic
      await chmod(atomicPath, 0o600);
      const stPerm = new NodeFsStorage(atomicPath);
      const dbPerm = await WebDB.open({
        storage: stPerm,
        engine: testEngine(),
        crossTabSync: false,
      });
      await dbPerm.compact();
      await dbPerm.close();
      expect((await stat(atomicPath)).mode & 0o777).toBe(0o600);

      // H1c: cellCount > MAX_SLOTS_PER_PAGE with valid CRC32 throws CorruptPageError in WebDB.compact()
      const maxSlotsSlice = bin3.slice();
      const maxLeaf = maxSlotsSlice.subarray(
        (cellsMeta.rootPageId - 1) * PAGE_SIZE,
        cellsMeta.rootPageId * PAGE_SIZE,
      );
      new DataView(maxLeaf.buffer, maxLeaf.byteOffset, PAGE_SIZE).setUint16(2, 50000, true);
      new DataView(maxLeaf.buffer, maxLeaf.byteOffset, PAGE_SIZE).setUint32(
        12,
        computePageChecksum(maxLeaf),
        true,
      );
      const dbBadCount = await WebDB.open({
        storage: new MemoryStorage(),
        engine: testEngine(),
        initialData: maxSlotsSlice,
        crossTabSync: false,
      });
      await expect(dbBadCount.compact()).rejects.toThrow(CorruptPageError);
      await dbBadCount.close();
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("preserves case-variant dropped PKs cleanly (H3+M2) and keeps OpfsStorage.replaceDatabaseAtomic crash/lock-safe on error", async () => {
    // 1. H3 + M2 combined: slot 0 "Users" (active PK), slot 1 "users" (dropped PK with duplicate keys)
    {
      const seed = await WebDB.open({
        storage: new MemoryStorage(),
        engine: testEngine(),
        crossTabSync: false,
      });
      await seed.createTable("Users", [{ name: "id", type: "INT32", primaryKey: true }]);
      await seed.insert("Users", { id: 1 });
      await seed.createTable("users", [{ name: "id", type: "INT32", primaryKey: true }]);
      await seed.insert("users", { id: 5 });
      const bin = await seed.exportBinary();
      await seed.close();

      // Clear embedded PK metadata on slot 1 ("users") while keeping slot 0 ("Users") PK active
      const p1View = new DataView(bin.buffer, bin.byteOffset, PAGE_SIZE);
      const usersDesc = catalog_read_table_descriptor(p1View, 1)!;
      expect(usersDesc.name).toBe("users");
      catalog_write_table_descriptor(p1View, 1, {
        ...usersDesc,
        pkRootPageId: undefined,
        pkColumnCount: undefined,
        pkFlags: undefined,
        pkColumnIndices: undefined,
        pkTailPageId: undefined,
      });
      catalog_update_page1_checksum(p1View, 0);

      const db = await WebDB.open({
        storage: new MemoryStorage(),
        engine: testEngine(),
        initialData: bin,
        crossTabSync: false,
      });
      await db.insert("users", { id: 5 }); // duplicate allowed since "users" PK is dropped
      const res = await db.compact();
      expect(res.compacted).toBe(true);
      expect((await db.getTable("Users")).pkRootPageId).toBeGreaterThan(1);
      expect((await db.getTable("users")).pkRootPageId).toBeUndefined();
      await expect(db.insert("Users", { id: 1 })).rejects.toThrow();
      await db.insert("users", { id: 5 });
      expect(await db.from("users").toArray()).toHaveLength(3);
      await db.close();
    }

    // 2. OpfsStorage.replaceDatabaseAtomic SyncAccessHandle & async writable error safety
    const prevNav = globalThis.navigator;
    const prevSyncClass = (globalThis as any).FileSystemSyncAccessHandle;
    try {
      // 2a. SyncAccessHandle staging write failure leaves live DB & WAL untouched
      const syncFiles = new Map<string, Uint8Array>();
      let failTmpWrite = false;
      (globalThis as any).FileSystemSyncAccessHandle = function () {};
      const makeSyncHandle = (fileName: string) => {
        if (!syncFiles.has(fileName)) syncFiles.set(fileName, new Uint8Array(0));
        return {
          getSize: () => syncFiles.get(fileName)!.byteLength,
          read: (buf: Uint8Array, opts?: { at?: number }) => {
            const cur = syncFiles.get(fileName)!;
            const at = opts?.at ?? 0;
            buf.set(cur.subarray(at, at + buf.byteLength));
            return buf.byteLength;
          },
          write: (buf: Uint8Array, opts?: { at?: number }) => {
            if (failTmpWrite && fileName.endsWith(".atomic.tmp")) {
              throw new Error("QuotaExceededError");
            }
            const cur = syncFiles.get(fileName)!;
            const at = opts?.at ?? 0;
            const needed = at + buf.byteLength;
            const next = needed > cur.byteLength ? new Uint8Array(needed) : cur.slice();
            if (needed > cur.byteLength) next.set(cur);
            next.set(buf, at);
            syncFiles.set(fileName, next);
            return buf.byteLength;
          },
          truncate: (sz: number) => {
            const cur = syncFiles.get(fileName)!;
            const next = new Uint8Array(sz);
            next.set(cur.subarray(0, Math.min(sz, cur.byteLength)));
            syncFiles.set(fileName, next);
          },
          flush: () => {},
          close: () => {},
        };
      };
      Object.defineProperty(globalThis, "navigator", {
        value: {
          storage: {
            getDirectory: async () => ({
              getFileHandle: async (name: string) => ({
                createSyncAccessHandle: async () => makeSyncHandle(name),
              }),
              removeEntry: async (name: string) => {
                syncFiles.delete(name);
              },
            }),
          },
        },
        configurable: true,
        writable: true,
      });

      const opfsSync = new OpfsStorage("sync_atomic_test");
      const dbSync = await WebDB.open({
        storage: opfsSync,
        engine: testEngine(),
        crossTabSync: false,
      });
      await dbSync.createTable("k", [{ name: "id", type: "INT32", primaryKey: true }]);
      await dbSync.insert("k", { id: 1 });
      await dbSync.checkpoint();
      const liveDbBefore = syncFiles.get("sync_atomic_test.db")!.slice();
      const liveWalBefore = syncFiles.get("sync_atomic_test.wal")!.slice();

      failTmpWrite = true;
      await expect(
        opfsSync.replaceDatabaseAtomic(
          [{ pageId: 1, data: new Uint8Array(PAGE_SIZE).fill(9) }],
          new Uint8Array(32).fill(7),
        ),
      ).rejects.toThrow("QuotaExceededError");
      expect(syncFiles.get("sync_atomic_test.db")).toEqual(liveDbBefore);
      expect(syncFiles.get("sync_atomic_test.wal")).toEqual(liveWalBefore);
      expect(syncFiles.has("sync_atomic_test.db.atomic.tmp")).toBe(false);
      await dbSync.close();

      // 2b. Async createWritable aborts cleanly on error
      delete (globalThis as any).FileSystemSyncAccessHandle;
      const asyncFiles = new Map<string, Uint8Array>();
      let abortedCount = 0;
      Object.defineProperty(globalThis, "navigator", {
        value: {
          storage: {
            getDirectory: async () => ({
              getFileHandle: async (name: string) => ({
                getFile: async () => ({
                  size: (asyncFiles.get(name) ?? new Uint8Array(0)).byteLength,
                  slice: (s: number, e: number) => ({
                    arrayBuffer: async () =>
                      (asyncFiles.get(name) ?? new Uint8Array(0)).slice(s, e).buffer,
                  }),
                }),
                createWritable: async () => ({
                  write: async () => {
                    throw new Error("AsyncWriteFail");
                  },
                  close: async () => {},
                  abort: async () => {
                    abortedCount++;
                  },
                }),
              }),
            }),
          },
        },
        configurable: true,
        writable: true,
      });
      const opfsAsync = new OpfsStorage("async_atomic_test");
      await expect(
        opfsAsync.replaceDatabaseAtomic(
          [{ pageId: 1, data: new Uint8Array(PAGE_SIZE) }],
          new Uint8Array(32),
        ),
      ).rejects.toThrow("AsyncWriteFail");
      expect(abortedCount).toBe(1);
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        value: prevNav,
        configurable: true,
        writable: true,
      });
      if (prevSyncClass === undefined) {
        delete (globalThis as any).FileSystemSyncAccessHandle;
      } else {
        (globalThis as any).FileSystemSyncAccessHandle = prevSyncClass;
      }
    }
  });
});
