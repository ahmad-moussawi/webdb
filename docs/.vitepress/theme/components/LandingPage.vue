<script setup lang="ts">
import { ref, computed } from 'vue';
import { withBase } from 'vitepress';

const activeTab = ref<'query' | 'http' | 'schema' | 'tx' | 'explain'>('query');

const codeSnippets: Record<'query' | 'http' | 'schema' | 'tx' | 'explain', string> = {
  query: `// Fluent query compiled directly into flat 16-byte bytecode
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

  schema: `// Define schema stored directly on Page 1 (Binary Master Table)
await db.createTable("users", [
  { name: "id", type: "UUID", flags: { primaryKey: true } }, // Native 16B binary slice
  { name: "name", type: "TEXT", flags: { notNull: true } },
  { name: "age", type: "INT32" },
  { name: "score", type: "FLOAT64" },
  { name: "embedding", type: "VECTOR", dimensions: 128 },    // Wasm SIMD accelerated
]);

await db.createIndex("users", "score");`,

  tx: `// ACID Transactions with Write-Ahead Logging (WAL)
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

  explain: `// Query Inspection & Virtual Machine Disassembly
const plan = await db.from("users").where("score", ">", 80.0).explain();
console.log(plan.assembly);

/*
ADDR  OPCODE          P1   P2   P3   COMMENT
0000  OP_INIT          0    0    0   Start VM context
0001  OP_CURSOR_OPEN   0    2    0   Open table 'users'
0002  OP_NEXT_ROW      0    6    0   Advance slot cursor
0003  OP_COLUMN        0    3    1   Load 'score' into r[1]
0004  OP_GT            1   80    2   Compare score > 80.0
0005  OP_EMIT_ROW      0    0    0   Emit row to result buffer
0006  OP_HALT          0    0    0   Halt VM
*/`
};

