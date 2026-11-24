<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { withBase } from "vitepress";
import { SIZE_METRICS } from "../constants";

type CodeTab = "quickstart" | "dualcore" | "customstorage" | "transactions";
const activeTab = ref<CodeTab>("quickstart");

const codeSnippets: Record<CodeTab, string> = {
  quickstart: `import { WebDB, WasmEngine, IdbStorage } from "@ahmadmoussawi/webdb";

// 1. Open an async database in the browser — zero server headers needed
//    Swap IdbStorage for OpfsStorage or MemoryStorage anytime
const db = await WebDB.open({
  engine: new WasmEngine(),
  storage: new IdbStorage("shop_app"),
});

// 2. Define typed relational tables & indexes
await db.createTable("orders", [
  { name: "id", type: "UUID", primaryKey: true },
  { name: "customer_id", type: "UUID", notNull: true },
  { name: "status", type: "TEXT", notNull: true },
  { name: "total", type: "FLOAT64", notNull: true },
]);
await db.createIndex("orders", ["status", "total"]);

// 3. Fluent, type-safe queries with JOINs, aggregates & sorting
const topCustomers = await db
  .from("orders")
  .join("customers", "orders.customer_id", "=", "customers.id")
  .select("customers.name as customer")
  .sum("orders.total", "lifetimeValue")
  .count("*", "orderCount")
  .where("orders.status", "=", "paid")
  .groupBy("customers.name")
  .having("lifetimeValue", ">=", 500)
  .orderBy("lifetimeValue", "desc")
  .limit(10)
  .toArray();`,

  dualcore: `// Tree-shakeable subpath imports keep your bundle ultra-small
import { WebDB } from "@ahmadmoussawi/webdb/slim";
import { WasmEngine } from "@ahmadmoussawi/webdb/core/wasm";
import { JsEngine } from "@ahmadmoussawi/webdb/core/js";
import { OpfsStorage } from "@ahmadmoussawi/webdb/storage/opfs";

// Option A: ~19 KB gzipped WebAssembly core for maximum speed
const fastDb = await WebDB.open({
  engine: new WasmEngine(),
  storage: new OpfsStorage("app_data"),
});

// Option B: 100% Pure JS core — identical API and storage format
// Ideal for strict CSP policies, browser extensions, or restricted WebViews
const cspSafeDb = await WebDB.open({
  engine: new JsEngine(),
  storage: new OpfsStorage("app_data"),
});`,

  customstorage: `import { WebDB, WasmEngine, MemoryStorage } from "@ahmadmoussawi/webdb";

// Extend MemoryStorage (or implement IVfsAdapter) to plug in any backend:
// S3/CDN HTTP Range streaming, Electron fs, React Native, or Cloudflare KV
class RemoteCatalogStorage extends MemoryStorage {
  constructor(private url: string) {
    super();
  }

  override async readPages(pageIds: number[]): Promise<Array<Uint8Array | null>> {
    const cached = await super.readPages(pageIds);
    const missing = pageIds.filter((_, i) => cached[i] === null);
    if (missing.length === 0) return cached;

    const fetched = await Promise.all(
      missing.map(async (pageId) => {
        const start = (pageId - 1) * 4096;
        const res = await fetch(this.url, {
          headers: { Range: \`bytes=\${start}-\${start + 4095}\` },
        });
        return { pageId, data: new Uint8Array(await res.arrayBuffer()) };
      }),
    );

    await super.writePages(fetched);
    return super.readPages(pageIds);
  }
}

const db = await WebDB.open({
  engine: new WasmEngine(),
  storage: new RemoteCatalogStorage("https://cdn.example.com/catalog.webdb"),
});

// Queries fetch only the data they need — without downloading the whole file
const products = await db
  .from("products")
  .where("category", "=", "Electronics")
  .orderBy("rating", "desc")
  .limit(10)
  .toArray();`,

  transactions: `// Crash-safe atomic transactions with nested savepoints
await db.transaction(async (tx) => {
  await tx.insert("orders", {
    id: crypto.randomUUID(),
    customer_id: "018d3e2a-1b4c-7000-8000-123456789abc",
    status: "paid",
    total: 249.0,
  });

  // Nested transactions act as savepoints — rolling back an inner block
  // restores state without aborting the outer transaction
  await tx
    .transaction(async (savepoint) => {
      await savepoint.update("orders", { total: 9999.0 });
      throw new Error("Revert inner savepoint only");
    })
    .catch(() => {});
});`,
};

type FrameworkTab = "react" | "vue" | "angular" | "vanilla";
const activeFrameworkTab = ref<FrameworkTab>("react");

const frameworkMeta: Record<
  FrameworkTab,
  { label: string; badge: string; pkg: string; size: string; file: string }
> = {
  react: {
    label: "React",
    badge: "Hooks + Context",
    pkg: "@ahmadmoussawi/webdb/react",
    size: "0.72 KB gzip",
    file: "OrderDashboard.tsx",
  },
  vue: {
    label: "Vue 3",
    badge: "Composition API",
    pkg: "@ahmadmoussawi/webdb/vue",
    size: "0.93 KB gzip",
    file: "OrderDashboard.vue",
  },
  angular: {
    label: "Angular",
    badge: "Signals + RxJS",
    pkg: "@ahmadmoussawi/webdb/angular",
    size: "0.96 KB gzip",
    file: "orders.component.ts",
  },
  vanilla: {
    label: "Plain JS / TS",
    badge: "Zero Dependencies",
    pkg: "@ahmadmoussawi/webdb",
    size: "",
    file: "live-query.ts",
  },
};

const frameworkSnippets: Record<FrameworkTab, string> = {
  react: `import { useLiveQuery } from "@ahmadmoussawi/webdb/react";

export function OrderDashboard({ status }: { status: string }) {
  // Automatically tracks 'orders' AND joined 'customers' table!
  const { data: orders, isLoading } = useLiveQuery(
    () =>
      db
        .from("orders")
        .join("customers", "orders.customer_id", "=", "customers.id")
        .where("orders.status", "=", status)
        .orderBy("orders.id", "desc"),
    [status],
    { initialData: [] }
  );

  // Mutating 'orders' (here or in another tab) automatically updates 'orders' & re-renders!
  const markPaid = (id: string) =>
    db.from("orders").where("id", "=", id).update({ status: "paid" });

  if (isLoading) return <p>Loading live orders...</p>;
  return <OrderTable rows={orders} onMarkPaid={markPaid} />;
}`,

  vue: `<script setup lang="ts">
import { ref } from "vue";
import { useLiveQuery } from "@ahmadmoussawi/webdb/vue";

const statusFilter = ref("paid");

// Returns reactive Vue Refs & cleans up automatically onScopeDispose
const { data: orders, isLoading } = useLiveQuery(
  () =>
    db
      .from("orders")
      .join("customers", "orders.customer_id", "=", "customers.id")
      .where("orders.status", "=", statusFilter.value)
      .orderBy("orders.id", "desc"),
  [statusFilter], // Re-runs when statusFilter Ref or watched tables mutate
  { initialData: [] }
);

// Inserting or updating a row automatically refreshes the 'orders' Ref!
const addOrder = (customerId: string, total: number) =>
  db.insert("orders", { id: crypto.randomUUID(), customer_id: customerId, status: "paid", total });
<\/script>`,

  angular: `import { Component, signal } from "@angular/core";
import { injectWebDB, liveQuerySignal } from "@ahmadmoussawi/webdb/angular";

@Component({
  selector: "app-orders",
  template: \`
    @for (order of orders.data(); track order.id) {
      <div>{{ order.customer }} — \${{ order.total }}</div>
    }
  \`,
})
export class OrdersComponent {
  private db = injectWebDB();
  status = signal("paid");

  // Automatically tracks Angular Signals + WebDB tables & cleans up via DestroyRef
  orders = liveQuerySignal(
    () => this.db.from("orders").where("status", "=", this.status()),
    { initialData: [] }
  );

  // Any insert/update to 'orders' automatically pushes a new value to the 'orders' Signal!
  markPaid(id: string) {
    return this.db.from("orders").where("id", "=", id).update({ status: "paid" });
  }
}`,

  vanilla: `import { WebDB } from "@ahmadmoussawi/webdb";

// 1. Chain .live() directly onto any QueryBuilder
const sub = db
  .from("orders")
  .where("status", "=", "paid")
  .orderBy("id", "desc")
  .live((rows) => renderOrders(rows));

// 2. Inserting or modifying a record in 'orders' automatically triggers the live callback!
await db.insert("orders", {
  id: crypto.randomUUID(),
  status: "paid",
  total: 149.99,
});`,
};

