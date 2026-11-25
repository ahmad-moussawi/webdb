<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { withBase } from "vitepress";
import { searchInMemory } from "@ahmadmoussawi/webdb/search";
import { SIZE_METRICS } from "../constants";

type CodeTab = "quickstart" | "dualcore" | "customstorage" | "transactions";
const activeTab = ref<CodeTab>("quickstart");

const codeSnippets: Record<CodeTab, string> = {
  quickstart: `import { WebDB, WasmEngine, IdbStorage } from "@ahmadmoussawi/webdb";

// 1. Open an async database (swap IdbStorage for OpfsStorage or MemoryStorage)
const db = await WebDB.open({
  engine: new WasmEngine(),
  storage: new IdbStorage("shop_app"),
});

// 2. Define typed relational tables
await db.createTable("orders", [
  { name: "id", type: "UUID", primaryKey: true },
  { name: "status", type: "TEXT", notNull: true },
  { name: "total", type: "FLOAT64", notNull: true },
]);

// 3. Query with fluent, type-safe filtering & sorting
const paidOrders = await db
  .from("orders")
  .where("status", "=", "paid")
  .orderBy("total", "desc")
  .limit(10)
  .toArray();`,

  dualcore: `import { WebDB } from "@ahmadmoussawi/webdb/slim";
import { WasmEngine } from "@ahmadmoussawi/webdb/core/wasm";
import { JsEngine } from "@ahmadmoussawi/webdb/core/js";
import { OpfsStorage } from "@ahmadmoussawi/webdb/storage/opfs";

// Option A: ~19 KB gzipped WebAssembly core for maximum speed
const fastDb = await WebDB.open({
  engine: new WasmEngine(),
  storage: new OpfsStorage("app_data"),
});

// Option B: 100% Pure JS core for strict CSP or restricted WebViews
const cspSafeDb = await WebDB.open({
  engine: new JsEngine(),
  storage: new OpfsStorage("app_data"),
});`,

  customstorage: `import { WebDB, WasmEngine, MemoryStorage } from "@ahmadmoussawi/webdb";

// Extend MemoryStorage (or implement IVfsAdapter) for any custom backend
class RemoteCatalogStorage extends MemoryStorage {
  override async readPages(ids: number[]): Promise<Array<Uint8Array | null>> {
    return Promise.all(
      ids.map(async (id) => {
        const start = (id - 1) * 4096;
        const res = await fetch("https://cdn.example.com/catalog.webdb", {
          headers: { Range: \`bytes=\${start}-\${start + 4095}\` },
        });
        return new Uint8Array(await res.arrayBuffer());
      }),
    );
  }
}

const db = await WebDB.open({
  engine: new WasmEngine(),
  storage: new RemoteCatalogStorage(),
});`,

  transactions: `// Crash-safe atomic transactions with nested savepoints
await db.transaction(async (tx) => {
  await tx.insert("orders", {
    id: crypto.randomUUID(),
    status: "paid",
    total: 249.0,
  });

  // Inner savepoint rolls back without aborting the outer transaction
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
    file: "OrderCounter.tsx",
  },
  vue: {
    label: "Vue 3",
    badge: "Composition API",
    pkg: "@ahmadmoussawi/webdb/vue",
    size: "0.93 KB gzip",
    file: "OrderCounter.vue",
  },
  angular: {
    label: "Angular",
    badge: "Signals + RxJS",
    pkg: "@ahmadmoussawi/webdb/angular",
    size: "0.96 KB gzip",
    file: "order-counter.component.ts",
  },
  vanilla: {
    label: "Plain JS / TS",
    badge: "Zero Dependencies",
    pkg: "@ahmadmoussawi/webdb",
    size: "",
    file: "live-count.ts",
  },
};

const frameworkSnippets: Record<FrameworkTab, string> = {
  react: `import { useLiveQuery } from "@ahmadmoussawi/webdb/react";

export function OrderCounter() {
  // Auto-updates when 'orders' changes (even in another tab)
  const { data } = useLiveQuery(() => db.from("orders").count("*", "total").first());

  return <span>{data?.total ?? 0} orders</span>;
}`,

  vue: `<script setup lang="ts">
import { useLiveQuery } from "@ahmadmoussawi/webdb/vue";

// Returns a reactive Ref & cleans up automatically on unmount
const { data } = useLiveQuery(() => db.from("orders").count("*", "total").first());
<\/script>

<template>
  <span>{{ data?.total ?? 0 }} orders</span>
<\/template>`,

  angular: `import { Component } from "@angular/core";
import { injectWebDB, liveQuerySignal } from "@ahmadmoussawi/webdb/angular";

@Component({
  selector: "app-order-counter",
  template: \`<span>{{ count.data()?.total ?? 0 }} orders</span>\`,
})
export class OrderCounterComponent {
  private db = injectWebDB();

  // Tracks WebDB tables & cleans up via DestroyRef
  count = liveQuerySignal(() => this.db.from("orders").count("*", "total").first());
}`,

  vanilla: `// Chain .live() onto any query — re-runs on every table write
const sub = db.from("orders").count("*", "total").live(([row]) => {
  badge.textContent = \`\${row.total} orders\`;
});

// Any insert into 'orders' triggers the callback automatically
await db.insert("orders", { id: 1043, status: "paid", total: 149 });`,
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
    /\b(UUID|ULID|TEXT|INT32|INT64|FLOAT64|BLOB|WebDB|WasmEngine|JsEngine|IdbStorage|OpfsStorage|MemoryStorage|NodeFsStorage|RemoteCatalogStorage|CustomAdapter|IVfsAdapter|RequestInit|Array|URL|DataType|Intl|Promise|Uint8Array|Error|string|number|boolean)\b/g,
    (m) => saveToken(`<span class="hl-type">${m}</span>`),
  );

  // 6. Function calls
  html = html.replace(
    /\b(createTable|createIndex|alterTable|addColumn|from|where|whereNotNull|orderBy|limit|toArray|first|transaction|insert|insertMany|update|open|useLiveQuery|useLiveQueryData|liveQuerySignal|liveQuery\$|liveQuery|live|join|select|sum|count|groupBy|having|ref|signal|injectWebDB|useWebDB|provideWebDB|randomUUID|catch|renderOrders|readPages|writePages|fetch|arrayBuffer|subarray|registerFunction|registerBatchedFunction|createSearchIndex|buildQuery|NumberFormat|onBeforeCommit|coalesced|exportBinary|defineMigration)\b(?=\()/g,
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

const searchSnippet = `import { createSearchIndex } from "@ahmadmoussawi/webdb/search";
import { useLiveQuery } from "@ahmadmoussawi/webdb/react"; // or vue, angular

// 1. Index your existing table directly (always in sync)
const articleSearch = createSearchIndex(db, {
  table: "articles",
  fields: [
    { name: "title", weight: 10, highlight: true },
    { name: "tags", weight: 5 },
    { name: "body", weight: 1, snippet: true },
  ],
});

// 2. Typo-tolerant live search that updates as data or input changes
const { data: results } = useLiveQuery(
  () =>
    articleSearch.buildQuery(searchQuery.value, {
      fuzzy: true,  // "reactve" -> "reactive"
      prefix: true, // "persist" -> "persistence"
      limit: 20,
    }),
  [searchQuery],
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

interface LandingSearchDoc {
  id: number;
  title: string;
  category: string;
  tags: string;
  body: string;
}

const landingSearchDocs: LandingSearchDoc[] = [
  {
    id: 1,
    title: "Reactive Live Queries for React, Vue & Angular",
    category: "Reactivity",
    tags: "reactive, live queries, react, vue, angular",
    body: "Queries automatically track every table and join they read, refreshing UI components whenever local data changes.",
  },
  {
    id: 2,
    title: "Persistent Storage with IndexedDB & OPFS",
    category: "Storage",
    tags: "persistence, indexeddb, opfs, offline",
    body: "Persist relational data across reloads and offline sessions in every modern browser without server configuration.",
  },
  {
    id: 3,
    title: "Café-Style Caching for Repeated Reads",
    category: "Performance",
    tags: "cache, accent-insensitive, fast, reads",
    body: "Keep frequently queried records warm in memory with accent-insensitive matching across Unicode text.",
  },
  {
    id: 4,
    title: "Dual Core: WebAssembly Speed or Pure JS",
    category: "Engines",
    tags: "wasm, javascript, csp, extensions",
    body: "Run with our 19 KB WebAssembly core by default, or switch to pure JS in strict CSP environments.",
  },
  {
    id: 5,
    title: "Cross-Tab Sync Without a Backend",
    category: "Multi-Tab",
    tags: "sync, tabs, broadcastchannel, web locks",
    body: "Coordinate writes with Web Locks and broadcast commits across open tabs instantly via BroadcastChannel.",
  },
  {
    id: 6,
    title: "Deploy on Any Static Host With Zero Headers",
    category: "Deployment",
    tags: "static, cdn, coop, coep, zero-config",
    body: "Ship on Vercel, Netlify, GitHub Pages, or S3 with zero COOP or COEP response header configuration.",
  },
];

const liveSearchQuery = ref("reactve");
const liveSearchFuzzy = ref(true);

const liveSearchPresets = [
  { query: "reactve", hint: "typo" },
  { query: "persist", hint: "prefix" },
  { query: "cafe", hint: "accent" },
  { query: "sync tabs", hint: "2 words" },
];

const liveSearchResult = computed(() =>
  searchInMemory(landingSearchDocs, liveSearchQuery.value, {
    fields: [
      { name: "title", weight: 10, highlight: true },
      { name: "tags", weight: 5 },
      { name: "body", weight: 1, snippet: { size: 105 } },
    ],
    fuzzy: liveSearchFuzzy.value,
    prefix: true,
    limit: 3,
  }),
);

const liveSearchStatus = ref(
  `${liveSearchResult.value.hits.length} matches found`,
);
let searchAnnounceTimer: ReturnType<typeof setTimeout> | null = null;

watch([liveSearchQuery, liveSearchFuzzy], () => {
  if (searchAnnounceTimer) clearTimeout(searchAnnounceTimer);
  searchAnnounceTimer = setTimeout(() => {
    const count = liveSearchResult.value.hits.length;
    liveSearchStatus.value =
      count === 1 ? "1 match found" : `${count} matches found`;
  }, 180);
});

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
  (argsBatch) =>
    argsBatch.map(([price, pct]) => Number(price) * (1 - Number(pct) / 100)),
  { returnType: DataType.FLOAT64, deterministic: true }
);

// 3. Call directly inside .select(), .where(), and .orderBy()
const deals = await db
  .from("products")
  .select(["id", "name", "format_money(calc_discount(price, 20)) as deal"])
  .where("calc_discount(price, 20) < 100")
  .toArray();`;

type UdfCurrency = "USD" | "EUR" | "JPY";
const udfCurrency = ref<UdfCurrency>("USD");
const udfDiscount = ref<10 | 20 | 35>(20);

const udfSampleProducts = [
  { name: "Mechanical Keyboard", price: 140 },
  { name: "USB-C Multiport Dock", price: 89 },
  { name: "Studio Desk Lamp", price: 54 },
];

const udfCurrencyRates: Record<UdfCurrency, { rate: number; locale: string }> = {
  USD: { rate: 1, locale: "en-US" },
  EUR: { rate: 0.92, locale: "de-DE" },
  JPY: { rate: 152, locale: "ja-JP" },
};

const formattedUdfRows = computed(() => {
  const { rate, locale } = udfCurrencyRates[udfCurrency.value];
  const fmt = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: udfCurrency.value,
    maximumFractionDigits: udfCurrency.value === "JPY" ? 0 : 2,
  });
  return udfSampleProducts.map((item) => {
    const base = item.price * rate;
    const discounted = base * (1 - udfDiscount.value / 100);
    return {
      name: item.name,
      original: fmt.format(base),
      deal: fmt.format(discounted),
    };
  });
});

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

const heroRef = ref<HTMLElement | null>(null);
let reducedMotionQuery: MediaQueryList | null = null;

const onHeroPointerMove = (e: PointerEvent) => {
  if (e.pointerType === "touch") return;
  if (reducedMotionQuery?.matches) return;
  const el = (e.currentTarget as HTMLElement | null) ?? heroRef.value;
  if (!el) return;

  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  el.style.setProperty("--hero-mouse-x", `${x.toFixed(1)}px`);
  el.style.setProperty("--hero-mouse-y", `${y.toFixed(1)}px`);
};

onMounted(() => {
  setTimeout(() => {
    benchAnimated.value = true;
  }, 120);
  startCarousel();

  reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
});

// ============================================================================
// 1. HERO INTERACTIVE BROWSER DB SHOWCASE
// ============================================================================
type HeroFilter = "all" | "paid" | "pending";
type HeroStatus = "paid" | "pending";

interface HeroOrderRow {
  id: number;
  customer: string;
  total: number;
  status: HeroStatus;
}

const heroFilter = ref<HeroFilter>("all");
const heroRuntime = ref<"wasm-idb" | "js-opfs">("wasm-idb");
const heroOrders = ref<HeroOrderRow[]>([
  { id: 1042, customer: "Maya Lin", total: 420, status: "paid" },
  { id: 1041, customer: "David Chen", total: 285, status: "paid" },
  { id: 1040, customer: "Sara Patel", total: 190, status: "pending" },
  { id: 1039, customer: "Alex Rivera", total: 540, status: "paid" },
]);
const heroNextId = ref(1043);
const heroFlashId = ref<number | null>(null);
const heroSyncPulse = ref(false);
let heroFlashTimer: ReturnType<typeof setTimeout> | null = null;

const heroSampleQueue = [
  { customer: "Elena Rostova", total: 310 },
  { customer: "Liam O'Connor", total: 640 },
  { customer: "Noor Al-Mansoor", total: 275 },
  { customer: "Kenji Sato", total: 490 },
];
let heroQueueIdx = 0;

const triggerHeroSync = (flashId: number) => {
  heroFlashId.value = flashId;
  heroSyncPulse.value = true;
  if (heroFlashTimer) clearTimeout(heroFlashTimer);
  heroFlashTimer = setTimeout(() => {
    heroFlashId.value = null;
    heroSyncPulse.value = false;
  }, 900);
};

const insertHeroOrder = () => {
  const sample = heroSampleQueue[heroQueueIdx % heroSampleQueue.length];
  heroQueueIdx++;
  const status: HeroStatus =
    heroFilter.value === "pending"
      ? "pending"
      : heroFilter.value === "paid"
        ? "paid"
        : heroQueueIdx % 2 === 0
          ? "pending"
          : "paid";
  const newOrder: HeroOrderRow = {
    id: heroNextId.value++,
    customer: sample.customer,
    total: sample.total,
    status,
  };
  heroOrders.value = [newOrder, ...heroOrders.value].slice(0, 8);
  triggerHeroSync(newOrder.id);
};

const toggleHeroOrderStatus = (id: number) => {
  heroOrders.value = heroOrders.value.map((row) =>
    row.id === id
      ? { ...row, status: row.status === "paid" ? "pending" : "paid" }
      : row,
  );
  triggerHeroSync(id);
};

const filteredHeroOrders = computed(() =>
  (heroFilter.value === "all"
    ? heroOrders.value
    : heroOrders.value.filter((o) => o.status === heroFilter.value)
  ).slice(0, 4),
);

const heroPaidCount = computed(
  () => heroOrders.value.filter((o) => o.status === "paid").length,
);

const heroPaidTotal = computed(() => {
  const sum = heroOrders.value
    .filter((o) => o.status === "paid")
    .reduce((acc, o) => acc + o.total, 0);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(sum);
});

const heroQueryHtml = computed(() => {
  const code =
    heroFilter.value === "all"
      ? `db.from("orders").orderBy("id", "desc").live(render)`
      : `db.from("orders").where("status", "=", "${heroFilter.value}").live(render)`;
  return highlightCode(code);
});

onBeforeUnmount(() => {
  stopCarousel();
  if (searchAnnounceTimer) clearTimeout(searchAnnounceTimer);
  if (heroFlashTimer) clearTimeout(heroFlashTimer);
});

// ============================================================================
// 4. INTERACTIVE FEATURE EXPLORER ("BUILT WITH THE BROWSER")
// ============================================================================
type FeatureId =
  | "storage"
  | "dualcore"
  | "bundle"
  | "offline"
  | "snapshots"
  | "schema";

type FeatureAccent =
  | "cyan"
  | "emerald"
  | "violet"
  | "amber"
  | "rose"
  | "indigo";

interface FeatureItem {
  id: FeatureId;
  eyebrow: string;
  title: string;
  shortTitle: string;
  teaser: string;
  accent: FeatureAccent;
}

const featureItems: FeatureItem[] = [
  {
    id: "storage",
    eyebrow: "PLUGGABLE ASYNC STORAGE",
    title: "IndexedDB, OPFS, or Custom Storage",
    shortTitle: "Storage",
    teaser: "Zero COOP/COEP headers across every runtime",
    accent: "cyan",
  },
  {
    id: "dualcore",
    eyebrow: "NATIVE WEB APIS & DUAL CORE",
    title: "WASM Speed + 100% Pure JS Mode",
    shortTitle: "WASM + JS",
    teaser: "Lean on browser APIs, swap engines in one line",
    accent: "emerald",
  },
  {
    id: "bundle",
    eyebrow: "SMALL BUNDLE SIZE",
    title: "Tiny & Tree-Shakeable Subpaths",
    shortTitle: "Bundle Size",
    teaser: "Ship only the engine and adapters you import",
    accent: "violet",
  },
  {
    id: "offline",
    eyebrow: "RELIABLE OFFLINE",
    title: "Crash-Safe Transactions & Sync",
    shortTitle: "Offline & Sync",
    teaser: "Nested savepoints and coalesced sync changesets",
    accent: "amber",
  },
  {
    id: "snapshots",
    eyebrow: "INSTANT HYDRATION & CLI",
    title: "Compressed Snapshots & Terminal CLI",
    shortTitle: "Snapshots & CLI",
    teaser: "Hydrate .webdb.gz images and inspect via npx webdb",
    accent: "rose",
  },
  {
    id: "schema",
    eyebrow: "SCHEMA & MIGRATIONS",
    title: "Typed Schemas, Indexes & Versions",
    shortTitle: "Schemas",
    teaser: "Composite indexes, ALTER TABLE, and clean upgrades",
    accent: "indigo",
  },
];

const activeFeature = ref<FeatureId>("storage");
const featureTabRefs = ref<Record<string, HTMLButtonElement | null>>({});

const selectFeature = (id: FeatureId, focusTab = false) => {
  activeFeature.value = id;
  const el = featureTabRefs.value[id];
  if (el) {
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (focusTab) el.focus();
  }
};

const onFeatureTabKeydown = (event: KeyboardEvent, idx: number) => {
  const len = featureItems.length;
  let nextIdx: number | null = null;
  if (event.key === "ArrowDown" || event.key === "ArrowRight") {
    nextIdx = (idx + 1) % len;
  } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
    nextIdx = (idx - 1 + len) % len;
  } else if (event.key === "Home") {
    nextIdx = 0;
  } else if (event.key === "End") {
    nextIdx = len - 1;
  }
  if (nextIdx !== null) {
    event.preventDefault();
    selectFeature(featureItems[nextIdx].id, true);
  }
};

const hiddenUntilFound = (isActive: boolean) =>
  isActive ? undefined : ("until-found" as unknown as boolean);

// Panel 1: Storage Picker
type StorageChoice = "idb" | "opfs" | "memory" | "custom";
const selectedStorage = ref<StorageChoice>("idb");

const storageOptions: Record<
  StorageChoice,
  {
    label: string;
    headers: string;
    runtime: string;
    bestFor: string;
    code: string;
  }
> = {
  idb: {
    label: "IndexedDB",
    headers: "None required",
    runtime: "Main thread & Workers",
    bestFor: "All browsers, Safari & mobile WebViews",
    code: `import { WebDB, WasmEngine, IdbStorage } from "@ahmadmoussawi/webdb";

const db = await WebDB.open({
  engine: new WasmEngine(),
  storage: new IdbStorage("app_production"),
});`,
  },
  opfs: {
    label: "OPFS",
    headers: "None required",
    runtime: "Dedicated Workers & modern browsers",
    bestFor: "Heavy local writes & large datasets",
    code: `import { WebDB, WasmEngine, OpfsStorage } from "@ahmadmoussawi/webdb";

const db = await WebDB.open({
  engine: new WasmEngine(),
  storage: new OpfsStorage("analytics_local"),
});`,
  },
  memory: {
    label: "In-Memory",
    headers: "None required",
    runtime: "Browsers, Node 20+, Vitest & Edge",
    bestFor: "Unit tests, SSR & ephemeral sessions",
    code: `import { WebDB, WasmEngine, MemoryStorage } from "@ahmadmoussawi/webdb";

const db = await WebDB.open({
  engine: new WasmEngine(),
  storage: new MemoryStorage(),
});`,
  },
  custom: {
    label: "Custom Adapter",
    headers: "None required",
    runtime: "S3 Range, Electron, React Native, KV",
    bestFor: "Remote streaming or custom persistence",
    code: `import { WebDB, WasmEngine, MemoryStorage } from "@ahmadmoussawi/webdb";

class CustomAdapter extends MemoryStorage {
  override async readPages(ids: number[]) { /* fetch from S3 / KV */ return super.readPages(ids); }
}

const db = await WebDB.open({ engine: new WasmEngine(), storage: new CustomAdapter() });`,
  },
};

const renderedStorageCode = computed(() =>
  highlightCode(storageOptions[selectedStorage.value].code).split("\n"),
);

// Panel 2: Dual Core Engine Toggle
const selectedEngine = ref<"wasm" | "js">("wasm");

const dualCoreMeta = computed(() =>
  selectedEngine.value === "wasm"
    ? {
        name: "WasmEngine",
        csp: "Standard WebAssembly",
        format: "100% Identical",
        footprint: `${SIZE_METRICS.wasmGzip} gzip`,
        code: `import { WebDB, WasmEngine, IdbStorage } from "@ahmadmoussawi/webdb";

const db = await WebDB.open({
  engine: new WasmEngine(), // Default ultra-fast ~19 KB WASM core
  storage: new IdbStorage("app_data"),
});`,
      }
    : {
        name: "JsEngine",
        csp: "Strict CSP / No-WASM safe",
        format: "100% Identical",
        footprint: "Zero WASM bytes",
        code: `import { WebDB } from "@ahmadmoussawi/webdb/slim";
import { JsEngine } from "@ahmadmoussawi/webdb/core/js";
import { IdbStorage } from "@ahmadmoussawi/webdb/storage/idb";

const db = await WebDB.open({
  engine: new JsEngine(), // Pure JS fallback for strict CSP & extensions
  storage: new IdbStorage("app_data"),
});`,
      },
);

const renderedDualCoreCode = computed(() =>
  highlightCode(dualCoreMeta.value.code).split("\n"),
);

// Panel 3: Bundle Composer
const bundleEngine = ref<"wasm" | "js">("wasm");
const bundleReact = ref(true);
const bundleSearch = ref(false);

const bundleCode = computed(() => {
  const lines = [
    `import { WebDB } from "@ahmadmoussawi/webdb/slim";`,
    bundleEngine.value === "wasm"
      ? `import { WasmEngine } from "@ahmadmoussawi/webdb/core/wasm";`
      : `import { JsEngine } from "@ahmadmoussawi/webdb/core/js";`,
    `import { IdbStorage } from "@ahmadmoussawi/webdb/storage/idb";`,
  ];
  if (bundleReact.value) {
    lines.push(`import { useLiveQuery } from "@ahmadmoussawi/webdb/react";`);
  }
  if (bundleSearch.value) {
    lines.push(
      `import { createSearchIndex } from "@ahmadmoussawi/webdb/search";`,
    );
  }
  return highlightCode(lines.join("\n")).split("\n");
});

const bundleSummary = computed(() => {
  const parts = ["Slim Core", bundleEngine.value === "wasm" ? "WASM (~19 KB)" : "Pure JS", "IDB"];
  if (bundleReact.value) parts.push("React (<1 KB)");
  if (bundleSearch.value) parts.push("Search");
  const pct =
    (bundleEngine.value === "wasm" ? 12 : 10) +
    (bundleReact.value ? 2 : 0) +
    (bundleSearch.value ? 3 : 0);
  return { parts, pct };
});

// Panel 4: Offline & Transactions Toggle
const selectedOfflineMode = ref<"savepoints" | "sync">("savepoints");

const offlineCode = computed(() =>
  highlightCode(
    selectedOfflineMode.value === "savepoints"
      ? `await db.transaction(async (tx) => {
  await tx.insert("invoices", { id, status: "sent", total: 120 });

  // Inner savepoint rolls back cleanly without aborting the outer write
  await tx.transaction(async (inner) => {
    await inner.update("invoices", { total: -1 });
    throw new Error("Undo inner edit only");
  }).catch(() => {});
});`
      : `// Capture minimal net changes per row before committing offline edits
db.onBeforeCommit((changeset) => {
  const netMutations = changeset.coalesced();
  syncQueue.enqueue(netMutations);
});`,
  ).split("\n"),
);

// Panel 5: Snapshots & CLI Toggle
const selectedSnapshotMode = ref<"snapshot" | "cli">("snapshot");

const snapshotCode = computed(() =>
  highlightCode(
    selectedSnapshotMode.value === "snapshot"
      ? `// Build time or server: export full indexed database snapshot
const bytes = await db.exportBinary();

// Client cold start: hydrate instantly from Uint8Array or .webdb.gz
const clientDb = await WebDB.open({
  engine: new WasmEngine(),
  storage: new IdbStorage("catalog"),
  initialData: bytes,
});`
      : `// Inspect, query & verify .db files right from your terminal
// $ npx webdb info app.db
// $ npx webdb tables app.db --exact-count
// $ npx webdb query app.db orders -w "status = 'paid'" -l 10
// $ npx webdb verify app.db`,
  ).split("\n"),
);

// Panel 6: Schema & Migrations Stepper
const selectedMigrationStep = ref<0 | 1 | 2>(0);

const migrationSteps = [
  {
    label: "1. Typed Schema",
    code: `await db.createTable("tasks", [
  { name: "id", type: "UUID", primaryKey: true },
  { name: "title", type: "TEXT", notNull: true },
  { name: "priority", type: "INT32" },
  { name: "score", type: "FLOAT64" },
]);`,
  },
  {
    label: "2. Composite Index",
    code: `// Speed up filtered & sorted queries across multiple columns
await db.createIndex("tasks", ["priority", "score"]);

const topTasks = await db
  .from("tasks")
  .where("priority", ">=", 2)
  .orderBy("score", "desc")
  .toArray();`,
  },
  {
    label: "3. Safe Migrations",
    code: `// Evolve tables safely across app versions
await db.alterTable("tasks", (table) => {
  table.addColumn({ name: "due_date", type: "TEXT" });
});`,
  },
];

const renderedMigrationCode = computed(() =>
  highlightCode(migrationSteps[selectedMigrationStep.value].code).split("\n"),
);
</script>

<template>
  <div class="webdb-landing">
    <!-- ======================================================================
         1. SPLIT VISUAL HERO SECTION
         ====================================================================== -->
    <header
      ref="heroRef"
      class="hero-section"
      @pointermove="onHeroPointerMove"
    >
      <div class="hero-grid-bg" aria-hidden="true"></div>
      <div class="hero-glow" aria-hidden="true"></div>
      <div class="hero-torch-grid" aria-hidden="true"></div>
      <div class="hero-torch-beam" aria-hidden="true"></div>

      <div class="hero-inner">
        <div class="hero-split">
        <!-- LEFT COLUMN: VALUE PROPOSITION & PRIMARY CTAS -->
        <div class="hero-copy">
          <div class="hero-eyebrow">
            <span class="status-dot" aria-hidden="true"></span>
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
            and typo-tolerant search over IndexedDB &amp; OPFS. Tiny bundle,
            dual WASM/JS core, and zero <code>COOP/COEP</code> server headers.
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
                aria-hidden="true"
              >
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              <span>Try Live Demos</span>
            </a>
          </div>

          <!-- ONE-CLICK INSTALL COMMAND PILL -->
          <div class="hero-install-wrap">
            <button
              type="button"
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
        </div>

        <!-- RIGHT COLUMN: INTERACTIVE BROWSER DB SHOWCASE -->
        <div class="hero-visual-stage">
          <div class="hero-stage-aura" aria-hidden="true"></div>

          <div class="hero-window-shell">
            <!-- WINDOW CHROME -->
            <div class="hw-chrome">
              <div class="hw-chrome-left">
                <div class="terminal-dots" aria-hidden="true">
                  <span class="tdot tdot-red"></span>
                  <span class="tdot tdot-amber"></span>
                  <span class="tdot tdot-green"></span>
                </div>
                <span class="hw-brand-chip">
                  <svg
                    viewBox="0 0 100 100"
                    width="14"
                    height="14"
                    fill="none"
                    aria-hidden="true"
                  >
                    <rect width="100" height="100" rx="22" fill="#3B82F6" />
                    <path
                      d="M25 36L50 22L75 36L50 50L25 36Z"
                      fill="#ffffff"
                      fill-opacity="0.92"
                    />
                    <path
                      d="M25 52L50 66L75 52"
                      stroke="#ffffff"
                      stroke-width="7"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                    <path
                      d="M25 67L50 81L75 67"
                      stroke="#ffffff"
                      stroke-width="7"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                  <span>webdb://shop_app</span>
                </span>
              </div>

              <button
                type="button"
                class="hw-runtime-toggle"
                :aria-pressed="heroRuntime === 'js-opfs'"
                title="Switch WebDB engine & storage mode"
                @click="
                  heroRuntime =
                    heroRuntime === 'wasm-idb' ? 'js-opfs' : 'wasm-idb'
                "
              >
                <span class="hw-runtime-dot" aria-hidden="true"></span>
                <span>{{
                  heroRuntime === "wasm-idb"
                    ? "WASM • IndexedDB"
                    : "Pure JS • OPFS"
                }}</span>
              </button>
            </div>

            <!-- LIVE QUERY BAR + CONTROLS -->
            <div class="hw-toolbar">
              <div class="hw-query-line" aria-label="Active live query">
                <span class="hw-query-prompt" aria-hidden="true">›</span>
                <code v-html="heroQueryHtml"></code>
              </div>

              <div class="hw-controls">
                <div class="hw-filter-group" role="group" aria-label="Filter orders">
                  <button
                    v-for="f in (['all', 'paid', 'pending'] as const)"
                    :key="f"
                    type="button"
                    :aria-pressed="heroFilter === f"
                    :class="['hw-filter-btn', { active: heroFilter === f }]"
                    @click="heroFilter = f"
                  >
                    {{ f === "all" ? "All" : f === "paid" ? "Paid" : "Pending" }}
                  </button>
                </div>

                <button
                  type="button"
                  class="hw-insert-btn"
                  @click="insertHeroOrder"
                >
                  <span>+ Insert Order</span>
                </button>
              </div>
            </div>

            <!-- LIVE ORDERS TABLE -->
            <div class="hw-table">
              <div class="hw-table-head" aria-hidden="true">
                <span class="hw-col-id">ID</span>
                <span>Customer</span>
                <span>Total</span>
                <span>Status (click to toggle)</span>
              </div>

              <div
                v-for="row in filteredHeroOrders"
                :key="row.id"
                :class="[
                  'hw-table-row',
                  { 'row-flash': heroFlashId === row.id },
                ]"
              >
                <span class="hw-col-id hw-cell-id">#{{ row.id }}</span>
                <span class="hw-cell-name">{{ row.customer }}</span>
                <span class="hw-cell-total">${{ row.total }}</span>
                <button
                  type="button"
                  :class="[
                    'hw-status-pill',
                    row.status === 'paid' ? 'status-paid' : 'status-pending',
                  ]"
                  :aria-label="`Toggle order ${row.id} status, currently ${row.status}`"
                  @click="toggleHeroOrderStatus(row.id)"
                >
                  <span aria-hidden="true">{{
                    row.status === "paid" ? "✓" : "◔"
                  }}</span>
                  <span>{{ row.status === "paid" ? "Paid" : "Pending" }}</span>
                </button>
              </div>

              <div v-if="filteredHeroOrders.length === 0" class="hw-table-empty">
                No {{ heroFilter }} orders — click <strong>+ Insert Order</strong>
                or switch to <strong>All</strong>.
              </div>
            </div>
          </div>

          <!-- DOCKED TAB 2 LIVE SYNC CARD -->
          <div :class="['hero-sync-card', { 'sync-pulse': heroSyncPulse }]">
            <div class="sync-card-head">
              <span class="status-dot" aria-hidden="true"></span>
              <span>Tab 2 · Live Sync</span>
            </div>
            <div class="sync-card-body">
              <div class="sync-metric-val">{{ heroPaidTotal }}</div>
              <div class="sync-metric-meta">
                {{ heroPaidCount }} paid • {{ heroOrders.length }} orders
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 4-CARD VALUE STRIP -->
      <div class="hero-metrics">
        <div class="metric-card metric-emerald">
          <div class="metric-head-row">
            <span class="metric-pill pill-emerald">SMALL BUNDLE</span>
            <span class="metric-icon-box icon-emerald" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
              </svg>
            </span>
          </div>
          <div class="metric-val">{{ SIZE_METRICS.wasmGzip }}</div>
          <div class="metric-label">Gzipped WASM Core</div>
          <div class="metric-desc">
            ~95% smaller than desktop SQLite &amp; PGlite ports, with
            tree-shakeable subpath imports.
          </div>
        </div>

        <div class="metric-card metric-cyan">
          <div class="metric-head-row">
            <span class="metric-pill pill-cyan">ZERO SERVER CONFIG</span>
            <span class="metric-icon-box icon-cyan" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <ellipse cx="12" cy="5" rx="9" ry="3" />
                <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
              </svg>
            </span>
          </div>
          <div class="metric-val">IDB + OPFS</div>
          <div class="metric-label">Async Storage Anywhere</div>
          <div class="metric-desc">
            Deploy to Vercel, Netlify, GitHub Pages, or S3 with zero
            <code>COOP/COEP</code> headers.
          </div>
        </div>

        <div class="metric-card metric-violet">
          <div class="metric-head-row">
            <span class="metric-pill pill-violet">DUAL CORE</span>
            <span class="metric-icon-box icon-violet" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="4" y="4" width="16" height="16" rx="2" />
                <rect x="9" y="9" width="6" height="6" />
              </svg>
            </span>
          </div>
          <div class="metric-val">WASM + JS</div>
          <div class="metric-label">Works in Restricted CSP</div>
          <div class="metric-desc">
            Full speed in WebAssembly, or swap to the Pure JS engine in one line
            when WASM is blocked.
          </div>
        </div>

        <div class="metric-card metric-rose">
          <div class="metric-head-row">
            <span class="metric-pill pill-rose">REACTIVE UI</span>
            <span class="metric-icon-box icon-rose" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
              </svg>
            </span>
          </div>
          <div class="metric-val">Live Queries</div>
          <div class="metric-label">Auto-Updating Components</div>
          <div class="metric-desc">
            <code>&lt; 1 KB</code> adapters for React, Vue 3, Angular &amp; JS
            that stay in sync across browser tabs.
          </div>
        </div>
      </div>
      </div>
    </header>

    <div class="landing-content">
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

      <div class="terminal-window term-brand">
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
         4. BUILT WITH THE BROWSER — INTERACTIVE FEATURE EXPLORER
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

      <div class="feature-explorer">
        <!-- LEFT RAIL (DESKTOP) / SINGLE-ROW SCROLLER (MOBILE): TABLIST -->
        <div
          class="feature-tablist"
          role="tablist"
          aria-label="Core browser-native capabilities"
        >
          <button
            v-for="(item, idx) in featureItems"
            :key="item.id"
            :id="`feature-tab-${item.id}`"
            :ref="
              (el) => {
                featureTabRefs[item.id] = el as HTMLButtonElement | null;
              }
            "
            type="button"
            role="tab"
            :aria-selected="activeFeature === item.id"
            :tabindex="activeFeature === item.id ? 0 : -1"
            :class="['feature-tab', `accent-${item.accent}`]"
            @click="selectFeature(item.id)"
            @keydown="onFeatureTabKeydown($event, idx)"
          >
            <span class="feature-tab-icon" aria-hidden="true">
              <svg
                v-if="item.id === 'storage'"
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <ellipse cx="12" cy="5" rx="9" ry="3" />
                <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
                <path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3" />
              </svg>
              <svg
                v-else-if="item.id === 'dualcore'"
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <rect x="4" y="4" width="16" height="16" rx="2" />
                <rect x="9" y="9" width="6" height="6" />
                <path d="M15 2v2M9 2v2M15 20v2M9 20v2M2 9h2M2 15h2M20 9h2M20 15h2" />
              </svg>
              <svg
                v-else-if="item.id === 'bundle'"
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                <line x1="12" y1="22.08" x2="12" y2="12" />
              </svg>
              <svg
                v-else-if="item.id === 'offline'"
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                <path d="m9 12 2 2 4-4" />
              </svg>
              <svg
                v-else-if="item.id === 'snapshots'"
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
              <svg
                v-else
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M3 9h18M9 21V9" />
              </svg>
            </span>

            <span class="feature-tab-copy">
              <span class="feature-tab-title feature-tab-title-full">{{ item.title }}</span>
              <span class="feature-tab-title feature-tab-title-short">{{ item.shortTitle }}</span>
              <span class="feature-tab-teaser">{{ item.teaser }}</span>
            </span>
          </button>
        </div>

        <!-- RIGHT STAGE: ALL 6 PANELS IN ONE GRID CELL -->
        <div class="feature-stage">
          <!-- PANEL 1: PLUGGABLE ASYNC STORAGE -->
          <div
            role="tabpanel"
            aria-labelledby="feature-tab-storage"
            :tabindex="activeFeature === 'storage' ? 0 : undefined"
            :hidden="hiddenUntilFound(activeFeature === 'storage')"
            class="feature-panel-slot"
            @beforematch="selectFeature('storage')"
          >
            <article class="feature-stage-card stage-accent-cyan">
              <header class="stage-header">
                <span class="stage-tag tag-cyan">PLUGGABLE ASYNC STORAGE</span>
                <h3 class="stage-title">IndexedDB, OPFS, or Custom Storage</h3>
                <p class="stage-desc">
                  Runs natively on the main thread or in Web Workers with zero
                  <code>COOP/COEP</code> server headers. Swap built-in storage
                  adapters in one line—or extend <code>MemoryStorage</code> for
                  S3 HTTP Range streaming, Electron, React Native, or KV stores.
                </p>
              </header>

              <div class="stage-widget">
                <div
                  class="mini-switcher"
                  role="group"
                  aria-label="Choose a storage backend"
                >
                  <button
                    v-for="(opt, key) in storageOptions"
                    :key="key"
                    type="button"
                    :aria-pressed="selectedStorage === key"
                    :class="[
                      'mini-pill-btn',
                      { active: selectedStorage === key },
                    ]"
                    @click="selectedStorage = key as StorageChoice"
                  >
                    {{ opt.label }}
                  </button>
                </div>

                <div class="mini-code-box">
                  <div
                    v-for="(line, i) in renderedStorageCode"
                    :key="i"
                    class="code-line"
                  >
                    <span class="line-num">{{ i + 1 }}</span>
                    <span class="line-content" v-html="line || '&nbsp;'"></span>
                  </div>
                </div>

                <div class="mini-facts-grid">
                  <div class="mini-fact">
                    <span class="mini-fact-label">Server Headers</span>
                    <span class="mini-fact-value">{{
                      storageOptions[selectedStorage].headers
                    }}</span>
                  </div>
                  <div class="mini-fact">
                    <span class="mini-fact-label">Runs In</span>
                    <span class="mini-fact-value">{{
                      storageOptions[selectedStorage].runtime
                    }}</span>
                  </div>
                  <div class="mini-fact">
                    <span class="mini-fact-label">Best For</span>
                    <span class="mini-fact-value">{{
                      storageOptions[selectedStorage].bestFor
                    }}</span>
                  </div>
                </div>
              </div>

              <footer class="stage-footer">
                <a
                  :href="withBase('/guides/storage-and-configuration')"
                  class="stage-footer-link"
                >
                  <span>Read Storage &amp; Custom Adapters Guide</span>
                  <span class="btn-arrow">→</span>
                </a>
              </footer>
            </article>
          </div>

          <!-- PANEL 2: NATIVE WEB APIS & DUAL CORE -->
          <div
            role="tabpanel"
            aria-labelledby="feature-tab-dualcore"
            :tabindex="activeFeature === 'dualcore' ? 0 : undefined"
            :hidden="hiddenUntilFound(activeFeature === 'dualcore')"
            class="feature-panel-slot"
            @beforematch="selectFeature('dualcore')"
          >
            <article class="feature-stage-card stage-accent-emerald">
              <header class="stage-header">
                <span class="stage-tag tag-emerald">
                  NATIVE WEB APIS &amp; DUAL CORE
                </span>
                <h3 class="stage-title">
                  WASM Speed + 100% Pure JS Fallback
                </h3>
                <p class="stage-desc">
                  Instead of shipping megabytes of duplicate C libraries, WebDB
                  leans on native browser APIs. Running inside a strict-CSP
                  enterprise app or browser extension where WebAssembly is
                  disallowed? Switch to <code>JsEngine</code> in one line.
                </p>
              </header>

              <div class="stage-widget">
                <div
                  class="mini-switcher"
                  role="group"
                  aria-label="Choose an execution engine"
                >
                  <button
                    type="button"
                    :aria-pressed="selectedEngine === 'wasm'"
                    :class="[
                      'mini-pill-btn',
                      { active: selectedEngine === 'wasm' },
                    ]"
                    @click="selectedEngine = 'wasm'"
                  >
                    WasmEngine (Default)
                  </button>
                  <button
                    type="button"
                    :aria-pressed="selectedEngine === 'js'"
                    :class="[
                      'mini-pill-btn',
                      { active: selectedEngine === 'js' },
                    ]"
                    @click="selectedEngine = 'js'"
                  >
                    JsEngine (Pure JS / Strict CSP)
                  </button>
                </div>

                <div class="mini-code-box">
                  <div
                    v-for="(line, i) in renderedDualCoreCode"
                    :key="i"
                    class="code-line"
                  >
                    <span class="line-num">{{ i + 1 }}</span>
                    <span class="line-content" v-html="line || '&nbsp;'"></span>
                  </div>
                </div>

                <div class="mini-facts-grid">
                  <div class="mini-fact">
                    <span class="mini-fact-label">CSP Support</span>
                    <span class="mini-fact-value">{{ dualCoreMeta.csp }}</span>
                  </div>
                  <div class="mini-fact">
                    <span class="mini-fact-label">Storage Format</span>
                    <span class="mini-fact-value">{{
                      dualCoreMeta.format
                    }}</span>
                  </div>
                  <div class="mini-fact">
                    <span class="mini-fact-label">Engine Size</span>
                    <span class="mini-fact-value">{{
                      dualCoreMeta.footprint
                    }}</span>
                  </div>
                </div>

                <div class="mini-api-row">
                  <span class="mini-api-label">Built on Web APIs:</span>
                  <div class="mini-api-pills">
                    <span class="mini-api-chip">Web Locks</span>
                    <span class="mini-api-chip">BroadcastChannel</span>
                    <span class="mini-api-chip">Intl</span>
                    <span class="mini-api-chip">RegExp</span>
                    <span class="mini-api-chip">crypto</span>
                  </div>
                </div>
              </div>

              <footer class="stage-footer">
                <a
                  :href="withBase('/guides/storage-and-configuration')"
                  class="stage-footer-link"
                >
                  <span>Compare WASM &amp; Pure JS Engines</span>
                  <span class="btn-arrow">→</span>
                </a>
              </footer>
            </article>
          </div>

          <!-- PANEL 3: TINY & TREE-SHAKEABLE -->
          <div
            role="tabpanel"
            aria-labelledby="feature-tab-bundle"
            :tabindex="activeFeature === 'bundle' ? 0 : undefined"
            :hidden="hiddenUntilFound(activeFeature === 'bundle')"
            class="feature-panel-slot"
            @beforematch="selectFeature('bundle')"
          >
            <article class="feature-stage-card stage-accent-violet">
              <header class="stage-header">
                <span class="stage-tag tag-violet">SMALL BUNDLE SIZE</span>
                <h3 class="stage-title">Tiny &amp; Tree-Shakeable Subpaths</h3>
                <p class="stage-desc">
                  Compose your exact imports with <code>/slim</code>,
                  <code>/core/*</code>, and <code>/storage/*</code> so unused
                  engines, adapters, and framework hooks never reach your
                  production bundle.
                </p>
              </header>

              <div class="stage-widget">
                <div
                  class="mini-switcher"
                  role="group"
                  aria-label="Toggle optional bundle modules"
                >
                  <button
                    type="button"
                    :aria-pressed="bundleEngine === 'wasm'"
                    :class="[
                      'mini-pill-btn',
                      { active: bundleEngine === 'wasm' },
                    ]"
                    @click="bundleEngine = 'wasm'"
                  >
                    WASM Core
                  </button>
                  <button
                    type="button"
                    :aria-pressed="bundleEngine === 'js'"
                    :class="[
                      'mini-pill-btn',
                      { active: bundleEngine === 'js' },
                    ]"
                    @click="bundleEngine = 'js'"
                  >
                    Pure JS Core
                  </button>
                  <button
                    type="button"
                    :aria-pressed="bundleReact"
                    :class="['mini-pill-btn', { active: bundleReact }]"
                    @click="bundleReact = !bundleReact"
                  >
                    {{ bundleReact ? "✓ React (<1 KB)" : "+ React (<1 KB)" }}
                  </button>
                  <button
                    type="button"
                    :aria-pressed="bundleSearch"
                    :class="['mini-pill-btn', { active: bundleSearch }]"
                    @click="bundleSearch = !bundleSearch"
                  >
                    {{ bundleSearch ? "✓ Search" : "+ Search" }}
                  </button>
                </div>

                <div class="mini-code-box">
                  <div
                    v-for="(line, i) in bundleCode"
                    :key="i"
                    class="code-line"
                  >
                    <span class="line-num">{{ i + 1 }}</span>
                    <span class="line-content" v-html="line || '&nbsp;'"></span>
                  </div>
                </div>

                <div class="mini-bundle-compare">
                  <div class="bundle-row">
                    <span class="bundle-label"
                      >Your WebDB selection ({{
                        bundleSummary.parts.join(" + ")
                      }})</span
                    >
                    <span class="bundle-val bundle-val-win"
                      >{{
                        bundleEngine === "wasm"
                          ? SIZE_METRICS.wasmGzip
                          : "Zero WASM"
                      }}
                      core</span
                    >
                  </div>
                  <div class="bundle-track">
                    <div
                      class="bundle-fill bundle-fill-webdb"
                      :style="{ width: `${bundleSummary.pct}%` }"
                    ></div>
                  </div>
                  <div class="bundle-row bundle-row-muted">
                    <span class="bundle-label"
                      >Typical ported desktop WASM DB</span
                    >
                    <span class="bundle-val">1 MB – 5 MB+</span>
                  </div>
                  <div class="bundle-track">
                    <div
                      class="bundle-fill bundle-fill-legacy"
                      style="width: 100%"
                    ></div>
                  </div>
                </div>
              </div>

              <footer class="stage-footer">
                <a
                  :href="withBase('/guides/storage-and-configuration')"
                  class="stage-footer-link"
                >
                  <span>Explore Modular Subpath Exports</span>
                  <span class="btn-arrow">→</span>
                </a>
              </footer>
            </article>
          </div>

          <!-- PANEL 4: CRASH-SAFE TRANSACTIONS & OFFLINE SYNC -->
          <div
            role="tabpanel"
            aria-labelledby="feature-tab-offline"
            :tabindex="activeFeature === 'offline' ? 0 : undefined"
            :hidden="hiddenUntilFound(activeFeature === 'offline')"
            class="feature-panel-slot"
            @beforematch="selectFeature('offline')"
          >
            <article class="feature-stage-card stage-accent-amber">
              <header class="stage-header">
                <span class="stage-tag tag-amber">RELIABLE OFFLINE</span>
                <h3 class="stage-title">Crash-Safe Transactions &amp; Sync</h3>
                <p class="stage-desc">
                  Atomic transactions with nested savepoints protect your local
                  state across sudden tab closes, while commit hooks let you
                  collect compact net changesets for background sync.
                </p>
              </header>

              <div class="stage-widget">
                <div
                  class="mini-switcher"
                  role="group"
                  aria-label="Choose offline reliability feature"
                >
                  <button
                    type="button"
                    :aria-pressed="selectedOfflineMode === 'savepoints'"
                    :class="[
                      'mini-pill-btn',
                      { active: selectedOfflineMode === 'savepoints' },
                    ]"
                    @click="selectedOfflineMode = 'savepoints'"
                  >
                    Nested Savepoints
                  </button>
                  <button
                    type="button"
                    :aria-pressed="selectedOfflineMode === 'sync'"
                    :class="[
                      'mini-pill-btn',
                      { active: selectedOfflineMode === 'sync' },
                    ]"
                    @click="selectedOfflineMode = 'sync'"
                  >
                    Coalesced Offline Sync
                  </button>
                </div>

                <div class="mini-code-box">
                  <div
                    v-for="(line, i) in offlineCode"
                    :key="i"
                    class="code-line"
                  >
                    <span class="line-num">{{ i + 1 }}</span>
                    <span class="line-content" v-html="line || '&nbsp;'"></span>
                  </div>
                </div>

                <div class="mini-facts-grid">
                  <div class="mini-fact">
                    <span class="mini-fact-label">Multi-Tab Locks</span>
                    <span class="mini-fact-value">Automatic via Web Locks</span>
                  </div>
                  <div class="mini-fact">
                    <span class="mini-fact-label">Tab Crash Safety</span>
                    <span class="mini-fact-value">Atomic commit &amp; rollback</span>
                  </div>
                  <div class="mini-fact">
                    <span class="mini-fact-label">Sync Payloads</span>
                    <span class="mini-fact-value">Coalesced net row diffs</span>
                  </div>
                </div>
              </div>

              <footer class="stage-footer">
                <a
                  :href="withBase('/offline-sync')"
                  class="stage-footer-link"
                >
                  <span>Read Transactions &amp; Offline Sync Guide</span>
                  <span class="btn-arrow">→</span>
                </a>
              </footer>
            </article>
          </div>

          <!-- PANEL 5: SNAPSHOTS & TERMINAL CLI -->
          <div
            role="tabpanel"
            aria-labelledby="feature-tab-snapshots"
            :tabindex="activeFeature === 'snapshots' ? 0 : undefined"
            :hidden="hiddenUntilFound(activeFeature === 'snapshots')"
            class="feature-panel-slot"
            @beforematch="selectFeature('snapshots')"
          >
            <article class="feature-stage-card stage-accent-rose">
              <header class="stage-header">
                <span class="stage-tag tag-rose">INSTANT HYDRATION &amp; CLI</span>
                <h3 class="stage-title">Compressed Snapshots &amp; CLI</h3>
                <p class="stage-desc">
                  Pre-seed an indexed database at build time, ship it as a
                  compact <code>.webdb.gz</code> snapshot for instant browser
                  cold starts, and inspect or query local files with
                  <code>npx webdb</code>.
                </p>
              </header>

              <div class="stage-widget">
                <div
                  class="mini-switcher"
                  role="group"
                  aria-label="Choose snapshots or CLI workflow"
                >
                  <button
                    type="button"
                    :aria-pressed="selectedSnapshotMode === 'snapshot'"
                    :class="[
                      'mini-pill-btn',
                      { active: selectedSnapshotMode === 'snapshot' },
                    ]"
                    @click="selectedSnapshotMode = 'snapshot'"
                  >
                    Instant .webdb.gz Hydration
                  </button>
                  <button
                    type="button"
                    :aria-pressed="selectedSnapshotMode === 'cli'"
                    :class="[
                      'mini-pill-btn',
                      { active: selectedSnapshotMode === 'cli' },
                    ]"
                    @click="selectedSnapshotMode = 'cli'"
                  >
                    Terminal CLI (npx webdb)
                  </button>
                </div>

                <div class="mini-code-box">
                  <div
                    v-for="(line, i) in snapshotCode"
                    :key="i"
                    class="code-line"
                  >
                    <span class="line-num">{{ i + 1 }}</span>
                    <span class="line-content" v-html="line || '&nbsp;'"></span>
                  </div>
                </div>

                <div class="mini-facts-grid">
                  <div class="mini-fact">
                    <span class="mini-fact-label">Cold Start</span>
                    <span class="mini-fact-value">Zero JSON parsing overhead</span>
                  </div>
                  <div class="mini-fact">
                    <span class="mini-fact-label">Inspection</span>
                    <span class="mini-fact-value">Read-only CLI verification</span>
                  </div>
                  <div class="mini-fact">
                    <span class="mini-fact-label">Portability</span>
                    <span class="mini-fact-value">Shareable URLs in Studio</span>
                  </div>
                </div>
              </div>

              <footer class="stage-footer">
                <a :href="withBase('/guides/cli')" class="stage-footer-link">
                  <span>Explore Snapshots &amp; CLI Guide</span>
                  <span class="btn-arrow">→</span>
                </a>
              </footer>
            </article>
          </div>

          <!-- PANEL 6: TYPED SCHEMAS & MIGRATIONS -->
          <div
            role="tabpanel"
            aria-labelledby="feature-tab-schema"
            :tabindex="activeFeature === 'schema' ? 0 : undefined"
            :hidden="hiddenUntilFound(activeFeature === 'schema')"
            class="feature-panel-slot"
            @beforematch="selectFeature('schema')"
          >
            <article class="feature-stage-card stage-accent-indigo">
              <header class="stage-header">
                <span class="stage-tag tag-indigo">SCHEMA &amp; MIGRATIONS</span>
                <h3 class="stage-title">Typed Schemas, Indexes &amp; Migrations</h3>
                <p class="stage-desc">
                  Model relational tables with strongly typed columns
                  (<code>UUID</code>, <code>ULID</code>, <code>TEXT</code>,
                  <code>INT32</code>, <code>FLOAT64</code>, <code>BLOB</code>),
                  composite indexes, and clean schema evolution as your app
                  grows.
                </p>
              </header>

              <div class="stage-widget">
                <div
                  class="mini-switcher"
                  role="group"
                  aria-label="Step through schema evolution"
                >
                  <button
                    v-for="(step, idx) in migrationSteps"
                    :key="step.label"
                    type="button"
                    :aria-pressed="selectedMigrationStep === idx"
                    :class="[
                      'mini-pill-btn',
                      { active: selectedMigrationStep === idx },
                    ]"
                    @click="selectedMigrationStep = idx as 0 | 1 | 2"
                  >
                    {{ step.label }}
                  </button>
                </div>

                <div class="mini-code-box">
                  <div
                    v-for="(line, i) in renderedMigrationCode"
                    :key="i"
                    class="code-line"
                  >
                    <span class="line-num">{{ i + 1 }}</span>
                    <span class="line-content" v-html="line || '&nbsp;'"></span>
                  </div>
                </div>

                <div class="mini-facts-grid">
                  <div class="mini-fact">
                    <span class="mini-fact-label">Column Types</span>
                    <span class="mini-fact-value">UUID, ULID, TEXT, INT, FLOAT, BLOB</span>
                  </div>
                  <div class="mini-fact">
                    <span class="mini-fact-label">Constraints</span>
                    <span class="mini-fact-value">Primary Keys &amp; Unique Indexes</span>
                  </div>
                  <div class="mini-fact">
                    <span class="mini-fact-label">Evolution</span>
                    <span class="mini-fact-value">ALTER TABLE &amp; versioned runners</span>
                  </div>
                </div>
              </div>

              <footer class="stage-footer">
                <a
                  :href="withBase('/guides/migrations')"
                  class="stage-footer-link"
                >
                  <span>Read Schema &amp; Migrations Guide</span>
                  <span class="btn-arrow">→</span>
                </a>
              </footer>
            </article>
          </div>
        </div>
      </div>
    </section>

    <!-- ======================================================================
         5A. BUILT-IN TEXT SEARCH — SPLIT LAYOUT WITH LIVE SEARCH WIDGET
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

      <div class="split-feature-grid">
        <!-- LEFT: REAL INLINE LIVE SEARCH WIDGET -->
        <div class="live-search-card">
          <div class="live-card-topbar">
            <span class="live-pulse-pill">
              <span class="status-dot" aria-hidden="true"></span>
              LIVE IN YOUR BROWSER
            </span>
            <span class="live-pkg-tag">@ahmadmoussawi/webdb/search</span>
          </div>

          <div class="live-search-field">
            <label for="landing-search-input" class="live-search-label">
              Try typo-tolerant search
            </label>
            <div class="live-search-input-wrap">
              <svg
                class="live-search-icon"
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <input
                id="landing-search-input"
                v-model="liveSearchQuery"
                type="search"
                class="live-search-input"
                autocomplete="off"
                spellcheck="false"
                placeholder="Type 'reactve', 'cafe', or 'persist'..."
              />
            </div>
          </div>

          <div class="live-search-controls">
            <div class="live-presets" role="group" aria-label="Sample queries">
              <button
                v-for="preset in liveSearchPresets"
                :key="preset.query"
                type="button"
                :class="[
                  'preset-chip',
                  { active: liveSearchQuery === preset.query },
                ]"
                @click="liveSearchQuery = preset.query"
              >
                <span>{{ preset.query }}</span>
                <small>{{ preset.hint }}</small>
              </button>
            </div>

            <button
              type="button"
              :aria-pressed="liveSearchFuzzy"
              :class="['fuzzy-toggle-btn', { active: liveSearchFuzzy }]"
              @click="liveSearchFuzzy = !liveSearchFuzzy"
            >
              <span class="fuzzy-label-full"
                >Typo tolerance: {{ liveSearchFuzzy ? "On" : "Off" }}</span
              >
              <span class="fuzzy-label-short"
                >Typos: {{ liveSearchFuzzy ? "On" : "Off" }}</span
              >
            </button>
          </div>

          <div class="live-search-status-bar">
            <span class="live-search-count" aria-live="polite">
              {{ liveSearchStatus }}
            </span>
            <span class="live-timing-pill">Zero external deps</span>
          </div>

          <ul v-if="liveSearchResult.hits.length" class="live-search-list">
            <li
              v-for="hit in liveSearchResult.hits"
              :key="hit.row.id"
              class="live-search-item"
            >
              <div class="live-hit-head">
                <h4
                  class="live-hit-title"
                  v-html="hit.highlights.title || hit.row.title"
                ></h4>
                <span class="live-hit-cat">{{ hit.row.category }}</span>
              </div>
              <p
                class="live-hit-snippet"
                v-html="hit.snippets.body || hit.row.body"
              ></p>
            </li>
          </ul>
          <div v-else class="live-search-empty">
            No matches for <strong>{{ liveSearchQuery }}</strong
            >.
            <template v-if="!liveSearchFuzzy">
              Turn on typo tolerance or try <code>reactve</code>.
            </template>
            <template v-else>Try <code>reactve</code> or <code>cafe</code>.</template>
          </div>
        </div>

        <!-- RIGHT: COMPACT CODE + KEY ADVANTAGES -->
        <div class="split-code-col">
          <div class="terminal-window term-amber">
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
                  SearchIndex
                </span>
              </div>
              <button
                type="button"
                class="terminal-copy"
                @click="copySearchCode"
              >
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

          <ul class="split-points-list">
            <li class="split-point">
              <span class="point-badge badge-amber" aria-hidden="true">✓</span>
              <div>
                <strong>Always in sync:</strong> queries your existing tables
                directly with zero duplicate sync tables.
              </div>
            </li>
            <li class="split-point">
              <span class="point-badge badge-amber" aria-hidden="true">✓</span>
              <div>
                <strong>Typo &amp; accent tolerant:</strong> weighted field
                ranking, prefix autocomplete, and safe <code>&lt;mark&gt;</code>
                snippets.
              </div>
            </li>
          </ul>

          <div class="split-actions">
            <a :href="withBase('/demos/search')" class="btn btn-primary">
              <span>Open Full Search Demo</span>
              <span class="btn-arrow">→</span>
            </a>
            <a
              :href="withBase('/guides/fuzzy-search')"
              class="btn btn-secondary"
            >
              <span>Search Guide</span>
            </a>
          </div>
        </div>
      </div>
    </section>

    <!-- ======================================================================
         5B. JAVASCRIPT UDFs — ALTERNATING SPLIT LAYOUT
         ====================================================================== -->
    <section class="section-block udf-section">
      <div class="split-feature-grid split-udf">
        <!-- LEFT: NARRATIVE + LIVE UDF PREVIEW -->
        <div class="split-udf-info">
          <div class="split-header-left">
            <span class="section-eyebrow eyebrow-rose">
              CUSTOM JAVASCRIPT FUNCTIONS
            </span>
            <h2 class="section-title split-title">
              Run Any JavaScript or Browser API Inside Queries
            </h2>
            <p class="section-subtitle">
              Register plain JavaScript functions to format dates and currency
              with <code>Intl</code>, match patterns with <code>RegExp</code>,
              or run custom business logic right inside <code>.select()</code>,
              <code>.where()</code>, and <code>.orderBy()</code>.
            </p>
          </div>

          <!-- INTERACTIVE UDF OUTPUT PREVIEW -->
          <div class="live-udf-card">
            <div class="live-card-topbar">
              <span class="live-pulse-pill pill-rose-soft">
                <span class="status-dot dot-rose" aria-hidden="true"></span>
                LIVE INTL + BATCH UDF PREVIEW
              </span>
            </div>

            <div class="udf-controls-row">
              <div class="udf-control-group">
                <span class="udf-control-label">Currency</span>
                <div class="mini-switcher" role="group" aria-label="Currency">
                  <button
                    v-for="cur in ['USD', 'EUR', 'JPY'] as const"
                    :key="cur"
                    type="button"
                    :aria-pressed="udfCurrency === cur"
                    :class="['mini-pill-btn', { active: udfCurrency === cur }]"
                    @click="udfCurrency = cur"
                  >
                    {{ cur }}
                  </button>
                </div>
              </div>

              <div class="udf-control-group">
                <span class="udf-control-label">Discount</span>
                <div
                  class="mini-switcher"
                  role="group"
                  aria-label="Discount percentage"
                >
                  <button
                    v-for="pct in [10, 20, 35] as const"
                    :key="pct"
                    type="button"
                    :aria-pressed="udfDiscount === pct"
                    :class="['mini-pill-btn', { active: udfDiscount === pct }]"
                    @click="udfDiscount = pct"
                  >
                    {{ pct }}% off
                  </button>
                </div>
              </div>
            </div>

            <div class="udf-preview-table">
              <div class="udf-preview-head">
                <span>Product</span>
                <span>Original</span>
                <span>format_money(calc_discount)</span>
              </div>
              <div
                v-for="row in formattedUdfRows"
                :key="row.name"
                class="udf-preview-row"
              >
                <span class="udf-prod-name">{{ row.name }}</span>
                <span class="udf-prod-orig">{{ row.original }}</span>
                <span class="udf-prod-deal">{{ row.deal }}</span>
              </div>
            </div>
          </div>

          <ul class="split-points-list">
            <li class="split-point">
              <span class="point-badge badge-rose" aria-hidden="true">✓</span>
              <div>
                <strong>Native Web APIs built in:</strong> use
                <code>Intl</code>, <code>RegExp</code>, and
                <code>crypto</code> without bundling heavy C libraries.
              </div>
            </li>
            <li class="split-point">
              <span class="point-badge badge-rose" aria-hidden="true">✓</span>
              <div>
                <strong>Smooth batch execution:</strong>
                <code>registerBatchedFunction</code> processes rows in chunks to
                keep large queries fast.
              </div>
            </li>
          </ul>

          <div class="split-actions">
            <a
              :href="withBase('/guides/expressions-and-functions')"
              class="btn btn-primary"
            >
              <span>Read UDFs Guide</span>
              <span class="btn-arrow">→</span>
            </a>
            <a :href="withBase('/demos/search')" class="btn btn-secondary">
              <span>See UDFs in Live Demo</span>
            </a>
          </div>
        </div>

        <!-- RIGHT: UDF CODE TERMINAL -->
        <div class="terminal-window term-rose">
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
            <button type="button" class="terminal-copy" @click="copyUdfCode">
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

      <div class="bench-mobile-cta">
        <a
          :href="withBase('/benchmark/')"
          target="_self"
          class="btn btn-secondary"
        >
          <span>Run this benchmark live on your machine</span>
          <span class="btn-arrow">→</span>
        </a>
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
    <section class="section-block compare-section">
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
              <th scope="col">Capability</th>
              <th scope="col">Raw IndexedDB / Wrappers</th>
              <th scope="col">Ported Desktop WASM (SQLite / PGlite)</th>
              <th scope="col" class="col-webdb-head">
                <div class="webdb-th-inner">
                  <span>WebDB</span>
                  <span class="webdb-th-badge">Browser-Native</span>
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row" class="td-feature">Bundle Size</th>
              <td class="td-neutral">
                <span class="cmp-cell">
                  <span class="cmp-icon cmp-neutral" aria-hidden="true">•</span>
                  <span>~15–40 KB (No query engine)</span>
                </span>
              </td>
              <td class="td-bad">
                <span class="cmp-cell">
                  <span class="cmp-icon cmp-bad" aria-hidden="true">✕</span>
                  <span>1 MB – 5 MB+ WASM binary</span>
                </span>
              </td>
              <td class="td-good">
                <span class="cmp-cell">
                  <span class="cmp-icon cmp-good" aria-hidden="true">✓</span>
                  <span>
                    <strong>{{ SIZE_METRICS.wasmGzip }} Gzipped WASM Core</strong>
                    ({{ SIZE_METRICS.wasmRaw }} raw, tree-shakeable)
                  </span>
                </span>
              </td>
            </tr>
            <tr>
              <th scope="row" class="td-feature">Server Configuration</th>
              <td class="td-neutral">
                <span class="cmp-cell">
                  <span class="cmp-icon cmp-good" aria-hidden="true">✓</span>
                  <span>None required</span>
                </span>
              </td>
              <td class="td-bad">
                <span class="cmp-cell">
                  <span class="cmp-icon cmp-bad" aria-hidden="true">✕</span>
                  <span>
                    Often needs <code>COOP/COEP</code> headers &amp; worker
                    proxies
                  </span>
                </span>
              </td>
              <td class="td-good">
                <span class="cmp-cell">
                  <span class="cmp-icon cmp-good" aria-hidden="true">✓</span>
                  <span>
                    <strong>Zero Headers</strong> — runs on any static host or
                    CDN
                  </span>
                </span>
              </td>
            </tr>
            <tr>
              <th scope="row" class="td-feature">
                Strict CSP / Restricted Environments
              </th>
              <td class="td-neutral">
                <span class="cmp-cell">
                  <span class="cmp-icon cmp-good" aria-hidden="true">✓</span>
                  <span>Pure JS (works)</span>
                </span>
              </td>
              <td class="td-bad">
                <span class="cmp-cell">
                  <span class="cmp-icon cmp-bad" aria-hidden="true">✕</span>
                  <span>Blocked if WASM is disallowed</span>
                </span>
              </td>
              <td class="td-good">
                <span class="cmp-cell">
                  <span class="cmp-icon cmp-good" aria-hidden="true">✓</span>
                  <span>
                    <strong>Dual Core (WASM + Pure JS)</strong> — swap in one
                    line
                  </span>
                </span>
              </td>
            </tr>
            <tr>
              <th scope="row" class="td-feature">
                Async Storage &amp; Custom Adapters
              </th>
              <td class="td-bad">
                <span class="cmp-cell">
                  <span class="cmp-icon cmp-bad" aria-hidden="true">✕</span>
                  <span>IndexedDB only</span>
                </span>
              </td>
              <td class="td-warn">
                <span class="cmp-cell">
                  <span class="cmp-icon cmp-warn" aria-hidden="true">!</span>
                  <span>Complex C VFS / async shims</span>
                </span>
              </td>
              <td class="td-good">
                <span class="cmp-cell">
                  <span class="cmp-icon cmp-good" aria-hidden="true">✓</span>
                  <span>
                    <strong>OPFS, IDB, Memory, Node, or Custom</strong> — clean
                    async adapters
                  </span>
                </span>
              </td>
            </tr>
            <tr>
              <th scope="row" class="td-feature">Relational Queries</th>
              <td class="td-bad">
                <span class="cmp-cell">
                  <span class="cmp-icon cmp-bad" aria-hidden="true">✕</span>
                  <span>Manual JS loops &amp; cursor code</span>
                </span>
              </td>
              <td class="td-neutral">
                <span class="cmp-cell">
                  <span class="cmp-icon cmp-good" aria-hidden="true">✓</span>
                  <span>Full SQL text parser</span>
                </span>
              </td>
              <td class="td-good">
                <span class="cmp-cell">
                  <span class="cmp-icon cmp-good" aria-hidden="true">✓</span>
                  <span>
                    <strong>Fluent TypeScript</strong> JOINs, GROUP BY &amp;
                    subqueries
                  </span>
                </span>
              </td>
            </tr>
            <tr>
              <th scope="row" class="td-feature">
                Reactive UI &amp; Multi-Tab Sync
              </th>
              <td class="td-neutral">
                <span class="cmp-cell">
                  <span class="cmp-icon cmp-warn" aria-hidden="true">!</span>
                  <span>Basic table hooks / polling</span>
                </span>
              </td>
              <td class="td-bad">
                <span class="cmp-cell">
                  <span class="cmp-icon cmp-bad" aria-hidden="true">✕</span>
                  <span>DIY wrappers / manual invalidation</span>
                </span>
              </td>
              <td class="td-good">
                <span class="cmp-cell">
                  <span class="cmp-icon cmp-good" aria-hidden="true">✓</span>
                  <span>
                    <strong>&lt;1 KB Adapters</strong> for React, Vue, Angular
                    &amp; JS with cross-tab sync
                  </span>
                </span>
              </td>
            </tr>
            <tr>
              <th scope="row" class="td-feature">
                Full-Text Search &amp; Custom UDFs
              </th>
              <td class="td-bad">
                <span class="cmp-cell">
                  <span class="cmp-icon cmp-bad" aria-hidden="true">✕</span>
                  <span>External packages required</span>
                </span>
              </td>
              <td class="td-neutral">
                <span class="cmp-cell">
                  <span class="cmp-icon cmp-warn" aria-hidden="true">!</span>
                  <span>Heavy extensions &amp; sync tables</span>
                </span>
              </td>
              <td class="td-good">
                <span class="cmp-cell">
                  <span class="cmp-icon cmp-good" aria-hidden="true">✓</span>
                  <span>
                    <strong>Zero-Dependency Fuzzy Search</strong> + native JS
                    UDFs
                  </span>
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ======================================================================
         7. TRY IT LIVE: INTERACTIVE DEMOS, STUDIO IDE & CLOSING CTA
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
          <div class="demo-thumb thumb-tabs" aria-hidden="true">
            <div class="mini-win">
              <span class="mini-win-bar"></span>
              <span class="mini-win-line w-70"></span>
              <span class="mini-win-line w-50"></span>
            </div>
            <span class="mini-sync-beam">⇄</span>
            <div class="mini-win">
              <span class="mini-win-bar bar-emerald"></span>
              <span class="mini-win-line w-70"></span>
              <span class="mini-win-line w-50"></span>
            </div>
          </div>
          <span class="demo-preview-tag tag-emerald">MULTI-TAB SYNC</span>
          <h3 class="demo-preview-title">Two Tabs, One Database</h3>
          <p class="demo-preview-desc">
            Open two panes sharing one database and watch live queries sync
            changes instantaneously.
          </p>
          <span class="demo-preview-cta">Launch demo →</span>
        </a>

        <a :href="withBase('/demos/kanban')" class="demo-preview-card">
          <div class="demo-thumb thumb-kanban" aria-hidden="true">
            <div class="mini-kcol">
              <span class="mini-kcard"></span>
              <span class="mini-kcard"></span>
            </div>
            <div class="mini-kcol">
              <span class="mini-kcard kcard-active"></span>
            </div>
            <div class="mini-kcol">
              <span class="mini-kcard kcard-done"></span>
              <span class="mini-kcard kcard-done"></span>
            </div>
          </div>
          <span class="demo-preview-tag tag-cyan">ATOMIC TRANSACTIONS</span>
          <h3 class="demo-preview-title">Kanban Board</h3>
          <p class="demo-preview-desc">
            Drag-and-drop task board where every move is saved locally in an
            atomic transaction.
          </p>
          <span class="demo-preview-cta">Launch demo →</span>
        </a>

        <a :href="withBase('/demos/search')" class="demo-preview-card">
          <div class="demo-thumb thumb-search" aria-hidden="true">
            <div class="mini-sbar">
              <span>reactve</span>
              <span class="mini-smatch">typo ok</span>
            </div>
            <div class="mini-srow">
              <span class="mini-smark">React</span>ive Live Queries
            </div>
            <div class="mini-srow">
              <span class="mini-smark">React</span> + Vue Adapters
            </div>
          </div>
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

      <!-- CLOSING CTA BANNER -->
      <div class="closing-cta-banner">
        <div class="closing-cta-grid" aria-hidden="true"></div>
        <div class="closing-cta-inner">
          <span class="section-eyebrow eyebrow-emerald">START IN SECONDS</span>
          <h2 class="closing-cta-title">
            Ready to build your next local-first web app?
          </h2>
          <p class="closing-cta-subtitle">
            Relational queries, reactive UI updates, and reliable offline
            storage—in a tiny bundle with zero server headers.
          </p>
          <div class="closing-cta-actions">
            <a :href="withBase('/getting-started')" class="btn btn-primary">
              <span>Get Started</span>
              <span class="btn-arrow">→</span>
            </a>
            <a href="https://studio.webdb.dev/" class="btn btn-secondary">
              <span>Launch Studio IDE</span>
            </a>
          </div>
          <button
            type="button"
            class="install-pill closing-install-pill"
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
      </div>
    </section>
    </div>
  </div>
</template>

<style scoped>
.webdb-landing {
  width: 100%;
  max-width: none;
  padding: 0 0 6rem;
  font-family: var(--vp-font-family-base);
  color: var(--vp-c-text-1);
  overflow-x: clip;
  overflow-wrap: break-word;
}

.webdb-landing :where(code) {
  overflow-wrap: anywhere;
}

.hero-inner,
.landing-content {
  max-width: 1180px;
  margin: 0 auto;
  padding-inline: 1.75rem;
}

.hero-inner {
  position: relative;
  z-index: 1;
}

code {
  font-family: var(--vp-font-family-mono);
}

/* ============================================================================
   1. SPLIT VISUAL HERO SECTION
   ============================================================================ */