function highlightCode(code: string, tab: string): string {
  let html = code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  if (tab === 'explain') {
    html = html.replace(/\/\*[\s\S]*?\*\//g, (m) => `<span class="hl-comment">${m}</span>`);
    html = html.replace(/\b(OP_[A-Z_]+)\b/g, `<span class="hl-op">$1</span>`);
    html = html.replace(/^([0-9]{4})\b/gm, `<span class="hl-addr">$1</span>`);
    html = html.replace(/\b(r\[\d+\])\b/g, `<span class="hl-reg">$1</span>`);
    html = html.replace(/\/\/.*/g, (m) => `<span class="hl-comment">${m}</span>`);
    return html;
  }

  // Hide comments temporarily
  const comments: string[] = [];
  html = html.replace(/\/\/.*/g, (m) => {
    comments.push(`<span class="hl-comment">${m}</span>`);
    return `___COMMENT_${comments.length - 1}___`;
  });

  // Strings
  html = html.replace(/(&quot;.*?&quot;|'.*?'|`.*?`)/g, `<span class="hl-str">$1</span>`);

  // Keywords
  html = html.replace(/\b(await|async|const|let|var|function|return|true|false|null|import|from|new)\b/g, `<span class="hl-kw">$1</span>`);

  // Column / Value Types
  html = html.replace(/\b(UUID|ULID|TEXT|INT32|FLOAT64|VECTOR|BLOB|WebDB|HttpVfsAdapter)\b/g, `<span class="hl-type">$1</span>`);

  // Numbers
  html = html.replace(/\b(\d+(\.\d+)?)\b/g, `<span class="hl-num">$1</span>`);

  // Method Names
  html = html.replace(/\b(createTable|createIndex|from|where|whereNotNull|orderBy|limit|toArray|transaction|insert|update|explain|open)\b(?=\()/g, `<span class="hl-fn">$1</span>`);

  // Restore comments
  html = html.replace(/___COMMENT_(\d+)___/g, (_, idx) => comments[Number(idx)]);

  return html;
}

const renderedLines = computed(() => {
  const highlighted = highlightCode(codeSnippets[activeTab.value], activeTab.value);
  return highlighted.split('\n');
});

const httpVfsSnippet = `import { WebDB, HttpVfsAdapter } from "@webdb/core";

// 1. Mount remote database hosted on CDN / S3 / R2
const db = await WebDB.open({
  vfs: new HttpVfsAdapter(
    "https://cdn.example.com/datasets/ecommerce.webdb",
    {
      cacheSize: 64, // Keep 64 hot pages in memory (256 KB)
      maxConcurrentRequests: 4,
    }
  ),
});

// 2. Query executes immediately without downloading the full file!
// Only 2-3 targeted 4KB pages (~12 KB total) are transferred over the wire.
const products = await db
  .from("products")
  .where("category", "=", "Electronics")
  .where("in_stock", "=", true)
  .orderBy("rating", "desc")
  .limit(10)
  .toArray();

console.table(products);`;

const httpSnippetLines = computed(() => {
  return highlightCode(httpVfsSnippet, 'http').split('\n');
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
        <img :src="withBase('/logo.svg')" alt="WebDB Logo" width="20" height="20" class="eyebrow-logo" />
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
        An ultra-lean &lt;50 KB WebAssembly engine with true SQL power, 4KB slotted pages, 
        and native async persistence over OPFS &amp; IndexedDB.
      </p>

      <div class="hero-actions">
        <a :href="withBase('/getting-started')" class="btn btn-primary">
          <span>Get Started</span>
          <span class="btn-arrow">→</span>
        </a>
        <a href="https://github.com/ahmad-moussawi/webdb" target="_blank" rel="noopener" class="btn btn-secondary">
          <span>GitHub</span>
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="star-icon">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>
        </a>
      </div>

      <!-- HERO STATS BAR (VIBRANT & DISTINCT) -->
      <div class="hero-stats">
        <!-- STAT 1: WASM SIZE -->
        <div class="stat-card stat-cyan">
          <div class="stat-card-top">
            <div class="stat-icon-box">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter">
                <rect width="16" height="16" x="4" y="4" />
                <rect width="6" height="6" x="9" y="9" />
                <path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>
              </svg>
            </div>
            <span class="stat-tag">BINARY</span>
          </div>
          <div class="stat-val">&lt; 50 KB</div>
          <div class="stat-label">Wasm Binary Size</div>
          <div class="stat-desc">90%+ smaller than SQLite Wasm</div>
        </div>

        <!-- STAT 2: ASYNC VFS -->
        <div class="stat-card stat-emerald">
          <div class="stat-card-top">
            <div class="stat-icon-box">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter">
                <ellipse cx="12" cy="5" rx="9" ry="3"/>
                <path d="M3 5v14a9 3 0 0 0 18 0V5"/>
                <path d="M3 12a9 3 0 0 0 18 0"/>
              </svg>
            </div>
            <span class="stat-tag">STORAGE</span>
          </div>
          <div class="stat-val">OPFS + IDB</div>
          <div class="stat-label">Dual Async VFS</div>
          <div class="stat-desc">Native non-blocking browser I/O</div>
        </div>

        <!-- STAT 3: ZERO ALLOCS -->
        <div class="stat-card stat-amber">
          <div class="stat-card-top">
            <div class="stat-icon-box">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter">
                <path d="m12 14 4-4"/>
                <path d="M3.34 19a10 10 0 1 1 17.32 0"/>
              </svg>
            </div>
            <span class="stat-tag">MEMORY</span>
          </div>
          <div class="stat-val">0 Bytes</div>
          <div class="stat-label">Heap Allocations</div>
          <div class="stat-desc">Zero-heap hot execution loop</div>
        </div>

        <!-- STAT 4: NATIVE -->
        <div class="stat-card stat-violet">
          <div class="stat-card-top">
            <div class="stat-icon-box">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter">
                <circle cx="12" cy="12" r="10"/>
                <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/>
                <path d="M2 12h20"/>
              </svg>
            </div>
            <span class="stat-tag">STANDARDS</span>
          </div>
          <div class="stat-val">100% Native</div>
          <div class="stat-label">Browser Integration</div>
          <div class="stat-desc">Direct Web API delegation</div>
        </div>
      </div>
    </header>

    <!-- SECTION 2: TARGET WORKLOADS & REAL-WORLD USAGE -->
    <section class="section-box">
      <h2 class="section-heading">Built for the Modern Browser Experience</h2>
      <p class="section-sub">
        WebDB bridges the gap between fragile key-value stores and heavyweight desktop Wasm ports. Here is where it excels in production web applications:
      </p>

      <div class="usecases-grid">
        <!-- CELL 1: OFFLINE-FIRST -->
        <div class="usecase-cell usecase-theme-emerald">
          <div class="usecase-cell-header">
            <div class="usecase-icon-box">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter">
                <line x1="1" y1="1" x2="23" y2="23"/>
                <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/>
                <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/>
                <path d="M10.71 5.05A16 16 0 0 1 22.56 9"/>
                <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/>
                <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>
                <line x1="12" y1="20" x2="12.01" y2="20"/>
              </svg>
            </div>
            <div class="usecase-cell-meta">
              <span class="usecase-num">01</span>
              <span class="usecase-pill">OFFLINE_SYNC</span>
            </div>
          </div>
          <h3 class="usecase-title">Offline-First Web Apps &amp; PWAs</h3>
          <p class="usecase-text">
            Eliminate spinners and network stalls. Render immediately from local storage, journal mutations into the Write-Ahead Log while disconnected, and seamlessly synchronize deltas upon reconnection.
          </p>
        </div>

        <!-- CELL 2: LOCAL-FIRST -->
        <div class="usecase-cell usecase-theme-cyan">
          <div class="usecase-cell-header">
            <div class="usecase-icon-box">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter">
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
                <circle cx="9" cy="7" r="4"/>
                <path d="M22 21v-2a4 4 0 0 0-3-3.87"/>
                <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
              </svg>
            </div>
            <div class="usecase-cell-meta">
              <span class="usecase-num">02</span>
              <span class="usecase-pill">LOCAL_FIRST</span>
            </div>
          </div>
          <h3 class="usecase-title">Local-First Productivity &amp; SaaS</h3>
          <p class="usecase-text">
            Build Notion, Linear, or Figma-grade creative suites where user documents reside directly in the client. Multi-tab concurrency is safely coordinated via Web Locks without server trips.
          </p>
        </div>

        <!-- CELL 3: BROWSER AI -->
        <div class="usecase-cell usecase-theme-violet">
          <div class="usecase-cell-header">
            <div class="usecase-icon-box">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter">
                <path d="M12 2v4"/><path d="M12 18v4"/><path d="M4.93 4.93l2.83 2.83"/><path d="M16.24 16.24l2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="M4.93 19.07l2.83-2.83"/><path d="M16.24 7.76l2.83-2.83"/>
              </svg>
            </div>
            <div class="usecase-cell-meta">
              <span class="usecase-num">03</span>
              <span class="usecase-pill">BROWSER_AI</span>
            </div>
          </div>
          <h3 class="usecase-title">Client-Side AI &amp; Vector Embeddings</h3>
          <p class="usecase-text">
            Store high-dimensional vector embeddings generated by WebLLM or Transformers.js. Perform cosine similarity searches with 128-bit Wasm SIMD directly in the browser for instant local RAG.
          </p>
        </div>

        <!-- CELL 4: CDN STREAMING -->
        <div class="usecase-cell usecase-theme-amber">
          <div class="usecase-cell-header">
            <div class="usecase-icon-box">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter">
                <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/>
                <path d="M12 12v9"/><path d="m8 17 4 4 4-4"/>
              </svg>
            </div>
            <div class="usecase-cell-meta">
              <span class="usecase-num">04</span>
              <span class="usecase-pill">HTTP_RANGE</span>
            </div>
          </div>
          <h3 class="usecase-title">Static CDN Dataset Streaming</h3>
          <p class="usecase-text">
            Host multi-gigabyte catalogs, documentation archives, or geographic datasets as read-only databases on S3 or Cloudflare R2. Query pages on-demand via HTTP Range requests without full downloads.
          </p>
        </div>

        <!-- CELL 5: PRIVACY-FIRST -->
        <div class="usecase-cell usecase-theme-rose">
          <div class="usecase-cell-header">
            <div class="usecase-icon-box">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter">
                <rect width="18" height="11" x="3" y="11" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
              </svg>
            </div>
            <div class="usecase-cell-meta">
              <span class="usecase-num">05</span>
              <span class="usecase-pill">ZERO_KNOWLEDGE</span>
            </div>
          </div>
          <h3 class="usecase-title">Privacy-Centric Personal Vaults</h3>
          <p class="usecase-text">
            Healthcare portals, password managers, financial ledgers, and journaling apps where customer data must never touch your backend unencrypted. The database lives and dies on the client device.
          </p>
        </div>

        <!-- CELL 6: EDGE ANALYTICS -->
        <div class="usecase-cell usecase-theme-indigo">
          <div class="usecase-cell-header">
            <div class="usecase-icon-box">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter">
                <line x1="18" y1="20" x2="18" y2="10"/>
                <line x1="12" y1="20" x2="12" y2="4"/>
                <line x1="6" y1="20" x2="6" y2="14"/>
              </svg>
            </div>
            <div class="usecase-cell-meta">
              <span class="usecase-num">06</span>
              <span class="usecase-pill">EDGE_ANALYTICS</span>
            </div>
          </div>
          <h3 class="usecase-title">In-Browser Analytics &amp; Dashboards</h3>
          <p class="usecase-text">
            Offload complex multi-table aggregations, filtering, and joins from your API servers directly into the user's browser. Transform raw CSVs or JSON payloads into relational tables on the fly.
          </p>
        </div>
      </div>
    </section>

    <!-- SECTION 3: ARCHITECTURE & PIPELINE (ZERO-AST DATAFLOW) -->
    <section class="section-box">
      <h2 class="section-heading">Zero-AST Execution Path</h2>
      <p class="section-sub">
        Standard ported databases parse text SQL strings at runtime into heavy ASTs. WebDB's TypeScript query builder compiles directly into flat 16-byte register instructions.
      </p>

      <div class="pipeline-board">
        <div class="pipeline-step">
          <div class="step-num">01 // QUERY</div>
          <div class="step-title">Fluent Builder</div>
          <div class="step-code"><code>db.from("users").where(...)</code></div>
          <div class="step-desc">Strongly typed TypeScript API. Zero SQL string parsing runtime cost.</div>
        </div>
        <div class="pipeline-connector">
          <span class="connector-arrow">▶</span>
        </div>
        <div class="pipeline-step">
          <div class="step-num">02 // COMPILER</div>
          <div class="step-title">Bytecode Compiler</div>
          <div class="step-code"><code>Direct-to-Bytes Engine</code></div>
          <div class="step-desc">Emits flat 16-byte VDBE opcodes directly into contiguous memory.</div>
        </div>
        <div class="pipeline-connector">
          <span class="connector-arrow">▶</span>
        </div>
        <div class="pipeline-step">
          <div class="step-num">03 // ENGINE</div>
          <div class="step-title">32-Reg VDBE VM</div>
          <div class="step-code"><code>Zero-Heap Loop (Wasm)</code></div>
          <div class="step-desc">Tight C-style bytecode loop yields cleanly on page faults without Asyncify.</div>
        </div>
        <div class="pipeline-connector">
          <span class="connector-arrow">▶</span>
        </div>
        <div class="pipeline-step">
          <div class="step-num">04 // STORAGE</div>
          <div class="step-title">Slotted Storage</div>
          <div class="step-code"><code>4KB Pages + WAL</code></div>
          <div class="step-desc">Pluggable async I/O via OPFS SyncHandle, IndexedDB, or CDN HTTP range requests.</div>
        </div>
      </div>
    </section>

    <!-- SECTION 4: THE PROBLEM VS THE SOLUTION -->
    <section class="section-box">
      <h2 class="section-heading">Why Porting Desktop Databases to the Web Fails</h2>
      <p class="section-sub">
        Web developers have been forced to choose between the awkward key-value cursors of IndexedDB or multi-megabyte desktop engines ported with Emscripten. WebDB rethinks the database engine specifically for web runtime constraints.
      </p>

      <div class="comparison-grid">
        <!-- OLD WAY -->
        <div class="compare-card compare-legacy">
          <div class="card-header">
            <span class="tag-danger">PORTED DESKTOP ENGINES (SQLite / PGlite)</span>
          </div>
          <ul class="compare-list">
            <li>
              <span class="bullet-cross">✕</span>
              <div>
                <strong>1 MB – 5 MB+ Binary Bloat:</strong>
                Drags along redundant text SQL parsers, lexers, AST tables, and heavy ICU unicode bundles.
              </div>
            </li>
            <li>
              <span class="bullet-cross">✕</span>
              <div>
                <strong>Emscripten Asyncify Penalty:</strong>
                Fakes synchronous POSIX I/O over async browser storage by repeatedly unwinding and rewinding the C call stack.
              </div>
            </li>
            <li>
              <span class="bullet-cross">✕</span>
              <div>
                <strong>POSIX Pthread Baggage:</strong>
                Bundles thread-synchronization primitives into single-threaded browser environments, requiring complex <code>COOP</code>/<code>COEP</code> headers.
              </div>
            </li>
            <li>
              <span class="bullet-cross">✕</span>
              <div>
                <strong>Duplicate C Shims:</strong>
                Re-implements regex, date math, and cryptographic algorithms already natively hardware-accelerated in the browser.
              </div>
            </li>
          </ul>
        </div>

        <!-- WEBDB WAY -->
        <div class="compare-card compare-webdb">
          <div class="card-header">
            <span class="tag-success">WEBDB ENGINE ARCHITECTURE</span>
          </div>
          <ul class="compare-list">
            <li>
              <span class="bullet-check">✓</span>
              <div>
                <strong>&lt;50 KB Razor-Sharp Binary:</strong>
                Eliminates the SQL text lexer from Wasm. The TypeScript query builder compiles directly to executable binary bytecode.
              </div>
            </li>
            <li>
              <span class="bullet-check">✓</span>
              <div>
                <strong>Async VFS by Heart:</strong>
                VDBE execution suspends cleanly via non-blocking page faults. Zero stack manipulation. Works over OPFS, IndexedDB, or HTTP Range requests.
              </div>
            </li>
            <li>
              <span class="bullet-check">✓</span>
              <div>
                <strong>Single-Threaded by Design:</strong>
                Built strictly for event-driven browser contexts. Multi-tab concurrency is cleanly managed via the native <code>navigator.locks</code> API.
              </div>
            </li>
            <li>
              <span class="bullet-check">✓</span>
              <div>
                <strong>Embraces Web Standards:</strong>
                Delegates to <code>Intl.Segmenter</code>, <code>crypto.subtle</code>, <code>Date</code>, and <code>RegExp</code> via zero-overhead synchronous UDFs.
              </div>
            </li>
          </ul>
        </div>
      </div>
    </section>

    <!-- SECTION 5: ASYNC VFS ARCHITECTURE & AVAILABLE ADAPTERS -->
    <section class="section-box">
      <h2 class="section-heading">Async VFS: Storage Built for the Web Platform</h2>
      <p class="section-sub">
        Standard C databases fail in browsers because POSIX assumes synchronous, blocking disk calls (<code>read</code>, <code>write</code>, <code>fsync</code>). WebDB’s VDBE bytecode machine is inherently asynchronous—it suspends execution on page cache misses, triggers non-blocking browser I/O, and resumes the instant the 4KB block arrives. Zero Emscripten stack-unwinding penalty.
      </p>

      <!-- 4 AVAILABLE VFS ADAPTERS GRID (2-CELL) -->
      <div class="vfs-grid">
        <!-- VFS 1: OPFS -->
        <div class="vfs-cell vfs-theme-emerald">
          <div class="vfs-cell-header">
            <div class="vfs-icon-box">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter">
                <ellipse cx="12" cy="5" rx="9" ry="3"/>
                <path d="M3 5v14a9 3 0 0 0 18 0V5"/>
                <path d="M3 12a9 3 0 0 0 18 0"/>
              </svg>
            </div>
            <div class="vfs-cell-meta">
              <span class="vfs-num">01</span>
              <span class="vfs-pill">OPFS</span>
            </div>
          </div>
          <h3 class="vfs-title">OPFS VFS</h3>
          <p class="vfs-desc">
            Direct access to the browser's Origin Private File System using <code>FileSystemSyncAccessHandle</code> inside dedicated Web Workers. Delivers near-native NVMe read/write throughput for high-frequency database persistence.
          </p>
        </div>

        <!-- VFS 2: INDEXEDDB -->
        <div class="vfs-cell vfs-theme-cyan">
          <div class="vfs-cell-header">
            <div class="vfs-icon-box">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter">
                <rect width="18" height="18" x="3" y="3"/>
                <path d="M3 9h18"/>
                <path d="M9 21V9"/>
              </svg>
            </div>
            <div class="vfs-cell-meta">
              <span class="vfs-num">02</span>
              <span class="vfs-pill">INDEXEDDB</span>
            </div>
          </div>
          <h3 class="vfs-title">IndexedDB VFS</h3>
          <p class="vfs-desc">
            Universal browser fallback running everywhere, including main thread contexts and mobile Safari on iOS. Stores rigid 4KB database pages as binary <code>ArrayBuffer</code> blobs with ACID transactional guarantees.
          </p>
        </div>

        <!-- VFS 3: MEMORY -->
        <div class="vfs-cell vfs-theme-violet">
          <div class="vfs-cell-header">
            <div class="vfs-icon-box">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter">
                <rect width="16" height="16" x="4" y="4"/>
                <rect width="6" height="6" x="9" y="9"/>
                <path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>
              </svg>
            </div>
            <div class="vfs-cell-meta">
              <span class="vfs-num">03</span>
              <span class="vfs-pill">IN_MEMORY</span>
            </div>
          </div>
          <h3 class="vfs-title">Memory VFS</h3>
          <p class="vfs-desc">
            In-memory volatile page store backed by flat <code>Uint8Array</code> buffers. Delivers sub-millisecond query execution for unit test fixtures, transient UI states, and isolated sandbox analytics.
          </p>
        </div>

        <!-- VFS 4: HTTP RANGE -->
        <div class="vfs-cell vfs-theme-amber">
          <div class="vfs-cell-header">
            <div class="vfs-icon-box">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter">
                <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/>
                <path d="M12 12v9"/><path d="m8 17 4 4 4-4"/>
              </svg>
            </div>
            <div class="vfs-cell-meta">
              <span class="vfs-num">04</span>
              <span class="vfs-pill">HTTP_RANGE</span>
            </div>
          </div>
          <h3 class="vfs-title">HTTP Range VFS</h3>
          <p class="vfs-desc">
            Stream read-only databases hosted on static CDNs or S3 buckets. Fetches 4KB pages on-demand using standard HTTP <code>Range: bytes=X-Y</code> headers with zero pre-downloading overhead.
          </p>
        </div>
      </div>

      <!-- HTTP VFS SHOWCASE & LIVE EXAMPLE -->
      <div class="http-vfs-box">
        <div class="http-vfs-content">
          <h3 class="http-vfs-title">Query a 5GB Database on S3 Over 16KB of Network</h3>
          <p class="http-vfs-desc">
            Instead of downloading the entire database to the client, <code>HttpVfsAdapter</code> turns static object storage into a serverless query engine. When your query executes, WebDB inspects its B+Tree indexes and requests <em>only the precise 4KB pages required</em>.
          </p>

          <div class="http-range-diagram">
            <div class="diagram-step">
              <span class="step-label">01 // QUERY EXECUTION</span>
              <span class="step-val"><code>db.from("products").where("sku", "=", "A900")</code></span>
            </div>
            <div class="diagram-arrow">▼</div>
            <div class="diagram-step">
              <span class="step-label">02 // BYTE-RANGE REQUEST</span>
              <span class="step-val"><code>GET /catalog.webdb (Range: bytes=12288-16383)</code></span>
            </div>
            <div class="diagram-arrow">▼</div>
            <div class="diagram-step">
              <span class="step-label">03 // INSTANT PAGE CACHE</span>
              <span class="step-val"><code>Leaf page parsed &amp; row emitted in 0.1ms</code></span>
            </div>
          </div>
        </div>

        <div class="http-vfs-code-wrap">
          <div class="code-header">
            <span class="code-file">HTTP_VFS_STREAMING.ts</span>
            <span class="code-badge">LIVE_CODE</span>
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
      <h2 class="section-heading">Engineered for Offline-First Applications</h2>
      <p class="section-sub">
        A low-level relational architecture designed for extreme memory efficiency and predictable browser execution.
      </p>

      <div class="features-grid">
        <div class="feat-box">
          <div class="feat-header">
            <span class="feat-code">01</span>
            <span class="feat-tag">Storage</span>
          </div>
          <h3 class="feat-title">Pluggable Async VFS</h3>
          <p class="feat-text">
            Co-equal support for bare-metal <strong>OPFS SyncAccessHandles</strong> in workers and universal <strong>IndexedDB</strong> in main thread/mobile Safari. Supports on-demand <strong>HTTP Range Request</strong> page streaming directly from S3/CDN.
          </p>
        </div>

        <div class="feat-box">
          <div class="feat-header">
            <span class="feat-code">02</span>
            <span class="feat-tag">Execution</span>
          </div>
          <h3 class="feat-title">32-Register Bytecode Machine</h3>
          <p class="feat-text">
            Replaces the classic Volcano iterator model (which destroys Wasm call stacks) with a flat, loop-driven register machine that yields cleanly on cache misses without dynamic memory allocation.
          </p>
        </div>

        <div class="feat-box">
          <div class="feat-header">
            <span class="feat-code">03</span>
            <span class="feat-tag">Reliability</span>
          </div>
          <h3 class="feat-title">Physical WAL Crash Recovery</h3>
          <p class="feat-text">
            Rigid 4,128-byte WAL frame architecture with CRC32 IEEE 802.3 checksums and atomic commit markers. Two-phase checkpointing guarantees 100% resilience against torn writes or sudden tab crashes.
          </p>
        </div>

        <div class="feat-box">
          <div class="feat-header">
            <span class="feat-code">04</span>
            <span class="feat-tag">Identity</span>
          </div>
          <h3 class="feat-title">Native Binary UUID &amp; ULID</h3>
          <p class="feat-text">
            Stored as compact 16-byte fixed binary slices (58% smaller than text UUIDs). Time-ordered UUIDv7 and ULID append sequentially to B+Tree leaves with near-zero page splits or fragmentation.
          </p>
        </div>

        <div class="feat-box">
          <div class="feat-header">
            <span class="feat-code">05</span>
            <span class="feat-tag">Extensibility</span>
          </div>
          <h3 class="feat-title">Synchronous JavaScript UDFs</h3>
          <p class="feat-text">
            Register arbitrary JS functions callable directly from bytecode. Query filters execute native browser regex and date comparisons at near-native speeds through shared memory.
          </p>
        </div>

        <div class="feat-box">
          <div class="feat-header">
            <span class="feat-code">06</span>
            <span class="feat-tag">Search</span>
          </div>
          <h3 class="feat-title">Vector &amp; BM25 Hybrid Search</h3>
          <p class="feat-text">
            Designed to support 128-bit Wasm SIMD vector embeddings (<code>VECTOR</code>), Okapi BM25 full-text search with <code>Intl.Segmenter</code>, and transparent AES-256-GCM page encryption.
          </p>
        </div>
      </div>
    </section>

    <!-- SECTION 7: INTERACTIVE CODE SHOWCASE -->
    <section class="section-box code-section">
      <h2 class="section-heading">Simple, Type-Safe API</h2>
      <p class="section-sub">
        Explore how schema creation, queries, transactions, and virtual machine disassembly work in practice.
      </p>

      <div class="terminal-box">
        <div class="terminal-bar">
          <div class="tab-list">
            <button
              :class="['tab-btn', { active: activeTab === 'query' }]"
              @click="activeTab = 'query'"
            >
              QUERY_BUILDER.ts
            </button>
            <button
              :class="['tab-btn', { active: activeTab === 'http' }]"
              @click="activeTab = 'http'"
            >
              HTTP_VFS.ts
            </button>
            <button
              :class="['tab-btn', { active: activeTab === 'schema' }]"
              @click="activeTab = 'schema'"
            >
              SCHEMA_DDL.ts
            </button>
            <button
              :class="['tab-btn', { active: activeTab === 'tx' }]"
              @click="activeTab = 'tx'"
            >
              TRANSACTION_WAL.ts
            </button>
            <button
              :class="['tab-btn', { active: activeTab === 'explain' }]"
              @click="activeTab = 'explain'"
            >
              VDBE_DISASM.asm
            </button>
          </div>
          <button class="copy-btn" @click="copyCode">
            {{ copyStatus ? 'COPIED ✓' : 'COPY' }}
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
          WebDB is an open initiative to give web developers the fast, lightweight database they deserve.
          Star the repo, review our architecture blueprints, and join the discussion!
        </p>
        <div class="banner-actions">
          <a
            href="https://github.com/ahmad-moussawi/webdb"
            target="_blank"
            rel="noopener"
            class="btn btn-primary"
          >
            <span>STAR ON GITHUB</span>
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="star-icon">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
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
  font-weight: 900;
  letter-spacing: -2.2px;
  line-height: 1.08;
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
  transition: transform 0.2s ease, fill 0.2s ease;
}

.btn:hover .star-icon {
  fill: #f59e0b;
  transform: scale(1.15) rotate(6deg);
}

/* HERO STATS BAR (VIBRANT & DISTINCT) */
.hero-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1.25rem;
  margin-top: 5rem;
  text-align: left;
}

.stat-card {
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  padding: 1.75rem 1.4rem;
  position: relative;
  display: flex;
  flex-direction: column;
  transition: transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
  border-top: 3px solid transparent;
}

.stat-card:hover {
  transform: translateY(-2px);
}

.stat-card-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.25rem;
}

.stat-icon-box {
  width: 38px;
  height: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
}

.stat-tag {
  font-family: var(--vp-font-family-mono);
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.5px;
  padding: 2px 6px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-3);
}

