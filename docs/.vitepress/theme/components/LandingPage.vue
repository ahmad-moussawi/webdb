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
    <!-- HERO SECTION -->
    <section class="hero-box">
      <div class="meta-tag">
        <span class="status-dot"></span>
        <code>ENGINE_STATUS: WALKING_SKELETON // V1.0_PROTOTYPE</code>
        <span class="badge-accent">EARLY_ACCESS</span>
      </div>

      <div class="hero-header">
        <div class="logo-box">
          <img :src="withBase('/logo.svg')" alt="WebDB Logo" width="72" height="72" />
        </div>
        <div class="title-group">
          <h1 class="hero-title">WebDB</h1>
          <p class="hero-lead">The Browser-Native Relational Database Engine</p>
        </div>
      </div>

      <p class="hero-desc">
        Built from scratch in C-style architecture compiling to <strong>&lt;50 KB WebAssembly</strong>.
        True SQL power, 4KB slotted pages, register-based VDBE execution, and async persistence via OPFS &amp; IndexedDB.
        <strong>No multi-megabyte bundle bloat. Zero Emscripten Asyncify hacks.</strong>
      </p>

      <div class="action-strip">
        <a :href="withBase('/getting-started')" class="btn btn-primary">
          <span>GET STARTED</span>
          <span class="btn-arrow">→</span>
        </a>
        <a :href="withBase('/plans/plan')" class="btn btn-secondary">
          <span>STRATEGIC PLAN</span>
        </a>
        <a href="https://github.com/ahmad-moussawi/webdb" target="_blank" rel="noopener" class="btn btn-ghost">
          <span>GITHUB ⭐</span>
        </a>
      </div>

      <!-- METRICS BAR -->
      <div class="metrics-grid">
        <div class="metric-card">
          <div class="metric-label">BINARY SIZE</div>
          <div class="metric-val">&lt; 50 KB</div>
          <div class="metric-sub">90%+ smaller than SQLite Wasm</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">ASYNC VFS</div>
          <div class="metric-val">OPFS + IDB</div>
          <div class="metric-sub">Native non-blocking async storage</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">RUNTIME ALLOCATIONS</div>
          <div class="metric-val">0 BYTES</div>
          <div class="metric-sub">Zero-heap hot execution loop</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">BROWSER INTEGRATION</div>
          <div class="metric-val">100% NATIVE</div>
          <div class="metric-sub">Zero duplicate C shims</div>
        </div>
      </div>
    </section>

    <!-- SECTION 2: APPLICATION DOMAINS & REAL-WORLD USAGE -->
    <section class="section-box">
      <div class="section-label">
        <span class="bracket">[</span> TARGET WORKLOADS &amp; REAL-WORLD USAGE <span class="bracket">]</span>
      </div>
      <h2 class="section-heading">Built for the Modern Browser Experience</h2>
      <p class="section-sub">
        WebDB bridges the gap between fragile key-value stores and heavyweight desktop Wasm ports. Here is where it excels in production web applications:
      </p>

      <div class="usecases-grid">
        <div class="usecase-card">
          <div class="usecase-badge">
            <span class="usecase-code">01 // OFFLINE-FIRST</span>
            <span class="usecase-tag">PWA_SYNC</span>
          </div>
          <h3 class="usecase-title">Offline-First Web Apps &amp; PWAs</h3>
          <p class="usecase-text">
            Eliminate spinners and network stalls. Render immediately from local storage, record mutations into the Write-Ahead Log while offline, and seamlessly sync deltas upon reconnection.
          </p>
          <div class="usecase-footer">
            <code>&gt; Zero-latency UI + WAL delta sync</code>
          </div>
        </div>

        <div class="usecase-card">
          <div class="usecase-badge">
            <span class="usecase-code">02 // LOCAL-FIRST</span>
            <span class="usecase-tag">COLLAB_SAAS</span>
          </div>
          <h3 class="usecase-title">Local-First Productivity &amp; SaaS</h3>
          <p class="usecase-text">
            Build Notion, Linear, or Figma-grade creative suites where user documents reside directly in the browser. Multi-tab concurrency is safely coordinated via Web Locks without server trips.
          </p>
          <div class="usecase-footer">
            <code>&gt; Multi-tab navigator.locks coordination</code>
          </div>
        </div>

        <div class="usecase-card">
          <div class="usecase-badge">
            <span class="usecase-code">03 // BROWSER AI</span>
            <span class="usecase-tag">EMBEDDINGS</span>
          </div>
          <h3 class="usecase-title">Client-Side AI &amp; Vector Search</h3>
          <p class="usecase-text">
            Store high-dimensional embeddings generated by WebLLM or Transformers.js. Perform cosine similarity searches with 128-bit Wasm SIMD directly in the browser for instant local RAG.
          </p>
          <div class="usecase-footer">
            <code>&gt; 128-dim SIMD vector search in Wasm</code>
          </div>
        </div>

        <div class="usecase-card">
          <div class="usecase-badge">
            <span class="usecase-code">04 // CDN STREAMING</span>
            <span class="usecase-tag">HTTP_RANGE</span>
          </div>
          <h3 class="usecase-title">Static CDN Dataset Streaming</h3>
          <p class="usecase-text">
            Host multi-gigabyte catalogs, documentation archives, or geographic datasets as read-only databases on S3 or Cloudflare R2. Query pages on-demand via HTTP Range requests without downloading the entire file.
          </p>
          <div class="usecase-footer">
            <code>&gt; 4KB page fetch over HTTP Range</code>
          </div>
        </div>

        <div class="usecase-card">
          <div class="usecase-badge">
            <span class="usecase-code">05 // PRIVACY-FIRST</span>
            <span class="usecase-tag">ZERO_KNOWLEDGE</span>
          </div>
          <h3 class="usecase-title">Privacy-Centric Personal Vaults</h3>
          <p class="usecase-text">
            Healthcare portals, password managers, financial ledgers, and journaling apps where customer data must never touch your backend unencrypted. The database lives and dies on the client device.
          </p>
          <div class="usecase-footer">
            <code>&gt; AES-256-GCM page-level encryption</code>
          </div>
        </div>

        <div class="usecase-card">
          <div class="usecase-badge">
            <span class="usecase-code">06 // EDGE ANALYTICS</span>
            <span class="usecase-tag">DASHBOARDS</span>
          </div>
          <h3 class="usecase-title">In-Browser Analytics &amp; Dashboards</h3>
          <p class="usecase-text">
            Offload complex multi-table aggregations, filtering, and joins from your API servers directly into the user's browser. Transform raw CSVs or JSON payloads into relational tables on the fly.
          </p>
          <div class="usecase-footer">
            <code>&gt; Fast in-memory joins &amp; aggregations</code>
          </div>
        </div>
      </div>
    </section>

    <!-- ARCHITECTURE & PIPELINE (ZERO-AST DATAFLOW) -->
    <section class="section-box">
      <div class="section-label">
        <span class="bracket">[</span> ARCHITECTURE &amp; PIPELINE <span class="bracket">]</span>
      </div>
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

    <!-- THE PROBLEM VS THE SOLUTION (FLAT BENTO BOXES) -->
    <section class="section-box">
      <div class="section-label">
        <span class="bracket">[</span> THE ARCHITECTURAL GAP <span class="bracket">]</span>
      </div>
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

    <!-- ASYNC VFS ARCHITECTURE & AVAILABLE VFS ADAPTERS -->
    <section class="section-box">
      <div class="section-label">
        <span class="bracket">[</span> STORAGE LAYER // ZERO ASYNCIFY <span class="bracket">]</span>
      </div>
      <h2 class="section-heading">Async VFS: Storage Built for the Web Platform</h2>
      <p class="section-sub">
        Standard C databases fail in browsers because POSIX assumes synchronous, blocking disk calls (<code>read</code>, <code>write</code>, <code>fsync</code>). WebDB’s VDBE bytecode machine is inherently asynchronous—it suspends execution on page cache misses, triggers non-blocking browser I/O, and resumes the instant the 4KB block arrives. Zero Emscripten stack-unwinding penalty.
      </p>

      <!-- 4 AVAILABLE VFS ADAPTERS GRID -->
      <div class="vfs-grid">
        <div class="vfs-card">
          <div class="vfs-header">
            <span class="vfs-code">ADAPTER 01</span>
            <span class="vfs-badge vfs-badge-primary">MAX_THROUGHPUT</span>
          </div>
          <h3 class="vfs-title">OPFS VFS</h3>
          <p class="vfs-desc">
            Direct bare-metal access to the browser's <strong>Origin Private File System</strong> using synchronous access handles (<code>FileSystemSyncAccessHandle</code>) inside dedicated Web Workers. Delivers near-native NVMe read/write throughput with zero serialization overhead.
          </p>
          <div class="vfs-context">
            <code>ENVIRONMENT: Dedicated Web Workers</code>
          </div>
        </div>

        <div class="vfs-card">
          <div class="vfs-header">
            <span class="vfs-code">ADAPTER 02</span>
            <span class="vfs-badge">UNIVERSAL</span>
          </div>
          <h3 class="vfs-title">IndexedDB VFS</h3>
          <p class="vfs-desc">
            Universal browser fallback running everywhere, including main thread contexts and mobile Safari on iOS. Stores rigid 4KB slotted pages as binary <code>ArrayBuffer</code> blobs within an IndexedDB object store.
          </p>
          <div class="vfs-context">
            <code>ENVIRONMENT: Main Thread &amp; Mobile Safari</code>
          </div>
        </div>

        <div class="vfs-card">
          <div class="vfs-header">
            <span class="vfs-code">ADAPTER 03</span>
            <span class="vfs-badge">EPHEMERAL</span>
          </div>
          <h3 class="vfs-title">Memory VFS</h3>
          <p class="vfs-desc">
            In-memory volatile page store backed by flat <code>Uint8Array</code> buffers. Delivers sub-millisecond query execution with zero persistence—ideal for automated test suites, transient UI state, and ephemeral analytics sandboxes.
          </p>
          <div class="vfs-context">
            <code>ENVIRONMENT: Unit Tests &amp; Scratchpads</code>
          </div>
        </div>

        <div class="vfs-card">
          <div class="vfs-header">
            <span class="vfs-code">ADAPTER 04</span>
            <span class="vfs-badge vfs-badge-accent">STREAMING</span>
          </div>
          <h3 class="vfs-title">HTTP Range VFS</h3>
          <p class="vfs-desc">
            Stream read-only databases hosted on static CDNs or S3 buckets. Fetches 4KB pages on-demand using standard HTTP <code>Range: bytes=X-Y</code> headers with zero pre-downloading of the database file.
          </p>
          <div class="vfs-context">
            <code>ENVIRONMENT: Static CDNs &amp; Cloudflare R2</code>
          </div>
        </div>
      </div>

      <!-- HTTP VFS SHOWCASE & LIVE EXAMPLE -->
      <div class="http-vfs-box">
        <div class="http-vfs-content">
          <div class="http-vfs-meta">
            <span class="tag-accent">DEEP DIVE</span>
            <code>FEATURE_HIGHLIGHT: HTTP_RANGE_VFS</code>
          </div>
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

    <!-- CORE PILLARS (FLAT SQUARED GRID) -->
    <section class="section-box">
      <div class="section-label">
        <span class="bracket">[</span> CORE CAPABILITIES <span class="bracket">]</span>
      </div>
      <h2 class="section-heading">Engineered for Offline-First Applications</h2>

      <div class="features-grid">
        <div class="feat-box">
          <div class="feat-header">
            <span class="feat-code">01 // STORAGE</span>
            <span class="feat-tag">DUAL-VFS</span>
          </div>
          <h3 class="feat-title">Pluggable Async VFS</h3>
          <p class="feat-text">
            Co-equal support for bare-metal <strong>OPFS SyncAccessHandles</strong> in workers and universal <strong>IndexedDB</strong> in main thread/mobile Safari. Supports on-demand <strong>HTTP Range Request</strong> page streaming directly from S3/CDN.
          </p>
        </div>

        <div class="feat-box">
          <div class="feat-header">
            <span class="feat-code">02 // EXECUTION</span>
            <span class="feat-tag">VDBE-VM</span>
          </div>
          <h3 class="feat-title">32-Register Bytecode Machine</h3>
          <p class="feat-text">
            Replaces the classic Volcano iterator model (which destroys Wasm call stacks) with a flat, loop-driven register machine that yields cleanly on cache misses without dynamic memory allocation.
          </p>
        </div>

        <div class="feat-box">
          <div class="feat-header">
            <span class="feat-code">03 // RELIABILITY</span>
            <span class="feat-tag">WAL-ACID</span>
          </div>
          <h3 class="feat-title">Physical WAL Crash Recovery</h3>
          <p class="feat-text">
            Rigid 4,128-byte WAL frame architecture with CRC32 IEEE 802.3 checksums and atomic commit markers. Two-phase checkpointing guarantees 100% resilience against torn writes or sudden tab crashes.
          </p>
        </div>

        <div class="feat-box">
          <div class="feat-header">
            <span class="feat-code">04 // IDENTITY</span>
            <span class="feat-tag">128-BIT</span>
          </div>
          <h3 class="feat-title">Native Binary UUID &amp; ULID</h3>
          <p class="feat-text">
            Stored as compact 16-byte fixed binary slices (58% smaller than text UUIDs). Time-ordered UUIDv7 and ULID append sequentially to B+Tree leaves with near-zero page splits or fragmentation.
          </p>
        </div>

        <div class="feat-box">
          <div class="feat-header">
            <span class="feat-code">05 // EXTENSIBILITY</span>
            <span class="feat-tag">UDF-BRIDGE</span>
          </div>
          <h3 class="feat-title">Synchronous JavaScript UDFs</h3>
          <p class="feat-text">
            Register arbitrary JS functions callable directly from bytecode. Query filters execute native browser regex and date comparisons at near-native speeds through shared memory.
          </p>
        </div>

        <div class="feat-box">
          <div class="feat-header">
            <span class="feat-code">06 // FUTURE-READY</span>
            <span class="feat-tag">SIMD+FTS</span>
          </div>
          <h3 class="feat-title">Vector &amp; BM25 Hybrid Search</h3>
          <p class="feat-text">
            Designed to support 128-bit Wasm SIMD vector embeddings (<code>VECTOR</code>), Okapi BM25 full-text search with <code>Intl.Segmenter</code>, and transparent AES-256-GCM page encryption.
          </p>
        </div>
      </div>
    </section>

    <!-- INTERACTIVE CODE SHOWCASE -->
    <section class="section-box code-section">
      <div class="section-label">
        <span class="bracket">[</span> DEVELOPER EXPERIENCE <span class="bracket">]</span>
      </div>
      <h2 class="section-heading">Simple, Type-Safe API</h2>

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

    <!-- SUPPORT / CTA BANNER -->
    <section class="support-banner">
      <div class="support-content">
        <span class="banner-tag">OPEN SOURCE &amp; MIT LICENSED</span>
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
            <span>STAR ON GITHUB ⭐</span>
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
  max-width: 1140px;
  margin: 0 auto;
  padding: 2.5rem 1.5rem 5rem;
  font-family: var(--vp-font-family-base);
  color: var(--vp-c-text-1);
}

