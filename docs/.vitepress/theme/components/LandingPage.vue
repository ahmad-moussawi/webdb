<script setup lang="ts">
import { ref, computed } from "vue";
import { withBase } from "vitepress";

type CodeTab = "query" | "tx" | "http" | "explain";
const activeTab = ref<CodeTab>("query");

const codeSnippets: Record<CodeTab, string> = {
  query: `// 1. Define relational schema with typed binary columns & B+Tree indexes
await db.createTable("orders", [
  { name: "id", type: "UUID", primaryKey: true }, // Packed into 16 raw bytes
  { name: "customer_id", type: "UUID", notNull: true },
  { name: "status", type: "TEXT", notNull: true },
  { name: "total", type: "FLOAT64", notNull: true },
]);
await db.createIndex("orders", ["status", "total"]);

// 2. Fluent relational query with JOINs, aggregates & subqueries
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

  tx: `// Crash-proof ACID transactions with WAL, Nested Savepoints & Outbox Hooks
await db.transaction(async (tx) => {
  await tx.insert("orders", {
    id: crypto.randomUUID(),
    customer_id: "018d3e2a-1b4c-7000-8000-123456789abc",
    status: "paid",
    total: 249.0,
  });

  // Nested transactions act as savepoints — rolling back an inner block
  // restores state without aborting the outer transaction!
  await tx
    .transaction(async (savepoint) => {
      await savepoint.update("orders", { total: 9999.0 });
      throw new Error("Revert inner savepoint only");
    })
    .catch(() => {});
});`,

  http: `// Stream a multi-GB database on S3 / Cloudflare R2 via 4KB HTTP Range Requests
import { WebDB, HttpVfsAdapter } from "@ahmadmoussawi/webdb";

const db = await WebDB.open({
  vfs: new HttpVfsAdapter("https://cdn.example.com/catalog.webdb"),
});

// Traverses B+Tree index pages over HTTP Range: bytes=X-Y
// Fetches only ~16 KB over the wire — zero full-file download!
const products = await db
  .from("products")
  .where("category", "=", "Electronics")
  .where("in_stock", "=", 1)
  .orderBy("rating", "desc")
  .limit(10)
  .toArray();`,

  explain: `// Inspect the Cost-Based Query Plan & VDBE Binary Bytecode Disassembly
const explain = await db
  .from("orders")
  .where("status", "=", "paid")
  .where("total", ">", 100)
  .explain();

console.log(explain.assembly);
/*
ADDR  OPCODE            P1   P2   P3   COMMENT
0000  OP_INIT            0    0    0   Initialize VDBE execution context
0001  OP_INDEX_SCAN      0    2    0   Seek composite B+Tree idx_orders_status_total
0002  OP_NEXT_INDEX      0    7    0   Advance index cursor
0003  OP_COLUMN          0    3    1   Read column 'total' -> r[1]
0004  OP_GT              1  100    2   Filter: r[1] > 100.0
0005  OP_RESULT_ROW      0    4    0   Emit projected row to output buffer
0006  OP_HALT            0    0    0   Complete execution (bytecodeSize: 88 bytes)
*/`,
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
    size: "Built-in",
    file: "live-query.ts",
  },
};

const frameworkSnippets: Record<FrameworkTab, string> = {
  react: `import { useLiveQuery } from "@ahmadmoussawi/webdb/react";

export function OrderDashboard({ status }: { status: string }) {
  // Automatically tracks 'orders' AND joined 'customers' table!
  // Re-renders on local writes or commits from another browser tab.
  const { data: orders, isLoading, error } = useLiveQuery(
    () =>
      db
        .from("orders")
        .join("customers", "orders.customer_id", "=", "customers.id")
        .where("orders.status", "=", status)
        .orderBy("orders.id", "desc"),
    [status],
    { initialData: [] }
  );

  if (isLoading) return <p>Loading live orders...</p>;
  return <OrderTable rows={orders} />;
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
<\/script>`,

  angular: `import { Component, signal } from "@angular/core";
import { injectWebDB, liveQuerySignal, liveQuery$ } from "@ahmadmoussawi/webdb/angular";

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
}`,

  vanilla: `import { WebDB } from "@ahmadmoussawi/webdb";

// 1. Chain .live() directly onto any QueryBuilder
const sub = db
  .from("orders")
  .where("status", "=", "paid")
  .orderBy("id", "desc")
  .live((rows) => renderOrders(rows));

// 2. Or consume live updates via standard Async Iteration (for await...of)
for await (const rows of db.from("orders").where("status", "=", "paid").live()) {
  renderOrders(rows);
}`,
};

function highlightCode(code: string, tab: string): string {
  let html = code
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  if (tab === "explain") {
    html = html.replace(
      /\/\*[\s\S]*?\*\//g,
      (m) => `<span class="hl-comment">${m}</span>`,
    );
    html = html.replace(/\b(OP_[A-Z_]+)\b/g, `<span class="hl-op">$1</span>`);
    html = html.replace(/^([0-9]{4})\b/gm, `<span class="hl-addr">$1</span>`);
    html = html.replace(/\b(r\[\d+\])\b/g, `<span class="hl-reg">$1</span>`);
    html = html.replace(
      /\/\/.*/g,
      (m) => `<span class="hl-comment">${m}</span>`,
    );
    return html;
  }

  const comments: string[] = [];
  html = html.replace(/\/\/.*/g, (m) => {
    comments.push(`<span class="hl-comment">${m}</span>`);
    return `___COMMENT_${comments.length - 1}___`;
  });

  html = html.replace(
    /(&quot;.*?&quot;|'.*?'|`[\s\S]*?`)/g,
    `<span class="hl-str">$1</span>`,
  );

  html = html.replace(
    /\b(await|async|const|let|var|function|return|true|false|null|import|from|new|export|class|implements|for|of|if|throw|private)\b/g,
    `<span class="hl-kw">$1</span>`,
  );

  html = html.replace(
    /\b(UUID|ULID|TEXT|INT32|INT64|FLOAT64|BLOB|WebDB|HttpVfsAdapter|Promise|Uint8Array|Error|string|number|boolean)\b/g,
    `<span class="hl-type">$1</span>`,
  );

  html = html.replace(/\b(\d+(\.\d+)?)\b/g, `<span class="hl-num">$1</span>`);

  html = html.replace(
    /\b(createTable|createIndex|from|where|whereNotNull|orderBy|limit|toArray|transaction|insert|update|explain|open|useLiveQuery|useLiveQueryData|liveQuerySignal|liveQuery\$|liveQuery|live|join|select|sum|count|groupBy|having|ref|signal|injectWebDB|useWebDB|provideWebDB|randomUUID|catch)\b(?=\()/g,
    `<span class="hl-fn">$1</span>`,
  );

  html = html.replace(
    /___COMMENT_(\d+)___/g,
    (_, idx) => comments[Number(idx)],
  );

  return html;
}

const renderedLines = computed(() =>
  highlightCode(codeSnippets[activeTab.value], activeTab.value).split("\n"),
);

const renderedFrameworkLines = computed(() =>
  highlightCode(
    frameworkSnippets[activeFrameworkTab.value],
    activeFrameworkTab.value,
  ).split("\n"),
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

const installCopied = ref(false);
const copyInstallCmd = () => {
  navigator.clipboard.writeText("npm install @ahmadmoussawi/webdb@alpha");
  installCopied.value = true;
  setTimeout(() => (installCopied.value = false), 2000);
};
</script>

<template>
  <div class="webdb-landing">
    <!-- ======================================================================
         1. HERO SECTION — FOCUSED, HIGH-CONTRAST, 2 CTAs ONLY
         ====================================================================== -->
    <header class="hero-section">
      <div class="hero-glow" aria-hidden="true"></div>

      <div class="hero-eyebrow">
        <span class="status-dot"></span>
        <span class="eyebrow-tag">~13 KB WASM ENGINE</span>
        <span class="eyebrow-sep">•</span>
        <span class="eyebrow-text">ACID + WAL</span>
        <span class="eyebrow-sep">•</span>
        <span class="eyebrow-text">React, Vue &amp; Angular Live Queries</span>
      </div>

      <h1 class="hero-title">
        SQLite-Grade Relational Power.<br />
        <span class="hero-gradient">Built Native for the Browser.</span>
      </h1>

      <p class="hero-lead">
        Powered by a <strong>~13 KB WebAssembly core</strong> (&lt;100 KB total
        bundle) with B+Tree indexes, joins, crash-proof ACID transactions, and
        reactive multi-tab <strong>Live Queries</strong> over OPFS &amp;
        IndexedDB—with zero <code>COOP/COEP</code> server headers.
      </p>

      <!-- ONLY 2 HERO CTA BUTTONS: PLAYGROUND & DOCS -->
      <div class="hero-actions">
        <a
          :href="withBase('/playground/')"
          target="_self"
          class="btn btn-primary"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="currentColor"
          >
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
          <span>Launch Studio IDE</span>
          <span class="btn-arrow">→</span>
        </a>

        <a :href="withBase('/getting-started')" class="btn btn-secondary">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
            <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
          </svg>
          <span>Read Documentation</span>
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
          <code>npm install @ahmadmoussawi/webdb@alpha</code>
          <span class="install-copy-badge">
            {{ installCopied ? "Copied ✓" : "Copy" }}
          </span>
        </button>
      </div>

      <!-- 4 HIGH-SIGNAL ENGINEERING METRICS -->
      <div class="hero-metrics">
        <div class="metric-card">
          <span class="metric-pill pill-emerald">WASM CORE</span>
          <div class="metric-val">~13 KB</div>
          <div class="metric-label">Featherweight Binary</div>
          <div class="metric-desc">
            95% smaller than desktop SQLite &amp; PGlite Wasm ports
          </div>
        </div>

        <div class="metric-card">
          <span class="metric-pill pill-cyan">LIVE SUBPATHS</span>
          <div class="metric-val">&lt; 1 KB</div>
          <div class="metric-label">Reactive Live Queries</div>
          <div class="metric-desc">
            Auto-tracked hooks for React, Vue 3, Angular &amp; Plain JS
          </div>
        </div>

        <div class="metric-card">
          <span class="metric-pill pill-violet">ASYNC VFS</span>
          <div class="metric-val">OPFS + IDB</div>
          <div class="metric-label">Universal Storage</div>
          <div class="metric-desc">
            Non-blocking 4KB page faults + S3 HTTP Range streaming
          </div>
        </div>

        <div class="metric-card">
          <span class="metric-pill pill-amber">STATIC READY</span>
          <div class="metric-val">0 Headers</div>
          <div class="metric-label">Zero Server Config</div>
          <div class="metric-desc">
            Works everywhere without COOP/COEP isolation headers
          </div>
        </div>
      </div>
    </header>

    <!-- ======================================================================
         2. INTERACTIVE ENGINE & DIRECT-TO-BYTECODE SHOWCASE
         ====================================================================== -->
    <section class="section-block">
      <div class="section-header-center">
        <span class="section-eyebrow">ENGINE ARCHITECTURE</span>
        <h2 class="section-title">
          Fluent TypeScript Queries ➔ Direct VDBE Bytecode
        </h2>
        <p class="section-subtitle">
          Ported desktop databases serialize queries into SQL text strings only
          to re-parse them inside a multi-megabyte C parser. WebDB compiles
          fluent TypeScript directly into compact binary opcodes—delivering a
          full relational engine with a <strong>~13 KB Wasm core</strong> (&lt;100
          KB total bundle).
        </p>
      </div>

      <!-- DUAL-TRACK EXECUTION PIPELINE COMPARISON (NO CLICK REQUIRED) -->
      <div class="pipeline-card">
        <div class="pipeline-bar">
          <span class="pipeline-bar-label">
            ARCHITECTURE COMPARISON: HOW QUERIES REACH THE ENGINE
          </span>
          <span class="pipeline-bar-hint">
            2 middle stages completely eliminated in WebDB
          </span>
        </div>

        <!-- TRACK 1: LEGACY WASM PORTS -->
        <div class="pipeline-track track-legacy">
          <div class="track-header">
            <div class="track-title-group">
              <span class="dot dot-red"></span>
              <span class="track-name">Legacy Wasm Ports</span>
              <span class="track-sub">(SQLite / PGlite Wasm)</span>
            </div>
            <span class="track-badge badge-red-soft">
              1 MB – 5 MB+ Bundle • 4 Stages
            </span>
          </div>

          <div class="track-grid">
            <div class="pipe-node node-muted">
              <div class="node-top">
                <span class="node-step">STAGE 01</span>
              </div>
              <div class="node-title">JS Query / ORM</div>
              <code class="node-code">Builds SQL text query</code>
            </div>

            <div class="pipe-node node-eliminated">
              <div class="node-top">
                <span class="node-step">STAGE 02</span>
                <span class="node-Status-pill pill-eliminated">ELIMINATED</span>
              </div>
              <div class="node-title">SQL String Serialization</div>
              <code class="node-code">String concat &amp; escaping</code>
            </div>

            <div class="pipe-node node-eliminated">
              <div class="node-top">
                <span class="node-step">STAGE 03</span>
                <span class="node-Status-pill pill-eliminated">
                  +1.5 MB BLOAT
                </span>
              </div>
              <div class="node-title">C SQL Lexer &amp; AST Parser</div>
              <code class="node-code">Re-tokenizes &amp; parses text</code>
            </div>

            <div class="pipe-node node-muted">
              <div class="node-top">
                <span class="node-step">STAGE 04</span>
              </div>
              <div class="node-title">Wasm Execution</div>
              <code class="node-code">+ Asyncify stack unwinding</code>
            </div>
          </div>
        </div>

        <!-- TRACK 2: WEBDB DIRECT-TO-BYTECODE -->
        <div class="pipeline-track track-webdb">
          <div class="track-header">
            <div class="track-title-group">
              <span class="dot dot-green"></span>
              <span class="track-name">WebDB Direct-to-Bytecode</span>
              <span class="track-sub">(Browser-Native Engine)</span>
            </div>
            <span class="track-badge badge-green-soft">
              ~13 KB Wasm Core • &lt; 100 KB Bundle • 2 Stages
            </span>
          </div>

          <div class="track-grid">
            <div class="pipe-node node-green">
              <div class="node-top">
                <span class="node-step step-green">STAGE 01</span>
              </div>
              <div class="node-title">Fluent Query Builder</div>
              <code class="node-code">db.from("orders").where(...)</code>
            </div>

            <!-- EXPRESS BYPASS SPANNING COLUMNS 2 & 3 -->
            <div class="pipe-bypass">
              <div class="bypass-rail">
                <div class="bypass-line">
                  <span class="bypass-pulse"></span>
                </div>
                <div class="bypass-pill">
                  ⚡ DIRECT COMPILER — SKIPS SQL STRING &amp; C PARSER ENTIRELY
                </div>
              </div>
              <div class="bypass-caption">
                Emits binary opcodes directly from TypeScript AST in &lt; 0.05ms
              </div>
            </div>

            <div class="pipe-node node-green">
              <div class="node-top">
                <span class="node-step step-green">STAGE 02</span>
              </div>
              <div class="node-title">VDBE Binary Bytecode</div>
              <code class="node-code">OP_INDEX_SCAN ➔ OP_RESULT_ROW</code>
            </div>
          </div>
        </div>
      </div>

      <!-- INTERACTIVE CODE SHOWCASE TERMINAL -->
      <div class="terminal-window">
        <div class="terminal-header">
          <div class="terminal-dots" aria-hidden="true">
            <span class="tdot tdot-red"></span>
            <span class="tdot tdot-amber"></span>
            <span class="tdot tdot-green"></span>
          </div>
          <div class="terminal-tabs">
            <button
              :class="['ttab', { active: activeTab === 'query' }]"
              @click="activeTab = 'query'"
            >
              joins-and-aggregates.ts
            </button>
            <button
              :class="['ttab', { active: activeTab === 'tx' }]"
              @click="activeTab = 'tx'"
            >
              acid-savepoints.ts
            </button>
            <button
              :class="['ttab', { active: activeTab === 'http' }]"
              @click="activeTab = 'http'"
            >
              s3-http-range.ts
            </button>
            <button
              :class="['ttab', { active: activeTab === 'explain' }]"
              @click="activeTab = 'explain'"
            >
              bytecode-explain.ts
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
         3. REACTIVE LIVE QUERIES & FRAMEWORK INTEGRATIONS (SELLER POINT)
         ====================================================================== -->
    <section class="section-block live-section">
      <div class="section-header-center">
        <span class="section-eyebrow eyebrow-emerald">
          ZERO-BLOAT FRAMEWORK INTEGRATIONS
        </span>
        <h2 class="section-title">
          Reactive Live Queries for React, Vue, Angular &amp; JS
        </h2>
        <p class="section-subtitle">
          Stop wiring manual event buses around database writes. WebDB
          automatically tracks every table accessed by your query—including
          <code>JOIN</code>s and nested subqueries—and pushes instant updates
          across components and open browser tabs.
        </p>
      </div>

      <!-- FULL-WIDTH STACKED LAYOUT: 4 FRAMEWORK CARDS -> CODE -> 3 PILLARS -->
      <div class="live-showcase-stack">
        <!-- 4-COLUMN FRAMEWORK SELECTOR BAR -->
        <div class="fw-selector-bar">
          <button
            v-for="fw in (['react', 'vue', 'angular', 'vanilla'] as FrameworkTab[])"
            :key="fw"
            :class="[
              'fw-selector-card',
              { active: activeFrameworkTab === fw },
            ]"
            @click="activeFrameworkTab = fw"
          >
            <div class="fw-selector-top">
              <span class="fw-selector-name">{{
                frameworkMeta[fw].label
              }}</span>
              <span class="fw-selector-size">{{
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
            <div class="lh-badge">AUTO-TRACKED AST</div>
            <h4 class="lh-title">Smart Table &amp; JOIN Tracking</h4>
            <p class="lh-desc">
              Inspects base tables, <code>JOIN</code>s, and subqueries
              automatically—only re-executing when relevant tables mutate.
            </p>
          </div>

          <div class="live-highlight-card">
            <div class="lh-badge">MULTI-TAB SYNC</div>
            <h4 class="lh-title">Cross-Tab &amp; Worker Reactivity</h4>
            <p class="lh-desc">
              Commits in another browser tab or Web Worker broadcast via
              <code>BroadcastChannel</code> and update your UI in real time.
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
          <a
            :href="withBase('/guides/live-queries-and-frameworks')"
            class="btn btn-secondary"
          >
            <span>Explore Live Queries &amp; Framework Guide</span>
            <span class="btn-arrow">→</span>
          </a>
        </div>
      </div>
    </section>

    <!-- ======================================================================
         4. MODERN BENTO GRID: BUILT FOR THE WEB PLATFORM
         ====================================================================== -->
    <section class="section-block">
      <div class="section-header-center">
        <span class="section-eyebrow">WEB-FIRST CAPABILITIES</span>
        <h2 class="section-title">
          Everything You Need for Local-First Web Apps
        </h2>
        <p class="section-subtitle">
          Engineered from the ground up around browser storage primitives,
          asynchronous I/O, and compact 4 KB slotted pages.
        </p>
      </div>

      <div class="bento-grid">
        <!-- BENTO 1 (WIDE): PLUGGABLE ASYNC VFS & HTTP RANGE STREAMING -->
        <div class="bento-card bento-wide">
          <div class="bento-tag tag-cyan">ASYNC VIRTUAL FILE SYSTEM</div>
          <h3 class="bento-title">
            OPFS, IndexedDB, In-Memory &amp; S3 HTTP Range Streaming
          </h3>
          <p class="bento-desc">
            Unlike desktop C ports that rely on Emscripten’s slow
            <code>Asyncify</code> stack rewriting, WebDB suspends cleanly on
            4 KB page faults. Persist data in high-speed
            <strong>OPFS</strong> or <strong>IndexedDB</strong>, or query
            multi-gigabyte read-only databases hosted on S3/CDN via
            <code>Range: bytes=X-Y</code> requests without downloading the file.
          </p>
          <div class="bento-pills">
            <span class="bento-chip">OPFS SyncAccessHandle</span>
            <span class="bento-chip">IndexedDB Fallback</span>
            <span class="bento-chip">HttpVfsAdapter (4KB Range)</span>
            <span class="bento-chip">Custom IVfsAdapter</span>
          </div>
        </div>

        <!-- BENTO 2 (WIDE): CRASH-PROOF WAL & MULTI-TAB CONCURRENCY -->
        <div class="bento-card bento-wide">
          <div class="bento-tag tag-emerald">ACID &amp; OFFLINE SYNC</div>
          <h3 class="bento-title">
            Crash-Proof WAL, Web Locks &amp; Coalesced Outbox Sync
          </h3>
          <p class="bento-desc">
            Write-Ahead Logging with IEEE 802.3 CRC32 checksums on every 4 KB
            page guarantees zero corruption across sudden tab closes. Multi-tab
            readers and writers coordinate automatically via
            <code>navigator.locks</code>, while <code>onBeforeCommit</code> and
            <code>changeset.coalesced()</code> make bidirectional offline sync
            effortless.
          </p>
          <div class="bento-pills">
            <span class="bento-chip">CRC32 Page Checksums</span>
            <span class="bento-chip">Nested Savepoints</span>
            <span class="bento-chip">Web Locks Coordination</span>
            <span class="bento-chip">changeset.coalesced()</span>
          </div>
        </div>

        <!-- BENTO 3: BINARY UUIDv7 & ULID -->
        <div class="bento-card">
          <div class="bento-tag tag-violet">COMPACT STORAGE</div>
          <h3 class="bento-title">16-Byte Binary UUIDv7 &amp; ULID</h3>
          <p class="bento-desc">
            Packs UUIDs and ULIDs into 16 raw bytes (58% smaller than 36-char
            text strings) for sequential, zero-fragmentation B+Tree index
            inserts.
          </p>
        </div>

        <!-- BENTO 4: QUERY PLANNER & EXPLAIN -->
        <div class="bento-card">
          <div class="bento-tag tag-amber">COST-BASED PLANNER</div>
          <h3 class="bento-title">Composite B+Trees &amp; .explain()</h3>
          <p class="bento-desc">
            Up to 8-column composite indexes, index-assisted sorting, hash/nested
            joins, and full VDBE bytecode disassembly via
            <code>.explain()</code>.
          </p>
        </div>

        <!-- BENTO 5: ZERO-OVERHEAD JS UDFs -->
        <div class="bento-card">
          <div class="bento-tag tag-rose">WEB PLATFORM NATIVE</div>
          <h3 class="bento-title">Native Browser JS Functions (UDFs)</h3>
          <p class="bento-desc">
            Instead of bundling heavy C ICU/regex libraries into Wasm, register
            custom JS functions using native <code>Intl</code>,
            <code>RegExp</code>, and <code>crypto</code>.
          </p>
        </div>

        <!-- BENTO 6: BINARY SNAPSHOTS (.webdb.gz) -->
        <div class="bento-card">
          <div class="bento-tag tag-indigo">INSTANT COLD START</div>
          <h3 class="bento-title">Compressed Snapshots (.webdb.gz)</h3>
          <p class="bento-desc">
            Export and restore full indexed databases as <code>Uint8Array</code>
            or compressed <code>.webdb.gz</code> images in milliseconds—or share
            live databases via Studio URLs.
          </p>
        </div>
      </div>
    </section>

    <!-- ======================================================================
         5. 3-WAY COMPARISON TABLE
         ====================================================================== -->
    <section class="section-block">
      <div class="section-header-center">
        <span class="section-eyebrow">ARCHITECTURAL COMPARISON</span>
        <h2 class="section-title">How WebDB Compares</h2>
        <p class="section-subtitle">
          Purpose-built to give you the relational power of SQLite with the tiny
          footprint and zero-config ergonomics of native browser APIs.
        </p>
      </div>

      <div class="compare-table-wrap">
        <table class="compare-table">
          <thead>
            <tr>
              <th>Capability</th>
              <th>Raw IndexedDB / Wrappers</th>
              <th>Ported Desktop Wasm (SQLite / PGlite)</th>
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
              <td class="td-feature">Bundle Footprint</td>
              <td class="td-neutral">~15–40 KB (No SQL engine)</td>
              <td class="td-bad">1 MB – 5 MB+ Wasm binary</td>
              <td class="td-good">
                <strong>~13 KB Wasm Core</strong> (&lt;100 KB total bundle)
              </td>
            </tr>
            <tr>
              <td class="td-feature">Relational Joins &amp; Subqueries</td>
              <td class="td-bad">Manual JS loops &amp; cursor merges</td>
              <td class="td-neutral">Full SQL text parser</td>
              <td class="td-good">
                <strong>Direct-to-Bytecode</strong> JOINs, GROUP BY &amp;
                Subqueries
              </td>
            </tr>
            <tr>
              <td class="td-feature">Reactive UI Hooks</td>
              <td class="td-neutral">Basic table-level polling/hooks</td>
              <td class="td-bad">DIY wrappers / manual invalidation</td>
              <td class="td-good">
                <strong>&lt;1 KB Subpaths</strong> for React, Vue, Angular &amp;
                JS with auto-JOIN tracking
              </td>
            </tr>
            <tr>
              <td class="td-feature">Server Isolation Headers</td>
              <td class="td-neutral">None required</td>
              <td class="td-bad">
                Requires <code>COOP/COEP</code> for SharedArrayBuffer
              </td>
              <td class="td-good">
                <strong>Zero Headers</strong> — runs on any static host or CDN
              </td>
            </tr>
            <tr>
              <td class="td-feature">Async Storage &amp; S3 Streaming</td>
              <td class="td-bad">IndexedDB only</td>
              <td class="td-warn">Emscripten Asyncify shims</td>
              <td class="td-good">
                <strong>Native Async VFS</strong> (OPFS, IDB, Memory, HTTP
                Range)
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ======================================================================
         6. INTERACTIVE BROWSER SUITE (STUDIO IDE & LIVE BENCHMARKS)
         ====================================================================== -->
    <section class="section-block">
      <div class="tools-grid">
        <!-- STUDIO IDE -->
        <div class="tool-card tool-card-primary">
          <div class="tool-badge-row">
            <span class="tool-pill pill-brand">IN-BROWSER DATABASE IDE</span>
            <span class="tool-sub">Supports .webdb.gz &amp; Remote URLs</span>
          </div>
          <h3 class="tool-title">WebDB Studio Playground</h3>
          <p class="tool-desc">
            Write and execute queries in Monaco Editor, inspect binary 4 KB
            slotted pages in real time, visualize B+Tree structures, and open
            remote <code>.webdb.gz</code> databases directly via shareable URLs.
          </p>
          <div class="tool-actions">
            <a
              :href="withBase('/playground/')"
              target="_self"
              class="btn btn-primary"
            >
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
            Measure real-time ops/sec throughput, latency percentiles, and memory
            footprint against Raw JS Arrays, Native IndexedDB, and official
            SQLite WASM directly in your browser.
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
  padding: 3.25rem 1rem 4.5rem;
  max-width: 980px;
  margin: 0 auto;
}

.hero-glow {
  position: absolute;
  top: -40px;
  left: 50%;
  transform: translateX(-50%);
  width: 680px;
  height: 320px;
  background: radial-gradient(
    ellipse at center,
    rgba(37, 99, 235, 0.14) 0%,
    rgba(16, 185, 129, 0.06) 45%,
    transparent 75%
  );
  pointer-events: none;
  z-index: 0;
  filter: blur(24px);
}

:global(.dark) .hero-glow {
  background: radial-gradient(
    ellipse at center,
    rgba(56, 189, 248, 0.16) 0%,
    rgba(16, 185, 129, 0.08) 45%,
    transparent 75%
  );
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
  max-width: 740px;
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
  color: #ffffff;
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 4px 16px rgba(37, 99, 235, 0.25);
}

:global(.dark) .btn-primary {
  color: #090d16;
  box-shadow: 0 4px 18px rgba(56, 189, 248, 0.22);
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
  margin-bottom: 3.5rem;
}

.install-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.65rem;
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

.install-copy-badge {
  font-size: 0.7rem;
  font-weight: 700;
  padding: 0.2rem 0.6rem;
  border-radius: 999px;
  background: var(--vp-c-bg-mute);
  color: var(--vp-c-text-2);
  border: 1px solid var(--vp-c-divider);
}

/* 4 METRICS STRIP */
.hero-metrics {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
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
  font-size: 1.55rem;
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

/* ============================================================================
   2. DUAL-TRACK PIPELINE COMPARISON & CODE TERMINAL
   ============================================================================ */
.pipeline-card {
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  border-radius: 16px;
  padding: 1.5rem 1.75rem;
  margin-bottom: 1.75rem;
  display: flex;
  flex-direction: column;
  gap: 1.15rem;
}

.pipeline-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.75rem;
  padding-bottom: 0.25rem;
}

.pipeline-bar-label {
  font-family: var(--vp-font-family-mono);
  font-size: 0.74rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--vp-c-text-2);
}

.pipeline-bar-hint {
  font-family: var(--vp-font-family-mono);
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--vp-c-text-3);
}

.pipeline-track {
  border-radius: 12px;
  padding: 1.1rem 1.25rem;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
}

.track-legacy {
  background: rgba(239, 68, 68, 0.025);
  border-color: rgba(239, 68, 68, 0.22);
}

.track-webdb {
  background: rgba(16, 185, 129, 0.035);
  border-color: rgba(16, 185, 129, 0.38);
  box-shadow: 0 6px 24px rgba(16, 185, 129, 0.06);
}

.track-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-bottom: 0.9rem;
}

.track-title-group {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.track-name {
  font-size: 0.92rem;
  font-weight: 700;
  color: var(--vp-c-text-1);
}

.track-sub {
  font-size: 0.8rem;
  color: var(--vp-c-text-3);
}

.track-badge {
  font-family: var(--vp-font-family-mono);
  font-size: 0.7rem;
  font-weight: 700;
  padding: 0.22rem 0.65rem;
  border-radius: 999px;
}

.badge-red-soft {
  color: #dc2626;
  background: rgba(239, 68, 68, 0.12);
}

:global(.dark) .badge-red-soft {
  color: #f87171;
}

.badge-green-soft {
  color: #059669;
  background: rgba(16, 185, 129, 0.14);
}

:global(.dark) .badge-green-soft {
  color: #34d399;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.dot-green {
  background: #10b981;
  box-shadow: 0 0 8px rgba(16, 185, 129, 0.6);
}

.dot-red {
  background: #ef4444;
}

.track-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.75rem;
  align-items: stretch;
}

.pipe-node {
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  padding: 0.85rem 1rem;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  min-width: 0;
}

.node-muted {
  opacity: 0.85;
}

.node-eliminated {
  background: rgba(239, 68, 68, 0.05);
  border: 1px dashed rgba(239, 68, 68, 0.45);
  position: relative;
}

.node-eliminated .node-title {
  text-decoration: line-through;
  text-decoration-color: rgba(239, 68, 68, 0.6);
  color: var(--vp-c-text-2);
}

.node-green {
  background: var(--vp-c-bg);
  border: 1.5px solid rgba(16, 185, 129, 0.5);
  box-shadow: 0 2px 10px rgba(16, 185, 129, 0.07);
}

.node-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.4rem;
  margin-bottom: 0.25rem;
}

.node-step {
  font-family: var(--vp-font-family-mono);
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--vp-c-text-3);
}

.step-green {
  color: #10b981;
}

.node-Status-pill {
  font-family: var(--vp-font-family-mono);
  font-size: 0.6rem;
  font-weight: 800;
  padding: 0.1rem 0.42rem;
  border-radius: 4px;
  letter-spacing: 0.03em;
  white-space: nowrap;
}

.pill-eliminated {
  color: #dc2626;
  background: rgba(239, 68, 68, 0.14);
}

:global(.dark) .pill-eliminated {
  color: #f87171;
}

.node-title {
  font-size: 0.9rem;
  font-weight: 700;
  color: var(--vp-c-text-1);
  margin: 0.1rem 0 0.3rem;
  line-height: 1.3;
}

.node-code {
  font-family: var(--vp-font-family-mono);
  font-size: 0.72rem;
  color: var(--vp-c-text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* EXPRESS BYPASS (SPANS MIDDLE 2 COLUMNS IN WEBDB TRACK) */
.pipe-bypass {
  grid-column: span 2;
  border-radius: 10px;
  border: 1px dashed rgba(16, 185, 129, 0.45);
  background: linear-gradient(
    90deg,
    rgba(16, 185, 129, 0.08) 0%,
    rgba(56, 189, 248, 0.08) 100%
  );
  padding: 0.85rem 1.25rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.45rem;
  position: relative;
}

.bypass-rail {
  width: 100%;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}

.bypass-line {
  position: absolute;
  left: 0;
  right: 0;
  height: 2px;
  background: linear-gradient(90deg, #10b981, #38bdf8, #10b981);
  overflow: hidden;
}

.bypass-pulse {
  position: absolute;
  top: 0;
  left: -30%;
  width: 30%;
  height: 100%;
  background: linear-gradient(
    90deg,
    transparent,
    rgba(255, 255, 255, 0.9),
    transparent
  );
  animation: bypassPulse 2.2s infinite linear;
}

@keyframes bypassPulse {
  0% {
    left: -30%;
  }
  100% {
    left: 100%;
  }
}

.bypass-pill {
  position: relative;
  z-index: 1;
  font-family: var(--vp-font-family-mono);
  font-size: 0.68rem;
  font-weight: 800;
  letter-spacing: 0.04em;
  color: #047857;
  background: var(--vp-c-bg);
  border: 1px solid rgba(16, 185, 129, 0.45);
  padding: 0.28rem 0.75rem;
  border-radius: 999px;
  text-align: center;
  box-shadow: 0 2px 8px rgba(16, 185, 129, 0.12);
}

:global(.dark) .bypass-pill {
  color: #34d399;
}

.bypass-caption {
  font-size: 0.74rem;
  color: var(--vp-c-text-2);
  text-align: center;
}

/* TERMINAL WINDOW — LIGHT THEME DEFAULT, SOFT SLATE IN DARK MODE */
.terminal-window {
  width: 100%;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
  border-radius: 14px;
  overflow: hidden;
  border: 1px solid #e2e8f0;
  background: #f8fafc;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.06);
}

:global(.dark) .terminal-window {
  border-color: #263248;
  background: #141c2b;
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.28);
}

.terminal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.65rem 1rem;
  background: #f1f5f9;
  border-bottom: 1px solid #e2e8f0;
}

:global(.dark) .terminal-header {
  background: #1a2436;
  border-bottom-color: #263248;
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
  color: #475569;
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 0.15s ease;
}

:global(.dark) .ttab {
  color: #94a3b8;
}

.ttab:hover {
  color: #0f172a;
}

:global(.dark) .ttab:hover {
  color: #f1f5f9;
}

.ttab.active {
  color: #2563eb;
  background: #ffffff;
  border-color: #cbd5e1;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.05);
}

:global(.dark) .ttab.active {
  color: #38bdf8;
  background: rgba(56, 189, 248, 0.12);
  border-color: rgba(56, 189, 248, 0.28);
}

.terminal-copy {
  font-family: var(--vp-font-family-mono);
  font-size: 0.72rem;
  font-weight: 700;
  color: #334155;
  background: #ffffff;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  padding: 0.3rem 0.7rem;
  cursor: pointer;
  transition: all 0.15s ease;
}

:global(.dark) .terminal-copy {
  color: #cbd5e1;
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(255, 255, 255, 0.14);
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
  color: #1e293b;
}

:global(.dark) .terminal-body {
  color: #e2e8f0;
}

.code-line {
  display: flex;
  white-space: pre;
}

.line-num {
  width: 2.2rem;
  flex-shrink: 0;
  color: #94a3b8;
  user-select: none;
  text-align: right;
  padding-right: 1rem;
}

:global(.dark) .line-num {
  color: #64748b;
}

/* Light-mode syntax highlighting */
.line-content :deep(.hl-comment) {
  color: #64748b;
  font-style: italic;
}
.line-content :deep(.hl-str) {
  color: #059669;
}
.line-content :deep(.hl-kw) {
  color: #7c3aed;
  font-weight: 600;
}
.line-content :deep(.hl-type) {
  color: #0284c7;
  font-weight: 600;
}
.line-content :deep(.hl-num) {
  color: #d97706;
}
.line-content :deep(.hl-fn) {
  color: #2563eb;
}
.line-content :deep(.hl-op) {
  color: #db2777;
  font-weight: 700;
}
.line-content :deep(.hl-addr) {
  color: #64748b;
}

/* Dark-mode syntax highlighting */
:global(.dark) .line-content :deep(.hl-comment) {
  color: #94a3b8;
}
:global(.dark) .line-content :deep(.hl-str) {
  color: #34d399;
}
:global(.dark) .line-content :deep(.hl-kw) {
  color: #c084fc;
}
:global(.dark) .line-content :deep(.hl-type) {
  color: #38bdf8;
}
:global(.dark) .line-content :deep(.hl-num) {
  color: #fbbf24;
}
:global(.dark) .line-content :deep(.hl-fn) {
  color: #60a5fa;
}
:global(.dark) .line-content :deep(.hl-op) {
  color: #f472b6;
}
:global(.dark) .line-content :deep(.hl-addr) {
  color: #94a3b8;
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
  grid-template-columns: repeat(4, 1fr);
  gap: 0.85rem;
}

.fw-selector-card {
  text-align: left;
  padding: 0.95rem 1.05rem;
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  cursor: pointer;
  transition: all 0.16s ease;
  min-width: 0;
}

.fw-selector-card:hover {
  border-color: var(--vp-c-brand-1);
  transform: translateY(-1px);
}

.fw-selector-card.active {
  border-color: #10b981;
  background: rgba(16, 185, 129, 0.08);
  box-shadow: 0 4px 14px rgba(16, 185, 129, 0.1);
}

.fw-selector-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.35rem;
}

.fw-selector-name {
  font-size: 0.95rem;
  font-weight: 800;
  color: var(--vp-c-text-1);
}

.fw-selector-size {
  font-family: var(--vp-font-family-mono);
  font-size: 0.68rem;
  font-weight: 700;
  color: #059669;
  background: rgba(16, 185, 129, 0.12);
  padding: 0.12rem 0.45rem;
  border-radius: 999px;
}

:global(.dark) .fw-selector-size {
  color: #34d399;
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
  gap: 0.6rem;
}

.fw-file-name {
  font-family: var(--vp-font-family-mono);
  font-size: 0.78rem;
  font-weight: 700;
  color: #1e293b;
}

:global(.dark) .fw-file-name {
  color: #e2e8f0;
}

.fw-badge-pill {
  font-family: var(--vp-font-family-mono);
  font-size: 0.66rem;
  font-weight: 700;
  color: #059669;
  background: rgba(16, 185, 129, 0.14);
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
}

:global(.dark) .fw-badge-pill {
  color: #34d399;
}

.live-highlights-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
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
  color: #059669;
  background: rgba(16, 185, 129, 0.12);
  padding: 0.16rem 0.5rem;
  border-radius: 999px;
  margin-bottom: 0.6rem;
}

:global(.dark) .lh-badge {
  color: #34d399;
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
  margin-top: 0.35rem;
}

/* ============================================================================
   4. BENTO GRID
   ============================================================================ */
.bento-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1.15rem;
}

.bento-card {
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
   5. COMPARISON TABLE
   ============================================================================ */
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
  color: #ffffff;
}

:global(.dark) .webdb-th-badge {
  color: #090d16;
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
   6. TOOLS SHOWCASE
   ============================================================================ */
.tools-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
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
@media (max-width: 960px) {
  .hero-title {
    font-size: 2.65rem;
  }
  .hero-metrics {
    grid-template-columns: repeat(2, 1fr);
  }
  .fw-selector-bar {
    grid-template-columns: repeat(2, 1fr);
  }
  .live-highlights-grid {
    grid-template-columns: 1fr;
  }
  .bento-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  .track-grid {
    grid-template-columns: 1fr;
  }
  .pipe-bypass {
    grid-column: span 1;
  }
  .tools-grid {
    grid-template-columns: 1fr;
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
  .hero-metrics {
    grid-template-columns: 1fr;
  }
  .bento-grid {
    grid-template-columns: 1fr;
  }
  .bento-wide {
    grid-column: span 1;
  }
  .fw-selector-bar {
    grid-template-columns: 1fr;
  }
}
</style>
