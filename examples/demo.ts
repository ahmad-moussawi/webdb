import { WebDB } from "../src/index.js";

async function main() {
  const db = await WebDB.open({ name: "demo_db", storage: "memory" });

  await db.createTable("users", [
    { name: "id", type: "INT32", flags: { primaryKey: true, notNull: true } },
    { name: "name", type: "TEXT", flags: { notNull: true } },
    { name: "age", type: "INT32" },
    { name: "salary", type: "FLOAT64" },
  ]);

  // Insert sample rows

  await db.insert("users", {
    id: 100 + 1,
    name: `Alice`,
    age: 30,
    salary: 120000,
  });
  await db.insert("users", {
    id: 200 + 2,
    name: `Bob`,
    age: 10,
    salary: 80000,
  });
  await db.insert("users", {
    id: 300 + 3,
    name: `Charlie`,
    age: 35,
    salary: null,
  });

  const query = db
    .from("users")
    .where("age", "<", 20)
    .whereNotNull("salary")
    .orderBy("name", "desc")
    .limit(10);

  const explainInfo = await query.explain();

  console.log("\n================== QUERY PLAN ==================");
  console.log(
    `Table:        ${explainInfo.plan.table} (Root Page: ${explainInfo.plan.rootPageId})`,
  );
  console.log(`Scan Type:    ${explainInfo.plan.scanType}`);
  console.log(`Bytecode Size: ${explainInfo.bytecodeSize} bytes`);
  console.log("\n========= VDBE BYTECODE DISASSEMBLY (EXPLAIN) =========");
  console.log(explainInfo.assembly);

  const results = await query.toArray();
  console.log("================= QUERY RESULTS =================");
  console.table(results);
}

main().catch(console.error);
