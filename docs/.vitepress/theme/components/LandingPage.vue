<script setup lang="ts">
import { ref, computed } from "vue";
import { withBase } from "vitepress";

const activeTab = ref<"query" | "http" | "tx" | "explain">("query");
const pipelineMode = ref<"other" | "webdb">("other");

const codeSnippets: Record<"query" | "http" | "tx" | "explain", string> = {
  query: `// 1. Define relational schema with typed columns & indexes
await db.createTable("users", [
  { name: "id", type: "UUID", flags: { primaryKey: true } },
  { name: "name", type: "TEXT", flags: { notNull: true } },
  { name: "age", type: "INT32" },
  { name: "score", type: "FLOAT64" },
]);

await db.createIndex("users", "score");

// 2. Query with type-safe fluent builder
const topScorers = await db
  .from("users")
  .where("age", ">=", 21)
  .whereNotNull("score")
  .orderBy("score", "desc")
  .limit(10)
  .toArray();

console.table(topScorers);`,

  http: `// Remote Page Streaming via HTTP Range Requests
import { WebDB, HttpVfsAdapter } from "@webdb/core";

// 1. Mount a remote database directly on CDN, S3, or Cloudflare R2
const db = await WebDB.open({
  vfs: new HttpVfsAdapter(
    "https://cdn.example.com/datasets/ecommerce.webdb",
    {
      cacheSize: 64, // Keep 64 hot pages in memory (256 KB)
      maxConcurrentRequests: 4,
    }
  ),
});

// 2. Traverses B+Tree indexes via targeted 4KB range requests
// Zero need to download the full multi-GB database!
const products = await db
  .from("products")
  .where("category", "=", "Electronics")
  .where("in_stock", "=", true)
  .orderBy("rating", "desc")
  .limit(10)
  .toArray();

console.table(products);`,

  tx: `// Crash-proof ACID transactions with automatic rollback
await db.transaction(async (tx) => {
  await tx.insert("users", {
    id: crypto.randomUUID(), // Automatically packed into 16 bytes
    name: "Charlie",
    age: 34,
    score: 88.0,
  });
  await tx
    .update("users", { score: 99.0 })
    .where("id", "=", "018d3e2a-1b4c-7000-8000-123456789abc");
  // Commits atomically on exit; auto-rollback on error
});`,

  explain: `// Transparent query execution plan inspection
const plan = await db.from("users").where("score", ">", 80.0).explain();
console.log(plan.assembly);

/*
ADDR  OPCODE          P1   P2   P3   COMMENT
0000  OP_INIT          0    0    0   Start execution context
0001  OP_CURSOR_OPEN   0    2    0   Scan table 'users' with index
0002  OP_NEXT_ROW      0    6    0   Advance cursor
0003  OP_COLUMN        0    3    1   Load 'score' into register
0004  OP_GT            1   80    2   Filter: score > 80.0
0005  OP_EMIT_ROW      0    0    0   Emit matched row
0006  OP_HALT          0    0    0   Complete query
*/`,
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

  // Hide comments temporarily
  const comments: string[] = [];
  html = html.replace(/\/\/.*/g, (m) => {
    comments.push(`<span class="hl-comment">${m}</span>`);
    return `___COMMENT_${comments.length - 1}___`;
  });

  // Strings
  html = html.replace(
    /(&quot;.*?&quot;|'.*?'|`.*?`)/g,
    `<span class="hl-str">$1</span>`,
  );

  // Keywords
  html = html.replace(
    /\b(await|async|const|let|var|function|return|true|false|null|import|from|new|export|class|implements)\b/g,
    `<span class="hl-kw">$1</span>`,
  );

  // Column / Value Types
  html = html.replace(
    /\b(UUID|ULID|TEXT|INT32|FLOAT64|VECTOR|BLOB|WebDB|HttpVfsAdapter|VfsAdapter|CloudflareKvVfs|Promise|Uint8Array|number|void|string|boolean)\b/g,
    `<span class="hl-type">$1</span>`,
  );

  // Numbers
  html = html.replace(/\b(\d+(\.\d+)?)\b/g, `<span class="hl-num">$1</span>`);

  // Method Names
  html = html.replace(
    /\b(createTable|createIndex|from|where|whereNotNull|orderBy|limit|toArray|transaction|insert|update|explain|open|readPage|writePage|get|put)\b(?=\()/g,
    `<span class="hl-fn">$1</span>`,
  );

  // Restore comments
  html = html.replace(
    /___COMMENT_(\d+)___/g,
    (_, idx) => comments[Number(idx)],
  );

  return html;
}

const renderedLines = computed(() => {
  const highlighted = highlightCode(
    codeSnippets[activeTab.value],
    activeTab.value,
  );
  return highlighted.split("\n");
});

const customVfsSnippet = `export class CloudflareKvVfs implements VfsAdapter {
  async readPage(id: number) {
    const key = "p" + id;
    return await kv.get(key);
  }
  async writePage(id: number, buf: Uint8Array) {
    const key = "p" + id;
    await kv.put(key, buf);
  }
}`;

const highlightedCustomVfs = computed(() => {
  return highlightCode(customVfsSnippet, "ts");
});

const httpVfsSnippet = `import { WebDB, HttpVfsAdapter } from "@webdb/core";

const httpStorage = new HttpVfsAdapter(
  "https://example.com/ecommerce.db"
);

// 1. Mount remote db hosted on CDN / S3 / R2
const db = await WebDB.open({
  vfs: httpStorage,
});

// 2. Instant response: 
// only ~16Kb are transferred over the wire.
const products = await db
  .from("products")
  .where("category", "=", "Electronics")
  .where("in_stock", "=", true)
  .orderBy("rating", "desc")
  .limit(10)
  .toArray();

console.table(products);`;

const httpSnippetLines = computed(() => {
  return highlightCode(httpVfsSnippet, "http").split("\n");
});

const copyStatus = ref(false);
const copyCode = () => {
  navigator.clipboard.writeText(codeSnippets[activeTab.value]);
  copyStatus.value = true;
  setTimeout(() => (copyStatus.value = false), 2000);
};
</script>

<template>
  <div class="webdb-landing">
    <!-- HERO SECTION (OPEN & SPACIOUS) -->
    <header class="hero-section">
      <div class="hero-eyebrow">
        <img
          :src="withBase('/logo.svg')"
          alt="WebDB Logo"
          width="20"
          height="20"
          class="eyebrow-logo"
        />
        <span class="eyebrow-brand">WebDB</span>
        <span class="eyebrow-sep">/</span>
        <span class="eyebrow-status">
          <span class="status-dot"></span>
          Early Prototype
        </span>
      </div>

      <h1 class="hero-title">
        The Browser-Native<br />
        <span class="hero-accent">Relational Database</span>
      </h1>

      <p class="hero-lead">
        An ultra-lean &lt;50 KB WebAssembly engine with true SQL power,
        type-safe queries, and instant persistence over OPFS &amp; IndexedDB.
        Zero server roundtrips, no complex headers.
      </p>

      <div class="hero-actions">
        <a :href="withBase('/plans/plan')" class="btn btn-primary">
          <span>View Specs</span>
          <span class="btn-arrow">→</span>
        </a>
        <a
          href="https://github.com/ahmad-moussawi/webdb"
          target="_blank"
          rel="noopener"
          class="btn btn-secondary"
        >
          <span>GitHub</span>
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
            class="star-icon"
          >
            <polygon
              points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"
            />
          </svg>
        </a>
      </div>

      <!-- HERO STATS BAR (VIBRANT & DISTINCT) -->
      <div class="hero-stats">
        <!-- STAT 1: WASM SIZE / ULTRA LIGHTWEIGHT -->
        <div class="stat-card">
          <div class="stat-card-top">
            <div class="stat-icon-box">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.75"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z" />
                <line x1="16" y1="8" x2="2" y2="22" />
                <line x1="17.5" y1="15" x2="9" y2="15" />
              </svg>
            </div>
          </div>
          <div class="stat-val">&lt; 50 KB</div>
          <div class="stat-label">Ultra lightweight</div>
          <div class="stat-desc">90%+ smaller than SQLite Wasm</div>
        </div>

        <!-- STAT 2: ASYNC VFS / STORAGE -->
        <div class="stat-card">
          <div class="stat-card-top">
            <div class="stat-icon-box">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.75"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <ellipse cx="12" cy="5" rx="9" ry="3" />
                <path d="M3 5v14a9 3 0 0 0 18 0V5" />
                <path d="M3 12a9 3 0 0 0 18 0" />
              </svg>
            </div>
          </div>
          <div class="stat-val">OPFS + IDB</div>
          <div class="stat-label">Universal Storage</div>
          <div class="stat-desc">
            Fast OPFS in Workers, seamless Safari fallback
          </div>
        </div>

        <!-- STAT 3: ZERO ALLOCS / PERFORMANCE -->
        <div class="stat-card">
          <div class="stat-card-top">
            <div class="stat-icon-box">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.75"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="m12 14 4-4" />
                <path d="M3.34 19a10 10 0 1 1 17.32 0" />
              </svg>
            </div>
          </div>
          <div class="stat-val">60 FPS</div>
          <div class="stat-label">Non-Blocking UI</div>
          <div class="stat-desc">
            Zero UI stutter with async event-loop execution
          </div>
        </div>

        <!-- STAT 4: NATIVE / STANDARDS -->
        <div class="stat-card">
          <div class="stat-card-top">
            <div class="stat-icon-box">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.75"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
                <path d="M2 12h20" />
              </svg>
            </div>
          </div>
          <div class="stat-val">Zero Config</div>
          <div class="stat-label">Cross-Browser Ready</div>
          <div class="stat-desc">No COOP/COEP headers required anywhere</div>
        </div>
      </div>
    </header>

    <!-- SECTION 2: TARGET WORKLOADS & REAL-WORLD USAGE -->
    <section class="section-box">
      <h2 class="section-heading">Built for the Modern Browser Experience</h2>
      <p class="section-sub">
        WebDB bridges the gap between fragile key-value stores and heavyweight
        desktop Wasm ports. Here is where it excels in production web
        applications:
      </p>

      <div class="usecases-grid">
        <!-- CELL 1: OFFLINE-FIRST -->
        <div class="usecase-cell usecase-theme-emerald">
          <div class="usecase-cell-header">
            <div class="usecase-icon-box">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="square"
                stroke-linejoin="miter"
              >
                <line x1="1" y1="1" x2="23" y2="23" />
                <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
                <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
                <path d="M10.71 5.05A16 16 0 0 1 22.56 9" />
                <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
                <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
                <line x1="12" y1="20" x2="12.01" y2="20" />
              </svg>
            </div>
            <span class="usecase-num">01</span>
          </div>
          <h3 class="usecase-title">Offline-First Web Apps &amp; PWAs</h3>
          <p class="usecase-text">
            Eliminate spinners and network stalls. Render instantly from local
            storage, mutate data offline with full ACID safety, and seamlessly
            synchronize changes when reconnected.
          </p>
        </div>

        <!-- CELL 2: LOCAL-FIRST -->
        <div class="usecase-cell usecase-theme-cyan">
          <div class="usecase-cell-header">
            <div class="usecase-icon-box">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="square"
                stroke-linejoin="miter"
              >
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            </div>
            <span class="usecase-num">02</span>
          </div>
          <h3 class="usecase-title">Local-First Productivity &amp; SaaS</h3>
          <p class="usecase-text">
            Build Notion, Linear, or Figma-grade creative suites where user
            documents reside directly in the client. Multi-tab concurrency is
            safely coordinated via Web Locks without server trips.
          </p>
        </div>

        <!-- CELL 3: BROWSER AI -->
        <div class="usecase-cell usecase-theme-violet">
          <div class="usecase-cell-header">
            <div class="usecase-icon-box">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="square"
                stroke-linejoin="miter"
              >
                <path d="M12 2v4" />
                <path d="M12 18v4" />
                <path d="M4.93 4.93l2.83 2.83" />
                <path d="M16.24 16.24l2.83 2.83" />
                <path d="M2 12h4" />
                <path d="M18 12h4" />
                <path d="M4.93 19.07l2.83-2.83" />
                <path d="M16.24 7.76l2.83-2.83" />
              </svg>
            </div>
            <span class="usecase-num">03</span>
          </div>
          <h3 class="usecase-title">Client-Side AI &amp; Vector Search</h3>
          <p class="usecase-text">
            Store high-dimensional vector embeddings generated by WebLLM or
            Transformers.js. Perform instant similarity searches with 128-bit
            Wasm SIMD directly in the browser for local RAG.
          </p>
        </div>

        <!-- CELL 4: CDN STREAMING -->
        <div class="usecase-cell usecase-theme-amber">
          <div class="usecase-cell-header">
            <div class="usecase-icon-box">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="square"
                stroke-linejoin="miter"
              >
                <path
                  d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"
                />
                <path d="M12 12v9" />
                <path d="m8 17 4 4 4-4" />
              </svg>
            </div>
            <span class="usecase-num">04</span>
          </div>
          <h3 class="usecase-title">
            Query Remote Data Without Full Downloads
          </h3>
          <p class="usecase-text">
            Host multi-gigabyte catalogs or archives on S3 or Cloudflare R2.
            Query precise records on demand via HTTP Range requests without
            downloading the entire database.
          </p>
        </div>

        <!-- CELL 5: PRIVACY-FIRST -->
        <div class="usecase-cell usecase-theme-rose">
          <div class="usecase-cell-header">
            <div class="usecase-icon-box">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="square"
                stroke-linejoin="miter"
              >
                <rect width="18" height="11" x="3" y="11" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </div>
            <span class="usecase-num">05</span>
          </div>
          <h3 class="usecase-title">Privacy-Centric Personal Vaults</h3>
          <p class="usecase-text">
            Healthcare portals, password managers, financial ledgers, and
            journaling apps where customer data must never touch your backend
            unencrypted. The database lives and dies on the client device.
          </p>
        </div>

        <!-- CELL 6: EDGE ANALYTICS -->
        <div class="usecase-cell usecase-theme-indigo">
          <div class="usecase-cell-header">
            <div class="usecase-icon-box">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="square"
                stroke-linejoin="miter"
              >
                <line x1="18" y1="20" x2="18" y2="10" />
                <line x1="12" y1="20" x2="12" y2="4" />
                <line x1="6" y1="20" x2="6" y2="14" />
              </svg>
            </div>
            <span class="usecase-num">06</span>
          </div>
          <h3 class="usecase-title">In-Browser Analytics &amp; Dashboards</h3>
          <p class="usecase-text">
            Offload complex multi-table aggregations, filtering, and joins from
            your API servers directly into the user's browser. Transform raw
            CSVs or JSON payloads into relational tables on the fly.
          </p>
        </div>
      </div>
    </section>

    <!-- SECTION 3: THE DIRECT SHORTCUT (EDITORIAL & CLEAN) -->
    <section class="section-box arch-shortcut-section">
      <h2 class="section-heading">
        A powerful &lt;50 KB database without sacrificing features
      </h2>
      <p class="section-sub">
        Most in-browser databases bloat past several megabytes by dragging along
        legacy C parsers and desktop OS shims. By rethinking the query pipeline
        specifically for modern TypeScript, we eliminated the dead weight
        without cutting relational power.
      </p>

      <!-- INTERACTIVE BOX DRAWING DIAGRAM -->
      <div class="boxdraw-container">
        <!-- MODE TOGGLE BUTTONS (CENTERED) -->
        <div class="boxdraw-header">
          <div class="boxdraw-toggle">
            <button
              :class="[
                'boxdraw-toggle-btn',
                { 'active-other': pipelineMode === 'other' },
              ]"
              @click="pipelineMode = 'other'"
            >
              <span class="toggle-dot dot-red"></span>
              Existing
            </button>
            <button
              :class="[
                'boxdraw-toggle-btn',
                { 'active-webdb': pipelineMode === 'webdb' },
              ]"
              @click="pipelineMode = 'webdb'"
            >
              <span class="toggle-dot dot-green"></span>
              WebDB
            </button>
          </div>
        </div>

        <!-- BOX DRAWING FLOW -->
        <div class="boxdraw-board">
          <Transition name="boxdraw-fade" mode="out-in">
            <!-- OTHER SOLUTIONS: 4 BOXES WITH RED SIGNALS -->
            <div
              v-if="pipelineMode === 'other'"
              key="other"
              class="boxdraw-track"
            >
              <div class="boxdraw-box">
                <span class="c-tl">┌</span><span class="c-tr">┐</span>
                <span class="c-bl">└</span><span class="c-br">┘</span>
                <span class="box-text">Fluent Query Builder</span>
              </div>

              <div class="boxdraw-arrow-wrap arrow-red">
                <div class="boxdraw-wire wire-red">
                  <span class="boxdraw-pulse pulse-red pulse-s1"></span>
                </div>
              </div>

              <div class="boxdraw-box box-red-dim">
                <span class="c-tl c-red">┌</span
                ><span class="c-tr c-red">┐</span>
                <span class="c-bl c-red">└</span
                ><span class="c-br c-red">┘</span>
                <span class="box-text">SQL string</span>
              </div>

              <div class="boxdraw-arrow-wrap arrow-red">
                <div class="boxdraw-wire wire-red">
                  <span class="boxdraw-pulse pulse-red pulse-s2"></span>
                </div>
              </div>

              <div class="boxdraw-box box-red-dim">
                <span class="c-tl c-red">┌</span
                ><span class="c-tr c-red">┐</span>
                <span class="c-bl c-red">└</span
                ><span class="c-br c-red">┘</span>
                <span class="box-text">AST tree</span>
              </div>

              <div class="boxdraw-arrow-wrap arrow-red">
                <div class="boxdraw-wire wire-red">
                  <span class="boxdraw-pulse pulse-red pulse-s3"></span>
                </div>
              </div>

              <div class="boxdraw-box">
                <span class="c-tl">┌</span><span class="c-tr">┐</span>
                <span class="c-bl">└</span><span class="c-br">┘</span>
                <span class="box-text">Byte Codes</span>
              </div>
            </div>

            <!-- WEBDB: 2 BOXES CONNECTED DIRECTLY WITH GREEN ACCENT -->
            <div v-else key="webdb" class="boxdraw-track track-direct">
              <div class="boxdraw-box box-active-green">
                <span class="c-tl c-green">┌</span
                ><span class="c-tr c-green">┐</span>
                <span class="c-bl c-green">└</span
                ><span class="c-br c-green">┘</span>
                <span class="box-text">Fluent Query Builder</span>
              </div>

              <div class="boxdraw-arrow-wrap arrow-direct arrow-green">
                <div class="boxdraw-wire wire-green">
                  <span class="boxdraw-pulse pulse-yellow"></span>
                </div>
                <span class="direct-pill pill-green">DIRECT TO BYTECODE</span>
              </div>

              <div class="boxdraw-box box-active-green box-end-green">
                <span class="c-tl c-green">┌</span
                ><span class="c-tr c-green">┐</span>
                <span class="c-bl c-green">└</span
                ><span class="c-br c-green">┘</span>
                <span class="box-text">Byte Codes</span>
              </div>
            </div>
          </Transition>
        </div>

        <!-- CAPTION BELOW THE DRAWING (CENTERED) -->
        <div class="boxdraw-caption-center">
          <Transition name="boxdraw-fade" mode="out-in">
            <div
              v-if="pipelineMode === 'other'"
              key="other-caption"
              class="caption-text"
            >
              <span class="status-indicator status-red"></span>
              <span
                >Redundant string formatting &amp; AST parsing inside Wasm (slow
                + 2.5 MB bundle bloat)</span
              >
            </div>
            <div v-else key="webdb-caption" class="caption-text">
              <span class="status-indicator status-green"></span>
              <span
                >Direct-to-bytecode execution — skips the SQL middleman entirely
                (&lt;50 KB engine)</span
              >
            </div>
          </Transition>
        </div>
      </div>

      <!-- EDITORIAL NARRATIVE -->
      <div class="shortcut-narrative">
        <div class="narrative-block">
          <h3 class="narrative-heading">Skipping the SQL String Middleman</h3>
          <p class="narrative-body">
            In modern web apps, developers rarely write raw SQL strings—we write
            type-safe queries using fluent builders (like Drizzle, Kysely, or
            Prisma) for autocomplete and compile-time validation.
          </p>
          <p class="narrative-body">
            In traditional ported databases, your client library serializes that
            fluent query into a SQL text string, sends it across the WebAssembly
            boundary, and runs a heavyweight C parser to turn it right back into
            an internal syntax tree.
          </p>
          <p class="narrative-body">
            <strong>WebDB eliminates this round-trip completely.</strong> The
            fluent query builder compiles directly into executable bytecode. By
            removing the text SQL parser from the WebAssembly binary, we
            stripped out megabytes of bloat—bringing the entire engine down to
            <strong>under 50 KB</strong> and eliminating runtime parsing
            overhead.
          </p>
        </div>

        <div class="narrative-block">
          <h3 class="narrative-heading">
            Stripping Desktop Threads for Native Web APIs
          </h3>
          <p class="narrative-body">
            Desktop databases like SQLite and PostgreSQL assume multi-core
            operating systems with blocking disk threads. Porting them to the
            browser requires Emscripten pthread shims that demand strict
            <code>COOP</code> (Cross-Origin-Opener-Policy) and
            <code>COEP</code> server headers.
          </p>
          <p class="narrative-body">
            In production web apps, those headers break OAuth login popups,
            Stripe payment frames, and third-party embeds.
          </p>
          <p class="narrative-body">
            <strong>WebDB is single-threaded by design.</strong> It respects the
            browser's event loop and coordinates multi-tab concurrency through
            the native <code>navigator.locks</code> Web API. It runs seamlessly
            on static hosting, CDNs, and PWAs with
            <strong>zero server headers required</strong>.
          </p>
        </div>
      </div>
    </section>

    <!-- SECTION 4: THE PROBLEM VS THE SOLUTION -->
    <section class="section-box">
      <h2 class="section-heading">
        How WebDB Differs from Ported Desktop Engines
      </h2>
      <p class="section-sub">
        Web developers shouldn't have to compromise between the awkward cursors
        of IndexedDB and multi-megabyte C/C++ desktop engines ported with
        Emscripten. WebDB rethinks the relational database engine specifically
        for web platform runtime constraints.
      </p>

      <!-- LIGHT COMPARISON TABLE -->
      <div class="compare-table-wrapper">
        <table class="compare-table">
          <thead>
            <tr>
              <th class="col-feature">Capability</th>
              <th class="col-legacy">
                Ported Desktop Engines (SQLite / PGlite)
              </th>
              <th class="col-webdb">
                <div class="webdb-col-header">
                  <span>WebDB</span>
                  <span class="webdb-header-pill">Web-Native</span>
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="row-feature">
                <div class="feature-title">Binary Size &amp; Cold Startup</div>
                <div class="feature-desc">
                  Load time penalty on initial page visit &amp; mobile networks
                </div>
              </td>
              <td class="cell-legacy">
                <span class="val-bad">1 MB – 5 MB+ Binary</span>
                <span class="val-sub"
                  >Heavy initial download dragging along redundant C parsers,
                  lexers, and desktop OS shims.</span
                >
              </td>
              <td class="cell-webdb">
                <span class="val-good">&lt; 50 KB Bundle</span>
                <span class="val-sub"
                  >Loads in milliseconds on slow mobile networks. Zero bloated
                  desktop parsers in Wasm.</span
                >
              </td>
            </tr>

            <tr>
              <td class="row-feature">
                <div class="feature-title">I/O &amp; UI Threading</div>
                <div class="feature-desc">
                  How asynchronous browser storage interacts with UI frames
                </div>
              </td>
              <td class="cell-legacy">
                <span class="val-warn">Emscripten Asyncify tricks</span>
                <span class="val-sub"
                  >Tries to make async browser storage look synchronous, risking
                  UI frame drops and tab stutter.</span
                >
              </td>
              <td class="cell-webdb">
                <span class="val-good">Native Non-Blocking I/O</span>
                <span class="val-sub"
                  >Built from the ground up for asynchronous browser
                  storage—zero main-thread blocking or stack hacks.</span
                >
              </td>
            </tr>

            <tr>
              <td class="row-feature">
                <div class="feature-title">Server Headers (COOP / COEP)</div>
                <div class="feature-desc">
                  Cross-Origin isolation required for desktop threading shims
                </div>
              </td>
              <td class="cell-legacy">
                <span class="val-bad">Strict headers often required</span>
                <span class="val-sub"
                  >Breaks external OAuth popups, Stripe/payment frames, and
                  embedded cross-origin widgets.</span
                >
              </td>
              <td class="cell-webdb">
                <span class="val-good">Zero Headers Required</span>
                <span class="val-sub"
                  >Runs anywhere out-of-the-box: static hosting, standard CDNs,
                  GitHub Pages, or PWAs without config.</span
                >
              </td>
            </tr>

            <tr>
              <td class="row-feature">
                <div class="feature-title">Web Platform Primitives</div>
                <div class="feature-desc">
                  Delegation to browser-native engines for crypto, dates, regex
                </div>
              </td>
              <td class="cell-legacy">
                <span class="val-warn">Redundant C duplicates</span>
                <span class="val-sub"
                  >Re-implements regex, date arithmetic, and cryptographic
                  algorithms already built into modern browsers.</span
                >
              </td>
              <td class="cell-webdb">
                <span class="val-good">Embraces Web Standards</span>
                <span class="val-sub"
                  >Delegates directly to browser-native <code>Intl</code>,
                  <code>crypto.subtle</code>, <code>Date</code>, and
                  <code>RegExp</code>.</span
                >
              </td>
            </tr>

            <tr>
              <td class="row-feature">
                <div class="feature-title">Remote S3 / CDN Queries</div>
                <div class="feature-desc">
                  Querying large datasets hosted on cloud object storage
                </div>
              </td>
              <td class="cell-legacy">
                <span class="val-bad">Full database download</span>
                <span class="val-sub"
                  >Must transfer the entire multi-gigabyte database file into
                  browser memory before running queries.</span
                >
              </td>
              <td class="cell-webdb">
                <span class="val-good">HTTP Range Streaming</span>
                <span class="val-sub"
                  >Queries 5GB+ datasets by reading B+Tree index pages on-demand
                  over HTTP Range (only ~16 KB wire transfer).</span
                >
              </td>
            </tr>

            <tr>
              <td class="row-feature">
                <div class="feature-title">Memory Management</div>
                <div class="feature-desc">
                  Allocation footprint and browser garbage collection
                </div>
              </td>
              <td class="cell-legacy">
                <span class="val-warn">Heavy upfront linear heap</span>
                <span class="val-sub"
                  >Fixed contiguous Wasm memory page allocations with costly GC
                  memory-copy bridging.</span
                >
              </td>
              <td class="cell-webdb">
                <span class="val-good">Adaptive Page Pool</span>
                <span class="val-sub"
                  >Dynamically managed LRU cache that scales responsibly with
                  device memory limits.</span
                >
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- SECTION 5: ASYNC VFS ARCHITECTURE & AVAILABLE ADAPTERS -->
    <section class="section-box">
      <h2 class="section-heading">
        Universal Storage Built for the Web Platform
      </h2>
      <p class="section-sub">
        Desktop C databases assume synchronous, blocking disk calls. WebDB is
        inherently asynchronous—it requests storage pages without locking up
        JavaScript, resuming execution the moment data arrives.
      </p>

      <!-- 4 AVAILABLE VFS ADAPTERS GRID (2-CELL) + HIGHLIGHTED CUSTOM VFS -->
      <div class="vfs-grid">
        <!-- VFS 1: OPFS -->
        <div class="vfs-cell vfs-theme-emerald">
          <div class="vfs-cell-header">
            <div class="vfs-icon-box">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="square"
                stroke-linejoin="miter"
              >
                <ellipse cx="12" cy="5" rx="9" ry="3" />
                <path d="M3 5v14a9 3 0 0 0 18 0V5" />
                <path d="M3 12a9 3 0 0 0 18 0" />
              </svg>
            </div>
            <span class="vfs-num">01</span>
          </div>
          <h3 class="vfs-title">OPFS Storage Adapter</h3>
          <p class="vfs-desc">
            Direct access to the browser's Origin Private File System using
            <code>FileSystemSyncAccessHandle</code> inside dedicated Web
            Workers. Delivers blazing-fast read/write throughput for
            high-frequency persistence.
          </p>
        </div>

        <!-- VFS 2: INDEXEDDB -->
        <div class="vfs-cell vfs-theme-cyan">
          <div class="vfs-cell-header">
            <div class="vfs-icon-box">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="square"
                stroke-linejoin="miter"
              >
                <rect width="18" height="18" x="3" y="3" />
                <path d="M3 9h18" />
                <path d="M9 21V9" />
              </svg>
            </div>
            <span class="vfs-num">02</span>
          </div>
          <h3 class="vfs-title">IndexedDB Storage Adapter</h3>
          <p class="vfs-desc">
            Universal browser fallback running everywhere, including main thread
            contexts and mobile Safari on iOS. Stores binary database pages with
            full ACID transactional guarantees.
          </p>
        </div>

        <!-- VFS 3: MEMORY -->
        <div class="vfs-cell vfs-theme-violet">
          <div class="vfs-cell-header">
            <div class="vfs-icon-box">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="square"
                stroke-linejoin="miter"
              >
                <rect width="16" height="16" x="4" y="4" />
                <rect width="6" height="6" x="9" y="9" />
                <path d="M15 2v2" />
                <path d="M15 20v2" />
                <path d="M2 15h2" />
                <path d="M2 9h2" />
                <path d="M20 15h2" />
                <path d="M20 9h2" />
                <path d="M9 2v2" />
                <path d="M9 20v2" />
              </svg>
            </div>
            <span class="vfs-num">03</span>
          </div>
          <h3 class="vfs-title">In-Memory Storage Adapter</h3>
          <p class="vfs-desc">
            Ultra-fast volatile page store backed by flat typed arrays. Delivers
            sub-millisecond query execution for unit test fixtures, transient UI
            states, and isolated sandbox analytics.
          </p>
        </div>

        <!-- VFS 4: HTTP RANGE -->
        <div class="vfs-cell vfs-theme-amber">
          <div class="vfs-cell-header">
            <div class="vfs-icon-box">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="square"
                stroke-linejoin="miter"
              >
                <path
                  d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"
                />
                <path d="M12 12v9" />
                <path d="m8 17 4 4 4-4" />
              </svg>
            </div>
            <span class="vfs-num">04</span>
          </div>
          <h3 class="vfs-title">HTTP Range Streaming Adapter</h3>
          <p class="vfs-desc">
            Stream read-only databases hosted on static CDNs or S3 buckets.
            Fetches targeted pages on-demand using standard HTTP
            <code>Range: bytes=X-Y</code> headers with zero pre-downloading
            overhead.
          </p>
        </div>

        <!-- VFS 5: BUILD YOUR OWN VFS (HIGHLIGHTED CARD) -->
        <div class="vfs-cell vfs-cell-custom-highlight">
          <div class="vfs-custom-content">
            <div class="vfs-cell-header">
              <div class="vfs-icon-box vfs-icon-custom">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="m18 16 4-4-4-4" />
                  <path d="m6 8-4 4 4 4" />
                  <path d="m14.5 4-5 16" />
                </svg>
              </div>
              <span class="vfs-custom-badge">EXTENSIBLE ARCHITECTURE</span>
            </div>
            <h3 class="vfs-title">Build Your Own VFS Layer in Minutes</h3>
            <p class="vfs-desc">
              WebDB decouples the query engine completely from physical disk
              I/O. Implementing a custom storage layer is as simple as defining
              two asynchronous methods: <code>readPage(pageId)</code> and
              <code>writePage(pageId, buffer)</code>. Easily connect WebDB to
              Cloudflare KV, Durable Objects, WebRTC peer swarms, or custom
              encrypted stores without touching engine internals.
            </p>
          </div>
          <div class="vfs-custom-code">
            <div class="code-header mini-header">
              <span class="code-file">custom-vfs.ts</span>
            </div>
            <div class="mini-code-body">
              <pre
                class="mini-code"
              ><code v-html="highlightedCustomVfs"></code></pre>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- SECTION: ZERO-DOWNLOAD REMOTE QUERY USE CASE SPOTLIGHT -->
    <section class="section-box remote-showcase-section">
      <div class="showcase-header">
        <div class="showcase-badge">
          <span class="showcase-dot"></span>
          REAL-WORLD USE CASE SPOTLIGHT
        </div>
        <h2 class="section-heading">
          Query a 5GB Database on S3 Over 16KB of Network
        </h2>
        <p class="section-sub">
          Instead of downloading the entire database to the client,
          <code>HttpVfsAdapter</code> turns static object storage into a
          serverless query engine. When your query executes, WebDB inspects its
          B+Tree indexes and requests
          <strong>only the precise 4KB pages required</strong> via standard HTTP
          Range headers.
        </p>
      </div>

      <div class="http-vfs-box">
        <div class="http-vfs-flow">
          <div class="flow-step">
            <span class="step-label">1. CLIENT QUERY</span>
            <span class="step-val">
              <code>db.from("products")</code><br />
              <code> .where("sku", "=", "A900")</code>
            </span>
          </div>

          <div class="flow-signal-line">
            <div class="signal-wire">
              <span class="signal-pulse pulse-1"></span>
            </div>
            <span class="signal-tag">4KB RANGE REQUEST</span>
          </div>

          <div class="flow-step">
            <span class="step-label">2. S3 / CDN BYTE-RANGE FETCH</span>
            <span class="step-val">
              <code>GET /catalog.webdb</code><br />
              <code>Range: bytes=12288-16383</code>
            </span>
          </div>

          <div class="flow-signal-line">
            <div class="signal-wire">
              <span class="signal-pulse pulse-2"></span>
            </div>
            <span class="signal-tag">STREAMED 4KB PAGE</span>
          </div>

          <div class="flow-step">
            <span class="step-label">3. INSTANT IN-MEMORY CACHE</span>
            <span class="step-val"
              ><code>Leaf page parsed &amp; row emitted in 0.1ms</code></span
            >
          </div>
        </div>

        <div class="http-vfs-code-wrap">
          <div class="code-header">
            <span class="code-file">http-streaming.ts</span>
            <span class="code-badge">HTTP VFS</span>
          </div>
          <div class="http-code-body">
            <div class="code-lines">
              <div
                v-for="(line, index) in httpSnippetLines"
                :key="index"
                class="code-line"
              >
                <span class="line-num">{{ index + 1 }}</span>
                <span class="line-content" v-html="line || '&nbsp;'"></span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- SECTION 6: CORE PILLARS -->
    <section class="section-box">
      <h2 class="section-heading">Engineered for Resilient Web Applications</h2>
      <p class="section-sub">
        A relational database built for extreme memory efficiency and
        predictable browser execution.
      </p>

      <div class="features-grid">
        <!-- FEAT 1: STORAGE -->
        <div class="feat-box">
          <div class="feat-card-top">
            <div class="feat-icon-box">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.75"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <ellipse cx="12" cy="5" rx="9" ry="3" />
                <path d="M3 5v14a9 3 0 0 0 18 0V5" />
                <path d="M3 12a9 3 0 0 0 18 0" />
              </svg>
            </div>
            <span class="feat-num">01</span>
          </div>
          <h3 class="feat-title">Pluggable Storage Adapters</h3>
          <p class="feat-text">
            Co-equal support for bare-metal
            <strong>OPFS SyncAccessHandles</strong> in workers and universal
            <strong>IndexedDB</strong> in main thread/mobile Safari. Supports
            on-demand <strong>HTTP Range Request</strong> page streaming
            directly from S3/CDN.
          </p>
        </div>

        <!-- FEAT 2: EXECUTION -->
        <div class="feat-box">
          <div class="feat-card-top">
            <div class="feat-icon-box">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.75"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="m13 2-2 10h9L11 22l2-10H4z" />
              </svg>
            </div>
            <span class="feat-num">02</span>
          </div>
          <h3 class="feat-title">Non-Blocking Query Engine</h3>
          <p class="feat-text">
            Designed specifically for the WebAssembly runtime to execute complex
            joins and aggregations smoothly without stack overflows or freezing
            the browser tab.
          </p>
        </div>

        <!-- FEAT 3: SAFETY -->
        <div class="feat-box">
          <div class="feat-card-top">
            <div class="feat-icon-box">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.75"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                <path d="m9 12 2 2 4-4" />
              </svg>
            </div>
            <span class="feat-num">03</span>
          </div>
          <h3 class="feat-title">Crash-Proof Local Transactions</h3>
          <p class="feat-text">
            Write-Ahead Logging with atomic commits guarantees full ACID safety.
            Your data stays 100% resilient against accidental tab closes or
            sudden browser crashes.
          </p>
        </div>

        <!-- FEAT 4: IDENTITY -->
        <div class="feat-box">
          <div class="feat-card-top">
            <div class="feat-icon-box">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.75"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M4 9h16" />
                <path d="M4 15h16" />
                <path d="M10 3 8 21" />
                <path d="M16 3l-2 18" />
              </svg>
            </div>
            <span class="feat-num">04</span>
          </div>
          <h3 class="feat-title">Native UUIDv7 &amp; ULID Support</h3>
          <p class="feat-text">
            Stored as compact 16-byte fixed binary slices (58% smaller than text
            UUIDs). Time-ordered UUIDv7 and ULID append sequentially with
            near-zero index fragmentation.
          </p>
        </div>

        <!-- FEAT 5: EXTENSIBILITY -->
        <div class="feat-box">
          <div class="feat-card-top">
            <div class="feat-icon-box">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.75"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <polyline points="16 18 22 12 16 6" />
                <polyline points="8 6 2 12 8 18" />
              </svg>
            </div>
            <span class="feat-num">05</span>
          </div>
          <h3 class="feat-title">Seamless JavaScript Functions (UDFs)</h3>
          <p class="feat-text">
            Register arbitrary JS functions callable directly from queries. Run
            native browser regex and date comparisons at near-native speeds
            through shared memory.
          </p>
        </div>

        <!-- FEAT 6: SEARCH -->
        <div class="feat-box">
          <div class="feat-card-top">
            <div class="feat-icon-box">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.75"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
                <circle cx="11" cy="11" r="3" />
              </svg>
            </div>
            <span class="feat-num">06</span>
          </div>
          <h3 class="feat-title">Vector &amp; Full-Text Hybrid Search</h3>
          <p class="feat-text">
            Designed to support 128-bit Wasm SIMD vector embeddings
            (<code>VECTOR</code>), Okapi BM25 full-text search with
            <code>Intl.Segmenter</code>, and transparent AES-256-GCM page
            encryption.
          </p>
        </div>
      </div>
    </section>

    <!-- SECTION 7: INTERACTIVE CODE SHOWCASE -->
    <section class="section-box code-section">
      <h2 class="section-heading">Simple, Type-Safe API</h2>
      <p class="section-sub">
        Explore how schema creation, queries, transactions, and execution plan
        inspection work in practice.
      </p>

      <div class="terminal-box">
        <div class="terminal-bar">
          <div class="tab-list">
            <button
              :class="['tab-btn', { active: activeTab === 'query' }]"
              @click="activeTab = 'query'"
            >
              query.ts
            </button>
            <button
              :class="['tab-btn', { active: activeTab === 'http' }]"
              @click="activeTab = 'http'"
            >
              http-vfs.ts
            </button>
            <button
              :class="['tab-btn', { active: activeTab === 'tx' }]"
              @click="activeTab = 'tx'"
            >
              transactions.ts
            </button>
            <button
              :class="['tab-btn', { active: activeTab === 'explain' }]"
              @click="activeTab = 'explain'"
            >
              explain-plan.ts
            </button>
          </div>
          <button class="copy-btn" @click="copyCode">
            {{ copyStatus ? "COPIED ✓" : "COPY" }}
          </button>
        </div>

        <div class="terminal-body">
          <div class="code-lines">
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
      </div>
    </section>

    <!-- SECTION 8: SUPPORT / CTA BANNER -->
    <section class="support-banner">
      <div class="support-content">
        <h2 class="banner-title">Help Build the Future of Browser Databases</h2>
        <p class="banner-desc">
          WebDB is an open initiative to give web developers the fast,
          lightweight database they deserve. Star the repo, review our
          architecture blueprints, and join the discussion!
        </p>
        <div class="banner-actions">
          <a
            href="https://github.com/ahmad-moussawi/webdb"
            target="_blank"
            rel="noopener"
            class="btn btn-primary"
          >
            <span>STAR ON GITHUB</span>
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
              class="star-icon"
            >
              <polygon
                points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"
              />
            </svg>
          </a>
          <a :href="withBase('/plans/plan')" class="btn btn-secondary">
            <span>READ THE SPECIFICATIONS</span>
          </a>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.webdb-landing {
  max-width: 1160px;
  margin: 0 auto;
  padding: 3.5rem 2rem 8rem;
  font-family: var(--vp-font-family-base);
  color: var(--vp-c-text-1);
}