.stat-val {
  font-family: var(--vp-font-family-mono);
  font-size: 1.65rem;
  font-weight: 900;
  letter-spacing: -0.5px;
  line-height: 1.15;
  margin-bottom: 0.4rem;
}

.stat-label {
  font-size: 0.92rem;
  font-weight: 700;
  color: var(--vp-c-text-1);
  margin-bottom: 0.35rem;
}

.stat-desc {
  font-size: 0.78rem;
  color: var(--vp-c-text-3);
  line-height: 1.45;
}

/* THEMED VIBRANT ACCENTS */
/* 1. CYAN / SKY */
.stat-cyan {
  border-top-color: #0284c7;
}
.stat-cyan .stat-icon-box {
  background: rgba(14, 165, 233, 0.1);
  border-color: rgba(14, 165, 233, 0.25);
  color: #0284c7;
}
:global(.dark) .stat-cyan {
  border-top-color: #38bdf8;
}
:global(.dark) .stat-cyan .stat-icon-box {
  background: rgba(56, 189, 248, 0.15);
  border-color: rgba(56, 189, 248, 0.35);
  color: #38bdf8;
}
.stat-cyan .stat-val {
  color: #0284c7;
}
:global(.dark) .stat-cyan .stat-val {
  color: #38bdf8;
}

