import { describe, it, expect } from "vitest";
import { WebDB } from "../src/host/api/webdb.js";
import { MemoryStorage } from "../src/host/storage/memory.js";
import { JsEngine } from "../src/core/js/entry.js";
import { WasmEngine } from "../src/core/wasm/entry.js";
import {
  INDEX_CATALOG_OFFSET,
  INDEX_DESCRIPTOR_OFFSET_TAIL_PAGE_ID,
  MASTER_TABLE_OFFSET,
  MAX_INDEXES_PAGE1,
  MAX_TABLES_PAGE1,
  PAGE_HEADER_OFFSET_NEXT_PAGE_ID,
  PAGE_HEADER_OFFSET_TYPE,
  PAGE_SIZE,
  PAGE_TYPE_FREE,
  TABLE_DESCRIPTOR_OFFSET_PK_TAIL_PAGE_ID,
  TABLE_DESCRIPTOR_OFFSET_TAIL_PAGE_ID,
} from "../src/constants.js";
import { InvalidDatabaseError } from "../src/types/index.js";
import {
  catalog_update_index_tail_page_by_root,
  catalog_update_page1_checksum,
} from "../src/core/index.js";
import { computePageChecksum } from "../src/host/storage/crc32.js";

class CountingMemoryStorage extends MemoryStorage {
  readCalls = 0;
  readPageIds: number[] = [];

  resetCounters(): void {
    this.readCalls = 0;
    this.readPageIds = [];
  }

  override async readPages(pageIds: number[]): Promise<Array<Uint8Array | null>> {
    this.readCalls += 1;
    for (const id of pageIds) {
      this.readPageIds.push(id);
    }
    return super.readPages(pageIds);
  }
}

function makeEngines() {
  return [
    { label: "JsEngine", create: () => new JsEngine() },
    { label: "WasmEngine", create: () => new WasmEngine() },
  ];
}

function recomputeDataPageChecksum(page: Uint8Array): void {
  const chk = computePageChecksum(page);
  new DataView(page.buffer, page.byteOffset, PAGE_SIZE).setUint32(
    12,
    chk,
    true,
  );
}

