# Complete API Reference

This page provides a concise reference for all public classes, methods, and helpers exported by `@ahmadmoussawi/webdb`.

```typescript
import {
  WebDB,
  QueryBuilder,
  DataType,
  col,
  fn,
  exp,
  sql,
  CostBasedPlanner,
  HeuristicPlanner,
  CustomOrderPlanner,
  NoOpPlanner,
  CustomPlanner,
} from "@ahmadmoussawi/webdb";
```

---

## 1. `WebDB` Instance Methods

### Lifecycle & Configuration

| Method                | Signature                                                      | Description                                                                               |
| :-------------------- | :------------------------------------------------------------- | :---------------------------------------------------------------------------------------- |
| **`WebDB.open`**      | `static open(options: WebDbOptions): Promise<WebDB>`           | Opens or creates a database, runs crash recovery if needed, and loads the schema catalog. |
| **`db.close`**        | `close(): Promise<void>`                                       | Flushes dirty pages, closes cross-tab channels, and releases storage handles.             |
| **`db.checkpoint`**   | `checkpoint(): Promise<{ pagesWritten: number }>`              | Forces an immediate WAL checkpoint to main storage and truncates the `.wal` file.         |
| **`db.exportBinary`** | `exportBinary(): Promise<Uint8Array>`                          | Exports the entire database as a self-contained binary image with CRC32 checksums.        |
| **`db.importBinary`** | `importBinary(data: Uint8Array \| ArrayBuffer): Promise<void>` | Validates checksums and atomically replaces the database with a binary image.             |
| **`db.getPlanner`**   | `getPlanner(): QueryPlanner \| undefined`                      | Returns the configured default query planner.                                             |
| **`db.setPlanner`**   | `setPlanner(planner?: QueryPlanner): this`                     | Sets the default query planner for subsequent queries.                                    |

---

### Schema & DDL (`CREATE`, `ALTER`, `DROP`)

| Method                | Signature                                                                                            | Description                                                                   |
| :-------------------- | :--------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------- |
| **`db.createTable`**  | `createTable(name: string, columns: ColumnDefinition[]): Promise<TableMeta>`                         | Creates a new table and persists its schema.                                  |
| **`db.getTable`**     | `getTable(tableName: string): Promise<TableMeta>`                                                    | Returns metadata for `tableName` (throws `TableNotFoundError` if missing).    |
| **`db.listTables`**   | `listTables(): Promise<TableMeta[]>`                                                                 | Lists metadata for all tables in the database.                                |
| **`db.dropTable`**    | `dropTable(tableName: string): Promise<void>`                                                        | Drops a table, frees its pages, and removes all of its indexes.               |
| **`db.renameTable`**  | `renameTable(oldName: string, newName: string): Promise<TableMeta>`                                  | Renames a table in $O(1)$ time and updates auto-named indexes.                |
| **`db.renameColumn`** | `renameColumn(tableName: string, oldCol: string, newCol: string): Promise<TableMeta>`                | Renames a column in $O(1)$ time while preserving all indexes.                 |
| **`db.addColumn`**    | `addColumn(tableName: string, column: ColumnDefinition, defaultValue?: DbValue): Promise<TableMeta>` | Adds a column and populates existing rows with `defaultValue` (or `null`).    |
| **`db.dropColumn`**   | `dropColumn(tableName: string, columnName: string): Promise<TableMeta>`                              | Drops a non-PK column and rebuilds rows and surviving indexes atomically.     |
| **`db.alterTable`**   | `alterTable(tableName: string, op: AlterTableOperation): Promise<TableMeta>`                         | Unified API for `renameTable`, `renameColumn`, `addColumn`, and `dropColumn`. |

---

### Indexing

| Method               | Signature                                                                                                       | Description                                                                                      |
| :------------------- | :-------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------- |
| **`db.createIndex`** | `createIndex(tableName: string, columns: string \| string[], options?: IndexOptions): Promise<IndexDescriptor>` | Creates a single-column or composite (up to 8 cols) B+Tree index, optionally `{ unique: true }`. |
| **`db.dropIndex`**   | `dropIndex(indexName: string): Promise<void>`                                                                   | Drops a secondary index and frees its pages.                                                     |
| **`db.listIndexes`** | `listIndexes(tableName?: string): Promise<IndexDescriptor[]>`                                                   | Lists all indexes in the database, or only those on `tableName`.                                 |

---

### Data Manipulation (`INSERT`, `UPDATE`, `DELETE`, `UPSERT`)