code {
  font-family: var(--vp-font-family-mono);
}

/* HERO SECTION (OPEN & SPACIOUS) */
.hero-section {
  text-align: center;
  padding: 3.5rem 1rem 5.5rem;
  max-width: 980px;
  margin: 0 auto;
}

.hero-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 0.65rem;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  padding: 0.35rem 0.9rem;
  font-family: var(--vp-font-family-mono);
  font-size: 0.8rem;
  margin-bottom: 2rem;
}

.eyebrow-logo {
  display: inline-block;
}

.eyebrow-brand {
  font-weight: 700;
  color: var(--vp-c-text-1);
}

.eyebrow-sep {
  color: var(--vp-c-text-3);
  opacity: 0.6;
}

.eyebrow-status {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  color: var(--vp-c-text-2);
}

.status-dot {
  width: 7px;
  height: 7px;
  background-color: #10b981;
  display: inline-block;
  box-shadow: 0 0 8px #10b981;
}

.hero-title {
  font-size: 3.85rem;
  font-weight: 800;
  letter-spacing: -2px;
  line-height: 1.15;
  margin: 0 0 1.5rem;
  color: var(--vp-c-text-1);
}

.hero-accent {
  color: var(--vp-c-brand-1);
}

.hero-lead {
  font-size: 1.25rem;
  line-height: 1.6;
  color: var(--vp-c-text-2);
  max-width: 680px;
  margin: 0 auto 2.5rem;
  font-weight: 400;
}