describe.each(makeEngines())(
  "Persisted tailPageId on $label",
  ({ create: createEngine }) => {
    it("resolves table heap and secondary index tail in O(1) after cold reopen", async () => {
      const storage = new CountingMemoryStorage();
      const db1 = await WebDB.open({
        name: "tail_heap_idx",
        engine: createEngine(),
        storage,
      });

      await db1.createTable("audit_logs", [
        { name: "id", type: "INT32" },
        { name: "category", type: "TEXT" },
        { name: "payload", type: "TEXT" },
      ]);
      await db1.createIndex("audit_logs", "category", {
        name: "idx_audit_cat",
      });

      // Insert enough rows to allocate >60 data pages and >10 secondary index pages
      const batch: Array<Record<string, any>> = [];
      const filler = "x".repeat(400);
      for (let i = 1; i <= 550; i++) {
        batch.push({
          id: i,
          category: `category_name_${String(i).padStart(4, "0")}_${"k".repeat(70)}`,
          payload: `${i}:${filler}`,
        });
      }
      await db1.insertMany("audit_logs", batch);

      const metaBefore = await db1.getTable("audit_logs");
      const secIdxBefore = metaBefore.indexes?.find(
        (i) => i.name === "idx_audit_cat",
      );
      expect(metaBefore.tailPageId).toBeDefined();
      expect(metaBefore.tailPageId!).toBeGreaterThan(metaBefore.rootPageId + 30);
      expect(secIdxBefore?.tailPageId).toBeDefined();
      expect(secIdxBefore!.tailPageId!).toBeGreaterThan(
        secIdxBefore!.rootPageId + 5,
      );
      await db1.close();

      // Reopen fresh instance on existing storage and measure reads on first insert
      const db2 = await WebDB.open({
        name: "tail_heap_idx",
        engine: createEngine(),
        storage,
      });
      storage.resetCounters();

      await db2.insert("audit_logs", {
        id: 551,
        category: `category_name_0551_${"k".repeat(70)}`,
        payload: `551:${filler}`,
      });

      const pagesRead = storage.readPageIds;
      // Root pages must NOT be read or walked; persisted tails must be jumped to directly
      expect(pagesRead).not.toContain(metaBefore.rootPageId);
      expect(pagesRead).not.toContain(secIdxBefore!.rootPageId);
      expect(pagesRead).toContain(metaBefore.tailPageId);
      expect(pagesRead).toContain(secIdxBefore!.tailPageId);
      expect(pagesRead.length).toBeLessThanOrEqual(4);

      const totalRows = (await db2.from("audit_logs").toArray()).length;
      expect(totalRows).toBe(551);
      await db2.close();
    });

    it("persists heap, PK index, and secondary index tailPageId across multi-page growth & multiple reopens", async () => {
      const storage = new CountingMemoryStorage();
      const db1 = await WebDB.open({
        name: "tail_pk_growth",
        engine: createEngine(),
        storage,
      });

      await db1.createTable("events", [
        { name: "id", type: "INT32", primaryKey: true, flags: { autoInc: true } },
        { name: "tag", type: "TEXT" },
        { name: "body", type: "TEXT" },
      ]);
      await db1.createIndex("events", "tag", { name: "idx_events_tag" });

      const batch1: Array<Record<string, any>> = [];
      for (let i = 1; i <= 400; i++) {
        batch1.push({
          tag: `tag_${String(i).padStart(4, "0")}_${"z".repeat(70)}`,
          body: "b".repeat(450),
        });
      }
      await db1.insertMany("events", batch1);

      const meta1 = await db1.getTable("events");
      const secIdx1 = meta1.indexes!.find((i) => i.name === "idx_events_tag")!;
      expect(meta1.tailPageId).toBeGreaterThan(meta1.rootPageId + 20);
      expect(meta1.pkTailPageId).toBeGreaterThan(meta1.pkRootPageId!);
      expect(secIdx1.tailPageId).toBeGreaterThan(secIdx1.rootPageId);
      await db1.close();

      // Reopen 1: insert one row and verify O(1) tail lookup on data + secondary index
      const db2 = await WebDB.open({
        name: "tail_pk_growth",
        engine: createEngine(),
        storage,
      });
      const meta2 = await db2.getTable("events");
      expect(meta2.tailPageId).toBe(meta1.tailPageId);
      expect(meta2.pkTailPageId).toBe(meta1.pkTailPageId);

      storage.resetCounters();
      await db2.insert("events", {
        tag: `tag_0401_${"z".repeat(70)}`,
        body: "b".repeat(450),
      });
      // Heap root page and non-unique secondary index root page should not be read
      expect(storage.readPageIds).not.toContain(meta1.rootPageId);
      expect(storage.readPageIds).not.toContain(secIdx1.rootPageId);
      expect(storage.readPageIds).toContain(meta1.tailPageId);
      expect(storage.readPageIds).toContain(secIdx1.tailPageId);

      // Grow significantly across new pages
      const batch2: Array<Record<string, any>> = [];
      for (let i = 402; i <= 650; i++) {
        batch2.push({
          tag: `tag_${String(i).padStart(4, "0")}_${"z".repeat(70)}`,
          body: "b".repeat(450),
        });
      }
      await db2.insertMany("events", batch2);
      const metaAfterGrowth = await db2.getTable("events");
      const secIdxAfterGrowth = metaAfterGrowth.indexes!.find(
        (i) => i.name === "idx_events_tag",
      )!;
      expect(metaAfterGrowth.tailPageId!).toBeGreaterThan(meta1.tailPageId!);
      expect(metaAfterGrowth.pkTailPageId!).toBeGreaterThanOrEqual(
        meta1.pkTailPageId!,
      );
      expect(secIdxAfterGrowth.tailPageId!).toBeGreaterThan(
        secIdx1.tailPageId!,
      );
      await db2.close();

      // Reopen 2: verify updated tails are immediately used
      const db3 = await WebDB.open({
        name: "tail_pk_growth",
        engine: createEngine(),
        storage,
      });
      storage.resetCounters();
      await db3.insert("events", {
        tag: `tag_0651_${"z".repeat(70)}`,
        body: "b".repeat(450),
      });
      expect(storage.readPageIds).not.toContain(metaAfterGrowth.rootPageId);
      expect(storage.readPageIds).not.toContain(secIdxAfterGrowth.rootPageId);
      expect(storage.readPageIds).toContain(metaAfterGrowth.tailPageId);
      expect(storage.readPageIds).toContain(secIdxAfterGrowth.tailPageId);
      expect((await db3.from("events").toArray()).length).toBe(651);
      await db3.close();
    });

    it("resolves update overflow relocation tail in O(1) after cold reopen", async () => {
      const storage = new CountingMemoryStorage();
      const db1 = await WebDB.open({
        name: "tail_update_reloc",
        engine: createEngine(),
        storage,
      });

      await db1.createTable("docs", [
        { name: "id", type: "INT32" },
        { name: "note", type: "TEXT" },
      ]);
      // Insert small row #1 onto root page, followed by 350 rows across 35+ pages
      const rows: Array<Record<string, any>> = [{ id: 1, note: "tiny" }];
      for (let i = 2; i <= 360; i++) {
        rows.push({ id: i, note: "p".repeat(400) });
      }
      await db1.insertMany("docs", rows);

      const meta1 = await db1.getTable("docs");
      expect(meta1.tailPageId!).toBeGreaterThan(meta1.rootPageId + 25);
      await db1.close();

      // Reopen and update row #1 (located on rootPageId) with limit: 1 so scan stops on page 1 of table
      // and overflow relocation jumps straight to tailPageId without walking intermediate pages.
      const db2 = await WebDB.open({
        name: "tail_update_reloc",
        engine: createEngine(),
        storage,
      });
      storage.resetCounters();
      const updated = await db2.update(
        "docs",
        { id: 1 },
        { note: "R".repeat(1600) },
        { limit: 1 },
      );
      expect(updated).toBe(1);
      expect(storage.readPageIds).toContain(meta1.rootPageId);
      expect(storage.readPageIds).toContain(meta1.tailPageId);
      expect(storage.readPageIds.length).toBeLessThanOrEqual(4);

      const metaAfterReloc = await db2.getTable("docs");
      expect(metaAfterReloc.tailPageId!).toBeGreaterThanOrEqual(
        meta1.tailPageId!,
      );
      await db2.close();

      const db3 = await WebDB.open({
        name: "tail_update_reloc",
        engine: createEngine(),
        storage,
      });
      storage.resetCounters();
      await db3.insert("docs", { id: 361, note: "tail_check" });
      expect(storage.readPageIds).not.toContain(meta1.rootPageId);
      expect(storage.readPageIds).toContain(metaAfterReloc.tailPageId);
      expect(storage.readPageIds.length).toBeLessThanOrEqual(4);
      const found = await db3.from("docs").where("id", "=", 1).first();
      expect(found?.note).toBe("R".repeat(1600));
      await db3.close();
    });

    it("persists index tailPageId produced during createIndex backfill", async () => {
      const storage = new CountingMemoryStorage();
      const db1 = await WebDB.open({
        name: "tail_backfill",
        engine: createEngine(),
        storage,
      });

      await db1.createTable("logs", [
        { name: "id", type: "INT32" },
        { name: "msg", type: "TEXT" },
      ]);
      const rows: Array<Record<string, any>> = [];
      for (let i = 1; i <= 300; i++) {
        rows.push({
          id: i,
          msg: `message_${String(i).padStart(4, "0")}_${"m".repeat(80)}`,
        });
      }
      await db1.insertMany("logs", rows);

      // Create index after rows already exist so backfill builds multiple index leaf pages
      await db1.createIndex("logs", "msg", { name: "idx_logs_msg" });
      const meta1 = await db1.getTable("logs");
      const idx1 = meta1.indexes!.find((i) => i.name === "idx_logs_msg")!;
      expect(idx1.tailPageId).toBeDefined();
      expect(idx1.tailPageId!).toBeGreaterThan(idx1.rootPageId + 4);
      await db1.close();

      const db2 = await WebDB.open({
        name: "tail_backfill",
        engine: createEngine(),
        storage,
      });
      storage.resetCounters();
      await db2.insert("logs", {
        id: 301,
        msg: `message_0301_${"m".repeat(80)}`,
      });
      expect(storage.readPageIds).not.toContain(meta1.rootPageId);
      expect(storage.readPageIds).not.toContain(idx1.rootPageId);
      expect(storage.readPageIds).toContain(meta1.tailPageId);
      expect(storage.readPageIds).toContain(idx1.tailPageId);
      expect(storage.readPageIds.length).toBeLessThanOrEqual(4);
      await db2.close();
    });

    it("self-heals when legacy Page 1 has zero tailPageId or stale/corrupt pointers", async () => {
      const storage = new CountingMemoryStorage();
      const db1 = await WebDB.open({
        name: "tail_heal",
        engine: createEngine(),
        storage,
      });
      await db1.createTable("items", [
        { name: "id", type: "INT32", primaryKey: true },
        { name: "label", type: "TEXT" },
        { name: "body", type: "TEXT" },
      ]);
      await db1.createIndex("items", "label", { name: "idx_items_label" });

      const rows: Array<Record<string, any>> = [];
      for (let i = 1; i <= 250; i++) {
        rows.push({
          id: i,
          label: `lbl_${String(i).padStart(4, "0")}_${"a".repeat(60)}`,
          body: "v".repeat(400),
        });
      }
      await db1.insertMany("items", rows);
      const trueMeta = await db1.getTable("items");
      const trueSecIdx = trueMeta.indexes!.find(
        (i) => i.name === "idx_items_label",
      )!;
      await db1.close();

      // 1. Simulate pre-fix database by zeroing table tailPageId, pkTailPageId,
      //    and secondary index tailPageId on Page 1
      const [page1Zeroed] = await storage.readPages([1]);
      const view1 = new DataView(
        page1Zeroed!.buffer,
        page1Zeroed!.byteOffset,
        PAGE_SIZE,
      );
      view1.setUint32(
        MASTER_TABLE_OFFSET + TABLE_DESCRIPTOR_OFFSET_TAIL_PAGE_ID,
        0,
        true,
      );
      view1.setUint32(
        MASTER_TABLE_OFFSET + TABLE_DESCRIPTOR_OFFSET_PK_TAIL_PAGE_ID,
        0,
        true,
      );
      view1.setUint32(
        INDEX_CATALOG_OFFSET + INDEX_DESCRIPTOR_OFFSET_TAIL_PAGE_ID,
        0,
        true,
      );
      catalog_update_page1_checksum(view1);
      await storage.writePages([{ pageId: 1, data: page1Zeroed! }]);

      const db2 = await WebDB.open({
        name: "tail_heal",
        engine: createEngine(),
        storage,
      });
      await db2.insert("items", {
        id: 251,
        label: `lbl_0251_${"a".repeat(60)}`,
        body: "v".repeat(400),
      });
      const healedMeta1 = await db2.getTable("items");
      const healedSec1 = healedMeta1.indexes!.find(
        (i) => i.name === "idx_items_label",
      )!;
      expect(healedMeta1.tailPageId).toBeGreaterThanOrEqual(
        trueMeta.tailPageId!,
      );
      expect(healedMeta1.pkTailPageId).toBeGreaterThanOrEqual(
        trueMeta.pkTailPageId!,
      );
      expect(healedSec1.tailPageId).toBeGreaterThanOrEqual(
        trueSecIdx.tailPageId!,
      );
      await db2.close();

      // Verify repaired tails are O(1) on next reopen
      const db3 = await WebDB.open({
        name: "tail_heal",
        engine: createEngine(),
        storage,
      });
      storage.resetCounters();
      await db3.insert("items", {
        id: 252,
        label: `lbl_0252_${"a".repeat(60)}`,
        body: "v".repeat(400),
      });
      expect(storage.readPageIds).not.toContain(trueMeta.rootPageId);
      expect(storage.readPageIds).not.toContain(trueSecIdx.rootPageId);
      expect(storage.readPageIds).toContain(healedMeta1.tailPageId);
      expect(storage.readPageIds).toContain(healedSec1.tailPageId);
      const beforeCorruptMeta = await db3.getTable("items");
      const beforeCorruptSec = beforeCorruptMeta.indexes!.find(
        (i) => i.name === "idx_items_label",
      )!;
      await db3.close();

      // 2. Simulate stale/corrupt pointers: out-of-bounds table tail & wrong-type index tail
      const [page1Corrupt] = await storage.readPages([1]);
      const viewCorrupt = new DataView(
        page1Corrupt!.buffer,
        page1Corrupt!.byteOffset,
        PAGE_SIZE,
      );
      viewCorrupt.setUint32(
        MASTER_TABLE_OFFSET + TABLE_DESCRIPTOR_OFFSET_TAIL_PAGE_ID,
        999999,
        true,
      ); // out-of-bounds
      viewCorrupt.setUint32(
        MASTER_TABLE_OFFSET + TABLE_DESCRIPTOR_OFFSET_PK_TAIL_PAGE_ID,
        trueMeta.rootPageId,
        true,
      ); // wrong type (data page)
      viewCorrupt.setUint32(
        INDEX_CATALOG_OFFSET + INDEX_DESCRIPTOR_OFFSET_TAIL_PAGE_ID,
        trueMeta.rootPageId,
        true,
      ); // wrong type (data page)
      catalog_update_page1_checksum(viewCorrupt);
      await storage.writePages([{ pageId: 1, data: page1Corrupt! }]);

      const db4 = await WebDB.open({
        name: "tail_heal",
        engine: createEngine(),
        storage,
      });
      await db4.insert("items", {
        id: 253,
        label: `lbl_0253_${"a".repeat(60)}`,
        body: "v".repeat(400),
      });
      const healedMeta2 = await db4.getTable("items");
      const healedSec2 = healedMeta2.indexes!.find(
        (i) => i.name === "idx_items_label",
      )!;
      expect(healedMeta2.tailPageId!).toBeGreaterThanOrEqual(
        beforeCorruptMeta.tailPageId!,
      );
      expect(healedMeta2.pkTailPageId!).toBeGreaterThanOrEqual(
        beforeCorruptMeta.pkTailPageId!,
      );
      expect(healedSec2.tailPageId!).toBeGreaterThanOrEqual(
        beforeCorruptSec.tailPageId!,
      );
      expect((await db4.from("items").toArray()).length).toBe(253);
      await db4.close();

      // Verify post-corruption repair is also O(1) on subsequent reopen
      const db5 = await WebDB.open({
        name: "tail_heal",
        engine: createEngine(),
        storage,
      });
      storage.resetCounters();
      await db5.insert("items", {
        id: 254,
        label: `lbl_0254_${"a".repeat(60)}`,
        body: "v".repeat(400),
      });
      expect(storage.readPageIds).not.toContain(trueMeta.rootPageId);
      expect(storage.readPageIds).not.toContain(trueSecIdx.rootPageId);
      expect(storage.readPageIds).toContain(healedMeta2.tailPageId);
      expect(storage.readPageIds).toContain(healedSec2.tailPageId);
      await db5.close();
    });

    it("persists tailPageId for tables and indexes stored on overflow catalog pages", async () => {
      const storage = new CountingMemoryStorage();
      const db1 = await WebDB.open({
        name: "tail_overflow_cat",
        engine: createEngine(),
        storage,
        slotCount: 128,
      });

      // Create >16 tables so table_18 lives on an overflow table catalog page
      for (let t = 1; t <= MAX_TABLES_PAGE1 + 2; t++) {
        await db1.createTable(`t_${t}`, [
          { name: "id", type: "INT32" },
          { name: "val", type: "TEXT" },
        ]);
      }

      // Create >8 indexes so the 10th index lives on an overflow index catalog page
      const targetTable = `t_${MAX_TABLES_PAGE1 + 2}`;
      for (let i = 1; i <= MAX_INDEXES_PAGE1 + 2; i++) {
        const tbl = `t_${i}`;
        await db1.createIndex(tbl, "val", { name: `idx_ov_${i}` });
      }
      await db1.createIndex(targetTable, "val", { name: "idx_ov_target" });

      const rows: Array<Record<string, any>> = [];
      for (let i = 1; i <= 200; i++) {
        rows.push({
          id: i,
          val: `ov_${String(i).padStart(4, "0")}_${"q".repeat(120)}`,
        });
      }
      await db1.insertMany(targetTable, rows);

      const meta1 = await db1.getTable(targetTable);
      const idx1 = meta1.indexes!.find((i) => i.name === "idx_ov_target")!;
      expect(meta1.tailPageId!).toBeGreaterThan(meta1.rootPageId + 5);
      expect(idx1.tailPageId!).toBeGreaterThan(idx1.rootPageId);
      await db1.close();

      // Reopen fresh DB (validates overflow catalog page CRC32 checksums on startup!)
      const db2 = await WebDB.open({
        name: "tail_overflow_cat",
        engine: createEngine(),
        storage,
        slotCount: 128,
      });
      storage.resetCounters();
      await db2.insert(targetTable, {
        id: 201,
        val: `ov_0201_${"q".repeat(120)}`,
      });
      expect(storage.readPageIds).not.toContain(meta1.rootPageId);
      expect(storage.readPageIds).not.toContain(idx1.rootPageId);
      expect(storage.readPageIds).toContain(meta1.tailPageId);
      expect(storage.readPageIds).toContain(idx1.tailPageId);
      expect(storage.readPageIds.length).toBeLessThanOrEqual(4);
      expect((await db2.from(targetTable).toArray()).length).toBe(201);
      await db2.close();
    });

    it("reverts uncommitted tailPageId updates when a transaction rolls back", async () => {
      const storage = new CountingMemoryStorage();
      const db1 = await WebDB.open({
        name: "tail_rollback",
        engine: createEngine(),
        storage,
      });
      await db1.createTable("tx_logs", [
        { name: "id", type: "INT32" },
        { name: "msg", type: "TEXT" },
      ]);
      await db1.createIndex("tx_logs", "msg", { name: "idx_tx_msg" });

      await db1.insertMany(
        "tx_logs",
        Array.from({ length: 120 }, (_, i) => ({
          id: i + 1,
          msg: `init_${String(i).padStart(4, "0")}_${"r".repeat(150)}`,
        })),
      );
      const baselineMeta = await db1.getTable("tx_logs");
      const baselineIdx = baselineMeta.indexes!.find(
        (i) => i.name === "idx_tx_msg",
      )!;
      await db1.close();

      const db2 = await WebDB.open({
        name: "tail_rollback",
        engine: createEngine(),
        storage,
      });
      await expect(
        db2.transaction(async (tx) => {
          await tx.insertMany(
            "tx_logs",
            Array.from({ length: 150 }, (_, i) => ({
              id: 1000 + i,
              msg: `aborted_${String(i).padStart(4, "0")}_${"r".repeat(150)}`,
            })),
          );
          throw new Error("Force rollback");
        }),
      ).rejects.toThrow("Force rollback");

      const afterRollbackMeta = await db2.getTable("tx_logs");
      const afterRollbackIdx = afterRollbackMeta.indexes!.find(
        (i) => i.name === "idx_tx_msg",
      )!;
      expect(afterRollbackMeta.tailPageId).toBe(baselineMeta.tailPageId);
      expect(afterRollbackIdx.tailPageId).toBe(baselineIdx.tailPageId);
      await db2.close();

      // Reopen after rollback and verify subsequent insert works in O(1)
      const db3 = await WebDB.open({
        name: "tail_rollback",
        engine: createEngine(),
        storage,
      });
      storage.resetCounters();
      await db3.insert("tx_logs", {
        id: 121,
        msg: `commit_121_${"r".repeat(150)}`,
      });
      expect(storage.readPageIds).not.toContain(baselineMeta.rootPageId);
      expect(storage.readPageIds).not.toContain(baselineIdx.rootPageId);
      expect(storage.readPageIds).toContain(baselineMeta.tailPageId);
      expect(storage.readPageIds).toContain(baselineIdx.tailPageId);
      expect(storage.readPageIds.length).toBeLessThanOrEqual(4);
      expect((await db3.from("tx_logs").toArray()).length).toBe(121);
      await db3.close();
    });

    it("preserves tailPageId across exportBinary and importBinary", async () => {
      const storage1 = new MemoryStorage();
      const db1 = await WebDB.open({
        name: "tail_export",
        engine: createEngine(),
        storage: storage1,
      });
      await db1.createTable("archive", [
        { name: "id", type: "INT32" },
        { name: "note", type: "TEXT" },
      ]);
      await db1.createIndex("archive", "note", { name: "idx_archive_note" });
      await db1.insertMany(
        "archive",
        Array.from({ length: 240 }, (_, i) => ({
          id: i + 1,
          note: `row_${String(i).padStart(4, "0")}_${"x".repeat(250)}`,
        })),
      );
      const srcMeta = await db1.getTable("archive");
      const srcIdx = srcMeta.indexes!.find(
        (i) => i.name === "idx_archive_note",
      )!;
      const exported = await db1.exportBinary();
      await db1.close();

      const countingStorage = new CountingMemoryStorage();
      const db2 = await WebDB.open({
        name: "tail_import",
        engine: createEngine(),
        storage: countingStorage,
        initialData: exported,
      });
      countingStorage.resetCounters();
      await db2.insert("archive", {
        id: 241,
        note: `row_0241_${"x".repeat(250)}`,
      });
      expect(countingStorage.readPageIds).not.toContain(srcMeta.rootPageId);
      expect(countingStorage.readPageIds).not.toContain(srcIdx.rootPageId);
      expect(countingStorage.readPageIds).toContain(srcMeta.tailPageId);
      expect(countingStorage.readPageIds).toContain(srcIdx.tailPageId);
      expect(countingStorage.readPageIds.length).toBeLessThanOrEqual(4);
      expect((await db2.from("archive").toArray()).length).toBe(241);
      await db2.close();
    });

    it("persists tailPageId on case-insensitive DML after cache warm-up", async () => {
      const storage = new CountingMemoryStorage();
      const db1 = await WebDB.open({
        name: "tail_case_dml",
        engine: createEngine(),
        storage,
      });
      await db1.createTable("UserLogs", [
        { name: "id", type: "INT32", primaryKey: true, flags: { autoInc: true } },
        { name: "kind", type: "TEXT" },
        { name: "note", type: "TEXT" },
      ]);
      await db1.createIndex("UserLogs", "kind", { name: "idx_userlogs_kind" });
      await db1.getTable("UserLogs"); // warm tableMetaCache

      // Insert using different casing ("USERLOGS") across many pages
      await db1.insertMany(
        "USERLOGS",
        Array.from({ length: 180 }, (_, i) => ({
          kind: `k_${String(i).padStart(4, "0")}_${"c".repeat(60)}`,
          note: "n".repeat(400),
        })),
      );
      const afterIns = await db1.getTable("UserLogs");
      const afterInsSec = afterIns.indexes!.find(
        (i) => i.name === "idx_userlogs_kind",
      )!;
      expect(afterIns.tailPageId!).toBeGreaterThan(afterIns.rootPageId + 10);
      expect(afterIns.rowCountEstimate).toBe(180);
      await db1.close();

      // Reopen and verify all persisted counters & tails survived
      const db2 = await WebDB.open({
        name: "tail_case_dml",
        engine: createEngine(),
        storage,
      });
      const reopened = await db2.getTable("UserLogs");
      expect(reopened.tailPageId).toBe(afterIns.tailPageId);
      expect(reopened.pkTailPageId).toBe(afterIns.pkTailPageId);
      expect(reopened.rowCountEstimate).toBe(180);
      expect(
        reopened.indexes!.find((i) => i.name === "idx_userlogs_kind")!.tailPageId,
      ).toBe(afterInsSec.tailPageId);

      // Update overflow relocation using different casing ("userlogs")
      await db2.update(
        "userlogs",
        { id: 1 },
        { note: "U".repeat(1600) },
        { limit: 1 },
      );
      await db2.delete("userlogs", { id: 2 }, { limit: 1 });
      const afterMut = await db2.getTable("UserLogs");
      expect(afterMut.rowCountEstimate).toBe(179);
      await db2.close();

      const db3 = await WebDB.open({
        name: "tail_case_dml",
        engine: createEngine(),
        storage,
      });
      const finalMeta = await db3.getTable("UserLogs");
      expect(finalMeta.tailPageId).toBe(afterMut.tailPageId);
      expect(finalMeta.rowCountEstimate).toBe(179);
      storage.resetCounters();
      await db3.insert("UserLogs", {
        kind: `k_0999_${"c".repeat(60)}`,
        note: "after",
      });
      expect(storage.readPageIds).not.toContain(finalMeta.rootPageId);
      expect(storage.readPageIds).not.toContain(afterInsSec.rootPageId);
      await db3.close();
    });

    it("persists index tailPageId on in-place indexed update and delete cell shifting", async () => {
      const storage = new CountingMemoryStorage();
      const db1 = await WebDB.open({
        name: "tail_idx_mut",
        engine: createEngine(),
        storage,
      });
      await db1.createTable("entries", [
        { name: "id", type: "INT32" },
        { name: "tag", type: "TEXT" },
      ]);
      await db1.createIndex("entries", "tag", { name: "idx_entries_tag" });

      // Populate enough rows to fill multiple index pages
      await db1.insertMany(
        "entries",
        Array.from({ length: 120 }, (_, i) => ({
          id: i + 1,
          tag: `t_${String(i).padStart(4, "0")}_${"p".repeat(120)}`,
        })),
      );
      const beforeMeta = await db1.getTable("entries");
      const beforeIdx = beforeMeta.indexes![0];
      const beforeIdxTailPageId = beforeIdx.tailPageId!;
      expect(beforeIdxTailPageId).toBeGreaterThan(beforeIdx.rootPageId);

      // In-place update of indexed column enough times to allocate a new index leaf page
      for (let i = 1; i <= 40; i++) {
        await db1.update(
          "entries",
          { id: i },
          { tag: `upd_${String(i).padStart(4, "0")}_${"u".repeat(120)}` },
          { limit: 1 },
        );
      }
      const afterUpdMeta = await db1.getTable("entries");
      const afterUpdIdx = afterUpdMeta.indexes![0];
      const afterUpdIdxTailPageId = afterUpdIdx.tailPageId!;
      expect(afterUpdIdxTailPageId).toBeGreaterThan(beforeIdxTailPageId);
      await db1.close();

      // Reopen, delete first row to trigger cell-shifting + index re-insertion on delete
      const db2 = await WebDB.open({
        name: "tail_idx_mut",
        engine: createEngine(),
        storage,
      });
      for (let i = 1; i <= 35; i++) {
        await db2.delete("entries", { id: i }, { limit: 1 });
      }
      const afterDelMeta = await db2.getTable("entries");
      const afterDelIdx = afterDelMeta.indexes![0];
      expect(afterDelIdx.tailPageId!).toBeGreaterThanOrEqual(
        afterUpdIdxTailPageId,
      );
      await db2.close();

      // Cold reopen should use the latest index tail in O(1)
      const db3 = await WebDB.open({
        name: "tail_idx_mut",
        engine: createEngine(),
        storage,
      });
      storage.resetCounters();
      await db3.insert("entries", {
        id: 999,
        tag: `final_999_${"z".repeat(120)}`,
      });
      expect(storage.readPageIds).not.toContain(afterDelIdx.rootPageId);
      expect(storage.readPageIds).toContain(afterDelIdx.tailPageId);
      await db3.close();
    });

    it("preserves and updates tailPageId across renameTable, dropColumn rebuild, and dropIndex on PK", async () => {
      const storage = new CountingMemoryStorage();
      const db1 = await WebDB.open({
        name: "tail_ddl_ops",
        engine: createEngine(),
        storage,
      });
      await db1.createTable("old_tbl", [
        { name: "id", type: "INT32", primaryKey: true, flags: { autoInc: true } },
        { name: "keep_col", type: "TEXT" },
        { name: "drop_me", type: "TEXT" },
      ]);
      await db1.createIndex("old_tbl", "keep_col", { name: "idx_keep_col" });
      await db1.insertMany(
        "old_tbl",
        Array.from({ length: 120 }, (_, i) => ({
          keep_col: `keep_${String(i).padStart(4, "0")}_${"k".repeat(100)}`,
          drop_me: "d".repeat(250),
        })),
      );
      await db1.renameTable("old_tbl", "new_tbl");
      const renamedMeta = await db1.getTable("new_tbl");
      expect(renamedMeta.tailPageId!).toBeGreaterThan(renamedMeta.rootPageId);

      // Rebuild via dropColumn -> recomputes tail pointers cleanly (freed pages may be recycled in any order)
      const rebuiltMeta = await db1.dropColumn("new_tbl", "drop_me");
      expect(rebuiltMeta.tailPageId!).toBeGreaterThanOrEqual(2);
      expect(rebuiltMeta.tailPageId).not.toBe(rebuiltMeta.rootPageId);
      expect(rebuiltMeta.pkTailPageId!).toBeGreaterThanOrEqual(2);
      const rebuiltSecIdx = rebuiltMeta.indexes!.find(
        (i) => i.name === "idx_keep_col",
      )!;
      expect(rebuiltSecIdx.tailPageId!).toBeGreaterThanOrEqual(2);
      expect(rebuiltSecIdx.tailPageId).not.toBe(rebuiltSecIdx.rootPageId);

      // Drop embedded primary key index -> clears pkRootPageId and pkTailPageId on disk
      await db1.dropIndex("pk_new_tbl");
      await db1.close();

      const db2 = await WebDB.open({
        name: "tail_ddl_ops",
        engine: createEngine(),
        storage,
      });
      const reloaded = await db2.getTable("new_tbl");
      expect(reloaded.pkRootPageId).toBeUndefined();
      expect(reloaded.pkTailPageId).toBeUndefined();
      expect(reloaded.tailPageId).toBe(rebuiltMeta.tailPageId);

      storage.resetCounters();
      await db2.insert("new_tbl", {
        id: 500,
        keep_col: `keep_0500_${"k".repeat(100)}`,
      });
      expect(storage.readPageIds).not.toContain(rebuiltMeta.rootPageId);
      expect(storage.readPageIds).not.toContain(rebuiltSecIdx.rootPageId);
      expect(storage.readPageIds).toContain(rebuiltMeta.tailPageId);
      expect(storage.readPageIds).toContain(rebuiltSecIdx.tailPageId);
      await db2.close();
    });

    it("restores tailPageId to nested savepoint on inner rollback & handles overflow catalog rollback", async () => {
      const storage = new CountingMemoryStorage();
      const db1 = await WebDB.open({
        name: "tail_savepoint_ov",
        engine: createEngine(),
        storage,
        slotCount: 128,
      });
      for (let t = 1; t <= MAX_TABLES_PAGE1 + 2; t++) {
        await db1.createTable(`sp_tbl_${t}`, [
          { name: "id", type: "INT32", primaryKey: true },
          { name: "body", type: "TEXT" },
        ]);
      }
      const targetTbl = `sp_tbl_${MAX_TABLES_PAGE1 + 2}`;
      await db1.insertMany(
        targetTbl,
        Array.from({ length: 40 }, (_, i) => ({
          id: i + 1,
          body: "s".repeat(400),
        })),
      );
      const preTxMeta = await db1.getTable(targetTbl);
      await db1.close();

      const db2 = await WebDB.open({
        name: "tail_savepoint_ov",
        engine: createEngine(),
        storage,
        slotCount: 128,
      });
      let outerCommittedTail = 0;
      let outerCommittedPkTail = 0;

      await db2.transaction(async (outerTx) => {
        // Outer tx grows the table & PK index onto new pages
        await outerTx.insertMany(
          targetTbl,
          Array.from({ length: 80 }, (_, i) => ({
            id: 100 + i,
            body: "o".repeat(400),
          })),
        );
        const outerMeta = await outerTx.getTable(targetTbl);
        outerCommittedTail = outerMeta.tailPageId!;
        outerCommittedPkTail = outerMeta.pkTailPageId!;
        expect(outerCommittedTail).toBeGreaterThan(preTxMeta.tailPageId!);

        // Nested savepoint grows further then rolls back
        await expect(
          outerTx.transaction(async (innerTx) => {
            await innerTx.insertMany(
              targetTbl,
              Array.from({ length: 80 }, (_, i) => ({
                id: 1000 + i,
                body: "i".repeat(400),
              })),
            );
            throw new Error("Rollback nested savepoint");
          }),
        ).rejects.toThrow("Rollback nested savepoint");
      });

      const committedMeta = await db2.getTable(targetTbl);
      expect(committedMeta.tailPageId).toBe(outerCommittedTail);
      expect(committedMeta.pkTailPageId).toBe(outerCommittedPkTail);

      // Now also verify overflow table catalog update relocation + PK tail on reopen
      await db2.update(
        targetTbl,
        { id: 1 },
        { body: "R".repeat(1600) },
        { limit: 1 },
      );
      const afterRelocMeta = await db2.getTable(targetTbl);
      await db2.close();

      const db3 = await WebDB.open({
        name: "tail_savepoint_ov",
        engine: createEngine(),
        storage,
        slotCount: 128,
      });
      const reloaded = await db3.getTable(targetTbl);
      expect(reloaded.tailPageId).toBe(afterRelocMeta.tailPageId);
      expect(reloaded.pkTailPageId).toBe(afterRelocMeta.pkTailPageId);
      expect((await db3.from(targetTbl).toArray()).length).toBe(120);
      await db3.close();
    });

    it("repairs free-page tail hints, nextPageId === 1, and cyclic chains on data and index pages", async () => {
      const storage = new CountingMemoryStorage();
      const db1 = await WebDB.open({
        name: "tail_cycles",
        engine: createEngine(),
        storage,
      });
      await db1.createTable("cyclic", [
        { name: "id", type: "INT32", primaryKey: true },
        { name: "val", type: "TEXT" },
      ]);
      await db1.createIndex("cyclic", "val", { name: "idx_cyclic_val" });
      await db1.insertMany(
        "cyclic",
        Array.from({ length: 120 }, (_, i) => ({
          id: i + 1,
          val: `val_${String(i).padStart(4, "0")}_${"y".repeat(90)}`,
        })),
      );
      const meta1 = await db1.getTable("cyclic");
      const secIdx1 = meta1.indexes!.find((i) => i.name === "idx_cyclic_val")!;
      await db1.close();

      // Point table tailPageId to a PAGE_TYPE_FREE page, corrupt data tail's nextPageId to itself (cycle),
      // and corrupt secondary index tail's nextPageId = 1.
      const freePageId = meta1.tailPageId!;
      const [p1, dataRoot, secTail] = await storage.readPages([
        1,
        meta1.rootPageId,
        secIdx1.tailPageId!,
      ]);

      // Create a PAGE_TYPE_FREE page on disk? Even simpler: point tailPageId on Page 1 to a page we mark free
      // Wait - make a copy of a free/scratch page at page 1 + meta1.tailPageId? Let's test free type safely via an unused extra page at tailPageId?
      // Better: walk from dataRoot first by pointing Page 1 tailPageId to a stale FREE page, OR mark a spare page after totalPages? No, must be <= totalPages.
      // Let's inject nextPageId = dataRoot (self-cycle) on data tail and nextPageId = 1 on secIdx tail while setting Page 1 tailPageId = stale rootPageId.
      const secTailView = new DataView(
        secTail!.buffer,
        secTail!.byteOffset,
        PAGE_SIZE,
      );
      secTailView.setUint32(PAGE_HEADER_OFFSET_NEXT_PAGE_ID, 1, true);
      recomputeDataPageChecksum(secTail!);

      // Also introduce a cycle on the true data tail page pointing back to dataRoot
      const [trueDataTail] = await storage.readPages([freePageId]);
      const dataTailView = new DataView(
        trueDataTail!.buffer,
        trueDataTail!.byteOffset,
        PAGE_SIZE,
      );
      dataTailView.setUint32(
        PAGE_HEADER_OFFSET_NEXT_PAGE_ID,
        meta1.rootPageId,
        true,
      );
      recomputeDataPageChecksum(trueDataTail!);

      // Point PK tail hint to a middle/stale page and mark an unreachable free-type check below
      const p1View = new DataView(p1!.buffer, p1!.byteOffset, PAGE_SIZE);
      p1View.setUint32(
        MASTER_TABLE_OFFSET + TABLE_DESCRIPTOR_OFFSET_TAIL_PAGE_ID,
        meta1.rootPageId,
        true,
      );
      catalog_update_page1_checksum(p1View);
      await storage.writePages([
        { pageId: 1, data: p1! },
        { pageId: secIdx1.tailPageId!, data: secTail! },
        { pageId: freePageId, data: trueDataTail! },
      ]);
      void dataRoot;

      const db2 = await WebDB.open({
        name: "tail_cycles",
        engine: createEngine(),
        storage,
      });
      await db2.insert("cyclic", {
        id: 121,
        val: `val_0121_${"y".repeat(90)}`,
      });
      await db2.close();

      // Verify links were repaired on disk (no cycle / nextPageId !== 1)
      const [repairedDataTail, repairedSecTail] = await storage.readPages([
        freePageId,
        secIdx1.tailPageId!,
      ]);
      const repairedNextData = new DataView(
        repairedDataTail!.buffer,
        repairedDataTail!.byteOffset,
        PAGE_SIZE,
      ).getUint32(PAGE_HEADER_OFFSET_NEXT_PAGE_ID, true);
      const repairedNextSec = new DataView(
        repairedSecTail!.buffer,
        repairedSecTail!.byteOffset,
        PAGE_SIZE,
      ).getUint32(PAGE_HEADER_OFFSET_NEXT_PAGE_ID, true);
      expect(repairedNextData).not.toBe(meta1.rootPageId);
      expect(repairedNextSec).not.toBe(1);

      // Also test PAGE_TYPE_FREE tail hint falls back safely (via an orphaned free page allocated & freed by dropTable)
      const db3 = await WebDB.open({
        name: "tail_free_hint",
        engine: createEngine(),
        storage: new CountingMemoryStorage(),
      });
      await db3.createTable("live", [{ name: "id", type: "INT32" }]);
      await db3.createTable("temp", [{ name: "id", type: "INT32" }]);
      const tempMeta = await db3.getTable("temp");
      await db3.dropTable("temp");
      await db3.insert("live", { id: 1 });
      const liveBefore = await db3.getTable("live");
      await db3.close();

      // Reopen after forging Page 1 tailPageId -> freed page (tempMeta.rootPageId, PAGE_TYPE_FREE)
      const st3 = (db3 as any).vfs as CountingMemoryStorage;
      const [fp1, fPage] = await st3.readPages([1, tempMeta.rootPageId]);
      expect(fPage![PAGE_HEADER_OFFSET_TYPE]).toBe(PAGE_TYPE_FREE);
      const fp1View = new DataView(fp1!.buffer, fp1!.byteOffset, PAGE_SIZE);
      fp1View.setUint32(
        MASTER_TABLE_OFFSET + TABLE_DESCRIPTOR_OFFSET_TAIL_PAGE_ID,
        tempMeta.rootPageId,
        true,
      );
      catalog_update_page1_checksum(fp1View);
      await st3.writePages([{ pageId: 1, data: fp1! }]);

      const db3b = await WebDB.open({
        name: "tail_free_hint",
        engine: createEngine(),
        storage: st3,
      });
      await db3b.insert("live", { id: 2 });
      const liveHealed = await db3b.getTable("live");
      expect(liveHealed.tailPageId).toBe(liveBefore.rootPageId);
      expect((await db3b.from("live").toArray()).length).toBe(2);
      await db3b.close();
    });

    it("rejects out-of-bounds or invalid-type tailPageId during importBinary and guards catalog_update_index_tail_page_by_root", async () => {
      const storage = new MemoryStorage();
      const db1 = await WebDB.open({
        name: "tail_import_validate",
        engine: createEngine(),
        storage,
      });
      await db1.createTable("non_pk", [{ name: "id", type: "INT32" }]);
      await db1.insert("non_pk", { id: 1 });
      await db1.createTable("with_pk", [
        { name: "id", type: "INT32", primaryKey: true },
      ]);
      await db1.insert("with_pk", { id: 1 });
      const validImage = await db1.exportBinary();

      // Guard check: catalog_update_index_tail_page_by_root(view, 0, tail) returns 0 and leaves non-PK table untouched
      const page1Copy = validImage.slice(0, PAGE_SIZE);
      const p1View = new DataView(page1Copy.buffer, page1Copy.byteOffset, PAGE_SIZE);
      expect(catalog_update_index_tail_page_by_root(p1View, 0, 2)).toBe(0);
      expect(
        p1View.getUint32(
          MASTER_TABLE_OFFSET + TABLE_DESCRIPTOR_OFFSET_PK_TAIL_PAGE_ID,
          true,
        ),
      ).toBe(0);

      // Corrupt tailPageId out-of-bounds -> rejected
      const oobImage = validImage.slice();
      const oobView = new DataView(oobImage.buffer, oobImage.byteOffset, PAGE_SIZE);
      oobView.setUint32(
        MASTER_TABLE_OFFSET + TABLE_DESCRIPTOR_OFFSET_TAIL_PAGE_ID,
        9999,
        true,
      );
      catalog_update_page1_checksum(oobView);
      await expect(db1.importBinary(oobImage)).rejects.toThrow(
        InvalidDatabaseError,
      );

      // Corrupt pkTailPageId on slot 1 (`with_pk`) to point to a leaf data page -> rejected
      const badTypeImage = validImage.slice();
      const badTypeView = new DataView(
        badTypeImage.buffer,
        badTypeImage.byteOffset,
        PAGE_SIZE,
      );
      badTypeView.setUint32(
        MASTER_TABLE_OFFSET + 128 + TABLE_DESCRIPTOR_OFFSET_PK_TAIL_PAGE_ID,
        2,
        true,
      );
      catalog_update_page1_checksum(badTypeView);
      await expect(db1.importBinary(badTypeImage)).rejects.toThrow(
        InvalidDatabaseError,
      );

      await db1.close();
    });
  },
);