function highlightCode(code: string): string {
  let html = code
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const tokens: string[] = [];
  const saveToken = (wrapped: string) => {
    const id = tokens.length;
    tokens.push(wrapped);
    return `___TOKEN_${id}___`;
  };

  // 1. Single-line comments
  html = html.replace(/\/\/.*/g, (m) =>
    saveToken(`<span class="hl-comment">${m}</span>`),
  );

  // 2. Strings ("...", '...', and multiline `...`)
  html = html.replace(/(".*?"|'.*?'|`[\s\S]*?`)/g, (m) => {
    const perLine = m
      .split("\n")
      .map((line) => `<span class="hl-str">${line}</span>`)
      .join("\n");
    return saveToken(perLine);
  });

  // 3. Angular / TS decorators
  html = html.replace(/@(Component|Injectable)\b/g, (m) =>
    saveToken(`<span class="hl-fn">${m}</span>`),
  );

  // 4. Keywords (safe because strings & comments are already tokenized)
  html = html.replace(
    /\b(await|async|const|let|var|function|return|true|false|null|import|from|new|export|class|implements|extends|override|super|type|for|of|if|throw|private)\b/g,
    (m) => saveToken(`<span class="hl-kw">${m}</span>`),
  );

  // 5. Types
  html = html.replace(
    /\b(UUID|ULID|TEXT|INT32|INT64|FLOAT64|BLOB|WebDB|WasmEngine|JsEngine|IdbStorage|OpfsStorage|MemoryStorage|RemoteCatalogStorage|IVfsAdapter|RequestInit|Array|URL|DataType|Intl|Promise|Uint8Array|Error|string|number|boolean)\b/g,
    (m) => saveToken(`<span class="hl-type">${m}</span>`),
  );

  // 6. Function calls
  html = html.replace(
    /\b(createTable|createIndex|from|where|whereNotNull|orderBy|limit|toArray|transaction|insert|insertMany|update|open|useLiveQuery|useLiveQueryData|liveQuerySignal|liveQuery\$|liveQuery|live|join|select|sum|count|groupBy|having|ref|signal|injectWebDB|useWebDB|provideWebDB|randomUUID|catch|renderOrders|readPages|writePages|fetch|arrayBuffer|subarray|registerFunction|registerBatchedFunction|createSearchIndex|buildQuery|NumberFormat)\b(?=\()/g,
    (m) => saveToken(`<span class="hl-fn">${m}</span>`),
  );

  // 7. Numbers
  html = html.replace(/\b(\d+(\.\d+)?)\b/g, (m) =>
    saveToken(`<span class="hl-num">${m}</span>`),
  );

  // Restore tokens
  html = html.replace(/___TOKEN_(\d+)___/g, (_, idx) => tokens[Number(idx)]);

  return html;
}

const renderedLines = computed(() =>
  highlightCode(codeSnippets[activeTab.value]).split("\n"),
);

const renderedFrameworkLines = computed(() =>
  highlightCode(frameworkSnippets[activeFrameworkTab.value]).split("\n"),
);

const copyStatus = ref(false);
const copyCode = () => {
  navigator.clipboard.writeText(codeSnippets[activeTab.value]);
  copyStatus.value = true;
  setTimeout(() => (copyStatus.value = false), 2000);
};

const copyFrameworkStatus = ref(false);
const copyFrameworkCode = () => {
  navigator.clipboard.writeText(frameworkSnippets[activeFrameworkTab.value]);
  copyFrameworkStatus.value = true;
  setTimeout(() => (copyFrameworkStatus.value = false), 2000);
};

const searchSnippet = `import { WebDB, WasmEngine, IdbStorage } from "@ahmadmoussawi/webdb";
import { createSearchIndex } from "@ahmadmoussawi/webdb/search";
import { useLiveQuery } from "@ahmadmoussawi/webdb/react"; // or vue, angular

const db = await WebDB.open({
  engine: new WasmEngine(),
  storage: new IdbStorage("docs_app"),
});

// 1. Create a search index directly over your existing table (always in sync)
const articleSearch = createSearchIndex(db, {
  table: "articles",
  fields: [
    { name: "title", weight: 10, highlight: true }, // exact > prefix > typos
    { name: "tags", weight: 5 },
    { name: "body", weight: 1, snippet: true },     // extracts <mark> snippets
  ],
});

// 2. Reactively search with typo tolerance and live query updates as you type
const { data: results } = useLiveQuery(
  () =>
    articleSearch.buildQuery(searchQuery.value, {
      fuzzy: true,  // Typo tolerance ("reactve" -> "reactive")
      prefix: true, // Auto-completes word prefixes ("persist" -> "persistence")
      filter: (qb) => (category.value ? qb.where("category", "=", category.value) : qb),
      limit: 20,
    }),
  [searchQuery, category],
  { db }
);`;

const renderedSearchLines = computed(() =>
  highlightCode(searchSnippet).split("\n"),
);

const copySearchStatus = ref(false);
const copySearchCode = () => {
  navigator.clipboard.writeText(searchSnippet);
  copySearchStatus.value = true;
  setTimeout(() => (copySearchStatus.value = false), 2000);
};

const udfSnippet = `import { WebDB, WasmEngine, IdbStorage, DataType } from "@ahmadmoussawi/webdb";

const db = await WebDB.open({
  engine: new WasmEngine(),
  storage: new IdbStorage("app_db"),
});

// 1. Use native Browser Web APIs right inside your queries
db.registerFunction("format_money", (amount, currency = "USD") => {
  if (amount === null) return null;
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(Number(amount));
});

// 2. Batch mode processes rows in chunks to keep large queries fast
db.registerBatchedFunction(
  "calc_discount",
  (argsBatch) => {
    // Runs once per batch instead of once per row:
    return argsBatch.map(([price, discountPercent]) =>
      Number(price) * (1 - Number(discountPercent) / 100)
    );
  },
  { returnType: DataType.FLOAT64, deterministic: true }
);

// 3. Use seamlessly inside fluent queries: .select(), .where(), .orderBy()
const deals = await db
  .from("products")
  .select([
    "id",
    "name",
    "format_money(calc_discount(price, 20)) as discounted_price",
  ])
  .where("calc_discount(price, 20) < 50")
  .toArray();`;

const renderedUdfLines = computed(() =>
  highlightCode(udfSnippet).split("\n"),
);

const copyUdfStatus = ref(false);
const copyUdfCode = () => {
  navigator.clipboard.writeText(udfSnippet);
  copyUdfStatus.value = true;
  setTimeout(() => (copyUdfStatus.value = false), 2000);
};

const installCopied = ref(false);
const copyInstallCmd = () => {
  navigator.clipboard.writeText("npm install @ahmadmoussawi/webdb");
  installCopied.value = true;
  setTimeout(() => (installCopied.value = false), 2000);
};

interface EngineBenchMetric {
  ops: number;
  opsFormatted: string;
  meanMs: string;
  minMs: string;
  p95Ms: string;
  pct: number;
}

interface BenchmarkScenario {
  id: string;
  name: string;
  shortTitle: string;
  shortDesc: string;
  speedupVsSqlite: string;
  speedupHeadline: string;
  jsVsSqliteLabel: string;
  jsBeatsSqlite: boolean;
  webdbWasm: EngineBenchMetric;
  webdbJs: EngineBenchMetric;
  sqliteWasm: EngineBenchMetric;
}

const benchmarkScenarios: BenchmarkScenario[] = [
  {
    id: "range-scan",
    name: "1. Range Filter Scan",
    shortTitle: "RANGE FILTER SCAN",
    shortDesc: "Multi-condition range filter over 5,000 rows",
    speedupVsSqlite: "8.7x faster",
    speedupHeadline: "8.7x Faster",
    jsVsSqliteLabel: "3.5x Faster",
    jsBeatsSqlite: true,
    webdbWasm: {
      ops: 1091.7,
      opsFormatted: "1,091.7 ops/s",
      meanMs: "0.92 ms",
      minMs: "0.88 ms",
      p95Ms: "1.00 ms",
      pct: 100,
    },
    webdbJs: {
      ops: 444.0,
      opsFormatted: "444.0 ops/s",
      meanMs: "2.25 ms",
      minMs: "2.20 ms",
      p95Ms: "2.32 ms",
      pct: 40.7,
    },
    sqliteWasm: {
      ops: 125.9,
      opsFormatted: "125.9 ops/s",
      meanMs: "7.94 ms",
      minMs: "7.19 ms",
      p95Ms: "10.46 ms",
      pct: 11.5,
    },
  },
  {
    id: "bulk-insert",
    name: "2. Bulk Batch Insert",
    shortTitle: "BULK BATCH INSERT",
    shortDesc: "5,000 rows inserted in a single atomic transaction",
    speedupVsSqlite: "2.3x faster",
    speedupHeadline: "2.3x Faster",
    jsVsSqliteLabel: "1.9x Faster",
    jsBeatsSqlite: true,
    webdbWasm: {
      ops: 359152.4,
      opsFormatted: "359,152 ops/s",
      meanMs: "13.92 ms",
      minMs: "13.33 ms",
      p95Ms: "14.41 ms",
      pct: 100,
    },
    webdbJs: {
      ops: 301932.4,
      opsFormatted: "301,932 ops/s",
      meanMs: "16.56 ms",
      minMs: "16.24 ms",
      p95Ms: "17.14 ms",
      pct: 84.1,
    },
    sqliteWasm: {
      ops: 156576.2,
      opsFormatted: "156,576 ops/s",
      meanMs: "31.93 ms",
      minMs: "30.82 ms",
      p95Ms: "33.57 ms",
      pct: 43.6,
    },
  },
  {
    id: "point-lookups",
    name: "3. Batch Point Lookups (IN)",
    shortTitle: "BATCH POINT LOOKUPS",
    shortDesc: "Primary-key lookups via WHERE id IN (...)",
    speedupVsSqlite: "2.3x faster",
    speedupHeadline: "2.3x Faster",
    jsVsSqliteLabel: "1.6x Faster",
    jsBeatsSqlite: true,
    webdbWasm: {
      ops: 334448.2,
      opsFormatted: "334,448 ops/s",
      meanMs: "0.30 ms",
      minMs: "0.26 ms",
      p95Ms: "0.34 ms",
      pct: 100,
    },
    webdbJs: {
      ops: 234192.0,
      opsFormatted: "234,192 ops/s",
      meanMs: "0.43 ms",
      minMs: "0.41 ms",
      p95Ms: "0.44 ms",
      pct: 70.0,
    },
    sqliteWasm: {
      ops: 148148.1,
      opsFormatted: "148,148 ops/s",
      meanMs: "0.68 ms",
      minMs: "0.66 ms",
      p95Ms: "0.69 ms",
      pct: 44.3,
    },
  },
  {
    id: "indexed-join",
    name: "4. Indexed 2-Table JOIN",
    shortTitle: "INDEXED 2-TABLE JOIN",
    shortDesc: "Relational INNER JOIN across 2 indexed tables",
    speedupVsSqlite: "1.7x faster",
    speedupHeadline: "1.7x Faster",
    jsVsSqliteLabel: "1.1x Faster",
    jsBeatsSqlite: true,
    webdbWasm: {
      ops: 755.3,
      opsFormatted: "755.3 ops/s",
      meanMs: "1.32 ms",
      minMs: "1.28 ms",
      p95Ms: "1.42 ms",
      pct: 100,
    },
    webdbJs: {
      ops: 494.6,
      opsFormatted: "494.6 ops/s",
      meanMs: "2.02 ms",
      minMs: "1.98 ms",
      p95Ms: "2.07 ms",
      pct: 65.5,
    },
    sqliteWasm: {
      ops: 440.1,
      opsFormatted: "440.1 ops/s",
      meanMs: "2.27 ms",
      minMs: "2.22 ms",
      p95Ms: "2.36 ms",
      pct: 58.3,
    },
  },
  {
    id: "filter-sort-limit",
    name: "5. Filter + Sort + Limit",
    shortTitle: "FILTER + SORT + LIMIT",
    shortDesc: "Compound WHERE filter + ORDER BY + LIMIT pagination",
    speedupVsSqlite: "1.6x faster",
    speedupHeadline: "1.6x Faster",
    jsVsSqliteLabel: "0.5x",
    jsBeatsSqlite: false,
    webdbWasm: {
      ops: 2381.0,
      opsFormatted: "2,381.0 ops/s",
      meanMs: "0.42 ms",
      minMs: "0.32 ms",
      p95Ms: "0.47 ms",
      pct: 100,
    },
    webdbJs: {
      ops: 681.7,
      opsFormatted: "681.7 ops/s",
      meanMs: "1.47 ms",
      minMs: "1.44 ms",
      p95Ms: "1.52 ms",
      pct: 28.6,
    },
    sqliteWasm: {
      ops: 1483.7,
      opsFormatted: "1,483.7 ops/s",
      meanMs: "0.67 ms",
      minMs: "0.65 ms",
      p95Ms: "0.74 ms",
      pct: 62.3,
    },
  },
  {
    id: "analytics-agg",
    name: "6. Analytics Aggregation",
    shortTitle: "ANALYTICS AGGREGATION",
    shortDesc: "GROUP BY with COUNT, SUM & AVG aggregate functions",
    speedupVsSqlite: "1.4x faster",
    speedupHeadline: "1.4x Faster",
    jsVsSqliteLabel: "0.3x",
    jsBeatsSqlite: false,
    webdbWasm: {
      ops: 2392.3,
      opsFormatted: "2,392.3 ops/s",
      meanMs: "0.42 ms",
      minMs: "0.31 ms",
      p95Ms: "0.56 ms",
      pct: 100,
    },
    webdbJs: {
      ops: 559.0,
      opsFormatted: "559.0 ops/s",
      meanMs: "1.79 ms",
      minMs: "1.78 ms",
      p95Ms: "1.81 ms",
      pct: 23.4,
    },
    sqliteWasm: {
      ops: 1689.2,
      opsFormatted: "1,689.2 ops/s",
      meanMs: "0.59 ms",
      minMs: "0.58 ms",
      p95Ms: "0.60 ms",
      pct: 70.6,
    },
  },
];

const benchAnimated = ref(false);
const activeBenchIndex = ref(0);
const activeBenchSlide = computed(
  () => benchmarkScenarios[activeBenchIndex.value],
);
let carouselTimer: ReturnType<typeof setInterval> | null = null;

const startCarousel = () => {
  stopCarousel();
  carouselTimer = setInterval(() => {
    activeBenchIndex.value =
      (activeBenchIndex.value + 1) % benchmarkScenarios.length;
  }, 3800);
};

const stopCarousel = () => {
  if (carouselTimer) {
    clearInterval(carouselTimer);
    carouselTimer = null;
  }
};

const selectBenchSlide = (idx: number) => {
  activeBenchIndex.value = idx;
  startCarousel();
};

onMounted(() => {
  setTimeout(() => {
    benchAnimated.value = true;
  }, 120);
  startCarousel();
});

onBeforeUnmount(() => {
  stopCarousel();
});
</script>

<template>
  <div class="webdb-landing">
    <!-- ======================================================================
         1. FOCUSED HERO SECTION
         ====================================================================== -->
    <header class="hero-section">
      <div class="hero-glow" aria-hidden="true"></div>

      <div class="hero-eyebrow">
        <span class="status-dot"></span>
        <span class="eyebrow-tag"
          >{{ SIZE_METRICS.wasmGzip }} GZIPPED WASM CORE</span
        >
        <span class="eyebrow-sep">•</span>
        <span class="eyebrow-text">WASM &amp; Pure JS</span>
        <span class="eyebrow-sep">•</span>
        <span class="eyebrow-text">Zero Server Headers</span>
      </div>

      <h1 class="hero-title">
        The Relational Database<br />
        <span class="hero-gradient">Built Native for the Browser.</span>
      </h1>

      <p class="hero-lead">
        Type-safe relational queries, reactive <strong>Live Queries</strong>,
        and typo-tolerant search over IndexedDB &amp; OPFS. Tiny bundle, dual
        WASM/JS core, and zero <code>COOP/COEP</code> server headers.
      </p>

      <div class="hero-actions">
        <a :href="withBase('/getting-started')" class="btn btn-primary">
          <span>Get Started</span>
          <span class="btn-arrow">→</span>
        </a>

        <a :href="withBase('/demos/')" class="btn btn-secondary">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="currentColor"
          >
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
          <span>Try Live Demos</span>
        </a>
      </div>

      <!-- ONE-CLICK INSTALL COMMAND PILL -->
      <div class="hero-install-wrap">
        <button
          class="install-pill"
          title="Click to copy install command"
          @click="copyInstallCmd"
        >
          <span class="install-prompt">$</span>
          <code>npm install @ahmadmoussawi/webdb</code>
          <span class="install-copy-badge">
            {{ installCopied ? "Copied ✓" : "Copy" }}
          </span>
        </button>
      </div>

      <!-- 4-CARD VALUE STRIP -->
      <div class="hero-metrics">
        <div class="metric-card">
          <span class="metric-pill pill-emerald">SMALL BUNDLE</span>
          <div class="metric-val">{{ SIZE_METRICS.wasmGzip }}</div>
          <div class="metric-label">Gzipped WASM Core</div>
          <div class="metric-desc">
            ~95% smaller than desktop SQLite &amp; PGlite ports, with
            tree-shakeable subpath imports.
          </div>
        </div>

        <div class="metric-card">
          <span class="metric-pill pill-cyan">ZERO SERVER CONFIG</span>
          <div class="metric-val">IDB + OPFS</div>
          <div class="metric-label">Async Storage Anywhere</div>
          <div class="metric-desc">
            Deploy to Vercel, Netlify, GitHub Pages, or S3 with zero
            <code>COOP/COEP</code> headers.
          </div>
        </div>

        <div class="metric-card">
          <span class="metric-pill pill-violet">DUAL CORE</span>
          <div class="metric-val">WASM + JS</div>
          <div class="metric-label">Works in Restricted CSP</div>
          <div class="metric-desc">
            Full speed in WebAssembly, or swap to the Pure JS engine in one line
            when WASM is blocked.
          </div>
        </div>

        <div class="metric-card">
          <span class="metric-pill pill-rose">REACTIVE UI</span>
          <div class="metric-val">Live Queries</div>
          <div class="metric-label">Auto-Updating Components</div>
          <div class="metric-desc">
            <code>&lt; 1 KB</code> adapters for React, Vue 3, Angular &amp; JS
            that stay in sync across browser tabs.
          </div>
        </div>
      </div>
    </header>

    <!-- ======================================================================
         2. DEVELOPER EXPERIENCE CODE SHOWCASE
         ====================================================================== -->
    <section class="section-block">
      <div class="section-header-center">
        <span class="section-eyebrow">DEVELOPER EXPERIENCE</span>
        <h2 class="section-title">Up and Running in 10 Lines</h2>
        <p class="section-subtitle">
          Define typed tables, persist asynchronously to IndexedDB or OPFS,
          switch between WASM and Pure JS in one line, or plug in your own
          custom storage backend.
        </p>
      </div>

      <div class="terminal-window">
        <div class="terminal-header">
          <div class="terminal-dots" aria-hidden="true">
            <span class="tdot tdot-red"></span>
            <span class="tdot tdot-amber"></span>
            <span class="tdot tdot-green"></span>
          </div>
          <div class="terminal-tabs">
            <button
              :class="['ttab', { active: activeTab === 'quickstart' }]"
              @click="activeTab = 'quickstart'"
            >
              quick-start.ts
            </button>
            <button
              :class="['ttab', { active: activeTab === 'dualcore' }]"
              @click="activeTab = 'dualcore'"
            >
              dual-core.ts
            </button>
            <button
              :class="['ttab', { active: activeTab === 'customstorage' }]"
              @click="activeTab = 'customstorage'"
            >
              custom-storage.ts
            </button>
            <button
              :class="['ttab', { active: activeTab === 'transactions' }]"
              @click="activeTab = 'transactions'"
            >
              transactions.ts
            </button>
          </div>
          <button class="terminal-copy" @click="copyCode">
            {{ copyStatus ? "Copied ✓" : "Copy" }}
          </button>
        </div>

        <div class="terminal-body">
          <div
            v-for="(line, index) in renderedLines"
            :key="index"
            class="code-line"
          >
            <span class="line-num">{{ index + 1 }}</span>
            <span class="line-content" v-html="line || '&nbsp;'"></span>
          </div>
        </div>
      </div>
    </section>

    <!-- ======================================================================
         3. REACTIVE LIVE QUERIES & FRAMEWORK INTEGRATIONS
         ====================================================================== -->
    <section class="section-block live-section">
      <div class="section-header-center">
        <span class="section-eyebrow eyebrow-emerald">
          FRAMEWORK INTEGRATIONS
        </span>
        <h2 class="section-title">
          Reactive Live Queries for React, Vue, Angular &amp; JS
        </h2>
        <p class="section-subtitle">
          No manual cache keys, no event buses, no stale UI state. WebDB tracks
          every table and join your query uses and updates your components
          automatically—even across open browser tabs.
        </p>
      </div>

      <div class="live-showcase-stack">
        <!-- 4-COLUMN FRAMEWORK SELECTOR BAR -->
        <div class="fw-selector-bar">
          <button
            v-for="fw in [
              'react',
              'vue',
              'angular',
              'vanilla',
            ] as FrameworkTab[]"
            :key="fw"
            :class="[
              'fw-selector-card',
              `fw-card-${fw}`,
              { active: activeFrameworkTab === fw },
            ]"
            @click="activeFrameworkTab = fw"
          >
            <div class="fw-selector-top">
              <div class="fw-brand-group">
                <span
                  :class="['fw-logo-box', `fw-logo-${fw}`]"
                  aria-hidden="true"
                >
                  <!-- React Atom Logo -->
                  <svg
                    v-if="fw === 'react'"
                    viewBox="-11.5 -10.23174 23 20.46348"
                    width="34"
                    height="34"
                  >
                    <circle cx="0" cy="0" r="2.05" fill="#61DAFB" />
                    <g stroke="#61DAFB" stroke-width="1.2" fill="none">
                      <ellipse rx="11" ry="4.2" />
                      <ellipse rx="11" ry="4.2" transform="rotate(60)" />
                      <ellipse rx="11" ry="4.2" transform="rotate(120)" />
                    </g>
                  </svg>

                  <!-- Vue 3 Logo -->
                  <svg
                    v-else-if="fw === 'vue'"
                    viewBox="0 0 256 221"
                    width="32"
                    height="32"
                  >
                    <path
                      fill="#41B883"
                      d="M204.8 0H256L128 220.8 0 0h97.92L128 51.2 157.44 0h47.36Z"
                    />
                    <path
                      fill="#41B883"
                      d="m0 0 128 220.8L256 0h-51.2L128 132.48 50.56 0H0Z"
                    />
                    <path
                      fill="#35495E"
                      d="M50.56 0 128 133.12 204.8 0h-47.36L128 51.2 97.92 0H50.56Z"
                    />
                  </svg>

                  <!-- Angular Shield Logo -->
                  <svg
                    v-else-if="fw === 'angular'"
                    viewBox="25 25 200 210"
                    width="34"
                    height="34"
                  >
                    <polygon
                      fill="#DD0031"
                      points="125,30 125,30 125,30 31.9,63.2 46.1,186.3 125,230 125,230 125,230 203.9,186.3 218.1,63.2"
                    />
                    <polygon
                      fill="#C3002F"
                      points="125,30 125,52.2 125,52.1 125,153.4 125,153.4 125,230 125,230 203.9,186.3 218.1,63.2 125,30"
                    />
                    <path
                      fill="#FFFFFF"
                      d="M125,52.1L66.8,182.6h0h21.7h0l11.7-29.2h49.4l11.7,29.2h0h21.7h0L125,52.1L125,52.1L125,52.1L125,52.1 L125,52.1z M142,135.4H108l17-40.9L142,135.4z"
                    />
                  </svg>

                  <!-- TypeScript / JavaScript Logo -->
                  <svg v-else viewBox="0 0 256 256" width="32" height="32">
                    <rect width="256" height="256" rx="36" fill="#3178C6" />
                    <path
                      fill="#FFFFFF"
                      d="M150.5 200.5v27.7c4.5 2.3 9.9 4.1 16.2 5.3 6.3 1.2 13 1.8 20.1 1.8 6.9 0 13.3-.7 19.3-2 6-1.3 11.2-3.5 15.6-6.5 4.4-3 7.9-6.9 10.4-11.7 2.5-4.8 3.8-10.7 3.8-17.7 0-5.1-.8-9.5-2.3-13.2-1.5-3.7-3.8-7-6.8-9.8-3-2.8-6.6-5.3-10.9-7.5-4.3-2.2-9.2-4.3-14.8-6.4-4.1-1.5-7.6-3-10.5-4.3-2.9-1.3-5.2-2.7-7-4.1-1.8-1.4-3.1-2.9-3.9-4.5-.8-1.6-1.2-3.5-1.2-5.6 0-1.9.5-3.6 1.5-5.1 1-1.5 2.4-2.8 4.3-3.8 1.9-1 4.2-1.8 6.9-2.3 2.7-.5 5.8-.8 9.2-.8 5 0 9.9.6 14.8 1.9 4.9 1.3 9.4 3.2 13.5 5.8v-26.2c-4.1-1.6-8.7-2.8-13.8-3.6-5.1-.8-10.8-1.2-17.1-1.2-6.8 0-13.1.8-18.9 2.3-5.8 1.5-10.9 3.8-15.2 6.9-4.3 3.1-7.7 7-10.1 11.7-2.4 4.7-3.6 10.2-3.6 16.5 0 8.2 2.4 15.1 7.1 20.7 4.7 5.6 11.9 10.3 21.6 14.1 3.8 1.5 7.2 2.9 10.2 4.3 3 1.4 5.5 2.8 7.5 4.3 2 1.5 3.5 3.1 4.5 4.9 1 1.8 1.5 3.8 1.5 6.1 0 2.1-.5 3.9-1.4 5.5-.9 1.6-2.3 2.9-4.2 4-1.9 1.1-4.3 1.9-7.2 2.4-2.9.5-6.3.8-10.1.8-6.4 0-12.5-1.1-18.3-3.2-5.8-2.1-11-5.1-15.6-9zM105.7 137.4H140V113H41v24.4h34.2v95.6h30.5v-95.6z"
                    />
                  </svg>
                </span>
                <span class="fw-selector-name">{{
                  frameworkMeta[fw].label
                }}</span>
              </div>
              <span v-if="frameworkMeta[fw].size" class="fw-selector-size">{{
                frameworkMeta[fw].size
              }}</span>
            </div>
            <div class="fw-selector-pkg">
              <code>{{ frameworkMeta[fw].pkg }}</code>
            </div>
          </button>
        </div>

        <!-- FULL-WIDTH LIVE FRAMEWORK CODE WINDOW -->
        <div class="terminal-window fw-code-window">
          <div class="terminal-header">
            <div class="terminal-dots" aria-hidden="true">
              <span class="tdot tdot-red"></span>
              <span class="tdot tdot-amber"></span>
              <span class="tdot tdot-green"></span>
            </div>
            <div class="fw-window-title">
              <span class="fw-window-icon" aria-hidden="true">
                <svg
                  v-if="activeFrameworkTab === 'react'"
                  viewBox="-11.5 -10.23174 23 20.46348"
                  width="22"
                  height="22"
                >
                  <circle cx="0" cy="0" r="2.05" fill="#61DAFB" />
                  <g stroke="#61DAFB" stroke-width="1.2" fill="none">
                    <ellipse rx="11" ry="4.2" />
                    <ellipse rx="11" ry="4.2" transform="rotate(60)" />
                    <ellipse rx="11" ry="4.2" transform="rotate(120)" />
                  </g>
                </svg>
                <svg
                  v-else-if="activeFrameworkTab === 'vue'"
                  viewBox="0 0 256 221"
                  width="20"
                  height="20"
                >
                  <path
                    fill="#41B883"
                    d="m0 0 128 220.8L256 0h-51.2L128 132.48 50.56 0H0Z"
                  />
                  <path
                    fill="#35495E"
                    d="M50.56 0 128 133.12 204.8 0h-47.36L128 51.2 97.92 0H50.56Z"
                  />
                </svg>
                <svg
                  v-else-if="activeFrameworkTab === 'angular'"
                  viewBox="25 25 200 210"
                  width="22"
                  height="22"
                >
                  <polygon
                    fill="#DD0031"
                    points="125,30 31.9,63.2 46.1,186.3 125,230 203.9,186.3 218.1,63.2"
                  />
                  <path
                    fill="#FFFFFF"
                    d="M125,52.1L66.8,182.6h21.7l11.7-29.2h49.4l11.7,29.2h21.7L125,52.1z M142,135.4H108l17-40.9L142,135.4z"
                  />
                </svg>
                <svg v-else viewBox="0 0 256 256" width="20" height="20">
                  <rect width="256" height="256" rx="36" fill="#3178C6" />
                  <path
                    fill="#FFFFFF"
                    d="M150.5 200.5v27.7c4.5 2.3 9.9 4.1 16.2 5.3 6.3 1.2 13 1.8 20.1 1.8 6.9 0 13.3-.7 19.3-2 6-1.3 11.2-3.5 15.6-6.5 4.4-3 7.9-6.9 10.4-11.7 2.5-4.8 3.8-10.7 3.8-17.7 0-5.1-.8-9.5-2.3-13.2-1.5-3.7-3.8-7-6.8-9.8-3-2.8-6.6-5.3-10.9-7.5-4.3-2.2-9.2-4.3-14.8-6.4-4.1-1.5-7.6-3-10.5-4.3-2.9-1.3-5.2-2.7-7-4.1-1.8-1.4-3.1-2.9-3.9-4.5-.8-1.6-1.2-3.5-1.2-5.6 0-1.9.5-3.6 1.5-5.1 1-1.5 2.4-2.8 4.3-3.8 1.9-1 4.2-1.8 6.9-2.3 2.7-.5 5.8-.8 9.2-.8 5 0 9.9.6 14.8 1.9 4.9 1.3 9.4 3.2 13.5 5.8v-26.2c-4.1-1.6-8.7-2.8-13.8-3.6-5.1-.8-10.8-1.2-17.1-1.2-6.8 0-13.1.8-18.9 2.3-5.8 1.5-10.9 3.8-15.2 6.9-4.3 3.1-7.7 7-10.1 11.7-2.4 4.7-3.6 10.2-3.6 16.5 0 8.2 2.4 15.1 7.1 20.7 4.7 5.6 11.9 10.3 21.6 14.1 3.8 1.5 7.2 2.9 10.2 4.3 3 1.4 5.5 2.8 7.5 4.3 2 1.5 3.5 3.1 4.5 4.9 1 1.8 1.5 3.8 1.5 6.1 0 2.1-.5 3.9-1.4 5.5-.9 1.6-2.3 2.9-4.2 4-1.9 1.1-4.3 1.9-7.2 2.4-2.9.5-6.3.8-10.1.8-6.4 0-12.5-1.1-18.3-3.2-5.8-2.1-11-5.1-15.6-9zM105.7 137.4H140V113H41v24.4h34.2v95.6h30.5v-95.6z"
                  />
                </svg>
              </span>
              <span class="fw-file-name">{{
                frameworkMeta[activeFrameworkTab].file
              }}</span>
              <span class="fw-badge-pill">{{
                frameworkMeta[activeFrameworkTab].badge
              }}</span>
            </div>
            <button class="terminal-copy" @click="copyFrameworkCode">
              {{ copyFrameworkStatus ? "Copied ✓" : "Copy" }}
            </button>
          </div>

          <div class="terminal-body">
            <div
              v-for="(line, index) in renderedFrameworkLines"
              :key="index"
              class="code-line"
            >
              <span class="line-num">{{ index + 1 }}</span>
              <span class="line-content" v-html="line || '&nbsp;'"></span>
            </div>
          </div>
        </div>

        <!-- 3 HORIZONTAL HIGHLIGHT CARDS -->
        <div class="live-highlights-grid">
          <div class="live-highlight-card">
            <div class="lh-badge">ZERO CACHE KEYS</div>
            <h4 class="lh-title">Automatic Table &amp; JOIN Tracking</h4>
            <p class="lh-desc">
              Knows every table and <code>JOIN</code> your query reads—only
              refreshing the components affected by a write.
            </p>
          </div>

          <div class="live-highlight-card">
            <div class="lh-badge">MULTI-TAB SYNC</div>
            <h4 class="lh-title">Real-Time Cross-Tab Updates</h4>
            <p class="lh-desc">
              Uses the browser’s native <code>BroadcastChannel</code> so edits
              in one tab or worker update every other open tab instantly.
            </p>
          </div>

          <div class="live-highlight-card">
            <div class="lh-badge">&lt; 1 KB SUBPATHS</div>
            <h4 class="lh-title">Zero Core Bundle Bloat</h4>
            <p class="lh-desc">
              Each framework adapter is an isolated subpath export under
              <code>1 KB</code> gzipped with optional peer dependencies.
            </p>
          </div>
        </div>

        <div class="fw-guide-row">
          <a :href="withBase('/demos/multi-tab')" class="btn btn-primary">
            <span>Try Two-Tab Live Demo</span>
            <span class="btn-arrow">→</span>
          </a>
          <a
            :href="withBase('/guides/live-queries-and-frameworks')"
            class="btn btn-secondary"
          >
            <span>Explore Live Queries Guide</span>
            <span class="btn-arrow">→</span>
          </a>
        </div>
      </div>
    </section>

    <!-- ======================================================================
         4. BUILT WITH THE BROWSER (6-CARD BENTO GRID)
         ====================================================================== -->
    <section class="section-block">
      <div class="section-header-center">
        <span class="section-eyebrow">BUILT WITH THE BROWSER</span>
        <h2 class="section-title">
          Designed for Modern Web Apps, Not Desktop Ports
        </h2>
        <p class="section-subtitle">
          WebDB works with native browser APIs instead of fighting them—keeping
          your bundle tiny, your setup effortless, and your app resilient
          offline.
        </p>
      </div>

      <div class="bento-grid">
        <!-- BENTO 1 (WIDE): PLUGGABLE ASYNC STORAGE -->
        <div class="bento-card bento-wide">
          <div class="bento-tag tag-cyan">PLUGGABLE ASYNC STORAGE</div>
          <h3 class="bento-title">
            IndexedDB, OPFS, or Custom Storage
          </h3>
          <p class="bento-desc">
            Runs natively on the main thread or in Web Workers with zero
            <code>COOP/COEP</code> server headers. Pick built-in
            <strong>IdbStorage</strong>, <strong>OpfsStorage</strong>,
            <strong>MemoryStorage</strong>, or <strong>NodeFsStorage</strong>—or
            plug in your own adapter for S3 HTTP Range streaming, Electron,
            React Native, or KV stores in a few lines.
          </p>
          <div class="bento-pills">
            <span class="bento-chip">IdbStorage</span>
            <span class="bento-chip">OpfsStorage</span>
            <span class="bento-chip">MemoryStorage</span>
            <span class="bento-chip">Custom Adapters</span>
            <span class="bento-chip">Zero COOP/COEP</span>
          </div>
        </div>

        <!-- BENTO 2 (WIDE): EMBRACE WEB APIS & DUAL CORE -->
        <div class="bento-card bento-wide">
          <div class="bento-tag tag-emerald">EMBRACE WEB APIS &amp; DUAL CORE</div>
          <h3 class="bento-title">
            Native Browser APIs + WASM &amp; Pure JS
          </h3>
          <p class="bento-desc">
            Instead of shipping megabytes of duplicate C libraries, WebDB leans
            on native <code>Web Locks</code>, <code>BroadcastChannel</code>,
            <code>Intl</code>, <code>RegExp</code>, and <code>crypto</code>.
            Need to run in a strict-CSP enterprise app or browser extension
            where WebAssembly is disabled? Switch from
            <code>WasmEngine</code> to <code>JsEngine</code> in one line.
          </p>
          <div class="bento-pills">
            <span class="bento-chip"
              >WasmEngine ({{ SIZE_METRICS.wasmGzip }})</span
            >
            <span class="bento-chip">JsEngine (Pure JS)</span>
            <span class="bento-chip">Web Locks</span>
            <span class="bento-chip">BroadcastChannel</span>
            <span class="bento-chip">Intl &amp; crypto</span>
          </div>
        </div>

        <!-- BENTO 3: SMALL BUNDLE SIZE -->
        <div class="bento-card">
          <div class="bento-tag tag-violet">SMALL BUNDLE SIZE</div>
          <h3 class="bento-title">Tree-Shakeable Subpath Imports</h3>
          <p class="bento-desc">
            Import only what you use (<code>/slim</code>,
            <code>/core/wasm</code>, <code>/core/js</code>,
            <code>/storage/*</code>, <code>/react</code>) so unused engines and
            adapters stay completely out of your production bundle.
          </p>
        </div>

        <!-- BENTO 4: RELIABLE OFFLINE -->
        <div class="bento-card">
          <div class="bento-tag tag-amber">RELIABLE OFFLINE</div>
          <h3 class="bento-title">Crash-Safe Transactions &amp; Sync</h3>
          <p class="bento-desc">
            Atomic transactions with nested savepoints survive sudden tab
            closes, while commit hooks and coalesced changesets make syncing
            offline writes back to your server straightforward.
          </p>
        </div>

        <!-- BENTO 5: INSTANT HYDRATION -->
        <div class="bento-card">
          <div class="bento-tag tag-rose">INSTANT HYDRATION</div>
          <h3 class="bento-title">Compressed Snapshots &amp; CLI</h3>
          <p class="bento-desc">
            Export and restore full databases as compressed
            <code>.webdb.gz</code> snapshots in milliseconds, and inspect or
            query local database files from your terminal with
            <code>npx webdb</code>.
          </p>
        </div>

        <!-- BENTO 6: SCHEMA & MIGRATIONS -->
        <div class="bento-card">
          <div class="bento-tag tag-indigo">SCHEMA &amp; MIGRATIONS</div>
          <h3 class="bento-title">Typed Schemas, Indexes &amp; Migrations</h3>
          <p class="bento-desc">
            Define typed columns (<code>UUID</code>, <code>TEXT</code>,
            <code>INT32</code>, <code>FLOAT64</code>, <code>BLOB</code>),
            composite indexes, <code>ALTER TABLE</code> updates, and versioned
            migrations out of the box.
          </p>
        </div>
      </div>
    </section>

    <!-- ======================================================================
         5A. BUILT-IN TEXT SEARCH
         ====================================================================== -->
    <section class="section-block search-section">
      <div class="section-header-center">
        <span class="section-eyebrow eyebrow-amber">BUILT-IN TEXT SEARCH</span>
        <h2 class="section-title">
          Typo-Tolerant Full-Text Search, Zero Dependencies
        </h2>
        <p class="section-subtitle">
          Search directly across your existing tables with typo tolerance,
          prefix autocomplete, weighted relevance ranking, and highlighted
          snippets—using native browser APIs with zero extra sync tables.
        </p>
      </div>

      <div class="live-showcase-stack">
        <div class="terminal-window fw-code-window">
          <div class="terminal-header">
            <div class="terminal-dots" aria-hidden="true">
              <span class="tdot tdot-red"></span>
              <span class="tdot tdot-amber"></span>
              <span class="tdot tdot-green"></span>
            </div>
            <div class="fw-window-title">
              <span class="fw-file-name">SearchComponent.tsx</span>
              <span
                class="fw-badge-pill"
                style="color: #f59e0b; background: rgba(245, 158, 11, 0.14)"
              >
                @ahmadmoussawi/webdb/search
              </span>
            </div>
            <button class="terminal-copy" @click="copySearchCode">
              {{ copySearchStatus ? "Copied ✓" : "Copy" }}
            </button>
          </div>

          <div class="terminal-body">
            <div
              v-for="(line, index) in renderedSearchLines"
              :key="index"
              class="code-line"
            >
              <span class="line-num">{{ index + 1 }}</span>
              <span class="line-content" v-html="line || '&nbsp;'"></span>
            </div>
          </div>
        </div>

        <div class="live-highlights-grid">
          <div class="live-highlight-card">
            <div
              class="lh-badge"
              style="color: #f59e0b; background: rgba(245, 158, 11, 0.12)"
            >
              ALWAYS IN SYNC
            </div>
            <h4 class="lh-title">Zero Duplicate Sync Tables</h4>
            <p class="lh-desc">
              Queries your existing tables directly—so search results are always
              up to date after every insert, update, or delete.
            </p>
          </div>

          <div class="live-highlight-card">
            <div
              class="lh-badge"
              style="color: #10b981; background: rgba(16, 185, 129, 0.12)"
            >
              SMART RANKING
            </div>
            <h4 class="lh-title">Typo Tolerance &amp; Relevance</h4>
            <p class="lh-desc">
              Weighted multi-field scoring, prefix matching, and typo tolerance
              powered by native browser APIs with zero external dependencies.
            </p>
          </div>

          <div class="live-highlight-card">
            <div
              class="lh-badge"
              style="color: #06b6d4; background: rgba(6, 182, 212, 0.12)"
            >
              UI-READY
            </div>
            <h4 class="lh-title">Hit Highlights &amp; Snippets</h4>
            <p class="lh-desc">
              Automatically wraps matched keywords in safe
              <code>&lt;mark&gt;</code> tags and extracts contextual snippets
              ready to render in your UI.
            </p>
          </div>
        </div>

        <div class="fw-guide-row">
          <a :href="withBase('/demos/search')" class="btn btn-primary">
            <span>Try Interactive Live Search Demo</span>
            <span class="btn-arrow">→</span>
          </a>
          <a :href="withBase('/guides/fuzzy-search')" class="btn btn-secondary">
            <span>Explore Fuzzy Search Guide</span>
            <span class="btn-arrow">→</span>
          </a>
        </div>
      </div>
    </section>

    <!-- ======================================================================
         5B. JAVASCRIPT UDFs
         ====================================================================== -->
    <section class="section-block udf-section">
      <div class="section-header-center">
        <span class="section-eyebrow eyebrow-rose">
          CUSTOM JAVASCRIPT FUNCTIONS
        </span>
        <h2 class="section-title">
          Run Any JavaScript or Browser API Inside Queries
        </h2>
        <p class="section-subtitle">
          Register plain JavaScript functions to format dates and currency with
          <code>Intl</code>, match patterns with <code>RegExp</code>, or run
          custom business logic right inside <code>.select()</code>,
          <code>.where()</code>, and <code>.orderBy()</code>.
        </p>
      </div>

      <div class="live-showcase-stack">
        <div class="terminal-window fw-code-window">
          <div class="terminal-header">
            <div class="terminal-dots" aria-hidden="true">
              <span class="tdot tdot-red"></span>
              <span class="tdot tdot-amber"></span>
              <span class="tdot tdot-green"></span>
            </div>
            <div class="fw-window-title">
              <span class="fw-file-name">custom-functions.ts</span>
              <span
                class="fw-badge-pill"
                style="color: #f43f5e; background: rgba(244, 63, 94, 0.14)"
              >
                db.registerFunction()
              </span>
            </div>
            <button class="terminal-copy" @click="copyUdfCode">
              {{ copyUdfStatus ? "Copied ✓" : "Copy" }}
            </button>
          </div>

          <div class="terminal-body">
            <div
              v-for="(line, index) in renderedUdfLines"
              :key="index"
              class="code-line"
            >
              <span class="line-num">{{ index + 1 }}</span>
              <span class="line-content" v-html="line || '&nbsp;'"></span>
            </div>
          </div>
        </div>

        <div class="live-highlights-grid">
          <div class="live-highlight-card">
            <div
              class="lh-badge"
              style="color: #f43f5e; background: rgba(244, 63, 94, 0.12)"
            >
              BROWSER APIS BUILT IN
            </div>
            <h4 class="lh-title">Use Native Web APIs</h4>
            <p class="lh-desc">
              Call <code>Intl.DateTimeFormat</code>,
              <code>Intl.NumberFormat</code>, and <code>RegExp</code> directly
              inside queries without bundling heavy C libraries.
            </p>
          </div>

          <div class="live-highlight-card">
            <div
              class="lh-badge"
              style="color: #10b981; background: rgba(16, 185, 129, 0.12)"
            >
              FAST BATCH EXECUTION
            </div>
            <h4 class="lh-title">Automatic Chunked Batching</h4>
            <p class="lh-desc">
              <code>registerBatchedFunction</code> processes rows in batches
              rather than one call per row, keeping large filter and sort
              queries smooth.
            </p>
          </div>

          <div class="live-highlight-card">
            <div
              class="lh-badge"
              style="color: #8b5cf6; background: rgba(139, 92, 246, 0.12)"
            >
              SEAMLESS INTEGRATION
            </div>
            <h4 class="lh-title">Works Across Your Queries</h4>
            <p class="lh-desc">
              Use custom functions cleanly in projections, filters, and sorting,
              with optional return types for predictable TypeScript results.
            </p>
          </div>
        </div>

        <div class="fw-guide-row">
          <a
            :href="withBase('/guides/expressions-and-functions')"
            class="btn btn-primary"
          >
            <span>Read Expressions &amp; UDFs Guide</span>
            <span class="btn-arrow">→</span>
          </a>
          <a :href="withBase('/demos/search')" class="btn btn-secondary">
            <span>See UDFs in Live Demo</span>
            <span class="btn-arrow">→</span>
          </a>
        </div>
      </div>
    </section>

    <!-- ======================================================================
         6A. PROVEN PERFORMANCE (BENCHMARKS)
         ====================================================================== -->
    <section id="benchmarks" class="section-block bench-section">
      <div class="section-header-center">
        <span class="section-eyebrow eyebrow-emerald">PROVEN PERFORMANCE</span>
        <h2 class="section-title">
          Up to 8.7x Faster Than Official SQLite WASM
        </h2>
        <p class="section-subtitle">
          Because WebDB is built natively for TypeScript and browser
          storage—without a heavy SQL text parser or desktop C port—our
          <strong>{{ SIZE_METRICS.wasmGzip }} WASM engine</strong> outperforms
          <code>SQLite WASM (:memory:)</code> across all 6 workloads, while even
          <strong>WebDB Pure JS</strong> beats SQLite WASM in 4 out of 6.
          <a
            :href="withBase('/guides/performance-architecture')"
            class="inline-arch-link"
          >
            Read how WebDB stays fast →
          </a>
        </p>
      </div>

      <!-- INTERACTIVE BENCHMARK SPOTLIGHT CAROUSEL -->
      <div
        class="bench-spotlight-wrap"
        @mouseenter="stopCarousel"
        @mouseleave="startCarousel"
      >
        <div class="hero-bench-spotlight">
          <div class="hero-bench-top">
            <h3 class="hero-bench-headline">
              <span class="hero-speed-highlight">{{
                activeBenchSlide.speedupHeadline
              }}</span>
              Than SQLite WASM
            </h3>
            <p class="hero-bench-subdesc">{{ activeBenchSlide.shortDesc }}</p>
          </div>

          <div class="hero-bench-bars">
            <!-- WebDB Wasm -->
            <div class="hero-hbar-row row-winner">
              <div class="hero-hbar-label">
                <span class="dot dot-emerald-glow"></span>
                <span class="engine-main">WebDB</span>
                <span class="hero-hbar-tag tag-wasm">WASM</span>
              </div>
              <div class="hero-hbar-track">
                <div
                  class="hbar-fill hero-fill-wasm"
                  :style="{
                    width: benchAnimated
                      ? `${activeBenchSlide.webdbWasm.pct}%`
                      : '0%',
                  }"
                >
                  <span class="hbar-shimmer"></span>
                </div>
              </div>
              <div class="hero-hbar-val val-winner">
                {{ activeBenchSlide.speedupHeadline }}
              </div>
            </div>

            <!-- WebDB JS -->
            <div class="hero-hbar-row">
              <div class="hero-hbar-label">
                <span class="dot dot-violet"></span>
                <span class="engine-main">WebDB</span>
                <span class="hero-hbar-tag tag-js">JS</span>
              </div>
              <div class="hero-hbar-track">
                <div
                  class="hbar-fill hero-fill-js"
                  :style="{
                    width: benchAnimated
                      ? `${activeBenchSlide.webdbJs.pct}%`
                      : '0%',
                  }"
                ></div>
              </div>
              <div class="hero-hbar-val val-js">
                {{ activeBenchSlide.jsVsSqliteLabel }}
              </div>
            </div>

            <!-- SQLite WASM -->
            <div class="hero-hbar-row">
              <div class="hero-hbar-label">
                <span class="dot dot-amber"></span>
                <span class="label-muted">SQLite WASM</span>
              </div>
              <div class="hero-hbar-track">
                <div
                  class="hbar-fill hero-fill-sqlite"
                  :style="{
                    width: benchAnimated
                      ? `${activeBenchSlide.sqliteWasm.pct}%`
                      : '0%',
                  }"
                ></div>
              </div>
              <div class="hero-hbar-val val-muted">1x</div>
            </div>
          </div>

          <!-- CAROUSEL NAVIGATION DOTS -->
          <div
            class="hero-carousel-dots"
            role="tablist"
            aria-label="Benchmark scenarios"
          >
            <button
              v-for="(slide, idx) in benchmarkScenarios"
              :key="slide.id"
              type="button"
              role="tab"
              :aria-selected="activeBenchIndex === idx"
              :aria-label="slide.name"
              :title="slide.name"
              :class="['carousel-dot', { active: activeBenchIndex === idx }]"
              @click="selectBenchSlide(idx)"
            ></button>
          </div>
        </div>
      </div>

      <!-- FULL BENCHMARK RESULTS TABLE -->
      <div class="compare-table-wrap bench-table-wrap">
        <table class="compare-table bench-table">
          <thead>
            <tr>
              <th>Workload Scenario (5,000 Rows • In-Memory)</th>
              <th class="col-webdb-head">
                <div class="webdb-th-inner">
                  <span>WebDB (WASM)</span>
                </div>
              </th>
              <th>
                <div class="webdb-th-inner">
                  <span>WebDB (Pure JS)</span>
                </div>
              </th>
              <th>
                <div class="webdb-th-inner">
                  <span>SQLite WASM (:memory:)</span>
                </div>
              </th>
              <th>WebDB vs SQLite</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in benchmarkScenarios" :key="row.id">
              <td class="td-feature">
                <div class="bench-td-scenario">{{ row.name }}</div>
                <div class="bench-td-sub">{{ row.shortDesc }}</div>
              </td>
              <td class="td-good">
                <div class="bench-cell-ops">
                  <strong>{{ row.webdbWasm.opsFormatted }}</strong>
                </div>
                <div class="bench-cell-ms">
                  Mean {{ row.webdbWasm.meanMs }} • P95
                  {{ row.webdbWasm.p95Ms }}
                </div>
              </td>
              <td class="td-neutral">
                <div class="bench-cell-ops">
                  <strong>{{ row.webdbJs.opsFormatted }}</strong>
                </div>
                <div class="bench-cell-ms">
                  Mean {{ row.webdbJs.meanMs }} • P95 {{ row.webdbJs.p95Ms }}
                </div>
              </td>
              <td class="td-neutral">
                <div class="bench-cell-ops">
                  {{ row.sqliteWasm.opsFormatted }}
                </div>
                <div class="bench-cell-ms">
                  Mean {{ row.sqliteWasm.meanMs }} • P95
                  {{ row.sqliteWasm.p95Ms }}
                </div>
              </td>
              <td class="td-speedup">
                <span class="table-speedup-badge">
                  {{ row.speedupVsSqlite }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>

        <div class="bench-table-footer">
          <span class="bench-env-note">
            Hardware: <strong>MacBook Pro, Apple M1 Max 2021</strong> • Dataset:
            <strong>5,000 rows in memory</strong> • Higher ops/s &amp; lower ms
            is better
          </span>
          <a
            :href="withBase('/benchmark/')"
            target="_self"
            class="bench-run-link"
          >
            Run this benchmark live on your machine →
          </a>
        </div>
      </div>
    </section>

    <!-- ======================================================================
         6B. 3-WAY COMPARISON TABLE
         ====================================================================== -->
    <section class="section-block">
      <div class="section-header-center">
        <span class="section-eyebrow">ARCHITECTURAL COMPARISON</span>
        <h2 class="section-title">How WebDB Compares</h2>
        <p class="section-subtitle">
          Purpose-built to give you full relational queries with the tiny
          footprint and zero-config ergonomics of native browser APIs.
        </p>
      </div>

      <div class="compare-table-wrap">
        <table class="compare-table">
          <thead>
            <tr>
              <th>Capability</th>
              <th>Raw IndexedDB / Wrappers</th>
              <th>Ported Desktop WASM (SQLite / PGlite)</th>
              <th class="col-webdb-head">
                <div class="webdb-th-inner">
                  <span>WebDB</span>
                  <span class="webdb-th-badge">Browser-Native</span>
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="td-feature">Bundle Size</td>
              <td class="td-neutral">~15–40 KB (No query engine)</td>
              <td class="td-bad">1 MB – 5 MB+ WASM binary</td>
              <td class="td-good">
                <strong>{{ SIZE_METRICS.wasmGzip }} Gzipped WASM Core</strong>
                ({{ SIZE_METRICS.wasmRaw }} raw, tree-shakeable)
              </td>
            </tr>
            <tr>
              <td class="td-feature">Server Configuration</td>
              <td class="td-neutral">None required</td>
              <td class="td-bad">
                Often needs <code>COOP/COEP</code> headers &amp; worker proxies
              </td>
              <td class="td-good">
                <strong>Zero Headers</strong> — runs on any static host or CDN
              </td>
            </tr>
            <tr>
              <td class="td-feature">Strict CSP / Restricted Environments</td>
              <td class="td-neutral">Pure JS (works)</td>
              <td class="td-bad">Blocked if WASM is disallowed</td>
              <td class="td-good">
                <strong>Dual Core (WASM + Pure JS)</strong> — swap in one line
              </td>
            </tr>
            <tr>
              <td class="td-feature">Async Storage &amp; Custom Adapters</td>
              <td class="td-bad">IndexedDB only</td>
              <td class="td-warn">Complex C VFS / async shims</td>
              <td class="td-good">
                <strong>OPFS, IDB, Memory, Node, or Custom</strong> — clean
                async adapters
              </td>
            </tr>
            <tr>
              <td class="td-feature">Relational Queries</td>
              <td class="td-bad">Manual JS loops &amp; cursor code</td>
              <td class="td-neutral">Full SQL text parser</td>
              <td class="td-good">
                <strong>Fluent TypeScript</strong> JOINs, GROUP BY &amp;
                subqueries
              </td>
            </tr>
            <tr>
              <td class="td-feature">Reactive UI &amp; Multi-Tab Sync</td>
              <td class="td-neutral">Basic table hooks / polling</td>
              <td class="td-bad">DIY wrappers / manual invalidation</td>
              <td class="td-good">
                <strong>&lt;1 KB Adapters</strong> for React, Vue, Angular &amp;
                JS with cross-tab sync
              </td>
            </tr>
            <tr>
              <td class="td-feature">Full-Text Search &amp; Custom UDFs</td>
              <td class="td-bad">External packages required</td>
              <td class="td-neutral">Heavy extensions &amp; sync tables</td>
              <td class="td-good">
                <strong>Zero-Dependency Fuzzy Search</strong> + native JS UDFs
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ======================================================================
         7. TRY IT LIVE: INTERACTIVE DEMOS, STUDIO IDE & BENCHMARKS
         ====================================================================== -->
    <section class="section-block">
      <div class="section-header-center">
        <span class="section-eyebrow">TRY IT IN YOUR BROWSER</span>
        <h2 class="section-title">Experience WebDB Live — Zero Install</h2>
        <p class="section-subtitle">
          Every demo runs 100% locally in your browser with IndexedDB. Edit
          data, open a second tab, or refresh the page to see it persist.
        </p>
      </div>

      <div class="demos-strip">
        <a :href="withBase('/demos/multi-tab')" class="demo-preview-card">
          <span class="demo-preview-tag tag-emerald">MULTI-TAB SYNC</span>
          <h3 class="demo-preview-title">Two Tabs, One Database</h3>
          <p class="demo-preview-desc">
            Open two panes sharing one database and watch live queries sync
            changes instantaneously.
          </p>
          <span class="demo-preview-cta">Launch demo →</span>
        </a>

        <a :href="withBase('/demos/kanban')" class="demo-preview-card">
          <span class="demo-preview-tag tag-cyan">ATOMIC TRANSACTIONS</span>
          <h3 class="demo-preview-title">Kanban Board</h3>
          <p class="demo-preview-desc">
            Drag-and-drop task board where every move is saved locally in an
            atomic transaction.
          </p>
          <span class="demo-preview-cta">Launch demo →</span>
        </a>

        <a :href="withBase('/demos/search')" class="demo-preview-card">
          <span class="demo-preview-tag tag-amber">FUZZY SEARCH + UDFS</span>
          <h3 class="demo-preview-title">Typo-Tolerant Search</h3>
          <p class="demo-preview-desc">
            Live fuzzy search with highlights, relevance ranking, and custom
            JavaScript UDFs.
          </p>
          <span class="demo-preview-cta">Launch demo →</span>
        </a>
      </div>

      <div class="demos-all-row">
        <a :href="withBase('/demos/')" class="demos-all-link">
          Explore all 5 interactive demos →
        </a>
      </div>

      <div class="tools-grid">
        <!-- STUDIO IDE -->
        <div class="tool-card tool-card-primary">
          <div class="tool-badge-row">
            <span class="tool-pill pill-brand">IN-BROWSER DATABASE IDE</span>
            <span class="tool-sub">Supports .webdb.gz &amp; Remote URLs</span>
          </div>
          <h3 class="tool-title">WebDB Studio Playground</h3>
          <p class="tool-desc">
            Write and run queries in Monaco Editor, browse tables and schemas,
            and open or share <code>.webdb.gz</code> databases directly via URL.
          </p>
          <div class="tool-actions">
            <a href="https://studio.webdb.dev/" class="btn btn-primary">
              <span>Launch Studio IDE</span>
              <span class="btn-arrow">→</span>
            </a>
          </div>
        </div>

        <!-- BENCHMARK SUITE -->
        <div class="tool-card">
          <div class="tool-badge-row">
            <span class="tool-pill pill-emerald">LIVE PERFORMANCE SUITE</span>
            <span class="tool-sub">Runs on Your Hardware</span>
          </div>
          <h3 class="tool-title">In-Browser Benchmark Suite</h3>
          <p class="tool-desc">
            Measure real-time throughput and latency against Native IndexedDB
            and official SQLite WASM directly on your own hardware.
          </p>
          <div class="tool-actions">
            <a
              :href="withBase('/benchmark/')"
              target="_self"
              class="btn btn-secondary"
            >
              <span>Run Live Benchmarks</span>
              <span class="btn-arrow">→</span>
            </a>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.webdb-landing {
  max-width: 1180px;
  margin: 0 auto;
  padding: 2.5rem 1.75rem 6rem;
  font-family: var(--vp-font-family-base);
  color: var(--vp-c-text-1);
  overflow-x: clip;
}

code {
  font-family: var(--vp-font-family-mono);
}

/* ============================================================================
   1. HERO SECTION
   ============================================================================ */
.hero-section {
  position: relative;
  text-align: center;
  padding: 3.25rem 1rem 4.25rem;
  max-width: 980px;
  margin: 0 auto;
}

.hero-glow {
  position: absolute;
  top: -40px;
  left: 50%;
  transform: translateX(-50%);
  width: min(680px, 100vw);
  height: 320px;
  background: var(--webdb-hero-glow);
  pointer-events: none;
  z-index: 0;
  filter: blur(24px);
}

.hero-eyebrow {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.55rem;
  padding: 0.4rem 1rem;
  border-radius: 999px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  font-family: var(--vp-font-family-mono);
  font-size: 0.76rem;
  margin-bottom: 1.75rem;
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background-color: #10b981;
  box-shadow: 0 0 8px #10b981;
}

.eyebrow-tag {
  font-weight: 700;
  color: var(--vp-c-brand-1);
}

.eyebrow-sep {
  color: var(--vp-c-text-3);
}

.eyebrow-text {
  color: var(--vp-c-text-2);
  font-weight: 500;
}

.hero-title {
  position: relative;
  z-index: 1;
  font-size: 3.75rem;
  font-weight: 800;
  letter-spacing: -1.8px;
  line-height: 1.12;
  margin: 0 0 1.35rem;
  color: var(--vp-c-text-1);
}

.hero-gradient {
  background: linear-gradient(135deg, var(--vp-c-brand-1) 0%, #10b981 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.hero-lead {
  position: relative;
  z-index: 1;
  font-size: 1.18rem;
  line-height: 1.65;
  color: var(--vp-c-text-2);
  max-width: 720px;
  margin: 0 auto 2.25rem;
}

.hero-lead code {
  font-size: 0.92em;
  padding: 0.15rem 0.4rem;
  border-radius: 5px;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
}

.hero-actions {
  position: relative;
  z-index: 1;
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 1rem;
  margin-bottom: 1.35rem;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.82rem 1.65rem;
  border-radius: 10px;
  font-size: 0.92rem;
  font-weight: 700;
  text-decoration: none;
  cursor: pointer;
  transition: all 0.18s ease;
  border: 1px solid transparent;
}

.btn-primary {
  background: var(--vp-c-brand-1);
  color: var(--webdb-btn-primary-text);
  border-color: var(--vp-c-brand-1);
  box-shadow: var(--webdb-btn-primary-shadow);
}

.btn-primary:hover {
  background: var(--vp-c-brand-2);
  border-color: var(--vp-c-brand-2);
  transform: translateY(-1px);
}

.btn-secondary {
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  border-color: var(--vp-c-divider);
}

.btn-secondary:hover {
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-bg-mute);
  transform: translateY(-1px);
}

.btn-arrow {
  transition: transform 0.18s ease;
}

.btn:hover .btn-arrow {
  transform: translateX(3px);
}

/* INSTALL PILL */
.hero-install-wrap {
  position: relative;
  z-index: 1;
  display: flex;
  justify-content: center;
  margin-bottom: 3.25rem;
}

.install-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.65rem;
  max-width: 100%;
  box-sizing: border-box;
  padding: 0.5rem 0.65rem 0.5rem 1rem;
  border-radius: 999px;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  font-family: var(--vp-font-family-mono);
  font-size: 0.82rem;
  color: var(--vp-c-text-1);
  cursor: pointer;
  transition: border-color 0.18s ease;
}

