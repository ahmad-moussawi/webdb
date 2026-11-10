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

| Method                          | Signature                                                                                            | Description                                                                                       |
| :------------------------------ | :--------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------ |
| **`db.createTable`**            | `createTable(name: string, columns: ColumnDefinition[]): Promise<TableMeta>`                         | Creates a new table and persists its schema.                                                      |
| **`db.createTableIfNotExists`** | `createTableIfNotExists(name: string, columns: ColumnDefinition[]): Promise<TableMeta>`             | Idempotently creates a table if absent; returns existing metadata without error if present.       |
| **`db.getTable`**               | `getTable(tableName: string): Promise<TableMeta>`                                                    | Returns metadata for `tableName` (throws `TableNotFoundError` if missing).                        |
| **`db.hasTable`**               | `hasTable(tableName: string): Promise<boolean>`                                                     | Checks whether a table exists in the database catalog.                                           |
| **`db.getTableNames`**          | `getTableNames(): Promise<string[]>`                                                                 | Returns list of all active table names in $O(1)$ time without decoding column descriptor chains.  |
| **`db.hasColumn`**              | `hasColumn(tableName: string, columnName: string): Promise<boolean>`                                 | Checks whether a column exists on a table (returns `false` if table is absent).                   |
| **`db.hasIndex`**               | `hasIndex(tableName: string, indexOrCols: string \| string[]): Promise<boolean>`                    | Checks whether an index exists by name or column sequence.                                        |
| **`db.listTables`**             | `listTables(): Promise<TableMeta[]>`                                                                 | Lists full metadata for all tables in the database.                                              |
| **`db.dropTable`**              | `dropTable(tableName: string): Promise<void>`                                                        | Drops a table, frees its pages, and removes all of its indexes.                                   |
| **`db.dropTableIfExists`**      | `dropTableIfExists(tableName: string): Promise<boolean>`                                            | Idempotently drops a table if present; returns `false` without error if absent.                   |
| **`db.renameTable`**            | `renameTable(oldName: string, newName: string): Promise<TableMeta>`                                  | Renames a table in $O(1)$ time and updates auto-named indexes.                                    |
| **`db.renameColumn`**           | `renameColumn(tableName: string, oldCol: string, newCol: string): Promise<TableMeta>`                | Renames a column in $O(1)$ time while preserving all indexes.                                     |
| **`db.addColumn`**              | `addColumn(tableName: string, column: ColumnDefinition, defaultValue?: DbValue): Promise<TableMeta>` | Adds a column and populates existing rows with `defaultValue` (or `null`).                        |
| **`db.addColumnIfNotExists`**   | `addColumnIfNotExists(tableName: string, column: ColumnDefinition, defaultValue?: DbValue): Promise<TableMeta>` | Idempotently adds a column if missing; returns existing table metadata if already present.       |
| **`db.dropColumn`**             | `dropColumn(tableName: string, columnName: string): Promise<TableMeta>`                              | Drops a non-PK column and rebuilds rows and surviving indexes atomically.                         |
| **`db.dropColumnIfExists`**     | `dropColumnIfExists(tableName: string, columnName: string): Promise<TableMeta>`                     | Idempotently drops a column if present; returns existing metadata without error if absent.       |
| **`db.alterTable`**             | `alterTable(tableName: string, op: AlterTableOperation): Promise<TableMeta>`                         | Unified API for `renameTable`, `renameColumn`, `addColumn`, `addColumnIfNotExists`, `dropColumn`, and `dropColumnIfExists`. |

---

### Indexing

