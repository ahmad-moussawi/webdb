import { describe, it, expect } from "vitest";
import {
  WebDB,
  MemoryVfsAdapter,
  PAGE_SIZE,
  MAX_ROW_SIZE,
  PAGE_TYPE_LEAF_DATA,
  PAGE_TYPE_CATALOG_PAGE,
  PAGE_TYPE_FREE,
  DataType,
  ColumnFlag,
  TableMeta,
  createWasmMemory,
  createWasmCore,
} from "../src/index.ts";
import * as jsCore from "../src/core/js/index.ts";
import {
  page_init,
  page_insert_row,
  page_get_cell_offset,
  page_serialize_row,
  page_deserialize_row,
  page_get_type,
  page_get_next_page_id,
} from "../src/core/index.ts";

describe("Cross-linked leaf data pages, bounds validation & addColumn rebuild safety", () => {
  it("1. reproduces RangeError in _rebuildTableSchemaInternal when two tables share a tail leaf page", async () => {
    const db = await WebDB.open({
      name: "repro_cross_link",
      storage: "memory",
    });

    // 1. Create Table A (with FLOAT64 + TEXT columns, like inventory_transactions)
    await db.createTable("inventory_transactions", [
      {
        name: "id",
        type: "INT32",
        flags: { primaryKey: true, autoInc: true, notNull: true },
      },
      { name: "tx_no", type: "TEXT", flags: { notNull: true } },
      { name: "quantity", type: "FLOAT64", flags: { notNull: true } },
      { name: "unit_cost", type: "FLOAT64", flags: { notNull: true } },
      { name: "created_at", type: "TEXT" },
    ]);

    // 2. Create Table B (all TEXT columns, like audit_logs)
    await db.createTable("audit_logs", [
      { name: "id", type: "TEXT", flags: { primaryKey: true, notNull: true } },
      { name: "action", type: "TEXT", flags: { notNull: true } },
      { name: "table_name", type: "TEXT", flags: { notNull: true } },
      { name: "record_pk", type: "TEXT" },
      { name: "old_values_json", type: "TEXT" },
      { name: "new_values_json", type: "TEXT" },
      { name: "created_at", type: "TEXT" },
    ]);

    // 3. Insert enough rows into inventory_transactions so it allocates a second leaf data page
    for (let i = 1; i <= 40; i++) {
      await db.insert("inventory_transactions", {
        tx_no: `STK-${String(i).padStart(4, "0")}-${"X".repeat(80)}`,
        quantity: 1.5,
        unit_cost: 29.99,
        created_at: "2026-11-06 14:41:33",
      });
    }

    await db.insert("audit_logs", {
      id: "01M6RMXJGJYPMW3C1QPYZCV1DB",
      action: "insert",
      table_name: "orders",
      record_pk: "1",
      old_values_json: null,
      new_values_json: '{"order_no":"ORD-1005"}',
      created_at: "2026-11-06 14:41:33",
    });

    // Find inventory_transactions's second leaf page (the equivalent of Page 118)
    const invMeta = await db.getTable("inventory_transactions");
    const auditMeta = await db.getTable("audit_logs");
    const anyDb = db as any;

    const invRootSlot = await anyDb.driver.acquirePage(invMeta.rootPageId);
    const sharedLeafPageId = anyDb.pool
      .getSlotDataView(invRootSlot)
      .getUint32(6, true);
    expect(sharedLeafPageId).toBeGreaterThan(1);

    // Simulate the cross-link in broken.cub.gz: audit_logs tail page also points nextPageId -> sharedLeafPageId
    const auditRootSlot = await anyDb.driver.acquirePage(auditMeta.rootPageId);
    anyDb.pool
      .getSlotDataView(auditRootSlot)
      .setUint32(6, sharedLeafPageId, true);
    anyDb.pool.markDirty(auditRootSlot);

    // 4. Querying audit_logs BEFORE migration should not read 30KB across adjacent buffer pool slots
    const auditRowsBefore = await db.from("audit_logs").toArray();
    for (const r of auditRowsBefore) {
      expect(String(r.new_values_json ?? "").length).toBeLessThan(2048);
    }

    // Also test VM WHERE filter and projection on TEXT columns across the cross-linked page
    const filteredBefore = await db
      .from("audit_logs")
      .where("action", "=", "insert")
      .select("id", "new_values_json")
      .toArray();
    expect(filteredBefore).toHaveLength(1);
    expect(filteredBefore[0].id).toBe("01M6RMXJGJYPMW3C1QPYZCV1DB");

    // 5. Run migration: addColumn('updated_at') on both tables inside a transaction
    await db.transaction(async (tx) => {
      await tx.addColumn("inventory_transactions", {
        name: "updated_at",
        type: "TEXT",
      });
      await tx.addColumn("audit_logs", { name: "updated_at", type: "TEXT" });
    });

    // Verify both tables survived migration and contain their expected rows
    const invRowsAfter = await db.from("inventory_transactions").toArray();
    const auditRowsAfter = await db.from("audit_logs").toArray();
    expect(invRowsAfter.length).toBe(40);
    expect(auditRowsAfter.length).toBe(1);
    expect(auditRowsAfter[0].id).toBe("01M6RMXJGJYPMW3C1QPYZCV1DB");
    expect(auditRowsAfter[0].updated_at).toBeNull();

    // Verify inventory_transactions's new column catalog page is intact and still pinned
    const invMetaAfter = await db.getTable("inventory_transactions");
    const catSlot = await anyDb.driver.acquirePage(
      invMetaAfter.colCatalogPageId,
    );
    const catView = anyDb.pool.getSlotDataView(catSlot);
    expect(page_get_type(catView, 0)).toBe(PAGE_TYPE_CATALOG_PAGE);
    expect(anyDb.pool.isSlotPinned(catSlot)).toBe(true);

    await db.close();
  });

  it('2. serializes concurrent autocommit writes triggered from subscribe("*") and Promise.all without cross-linking pages', async () => {
    const vfs = new MemoryVfsAdapter();
    const db = await WebDB.open({
      name: "concurrent_autocommit_sub",
      vfs,
    });

    await db.createTable("orders", [
      { name: "id", type: "INT32", primaryKey: true, autoInc: true },
      { name: "order_no", type: "TEXT", notNull: true },
    ]);
    await db.createTable("items", [
      { name: "id", type: "INT32", primaryKey: true },
      { name: "stock", type: "FLOAT64", notNull: true },
    ]);
    await db.createTable("inventory_transactions", [
      { name: "id", type: "INT32", primaryKey: true, autoInc: true },
      { name: "tx_no", type: "TEXT", notNull: true },
      { name: "quantity", type: "FLOAT64", notNull: true },
      { name: "unit_cost", type: "FLOAT64", notNull: true },
      { name: "notes", type: "TEXT" },
    ]);
    await db.createTable("audit_logs", [
      { name: "id", type: "TEXT", primaryKey: true, notNull: true },
      { name: "action", type: "TEXT", notNull: true },
      { name: "table_name", type: "TEXT", notNull: true },
      { name: "payload", type: "TEXT" },
    ]);

    await db.insert("items", { id: 1, stock: 1000 });

    const pendingAuditWrites: Promise<unknown>[] = [];
    let auditCounter = 0;

    // Subscribe listener that fires unawaited autocommit writes synchronously when orders commit
    const unsub = db.subscribe("*", (ev) => {
      if (ev.tables.includes("orders")) {
        const batch = Array.from({ length: 8 }, (_, idx) => ({
          id: `AUD-${++auditCounter}-${idx}-${"A".repeat(40)}`,
          action: "insert",
          table_name: "orders",
          payload: JSON.stringify({ seq: auditCounter, pad: "P".repeat(180) }),
        }));
        pendingAuditWrites.push(db.insertMany("audit_logs", batch));
      }
    });

    // Execute multiple rounds where transaction commit triggers subscribe('*') autocommit writes
    // at the exact same moment the caller fires concurrent autocommit updates & inserts
    for (let round = 1; round <= 10; round++) {
      await db.transaction(async (tx) => {
        await tx.insert("orders", { order_no: `ORD-${round}` });
      });

      const invBatch = Array.from({ length: 8 }, (_, idx) => ({
        tx_no: `TX-${round}-${idx}-${"X".repeat(60)}`,
        quantity: round * 1.25,
        unit_cost: 19.95,
        notes: "N".repeat(160),
      }));

      await Promise.all([
        db.update("items", 1, { stock: 1000 - round }),
        db.insertMany("inventory_transactions", invBatch),
        db.insert("inventory_transactions", {
          tx_no: `TX-SINGLE-${round}-${"S".repeat(60)}`,
          quantity: 1,
          unit_cost: 9.99,
          notes: "M".repeat(160),
        }),
      ]);
    }

    await Promise.all(pendingAuditWrites);
    unsub();

    // Verify no two tables share any data or catalog page IDs
    const anyDb = db as any;
    const tableNames = [
      "orders",
      "items",
      "inventory_transactions",
      "audit_logs",
    ];
    const pageOwner = new Map<number, string>();

    for (const tName of tableNames) {
      const meta = await db.getTable(tName);
      expect(pageOwner.has(meta.colCatalogPageId)).toBe(false);
      pageOwner.set(meta.colCatalogPageId, `${tName}:catalog`);

      let pId = meta.rootPageId;
      const visited = new Set<number>();
      while (pId > 1 && !visited.has(pId)) {
        visited.add(pId);
        expect(pageOwner.get(pId)).toBeUndefined();
        pageOwner.set(pId, `${tName}:data`);
        const slot = await anyDb.driver.acquirePage(pId);
        const view = anyDb.pool.getSlotDataView(slot);
        expect(page_get_type(view, 0)).toBe(PAGE_TYPE_LEAF_DATA);
        pId = page_get_next_page_id(view, 0);
      }
    }

    // Verify row counts
    expect((await db.from("orders").toArray()).length).toBe(10);
    expect((await db.from("inventory_transactions").toArray()).length).toBe(90);
    expect((await db.from("audit_logs").toArray()).length).toBe(80);

    // Run schema migration across all tables
    await db.transaction(async (tx) => {
      for (const tName of tableNames) {
        await tx.addColumn(tName, { name: "updated_at", type: "TEXT" });
      }
    });

    expect((await db.from("inventory_transactions").toArray()).length).toBe(90);
    expect((await db.from("audit_logs").toArray()).length).toBe(80);

    await db.close();
  });

  it("3. prevents freeTableTreePages / dropTable from freeing a cross-linked PAGE_TYPE_CATALOG_PAGE or looping on cycles", async () => {
    const db = await WebDB.open({
      name: "drop_table_catalog_guard",
      storage: "memory",
    });

    await db.createTable("keep_table", [
      { name: "id", type: "INT32", primaryKey: true },
      { name: "name", type: "TEXT", notNull: true },
    ]);
    await db.createTable("victim_table", [
      { name: "id", type: "INT32", primaryKey: true },
      { name: "val", type: "TEXT" },
    ]);

    await db.insert("keep_table", { id: 1, name: "preserved" });
    await db.insert("victim_table", { id: 1, val: "temp" });

    const keepMeta = await db.getTable("keep_table");
    const victimMeta = await db.getTable("victim_table");
    const anyDb = db as any;

    // Cross-link victim_table's root leaf page nextPageId -> keep_table's colCatalogPageId
    const victimRootSlot = await anyDb.driver.acquirePage(
      victimMeta.rootPageId,
    );
    anyDb.pool
      .getSlotDataView(victimRootSlot)
      .setUint32(6, keepMeta.colCatalogPageId, true);
    anyDb.pool.markDirty(victimRootSlot);

    // Dropping victim_table must NOT free or unpin keep_table's catalog page
    await db.dropTable("victim_table");

    const keepCatSlot = await anyDb.driver.acquirePage(
      keepMeta.colCatalogPageId,
    );
    const keepCatView = anyDb.pool.getSlotDataView(keepCatSlot);
    expect(page_get_type(keepCatView, 0)).toBe(PAGE_TYPE_CATALOG_PAGE);
    expect(anyDb.pool.isSlotPinned(keepCatSlot)).toBe(true);

    // keep_table must still work for queries, inserts, and addColumn
    await db.insert("keep_table", { id: 2, name: "still_works" });
    await db.addColumn("keep_table", {
      name: "extra",
      type: "INT32",
      defaultValue: 7,
    });
    const rows = await db.from("keep_table").orderBy("id", "asc").toArray();
    expect(rows).toEqual([
      { id: 1, name: "preserved", extra: 7 },
      { id: 2, name: "still_works", extra: 7 },
    ]);

    await db.close();
  });

  it("4. handles cyclic nextPageId chains gracefully across query, update, delete, createIndex, and addColumn", async () => {
    const db = await WebDB.open({
      name: "cyclic_page_chain_guard",
      storage: "memory",
    });

    await db.createTable("cyclic_tbl", [
      { name: "id", type: "INT32" },
      { name: "label", type: "TEXT" },
    ]);
    await db.insert("cyclic_tbl", { id: 1, label: "row1" });
    await db.insert("cyclic_tbl", { id: 2, label: "row2" });

    const meta = await db.getTable("cyclic_tbl");
    const anyDb = db as any;
    const rootSlot = await anyDb.driver.acquirePage(meta.rootPageId);
    // Create a self-loop: rootPageId.nextPageId -> rootPageId
    anyDb.pool.getSlotDataView(rootSlot).setUint32(6, meta.rootPageId, true);
    anyDb.pool.markDirty(rootSlot);

    // Update, delete, createIndex, and addColumn should terminate without infinite loop
    const updatedCount = await db
      .from("cyclic_tbl")
      .where("id", "=", 1)
      .update({ label: "row1_updated" });
    expect(updatedCount).toBe(1);

    const deletedCount = await db
      .from("cyclic_tbl")
      .where("id", "=", 2)
      .delete();
    expect(deletedCount).toBe(1);

    await db.createIndex("cyclic_tbl", "label");
    await db.addColumn("cyclic_tbl", {
      name: "status",
      type: "TEXT",
      defaultValue: "ok",
    });

    const rows = await db.from("cyclic_tbl").toArray();
    expect(rows).toEqual([{ id: 1, label: "row1_updated", status: "ok" }]);

    await db.close();
  });

  it("5. validates record bounds and rejects corrupt/mismatched cells in page_deserialize_row (JS and WASM parity)", () => {
    const table: TableMeta = {
      tableId: 1,
      flags: 1,
      rootPageId: 2,
      colCatalogPageId: 3,
      columnCount: 3,
      rowCountEstimate: 0,
      autoIncNext: 1n,
      name: "audit_logs",
      columns: [
        {
          type: DataType.TEXT,
          flags: ColumnFlag.PRIMARY_KEY | ColumnFlag.NOT_NULL,
          colOffset: 0,
          name: "id",
        },
        {
          type: DataType.TEXT,
          flags: ColumnFlag.NOT_NULL,
          colOffset: 0,
          name: "action",
        },
        {
          type: DataType.BLOB,
          flags: ColumnFlag.NONE,
          colOffset: 0,
          name: "payload",
        },
      ],
    };

    // Allocate a multi-page buffer (like the buffer pool) to ensure adjacent slot bytes exist
    const mem = createWasmMemory();
    const fullView = new DataView(mem.buffer);
    const page0View = new DataView(mem.buffer, 0, PAGE_SIZE);
    const page1Bytes = new Uint8Array(mem.buffer, PAGE_SIZE, PAGE_SIZE);
    page1Bytes.fill(0x41); // Fill adjacent slot with 'A'

    page_init(page0View, 0, PAGE_TYPE_LEAF_DATA, 0);

    // Case A: Out-of-bounds record_offset (e.g., 25705 from reading ASCII "id" on a catalog page)
    expect(page_deserialize_row(page0View, 25705, table)).toBeNull();
    expect(page_deserialize_row(page0View, -10, table)).toBeNull();
    expect(page_deserialize_row(page0View, PAGE_SIZE - 2, table)).toBeNull();

    // Insert a valid row first
    const validBytes = page_serialize_row(table, {
      id: "row-1",
      action: "insert",
      payload: new Uint8Array([1, 2, 3, 4]),
    });
    const slotIdx = page_insert_row(page0View, 0, validBytes);
    const cellOffset = page_get_cell_offset(page0View, 0, slotIdx);
    expect(page_deserialize_row(page0View, cellOffset, table)).toEqual({
      id: "row-1",
      action: "insert",
      payload: new Uint8Array([1, 2, 3, 4]),
    });

    // Case B: Corrupt var-offset length that tries to read 31KB across adjacent buffer pool slots
    const savedRelOffset = page0View.getUint16(cellOffset + 4, true);
    const savedLen = page0View.getUint16(cellOffset + 6, true);
    page0View.setUint16(cellOffset + 6, 31199, true); // len = 31199 (> record_length and > PAGE_SIZE)
    expect(page_deserialize_row(page0View, cellOffset, table)).toBeNull();

    // Case C: Corrupt rel_offset pointing before the var-offset table (into fixed header)
    page0View.setUint16(cellOffset + 4, 2, true); // rel_offset = 2 (< min_payload_rel_offset)
    page0View.setUint16(cellOffset + 6, 4, true);
    expect(page_deserialize_row(page0View, cellOffset, table)).toBeNull();
    // Restore var-offset entry
    page0View.setUint16(cellOffset + 4, savedRelOffset, true);
    page0View.setUint16(cellOffset + 6, savedLen, true);

    // Case D: Corrupt record_length > MAX_ROW_SIZE
    const savedRecLen = page0View.getUint16(cellOffset + 1, true);
    page0View.setUint16(cellOffset + 1, MAX_ROW_SIZE + 100, true);
    expect(page_deserialize_row(page0View, cellOffset, table)).toBeNull();
    page0View.setUint16(cellOffset + 1, savedRecLen, true);

    // Case E: Inactive record flag (record_flags & 0x01 === 0)
    page0View.setUint8(cellOffset, 0x00);
    expect(page_deserialize_row(page0View, cellOffset, table)).toBeNull();
    page0View.setUint8(cellOffset, 0x01);
  });

  it("6. VM OP_COLUMN_TEXT and OP_COLUMN_BLOB guard against out-of-bounds slices on corrupt cells in both JS and WASM", async () => {
    const db = await WebDB.open({
      name: "vm_corrupt_var_slice_guard",
      storage: "memory",
    });

    await db.createTable("docs", [
      { name: "id", type: "INT32" },
      { name: "title", type: "TEXT" },
      { name: "raw", type: "BLOB" },
    ]);

    await db.insert("docs", {
      id: 1,
      title: "hello",
      raw: new Uint8Array([10, 20, 30]),
    });

    const meta = await db.getTable("docs");
    const anyDb = db as any;
    const slot = await anyDb.driver.acquirePage(meta.rootPageId);
    const view = anyDb.pool.getSlotDataView(slot);
    const cellOffset = page_get_cell_offset(view, 0, 0);

    // Fixed header: 3 bytes + 1 byte null bitmap + 4 bytes (id INT32) = 8 bytes
    // Var-offset table starts at cellOffset + 8:
    // Entry 0 (title): rel_offset at +8, len at +10
    // Entry 1 (raw):   rel_offset at +12, len at +14
    view.setUint16(cellOffset + 10, 30000, true); // Corrupt title len = 30000
    view.setUint16(cellOffset + 14, 30000, true); // Corrupt raw len = 30000

    // Querying via VM projection (SELECT id, title, raw) must not read 30KB across slots
    const projected = await db
      .from("docs")
      .select("id", "title", "raw")
      .toArray();
    expect(projected).toHaveLength(1);
    expect(projected[0].id).toBe(1);
    expect(projected[0].title).toBeNull();
    expect(projected[0].raw).toBeNull();

    await db.close();
  });

  it("7. preserves WAL-committed Page 1 totalPages across syncCrossTabState and subsequent autocommit allocations", async () => {
    const vfs = new MemoryVfsAdapter();
    const db = await WebDB.open({
      name: "wal_page1_total_pages_sync",
      vfs,
    });

    await db.createTable("table_a", [
      { name: "id", type: "INT32", primaryKey: true, autoInc: true },
      { name: "body", type: "TEXT" },
    ]);
    await db.createTable("table_b", [
      { name: "id", type: "INT32", primaryKey: true, autoInc: true },
      { name: "body", type: "TEXT" },
    ]);

    // 1. Inside a transaction, allocate a new leaf page for table_a (commits new totalPages to WAL)
    await db.transaction(async (tx) => {
      for (let i = 0; i < 15; i++) {
        await tx.insert("table_a", { body: `A-${i}-${"X".repeat(300)}` });
      }
    });

    const anyDb = db as any;
    const totalPagesAfterTx = anyDb.pool.getSlotDataView(0).getUint32(12, true);

    // 2. Force syncCrossTabState before checkpointing: must not regress Page 1 totalPages to pre-WAL disk value
    await anyDb.coordinator.syncCrossTabState(true);
    const totalPagesAfterSync = anyDb.pool
      .getSlotDataView(0)
      .getUint32(12, true);
    expect(totalPagesAfterSync).toBe(totalPagesAfterTx);

    // 3. Allocate a new leaf page in table_b via autocommit: must not reuse table_a's newly allocated leaf page
    for (let i = 0; i < 15; i++) {
      await db.insert("table_b", { body: `B-${i}-${"Y".repeat(300)}` });
    }

    const metaA = await db.getTable("table_a");
    const metaB = await db.getTable("table_b");
    const slotA = await anyDb.driver.acquirePage(metaA.rootPageId);
    const nextA = page_get_next_page_id(anyDb.pool.getSlotDataView(slotA), 0);
    const slotB = await anyDb.driver.acquirePage(metaB.rootPageId);
    const nextB = page_get_next_page_id(anyDb.pool.getSlotDataView(slotB), 0);

    expect(nextA).toBeGreaterThan(1);
    expect(nextB).toBeGreaterThan(1);
    expect(nextA).not.toBe(nextB);

    expect((await db.from("table_a").toArray()).length).toBe(15);
    expect((await db.from("table_b").toArray()).length).toBe(15);

    await db.close();
  });

  it("8. VM OP_REWIND, OP_NEXT_ROW, and OP_LAST stop cleanly when encountering a non-leaf page in both JS and WASM", async () => {
    const db = await WebDB.open({
      name: "vm_non_leaf_page_guard",
      storage: "memory",
    });

    await db.createTable("events", [
      { name: "id", type: "INT32", primaryKey: true },
      { name: "kind", type: "TEXT" },
    ]);

    await db.insert("events", { id: 1, kind: "login" });
    await db.insert("events", { id: 2, kind: "logout" });

    const meta = await db.getTable("events");
    const anyDb = db as any;

    // Point events root data page nextPageId -> its own colCatalogPageId (PAGE_TYPE_CATALOG_PAGE = 12)
    const rootSlot = await anyDb.driver.acquirePage(meta.rootPageId);
    anyDb.pool
      .getSlotDataView(rootSlot)
      .setUint32(6, meta.colCatalogPageId, true);
    anyDb.pool.markDirty(rootSlot);

    // Full scan, filtered scan, and ORDER BY DESC must return only the 2 valid leaf rows
    const allRows = await db.from("events").toArray();
    expect(allRows).toEqual([
      { id: 1, kind: "login" },
      { id: 2, kind: "logout" },
    ]);

    const filtered = await db
      .from("events")
      .where("kind", "=", "logout")
      .toArray();
    expect(filtered).toEqual([{ id: 2, kind: "logout" }]);

    const descRows = await db.from("events").orderBy("id", "desc").toArray();
    expect(descRows).toEqual([
      { id: 2, kind: "logout" },
      { id: 1, kind: "login" },
    ]);

    await db.close();
  });

  it("9. dropColumn and alterTable safely unlink cross-linked foreign pages and preserve rows", async () => {
    const db = await WebDB.open({
      name: "drop_column_cross_link_guard",
      storage: "memory",
    });

    await db.createTable("tbl_one", [
      { name: "id", type: "INT32", primaryKey: true, autoInc: true },
      { name: "code", type: "TEXT", notNull: true },
      { name: "amount", type: "FLOAT64", notNull: true },
      { name: "obsolete", type: "TEXT" },
    ]);

    await db.createTable("tbl_two", [
      { name: "id", type: "TEXT", primaryKey: true, notNull: true },
      { name: "title", type: "TEXT", notNull: true },
      { name: "legacy_col", type: "TEXT" },
    ]);

    for (let i = 1; i <= 35; i++) {
      await db.insert("tbl_one", {
        code: `C-${i}-${"Z".repeat(100)}`,
        amount: i * 10.5,
        obsolete: "drop_me",
      });
    }

    await db.insert("tbl_two", {
      id: "ROW-1",
      title: "Keep Me",
      legacy_col: "remove",
    });

    const metaOne = await db.getTable("tbl_one");
    const metaTwo = await db.getTable("tbl_two");
    const anyDb = db as any;

    const slotOne = await anyDb.driver.acquirePage(metaOne.rootPageId);
    const sharedTailPageId = anyDb.pool
      .getSlotDataView(slotOne)
      .getUint32(6, true);
    expect(sharedTailPageId).toBeGreaterThan(1);

    // Cross-link tbl_two's root leaf page nextPageId -> tbl_one's second leaf page
    const slotTwo = await anyDb.driver.acquirePage(metaTwo.rootPageId);
    anyDb.pool.getSlotDataView(slotTwo).setUint32(6, sharedTailPageId, true);
    anyDb.pool.markDirty(slotTwo);

    await db.transaction(async (tx) => {
      await tx.dropColumn("tbl_one", "obsolete");
      await tx.alterTable("tbl_two", {
        type: "dropColumn",
        column: "legacy_col",
      });
      await tx.alterTable("tbl_two", {
        type: "addColumn",
        column: { name: "updated_at", type: "TEXT", defaultValue: "now" },
      });
    });

    const rowsOne = await db.from("tbl_one").toArray();
    const rowsTwo = await db.from("tbl_two").toArray();
    expect(rowsOne).toHaveLength(35);
    expect(rowsTwo).toEqual([
      { id: "ROW-1", title: "Keep Me", updated_at: "now" },
    ]);

    await db.close();
  });
});
