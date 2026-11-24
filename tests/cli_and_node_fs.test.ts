import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, readFile, readlink, stat, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  WebDB,
  encodeWalFileHeader,
  encodeWalFrame,
  WAL_FRAME_TYPE_PAGE_DATA,
  WAL_FRAME_TYPE_TX_COMMIT,
  WAL_FRAME_TYPE_TX_UNCOMMITTED,
  PAGE_SIZE,
  PAGE_TYPE_FREE,
  HEADER_OFFSET_TOTAL_PAGES,
} from "@ahmadmoussawi/webdb/slim";
import { WasmEngine } from "@ahmadmoussawi/webdb/core/wasm";
import { JsEngine } from "@ahmadmoussawi/webdb/core/js";
import { MemoryStorage } from "@ahmadmoussawi/webdb/storage/memory";
import {
  NodeFsStorage,
  defaultWalPath,
} from "../src/host/storage/node_fs.ts";
import { runCli, type CliIo } from "@ahmadmoussawi/webdb/cli";
import { ReadOnlyOverlayVfs } from "../src/host/storage/read_only_overlay.ts";
import {
  catalog_update_page1_checksum,
  catalog_list_table_descriptors,
  catalog_read_index_descriptor,
  catalog_write_index_descriptor,
} from "../src/core/js/catalog.c.ts";
import { computePageChecksum } from "../src/host/storage/crc32.ts";
import {
  HEADER_OFFSET_NEXT_INDEX_CATALOG_PAGE_ID,
  PAGE_HEADER_OFFSET_CHECKSUM,
} from "../src/constants.ts";

const execFileAsync = promisify(execFile);

const coreMode: "wasm" | "js" = process.env.WEBDB_CORE === "js" ? "js" : "wasm";
const createEngine = () =>
  coreMode === "js" ? new JsEngine() : new WasmEngine();

function createCaptureIo(): {
  io: CliIo;
  stdout: () => string;
  stderr: () => string;
} {
  let out = "";
  let err = "";
  return {
    io: {
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
    },
    stdout: () => out,
    stderr: () => err,
  };
}

async function createSampleDbFile(dbPath: string): Promise<void> {
  const storage = new NodeFsStorage(dbPath);
  const db = await WebDB.open({
    storage,
    engine: createEngine(),
    crossTabSync: false,
  });

  await db.createTable("users", [
    { name: "id", type: "INT32", primaryKey: true },
    { name: "name", type: "TEXT", notNull: true },
    { name: "age", type: "INT32" },
    { name: "score", type: "FLOAT64" },
    { name: "dept", type: "TEXT" },
    { name: "big_id", type: "INT64" },
    { name: "raw", type: "BLOB" },
  ]);
  await db.createIndex("users", "score");

  await db.insertMany("users", [
    {
      id: 1,
      name: "Alice",
      age: 28,
      score: 95.5,
      dept: "eng",
      big_id: 9007199254740993n,
      raw: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    },
    {
      id: 2,
      name: "Bob",
      age: 19,
      score: 82.0,
      dept: "sales",
      big_id: 42n,
      raw: null,
    },
    {
      id: 3,
      name: "Charlie",
      age: 34,
      score: 88.0,
      dept: "eng",
      big_id: 100n,
      raw: new Uint8Array([1, 2]),
    },
    {
      id: 4,
      name: "Diana",
      age: 25,
      score: 99.0,
      dept: "sales",
      big_id: 200n,
      raw: null,
    },
  ]);

  await db.createTable("orders", [
    { name: "id", type: "INT32", primaryKey: true },
    { name: "user_id", type: "INT32", notNull: true },
    { name: "amount", type: "FLOAT64", notNull: true },
  ]);
  await db.insertMany("orders", [
    { id: 101, user_id: 1, amount: 50.0 },
    { id: 102, user_id: 1, amount: 75.5 },
    { id: 103, user_id: 3, amount: 120.0 },
  ]);

  await db.checkpoint();
  await db.close();
}