| Method              | Signature                                                                                                                            | Description                                                                               |
| :------------------ | :----------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------- |
| **`db.insert`**     | `insert(table: string, row: DbRow, options?: TransactionOptions): Promise<void>`                                                     | Inserts a single record.                                                                  |
| **`db.insertMany`** | `insertMany(table: string, rows: DbRow[], options?: TransactionOptions): Promise<void>`                                              | Bulk-inserts an array of records in one atomic pass.                                      |
| **`db.update`**     | `update(table: string, pkOrFilter: DbValue \| Partial<DbRow>, patch: Partial<DbRow>, options?: TransactionOptions): Promise<number>` | Updates row(s) by primary key value or equality filter object. Returns updated row count. |
| **`db.delete`**     | `delete(table: string, pkOrFilter: DbValue \| Partial<DbRow>, options?: TransactionOptions): Promise<number>`                        | Deletes row(s) by primary key value or equality filter object. Returns deleted row count. |
| **`db.upsert`**     | `upsert(table: string, row: DbRow, options?: UpsertOptions): Promise<'inserted' \| 'updated' \| 'ignored'>`                          | Inserts or resolves conflict according to `conflictTarget`, `mode`, and `where` guard.    |
| **`db.upsertMany`** | `upsertMany(table: string, rows: DbRow[], options?: UpsertOptions): Promise<{ inserted: number; updated: number; ignored: number }>` | Batch upserts multiple rows atomically and returns summary counts.                        |

---

### Transactions, Reactivity, Sync & UDFs

| Method                    | Signature                                                                                         | Description                                                                                              |
| :------------------------ | :------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------- |
| **`db.from`**             | `from(tableOrSubquery: string \| QueryBuilder): QueryBuilder`                                     | Starts a fluent query on a table name or a derived-table `QueryBuilder` subquery.                        |
| **`db.transaction`**      | `transaction<T>(cb: (tx: WebDB) => Promise<T>, options?: TransactionOptions): Promise<T>`         | Runs `cb` inside an ACID transaction (or nested savepoint if called on `tx`).                            |
| **`db.onBeforeCommit`**   | `onBeforeCommit(hook: (changeset: Changeset, tx: WebDB) => Promise<void> \| void): () => void`    | Registers a pre-commit hook inside the active transaction lease. Returns an unsubscribe function.        |
| **`db.onCommit`**         | `onCommit(hook: (changeset: Changeset) => void): () => void`                                      | Registers a post-commit hook fired after WAL durability. Returns an unsubscribe function.                |
| **`db.subscribe`**        | `subscribe(tables: string \| string[] \| '*', cb: (event: TableChangeEvent) => void): () => void` | Subscribes to local and cross-tab (`BroadcastChannel`) table mutations. Returns an unsubscribe function. |
| **`db.getSyncState`**     | `getSyncState(): { changeCounter: number; schemaVersion: number }`                                | Returns current Page 1 `changeCounter` and `schemaVersion`.                                              |
| **`db.registerFunction`** | `registerFunction(name: string, def: UdfDefinition \| ((...args: any[]) => any)): this`           | Registers a custom synchronous JavaScript UDF callable in queries.                                       |

---

## 2. `QueryBuilder` Methods (`db.from(table)`)

### Projection & Joins

| Method                                         | Description                                                                                                                                                                              |
| :--------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`.select(...items)`**                        | Projects column names, `'expr as alias'` strings, `{ col, as }` specs, `{ col: 'alias' }` maps, `ExpressionBuilder` nodes, or scalar `QueryBuilder` subqueries (`subquery.as('alias')`). |
| **`.as(alias)`**                               | Aliases a `QueryBuilder` instance for use as a scalar subquery inside an outer `.select()`.                                                                                              |
| **`.join(table, leftCol, op?, rightCol)`**     | Adds an `INNER JOIN` (alias: `.innerJoin()`). If `op` is omitted, defaults to `'='`.                                                                                                     |
| **`.leftJoin(table, leftCol, op?, rightCol)`** | Adds a `LEFT OUTER JOIN`. Unmatched inner columns evaluate to `null`.                                                                                                                    |

### Filtering (`WHERE`)