.hero-actions {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 1.25rem;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.85rem 1.85rem;
  font-size: 0.9rem;
  font-weight: 700;
  letter-spacing: 0.3px;
  text-decoration: none;
  cursor: pointer;
  transition: all 0.15s ease;
  border: 1px solid transparent;
}

.btn-primary {
  background: var(--vp-c-brand-1);
  color: #fff;
  border-color: var(--vp-c-brand-1);
}

.btn-primary:hover {
  background: var(--vp-c-brand-2);
  border-color: var(--vp-c-brand-2);
}

.btn-secondary {
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  border-color: var(--vp-c-divider);
}

.btn-secondary:hover {
  background: var(--vp-c-bg-mute);
  border-color: var(--vp-c-text-2);
}

.btn-arrow {
  transition: transform 0.15s ease;
}

.btn:hover .btn-arrow {
  transform: translateX(3px);
}

.star-icon {
  display: inline-block;
  vertical-align: middle;
  color: #f59e0b;
  transition:
    transform 0.2s ease,
    fill 0.2s ease;
}

.btn:hover .star-icon {
  fill: #f59e0b;
  transform: scale(1.15) rotate(6deg);
}

/* HERO STATS BAR (VIBRANT & DISTINCT) */
/* HERO STATS BAR (CLEAN, TECHNICAL & REFINED) */
.hero-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1.25rem;
  margin-top: 4.5rem;
  text-align: left;
}

