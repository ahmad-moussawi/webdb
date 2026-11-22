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
<head><meta charset="utf-8"><title>WebDB DB-Grade E2E Harness</title></head>
<body>
  <script type="module">
    import { WebDB, WasmEngine, JsEngine, IdbStorage, OpfsStorage, MemoryStorage } from '/dist/webdb.js';
    import { Migrator } from '/dist/migrations.js';
        window.WebDB = WebDB;
    window.WasmEngine = WasmEngine;
    window.JsEngine = JsEngine;
    window.IdbStorage = IdbStorage;
    window.OpfsStorage = OpfsStorage;
    window.MemoryStorage = MemoryStorage;
    window.Migrator = Migrator;
    window.__harnessReady = true;
  </script>
</body>
</html>`,
      });
      return;
    }

    if (reqPath === "/opfs-worker.js") {
      await route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: `
import { WebDB, WasmEngine, OpfsStorage } from '/dist/webdb.js';

self.onmessage = async (ev) => {
  const { id, action, dbName, payload } = ev.data;
  try {
    if (action === 'write_and_hang') {
      const db = await WebDB.open({ engine: new WasmEngine(), storage: new OpfsStorage(dbName) });
      const isSync = Boolean(db.vfs?.isSynchronous);
      await db.createTable('events', [
        { name: 'id', type: 'INT32', primaryKey: true },
        { name: 'kind', type: 'TEXT' },
        { name: 'body', type: 'TEXT' },
      ]);
      await db.createIndex('events', 'kind');

      // Committed transaction (left uncheckpointed in OPFS .wal)
      await db.transaction(async (tx) => {
        for (const row of payload.committed) {
          await tx.insert('events', row);
        }
      });

      self.postMessage({ id, ok: true, stage: 'committed', isSync });

      // Start uncommitted transaction and hang until worker.terminate()
      if (payload.hangUncommitted) {
        await db.transaction(async (tx) => {
          await tx.insert('events', payload.hangUncommitted);
          self.postMessage({ id, ok: true, stage: 'hanging_in_tx' });
          await new Promise(() => {});
        });
      } else {
        await db.close();
      }
    } else if (action === 'read_all') {
      const db = await WebDB.open({ engine: new WasmEngine(), storage: new OpfsStorage(dbName) });
      const isSync = Boolean(db.vfs?.isSynchronous);
      const rows = await db.from('events').orderBy('id', 'asc').toArray();
      const byIndex = await db.from('events').where('kind', '=', 'audit').orderBy('id', 'asc').toArray();
      await db.close();
      self.postMessage({ id, ok: true, isSync, rows, byIndex });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
};
`,
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

test.describe("DB-Grade E2E: Wasm Core, OPFS SyncAccessHandle Workers, TOAST Overflow, Migrations & Fault Injection", () => {
  test("1. Wasm Core (core: 'wasm'): Full CRUD, Joins, Overflow TOAST & WAL Crash Recovery in Real Browser (IDB)", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await attachVirtualOriginServer(context);
    const dbName = `e2e_wasm_toast_${Date.now()}`;

    const tab1 = await context.newPage();
    await tab1.goto(baseUrl);
    await tab1.waitForFunction(() => (window as any).__harnessReady === true);

    await tab1.evaluate(async (name) => {
      const { WebDB, WasmEngine, JsEngine, IdbStorage, OpfsStorage, MemoryStorage } = window as any;
      const db = await WebDB.open({ engine: new WasmEngine(), storage: new IdbStorage(name), slotCount: 16 });
      if (!(db as any).wasmCore) {
        throw new Error("Expected wasmCore to be initialized when core: 'wasm'");
      }

      await db.createTable("authors", [
        { name: "id", type: "INT32", primaryKey: true },
        { name: "name", type: "TEXT", notNull: true },
      ]);
      await db.createTable("articles", [
        { name: "id", type: "INT32", primaryKey: true },
        { name: "author_id", type: "INT32", notNull: true },
        { name: "title", type: "TEXT", notNull: true },
        { name: "body", type: "TEXT", notNull: true },
        { name: "blob_data", type: "BLOB" },
      ]);
      await db.createIndex("articles", "author_id");

      await db.insert("authors", { id: 1, name: "Ada" });

      const bigBody1 = "WASM-TOAST-".repeat(2000); // ~22 KB
      const bigBody2 = "NEEDLE_WASM_".repeat(1500); // ~18 KB
      const bigBlob = new Uint8Array(48_000);
      for (let i = 0; i < bigBlob.length; i++) bigBlob[i] = (i * 7) & 0xff;

      await db.insertMany("articles", [
        { id: 10, author_id: 1, title: "First", body: bigBody1, blob_data: bigBlob },
        { id: 20, author_id: 1, title: "Second", body: bigBody2, blob_data: null },
      ]);

      // Update row 10 overflow -> smaller overflow, and leave uncheckpointed in WAL
      await db.update("articles", { id: 10 }, { body: "UPDATED_WASM_" + "Z".repeat(8000) });
    }, dbName);

    // Abruptly kill Tab 1 before close/checkpoint
    await tab1.close({ runBeforeUnload: false });

    // Reopen in Tab 2 with Wasm core and verify WAL replay, JOIN, LIKE on overflow, and BLOB integrity
    const tab2 = await context.newPage();
    await tab2.goto(baseUrl);
    await tab2.waitForFunction(() => (window as any).__harnessReady === true);

    const res = await tab2.evaluate(async (name) => {
      const { WebDB, WasmEngine, JsEngine, IdbStorage, OpfsStorage, MemoryStorage } = window as any;
      const db = await WebDB.open({ engine: new WasmEngine(), storage: new IdbStorage(name) });

      const joined = await db
        .from("articles")
        .join("authors", "articles.author_id", "=", "authors.id")
        .select("articles.id", "articles.title", "authors.name")
        .orderBy("articles.id", "asc")
        .toArray();

      const likeHit = await db
        .from("articles")
        .where("body", "LIKE", "%NEEDLE_WASM_%")
        .toArray();

      const row10 = await db.from("articles").where("id", "=", 10).first();
      await db.close();

      return {
        joined,
        likeId: likeHit[0]?.id,
        likeBodyLen: likeHit[0]?.body?.length,
        row10BodyPrefix: row10?.body?.slice(0, 13),
        row10BodyLen: row10?.body?.length,
        blobLen: row10?.blob_data?.byteLength,
        blobSample: [row10?.blob_data?.[0], row10?.blob_data?.[100], row10?.blob_data?.[47999]],
      };
    }, dbName);

    expect(res.joined).toEqual([
      { id: 10, title: "First", name: "Ada" },
      { id: 20, title: "Second", name: "Ada" },
    ]);
    expect(res.likeId).toBe(20);
    expect(res.likeBodyLen).toBe(18_000);
    expect(res.row10BodyPrefix).toBe("UPDATED_WASM_");
    expect(res.row10BodyLen).toBe(8013);
    expect(res.blobLen).toBe(48_000);
    expect(res.blobSample).toEqual([0, (100 * 7) & 0xff, (47999 * 7) & 0xff]);

    await context.close();
  });

  test("2. Dedicated Web Worker + OPFS FileSystemSyncAccessHandle: Sync I/O, Overflow Rows & Abrupt worker.terminate() Crash Recovery", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await attachVirtualOriginServer(context);
    const dbName = `e2e_worker_opfs_sync_${Date.now()}`;

    const page = await context.newPage();
    await page.goto(baseUrl);
    await page.waitForFunction(() => (window as any).__harnessReady === true);

    const worker1Result = await page.evaluate(async (name) => {
      const worker = new Worker("/opfs-worker.js", { type: "module" });
      const committed = [
        { id: 1, kind: "audit", body: "SYNC_OK_" + "A".repeat(12_000) },
        { id: 2, kind: "metric", body: "SYNC_OK_" + "B".repeat(5_000) },
      ];

      const result: any = await new Promise((resolve, reject) => {
        let committedInfo: any = null;
        worker.onerror = (e) => reject(new Error(e.message || "Worker error"));
        worker.onmessage = (ev) => {
          if (!ev.data.ok) {
            reject(new Error(ev.data.error));
            return;
          }
          if (ev.data.stage === "committed") {
            committedInfo = ev.data;
          } else if (ev.data.stage === "hanging_in_tx") {
            resolve(committedInfo);
          }
        };
        worker.postMessage({
          id: 1,
          action: "write_and_hang",
          dbName: name,
          payload: {
            committed,
            hangUncommitted: { id: 99, kind: "audit", body: "UNCOMMITTED_CRASH" },
          },
        });
      });

      // Abruptly terminate Worker 1 mid-uncommitted-transaction!
      worker.terminate();

      // Give browser a moment to release SyncAccessHandles & Web Lock
      await new Promise((r) => setTimeout(r, 50));

      // Spawn Worker 2 to recover from OPFS WAL using SyncAccessHandle
      const worker2 = new Worker("/opfs-worker.js", { type: "module" });
      const recovered: any = await new Promise((resolve, reject) => {
        worker2.onerror = (e) => reject(new Error(e.message || "Worker2 error"));
        worker2.onmessage = (ev) => {
          if (!ev.data.ok) reject(new Error(ev.data.error));
          else resolve(ev.data);
        };
        worker2.postMessage({ id: 2, action: "read_all", dbName: name });
      });
      worker2.terminate();

      return { w1Sync: result.isSync, recovered };
    }, dbName);

    expect(worker1Result.w1Sync).toBe(true);
    expect(worker1Result.recovered.isSync).toBe(true);
    expect(worker1Result.recovered.rows).toHaveLength(2);
    expect(worker1Result.recovered.rows[0].id).toBe(1);
    expect(worker1Result.recovered.rows[0].body.length).toBe(12_008);
    expect(worker1Result.recovered.rows[1].id).toBe(2);
    expect(worker1Result.recovered.rows[1].body.length).toBe(5_008);
    expect(worker1Result.recovered.byIndex).toHaveLength(1);
    expect(worker1Result.recovered.byIndex[0].id).toBe(1);

    await context.close();
  });

  test("3. Native OPFS Multi-Tab Concurrency & Crash Recovery Under Web Lock Contention", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await attachVirtualOriginServer(context);
    const dbName = `e2e_opfs_multitab_crash_${Date.now()}`;

    const tab1 = await context.newPage();
    const tab2 = await context.newPage();
    await Promise.all([tab1.goto(baseUrl), tab2.goto(baseUrl)]);
    await Promise.all([
      tab1.waitForFunction(() => (window as any).__harnessReady === true),
      tab2.waitForFunction(() => (window as any).__harnessReady === true),
    ]);

    await tab1.evaluate(async (name) => {
      const { WebDB, WasmEngine, JsEngine, IdbStorage, OpfsStorage, MemoryStorage } = window as any;
      const db = await WebDB.open({ engine: new WasmEngine(), storage: new OpfsStorage(name) });
      await db.createTable("opfs_ledger", [
        { name: "id", type: "INT32", primaryKey: true },
        { name: "note", type: "TEXT" },
      ]);
      await db.insert("opfs_ledger", { id: 1, note: "seed" });
      await db.checkpoint();
      (window as any).__opfsDb = db;
    }, dbName);

    await tab2.evaluate(async (name) => {
      const { WebDB, WasmEngine, JsEngine, IdbStorage, OpfsStorage, MemoryStorage } = window as any;
      (window as any).__opfsDb = await WebDB.open({ engine: new WasmEngine(), storage: new OpfsStorage(name) });
    }, dbName);

    // Concurrent transactions from both tabs on real OPFS
    await Promise.all([
      tab1.evaluate(async () => {
        const db = (window as any).__opfsDb;
        await db.insert("opfs_ledger", { id: 10, note: "tab1_ok" });
      }),
      tab2.evaluate(async () => {
        const db = (window as any).__opfsDb;
        await db.insert("opfs_ledger", { id: 20, note: "tab2_ok" });
      }),
    ]);

    // Now Tab 1 spills uncommitted overflow row in OPFS WAL and hangs holding the Web Lock
    await tab1.evaluate(async () => {
      const db = (window as any).__opfsDb;
      db.transaction(async (tx: any) => {
        await tx.insert("opfs_ledger", { id: 999, note: "CRASH_".repeat(1500) });
        (window as any).__holdingOpfsLock = true;
        await new Promise(() => {});
      });
    });

    await tab1.waitForFunction(() => (window as any).__holdingOpfsLock === true);

    const tab2CommitPromise = tab2.evaluate(async () => {
      const db = (window as any).__opfsDb;
      await db.transaction(async (tx: any) => {
        await tx.insert("opfs_ledger", { id: 30, note: "tab2_after_crash_" + "K".repeat(5000) });
      });
      const rows = await db.from("opfs_ledger").orderBy("id", "asc").toArray();
      await db.close();
      return rows;
    });

    await new Promise((r) => setTimeout(r, 30));
    await tab1.close({ runBeforeUnload: false });

    const finalRows = await tab2CommitPromise;
    expect(finalRows.map((r: any) => r.id)).toEqual([1, 10, 20, 30]);
    expect(finalRows[3].note.length).toBe(5017);

    await context.close();
  });

  test("4. Multi-Tab Schema Version Skew & MigrationRunner: Tab 2 Seamlessly Adapts to Tab 1 DDL Migration", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await attachVirtualOriginServer(context);
    const dbName = `e2e_multitab_migration_${Date.now()}`;

    const tab1 = await context.newPage();
    const tab2 = await context.newPage();
    await Promise.all([tab1.goto(baseUrl), tab2.goto(baseUrl)]);
    await Promise.all([
      tab1.waitForFunction(() => (window as any).__harnessReady === true),
      tab2.waitForFunction(() => (window as any).__harnessReady === true),
    ]);

    // Tab 1 runs v1 migration
    await tab1.evaluate(async (name) => {
      const { WebDB, WasmEngine, JsEngine, IdbStorage, OpfsStorage, MemoryStorage } = window as any;
      const Migrator = (window as any).Migrator;
      const db = await WebDB.open({ engine: new WasmEngine(), storage: new IdbStorage(name) });
      const runner = new Migrator(db, {
        migrations: [
          {
            version: 1,
            name: "init_users",
            up: async (tx: any) => {
              await tx.createTable("users", [
                { name: "id", type: "INT32", primaryKey: true },
                { name: "email", type: "TEXT", notNull: true },
              ]);
              await tx.insert("users", { id: 1, email: "alice@example.com" });
            },
            down: async (tx: any) => {
              await tx.dropTable("users");
            },
          },
        ],
      });
      await runner.up();
      (window as any).__migDb1 = db;
    }, dbName);

    // Tab 2 opens on v1 schema and caches it
    const tab2V1 = await tab2.evaluate(async (name) => {
      const { WebDB, WasmEngine, JsEngine, IdbStorage, OpfsStorage, MemoryStorage } = window as any;
      const db = await WebDB.open({ engine: new WasmEngine(), storage: new IdbStorage(name) });
      (window as any).__migDb2 = db;
      return await db.from("users").toArray();
    }, dbName);
    expect(tab2V1).toEqual([{ id: 1, email: "alice@example.com" }]);

    // Tab 1 runs v2 migration (ADD COLUMN + CREATE INDEX) while Tab 2 is still open
    await tab1.evaluate(async () => {
      const db = (window as any).__migDb1;
      const Migrator = (window as any).Migrator;
      const runner = new Migrator(db, {
        migrations: [
          {
            version: 1,
            name: "init_users",
            up: async () => {},
            down: async () => {},
          },
          {
            version: 2,
            name: "add_role",
            up: async (tx: any) => {
              await tx.addColumn("users", { name: "role", type: "TEXT", notNull: true }, { defaultValue: "member" });
              await tx.createIndex("users", "role");
            },
            down: async (tx: any) => {
              await tx.dropColumn("users", "role");
            },
          },
        ],
      });
      await runner.up();
      await db.close();
    });

    // Tab 2 queries & writes using the new schema without reopening!
    const tab2V2 = await tab2.evaluate(async () => {
      const db = (window as any).__migDb2;
      await db.insert("users", { id: 2, email: "bob@example.com", role: "admin" });
      const admins = await db.from("users").where("role", "=", "admin").toArray();
      const all = await db.from("users").orderBy("id", "asc").toArray();
      await db.close();
      return { admins, all };
    });

    expect(tab2V2.admins).toEqual([{ id: 2, email: "bob@example.com", role: "admin" }]);
    expect(tab2V2.all).toEqual([
      { id: 1, email: "alice@example.com", role: "member" },
      { id: 2, email: "bob@example.com", role: "admin" },
    ]);

    await context.close();
  });

  test("5. Fault Injection: Truncated/Corrupt WAL Tail Frame on OPFS & Nested Savepoint Rollback Durability", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await attachVirtualOriginServer(context);
    const dbName = `e2e_wal_fault_savepoint_${Date.now()}`;

    const tab1 = await context.newPage();
    await tab1.goto(baseUrl);
    await tab1.waitForFunction(() => (window as any).__harnessReady === true);

    await tab1.evaluate(async (name) => {
      const { WebDB, WasmEngine, JsEngine, IdbStorage, OpfsStorage, MemoryStorage } = window as any;
      const db = await WebDB.open({ engine: new WasmEngine(), storage: new OpfsStorage(name) });
      await db.createTable("kv", [
        { name: "k", type: "TEXT", primaryKey: true },
        { name: "v", type: "TEXT" },
      ]);

      // Outer transaction commits k='outer', inner savepoint rolls back k='inner_aborted'
      await db.transaction(async (tx: any) => {
        await tx.insert("kv", { k: "outer", v: "committed_value" });
        try {
          await tx.transaction(async (inner: any) => {
            await inner.insert("kv", { k: "inner_aborted", v: "should_rollback" });
            throw new Error("Simulated savepoint failure");
          });
        } catch {
          // Expected inner rollback
        }
      });

      // Leave uncheckpointed in OPFS .wal, then inject a torn/corrupted 512-byte partial WAL tail frame
      const preCloseRows = await db.from("kv").toArray();
      if (preCloseRows.length !== 1) {
        throw new Error(`Expected 1 row before crash, got ${JSON.stringify(preCloseRows)}`);
      }

      const root = await navigator.storage.getDirectory();
      const walHandle = await root.getFileHandle(`${name}.wal`);
      const walFile = await walHandle.getFile();
      const writable = await (walHandle as any).createWritable({ keepExistingData: true });
      await writable.seek(walFile.size);
      const garbage = new Uint8Array(512);
      garbage.fill(0xde);
      await writable.write(garbage);
      await writable.close();
    }, dbName);

    await tab1.close({ runBeforeUnload: false });

    // Reopen in Tab 2: must ignore the corrupt partial WAL tail and recover outer committed row only
    const tab2 = await context.newPage();
    await tab2.goto(baseUrl);
    await tab2.waitForFunction(() => (window as any).__harnessReady === true);

    const recovered = await tab2.evaluate(async (name) => {
      const { WebDB, WasmEngine, JsEngine, IdbStorage, OpfsStorage, MemoryStorage } = window as any;
      const db = await WebDB.open({ engine: new WasmEngine(), storage: new OpfsStorage(name) });
      const rows = await db.from("kv").toArray();
      await db.close();
      return rows;
    }, dbName);

    expect(recovered).toEqual([{ k: "outer", v: "committed_value" }]);

    await context.close();
  });
});
