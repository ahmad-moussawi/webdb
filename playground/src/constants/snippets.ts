import type { TypeTagMeta, TableMeta } from '../types/studio';

export const SNIPPETS: Record<string, string> = {
  topRated: `// Query top 10 products with rating >= 4.5 sorted by rating
return db.from("products")
  .where("rating", ">=", 4.5)
  .orderBy("rating", "desc")
  .limit(10);`,

  udfRegex: `// 1. Register custom regex pattern matching User-Defined Function (UDF)
db.registerFunction("regex_match", (val, pattern) => {
  if (!val) return false;
  return new RegExp(pattern, "i").test(val);
});

// 2. Query products whose brand starts with Sony, Apple, or Logitech
return db.from("products")
  .select(["id", "title", "brand", "price", "rating"])
  .where("regex_match(title, '^(Sony|Apple|Logitech)')")
  .orderBy("price", "desc")
  .limit(10);`,

  udfDate: `// 1. Register date parsing and delta calculations (UDF)
db.registerFunction("format_date", (dateStr) => {
  if (!dateStr) return null;
  return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
});

db.registerFunction("days_ago", (dateStr) => {
  if (!dateStr) return null;
  const diffMs = Date.now() - new Date(dateStr).getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
});

// 2. Query recent orders placed in the last 30 days
return db.from("orders")
  .select([
    "id",
    "customer_id",
    "format_date(order_date) as formatted_date",
    "days_ago(order_date) as days_since_order",
    "total_amount",
    "status"
  ])
  .where("days_ago(order_date)", "<=", 30)
  .orderBy("total_amount", "desc")
  .limit(10);`,

  udfMargin: `// 1. Register dynamic profit margin calculation UDF
db.registerFunction("profit_margin", (price, cost) => {
  if (!price || !cost) return 0;
  return Math.round(((price - cost) / price) * 100);
});

// 2. Query items with >= 55% profit margin
return db.from("products")
  .select(["id", "title", "price", "cost", "profit_margin(price, cost) as margin_pct"])
  .where("profit_margin(price, cost)", ">=", 55)
  .orderBy("price", "desc")
  .limit(10);`,

  lowStock: `// Inventory Alert: Find items running low on stock (< 15 units)
return db.from("products")
  .where("stock", "<", 15)
  .orderBy("stock", "asc")
  .limit(10);`,

  deliveredOrders: `// High-value delivered orders over $200
return db.from("orders")
  .where("status", "=", "delivered")
  .where("total_amount", ">", 200)
  .orderBy("total_amount", "desc")
  .limit(10);`,

  vipCustomers: `// VIP Customers who spent over $1,000
return db.from("customers")
  .where("lifetime_spent", ">", 1000)
  .orderBy("lifetime_spent", "desc")
  .limit(10);`,

  explainBytecode: `// Inspect compiled SQLite-style VDBE instruction stream
const q = db.from("products")
  .where("price", ">=", 99)
  .where("rating", ">=", 4.0)
  .orderBy("price", "desc")
  .limit(10);

const explain = await q.explain();
console.log("VDBE Instruction Count:", explain.instructions.length);
console.log("Compiled Bytecode Size:", explain.bytecodeSize, "bytes");

return q;`,
};