.stat-card {
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  padding: 1.75rem 1.4rem;
  position: relative;
  display: flex;
  flex-direction: column;
  transition:
    border-color 0.2s ease,
    box-shadow 0.2s ease,
    transform 0.2s ease;
}

.stat-card:hover {
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.05);
  transform: translateY(-2px);
}

:global(.dark) .stat-card:hover {
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}

.stat-card-top {
  display: flex;
  align-items: center;
  margin-bottom: 1.25rem;
}

.stat-icon-box {
  width: 38px;
  height: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
  border: 1px solid rgba(37, 99, 235, 0.18);
  transition: all 0.2s ease;
}

:global(.dark) .stat-icon-box {
  border-color: rgba(56, 189, 248, 0.2);
}

.stat-card:hover .stat-icon-box {
  background: var(--vp-c-brand-1);
  color: #ffffff;
  border-color: var(--vp-c-brand-1);
}

:global(.dark) .stat-card:hover .stat-icon-box {
  background: var(--vp-c-brand-1);
  color: #0f172a;
  border-color: var(--vp-c-brand-1);
}

.stat-val {
  font-family: var(--vp-font-family-mono);
  font-size: 1.65rem;
  font-weight: 800;
  letter-spacing: -0.5px;
  line-height: 1.15;
  margin-bottom: 0.45rem;
  color: var(--vp-c-text-1);
}