.install-pill:hover {
  border-color: var(--vp-c-brand-1);
}

.install-prompt {
  color: var(--vp-c-brand-1);
  font-weight: 700;
}

.install-pill code {
  min-width: 0;
  overflow-wrap: anywhere;
  text-align: left;
}

.install-copy-badge {
  flex: none;
  font-size: 0.7rem;
  font-weight: 700;
  padding: 0.2rem 0.6rem;
  border-radius: 999px;
  background: var(--vp-c-bg-mute);
  color: var(--vp-c-text-2);
  border: 1px solid var(--vp-c-divider);
}

/* 4-CARD VALUE STRIP */
.hero-metrics {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1rem;
  text-align: left;
}

.metric-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  padding: 1.35rem 1.25rem;
  transition:
    border-color 0.2s ease,
    transform 0.2s ease;
}

.metric-card:hover {
  border-color: var(--vp-c-brand-1);
  transform: translateY(-2px);
}

.metric-val {
  font-family: var(--vp-font-family-mono);
  font-size: 1.5rem;
  font-weight: 800;
  color: var(--vp-c-text-1);
  letter-spacing: -0.5px;
  line-height: 1.2;
  margin-bottom: 0.35rem;
}

.metric-pill {
  display: inline-flex;
  align-items: center;
  white-space: nowrap;
  font-family: var(--vp-font-family-mono);
  font-size: 0.64rem;
  font-weight: 700;
  line-height: 1;
  padding: 0.28rem 0.58rem;
  border-radius: 999px;
  letter-spacing: 0.05em;
  margin-bottom: 0.65rem;
}