/* 2. EMERALD */
.stat-emerald {
  border-top-color: #059669;
}
.stat-emerald .stat-icon-box {
  background: rgba(16, 185, 129, 0.1);
  border-color: rgba(16, 185, 129, 0.25);
  color: #059669;
}
:global(.dark) .stat-emerald {
  border-top-color: #34d399;
}
:global(.dark) .stat-emerald .stat-icon-box {
  background: rgba(52, 211, 153, 0.15);
  border-color: rgba(52, 211, 153, 0.35);
  color: #34d399;
}
.stat-emerald .stat-val {
  color: #059669;
}
:global(.dark) .stat-emerald .stat-val {
  color: #34d399;
}

/* 3. AMBER / ORANGE */
.stat-amber {
  border-top-color: #d97706;
}
.stat-amber .stat-icon-box {
  background: rgba(245, 158, 11, 0.1);
  border-color: rgba(245, 158, 11, 0.25);
  color: #d97706;
}
:global(.dark) .stat-amber {
  border-top-color: #fbbf24;
}
:global(.dark) .stat-amber .stat-icon-box {
  background: rgba(251, 191, 36, 0.15);
  border-color: rgba(251, 191, 36, 0.35);
  color: #fbbf24;
}
.stat-amber .stat-val {
  color: #d97706;
}
:global(.dark) .stat-amber .stat-val {
  color: #fbbf24;
}

