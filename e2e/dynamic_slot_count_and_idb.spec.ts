import { test, expect, BrowserContext } from "@playwright/test";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const baseUrl = "http://localhost/harness.html";

async function attachVirtualOriginServer(
  context: BrowserContext,
): Promise<void> {
  await context.route("http://localhost/**", async (route) => {
    const url = new URL(route.request().url());
    const reqPath = url.pathname;

    if (reqPath === "/" || reqPath === "/harness.html") {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>WebDB E2E Harness</title></head>
<body>
  <script type="module">
    import { WebDB, WasmEngine, JsEngine, IdbStorage, OpfsStorage, MemoryStorage, col, fn } from '/dist/webdb.js';
    window.WebDB = WebDB;
    window.WasmEngine = WasmEngine;
    window.JsEngine = JsEngine;
    window.IdbStorage = IdbStorage;
    window.OpfsStorage = OpfsStorage;
    window.MemoryStorage = MemoryStorage;
    window.col = col;
    window.fn = fn;
    window.__harnessReady = true;
  </script>
</body>
</html>`,
      });
      return;
    }

    const filePath = path.join(rootDir, reqPath);
    if (
      !filePath.startsWith(rootDir) ||
      !fs.existsSync(filePath) ||
      !fs.statSync(filePath).isFile()
    ) {
      await route.fulfill({
        status: 404,
        contentType: "text/plain",
        body: `Not Found: ${reqPath}`,
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
      ".js": "application/javascript",
      ".mjs": "application/javascript",
      ".wasm": "application/wasm",
      ".json": "application/json",
      ".html": "text/html",
    };

    await route.fulfill({
      status: 200,
      contentType: mimeMap[ext] || "application/octet-stream",
      body: fs.readFileSync(filePath),
    });
  });
}

test.describe("Real Browser E2E: Dynamic slotCount (> 1024) & IDB Optimizations", () => {
  test("1. WASM + IDB with slotCount: 8192 handles > 1,200 pages without Page 1 / catalog corruption", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await attachVirtualOriginServer(context);
    const dbName = `e2e_wasm_slot8192_${Date.now()}`;

    const page = await context.newPage();
    await page.goto(baseUrl);
    await page.waitForFunction(() => (window as any).__harnessReady === true);

    const result = await page.evaluate(async (name) => {
      const { WebDB, WasmEngine, JsEngine, IdbStorage, OpfsStorage, MemoryStorage, col, fn } = window as any;

      const db = await WebDB.open({
        engine: new WasmEngine(),
        storage: new IdbStorage(name),
        slotCount: 8192,
        crossTabSync: false,
      });

      await db.createTable("items", [
        { name: "id", type: "INT32", primaryKey: true },
        { name: "sku", type: "TEXT", notNull: true },
        { name: "cat", type: "TEXT", notNull: true },
        { name: "payload", type: "TEXT", notNull: true },
      ]);
      await db.createIndex("items", ["sku"], { name: "idx_items_sku" });

      const pad = "P".repeat(3000);
      await db.transaction(async (tx: any) => {
        for (let i = 1; i <= 1200; i++) {
          await tx.insert("items", {
            id: i,
            sku: `SKU-${String(i).padStart(5, "0")}`,
            cat: i % 2 === 0 ? "even" : "odd",
            payload: `item-${i}-${pad}`,
          });
        }
      });

      const totalPages = db.driver.getSlotDataView(0).getUint32(12, true);
      const hit = await db
        .from("items")
        .where(col("sku").eq("SKU-01180"))
        .toArray();
      const grouped = await db
        .from("items")
        .select("cat", fn.count("id").as("cnt"))
        .groupBy("cat")
        .orderBy("cat", "asc")
        .toArray();

      await db.update("items", { id: 1200 }, { sku: "SKU-UPDATED" });
      await db.checkpoint();
      await db.close();

      // Reopen with slotCount: 2048 to verify slotCount-independent persistence
      const reopened = await WebDB.open({
        engine: new WasmEngine(),
        storage: new IdbStorage(name),
        slotCount: 2048,
        crossTabSync: false,
      });
      const updated = await reopened
        .from("items")
        .where(col("sku").eq("SKU-UPDATED"))
        .toArray();
      const totalAfterReopen = await reopened
        .from("items")
        .count("id", "total")
        .toArray();
      await reopened.close();

      return {
        totalPages,
        hitId: hit[0]?.id,
        hitPrefix: (hit[0]?.payload as string)?.slice(0, 10),
        grouped,
        updatedId: updated[0]?.id,
        totalAfterReopen: totalAfterReopen[0]?.total,
      };
    }, dbName);

    expect(result.totalPages).toBeGreaterThan(1100);
    expect(result.hitId).toBe(1180);
    expect(result.hitPrefix).toBe("item-1180-");
    expect(result.grouped).toEqual([
      { cat: "even", cnt: 600 },
      { cat: "odd", cnt: 600 },
    ]);
    expect(result.updatedId).toBe(1200);
    expect(result.totalAfterReopen).toBe(1200);

    await context.close();
  });

  test("2. Real Chromium IDB batches autocommit writes, atomic checkpoints, and respects IdbStorage durability", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await attachVirtualOriginServer(context);
    const dbName = `e2e_idb_tx_counts_${Date.now()}`;

    const page = await context.newPage();
    await page.goto(baseUrl);
    await page.waitForFunction(() => (window as any).__harnessReady === true);

    const metrics = await page.evaluate(async (name) => {
      const { WebDB, WasmEngine, JsEngine, IdbStorage, OpfsStorage, MemoryStorage } = window as any;

      const recorded: Array<{
        stores: string[];
        mode: string | undefined;
        durability: string | undefined;
      }> = [];
      const origTx = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (
        storeNames: any,
        mode?: any,
        options?: any,
      ) {
        const stores =
          typeof storeNames === "string"
            ? [storeNames]
            : Array.from(storeNames);
        recorded.push({
          stores,
          mode,
          durability: options?.durability,
        });
        return origTx.call(this, storeNames, mode, options);
      };

      const db = await WebDB.open({
        engine: new WasmEngine(),
        storage: new IdbStorage(name, { durability: "relaxed" }),
        crossTabSync: false,
      });

      await db.createTable("orders", [
        { name: "id", type: "INT32", primaryKey: true },
        { name: "sku", type: "TEXT", notNull: true },
      ]);
      await db.createIndex("orders", ["sku"], { name: "idx_orders_sku" });

      // Measure autocommit multi-page insert (Page 1 + data leaf + PK index + secondary index)
      recorded.length = 0;
      await db.insert("orders", { id: 1, sku: "A-100" });
      const autocommitWrites = recorded.filter((t) => t.mode === "readwrite");

      // Measure explicit transaction (first tx combines WAL header + frames)
      recorded.length = 0;
      await db.transaction(async (tx: any) => {
        await tx.insert("orders", { id: 2, sku: "B-200" });
        await tx.insert("orders", { id: 3, sku: "C-300" });
      });
      const txWrites = recorded.filter((t) => t.mode === "readwrite");

      // Measure checkpoint (single atomic multi-store tx)
      recorded.length = 0;
      await db.checkpoint();
      const checkpointWrites = recorded.filter((t) => t.mode === "readwrite");

      await db.close();

      // Verify IdbStorage durability: 'strict' passes durability: 'strict'
      const strictDb = await WebDB.open({
        engine: new WasmEngine(),
        storage: new IdbStorage(`${name}_strict`, { durability: "strict" }),
        crossTabSync: false,
      });
      recorded.length = 0;
      await strictDb.createTable("t", [
        { name: "id", type: "INT32", primaryKey: true },
      ]);
      const strictWrites = recorded.filter((t) => t.mode === "readwrite");
      await strictDb.close();

      IDBDatabase.prototype.transaction = origTx;

      return {
        autocommitWrites,
        txWrites,
        checkpointWrites,
        strictDurabilities: strictWrites.map((w) => w.durability),
      };
    }, dbName);

    expect(metrics.autocommitWrites).toHaveLength(1);
    expect(metrics.autocommitWrites[0]).toEqual({
      stores: ["pages"],
      mode: "readwrite",
      durability: "relaxed",
    });

    expect(metrics.txWrites).toHaveLength(1);
    expect(metrics.txWrites[0]).toEqual({
      stores: ["wal_frames", "wal_meta"],
      mode: "readwrite",
      durability: "relaxed",
    });

    expect(metrics.checkpointWrites).toHaveLength(1);
    expect(metrics.checkpointWrites[0]).toEqual({
      stores: ["pages", "wal_frames", "wal_meta"],
      mode: "readwrite",
      durability: "relaxed",
    });

    expect(metrics.strictDurabilities.length).toBeGreaterThan(0);
    expect(metrics.strictDurabilities.every((d) => d === "strict")).toBe(true);

    await context.close();
  });

  test("3. Multi-tab real Chromium Web Locks + readSyncSnapshot with slotCount: 4096 (Tab 1) & 2048 (Tab 2)", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await attachVirtualOriginServer(context);
    const dbName = `e2e_multitab_dyn_slots_${Date.now()}`;

    const tab1 = await context.newPage();
    const tab2 = await context.newPage();
    await Promise.all([tab1.goto(baseUrl), tab2.goto(baseUrl)]);
    await Promise.all([
      tab1.waitForFunction(() => (window as any).__harnessReady === true),
      tab2.waitForFunction(() => (window as any).__harnessReady === true),
    ]);

    // Tab 1 initializes schema with slotCount: 4096 (WASM)
    await tab1.evaluate(async (name) => {
      const { WebDB, WasmEngine, JsEngine, IdbStorage, OpfsStorage, MemoryStorage } = window as any;
      const db = await WebDB.open({
        engine: new WasmEngine(),
        storage: new IdbStorage(name),
        slotCount: 4096,
      });
      await db.createTable("ledger", [
        { name: "id", type: "INT32", primaryKey: true },
        { name: "owner", type: "TEXT", notNull: true },
      ]);
      await db.transaction(async (tx: any) => {
        await tx.insert("ledger", { id: 1, owner: "tab1-init" });
      });
      (window as any).__db = db;
    }, dbName);

    // Tab 2 opens the same DB with slotCount: 2048 (WASM), reads Tab 1's WAL commit, and writes its own tx
    const tab2Result = await tab2.evaluate(async (name) => {
      const { WebDB, WasmEngine, JsEngine, IdbStorage, OpfsStorage, MemoryStorage } = window as any;
      const db = await WebDB.open({
        engine: new WasmEngine(),
        storage: new IdbStorage(name),
        slotCount: 2048,
      });
      const initial = await db.from("ledger").orderBy("id", "asc").toArray();
      await db.transaction(async (tx: any) => {
        await tx.insert("ledger", { id: 2, owner: "tab2-tx" });
      });
      await db.insert("ledger", { id: 3, owner: "tab2-auto" });
      (window as any).__db = db;
      return initial;
    }, dbName);

    expect(tab2Result).toEqual([{ id: 1, owner: "tab1-init" }]);

    // Tab 1 reads back all rows written by Tab 2 via real Web Locks + readSyncSnapshot
    const tab1Final = await tab1.evaluate(async () => {
      const db = (window as any).__db;
      const rows = await db.from("ledger").orderBy("id", "asc").toArray();
      await db.close();
      return rows;
    });

    expect(tab1Final).toEqual([
      { id: 1, owner: "tab1-init" },
      { id: 2, owner: "tab2-tx" },
      { id: 3, owner: "tab2-auto" },
    ]);

    await tab2.evaluate(async () => {
      await (window as any).__db?.close();
    });
    await context.close();
  });

  test("4. Abrupt tab close crash recovery with slotCount: 4096, WASM core, and deferred WAL header", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await attachVirtualOriginServer(context);
    const dbName = `e2e_crash_slot4096_${Date.now()}`;

    const tab1 = await context.newPage();
    await tab1.goto(baseUrl);
    await tab1.waitForFunction(() => (window as any).__harnessReady === true);

    await tab1.evaluate(async (name) => {
      const { WebDB, WasmEngine, JsEngine, IdbStorage, OpfsStorage, MemoryStorage } = window as any;
      const db = await WebDB.open({
        engine: new WasmEngine(),
        storage: new IdbStorage(name),
        slotCount: 4096,
        crossTabSync: false,
      });
      await db.createTable("notes", [
        { name: "id", type: "INT32", primaryKey: true },
        { name: "text", type: "TEXT", notNull: true },
      ]);
      // Commit two explicit transactions + 1 post-tx autocommit write, WITHOUT checkpoint or close
      await db.transaction(async (tx: any) => {
        await tx.insert("notes", { id: 1, text: "committed-1" });
      });
      await db.transaction(async (tx: any) => {
        await tx.insert("notes", { id: 2, text: "committed-2" });
      });
      await db.insert("notes", { id: 3, text: "autocommit-after-tx" });
    }, dbName);

    // Simulate abrupt tab crash
    await tab1.close();

    // Open Tab 2 -> recoverFromWal replays atomically via checkpointAtomic
    const tab2 = await context.newPage();
    await tab2.goto(baseUrl);
    await tab2.waitForFunction(() => (window as any).__harnessReady === true);

    const recovered = await tab2.evaluate(async (name) => {
      const { WebDB, WasmEngine, JsEngine, IdbStorage, OpfsStorage, MemoryStorage } = window as any;
      const db = await WebDB.open({
        engine: new WasmEngine(),
        storage: new IdbStorage(name),
        slotCount: 4096,
        crossTabSync: false,
      });
      const walCount = await db.vfs.getWalFrameCount();
      const rows = await db.from("notes").orderBy("id", "asc").toArray();
      await db.close();
      return { walCount, rows };
    }, dbName);

    expect(recovered.walCount).toBe(0);
    expect(recovered.rows).toEqual([
      { id: 1, text: "committed-1" },
      { id: 2, text: "committed-2" },
      { id: 3, text: "autocommit-after-tx" },
    ]);

    await context.close();
  });

  test("5. Real Chromium IDB: single-tx importBinary(), shrinking truncation, overflow-catalog ORDER BY, and padded columnIndices tie-break sort", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await attachVirtualOriginServer(context);
    const dbName = `e2e_import_edge_${Date.now()}`;

    const page = await context.newPage();
    await page.goto(baseUrl);
    await page.waitForFunction(() => (window as any).__harnessReady === true);

    const res = await page.evaluate(async (name) => {
      const { WebDB, WasmEngine, JsEngine, IdbStorage, OpfsStorage, MemoryStorage } = window as any;

      // 1. Seed a 20-table (>16) DB with >100 pages + single-col index with tie-breakers
      const src = await WebDB.open({
        engine: new WasmEngine(),
        storage: new IdbStorage(`${name}_src`),
        slotCount: 4096,
        crossTabSync: false,
      });

      await src.createTable("events", [
        { name: "id", type: "INT32", primaryKey: true },
        { name: "grp", type: "TEXT", notNull: true },
        { name: "pad", type: "TEXT", notNull: true },
      ]);
      await src.createIndex("events", ["grp"], { name: "idx_events_grp" });

      for (let t = 1; t <= 19; t++) {
        const tName = `entity_${String(t).padStart(2, "0")}`;
        await src.createTable(tName, [
          { name: "id", type: "INT32", primaryKey: true },
          { name: "tag", type: "TEXT", notNull: true },
        ]);
      }
      await src.createIndex("entity_19", ["tag"], { name: "idx_e19_tag" });

      const bigPad = "Z".repeat(2500);
      await src.transaction(async (tx: any) => {
        await tx.insert("events", { id: 30, grp: "a", pad: bigPad });
        await tx.insert("events", { id: 10, grp: "a", pad: bigPad });
        await tx.insert("events", { id: 20, grp: "a", pad: bigPad });
        await tx.insert("events", { id: 5, grp: "b", pad: bigPad });
        await tx.insert("events", { id: 1, grp: "b", pad: bigPad });
        for (let i = 100; i < 200; i++) {
          await tx.insert("events", { id: i, grp: "z", pad: bigPad });
        }
        for (let r = 1; r <= 10; r++) {
          await tx.insert("entity_19", { id: r, tag: `t19-${String(r).padStart(2, "0")}` });
        }
      });

      const largePages = src.driver.getSlotDataView(0).getUint32(12, true);
      const largeBin = await src.exportBinary();
      await src.close();

      // 2. Build a tiny 1-table DB
      const tinySrc = await WebDB.open({
        engine: new WasmEngine(),
        storage: new MemoryStorage(),
      });
      await tinySrc.createTable("fresh", [
        { name: "id", type: "INT32", primaryKey: true },
        { name: "val", type: "TEXT", notNull: true },
      ]);
      await tinySrc.insert("fresh", { id: 1, val: "tiny-seed" });
      const tinyPages = tinySrc.driver.getSlotDataView(0).getUint32(12, true);
      const tinyBin = await tinySrc.exportBinary();
      await tinySrc.close();

      // 3. Import large 20-table DB into tight slotCount: 64 target and count IDB write txs
      const recorded: Array<{ stores: string[]; mode: string }> = [];
      const origTx = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (
        storeNames: any,
        mode?: any,
        options?: any,
      ) {
        const stores =
          typeof storeNames === "string"
            ? [storeNames]
            : Array.from(storeNames);
        recorded.push({ stores, mode });
        return origTx.call(this, storeNames, mode, options);
      };

      const dst = await WebDB.open({
        engine: new WasmEngine(),
        storage: new IdbStorage(`${name}_dst`),
        slotCount: 64,
        crossTabSync: false,
      });

      recorded.length = 0;
      await dst.importBinary(largeBin);
      const importWriteTxs = recorded.filter((t) => t.mode === "readwrite");
      IDBDatabase.prototype.transaction = origTx;

      // Verify padded columnIndices tie-breaker ORDER BY grp ASC, id ASC
      const tied = await dst
        .from("events")
        .where("grp", "IN", ["a", "b"])
        .orderBy("grp", "asc")
        .orderBy("id", "asc")
        .select("id", "grp")
        .toArray();

      // Thrash pool by scanning all 105 overflow rows, then ORDER BY on overflow-catalog table #20
      const allEvents = await dst.from("events").toArray();
      const e19Ordered = await dst
        .from("entity_19")
        .orderBy("tag", "asc")
        .toArray();

      // 4. Shrink target DB by importing tinyBin -> leftover pages > tinyPages must be truncated
      await dst.importBinary(tinyBin);
      const leftover = await dst.vfs.readPages([
        tinyPages + 1,
        Math.floor(largePages / 2),
        largePages,
      ]);

      // Allocate fresh pages reusing old page IDs and reopen cleanly
      await dst.transaction(async (tx: any) => {
        for (let i = 2; i <= 20; i++) {
          await tx.insert("fresh", { id: i, val: `reused-${i}-${bigPad}` });
        }
      });
      await dst.checkpoint();
      await dst.close();

      const reopened = await WebDB.open({
        engine: new WasmEngine(),
        storage: new IdbStorage(`${name}_dst`),
        slotCount: 64,
        crossTabSync: false,
      });
      const freshCount = (await reopened.from("fresh").toArray()).length;
      await reopened.close();

      return {
        largePages,
        importWriteTxCount: importWriteTxs.length,
        importWriteStores: importWriteTxs[0]?.stores,
        tied,
        allEventsCount: allEvents.length,
        e19FirstTag: e19Ordered[0]?.tag,
        e19Count: e19Ordered.length,
        leftover,
        freshCount,
      };
    }, dbName);

    expect(res.largePages).toBeGreaterThan(100);
    expect(res.importWriteTxCount).toBe(1);
    expect(res.importWriteStores).toEqual(["pages", "wal_frames", "wal_meta"]);
    expect(res.tied).toEqual([
      { id: 10, grp: "a" },
      { id: 20, grp: "a" },
      { id: 30, grp: "a" },
      { id: 1, grp: "b" },
      { id: 5, grp: "b" },
    ]);
    expect(res.allEventsCount).toBe(105);
    expect(res.e19Count).toBe(10);
    expect(res.e19FirstTag).toBe("t19-01");
    expect(res.leftover).toEqual([null, null, null]);
    expect(res.freshCount).toBe(20);

    await context.close();
  });

  test("6. Real Chromium IDB: zero-read checkpoint() and multi-tx getAll() WAL crash recovery", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await attachVirtualOriginServer(context);
    const dbName = `e2e_idb_zeroread_cp_${Date.now()}`;

    const tab1 = await context.newPage();
    await tab1.goto(baseUrl);
    await tab1.waitForFunction(() => (window as any).__harnessReady === true);

    const cpMetrics = await tab1.evaluate(async (name) => {
      const { WebDB, WasmEngine, JsEngine, IdbStorage, OpfsStorage, MemoryStorage } = window as any;
      const db = await WebDB.open({
        engine: new WasmEngine(),
        storage: new IdbStorage(name),
        crossTabSync: false,
      });
      await db.createTable("kv", [
        { name: "id", type: "INT32", primaryKey: true },
        { name: "v", type: "TEXT", notNull: true },
      ]);

      await db.transaction(async (tx: any) => {
        await tx.insert("kv", { id: 1, v: "one" });
        await tx.insert("kv", { id: 2, v: "two" });
      });

      const recorded: Array<{ mode: string; stores: string[] }> = [];
      const origTx = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (
        storeNames: any,
        mode?: any,
        options?: any,
      ) {
        const stores =
          typeof storeNames === "string"
            ? [storeNames]
            : Array.from(storeNames);
        recorded.push({ mode, stores });
        return origTx.call(this, storeNames, mode, options);
      };

      await db.checkpoint();
      IDBDatabase.prototype.transaction = origTx;

      // Now commit 15 separate transactions (30+ WAL frames) WITHOUT checkpointing, then crash tab
      for (let i = 3; i <= 17; i++) {
        await db.transaction(async (tx: any) => {
          await tx.insert("kv", { id: i, v: `wal-${i}` });
        });
      }

      return {
        cpReads: recorded.filter((r) => r.mode === "readonly").length,
        cpWrites: recorded.filter((r) => r.mode === "readwrite").length,
      };
    }, dbName);

    expect(cpMetrics.cpReads).toBe(0);
    expect(cpMetrics.cpWrites).toBe(1);

    // Abruptly close Tab 1 without db.close()
    await tab1.close();

    // Tab 2 recovers all 15 uncheckpointed transactions via readWalFrames() (store.getAll()) + checkpointAtomic
    const tab2 = await context.newPage();
    await tab2.goto(baseUrl);
    await tab2.waitForFunction(() => (window as any).__harnessReady === true);

    const recovered = await tab2.evaluate(async (name) => {
      const { WebDB, WasmEngine, JsEngine, IdbStorage, OpfsStorage, MemoryStorage } = window as any;
      const db = await WebDB.open({
        engine: new WasmEngine(),
        storage: new IdbStorage(name),
        crossTabSync: false,
      });
      const rows = await db.from("kv").orderBy("id", "asc").toArray();
      const walCount = await db.vfs.getWalFrameCount();
      await db.close();
      return { count: rows.length, last: rows[rows.length - 1], walCount };
    }, dbName);

    expect(recovered.count).toBe(17);
    expect(recovered.last).toEqual({ id: 17, v: "wal-17" });
    expect(recovered.walCount).toBe(0);

    await context.close();
  });

  test("7. Real Chromium Dedicated Worker OPFS (SyncAccessHandle): coalesced I/O + slotCount: 4096 -> 64 export/import", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await attachVirtualOriginServer(context);
    const dbName = `e2e_opfs_worker_coalesced_${Date.now()}`;

    const page = await context.newPage();
    await page.goto(baseUrl);
    await page.waitForFunction(() => (window as any).__harnessReady === true);

    const workerResult = await page.evaluate(async (name) => {
      const workerCode = `
        import { WebDB, WasmEngine, OpfsStorage, col } from 'http://localhost/dist/webdb.js';

        self.onmessage = async (e) => {
          try {
            const dbName = e.data;
            const db1 = await WebDB.open({
              engine: new WasmEngine(),
              storage: new OpfsStorage(dbName + '_src'),
              slotCount: 4096,
              crossTabSync: false,
            });
            const isSync = db1.vfs.isSynchronous;

            await db1.createTable('docs', [
              { name: 'id', type: 'INT32', primaryKey: true },
              { name: 'code', type: 'TEXT', notNull: true },
              { name: 'body', type: 'TEXT', notNull: true },
            ]);
            await db1.createIndex('docs', ['code'], { name: 'idx_docs_code' });

            const pad = 'W'.repeat(2600);
            await db1.transaction(async (tx) => {
              for (let i = 1; i <= 150; i++) {
                await tx.insert('docs', {
                  id: i,
                  code: 'DOC-' + String(i).padStart(4, '0'),
                  body: 'w-' + i + '-' + pad,
                });
              }
            });

            // Exercises coalesced writePages + readWalFrames + contiguous readPages (exportBinary)
            await db1.checkpoint();
            const db1Count = (await db1.from('docs').toArray()).length;
            const exported = await db1.exportBinary();
            await db1.close();

            // Import into constrained OPFS pool (slotCount: 64)
            const db2 = await WebDB.open({
              engine: new WasmEngine(),
              storage: new OpfsStorage(dbName + '_dst'),
              slotCount: 64,
              crossTabSync: false,
              initialData: exported,
            });
            const db2Initial = (await db2.from('docs').toArray()).length;

            await db2.update('docs', { id: 150 }, { code: 'DOC-UPDATED' });
            await db2.delete('docs', { id: 1 });
            const db2After = (await db2.from('docs').toArray()).length;
            await db2.checkpoint();
            await db2.close();

            const db3 = await WebDB.open({
              engine: new WasmEngine(),
              storage: new OpfsStorage(dbName + '_dst'),
              slotCount: 64,
              crossTabSync: false,
            });
            const count = (await db3.from('docs').toArray()).length;
            const hit = await db3.from('docs').where(col('code').eq('DOC-UPDATED')).toArray();
            await db3.close();

            self.postMessage({
              ok: true,
              isSync,
              db1Count,
              db2Initial,
              db2After,
              count,
              hitId: hit[0]?.id,
              hitPrefix: hit[0]?.body?.slice(0, 6),
            });
          } catch (err) {
            self.postMessage({ ok: false, error: String(err && err.stack || err) });
          }
        };
      `;
      const blob = new Blob([workerCode], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      const worker = new Worker(url, { type: "module" });

      return await new Promise<any>((resolve) => {
        worker.onmessage = (ev) => {
          worker.terminate();
          URL.revokeObjectURL(url);
          resolve(ev.data);
        };
        worker.onerror = (err) => {
          worker.terminate();
          URL.revokeObjectURL(url);
          resolve({ ok: false, error: err.message });
        };
        worker.postMessage(name);
      });
    }, dbName);

    expect(workerResult.ok, workerResult.error).toBe(true);
    expect(workerResult.isSync).toBe(true);
    expect(workerResult.count, JSON.stringify(workerResult)).toBe(149);
    expect(workerResult.hitId).toBe(150);
    expect(workerResult.hitPrefix).toBe("w-150-");

    await context.close();
  });

  test("8. Multi-tab real Chromium BroadcastChannel + importBinary() notifies subscribers for overflow-catalog tables (>16)", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await attachVirtualOriginServer(context);
    const dbName = `e2e_crosstab_import_overflow_${Date.now()}`;

    const tab1 = await context.newPage();
    const tab2 = await context.newPage();
    await Promise.all([tab1.goto(baseUrl), tab2.goto(baseUrl)]);
    await Promise.all([
      tab1.waitForFunction(() => (window as any).__harnessReady === true),
      tab2.waitForFunction(() => (window as any).__harnessReady === true),
    ]);

    // Tab 1 & Tab 2 both open the shared IDB database
    await tab1.evaluate(async (name) => {
      const { WebDB, WasmEngine, JsEngine, IdbStorage, OpfsStorage, MemoryStorage } = window as any;
      (window as any).__db = await WebDB.open({
        engine: new WasmEngine(),
        storage: new IdbStorage(name),
        slotCount: 256,
      });
    }, dbName);

    await tab2.evaluate(async (name) => {
      const { WebDB, WasmEngine, JsEngine, IdbStorage, OpfsStorage, MemoryStorage } = window as any;
      const db = await WebDB.open({
        engine: new WasmEngine(),
        storage: new IdbStorage(name),
        slotCount: 256,
      });
      (window as any).__db = db;
      (window as any).__notified = new Promise<string[]>((resolve) => {
        db.subscribe(["entity_19"], (ev: any) => {
          if (ev.crossTab) {
            resolve(ev.tables);
          }
        });
      });
    }, dbName);

    // Tab 1 builds a 20-table snapshot in memory and imports it into the shared IDB DB
    await tab1.evaluate(async () => {
      const { WebDB, WasmEngine, JsEngine, IdbStorage, OpfsStorage, MemoryStorage } = window as any;
      const tmp = await WebDB.open({
        engine: new WasmEngine(),
        storage: new MemoryStorage(),
      });
      for (let t = 0; t < 20; t++) {
        const tName = `entity_${String(t).padStart(2, "0")}`;
        await tmp.createTable(tName, [
          { name: "id", type: "INT32", primaryKey: true },
          { name: "label", type: "TEXT", notNull: true },
        ]);
      }
      await tmp.insert("entity_19", { id: 1, label: "from-import-overflow" });
      const snap = await tmp.exportBinary();
      await tmp.close();

      await (window as any).__db.importBinary(snap);
    });

    // Tab 2 must receive the cross-tab BroadcastChannel event for entity_19 and read the imported row
    const tab2Res = await tab2.evaluate(async () => {
      const notifiedTables = await (window as any).__notified;
      const rows = await (window as any).__db
        .from("entity_19")
        .orderBy("id", "asc")
        .toArray();
      await (window as any).__db.close();
      return { notifiedTables, rows };
    });

    expect(tab2Res.notifiedTables).toContain("entity_19");
    expect(tab2Res.rows).toEqual([{ id: 1, label: "from-import-overflow" }]);

    await tab1.evaluate(async () => {
      await (window as any).__db?.close();
    });
    await context.close();
  });
});
