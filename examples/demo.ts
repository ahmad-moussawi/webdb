import { CostBasedPlanner, HeuristicPlanner, WebDB } from "../src/index.ts";

async function main() {
  const db = await WebDB.open({
    name: "demo_db",
    storage: "memory",
    planner: new CostBasedPlanner(),
  });

  await db.createTable("countries", [
    { name: "id", type: "INT32", flags: { primaryKey: true, notNull: true } },
    { name: "name", type: "TEXT", flags: { notNull: true } },
  ]);

  await db.createTable("users", [
    { name: "id", type: "INT32", flags: { primaryKey: true, notNull: true } },
    { name: "name", type: "TEXT", flags: { notNull: true } },
    { name: "age", type: "INT32" },
    { name: "salary", type: "FLOAT64" },
    { name: "country_id", type: "INT32" },
  ]);

  const countries = [
    "Lebanon",
    "France",
    "Iraq",
    "Iran",
    "Korea",
    "Japan",
    "Poland",
  ];

  for (let i = 0; i < countries.length; i++) {
    await db.insert("countries", { id: i + 1, name: countries[i] });
  }

  // Insert sample rows
  await db.insert("users", {
    id: 101,
    name: "Alice",
    age: 30,
    salary: 120000,
    country_id: 1,
  });
  await db.insert("users", {
    id: 102,
    name: "Bob",
    age: 19,
    salary: 80000,
    country_id: 1,
  });
  await db.insert("users", {
    id: 103,
    name: "Charlie",
    age: 35,
    salary: null,
    country_id: 2,
  });

  const query = db
    .from("users")
    .join("countries", "users.country_id", "=", "countries.id")
    .where("users.age", "<", 25)
    .whereNotNull("users.salary")
    .orderBy("users.name", "desc")
    .select([
      "users.name",
      "users.age",
      "users.salary",
      "countries.name as country",
    ])
    .limit(10);

  const explainInfo = await query.explain();

  console.log("\n================== QUERY PLAN ==================");
  console.log(
    `Table:        ${explainInfo.plan.table} (Root Page: ${explainInfo.plan.rootPageId})`,
  );
  console.log(`Scan Type:    ${explainInfo.plan.scanType}`);
  if (explainInfo.plan.joinOrder) {
    console.log(`Join Order:   ${explainInfo.plan.joinOrder.join(" -> ")}`);
  }
  console.log(`Bytecode Size: ${explainInfo.bytecodeSize} bytes`);
  console.log("\n========= VDBE BYTECODE DISASSEMBLY (EXPLAIN) =========");
  console.log(explainInfo.assembly);

  const results = await query.toArray();
  console.log("\n================= QUERY RESULTS =================");
  console.table(results);
}

main().catch(console.error);
