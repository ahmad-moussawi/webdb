# Command-Line Interface (`webdb`)

WebDB ships with a zero-dependency Node.js CLI (`webdb`) and filesystem storage adapter (`NodeFsStorage`) so you can inspect schemas, run queries, disassemble VDBE bytecode, examine raw 4 KB slotted pages, verify CRC32 checksums, and export data—**without writing JavaScript**.

Because the CLI lives in a dedicated Node-only build (`dist/cli.js`), browser bundles keep WebDB's tiny ~19 KB gzipped WASM footprint with zero CLI or Node.js overhead.

---

## Installation & Running the CLI

The `webdb` binary is bundled with `@ahmadmoussawi/webdb` (requires **Node.js 20+**):

```bash
# Run locally in a project that has @ahmadmoussawi/webdb installed
npx webdb --help

# Or install globally
npm install -g @ahmadmoussawi/webdb
webdb --help
```

> [!TIP]
> **Inspecting Browser Databases:** WebDB's browser storage (`IdbStorage` / `OpfsStorage`) lives inside the browser sandbox. To inspect a browser database from the terminal, export a snapshot with `await db.exportBinary()` (see [Binary Snapshots & Backups](/guides/snapshots-and-backups)) or download a `.webdb` file from [WebDB Studio](https://studio.webdb.dev/), then pass that file directly to `webdb`.

---

## Read-Only Guarantee & WAL Safety

All inspection and query commands open database files **strictly read-only**:

- They never modify `.db` / `.webdb` files or create stray `.wal` files.
- If a companion `.wal` file contains uncheckpointed committed frames, the CLI automatically replays them **in memory only**, so `info`, `tables`, `query`, and `page` show the exact committed state without mutating disk files.
- Use `webdb checkpoint <file>` only when you explicitly want to fold committed WAL frames into the main `.db` file.

---

## Command Reference & Examples

### 1. Inspect Database Overview (`info`)

View the Page 1 file header, format version, schema version, change counter, Page 1 CRC32 status, WAL state, and page-type distribution:

```bash
webdb info app.db
webdb info app.db --format json
```

```text
File            : app.db (28.0 KB)
Format Version  : 1 (min read: 1)
Page Size       : 4096 bytes
Total Pages     : 7 (28.0 KB)
Free Page Head  : 0 (none)
Schema Version  : 4
Change Counter  : 12
Page 1 Checksum : 0x8f31c9a2 (valid)
Tables          : 2
Indexes         : 1
WAL Status      : none

┌────────────────┬───────┬─────────┐
│ page_type      │ pages │ size    │
├────────────────┼───────┼─────────┤
│ HEADER_CATALOG │     1 │ 4.0 KB  │
│ CATALOG_PAGE   │     2 │ 8.0 KB  │
│ LEAF_DATA      │     3 │ 12.0 KB │
│ INDEX_LEAF     │     1 │ 4.0 KB  │
└────────────────┴───────┴─────────┘
```

---

### 2. List Tables, Schemas & Indexes (`tables`, `schema`, `indexes`)

```bash
# List all tables (use --exact-count to run COUNT(*) per table)
webdb tables app.db --exact-count

# Show detailed columns, types, flags (PK, NOT NULL, AUTO_INC, INDEXED), and indexes
webdb schema app.db
webdb schema app.db users

# List all indexes (or filter to one table)
webdb indexes app.db
webdb indexes app.db users --format json
```

Example `schema` output:

```text
Table: users (id=1, rootPage=3, catalogPage=2, estRows=4, autoIncNext=1)
┌───┬───────┬─────────┬──────────────┬────────┐
│ # │ name  │ type    │ flags        │ offset │
├───┼───────┼─────────┼──────────────┼────────┤
│ 0 │ id    │ INT32   │ PK, NOT NULL │      0 │
│ 1 │ name  │ TEXT    │ NOT NULL     │      4 │
│ 2 │ age   │ INT32   │ -            │      8 │
│ 3 │ score │ FLOAT64 │ INDEXED      │     12 │
└───┴───────┴─────────┴──────────────┴────────┘
Indexes:
┌────┬─────────────────┬───────────┬───────┬───────────┐
│ id │ name            │ columns   │ flags │ root_page │
├────┼─────────────────┼───────────┼───────┼───────────┤
│  1 │ idx_users_score │ score ASC │ -     │         4 │
└────┴─────────────────┴───────────┴───────┴───────────┘
```

