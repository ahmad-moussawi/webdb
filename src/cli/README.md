# WebDB CLI (`webdb`)

Inspect, query, verify, and dump WebDB binary database files (`.db` / `.webdb`) directly from your terminal—without writing JavaScript or requiring a SQL parser in the browser engine.

The CLI ships as a Node.js-only binary (`dist/cli.js`) alongside the `@ahmadmoussawi/webdb/storage/node` (`NodeFsStorage`) and `@ahmadmoussawi/webdb/cli` subpath exports, keeping browser bundles completely untouched.

---

## Requirements & Invocation

- **Node.js 20+**
- Works with both **exported browser snapshots** (`db.exportBinary()` / WebDB Studio downloads) and **Node.js filesystem databases** created with `NodeFsStorage`.

```bash
# After installing @ahmadmoussawi/webdb in a project
npx webdb --help

# Or if installed globally
npm install -g @ahmadmoussawi/webdb
webdb --help

# Inside this repository (after `npm run build`)
npm run cli -- --help
./dist/cli.js --help
```

---

## Read-Only Safety & WAL Handling

Every inspection and query command (`info`, `tables`, `schema`, `indexes`, `query`, `explain`, `page`, `verify`, `dump`) opens the database **strictly read-only**:

- It never creates an empty `.wal` file if one does not exist.
- If a companion `.wal` file has pending committed frames on disk, the CLI replays them **strictly in memory** via `ReadOnlyOverlayVfs` so queries reflect the latest committed state without modifying a single byte of your `.db` or `.wal` files.
- Only `webdb checkpoint <file>` opens the database read-write to fold committed WAL frames into the main `.db` file.

---

## Global Options

| Flag                | Description                                                                        |
| :------------------ | :--------------------------------------------------------------------------------- |
| `--core <wasm\|js>` | Execution engine core (`wasm` by default, or `js` for the pure-JS VM interpreter). |
| `-h`, `--help`      | Show usage and command summary.                                                    |
| `-v`, `--version`   | Print CLI version.                                                                 |

---

## Commands

### `info <file>`

Displays the Page 1 binary header, format version, schema version, change counter, Page 1 CRC32 status, table/index counts, WAL status, and a per-page-type storage breakdown.

```bash
webdb info app.db
webdb info app.db --format json
```

Example output:

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

### `tables <file>`

Lists all tables in the catalog with column counts, primary keys, index counts, and root page IDs.

```bash
webdb tables app.db
webdb tables app.db --exact-count
webdb tables app.db --format csv
```

| Flag                                      | Description                                                         |
| :---------------------------------------- | :------------------------------------------------------------------ |
| `--exact-count`                           | Runs `COUNT(*)` per table instead of displaying `rowCountEstimate`. |
| `-f, --format <table\|json\|ndjson\|csv>` | Output format (default: `table`).                                   |

---

### `schema <file> [table]`

Shows column definitions (index, name, data type, flags such as `PK`, `NOT NULL`, `AUTO_INC`, `INDEXED`, fixed-slice byte offset) and indexes for one table or all tables.

```bash
webdb schema app.db
webdb schema app.db users
webdb schema app.db users --format json
```

---

### `indexes <file> [table]`

Lists all secondary/unique indexes across the database or for a specific table, with resolved column names and `ASC`/`DESC` sort directions.

```bash
webdb indexes app.db
webdb indexes app.db users --format json
```

---

### `query <file> <table> [options]`

Queries rows without writing JavaScript by mapping flags directly onto WebDB's `QueryBuilder` and expression parser (`parseSelectExpr` / `parseExpression`).

```bash
# Filter, compute expressions, sort, and limit
webdb query app.db users \
  -s "name, age, score * 2 as doubled, concat(name, '!') as label" \
  -w "age >= 21" \
  -w "score > 80" \
  -o "score desc" \
  -l 10

# Group by and aggregate
webdb query app.db users \
  -s "dept, count(*) as cnt, avg(score) as avg_score" \
  -g dept \
  --having "count(*) >= 2" \
  -o "avg_score desc"

# Join two tables
webdb query app.db users \
  --join "orders:users.id=orders.user_id" \
  -s "users.name as customer, orders.amount as amount" \
  -o "orders.id asc"

# Count matching rows only
webdb query app.db users -w "age >= 21" --count

# Machine-readable output
webdb query app.db users --format json
webdb query app.db users --format ndjson
webdb query app.db users --format csv
```

| Flag                                      | Description                                                                                                                      |
| :---------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------- |
| `-s, --select <expr>`                     | Comma-separated columns or expressions with optional `AS alias` (repeatable; commas inside function calls/quotes are preserved). |
| `-w, --where <expr>`                      | Filter expression, AND-ed across repeated flags (e.g. `-w "age >= 21" -w "lower(dept) = 'eng'"`).                                |
| `--or-where <expr>`                       | Filter expression, OR-ed (repeatable).                                                                                           |
| `--join <table>:<l><op><r>`               | `INNER JOIN` specification, e.g. `orders:users.id=orders.user_id` (repeatable).                                                  |
| `--left-join <table>:<l><op><r>`          | `LEFT JOIN` specification (repeatable).                                                                                          |
| `-g, --group-by <cols>`                   | Comma-separated `GROUP BY` columns/expressions (repeatable).                                                                     |
| `--having <expr>`                         | `HAVING` filter expression (repeatable).                                                                                         |
| `-o, --order <spec>`                      | `ORDER BY` clause (`col`, `col:desc`, `col desc`, `col desc nulls last`; repeatable or comma-separated).                         |
| `-l, --limit <n>`                         | Maximum rows to return.                                                                                                          |
| `--offset <n>`                            | Rows to skip before returning results.                                                                                           |
| `--count`                                 | Output only the count of matching rows.                                                                                          |
| `-f, --format <table\|json\|ndjson\|csv>` | Output format (default: `table`).                                                                                                |

