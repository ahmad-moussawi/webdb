# Future Roadmap: Vector, JSON, Search & Database Encryption

## 1. Executive Vision

While **WebDB V1** focuses strictly on a rock-solid, zero-heap relational core (ACID transactions, slotted-page B+Trees, WAL crash resilience, and register VDBE execution), modern local-first and offline web applications require more than tabular rows.

Applications running in browsers increasingly demand:

1. **Semantic AI Capabilities:** Client-side embeddings, vector similarity search, and Retrieval-Augmented Generation (RAG) powered by local models (Transformers.js, ONNX Runtime Web, Chrome `window.ai` / Gemini Nano).
2. **Semi-Structured Schemas:** Storing dynamic API payloads, user configurations, and audit events without rigid schema migrations.
3. **Instant Interactive Search:** Multi-lingual full-text search and typo-tolerant fuzzy queries without forcing web apps to load 500KB third-party search libraries that duplicate data in the JavaScript heap.
4. **Zero-Knowledge Security & Database Encryption:** Encrypting the entire database at rest (pages and WAL) via AES-256-GCM using hardware-accelerated Web Crypto, guaranteeing privacy for sensitive client-side data.

By extending WebDB's existing **slotted-page binary architecture**, **Wasm SIMD execution**, and **Transient Query Arena**, WebDB transforms into an **all-in-one local data platform: Relational + Vector + JSON + Lexical Search + Zero-Knowledge Encryption**.

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                   WebDB Core Engine                                     │
├───────────────────────┬──────────────────────────┬──────────────────────────┬───────────┤
│ Relational Core (V1)  │ Semi-Structured (V1.1+)  │ Search Platform (V1.2+)  │ Security  │
├───────────────────────┼──────────────────────────┼──────────────────────────┼───────────┤
│ • 4KB Slotted Pages   │ • JSON (Text + Extract)  │ • Full-Text Search (BM25)│ • AES-GCM │
│ • B+Tree Indexing     │ • JSONB (Binary TLV)     │ • Trigram Fuzzy / LIKE   │ • PBKDF2  │
│ • ACID WAL Engine     │ • Row Overflow Pages     │ • Vector Embeddings      │ • Zero-   │
│ • Register VDBE VM    │ • In-Arena Hash Joins    │ • Hybrid RRF Search      │   Leakage │
└───────────────────────┴──────────────────────────┴──────────────────────────┴───────────┘
```

---

## 2. Vector Data Type (`VECTOR<float32, D>`) & Wasm SIMD

### 2.1 Storage Representation & Math

A vector column of dimension $D$ is stored as a contiguous array of IEEE 754 32-bit floating-point numbers:

```c
typedef struct {
    uint16_t dimensions;    // Vector dimensionality (e.g. 128, 384, 768)
    uint8_t  element_type;  // 1 = FLOAT32, 2 = INT8 (quantized)
    uint8_t  reserved;      // Alignment padding
    float    elements[];    // Contiguous array of floats (dimensions * 4 bytes)
} VectorPayload;
```

#### Row Size Boundary Evaluation (V1 vs V2)

WebDB enforces a strict **2,048-byte single-row boundary** in V1 to prevent leaf page collapse without overflow pages:

| Dimension $D$ |      Encoding      |                 Size on Disk                  |    Fits in V1 Row ($\le 2048$ B)?    | Target Use Case                                              |
| :-----------: | :----------------: | :-------------------------------------------: | :----------------------------------: | :----------------------------------------------------------- |
|    **128**    |      Float32       |    $128 \times 4 = \mathbf{512\text{ B}}$     |     **YES** (Plenty of headroom)     | Audio / image feature vectors, small custom embeddings       |
|    **384**    |      Float32       |   $384 \times 4 = \mathbf{1,536\text{ B}}$    |  **YES** (Fits with ID & metadata)   | `all-MiniLM-L6-v2`, Transformers.js standard text embeddings |
|    **768**    |      Float32       |        $768 \times 4 = 3,072\text{ B}$        |     NO (Requires Overflow Page)      | Base BERT, Gemini Nano embeddings                            |
|    **768**    | **Int8 Quantized** |  $768 \times 1 + 8 = \mathbf{776\text{ B}}$   |         **YES** (Compressed)         | High-accuracy quantized 768-dim models                       |
|   **1,536**   | **Int8 Quantized** | $1536 \times 1 + 8 = \mathbf{1,544\text{ B}}$ |         **YES** (Compressed)         | OpenAI `text-embedding-3-small` (quantized)                  |
|   **1,536**   |      Float32       |       $1536 \times 4 = 6,144\text{ B}$        | NO (Requires Phase 2 Overflow Pages) | Uncompressed OpenAI embeddings                               |

### 2.2 Hardware-Accelerated Similarity via 128-bit Wasm SIMD

Modern browsers universally support WebAssembly **128-bit SIMD (`v128`)**. A vectorized loop processes four 32-bit floats per instruction cycle:

$$\text{Cosine Similarity}(A, B) = \frac{\sum_{i=1}^D A_i B_i}{\sqrt{\sum_{i=1}^D A_i^2} \cdot \sqrt{\sum_{i=1}^D B_i^2}}$$

```c
// SIMD dot-product kernel processing 4 floats simultaneously:
v128_t dot = wasm_f32x4_splat(0.0f);
for (int i = 0; i < D; i += 4) {
    v128_t a = wasm_v128_load(&vecA[i]);
    v128_t b = wasm_v128_load(&vecB[i]);
    dot = wasm_f32x4_add(dot, wasm_f32x4_mul(a, b));
}
```

- **Throughput:** A single Web Worker thread running Wasm SIMD can compute over **5,000,000 float32 dot products per second**, making flat brute-force KNN searches across 10,000 records execute in **under 2 milliseconds**.

### 2.3 Search Execution: Flat KNN vs. ANN (HNSW)

1. **Phase 1: Flat KNN Scan (V1.1):**
   - Sequential scan across table rows.
   - Evaluates SIMD distance between query vector and column vector.
   - Maintains a bounded **Top-$K$ Min-Heap** in the Transient Query Arena (`0x420000`).
   - Zero index build overhead; 100% exact recall.
2. **Phase 2: Graph-Based HNSW Index (V2.0):**
   - Hierarchical Navigable Small World index stored across dedicated index pages (`page_type = 0x0B`).
   - Enables $O(\log N)$ approximate nearest neighbor queries across 100,000+ vectors in $< 1\text{ ms}$.

---

## 3. Semi-Structured JSON & Binary JSON (`JSONB`)

Web applications frequently process semi-structured data: webhook payloads, user settings, dynamic forms, and nested audit logs.

### 3.1 Tier 1: Text-Based JSON with Functional Extraction (V1.1)

- **Storage:** Stored in the existing variable-length string slice as UTF-8 `TEXT` (type tag `0x06`).
- **Query API:**
  ```typescript
  // Fluent extraction:
  db.from("events").where("payload->>'user.address.city'", "=", "Berlin");
  // Scalar function extraction:
  db.from("events").where(
    jsonExtract("payload", "$.user.address.city"),
    "=",
    "Berlin",
  );
  ```
- **Engine Execution:** A streaming C tokenizer parses only the tokens necessary to navigate to the target path without building full AST objects or allocating heap memory.

### 3.2 Tier 2: Binary JSON (`JSONB`) & Overflow Pages (V1.2)

- **Storage Format:** Tag-Length-Value (TLV) binary tree.
  ```
  [JSONB Header: 4B]
  [Key Offset Directory: 2B * KeyCount]
  [Payload Data: Fixed-width primitives & length-prefixed strings]
  ```
- **Benefits:**
  - $O(1)$ field navigation: Jumps directly to key offsets without scanning preceding text.
  - Zero-copy scalar extraction into VDBE registers.
- **Row Overflow Pages:** When JSON documents exceed 2,048 bytes, WebDB links overflow page chains (`page_type = 0x0C`), preserving B+Tree node balance while allowing documents up to megabytes in size.

---

## 4. Full-Text Search (FTS) with BM25 Ranking

### 4.1 Native Zero-Bundle Tokenization via `Intl.Segmenter`

A major roadblock for embedded C databases (like SQLite FTS5) is Unicode tokenization: compiling full ICU tables adds 2MB–5MB to the binary.

**WebDB leverages the browser's native JavaScript `Intl.Segmenter` API**:

```typescript
// Host-assisted tokenization (0 KB bundle size cost):
const segmenter = new Intl.Segmenter(locale, { granularity: "word" });
const tokens: Array<{ term: string; offset: number }> = [];