.hero-section {
  position: relative;
  width: 100%;
  max-width: none;
  text-align: left;
  padding: 4rem 0 4.5rem;
  overflow: clip;
  --hero-mouse-x: 50%;
  --hero-mouse-y: 35%;
}

@media (hover: hover) and (pointer: fine) {
  .hero-section:hover {
    --hero-torch-inner: 72px;
    --hero-torch-outer: 300px;
  }
}

.hero-grid-bg {
  position: absolute;
  inset: 0;
  background-image: radial-gradient(
    color-mix(in oklab, var(--vp-c-text-1) 14%, transparent) 1px,
    transparent 1px
  );
  background-size: 24px 24px;
  mask-image: linear-gradient(
    to bottom,
    black 0%,
    black 75%,
    transparent 100%
  );
  -webkit-mask-image: linear-gradient(
    to bottom,
    black 0%,
    black 75%,
    transparent 100%
  );
  pointer-events: none;
  z-index: 0;
}

.hero-torch-grid,
.hero-torch-beam {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  -webkit-mask-image: radial-gradient(
    circle at var(--hero-mouse-x, 50%) var(--hero-mouse-y, 35%),
    black var(--hero-torch-inner, 0px),
    transparent var(--hero-torch-outer, 0px)
  );
  mask-image: radial-gradient(
    circle at var(--hero-mouse-x, 50%) var(--hero-mouse-y, 35%),
    black var(--hero-torch-inner, 0px),
    transparent var(--hero-torch-outer, 0px)
  );
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  transition:
    --hero-torch-inner 0.22s ease-out,
    --hero-torch-outer 0.22s ease-out;
}