/* TYPOGRAPHY & BRACKETS */
.bracket {
  color: var(--vp-c-brand-1);
  font-weight: 700;
}

code {
  font-family: var(--vp-font-family-mono);
}

/* HERO SECTION */
.hero-box {
  border: 1px solid var(--vp-c-divider);
  background-color: var(--vp-c-bg-soft);
  background-image: radial-gradient(var(--vp-c-divider) 1px, transparent 1px);
  background-size: 20px 20px;
  padding: 3rem 2.5rem;
  margin-bottom: 3.5rem;
  position: relative;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.05);
}

.meta-tag {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.8rem;
  color: var(--vp-c-text-2);
  margin-bottom: 1.5rem;
  flex-wrap: wrap;
}

.status-dot {
  width: 8px;
  height: 8px;
  background-color: #10b981;
  display: inline-block;
  box-shadow: 0 0 8px #10b981;
}

.badge-accent {
  background: var(--vp-c-brand-1);
  color: #fff;
  padding: 2px 6px;
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.5px;
}

.hero-header {
  display: flex;
  align-items: center;
  gap: 1.5rem;
  margin-bottom: 1.25rem;
}

.logo-box {
  border: 1px solid var(--vp-c-divider);
  padding: 0.5rem;
  background: var(--vp-c-bg);
  display: flex;
  align-items: center;
  justify-content: center;
}