/* 4. VIOLET / PURPLE */
.stat-violet {
  border-top-color: #7c3aed;
}
.stat-violet .stat-icon-box {
  background: rgba(168, 85, 247, 0.1);
  border-color: rgba(168, 85, 247, 0.25);
  color: #7c3aed;
}
:global(.dark) .stat-violet {
  border-top-color: #c084fc;
}
:global(.dark) .stat-violet .stat-icon-box {
  background: rgba(192, 132, 252, 0.15);
  border-color: rgba(192, 132, 252, 0.35);
  color: #c084fc;
}
.stat-violet .stat-val {
  color: #7c3aed;
}
:global(.dark) .stat-violet .stat-val {
  color: #c084fc;
}

/* SECTION CONTAINER */
.section-box {
  margin-bottom: 6rem;
}

.section-heading {
  font-size: 2.1rem;
  font-weight: 800;
  letter-spacing: -0.6px;
  margin: 0 0 0.85rem;
}

.section-sub {
  color: var(--vp-c-text-2);
  font-size: 1.05rem;
  line-height: 1.65;
  max-width: 820px;
  margin: 0 0 3rem;
}

/* USECASES GRID (2-CELL WITH BLACK BORDER & WHITE BACKGROUND) */
.usecases-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 1px;
  background: #000000;
  border: 1px solid #000000;
}

