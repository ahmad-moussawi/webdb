import { describe, it, expect } from "vitest";
import { WebDB } from "../src/host/api/webdb.js";
import {
  DataType,
  ColumnFlag,
  IndexFlag,
  UniqueConstraintViolationError,
  IndexNotFoundError,
  IndexAlreadyExistsError,
  ColumnNotFoundError,
  TooManyIndexesError,
  TableNotFoundError,
} from "../src/types/index.js";

describe("Index DDL, Backfill & Composite Keys (Phase 2)", () => {
  it("creates single-column and composite secondary indexes with default and custom names", async () => {
    const db = await WebDB.open({ name: "test_idx_ddl_1", storage: "memory" });

    await db.createTable("users", [
      { name: "id", type: "INT32", primaryKey: true, flags: { autoInc: true } },
      { name: "email", type: "TEXT" },
      { name: "first_name", type: "TEXT" },
      { name: "last_name", type: "TEXT" },
    ]);

    // Single column with custom name
    await db.createIndex("users", "email", { name: "idx_user_email" });

    // Composite index with default name
    await db.createIndex("users", ["last_name", "first_name"]);

    const indexes = await db.listIndexes("users");
    // pk_users + idx_user_email + idx_users_last_name_first_name = 3 indexes
    expect(indexes).toHaveLength(3);

    const names = indexes.map((i) => i.name);
    expect(names).toContain("pk_users");
    expect(names).toContain("idx_user_email");
    expect(names).toContain("idx_users_last_name_first_name");

    const compositeIdx = indexes.find(
      (i) => i.name === "idx_users_last_name_first_name",
    )!;
    expect(compositeIdx.columnCount).toBe(2);
    expect(compositeIdx.columnIndices[0]).toBe(3); // last_name
    expect(compositeIdx.columnIndices[1]).toBe(2); // first_name
  });

  it("enforces uniqueness on secondary unique indexes during insert", async () => {
    const db = await WebDB.open({ name: "test_idx_ddl_2", storage: "memory" });

    await db.createTable("users", [
      { name: "id", type: "INT32", primaryKey: true, flags: { autoInc: true } },
      { name: "email", type: "TEXT" },
    ]);

    await db.createIndex("users", "email", { unique: true });

    await db.insert("users", { id: 1, email: "alice@example.com" });
    await db.insert("users", { id: 2, email: "bob@example.com" });

    // Duplicate email insert must be rejected
    await expect(
      db.insert("users", { id: 3, email: "alice@example.com" }),
    ).rejects.toThrow(UniqueConstraintViolationError);

    const rows = await db.from("users").toArray();
    expect(rows).toHaveLength(2);
  });

  it("enforces uniqueness on composite secondary indexes", async () => {
    const db = await WebDB.open({ name: "test_idx_ddl_3", storage: "memory" });

    await db.createTable("memberships", [
      { name: "id", type: "INT32", primaryKey: true, flags: { autoInc: true } },
      { name: "tenant_id", type: "INT32" },
      { name: "user_id", type: "INT32" },
      { name: "role", type: "TEXT" },
    ]);

    await db.createIndex("memberships", ["tenant_id", "user_id"], {
      unique: true,
    });

    await db.insert("memberships", {
      tenant_id: 1,
      user_id: 10,
      role: "admin",
    });
    await db.insert("memberships", {
      tenant_id: 2,
      user_id: 10,
      role: "member",
    });
    await db.insert("memberships", {
      tenant_id: 1,
      user_id: 20,
      role: "member",
    });

    // Duplicate tuple (tenant_id: 1, user_id: 10) must be rejected
    await expect(
      db.insert("memberships", { tenant_id: 1, user_id: 10, role: "viewer" }),
    ).rejects.toThrow(UniqueConstraintViolationError);

    const rows = await db.from("memberships").toArray();
    expect(rows).toHaveLength(3);
  });

  it("backfills existing table records into newly created indexes", async () => {
    const db = await WebDB.open({ name: "test_idx_ddl_4", storage: "memory" });

    await db.createTable("products", [
      { name: "id", type: "INT32", primaryKey: true, flags: { autoInc: true } },
      { name: "sku", type: "TEXT" },
      { name: "price", type: "INT32" },
    ]);

    // Populate existing data before index creation
    await db.insert("products", { id: 1, sku: "SKU-A", price: 100 });
    await db.insert("products", { id: 2, sku: "SKU-B", price: 200 });
    await db.insert("products", { id: 3, sku: "SKU-C", price: 300 });

    // Now create unique index over existing column
    await db.createIndex("products", "sku", { unique: true });

    // Inserting a duplicate of an existing row backfilled into the index must reject
    await expect(
      db.insert("products", { id: 4, sku: "SKU-B", price: 999 }),
    ).rejects.toThrow(UniqueConstraintViolationError);

    // Inserting a new unique SKU succeeds
    await db.insert("products", { id: 4, sku: "SKU-D", price: 400 });
    const rows = await db.from("products").toArray();
    expect(rows).toHaveLength(4);
  });

  it("rejects createIndex with unique: true when existing records have duplicates", async () => {
    const db = await WebDB.open({ name: "test_idx_ddl_5", storage: "memory" });

    await db.createTable("users", [
      { name: "id", type: "INT32", primaryKey: true, flags: { autoInc: true } },
      { name: "code", type: "TEXT" },
    ]);

    await db.insert("users", { id: 1, code: "DUP" });
    await db.insert("users", { id: 2, code: "DUP" });

    // Trying to create unique index on duplicate data must reject during backfill
    await expect(
      db.createIndex("users", "code", { unique: true }),
    ).rejects.toThrow(UniqueConstraintViolationError);

    // Verify index was not registered
    const indexes = await db.listIndexes("users");
    expect(indexes).toHaveLength(1); // Only pk_users
  });

  it("drops indexes via dropIndex and reclaims uniqueness constraints", async () => {
    const db = await WebDB.open({ name: "test_idx_ddl_6", storage: "memory" });

    await db.createTable("accounts", [
      { name: "id", type: "INT32", primaryKey: true, flags: { autoInc: true } },
      { name: "username", type: "TEXT" },
    ]);

    await db.createIndex("accounts", "username", {
      name: "idx_uname",
      unique: true,
    });

    await db.insert("accounts", { id: 1, username: "neo" });

    // Reject duplicate while index is active
    await expect(
      db.insert("accounts", { id: 2, username: "neo" }),
    ).rejects.toThrow(UniqueConstraintViolationError);

    // Drop index
    await db.dropIndex("idx_uname");

    const indexes = await db.listIndexes("accounts");
    expect(indexes.find((i) => i.name === "idx_uname")).toBeUndefined();

    // Now duplicate insert should succeed because the index was dropped
    await db.insert("accounts", { id: 2, username: "neo" });
    const rows = await db.from("accounts").toArray();
    expect(rows).toHaveLength(2);

    // Dropping again throws IndexNotFoundError
    await expect(db.dropIndex("idx_uname")).rejects.toThrow(IndexNotFoundError);
  });

  it("cascades index cleanup when dropping a table with dropTable", async () => {
    const db = await WebDB.open({ name: "test_idx_ddl_7", storage: "memory" });

    await db.createTable("items", [
      { name: "id", type: "INT32", primaryKey: true, flags: { autoInc: true } },
      { name: "name", type: "TEXT" },
    ]);
    await db.createIndex("items", "name");

    expect(await db.listIndexes("items")).toHaveLength(2);

    await db.dropTable("items");

    // Table is gone
    await expect(db.getTable("items")).rejects.toThrow(TableNotFoundError);
    await expect(db.listIndexes("items")).rejects.toThrow(TableNotFoundError);

    const allIndexes = await db.listIndexes();
    expect(allIndexes).toHaveLength(0);
  });

  it("validates invalid column names, duplicate index names, and index limits", async () => {
    const db = await WebDB.open({ name: "test_idx_ddl_8", storage: "memory" });

    await db.createTable("t", [
      { name: "id", type: "INT32", primaryKey: true, flags: { autoInc: true } },
      { name: "c1", type: "INT32" },
      { name: "c2", type: "INT32" },
      { name: "c3", type: "INT32" },
      { name: "c4", type: "INT32" },
      { name: "c5", type: "INT32" },
      { name: "c6", type: "INT32" },
      { name: "c7", type: "INT32" },
    ]);

    // Invalid column
    await expect(db.createIndex("t", "non_existent_col")).rejects.toThrow(
      ColumnNotFoundError,
    );

    // Create index
    await db.createIndex("t", "c1", { name: "my_idx" });

    // Duplicate index name
    await expect(db.createIndex("t", "c2", { name: "my_idx" })).rejects.toThrow(
      IndexAlreadyExistsError,
    );

    // Max indexes limit (Page 1 has 8 slots total: 1 taken by pk_t, 1 by my_idx -> 6 remaining)
    for (let i = 2; i <= 7; i++) {
      await db.createIndex("t", `c${i}`, { name: `idx_${i}` });
    }

    // 9th index should exceed limit
    await expect(
      db.createIndex("t", ["c1", "c2"], { name: "idx_overflow" }),
    ).rejects.toThrow(TooManyIndexesError);
  });

  it("covers basic index creation: validates descriptor fields, rootPageId, column indices and flags", async () => {
    const db = await WebDB.open({
      name: "test_basic_index_creation",
      storage: "memory",
    });

    const table = await db.createTable("articles", [
      { name: "id", type: "INT32", primaryKey: true, flags: { autoInc: true } },
      { name: "slug", type: "TEXT" },
      { name: "author_id", type: "INT32" },
      { name: "created_at", type: "INT64" },
    ]);

    // Check primary key index was automatically created
    const initialIndexes = await db.listIndexes("articles");
    expect(initialIndexes).toHaveLength(1);
    const pkIdx = initialIndexes[0];
    expect(pkIdx.name).toBe("pk_articles");
    expect(pkIdx.tableId).toBe(table.tableId);
    expect(pkIdx.rootPageId).toBeGreaterThan(0);
    expect(pkIdx.columnCount).toBe(1);
    expect(pkIdx.columnIndices[0]).toBe(0); // 'id' is column 0
    expect((pkIdx.flags & IndexFlag.PRIMARY) !== 0).toBe(true);

    // 1. Create a basic single-column index with default naming
    await db.createIndex("articles", "slug");
    const afterSlug = await db.listIndexes("articles");
    expect(afterSlug).toHaveLength(2);
    const slugIdx = afterSlug.find((i) => i.name === "idx_articles_slug")!;
    expect(slugIdx).toBeDefined();
    expect(slugIdx.tableId).toBe(table.tableId);
    expect(slugIdx.rootPageId).toBeGreaterThan(0);
    expect(slugIdx.columnCount).toBe(1);
    expect(slugIdx.columnIndices[0]).toBe(1); // 'slug' is column 1
    expect((slugIdx.flags & IndexFlag.UNIQUE) === 0).toBe(true);

    // 2. Create a unique composite index with a custom name
    await db.createIndex("articles", ["author_id", "created_at"], {
      name: "idx_articles_author_created",
      unique: true,
    });
    const afterComposite = await db.listIndexes("articles");
    expect(afterComposite).toHaveLength(3);
    const compIdx = afterComposite.find(
      (i) => i.name === "idx_articles_author_created",
    )!;
    expect(compIdx).toBeDefined();
    expect(compIdx.columnCount).toBe(2);
    expect(compIdx.columnIndices[0]).toBe(2); // 'author_id'
    expect(compIdx.columnIndices[1]).toBe(3); // 'created_at'
    expect((compIdx.flags & IndexFlag.UNIQUE) !== 0).toBe(true);
  });

  it("validates that deleting a table deletes all associated indexes and allows name reuse", async () => {
    const db = await WebDB.open({
      name: "test_drop_table_cascades_indexes",
      storage: "memory",
    });

    // Create table with 3 indexes: pk + 2 secondary
    await db.createTable("users", [
      { name: "id", type: "INT32", primaryKey: true, flags: { autoInc: true } },
      { name: "username", type: "TEXT" },
      { name: "email", type: "TEXT" },
    ]);
    await db.createIndex("users", "username", { name: "idx_uname" });
    await db.createIndex("users", "email", { name: "idx_email", unique: true });

    // Verify 3 indexes in catalog
    const userIndexes = await db.listIndexes("users");
    expect(userIndexes).toHaveLength(3);

    const allIndexesBefore = await db.listIndexes();
    expect(allIndexesBefore).toHaveLength(3);

    // Drop table
    await db.dropTable("users");

    // Querying indexes of dropped table throws TableNotFoundError
    await expect(db.listIndexes("users")).rejects.toThrow(TableNotFoundError);

    // Database-wide index list is completely empty
    const allIndexesAfter = await db.listIndexes();
    expect(allIndexesAfter).toEqual([]);

    // Recreate the table and recreate indexes with identical names to prove catalog slots were freed
    await db.createTable("users", [
      { name: "id", type: "INT32", primaryKey: true, flags: { autoInc: true } },
      { name: "username", type: "TEXT" },
      { name: "email", type: "TEXT" },
    ]);
    await db.createIndex("users", "username", { name: "idx_uname" });
    await db.createIndex("users", "email", { name: "idx_email", unique: true });

    const recreatedIndexes = await db.listIndexes("users");
    expect(recreatedIndexes).toHaveLength(3);
    expect(recreatedIndexes.map((i) => i.name).sort()).toEqual([
      "idx_email",
      "idx_uname",
      "pk_users",
    ]);
  });

  it("prevents creating the same index twice (same columns on the same table)", async () => {
    const db = await WebDB.open({
      name: "test_prevent_same_index_twice",
      storage: "memory",
    });

    await db.createTable("customers", [
      { name: "id", type: "INT32", primaryKey: true, flags: { autoInc: true } },
      { name: "email", type: "TEXT" },
      { name: "phone", type: "TEXT" },
      { name: "country", type: "TEXT" },
    ]);

    // 1. Attempting to create an index on PK column 'id' (which is already indexed by pk_customers) must fail
    await expect(db.createIndex("customers", "id")).rejects.toThrow(
      IndexAlreadyExistsError,
    );
    await expect(
      db.createIndex("customers", "id", { name: "custom_pk_idx" }),
    ).rejects.toThrow(IndexAlreadyExistsError);

    // 2. Create secondary index on 'email'
    await db.createIndex("customers", "email");

    // Attempting to create it again without custom name (default name clash)
    await expect(db.createIndex("customers", "email")).rejects.toThrow(
      IndexAlreadyExistsError,
    );

    // Attempting to create it again WITH a different custom name (same columns on same table)
    await expect(
      db.createIndex("customers", "email", {
        name: "idx_customers_email_custom",
      }),
    ).rejects.toThrow(IndexAlreadyExistsError);

    // 3. Composite index
    await db.createIndex("customers", ["country", "phone"], {
      name: "idx_cust_country_phone",
    });

    // Attempting to create the identical composite index again must fail
    await expect(
      db.createIndex("customers", ["country", "phone"]),
    ).rejects.toThrow(IndexAlreadyExistsError);
    await expect(
      db.createIndex("customers", ["country", "phone"], {
        name: "another_name",
      }),
    ).rejects.toThrow(IndexAlreadyExistsError);

    // Reversing the order of composite columns is a distinct index and is allowed
    await expect(
      db.createIndex("customers", ["phone", "country"], {
        name: "idx_cust_phone_country",
      }),
    ).resolves.not.toThrow();

    const indexes = await db.listIndexes("customers");
    // pk_customers + idx_customers_email + idx_cust_country_phone + idx_cust_phone_country = 4
    expect(indexes).toHaveLength(4);
  });

  it("prevents creating two indexes with the same name across tables or within a table", async () => {
    const db = await WebDB.open({
      name: "test_prevent_duplicate_name_across_tables",
      storage: "memory",
    });

    await db.createTable("orders", [
      { name: "id", type: "INT32", primaryKey: true, flags: { autoInc: true } },
      { name: "order_number", type: "TEXT" },
    ]);

    await db.createTable("invoices", [
      { name: "id", type: "INT32", primaryKey: true, flags: { autoInc: true } },
      { name: "invoice_number", type: "TEXT" },
    ]);

    // Create named index on orders
    await db.createIndex("orders", "order_number", { name: "idx_unique_code" });

    // Attempting to create an index with the exact same name on another table (invoices) must fail
    await expect(
      db.createIndex("invoices", "invoice_number", { name: "idx_unique_code" }),
    ).rejects.toThrow(IndexAlreadyExistsError);

    // Attempting case-insensitive collision must also fail
    await expect(
      db.createIndex("invoices", "invoice_number", { name: "IDX_UNIQUE_CODE" }),
    ).rejects.toThrow(IndexAlreadyExistsError);

    // Attempting to reuse the auto-generated PK index name
    await expect(
      db.createIndex("invoices", "invoice_number", { name: "pk_orders" }),
    ).rejects.toThrow(IndexAlreadyExistsError);
  });
});