.hero-torch-grid {
  background-image:
    radial-gradient(rgba(37, 99, 235, 0.52) 1.5px, transparent 1.5px),
    linear-gradient(to right, rgba(37, 99, 235, 0.08) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(16, 185, 129, 0.08) 1px, transparent 1px);
  background-size:
    24px 24px,
    48px 48px,
    48px 48px;
}

:global(.dark) .hero-torch-grid {
  background-image:
    radial-gradient(rgba(56, 189, 248, 0.62) 1.5px, transparent 1.5px),
    linear-gradient(to right, rgba(56, 189, 248, 0.12) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(16, 185, 129, 0.12) 1px, transparent 1px);
}

.hero-torch-beam {
  background: radial-gradient(
    circle 300px at var(--hero-mouse-x, 50%) var(--hero-mouse-y, 35%),
    rgba(37, 99, 235, 0.14) 0%,
    rgba(139, 92, 246, 0.09) 42%,
    rgba(16, 185, 129, 0.08) 72%,
    transparent 100%
  );
}

:global(.dark) .hero-torch-beam {
  background: radial-gradient(
    circle 300px at var(--hero-mouse-x, 50%) var(--hero-mouse-y, 35%),
    rgba(56, 189, 248, 0.2) 0%,
    rgba(139, 92, 246, 0.14) 45%,
    rgba(16, 185, 129, 0.11) 75%,
    transparent 100%
  );
}