.hero-title {
  font-size: 3rem;
  font-weight: 900;
  letter-spacing: -1.5px;
  margin: 0;
  line-height: 1;
}

.hero-lead {
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--vp-c-brand-1);
  margin: 0.4rem 0 0;
  letter-spacing: -0.3px;
}

.hero-desc {
  font-size: 1.05rem;
  line-height: 1.6;
  color: var(--vp-c-text-2);
  max-width: 840px;
  margin-bottom: 2rem;
}

.action-strip {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
  margin-bottom: 2.5rem;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1.4rem;
  font-size: 0.85rem;
  font-weight: 700;
  letter-spacing: 0.5px;
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
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  border-color: var(--vp-c-divider);
}

.btn-secondary:hover {
  background: var(--vp-c-bg-mute);
  border-color: var(--vp-c-text-2);
}

.btn-ghost {
  background: transparent;
  color: var(--vp-c-text-1);
  border-color: var(--vp-c-divider);
}

.btn-ghost:hover {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}

/* METRICS GRID */
.metrics-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1px;
  background: var(--vp-c-divider);
  border: 1px solid var(--vp-c-divider);
}

.metric-card {
  background: var(--vp-c-bg);
  padding: 1.25rem 1rem;
}

.metric-label {
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.5px;
  color: var(--vp-c-text-3);
  font-family: var(--vp-font-family-mono);
}

