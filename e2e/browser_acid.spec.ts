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
    import { WebDB } from '/dist/webdb.js';
    window.WebDB = WebDB;
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

test.describe("Real Browser E2E: IndexedDB & OPFS ACID, Crash Recovery & Multi-Tab Concurrency", () => {
  test("1. IndexedDB: Abrupt tab close mid-transaction discards uncommitted writes and spilled WAL frames on reopen", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await attachVirtualOriginServer(context);
    const dbName = `e2e_idb_crash_mid_tx_${Date.now()}`;

    // Open Tab 1
    const tab1 = await context.newPage();
    await tab1.goto(baseUrl);
    await tab1.waitForFunction(() => (window as any).__harnessReady === true);

    // Seed base committed row and start an uncommitted transaction that spills to WAL and hangs
    await tab1.evaluate(async (name) => {
      const WebDB = (window as any).WebDB;
      const db = await WebDB.open({ name, storage: "idb", slotCount: 8 });
      await db.createTable("accounts", [
        { name: "id", type: "INT32", flags: { primaryKey: true } },
        { name: "holder", type: "TEXT" },
        { name: "balance", type: "INT32" },
      ]);
      await db.insert("accounts", { id: 1, holder: "Genesis", balance: 1000 });
      await db.checkpoint();

      // Start a transaction that inserts 40 large rows (spilling FRAME_TX_UNCOMMITTED to IndexedDB wal_frames)
      // and signals window.__midTxReady before hanging forever (simulating crash mid-transaction).
      const pad = "X".repeat(500);
      db.transaction(async (tx: any) => {
        for (let i = 2; i <= 41; i++) {
          await tx.insert("accounts", {
            id: i,
            holder: `Uncommitted_${i}_${pad}`,
            balance: i * 10,
          });
        }
        (window as any).__midTxSpilled = true;
        // Hang indefinitely while transaction is still uncommitted
        await new Promise(() => {});
      });
    }, dbName);

    await tab1.waitForFunction(() => (window as any).__midTxSpilled === true);

    // Abruptly kill Tab 1 mid-transaction!
    await tab1.close({ runBeforeUnload: false });

    // Open Tab 2 on the same origin and open the same IndexedDB database
    const tab2 = await context.newPage();
    await tab2.goto(baseUrl);
    await tab2.waitForFunction(() => (window as any).__harnessReady === true);

    const rowsAfterCrash = await tab2.evaluate(async (name) => {
      const WebDB = (window as any).WebDB;
      const db = await WebDB.open({ name, storage: "idb" });
      const rows = await db.from("accounts").orderBy("id", "asc").toArray();
      await db.close();
      return rows;
    }, dbName);

    // Only Genesis row (#1) must exist; all 40 uncommitted spilled rows must be discarded
    expect(rowsAfterCrash).toEqual([
      { id: 1, holder: "Genesis", balance: 1000 },
    ]);

    await context.close();
  });

  test("2. IndexedDB: Abrupt tab kill right after commit (before checkpoint) replays WAL on next tab open", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await attachVirtualOriginServer(context);
    const dbName = `e2e_idb_uncheckpointed_commit_${Date.now()}`;

    const tab1 = await context.newPage();
    await tab1.goto(baseUrl);
    await tab1.waitForFunction(() => (window as any).__harnessReady === true);

    await tab1.evaluate(async (name) => {
      const WebDB = (window as any).WebDB;
      const db = await WebDB.open({ name, storage: "idb", slotCount: 8 });
      await db.createTable("orders", [
        { name: "id", type: "INT32", flags: { primaryKey: true } },
        { name: "sku", type: "TEXT" },
        { name: "qty", type: "INT32" },
      ]);
      await db.createIndex("orders", "sku", { unique: true });

      await db.transaction(async (tx: any) => {
        for (let i = 1; i <= 25; i++) {
          await tx.insert("orders", { id: i, sku: `SKU_${i}`, qty: i * 2 });
        }
      });

      await db.transaction(async (tx: any) => {
        for (let i = 26; i <= 50; i++) {
          await tx.insert("orders", { id: i, sku: `SKU_${i}`, qty: i * 2 });
        }
      });
      // DO NOT call db.checkpoint() or db.close()!
    }, dbName);

    // Abruptly close Tab 1 before any checkpoint runs
    await tab1.close({ runBeforeUnload: false });

    // Open Tab 2 and verify WAL recovery replays all 50 committed rows and secondary index
    const tab2 = await context.newPage();
    await tab2.goto(baseUrl);
    await tab2.waitForFunction(() => (window as any).__harnessReady === true);

    const result = await tab2.evaluate(async (name) => {
      const WebDB = (window as any).WebDB;
      const db = await WebDB.open({ name, storage: "idb" });
      const all = await db.from("orders").orderBy("id", "asc").toArray();
      const single = await db
        .from("orders")
        .where("sku", "=", "SKU_37")
        .toArray();
      await db.close();
      return { count: all.length, first: all[0], last: all[49], single };
    }, dbName);

    expect(result.count).toBe(50);
    expect(result.first).toEqual({ id: 1, sku: "SKU_1", qty: 2 });
    expect(result.last).toEqual({ id: 50, sku: "SKU_50", qty: 100 });
    expect(result.single).toEqual([{ id: 37, sku: "SKU_37", qty: 74 }]);

    await context.close();
  });

  test("3. Native OPFS: Abrupt tab kill right after commit (before checkpoint) replays WAL from real browser OPFS", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await attachVirtualOriginServer(context);
    const dbName = `e2e_opfs_recovery_${Date.now()}`;

    const tab1 = await context.newPage();
    await tab1.goto(baseUrl);
    await tab1.waitForFunction(() => (window as any).__harnessReady === true);

    await tab1.evaluate(async (name) => {
      const WebDB = (window as any).WebDB;
      const db = await WebDB.open({ name, storage: "opfs" });
      await db.createTable("devices", [
        { name: "id", type: "INT32", flags: { primaryKey: true } },
        { name: "serial", type: "TEXT" },
      ]);

      await db.transaction(async (tx: any) => {
        for (let i = 1; i <= 20; i++) {
          await tx.insert("devices", { id: i, serial: `SN_${1000 + i}` });
        }
      });
      // Leave uncheckpointed in real OPFS .wal file
    }, dbName);

    await tab1.close({ runBeforeUnload: false });

    const tab2 = await context.newPage();
    await tab2.goto(baseUrl);
    await tab2.waitForFunction(() => (window as any).__harnessReady === true);

    const rows = await tab2.evaluate(async (name) => {
      const WebDB = (window as any).WebDB;
      const db = await WebDB.open({ name, storage: "opfs" });
      const res = await db.from("devices").orderBy("id", "asc").toArray();
      await db.close();
      return res;
    }, dbName);

    expect(rows).toHaveLength(20);
    expect(rows[0]).toEqual({ id: 1, serial: "SN_1001" });
    expect(rows[19]).toEqual({ id: 20, serial: "SN_1020" });

    await context.close();
  });

  test("4. Multi-Tab Concurrent Transactions (IndexedDB): Two open tabs concurrently executing transactions on the same database preserve all writes and cache coherency", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await attachVirtualOriginServer(context);
    const dbName = `e2e_idb_multitab_${Date.now()}`;

    // Step 1: Initialize schema in Tab 1
    const tab1 = await context.newPage();
    const tab2 = await context.newPage();
    await Promise.all([tab1.goto(baseUrl), tab2.goto(baseUrl)]);
    await Promise.all([
      tab1.waitForFunction(() => (window as any).__harnessReady === true),
      tab2.waitForFunction(() => (window as any).__harnessReady === true),
    ]);

    await tab1.evaluate(async (name) => {
      const WebDB = (window as any).WebDB;
      const db = await WebDB.open({ name, storage: "idb" });
      await db.createTable("ledger", [
        { name: "id", type: "INT32", flags: { primaryKey: true } },
        { name: "tab", type: "INT32" },
        { name: "amount", type: "INT32" },
      ]);
      await db.checkpoint();
      (window as any).__db = db;
    }, dbName);

    // Step 2: Open the SAME IndexedDB database in Tab 2 while Tab 1 keeps its connection open
    await tab2.evaluate(async (name) => {
      const WebDB = (window as any).WebDB;
      (window as any).__db = await WebDB.open({ name, storage: "idb" });
    }, dbName);

    // Step 3: Both tabs concurrently execute 5 transactions (each inserting 4 rows) simultaneously!
    const [tab1Result, tab2Result] = await Promise.all([
      tab1.evaluate(async () => {
        const db = (window as any).__db;
        for (let txIdx = 0; txIdx < 5; txIdx++) {
          await db.transaction(async (tx: any) => {
            for (let j = 1; j <= 4; j++) {
              const id = 100 + txIdx * 10 + j;
              await tx.insert("ledger", { id, tab: 1, amount: id * 10 });
            }
          });
        }
        return true;
      }),
      tab2.evaluate(async () => {
        const db = (window as any).__db;
        for (let txIdx = 0; txIdx < 5; txIdx++) {
          await db.transaction(async (tx: any) => {
            for (let j = 1; j <= 4; j++) {
              const id = 200 + txIdx * 10 + j;
              await tx.insert("ledger", { id, tab: 2, amount: id * 10 });
            }
          });
        }
        return true;
      }),
    ]);

    expect(tab1Result).toBe(true);
    expect(tab2Result).toBe(true);

    // Step 4: Both Tab 1 and Tab 2 must immediately see all 40 rows (20 from Tab 1 + 20 from Tab 2)
    const tab1Rows = await tab1.evaluate(async () => {
      const db = (window as any).__db;
      return await db.from("ledger").orderBy("id", "asc").toArray();
    });
    const tab2Rows = await tab2.evaluate(async () => {
      const db = (window as any).__db;
      return await db.from("ledger").orderBy("id", "asc").toArray();
    });

    expect(tab1Rows).toHaveLength(40);
    expect(tab2Rows).toHaveLength(40);
    expect(tab1Rows).toEqual(tab2Rows);

    // Step 5: Open a fresh Tab 3 to verify durable state on disk matches
    const tab3 = await context.newPage();
    await tab3.goto(baseUrl);
    await tab3.waitForFunction(() => (window as any).__harnessReady === true);
    const tab3Rows = await tab3.evaluate(async (name) => {
      const WebDB = (window as any).WebDB;
      const db = await WebDB.open({ name, storage: "idb" });
      const rows = await db.from("ledger").orderBy("id", "asc").toArray();
      await db.close();
      return rows;
    }, dbName);

    expect(tab3Rows).toHaveLength(40);
    await context.close();
  });

  test("5. Multi-Tab Crash Recovery Under Contention: Tab 1 crashes mid-transaction while Tab 2 is waiting on the cross-tab lock; Tab 2 recovers and commits cleanly", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await attachVirtualOriginServer(context);
    const dbName = `e2e_idb_multitab_crash_${Date.now()}`;

    const tab1 = await context.newPage();
    const tab2 = await context.newPage();
    await Promise.all([tab1.goto(baseUrl), tab2.goto(baseUrl)]);
    await Promise.all([
      tab1.waitForFunction(() => (window as any).__harnessReady === true),
      tab2.waitForFunction(() => (window as any).__harnessReady === true),
    ]);

    // Initialize table in Tab 1
    await tab1.evaluate(async (name) => {
      const WebDB = (window as any).WebDB;
      const db = await WebDB.open({ name, storage: "idb", slotCount: 8 });
      await db.createTable("transfers", [
        { name: "id", type: "INT32", flags: { primaryKey: true } },
        { name: "source", type: "TEXT" },
      ]);
      await db.insert("transfers", { id: 1, source: "initial_seed" });
      await db.checkpoint();
      (window as any).__db = db;
    }, dbName);

    // Open same DB in Tab 2
    await tab2.evaluate(async (name) => {
      const WebDB = (window as any).WebDB;
      (window as any).__db = await WebDB.open({ name, storage: "idb" });
    }, dbName);

    // Tab 1 starts a transaction, spills 30 uncommitted rows to WAL, and hangs while holding the cross-tab lock
    await tab1.evaluate(async () => {
      const db = (window as any).__db;
      const pad = "Z".repeat(500);
      db.transaction(async (tx: any) => {
        for (let i = 900; i < 930; i++) {
          await tx.insert("transfers", {
            id: i,
            source: `crashed_tab1_${i}_${pad}`,
          });
        }
        (window as any).__tab1HoldingLock = true;
        await new Promise(() => {});
      });
    });

    await tab1.waitForFunction(
      () => (window as any).__tab1HoldingLock === true,
    );

    // While Tab 1 is still holding the lock mid-transaction, Tab 2 starts a transaction (which blocks on navigator.locks)
    const tab2TxPromise = tab2.evaluate(async () => {
      const db = (window as any).__db;
      await db.transaction(async (tx: any) => {
        await tx.insert("transfers", {
          id: 2,
          source: "committed_by_tab2_after_tab1_crash",
        });
        await tx.insert("transfers", {
          id: 3,
          source: "committed_by_tab2_second_row",
        });
      });
      return await db.from("transfers").orderBy("id", "asc").toArray();
    });

    // Give Tab 2 30ms to enqueue on the cross-tab Web Lock, then kill Tab 1 abruptly!
    await new Promise((r) => setTimeout(r, 30));
    await tab1.close({ runBeforeUnload: false });

    // Tab 2 must now acquire the released Web Lock, discard Tab 1's 30 spilled uncommitted rows, and commit its 2 rows!
    const tab2FinalRows = await tab2TxPromise;
    expect(tab2FinalRows).toEqual([
      { id: 1, source: "initial_seed" },
      { id: 2, source: "committed_by_tab2_after_tab1_crash" },
      { id: 3, source: "committed_by_tab2_second_row" },
    ]);

    await context.close();
  });

  test("6. Large Database & Bulk Insert Stress Test (IndexedDB): 1,000-row insertMany + index backfill + abrupt crash recovery", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await attachVirtualOriginServer(context);
    const dbName = `e2e_idb_large_bulk_${Date.now()}`;

    const tab1 = await context.newPage();
    await tab1.goto(baseUrl);
    await tab1.waitForFunction(() => (window as any).__harnessReady === true);

    await tab1.evaluate(async (name) => {
      const WebDB = (window as any).WebDB;
      const db = await WebDB.open({ name, storage: "idb", slotCount: 32 });
      await db.createTable("telemetry", [
        { name: "id", type: "INT32", flags: { primaryKey: true } },
        { name: "device", type: "TEXT" },
        { name: "metric", type: "INT32" },
        { name: "details", type: "TEXT" },
      ]);

      const payload = "M".repeat(300);
      const batch = Array.from({ length: 1000 }, (_, i) => ({
        id: i + 1,
        device: `DEV_${String(i + 1).padStart(4, "0")}`,
        metric: (i + 1) * 3,
        details: `${i + 1}_${payload}`,
      }));

      await db.transaction(async (tx: any) => {
        await tx.insertMany("telemetry", batch);
        await tx.createIndex("telemetry", "device", { unique: true });
      });
      // Do NOT close or checkpoint: leave all 1,000 rows + index in IndexedDB WAL!
    }, dbName);

    // Abruptly close Tab 1
    await tab1.close({ runBeforeUnload: false });

    // Open Tab 2 and verify WAL recovery reconstructs all 1,000 rows and the unique index
    const tab2 = await context.newPage();
    await tab2.goto(baseUrl);
    await tab2.waitForFunction(() => (window as any).__harnessReady === true);

    const verification = await tab2.evaluate(async (name) => {
      const WebDB = (window as any).WebDB;
      const db = await WebDB.open({ name, storage: "idb", slotCount: 32 });
      const all = await db.from("telemetry").orderBy("id", "asc").toArray();
      const lookup = await db
        .from("telemetry")
        .where("device", "=", "DEV_0777")
        .toArray();
      await db.close();
      return {
        total: all.length,
        firstId: all[0]?.id,
        lastId: all[999]?.id,
        lookup,
      };
    }, dbName);

    expect(verification.total).toBe(1000);
    expect(verification.firstId).toBe(1);
    expect(verification.lastId).toBe(1000);
    expect(verification.lookup).toHaveLength(1);
    expect(verification.lookup[0]).toMatchObject({
      id: 777,
      device: "DEV_0777",
      metric: 777 * 3,
    });

    await context.close();
  });

  test("7. Binary Export & Import (IndexedDB -> OPFS & Multi-Tab Cache Coherency) with ALTER TABLE mutations", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await attachVirtualOriginServer(context);
    const idbSourceName = `e2e_export_idb_${Date.now()}`;
    const opfsTargetName = `e2e_import_opfs_${Date.now()}`;
    const multiTabIdbName = `e2e_multitab_import_${Date.now()}`;

    const tab1 = await context.newPage();
    const tab2 = await context.newPage();
    await Promise.all([tab1.goto(baseUrl), tab2.goto(baseUrl)]);
    await Promise.all([
      tab1.waitForFunction(() => (window as any).__harnessReady === true),
      tab2.waitForFunction(() => (window as any).__harnessReady === true),
    ]);

    // 1. In Tab 1: Create IndexedDB database, run ALTER TABLE mutations, export binary image, and import into native OPFS
    const opfsVerification = await tab1.evaluate(
      async ({ srcName, opfsName }) => {
        const WebDB = (window as any).WebDB;
        const srcDb = await WebDB.open({ name: srcName, storage: "idb" });

        await srcDb.createTable("inventory", [
          { name: "id", type: "INT32", primaryKey: true, autoInc: true },
          { name: "old_sku", type: "TEXT", notNull: true },
          { name: "deprecated_col", type: "INT32" },
        ]);
        await srcDb.createIndex("inventory", "old_sku", { unique: true });

        await srcDb.insertMany("inventory", [
          { old_sku: "ITEM-101", deprecated_col: 1 },
          { old_sku: "ITEM-202", deprecated_col: 2 },
        ]);

        // Perform ALTER TABLE mutations before binary export
        await srcDb.renameColumn("inventory", "old_sku", "sku");
        await srcDb.addColumn(
          "inventory",
          { name: "stock", type: "INT32", notNull: true },
          { defaultValue: 50 },
        );
        await srcDb.dropColumn("inventory", "deprecated_col");

        const exportedBytes: Uint8Array = await srcDb.exportBinary();
        (window as any).__exportedBytes = exportedBytes;
        await srcDb.close();

        // Import into a real browser OPFS database and verify persistence across close/reopen
        const opfsDb = await WebDB.open({ name: opfsName, storage: "opfs" });
        await opfsDb.importBinary(exportedBytes);
        await opfsDb.insert("inventory", { sku: "ITEM-303", stock: 120 });
        await opfsDb.close();

        const opfsReopened = await WebDB.open({
          name: opfsName,
          storage: "opfs",
        });
        const rows = await opfsReopened
          .from("inventory")
          .orderBy("id", "asc")
          .toArray();
        await opfsReopened.close();
        return {
          byteLength: exportedBytes.byteLength,
          rows,
        };
      },
      { srcName: idbSourceName, opfsName: opfsTargetName },
    );

    expect(opfsVerification.byteLength % 4096).toBe(0);
    expect(opfsVerification.rows).toEqual([
      { id: 1, sku: "ITEM-101", stock: 50 },
      { id: 2, sku: "ITEM-202", stock: 50 },
      { id: 3, sku: "ITEM-303", stock: 120 },
    ]);

    // 2. Open a shared IndexedDB database in both Tab 1 and Tab 2 with initial seed schema
    await tab1.evaluate(async (name) => {
      const WebDB = (window as any).WebDB;
      const db = await WebDB.open({ name, storage: "idb" });
      await db.createTable("old_table", [
        { name: "id", type: "INT32", primaryKey: true },
      ]);
      await db.insert("old_table", { id: 999 });
      (window as any).__sharedDb = db;
    }, multiTabIdbName);

    const tab2BeforeImport = await tab2.evaluate(async (name) => {
      const WebDB = (window as any).WebDB;
      const db = await WebDB.open({ name, storage: "idb" });
      (window as any).__sharedDb = db;
      return await db.from("old_table").toArray();
    }, multiTabIdbName);
    expect(tab2BeforeImport).toEqual([{ id: 999 }]);

    // Tab 1 imports the binary image into the shared IndexedDB database
    await tab1.evaluate(async () => {
      const db = (window as any).__sharedDb;
      const exportedBytes = (window as any).__exportedBytes;
      await db.importBinary(exportedBytes);
    });

    // Tab 2 queries the shared database and automatically detects the imported schema & rows via cross-tab coherency
    const tab2AfterImport = await tab2.evaluate(async () => {
      const db = (window as any).__sharedDb;
      return await db.from("inventory").orderBy("id", "asc").toArray();
    });
    expect(tab2AfterImport).toEqual([
      { id: 1, sku: "ITEM-101", stock: 50 },
      { id: 2, sku: "ITEM-202", stock: 50 },
    ]);

    await context.close();
  });

  test("8. Sync Primitives: Atomic Outbox (onBeforeCommit), LWW Upsert, and Real-Time Cross-Tab BroadcastChannel Subscriptions", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await attachVirtualOriginServer(context);
    const tab1 = await context.newPage();
    const tab2 = await context.newPage();

    await Promise.all([tab1.goto(baseUrl), tab2.goto(baseUrl)]);
    await Promise.all([
      tab1.waitForFunction(() => (window as any).__harnessReady === true),
      tab2.waitForFunction(() => (window as any).__harnessReady === true),
    ]);

    const dbName = `sync_e2e_${Date.now()}`;

    // 1. Tab 1 initializes schema and registers an atomic outbox hook via onBeforeCommit
    await tab1.evaluate(async (name) => {
      const WebDB = (window as any).WebDB;
      const db = await WebDB.open({ name, storage: "idb" });

      await db.createTable("todos", [
        { name: "id", type: "INT32", primaryKey: true },
        { name: "title", type: "TEXT" },
        { name: "updated_at", type: "INT32" },
      ]);
      await db.createTable("_outbox", [
        { name: "seq", type: "INT32", primaryKey: true, autoInc: true },
        { name: "op", type: "TEXT" },
        { name: "pk", type: "INT32" },
        { name: "title", type: "TEXT" },
      ]);

      db.onBeforeCommit(async (cs: any, tx: any) => {
        if (cs.origin !== "local") return;
        for (const m of cs.coalesced()) {
          await tx.insert("_outbox", {
            op: m.op,
            pk: m.pk,
            title: (m.newRow ?? m.oldRow).title,
          });
        }
      });

      await db.checkpoint();
      (window as any).__syncDb1 = db;
    }, dbName);

    // 2. Tab 2 opens the same IndexedDB database and subscribes to 'todos'
    await tab2.evaluate(async (name) => {
      const WebDB = (window as any).WebDB;
      const db = await WebDB.open({ name, storage: "idb" });
      (window as any).__syncDb2 = db;
      (window as any).__tab2WakeupPromise = new Promise((resolve) => {
        db.subscribe("todos", async (ev: any) => {
          if (ev.crossTab) {
            const todos = await db.from("todos").orderBy("id", "asc").toArray();
            const outbox = await db
              .from("_outbox")
              .orderBy("seq", "asc")
              .toArray();
            resolve({ event: ev, todos, outbox });
          }
        });
      });
    }, dbName);

    // 3. Tab 1 executes a local transaction with insert + update coalescing and insert + delete cancellation
    await tab1.evaluate(async () => {
      const db = (window as any).__syncDb1;
      await db.transaction(
        async (tx: any) => {
          await tx.insert("todos", {
            id: 1,
            title: "Draft 1",
            updated_at: 100,
          });
          await tx.update("todos", 1, {
            title: "Final 1",
            updated_at: 200,
          });
          await tx.insert("todos", {
            id: 2,
            title: "Temporary 2",
            updated_at: 100,
          });
          await tx.delete("todos", 2);
        },
        { origin: "local", meta: { batchId: "b-1" } },
      );
    });

    // 4. Tab 2 immediately wakes up via BroadcastChannel without polling and sees both todos and outbox!
    const tab2Result: any = await tab2.evaluate(async () => {
      return await (window as any).__tab2WakeupPromise;
    });

    expect(tab2Result.event.crossTab).toBe(true);
    expect(tab2Result.event.meta).toEqual({ batchId: "b-1" });
    expect(tab2Result.todos).toEqual([
      { id: 1, title: "Final 1", updated_at: 200 },
    ]);
    expect(tab2Result.outbox).toEqual([
      { seq: 1, op: "insert", pk: 1, title: "Final 1" },
    ]);

    // 5. Tab 1 applies remote LWW upsertMany (stale id=1 ignored, new id=3 inserted, outbox untouched)
    const remoteSyncResult = await tab1.evaluate(async () => {
      const db = (window as any).__syncDb1;
      const stats = await db.upsertMany(
        "todos",
        [
          { id: 1, title: "Stale Remote 1", updated_at: 150 },
          { id: 3, title: "Remote 3", updated_at: 300 },
        ],
        {
          origin: "remote",
          where: (existing: any, incoming: any) =>
            incoming.updated_at > existing.updated_at,
        },
      );
      const todos = await db.from("todos").orderBy("id", "asc").toArray();
      const outbox = await db.from("_outbox").orderBy("seq", "asc").toArray();
      return { stats, todos, outbox };
    });

    expect(remoteSyncResult.stats).toEqual({
      inserted: 1,
      updated: 0,
      ignored: 1,
    });
    expect(remoteSyncResult.todos).toEqual([
      { id: 1, title: "Final 1", updated_at: 200 },
      { id: 3, title: "Remote 3", updated_at: 300 },
    ]);
    expect(remoteSyncResult.outbox).toHaveLength(1);

    await context.close();
  });

  // ============================================================================
  // TEST 9: Catalog Overflow (>16 Tables & >8 Indexes) Across Multi-Tab Sync & WAL Recovery
  // ============================================================================
  test("9. Catalog Overflow (>16 Tables & >8 Secondary Indexes): Multi-Tab Sync & WAL Crash Recovery", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await attachVirtualOriginServer(context);
    const tab1 = await context.newPage();
    const tab2 = await context.newPage();

    await Promise.all([tab1.goto(baseUrl), tab2.goto(baseUrl)]);
    await Promise.all([
      tab1.waitForFunction(() => (window as any).__harnessReady === true),
      tab2.waitForFunction(() => (window as any).__harnessReady === true),
    ]);

    const dbName = `e2e_catalog_overflow_${Date.now()}`;

    // 1. Open the database in both tabs BEFORE overflowing Page 1 catalog limits
    await tab1.evaluate(async (name) => {
      const WebDB = (window as any).WebDB;
      (window as any).__overflowDb1 = await WebDB.open({
        name,
        storage: "idb",
        bufferPoolPages: 256,
      });
    }, dbName);

    await tab2.evaluate(async (name) => {
      const WebDB = (window as any).WebDB;
      (window as any).__overflowDb2 = await WebDB.open({
        name,
        storage: "idb",
        bufferPoolPages: 256,
      });
    }, dbName);

    // 2. In Tab 1, run migrations creating 22 tables (exceeding 16 on Page 1), each with a PK,
    //    plus 14 secondary unique indexes (exceeding 8 on Page 1), and insert rows.
    await tab1.evaluate(async () => {
      const db = (window as any).__overflowDb1;
      await db.transaction(async (tx: any) => {
        for (let t = 1; t <= 22; t++) {
          const tableName = `pos_table_${t}`;
          await tx.createTable(tableName, [
            { name: "id", type: "INT32", primaryKey: true },
            { name: "code", type: "TEXT", maxLength: 32 },
            { name: "amount", type: "INT32" },
          ]);
          if (t <= 14) {
            await tx.createIndex(tableName, ["code"], {
              name: `idx_${tableName}_code`,
              unique: true,
            });
          }
          await tx.insert(tableName, {
            id: t * 10,
            code: `CODE-${t}`,
            amount: t * 100,
          });
        }
      });
    });

    // 3. Verify Tab 2 automatically pins the newly chained table & index overflow catalog pages
    //    via cross-tab invalidation and can query & enforce unique constraints on overflow tables/indexes!
    const tab2Verification = await tab2.evaluate(async () => {
      const db = (window as any).__overflowDb2;
      // Query table #22 (lives on table overflow catalog page) — triggers cross-tab reload & pinning
      const row22 = await db
        .from("pos_table_22")
        .where("id", "=", 220)
        .first();
      const tables = await db.listTables();
      // Query table #14 via secondary index #14 (lives on index overflow catalog page)
      const row14ByIndex = await db
        .from("pos_table_14")
        .where("code", "=", "CODE-14")
        .first();

      let duplicatePkCaught = false;
      try {
        await db.insert("pos_table_22", { id: 220, code: "DUP-PK", amount: 0 });
      } catch {
        duplicatePkCaught = true;
      }

      let duplicateSecIdxCaught = false;
      try {
        await db.insert("pos_table_14", { id: 999, code: "CODE-14", amount: 0 });
      } catch {
        duplicateSecIdxCaught = true;
      }

      return {
        tableCount: tables.length,
        row22,
        row14ByIndex,
        duplicatePkCaught,
        duplicateSecIdxCaught,
      };
    });

    expect(tab2Verification.tableCount).toBe(22);
    expect(tab2Verification.row22).toEqual({
      id: 220,
      code: "CODE-22",
      amount: 2200,
    });
    expect(tab2Verification.row14ByIndex).toEqual({
      id: 140,
      code: "CODE-14",
      amount: 1400,
    });
    expect(tab2Verification.duplicatePkCaught).toBe(true);
    expect(tab2Verification.duplicateSecIdxCaught).toBe(true);

    // 4. Simulate abrupt crash of both tabs without closing DB (testing WAL recovery + catalog overflow re-pinning)
    await tab1.close();
    await tab2.close();

    const tab3 = await context.newPage();
    await tab3.goto(baseUrl);
    await tab3.waitForFunction(() => (window as any).__harnessReady === true);

    const recoveryVerification = await tab3.evaluate(async (name) => {
      const WebDB = (window as any).WebDB;
      const db = await WebDB.open({
        name,
        storage: "idb",
        bufferPoolPages: 256,
      });

      const tables = await db.listTables();
      const idx14 = await db.listIndexes("pos_table_14");
      const idx22 = await db.listIndexes("pos_table_22");
      const row1 = await db
        .from("pos_table_1")
        .where("id", "=", 10)
        .first();
      const row22 = await db
        .from("pos_table_22")
        .where("id", "=", 220)
        .first();
      const row14ByIndex = await db
        .from("pos_table_14")
        .where("code", "=", "CODE-14")
        .first();

      await db.close();
      return {
        tableCount: tables.length,
        idx14Names: idx14.map((i: any) => i.name).sort(),
        idx22Names: idx22.map((i: any) => i.name).sort(),
        row1,
        row22,
        row14ByIndex,
      };
    }, dbName);

    expect(recoveryVerification.tableCount).toBe(22);
    expect(recoveryVerification.idx14Names).toEqual([
      "idx_pos_table_14_code",
      "pk_pos_table_14",
    ]);
    expect(recoveryVerification.idx22Names).toEqual(["pk_pos_table_22"]);
    expect(recoveryVerification.row1).toEqual({
      id: 10,
      code: "CODE-1",
      amount: 100,
    });
    expect(recoveryVerification.row22).toEqual({
      id: 220,
      code: "CODE-22",
      amount: 2200,
    });
    expect(recoveryVerification.row14ByIndex).toEqual({
      id: 140,
      code: "CODE-14",
      amount: 1400,
    });

    await context.close();
  });
});
