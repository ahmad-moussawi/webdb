import { describe, it, expect, vi } from "vitest";
import { WebDB } from "../src/host/api/webdb.ts";
import {
  Migrator,
  runMigrations,
  type Migration,
} from "../src/migrations/index.ts";

describe("Database Migrations Runner (@ahmadmoussawi/webdb/migrations)", () => {
  it("executes pending migrations sequentially in version order", async () => {
    const db = await WebDB.open({
      name: "test_migrator_basic",
      storage: "memory",
    });

    const executionOrder: string[] = [];

    const migrations: Migration[] = [
      {
        version: 2,
        name: "add_bio_column",
        async up(tx) {
          executionOrder.push("v2");
          await tx.addColumn("users", { name: "bio", type: "TEXT" });
        },
        async down(tx) {
          await tx.dropColumn("users", "bio");
        },
      },
      {
        version: 1,
        name: "create_users_table",
        async up(tx) {
          executionOrder.push("v1");
          await tx.createTable("users", [
            { name: "id", type: "INT32", primaryKey: true },
            { name: "name", type: "TEXT", notNull: true },
          ]);
        },
        async down(tx) {
          await tx.dropTable("users");
        },
      },
    ];

    const migrator = new Migrator(db, { migrations });

    // Initial status
    const statusBefore = await migrator.status();
    expect(statusBefore.applied).toHaveLength(0);
    expect(statusBefore.pending).toHaveLength(2);
    expect(statusBefore.pending[0].version).toBe(1);
    expect(statusBefore.pending[1].version).toBe(2);

    // Run migrations
    const result = await migrator.up();
    expect(executionOrder).toEqual(["v1", "v2"]);
    expect(result.executed).toHaveLength(2);
    expect(result.batch).toBe(1);

    // Status after
    const statusAfter = await migrator.status();
    expect(statusAfter.applied).toHaveLength(2);
    expect(statusAfter.pending).toHaveLength(0);
    expect(statusAfter.applied[0].version).toBe("1");
    expect(statusAfter.applied[1].version).toBe("2");

    // Table exists with both columns
    expect(await db.hasTable("users")).toBe(true);
    expect(await db.hasColumn("users", "id")).toBe(true);
    expect(await db.hasColumn("users", "name")).toBe(true);
    expect(await db.hasColumn("users", "bio")).toBe(true);

    // Second run is a no-op
    const noopResult = await migrator.up();
    expect(noopResult.executed).toHaveLength(0);

    await db.close();
  });

  it("handles batches and down() rollbacks correctly", async () => {
    const db = await WebDB.open({
      name: "test_migrator_rollback",
      storage: "memory",
    });

    const m1: Migration = {
      version: 1,
      name: "create_categories",
      async up(tx) {
        await tx.createTable("categories", [
          { name: "id", type: "INT32", primaryKey: true },
          { name: "title", type: "TEXT" },
        ]);
      },
      async down(tx) {
        await tx.dropTable("categories");
      },
    };

    const m2: Migration = {
      version: 2,
      name: "create_products",
      async up(tx) {
        await tx.createTable("products", [
          { name: "id", type: "INT32", primaryKey: true },
          { name: "title", type: "TEXT" },
        ]);
      },
      async down(tx) {
        await tx.dropTable("products");
      },
    };

    const m3: Migration = {
      version: 3,
      name: "add_category_to_products",
      async up(tx) {
        await tx.addColumn("products", { name: "category_id", type: "INT32" });
      },
      async down(tx) {
        await tx.dropColumn("products", "category_id");
      },
    };

    const migrator = new Migrator(db);

    // Run batch 1 (m1, m2)
    migrator.register([m1, m2]);
    const res1 = await migrator.up();
    expect(res1.batch).toBe(1);
    expect(res1.executed).toHaveLength(2);

    // Run batch 2 (m3)
    migrator.register(m3);
    const res2 = await migrator.up();
    expect(res2.batch).toBe(2);
    expect(res2.executed).toHaveLength(1);

    expect(await db.hasColumn("products", "category_id")).toBe(true);

    // Rollback batch 2
    const downRes1 = await migrator.down();
    expect(downRes1.executed).toHaveLength(1);
    expect(downRes1.executed[0].name).toBe("add_category_to_products");
    expect(await db.hasColumn("products", "category_id")).toBe(false);
    expect(await db.hasTable("products")).toBe(true);

    // Rollback batch 1 (m1, m2)
    const downRes2 = await migrator.down();
    expect(downRes2.executed).toHaveLength(2);
    expect(await db.hasTable("products")).toBe(false);
    expect(await db.hasTable("categories")).toBe(false);

    // Rollback when empty is a no-op
    const downRes3 = await migrator.down();
    expect(downRes3.executed).toHaveLength(0);

    await db.close();
  });

  it("supports step rollback and full reset", async () => {
    const db = await WebDB.open({
      name: "test_migrator_step_reset",
      storage: "memory",
    });

    const migrations: Migration[] = [
      {
        version: "20261109_01",
        name: "tbl1",
        async up(tx) {
          await tx.createTable("t1", [{ name: "id", type: "INT32", primaryKey: true }]);
        },
        async down(tx) {
          await tx.dropTable("t1");
        },
      },
      {
        version: "20261109_02",
        name: "tbl2",
        async up(tx) {
          await tx.createTable("t2", [{ name: "id", type: "INT32", primaryKey: true }]);
        },
        async down(tx) {
          await tx.dropTable("t2");
        },
      },
      {
        version: "20261109_03",
        name: "tbl3",
        async up(tx) {
          await tx.createTable("t3", [{ name: "id", type: "INT32", primaryKey: true }]);
        },
        async down(tx) {
          await tx.dropTable("t3");
        },
      },
    ];

    const migrator = new Migrator(db, { migrations });
    await migrator.up();
    expect(await db.hasTable("t1")).toBe(true);
    expect(await db.hasTable("t2")).toBe(true);
    expect(await db.hasTable("t3")).toBe(true);

    // Rollback exactly 1 step
    const downStep = await migrator.down({ step: 1 });
    expect(downStep.executed).toHaveLength(1);
    expect(downStep.executed[0].version).toBe("20261109_03");
    expect(await db.hasTable("t3")).toBe(false);
    expect(await db.hasTable("t2")).toBe(true);

    // Reset rolls back all remaining
    const resetRes = await migrator.reset();
    expect(resetRes.executed).toHaveLength(2);
    expect(await db.hasTable("t2")).toBe(false);
    expect(await db.hasTable("t1")).toBe(false);

    await db.close();
  });

  it("rolls back atomically if a migration fails in atomic mode", async () => {
    const db = await WebDB.open({
      name: "test_migrator_atomic_failure",
      storage: "memory",
    });

    const migrations: Migration[] = [
      {
        version: 1,
        name: "create_valid_table",
        async up(tx) {
          await tx.createTable("valid_tbl", [
            { name: "id", type: "INT32", primaryKey: true },
          ]);
        },
      },
      {
        version: 2,
        name: "fail_migration",
        async up() {
          throw new Error("Simulated upgrade disaster!");
        },
      },
    ];

    const onError = vi.fn();
    const migrator = new Migrator(db, {
      migrations,
      mode: "atomic",
      onMigrationError: onError,
    });

    await expect(migrator.up()).rejects.toThrow("Simulated upgrade disaster!");
    expect(onError).toHaveBeenCalledTimes(1);

    // Because atomic mode rolls back transaction, valid_tbl should NOT exist
    expect(await db.hasTable("valid_tbl")).toBe(false);

    // _migrations table has zero applied records
    const status = await migrator.status();
    expect(status.applied).toHaveLength(0);
    expect(status.pending).toHaveLength(2);

    await db.close();
  });

  it("supports standalone runMigrations helper function", async () => {
    const db = await WebDB.open({
      name: "test_run_migrations_helper",
      storage: "memory",
    });

    const migrations: Migration[] = [
      {
        version: 1,
        name: "init_db",
        async up(tx) {
          await tx.createTable("settings", [
            { name: "key", type: "TEXT", primaryKey: true },
            { name: "val", type: "TEXT" },
          ]);
        },
      },
    ];

    const result = await runMigrations(db, migrations);
    expect(result.executed).toHaveLength(1);
    expect(await db.hasTable("settings")).toBe(true);

    await db.close();
  });

  it("invokes migration lifecycle callbacks (start, success, error)", async () => {
    const db = await WebDB.open({
      name: "test_migrator_callbacks",
      storage: "memory",
    });

    const onStart = vi.fn();
    const onSuccess = vi.fn();

    const migrations: Migration[] = [
      {
        version: 1,
        name: "m1",
        async up(tx) {
          await tx.createTable("t", [{ name: "id", type: "INT32", primaryKey: true }]);
        },
      },
    ];

    const migrator = new Migrator(db, {
      migrations,
      onMigrationStart: onStart,
      onMigrationSuccess: onSuccess,
    });

    await migrator.up();
    expect(onStart).toHaveBeenCalledWith(migrations[0], "up");
    expect(onSuccess).toHaveBeenCalledWith(migrations[0], "up", expect.any(Number));

    await db.close();
  });

  it("supports custom tracking table name", async () => {
    const db = await WebDB.open({
      name: "test_custom_table_name",
      storage: "memory",
    });

    const migrator = new Migrator(db, {
      tableName: "app_schema_version",
      migrations: [
        {
          version: 1,
          name: "m1",
          async up(tx) {
            await tx.createTable("test", [{ name: "id", type: "INT32", primaryKey: true }]);
          },
        },
      ],
    });

    await migrator.up();
    expect(await db.hasTable("app_schema_version")).toBe(true);
    expect(await db.hasTable("_migrations")).toBe(false);

    await db.close();
  });
});