.pill-emerald {
  color: #10b981;
  background: rgba(16, 185, 129, 0.12);
}

.pill-cyan {
  color: #0ea5e9;
  background: rgba(14, 165, 233, 0.12);
}

.pill-violet {
  color: #8b5cf6;
  background: rgba(139, 92, 246, 0.12);
}

.pill-amber {
  color: #f59e0b;
  background: rgba(245, 158, 11, 0.12);
}

.pill-rose {
  color: #f43f5e;
  background: rgba(244, 63, 94, 0.12);
}

.metric-label {
  font-size: 0.92rem;
  font-weight: 700;
  color: var(--vp-c-text-1);
  margin-bottom: 0.25rem;
}

.metric-desc {
  font-size: 0.8rem;
  line-height: 1.45;
  color: var(--vp-c-text-2);
}

/* ============================================================================
   SECTIONS COMMON
   ============================================================================ */
.section-block {
  margin-bottom: 5.5rem;
}

.section-header-center {
  text-align: center;
  max-width: 780px;
  margin: 0 auto 2.5rem;
}

.section-eyebrow {
  display: inline-block;
  font-family: var(--vp-font-family-mono);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
  padding: 0.28rem 0.75rem;
  border-radius: 999px;
  margin-bottom: 0.85rem;
}