.metric-val {
  font-size: 1.5rem;
  font-weight: 800;
  color: var(--vp-c-brand-1);
  margin: 0.25rem 0;
  font-family: var(--vp-font-family-mono);
}

.metric-sub {
  font-size: 0.75rem;
  color: var(--vp-c-text-2);
}

/* SECTION CONTAINER */
.section-box {
  margin-bottom: 3.5rem;
}

.section-label {
  font-family: var(--vp-font-family-mono);
  font-size: 0.8rem;
  font-weight: 700;
  color: var(--vp-c-brand-1);
  letter-spacing: 1px;
  margin-bottom: 0.5rem;
}

.section-heading {
  font-size: 1.85rem;
  font-weight: 800;
  letter-spacing: -0.5px;
  margin: 0 0 0.75rem;
}

.section-sub {
  color: var(--vp-c-text-2);
  font-size: 1rem;
  line-height: 1.6;
  max-width: 820px;
  margin: 0 0 2rem;
}

/* USE CASES GRID */
.usecases-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1.25rem;
}

.usecase-card {
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  transition: transform 0.15s ease, border-color 0.15s ease;
}

.usecase-card:hover {
  border-color: var(--vp-c-brand-1);
  transform: translateY(-2px);
}

.usecase-badge {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-family: var(--vp-font-family-mono);
  font-size: 0.72rem;
  color: var(--vp-c-text-3);
  margin-bottom: 0.75rem;
}

