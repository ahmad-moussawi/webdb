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
    import { WebDB, col, fn } from '/dist/webdb.js';
    window.WebDB = WebDB;
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
      const { WebDB, col, fn } = window as any;

      const db = await WebDB.open({
        name,
        storage: "idb",
        core: "wasm",
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
        name,
        storage: "idb",
        core: "wasm",
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

  test("2. Real Chromium IDB batches autocommit writes, atomic checkpoints, and respects idbDurability", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await attachVirtualOriginServer(context);
    const dbName = `e2e_idb_tx_counts_${Date.now()}`;

    const page = await context.newPage();
    await page.goto(baseUrl);
    await page.waitForFunction(() => (window as any).__harnessReady === true);

    const metrics = await page.evaluate(async (name) => {
      const { WebDB } = window as any;

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
        name,
        storage: "idb",
        core: "wasm",
        idbDurability: "relaxed",
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

      // Verify idbDurability: 'strict' passes durability: 'strict'
      const strictDb = await WebDB.open({
        name: `${name}_strict`,
        storage: "idb",
        core: "wasm",
        idbDurability: "strict",
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
      const { WebDB } = window as any;
      const db = await WebDB.open({
        name,
        storage: "idb",
        core: "wasm",
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
      const { WebDB } = window as any;
      const db = await WebDB.open({
        name,
        storage: "idb",
        core: "wasm",
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
      const { WebDB } = window as any;
      const db = await WebDB.open({
        name,
        storage: "idb",
        core: "wasm",
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
      const { WebDB } = window as any;
      const db = await WebDB.open({
        name,
        storage: "idb",
        core: "wasm",
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
});