.stat-label {
  font-size: 0.92rem;
  font-weight: 700;
  color: var(--vp-c-text-1);
  margin-bottom: 0.35rem;
  letter-spacing: -0.2px;
}

.stat-desc {
  font-size: 0.8rem;
  color: var(--vp-c-text-2);
  line-height: 1.5;
}

/* SECTION CONTAINER */
.section-box {
  margin-bottom: 6rem;
}

.section-heading {
  font-size: 2.1rem;
  font-weight: 800;
  letter-spacing: -0.6px;
  line-height: 1.25;
  margin: 0 0 0.85rem;
}

.section-sub {
  color: var(--vp-c-text-2);
  font-size: 1.05rem;
  line-height: 1.65;
  max-width: 820px;
  margin: 0 0 3rem;
}

/* USECASES GRID (2-CELL WITH ADAPTIVE BORDER & BACKGROUND) */
.usecases-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 1px;
  background: var(--vp-c-divider);
  border: 1px solid var(--vp-c-divider);
}

:global(.dark) .usecases-grid,
.dark .usecases-grid {
  background: var(--vp-c-divider);
  border-color: var(--vp-c-divider);
}

.usecase-cell {
  padding: 3rem 2.5rem;
  display: flex;
  flex-direction: column;
  position: relative;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  transition: background 0.15s ease;
}

.usecase-cell:hover {
  background: var(--vp-c-bg-soft);
}

:global(.dark) .usecase-cell,
.dark .usecase-cell {
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
}

:global(.dark) .usecase-cell:hover,
.dark .usecase-cell:hover {
  background: var(--vp-c-bg-soft);
}

.usecase-cell-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.5rem;
}

.usecase-icon-box {
  width: 40px;
  height: 40px;
  min-width: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
}

.usecase-cell-meta {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.usecase-num {
  font-family: var(--vp-font-family-mono);
  font-size: 0.85rem;
  font-weight: 800;
  letter-spacing: 0.5px;
}

.usecase-pill {
  font-family: var(--vp-font-family-mono);
  font-size: 0.68rem;
  font-weight: 700;
  padding: 2px 7px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-mute);
  color: var(--vp-c-text-1);
  letter-spacing: 0.5px;
}

:global(.dark) .usecase-pill,
.dark .usecase-pill {
  border-color: var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2);
}

.usecase-title {
  font-size: 1.22rem;
  font-weight: 800;
  letter-spacing: -0.3px;
  margin: 0 0 0.85rem;
  color: var(--vp-c-text-1);
  line-height: 1.35;
}

.usecase-text {
  font-size: 0.92rem;
  line-height: 1.65;
  color: var(--vp-c-text-2);
  margin: 0;
}

/* THEME ACCENTS FOR ICONS & NUMBERS */
/* Emerald */
.usecase-theme-emerald .usecase-num {
  color: #10b981;
}
:global(.dark) .usecase-theme-emerald .usecase-num,
.dark .usecase-theme-emerald .usecase-num {
  color: #34d399;
}
.usecase-theme-emerald .usecase-icon-box {
  background: rgba(16, 185, 129, 0.08);
  border-color: rgba(16, 185, 129, 0.2);
  color: #10b981;
}
:global(.dark) .usecase-theme-emerald .usecase-icon-box,
.dark .usecase-theme-emerald .usecase-icon-box {
  background: rgba(52, 211, 153, 0.12);
  border-color: rgba(52, 211, 153, 0.3);
  color: #34d399;
}

/* Cyan */
.usecase-theme-cyan .usecase-num {
  color: #0284c7;
}
:global(.dark) .usecase-theme-cyan .usecase-num {
  color: #38bdf8;
}
.usecase-theme-cyan .usecase-icon-box {
  background: rgba(14, 165, 233, 0.08);
  border-color: rgba(14, 165, 233, 0.2);
  color: #0284c7;
}
:global(.dark) .usecase-theme-cyan .usecase-icon-box {
  background: rgba(56, 189, 248, 0.12);
  border-color: rgba(56, 189, 248, 0.3);
  color: #38bdf8;
}

/* Violet */
.usecase-theme-violet .usecase-num {
  color: #8b5cf6;
}
:global(.dark) .usecase-theme-violet .usecase-num {
  color: #a78bfa;
}
.usecase-theme-violet .usecase-icon-box {
  background: rgba(139, 92, 246, 0.08);
  border-color: rgba(139, 92, 246, 0.2);
  color: #8b5cf6;
}
:global(.dark) .usecase-theme-violet .usecase-icon-box {
  background: rgba(167, 139, 250, 0.12);
  border-color: rgba(167, 139, 250, 0.3);
  color: #a78bfa;
}

/* Amber */
.usecase-theme-amber .usecase-num {
  color: #d97706;
}
:global(.dark) .usecase-theme-amber .usecase-num {
  color: #fbbf24;
}
.usecase-theme-amber .usecase-icon-box {
  background: rgba(245, 158, 11, 0.08);
  border-color: rgba(245, 158, 11, 0.2);
  color: #d97706;
}
:global(.dark) .usecase-theme-amber .usecase-icon-box {
  background: rgba(251, 191, 36, 0.12);
  border-color: rgba(251, 191, 36, 0.3);
  color: #fbbf24;
}

/* Rose */
.usecase-theme-rose .usecase-num {
  color: #f43f5e;
}
:global(.dark) .usecase-theme-rose .usecase-num {
  color: #fb7185;
}
.usecase-theme-rose .usecase-icon-box {
  background: rgba(244, 63, 94, 0.08);
  border-color: rgba(244, 63, 94, 0.2);
  color: #f43f5e;
}
:global(.dark) .usecase-theme-rose .usecase-icon-box {
  background: rgba(251, 113, 133, 0.12);
  border-color: rgba(251, 113, 133, 0.3);
  color: #fb7185;
}

/* Indigo */
.usecase-theme-indigo .usecase-num {
  color: #6366f1;
}
:global(.dark) .usecase-theme-indigo .usecase-num {
  color: #818cf8;
}
.usecase-theme-indigo .usecase-icon-box {
  background: rgba(99, 102, 241, 0.08);
  border-color: rgba(99, 102, 241, 0.2);
  color: #6366f1;
}
:global(.dark) .usecase-theme-indigo .usecase-icon-box {
  background: rgba(129, 140, 248, 0.12);
  border-color: rgba(129, 140, 248, 0.3);
  color: #818cf8;
}

/* ARCHITECTURAL SHORTCUT (CLEAN EDITORIAL) */
.arch-shortcut-section {
  padding-top: 1rem;
}

/* INTERACTIVE BOX DRAWING DIAGRAM */
.boxdraw-container {
  margin: 2.75rem 0 2rem;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  padding: 2rem 2.25rem;
}

.boxdraw-header {
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 2rem;
}

.boxdraw-toggle {
  display: inline-flex;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-mute);
  padding: 3px;
  border-radius: 6px;
  gap: 4px;
}

.boxdraw-toggle-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.45rem 1rem;
  font-family: var(--vp-font-family-mono);
  font-size: 0.82rem;
  font-weight: 500;
  color: var(--vp-c-text-2);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.boxdraw-toggle-btn:hover {
  color: var(--vp-c-text-1);
}

/* Subtle, clean active state */
.boxdraw-toggle-btn.active-other,
.boxdraw-toggle-btn.active-webdb {
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font-weight: 600;
  border-color: var(--vp-c-divider);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
}

.toggle-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  display: inline-block;
  opacity: 0.35;
  transition: opacity 0.15s ease;
}

.dot-red {
  background: #ef4444;
}

.dot-green {
  background: #10b981;
}

.active-other .dot-red {
  opacity: 1;
  box-shadow: 0 0 4px rgba(239, 68, 68, 0.5);
}

.active-webdb .dot-green {
  opacity: 1;
  box-shadow: 0 0 4px rgba(16, 185, 129, 0.5);
}