export const VOCAB = {
  brands: [
    "Sony",
    "Apple",
    "Logitech",
    "Samsung",
    "Dell",
    "Anker",
    "Bose",
    "LG",
    "Razer",
    "Asus",
    "Corsair",
    "SteelSeries",
  ],
  adjectives: [
    "Ultra Pro",
    "Max Sound",
    "Slim Wireless",
    "Mechanical RGB",
    "Noise-Canceling",
    "Ergonomic 4K",
    "High-Precision",
    "Studio Edition",
    "Titanium",
    "Carbon Elite",
  ],
  nouns: [
    "Headphones",
    "Gaming Mouse",
    "Mechanical Keyboard",
    "OLED Monitor",
    "Microphone",
    "Webcam Pro",
    "Earbuds",
    "Docking Station",
    "Bluetooth Speaker",
    "Smart Watch",
  ],
  firstNames: [
    "Alex",
    "Jordan",
    "Taylor",
    "Morgan",
    "Sam",
    "Chris",
    "Elena",
    "Marcus",
    "Sophia",
    "Liam",
    "Maya",
    "Daniel",
    "Olivia",
    "Lucas",
    "Emma",
    "Noah",
  ],
  lastNames: [
    "Smith",
    "Johnson",
    "Vance",
    "Chen",
    "Miller",
    "Davis",
    "Rodriguez",
    "Kowalski",
    "Tanaka",
    "Dubois",
    "Kim",
    "Patel",
    "Santos",
    "Johansson",
  ],
  countries: [
    "United States",
    "Germany",
    "United Kingdom",
    "Japan",
    "Canada",
    "France",
    "Netherlands",
    "Australia",
    "Sweden",
    "Switzerland",
  ],
  customerTiers: ["Standard", "Bronze", "Silver", "Gold", "Platinum"],
  orderStatuses: ["pending", "processing", "shipped", "delivered", "delivered"],
};

export function getColumnMetaType(
  colName: string,
  val: unknown,
  cachedTablesMeta: TableMeta[],
  activeQueryTableName?: string,
): TypeTagMeta {
  let schemaType: unknown = null;
  if (cachedTablesMeta && cachedTablesMeta.length > 0) {
    if (activeQueryTableName) {
      const tbl = cachedTablesMeta.find((t) => t.name === activeQueryTableName);
      if (tbl && tbl.columns) {
        const col = tbl.columns.find((c) => c.name === colName);
        if (col) schemaType = col.type;
      }
    }
    if (schemaType === null) {
      for (const tbl of cachedTablesMeta) {
        const col = tbl.columns?.find((c) => c.name === colName);
        if (col) {
          schemaType = col.type;
          break;
        }
      }
    }
  }

  if (schemaType !== null && schemaType !== undefined) {
    const typeStr = String(schemaType).toUpperCase();
    if (typeStr === '1' || typeStr === 'INT32' || typeStr === 'INTEGER' || typeStr === 'INT') {
      return { short: 'i32', label: 'INT32' };
    }
    if (typeStr === '2' || typeStr === 'INT64' || typeStr === 'BIGINT') {
      return { short: 'i64', label: 'INT64' };
    }
    if (typeStr === '3' || typeStr === 'FLOAT64' || typeStr === 'FLOAT' || typeStr === 'REAL' || typeStr === 'DOUBLE') {
      return { short: 'f64', label: 'FLOAT64' };
    }
    if (typeStr === '4' || typeStr === 'TEXT' || typeStr === 'VARCHAR' || typeStr === 'STRING') {
      return { short: 'txt', label: 'TEXT' };
    }
    if (typeStr === '5' || typeStr === 'BLOB' || typeStr === 'BINARY') {
      return { short: 'blo', label: 'BLOB' };
    }
    if (typeStr === '6' || typeStr === 'UUID') {
      return { short: 'uid', label: 'UUID' };
    }
    if (typeStr === '7' || typeStr === 'ULID') {
      return { short: 'uid', label: 'ULID' };
    }
  }

  if (val === null || val === undefined) {
    return { short: 'null', label: 'NULL' };
  }
  if (typeof val === 'number') {
    return Number.isInteger(val)
      ? { short: 'i32', label: 'INT32' }
      : { short: 'f64', label: 'FLOAT64' };
  }
  if (typeof val === 'bigint') {
    return { short: 'i64', label: 'INT64' };
  }
  if (typeof val === 'boolean') {
    return { short: 'bool', label: 'BOOLEAN' };
  }
  if (val instanceof Uint8Array) {
    return { short: 'blo', label: 'BLOB' };
  }
  if (typeof val === 'string') {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(val);
    const isUlid = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i.test(val);
    if (isUuid) return { short: 'uid', label: 'UUID' };
    if (isUlid) return { short: 'uid', label: 'ULID' };
    return { short: 'txt', label: 'TEXT' };
  }
  return { short: 'txt', label: 'TEXT' };
}