| Method                          | Signature                                                                                                       | Description                                                                                      |
| :------------------------------ | :-------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------- |
| **`db.createIndex`**            | `createIndex(tableName: string, columns: string \| string[], options?: IndexOptions): Promise<IndexDescriptor>` | Creates a single-column or composite (up to 8 cols) B+Tree index, optionally `{ unique: true }`. |
| **`db.createIndexIfNotExists`** | `createIndexIfNotExists(tableName: string, columns: string \| string[], options?: IndexOptions): Promise<void>` | Idempotently creates an index if not already present by name or column sequence.                 |
| **`db.dropIndex`**              | `dropIndex(indexName: string): Promise<void>`                                                                   | Drops a secondary index and frees its pages.                                                     |
| **`db.dropIndexIfExists`**      | `dropIndexIfExists(indexName: string): Promise<boolean>`                                                        | Idempotently drops a secondary index if present; returns `false` without error if absent.        |
| **`db.listIndexes`**            | `listIndexes(tableName?: string): Promise<IndexDescriptor[]>`                                                   | Lists all indexes in the database, or only those on `tableName`.                                 |

---

### `TableMeta` Helper Methods

Every `TableMeta` returned by `getTable`, `createTable`, `listTables`, or `alterTable` includes the following methods:

| Method                 | Signature                                                               | Description                                                                        |
| :--------------------- | :---------------------------------------------------------------------- | :--------------------------------------------------------------------------------- |
| **`meta.hasColumn`**   | `hasColumn(columnName: string): boolean`                                | Returns `true` if the column exists on this table (case-insensitive).              |
| **`meta.getColumn`**   | `getColumn(columnName: string): ColumnMeta \| undefined`                | Retrieves the column metadata descriptor by name (case-insensitive).               |
| **`meta.hasIndex`**    | `hasIndex(indexNameOrColumns: string \| string[]): boolean`             | Returns `true` if an index exists by name, single column, or composite columns.   |
| **`meta.getIndex`**    | `getIndex(indexNameOrColumns: string \| string[]): IndexDescriptor \| undefined` | Retrieves the matching index descriptor by name or column sequence.       |

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
| **`db.liveQuery`**        | `liveQuery<T>(queryFn: LiveQueryFn<T>, cbOrOpts?: ..., opts?: LiveQueryOptions<T>): LiveQueryController<T>` | Creates a reactive live query bound to `db` that automatically tracks accessed tables and re-executes on change. |
| **`db.getSyncState`**     | `getSyncState(): { changeCounter: number; schemaVersion: number }`                                | Returns current Page 1 `changeCounter` and `schemaVersion`.                                              |
| **`db.registerFunction`**        | `registerFunction(name: string, def: UdfDefinition \| ((...args: any[]) => any)): this`           | Registers a custom synchronous JavaScript UDF callable in queries.                                       |
| **`db.registerBatchedFunction`** | `registerBatchedFunction(name: string, batchFn: (argsBatch: any[][]) => any[], options?: ...): this` | Registers a vectorized JavaScript UDF dispatched in chunks (default 128 rows) to eliminate per-row call overhead. |

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
| **`.live(callbackOrOptions?, options?)`**   | Turns the query into a reactive `LiveQueryController<T>` (supports `.onData()`, `.destroy()`, and `for await...of`). |
| **`.update(patch, options?)`**              | Updates all rows matching the query's `WHERE` filters and returns `Promise<number>`.                |
| **`.delete(options?)`**                     | Deletes all rows matching the query's `WHERE` filters and returns `Promise<number>`.                |
| **`.explain()`**                            | Compiles and returns `Promise<ExplainOutput>` (`plan`, `bytecodeSize`, `instructions`, `assembly`). |

---

## 3. Reactive Live Queries & Framework Subpath Exports

See the [**Reactive Live Queries Guide**](/guides/live-queries-and-frameworks) for complete usage examples.

### Core / Plain JavaScript (`@ahmadmoussawi/webdb`)

