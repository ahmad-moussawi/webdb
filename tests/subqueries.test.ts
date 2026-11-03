import { describe, it, expect, beforeEach } from "vitest";
import {
  WebDB,
  DataType,
  col,
  fn,
  SubqueryNestingTooDeepError,
} from "../src/index.js";

describe("Subqueries & Nested Queries (FROM, WHERE, SELECT)", () => {
  let db: WebDB;

  beforeEach(async () => {
    db = await WebDB.open({
      storage: "memory",
      name: `test_subqueries_${Math.random().toString(36).slice(2)}`,
    });

    await db.createTable("employees", [
      { name: "id", type: DataType.INT32, primaryKey: true },
      { name: "name", type: DataType.TEXT },
      { name: "dept", type: DataType.TEXT },
      { name: "salary", type: DataType.FLOAT64 },
      { name: "active", type: DataType.INT32 },
      { name: "manager_id", type: DataType.INT32, nullable: true },
    ]);

    await db.createTable("orders", [
      { name: "id", type: DataType.INT32, primaryKey: true },
      { name: "emp_id", type: DataType.INT32 },
      { name: "amount", type: DataType.FLOAT64 },
      { name: "status", type: DataType.TEXT },
    ]);

    await db.insertMany("employees", [
      {
        id: 1,
        name: "Alice",
        dept: "Engineering",
        salary: 120000,
        active: 1,
        manager_id: null,
      },
      {
        id: 2,
        name: "Bob",
        dept: "Engineering",
        salary: 90000,
        active: 1,
        manager_id: 1,
      },
      {
        id: 3,
        name: "Charlie",
        dept: "Sales",
        salary: 80000,
        active: 1,
        manager_id: 1,
      },
      {
        id: 4,
        name: "Diana",
        dept: "Sales",
        salary: 60000,
        active: 1,
        manager_id: 3,
      },
      {
        id: 5,
        name: "Evan",
        dept: "HR",
        salary: 70000,
        active: 0,
        manager_id: 1,
      },
    ]);

    await db.insertMany("orders", [
      { id: 101, emp_id: 1, amount: 500, status: "completed" },
      { id: 102, emp_id: 1, amount: 1500, status: "completed" },
      { id: 103, emp_id: 3, amount: 2000, status: "completed" },
      { id: 104, emp_id: 3, amount: 300, status: "pending" },
      { id: 105, emp_id: 4, amount: 700, status: "completed" },
    ]);
  });

  describe("1. Derived Tables in FROM (`db.from(subquery)`)", () => {
    it("flattens simple projection and filter subqueries into a single table scan", async () => {
      const activeSub = db
        .from("employees")
        .select([
          "id",
          "upper(name) as upper_name",
          "floor(salary / 1000) as sal_k",
        ])
        .where("active", "=", 1);

      const outerQuery = db
        .from(activeSub)
        .select(["id", "upper_name", "sal_k * 2 as double_sal_k"])
        .where("sal_k", ">=", 80)
        .orderBy("id", "asc");

      const explain = await outerQuery.explain();
      expect(explain.plan.table).toBe("employees");
      expect(explain.plan.filters.length).toBe(2);

      const rows = await outerQuery.toArray();
      expect(rows).toEqual([
        { id: 1, upper_name: "ALICE", double_sal_k: 240 },
        { id: 2, upper_name: "BOB", double_sal_k: 180 },
        { id: 3, upper_name: "CHARLIE", double_sal_k: 160 },
      ]);
    });

    it("executes materialized derived tables with GROUP BY and aggregates", async () => {
      const deptStats = db
        .from("employees")
        .where("active", "=", 1)
        .groupBy("dept")
        .select(["dept", "count(*) as headcount", "avg(salary) as avg_sal"]);

      const highPayingDepts = await db
        .from(deptStats)
        .where("avg_sal", ">", 75000)
        .orderBy("avg_sal", "desc")
        .select(["dept", "headcount", "avg_sal"])
        .toArray();

      expect(highPayingDepts).toEqual([
        { dept: "Engineering", headcount: 2, avg_sal: 105000 },
      ]);
    });

    it("executes materialized derived tables with inner LIMIT and OFFSET", async () => {
      const top3 = db
        .from("employees")
        .orderBy("salary", "desc")
        .limit(3)
        .select(["id", "name", "salary"]);

      const rows = await db
        .from(top3)
        .where("salary", "<", 120000)
        .orderBy("salary", "asc")
        .toArray();

      expect(rows).toEqual([
        { id: 3, name: "Charlie", salary: 80000 },
        { id: 2, name: "Bob", salary: 90000 },
      ]);
    });

    it("supports outer aggregation over a materialized derived table", async () => {
      const empOrderTotals = db
        .from("orders")
        .where("status", "=", "completed")
        .groupBy("emp_id")
        .select(["emp_id", "sum(amount) as total_spent"]);

      const overall = await db
        .from(empOrderTotals)
        .select([
          "count(*) as active_buyers",
          "avg(total_spent) as avg_buyer_spend",
        ])
        .toArray();

      expect(overall).toEqual([
        { active_buyers: 3, avg_buyer_spend: (2000 + 2000 + 700) / 3 },
      ]);
    });

    it("allows nesting up to depth 7 and throws SubqueryNestingTooDeepError at depth 8", async () => {
      let q = db.from("employees").where("active", "=", 1);
      for (let i = 1; i <= 7; i++) {
        q = db.from(q);
      }
      expect(q.getMaxSubqueryDepth()).toBe(7);
      const rows = await q
        .orderBy("id", "asc")
        .select(["id", "name"])
        .toArray();
      expect(rows.length).toBe(4);

      expect(() => db.from(q)).toThrow(SubqueryNestingTooDeepError);
    });
  });

  describe("2. Subqueries in WHERE (`whereIn`, `whereNotIn`, scalar comparison, `whereExists`)", () => {
    it("filters rows with whereIn(col, subquery) and accelerates with IndexScan on PK", async () => {
      const bigBuyers = db
        .from("orders")
        .where("amount", ">=", 1000)
        .select("emp_id");

      const query = db
        .from("employees")
        .whereIn("id", bigBuyers)
        .orderBy("id", "asc")
        .select(["id", "name"]);

      const explain = await query.explain();
      expect(explain.plan.scanType).toBe("IndexScan");

      const rows = await query.toArray();
      expect(rows).toEqual([
        { id: 1, name: "Alice" },
        { id: 3, name: "Charlie" },
      ]);
    });

    it('supports whereNotIn(col, subquery) and .where(col, "in" | "not in", subquery)', async () => {
      const buyers = db.from("orders").select("emp_id");

      const nonBuyers = await db
        .from("employees")
        .whereNotIn("id", buyers)
        .orderBy("id", "asc")
        .select(["id", "name"])
        .toArray();

      expect(nonBuyers).toEqual([
        { id: 2, name: "Bob" },
        { id: 5, name: "Evan" },
      ]);

      const viaOp = await db
        .from("employees")
        .where("id", "in", buyers)
        .orderBy("id", "asc")
        .select(["id", "name"])
        .toArray();

      expect(viaOp).toEqual([
        { id: 1, name: "Alice" },
        { id: 3, name: "Charlie" },
        { id: 4, name: "Diana" },
      ]);
    });

    it("preserves SQL 3VL semantics when whereNotIn subquery returns NULL", async () => {
      // manager_id contains null (for Alice). In SQL, x NOT IN (null, 1, 3) is always UNKNOWN (empty set).
      const managersWithNull = db.from("employees").select("manager_id");
      const resWithNull = await db
        .from("employees")
        .whereNotIn("id", managersWithNull)
        .toArray();
      expect(resWithNull).toEqual([]);

      // When NULLs are filtered out in the subquery, non-managers are returned properly
      const managersNoNull = db
        .from("employees")
        .whereNotNull("manager_id")
        .select("manager_id");
      const resNoNull = await db
        .from("employees")
        .whereNotIn("id", managersNoNull)
        .orderBy("id", "asc")
        .select(["id", "name"])
        .toArray();
      expect(resNoNull).toEqual([
        { id: 2, name: "Bob" },
        { id: 4, name: "Diana" },
        { id: 5, name: "Evan" },
      ]);
    });

    it("supports uncorrelated scalar subqueries in WHERE and HAVING", async () => {
      const avgSalSub = db.from("employees").select("avg(salary)");

      const aboveAvg = await db
        .from("employees")
        .where("salary", ">", avgSalSub)
        .orderBy("id", "asc")
        .select(["id", "name", "salary"])
        .toArray();

      // Overall avg salary is (120k + 90k + 80k + 60k + 70k) / 5 = 84,000
      expect(aboveAvg).toEqual([
        { id: 1, name: "Alice", salary: 120000 },
        { id: 2, name: "Bob", salary: 90000 },
      ]);

      const deptsAboveAvg = await db
        .from("employees")
        .groupBy("dept")
        .having("avg(salary)", ">", avgSalSub)
        .select(["dept", "avg(salary) as dept_avg"])
        .toArray();

      expect(deptsAboveAvg).toEqual([
        { dept: "Engineering", dept_avg: 105000 },
      ]);
    });

    it("supports correlated scalar subqueries in WHERE", async () => {
      // Find employees earning strictly more than the average salary of their own department
      const deptAvgSub = db
        .from("employees")
        .select("avg(salary)")
        .where("dept", "=", col("employees.dept"));

      const topInDept = await db
        .from("employees")
        .where("salary", ">", deptAvgSub)
        .orderBy("id", "asc")
        .select(["id", "name", "dept", "salary"])
        .toArray();

      // Engineering avg: 105k -> Alice (120k)
      // Sales avg: 70k -> Charlie (80k)
      // HR avg: 70k -> none strictly greater
      expect(topInDept).toEqual([
        { id: 1, name: "Alice", dept: "Engineering", salary: 120000 },
        { id: 3, name: "Charlie", dept: "Sales", salary: 80000 },
      ]);
    });

    it("supports correlated whereExists and whereNotExists", async () => {
      const hasCompletedOrder = db
        .from("orders")
        .where("orders.emp_id", "=", col("employees.id"))
        .where("status", "=", "completed");

      const withOrders = await db
        .from("employees")
        .whereExists(hasCompletedOrder)
        .orderBy("id", "asc")
        .select(["id", "name"])
        .toArray();

      expect(withOrders).toEqual([
        { id: 1, name: "Alice" },
        { id: 3, name: "Charlie" },
        { id: 4, name: "Diana" },
      ]);

      const withoutOrders = await db
        .from("employees")
        .whereNotExists(hasCompletedOrder)
        .orderBy("id", "asc")
        .select(["id", "name"])
        .toArray();

      expect(withoutOrders).toEqual([
        { id: 2, name: "Bob" },
        { id: 5, name: "Evan" },
      ]);
    });

    it("supports update() and delete() with WHERE subqueries", async () => {
      const pendingOrderEmps = db
        .from("orders")
        .where("status", "=", "pending")
        .select("emp_id");

      const updated = await db
        .from("employees")
        .whereIn("id", pendingOrderEmps)
        .update({ salary: 85000 });
      expect(updated).toBe(1);

      const charlie = await db.from("employees").where("id", "=", 3).first();
      expect(charlie?.salary).toBe(85000);
    });
  });

  describe("3. Scalar Subqueries in SELECT (`select(subquery.as(...))`)", () => {
    it("projects uncorrelated and correlated scalar subqueries in SELECT", async () => {
      const companyMaxSub = db
        .from("employees")
        .select("max(salary)")
        .as("company_max");

      const orderCountSub = db
        .from("orders")
        .where("emp_id", "=", col("employees.id"))
        .select("count(*)")
        .as("order_count");

      const maxOrderSub = db
        .from("orders")
        .where("emp_id", "=", col("employees.id"))
        .select("max(amount)");

      const rows = await db
        .from("employees")
        .where("active", "=", 1)
        .orderBy("id", "asc")
        .select("id", "name", companyMaxSub, orderCountSub, {
          biggest_order: maxOrderSub,
        })
        .toArray();

      expect(rows).toEqual([
        {
          id: 1,
          name: "Alice",
          company_max: 120000,
          order_count: 2,
          biggest_order: 1500,
        },
        {
          id: 2,
          name: "Bob",
          company_max: 120000,
          order_count: 0,
          biggest_order: null,
        },
        {
          id: 3,
          name: "Charlie",
          company_max: 120000,
          order_count: 2,
          biggest_order: 2000,
        },
        {
          id: 4,
          name: "Diana",
          company_max: 120000,
          order_count: 1,
          biggest_order: 700,
        },
      ]);
    });

    it("executes subqueries cleanly inside an interactive transaction without deadlocking", async () => {
      await db.transaction(async (tx) => {
        await tx.insert("orders", {
          id: 106,
          emp_id: 2,
          amount: 999,
          status: "completed",
        });

        const buyers = db
          .from("orders")
          .where("amount", ">=", 900)
          .select("emp_id");

        const orderSumSub = db
          .from("orders")
          .where("emp_id", "=", col("employees.id"))
          .select("sum(amount)")
          .as("total_amount");

        const rows = await tx
          .from("employees")
          .whereIn("id", buyers)
          .orderBy("id", "asc")
          .select(["id", "name", orderSumSub])
          .toArray();

        expect(rows).toEqual([
          { id: 1, name: "Alice", total_amount: 2000 },
          { id: 2, name: "Bob", total_amount: 999 },
          { id: 3, name: "Charlie", total_amount: 2300 },
        ]);
      });
    });
  });
});