for (const { segment, isWordLike, index } of segmenter.segment(text)) {
  if (isWordLike) {
    tokens.push({ term: segment.toLowerCase(), offset: index });
  }
}
```

- **Universal Localization:** Native multibyte support for Chinese, Japanese, Arabic, European languages, and emojis out of the box with zero runtime weight.

### 4.2 B+Tree Inverted Index Storage

WebDB formats full-text postings directly into its existing secondary B+Tree index pages (`page_type = 0x0A`):

```c
typedef struct {
    uint16_t term_len;       // Term length (bytes)
    char     term[term_len]; // Stemmed/normalized word string
    int64_t  rowid;          // Matching table row ID (8 bytes)
    uint16_t term_freq;      // Frequency of term in this row (2 bytes)
} FtsIndexCell;
```

Because cells in secondary index leaf pages are kept sorted by `(term, rowid)`, all rows containing a word are clustered together. An exact word search is a single $O(\log N)$ B+Tree seek followed by a sequential range scan.

### 4.3 BM25 Relevance Scoring

Relevance is scored in a tight C/Wasm loop using the industry-standard Okapi **BM25** formula:

$$\text{Score}(D, Q) = \sum_{t \in Q} \text{IDF}(t) \cdot \frac{f(t, D) \cdot (k_1 + 1)}{f(t, D) + k_1 \cdot \left(1 - b + b \cdot \frac{|D|}{\text{avgdl}}\right)}$$

- **Parameters:** Tuned for local document lengths ($k_1 = 1.2, b = 0.75$).
- **Memory Invariant:** Scored candidates are accumulated in the **Transient Query Arena**, maintaining zero JS garbage collection overhead.

---

## 5. Fuzzy & Substring Search (Trigrams & SIMD Levenshtein)

User queries routinely contain typographical errors (`"iphoen"` $\to$ `"iphone"`) or require substring matches (`LIKE '%phone%'`).

### 5.1 Trigram (3-Gram) Inverted Indexing

Following PostgreSQL's battle-tested `pg_trgm` design:

1. Strings are padded and split into contiguous 3-character slices:
   $$\text{"apple"} \longrightarrow \text{["\$\$a", "\$ap", "app", "ppl", "ple", "le\$"]}$$
2. Trigrams are stored in a standard WebDB secondary B+Tree index (`idx_products_name_trgm`).
3. **Capabilities:**
   - **Accelerated Substring Search:** `where('name', 'LIKE', '%phone%')` is converted into an intersection of trigram lookups, transforming an $O(N)$ sequential table scan into $O(\log N)$ index seeks.
   - **Typo Tolerance:** Words are ranked by Trigram Jaccard Similarity:
     $$\text{Similarity}(S_1, S_2) = \frac{|T(S_1) \cap T(S_2)|}{|T(S_1) \cup T(S_2)|}$$

### 5.2 Wasm SIMD Levenshtein Distance

For real-time filtering where indexes are absent, WebDB provides a SIMD-vectorized Levenshtein edit distance kernel (`max_distance <= 2`). The bit-parallel Myers algorithm computes edit distances across thousands of candidate strings per millisecond.

---

## 6. The Unified Platform: Client-Side Hybrid Search

Combining **BM25 Full-Text Search** with **Vector Similarity** creates **Hybrid Search**, resolving the classic limitations of both approaches:

- **Lexical BM25:** Excels at exact keywords, model numbers, SKUs, and rare names, but fails on synonyms.
- **Vector Search:** Excels at semantic meaning and concepts, but struggles with exact alphanumeric codes or rare jargon.

### Reciprocal Rank Fusion (RRF) Pipeline

WebDB combines candidate lists inside the browser using **Reciprocal Rank Fusion**:

$$RRF(d) = \sum_{m \in \{\text{BM25}, \text{Vector}\}} \frac{1}{60 + r_m(d)}$$

```
                         User Query: "wireless noise cancelling headphones"
                                                 │
                   ┌─────────────────────────────┴─────────────────────────────┐
                   ▼                                                           ▼
         [BM25 Lexical Search]                                       [SIMD Vector Search]
      (B+Tree Inverted Index Seek)                                 (Wasm SIMD Dot Product)
                   │                                                           │
        Rank 1: SKU-WH1000XM5                                      Rank 1: QuietComfort 45
        Rank 2: QuietComfort 45                                    Rank 2: Studio Pro ANC
        Rank 3: Earbuds Pro                                        Rank 3: SKU-WH1000XM5
                   │                                                           │
                   └─────────────────────────────┬─────────────────────────────┘
                                                 ▼
                                     [Reciprocal Rank Fusion]
                                                 │
                                1. SKU-WH1000XM5  (Score: 0.0325)
                                2. QuietComfort 45 (Score: 0.0322)
                                3. Studio Pro ANC (Score: 0.0161)
