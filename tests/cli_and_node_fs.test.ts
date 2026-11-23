import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WebDB,
  encodeWalFileHeader,
  encodeWalFrame,
  WAL_FRAME_TYPE_PAGE_DATA,
  WAL_FRAME_TYPE_TX_COMMIT,
  PAGE_SIZE,
} from "@ahmadmoussawi/webdb/slim";
import { WasmEngine } from "@ahmadmoussawi/webdb/core/wasm";
import { JsEngine } from "@ahmadmoussawi/webdb/core/js";
import { MemoryStorage } from "@ahmadmoussawi/webdb/storage/memory";
import { NodeFsStorage } from "@ahmadmoussawi/webdb/storage/node";
import { runCli, type CliIo } from "@ahmadmoussawi/webdb/cli";

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
    expect(await runCli(["--core", coreMode, "info", fakePath], infoCap.io)).toBe(1);
    expect(infoCap.stderr()).toMatch(/smaller than|Invalid database/i);

    const tablesCap = createCaptureIo();
    expect(await runCli(["--core", coreMode, "tables", fakePath], tablesCap.io)).toBe(1);

    // checkpoint must fail AND leave the file completely untouched on disk
    const cpCap = createCaptureIo();
    expect(await runCli(["--core", coreMode, "checkpoint", fakePath], cpCap.io)).toBe(1);
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
      await expect(storage.writePages([{ pageId: 0, data: new Uint8Array(PAGE_SIZE) }])).rejects.toThrow(RangeError);
      await expect(storage.writePages([{ pageId: 1, data: new Uint8Array(100) }])).rejects.toThrow(RangeError);
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
    const tmp = await WebDB.open({ storage: mem, engine: createEngine(), initialData: baseBytes });
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
          { frameType: WAL_FRAME_TYPE_PAGE_DATA, flags: 0, txId: 1, pageId: p, dbSizePages: totalPages, frameSeq: seq++ },
          nextBytes.subarray((p - 1) * PAGE_SIZE, p * PAGE_SIZE),
        ),
      );
    }
    frames.push(
      encodeWalFrame({ frameType: WAL_FRAME_TYPE_TX_COMMIT, flags: 0, txId: 1, pageId: 0, dbSizePages: totalPages, frameSeq: seq++ }),
    );
    const walBuf = new Uint8Array(32 + frames.length * 4128);
    walBuf.set(walHdr, 0);
    for (let i = 0; i < frames.length; i++) walBuf.set(frames[i], 32 + i * 4128);
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
    await expect(roDb.insert("items", { id: 3, val: "should-fail" })).rejects.toThrow(/read-only/i);
    await roDb.close();

    // Disk files untouched
    expect(new Uint8Array(await readFile(dbPath))).toEqual(new Uint8Array(baseBytes));
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
    expect(await runCli(["--core", coreMode, "page", dbPath, String(rootPage), "--rows", "-f", "json"], cap.io)).toBe(0);
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
    expect(await runCli(["--core", coreMode, "page", corruptPath, String(rootPage), "--raw", "-f", "json"], rawLeaf.io)).toBe(0);
    const leafJson = JSON.parse(rawLeaf.stdout());
    expect(leafJson.cellCount).toBe(50000);
    expect(leafJson.cellOffsets).toHaveLength(2040);
    expect(leafJson.warnings.some((w: string) => w.includes("clamped"))).toBe(true);

    const rawP1 = createCaptureIo();
    expect(await runCli(["--core", coreMode, "page", corruptPath, "1", "--raw", "-f", "json"], rawP1.io)).toBe(0);
    expect(JSON.parse(rawP1.stdout()).checksumValid).toBe(false);
  });

  it("catches 0-byte DBs, totalPages=0, and WAL frame corruption in verify with exit code 1", async () => {
    // 1. 0-byte file emits valid JSON report with ok=false
    const emptyPath = join(workDir, "empty.db");
    await writeFile(emptyPath, new Uint8Array(0));
    const emptyCap = createCaptureIo();
    expect(await runCli(["--core", coreMode, "verify", emptyPath, "-f", "json"], emptyCap.io)).toBe(1);
    expect(JSON.parse(emptyCap.stdout()).ok).toBe(false);

    // 2. Corrupt WAL frame checksum causes verify to exit 1 with invalidFrames > 0
    const dbPath = join(workDir, "badwal.db");
    await createSampleDbFile(dbPath);
    const walPath = join(workDir, "badwal.wal");
    const hdr = encodeWalFileHeader({ checkpointSeq: 1 });
    const badFrame = encodeWalFrame(
      { frameType: WAL_FRAME_TYPE_TX_COMMIT, flags: 0, txId: 1, pageId: 0, dbSizePages: 1, frameSeq: 1 },
    );
    badFrame[40] ^= 0xff; // corrupt payload byte -> checksum mismatch
    const buf = new Uint8Array(32 + 4128);
    buf.set(hdr, 0);
    buf.set(badFrame, 32);
    await writeFile(walPath, buf);

    const walCap = createCaptureIo();
    expect(await runCli(["--core", coreMode, "verify", dbPath, "-f", "json"], walCap.io)).toBe(1);
    const report = JSON.parse(walCap.stdout());
    expect(report.ok).toBe(false);
    expect(report.wal.invalidFrames).toBe(1);
  });

  it("handles CLI parsing edge cases (ordered where/or-where, --limit '', explain --count, empty CSV/NDJSON, -- separator)", async () => {
    const dbPath = join(workDir, "edge.db");
    await createSampleDbFile(dbPath);

    // Empty --limit "" rejected with exit code 2
    const emptyLimit = createCaptureIo();
    expect(await runCli(["--core", coreMode, "query", dbPath, "users", "--limit", ""], emptyLimit.io)).toBe(2);

    // explain rejects --count with exit code 2
    const expCount = createCaptureIo();
    expect(await runCli(["--core", coreMode, "explain", dbPath, "users", "--count"], expCount.io)).toBe(2);

    // query --count --group-by rejected with exit code 2
    const grpCount = createCaptureIo();
    expect(await runCli(["--core", coreMode, "query", dbPath, "users", "-g", "dept", "--count"], grpCount.io)).toBe(2);

    // query --count --format csv respects format
    const csvCount = createCaptureIo();
    expect(await runCli(["--core", coreMode, "query", dbPath, "users", "--count", "-f", "csv"], csvCount.io)).toBe(0);
    expect(csvCount.stdout()).toBe("count\n4\n");

    // 0-row --select CSV uses projected headers only, and 0-row NDJSON emits empty output
    const emptyCsv = createCaptureIo();
    expect(
      await runCli(["--core", coreMode, "query", dbPath, "users", "-s", "name, score", "-w", "age > 999", "-f", "csv"], emptyCsv.io),
    ).toBe(0);
    expect(emptyCsv.stdout()).toBe("name,score\n");

    const emptyNdjson = createCaptureIo();
    expect(
      await runCli(["--core", coreMode, "query", dbPath, "users", "-w", "age > 999", "-f", "ndjson"], emptyNdjson.io),
    ).toBe(0);
    expect(emptyNdjson.stdout()).toBe("");

    // -- separator stops help flag parsing (info -- -h looks for file "-h" instead of printing help)
    const dashH = createCaptureIo();
    expect(await runCli(["info", "--", "-h"], dashH.io)).toBe(1);
    expect(dashH.stderr()).toContain("not found");
  });
});