.usecase-code {
  color: var(--vp-c-brand-1);
  font-weight: 700;
}

.usecase-tag {
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  padding: 1px 6px;
  font-size: 0.68rem;
  font-weight: 700;
  color: var(--vp-c-text-2);
}

.usecase-title {
  font-size: 1.1rem;
  font-weight: 700;
  margin: 0 0 0.5rem;
  letter-spacing: -0.3px;
}

.usecase-text {
  font-size: 0.88rem;
  color: var(--vp-c-text-2);
  line-height: 1.5;
  margin: 0 0 1rem;
  flex: 1;
}

.usecase-footer {
  border-top: 1px solid var(--vp-c-divider);
  padding-top: 0.6rem;
  font-size: 0.75rem;
  color: var(--vp-c-text-3);
  font-family: var(--vp-font-family-mono);
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
  padding: 1.5rem;
  background: var(--vp-c-bg);
  border-right: 1px solid var(--vp-c-divider);
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
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
  font-size: 1.05rem;
  font-weight: 700;
  color: var(--vp-c-text-1);
}

.step-code {
  font-size: 0.78rem;
  font-family: var(--vp-font-family-mono);
  color: var(--vp-c-text-2);
}

.step-desc {
  font-size: 0.8rem;
  color: var(--vp-c-text-3);
  line-height: 1.45;
  margin-top: 0.25rem;
}

