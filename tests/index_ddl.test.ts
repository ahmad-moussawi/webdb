import { describe, it, expect } from "vitest";
import { WebDB } from "../src/host/api/webdb.js";
import {
  IndexFlag,
  UniqueConstraintViolationError,
  IndexNotFoundError,
  IndexAlreadyExistsError,
  ColumnNotFoundError,
  TooManyIndexesError,
  TooManyTablesError,
  TableNotFoundError,
} from "../src/types/index.js";
import { MemoryVfsAdapter } from "../src/host/storage/memory.js";
import {
  HEADER_OFFSET_NEXT_CATALOG_PAGE_ID,
  HEADER_OFFSET_NEXT_INDEX_CATALOG_PAGE_ID,
  MAX_INDEXES_PAGE1,
  MAX_TABLES_PAGE1,
  PAGE_SIZE,
} from "../src/constants.js";
import {
  catalog_init_page1,
  catalog_create_table,
  catalog_read_table_descriptor,
  catalog_write_table_descriptor,
  catalog_write_index_descriptor,
} from "../src/core/index.js";

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

  it("validates invalid column names, duplicate index names, and seamless index overflow beyond 8 slots", async () => {
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

    // Fill remaining Page 1 index slots and overflow into chained index catalog pages
    for (let i = 2; i <= 7; i++) {
      await db.createIndex("t", `c${i}`, { name: `idx_${i}` });
    }

    // Creating 8th, 9th, and 10th secondary indexes succeeds seamlessly
    await expect(
      db.createIndex("t", ["c1", "c2"], { name: "idx_8" }),
    ).resolves.not.toThrow();
    await expect(
      db.createIndex("t", ["c2", "c3"], { name: "idx_overflow_9" }),
    ).resolves.not.toThrow();
    await expect(
      db.createIndex("t", ["c3", "c4"], { name: "idx_overflow_10" }),
    ).resolves.not.toThrow();

    const allIndexes = await db.listIndexes("t");
    // pk_t + my_idx + idx_2..idx_7 (6) + idx_8 + idx_overflow_9 + idx_overflow_10 = 11 indexes
    expect(allIndexes).toHaveLength(11);
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

  it("frees and unpins all data, index, and column catalog pages to the free-page list on dropTable", async () => {
    const db = await WebDB.open({
      name: "test_drop_unpin_and_free_all",
      storage: "memory",
    });

    const table = await db.createTable("products", [
      { name: "id", type: "INT32", primaryKey: true, flags: { autoInc: true } },
      { name: "sku", type: "TEXT" },
      { name: "category", type: "TEXT" },
      { name: "price", type: "FLOAT64" },
    ]);

    // Create 2 secondary indexes
    await db.createIndex("products", "sku", { unique: true });
    await db.createIndex("products", ["category", "price"]);

    // Insert records
    for (let i = 1; i <= 20; i++) {
      await db.insert("products", {
        sku: `SKU-${i}`,
        category: i % 2 === 0 ? "Electronics" : "Books",
        price: i * 10.5,
      });
    }

    // Verify 3 indexes exist (PK + 2 secondary)
    const indexesBefore = await db.listIndexes("products");
    expect(indexesBefore).toHaveLength(3);

    // Verify that column catalog page was pinned in buffer pool
    const catSlot = (db as any).pool.getResidentSlot(table.colCatalogPageId);
    expect(catSlot).toBeGreaterThan(0);
    expect((db as any).pool.isSlotPinned(catSlot)).toBe(true);

    // Drop table
    await db.dropTable("products");

    // 1. All indexes for the table and globally must be deleted
    await expect(db.listIndexes("products")).rejects.toThrow();
    const allIndexes = await db.listIndexes();
    expect(allIndexes).toHaveLength(0);

    // 2. The column catalog page slot must no longer be pinned
    expect((db as any).pool.isSlotPinned(catSlot)).toBe(false);

    // 3. Database Free Page List must have recycled all the freed pages
    const page1View = (db as any).pool.getSlotDataView(0);
    const freeHead = page1View.getUint32(16, true); // HEADER_OFFSET_FREE_PAGE_HEAD
    expect(freeHead).toBeGreaterThan(1);

    // 4. Recreating the table should succeed smoothly without conflict
    await expect(
      db.createTable("products", [
        { name: "id", type: "INT32", primaryKey: true },
        { name: "title", type: "TEXT" },
      ]),
    ).resolves.not.toThrow();

    await db.insert("products", { id: 1, title: "New Product" });
    const rows = await db.from("products").toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 1, title: "New Product" });

    // 5. Dropping the recreated table again must not cause Double-free detected
    await expect(db.dropTable("products")).resolves.not.toThrow();
  });

  it("handles dropping indexes manually before dropping the parent table without double-free", async () => {
    const db = await WebDB.open({
      name: "test_manual_idx_drop_then_table_drop",
      storage: "memory",
    });

    await db.createTable("items", [
      { name: "id", type: "INT32", primaryKey: true },
      { name: "sku", type: "TEXT" },
      { name: "tag", type: "TEXT" },
    ]);

    await db.createIndex("items", "sku", { unique: true });
    await db.createIndex("items", "tag");

    // Drop one secondary index manually first
    await db.dropIndex("idx_items_sku");

    // Dropping table should cascade cleanly without double-freeing the manual drop
    await expect(db.dropTable("items")).resolves.not.toThrow();
  });

  it("embeds primaryKey indexes in TableDescriptor so PKs never consume secondary index slots or get silently dropped", async () => {
    const db = await WebDB.open({
      name: "test_pk_embedded_no_silent_drop",
      storage: "memory",
    });

    // 1. Fill all 8 secondary index slots on Page 1 first
    await db.createTable("seed_table", [
      { name: "id", type: "INT32", primaryKey: true },
      { name: "c1", type: "INT32" },
      { name: "c2", type: "INT32" },
      { name: "c3", type: "INT32" },
      { name: "c4", type: "INT32" },
      { name: "c5", type: "INT32" },
      { name: "c6", type: "INT32" },
      { name: "c7", type: "INT32" },
      { name: "c8", type: "INT32" },
    ]);
    for (let i = 1; i <= 8; i++) {
      await db.createIndex("seed_table", `c${i}`, { name: `idx_seed_${i}` });
    }

    // Verify all 8 Page 1 secondary index slots are used, and no index overflow page was needed yet
    const page1View = (db as any).pool.getSlotDataView(0);
    expect(
      page1View.getUint32(HEADER_OFFSET_NEXT_INDEX_CATALOG_PAGE_ID, true),
    ).toBe(0);

    // 2. Now create 15 more tables on Page 1 (total 16 tables on Page 1), ALL with primaryKey: true
    for (let t = 2; t <= 16; t++) {
      const tbl = await db.createTable(`tbl_${t}`, [
        { name: "id", type: "INT32", primaryKey: true },
        { name: "val", type: "TEXT" },
      ]);
      // Every single table MUST have its pk_<tableName> index created (never silently dropped!)
      expect(tbl.indexes).toBeDefined();
      expect(tbl.indexes!.some((idx) => idx.name === `pk_tbl_${t}`)).toBe(true);

      // Verify PK uniqueness enforcement works on every single table
      await db.insert(`tbl_${t}`, { id: 100, val: "first" });
      await expect(
        db.insert(`tbl_${t}`, { id: 100, val: "duplicate" }),
      ).rejects.toThrow(UniqueConstraintViolationError);

      // Verify PK index lookup works
      const row = await db.from(`tbl_${t}`).where("id", "=", 100).first();
      expect(row).toEqual({ id: 100, val: "first" });
    }

    // All 16 tables + 16 PK indexes + 8 secondary indexes fit on Page 1 with 0 catalog overflow pages!
    expect(
      page1View.getUint32(HEADER_OFFSET_NEXT_CATALOG_PAGE_ID, true),
    ).toBe(0);
    expect(
      page1View.getUint32(HEADER_OFFSET_NEXT_INDEX_CATALOG_PAGE_ID, true),
    ).toBe(0);

    const allIndexes = await db.listIndexes();
    expect(allIndexes).toHaveLength(24); // 16 PK indexes + 8 secondary indexes
  });

  it("chains multiple Index Catalog Overflow Pages (NEXT_INDEX_CATALOG_PAGE_ID) for 50+ secondary indexes with persistence, rename, drop & binary import/export", async () => {
    const vfs = new MemoryVfsAdapter();
    const db = await WebDB.open({ name: "test_50_indexes_overflow", vfs });

    // Create 5 tables, each with 12 columns (id + c1..c10 + extra)
    for (let t = 1; t <= 5; t++) {
      const cols = [{ name: "id", type: "INT32" as const, primaryKey: true }];
      for (let c = 1; c <= 10; c++) {
        cols.push({ name: `c${c}`, type: "INT32" as const, primaryKey: false });
      }
      await db.createTable(`t${t}`, cols);
      await db.insert(`t${t}`, {
        id: 1,
        c1: 10,
        c2: 20,
        c3: 30,
        c4: 40,
        c5: 50,
        c6: 60,
        c7: 70,
        c8: 80,
        c9: 90,
        c10: 100,
      });
    }

    // Create 50 secondary indexes (10 per table) -> spans Page 1 (8) + Overflow Page A (31) + Overflow Page B (11)
    for (let t = 1; t <= 5; t++) {
      for (let c = 1; c <= 10; c++) {
        await db.createIndex(`t${t}`, `c${c}`, {
          name: `idx_t${t}_c${c}`,
          unique: c === 10, // c10 index is unique
        });
      }
    }

    const page1View = (db as any).pool.getSlotDataView(0);
    const firstIdxOverflowPageId = page1View.getUint32(
      HEADER_OFFSET_NEXT_INDEX_CATALOG_PAGE_ID,
      true,
    );
    expect(firstIdxOverflowPageId).toBeGreaterThan(1);

    // Total indexes = 5 PK indexes + 50 secondary indexes = 55
    const allIndexes = await db.listIndexes();
    expect(allIndexes).toHaveLength(55);

    // Verify uniqueness enforcement on an index stored in the 2nd overflow page (t5.c10 is the 50th secondary index)
    await expect(
      db.insert("t5", {
        id: 2,
        c1: 1,
        c2: 2,
        c3: 3,
        c4: 4,
        c5: 5,
        c6: 6,
        c7: 7,
        c8: 8,
        c9: 9,
        c10: 100, // duplicate c10!
      }),
    ).rejects.toThrow(UniqueConstraintViolationError);

    // Drop an index in the overflow region and recreate it (verifying slot reuse)
    await db.dropIndex("idx_t5_c5");
    expect(await db.listIndexes("t5")).toHaveLength(10); // 1 PK + 9 secondary
    await db.createIndex("t5", "c5", { name: "idx_t5_c5" });
    expect(await db.listIndexes("t5")).toHaveLength(11);

    // Export binary and import into a fresh DB instance
    const binary = await db.exportBinary();
    const dbImported = await WebDB.open({
      name: "test_50_indexes_imported",
      storage: "memory",
      initialData: binary,
    });
    expect(await dbImported.listIndexes()).toHaveLength(55);
    await expect(
      dbImported.insert("t5", { id: 3, c10: 100 }),
    ).rejects.toThrow(UniqueConstraintViolationError);
    await dbImported.close();

    // Close and reopen from VFS
    await db.close();
    const dbReopened = await WebDB.open({ name: "test_50_indexes_overflow", vfs });
    expect(await dbReopened.listIndexes()).toHaveLength(55);
    const row = await dbReopened.from("t5").where("c9", "=", 90).first();
    expect(row?.id).toBe(1);

    // Drop table t5 and verify all 11 of its indexes (1 PK + 10 secondary on overflow pages) are cleaned up
    await dbReopened.dropTable("t5");
    expect(await dbReopened.listIndexes()).toHaveLength(44);
    await dbReopened.close();
  });

  it("chains multiple Table Catalog Overflow Pages (NEXT_CATALOG_PAGE_ID) for 55+ tables with full DDL, DML, persistence & binary export/import", async () => {
    const vfs = new MemoryVfsAdapter();
    const db = await WebDB.open({ name: "test_55_tables_overflow", vfs });

    // Create 55 tables (16 on Page 1 + 31 on Overflow Page 1 + 8 on Overflow Page 2), each with a PK and secondary index
    for (let i = 1; i <= 55; i++) {
      await db.createTable(`table_${i}`, [
        { name: "id", type: "INT32", primaryKey: true, flags: { autoInc: true } },
        { name: "code", type: "TEXT" },
        { name: "amount", type: "INT32" },
      ]);
      await db.createIndex(`table_${i}`, "code", { unique: true });
      await db.insert(`table_${i}`, { code: `CODE_${i}`, amount: i * 10 });
    }

    const page1View = (db as any).pool.getSlotDataView(0);
    expect(
      page1View.getUint32(HEADER_OFFSET_NEXT_CATALOG_PAGE_ID, true),
    ).toBeGreaterThan(1);
    expect(
      page1View.getUint32(HEADER_OFFSET_NEXT_INDEX_CATALOG_PAGE_ID, true),
    ).toBeGreaterThan(1);

    const tables = await db.listTables();
    expect(tables).toHaveLength(55);
    const indexes = await db.listIndexes();
    expect(indexes).toHaveLength(110); // 55 PK indexes + 55 secondary unique indexes

    // Test renameTable, addColumn, dropColumn on table_55 (in the 2nd table overflow page)
    await db.renameTable("table_55", "table_55_renamed");
    await db.addColumn("table_55_renamed", { name: "note", type: "TEXT" }, { defaultValue: "ok" });
    const r55 = await db.from("table_55_renamed").where("code", "=", "CODE_55").first();
    expect(r55).toEqual({ id: 1, code: "CODE_55", amount: 550, note: "ok" });

    // Rename back
    await db.renameTable("table_55_renamed", "table_55");

    // Drop table_25 (in 1st overflow page) and create table_56 (reusing slot 25)
    await db.dropTable("table_25");
    expect(await db.listTables()).toHaveLength(54);
    await db.createTable("table_56", [
      { name: "id", type: "INT32", primaryKey: true },
      { name: "name", type: "TEXT" },
    ]);
    expect(await db.listTables()).toHaveLength(55);

    // Close and reopen from VFS
    await db.close();
    const db2 = await WebDB.open({ name: "test_55_tables_overflow", vfs });
    expect(await db2.listTables()).toHaveLength(55);
    const row50 = await db2.from("table_50").where("id", "=", 1).first();
    expect(row50).toEqual({ id: 1, code: "CODE_50", amount: 500 });

    // Enforce PK and unique index on table_50 after reopen
    await expect(
      db2.insert("table_50", { id: 1, code: "NEW_CODE", amount: 1 }),
    ).rejects.toThrow(UniqueConstraintViolationError);
    await expect(
      db2.insert("table_50", { id: 2, code: "CODE_50", amount: 1 }),
    ).rejects.toThrow(UniqueConstraintViolationError);

    await db2.close();
  });

  it("formats TooManyTablesError and TooManyIndexesError with accurate count (limit + 1 instead of limit)", () => {
    const idxErr = new TooManyIndexesError(MAX_INDEXES_PAGE1 + 1, MAX_INDEXES_PAGE1);
    expect(idxErr.message).toBe(
      "Too many indexes: 9 exceeds maximum limit of 8 indexes on Page 1",
    );

    const tblErr = new TooManyTablesError(MAX_TABLES_PAGE1 + 1, MAX_TABLES_PAGE1);
    expect(tblErr.message).toBe(
      "Too many tables: 17 exceeds maximum limit of 16 tables on Page 1",
    );

    // Also verify low-level catalog_create_table throws 17 exceeds 16 when pager cannot allocate overflow page
    const page1Buf = new ArrayBuffer(PAGE_SIZE);
    const page1View = new DataView(page1Buf);
    catalog_init_page1(page1View);
    let nextPage = 2;
    const pages = new Map<number, Uint8Array>();
    let allowOverflow = true;
    const mockPager = {
      allocateNewPage: () => {
        if (!allowOverflow) return 0;
        const id = nextPage++;
        pages.set(id, new Uint8Array(PAGE_SIZE));
        return id;
      },
      getPageBytes: (id: number) => {
        if (!pages.has(id)) pages.set(id, new Uint8Array(PAGE_SIZE));
        return pages.get(id)!;
      },
      markPageDirty: () => {},
    };

    for (let i = 1; i <= 16; i++) {
      catalog_create_table(page1View, mockPager, `t_${i}`, [
        { name: "id", type: "INT32" },
      ]);
    }

    allowOverflow = false;
    expect(() =>
      catalog_create_table(page1View, mockPager, "t_17", [
        { name: "id", type: "INT32" },
      ]),
    ).toThrow("Too many tables: 17 exceeds maximum limit of 16 tables on Page 1");
  });

  it("cleanly rolls back overflow table and index catalog page allocations when a transaction aborts", async () => {
    const db = await WebDB.open({
      name: "test_tx_rollback_overflow_catalog",
      storage: "memory",
    });

    // Create 16 tables and 8 secondary indexes to fill Page 1 exactly
    for (let i = 1; i <= 16; i++) {
      await db.createTable(`base_${i}`, [
        { name: "id", type: "INT32", primaryKey: true },
        { name: "c1", type: "INT32" },
        { name: "c2", type: "INT32" },
      ]);
    }
    for (let i = 1; i <= 8; i++) {
      await db.createIndex(`base_${i}`, "c1", { name: `idx_base_${i}` });
    }

    const page1View = (db as any).pool.getSlotDataView(0);
    expect(page1View.getUint32(HEADER_OFFSET_NEXT_CATALOG_PAGE_ID, true)).toBe(0);
    expect(page1View.getUint32(HEADER_OFFSET_NEXT_INDEX_CATALOG_PAGE_ID, true)).toBe(0);

    // Start a transaction that allocates overflow pages for tables 17..20 and indexes 9..12, then aborts
    await expect(
      db.transaction(async (tx) => {
        for (let i = 17; i <= 20; i++) {
          await tx.createTable(`tx_tbl_${i}`, [
            { name: "id", type: "INT32", primaryKey: true },
            { name: "val", type: "TEXT" },
          ]);
          await tx.createIndex(`tx_tbl_${i}`, "val", { name: `idx_tx_${i}` });
        }
        throw new Error("Simulated migration failure");
      }),
    ).rejects.toThrow("Simulated migration failure");

    // Verify Page 1 overflow pointers were rolled back to 0 and count is back to 16 tables / 24 indexes
    expect(page1View.getUint32(HEADER_OFFSET_NEXT_CATALOG_PAGE_ID, true)).toBe(0);
    expect(page1View.getUint32(HEADER_OFFSET_NEXT_INDEX_CATALOG_PAGE_ID, true)).toBe(0);
    expect(await db.listTables()).toHaveLength(16);
    expect(await db.listIndexes()).toHaveLength(24);

    // Now run a committed transaction that creates tables 17..20 and indexes 9..12
    await db.transaction(async (tx) => {
      for (let i = 17; i <= 20; i++) {
        await tx.createTable(`committed_tbl_${i}`, [
          { name: "id", type: "INT32", primaryKey: true },
          { name: "val", type: "TEXT" },
        ]);
        await tx.createIndex(`committed_tbl_${i}`, "val", {
          name: `idx_committed_${i}`,
          unique: true,
        });
        await tx.insert(`committed_tbl_${i}`, { id: i, val: `V_${i}` });
      }
    });

    expect(await db.listTables()).toHaveLength(20);
    expect(await db.listIndexes()).toHaveLength(32); // 20 PKs + 12 secondary
    const row20 = await db.from("committed_tbl_20").where("val", "=", "V_20").first();
    expect(row20).toEqual({ id: 20, val: "V_20" });
  });

  it("maintains backward compatibility with legacy databases that stored pk_<table> in IndexDescriptor slots", async () => {
    const db = await WebDB.open({
      name: "test_legacy_pk_slot_compat",
      storage: "memory",
    });

    const tbl = await db.createTable("legacy_items", [
      { name: "id", type: "INT32", primaryKey: true },
      { name: "sku", type: "TEXT" },
    ]);

    // Convert legacy_items in-place to simulate an older v0.1.4 database:
    // Move pkRootPageId out of TableDescriptor (offset 92..113) into Page 1 IndexDescriptor slot 0
    const page1View = (db as any).pool.getSlotDataView(0);
    const desc = catalog_read_table_descriptor(page1View, 0)!;
    const pkRootPageId = desc.pkRootPageId!;
    desc.pkRootPageId = undefined;
    desc.pkColumnCount = undefined;
    desc.pkFlags = undefined;
    desc.pkColumnIndices = undefined;
    catalog_write_table_descriptor(page1View, 0, desc);

    catalog_write_index_descriptor(page1View, 0, {
      indexId: 1,
      tableId: tbl.tableId,
      rootPageId: pkRootPageId,
      columnCount: 1,
      flags: IndexFlag.PRIMARY | IndexFlag.UNIQUE,
      columnIndices: [0, 0, 0, 0, 0, 0, 0, 0],
      colDirections: [0, 0, 0, 0, 0, 0, 0, 0],
      name: "pk_legacy_items",
    });
    (db as any).tableMetaCache.clear();

    // Verify listIndexes still finds pk_legacy_items without duplication
    const indexes = await db.listIndexes("legacy_items");
    expect(indexes).toHaveLength(1);
    expect(indexes[0].name).toBe("pk_legacy_items");

    // Verify PK uniqueness and lookup still work on legacy table
    await db.insert("legacy_items", { id: 10, sku: "A" });
    await expect(
      db.insert("legacy_items", { id: 10, sku: "B" }),
    ).rejects.toThrow(UniqueConstraintViolationError);

    // Verify renameTable updates legacy pk_<table> slot
    await db.renameTable("legacy_items", "legacy_renamed");
    const renamedIndexes = await db.listIndexes("legacy_renamed");
    expect(renamedIndexes).toHaveLength(1);
    expect(renamedIndexes[0].name).toBe("pk_legacy_renamed");

    // Verify dropTable cleans up legacy pk_<table> slot
    await db.dropTable("legacy_renamed");
    expect(await db.listIndexes()).toHaveLength(0);
  });
});