.eyebrow-emerald {
  color: #10b981;
  background: rgba(16, 185, 129, 0.12);
}

.eyebrow-amber {
  color: #f59e0b;
  background: rgba(245, 158, 11, 0.12);
}

.eyebrow-rose {
  color: #f43f5e;
  background: rgba(244, 63, 94, 0.12);
}

.section-title {
  font-size: 2.2rem;
  font-weight: 800;
  letter-spacing: -0.8px;
  margin: 0 0 0.85rem;
  color: var(--vp-c-text-1);
}

.section-subtitle {
  font-size: 1.05rem;
  line-height: 1.65;
  color: var(--vp-c-text-2);
  margin: 0;
}

.inline-arch-link {
  color: var(--vp-c-brand-1);
  font-weight: 600;
  text-decoration: none;
  margin-left: 0.25rem;
}

.inline-arch-link:hover {
  text-decoration: underline;
}

/* ============================================================================
   TERMINAL WINDOW — THEME-ADAPTIVE VIA CSS CUSTOM PROPERTIES
   ============================================================================ */
.terminal-window {
  width: 100%;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
  border-radius: 14px;
  overflow: hidden;
  border: 1px solid var(--webdb-term-border);
  background: var(--webdb-term-bg);
  box-shadow: var(--webdb-term-shadow);
  transition:
    background-color 0.2s ease,
    border-color 0.2s ease;
}