/* CAPTION BELOW THE DRAWING (CENTERED, NO BOX) */
.boxdraw-caption-center {
  margin-top: 1.75rem;
  display: flex;
  justify-content: center;
  align-items: center;
  text-align: center;
}

.caption-text {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.55rem;
  font-family: var(--vp-font-family-mono);
  font-size: 0.84rem;
  font-weight: 500;
  line-height: 1.5;
  color: var(--vp-c-text-1);
  background: none;
  border: none;
  padding: 0;
  border-radius: 0;
  text-align: center;
}

.status-indicator {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  display: inline-block;
  flex-shrink: 0;
}

.status-red {
  background-color: #ef4444;
  box-shadow: 0 0 5px rgba(239, 68, 68, 0.6);
}

.status-green {
  background-color: #10b981;
  box-shadow: 0 0 5px rgba(16, 185, 129, 0.6);
}

.boxdraw-board {
  min-height: 72px;
  display: flex;
  align-items: center;
}

.boxdraw-track {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

/* BOX DRAWING CARDS */
.boxdraw-box {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.75rem 1.25rem;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  font-family: var(--vp-font-family-mono);
  font-size: 0.88rem;
  font-weight: 700;
  color: var(--vp-c-text-1);
  white-space: nowrap;
  user-select: none;
  transition: all 0.2s ease;
}

/* ASCII Corner characters */
.c-tl,
.c-tr,
.c-bl,
.c-br {
  position: absolute;
  font-family: var(--vp-font-family-mono);
  font-size: 0.75rem;
  line-height: 1;
  color: var(--vp-c-text-3);
  pointer-events: none;
}
.c-tl {
  top: -6px;
  left: -4px;
}
.c-tr {
  top: -6px;
  right: -4px;
}
.c-bl {
  bottom: -6px;
  left: -4px;
}
.c-br {
  bottom: -6px;
  right: -4px;
}

/* Red Dim / Slowness boxes in Other Solutions */
.box-red-dim {
  border-color: rgba(239, 68, 68, 0.35);
  color: var(--vp-c-text-2);
}

:global(.dark) .box-red-dim {
  border-color: rgba(239, 68, 68, 0.4);
}

.c-red {
  color: #ef4444 !important;
}

:global(.dark) .c-red {
  color: #f87171 !important;
}

/* Green Active boxes in WebDB Mode */
.box-active-green {
  border-color: rgba(16, 185, 129, 0.4);
  color: var(--vp-c-text-1);
}

:global(.dark) .box-active-green {
  border-color: rgba(52, 211, 153, 0.4);
}

.c-green {
  color: #10b981 !important;
}

:global(.dark) .c-green {
  color: #34d399 !important;
}

.box-end-green {
  border-color: rgba(16, 185, 129, 0.5);
}

/* CONNECTING ARROWS & WIRES */
.boxdraw-arrow-wrap {
  display: flex;
  align-items: center;
  flex: 1 1 0;
  position: relative;
  margin: 0 0.25rem;
}

.boxdraw-wire {
  flex: 1 1 0;
  height: 2px;
  background: var(--vp-c-divider);
  position: relative;
  overflow: visible;
}

/* Red Slowness wire */
.arrow-red .boxdraw-wire {
  background: rgba(239, 68, 68, 0.4);
}

/* Green Fastness wire */
.arrow-green .boxdraw-wire {
  background: rgba(16, 185, 129, 0.45);
  height: 2px;
}

.boxdraw-pulse {
  position: absolute;
  top: -2px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

/* Red Slow Signal */
.pulse-red {
  background-color: #ef4444;
  box-shadow: 0 0 4px rgba(239, 68, 68, 0.6);
  animation: boxdraw-signal-slow 2.4s cubic-bezier(0.4, 0, 0.2, 1) infinite;
}

.pulse-s1 {
  animation-delay: 0s;
}
.pulse-s2 {
  animation-delay: 0.75s;
}
.pulse-s3 {
  animation-delay: 1.5s;
}

/* Yellow Fast Signal */
.pulse-yellow {
  background-color: #f59e0b;
  box-shadow: 0 0 5px rgba(245, 158, 11, 0.6);
  animation: boxdraw-signal-fast 1.1s cubic-bezier(0.2, 0, 0.2, 1) infinite;
}

:global(.dark) .pulse-yellow {
  background-color: #fbbf24;
  box-shadow: 0 0 5px rgba(251, 191, 36, 0.6);
}

@keyframes boxdraw-signal-slow {
  0% {
    left: -4px;
    opacity: 0;
  }
  20% {
    opacity: 1;
  }
  80% {
    opacity: 1;
  }
  100% {
    left: calc(100% - 4px);
    opacity: 0;
  }
}

@keyframes boxdraw-signal-fast {
  0% {
    left: -4px;
    opacity: 0;
  }
  15% {
    opacity: 1;
  }
  85% {
    opacity: 1;
  }
  100% {
    left: calc(100% - 4px);
    opacity: 0;
  }
}

/* DIRECT BADGE IN WEBDB MODE */
.direct-pill {
  position: absolute;
  top: -16px;
  left: 50%;
  transform: translateX(-50%);
  font-family: var(--vp-font-family-mono);
  font-size: 0.68rem;
  font-weight: 800;
  letter-spacing: 0.5px;
  color: #10b981;
  background: var(--vp-c-bg-soft);
  border: 1px solid rgba(16, 185, 129, 0.4);
  border-radius: 3px;
  padding: 1px 8px;
  white-space: nowrap;
}

:global(.dark) .direct-pill {
  color: #34d399;
  border-color: rgba(52, 211, 153, 0.4);
}

/* TRANSITIONS */
.boxdraw-fade-enter-active,
.boxdraw-fade-leave-active {
  transition: all 0.2s ease;
}

.boxdraw-fade-enter-from {
  opacity: 0;
  transform: translateY(4px);
}

.boxdraw-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

@media (max-width: 900px) {
  .boxdraw-board {
    padding: 0.5rem 0;
  }
  .boxdraw-track {
    flex-direction: column;
    align-items: center;
    gap: 0;
  }
  .boxdraw-box {
    width: 100%;
    max-width: 280px;
    justify-content: center;
  }
  .boxdraw-arrow-wrap {
    height: 52px;
    width: 2px;
    margin: 0.5rem auto;
    flex-direction: column;
    flex: none;
  }
  .arrow-direct {
    height: 72px;
    margin: 0.75rem auto;
  }
  .boxdraw-wire {
    width: 2px;
    height: 100%;
  }
  .direct-pill {
    top: 50%;
    left: 20px;
    transform: translateY(-50%);
  }
  .pulse-red,
  .pulse-yellow {
    top: 0;
    left: -2px;
    animation: boxdraw-signal-v-slow 2.4s cubic-bezier(0.4, 0, 0.2, 1) infinite;
  }
  .pulse-yellow {
    animation: boxdraw-signal-v-fast 1.1s cubic-bezier(0.2, 0, 0.2, 1) infinite;
  }
  @keyframes boxdraw-signal-v-slow {
    0% {
      top: -2px;
      opacity: 0;
    }
    20% {
      opacity: 1;
    }
    80% {
      opacity: 1;
    }
    100% {
      top: calc(100% - 4px);
      opacity: 0;
    }
  }
  @keyframes boxdraw-signal-v-fast {
    0% {
      top: -2px;
      opacity: 0;
    }
    15% {
      opacity: 1;
    }
    85% {
      opacity: 1;
    }
    100% {
      top: calc(100% - 4px);
      opacity: 0;
    }
  }
}

/* EDITORIAL NARRATIVE */
.shortcut-narrative {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 3.5rem;
  margin-top: 3rem;
}

.narrative-block {
  display: flex;
  flex-direction: column;
}

.narrative-heading {
  font-size: 1.35rem;
  font-weight: 800;
  color: var(--vp-c-text-1);
  margin: 0 0 1rem;
  line-height: 1.3;
  letter-spacing: -0.3px;
}

.narrative-body {
  font-size: 0.95rem;
  line-height: 1.7;
  color: var(--vp-c-text-2);
  margin: 0 0 1rem;
}

.narrative-body strong {
  color: var(--vp-c-text-1);
  font-weight: 700;
}

.narrative-body code {
  font-family: var(--vp-font-family-mono);
  font-size: 0.85em;
  padding: 0.15rem 0.35rem;
  background: var(--vp-c-bg-mute);
  border: 1px solid var(--vp-c-divider);
}

/* LIGHT COMPARISON TABLE */
.compare-table-wrapper {
  width: 100%;
  overflow-x: auto;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.03);
  margin-top: 1rem;
}

:global(.dark) .compare-table-wrapper {
  background: var(--vp-c-bg-mute);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
}

.compare-table {
  width: 100%;
  border-collapse: collapse;
  text-align: left;
  font-size: 0.88rem;
  min-width: 680px;
}

.compare-table thead th {
  padding: 1.15rem 1.5rem;
  font-size: 0.74rem;
  font-weight: 700;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  font-family: var(--vp-font-family-mono);
  border-bottom: 2px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2);
}

:global(.dark) .compare-table thead th {
  background: rgba(15, 23, 42, 0.6);
}

.col-feature {
  width: 28%;
}

.col-legacy {
  width: 36%;
}

.col-webdb {
  width: 36%;
  background: rgba(16, 185, 129, 0.04);
}

:global(.dark) .col-webdb {
  background: rgba(16, 185, 129, 0.08);
}

.webdb-col-header {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  color: var(--vp-c-text-1);
}

.webdb-header-pill {
  font-family: var(--vp-font-family-mono);
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.5px;
  padding: 2px 7px;
  background: var(--vp-c-brand-1);
  color: #ffffff;
}

.compare-table tbody tr {
  border-bottom: 1px solid var(--vp-c-divider);
  transition: background 0.15s ease;
}

.compare-table tbody tr:last-child {
  border-bottom: none;
}

.compare-table tbody tr:hover {
  background: rgba(0, 0, 0, 0.015);
}

:global(.dark) .compare-table tbody tr:hover {
  background: rgba(255, 255, 255, 0.02);
}

.compare-table tbody td {
  padding: 1.25rem 1.5rem;
  vertical-align: top;
}

.row-feature {
  background: var(--vp-c-bg);
}

.feature-title {
  font-weight: 700;
  color: var(--vp-c-text-1);
  font-size: 0.92rem;
  margin-bottom: 0.25rem;
}

.feature-desc {
  font-size: 0.78rem;
  color: var(--vp-c-text-3);
  line-height: 1.45;
}

.cell-legacy {
  color: var(--vp-c-text-2);
}

.cell-webdb {
  background: rgba(16, 185, 129, 0.02);
  border-left: 1px solid rgba(16, 185, 129, 0.12);
}

:global(.dark) .cell-webdb {
  background: rgba(16, 185, 129, 0.04);
  border-left-color: rgba(16, 185, 129, 0.15);
}