| Method                                     | `OR` Variant                  | Description                                                                                                                                                                                                                     |
| :----------------------------------------- | :---------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`.where(col, op, val)`**                 | **`.orWhere(...)`**           | Adds a comparison filter (`=`, `!=`, `<`, `<=`, `>`, `>=`, `like`, `in`, etc.) against a scalar value or scalar `QueryBuilder` subquery. Also accepts an expression string, `{ col: val }` map, or nested `(qb) => void` group. |
| **`.whereNot(col, op, val)`**              | **`.orWhereNot(...)`**        | Negates a condition or nested `(qb) => void` filter group.                                                                                                                                                                      |
| **`.whereIn(col, values \| subquery)`**    | **`.orWhereIn(...)`**         | Matches rows where `col` is in `values` (up to 10,000 items) or in a `QueryBuilder` subquery result.                                                                                                                            |
| **`.whereNotIn(col, values \| subquery)`** | **`.orWhereNotIn(...)`**      | Matches rows where `col` is not in `values` or not in a `QueryBuilder` subquery result.                                                                                                                                         |
| **`.whereExists(subquery)`**               | **`.orWhereExists(...)`**     | Matches rows where `subquery` returns at least one row (`EXISTS (...)`).                                                                                                                                                        |
| **`.whereNotExists(subquery)`**            | **`.orWhereNotExists(...)`**  | Matches rows where `subquery` returns zero rows (`NOT EXISTS (...)`).                                                                                                                                                           |
| **`.whereNull(col)`**                      | **`.orWhereNull(col)`**       | Matches rows where `col IS NULL`.                                                                                                                                                                                               |
| **`.whereNotNull(col)`**                   | **`.orWhereNotNull(col)`**    | Matches rows where `col IS NOT NULL`.                                                                                                                                                                                           |
| **`.whereLike(col, pattern)`**             | **`.orWhereLike(...)`**       | SQL `LIKE` pattern match (`%` and `_` wildcards).                                                                                                                                                                               |
| **`.whereNotLike(col, pattern)`**          | **`.orWhereNotLike(...)`**    | Negated SQL `NOT LIKE` pattern match.                                                                                                                                                                                           |
| **`.whereStartsWith(col, prefix)`**        | **`.orWhereStartsWith(...)`** | Matches strings starting with `prefix`.                                                                                                                                                                                         |
| **`.whereEndsWith(col, suffix)`**          | **`.orWhereEndsWith(...)`**   | Matches strings ending with `suffix`.                                                                                                                                                                                           |
| **`.whereContains(col, substr)`**          | **`.orWhereContains(...)`**   | Matches strings containing `substr`.                                                                                                                                                                                            |
| **`.whereRaw(sqlExpr)`**                   | **`.orWhereRaw(sqlExpr)`**    | Alias for `.where(sqlExpr)`.                                                                                                                                                                                                    |

### Grouping, Aggregations & `HAVING`

| Method                              | Description                                                                                                            |
| :---------------------------------- | :--------------------------------------------------------------------------------------------------------------------- |
| **`.groupBy(...cols)`**             | Groups rows by up to 8 columns or expressions.                                                                         |
| **`.count(col?, alias?)`**          | Adds a `COUNT(*)` or `COUNT(col)` aggregate.                                                                           |
| **`.sum(col, alias?)`**             | Adds a `SUM(col)` aggregate.                                                                                           |
| **`.avg(col, alias?)`**             | Adds an `AVG(col)` aggregate.                                                                                          |
| **`.min(col, alias?)`**             | Adds a `MIN(col)` aggregate.                                                                                           |
| **`.max(col, alias?)`**             | Adds a `MAX(col)` aggregate.                                                                                           |
| **`.having(colOrExpr, op?, val?)`** | Filters aggregated groups (also `.orHaving()`, `.havingNot()`, `.orHavingNot()`, `.havingNull()`, `.havingNotNull()`). |

### Sorting, Pagination & Execution

| Method                                      | Description                                                                                         |
| :------------------------------------------ | :-------------------------------------------------------------------------------------------------- |
| **`.orderBy(colOrExpr, dir?, nullOrder?)`** | Sorts results (`'asc'` or `'desc'`, optional `'nulls_first'` or `'nulls_last'`).                    |
| **`.limit(count)`**                         | Caps the maximum number of returned rows.                                                           |
| **`.offset(count)`**                        | Skips the first `count` rows before emitting results.                                               |
| **`.withPlanner(planner)`**                 | Overrides the query planner for this specific query.                                                |
| **`.toArray()`**                            | Executes the query and returns `Promise<DbRow[]>`.                                                  |
| **`.first()`**                              | Executes with `limit(1)` and returns `Promise<DbRow \| null>`.                                      |
| **`.update(patch, options?)`**              | Updates all rows matching the query's `WHERE` filters and returns `Promise<number>`.                |
| **`.delete(options?)`**                     | Deletes all rows matching the query's `WHERE` filters and returns `Promise<number>`.                |
| **`.explain()`**                            | Compiles and returns `Promise<ExplainOutput>` (`plan`, `bytecodeSize`, `instructions`, `assembly`). |