@media (pointer: coarse), (hover: none), (max-width: 768px) {
  .hero-torch-grid,
  .hero-torch-beam {
    display: none;
  }
}

@media (pointer: coarse) {
  .ttab,
  .terminal-copy,
  .fw-selector-card,
  .feature-tab,
  .preset-chip,
  .fuzzy-toggle-btn {
    min-block-size: 44px;
  }
  .hero-carousel-dots {
    gap: 0.95rem;
    padding-block: 1rem;
  }
  .carousel-dot {
    position: relative;
  }
  .carousel-dot::after {
    content: "";
    position: absolute;
    inset: -14px -5px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .hero-torch-grid,
  .hero-torch-beam {
    transition: none !important;
    display: none;
  }
}

.hero-glow {
  position: absolute;
  top: -72px;
  left: 55%;
  transform: translateX(-50%);
  width: min(1040px, 100vw);
  height: 440px;
  background: radial-gradient(
    ellipse at 55% 40%,
    rgba(37, 99, 235, 0.22) 0%,
    rgba(139, 92, 246, 0.14) 36%,
    rgba(16, 185, 129, 0.12) 64%,
    transparent 80%
  );
  pointer-events: none;
  z-index: 0;
  filter: blur(34px);
}

:global(.dark) .hero-glow {
  background: radial-gradient(
    ellipse at 55% 40%,
    rgba(56, 189, 248, 0.22) 0%,
    rgba(139, 92, 246, 0.16) 38%,
    rgba(16, 185, 129, 0.14) 66%,
    transparent 82%
  );
}

.hero-split {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: minmax(0, 1.02fr) minmax(0, 1.08fr);
  gap: 2.75rem;
  align-items: center;
  margin-bottom: 3.25rem;
}

.hero-copy {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  min-width: 0;
}

.hero-eyebrow {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-start;
  gap: 0.5rem;
  padding: 0.38rem 0.9rem;
  border-radius: 999px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  font-family: var(--vp-font-family-mono);
  font-size: 0.72rem;
  margin-bottom: 1.45rem;
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
  font-size: clamp(2rem, 1.35rem + 2.6vw, 3.35rem);
  font-weight: 800;
  letter-spacing: -1.6px;
  line-height: 1.08;
  text-wrap: balance;
  margin: 0 0 1.2rem;
  color: var(--vp-c-text-1);
}

.hero-gradient {
  background: linear-gradient(125deg, #2563eb 0%, #7c3aed 52%, #10b981 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

:global(.dark) .hero-gradient {
  background: linear-gradient(125deg, #38bdf8 0%, #a78bfa 52%, #34d399 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.hero-lead {
  position: relative;
  z-index: 1;
  font-size: 1.12rem;
  line-height: 1.65;
  text-wrap: pretty;
  color: var(--vp-c-text-2);
  max-width: 540px;
  margin: 0 0 1.9rem;
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
  justify-content: flex-start;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.9rem;
  margin-bottom: 1.2rem;
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
  justify-content: flex-start;
  margin-bottom: 0;
}

/* RIGHT COLUMN: INTERACTIVE BROWSER DB SHOWCASE */
.hero-visual-stage {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.hero-stage-aura {
  position: absolute;
  inset: -16px -14px;
  border-radius: 26px;
  background: radial-gradient(
    circle at 30% 25%,
    rgba(59, 130, 246, 0.28),
    rgba(139, 92, 246, 0.2) 45%,
    rgba(16, 185, 129, 0.2) 85%,
    transparent 100%
  );
  filter: blur(26px);
  pointer-events: none;
  z-index: 0;
}

.hero-window-shell {
  position: relative;
  z-index: 1;
  border-radius: 16px;
  overflow: hidden;
  background: #0b1120;
  color: #f8fafc;
  border: 1px solid rgba(148, 163, 184, 0.28);
  box-shadow:
    0 24px 54px rgba(15, 23, 42, 0.28),
    0 0 0 1px rgba(56, 189, 248, 0.12);
}

.hw-chrome {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.72rem 1rem;
  background: #131c31;
  border-bottom: 1px solid rgba(148, 163, 184, 0.2);
}

.hw-chrome-left {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-width: 0;
}

.hw-brand-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.42rem;
  font-family: var(--vp-font-family-mono);
  font-size: 0.74rem;
  font-weight: 700;
  color: #e2e8f0;
  white-space: nowrap;
}

.hw-runtime-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.42rem;
  padding: 0.26rem 0.65rem;
  border-radius: 999px;
  border: 1px solid rgba(56, 189, 248, 0.4);
  background: rgba(56, 189, 248, 0.12);
  color: #7dd3fc;
  font-family: var(--vp-font-family-mono);
  font-size: 0.68rem;
  font-weight: 700;
  cursor: pointer;
  white-space: nowrap;
  transition:
    background-color 0.16s ease,
    border-color 0.16s ease;
}

.hw-runtime-toggle:hover {
  background: rgba(56, 189, 248, 0.2);
  border-color: rgba(56, 189, 248, 0.7);
}

.hw-runtime-toggle:focus-visible {
  outline: 2px solid #38bdf8;
  outline-offset: 2px;
}

.hw-runtime-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #38bdf8;
  box-shadow: 0 0 8px #38bdf8;
}

.hw-toolbar {
  padding: 0.85rem 1rem;
  border-bottom: 1px solid rgba(148, 163, 184, 0.16);
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
  background: #0f172a;
}

.hw-query-line {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.48rem 0.7rem;
  border-radius: 8px;
  background: rgba(2, 6, 23, 0.75);
  border: 1px solid rgba(148, 163, 184, 0.18);
  font-family: var(--vp-font-family-mono);
  font-size: 0.74rem;
  color: #e2e8f0;
  overflow-x: auto;
  white-space: nowrap;
}

.hw-query-line :deep(.hl-str) {
  color: #34d399;
}
.hw-query-line :deep(.hl-fn) {
  color: #60a5fa;
}
.hw-query-line :deep(.hl-kw) {
  color: #c084fc;
}

.hw-query-prompt {
  color: #34d399;
  font-weight: 800;
}

.hw-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.55rem;
}

.hw-filter-group {
  display: inline-flex;
  gap: 0.35rem;
}

.hw-filter-btn {
  padding: 0.28rem 0.65rem;
  border-radius: 7px;
  border: 1px solid rgba(148, 163, 184, 0.24);
  background: rgba(30, 41, 59, 0.75);
  color: #cbd5e1;
  font-family: var(--vp-font-family-mono);
  font-size: 0.7rem;
  font-weight: 600;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease,
    color 0.15s ease;
}

.hw-filter-btn:hover {
  border-color: rgba(148, 163, 184, 0.5);
  color: #ffffff;
}

.hw-filter-btn.active {
  background: rgba(56, 189, 248, 0.18);
  border-color: #38bdf8;
  color: #e0f2fe;
}

.hw-filter-btn:focus-visible,
.hw-insert-btn:focus-visible,
.hw-status-pill:focus-visible {
  outline: 2px solid #38bdf8;
  outline-offset: 2px;
}

.hw-insert-btn {
  padding: 0.3rem 0.75rem;
  border-radius: 7px;
  border: 1px solid rgba(16, 185, 129, 0.55);
  background: rgba(16, 185, 129, 0.18);
  color: #6ee7b7;
  font-family: var(--vp-font-family-mono);
  font-size: 0.71rem;
  font-weight: 700;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease;
}

.hw-insert-btn:hover {
  background: rgba(16, 185, 129, 0.28);
  border-color: #34d399;
  color: #ecfdf5;
}

.hw-table {
  display: flex;
  flex-direction: column;
  padding: 0.35rem 0 0.85rem;
  min-height: 236px;
  height: 236px;
  box-sizing: border-box;
}

.hw-table-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  flex-wrap: wrap;
  padding: 1rem;
  font-size: 0.82rem;
  color: #94a3b8;
  text-align: center;
}