:global(.dark) .usecases-grid {
  background: var(--vp-c-divider);
  border-color: var(--vp-c-divider);
}

.usecase-cell {
  padding: 3rem 2.5rem;
  display: flex;
  flex-direction: column;
  position: relative;
  background: #ffffff;
  transition: background 0.15s ease;
}

.usecase-cell:hover {
  background: #fafafa;
}

:global(.dark) .usecase-cell {
  background: var(--vp-c-bg);
}

:global(.dark) .usecase-cell:hover {
  background: var(--vp-c-bg-mute);
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
  border: 1px solid #000000;
  background: #ffffff;
  color: #000000;
  letter-spacing: 0.5px;
}

:global(.dark) .usecase-pill {
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
.usecase-theme-emerald .usecase-icon-box {
  background: rgba(16, 185, 129, 0.08);
  border-color: rgba(16, 185, 129, 0.2);
  color: #10b981;
}
:global(.dark) .usecase-theme-emerald .usecase-icon-box {
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

/* ZERO-AST PIPELINE BOARD */
.pipeline-board {
  display: flex;
  align-items: stretch;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  gap: 0;
}

.pipeline-step {
  flex: 1;
  padding: 1.75rem 1.5rem;
  background: var(--vp-c-bg);
  border-right: 1px solid var(--vp-c-divider);
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.pipeline-step:last-child {
  border-right: none;
}

.pipeline-connector {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--vp-c-bg-mute);
  padding: 0 0.5rem;
  color: var(--vp-c-brand-1);
  font-weight: 900;
  border-right: 1px solid var(--vp-c-divider);
}

.connector-arrow {
  font-size: 0.8rem;
}

.step-num {
  font-family: var(--vp-font-family-mono);
  font-size: 0.72rem;
  font-weight: 700;
  color: var(--vp-c-brand-1);
  letter-spacing: 0.5px;
}

.step-title {
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--vp-c-text-1);
}

.step-code {
  font-size: 0.78rem;
  font-family: var(--vp-font-family-mono);
  color: var(--vp-c-text-2);
}

.step-desc {
  font-size: 0.82rem;
  color: var(--vp-c-text-3);
  line-height: 1.5;
  margin-top: 0.35rem;
}

/* COMPARISON CARDS */
.comparison-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2rem;
}

