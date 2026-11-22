import { describe, it, expect } from "vitest";
import {
  WebDB,
  col,
  MemoryStorage,
  Io,
  BufferPoolDriver,
  TransactionCoordinator,
  decodeWalFrameHeader,
  createWasmMemory,
  createWasmCore,
  page_init_interior,
  page_insert_interior_cell,
  page_binary_search_interior,
  page_split_interior,
  page_get_cell_count,
  page_get_cell_content_offset,
  page_init,
  page_insert_row,
  page_delete_row,
  UlidCodec,
  PAGE_SIZE,
  MAX_TABLE_INTERIOR_CELLS,
  BYTECODE_OFFSET,
} from "../src/index.ts";
import { highlight, snippet } from "../src/search/index.ts";
import { Migrator } from "../src/migrations/index.ts";
import { regexpMatch, regexpReplace } from "../src/intl/index.ts";
import { TsToCTranspiler } from "../scripts/transpiler/transpiler.ts";
import { testEngine } from "./helpers/test_engine.js";

describe("Phase 1: Safety, C/WASM UB, WAL Durability & Data Integrity", () => {
  describe("1. C/WASM Codecs, Interior B-Tree, memmove & Non-Trapping Float64", () => {
    it("WASM ulid_decode terminates safely without infinite OOB loop and rejects invalid UUID/ULID", () => {
      const mem = createWasmMemory();
      const wasm = createWasmCore(mem);
      const u8 = new Uint8Array(mem.buffer);
      const enc = new TextEncoder();
      const dec = new TextDecoder();

      const validUlid = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
      const inOff = BYTECODE_OFFSET;
      const binOff = BYTECODE_OFFSET + 64;
      const outOff = BYTECODE_OFFSET + 128;

      u8.set(enc.encode(validUlid + "\0"), inOff);
      expect(wasm.exports.ulid_encode(inOff, binOff, 0)).toBe(0);

      wasm.exports.ulid_decode(binOff, 0, outOff);
      const decoded = dec.decode(u8.subarray(outOff, outOff + 26));
      expect(decoded).toBe(validUlid);
      expect(UlidCodec.decode(u8.subarray(binOff, binOff + 16))).toBe(validUlid);

      // Invalid ULID char ('U' is invalid in Crockford Base32) must return -1
      const badUlid = "01ARZ3NDEKTSV4RRFFQ69G5FAU";
      u8.set(enc.encode(badUlid + "\0"), inOff);
      expect(wasm.exports.ulid_encode(inOff, binOff, 0)).toBe(-1);

      // Invalid UUID hex char ('z') must return -1
      const badUuid = "550e8400-e29b-41d4-a716-44665544000z";
      u8.set(enc.encode(badUuid + "\0"), inOff);
      expect(wasm.exports.uuid_encode(inOff, binOff, 0)).toBe(-1);
    });

    it("WASM page_binary_search_interior handles lower-bound (mid===0) and >32-bit rowids without underflow/truncation", () => {
      const mem = createWasmMemory();
      const wasm = createWasmCore(mem);
      const view = new DataView(mem.buffer);
      const pageOff = BYTECODE_OFFSET;

      wasm.exports.page_init_interior(pageOff, 999);
      const largeBase = 5_000_000_000n;
      expect(wasm.exports.page_insert_interior_cell(pageOff, 101, largeBase + 10n)).toBe(1);
      expect(wasm.exports.page_insert_interior_cell(pageOff, 102, largeBase + 20n)).toBe(2);
      expect(wasm.exports.page_insert_interior_cell(pageOff, 103, largeBase + 30n)).toBe(3);

      // Search smaller than first key -> triggers hi = mid - 1 when mid === 0
      expect(wasm.exports.page_binary_search_interior(pageOff, 1n)).toBe(101);
      expect(wasm.exports.page_binary_search_interior(pageOff, largeBase + 5n)).toBe(101);
      // Exact match on >32-bit key
      expect(wasm.exports.page_binary_search_interior(pageOff, largeBase + 20n)).toBe(102);
      // Larger than all keys -> right child
      expect(wasm.exports.page_binary_search_interior(pageOff, largeBase + 99n)).toBe(999);
    });

    it("page_split_interior reclaims left-page space and maintains sorted order on subsequent inserts", () => {
      const buf = new ArrayBuffer(PAGE_SIZE * 2);
      const view = new DataView(buf);
      const leftOff = 0;
      const rightOff = PAGE_SIZE;

      page_init_interior(view, leftOff, 9999);
      for (let i = 0; i < MAX_TABLE_INTERIOR_CELLS; i++) {
        expect(page_insert_interior_cell(view, leftOff, i + 10, BigInt((i + 1) * 10))).toBe(i + 1);
      }

      const split = page_split_interior(view, leftOff, rightOff);
      expect(page_get_cell_count(view, leftOff)).toBe(145);
      expect(page_get_cell_count(view, rightOff)).toBe(145);
      expect(split.median_rowid).toBe(1460n);

      // Space must be reclaimed on left page (4096 - 145 * 12 = 2356)
      expect(page_get_cell_content_offset(view, leftOff)).toBe(PAGE_SIZE - 145 * 12);

      // Insert 146 more entries (including out-of-order keys) into the split left page up to capacity 291
      for (let i = 0; i < 146; i++) {
        const key = i % 2 === 0 ? BigInt(i * 10 + 5) : BigInt(1445 - i);
        const count = page_insert_interior_cell(view, leftOff, 5000 + i, key);
        expect(count).toBe(145 + i + 1);
      }
      expect(page_get_cell_count(view, leftOff)).toBe(MAX_TABLE_INTERIOR_CELLS);
      expect(page_insert_interior_cell(view, leftOff, 8888, 999999n)).toBe(-1);

      // Verify binary search finds an out-of-order inserted key accurately
      expect(page_binary_search_interior(view, leftOff, 5n)).toBe(5000);
    });

    it("page_delete_row safely shifts overlapping slot directory entries via memmove", () => {
      const mem = createWasmMemory();
      const wasm = createWasmCore(mem);
      const view = new DataView(mem.buffer);
      const pageOff = BYTECODE_OFFSET + 4096;

      page_init(view, pageOff);
      const makeRow = (id: number) => {
        const row = new Uint8Array(16);
        const rv = new DataView(row.buffer);
        rv.setUint16(0, 16, true);
        rv.setUint8(2, 0x01);
        rv.setUint32(4, id, true);
        return row;
      };
      for (let i = 1; i <= 5; i++) {
        page_insert_row(view, pageOff, makeRow(i));
      }
      wasm.page_delete_row(view, pageOff, 1);
      expect(wasm.page_get_cell_count(view, pageOff)).toBe(4);
      const ids: number[] = [];
      for (let i = 0; i < 4; i++) {
        const off = wasm.page_get_cell_offset(view, pageOff, i);
        ids.push(view.getUint32(pageOff + off + 4, true));
      }
      expect(ids).toEqual([1, 3, 4, 5]);
    });

    it("handles large FLOAT64 (>2^31), Infinity, and NaN in SQL queries without WASM traps or JS RangeError", async () => {
      const db = await WebDB.open({ engine: testEngine(), storage: new MemoryStorage() });
      await db.createTable("metrics", [
        { name: "id", type: "INT32", primaryKey: true },
        { name: "ts", type: "FLOAT64" },
      ]);

      const largeTs = 1_763_700_000_000.75; // Unix ms timestamp >> 2^31
      await db.insertMany("metrics", [
        { id: 1, ts: largeTs },
        { id: 2, ts: -largeTs },
        { id: 3, ts: 3_000_000_000.25 },
        { id: 4, ts: 1e25 },
      ]);

      const rows = await db
        .from("metrics")
        .select(["id", "ts", "floor(ts) as f", "ceil(ts) as c", "round(ts) as r"])
        .orderBy("id", "asc")
        .toArray();

      expect(rows).toHaveLength(4);
      expect(rows[0].ts).toBe(largeTs);
      expect(rows[0].f).toBe(Math.floor(largeTs));
      expect(rows[0].c).toBe(Math.ceil(largeTs));
      expect(rows[1].f).toBe(Math.floor(-largeTs));
      expect(rows[2].f).toBe(3_000_000_000);
      expect(rows[3].ts).toBe(1e25);

      await db.close();
    });

    it("transpiler emits non-trapping __builtin_trunc/__builtin_floor, webdb_memmove, and safe f64 conversions", () => {
      const transpiler = new TsToCTranspiler();
      const res = transpiler.transpile(
        `
        export function safe_ops(x: f64, dst: u32, src: u32, n: u32): i32 {
          const a: f64 = Math.trunc(x);
          const b: f64 = Math.floor(x);
          memmove(view, dst, view, src, n);
          const i: i64 = f64_to_i64(a + b);
          return f64_to_i32(i64_to_f64(i));
        }
        `,
        "safe_ops.c.ts",
      );
      expect(res.cSource).toContain("__builtin_trunc");
      expect(res.cSource).toContain("__builtin_floor");
      expect(res.cSource).toContain("webdb_memmove");
      expect(res.cSource).toContain("webdb_f64_to_i64");
      expect(res.cSource).toContain("webdb_f64_to_i32");
    });
  });

  describe("2. WAL & Io Durability", () => {
    it("Io.writeSlot does not drop concurrent modifications while a prior flush is in flight", async () => {
      const vfs = new MemoryStorage();
      const memory = createWasmMemory(4);
      const io = new Io({ vfs, memory });
      const driver = new BufferPoolDriver({ io, memory, slotCount: 4 });

      const slot = await driver.acquirePage(2);
      const bytes = driver.getPageBytesInSlot(slot);
      bytes[20] = 0x11;
      driver.markDirty(slot);

      let releaseFirstWrite!: () => void;
      const firstWriteStarted = new Promise<void>((res) => {
        const origWrite = vfs.writePages.bind(vfs);
        let call = 0;
        vfs.writePages = async (pages) => {
          call++;
          if (call === 1) {
            res();
            await new Promise<void>((r) => {
              releaseFirstWrite = r;
            });
          }
          return origWrite(pages);
        };
      });

      const flush1 = driver.flushSlot(slot);
      await firstWriteStarted;

      // Mutate page 2 while flush #1 is still in flight, then initiate flush #2
      bytes[20] = 0x22;
      driver.markDirty(slot);
      const flush2 = driver.flushSlot(slot);

      releaseFirstWrite();
      await Promise.all([flush1, flush2]);

      const [diskPage] = await vfs.readPages([2]);
      expect(diskPage![20]).toBe(0x22);
      expect(driver.isDirty(slot)).toBe(false);
    });

    it("Io.readSlot copies coalesced in-flight read data into every distinct requesting slot", async () => {
      const vfs = new MemoryStorage();
      const seed = new Uint8Array(PAGE_SIZE);
      seed[42] = 0xab;
      await vfs.writePages([{ pageId: 2, data: seed }]);

      const origRead = vfs.readPages.bind(vfs);
      vfs.readPages = async (ids) => {
        await new Promise((r) => setTimeout(r, 15));
        return origRead(ids);
      };

      const memory = createWasmMemory(4);
      const io = new Io({ vfs, memory });
      await Promise.all([io.readSlot(1, 2), io.readSlot(2, 2)]);

      const slot1Off = io.slotsBaseOffset + 1 * PAGE_SIZE;
      const slot2Off = io.slotsBaseOffset + 2 * PAGE_SIZE;
      expect(io.uint8[slot1Off + 42]).toBe(0xab);
      expect(io.uint8[slot2Off + 42]).toBe(0xab);
    });

    it("failed commit() does not clear dirty flags or leak uncommitted pages into committedWalPages", async () => {
      const vfs = new MemoryStorage();
      const db = await WebDB.open({ engine: testEngine(), storage: vfs });
      await db.createTable("items", [
        { name: "id", type: "INT32", primaryKey: true },
        { name: "name", type: "TEXT" },
      ]);
      await db.insert("items", { id: 1, name: "committed" });
      await db.checkpoint();

      const origAppend = vfs.appendWalFrames.bind(vfs);
      let failWal = true;
      vfs.appendWalFrames = async (frames) => {
        if (failWal) throw new Error("Simulated QuotaExceededError");
        return origAppend(frames);
      };

      await expect(
        db.transaction(async (tx) => {
          await tx.insert("items", { id: 2, name: "must_not_commit" });
        }),
      ).rejects.toThrow("Simulated QuotaExceededError");

      // Re-enable storage and checkpoint — aborted row must NOT be persisted!
      failWal = false;
      await db.checkpoint();

      const rows = await db.from("items").toArray();
      expect(rows).toEqual([{ id: 1, name: "committed" }]);

      await db.close();
      const reopened = await WebDB.open({ engine: testEngine(), storage: vfs });
      expect(await reopened.from("items").toArray()).toEqual([
        { id: 1, name: "committed" },
      ]);
      await reopened.close();
    });

    it("failed executeCheckpoint() preserves dirty flags so subsequent checkpoint persists pages", async () => {
      const vfs = new MemoryStorage();
      const db = await WebDB.open({ engine: testEngine(), storage: vfs });
      await db.createTable("logs", [
        { name: "id", type: "INT32", primaryKey: true },
        { name: "msg", type: "TEXT" },
      ]);
      await db.insert("logs", { id: 1, msg: "hello" });

      const origWrite = vfs.writePages.bind(vfs);
      let failOnce = true;
      vfs.writePages = async (pages) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("Transient I/O error");
        }
        return origWrite(pages);
      };

      // Insert inside tx so pages live in WAL, then fail first checkpoint write
      await db.transaction(async (tx) => {
        await tx.insert("logs", { id: 2, msg: "durability" });
      });

      await expect(db.checkpoint()).rejects.toThrow("Transient I/O error");

      // Second checkpoint must succeed and persist both rows
      await db.checkpoint();
      await db.close();

      const reopened = await WebDB.open({ engine: testEngine(), storage: vfs });
      const rows = await reopened.from("logs").orderBy("id", "asc").toArray();
      expect(rows).toEqual([
        { id: 1, msg: "hello" },
        { id: 2, msg: "durability" },
      ]);
      await reopened.close();
    });
  });

  describe("3. dropTable Prefix-Match Safety", () => {
    it("dropping table 'user' does NOT drop secondary indexes belonging to 'user_roles'", async () => {
      const db = await WebDB.open({ engine: testEngine(), storage: new MemoryStorage() });
      await db.createTable("user", [
        { name: "id", type: "INT32", primaryKey: true },
        { name: "name", type: "TEXT" },
      ]);
      await db.createTable("user_roles", [
        { name: "id", type: "INT32", primaryKey: true },
        { name: "role", type: "TEXT" },
      ]);
      await db.createIndex("user_roles", "role");
      await db.insertMany("user_roles", [
        { id: 1, role: "admin" },
        { id: 2, role: "editor" },
      ]);

      await db.dropTable("user");

      const rolesMeta = await db.getTable("user_roles");
      expect(rolesMeta.hasIndex("idx_user_roles_role")).toBe(true);
      const admins = await db
        .from("user_roles")
        .where("role", "=", "admin")
        .toArray();
      expect(admins).toEqual([{ id: 1, role: "admin" }]);

      await db.close();
    });
  });

  describe("4. whereExists / whereNotExists DML Safety", () => {
    it("correlated whereExists/whereNotExists delete and update affect ONLY matching rows", async () => {
      const db = await WebDB.open({ engine: testEngine(), storage: new MemoryStorage() });
      await db.createTable("users", [
        { name: "id", type: "INT32", primaryKey: true },
        { name: "name", type: "TEXT" },
        { name: "status", type: "TEXT" },
      ]);
      await db.createTable("orders", [
        { name: "id", type: "INT32", primaryKey: true },
        { name: "user_id", type: "INT32" },
      ]);

      await db.insertMany("users", [
        { id: 1, name: "Alice", status: "pending" },
        { id: 2, name: "Bob", status: "pending" },
        { id: 3, name: "Charlie", status: "pending" },
      ]);
      await db.insertMany("orders", [{ id: 10, user_id: 2 }]);

      // Correlated EXISTS update -> must update ONLY Bob (id=2)
      const updated = await db
        .from("users")
        .whereExists(
          db.from("orders").where("orders.user_id", "=", col("users.id")),
        )
        .update({ status: "active" });
      expect(updated).toBe(1);

      const afterUpdate = await db.from("users").orderBy("id", "asc").toArray();
      expect(afterUpdate.map((r) => [r.id, r.status])).toEqual([
        [1, "pending"],
        [2, "active"],
        [3, "pending"],
      ]);

      // Correlated EXISTS delete -> must delete ONLY Bob (id=2), NOT wipe the table!
      const deleted = await db
        .from("users")
        .whereExists(
          db.from("orders").where("orders.user_id", "=", col("users.id")),
        )
        .delete();
      expect(deleted).toBe(1);

      const remaining = await db.from("users").orderBy("id", "asc").toArray();
      expect(remaining.map((r) => r.id)).toEqual([1, 3]);

      // Correlated NOT EXISTS update -> updates Alice & Charlie (neither has an order)
      const updatedNoOrder = await db
        .from("users")
        .whereNotExists(
          db.from("orders").where("orders.user_id", "=", col("users.id")),
        )
        .update({ status: "no_orders" });
      expect(updatedNoOrder).toBe(2);

      // Uncorrelated EXISTS (false -> 0 deleted, true -> deletes remaining)
      const deletedEmpty = await db
        .from("users")
        .whereExists(db.from("orders").where("user_id", "=", 999))
        .delete();
      expect(deletedEmpty).toBe(0);
      expect((await db.from("users").toArray()).length).toBe(2);

      const deletedAll = await db
        .from("users")
        .whereExists(db.from("orders").where("user_id", "=", 2))
        .delete();
      expect(deletedAll).toBe(2);
      expect((await db.from("users").toArray()).length).toBe(0);

      // Unsupported filter type in raw executeDelete must fail closed (throw), never wipe
      await db.insert("users", { id: 99, name: "Safe", status: "ok" });
      await expect(
        db.executeDelete("users", [{ type: "unknown_future_op" } as any]),
      ).rejects.toThrow(/Unsupported filter type/);
      expect((await db.from("users").toArray()).length).toBe(1);

      await db.close();
    });
  });

  describe("5. highlight() / snippet() XSS Prevention", () => {
    it("blocks HTML/attribute injection via tag and escapes ellipsis", () => {
      const hlInjectedTag = highlight("hello world", "world", {
        tag: 'img src=x onerror="alert(1)"',
      });
      expect(hlInjectedTag).toBe("hello <mark>world</mark>");
      expect(hlInjectedTag).not.toContain("<img");
      expect(hlInjectedTag).not.toContain("onerror");

      const hlScript = highlight("hello world", "world", { tag: "script" });
      expect(hlScript).toBe("hello <mark>world</mark>");

      const hlValid = highlight("hello world", "world", {
        tag: "span",
        className: 'x" onclick="evil()',
      });
      expect(hlValid).toBe(
        'hello <span class="x&quot; onclick=&quot;evil()">world</span>',
      );

      const snip = snippet(
        "This is a fairly long paragraph discussing WebDB performance and security in detail.",
        "WebDB",
        { size: 25, ellipsis: "<img src=x onerror=alert(1)>" },
      );
      expect(snip).not.toContain("<img");
      expect(snip).toContain("&lt;img src=x onerror=alert(1)&gt;");
    });
  });

  describe("6. Migrator step: 0 & Negative Step Validation", () => {
    it("up({ step: 0 }) and down({ step: 0 }) are strict no-ops; negative step throws RangeError", async () => {
      for (const mode of ["atomic", "per-migration"] as const) {
        const db = await WebDB.open({ engine: testEngine(), storage: new MemoryStorage() });
        const migrator = new Migrator(db, {
          mode,
          migrations: [
            {
              version: 1,
              name: "m1",
              async up(tx) {
                await tx.createTable("t1", [{ name: "id", type: "INT32", primaryKey: true }]);
              },
              async down(tx) {
                await tx.dropTable("t1");
              },
            },
            {
              version: 2,
              name: "m2",
              async up(tx) {
                await tx.createTable("t2", [{ name: "id", type: "INT32", primaryKey: true }]);
              },
              async down(tx) {
                await tx.dropTable("t2");
              },
            },
          ],
        });

        // step: 0 must run ZERO migrations AND not create the tracking table
        const res0 = await migrator.up({ step: 0 });
        expect(res0.executed).toEqual([]);
        expect(await db.hasTable("t1")).toBe(false);
        expect(await db.hasTable("_webdb_migrations")).toBe(false);

        await expect(migrator.up({ step: -1 })).rejects.toThrow(RangeError);
        await expect(migrator.up({ step: 1.5 })).rejects.toThrow(RangeError);
        expect(await db.hasTable("_webdb_migrations")).toBe(false);

        // On an empty DB, down({ step: 0 }) must NOT create tracking table, and invalid step must throw
        const emptyDown0 = await migrator.down({ step: 0 });
        expect(emptyDown0.executed).toEqual([]);
        expect(await db.hasTable("_webdb_migrations")).toBe(false);
        await expect(migrator.down({ step: -1 })).rejects.toThrow(RangeError);
        await expect(migrator.down({ step: 1.5 })).rejects.toThrow(RangeError);
        expect(await db.hasTable("_webdb_migrations")).toBe(false);

        // Apply all 2 migrations
        const resAll = await migrator.up();
        expect(resAll.executed).toHaveLength(2);

        // down({ step: 0 }) must roll back ZERO migrations
        const down0 = await migrator.down({ step: 0 });
        expect(down0.executed).toEqual([]);
        expect(await db.hasTable("t1")).toBe(true);
        expect(await db.hasTable("t2")).toBe(true);

        await expect(migrator.down({ step: -2 })).rejects.toThrow(RangeError);
        await db.close();
      }
    });
  });

  describe("7. regexpMatch / regexpReplace Shared RegExp.lastIndex", () => {
    it("does not alternate match/miss across rows when using global ('g') or sticky ('y') flags", () => {
      for (let i = 0; i < 6; i++) {
        expect(regexpMatch("foo", "foo", "g")).toBe(1);
        expect(regexpMatch("foo", "foo", "y")).toBe(1);
      }
      expect(regexpReplace("foo bar", "foo", "baz", "y")).toBe("baz bar");
      expect(regexpReplace("foo bar", "foo", "baz", "y")).toBe("baz bar");
    });
  });

  describe("8. PR Review Regressions (Correlated DML Isolation/groupKeys, WAL Serialization, Atomic Import, Batch Flush)", () => {
    it("correlated update/delete with groupBy() clears groupKeys and updates row-granularity matches", async () => {
      const db = await WebDB.open({ engine: testEngine(), storage: new MemoryStorage() });
      await db.createTable("users", [
        { name: "id", type: "INT32", primaryKey: true },
        { name: "status", type: "TEXT" },
      ]);
      await db.createTable("orders", [
        { name: "id", type: "INT32", primaryKey: true },
        { name: "user_id", type: "INT32" },
      ]);
      await db.insertMany("users", [
        { id: 1, status: "pending" },
        { id: 2, status: "pending" },
        { id: 3, status: "other" },
      ]);
      await db.insertMany("orders", [
        { id: 10, user_id: 1 },
        { id: 11, user_id: 2 },
      ]);

      const updated = await db
        .from("users")
        .groupBy("status")
        .whereExists(
          db.from("orders").where("orders.user_id", "=", col("users.id")),
        )
        .update({ status: "done" });

      expect(updated).toBe(2);
      const rows = await db.from("users").orderBy("id", "asc").toArray();
      expect(rows).toEqual([
        { id: 1, status: "done" },
        { id: 2, status: "done" },
        { id: 3, status: "other" },
      ]);
      await db.close();
    });

    it("correlated update/delete executes selection and mutation under a single exclusive lease", async () => {
      const db = await WebDB.open({ engine: testEngine(), storage: new MemoryStorage() });
      await db.createTable("users", [
        { name: "id", type: "INT32", primaryKey: true },
        { name: "name", type: "TEXT" },
      ]);
      await db.createTable("orders", [
        { name: "id", type: "INT32", primaryKey: true },
        { name: "user_id", type: "INT32" },
      ]);
      await db.insertMany("users", [
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
      ]);
      await db.insert("orders", { id: 10, user_id: 1 });

      // Start correlated delete and immediately enqueue a concurrent write removing the order.
      // Because correlated delete holds one exclusive transaction lease across select + delete,
      // the concurrent write cannot interleave between selection and mutation.
      const events: string[] = [];
      const origExecQuery = db.executeQuery;
      db.executeQuery = async function (...args) {
        events.push("query_start");
        await new Promise((r) => setTimeout(r, 15));
        return origExecQuery.apply(this, args);
      };

      const p1 = db
        .from("users")
        .whereExists(
          db.from("orders").where("orders.user_id", "=", col("users.id")),
        )
        .delete()
        .then((n) => {
          events.push("correlated_done");
          return n;
        });

      const p2 = db
        .from("orders")
        .where("id", "=", 10)
        .delete()
        .then((n) => {
          events.push("concurrent_order_delete_done");
          return n;
        });

      const [deletedUsers] = await Promise.all([p1, p2]);
      expect(deletedUsers).toBe(1);
      expect(events.indexOf("correlated_done")).toBeLessThan(
        events.indexOf("concurrent_order_delete_done"),
      );
      expect(await db.from("users").toArray()).toEqual([{ id: 2, name: "Bob" }]);
      await db.close();
    });

    it("concurrent commitDirectPagesViaWal calls on different pages produce strictly monotonic WAL frameSeq", async () => {
      const vfs = new MemoryStorage();
      const origAppend = vfs.appendWalFrames.bind(vfs);
      vfs.appendWalFrames = async (frames) => {
        await new Promise((r) => setTimeout(r, 10));
        return origAppend(frames);
      };

      const memory = createWasmMemory(4);
      const io = new Io({ vfs, memory });
      const driver = new BufferPoolDriver({ io, memory, slotCount: 4 });
      const coordinator = new TransactionCoordinator(vfs, driver, io);

      const p2 = new Uint8Array(PAGE_SIZE);
      p2[20] = 0xaa;
      const p3 = new Uint8Array(PAGE_SIZE);
      p3[20] = 0xbb;

      await Promise.all([
        coordinator.commitDirectPagesViaWal([{ pageId: 2, data: p2 }]),
        coordinator.commitDirectPagesViaWal([{ pageId: 3, data: p3 }]),
      ]);

      const frameCount = await vfs.getWalFrameCount();
      expect(frameCount).toBe(4);
      const rawFrames = await vfs.readWalFrames(0, frameCount);
      const seqs = rawFrames.map((f) => decodeWalFrameHeader(f).frameSeq);
      expect(seqs).toEqual([1, 2, 3, 4]);
    });

    it("failed importBinary() preserves live buffer pool and committed WAL state when replaceDatabaseAtomic rejects", async () => {
      const vfs = new MemoryStorage();
      const sourceDb = await WebDB.open({ engine: testEngine(), storage: new MemoryStorage() });
      await sourceDb.createTable("imported_tbl", [
        { name: "id", type: "INT32", primaryKey: true },
      ]);
      await sourceDb.insert("imported_tbl", { id: 99 });
      const importBytes = await sourceDb.exportBinary();
      await sourceDb.close();

      const db = await WebDB.open({ engine: testEngine(), storage: vfs });
      await db.createTable("live_tbl", [
        { name: "id", type: "INT32", primaryKey: true },
        { name: "val", type: "TEXT" },
      ]);
      await db.transaction(async (tx) => {
        await tx.insert("live_tbl", { id: 1, val: "still_alive" });
      });

      // Inject failing replaceDatabaseAtomic
      (vfs as any).replaceDatabaseAtomic = async () => {
        throw new Error("Simulated atomic replace failure");
      };

      await expect(db.importBinary(importBytes)).rejects.toThrow(
        "Simulated atomic replace failure",
      );

      // Live DB state & uncheckpointed WAL must remain completely intact!
      expect(await db.hasTable("live_tbl")).toBe(true);
      expect(await db.hasTable("imported_tbl")).toBe(false);
      expect(await db.from("live_tbl").toArray()).toEqual([
        { id: 1, val: "still_alive" },
      ]);

      // Checkpointing and reopening must still retain the committed row
      delete (vfs as any).replaceDatabaseAtomic;
      await db.checkpoint();
      await db.close();

      const reopened = await WebDB.open({ engine: testEngine(), storage: vfs });
      expect(await reopened.from("live_tbl").toArray()).toEqual([
        { id: 1, val: "still_alive" },
      ]);
      await reopened.close();
    });

    it("Io.writeSlots rechecks earlier batch pages if a new flush starts while waiting on a later page", async () => {
      const vfs = new MemoryStorage();
      const memory = createWasmMemory(6);
      const io = new Io({ vfs, memory });
      const driver = new BufferPoolDriver({ io, memory, slotCount: 6 });

      const slotA = await driver.acquirePage(2);
      const slotB = await driver.acquirePage(3);
      driver.getPageBytesInSlot(slotA)[20] = 0x10;
      driver.getPageBytesInSlot(slotB)[20] = 0x20;

      let releaseB!: () => void;
      let releaseA!: () => void;
      let activeForPage2 = 0;
      let maxConcurrentForPage2 = 0;
      const origWrite = vfs.writePages.bind(vfs);
      let bStarted!: () => void;
      const bStartedPromise = new Promise<void>((r) => (bStarted = r));
      let aStarted!: () => void;
      const aStartedPromise = new Promise<void>((r) => (aStarted = r));

      let callNum = 0;
      vfs.writePages = async (pages) => {
        callNum++;
        const has2 = pages.some((p) => p.pageId === 2);
        if (has2) {
          activeForPage2++;
          maxConcurrentForPage2 = Math.max(maxConcurrentForPage2, activeForPage2);
        }
        try {
          if (callNum === 1 && pages.length === 1 && pages[0].pageId === 3) {
            bStarted();
            await new Promise<void>((r) => (releaseB = r));
          } else if (callNum === 2 && pages.length === 1 && pages[0].pageId === 2) {
            aStarted();
            await new Promise<void>((r) => (releaseA = r));
          }
          return await origWrite(pages);
        } finally {
          if (has2) activeForPage2--;
        }
      };

      // 1. Start an in-flight flush on page 3 (B)
      const flushB = io.writeSlot(slotB, 3);
      await bStartedPromise;

      // 2. Start batch writeSlots([A(2), B(3)]) — it will pause awaiting B(3)
      const batchFlush = io.writeSlots([
        { slotIdx: slotA, pageId: 2 },
        { slotIdx: slotB, pageId: 3 },
      ]);

      // 3. While batch is waiting on B(3), start a flush on A(2) with newer data
      driver.getPageBytesInSlot(slotA)[20] = 0x33;
      const flushA = io.writeSlot(slotA, 2);
      await aStartedPromise;

      // 4. Release B(3) first — batch MUST wait for A(2) too before starting its own write!
      releaseB();
      await new Promise((r) => setTimeout(r, 15));
      expect(maxConcurrentForPage2).toBe(1);

      driver.getPageBytesInSlot(slotA)[20] = 0x44;
      releaseA();
      await Promise.all([flushB, flushA, batchFlush]);

      expect(maxConcurrentForPage2).toBe(1);
      const [diskPage2] = await vfs.readPages([2]);
      expect(diskPage2![20]).toBe(0x44);
    });
  });
});