.hw-table-empty strong {
  color: #e2e8f0;
}

.hw-table-head,
.hw-table-row {
  display: grid;
  grid-template-columns: 56px 1fr 72px 116px;
  align-items: center;
  gap: 0.5rem;
  padding: 0.55rem 1rem;
}

.hw-table-head {
  font-family: var(--vp-font-family-mono);
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #94a3b8;
  border-bottom: 1px solid rgba(148, 163, 184, 0.14);
}

.hw-table-row {
  font-size: 0.82rem;
  color: #e2e8f0;
  border-bottom: 1px solid rgba(148, 163, 184, 0.08);
  transition: background-color 0.25s ease;
}

.hw-table-row:last-child {
  border-bottom: none;
}

@media (prefers-reduced-motion: no-preference) {
  .hw-table-row.row-flash {
    background: rgba(16, 185, 129, 0.18);
  }
}

.hw-cell-id {
  font-family: var(--vp-font-family-mono);
  font-size: 0.74rem;
  color: #94a3b8;
}

.hw-cell-name {
  font-weight: 600;
  color: #f8fafc;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hw-cell-total {
  font-family: var(--vp-font-family-mono);
  font-weight: 700;
  color: #cbd5e1;
}

.hw-status-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.3rem;
  padding: 0.22rem 0.55rem;
  border-radius: 999px;
  font-family: var(--vp-font-family-mono);
  font-size: 0.69rem;
  font-weight: 700;
  border: 1px solid transparent;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease;
}