.terminal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.65rem 1rem;
  background: var(--webdb-term-header-bg);
  border-bottom: 1px solid var(--webdb-term-border);
  transition:
    background-color 0.2s ease,
    border-color 0.2s ease;
}

.terminal-dots {
  display: flex;
  gap: 6px;
}

.tdot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.tdot-red {
  background: #f87171;
}
.tdot-amber {
  background: #fbbf24;
}
.tdot-green {
  background: #34d399;
}

.terminal-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.ttab {
  padding: 0.38rem 0.8rem;
  border-radius: 6px;
  font-family: var(--vp-font-family-mono);
  font-size: 0.76rem;
  font-weight: 600;
  color: var(--webdb-term-tab-text);
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 0.15s ease;
}

.ttab:hover {
  color: var(--webdb-term-tab-hover);
}

.ttab.active {
  color: var(--webdb-term-tab-active-text);
  background: var(--webdb-term-tab-active-bg);
  border-color: var(--webdb-term-tab-active-border);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.05);
}

.terminal-copy {
  font-family: var(--vp-font-family-mono);
  font-size: 0.72rem;
  font-weight: 700;
  color: var(--webdb-term-copy-text);
  background: var(--webdb-term-copy-bg);
  border: 1px solid var(--webdb-term-copy-border);
  border-radius: 6px;
  padding: 0.3rem 0.7rem;
  cursor: pointer;
  transition: all 0.15s ease;
}

