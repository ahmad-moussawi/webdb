# Error Handling & System Limits

To guarantee fast startup, predictable memory usage on mobile browsers, and a `< 100 KB` footprint (`~13 KB` Wasm core), WebDB enforces clear boundaries and throws strongly-typed error classes that you can catch in your application code.

---

## 1. Practical System Limits

| Area                         | Limit                | Notes & How to Handle                                                                                                                                                |
| :--------------------------- | :------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Maximum Row Size**         | `2,048 bytes` (2 KB) | Serialized size of a single row (columns + strings/blobs) cannot exceed 2 KB. Store large files/images in OPFS/Blob storage and save their URL or file key in WebDB. |
| **Identifier Length**        | `64 characters`      | Maximum length for table names, column names, and index names (matches PostgreSQL & MySQL).                                                                          |
| **Tables per Database**      | `16 tables`          | Maximum number of active tables stored on Page 1.                                                                                                                    |
| **Columns per Table**        | `256 columns`        | Supports 1 to 256 columns per table.                                                                                                                                 |
| **Secondary Indexes**        | `8 indexes`          | Shared across primary key indexes and secondary indexes on Page 1 (each composite index can span up to `8 columns`).                                                 |
| **`ORDER BY` Columns**       | `8 columns`          | Maximum columns in a multi-column `.orderBy()` clause.                                                                                                               |
| **`GROUP BY` Columns**       | `8 columns`          | Maximum columns in a multi-column `.groupBy()` clause.                                                                                                               |
| **Where `IN` List Size**     | `10,000 values`      | Maximum array length or subquery result set passed to `.whereIn()` or `.whereNotIn()`.                                                                               |
| **Subquery Nesting Depth**   | `7 levels`           | Maximum nesting depth for subqueries in `from()`, `where()`, `having()`, and `select()`.                                                                             |
| **Joined Tables per Query**  | `16 cursors`         | Supports up to 16 concurrent table/index cursors in a single query.                                                                                                  |
| **Query Memory Ceiling**     | `16 MB` _(default)_  | Used for unindexed `ORDER BY` sorts and `GROUP BY` hash tables. Increase via `WebDB.open({ maxQueryMemory: 64 * 1024 * 1024 })` if needed.                           |
| **Idle Transaction Timeout** | `30 seconds`         | Open transactions that remain idle for 30s automatically roll back so they cannot deadlock other tabs.                                                               |

---

## 2. Typed Error Classes

All custom error classes are exported directly from `@ahmadmoussawi/webdb` so you can check them using `instanceof`:

```typescript
import {
  UniqueConstraintViolationError,
  NotNullConstraintError,
  RowSizeLimitExceededError,
  TableNotFoundError,
} from "@ahmadmoussawi/webdb";

try {
  await db.insert("users", {
    id: existingUserId,
    email: "duplicate@example.com",
  });
} catch (err) {
  if (err instanceof UniqueConstraintViolationError) {
    alert("An account with this ID or email already exists.");
  } else if (err instanceof NotNullConstraintError) {
    alert("Please fill in all required fields.");
  } else if (err instanceof RowSizeLimitExceededError) {
    alert("Profile text is too long (maximum 2 KB per record).");
  } else {
    throw err;
  }
}
```

### Complete Error Reference

| Error Class                                          | When It Is Thrown                                                                                                                                      |
| :--------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`UniqueConstraintViolationError`**                 | Inserting or updating a duplicate value on a `primaryKey: true` column or `{ unique: true }` index.                                                    |
| **`NotNullConstraintError`**                         | Inserting `null`/`undefined` into a `notNull: true` column, or calling `addColumn` with `notNull: true` on a populated table without a `defaultValue`. |
| **`RowSizeLimitExceededError`**                      | Inserting or updating a row whose serialized binary size exceeds `2,048 bytes`.                                                                        |
| **`TableNotFoundError`**                             | Querying, mutating, or inspecting a table name that does not exist.                                                                                    |
| **`TableAlreadyExistsError`**                        | Calling `createTable()` or `renameTable()` with a name that already exists.                                                                            |
| **`ColumnNotFoundError`**                            | Referencing a non-existent column in `renameColumn`, `dropColumn`, `createIndex`, or queries.                                                          |
| **`ColumnAlreadyExistsError`**                       | Defining duplicate column names in `createTable`, `addColumn`, or `renameColumn`.                                                                      |
| **`CannotDropColumnError`**                          | Attempting to drop a `PRIMARY KEY` column or the only remaining column of a table.                                                                     |
| **`IndexNotFoundError`**                             | Calling `dropIndex()` with an index name that does not exist.                                                                                          |
| **`IndexAlreadyExistsError`**                        | Calling `createIndex()` with a name that already exists.                                                                                               |
| **`IdentifierTooLongError`**                         | Providing a table, column, or index name longer than `64 characters`.                                                                                  |
| **`TooManyTablesError`**                             | Creating more than `16 tables`.                                                                                                                        |
| **`TooManyColumnsError`**                            | Creating or altering a table to have more than `256 columns`.                                                                                          |
| **`TooManyIndexesError`**                            | Creating more than `8 indexes` on Page 1.                                                                                                              |
| **`TooManyOrderByColumnsError`**                     | Ordering by more than `8 columns`.                                                                                                                     |
| **`TooManyGroupByColumnsError`**                     | Grouping by more than `8 columns`.                                                                                                                     |
| **`TooManyCursorsError`**                            | Compiling a query that requires more than `16 cursors` (e.g. >16 joined tables).                                                                       |
| **`TooManyRegistersError`**                          | Compiling an expression tree that exceeds `64 VM registers`.                                                                                           |
| **`SubqueryNestingTooDeepError`**                    | Nesting subqueries beyond the maximum depth of `7 levels`.                                                                                             |
| **`AggregateNotAllowedInWhereError`**                | Using `count()`, `sum()`, `avg()`, `min()`, or `max()` inside `.where()` instead of `.having()`.                                                       |
| **`UnknownFunctionError`**                           | Calling a function name in an expression that is neither built-in nor registered via `db.registerFunction()`.                                          |
| **`QueryArenaExhaustedError`**                       | An unindexed sort or hash aggregation exceeded `maxQueryMemory` (increase `maxQueryMemory` in `WebDB.open()` or add an index).                         |
| **`QueryTimeoutError`**                              | A query exceeded the VM instruction cycle safety limit.                                                                                                |
| **`InvalidDatabaseError`**                           | Passing a malformed or truncated buffer to `db.importBinary()`.                                                                                        |
| **`CorruptPageError`**                               | A database page failed IEEE 802.3 CRC32 checksum verification on read or `importBinary()`.                                                             |
| **`CorruptWalHeaderError` / `CorruptWalFrameError`** | Corrupted WAL data encountered when validating WAL frames.                                                                                             |