```

This delivers state-of-the-art search relevance completely locally, offline, and with absolute data privacy.

---

## 7. Transparent Database Encryption (`EncryptedVfsAdapter`)

### 7.1 The Architectural Advantage: Zero Engine Changes

Unlike traditional databases where encryption requires invasive changes across row formats, B-tree balancing, and buffer pools, WebDB isolates storage entirely behind the **`IVfsAdapter` boundary** ([01_storage_memory_arch.md §7](/plans/01_storage_memory_arch.md#L576)):

- **In-Memory Invariant:** The Wasm/C Engine Core operates exclusively on standard, unencrypted 4KB slotted pages in shared memory (`wasmMemory`).
- **At-Rest Invariant:** Every page written to OPFS or IndexedDB is encrypted before passing to the storage device, and decrypted immediately upon retrieval.
- **Pattern:** An `EncryptedVfsAdapter` wraps any underlying `IVfsAdapter` (OPFS, IndexedDB, Memory) as a transparent decorator.

```
┌────────────────────────────────────────────────────────┐
│               Wasm / C Engine Core                     │
│        (Plaintext 4KB pages in wasmMemory)             │
└──────────────────────────┬─────────────────────────────┘
                           │ readPage / writePage / appendWalFrames
                           ▼
┌────────────────────────────────────────────────────────┐
│               EncryptedVfsAdapter                      │
│   • Hardware-accelerated AES-256-GCM (crypto.subtle)   │
│   • Page Nonce derivation: [page_id + counter + salt]  │
│   • 16-byte AEAD authentication tag verification       │
└──────────────────────────┬─────────────────────────────┘
                           │
       ┌───────────────────┴───────────────────┐
       ▼                                       ▼