.terminal-copy:hover {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}

.terminal-body {
  padding: 1.25rem 1rem;
  overflow-x: auto;
  font-family: var(--vp-font-family-mono);
  font-size: 0.82rem;
  line-height: 1.68;
  color: var(--webdb-term-text);
}

.code-line {
  display: flex;
  white-space: pre;
}

.line-num {
  width: 2.2rem;
  flex-shrink: 0;
  color: var(--webdb-term-line-num);
  user-select: none;
  text-align: right;
  padding-right: 1rem;
}

/* Theme-adaptive syntax highlighting */
.line-content :deep(.hl-comment) {
  color: var(--webdb-hl-comment);
  font-style: italic;
}
.line-content :deep(.hl-str) {
  color: var(--webdb-hl-str);
}
.line-content :deep(.hl-kw) {
  color: var(--webdb-hl-kw);
  font-weight: 600;
}
.line-content :deep(.hl-type) {
  color: var(--webdb-hl-type);
  font-weight: 600;
}
.line-content :deep(.hl-num) {
  color: var(--webdb-hl-num);
}
.line-content :deep(.hl-fn) {
  color: var(--webdb-hl-fn);
}

/* ============================================================================
   3. REACTIVE LIVE QUERIES & FRAMEWORKS SHOWCASE
   ============================================================================ */
.live-showcase-stack {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  width: 100%;
  max-width: 100%;
}

.fw-selector-bar {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.85rem;
}

.fw-selector-card {
  text-align: left;
  padding: 1.05rem 1.15rem;
  border-radius: 14px;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  cursor: pointer;
  transition: all 0.18s ease;
  min-width: 0;
}

.fw-selector-card:hover {
  border-color: var(--vp-c-brand-1);
  transform: translateY(-2px);
}

.fw-selector-card.active {
  border-color: #10b981;
  background: rgba(16, 185, 129, 0.08);
  box-shadow: 0 4px 16px rgba(16, 185, 129, 0.12);
}

.fw-card-react.active {
  border-color: #0ea5e9;
  background: rgba(14, 165, 233, 0.08);
  box-shadow: 0 4px 16px rgba(14, 165, 233, 0.14);
}

.fw-card-vue.active {
  border-color: #10b981;
  background: rgba(16, 185, 129, 0.08);
  box-shadow: 0 4px 16px rgba(16, 185, 129, 0.14);
}

.fw-card-angular.active {
  border-color: #e11d48;
  background: rgba(225, 29, 72, 0.07);
  box-shadow: 0 4px 16px rgba(225, 29, 72, 0.13);
}

.fw-card-vanilla.active {
  border-color: #3178c6;
  background: rgba(49, 120, 198, 0.09);
  box-shadow: 0 4px 16px rgba(49, 120, 198, 0.14);
}

.fw-selector-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.65rem;
  margin-bottom: 0.6rem;
}

.fw-brand-group {
  display: inline-flex;
  align-items: center;
  gap: 0.75rem;
  min-width: 0;
}

.fw-logo-box {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  box-shadow: 0 2px 6px rgba(15, 23, 42, 0.08);
}

.fw-selector-name {
  font-size: 1.05rem;
  font-weight: 800;
  color: var(--vp-c-text-1);
}

.fw-selector-size {
  font-family: var(--vp-font-family-mono);
  font-size: 0.68rem;
  font-weight: 700;
  color: var(--webdb-badge-green-text);
  background: rgba(16, 185, 129, 0.12);
  padding: 0.12rem 0.45rem;
  border-radius: 999px;
}

.fw-selector-pkg {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fw-selector-pkg code {
  font-size: 0.72rem;
  color: var(--vp-c-text-2);
}

.fw-window-title {
  display: flex;
  align-items: center;
  gap: 0.55rem;
}

.fw-window-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.fw-file-name {
  font-family: var(--vp-font-family-mono);
  font-size: 0.78rem;
  font-weight: 700;
  color: var(--webdb-term-text);
}

.fw-badge-pill {
  font-family: var(--vp-font-family-mono);
  font-size: 0.66rem;
  font-weight: 700;
  color: var(--webdb-badge-green-text);
  background: rgba(16, 185, 129, 0.14);
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
}

.live-highlights-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1rem;
}

.live-highlight-card {
  padding: 1.25rem 1.35rem;
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
}

.lh-badge {
  display: inline-block;
  font-family: var(--vp-font-family-mono);
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--webdb-badge-green-text);
  background: rgba(16, 185, 129, 0.12);
  padding: 0.16rem 0.5rem;
  border-radius: 999px;
  margin-bottom: 0.6rem;
}

.lh-title {
  font-size: 1rem;
  font-weight: 800;
  color: var(--vp-c-text-1);
  margin: 0 0 0.4rem;
}

.lh-desc {
  font-size: 0.85rem;
  line-height: 1.55;
  color: var(--vp-c-text-2);
  margin: 0;
}

.fw-guide-row {
  display: flex;
  justify-content: center;
  align-items: center;
  flex-wrap: wrap;
  gap: 1rem;
  margin-top: 0.5rem;
}

/* ============================================================================
   4. BENTO GRID
   ============================================================================ */
.bento-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1.15rem;
}

.bento-card {
  min-width: 0;
  overflow-wrap: anywhere;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  padding: 1.65rem 1.5rem;
  display: flex;
  flex-direction: column;
  transition:
    border-color 0.2s ease,
    transform 0.2s ease;
}

.bento-card:hover {
  border-color: var(--vp-c-brand-1);
  transform: translateY(-2px);
}

.bento-wide {
  grid-column: span 2;
}

.bento-tag {
  display: inline-block;
  align-self: flex-start;
  font-family: var(--vp-font-family-mono);
  font-size: 0.66rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  padding: 0.2rem 0.55rem;
  border-radius: 999px;
  margin-bottom: 0.85rem;
}

.tag-cyan {
  color: #0ea5e9;
  background: rgba(14, 165, 233, 0.12);
}
.tag-emerald {
  color: #10b981;
  background: rgba(16, 185, 129, 0.12);
}
.tag-violet {
  color: #8b5cf6;
  background: rgba(139, 92, 246, 0.12);
}
.tag-amber {
  color: #f59e0b;
  background: rgba(245, 158, 11, 0.12);
}
.tag-rose {
  color: #f43f5e;
  background: rgba(244, 63, 94, 0.12);
}
.tag-indigo {
  color: #6366f1;
  background: rgba(99, 102, 241, 0.12);
}

.bento-title {
  font-size: 1.15rem;
  font-weight: 800;
  color: var(--vp-c-text-1);
  margin: 0 0 0.6rem;
}

.bento-desc {
  font-size: 0.88rem;
  line-height: 1.6;
  color: var(--vp-c-text-2);
  margin: 0;
  flex: 1;
}

.bento-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
  margin-top: 1.25rem;
}

.bento-chip {
  font-family: var(--vp-font-family-mono);
  font-size: 0.7rem;
  font-weight: 600;
  padding: 0.22rem 0.6rem;
  border-radius: 6px;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  color: var(--vp-c-text-2);
}

/* ============================================================================
   6. BENCHMARK SPOTLIGHT & COMPARISON TABLES
   ============================================================================ */
.bench-spotlight-wrap {
  max-width: 720px;
  margin: 0 auto 2rem;
}

.hero-bench-spotlight {
  background: linear-gradient(
    145deg,
    rgba(16, 185, 129, 0.07) 0%,
    var(--vp-c-bg-soft) 50%,
    rgba(99, 102, 241, 0.07) 100%
  );
  border: 1.5px solid rgba(16, 185, 129, 0.4);
  border-radius: 18px;
  padding: 1.5rem 1.75rem;
  text-align: left;
  box-shadow:
    0 14px 36px rgba(16, 185, 129, 0.08),
    0 4px 12px rgba(15, 23, 42, 0.04);
}