/* COMPARISON CARDS */
.comparison-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.5rem;
}

.compare-card {
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  padding: 1.75rem;
}

.compare-legacy {
  border-left: 3px solid #ef4444;
}

.compare-webdb {
  border-left: 3px solid var(--vp-c-brand-1);
}

.card-header {
  margin-bottom: 1.25rem;
}

.tag-danger {
  font-family: var(--vp-font-family-mono);
  font-size: 0.75rem;
  font-weight: 700;
  color: #ef4444;
  letter-spacing: 0.5px;
}

.tag-success {
  font-family: var(--vp-font-family-mono);
  font-size: 0.75rem;
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
  gap: 1.1rem;
}

.compare-list li {
  display: flex;
  gap: 0.75rem;
  font-size: 0.92rem;
  line-height: 1.5;
  color: var(--vp-c-text-2);
}

.compare-list li strong {
  color: var(--vp-c-text-1);
  display: block;
  margin-bottom: 0.2rem;
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

/* ASYNC VFS GRID */
.vfs-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1.25rem;
  margin-bottom: 2rem;
}

.vfs-card {
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  transition: transform 0.15s ease, border-color 0.15s ease;
}

.vfs-card:hover {
  border-color: var(--vp-c-brand-1);
  transform: translateY(-2px);
}

.vfs-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-family: var(--vp-font-family-mono);
  font-size: 0.72rem;
  color: var(--vp-c-text-3);
  margin-bottom: 0.75rem;
}

.vfs-code {
  color: var(--vp-c-brand-1);
  font-weight: 700;
}

.vfs-badge {
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  padding: 1px 6px;
  font-size: 0.68rem;
  font-weight: 700;
  color: var(--vp-c-text-2);
}

.vfs-badge-primary {
  color: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
}

.vfs-badge-accent {
  color: #10b981;
  border-color: #10b981;
}

.vfs-title {
  font-size: 1.15rem;
  font-weight: 700;
  margin: 0 0 0.5rem;
  letter-spacing: -0.3px;
}

.vfs-desc {
  font-size: 0.88rem;
  color: var(--vp-c-text-2);
  line-height: 1.5;
  margin: 0 0 1rem;
  flex: 1;
}

.vfs-context {
  border-top: 1px solid var(--vp-c-divider);
  padding-top: 0.6rem;
  font-size: 0.72rem;
  color: var(--vp-c-text-3);
  font-family: var(--vp-font-family-mono);
}

/* HTTP VFS SHOWCASE BOX */
.http-vfs-box {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2rem;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  padding: 2rem;
  align-items: start;
}

.http-vfs-meta {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.75rem;
  color: var(--vp-c-text-3);
  margin-bottom: 0.75rem;
}

.tag-accent {
  background: var(--vp-c-brand-1);
  color: #fff;
  padding: 2px 6px;
  font-size: 0.68rem;
  font-weight: 700;
  font-family: var(--vp-font-family-mono);
}

.http-vfs-title {
  font-size: 1.45rem;
  font-weight: 800;
  letter-spacing: -0.5px;
  margin: 0 0 0.75rem;
  line-height: 1.25;
}

.http-vfs-desc {
  font-size: 0.92rem;
  line-height: 1.6;
  color: var(--vp-c-text-2);
  margin: 0 0 1.5rem;
}

/* RANGE REQUEST DIAGRAM */
.http-range-diagram {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  padding: 1.25rem;
}

.diagram-step {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  padding: 0.75rem 1rem;
}

.step-label {
  font-family: var(--vp-font-family-mono);
  font-size: 0.7rem;
  font-weight: 700;
  color: var(--vp-c-brand-1);
  letter-spacing: 0.5px;
}