.status-paid {
  color: #6ee7b7;
  background: rgba(16, 185, 129, 0.16);
  border-color: rgba(16, 185, 129, 0.4);
}

.status-pending {
  color: #fcd34d;
  background: rgba(245, 158, 11, 0.16);
  border-color: rgba(245, 158, 11, 0.4);
}

/* FLOATING DOCKED TAB 2 SYNC CARD */
.hero-sync-card {
  position: relative;
  z-index: 2;
  align-self: flex-end;
  margin: -1.15rem 1rem 0 auto;
  min-width: 215px;
  padding: 0.85rem 1.05rem;
  border-radius: 13px;
  background: #111a2e;
  color: #f8fafc;
  border: 1px solid rgba(16, 185, 129, 0.45);
  box-shadow: 0 14px 32px rgba(15, 23, 42, 0.34);
  transition: border-color 0.2s ease;
}

@media (prefers-reduced-motion: no-preference) {
  .hero-sync-card.sync-pulse {
    border-color: #34d399;
    transform: translateY(-2px);
  }
}

.sync-card-head {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  font-family: var(--vp-font-family-mono);
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: #6ee7b7;
  margin-bottom: 0.32rem;
}

.sync-card-body {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.85rem;
}

.sync-metric-val {
  font-family: var(--vp-font-family-mono);
  font-size: 1.25rem;
  font-weight: 800;
  color: #ffffff;
}

.sync-metric-meta {
  font-family: var(--vp-font-family-mono);
  font-size: 0.7rem;
  color: #94a3b8;
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
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  padding: 1.35rem 1.25rem;
  --metric-accent: var(--vp-c-brand-1);
  transition:
    border-color 0.2s ease,
    box-shadow 0.2s ease,
    transform 0.2s ease;
}

.metric-card::before {
  content: "";
  position: absolute;
  inset: 0 0 auto;
  height: 2px;
  background: linear-gradient(
    90deg,
    transparent,
    var(--metric-accent),
    transparent
  );
  opacity: 0.7;
}

.metric-emerald {
  --metric-accent: #10b981;
}
.metric-cyan {
  --metric-accent: #0ea5e9;
}
.metric-violet {
  --metric-accent: #8b5cf6;
}
.metric-rose {
  --metric-accent: #f43f5e;
}

.metric-card:hover {
  border-color: color-mix(in srgb, var(--metric-accent) 55%, var(--vp-c-divider));
  box-shadow: 0 10px 26px color-mix(in srgb, var(--metric-accent) 10%, transparent);
}

@media (prefers-reduced-motion: no-preference) {
  .metric-card:hover {
    transform: translateY(-2px);
  }
}

.metric-head-row {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.7rem;
}

.metric-head-row .metric-pill {
  margin-bottom: 0;
}

.metric-icon-box {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border: 1px solid transparent;
}

.icon-emerald {
  color: #10b981;
  background: rgba(16, 185, 129, 0.12);
  border-color: rgba(16, 185, 129, 0.25);
}

.icon-cyan {
  color: #0ea5e9;
  background: rgba(14, 165, 233, 0.12);
  border-color: rgba(14, 165, 233, 0.25);
}

.icon-violet {
  color: #8b5cf6;
  background: rgba(139, 92, 246, 0.12);
  border-color: rgba(139, 92, 246, 0.25);
}

.icon-rose {
  color: #f43f5e;
  background: rgba(244, 63, 94, 0.12);
  border-color: rgba(244, 63, 94, 0.25);
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
  font-size: clamp(1.45rem, 1.15rem + 1.3vw, 2.2rem);
  font-weight: 800;
  letter-spacing: -0.8px;
  text-wrap: balance;
  margin: 0 0 0.85rem;
  color: var(--vp-c-text-1);
}

.section-subtitle {
  font-size: 1.05rem;
  line-height: 1.65;
  text-wrap: pretty;
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
    border-color 0.2s ease,
    box-shadow 0.2s ease;
}

.term-brand {
  border-color: color-mix(in srgb, var(--vp-c-brand-1) 28%, var(--webdb-term-border));
  box-shadow:
    var(--webdb-term-shadow),
    0 12px 36px rgba(37, 99, 235, 0.08);
}

.term-amber {
  border-color: rgba(245, 158, 11, 0.32);
  box-shadow:
    var(--webdb-term-shadow),
    0 12px 32px rgba(245, 158, 11, 0.08);
}