.compare-card {
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  padding: 2.25rem 2rem;
}

.compare-legacy {
  border-left: 3px solid #ef4444;
}

.compare-webdb {
  border-left: 3px solid var(--vp-c-brand-1);
}

.card-header {
  margin-bottom: 1.5rem;
}

.tag-danger {
  font-family: var(--vp-font-family-mono);
  font-size: 0.78rem;
  font-weight: 700;
  color: #ef4444;
  letter-spacing: 0.5px;
}

.tag-success {
  font-family: var(--vp-font-family-mono);
  font-size: 0.78rem;
  font-weight: 700;
  color: var(--vp-c-brand-1);
  letter-spacing: 0.5px;
}

.compare-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 1.35rem;
}

.compare-list li {
  display: flex;
  gap: 0.85rem;
  font-size: 0.94rem;
  line-height: 1.55;
  color: var(--vp-c-text-2);
}

.compare-list li strong {
  color: var(--vp-c-text-1);
  display: block;
  margin-bottom: 0.25rem;
}

.bullet-cross {
  color: #ef4444;
  font-weight: 800;
  font-size: 1rem;
}

.bullet-check {
  color: #10b981;
  font-weight: 800;
  font-size: 1rem;
}

/* ASYNC VFS GRID (2-CELL WITH BLACK BORDER & WHITE BACKGROUND) */
.vfs-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 1px;
  background: #000000;
  border: 1px solid #000000;
  margin-bottom: 2.5rem;
}

:global(.dark) .vfs-grid {
  background: var(--vp-c-divider);
  border-color: var(--vp-c-divider);
}

.vfs-cell {
  padding: 3rem 2.5rem;
  display: flex;
  flex-direction: column;
  position: relative;
  background: #ffffff;
  transition: background 0.15s ease;
}

.vfs-cell:hover {
  background: #fafafa;
}

:global(.dark) .vfs-cell {
  background: var(--vp-c-bg);
}