describe(`NodeFsStorage & Tier 1 CLI (${coreMode} core)`, () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "webdb-cli-test-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // NodeFsStorage Tests
  // --------------------------------------------------------------------------

  it("persists and reopens a WebDB database on the Node filesystem", async () => {
    const dbPath = join(workDir, "persist.db");
    await createSampleDbFile(dbPath);

    // Reopen from disk in read-only mode (also verifies crossTabSync defaults off for node-fs)
    const ro = new NodeFsStorage(dbPath, { readOnly: true });
    expect(ro.databaseName).toBe("persist");
    expect(ro.walPath).toBe(join(workDir, "persist.wal"));

    const db = await WebDB.open({
      storage: ro,
      engine: createEngine(),
    });
    expect((db as any).broadcastChannel).toBeNull();

    const rows = await db.from("users").orderBy("id", "asc").toArray();
    expect(rows).toHaveLength(4);
    expect(rows[0].name).toBe("Alice");
    expect(rows[0].big_id).toBe(9007199254740993n);
    expect(rows[0].raw).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));

    await db.close();
  });

  it("enforces read-only mode and does not create stray WAL files", async () => {
    const dbPath = join(workDir, "exported.db");

    // Create in memory, exportBinary(), and write raw snapshot to disk (no .wal file)
    const memDb = await WebDB.open({
      storage: new MemoryStorage(),
      engine: createEngine(),
      crossTabSync: false,
    });
    await memDb.createTable("notes", [
      { name: "id", type: "INT32", primaryKey: true },
      { name: "body", type: "TEXT" },
    ]);
    await memDb.insert("notes", { id: 1, body: "hello from exportBinary" });
    const binary = await memDb.exportBinary();
    await memDb.close();
    await writeFile(dbPath, binary);

    const ro = new NodeFsStorage(dbPath, { readOnly: true });
    expect(await ro.getWalFrameCount()).toBe(0);
    expect(await ro.readWalHeader()).toBeNull();
    await expect(
      ro.writePages([{ pageId: 1, data: new Uint8Array(PAGE_SIZE) }]),
    ).rejects.toThrow(/read-only/i);
    await expect(ro.truncate(1)).rejects.toThrow(/read-only/i);
    await expect(ro.writeWalHeader(new Uint8Array(32))).rejects.toThrow(
      /read-only/i,
    );
    await expect(ro.appendWalFrames([new Uint8Array(4128)])).rejects.toThrow(
      /read-only/i,
    );
    await expect(ro.truncateWal(0)).rejects.toThrow(/read-only/i);
    await ro.close();

    // Ensure no .wal file was created
    await expect(stat(ro.walPath)).rejects.toThrow();
  });

  // --------------------------------------------------------------------------
  // CLI Inspection Commands
  // --------------------------------------------------------------------------

  it("runs info, tables, schema, and indexes commands (table and json formats)", async () => {
    const dbPath = join(workDir, "app.db");
    await createSampleDbFile(dbPath);

    // info --format json
    {
      const cap = createCaptureIo();
      const code = await runCli(
        ["--core", coreMode, "info", dbPath, "--format", "json"],
        cap.io,
      );
      expect(code).toBe(0);
      expect(cap.stderr()).toBe("");
      const parsed = JSON.parse(cap.stdout());
      expect(parsed.pageSize).toBe(4096);
      expect(parsed.tableCount).toBe(2);
      expect(parsed.indexCount).toBeGreaterThanOrEqual(1);
      expect(parsed.page1ChecksumStatus).toBe("valid");
      expect(parsed.pageBreakdown.HEADER_CATALOG).toBe(1);
      expect(parsed.pageBreakdown.LEAF_DATA).toBeGreaterThanOrEqual(2);
    }

    // info default human-readable
    {
      const cap = createCaptureIo();
      const code = await runCli(["--core", coreMode, "info", dbPath], cap.io);
      expect(code).toBe(0);
      expect(cap.stdout()).toContain("Page Size");
      expect(cap.stdout()).toContain("LEAF_DATA");
    }

    // tables --exact-count --format json
    {
      const cap = createCaptureIo();
      const code = await runCli(
        [
          "--core",
          coreMode,
          "tables",
          dbPath,
          "--exact-count",
          "--format",
          "json",
        ],
        cap.io,
      );
      expect(code).toBe(0);
      const rows = JSON.parse(cap.stdout());
      expect(rows.map((r: any) => r.name)).toEqual(["users", "orders"]);
      expect(rows[0].rows).toBe(4);
      expect(rows[1].rows).toBe(3);
    }

    // schema single table
    {
      const cap = createCaptureIo();
      const code = await runCli(
        ["--core", coreMode, "schema", dbPath, "users"],
        cap.io,
      );
      expect(code).toBe(0);
      expect(cap.stdout()).toContain("Table: users");
      expect(cap.stdout()).toContain("FLOAT64");
      expect(cap.stdout()).toContain("PK");
      expect(cap.stdout()).toContain("Indexes:");
    }

    // indexes
    {
      const cap = createCaptureIo();
      const code = await runCli(
        ["--core", coreMode, "indexes", dbPath, "--format", "json"],
        cap.io,
      );
      expect(code).toBe(0);
      const indexes = JSON.parse(cap.stdout());
      expect(
        indexes.some(
          (ix: any) => ix.table === "users" && ix.columns.includes("score"),
        ),
      ).toBe(true);
    }
  });

  // --------------------------------------------------------------------------
  // CLI Query & Explain Commands
  // --------------------------------------------------------------------------

  it("runs query with select expressions, where, order, limit, join, group-by, count, and formats", async () => {
    const dbPath = join(workDir, "query.db");
    await createSampleDbFile(dbPath);

    // Expressions + where + order + limit + json
    {
      const cap = createCaptureIo();
      const code = await runCli(
        [
          "--core",
          coreMode,
          "query",
          dbPath,
          "users",
          "-s",
          "name, score * 2 as doubled, concat(name, '!') as shout",
          "-w",
          "age >= 21",
          "-o",
          "score desc",
          "-l",
          "2",
          "-f",
          "json",
        ],
        cap.io,
      );
      expect(code).toBe(0);
      const rows = JSON.parse(cap.stdout());
      expect(rows).toEqual([
        { name: "Diana", doubled: 198, shout: "Diana!" },
        { name: "Alice", doubled: 191, shout: "Alice!" },
      ]);
    }

    // Group-by + aggregate + order
    {
      const cap = createCaptureIo();
      const code = await runCli(
        [
          "--core",
          coreMode,
          "query",
          dbPath,
          "users",
          "-s",
          "dept, count(*) as cnt, max(score) as top_score",
          "-g",
          "dept",
          "-o",
          "dept asc",
          "-f",
          "json",
        ],
        cap.io,
      );
      expect(code).toBe(0);
      const rows = JSON.parse(cap.stdout());
      expect(rows).toEqual([
        { dept: "eng", cnt: 2, top_score: 95.5 },
        { dept: "sales", cnt: 2, top_score: 99 },
      ]);
    }

    // Join
    {
      const cap = createCaptureIo();
      const code = await runCli(
        [
          "--core",
          coreMode,
          "query",
          dbPath,
          "users",
          "--join",
          "orders:users.id=orders.user_id",
          "-s",
          "users.name as user_name, orders.amount as amount",
          "-o",
          "orders.id asc",
          "-f",
          "json",
        ],
        cap.io,
      );
      expect(code).toBe(0);
      const rows = JSON.parse(cap.stdout());
      expect(rows).toEqual([
        { user_name: "Alice", amount: 50 },
        { user_name: "Alice", amount: 75.5 },
        { user_name: "Charlie", amount: 120 },
      ]);
    }

    // --count
    {
      const cap = createCaptureIo();
      const code = await runCli(
        [
          "--core",
          coreMode,
          "query",
          dbPath,
          "users",
          "-w",
          "age >= 25",
          "--count",
        ],
        cap.io,
      );
      expect(code).toBe(0);
      expect(cap.stdout().trim()).toBe("3");
    }

    // CSV & table & NDJSON with bigint and blob values
    {
      const capCsv = createCaptureIo();
      expect(
        await runCli(
          [
            "--core",
            coreMode,
            "query",
            dbPath,
            "users",
            "-s",
            "id, name, big_id",
            "-o",
            "id asc",
            "-f",
            "csv",
          ],
          capCsv.io,
        ),
      ).toBe(0);
      expect(capCsv.stdout()).toContain(
        "id,name,big_id\n1,Alice,9007199254740993",
      );

      const capTable = createCaptureIo();
      expect(
        await runCli(
          ["--core", coreMode, "query", dbPath, "users", "-l", "1"],
          capTable.io,
        ),
      ).toBe(0);
      expect(capTable.stdout()).toContain("<BLOB 4B 0xdeadbeef>");

      const capNdjson = createCaptureIo();
      expect(
        await runCli(
          [
            "--core",
            coreMode,
            "query",
            dbPath,
            "users",
            "-s",
            "name",
            "-l",
            "2",
            "-f",
            "ndjson",
          ],
          capNdjson.io,
        ),
      ).toBe(0);
      const lines = capNdjson.stdout().trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toHaveProperty("name");
    }

    // explain
    {
      const cap = createCaptureIo();
      const code = await runCli(
        ["--core", coreMode, "explain", dbPath, "users", "-w", "score > 80"],
        cap.io,
      );
      expect(code).toBe(0);
      expect(cap.stdout()).toContain("Scan Type");
      expect(cap.stdout()).toContain("OPCODE");
    }
  });

  // --------------------------------------------------------------------------
  // CLI Page, Verify, and Dump Commands
  // --------------------------------------------------------------------------

  it("inspects raw pages, verifies checksums (detecting corruption), and dumps data", async () => {
    const dbPath = join(workDir, "inspect.db");
    await createSampleDbFile(dbPath);

    // Find users rootPage via tables json
    const tablesCap = createCaptureIo();
    await runCli(
      ["--core", coreMode, "tables", dbPath, "-f", "json"],
      tablesCap.io,
    );
    const usersRootPage = JSON.parse(tablesCap.stdout()).find(
      (t: any) => t.name === "users",
    ).root_page;

    // page 1
    {
      const cap = createCaptureIo();
      expect(
        await runCli(["--core", coreMode, "page", dbPath, "1"], cap.io),
      ).toBe(0);
      expect(cap.stdout()).toContain("HEADER_CATALOG");
      expect(cap.stdout()).toContain("users");
    }

    // page <usersRootPage> --rows --hex
    {
      const cap = createCaptureIo();
      expect(
        await runCli(
          [
            "--core",
            coreMode,
            "page",
            dbPath,
            String(usersRootPage),
            "--rows",
            "--hex",
          ],
          cap.io,
        ),
      ).toBe(0);
      expect(cap.stdout()).toContain("LEAF_DATA");
      expect(cap.stdout()).toContain("Owner Table");
      expect(cap.stdout()).toContain("Alice");
      expect(cap.stdout()).toContain("0000  ");
    }

    // verify passes on clean DB (exportBinary guarantees all page CRC32 checksums are stamped)
    const expDb = await WebDB.open({
      storage: new NodeFsStorage(dbPath, { readOnly: true }),
      engine: createEngine(),
      crossTabSync: false,
    });
    const stamped = await expDb.exportBinary();
    await expDb.close();
    const stampedPath = join(workDir, "stamped.db");
    await writeFile(stampedPath, stamped);

    {
      const cap = createCaptureIo();
      expect(
        await runCli(
          ["--core", coreMode, "verify", stampedPath, "-f", "json"],
          cap.io,
        ),
      ).toBe(0);
      const report = JSON.parse(cap.stdout());
      expect(report.ok).toBe(true);
      expect(report.corruptPages).toBe(0);
      expect(report.validChecksumPages).toBe(report.pagesChecked);
    }

    // Corrupt a byte in Page 2 and confirm verify catches it with exit code 1
    const corrupted = new Uint8Array(stamped);
    corrupted[PAGE_SIZE + 50] ^= 0xff;
    const corruptPath = join(workDir, "corrupt.db");
    await writeFile(corruptPath, corrupted);

    {
      const cap = createCaptureIo();
      expect(
        await runCli(
          ["--core", coreMode, "verify", corruptPath, "-f", "json"],
          cap.io,
        ),
      ).toBe(1);
      const report = JSON.parse(cap.stdout());
      expect(report.ok).toBe(false);
      expect(report.corruptPages).toBe(1);
    }

    // dump full DB and single table to file
    {
      const cap = createCaptureIo();
      expect(await runCli(["--core", coreMode, "dump", dbPath], cap.io)).toBe(
        0,
      );
      const dumped = JSON.parse(cap.stdout());
      expect(dumped.tables.users.rows).toHaveLength(4);
      expect(dumped.tables.orders.rows).toHaveLength(3);

      const csvOut = join(workDir, "orders.csv");
      const capOut = createCaptureIo();
      expect(
        await runCli(
          [
            "--core",
            coreMode,
            "dump",
            dbPath,
            "orders",
            "-f",
            "csv",
            "-o",
            csvOut,
          ],
          capOut.io,
        ),
      ).toBe(0);
      const csvText = await readFile(csvOut, "utf8");
      expect(csvText).toContain("id,user_id,amount\n101,1,50");
    }
  });

  // --------------------------------------------------------------------------
  // Read-Only WAL Safety + Checkpoint Command
  // --------------------------------------------------------------------------

  it("replays pending WAL frames in-memory without mutating disk during read-only inspection, then checkpoints on demand", async () => {
    const dbPath = join(workDir, "waltest.db");
    const storage = new NodeFsStorage(dbPath);
    const db = await WebDB.open({
      storage,
      engine: createEngine(),
      crossTabSync: false,
    });
    await db.createTable("kv", [
      { name: "k", type: "INT32", primaryKey: true },
      { name: "v", type: "TEXT" },
    ]);
    await db.insert("kv", { k: 1, v: "base" });
    await db.checkpoint();
    await db.close();

    // Snapshot base .db bytes, then create a second DB in memory with an extra row so we can write a realistic committed WAL frame
    const baseDbBytes = await readFile(dbPath);
    const mem = new MemoryStorage();
    const tmpDb = await WebDB.open({
      storage: mem,
      engine: createEngine(),
      crossTabSync: false,
      initialData: baseDbBytes,
    });
    await tmpDb.insert("kv", { k: 2, v: "from-wal" });
    const updatedBytes = await tmpDb.exportBinary();
    await tmpDb.close();

    // Write all changed pages from updatedBytes as a committed transaction in waltest.wal
    const walPath = join(workDir, "waltest.wal");
    const totalPages = updatedBytes.byteLength / PAGE_SIZE;
    const walHeader = encodeWalFileHeader({ checkpointSeq: 1 });
    const frames: Uint8Array[] = [];
    let seq = 1;
    for (let p = 1; p <= totalPages; p++) {
      const pageSlice = updatedBytes.subarray(
        (p - 1) * PAGE_SIZE,
        p * PAGE_SIZE,
      );
      frames.push(
        encodeWalFrame(
          {
            frameType: WAL_FRAME_TYPE_PAGE_DATA,
            flags: 0,
            txId: 7,
            pageId: p,
            dbSizePages: totalPages,
            frameSeq: seq++,
          },
          pageSlice,
        ),
      );
    }
    frames.push(
      encodeWalFrame({
        frameType: WAL_FRAME_TYPE_TX_COMMIT,
        flags: 0,
        txId: 7,
        pageId: 0,
        dbSizePages: totalPages,
        frameSeq: seq++,
      }),
    );

    const walBuf = new Uint8Array(walHeader.byteLength + frames.length * 4128);
    walBuf.set(walHeader, 0);
    for (let i = 0; i < frames.length; i++) {
      walBuf.set(frames[i], 32 + i * 4128);
    }
    await writeFile(walPath, walBuf);

    // 1. Read-only CLI query MUST see the WAL row WITHOUT modifying .db or .wal on disk
    const qCap = createCaptureIo();
    expect(
      await runCli(
        [
          "--core",
          coreMode,
          "query",
          dbPath,
          "kv",
          "-o",
          "k asc",
          "-f",
          "json",
        ],
        qCap.io,
      ),
    ).toBe(0);
    expect(JSON.parse(qCap.stdout())).toEqual([
      { k: 1, v: "base" },
      { k: 2, v: "from-wal" },
    ]);

    expect(new Uint8Array(await readFile(dbPath))).toEqual(
      new Uint8Array(baseDbBytes),
    );
    expect(new Uint8Array(await readFile(walPath))).toEqual(walBuf);

    // 2. Explicit checkpoint replays WAL into .db and clears .wal
    const cpCap = createCaptureIo();
    expect(
      await runCli(
        ["--core", coreMode, "checkpoint", dbPath, "-f", "json"],
        cpCap.io,
      ),
    ).toBe(0);
    const cpRes = JSON.parse(cpCap.stdout());
    expect(cpRes.walFramesBefore).toBe(frames.length);
    expect(cpRes.walFramesAfter).toBe(0);
    expect(cpRes.pagesWritten).toBeGreaterThan(0);
    expect(cpRes.committedTxCount).toBe(1);

    // 3. Re-query after checkpoint confirms persisted row
    const qCap2 = createCaptureIo();
    expect(
      await runCli(
        [
          "--core",
          coreMode,
          "query",
          dbPath,
          "kv",
          "-o",
          "k asc",
          "-f",
          "json",
        ],
        qCap2.io,
      ),
    ).toBe(0);
    expect(JSON.parse(qCap2.stdout())).toEqual([
      { k: 1, v: "base" },
      { k: 2, v: "from-wal" },
    ]);
  });

  // --------------------------------------------------------------------------
  // CLI Usage & Error Handling
  // --------------------------------------------------------------------------

  it("handles help, version, unknown commands, and missing files cleanly", async () => {
    const h = createCaptureIo();
    expect(await runCli(["--help"], h.io)).toBe(0);
    expect(h.stdout()).toContain("Usage:");

    const v = createCaptureIo();
    expect(await runCli(["--version"], v.io)).toBe(0);
    expect(v.stdout()).toMatch(/^webdb \d+\.\d+\.\d+/);

    const unk = createCaptureIo();
    expect(await runCli(["bogus"], unk.io)).toBe(2);
    expect(unk.stderr()).toContain("Unknown command");

    const missing = createCaptureIo();
    expect(await runCli(["info", join(workDir, "nope.db")], missing.io)).toBe(
      1,
    );
    expect(missing.stderr()).toContain("not found");
  });

  // --------------------------------------------------------------------------
  // Regression Tests (Review Findings)
  // --------------------------------------------------------------------------

  it("rejects truncated/non-DB files (< 4096 bytes) without fabricating DBs or overwriting disk on checkpoint", async () => {
    const fakePath = join(workDir, "not-a-db.txt");
    const originalContent = '{"hello":"world"}\n';
    await writeFile(fakePath, originalContent, "utf8");

    // info and tables must fail (exit 1), never fabricate an empty DB
    const infoCap = createCaptureIo();
    expect(
      await runCli(["--core", coreMode, "info", fakePath], infoCap.io),
    ).toBe(1);
    expect(infoCap.stderr()).toMatch(/smaller than|Invalid database/i);

    const tablesCap = createCaptureIo();
    expect(
      await runCli(["--core", coreMode, "tables", fakePath], tablesCap.io),
    ).toBe(1);

    // checkpoint must fail AND leave the file completely untouched on disk
    const cpCap = createCaptureIo();
    expect(
      await runCli(["--core", coreMode, "checkpoint", fakePath], cpCap.io),
    ).toBe(1);
    expect(await readFile(fakePath, "utf8")).toBe(originalContent);

    // Direct WebDB.open with readOnly NodeFsStorage must also reject missing Page 1
    const ro = new NodeFsStorage(fakePath, { readOnly: true });
    await expect(
      WebDB.open({ storage: ro, engine: createEngine() }),
    ).rejects.toThrow(/Page 1|Invalid/i);
    await ro.close();
  });

  it("handles NodeFsStorage concurrent opens and validates pageIds, buffer sizes, and WAL bounds", async () => {
    const dbPath = join(workDir, "concurrent.db");
    await createSampleDbFile(dbPath);

    const storage = new NodeFsStorage(dbPath, { readOnly: false });
    try {
      const [p1, p2, walHdr, walCount] = await Promise.all([
        storage.readPages([1]),
        storage.readPages([2]),
        storage.readWalHeader(),
        storage.getWalFrameCount(),
      ]);
      expect(p1[0]?.byteLength).toBe(PAGE_SIZE);
      expect(p2[0]?.byteLength).toBe(PAGE_SIZE);
      expect(walHdr?.byteLength).toBe(32);
      expect(walCount).toBe(0);

      // readPages([0, 1, 2]) must return [null, page1, page2] instead of dropping pages 1 & 2
      const mixed = await storage.readPages([0, 1, 2]);
      expect(mixed[0]).toBeNull();
      expect(mixed[1]?.byteLength).toBe(PAGE_SIZE);
      expect(mixed[2]?.byteLength).toBe(PAGE_SIZE);

      // Non-integer / NaN page IDs return null safely
      const bad = await storage.readPages([1.5, NaN, -5]);
      expect(bad).toEqual([null, null, null]);

      // Invalid write/truncate/WAL bounds throw RangeError
      await expect(
        storage.writePages([{ pageId: 0, data: new Uint8Array(PAGE_SIZE) }]),
      ).rejects.toThrow(RangeError);
      await expect(
        storage.writePages([{ pageId: 1, data: new Uint8Array(100) }]),
      ).rejects.toThrow(RangeError);
      await expect(storage.truncate(-1)).rejects.toThrow(RangeError);
      await expect(storage.readWalFrames(-1)).rejects.toThrow(RangeError);
      await expect(storage.truncateWal(-1)).rejects.toThrow(RangeError);
    } finally {
      await storage.close();
    }
  });

  it("supports direct WebDB.open with readOnly NodeFsStorage on a DB with pending WAL frames without touching disk", async () => {
    const dbPath = join(workDir, "direct-ro-wal.db");
    const rw = new NodeFsStorage(dbPath);
    const db = await WebDB.open({ storage: rw, engine: createEngine() });
    await db.createTable("items", [
      { name: "id", type: "INT32", primaryKey: true },
      { name: "val", type: "TEXT" },
    ]);
    await db.insert("items", { id: 1, val: "committed-base" });
    await db.checkpoint();
    await db.close();

    // Build an updated image with row 2 and put it into a companion .wal
    const baseBytes = await readFile(dbPath);
    const mem = new MemoryStorage();
    const tmp = await WebDB.open({
      storage: mem,
      engine: createEngine(),
      initialData: baseBytes,
    });
    await tmp.insert("items", { id: 2, val: "committed-wal" });
    const nextBytes = await tmp.exportBinary();
    await tmp.close();

    const walPath = join(workDir, "direct-ro-wal.wal");
    const totalPages = nextBytes.byteLength / PAGE_SIZE;
    const walHdr = encodeWalFileHeader({ checkpointSeq: 1 });
    const frames: Uint8Array[] = [];
    let seq = 1;
    for (let p = 1; p <= totalPages; p++) {
      frames.push(
        encodeWalFrame(
          {
            frameType: WAL_FRAME_TYPE_PAGE_DATA,
            flags: 0,
            txId: 1,
            pageId: p,
            dbSizePages: totalPages,
            frameSeq: seq++,
          },
          nextBytes.subarray((p - 1) * PAGE_SIZE, p * PAGE_SIZE),
        ),
      );
    }
    frames.push(
      encodeWalFrame({
        frameType: WAL_FRAME_TYPE_TX_COMMIT,
        flags: 0,
        txId: 1,
        pageId: 0,
        dbSizePages: totalPages,
        frameSeq: seq++,
      }),
    );
    const walBuf = new Uint8Array(32 + frames.length * 4128);
    walBuf.set(walHdr, 0);
    for (let i = 0; i < frames.length; i++)
      walBuf.set(frames[i], 32 + i * 4128);
    await writeFile(walPath, walBuf);

    // Direct WebDB.open with readOnly NodeFsStorage replays WAL in memory and stays strictly read-only
    const roDb = await WebDB.open({
      storage: new NodeFsStorage(dbPath, { readOnly: true }),
      engine: createEngine(),
    });
    const rows = await roDb.from("items").orderBy("id", "asc").toArray();
    expect(rows).toEqual([
      { id: 1, val: "committed-base" },
      { id: 2, val: "committed-wal" },
    ]);

    // All mutating entry points must fail upfront WITHOUT poisoning in-memory buffer pool or catalog cache
    await expect(
      roDb.insert("items", { id: 3, val: "should-fail" }),
    ).rejects.toThrow(/read-only/i);
    await expect(roDb.update("items", 1, { val: "mutated" })).rejects.toThrow(
      /read-only/i,
    );
    await expect(roDb.delete("items", 1)).rejects.toThrow(/read-only/i);
    await expect(
      roDb.createTable("extra", [
        { name: "id", type: "INT32", primaryKey: true },
      ]),
    ).rejects.toThrow(/read-only/i);
    await expect(roDb.transaction(async () => {})).rejects.toThrow(
      /read-only/i,
    );
    await expect(roDb.importBinary(baseBytes)).rejects.toThrow(/read-only/i);

    // State in RAM must remain completely untouched after rejected mutations
    expect(await roDb.from("items").orderBy("id", "asc").toArray()).toEqual([
      { id: 1, val: "committed-base" },
      { id: 2, val: "committed-wal" },
    ]);
    expect((await roDb.listTables()).map((t) => t.name)).toEqual(["items"]);
    const exportedFromRo = await roDb.exportBinary();
    expect(exportedFromRo.byteLength).toBeGreaterThanOrEqual(PAGE_SIZE);
    await roDb.close();

    // Disk files untouched
    expect(new Uint8Array(await readFile(dbPath))).toEqual(
      new Uint8Array(baseBytes),
    );
    expect(new Uint8Array(await readFile(walPath))).toEqual(walBuf);
  });

  it("decodes overflow TEXT columns in cmdPage --rows and safely inspects corrupt pages/DBs", async () => {
    const dbPath = join(workDir, "overflow.db");
    const storage = new NodeFsStorage(dbPath);
    const db = await WebDB.open({ storage, engine: createEngine() });
    await db.createTable("docs", [
      { name: "id", type: "INT32", primaryKey: true },
      { name: "body", type: "TEXT" },
    ]);
    const bigText = "OVERFLOW_MARKER_" + "x".repeat(6000);
    await db.insert("docs", { id: 1, body: bigText });
    const tables = await db.listTables();
    const rootPage = tables[0].rootPageId;
    const exported = await db.exportBinary();
    await db.close();

    // 1. cmdPage --rows --format json hydrates overflow TEXT (not NULL)
    const cap = createCaptureIo();
    expect(
      await runCli(
        [
          "--core",
          coreMode,
          "page",
          dbPath,
          String(rootPage),
          "--rows",
          "-f",
          "json",
        ],
        cap.io,
      ),
    ).toBe(0);
    const parsed = JSON.parse(cap.stdout());
    expect(parsed.rows[0].row.body).toBe(bigText);

    // 2. Corrupt cellCount > 2040 + corrupt Page 1 checksum: --raw must still inspect without crashing
    const corruptBytes = new Uint8Array(exported);
    corruptBytes[50] ^= 0xff; // break Page 1 checksum
    const leafOff = (rootPage - 1) * PAGE_SIZE;
    new DataView(corruptBytes.buffer).setUint16(leafOff + 2, 50000, true); // cellCount = 50000 > 2040
    const corruptPath = join(workDir, "corrupt-page.db");
    await writeFile(corruptPath, corruptBytes);

    const rawLeaf = createCaptureIo();
    expect(
      await runCli(
        [
          "--core",
          coreMode,
          "page",
          corruptPath,
          String(rootPage),
          "--raw",
          "-f",
          "json",
        ],
        rawLeaf.io,
      ),
    ).toBe(0);
    const leafJson = JSON.parse(rawLeaf.stdout());
    expect(leafJson.cellCount).toBe(50000);
    expect(leafJson.cellOffsets).toHaveLength(2040);
    expect(leafJson.warnings.some((w: string) => w.includes("clamped"))).toBe(
      true,
    );

    const rawP1 = createCaptureIo();
    expect(
      await runCli(
        ["--core", coreMode, "page", corruptPath, "1", "--raw", "-f", "json"],
        rawP1.io,
      ),
    ).toBe(0);
    expect(JSON.parse(rawP1.stdout()).checksumValid).toBe(false);
  });

  it("catches 0-byte DBs, totalPages mismatches, and WAL corruption branches in verify", async () => {
    // 1. 0-byte file emits valid JSON report with ok=false
    const emptyPath = join(workDir, "empty.db");
    await writeFile(emptyPath, new Uint8Array(0));
    const emptyCap = createCaptureIo();
    expect(
      await runCli(
        ["--core", coreMode, "verify", emptyPath, "-f", "json"],
        emptyCap.io,
      ),
    ).toBe(1);
    expect(JSON.parse(emptyCap.stdout()).ok).toBe(false);

    // Prepare a clean stamped snapshot for header mutations
    const basePath = join(workDir, "verify-base.db");
    await createSampleDbFile(basePath);
    const expDb = await WebDB.open({
      storage: new NodeFsStorage(basePath, { readOnly: true }),
      engine: createEngine(),
    });
    const stamped = await expDb.exportBinary();
    await expDb.close();

    // 2. totalPages = 0 fails with exit code 1
    const zeroPages = new Uint8Array(stamped);
    const zpView = new DataView(zeroPages.buffer);
    zpView.setUint32(HEADER_OFFSET_TOTAL_PAGES, 0, true);
    catalog_update_page1_checksum(zpView, 0);
    const zeroPagesPath = join(workDir, "zero-pages.db");
    await writeFile(zeroPagesPath, zeroPages);
    const zpCap = createCaptureIo();
    expect(
      await runCli(
        ["--core", coreMode, "verify", zeroPagesPath, "-f", "json"],
        zpCap.io,
      ),
    ).toBe(1);
    expect(
      JSON.parse(zpCap.stdout()).errors.some((e: string) =>
        e.includes("totalPages=0"),
      ),
    ).toBe(true);

    // 3. totalPages > physicalPages fails with exit code 1
    const tooHigh = new Uint8Array(stamped);
    const thView = new DataView(tooHigh.buffer);
    thView.setUint32(HEADER_OFFSET_TOTAL_PAGES, 999, true);
    catalog_update_page1_checksum(thView, 0);
    const tooHighPath = join(workDir, "too-high.db");
    await writeFile(tooHighPath, tooHigh);
    const thCap = createCaptureIo();
    expect(
      await runCli(
        ["--core", coreMode, "verify", tooHighPath, "-f", "json"],
        thCap.io,
      ),
    ).toBe(1);
    expect(
      JSON.parse(thCap.stdout()).errors.some((e: string) =>
        e.includes("totalPages=999"),
      ),
    ).toBe(true);

    // 4. Trailing extra physical page emits warning (exit code 0)
    const extraPage = new Uint8Array(stamped.byteLength + PAGE_SIZE);
    extraPage.set(stamped, 0);
    const extraPath = join(workDir, "extra-page.db");
    await writeFile(extraPath, extraPage);
    const extraCap = createCaptureIo();
    expect(
      await runCli(
        ["--core", coreMode, "verify", extraPath, "-f", "json"],
        extraCap.io,
      ),
    ).toBe(0);
    expect(JSON.parse(extraCap.stdout()).warnings.length).toBeGreaterThan(0);

    // 5. Non-4096-multiple file size fails
    const unaligned = new Uint8Array(stamped.byteLength + 13);
    unaligned.set(stamped, 0);
    const unalignedPath = join(workDir, "unaligned.db");
    await writeFile(unalignedPath, unaligned);
    expect(
      await runCli(
        ["--core", coreMode, "verify", unalignedPath, "-f", "json"],
        createCaptureIo().io,
      ),
    ).toBe(1);

    // 6. Corrupt WAL frame checksum causes verify to exit 1 with invalidFrames=1
    const dbPath = join(workDir, "badwal.db");
    await writeFile(dbPath, stamped);
    const walPath = join(workDir, "badwal.wal");
    const hdr = encodeWalFileHeader({ checkpointSeq: 1 });
    const badFrame = encodeWalFrame({
      frameType: WAL_FRAME_TYPE_TX_COMMIT,
      flags: 0,
      txId: 1,
      pageId: 0,
      dbSizePages: 1,
      frameSeq: 1,
    });
    badFrame[40] ^= 0xff;
    const buf = new Uint8Array(32 + 4128);
    buf.set(hdr, 0);
    buf.set(badFrame, 32);
    await writeFile(walPath, buf);

    const walCap = createCaptureIo();
    expect(
      await runCli(
        ["--core", coreMode, "verify", dbPath, "-f", "json"],
        walCap.io,
      ),
    ).toBe(1);
    const report = JSON.parse(walCap.stdout());
    expect(report.ok).toBe(false);
    expect(report.wal.invalidFrames).toBe(1);

    // 7. WAL sequence gap fails with invalidFrames=1
    const gapFrame = encodeWalFrame({
      frameType: WAL_FRAME_TYPE_TX_COMMIT,
      flags: 0,
      txId: 1,
      pageId: 0,
      dbSizePages: 1,
      frameSeq: 5,
    });
    const gapBuf = new Uint8Array(32 + 4128);
    gapBuf.set(hdr, 0);
    gapBuf.set(gapFrame, 32);
    await writeFile(walPath, gapBuf);
    const gapCap = createCaptureIo();
    expect(
      await runCli(
        ["--core", coreMode, "verify", dbPath, "-f", "json"],
        gapCap.io,
      ),
    ).toBe(1);
    expect(JSON.parse(gapCap.stdout()).wal.invalidFrames).toBe(1);

    // 8. Truncated WAL header (< 32 bytes) and corrupt WAL header pageSize fail
    await writeFile(walPath, new Uint8Array(10));
    expect(
      await runCli(
        ["--core", coreMode, "verify", dbPath, "-f", "json"],
        createCaptureIo().io,
      ),
    ).toBe(1);

    await writeFile(
      walPath,
      encodeWalFileHeader({ checkpointSeq: 1, pageSize: 8192 }),
    );
    expect(
      await runCli(
        ["--core", coreMode, "verify", dbPath, "-f", "json"],
        createCaptureIo().io,
      ),
    ).toBe(1);

    // 9. Valid WAL with 1 committed tx + 1 uncommitted tx passes with counts
    const f1 = encodeWalFrame({
      frameType: WAL_FRAME_TYPE_TX_COMMIT,
      flags: 0,
      txId: 1,
      pageId: 0,
      dbSizePages: 1,
      frameSeq: 1,
    });
    const f2 = encodeWalFrame(
      {
        frameType: WAL_FRAME_TYPE_TX_UNCOMMITTED,
        flags: 0,
        txId: 2,
        pageId: 1,
        dbSizePages: 1,
        frameSeq: 2,
      },
      stamped.subarray(0, PAGE_SIZE),
    );
    const validWal = new Uint8Array(32 + 2 * 4128);
    validWal.set(hdr, 0);
    validWal.set(f1, 32);
    validWal.set(f2, 32 + 4128);
    await writeFile(walPath, validWal);
    const okWalCap = createCaptureIo();
    expect(
      await runCli(
        ["--core", coreMode, "verify", dbPath, "-f", "json"],
        okWalCap.io,
      ),
    ).toBe(0);
    const okWalRep = JSON.parse(okWalCap.stdout());
    expect(okWalRep.wal.committedTx).toBe(1);
    expect(okWalRep.wal.uncommittedTx).toBe(1);
  });

  it("handles CLI query ordering, left-join, having, offset, --count guards, CSV escaping, and arg edge cases", async () => {
    const dbPath = join(workDir, "edge.db");
    await createSampleDbFile(dbPath);

    // Interleaved -w / --or-where preserves exact CLI order
    // (dept = 'eng' OR dept = 'sales') AND age >= 30 -> only Charlie (34)
    const orCap = createCaptureIo();
    expect(
      await runCli(
        [
          "--core",
          coreMode,
          "query",
          dbPath,
          "users",
          "-s",
          "name",
          "-w",
          "dept = 'eng'",
          "--or-where",
          "dept = 'sales'",
          "-w",
          "age >= 30",
          "-f",
          "json",
        ],
        orCap.io,
      ),
    ).toBe(0);
    expect(JSON.parse(orCap.stdout())).toEqual([{ name: "Charlie" }]);

    // --left-join returns unmatched users with null order amounts, plus == join op normalization
    const ljCap = createCaptureIo();
    expect(
      await runCli(
        [
          "--core",
          coreMode,
          "query",
          dbPath,
          "users",
          "--left-join",
          "orders:users.id==orders.user_id",
          "-s",
          "users.name as name, orders.amount as amount",
          "-o",
          "users.id asc, orders.id asc",
          "-f",
          "json",
        ],
        ljCap.io,
      ),
    ).toBe(0);
    const ljRows = JSON.parse(ljCap.stdout());
    expect(ljRows.find((r: any) => r.name === "Bob")?.amount).toBeNull();
    expect(ljRows.find((r: any) => r.name === "Diana")?.amount).toBeNull();

    // --having + --offset + multi-column order spec (col:desc)
    const hvCap = createCaptureIo();
    expect(
      await runCli(
        [
          "--core",
          coreMode,
          "query",
          dbPath,
          "users",
          "-s",
          "dept, avg(score) as avg_score",
          "-g",
          "dept",
          "--having",
          "avg(score) > 91",
          "-o",
          "dept:desc",
          "-f",
          "json",
        ],
        hvCap.io,
      ),
    ).toBe(0);
    expect(JSON.parse(hvCap.stdout())).toEqual([
      { dept: "eng", avg_score: 91.75 },
    ]);

    const offCap = createCaptureIo();
    expect(
      await runCli(
        [
          "--core",
          coreMode,
          "query",
          dbPath,
          "users",
          "-s",
          "id",
          "-o",
          "id asc",
          "--offset",
          "2",
          "-l",
          "1",
          "-f",
          "json",
        ],
        offCap.io,
      ),
    ).toBe(0);
    expect(JSON.parse(offCap.stdout())).toEqual([{ id: 3 }]);

    // Empty --limit "" rejected with exit code 2
    expect(
      await runCli(
        ["--core", coreMode, "query", dbPath, "users", "--limit", ""],
        createCaptureIo().io,
      ),
    ).toBe(2);

    // explain rejects --count with exit code 2
    expect(
      await runCli(
        ["--core", coreMode, "explain", dbPath, "users", "--count"],
        createCaptureIo().io,
      ),
    ).toBe(2);

    // query --count rejects --group-by, --select, --order, --limit, --offset with exit code 2
    expect(
      await runCli(
        ["--core", coreMode, "query", dbPath, "users", "-g", "dept", "--count"],
        createCaptureIo().io,
      ),
    ).toBe(2);
    expect(
      await runCli(
        ["--core", coreMode, "query", dbPath, "users", "-s", "name", "--count"],
        createCaptureIo().io,
      ),
    ).toBe(2);
    expect(
      await runCli(
        [
          "--core",
          coreMode,
          "query",
          dbPath,
          "users",
          "-o",
          "id asc",
          "--count",
        ],
        createCaptureIo().io,
      ),
    ).toBe(2);
    expect(
      await runCli(
        ["--core", coreMode, "query", dbPath, "users", "-l", "1", "--count"],
        createCaptureIo().io,
      ),
    ).toBe(2);
    expect(
      await runCli(
        [
          "--core",
          coreMode,
          "query",
          dbPath,
          "users",
          "--offset",
          "1",
          "--count",
        ],
        createCaptureIo().io,
      ),
    ).toBe(2);

    // query --count respects csv, json, ndjson
    const csvCount = createCaptureIo();
    expect(
      await runCli(
        ["--core", coreMode, "query", dbPath, "users", "--count", "-f", "csv"],
        csvCount.io,
      ),
    ).toBe(0);
    expect(csvCount.stdout()).toBe("count\n4\n");
    const jsonCount = createCaptureIo();
    expect(
      await runCli(
        ["--core", coreMode, "query", dbPath, "users", "--count", "-f", "json"],
        jsonCount.io,
      ),
    ).toBe(0);
    expect(JSON.parse(jsonCount.stdout())).toEqual({ count: 4 });
    const ndjsonCount = createCaptureIo();
    expect(
      await runCli(
        [
          "--core",
          coreMode,
          "query",
          dbPath,
          "users",
          "--count",
          "-f",
          "ndjson",
        ],
        ndjsonCount.io,
      ),
    ).toBe(0);
    expect(ndjsonCount.stdout()).toBe('{"count":4}\n');

    // 0-row --select CSV uses projected headers only, and 0-row NDJSON emits empty output
    const emptyCsv = createCaptureIo();
    expect(
      await runCli(
        [
          "--core",
          coreMode,
          "query",
          dbPath,
          "users",
          "-s",
          "name, score",
          "-w",
          "age > 999",
          "-f",
          "csv",
        ],
        emptyCsv.io,
      ),
    ).toBe(0);
    expect(emptyCsv.stdout()).toBe("name,score\n");

    const emptyNdjson = createCaptureIo();
    expect(
      await runCli(
        [
          "--core",
          coreMode,
          "query",
          dbPath,
          "users",
          "-w",
          "age > 999",
          "-f",
          "ndjson",
        ],
        emptyNdjson.io,
      ),
    ).toBe(0);
    expect(emptyNdjson.stdout()).toBe("");

    // Malformed join specs, invalid --core, invalid boolean, missing value -> exit code 2
    expect(
      await runCli(
        ["--core", coreMode, "query", dbPath, "users", "--join", "   :a=b"],
        createCaptureIo().io,
      ),
    ).toBe(2);
    expect(
      await runCli(
        [
          "--core",
          coreMode,
          "query",
          dbPath,
          "users",
          "--join",
          "orders:badcond",
        ],
        createCaptureIo().io,
      ),
    ).toBe(2);
    expect(
      await runCli(["--core=bogus", "info", dbPath], createCaptureIo().io),
    ).toBe(2);
    expect(
      await runCli(
        ["tables", dbPath, "--exact-count=maybe"],
        createCaptureIo().io,
      ),
    ).toBe(2);
    expect(
      await runCli(["query", dbPath, "users", "--limit"], createCaptureIo().io),
    ).toBe(2);

    // -- separator stops help flag parsing; --out --help treats "--help" as filename, not help flag
    const dashH = createCaptureIo();
    expect(await runCli(["info", "--", "-h"], dashH.io)).toBe(1);
    expect(dashH.stderr()).toContain("not found");

    const helpFile = join(workDir, "--help");
    const outHelpCap = createCaptureIo();
    expect(
      await runCli(
        ["--core", coreMode, "dump", dbPath, "orders", "-o", helpFile],
        outHelpCap.io,
      ),
    ).toBe(0);
    expect(outHelpCap.stdout()).toContain("Wrote dump");

    // CSV RFC-4180 escaping with commas, quotes, newlines, null, and BLOBs
    const csvDbPath = join(workDir, "csv-escape.db");
    const csvDb = await WebDB.open({
      storage: new NodeFsStorage(csvDbPath),
      engine: createEngine(),
    });
    await csvDb.createTable("notes", [
      { name: "id", type: "INT32", primaryKey: true },
      { name: "text", type: "TEXT" },
      { name: "bin", type: "BLOB" },
    ]);
    await csvDb.insert("notes", {
      id: 1,
      text: 'a, "b"\nc',
      bin: new Uint8Array([0xab, 0xcd]),
    });
    await csvDb.insert("notes", { id: 2, text: null, bin: null });
    await csvDb.close();

    const escCsv = createCaptureIo();
    expect(
      await runCli(
        [
          "--core",
          coreMode,
          "query",
          csvDbPath,
          "notes",
          "-o",
          "id asc",
          "-f",
          "csv",
        ],
        escCsv.io,
      ),
    ).toBe(0);
    expect(escCsv.stdout()).toBe('id,text,bin\n1,"a, ""b""\nc",0xabcd\n2,,\n');
  });

  it("tests NodeFsStorage truncate, truncateWal, coalescing, close-mid-open, create:false, and ReadOnlyOverlayVfs", async () => {
    // 1. create:false on non-existent path fails without creating directories
    const missingNested = join(workDir, "nonexistent-dir", "no.db");
    const noCreate = new NodeFsStorage(missingNested, { create: false });
    await expect(noCreate.readPages([1])).rejects.toThrow(/not found/i);
    await expect(stat(join(workDir, "nonexistent-dir"))).rejects.toThrow();
    await noCreate.close();

    // 2. Non-.db path default walPath & custom options
    const customStorage = new NodeFsStorage(join(workDir, "store.webdb"), {
      databaseName: "custom_name",
    });
    expect(customStorage.walPath).toBe(join(workDir, "store.webdb.wal"));
    expect(customStorage.databaseName).toBe("custom_name");
    await customStorage.close();

    // 3. writePages coalescing (unsorted + contiguous + non-contiguous), readPages past EOF, truncate, truncateWal
    const fsPath = join(workDir, "fsops.db");
    const st = new NodeFsStorage(fsPath);
    try {
      const mkPage = (tag: number) => {
        const b = new Uint8Array(PAGE_SIZE);
        b[0] = tag;
        return b;
      };
      // Unsorted write: pages 4, 2, 1, 3 -> coalesces into contiguous run 1..4
      await st.writePages([
        { pageId: 4, data: mkPage(4) },
        { pageId: 2, data: mkPage(2) },
        { pageId: 1, data: mkPage(1) },
        { pageId: 3, data: mkPage(3) },
      ]);
      // Contiguous read partially past EOF ([1..6] on 4-page file)
      const pages = await st.readPages([1, 2, 3, 4, 5, 6]);
      expect(pages.slice(0, 4).map((p) => p?.[0])).toEqual([1, 2, 3, 4]);
      expect(pages[4]).toBeNull();
      expect(pages[5]).toBeNull();

      // truncate(2) shrinks file
      await st.truncate(2);
      expect((await st.readPages([2, 3])).map((p) => p?.[0] ?? null)).toEqual([
        2,
        null,
      ]);

      // truncateWal(> 0) on non-existent WAL must NOT create or zero-extend a corrupt .wal
      await st.truncateWal(3);
      await expect(stat(st.walPath)).rejects.toThrow();

      // Concurrent WAL read + multiple WAL writes must not leak FileHandles
      const hdr = encodeWalFileHeader({ checkpointSeq: 1 });
      const f1 = encodeWalFrame({
        frameType: WAL_FRAME_TYPE_TX_COMMIT,
        flags: 0,
        txId: 1,
        pageId: 0,
        dbSizePages: 2,
        frameSeq: 1,
      });
      const f2 = encodeWalFrame({
        frameType: WAL_FRAME_TYPE_TX_COMMIT,
        flags: 0,
        txId: 2,
        pageId: 0,
        dbSizePages: 2,
        frameSeq: 2,
      });
      await Promise.all([
        st.readWalHeader(),
        st.writeWalHeader(hdr),
        st.appendWalFrames([f1, f2]),
      ]);
      expect(await st.getWalFrameCount()).toBe(2);
      expect(await st.readWalFrames(0, 0)).toEqual([]);
      expect((await st.readWalFrames(1, 1)).length).toBe(1);

      // truncateWal(1) shrinks from 2 frames to 1 frame; truncateWal(5) does NOT zero-extend
      await st.truncateWal(1);
      expect(await st.getWalFrameCount()).toBe(1);
      await st.truncateWal(5);
      expect(await st.getWalFrameCount()).toBe(1);

      // Empty-array no-ops
      expect(await st.readPages([])).toEqual([]);
      await st.writePages([]);
      await st.appendWalFrames([]);
    } finally {
      await st.close();
    }

    // 4. close() mid-open race does not leak handles
    const raceSt = new NodeFsStorage(fsPath, { readOnly: true });
    const pendingRead = raceSt.readPages([1]).catch(() => null);
    await raceSt.close();
    await pendingRead;

    // 5. ReadOnlyOverlayVfs direct unit tests (monotonic truncate, write-after-truncate, WAL overlay, seal)
    const memBase = new MemoryStorage();
    const p1 = new Uint8Array(PAGE_SIZE).fill(1);
    const p2 = new Uint8Array(PAGE_SIZE).fill(2);
    const p3 = new Uint8Array(PAGE_SIZE).fill(3);
    await memBase.writePages([
      { pageId: 1, data: p1 },
      { pageId: 2, data: p2 },
      { pageId: 3, data: p3 },
    ]);
    const overlay = new ReadOnlyOverlayVfs(memBase);
    await overlay.truncate(1);
    expect(
      (await overlay.readPages([1, 2, 3])).map((p) => p?.[0] ?? null),
    ).toEqual([1, null, null]);
    // Monotonic truncate: truncate(3) after truncate(1) must NOT resurrect base pages 2..3
    await overlay.truncate(3);
    expect(
      (await overlay.readPages([1, 2, 3])).map((p) => p?.[0] ?? null),
    ).toEqual([1, null, null]);
    // Write after truncate IS visible via overlay
    await overlay.writePages([
      { pageId: 2, data: new Uint8Array(PAGE_SIZE).fill(9) },
    ]);
    expect((await overlay.readPages([2]))[0]?.[0]).toBe(9);
    // WAL overlay + negative index validation
    const walHdr = encodeWalFileHeader({ checkpointSeq: 1 });
    await overlay.writeWalHeader(walHdr);
    await overlay.appendWalFrames([
      new Uint8Array(4128).fill(7),
      new Uint8Array(4128).fill(8),
    ]);
    expect(await overlay.getWalFrameCount()).toBe(2);
    expect((await overlay.readWalFrames(1, 1))[0]?.[0]).toBe(8);
    await expect(overlay.readWalFrames(-1)).rejects.toThrow(RangeError);
    await overlay.truncateWal(1);
    expect(await overlay.getWalFrameCount()).toBe(1);
    // seal() blocks all 5 mutating methods
    overlay.seal();
    await expect(overlay.writePages([{ pageId: 1, data: p1 }])).rejects.toThrow(
      /read-only/i,
    );
    await expect(overlay.truncate(1)).rejects.toThrow(/read-only/i);
    await expect(overlay.writeWalHeader(walHdr)).rejects.toThrow(/read-only/i);
    await expect(
      overlay.appendWalFrames([new Uint8Array(4128)]),
    ).rejects.toThrow(/read-only/i);
    await expect(overlay.truncateWal(0)).rejects.toThrow(/read-only/i);
    // Base untouched
    expect((await memBase.readPages([2]))[0]?.[0]).toBe(2);
    expect(await memBase.getWalFrameCount()).toBe(0);
  });

  it("tests cmdPage on FREE/INDEX/CATALOG/OVERFLOW pages, --raw vs WAL, checkpoint edge cases, initialData failure cleanup, and dist/cli.js binary", async () => {
    // 1. checkpoint on a clean exported .db with NO .wal does not create a .wal file
    const noWalPath = join(workDir, "no-wal.db");
    const mem = new MemoryStorage();
    const tmp = await WebDB.open({ storage: mem, engine: createEngine() });
    await tmp.createTable("t", [
      { name: "id", type: "INT32", primaryKey: true },
      { name: "tag", type: "TEXT" },
      { name: "blob_col", type: "BLOB" },
    ]);
    await tmp.createIndex("t", "tag");
    const bigBlob = new Uint8Array(5000);
    for (let i = 0; i < bigBlob.length; i++) bigBlob[i] = i & 0xff;
    await tmp.insert("t", { id: 1, tag: "alpha", blob_col: bigBlob });
    const tMeta = await tmp.getTable("t");
    const tIndexes = await tmp.listIndexes("t");
    const snap = await tmp.exportBinary();
    await tmp.close();
    await writeFile(noWalPath, snap);

    const cpClean = createCaptureIo();
    expect(
      await runCli(
        ["--core", coreMode, "checkpoint", noWalPath, "-f", "json"],
        cpClean.io,
      ),
    ).toBe(0);
    expect(JSON.parse(cpClean.stdout()).pagesWritten).toBe(0);
    await expect(stat(join(workDir, "no-wal.wal"))).rejects.toThrow();

    // 2. Overflow BLOB hydration in cmdPage --rows + CATALOG/INDEX/OVERFLOW/FREE page inspection
    const leafCap = createCaptureIo();
    expect(
      await runCli(
        [
          "--core",
          coreMode,
          "page",
          noWalPath,
          String(tMeta.rootPageId),
          "--rows",
          "-f",
          "json",
        ],
        leafCap.io,
      ),
    ).toBe(0);
    const leafJson = JSON.parse(leafCap.stdout());
    expect(leafJson.rows[0].row.blob_col.byteLength).toBe(5000);

    const catCap = createCaptureIo();
    expect(
      await runCli(
        [
          "--core",
          coreMode,
          "page",
          noWalPath,
          String(tMeta.colCatalogPageId),
          "-f",
          "json",
        ],
        catCap.io,
      ),
    ).toBe(0);
    expect(JSON.parse(catCap.stdout()).pageType).toBe("CATALOG_PAGE");

    const idxCap = createCaptureIo();
    expect(
      await runCli(
        [
          "--core",
          coreMode,
          "page",
          noWalPath,
          String(tIndexes[0].rootPageId),
          "-f",
          "json",
        ],
        idxCap.io,
      ),
    ).toBe(0);
    expect(JSON.parse(idxCap.stdout()).pageType).toBe("INDEX_LEAF");

    // Inspect FREE page explicitly by appending a PAGE_TYPE_FREE page
    const withFree = new Uint8Array(snap.byteLength + PAGE_SIZE);
    withFree.set(snap, 0);
    const freePageId = snap.byteLength / PAGE_SIZE + 1;
    const freeOff = (freePageId - 1) * PAGE_SIZE;
    withFree[freeOff] = PAGE_TYPE_FREE;
    new DataView(withFree.buffer).setUint32(freeOff + 6, 42, true);
    const freeDbPath = join(workDir, "with-free.db");
    await writeFile(freeDbPath, withFree);
    const freeCap = createCaptureIo();
    expect(
      await runCli(
        ["--core", coreMode, "page", freeDbPath, String(freePageId)],
        freeCap.io,
      ),
    ).toBe(0);
    expect(freeCap.stdout()).toContain("Next Free Page ID");
    expect(freeCap.stdout()).toContain("42");

    // 3. checkpoint with uncommitted/aborted WAL transaction reports abortedTxCount=1
    const abortWalPath = join(workDir, "no-wal.wal");
    const hdr = encodeWalFileHeader({ checkpointSeq: 1 });
    const uncomm = encodeWalFrame(
      {
        frameType: WAL_FRAME_TYPE_TX_UNCOMMITTED,
        flags: 0,
        txId: 99,
        pageId: 1,
        dbSizePages: snap.byteLength / PAGE_SIZE,
        frameSeq: 1,
      },
      snap.subarray(0, PAGE_SIZE),
    );
    const abortWal = new Uint8Array(32 + 4128);
    abortWal.set(hdr, 0);
    abortWal.set(uncomm, 32);
    await writeFile(abortWalPath, abortWal);

    // info sees WAL status before checkpoint
    const infoWalCap = createCaptureIo();
    expect(
      await runCli(
        ["--core", coreMode, "info", noWalPath, "-f", "json"],
        infoWalCap.io,
      ),
    ).toBe(0);
    expect(JSON.parse(infoWalCap.stdout()).wal.framesOnDisk).toBe(1);

    const cpAbort = createCaptureIo();
    expect(
      await runCli(
        ["--core", coreMode, "checkpoint", noWalPath, "-f", "json"],
        cpAbort.io,
      ),
    ).toBe(0);
    const cpAbortJson = JSON.parse(cpAbort.stdout());
    expect(cpAbortJson.abortedTxCount).toBe(1);
    expect(cpAbortJson.pagesWritten).toBe(0);

    // 4. WebDB.open initialData failure cleans up storage handle without leak
    const initFailPath = join(workDir, "init-fail.db");
    await expect(
      WebDB.open({
        storage: new NodeFsStorage(initFailPath),
        engine: createEngine(),
        initialData: new Uint8Array(123), // invalid non-4KB snapshot
      }),
    ).rejects.toThrow();

    // 5. Built dist/cli.js subprocess smoke test (runs when dist/cli.js is built)
    const distBin = resolve("dist/cli.js");
    if (existsSync(distBin)) {
      const { stdout: verOut } = await execFileAsync(process.execPath, [
        distBin,
        "--version",
      ]);
      expect(verOut.trim()).toMatch(/^webdb \d+\.\d+\.\d+/);

      const { stdout: infoOut } = await execFileAsync(process.execPath, [
        distBin,
        "info",
        noWalPath,
        "-f",
        "json",
      ]);
      expect(JSON.parse(infoOut).tableCount).toBe(1);

      let usageExit = 0;
      try {
        await execFileAsync(process.execPath, [distBin, "unknown-cmd"]);
      } catch (err: any) {
        usageExit = err.code;
      }
      expect(usageExit).toBe(2);
    }
  });

  it("detects structural corruption in verify even with valid CRC32 checksums and repairs it via recover", async () => {
    // Build a multi-table DB with > 8 indexes (triggers overflow index catalog page),
    // multi-page 0x0D leaf chains, and 0x0E overflow payloads.
    const srcPath = join(workDir, "multi-corrupt-src.db");
    const storage = new NodeFsStorage(srcPath);
    const db = await WebDB.open({
      storage,
      engine: createEngine(),
      crossTabSync: false,
    });

    await db.createTable("with_pk", [
      { name: "id", type: "INT32", primaryKey: true },
      { name: "sku", type: "TEXT", notNull: true },
      { name: "blob_text", type: "TEXT" },
    ]);
    await db.createIndex("with_pk", "sku", { name: "idx_with_pk_sku", unique: true });

    await db.createTable("no_pk", [
      { name: "tag", type: "TEXT", notNull: true },
      { name: "seq", type: "INT32", notNull: true },
    ]);

    await db.createTable("schema_tbl", [
      { name: "k", type: "TEXT", primaryKey: true },
      { name: "v", type: "TEXT", notNull: true },
    ]);

    // Extra table + > 8 indexes so index catalog spills to an overflow 0x0C page
    await db.createTable("many_idx", [
      { name: "id", type: "INT32", primaryKey: true },
      { name: "c1", type: "INT32" },
      { name: "c2", type: "INT32" },
      { name: "c3", type: "INT32" },
      { name: "c4", type: "INT32" },
      { name: "c5", type: "INT32" },
      { name: "c6", type: "INT32" },
      { name: "c7", type: "INT32" },
      { name: "c8", type: "INT32" },
      { name: "c9", type: "INT32" },
    ]);
    for (let i = 1; i <= 9; i++) {
      await db.createIndex("many_idx", `c${i}`, { name: `idx_many_c${i}` });
    }

    // Insert enough rows into with_pk (including an overflow payload) and no_pk to span multiple 0x0D pages
    const bigPayload = "OV-" + "X".repeat(3200);
    const pkRows = Array.from({ length: 45 }, (_, i) => ({
      id: i + 1,
      sku: `SKU-${String(i + 1).padStart(3, "0")}`,
      blob_text: i === 44 ? bigPayload : `item-${i + 1}-${"a".repeat(120)}`,
    }));
    await db.insertMany("with_pk", pkRows);

    const noPkRows = Array.from({ length: 180 }, (_, i) => ({
      tag: `tag-${String(i + 1).padStart(3, "0")}-${"b".repeat(40)}`,
      seq: i + 1,
    }));
    await db.insertMany("no_pk", noPkRows);
    await db.insertMany("schema_tbl", [
      { k: "mode", v: "pos" },
      { k: "ver", v: "35" },
    ]);
    await db.insertMany("many_idx", [{ id: 1, c1: 10, c2: 20, c3: 30, c4: 40, c5: 50, c6: 60, c7: 70, c8: 80, c9: 90 }]);

    const cleanBin = await db.exportBinary();
    await db.close();

    // Clone and inject legacy valid-CRC32 structural corruption
    const corrupt = new Uint8Array(cleanBin);
    const stampPage = (pid: number) => {
      const slice = corrupt.subarray((pid - 1) * PAGE_SIZE, pid * PAGE_SIZE);
      const dv = new DataView(slice.buffer, slice.byteOffset, PAGE_SIZE);
      dv.setUint32(PAGE_HEADER_OFFSET_CHECKSUM, computePageChecksum(slice), true);
    };
    const zeroPageWithValidCrc = (pid: number) => {
      const slice = corrupt.subarray((pid - 1) * PAGE_SIZE, pid * PAGE_SIZE);
      slice.fill(0);
      stampPage(pid);
    };

    const p1View = new DataView(corrupt.buffer, corrupt.byteOffset, PAGE_SIZE);
    const pager = {
      getPageBytes: (pid: number) => corrupt.subarray((pid - 1) * PAGE_SIZE, pid * PAGE_SIZE),
    };
    const tables = catalog_list_table_descriptors(p1View, pager);
    const tWithPk = tables.find((t) => t.name === "with_pk")!;
    const tNoPk = tables.find((t) => t.name === "no_pk")!;
    const tSchema = tables.find((t) => t.name === "schema_tbl")!;
    const idxOvPage = p1View.getUint32(HEADER_OFFSET_NEXT_INDEX_CATALOG_PAGE_ID, true);
    expect(idxOvPage).toBeGreaterThan(1);

    // Count how many rows live on rootPageId of with_pk and no_pk (these root pages will be zeroed)
    const countLeafCells = (pid: number) => {
      const s = pager.getPageBytes(pid);
      return new DataView(s.buffer, s.byteOffset, PAGE_SIZE).getUint16(2, true);
    };
    const lostWithPkOnRoot = countLeafCells(tWithPk.rootPageId);
    const lostNoPkOnRoot = countLeafCells(tNoPk.rootPageId);
    expect(lostWithPkOnRoot).toBeGreaterThan(0);
    expect(lostNoPkOnRoot).toBeGreaterThan(0);

    // 1. Corrupt 12-byte header of overflow index catalog page (with valid CRC32) & duplicate an index
    const firstOvIdx = catalog_read_index_descriptor(p1View, 8, pager)!;
    expect(firstOvIdx).toBeTruthy();
    const dupIdxDesc = { ...catalog_read_index_descriptor(p1View, 0, pager)!, indexId: 99 };
    catalog_write_index_descriptor(p1View, 10, dupIdxDesc, {
      getPageBytes: pager.getPageBytes,
      markPageDirty: stampPage,
    });
    const ovSlice = pager.getPageBytes(idxOvPage);
    ovSlice.fill(0, 0, 12);
    stampPage(idxOvPage);

    // 2. Zero rootPageId of with_pk (orphans later leaf pages + big overflow payload)
    zeroPageWithValidCrc(tWithPk.rootPageId);

    // 3. Zero rootPageId of no_pk (tests deserialization fallback since no_pk has no indexes)
    zeroPageWithValidCrc(tNoPk.rootPageId);

    // 4. Zero colCatalogPageId of schema_tbl
    zeroPageWithValidCrc(tSchema.colCatalogPageId);

    const corruptPath = join(workDir, "struct-corrupt.db");
    await writeFile(corruptPath, corrupt);

    // `verify` must detect structural corruption and exit 1 even though CRC32 checksums are valid
    {
      const cap = createCaptureIo();
      expect(
        await runCli(["--core", coreMode, "verify", corruptPath, "-f", "json"], cap.io),
      ).toBe(1);
      const rep = JSON.parse(cap.stdout());
      expect(rep.ok).toBe(false);
      expect(rep.corruptPages).toBe(0);
      expect(rep.structuralIssues).toBeGreaterThan(0);
      expect(rep.errors.some((e: string) => e.includes("unlinked zeroed page"))).toBe(true);
    }

    // `recover` CLI guard checks: missing --out, --out === input, --dry-run
    expect(
      await runCli(["--core", coreMode, "recover", corruptPath], createCaptureIo().io),
    ).toBe(2);
    expect(
      await runCli(
        ["--core", coreMode, "recover", corruptPath, "--out", corruptPath],
        createCaptureIo().io,
      ),
    ).toBe(2);

    // Dry-run without --schema reports skipped table (exit 1) and does not write
    {
      const cap = createCaptureIo();
      expect(
        await runCli(
          ["--core", coreMode, "recover", corruptPath, "--dry-run", "-f", "json"],
          cap.io,
        ),
      ).toBe(1);
      const dryRep = JSON.parse(cap.stdout());
      expect(dryRep.dryRun).toBe(true);
      expect(dryRep.tablesSkipped).toBe(1);
      expect(dryRep.tables.find((t: any) => t.name === "schema_tbl").status).toBe(
        "skipped_missing_schema",
      );
    }

    // Full recovery with --schema and --report
    const schemaPath = join(workDir, "recover-schema.json");
    await writeFile(
      schemaPath,
      JSON.stringify({
        schema_tbl: {
          columns: [
            { name: "k", type: "TEXT", flags: { primaryKey: true } },
            { name: "v", type: "TEXT", flags: { notNull: true } },
          ],
        },
      }),
    );

    const recoveredPath = join(workDir, "recovered.db");
    const reportPath = join(workDir, "recovery-report.json");
    {
      const cap = createCaptureIo();
      expect(
        await runCli(
          [
            "--core",
            coreMode,
            "recover",
            corruptPath,
            "--out",
            recoveredPath,
            "--schema",
            schemaPath,
            "--report",
            reportPath,
            "-f",
            "json",
          ],
          cap.io,
        ),
      ).toBe(0);
      const recRep = JSON.parse(cap.stdout());
      expect(recRep.tablesRecovered).toBe(4);
      expect(recRep.tablesSkipped).toBe(0);
      expect(recRep.repairedCatalogPages.length).toBe(1);
      expect(recRep.repairedCatalogPages[0].pageId).toBe(idxOvPage);
      expect(recRep.deduplicatedIndexes).toBeGreaterThanOrEqual(1);

      const withPkSummary = recRep.tables.find((t: any) => t.name === "with_pk");
      expect(withPkSummary.totalRecoveredRows).toBe(45 - lostWithPkOnRoot);
      expect(withPkSummary.orphanRowsRecovered).toBe(45 - lostWithPkOnRoot);
      expect(withPkSummary.lostIndexEntries).toBe(lostWithPkOnRoot);
      expect(withPkSummary.lostKeysSample.length).toBe(lostWithPkOnRoot);

      const noPkSummary = recRep.tables.find((t: any) => t.name === "no_pk");
      expect(noPkSummary.totalRecoveredRows).toBe(180 - lostNoPkOnRoot);
      expect(noPkSummary.orphanRowsRecovered).toBe(180 - lostNoPkOnRoot);

      const schemaSummary = recRep.tables.find((t: any) => t.name === "schema_tbl");
      expect(schemaSummary.repairedColCatalog).toBe(true);
      expect(schemaSummary.totalRecoveredRows).toBe(2);

      expect(existsSync(reportPath)).toBe(true);
    }

    // Refuses overwrite without --force, succeeds with --force
    expect(
      await runCli(
        [
          "--core",
          coreMode,
          "recover",
          corruptPath,
          "--out",
          recoveredPath,
          "--schema",
          schemaPath,
        ],
        createCaptureIo().io,
      ),
    ).toBe(1);

    // Recovered file passes `verify` completely cleanly (0 errors, 0 structural issues)
    {
      const cap = createCaptureIo();
      expect(
        await runCli(["--core", coreMode, "verify", recoveredPath, "-f", "json"], cap.io),
      ).toBe(0);
      const verRep = JSON.parse(cap.stdout());
      expect(verRep.ok).toBe(true);
      expect(verRep.structuralIssues).toBe(0);
    }

    // Recovered data & overflow payloads & rebuilt indexes are queryable via CLI
    {
      const qCap = createCaptureIo();
      expect(
        await runCli(
          [
            "--core",
            coreMode,
            "query",
            recoveredPath,
            "with_pk",
            "-w",
            "sku = 'SKU-045'",
            "-s",
            "id, sku, blob_text",
            "-f",
            "json",
          ],
          qCap.io,
        ),
      ).toBe(0);
      const rows = JSON.parse(qCap.stdout());
      expect(rows.length).toBe(1);
      expect(rows[0].blob_text).toBe(bigPayload);
    }

    {
      const sCap = createCaptureIo();
      expect(
        await runCli(
          [
            "--core",
            coreMode,
            "query",
            recoveredPath,
            "schema_tbl",
            "-o",
            "k asc",
            "-f",
            "json",
          ],
          sCap.io,
        ),
      ).toBe(0);
      expect(JSON.parse(sCap.stdout())).toEqual([
        { k: "mode", v: "pos" },
        { k: "ver", v: "35" },
      ]);
    }
  });

  it("supports schema --recovery, schema --format json in recover --schema, --schema-from, and --schema-template", async () => {
    // Build healthy reference DB with PK + secondary index + ULID + INT32 columns
    const healthyPath = join(workDir, "healthy-ref.db");
    const db = await WebDB.open({
      storage: new NodeFsStorage(healthyPath),
      engine: createEngine(),
      crossTabSync: false,
    });
    await db.createTable("products", [
      { name: "id", type: "INT32", primaryKey: true },
      { name: "code", type: "TEXT", notNull: true },
      { name: "price", type: "FLOAT64", notNull: true },
    ]);
    await db.createIndex("products", "code", { name: "idx_products_code", unique: true });
    await db.createTable("settings", [
      { name: "key", type: "TEXT", primaryKey: true },
      { name: "value", type: "TEXT" },
    ]);
    await db.insertMany("products", [
      { id: 1, code: "ESP", price: 2.5 },
      { id: 2, code: "LATTE", price: 4.0 },
    ]);
    await db.insertMany("settings", [{ key: "currency", value: "USD" }]);

    const cleanBin = await db.exportBinary();
    await db.close();

    // Create damaged copy by zeroing colCatalogPageId for `products` (with valid CRC32)
    const corrupt = new Uint8Array(cleanBin);
    const p1View = new DataView(corrupt.buffer, corrupt.byteOffset, PAGE_SIZE);
    const tProd = catalog_list_table_descriptors(p1View, {
      getPageBytes: (pid) => corrupt.subarray((pid - 1) * PAGE_SIZE, pid * PAGE_SIZE),
    }).find((t) => t.name === "products")!;
    const catSlice = corrupt.subarray(
      (tProd.colCatalogPageId - 1) * PAGE_SIZE,
      tProd.colCatalogPageId * PAGE_SIZE,
    );
    catSlice.fill(0);
    new DataView(catSlice.buffer, catSlice.byteOffset, PAGE_SIZE).setUint32(
      PAGE_HEADER_OFFSET_CHECKSUM,
      computePageChecksum(catSlice),
      true,
    );

    const corruptPath = join(workDir, "corrupt-schema-test.db");
    await writeFile(corruptPath, corrupt);

    // 1. Missing schema without --schema prints actionable tip
    {
      const skipCap = createCaptureIo();
      expect(
        await runCli(
          ["--core", coreMode, "recover", corruptPath, "--dry-run"],
          skipCap.io,
        ),
      ).toBe(1);
      expect(skipCap.stdout()).toContain("--schema-from");
      expect(skipCap.stdout()).toContain("--schema-template");
      expect(skipCap.stdout()).toContain("products");
    }

    // 2. `schema --recovery --out` exports --schema compatible JSON & recovers `products` + unique index
    const recSchemaPath = join(workDir, "exported-recovery-schema.json");
    {
      const expCap = createCaptureIo();
      expect(
        await runCli(
          ["--core", coreMode, "schema", healthyPath, "--recovery", "--out", recSchemaPath],
          expCap.io,
        ),
      ).toBe(0);
      const exportedJson = JSON.parse(await readFile(recSchemaPath, "utf8"));
      expect(exportedJson.products.columns).toHaveLength(3);
      expect(exportedJson.products.indexes).toEqual([
        { name: "idx_products_code", columns: ["code"], unique: true },
      ]);

      const outPath = join(workDir, "rec-from-exported.db");
      const rCap = createCaptureIo();
      expect(
        await runCli(
          [
            "--core",
            coreMode,
            "recover",
            corruptPath,
            "--out",
            outPath,
            "--schema",
            recSchemaPath,
            "-f",
            "json",
          ],
          rCap.io,
        ),
      ).toBe(0);
      expect(JSON.parse(rCap.stdout()).tablesRecovered).toBe(2);

      const qCap = createCaptureIo();
      expect(
        await runCli(
          [
            "--core",
            coreMode,
            "query",
            outPath,
            "products",
            "-w",
            "code = 'LATTE'",
            "-f",
            "json",
          ],
          qCap.io,
        ),
      ).toBe(0);
      expect(JSON.parse(qCap.stdout())).toEqual([{ id: 2, code: "LATTE", price: 4 }]);
    }

    // 3. Standard `webdb schema --format json` output works directly as `--schema`
    const stdJsonPath = join(workDir, "std-schema.json");
    {
      const stdCap = createCaptureIo();
      expect(
        await runCli(
          ["--core", coreMode, "schema", healthyPath, "products", "-f", "json", "--out", stdJsonPath],
          stdCap.io,
        ),
      ).toBe(0);
      const outPath = join(workDir, "rec-from-std-json.db");
      expect(
        await runCli(
          [
            "--core",
            coreMode,
            "recover",
            corruptPath,
            "--out",
            outPath,
            "--schema",
            stdJsonPath,
            "-f",
            "json",
          ],
          createCaptureIo().io,
        ),
      ).toBe(0);
      expect(
        await runCli(["--core", coreMode, "verify", outPath], createCaptureIo().io),
      ).toBe(0);
    }

    // 4. `recover --schema-from <healthy.db>` borrows schemas directly without JSON files
    {
      const outFromHealthy = join(workDir, "rec-schema-from.db");
      const sfCap = createCaptureIo();
      expect(
        await runCli(
          [
            "--core",
            coreMode,
            "recover",
            corruptPath,
            "--out",
            outFromHealthy,
            "--schema-from",
            healthyPath,
            "-f",
            "json",
          ],
          sfCap.io,
        ),
      ).toBe(0);
      const rep = JSON.parse(sfCap.stdout());
      expect(rep.tablesRecovered).toBe(2);
      expect(rep.tablesSkipped).toBe(0);
      expect(
        await runCli(["--core", coreMode, "verify", outFromHealthy], createCaptureIo().io),
      ).toBe(0);
    }

    // 5. `recover --schema-template` prints valid JSON for only the damaged table, pre-flags PK & indexes
    {
      const tplCap = createCaptureIo();
      expect(
        await runCli(
          ["--core", coreMode, "recover", corruptPath, "--schema-template"],
          tplCap.io,
        ),
      ).toBe(0);
      const tpl = JSON.parse(tplCap.stdout());
      expect(Object.keys(tpl)).toEqual(["products"]);
      expect(tpl.products.columns).toHaveLength(3);
      expect(tpl.products.columns[0]).toMatchObject({
        name: "id",
        type: "INT32",
        flags: { primaryKey: true, notNull: true },
      });
      expect(tpl.products.columns[1]._hint).toContain("idx_products_code");
      expect(tpl.products.indexes).toEqual([
        { name: "idx_products_code", columns: ["col_1"], unique: true },
      ]);

      // Refuses overwriting input with --schema-template --out
      expect(
        await runCli(
          ["--core", coreMode, "recover", corruptPath, "--schema-template", "--out", corruptPath],
          createCaptureIo().io,
        ),
      ).toBe(2);

      // Writes cleanly with --schema-template --out
      const tplPath = join(workDir, "tpl.json");
      expect(
        await runCli(
          ["--core", coreMode, "recover", corruptPath, "--schema-template", "--out", tplPath],
          createCaptureIo().io,
        ),
      ).toBe(0);
      expect(existsSync(tplPath)).toBe(true);
    }
  });

  it("supports `compact` with --dry-run, --out, --min-reclaim, --in-place (WAL cleanup), and rejects damaged DBs", async () => {
    const dbPath = join(workDir, "fragmented.db");
    const storage = new NodeFsStorage(dbPath);
    const db = await WebDB.open({
      storage,
      engine: createEngine(),
      crossTabSync: false,
    });
    await db.createTable("events", [
      { name: "id", type: "INT32", primaryKey: true, autoInc: true },
      { name: "kind", type: "TEXT", notNull: true },
      { name: "body", type: "TEXT" },
    ]);
    await db.createIndex("events", "kind", { name: "idx_events_kind" });
    await db.insertMany(
      "events",
      Array.from({ length: 160 }, (_, i) => ({
        kind: i % 2 === 0 ? "info" : "warn",
        body: `event-${i}-${"b".repeat(160)}`,
      })),
    );
    expect(await db.from("events").where("id", ">", 4).delete()).toBe(156);
    await db.close();

    // Also leave committed WAL frames on disk so we verify WAL merge & cleanup on --in-place
    const walDb = await WebDB.open({
      storage: new NodeFsStorage(dbPath),
      engine: createEngine(),
      crossTabSync: false,
    });
    // Force an uncheckpointed WAL transaction by reading/inserting cleanly
    await walDb.insert("events", { kind: "info", body: "post-close-row" });
    // Note: WebDB autocommit keeps WAL until checkpoint/close; verify before/after sizes cleanly
    await walDb.close();

    const sizeBefore = (await stat(dbPath)).size;

    // 1. Validation errors
    expect(
      await runCli(["--core", coreMode, "compact", dbPath], createCaptureIo().io),
    ).toBe(2);
    expect(
      await runCli(
        ["--core", coreMode, "compact", dbPath, "--out", dbPath],
        createCaptureIo().io,
      ),
    ).toBe(2);
    expect(
      await runCli(
        ["--core", coreMode, "compact", dbPath, "--out", join(workDir, "a.db"), "--in-place"],
        createCaptureIo().io,
      ),
    ).toBe(2);

    // 2. --dry-run inspects without modifying file
    let dryReclaimed = 0;
    {
      const cap = createCaptureIo();
      expect(
        await runCli(
          ["--core", coreMode, "compact", dbPath, "--dry-run", "-f", "json"],
          cap.io,
        ),
      ).toBe(0);
      const rep = JSON.parse(cap.stdout());
      expect(rep.dryRun).toBe(true);
      expect(rep.compacted).toBe(false);
      expect(rep.pagesAfter).toBeLessThan(rep.pagesBefore);
      expect(rep.rowsCopied).toBe(5);
      dryReclaimed = rep.pagesReclaimed;
      expect((await stat(dbPath)).size).toBe(sizeBefore);
    }

    // 3. --min-reclaim skips writing --out when threshold exceeds reclaimable pages
    const outPath = join(workDir, "compacted.db");
    {
      const cap = createCaptureIo();
      expect(
        await runCli(
          [
            "--core",
            coreMode,
            "compact",
            dbPath,
            "--out",
            outPath,
            "--min-reclaim",
            String(dryReclaimed + 1),
            "-f",
            "json",
          ],
          cap.io,
        ),
      ).toBe(0);
      const rep = JSON.parse(cap.stdout());
      expect(rep.compacted).toBe(false);
      expect(existsSync(outPath)).toBe(false);
    }

    // 4. --out writes smaller compacted DB, refuses overwrite without --force, passes verify & queries
    {
      const cap = createCaptureIo();
      expect(
        await runCli(
          ["--core", coreMode, "compact", dbPath, "--out", outPath],
          cap.io,
        ),
      ).toBe(0);
      expect(cap.stdout()).toContain("COMPACTED");
      expect(existsSync(outPath)).toBe(true);
      expect((await stat(outPath)).size).toBeLessThan(sizeBefore);

      // Refuses overwrite without --force
      expect(
        await runCli(
          ["--core", coreMode, "compact", dbPath, "--out", outPath],
          createCaptureIo().io,
        ),
      ).toBe(1);
      // Succeeds with --force
      expect(
        await runCli(
          ["--core", coreMode, "compact", dbPath, "--out", outPath, "--force"],
          createCaptureIo().io,
        ),
      ).toBe(0);

      expect(
        await runCli(["--core", coreMode, "verify", outPath], createCaptureIo().io),
      ).toBe(0);
    }

    // 5. Append an uncheckpointed committed WAL frame onto dbPath and compact --in-place
    {
      const st = new NodeFsStorage(dbPath);
      const walPath = st.walPath;
      const [p1] = await st.readPages([1]);
      expect(p1).toBeTruthy();
      const hdr = encodeWalFileHeader({ checkpointSeq: 1, salt1: 777 });
      await st.writeWalHeader(hdr);
      const commitFrame = encodeWalFrame({
        pageId: 1,
        txId: 1,
        frameSeq: 1,
        frameType: WAL_FRAME_TYPE_TX_COMMIT,
        salt1: 777,
        checkpointSeq: 1,
        pageData: p1!,
      });
      await st.appendWalFrames([commitFrame]);
      await st.close();
      expect(existsSync(walPath)).toBe(true);

      const cap = createCaptureIo();
      expect(
        await runCli(
          ["--core", coreMode, "compact", dbPath, "--in-place", "-f", "json"],
          cap.io,
        ),
      ).toBe(0);
      const rep = JSON.parse(cap.stdout());
      expect(rep.compacted).toBe(true);
      expect(rep.inPlace).toBe(true);
      expect(rep.walFramesMerged).toBe(1);
      expect((await stat(dbPath)).size).toBe(rep.bytesAfter);
      expect((await stat(dbPath)).size).toBeLessThan(sizeBefore);
      expect(existsSync(walPath)).toBe(false);

      expect(
        await runCli(["--core", coreMode, "verify", dbPath], createCaptureIo().io),
      ).toBe(0);
    }

    // 6. Structurally damaged DB is rejected with hint to use `webdb recover`
    {
      const corruptPath = join(workDir, "corrupt-compact.db");
      const raw = new Uint8Array(await readFile(outPath));
      // Zero Page 1's index/table root pointer page (page 2)
      raw.fill(0, PAGE_SIZE, PAGE_SIZE * 2);
      await writeFile(corruptPath, raw);

      const errCap = createCaptureIo();
      expect(
        await runCli(
          ["--core", coreMode, "compact", corruptPath, "--dry-run"],
          errCap.io,
        ),
      ).toBe(1);
      expect(errCap.stderr()).toContain("webdb recover");
    }

    // 7. C1: Bit-flipped data page (bad CRC32) on disk is rejected instead of forging CRC32
    {
      const bitflipPath = join(workDir, "bitflip-cli.db");
      const raw = new Uint8Array(await readFile(outPath));
      // Flip 1 byte in page 4 (leaf data or index leaf) without updating CRC32
      raw[PAGE_SIZE * 3 + PAGE_SIZE - 5] ^= 0x55;
      await writeFile(bitflipPath, raw);

      const errCap = createCaptureIo();
      expect(
        await runCli(
          ["--core", coreMode, "compact", bitflipPath, "--in-place"],
          errCap.io,
        ),
      ).toBe(1);
      expect(errCap.stderr()).toMatch(/corrupt|checksum/i);
      // Must NOT overwrite or forge CRC32
      expect(new Uint8Array(await readFile(bitflipPath))).toEqual(raw);
    }

    // 8. C3: --out --force removes stale <out>.wal; symlink & 0o600 permissions preserved on --in-place
    {
      const staleOut = join(workDir, "stale-force.db");
      await writeFile(staleOut, await readFile(outPath));
      const staleWal = defaultWalPath(staleOut);
      // Write a corrupt/stale WAL beside staleOut
      await writeFile(staleWal, new Uint8Array(64));
      expect(existsSync(staleWal)).toBe(true);

      expect(
        await runCli(
          ["--core", coreMode, "compact", dbPath, "--out", staleOut, "--force"],
          createCaptureIo().io,
        ),
      ).toBe(0);
      expect(existsSync(staleWal)).toBe(false);
      expect(
        await runCli(["--core", coreMode, "verify", staleOut], createCaptureIo().io),
      ).toBe(0);

      // Symlink & mode 0o600 preservation
      const realTarget = join(workDir, "real-target.db");
      const symLinkPath = join(workDir, "link-target.db");
      await writeFile(realTarget, await readFile(outPath));
      await chmod(realTarget, 0o600);
      await symlink(realTarget, symLinkPath);

      expect(
        await runCli(
          ["--core", coreMode, "compact", symLinkPath, "--in-place"],
          createCaptureIo().io,
        ),
      ).toBe(0);
      expect(await readlink(symLinkPath)).toBe(realTarget);
      expect((await stat(realTarget)).mode & 0o777).toBe(0o600);
    }

    // 9. M4 & L5: Corrupt WAL refuses --in-place WITHOUT deleting .wal; uncommitted WAL frames not counted as merged; unsafe --min-reclaim rejected
    {
      const corruptWalDb = join(workDir, "corrupt-wal.db");
      await writeFile(corruptWalDb, await readFile(outPath));
      const badWalPath = defaultWalPath(corruptWalDb);
      const badWal = new Uint8Array(64);
      badWal.fill(0xab);
      await writeFile(badWalPath, badWal);

      const errCap = createCaptureIo();
      expect(
        await runCli(
          ["--core", coreMode, "compact", corruptWalDb, "--in-place"],
          errCap.io,
        ),
      ).toBe(1);
      expect(errCap.stderr()).toMatch(/WAL/i);
      expect(existsSync(badWalPath)).toBe(true);

      // Uncommitted WAL frame reported separately, not counted as walFramesMerged
      const stUnc = new NodeFsStorage(corruptWalDb, { walPath: badWalPath });
      const [p1] = await stUnc.readPages([1]);
      await stUnc.truncateWal(0);
      await stUnc.writeWalHeader(encodeWalFileHeader({ checkpointSeq: 1, salt1: 99 }));
      await stUnc.appendWalFrames([
        encodeWalFrame({
          pageId: 1,
          txId: 1,
          frameSeq: 1,
          frameType: WAL_FRAME_TYPE_TX_UNCOMMITTED,
          salt1: 99,
          checkpointSeq: 1,
          pageData: p1!,
        }),
      ]);
      await stUnc.close();

      const capUnc = createCaptureIo();
      expect(
        await runCli(
          ["--core", coreMode, "compact", corruptWalDb, "--in-place", "-f", "json"],
          capUnc.io,
        ),
      ).toBe(0);
      const repUnc = JSON.parse(capUnc.stdout());
      expect(repUnc.walFramesMerged).toBe(0);
      expect(repUnc.uncommittedWalFrames).toBe(1);
      expect(existsSync(badWalPath)).toBe(false);

      // Unsafe integer rejected for --min-reclaim
      expect(
        await runCli(
          ["--core", coreMode, "compact", corruptWalDb, "--dry-run", "--min-reclaim", "99999999999999999"],
          createCaptureIo().io,
        ),
      ).toBe(2);
    }

    // 10. H1 step 4d & L1: inspectDatabaseStructure catches cellCount > MAX_SLOTS_PER_PAGE (no RangeError) and duplicate indexes in CLI compact
    {
      const badSlotsDb = join(workDir, "bad-cellcount.db");
      const raw = new Uint8Array(await readFile(outPath));
      // Find first LEAF_DATA (0x0D) page and corrupt its cellCount to 50000 with valid CRC32
      let leafPageOffset = -1;
      for (let off = PAGE_SIZE; off < raw.byteLength; off += PAGE_SIZE) {
        if (raw[off] === 0x0d) {
          leafPageOffset = off;
          break;
        }
      }
      expect(leafPageOffset).toBeGreaterThan(0);
      const lv = new DataView(raw.buffer, raw.byteOffset + leafPageOffset, PAGE_SIZE);
      lv.setUint16(2, 50000, true);
      lv.setUint32(12, computePageChecksum(raw.subarray(leafPageOffset, leafPageOffset + PAGE_SIZE)), true);
      await writeFile(badSlotsDb, raw);

      const verCap = createCaptureIo();
      expect(
        await runCli(["--core", coreMode, "verify", badSlotsDb, "-f", "json"], verCap.io),
      ).toBe(1);
      const verRep = JSON.parse(verCap.stdout());
      expect(verRep.ok).toBe(false);
      expect(verRep.errors.some((e: string) => /cellCount 50000 exceeds/i.test(e))).toBe(true);

      const cmpErr = createCaptureIo();
      expect(
        await runCli(["--core", coreMode, "compact", badSlotsDb, "--dry-run"], cmpErr.io),
      ).toBe(1);
      expect(cmpErr.stderr()).toContain("webdb recover");
    }
  });

  it("scales openReadOnlyDb and compact past the 1024-slot buffer pool limit (>1023 catalog pages)", async () => {
    const bigCatDb = join(workDir, "many-catalogs.db");
    // Build in MemoryStorage with 220 tables x 230 cols => 220 * 5 = 1100 col catalog pages (>1023)
    const bigDb = await WebDB.open({
      storage: new MemoryStorage(),
      engine: createEngine(),
      slotCount: 2048,
      crossTabSync: false,
    });
    const wideCols = Array.from({ length: 230 }, (_, c) => ({
      name: `c_${c}`,
      type: "INT32" as const,
    }));
    for (let t = 1; t <= 220; t++) {
      await bigDb.createTable(`mt_${t}`, wideCols);
    }
    await bigDb.insert("mt_1", { c_0: 7 });
    await writeFile(bigCatDb, await bigDb.exportBinary());
    await bigDb.close();

    const bigCap = createCaptureIo();
    expect(
      await runCli(
        ["--core", coreMode, "compact", bigCatDb, "--dry-run", "-f", "json"],
        bigCap.io,
      ),
    ).toBe(0);
    const bigRep = JSON.parse(bigCap.stdout());
    expect(bigRep.tablesCompacted).toBe(220);
    expect(bigRep.rowsCopied).toBe(1);
  });
});