.term-rose {
  border-color: rgba(244, 63, 94, 0.32);
  box-shadow:
    var(--webdb-term-shadow),
    0 12px 32px rgba(244, 63, 94, 0.08);
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
   4. BUILT WITH THE BROWSER — INTERACTIVE FEATURE EXPLORER
   ============================================================================ */
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

.feature-explorer {
  display: grid;
  grid-template-columns: minmax(270px, 340px) minmax(0, 1fr);
  gap: 1.5rem;
  align-items: start;
}

.feature-tablist {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.feature-tab {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 0.85rem;
  width: 100%;
  text-align: left;
  padding: 0.95rem 1.05rem;
  border-radius: 12px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--vp-c-text-2);
  cursor: pointer;
  transition:
    background-color 0.18s ease,
    border-color 0.18s ease,
    color 0.18s ease;
  --feature-accent: var(--vp-c-brand-1);
}

.feature-tab.accent-cyan {
  --feature-accent: #0ea5e9;
}
.feature-tab.accent-emerald {
  --feature-accent: #10b981;
}
.feature-tab.accent-violet {
  --feature-accent: #8b5cf6;
}
.feature-tab.accent-amber {
  --feature-accent: #f59e0b;
}
.feature-tab.accent-rose {
  --feature-accent: #f43f5e;
}
.feature-tab.accent-indigo {
  --feature-accent: #6366f1;
}

.feature-tab:hover {
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
}

.feature-tab:focus-visible {
  outline: 2px solid var(--feature-accent);
  outline-offset: 2px;
}

.feature-tab[aria-selected="true"] {
  background: var(--vp-c-bg-soft);
  border-color: var(--vp-c-divider);
  color: var(--vp-c-text-1);
}

/* Non-color selection indicator bar on ::after (no layout shift) */
.feature-tab[aria-selected="true"]::after {
  content: "";
  position: absolute;
  inset: 10px auto 10px 0;
  width: 3px;
  background: var(--feature-accent);
  border-radius: 999px;
}

.feature-tab-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 9px;
  flex-shrink: 0;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  color: var(--vp-c-text-2);
  transition:
    color 0.18s ease,
    border-color 0.18s ease,
    background-color 0.18s ease;
}

.feature-tab[aria-selected="true"] .feature-tab-icon {
  color: var(--feature-accent);
  border-color: color-mix(in srgb, var(--feature-accent) 45%, var(--vp-c-divider));
  background: color-mix(in srgb, var(--feature-accent) 12%, var(--vp-c-bg));
}

.feature-tab-copy {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  min-width: 0;
}

.feature-tab-title {
  font-size: 0.94rem;
  font-weight: 700;
  line-height: 1.3;
  color: var(--vp-c-text-1);
}

.feature-tab-title-short {
  display: none;
}

.feature-tab-teaser {
  font-size: 0.79rem;
  line-height: 1.4;
  color: var(--vp-c-text-2);
}

/* Stack all tabpanels in one grid cell with zero gap */
.feature-stage {
  display: grid;
  min-width: 0;
}

.feature-panel-slot {
  grid-area: 1 / 1;
  min-width: 0;
}

.feature-panel-slot[hidden] {
  pointer-events: none;
  align-self: start;
}

.feature-panel-slot:not([hidden]) {
  position: relative;
  z-index: 1;
}

.feature-panel-slot:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 4px;
  border-radius: 16px;
}

.feature-stage-card {
  position: relative;
  overflow: hidden;
  container-type: inline-size;
  --stage-accent: var(--vp-c-brand-1);
  background:
    radial-gradient(
      ellipse 80% 45% at 50% 0%,
      color-mix(in srgb, var(--stage-accent) 9%, transparent),
      transparent 70%
    ),
    var(--vp-c-bg-soft);
  border: 1px solid color-mix(in srgb, var(--stage-accent) 26%, var(--vp-c-divider));
  border-radius: 16px;
  padding: 2rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  min-width: 0;
}

.feature-stage-card::before {
  content: "";
  position: absolute;
  inset: 0 0 auto;
  height: 2px;
  background: linear-gradient(
    90deg,
    transparent,
    var(--stage-accent),
    transparent
  );
  opacity: 0.85;
}

.stage-accent-cyan {
  --stage-accent: #0ea5e9;
}
.stage-accent-emerald {
  --stage-accent: #10b981;
}
.stage-accent-violet {
  --stage-accent: #8b5cf6;
}
.stage-accent-amber {
  --stage-accent: #f59e0b;
}
.stage-accent-rose {
  --stage-accent: #f43f5e;
}
.stage-accent-indigo {
  --stage-accent: #6366f1;
}

@media (prefers-reduced-motion: no-preference) {
  .feature-panel-slot:not([hidden]) .feature-stage-card {
    animation: featurePanelReveal 0.24s cubic-bezier(0.22, 1, 0.36, 1);
  }
}

@keyframes featurePanelReveal {
  from {
    opacity: 0;
    translate: 0 6px;
  }
  to {
    opacity: 1;
    translate: 0 0;
  }
}

.stage-header {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}

.stage-tag {
  align-self: flex-start;
  font-family: var(--vp-font-family-mono);
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  padding: 0.24rem 0.65rem;
  border-radius: 999px;
}

.stage-title {
  font-size: 1.42rem;
  font-weight: 800;
  letter-spacing: -0.4px;
  text-wrap: balance;
  color: var(--vp-c-text-1);
  margin: 0;
}

.stage-desc {
  font-size: 0.94rem;
  line-height: 1.65;
  text-wrap: pretty;
  color: var(--vp-c-text-2);
  margin: 0;
}

.stage-desc code {
  font-size: 0.88em;
  padding: 0.1rem 0.35rem;
  border-radius: 5px;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
}

.stage-widget {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.25rem;
  border-radius: 12px;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
}

.mini-switcher {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
}

.mini-pill-btn {
  padding: 0.42rem 0.82rem;
  border-radius: 999px;
  font-family: var(--vp-font-family-mono);
  font-size: 0.74rem;
  font-weight: 600;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2);
  cursor: pointer;
  transition:
    background-color 0.16s ease,
    border-color 0.16s ease,
    color 0.16s ease;
}

.mini-pill-btn:hover {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-text-1);
}

.mini-pill-btn:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}

.mini-pill-btn.active {
  background: var(--vp-c-brand-soft);
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}

.mini-code-box {
  padding: 0.95rem 0.9rem;
  border-radius: 10px;
  background: var(--webdb-term-bg);
  border: 1px solid var(--webdb-term-border);
  overflow-x: auto;
  font-family: var(--vp-font-family-mono);
  font-size: 0.79rem;
  line-height: 1.62;
  color: var(--webdb-term-text);
}

.mini-facts-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 0.65rem;
}

@container (min-width: 480px) {
  .mini-facts-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

.mini-fact {
  padding: 0.75rem 0.85rem;
  border-radius: 9px;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.mini-fact-label {
  font-family: var(--vp-font-family-mono);
  font-size: 0.66rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--vp-c-text-3);
}

.mini-fact-value {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--vp-c-text-1);
  line-height: 1.35;
}

.mini-api-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}

.mini-api-label {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--vp-c-text-2);
}

.mini-api-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.mini-api-chip {
  font-family: var(--vp-font-family-mono);
  font-size: 0.7rem;
  font-weight: 600;
  padding: 0.2rem 0.55rem;
  border-radius: 6px;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  color: var(--vp-c-text-2);
}

.mini-bundle-compare {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.bundle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
  font-size: 0.78rem;
}

.bundle-row-muted {
  margin-top: 0.35rem;
  color: var(--vp-c-text-3);
}

.bundle-label {
  font-weight: 600;
  color: var(--vp-c-text-2);
}

.bundle-val {
  font-family: var(--vp-font-family-mono);
  font-weight: 700;
  color: var(--vp-c-text-2);
}

.bundle-val-win {
  color: var(--webdb-badge-green-text);
}

.bundle-track {
  height: 10px;
  border-radius: 999px;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  overflow: hidden;
}

.bundle-fill {
  height: 100%;
  border-radius: 999px;
  transition: width 0.3s ease;
}

.bundle-fill-webdb {
  background: linear-gradient(90deg, #8b5cf6, #10b981);
}

.bundle-fill-legacy {
  background: rgba(148, 163, 184, 0.4);
}

.stage-footer {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding-top: 0.25rem;
}

.stage-footer-link {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  font-family: var(--vp-font-family-mono);
  font-size: 0.82rem;
  font-weight: 700;
  color: var(--vp-c-brand-1);
  text-decoration: none;
}

.stage-footer-link:hover {
  text-decoration: underline;
}

.stage-footer-link:hover .btn-arrow {
  transform: translateX(3px);
}

/* ============================================================================
   5. SPLIT SEARCH & UDF LIVE SHOWCASES
   ============================================================================ */
.split-feature-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr);
  gap: 1.5rem;
  align-items: start;
}

.split-code-col,
.split-udf-info {
  display: flex;
  flex-direction: column;
  gap: 1.15rem;
  min-width: 0;
}

.split-header-left {
  text-align: left;
}

.split-title {
  font-size: 1.95rem;
}

.split-points-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}

.split-point {
  display: flex;
  align-items: flex-start;
  gap: 0.65rem;
  font-size: 0.9rem;
  line-height: 1.5;
  color: var(--vp-c-text-2);
}

.split-point strong {
  color: var(--vp-c-text-1);
}

.point-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  font-size: 0.75rem;
  font-weight: 800;
  flex-shrink: 0;
  margin-top: 0.1rem;
}

.badge-amber {
  color: #d97706;
  background: rgba(245, 158, 11, 0.16);
}

:global(.dark) .badge-amber {
  color: #fbbf24;
}

.badge-rose {
  color: #e11d48;
  background: rgba(244, 63, 94, 0.15);
}

:global(.dark) .badge-rose {
  color: #fb7185;
}

.split-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-top: 0.25rem;
}

/* LIVE SEARCH INTERACTIVE CARD */
.live-search-card,
.live-udf-card {
  position: relative;
  overflow: hidden;
  border-radius: 16px;
  padding: 1.35rem;
  background:
    radial-gradient(
      ellipse 90% 45% at 50% 0%,
      rgba(245, 158, 11, 0.1),
      transparent 72%
    ),
    var(--vp-c-bg-soft);
  border: 1px solid rgba(245, 158, 11, 0.35);
  display: flex;
  flex-direction: column;
  gap: 0.95rem;
  min-width: 0;
}

.live-udf-card {
  background:
    radial-gradient(
      ellipse 90% 45% at 50% 0%,
      rgba(244, 63, 94, 0.09),
      transparent 72%
    ),
    var(--vp-c-bg-soft);
  border-color: rgba(244, 63, 94, 0.32);
}

.live-card-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.live-pulse-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  font-family: var(--vp-font-family-mono);
  font-size: 0.66rem;
  font-weight: 800;
  letter-spacing: 0.07em;
  color: #b45309;
  background: rgba(245, 158, 11, 0.14);
  padding: 0.24rem 0.6rem;
  border-radius: 999px;
}

:global(.dark) .live-pulse-pill {
  color: #fbbf24;
}

.pill-rose-soft {
  color: #be123c;
  background: rgba(244, 63, 94, 0.14);
}

:global(.dark) .pill-rose-soft {
  color: #fb7185;
}

.dot-rose {
  background-color: #f43f5e;
  box-shadow: 0 0 8px #f43f5e;
}

.live-pkg-tag {
  font-family: var(--vp-font-family-mono);
  font-size: 0.7rem;
  color: var(--vp-c-text-3);
}

.live-search-field {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.live-search-label {
  font-size: 0.82rem;
  font-weight: 700;
  color: var(--vp-c-text-1);
}

.live-search-input-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.live-search-icon {
  position: absolute;
  left: 0.85rem;
  color: var(--vp-c-text-3);
  pointer-events: none;
}

.live-search-input {
  width: 100%;
  box-sizing: border-box;
  padding: 0.68rem 0.9rem 0.68rem 2.45rem;
  border-radius: 10px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font-family: var(--vp-font-family-base);
  font-size: 0.92rem;
  transition: border-color 0.16s ease;
}

.live-search-input:focus-visible {
  outline: 2px solid #f59e0b;
  outline-offset: 1px;
  border-color: #f59e0b;
}

.live-search-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.live-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 0.38rem;
}

.preset-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.32rem;
  padding: 0.28rem 0.58rem;
  border-radius: 999px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-2);
  font-family: var(--vp-font-family-mono);
  font-size: 0.71rem;
  font-weight: 600;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    color 0.15s ease,
    background-color 0.15s ease;
}

.preset-chip small {
  font-size: 0.64rem;
  color: var(--vp-c-text-3);
}

.preset-chip:hover {
  border-color: #f59e0b;
  color: var(--vp-c-text-1);
}

.preset-chip.active {
  border-color: #f59e0b;
  background: rgba(245, 158, 11, 0.14);
  color: #b45309;
}

:global(.dark) .preset-chip.active {
  color: #fbbf24;
}

.fuzzy-toggle-btn {
  padding: 0.28rem 0.65rem;
  border-radius: 8px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-2);
  font-family: var(--vp-font-family-mono);
  font-size: 0.7rem;
  font-weight: 700;
  cursor: pointer;
}

.fuzzy-label-short {
  display: none;
}

.fuzzy-toggle-btn.active {
  border-color: rgba(16, 185, 129, 0.45);
  background: rgba(16, 185, 129, 0.12);
  color: var(--webdb-badge-green-text);
}

.live-search-status-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-family: var(--vp-font-family-mono);
  font-size: 0.72rem;
  color: var(--vp-c-text-3);
}

.live-timing-pill {
  padding: 0.14rem 0.5rem;
  border-radius: 999px;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
}

.live-search-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.live-search-item {
  padding: 0.82rem 0.95rem;
  border-radius: 10px;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.live-hit-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.5rem;
}

.live-hit-title {
  font-size: 0.92rem;
  font-weight: 700;
  color: var(--vp-c-text-1);
  margin: 0;
  line-height: 1.35;
}

.live-hit-cat {
  font-family: var(--vp-font-family-mono);
  font-size: 0.64rem;
  font-weight: 700;
  padding: 0.14rem 0.48rem;
  border-radius: 999px;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  color: var(--vp-c-text-2);
  white-space: nowrap;
}

.live-hit-snippet {
  font-size: 0.81rem;
  line-height: 1.48;
  color: var(--vp-c-text-2);
  margin: 0;
}

.live-hit-title :deep(mark),
.live-hit-snippet :deep(mark) {
  background: rgba(245, 158, 11, 0.28);
  color: inherit;
  padding: 0.04rem 0.2rem;
  border-radius: 4px;
  font-weight: 700;
}

:global(.dark) .live-hit-title :deep(mark),
:global(.dark) .live-hit-snippet :deep(mark) {
  background: rgba(251, 191, 36, 0.28);
  color: #fef3c7;
}

.live-search-empty {
  padding: 1rem;
  border-radius: 10px;
  background: var(--vp-c-bg);
  border: 1px dashed var(--vp-c-divider);
  font-size: 0.84rem;
  color: var(--vp-c-text-2);
  text-align: center;
}

/* LIVE UDF OUTPUT PREVIEW */
.udf-controls-row {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  justify-content: space-between;
}

.udf-control-group {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.udf-control-label {
  font-family: var(--vp-font-family-mono);
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--vp-c-text-3);
}

.udf-preview-table {
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
}

.udf-preview-head,
.udf-preview-row {
  display: grid;
  grid-template-columns: 1.3fr 0.7fr 1fr;
  gap: 0.5rem;
  align-items: center;
  padding: 0.58rem 0.85rem;
  font-size: 0.8rem;
}

.udf-preview-head {
  background: var(--vp-c-bg-mute);
  font-family: var(--vp-font-family-mono);
  font-size: 0.68rem;
  font-weight: 700;
  color: var(--vp-c-text-3);
  border-bottom: 1px solid var(--vp-c-divider);
}

.udf-preview-row + .udf-preview-row {
  border-top: 1px solid var(--vp-c-divider);
}

.udf-prod-name {
  font-weight: 600;
  color: var(--vp-c-text-1);
}

.udf-prod-orig {
  font-family: var(--vp-font-family-mono);
  font-size: 0.76rem;
  color: var(--vp-c-text-3);
  text-decoration: line-through;
}