:global(.dark) .hero-bench-spotlight {
  background: linear-gradient(
    145deg,
    rgba(16, 185, 129, 0.11) 0%,
    rgba(20, 28, 43, 0.92) 55%,
    rgba(99, 102, 241, 0.11) 100%
  );
  border-color: rgba(16, 185, 129, 0.45);
  box-shadow: 0 18px 42px rgba(0, 0, 0, 0.35);
}

.hero-bench-top {
  text-align: center;
  margin-bottom: 1.35rem;
}

.hero-bench-headline {
  font-size: 1.5rem;
  font-weight: 900;
  letter-spacing: -0.5px;
  line-height: 1.2;
  color: var(--vp-c-text-1);
  margin: 0 0 0.35rem;
}

.hero-bench-subdesc {
  font-size: 0.82rem;
  color: var(--vp-c-text-2);
  margin: 0;
}

.hero-speed-highlight {
  display: inline-block;
  padding: 0.05rem 0.45rem;
  border-radius: 8px;
  background: linear-gradient(
    135deg,
    rgba(16, 185, 129, 0.2) 0%,
    rgba(6, 182, 212, 0.2) 100%
  );
  color: #059669;
  font-weight: 900;
}

:global(.dark) .hero-speed-highlight {
  color: #34d399;
  background: linear-gradient(
    135deg,
    rgba(16, 185, 129, 0.25) 0%,
    rgba(6, 182, 212, 0.25) 100%
  );
}

.hero-bench-bars {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}

.hero-hbar-row {
  display: grid;
  grid-template-columns: 145px 1fr 112px;
  align-items: center;
  gap: 0.85rem;
}

.hero-hbar-label {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  font-size: 0.88rem;
  color: var(--vp-c-text-1);
  white-space: nowrap;
}

.engine-main {
  font-weight: 800;
}

.hero-hbar-tag {
  font-family: var(--vp-font-family-mono);
  font-size: 0.62rem;
  font-weight: 800;
  padding: 0.12rem 0.42rem;
  border-radius: 5px;
}

.tag-wasm {
  color: #059669;
  background: rgba(16, 185, 129, 0.15);
}

:global(.dark) .tag-wasm {
  color: #34d399;
}

.tag-js {
  color: #7c3aed;
  background: rgba(139, 92, 246, 0.15);
}

:global(.dark) .tag-js {
  color: #c4b5fd;
}

.label-muted {
  color: var(--vp-c-text-2);
  font-weight: 600;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.dot-emerald-glow {
  background: #10b981;
  box-shadow: 0 0 10px #10b981;
}

.dot-violet {
  background: #8b5cf6;
}

.dot-amber {
  background: #f59e0b;
}

.hero-hbar-track {
  width: 100%;
  height: 20px;
  border-radius: 999px;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  overflow: hidden;
  position: relative;
}

.row-winner .hero-hbar-track {
  height: 24px;
  border-color: rgba(16, 185, 129, 0.45);
}

.hbar-fill {
  height: 100%;
  border-radius: 999px;
  width: 0%;
  transition: width 1.05s cubic-bezier(0.22, 1, 0.36, 1);
  position: relative;
  overflow: hidden;
}

.hero-fill-wasm {
  background: linear-gradient(90deg, #10b981 0%, #06b6d4 55%, #3b82f6 100%);
  box-shadow: 0 0 16px rgba(16, 185, 129, 0.45);
}

.hero-fill-js {
  background: linear-gradient(90deg, #8b5cf6 0%, #ec4899 100%);
}

.hero-fill-sqlite {
  background: linear-gradient(90deg, #f59e0b 0%, #ea580c 100%);
}

.hbar-shimmer {
  position: absolute;
  top: 0;
  left: -35%;
  width: 35%;
  height: 100%;
  background: linear-gradient(
    90deg,
    transparent,
    rgba(255, 255, 255, 0.55),
    transparent
  );
  animation: hbarShimmer 2.6s infinite linear;
}

@keyframes hbarShimmer {
  0% {
    left: -35%;
  }
  100% {
    left: 100%;
  }
}

.hero-hbar-val {
  font-family: var(--vp-font-family-mono);
  text-align: right;
  white-space: nowrap;
}

.val-winner {
  font-size: 0.96rem;
  font-weight: 900;
  color: #059669;
}

:global(.dark) .val-winner {
  color: #34d399;
}

.val-js {
  font-size: 0.85rem;
  font-weight: 800;
  color: #7c3aed;
}

:global(.dark) .val-js {
  color: #c4b5fd;
}

.val-muted {
  font-size: 0.82rem;
  font-weight: 700;
  color: #d97706;
}

:global(.dark) .val-muted {
  color: #fbbf24;
}

.hero-carousel-dots {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.45rem;
  margin-top: 1.25rem;
  padding-top: 0.9rem;
  border-top: 1px solid rgba(148, 163, 184, 0.2);
}

.carousel-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  border: none;
  padding: 0;
  background: rgba(148, 163, 184, 0.45);
  cursor: pointer;
  transition:
    width 0.25s ease,
    background-color 0.25s ease;
}

.carousel-dot:hover {
  background: rgba(16, 185, 129, 0.7);
}

.carousel-dot.active {
  width: 26px;
  background: linear-gradient(90deg, #10b981, #06b6d4);
}

.bench-table-wrap {
  margin-top: 0.25rem;
}

.bench-td-scenario {
  font-weight: 800;
  color: var(--vp-c-text-1);
}

.bench-td-sub {
  font-size: 0.75rem;
  font-weight: 400;
  color: var(--vp-c-text-3);
  margin-top: 0.15rem;
}

.bench-cell-ops {
  font-family: var(--vp-font-family-mono);
  font-size: 0.86rem;
  color: var(--vp-c-text-1);
}

.bench-cell-ms {
  font-family: var(--vp-font-family-mono);
  font-size: 0.72rem;
  color: var(--vp-c-text-3);
  margin-top: 0.18rem;
}

.td-speedup {
  white-space: nowrap;
}

.table-speedup-badge {
  display: inline-flex;
  align-items: center;
  font-family: var(--vp-font-family-mono);
  font-size: 0.75rem;
  font-weight: 800;
  padding: 0.25rem 0.65rem;
  border-radius: 999px;
  color: #059669;
  background: rgba(16, 185, 129, 0.14);
}

:global(.dark) .table-speedup-badge {
  color: #34d399;
}

.bench-table-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.75rem;
  padding: 0.85rem 1.25rem;
  background: var(--vp-c-bg-mute);
  font-size: 0.78rem;
  color: var(--vp-c-text-2);
}

.bench-run-link {
  font-family: var(--vp-font-family-mono);
  font-weight: 700;
  color: var(--vp-c-brand-1);
  text-decoration: none;
}

.bench-run-link:hover {
  text-decoration: underline;
}

.compare-table-wrap {
  overflow-x: auto;
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  background: var(--vp-c-bg-soft);
}

.compare-table {
  width: 100%;
  border-collapse: collapse;
  text-align: left;
  font-size: 0.88rem;
}

.compare-table th,
.compare-table td {
  padding: 1.05rem 1.25rem;
  border-bottom: 1px solid var(--vp-c-divider);
}

.compare-table thead th {
  font-size: 0.78rem;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--vp-c-text-2);
  background: var(--vp-c-bg-mute);
}

.col-webdb-head {
  background: var(--vp-c-brand-soft) !important;
  color: var(--vp-c-brand-1) !important;
}

.webdb-th-inner {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.webdb-th-badge {
  font-family: var(--vp-font-family-mono);
  font-size: 0.64rem;
  padding: 0.15rem 0.45rem;
  border-radius: 999px;
  background: var(--vp-c-brand-1);
  color: var(--webdb-btn-primary-text);
}

.td-feature {
  font-weight: 700;
  color: var(--vp-c-text-1);
}

.td-neutral {
  color: var(--vp-c-text-2);
}

.td-bad {
  color: #ef4444;
}

.td-warn {
  color: #f59e0b;
}

.td-good {
  color: var(--vp-c-text-1);
  background: rgba(16, 185, 129, 0.05);
}

/* ============================================================================
   7. LIVE DEMOS STRIP & TOOLS SHOWCASE
   ============================================================================ */
.demos-strip {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1.15rem;
  margin-bottom: 1.25rem;
}

.demo-preview-card {
  display: flex;
  flex-direction: column;
  padding: 1.5rem;
  border-radius: 14px;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  text-decoration: none;
  color: var(--vp-c-text-1);
  transition:
    border-color 0.2s ease,
    transform 0.2s ease;
}

.demo-preview-card:hover {
  border-color: var(--vp-c-brand-1);
  transform: translateY(-2px);
}

.demo-preview-tag {
  align-self: flex-start;
  font-family: var(--vp-font-family-mono);
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  padding: 0.2rem 0.55rem;
  border-radius: 999px;
  margin-bottom: 0.85rem;
}

.demo-preview-title {
  font-size: 1.12rem;
  font-weight: 800;
  color: var(--vp-c-text-1);
  margin: 0 0 0.5rem;
}

.demo-preview-desc {
  font-size: 0.86rem;
  line-height: 1.55;
  color: var(--vp-c-text-2);
  margin: 0 0 1.1rem;
  flex: 1;
}

.demo-preview-cta {
  font-family: var(--vp-font-family-mono);
  font-size: 0.78rem;
  font-weight: 700;
  color: var(--vp-c-brand-1);
}

.demos-all-row {
  text-align: center;
  margin-bottom: 2.25rem;
}

.demos-all-link {
  font-family: var(--vp-font-family-mono);
  font-size: 0.84rem;
  font-weight: 700;
  color: var(--vp-c-brand-1);
  text-decoration: none;
}

.demos-all-link:hover {
  text-decoration: underline;
}

.tools-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1.25rem;
}

.tool-card {
  border-radius: 14px;
  padding: 2rem;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  display: flex;
  flex-direction: column;
}

.tool-card-primary {
  border-color: rgba(37, 99, 235, 0.35);
  background: linear-gradient(
    145deg,
    var(--vp-c-bg-soft) 0%,
    var(--vp-c-brand-soft) 100%
  );
}

.tool-badge-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 1rem;
}

.tool-pill {
  font-family: var(--vp-font-family-mono);
  font-size: 0.68rem;
  font-weight: 700;
  padding: 0.22rem 0.6rem;
  border-radius: 999px;
}

.pill-brand {
  color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
}

.tool-sub {
  font-family: var(--vp-font-family-mono);
  font-size: 0.72rem;
  color: var(--vp-c-text-2);
}

.tool-title {
  font-size: 1.4rem;
  font-weight: 800;
  margin: 0 0 0.65rem;
  color: var(--vp-c-text-1);
}

.tool-desc {
  font-size: 0.92rem;
  line-height: 1.6;
  color: var(--vp-c-text-2);
  margin: 0 0 1.5rem;
  flex: 1;
}

.tool-actions {
  display: flex;
}

/* ============================================================================
   RESPONSIVE BREAKPOINTS
   ============================================================================ */
@media (max-width: 1100px) {
  .hero-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 960px) {
  .hero-title {
    font-size: 2.65rem;
  }
  .hero-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .hero-hbar-row {
    grid-template-columns: minmax(0, 1fr);
    gap: 0.25rem;
  }
  .hero-hbar-val {
    text-align: left;
  }
  .fw-selector-bar {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .live-highlights-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .bento-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .demos-strip {
    grid-template-columns: minmax(0, 1fr);
  }
  .tools-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 640px) {
  .webdb-landing {
    padding: 1.5rem 1rem 4rem;
  }
  .hero-title {
    font-size: 2.1rem;
    letter-spacing: -1px;
  }
  .hero-actions {
    flex-direction: column;
    width: 100%;
  }
  .hero-actions .btn {
    width: 100%;
    justify-content: center;
  }
  .fw-guide-row {
    flex-direction: column;
    width: 100%;
  }
  .fw-guide-row .btn {
    width: 100%;
    justify-content: center;
  }
  .hero-metrics {
    grid-template-columns: minmax(0, 1fr);
  }
  .bento-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .bento-wide {
    grid-column: span 1;
  }
  .fw-selector-bar {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