:global(.dark) .vfs-cell:hover {
  background: var(--vp-c-bg-mute);
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
  border: 1px solid #000000;
  background: #ffffff;
  color: #000000;
  letter-spacing: 0.5px;
}

:global(.dark) .vfs-pill {
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
.vfs-theme-emerald .vfs-num {
  color: #10b981;
}
.vfs-theme-emerald .vfs-icon-box {
  background: rgba(16, 185, 129, 0.08);
  border-color: rgba(16, 185, 129, 0.2);
  color: #10b981;
}
:global(.dark) .vfs-theme-emerald .vfs-icon-box {
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

/* HTTP VFS SHOWCASE BOX */
.http-vfs-box {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2.5rem;
  border: 1px solid #000000;
  background: #ffffff;
  padding: 3rem 2.5rem;
  align-items: start;
}

:global(.dark) .http-vfs-box {
  background: var(--vp-c-bg);
  border-color: var(--vp-c-divider);
}

.http-vfs-title {
  font-size: 1.5rem;
  font-weight: 800;
  letter-spacing: -0.5px;
  margin: 0 0 0.85rem;
  line-height: 1.25;
}

.http-vfs-desc {
  font-size: 0.95rem;
  line-height: 1.65;
  color: var(--vp-c-text-2);
  margin: 0 0 1.75rem;
}

/* RANGE REQUEST DIAGRAM */
.http-range-diagram {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
  background: #ffffff;
  border: 1px solid #000000;
  padding: 1.25rem;
}

:global(.dark) .http-range-diagram {
  background: var(--vp-c-bg-soft);
  border-color: var(--vp-c-divider);
}

.diagram-step {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  background: #fafafa;
  border: 1px solid #000000;
  padding: 0.85rem 1.1rem;
}

:global(.dark) .diagram-step {
  background: var(--vp-c-bg);
  border-color: var(--vp-c-divider);
}

.step-label {
  font-family: var(--vp-font-family-mono);
  font-size: 0.7rem;
  font-weight: 700;
  color: #000000;
  letter-spacing: 0.5px;
}

:global(.dark) .step-label {
  color: var(--vp-c-brand-1);
}

.step-val {
  font-family: var(--vp-font-family-mono);
  font-size: 0.8rem;
  color: var(--vp-c-text-1);
}

.diagram-arrow {
  color: #000000;
  font-size: 0.75rem;
  text-align: center;
  line-height: 1;
  opacity: 0.8;
}

:global(.dark) .diagram-arrow {
  color: var(--vp-c-brand-1);
}

/* HTTP VFS CODE EMBED */
.http-vfs-code-wrap {
  border: 1px solid #000000;
  background: #ffffff;
  overflow: hidden;
}

:global(.dark) .http-vfs-code-wrap {
  border-color: var(--vp-c-divider);
  background: var(--vp-c-bg);
}

.code-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #fafafa;
  border-bottom: 1px solid #000000;
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

/* FEATURES GRID */
.features-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1.5rem;
}

.feat-box {
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  padding: 2rem 1.75rem;
  transition: transform 0.15s ease, border-color 0.15s ease;
}

.feat-box:hover {
  border-color: var(--vp-c-brand-1);
  transform: translateY(-2px);
}

.feat-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-family: var(--vp-font-family-mono);
  font-size: 0.75rem;
  color: var(--vp-c-text-3);
  margin-bottom: 1rem;
}

.feat-code {
  color: var(--vp-c-brand-1);
  font-weight: 700;
}

.feat-tag {
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  padding: 2px 7px;
  font-size: 0.7rem;
  color: var(--vp-c-text-2);
  font-weight: 600;
}

.feat-title {
  font-size: 1.2rem;
  font-weight: 700;
  margin: 0 0 0.65rem;
  letter-spacing: -0.3px;
}

.feat-text {
  font-size: 0.9rem;
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
  .vfs-grid {
    grid-template-columns: 1fr;
  }
  .vfs-cell {
    padding: 2.25rem 1.85rem;
  }
  .http-vfs-box {
    grid-template-columns: 1fr;
    padding: 2.25rem 1.85rem;
  }
  .usecases-grid {
    grid-template-columns: 1fr;
  }
  .usecase-cell {
    padding: 2.25rem 1.85rem;
  }
  .pipeline-board {
    flex-direction: column;
  }
  .pipeline-step {
    border-right: none;
    border-bottom: 1px solid var(--vp-c-divider);
  }
  .pipeline-connector {
    display: none;
  }
  .features-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  .hero-stats {
    grid-template-columns: repeat(2, 1fr);
  }
  .comparison-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .webdb-landing {
    padding: 2rem 1.25rem 5rem;
  }
  .hero-section {
    padding: 2rem 0.5rem 4rem;
  }
  .hero-title {
    font-size: 2.5rem;
    letter-spacing: -1.2px;
  }
  .hero-lead {
    font-size: 1.05rem;
  }
  .hero-actions {
    flex-direction: column;
    width: 100%;
  }
  .hero-actions .btn {
    width: 100%;
    justify-content: center;
  }
  .hero-stats {
    grid-template-columns: repeat(2, 1fr);
    margin-top: 3rem;
  }
  .vfs-grid {
    grid-template-columns: 1fr;
  }
  .vfs-cell {
    padding: 1.85rem 1.35rem;
  }
  .http-vfs-box {
    padding: 1.85rem 1.35rem;
  }
  .usecase-cell {
    padding: 1.85rem 1.35rem;
  }
  .features-grid {
    grid-template-columns: 1fr;
  }
  .section-box {
    margin-bottom: 4rem;
  }
}
</style>