---

### 3. Query Data Without Writing JS (`query`)

`webdb query` compiles CLI flags directly into WebDB's `QueryBuilder` and expression parser—supporting expressions, aliases, `WHERE` / `OR WHERE`, `JOIN` / `LEFT JOIN`, `GROUP BY`, `HAVING`, `ORDER BY`, `LIMIT`, `OFFSET`, and multiple output formats.

#### Filtering, Expressions & Sorting

```bash
webdb query app.db users \
  --select "name, age, score * 2 as doubled, concat(name, '!') as label" \
  --where "age >= 21" \
  --where "score > 80" \
  --order "score desc" \
  --limit 10
```

#### Aggregations & `GROUP BY`

```bash
webdb query app.db users \
  -s "dept, count(*) as total, max(score) as top_score" \
  -g dept \
  --having "count(*) >= 2" \
  -o "top_score desc"
```

#### Joins

Join syntax uses `<table>:<leftCol><op><rightCol>` (supporting `=`, `!=`, `<`, `<=`, `>`, `>=`):

```bash
webdb query app.db users \
  --join "orders:users.id=orders.user_id" \
  -s "users.name as customer, orders.amount as amount" \
  -o "orders.id asc"
```

#### Counting & Machine-Readable Output

```bash
# Fast count of matching rows
webdb query app.db users -w "age >= 21" --count

# Output as JSON, newline-delimited JSON, or CSV
webdb query app.db users --format json
webdb query app.db users --format ndjson
webdb query app.db users --format csv
```

| Option                        | Short | Repeatable | Description                                                      |
| :---------------------------- | :---- | :--------- | :--------------------------------------------------------------- |
| `--select <expr>`             | `-s`  | Yes        | Comma-separated columns or expressions with optional `AS alias`. |
| `--where <expr>`              | `-w`  | Yes        | Filter expression, AND-ed across flags.                          |
| `--or-where <expr>`           | —     | Yes        | Filter expression, OR-ed.                                        |
| `--join <table>:<l>=<r>`      | —     | Yes        | `INNER JOIN` specification.                                      |
| `--left-join <table>:<l>=<r>` | —     | Yes        | `LEFT JOIN` specification.                                       |
| `--group-by <cols>`           | `-g`  | Yes        | Comma-separated `GROUP BY` columns/expressions.                  |
| `--having <expr>`             | —     | Yes        | `HAVING` filter expression.                                      |
| `--order <spec>`              | `-o`  | Yes        | Sort spec (`score desc`, `score:desc`, `score desc nulls last`). |
| `--limit <n>`                 | `-l`  | No         | Maximum number of rows to return.                                |
| `--offset <n>`                | —     | No         | Number of rows to skip.                                          |
| `--count`                     | —     | No         | Print only the matching row count.                               |
| `--format <fmt>`              | `-f`  | No         | `table` (default), `json`, `ndjson`, or `csv`.                   |

---

### 4. Inspect Query Plans & VDBE Bytecode (`explain`)

`explain` accepts the exact same flags as `query` and prints the planner decision (`TableScan` vs `IndexScan`, index name, sort avoidance) plus the disassembled VDBE bytecode:

```bash
webdb explain app.db users -w "score > 80" -o "score desc"
webdb explain app.db users -w "score > 80" --format json
```

```text
Table         : users
Root Page     : 3
Scan Type     : IndexScan
Index         : idx_users_score
Filters       : 1
Order By      : score DESC
Bytecode Size : 64 bytes (8 ops)

ADDR     OPCODE             P1           P2                   P3         COMMENT
-----------------------------------------------------------------------------------------------
0x0000   OP_OPEN_INDEX      0            4                    0          ...
...
```

---

### 5. Inspect Raw 4 KB Slotted Pages (`page`)

Examine any page directly—similar to the binary page inspector in WebDB Studio:

