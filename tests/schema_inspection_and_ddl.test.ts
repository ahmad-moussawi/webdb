import { describe, it, expect } from "vitest";
import { WebDB } from "../src/host/api/webdb.ts";

describe("Schema Inspection & Idempotent DDL Methods", () => {
  it("tableMeta helper methods (hasColumn, getColumn, hasIndex, getIndex)", async () => {
    const db = await WebDB.open({
      name: "test_meta_helpers",
      storage: "memory",
    });

    const meta = await db.createTable("users", [
      { name: "id", type: "INT32", flags: { primaryKey: true } },
      { name: "email", type: "TEXT", flags: { notNull: true } },
      { name: "age", type: "INT32" },
    ]);

    // hasColumn & getColumn
    expect(meta.hasColumn("id")).toBe(true);
    expect(meta.hasColumn("ID")).toBe(true); // case-insensitive
    expect(meta.hasColumn("email")).toBe(true);
    expect(meta.hasColumn("EMAIL")).toBe(true);
    expect(meta.hasColumn("missing")).toBe(false);

    const emailCol = meta.getColumn("email");
    expect(emailCol).toBeDefined();
    expect(emailCol?.name).toBe("email");
    expect(meta.getColumn("MISSING")).toBeUndefined();

    // Indexes on meta
    await db.createIndex("users", ["email"], { name: "idx_user_email", unique: true });
    await db.createIndex("users", ["age", "email"], { name: "idx_user_age_email" });

    const updatedMeta = await db.getTable("users");

    expect(updatedMeta.hasIndex("idx_user_email")).toBe(true);
    expect(updatedMeta.hasIndex("IDX_USER_EMAIL")).toBe(true);
    expect(updatedMeta.hasIndex("email")).toBe(true); // single-column lookup
    expect(updatedMeta.hasIndex(["age", "email"])).toBe(true);
    expect(updatedMeta.hasIndex(["email", "age"])).toBe(false); // order-sensitive
    expect(updatedMeta.hasIndex("nonexistent")).toBe(false);

    const idxDesc = updatedMeta.getIndex("idx_user_email");
    expect(idxDesc).toBeDefined();
    expect(idxDesc?.name).toBe("idx_user_email");

    const multiIdx = updatedMeta.getIndex(["age", "email"]);
    expect(multiIdx).toBeDefined();
    expect(multiIdx?.name).toBe("idx_user_age_email");

    await db.close();
  });

  it("hasTable & getTableNames inspection", async () => {
    const db = await WebDB.open({
      name: "test_has_table",
      storage: "memory",
    });

    expect(await db.hasTable("orders")).toBe(false);
    expect(await db.getTableNames()).toEqual([]);

    await db.createTable("orders", [
      { name: "id", type: "INT32", primaryKey: true },
    ]);
    await db.createTable("customers", [
      { name: "id", type: "INT32", primaryKey: true },
    ]);

    expect(await db.hasTable("orders")).toBe(true);
    expect(await db.hasTable("ORDERS")).toBe(true);
    expect(await db.hasTable("customers")).toBe(true);
    expect(await db.hasTable("products")).toBe(false);

    const names = await db.getTableNames();
    expect(names.sort()).toEqual(["customers", "orders"]);

    await db.dropTable("orders");
    expect(await db.hasTable("orders")).toBe(false);
    expect(await db.getTableNames()).toEqual(["customers"]);

    await db.close();
  });

  it("hasColumn & hasIndex inspection on WebDB", async () => {
    const db = await WebDB.open({
      name: "test_webdb_has_col_idx",
      storage: "memory",
    });

    // When table does not exist
    expect(await db.hasColumn("ghost_table", "id")).toBe(false);
    expect(await db.hasIndex("ghost_table", "idx_ghost")).toBe(false);

    await db.createTable("accounts", [
      { name: "id", type: "INT32", primaryKey: true },
      { name: "balance", type: "FLOAT64" },
      { name: "note", type: "TEXT" },
    ]);
    await db.createIndex("accounts", "balance", { name: "idx_acc_balance" });

    expect(await db.hasColumn("accounts", "id")).toBe(true);
    expect(await db.hasColumn("accounts", "BALANCE")).toBe(true);
    expect(await db.hasColumn("accounts", "nonexistent")).toBe(false);

    expect(await db.hasIndex("accounts", "idx_acc_balance")).toBe(true);
    expect(await db.hasIndex("accounts", "balance")).toBe(true);
    expect(await db.hasIndex("accounts", "id")).toBe(true); // PK is indexed
    expect(await db.hasIndex("accounts", "note")).toBe(false);

    await db.close();
  });

  it("createTableIfNotExists & dropTableIfExists", async () => {
    const db = await WebDB.open({
      name: "test_idempotent_tables",
      storage: "memory",
    });

    // 1. Initial create
    const meta1 = await db.createTableIfNotExists("items", [
      { name: "id", type: "INT32", primaryKey: true },
      { name: "name", type: "TEXT" },
    ]);
    expect(meta1.name).toBe("items");
    expect(meta1.columns).toHaveLength(2);

    // 2. Second create should not throw, returns existing
    const meta2 = await db.createTableIfNotExists("items", [
      { name: "id", type: "INT32", primaryKey: true },
      { name: "different_col", type: "TEXT" },
    ]);
    expect(meta2.name).toBe("items");
    expect(meta2.hasColumn("name")).toBe(true);
    expect(meta2.hasColumn("different_col")).toBe(false);

    // 3. Drop existing
    const dropped1 = await db.dropTableIfExists("items");
    expect(dropped1).toBe(true);
    expect(await db.hasTable("items")).toBe(false);

    // 4. Drop already dropped / nonexistent should return false without error
    const dropped2 = await db.dropTableIfExists("items");
    expect(dropped2).toBe(false);

    await db.close();
  });

  it("addColumnIfNotExists & dropColumnIfExists", async () => {
    const db = await WebDB.open({
      name: "test_idempotent_columns",
      storage: "memory",
    });

    await db.createTable("products", [
      { name: "id", type: "INT32", primaryKey: true },
      { name: "title", type: "TEXT" },
    ]);
    await db.insert("products", { id: 1, title: "Phone" });

    // Add new column with raw default value
    const metaAfterAdd = await db.addColumnIfNotExists(
      "products",
      { name: "price", type: "INT32" },
      99,
    );
    expect(metaAfterAdd.hasColumn("price")).toBe(true);
    const rows1 = await db.from("products").toArray();
    expect(rows1[0].price).toBe(99);

    // Adding existing column is a safe no-op
    const metaAfterNoop = await db.addColumnIfNotExists(
      "products",
      { name: "price", type: "INT32" },
      999,
    );
    expect(metaAfterNoop.hasColumn("price")).toBe(true);
    const rows2 = await db.from("products").toArray();
    expect(rows2[0].price).toBe(99); // still 99

    // Drop column
    const metaAfterDrop = await db.dropColumnIfExists("products", "price");
    expect(metaAfterDrop.hasColumn("price")).toBe(false);

    // Dropping nonexistent column is a safe no-op
    const metaAfterDropAgain = await db.dropColumnIfExists("products", "price");
    expect(metaAfterDropAgain.hasColumn("price")).toBe(false);

    await db.close();
  });

  it("createIndexIfNotExists & dropIndexIfExists", async () => {
    const db = await WebDB.open({
      name: "test_idempotent_indexes",
      storage: "memory",
    });

    await db.createTable("logs", [
      { name: "id", type: "INT32", primaryKey: true },
      { name: "level", type: "TEXT" },
      { name: "timestamp", type: "INT64" },
    ]);

    // Create index
    await db.createIndexIfNotExists("logs", ["level"], { name: "idx_logs_level" });
    expect(await db.hasIndex("logs", "idx_logs_level")).toBe(true);

    // Second create with same name or column is a safe no-op
    await db.createIndexIfNotExists("logs", ["level"], { name: "idx_logs_level" });
    await db.createIndexIfNotExists("logs", ["level"]); // duplicate column signature

    // Drop index
    const dropped1 = await db.dropIndexIfExists("idx_logs_level");
    expect(dropped1).toBe(true);
    expect(await db.hasIndex("logs", "idx_logs_level")).toBe(false);

    // Drop again returns false without error
    const dropped2 = await db.dropIndexIfExists("idx_logs_level");
    expect(dropped2).toBe(false);

    await db.close();
  });

  it("alterTable supports addColumnIfNotExists and dropColumnIfExists", async () => {
    const db = await WebDB.open({
      name: "test_alter_idempotent",
      storage: "memory",
    });

    await db.createTable("tasks", [
      { name: "id", type: "INT32", primaryKey: true },
      { name: "desc", type: "TEXT" },
    ]);

    await db.alterTable("tasks", {
      type: "addColumnIfNotExists",
      column: { name: "done", type: "INT32" },
      defaultValue: 0,
    });
    expect(await db.hasColumn("tasks", "done")).toBe(true);

    // Safe duplicate
    await db.alterTable("tasks", {
      type: "addColumnIfNotExists",
      column: { name: "done", type: "INT32" },
      defaultValue: 1,
    });
    expect(await db.hasColumn("tasks", "done")).toBe(true);

    // Drop
    await db.alterTable("tasks", {
      type: "dropColumnIfExists",
      column: "done",
    });
    expect(await db.hasColumn("tasks", "done")).toBe(false);

    // Drop nonexistent
    await db.alterTable("tasks", {
      type: "dropColumnIfExists",
      column: "done",
    });
    expect(await db.hasColumn("tasks", "done")).toBe(false);

    await db.close();
  });

  it("works seamlessly inside db.transaction()", async () => {
    const db = await WebDB.open({
      name: "test_tx_idempotent",
      storage: "memory",
    });

    await db.transaction(async (tx) => {
      const usersMeta = await tx.createTableIfNotExists("users", [
        { name: "id", type: "INT32", primaryKey: true },
        { name: "username", type: "TEXT" },
      ]);
      expect(usersMeta.hasColumn("username")).toBe(true);
      expect(await tx.hasTable("users")).toBe(true);
      expect(await tx.hasColumn("users", "username")).toBe(true);

      await tx.addColumnIfNotExists(
        "users",
        { name: "created_at", type: "INT64" },
        12345n,
      );
      expect(await tx.hasColumn("users", "created_at")).toBe(true);

      await tx.createIndexIfNotExists("users", "username", {
        name: "idx_tx_username",
      });
      expect(await tx.hasIndex("users", "idx_tx_username")).toBe(true);

      const dropped = await tx.dropTableIfExists("nonexistent");
      expect(dropped).toBe(false);
    });

    expect(await db.hasTable("users")).toBe(true);
    expect(await db.hasColumn("users", "created_at")).toBe(true);
    expect(await db.hasIndex("users", "idx_tx_username")).toBe(true);

    await db.close();
  });
});