┌──────────────┐                       ┌──────────────┐
│  OPFS VFS    │                       │ IndexedDB    │
│  (.db / .wal)│                       │ (pages / wal)│
└──────────────┘                       └──────────────┘
```

### 7.2 Cryptographic Specification

#### A. Cipher & Key Derivation

- **Cipher:** **AES-256-GCM** (Galois/Counter Mode). Provides both **Confidentiality** (encryption) and **Integrity / Authenticity** (16-byte authentication tag).
- **Key Derivation Function (KDF):** **PBKDF2-HMAC-SHA256** (with 100,000 iterations) or **Argon2id**, implemented via standard browser `crypto.subtle.deriveKey`.
- **Salt Storage:** A 16-byte cryptographically secure random salt (`crypto.getRandomValues(new Uint8Array(16))`) is generated at database creation and stored in Page 1 reserved bytes `36..51` ([01_storage_memory_arch.md §6.1](/plans/01_storage_memory_arch.md#L457)).

#### B. Deterministic Nonce / IV Generation (Zero IV Reuse)

AES-GCM strictly prohibits reusing a Nonce with the same key. WebDB constructs a deterministic 12-byte Nonce per write:
$$\text{Nonce (12 Bytes)} = [\text{page\_id (4B, uint32)}] + [\text{change\_counter (4B, uint32)}] + [\text{session\_salt (4B)}]$$

- Because `Page1.change_counter` increments monotonically on every transaction commit, every page write is mathematically guaranteed a unique Nonce.

#### C. Page & WAL Frame Sizing on Disk

AES-GCM outputs the ciphertext plus a 16-byte authentication tag:

- **Database Pages:** $4,096\text{ B (Plaintext)} + 16\text{ B (Auth Tag)} = \mathbf{4,112\text{ Bytes (Ciphertext)}}$.
  - In **IndexedDB:** The `pages` object store stores the 4,112-byte `Uint8Array` directly.
  - In **OPFS:** Blocks are indexed on disk at offset $\text{offset} = (\text{pageId} - 1) \times 4112$.
- **WAL Frames:** $4,128\text{ B (Plaintext Frame)} + 16\text{ B (Auth Tag)} = \mathbf{4,144\text{ Bytes (Ciphertext Frame)}}$.
  - WAL header (bytes 0..31) stores a 16-byte WAL salt; individual frames are encrypted sequentially.

### 7.3 Developer API & Fail-Fast Authentication

```typescript
// Opening an encrypted zero-knowledge database:
const db = await WebDB.open({
  name: "confidential_records",
  storage: "opfs",
  encryption: {
    password: userEnteredPassphrase,
  },
});
```

- **Tamper & Wrong-Password Detection:** When opening the database, WebDB decrypts Page 1. If the password is incorrect or the database file has been tampered with, the AES-GCM tag verification fails natively in Web Crypto $\to$ throws `InvalidEncryptionPasswordError`.

---

## 8. Vectorized User-Defined Functions (Batched UDF Evaluation)

### 8.1 The Row-by-Row FFI Bottleneck

While standard scalar functions (math, string formatting, collation) are implemented natively inside C/Wasm, applications frequently require custom **User-Defined Functions (UDFs)** written in JavaScript (e.g. domain validation, custom business formulas, application-specific parsing).

Executing a JavaScript callback on a row-by-row basis in large sequential scans (e.g. 100,000 rows) causes three critical performance bottlenecks:
1. **Wasm ⟷ JS Boundary Transitions:** Calling an imported JavaScript function from Wasm incurs a foreign-function context switch on every single row (100,000 round-trips).
2. **Garbage Collection (GC) Thrashing:** Text in WebDB resides as raw UTF-8 bytes in slotted page memory. Passing a string to a JS function forces the engine to decode and allocate a JavaScript `String` object on the V8/SpiderMonkey heap for every evaluated row, triggering browser garbage collection pauses.
3. **Register Spilling:** Calling outside Wasm prevents the JIT compiler from keeping registers alive across loop iterations.

### 8.2 Execution Scenarios & Architecture

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        Scenario A: Projection UDF (SELECT my_udf(col))                │
│                                                                                        │
│   [VM Filters & Scans] ──► [64KB Result Buffer] ──► [Host JS Drains Chunk]            │
│                                                                 │                      │
│                                            (Fast JS Map Loop over 500-1,000 rows)      │
│                                                                 ▼                      │
│                                                        [Returned to User]              │
└────────────────────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        Scenario B: Filter UDF (WHERE my_udf(col) = true)              │
│                                                                                        │
│   [VM Scans 64 Rows] ────► [Arena Vector Buffer] ────► [Host JS Batch Evaluation]      │
│                                                                 │                      │
│   [Emits Matching Rows] ◄── [Resume vm_step()] ◄────── [64-bit Selection Bitmask]      │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

#### A. Scenario A: Projection UDFs (`SELECT my_udf(col)`) — Zero VM Overhead
When UDFs appear in the `SELECT` projection list, the VM evaluates the query filters and emits raw serialized rows into the **64KB Result Buffer**.
- When Host JavaScript drains the buffer chunk (e.g. 500–1,000 rows), JS applies the UDF transformation in a single tight JavaScript loop.
- **VM Impact:** Zero modifications to `vm_step()`; zero Wasm-to-JS calls during the scan.

#### B. Scenario B: Filter UDFs (`WHERE my_udf(col) = true`) — Vectorized State Machine
When a UDF is used as a filter predicate, the VM cannot make an emit/skip decision on row 1 until the UDF evaluates. To avoid row-by-row FFI calls, WebDB employs a **Vectorized Pause-by-Return** architecture:

1. **Arena Vector Accumulation:**
   - As `vm_step()` iterates, instead of calling JS immediately, it buffers row references and extracted arguments (up to $N = 64$ entries) into a pre-allocated vector in the **Transient Query Arena** (`0x430000`).
2. **Pause via Return (`STATUS_UDF_BATCH`):**
   - When the vector fills 64 entries (or hits EOF / page boundary), the VM records the batch descriptor, sets `ctx->status = STATUS_UDF_BATCH`, and returns control immediately to JavaScript.
3. **Batch Execution in Host JS:**
   - JavaScript invokes the user-registered UDF in a single batch:
     ```typescript
     // Dispatched once for 64 rows instead of 64 individual FFI calls:
     const selectionBitmask = dispatchUdfBatch(udfId, arenaVectorSlice);
     ```
   - Host JS writes a **64-bit bitmask** (`uint64_t`, 8 bytes) directly into shared memory where bit $i = 1$ indicates that row $i$ passed the filter.
4. **Resumption:**
   - Host JS calls `vm_step()`.
   - The VM reads the 64-bit mask from shared memory into a single CPU register and branches on each bit, emitting only the passing rows into the Result Buffer.

### 8.3 Performance & Trade-Off Matrix

| Metric | Row-by-Row UDF (`OP_CALL_UDF`) | Batched Vectorized UDF (64 Rows) | Native C Builtin (`OP_LIKE`, math) |
| :--- | :---: | :---: | :---: |
| **FFI Boundary Transitions (100k rows)** | 100,000 calls | **1,562 calls (64x reduction)** | **0** |
| **JS Heap Allocations** | 100,000 string objects | 100,000 string objects | **0 (Zero-copy raw bytes)** |
| **100k Scan Execution Time** | ~150 – 250 ms | **~20 – 40 ms** | **~2 – 4 ms** |
| **Implementation Complexity** | Low | Medium (Vector buffer + bitmask) | Low (10–25 lines C per op) |

### 8.4 Architectural Guideline
- **Standard Primitives in Native C:** Core string and math filters (`LIKE`, `CONTAINS`, `STARTS_WITH`, `LOWER`, `UPPER`, `SUBSTR`, `ABS`, `ROUND`) must be implemented directly as native C/Wasm opcodes (< 200 bytes Wasm each, zero heap allocation, ~GB/s throughput).
- **Batched Vectorization for Extension UDFs:** Custom user-defined business logic should be dispatched in 64-row vectorized batches using `STATUS_UDF_BATCH` to eliminate 98.4% of foreign-function call overhead.

---

## 9. Phased Implementation Roadmap

| Milestone       | Target Version | Focus Area                                | Key Architectural Deliverables                                                                                                                                                                                                                                                         |
| :-------------- | :------------: | :---------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Milestone 1** |    **V1.1**    | **Semi-Structured, Vectors & Encryption** | • `EncryptedVfsAdapter` (AES-256-GCM via Web Crypto)<br>• `JSON` Text type + `jsonExtract()` VDBE scalar opcode<br>• `VECTOR<float32, D>` column ($D \le 384$ or quantized $D \le 1536$)<br>• Wasm SIMD `v128` Cosine/L2 distance kernel<br>• Flat KNN Top-$K$ Min-Heap in Query Arena |
| **Milestone 2** |    **V1.2**    | **Full-Text, Fuzzy & Vectorized UDFs**    | • Host `Intl.Segmenter` tokenizer pipeline<br>• B+Tree Inverted Index (`0x0A`) with term frequencies<br>• BM25 relevance scorer in Wasm<br>• Trigram index generation for accelerated `LIKE '%substr%'`<br>• Row Overflow Pages (`page_type = 0x0C`)<br>• Vectorized UDF batching (`STATUS_UDF_BATCH` + 64-bit selection bitmask) |
| **Milestone 3** |    **V2.0**    | **Hybrid Platform & ANN Graphs**          | • Reciprocal Rank Fusion (RRF) engine<br>• Graph-based HNSW vector index pages (`page_type = 0x0B`)<br>• `JSONB` binary TLV storage<br>• Multi-column composite secondary indexes                                                                                                      |