.udf-prod-deal {
  font-family: var(--vp-font-family-mono);
  font-size: 0.82rem;
  font-weight: 800;
  color: var(--webdb-badge-green-text);
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

.bench-mobile-cta {
  display: none;
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

.cmp-cell {
  display: inline-flex;
  align-items: flex-start;
  gap: 0.55rem;
}

.cmp-icon {
  width: 19px;
  height: 19px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.68rem;
  font-weight: 800;
  flex-shrink: 0;
  margin-top: 0.12rem;
}

.cmp-good {
  color: #059669;
  background: rgba(16, 185, 129, 0.16);
}

:global(.dark) .cmp-good {
  color: #34d399;
}

.cmp-bad {
  color: #dc2626;
  background: rgba(239, 68, 68, 0.14);
}

:global(.dark) .cmp-bad {
  color: #f87171;
}

.cmp-warn {
  color: #d97706;
  background: rgba(245, 158, 11, 0.16);
}

:global(.dark) .cmp-warn {
  color: #fbbf24;
}

.cmp-neutral {
  color: var(--vp-c-text-3);
  background: var(--vp-c-bg-mute);
}

/* ============================================================================
   7. LIVE DEMOS STRIP, TOOLS SHOWCASE & CLOSING CTA BANNER
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
  padding: 1.35rem;
  border-radius: 14px;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  text-decoration: none;
  color: var(--vp-c-text-1);
  transition:
    border-color 0.2s ease,
    box-shadow 0.2s ease,
    transform 0.2s ease;
}

.demo-preview-card:hover {
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 10px 26px rgba(15, 23, 42, 0.06);
}

@media (prefers-reduced-motion: no-preference) {
  .demo-preview-card:hover {
    transform: translateY(-2px);
  }
}

.demo-thumb {
  height: 76px;
  border-radius: 10px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  margin-bottom: 1rem;
  padding: 0.65rem 0.75rem;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

/* Mini Two-Tabs Thumbnail */
.thumb-tabs {
  gap: 0.45rem;
  background: radial-gradient(
    circle at 50% 50%,
    rgba(16, 185, 129, 0.1),
    var(--vp-c-bg) 75%
  );
}

.mini-win {
  flex: 1;
  height: 100%;
  border-radius: 6px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  padding: 0.35rem 0.4rem;
  display: flex;
  flex-direction: column;
  gap: 0.28rem;
}

.mini-win-bar {
  height: 5px;
  width: 55%;
  border-radius: 999px;
  background: rgba(56, 189, 248, 0.55);
}

.bar-emerald {
  background: rgba(16, 185, 129, 0.7);
}

.mini-win-line {
  height: 4px;
  border-radius: 999px;
  background: var(--vp-c-divider);
}

.w-70 {
  width: 72%;
}
.w-50 {
  width: 52%;
}

.mini-sync-beam {
  font-size: 0.85rem;
  font-weight: 800;
  color: #10b981;
}

/* Mini Kanban Thumbnail */
.thumb-kanban {
  gap: 0.45rem;
  align-items: stretch;
  background: radial-gradient(
    circle at 50% 20%,
    rgba(14, 165, 233, 0.1),
    var(--vp-c-bg) 75%
  );
}

.mini-kcol {
  flex: 1;
  border-radius: 6px;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  padding: 0.3rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.mini-kcard {
  height: 12px;
  border-radius: 4px;
  background: var(--vp-c-divider);
}

.kcard-active {
  background: rgba(14, 165, 233, 0.42);
  border: 1px solid rgba(14, 165, 233, 0.65);
}

.kcard-done {
  background: rgba(16, 185, 129, 0.3);
}

/* Mini Search Thumbnail */
.thumb-search {
  flex-direction: column;
  align-items: stretch;
  justify-content: space-between;
  gap: 0.25rem;
  background: radial-gradient(
    circle at 50% 0%,
    rgba(245, 158, 11, 0.1),
    var(--vp-c-bg) 78%
  );
}

.mini-sbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.16rem 0.45rem;
  border-radius: 5px;
  border: 1px solid rgba(245, 158, 11, 0.45);
  background: var(--vp-c-bg-soft);
  font-family: var(--vp-font-family-mono);
  font-size: 0.62rem;
  color: var(--vp-c-text-1);
}

.mini-smatch {
  color: #10b981;
  font-weight: 700;
}

.mini-srow {
  font-size: 0.66rem;
  color: var(--vp-c-text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mini-smark {
  background: rgba(245, 158, 11, 0.25);
  color: var(--vp-c-text-1);
  padding: 0 0.15rem;
  border-radius: 3px;
  font-weight: 700;
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
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-bottom: 1rem;
}

.tool-pill {
  font-family: var(--vp-font-family-mono);
  font-size: 0.68rem;
  font-weight: 700;
  white-space: nowrap;
  flex-shrink: 0;
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

/* CLOSING CTA BANNER */
.closing-cta-banner {
  position: relative;
  overflow: hidden;
  margin-top: 3rem;
  padding: 3.25rem 2rem;
  border-radius: 20px;
  border: 1px solid color-mix(in srgb, var(--vp-c-brand-1) 32%, var(--vp-c-divider));
  background:
    radial-gradient(
      ellipse 70% 80% at 20% 0%,
      rgba(37, 99, 235, 0.14),
      transparent 70%
    ),
    radial-gradient(
      ellipse 65% 80% at 85% 100%,
      rgba(16, 185, 129, 0.14),
      transparent 70%
    ),
    var(--vp-c-bg-soft);
  text-align: center;
}

.closing-cta-grid {
  position: absolute;
  inset: 0;
  background-image: radial-gradient(
    color-mix(in srgb, var(--vp-c-text-1) 12%, transparent) 1px,
    transparent 1px
  );
  background-size: 22px 22px;
  mask-image: radial-gradient(ellipse 75% 75% at 50% 50%, black 20%, transparent 85%);
  -webkit-mask-image: radial-gradient(ellipse 75% 75% at 50% 50%, black 20%, transparent 85%);
  pointer-events: none;
}

.closing-cta-inner {
  position: relative;
  z-index: 1;
  max-width: 640px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.closing-cta-title {
  font-size: clamp(1.45rem, 1.2rem + 1vw, 2rem);
  font-weight: 800;
  letter-spacing: -0.7px;
  line-height: 1.2;
  text-wrap: balance;
  color: var(--vp-c-text-1);
  margin: 0 0 0.75rem;
}

.closing-cta-subtitle {
  font-size: 1.02rem;
  line-height: 1.6;
  color: var(--vp-c-text-2);
  margin: 0 0 1.75rem;
}

.closing-cta-actions {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 0.9rem;
  margin-bottom: 1.25rem;
}

.closing-install-pill {
  background: var(--vp-c-bg);
}

/* ============================================================================
   RESPONSIVE BREAKPOINTS
   ============================================================================ */
@media (max-width: 1100px) {
  .hero-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 1024px) {
  .hero-split {
    grid-template-columns: minmax(0, 1fr);
    gap: 2.25rem;
  }
  .hero-copy {
    align-items: center;
    text-align: center;
  }
  .hero-eyebrow,
  .hero-actions,
  .hero-install-wrap {
    justify-content: center;
  }
  .hero-lead {
    margin-inline: auto;
  }
  .hero-visual-stage {
    max-width: 600px;
    width: 100%;
    margin: 0 auto;
  }
}

@media (max-width: 960px) {
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
  .split-feature-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .split-title {
    font-size: 1.65rem;
  }
  .feature-explorer {
    grid-template-columns: minmax(0, 1fr);
    gap: 1rem;
  }
  .feature-tablist {
    flex-direction: row;
    overflow-x: auto;
    gap: 0.5rem;
    padding-block-end: 0.35rem;
    scroll-snap-type: inline proximity;
    scroll-padding-inline: 2.5rem;
    scrollbar-width: none;
    --fade-size: 2.5rem;
    --fade-dir: right;
    --fade-start-pos: 0;
    --fade-end-pos: 100%;
    mask:
      linear-gradient(black, black) no-clip subtract,
      linear-gradient(to var(--fade-dir), black, transparent) var(--fade-start-pos) 0 / var(--webdb-fade-start) 100% no-repeat no-clip,
      linear-gradient(to var(--fade-dir), transparent, black) var(--fade-end-pos) 0 / var(--webdb-fade-end) 100% no-repeat no-clip;
    animation: reveal-fade-start linear both, hide-fade-end linear both;
    animation-timeline: scroll(self inline);
    animation-range: 0 var(--fade-size), calc(100% - var(--fade-size)) 100%;
  }
  .feature-tablist:dir(rtl) {
    --fade-dir: left;
    --fade-start-pos: 100%;
    --fade-end-pos: 0;
  }
  .feature-tablist::-webkit-scrollbar {
    display: none;
  }
  .feature-tab {
    flex: none;
    width: auto;
    align-items: center;
    gap: 0.5rem;
    padding: 0.55rem 0.85rem;
    scroll-snap-align: start;
    border: 1px solid var(--vp-c-divider);
    background: var(--vp-c-bg-soft);
  }
  .feature-tab-icon {
    width: 26px;
    height: 26px;
    border-radius: 7px;
  }
  .feature-tab-icon svg {
    width: 15px;
    height: 15px;
  }
  .feature-tab-title-full {
    display: none;
  }
  .feature-tab-title-short {
    display: inline;
    white-space: nowrap;
    font-size: 0.86rem;
  }
  .feature-tab-teaser {
    display: none;
  }
  .feature-tab[aria-selected="true"] {
    border-color: var(--feature-accent);
    background: color-mix(in srgb, var(--feature-accent) 11%, var(--vp-c-bg));
    box-shadow: 0 2px 10px color-mix(in srgb, var(--feature-accent) 14%, transparent);
  }
  .feature-tab[aria-selected="true"]::after {
    display: none;
  }
  .demos-strip {
    grid-template-columns: minmax(0, 1fr);
  }
  .tools-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

@keyframes reveal-fade-start {
  to {
    --webdb-fade-start: var(--fade-size);
  }
}

@keyframes hide-fade-end {
  from {
    --webdb-fade-end: var(--fade-size);
  }
}

@media (max-width: 768px) {
  .hero-section {
    padding: 2.5rem 0 5rem;
  }
  .hero-split {
    margin-bottom: 0;
  }
  .hero-eyebrow {
    flex-wrap: nowrap;
    white-space: nowrap;
    font-size: 0.68rem;
    padding: 0.34rem 0.78rem;
    max-width: 100%;
  }
  .hero-eyebrow .eyebrow-sep,
  .hero-eyebrow .eyebrow-text {
    display: none;
  }
  .hero-visual-stage,
  .hero-install-wrap {
    display: none;
  }
  .hero-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.75rem;
    margin-top: 2rem;
  }
  .metric-card {
    padding: 0.95rem 0.9rem;
  }
  .metric-head-row {
    margin-bottom: 0.5rem;
  }
  .metric-pill,
  .metric-desc {
    display: none;
  }
  .metric-val {
    font-size: 1.18rem;
    margin-bottom: 0.2rem;
  }
  .metric-label {
    font-size: 0.8rem;
    margin-bottom: 0;
  }

  .section-block {
    margin-bottom: 6.25rem;
  }
  .section-header-center {
    margin-bottom: 2.25rem;
  }
  .section-subtitle {
    font-size: 0.94rem;
    line-height: 1.55;
  }

  .terminal-dots,
  .terminal-copy,
  .line-num {
    display: none;
  }
  .terminal-header {
    padding: 0.55rem 0.75rem;
    gap: 0.5rem;
  }
  .terminal-tabs {
    flex-wrap: nowrap;
    overflow-x: auto;
    scrollbar-width: none;
    min-width: 0;
    -webkit-overflow-scrolling: touch;
  }
  .terminal-tabs::-webkit-scrollbar {
    display: none;
  }
  .ttab {
    flex-shrink: 0;
    white-space: nowrap;
    padding: 0.35rem 0.65rem;
    font-size: 0.74rem;
  }
  .terminal-body {
    padding: 0.95rem 0.85rem;
    font-size: 0.76rem;
    line-height: 1.6;
  }

  .fw-selector-bar {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.55rem;
  }
  .fw-selector-card {
    padding: 0.65rem 0.75rem;
    border-radius: 12px;
  }
  .fw-selector-top {
    margin-bottom: 0;
  }
  .fw-brand-group {
    gap: 0.55rem;
  }
  .fw-logo-box {
    width: 30px;
    height: 30px;
    border-radius: 8px;
  }
  .fw-logo-box svg {
    width: 18px;
    height: 18px;
  }
  .fw-selector-name {
    font-size: 0.88rem;
  }
  .fw-selector-pkg,
  .fw-selector-size,
  .live-highlights-grid {
    display: none;
  }

  .stage-widget {
    display: none;
  }
  .feature-stage-card {
    padding: 1.25rem;
  }
  .stage-header {
    margin-bottom: 1rem;
  }
  .stage-desc {
    font-size: 0.92rem;
  }

  .search-section .split-code-col .terminal-window {
    display: none;
  }
  .live-search-card {
    padding: 1.1rem;
  }
  .live-card-topbar {
    flex-wrap: wrap;
    gap: 0.45rem;
  }
  .live-search-controls {
    flex-wrap: nowrap;
    gap: 0.45rem;
  }
  .live-presets {
    flex-wrap: nowrap;
    overflow-x: auto;
    scrollbar-width: none;
    min-width: 0;
    gap: 0.3rem;
  }
  .live-presets::-webkit-scrollbar {
    display: none;
  }
  .preset-chip {
    flex-shrink: 0;
    white-space: nowrap;
    padding: 0.25rem 0.55rem;
  }
  .preset-chip small,
  .preset-chip:nth-child(n + 4) {
    display: none;
  }
  .fuzzy-toggle-btn {
    flex-shrink: 0;
    white-space: nowrap;
    padding: 0.25rem 0.58rem;
  }
  .fuzzy-label-full {
    display: none;
  }
  .fuzzy-label-short {
    display: inline;
  }

  .live-udf-card {
    display: none;
  }

  .bench-table-wrap {
    display: none;
  }
  .bench-mobile-cta {
    display: flex;
    justify-content: center;
    margin-top: 1.15rem;
  }
  .bench-mobile-cta .btn {
    width: 100%;
    justify-content: center;
  }

  .compare-section {
    display: none;
  }

  .demo-thumb,
  .tool-sub {
    display: none;
  }
  .demo-preview-card,
  .tool-card {
    padding: 1.25rem;
  }
  .closing-cta-banner {
    margin-top: 4.5rem;
  }
  .closing-install-pill {
    display: none;
  }
  .closing-cta-actions {
    margin-bottom: 0;
  }
}

@media (max-width: 640px) {
  .webdb-landing {
    padding: 0 0 4rem;
  }
  .hero-inner,
  .landing-content {
    padding-inline: 1rem;
  }
  .hero-actions {
    flex-direction: column;
    width: 100%;
  }
  .hero-actions .btn {
    width: 100%;
    justify-content: center;
  }
  .fw-guide-row,
  .split-actions,
  .closing-cta-actions {
    flex-direction: column;
    width: 100%;
  }
  .fw-guide-row .btn,
  .split-actions .btn,
  .closing-cta-actions .btn {
    width: 100%;
    justify-content: center;
  }
  .closing-cta-banner {
    padding: 2.25rem 1.25rem;
  }
}
</style>

<style>
@property --webdb-fade-start {
  syntax: "<length>";
  inherits: false;
  initial-value: 0px;
}

@property --webdb-fade-end {
  syntax: "<length>";
  inherits: false;
  initial-value: 0px;
}

@property --hero-torch-inner {
  syntax: "<length-percentage>";
  inherits: true;
  initial-value: 0px;
}

@property --hero-torch-outer {
  syntax: "<length-percentage>";
  inherits: true;
  initial-value: 0px;
}
</style>