```bash
# Inspect Page 1 (file header + catalog summary)
webdb page app.db 1

# Inspect a table LEAF_DATA page, decode its rows, and show a hex + ASCII dump
webdb page app.db 3 --rows --hex

# Inspect raw .db bytes bypassing any WAL overlay
webdb page app.db 3 --raw --format json
```

---

### 6. Verify Binary Integrity (`verify`)

Validates file alignment (4,096-byte multiples), Page 1 magic bytes (`WEBDB\0`), format version, page count, IEEE 802.3 CRC32 checksums on every page, and WAL header/frame checksums if a `.wal` file is present:

```bash
webdb verify app.db
webdb verify app.db --format json
```

Exits with code `0` when valid and `1` if any corruption is detected—making it easy to run in CI pipelines or backup checks.

---

### 7. Dump Data to JSON, NDJSON, or CSV (`dump`)

```bash
# Dump the entire database (schemas + rows for every table) to a JSON file
webdb dump app.db --out backup.json

# Export a single table to CSV
webdb dump app.db users --format csv --out users.csv

# Stream a table as NDJSON to stdout (great for piping to jq)
webdb dump app.db orders --format ndjson | jq '.amount'
```

---

### 8. Checkpoint a WAL File (`checkpoint`)

Folds committed frames from `<name>.wal` into `<name>.db` and resets the WAL to 0 frames:

```bash
webdb checkpoint app.db
```

> [!WARNING]
> `checkpoint` is the only CLI command that writes to disk. Avoid running it while another Node.js process has the same `.db` file open for writing.

---

### 9. Switching Engine Core (`--core`)

By default, the CLI runs queries on WebDB's WASM core (`--core wasm`). You can switch to the pure-JS VM interpreter for differential debugging or environments without WebAssembly:

```bash
webdb --core js query app.db users -w "score >= 90"
```

---

## Using `NodeFsStorage` Directly in Node.js

The same filesystem adapter that powers the CLI is exported at `@ahmadmoussawi/webdb/storage/node` (experimental):

```typescript
import { WebDB } from "@ahmadmoussawi/webdb/slim";
import { WasmEngine } from "@ahmadmoussawi/webdb/core/wasm";
import { NodeFsStorage } from "@ahmadmoussawi/webdb/storage/node";

const db = await WebDB.open({
  engine: new WasmEngine(),
  storage: new NodeFsStorage("./data/app.db", {
    // Optional: readOnly: true, create: true, walPath: './data/app.wal'
  }),
});

await db.createTableIfNotExists("users", [
  { name: "id", type: "INT32", primaryKey: true },
  { name: "name", type: "TEXT", notNull: true },
  { name: "score", type: "FLOAT64" },
]);

await db.upsert("users", { id: 1, name: "Alice", score: 95.5 });
await db.close();
```

> [!IMPORTANT]
> **Node.js Positioning:** WebDB is built **primarily for web browsers**. Node.js 20+ support (`MemoryStorage`, the `webdb` CLI, and experimental `NodeFsStorage`) is meant for **testing, SSR, build-time `.db` snapshot generation, and single-process tooling**—not as a server-side replacement for SQLite, PostgreSQL, or other multi-process database engines. `NodeFsStorage` has no OS-level multi-process file locking (`flock`), so only one process should write to a `.db` file at a time.

You can then immediately inspect `./data/app.db` from the terminal:

```bash
webdb info ./data/app.db
webdb query ./data/app.db users
```

### Programmatic CLI Execution

If you want to embed CLI commands into your own scripts or test suites, import `runCli` from `@ahmadmoussawi/webdb/cli`:

```typescript
import { runCli } from "@ahmadmoussawi/webdb/cli";

let output = "";
const exitCode = await runCli(
  ["query", "./data/app.db", "users", "--format", "json"],
  {
    stdout: (chunk) => {
      output += chunk;
    },
    stderr: (chunk) => process.stderr.write(chunk),
  },
);

console.log(exitCode, JSON.parse(output));
```

---

## Exit Codes

| Exit Code | Meaning                                                                                |
| :-------- | :------------------------------------------------------------------------------------- |
| `0`       | Command succeeded (`verify` found zero errors).                                        |
| `1`       | Runtime or data error (file not found, query error, corrupt page, or `verify` failed). |
| `2`       | CLI usage error (unknown command, unknown flag, or invalid argument value).            |