---

### `explain <file> <table> [query options]`

Accepts the query flags from `query` (except `--count`, which is query-only, and with `--format table|json`) and prints the chosen query plan (`TableScan` vs `IndexScan`, index name, order satisfaction) along with the full VDBE bytecode disassembly.

```bash
webdb explain app.db users -w "score > 80" -o "score desc"
webdb explain app.db users -w "score > 80" --format json
```

---

### `page <file> <pageId> [options]`

Low-level 4 KB slotted-page inspector (CLI counterpart to WebDB Studio's page inspector).

```bash
# Inspect Page 1 (header + master catalog)
webdb page app.db 1

# Inspect a table leaf page, decode its rows, and print a hex+ASCII dump
webdb page app.db 3 --rows --hex

# Read raw page bytes directly from .db without WAL overlay
webdb page app.db 3 --raw --format json
```

| Flag                         | Description                                                                       |
| :--------------------------- | :-------------------------------------------------------------------------------- |
| `--rows`                     | For `LEAF_DATA` pages, resolve the owning table and decode each slotted row.      |
| `--hex`                      | Print a `hexdump -C` style hex + ASCII view (collapsing repeated lines with `*`). |
| `--raw`                      | Read directly from `.db` on disk, bypassing the in-memory WAL overlay.            |
| `-f, --format <table\|json>` | Output format (default: `table`).                                                 |

---

### `verify <file>`

Performs a full binary integrity check across the `.db` file and any companion `.wal` file:

- Validates file size alignment (multiple of 4,096 bytes)
- Validates Page 1 magic bytes (`WEBDB\0`), page size, version handshake, `totalPages`, and Page 1 CRC32
- Validates IEEE 802.3 CRC32 checksums and page types for all pages `2..totalPages`
- Validates WAL header (`WEBWAL` + CRC32), frame checksums, and sequence numbers when a `.wal` file is present

Returns exit code `0` when valid and `1` if corruption is detected.

```bash
webdb verify app.db
webdb verify app.db --format json
```

---

### `dump <file> [table] [options]`

Exports a single table (`json`, `ndjson`, or `csv`) or the entire database (`json` containing schemas and rows for every table) to stdout or a file.

```bash
# Dump entire database as JSON
webdb dump app.db --out backup.json

# Dump one table as CSV
webdb dump app.db users --format csv --out users.csv

# Stream one table as NDJSON to stdout
webdb dump app.db orders --format ndjson
```

---

### `checkpoint <file>`

Replays committed frames from the companion `.wal` file into the main `.db` file and resets the WAL to 0 frames. This is the only command that writes to disk.

```bash
webdb checkpoint app.db
webdb checkpoint app.db --format json
```

---

## Using `NodeFsStorage` & Programmatic CLI in Node.js

You can also use the Node filesystem adapter or invoke the CLI programmatically from TypeScript/JavaScript:

```typescript
import { WebDB } from "@ahmadmoussawi/webdb/slim";
import { WasmEngine } from "@ahmadmoussawi/webdb/core/wasm";
import { NodeFsStorage } from "@ahmadmoussawi/webdb/storage/node";

const db = await WebDB.open({
  engine: new WasmEngine(),
  storage: new NodeFsStorage("./data/app.db"),
});

await db.createTableIfNotExists("users", [
  { name: "id", type: "INT32", primaryKey: true },
  { name: "name", type: "TEXT", notNull: true },
]);
await db.upsert("users", { id: 1, name: "Alice" });
await db.close();
```

Programmatic CLI invocation (`@ahmadmoussawi/webdb/cli`):

```typescript
import { runCli } from "@ahmadmoussawi/webdb/cli";

const exitCode = await runCli(["tables", "./data/app.db", "--format", "json"]);
```

---

## Exit Codes

| Code | Meaning                                                                      |
| :--- | :--------------------------------------------------------------------------- |
| `0`  | Success (or `verify` passed with no errors).                                 |
| `1`  | Runtime error (missing file, query error, corrupt page, or `verify` failed). |
| `2`  | CLI usage error (unknown command, unknown flag, or invalid argument).        |

---

## Limitations & Node.js Scope

- **Browser-first engine (not a server DB replacement):** WebDB is built primarily for web browsers. Node.js 20+ support (`MemoryStorage`, this CLI, and experimental `NodeFsStorage`) is designed for testing, SSR, build-time `.db` snapshot generation, and local single-process tooling—not as a server-side replacement for SQLite or other multi-process database engines.
- **Single-process writes only:** `NodeFsStorage` does not use OS-level file locks (`flock`). Do not open the same `.db` file for writing from multiple processes concurrently.
- **Browser storage access:** The CLI operates on local `.db` / `.webdb` files. To inspect a browser app's IndexedDB or OPFS database, export it first via `db.exportBinary()` (or download a snapshot from WebDB Studio).
- **Custom JS UDFs:** Built-in scalar and aggregate functions work out of the box, while application-registered JS UDFs (`registerFunction`) are not available in standalone CLI queries.
