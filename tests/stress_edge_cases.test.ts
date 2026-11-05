import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  WebDB,
  UniqueConstraintViolationError,
  ColumnNotFoundError,
} from "../src/index.ts";

async function countRows(db: WebDB, tableName: string): Promise<number> {
  const row = await db.from(tableName).count("*", "c").first();
  return Number(row?.c ?? 0);
}

describe("Stress & Edge Case Lifecycle Tests (JS & WASM)", () => {
  let db: WebDB;

  beforeEach(async () => {
    db = await WebDB.open({
      name: `stress-edge-${Date.now()}-${Math.random()}`,
      storage: "memory",
    });
  });

  afterEach(async () => {
    await db.close();
  });

  it("handles huge batch inserts (2,500 rows) with PK, unique, and composite indexes across all data types", async () => {
    await db.createTable("employees", [
      {
        name: "id",
        type: "INT32",
        primaryKey: true,
        autoInc: true,
      },
      { name: "email", type: "TEXT", notNull: true },
      { name: "dept", type: "TEXT", notNull: true },
      { name: "level", type: "INT32", notNull: true },
      { name: "salary", type: "FLOAT64", notNull: true },
      { name: "badge_views", type: "INT64", notNull: true },
      { name: "ext_uuid", type: "UUID", notNull: true },
      { name: "trace_ulid", type: "ULID", notNull: true },
      { name: "avatar", type: "BLOB" },
    ]);

    await db.createIndex("employees", "email", {
      name: "idx_employees_email",
      unique: true,
    });
    await db.createIndex("employees", ["dept", "level"], {
      name: "idx_dept_level",
    });

    const depts = ["eng", "sales", "design", "ops", "research"];
    const totalRows = 2500;
    const batch = [];

    for (let i = 1; i <= totalRows; i++) {
      const hex12 = (i * 1337).toString(16).padStart(12, "0");
      const ulidSuffix = i.toString(16).toUpperCase().padStart(10, "0");
      batch.push({
        email: `user_${i}@example.com`,
        dept: depts[i % depts.length],
        level: (i % 7) + 1,
        salary: 50000 + (i % 100) * 1250.5,
        badge_views: BigInt(i * 100000),
        ext_uuid: `550e8400-e29b-41d4-a716-${hex12}`,
        trace_ulid: `01ARZ3NDEKTSV4RR${ulidSuffix}`,
        avatar: new Uint8Array([i & 0xff, (i >> 8) & 0xff, 0xaa, 0x55]),
      });
    }

    await db.insertMany("employees", batch);
    expect(await countRows(db, "employees")).toBe(totalRows);

    // 1. Point lookup via PK index across early, middle, and tail pages
    for (const targetId of [1, 777, 1500, 2499, 2500]) {
      const rows = await db
        .from("employees")
        .where("id", "=", targetId)
        .toArray();
      expect(rows.length).toBe(1);
      expect(rows[0].email).toBe(`user_${targetId}@example.com`);
      expect(rows[0].badge_views).toBe(BigInt(targetId * 100000));
      expect(Array.from(rows[0].avatar as Uint8Array)).toEqual([
        targetId & 0xff,
        (targetId >> 8) & 0xff,
        0xaa,
        0x55,
      ]);
    }

    // 2. Point lookup via secondary unique TEXT index
    const emailRow = await db
      .from("employees")
      .where("email", "=", "user_1984@example.com")
      .toArray();
    expect(emailRow.length).toBe(1);
    expect(emailRow[0].id).toBe(1984);

    // 3. Composite index lookup (dept = 'eng' AND level = 4)
    const expectedCompositeCount = batch.filter(
      (r) => r.dept === "eng" && r.level === 4,
    ).length;
    const compositeRows = await db
      .from("employees")
      .where("dept", "=", "eng")
      .where("level", "=", 4)
      .toArray();
    expect(compositeRows.length).toBe(expectedCompositeCount);
    for (const r of compositeRows) {
      expect(r.dept).toBe("eng");
      expect(r.level).toBe(4);
    }

    // 4. Filter + Sort + Limit (Top-K heap sorter path)
    const topPaidEng = await db
      .from("employees")
      .where("dept", "=", "eng")
      .orderBy("salary", "desc")
      .limit(10)
      .toArray();
    expect(topPaidEng.length).toBe(10);
    for (let i = 1; i < topPaidEng.length; i++) {
      expect(Number(topPaidEng[i - 1].salary)).toBeGreaterThanOrEqual(
        Number(topPaidEng[i].salary),
      );
    }

    // 5. Intra-batch duplicate key rollback on populated table
    await expect(
      db.insertMany("employees", [
        {
          email: "new_valid_1@example.com",
          dept: "eng",
          level: 1,
          salary: 60000,
          badge_views: 1n,
          ext_uuid: "550e8400-e29b-41d4-a716-000000999991",
          trace_ulid: "01ARZ3NDEKTSV4RR0000999991",
          avatar: null,
        },
        {
          email: "user_1200@example.com", // collides with existing row 1200
          dept: "sales",
          level: 2,
          salary: 65000,
          badge_views: 2n,
          ext_uuid: "550e8400-e29b-41d4-a716-000000999992",
          trace_ulid: "01ARZ3NDEKTSV4RR0000999992",
          avatar: null,
        },
      ]),
    ).rejects.toThrow(UniqueConstraintViolationError);

    // Count and auto-increment state must remain untouched after failed batch
    expect(await countRows(db, "employees")).toBe(totalRows);
    await db.insert("employees", {
      email: "user_2501@example.com",
      dept: "ops",
      level: 3,
      salary: 70000,
      badge_views: 2501n,
      ext_uuid: "550e8400-e29b-41d4-a716-000000002501",
      trace_ulid: "01ARZ3NDEKTSV4RR0000002501",
      avatar: null,
    });
    const row2501 = await db
      .from("employees")
      .where("email", "=", "user_2501@example.com")
      .toArray();
    expect(row2501[0].id).toBe(2501);
  });

  it("handles full schema evolution lifecycle: huge insert -> addColumn -> huge insert -> dropColumn -> renameColumn/Table -> createIndex/dropIndex", async () => {
    await db.createTable("products", [
      {
        name: "id",
        type: "INT32",
        primaryKey: true,
        autoInc: true,
      },
      { name: "sku", type: "TEXT", notNull: true },
      { name: "category", type: "TEXT", notNull: true, indexed: true },
      { name: "price", type: "FLOAT64", notNull: true },
      {
        name: "legacy_code",
        type: "INT32",
        notNull: true,
        indexed: true,
      },
    ]);
    await db.createIndex("products", "sku", { unique: true });

    // Step 1: Insert first large batch (1,200 rows across multiple pages)
    const batch1 = [];
    for (let i = 1; i <= 1200; i++) {
      batch1.push({
        sku: `SKU-${i.toString().padStart(5, "0")}`,
        category: `cat_${i % 6}`,
        price: 10 + (i % 50) * 1.5,
        legacy_code: i * 10,
      });
    }
    await db.insertMany("products", batch1);
    expect(await countRows(db, "products")).toBe(1200);

    // Step 2: Add an indexed column with a defaultValue and a large payload column
    await db.addColumn(
      "products",
      {
        name: "warehouse",
        type: "TEXT",
        notNull: true,
        indexed: true,
      },
      { defaultValue: "WH-NORTH" },
    );
    await db.addColumn(
      "products",
      {
        name: "description",
        type: "TEXT",
      },
      { defaultValue: "Standard catalog item" },
    );

    // Verify existing 1,200 rows received the default values and the new index works
    const whNorthRows = await db
      .from("products")
      .where("warehouse", "=", "WH-NORTH")
      .toArray();
    expect(whNorthRows.length).toBe(1200);
    expect(whNorthRows[0].description).toBe("Standard catalog item");

    // Step 3: Insert second batch (800 rows) with large ~600-byte descriptions & new warehouse values
    const largeTextPrefix = "D".repeat(550);
    const batch2 = [];
    for (let i = 1201; i <= 2000; i++) {
      batch2.push({
        sku: `SKU-${i.toString().padStart(5, "0")}`,
        category: `cat_${i % 6}`,
        price: 20 + (i % 50) * 2.0,
        legacy_code: i * 10,
        warehouse: i % 2 === 0 ? "WH-SOUTH" : "WH-EAST",
        description: `${largeTextPrefix}_${i}`,
      });
    }
    await db.insertMany("products", batch2);
    expect(await countRows(db, "products")).toBe(2000);

    // Verify auto-increment continuity and secondary index lookups across both batches
    const southRows = await db
      .from("products")
      .where("warehouse", "=", "WH-SOUTH")
      .toArray();
    expect(southRows.length).toBe(400);

    const checkRow1999 = await db
      .from("products")
      .where("sku", "=", "SKU-01999")
      .toArray();
    expect(checkRow1999.length).toBe(1);
    expect(checkRow1999[0].id).toBe(1999);
    expect(checkRow1999[0].warehouse).toBe("WH-EAST");
    expect(checkRow1999[0].description).toBe(`${largeTextPrefix}_1999`);

    // Step 4: Drop the indexed `legacy_code` column across all 2,000 multi-page rows
    await db.dropColumn("products", "legacy_code");

    const afterDropRow = await db
      .from("products")
      .where("id", "=", 500)
      .toArray();
    expect(afterDropRow.length).toBe(1);
    expect("legacy_code" in afterDropRow[0]).toBe(false);
    expect(afterDropRow[0].sku).toBe("SKU-00500");
    expect(afterDropRow[0].warehouse).toBe("WH-NORTH");

    await expect(
      db.from("products").where("legacy_code", "=", 5000).toArray(),
    ).rejects.toThrow(/legacy_code/);

    // Step 5: Rename column `warehouse` -> `region` and rename table `products` -> `inventory_items`
    await db.renameColumn("products", "warehouse", "region");
    await db.renameTable("products", "inventory_items");

    const eastItems = await db
      .from("inventory_items")
      .where("region", "=", "WH-EAST")
      .toArray();
    expect(eastItems.length).toBe(400);

    // Step 6: Create a composite index on the populated 2,000-row table
    await db.createIndex("inventory_items", ["category", "region"], {
      name: "idx_cat_region",
    });

    const cat2South = await db
      .from("inventory_items")
      .where("category", "=", "cat_2")
      .where("region", "=", "WH-SOUTH")
      .toArray();
    const expectedCat2South = batch2.filter(
      (r) => r.category === "cat_2" && r.warehouse === "WH-SOUTH",
    ).length;
    expect(cat2South.length).toBe(expectedCat2South);

    // Attempting to create a unique index on non-unique `category` must fail cleanly
    await expect(
      db.createIndex("inventory_items", "category", {
        name: "idx_unique_cat_fail",
        unique: true,
      }),
    ).rejects.toThrow(UniqueConstraintViolationError);

    // Step 7: Drop composite index and verify query still succeeds via TableScan fallback
    await db.dropIndex("idx_cat_region");
    const cat2SouthFallback = await db
      .from("inventory_items")
      .where("category", "=", "cat_2")
      .where("region", "=", "WH-SOUTH")
      .toArray();
    expect(cat2SouthFallback.length).toBe(expectedCat2South);
  });

  it("maintains index & rowid integrity under heavy interleaved deletes, page-overflow updates, re-inserts, and binary export/import", async () => {
    await db.createTable("documents", [
      {
        name: "id",
        type: "INT32",
        primaryKey: true,
        autoInc: true,
      },
      { name: "slug", type: "TEXT", notNull: true },
      { name: "bucket", type: "INT32", notNull: true },
      { name: "version", type: "INT32", notNull: true },
      { name: "payload", type: "TEXT", notNull: true },
    ]);

    await db.createIndex("documents", "slug", { unique: true });
    await db.createIndex("documents", ["bucket", "version"], {
      name: "idx_bucket_version",
    });

    // 1. Insert 900 medium rows (~250 bytes each -> ~60 data pages)
    const initialCount = 900;
    const initialBatch = [];
    for (let i = 1; i <= initialCount; i++) {
      initialBatch.push({
        slug: `doc-${i}`,
        bucket: i % 10,
        version: 1,
        payload: `init_payload_${i}_${"x".repeat(200)}`,
      });
    }
    await db.insertMany("documents", initialBatch);
    expect(await countRows(db, "documents")).toBe(initialCount);

    // 2. Delete 3 buckets (270 rows deleted -> shifts cell arrays across all 60 pages)
    const deletedCount = await db
      .from("documents")
      .whereIn("bucket", [0, 3, 6])
      .delete();
    expect(deletedCount).toBe(270);
    expect(await countRows(db, "documents")).toBe(initialCount - 270);

    // 3. Expand rows in bucket 1 and 2 with huge ~1,400-byte payloads (forces page compaction & tail-page migration)
    const hugePayload = "HUGE_" + "Z".repeat(1350);
    const updatedCount = await db
      .from("documents")
      .whereIn("bucket", [1, 2])
      .update({
        version: 2,
        payload: hugePayload,
      });
    expect(updatedCount).toBe(180);

    // Verify updated rows via composite index (bucket = 1, version = 2) and unique slug index
    const bucket1V2 = await db
      .from("documents")
      .where("bucket", "=", 1)
      .where("version", "=", 2)
      .toArray();
    expect(bucket1V2.length).toBe(90);
    for (const r of bucket1V2) {
      expect(r.payload).toBe(hugePayload);
    }

    const doc11 = await db
      .from("documents")
      .where("slug", "=", "doc-11")
      .toArray();
    expect(doc11.length).toBe(1);
    expect(doc11[0].id).toBe(11);
    expect(doc11[0].version).toBe(2);
    expect(doc11[0].payload).toBe(hugePayload);

    // 4. Insert 400 new rows in a batch after fragmentation
    const secondBatch = [];
    for (let i = 901; i <= 1300; i++) {
      secondBatch.push({
        slug: `doc-${i}`,
        bucket: i % 10,
        version: 3,
        payload: `second_wave_${i}_${"y".repeat(120)}`,
      });
    }
    await db.insertMany("documents", secondBatch);
    const expectedTotal = initialCount - 270 + 400; // 1030
    expect(await countRows(db, "documents")).toBe(expectedTotal);

    // 5. Binary export & import into a fresh DB instance and verify full index/table parity
    const binarySnapshot = await db.exportBinary();
    const restoredDb = await WebDB.open({
      name: `restored-${Date.now()}-${Math.random()}`,
      storage: "memory",
    });

    try {
      await restoredDb.importBinary(binarySnapshot);
      expect(await countRows(restoredDb, "documents")).toBe(expectedTotal);

      const restoredDoc1250 = await restoredDb
        .from("documents")
        .where("slug", "=", "doc-1250")
        .toArray();
      expect(restoredDoc1250.length).toBe(1);
      expect(restoredDoc1250[0].id).toBe(1250);
      expect(restoredDoc1250[0].version).toBe(3);

      const restoredBucket2V2 = await restoredDb
        .from("documents")
        .where("bucket", "=", 2)
        .where("version", "=", 2)
        .toArray();
      expect(restoredBucket2V2.length).toBe(90);
    } finally {
      await restoredDb.close();
    }
  });

  it("rolls back failed transactions containing huge batch inserts + schema/index mutations and executes joins & aggregations after alterTable", async () => {
    await db.createTable("customers", [
      { name: "id", type: "INT32", primaryKey: true, autoInc: true },
      { name: "name", type: "TEXT", notNull: true },
      { name: "tier", type: "TEXT", notNull: true, indexed: true },
    ]);

    await db.createTable("orders", [
      { name: "id", type: "INT32", primaryKey: true, autoInc: true },
      { name: "customer_id", type: "INT32", notNull: true, indexed: true },
      { name: "amount", type: "FLOAT64", notNull: true },
      { name: "temp_flag", type: "INT32", notNull: true },
    ]);

    const tiers = ["gold", "silver", "bronze"];
    const custBatch = [];
    for (let c = 1; c <= 200; c++) {
      custBatch.push({
        name: `Customer_${c}`,
        tier: tiers[c % 3],
      });
    }
    await db.insertMany("customers", custBatch);

    const orderBatch = [];
    for (let o = 1; o <= 1500; o++) {
      orderBatch.push({
        customer_id: ((o - 1) % 200) + 1,
        amount: (o % 20) * 10 + 5,
        temp_flag: o % 2,
      });
    }
    await db.insertMany("orders", orderBatch);

    // Evolve `orders` via alterTable unified API: add column, drop temp_flag, rename column
    await db.alterTable("orders", {
      type: "addColumn",
      column: { name: "tax", type: "FLOAT64", notNull: true },
      defaultValue: 2.5,
    });
    await db.alterTable("orders", {
      type: "dropColumn",
      column: "temp_flag",
    });
    await db.alterTable("orders", {
      type: "renameColumn",
      from: "amount",
      to: "subtotal",
    });

    // Execute a transaction that inserts 800 rows, adds a column, drops a column, and then aborts
    await expect(
      db.transaction(async (tx) => {
        const extraOrders = [];
        for (let i = 1; i <= 800; i++) {
          extraOrders.push({
            customer_id: 1,
            subtotal: 999.0,
            tax: 99.0,
          });
        }
        await tx.insertMany("orders", extraOrders);
        expect(await countRows(tx, "orders")).toBe(2300);

        await tx.addColumn(
          "orders",
          { name: "aborted_col", type: "TEXT", indexed: true },
          { defaultValue: "temp" },
        );

        throw new Error("Simulated mid-migration failure");
      }),
    ).rejects.toThrow("Simulated mid-migration failure");

    // Verify full rollback of row count, schema columns, and indexes
    expect(await countRows(db, "orders")).toBe(1500);
    const ordersMeta = await db.getTable("orders");
    expect(ordersMeta.columns.map((c) => c.name)).toEqual([
      "id",
      "customer_id",
      "subtotal",
      "tax",
    ]);

    // Verify JOIN across the evolved multi-page tables
    const goldOrders = await db
      .from("orders")
      .innerJoin("customers", "orders.customer_id", "=", "customers.id")
      .where("customers.tier", "=", "gold")
      .where("orders.subtotal", ">=", 150)
      .select("orders.id", "orders.customer_id", "orders.subtotal", "orders.tax", "customers.name")
      .orderBy("orders.subtotal", "desc")
      .limit(15)
      .toArray();

    expect(goldOrders.length).toBe(15);
    for (let i = 0; i < goldOrders.length; i++) {
      expect(Number(goldOrders[i].subtotal)).toBeGreaterThanOrEqual(150);
      expect(Number(goldOrders[i].tax)).toBe(2.5);
    }

    // Verify GROUP BY + HAVING + SUM/COUNT + ORDER BY + LIMIT on the altered `orders` table
    const topSpenders = await db
      .from("orders")
      .groupBy("customer_id")
      .select("customer_id")
      .sum("subtotal", "total_spent")
      .count("*", "order_count")
      .having("total_spent", ">", 100)
      .orderBy("total_spent", "desc")
      .limit(5)
      .toArray();

    expect(topSpenders.length).toBe(5);
    for (let i = 0; i < topSpenders.length; i++) {
      expect(Number(topSpenders[i].order_count)).toBeGreaterThanOrEqual(7);
      expect(Number(topSpenders[i].total_spent)).toBeGreaterThan(100);
      if (i > 0) {
        expect(Number(topSpenders[i - 1].total_spent)).toBeGreaterThanOrEqual(
          Number(topSpenders[i].total_spent),
        );
      }
    }
  });
});