| Export | Signature | Description |
| :--- | :--- | :--- |
| **`liveQuery`** | `liveQuery<T>(queryFn: LiveQueryFn<T>, callbackOrOptions?, options?): LiveQueryController<T>` | Creates a reactive live query (and optionally subscribes a data callback). Also supports `for await (const data of liveQuery(...))`. |
| **`createLiveQuery`** | `createLiveQuery<T>(queryFn: LiveQueryFn<T>, options?: LiveQueryOptions<T>): LiveQueryController<T>` | Low-level controller returning `{ getState, subscribe, onData, refresh, destroy, [Symbol.asyncIterator] }`. |

### React (`@ahmadmoussawi/webdb/react`)

| Export | Signature | Description |
| :--- | :--- | :--- |
| **`useLiveQuery`** | `useLiveQuery<T>(queryFn, deps?, options?): UseLiveQueryResult<T>` | React hook returning `{ data, isLoading, error, lastUpdated, lastEvent, refresh }`. |
| **`useLiveQueryData`** | `useLiveQueryData<T>(queryFn, deps?, defaultValue?, options?): T \| undefined` | Concise React hook returning `data` directly (or `defaultValue` while loading). |
| **`WebDBProvider`** | `WebDBProvider({ db, children })` | React Context Provider for sharing a `WebDB` instance across components. |
| **`useWebDB`** | `useWebDB(): WebDB` | Returns the `WebDB` instance from the nearest `<WebDBProvider>` (or `useOptionalWebDB()` for nullable). |

### Vue 3 (`@ahmadmoussawi/webdb/vue`)

| Export | Signature | Description |
| :--- | :--- | :--- |
| **`useLiveQuery`** | `useLiveQuery<T>(queryFn, depsOrOptions?, options?): UseVueLiveQueryReturn<T>` | Vue 3 composable returning readonly `Ref`s (`{ data, isLoading, error, lastUpdated, lastEvent, refresh, stop }`) with automatic `onScopeDispose` cleanup. |
| **`useLiveQueryData`** | `useLiveQueryData<T>(queryFn, deps?, defaultValue?, options?): Readonly<ShallowRef<T \| undefined>>` | Concise Vue 3 composable returning a single readonly `Ref<T \| undefined>`. |
| **`provideWebDB`** | `provideWebDB(db: WebDB, app?): WebDB` | Provides a `WebDB` instance in a Vue component `setup()` or on a Vue `app` instance. |
| **`useWebDB`** | `useWebDB(): WebDB` | Injects the provided `WebDB` instance (or `useOptionalWebDB()` for nullable). |

### Angular (`@ahmadmoussawi/webdb/angular`)

| Export | Signature | Description |
| :--- | :--- | :--- |
| **`liveQuerySignal`** | `liveQuerySignal<T>(queryFn, options?): LiveQuerySignal<T>` | Angular Signal helper returning `{ data, isLoading, error, state, refresh, destroy }`. Automatically tracks Signals read in `queryFn` and cleans up via `DestroyRef`. |
| **`liveQuery$`** | `liveQuery$<T>(queryFn, options?): Observable<T>` | Cold RxJS `Observable<T>` that emits fresh results on table mutations and unsubscribes on teardown. |
| **`liveQueryState$`** | `liveQueryState$<T>(queryFn, options?): Observable<LiveQueryState<T>>` | Cold RxJS `Observable<LiveQueryState<T>>` emitting full state transitions. |
| **`provideWebDB`** | `provideWebDB(dbOrFactory: WebDB \| (() => WebDB)): EnvironmentProviders` | Provides a `WebDB` instance in an Angular `ApplicationConfig` or route config. |
| **`injectWebDB`** | `injectWebDB(): WebDB` | Injects the configured `WebDB` instance via `WEBDB_TOKEN`. |

---

## Add-on Packages

### Database Migrations (`@ahmadmoussawi/webdb/migrations`)

Standalone schema migration manager with transactional execution and atomic locking.