.val-bad {
  display: inline-block;
  font-family: var(--vp-font-family-mono);
  font-size: 0.82rem;
  font-weight: 700;
  color: #ef4444;
  margin-bottom: 0.35rem;
}

.val-warn {
  display: inline-block;
  font-family: var(--vp-font-family-mono);
  font-size: 0.82rem;
  font-weight: 700;
  color: #d97706;
  margin-bottom: 0.35rem;
}

:global(.dark) .val-warn {
  color: #fbbf24;
}

.val-good {
  display: inline-block;
  font-family: var(--vp-font-family-mono);
  font-size: 0.86rem;
  font-weight: 800;
  color: var(--vp-c-brand-1);
  margin-bottom: 0.35rem;
}

.val-sub {
  display: block;
  font-size: 0.82rem;
  line-height: 1.5;
  color: var(--vp-c-text-2);
}

.cell-webdb .val-sub {
  color: var(--vp-c-text-1);
}

/* ASYNC VFS GRID (2-CELL WITH ADAPTIVE BORDER & BACKGROUND) */
.vfs-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 1px;
  background: var(--vp-c-divider);
  border: 1px solid var(--vp-c-divider);
  margin-bottom: 2.5rem;
}

:global(.dark) .vfs-grid,
.dark .vfs-grid {
  background: var(--vp-c-divider);
  border-color: var(--vp-c-divider);
}

.vfs-cell {
  padding: 3rem 2.5rem;
  display: flex;
  flex-direction: column;
  position: relative;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  transition: background 0.15s ease;
}

.vfs-cell:hover {
  background: var(--vp-c-bg-soft);
}

:global(.dark) .vfs-cell,
.dark .vfs-cell {
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
}

:global(.dark) .vfs-cell:hover,
.dark .vfs-cell:hover {
  background: var(--vp-c-bg-soft);
}

.vfs-cell-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.5rem;
}

.vfs-icon-box {
  width: 40px;
  height: 40px;
  min-width: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
}

.vfs-cell-meta {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.vfs-num {
  font-family: var(--vp-font-family-mono);
  font-size: 0.85rem;
  font-weight: 800;
  letter-spacing: 0.5px;
}

.vfs-pill {
  font-family: var(--vp-font-family-mono);
  font-size: 0.68rem;
  font-weight: 700;
  padding: 2px 7px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-mute);
  color: var(--vp-c-text-1);
  letter-spacing: 0.5px;
}

:global(.dark) .vfs-pill,
.dark .vfs-pill {
  border-color: var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2);
}

.vfs-title {
  font-size: 1.22rem;
  font-weight: 800;
  letter-spacing: -0.3px;
  margin: 0 0 0.85rem;
  color: var(--vp-c-text-1);
  line-height: 1.35;
}

.vfs-desc {
  font-size: 0.92rem;
  line-height: 1.65;
  color: var(--vp-c-text-2);
  margin: 0;
}

/* THEME ACCENTS FOR VFS */
/* OPFS - Emerald */
.vfs-theme-emerald .usecase-num,
.vfs-theme-emerald .vfs-num {
  color: #10b981;
}
:global(.dark) .vfs-theme-emerald .vfs-num,
.dark .vfs-theme-emerald .vfs-num {
  color: #34d399;
}
.vfs-theme-emerald .vfs-icon-box {
  background: rgba(16, 185, 129, 0.08);
  border-color: rgba(16, 185, 129, 0.2);
  color: #10b981;
}
:global(.dark) .vfs-theme-emerald .vfs-icon-box,
.dark .vfs-theme-emerald .vfs-icon-box {
  background: rgba(52, 211, 153, 0.12);
  border-color: rgba(52, 211, 153, 0.3);
  color: #34d399;
}

/* IDB - Cyan */
.vfs-theme-cyan .vfs-num {
  color: #0284c7;
}
:global(.dark) .vfs-theme-cyan .vfs-num {
  color: #38bdf8;
}
.vfs-theme-cyan .vfs-icon-box {
  background: rgba(14, 165, 233, 0.08);
  border-color: rgba(14, 165, 233, 0.2);
  color: #0284c7;
}
:global(.dark) .vfs-theme-cyan .vfs-icon-box {
  background: rgba(56, 189, 248, 0.12);
  border-color: rgba(56, 189, 248, 0.3);
  color: #38bdf8;
}

/* Memory - Violet */
.vfs-theme-violet .vfs-num {
  color: #8b5cf6;
}
:global(.dark) .vfs-theme-violet .vfs-num {
  color: #a78bfa;
}
.vfs-theme-violet .vfs-icon-box {
  background: rgba(139, 92, 246, 0.08);
  border-color: rgba(139, 92, 246, 0.2);
  color: #8b5cf6;
}
:global(.dark) .vfs-theme-violet .vfs-icon-box {
  background: rgba(167, 139, 250, 0.12);
  border-color: rgba(167, 139, 250, 0.3);
  color: #a78bfa;
}

/* HTTP Range - Amber */
.vfs-theme-amber .vfs-num {
  color: #d97706;
}
:global(.dark) .vfs-theme-amber .vfs-num {
  color: #fbbf24;
}
.vfs-theme-amber .vfs-icon-box {
  background: rgba(245, 158, 11, 0.08);
  border-color: rgba(245, 158, 11, 0.2);
  color: #d97706;
}
:global(.dark) .vfs-theme-amber .vfs-icon-box {
  background: rgba(251, 191, 36, 0.12);
  border-color: rgba(251, 191, 36, 0.3);
  color: #fbbf24;
}

/* VFS HIGHLIGHTED CUSTOM ADAPTER CARD */
.vfs-cell-custom-highlight {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: 1.25fr 1fr;
  gap: 2.5rem;
  background: var(--vp-c-bg);
  border-top: 3px solid var(--vp-c-brand-1);
  padding: 3rem 2.5rem;
  align-items: center;
}

:global(.dark) .vfs-cell-custom-highlight {
  background: var(--vp-c-bg-mute);
}

.vfs-icon-custom {
  color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
  border-color: rgba(37, 99, 235, 0.2);
}

.vfs-custom-badge {
  font-family: var(--vp-font-family-mono);
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.5px;
  color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
  padding: 3px 8px;
  border: 1px solid rgba(37, 99, 235, 0.2);
}

.vfs-custom-code {
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
}

:global(.dark) .vfs-custom-code {
  background: var(--vp-c-bg);
}

.mini-header {
  padding: 0.5rem 0.85rem;
  border-bottom: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-mute);
  font-size: 0.72rem;
}

.mini-code-body {
  padding: 1rem 1.15rem;
  overflow-x: auto;
}

.mini-code {
  margin: 0;
  font-family: var(--vp-font-family-mono);
  font-size: 0.78rem;
  line-height: 1.6;
}

/* REMOTE STREAMING SHOWCASE (DEDICATED USE CASE SECTION - CLEAN OPEN LAYOUT) */
.remote-showcase-section {
  margin-bottom: 6rem;
}

.showcase-header {
  margin-bottom: 2.5rem;
}

.showcase-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.55rem;
  font-family: var(--vp-font-family-mono);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.75px;
  color: var(--vp-c-brand-1);
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  padding: 0.35rem 0.85rem;
  margin-bottom: 1.25rem;
}

.showcase-dot {
  width: 6px;
  height: 6px;
  background-color: var(--vp-c-brand-1);
  border-radius: 50%;
  display: inline-block;
}

/* HTTP VFS SHOWCASE LAYOUT (OPEN WIDTH, NO CONFINING OUTER BOX) */
.http-vfs-box {
  display: grid;
  grid-template-columns: 330px 1fr;
  gap: 2.25rem;
  border: none;
  background: transparent;
  padding: 0;
  align-items: start;
  box-shadow: none;
}

:global(.dark) .http-vfs-box {
  background: transparent;
  border-color: transparent;
  box-shadow: none;
}

/* FLOW ON THE LEFT (NO OUTER BOX, SPACED STEPS WITH ANIMATED SIGNALS) */
.http-vfs-flow {
  display: flex;
  flex-direction: column;
}

.flow-step {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  padding: 1.2rem 1.35rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.03);
}

:global(.dark) .flow-step {
  background: var(--vp-c-bg-mute);
  border-color: var(--vp-c-divider);
}

.step-label {
  font-family: var(--vp-font-family-mono);
  font-size: 0.72rem;
  font-weight: 700;
  color: var(--vp-c-brand-1);
  letter-spacing: 0.5px;
}

.step-val {
  font-family: var(--vp-font-family-mono);
  font-size: 0.82rem;
  color: var(--vp-c-text-1);
  line-height: 1.45;
}

.flow-signal-line {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  height: 60px;
  padding-left: 1.85rem;
  position: relative;
}

.signal-wire {
  width: 2px;
  height: 100%;
  background: var(--vp-c-divider);
  position: relative;
}

.signal-pulse {
  position: absolute;
  top: 0;
  left: -2px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: var(--vp-c-brand-1);
  box-shadow: 0 0 6px var(--vp-c-brand-1);
  animation: flow-signal-pulse 1.8s cubic-bezier(0.4, 0, 0.2, 1) infinite;
}

.pulse-2 {
  animation-delay: 0.9s;
}

@keyframes flow-signal-pulse {
  0% {
    top: 0;
    opacity: 0;
  }
  20% {
    opacity: 1;
  }
  80% {
    opacity: 1;
  }
  100% {
    top: calc(100% - 6px);
    opacity: 0;
  }
}

.signal-tag {
  font-family: var(--vp-font-family-mono);
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.5px;
  color: var(--vp-c-text-3);
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  padding: 2px 7px;
}

:global(.dark) .signal-tag {
  background: var(--vp-c-bg-mute);
}

/* HTTP VFS CODE EMBED */
.http-vfs-code-wrap {
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  overflow: hidden;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.04);
}

:global(.dark) .http-vfs-code-wrap {
  border-color: var(--vp-c-divider);
  background: var(--vp-c-bg-mute);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
}

.code-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: var(--vp-c-bg-mute);
  border-bottom: 1px solid var(--vp-c-divider);
  padding: 0.85rem 1.25rem;
  font-family: var(--vp-font-family-mono);
  font-size: 0.8rem;
}

:global(.dark) .code-header {
  background: var(--vp-c-bg-mute);
  border-bottom-color: var(--vp-c-divider);
}

.code-file {
  font-weight: 700;
  color: var(--vp-c-text-1);
}

.code-badge {
  background: var(--vp-c-brand-1);
  color: #fff;
  padding: 2px 7px;
  font-size: 0.65rem;
  font-weight: 700;
}