.step-val {
  font-family: var(--vp-font-family-mono);
  font-size: 0.8rem;
  color: var(--vp-c-text-1);
}

.diagram-arrow {
  color: var(--vp-c-brand-1);
  font-size: 0.75rem;
  text-align: center;
  line-height: 1;
  opacity: 0.8;
}

/* HTTP VFS CODE EMBED */
.http-vfs-code-wrap {
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  overflow: hidden;
}

.code-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: var(--vp-c-bg-mute);
  border-bottom: 1px solid var(--vp-c-divider);
  padding: 0.6rem 1rem;
  font-family: var(--vp-font-family-mono);
  font-size: 0.78rem;
}

.code-file {
  font-weight: 700;
  color: var(--vp-c-text-1);
}

.code-badge {
  background: var(--vp-c-brand-1);
  color: #fff;
  padding: 1px 6px;
  font-size: 0.65rem;
  font-weight: 700;
}

.http-code-body {
  padding: 1rem 0.25rem;
  background: var(--vp-c-bg-soft);
  overflow-x: auto;
  font-family: var(--vp-font-family-mono);
  font-size: 0.82rem;
  line-height: 1.55;
}

/* FEATURES GRID */
.features-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1.25rem;
}

.feat-box {
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  padding: 1.5rem;
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
  font-size: 0.72rem;
  color: var(--vp-c-text-3);
  margin-bottom: 0.75rem;
}

.feat-tag {
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  padding: 1px 6px;
  font-size: 0.68rem;
  color: var(--vp-c-brand-1);
  font-weight: 700;
}

.feat-title {
  font-size: 1.1rem;
  font-weight: 700;
  margin: 0 0 0.5rem;
  letter-spacing: -0.3px;
}

.feat-text {
  font-size: 0.88rem;
  color: var(--vp-c-text-2);
  line-height: 1.5;
  margin: 0;
}

/* TERMINAL / CODE SECTION */
.terminal-box {
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.08);
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
  padding: 0.65rem 1.1rem;
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
  padding: 0.3rem 0.75rem;
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
  padding: 1.25rem 0.5rem;
  overflow-x: auto;
  font-family: var(--vp-font-family-mono);
  font-size: 0.88rem;
  line-height: 1.6;
  background: var(--vp-c-bg-soft);
}

.code-lines {
  display: flex;
  flex-direction: column;
}

.code-line {
  display: flex;
  min-height: 1.6em;
  padding: 0 0.75rem;
}

.code-line:hover {
  background: rgba(0, 0, 0, 0.03);
}

:global(.dark) .code-line:hover {
  background: rgba(255, 255, 255, 0.03);
}

.line-num {
  width: 2.5rem;
  text-align: right;
  padding-right: 1.25rem;
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
  padding: 3rem 2rem;
  text-align: center;
  position: relative;
}

.banner-tag {
  font-family: var(--vp-font-family-mono);
  font-size: 0.75rem;
  font-weight: 700;
  color: var(--vp-c-brand-1);
  letter-spacing: 1px;
}

.banner-title {
  font-size: 2rem;
  font-weight: 800;
  margin: 0.75rem 0;
  letter-spacing: -0.5px;
}

.banner-desc {
  font-size: 1rem;
  color: var(--vp-c-text-2);
  max-width: 650px;
  margin: 0 auto 2rem;
  line-height: 1.6;
}

.banner-actions {
  display: flex;
  justify-content: center;
  gap: 1rem;
  flex-wrap: wrap;
}

/* RESPONSIVE BREAKPOINTS */
@media (max-width: 900px) {
  .vfs-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  .http-vfs-box {
    grid-template-columns: 1fr;
  }
  .usecases-grid {
    grid-template-columns: repeat(2, 1fr);
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
  .metrics-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  .comparison-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .vfs-grid {
    grid-template-columns: 1fr;
  }
  .usecases-grid {
    grid-template-columns: 1fr;
  }
  .features-grid {
    grid-template-columns: 1fr;
  }
  .metrics-grid {
    grid-template-columns: 1fr;
  }
  .hero-title {
    font-size: 2.25rem;
  }
  .hero-box {
    padding: 1.75rem 1.25rem;
  }
}
</style>