| Export | Signature | Description |
| :--- | :--- | :--- |
| **`runMigrations`** | `runMigrations(db: WebDB, migrations: Migration[], options?: MigratorOptions): Promise<MigrationResult>` | One-line helper that initializes the migration table, discovers applied versions, and runs pending migrations sequentially. |
| **`Migrator`** | `new Migrator(db: WebDB, options?: MigratorOptions)` | Class with `.up()`, `.down()`, `.getAppliedMigrations()`, `.getPendingMigrations()`, `.reset()`. |

### Fuzzy & Typo-Tolerant Search (`@ahmadmoussawi/webdb/search`)

Zero-dependency browser-native full-text and typo-tolerant search extension powered by `Intl.Segmenter` and Damerau-Levenshtein distance.

| Export | Signature | Description |
| :--- | :--- | :--- |
| **`SearchIndex`** | `new SearchIndex(db, config)` | High-level search manager coordinating field weighting, ranking, snippets, and highlights. Has `.search(q, opts)` and `.buildQuery(q, opts)`. |
| **`createSearchIndex`** | `createSearchIndex(db, config)` | Factory function returning a `SearchIndex` instance. |
| **`registerFuzzySearch`** | `registerFuzzySearch(db: WebDB): void` | Registers low-level UDFs (`fuzzy`, `fuzzy_score`, `search_score`, `highlight`, `snippet`, `word_count`, `normalize_text`). |
| **`fuzzyMatch`** | `fuzzyMatch(field, query, options?): ExpressionBuilder` | QueryBuilder helper for `.where()` filtering with typo tolerance. |
| **`fuzzyScore`** | `fuzzyScore(field, query, options?): ExpressionBuilder` | Computes single-column relevance score in `.select()` and `.orderBy()`. |
| **`multiFuzzyScore`**| `multiFuzzyScore(fields, query, options?): ExpressionBuilder` | Computes weighted multi-column relevance score in `.select()` and `.orderBy()`. |
| **`highlightExpr`** | `highlightExpr(field, query, options?): ExpressionBuilder` | QueryBuilder expression projecting HTML-escaped text with `<mark>` tags around matches. |
| **`snippetExpr`** | `snippetExpr(field, query, options?): ExpressionBuilder` | QueryBuilder expression projecting highlighted context excerpts around matches with ellipses. |
| **`searchInMemory`** | `searchInMemory(items, query, options): SearchResult<T>` | Pure in-memory search utility over arbitrary JavaScript arrays without touching the database. |
| **`BM25Index`** | `new BM25Index(config)` | Probabilistic BM25 index with Robertson-Spärck Jones IDF and document length normalization. |
| **`bm25Score`** | `bm25Score(fields, query, config?): ExpressionBuilder` | QueryBuilder expression computing multi-field BM25 score. |
| **`ngrams`** | `ngrams(val: unknown, n = 3, options?): string[]` | Splits text into character n-grams (e.g. trigrams) with optional boundary padding. |
| **`wordNgrams`** | `wordNgrams(val: unknown, n = 2, options?): string[]` | Splits text into word-level n-grams (e.g. bigrams) for phrase searching. |
| **`ngramSimilarity`** | `ngramSimilarity(a, b, n = 3, options?): number` | Computes Sørensen-Dice similarity coefficient (0.0 to 1.0) over character n-grams. |
| **`ngramSimilarityExpr`** | `ngramSimilarityExpr(field, query, n = 3): ExpressionBuilder` | QueryBuilder expression computing n-gram similarity in `.select()` or `.where()`. |
| **`normalizeText`** | `normalizeText(val: unknown): string` | Strips diacritics/accents and lowercases text. |
| **`tokenize`** | `tokenize(val: unknown, locale?: string): string[]` | Word tokenization using native `Intl.Segmenter`. |
| **`damerauLevenshtein`** | `damerauLevenshtein(a, b, maxDistance?): number` | Optimal string alignment edit distance accounting for adjacent transpositions. |
| **`highlight`** | `highlight(text, query, options?): string` | Pure HTML highlighting function. |
| **`snippet`** | `snippet(text, query, options?): string` | Pure contextual excerpt function. |