.http-code-body {
  padding: 1.25rem 0.5rem;
  background: var(--vp-c-bg-soft);
  overflow-x: auto;
  font-family: var(--vp-font-family-mono);
  font-size: 0.82rem;
  line-height: 1.6;
}

/* FEATURES GRID (MATCHING STATS CARDS ARCHITECTURE) */
.features-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1.25rem;
}

.feat-box {
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  padding: 1.75rem 1.4rem;
  position: relative;
  display: flex;
  flex-direction: column;
  transition:
    border-color 0.2s ease,
    box-shadow 0.2s ease,
    transform 0.2s ease;
}

.feat-box:hover {
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.05);
  transform: translateY(-2px);
}

:global(.dark) .feat-box:hover {
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}

.feat-card-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.25rem;
}

.feat-icon-box {
  width: 38px;
  height: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
  border: 1px solid rgba(37, 99, 235, 0.18);
  transition: all 0.2s ease;
}

:global(.dark) .feat-icon-box {
  border-color: rgba(56, 189, 248, 0.2);
}

.feat-box:hover .feat-icon-box {
  background: var(--vp-c-brand-1);
  color: #ffffff;
  border-color: var(--vp-c-brand-1);
}

:global(.dark) .feat-box:hover .feat-icon-box {
  background: var(--vp-c-brand-1);
  color: #0f172a;
  border-color: var(--vp-c-brand-1);
}

.feat-num {
  font-family: var(--vp-font-family-mono);
  font-size: 0.78rem;
  font-weight: 700;
  color: var(--vp-c-text-3);
  letter-spacing: 0.5px;
}

.feat-title {
  font-size: 1.12rem;
  font-weight: 700;
  line-height: 1.35;
  margin: 0 0 0.65rem;
  letter-spacing: -0.2px;
  color: var(--vp-c-text-1);
}

.feat-text {
  font-size: 0.88rem;
  color: var(--vp-c-text-2);
  line-height: 1.6;
  margin: 0;
}

/* TERMINAL / CODE SECTION */
.terminal-box {
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.06);
}

.terminal-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: var(--vp-c-bg-mute);
  border-bottom: 1px solid var(--vp-c-divider);
  padding: 0 0.5rem;
  overflow-x: auto;
}

.tab-list {
  display: flex;
}

.tab-btn {
  background: transparent;
  border: none;
  border-right: 1px solid var(--vp-c-divider);
  padding: 0.75rem 1.25rem;
  font-family: var(--vp-font-family-mono);
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--vp-c-text-2);
  cursor: pointer;
  transition: all 0.15s ease;
}

.tab-btn:hover {
  color: var(--vp-c-text-1);
  background: var(--vp-c-bg-soft);
}

.tab-btn.active {
  color: var(--vp-c-brand-1);
  background: var(--vp-c-bg);
  border-bottom: 2px solid var(--vp-c-brand-1);
}

.copy-btn {
  background: transparent;
  border: 1px solid var(--vp-c-divider);
  padding: 0.35rem 0.85rem;
  font-family: var(--vp-font-family-mono);
  font-size: 0.72rem;
  font-weight: 700;
  color: var(--vp-c-text-2);
  cursor: pointer;
  margin-left: 0.5rem;
}

.copy-btn:hover {
  color: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
}

.terminal-body {
  padding: 1.5rem 0.5rem;
  overflow-x: auto;
  font-family: var(--vp-font-family-mono);
  font-size: 0.88rem;
  line-height: 1.65;
  background: var(--vp-c-bg-soft);
}

.code-lines {
  display: flex;
  flex-direction: column;
}

.code-line {
  display: flex;
  min-height: 1.65em;
  padding: 0 0.85rem;
}

.code-line:hover {
  background: rgba(0, 0, 0, 0.03);
}

:global(.dark) .code-line:hover {
  background: rgba(255, 255, 255, 0.03);
}

.line-num {
  width: 2.75rem;
  text-align: right;
  padding-right: 1.35rem;
  color: var(--vp-c-text-3);
  user-select: none;
  font-size: 0.8rem;
  opacity: 0.7;
}

.line-content {
  flex: 1;
  white-space: pre;
}

/* SYNTAX TOKENS */
:deep(.hl-kw) {
  color: #8b5cf6;
  font-weight: 600;
}

:deep(.hl-fn) {
  color: #2563eb;
  font-weight: 600;
}

:global(.dark) :deep(.hl-fn) {
  color: #38bdf8;
}

:deep(.hl-str) {
  color: #059669;
}

:global(.dark) :deep(.hl-str) {
  color: #34d399;
}

:deep(.hl-num) {
  color: #ea580c;
}

:global(.dark) :deep(.hl-num) {
  color: #fb923c;
}

:deep(.hl-type) {
  color: #d97706;
  font-weight: 700;
}

:global(.dark) :deep(.hl-type) {
  color: #f59e0b;
}

:deep(.hl-comment) {
  color: var(--vp-c-text-3);
  font-style: italic;
}

:deep(.hl-op) {
  color: #dc2626;
  font-weight: 700;
}

:global(.dark) :deep(.hl-op) {
  color: #f87171;
}

:deep(.hl-addr) {
  color: var(--vp-c-text-3);
}

:deep(.hl-reg) {
  color: #0284c7;
  font-weight: 600;
}

/* SUPPORT BANNER */
.support-banner {
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  padding: 4.5rem 2.5rem;
  text-align: center;
  position: relative;
}

.banner-title {
  font-size: 2.25rem;
  font-weight: 800;
  line-height: 1.25;
  margin: 0 0 1rem;
  letter-spacing: -0.6px;
}

.banner-desc {
  font-size: 1.05rem;
  color: var(--vp-c-text-2);
  max-width: 650px;
  margin: 0 auto 2.5rem;
  line-height: 1.65;
}

.banner-actions {
  display: flex;
  justify-content: center;
  gap: 1.25rem;
  flex-wrap: wrap;
}

/* RESPONSIVE BREAKPOINTS */
@media (max-width: 900px) {
  .shortcut-narrative {
    grid-template-columns: 1fr;
    gap: 2rem;
  }
  .vfs-grid {
    grid-template-columns: 1fr;
  }
  .vfs-cell {
    padding: 2.25rem 1.85rem;
  }
  .vfs-cell-custom-highlight {
    grid-template-columns: 1fr;
    gap: 1.75rem;
    padding: 2.25rem 1.85rem;
  }
  .remote-showcase-section {
    margin-bottom: 4rem;
  }
  .http-vfs-box {
    grid-template-columns: 1fr;
    gap: 2rem;
    padding: 0;
  }
  .usecases-grid {
    grid-template-columns: 1fr;
  }
  .usecase-cell {
    padding: 2.25rem 1.85rem;
  }
  .features-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  .hero-stats {
    grid-template-columns: repeat(2, 1fr);
  }
  .compare-table-wrapper {
    margin-top: 1rem;
  }
}

@media (max-width: 640px) {
  .webdb-landing {
    padding: 1.5rem 1rem 4rem;
  }
  .hero-section {
    padding: 1.5rem 0.25rem 3rem;
  }
  .hero-eyebrow {
    font-size: 0.75rem;
    padding: 0.3rem 0.75rem;
    margin-bottom: 1.5rem;
  }
  .hero-title {
    font-size: 2.15rem;
    letter-spacing: -0.8px;
    line-height: 1.2;
    margin-bottom: 1.25rem;
  }
  .hero-lead {
    font-size: 0.98rem;
    line-height: 1.55;
    margin-bottom: 2rem;
  }
  .hero-actions {
    flex-direction: column;
    width: 100%;
    gap: 0.75rem;
  }
  .hero-actions .btn {
    width: 100%;
    justify-content: center;
    padding: 0.8rem 1.5rem;
    min-height: 44px;
  }
  .hero-stats {
    grid-template-columns: 1fr;
    gap: 0.85rem;
    margin-top: 2.5rem;
  }
  .stat-card {
    padding: 1.35rem 1.25rem;
  }
  .stat-val {
    font-size: 1.65rem;
  }
  .section-box {
    margin-bottom: 3.5rem;
  }
  .section-heading {
    font-size: 1.55rem;
    letter-spacing: -0.4px;
    line-height: 1.25;
    margin-bottom: 0.75rem;
  }
  .section-sub {
    font-size: 0.92rem;
    line-height: 1.55;
    margin-bottom: 2rem;
  }
  .usecases-grid {
    grid-template-columns: 1fr;
  }
  .usecase-cell {
    padding: 1.5rem 1.15rem;
  }
  .usecase-title {
    font-size: 1.15rem;
    line-height: 1.3;
  }
  .vfs-grid {
    grid-template-columns: 1fr;
  }
  .vfs-cell {
    padding: 1.5rem 1.15rem;
  }
  .vfs-title {
    font-size: 1.15rem;
    line-height: 1.3;
  }
  .vfs-cell-custom-highlight {
    grid-template-columns: 1fr;
    padding: 1.5rem 1.15rem;
    gap: 1.5rem;
  }
  .remote-showcase-section {
    margin-bottom: 3.5rem;
  }
  .http-vfs-box {
    grid-template-columns: 1fr;
    padding: 0;
    gap: 1.5rem;
  }
  .flow-signal-line {
    height: 48px;
    padding-left: 1.25rem;
  }
  .compare-table thead th,
  .compare-table tbody td {
    padding: 1rem 1rem;
  }
  .features-grid {
    grid-template-columns: 1fr;
  }
  .feat-box {
    padding: 1.5rem 1.15rem;
  }
  .feat-title {
    font-size: 1.1rem;
    line-height: 1.3;
  }
  .boxdraw-container {
    padding: 1.25rem 0.85rem;
    margin: 2rem 0 1.5rem;
  }
  .boxdraw-box {
    max-width: 100%;
    font-size: 0.82rem;
    padding: 0.65rem 0.85rem;
  }
  .caption-text {
    font-size: 0.78rem;
    line-height: 1.45;
  }
  .terminal-box {
    margin-top: 1.25rem;
  }
  .tab-btn {
    padding: 0.65rem 0.75rem;
    font-size: 0.72rem;
  }
  .copy-btn {
    padding: 0.3rem 0.65rem;
    font-size: 0.68rem;
    min-height: 36px;
  }
  .terminal-body {
    padding: 1rem 0.25rem;
    font-size: 0.78rem;
  }
  .banner-title {
    font-size: 1.65rem;
    letter-spacing: -0.4px;
    line-height: 1.25;
  }
  .banner-desc {
    font-size: 0.92rem;
    line-height: 1.55;
    margin-bottom: 1.75rem;
  }
  .banner-actions {
    flex-direction: column;
    width: 100%;
    gap: 0.75rem;
  }
  .banner-actions .btn {
    width: 100%;
    justify-content: center;
    padding: 0.8rem 1.5rem;
    min-height: 44px;
  }
}
</style>
