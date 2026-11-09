import { describe, it, expect, beforeEach } from 'vitest';
import { WebDB, DataType } from '@ahmadmoussawi/webdb';
import {
  normalizeText,
  tokenize,
  damerauLevenshtein,
  withinEdits,
  matchWord,
  bestMatch,
  escapeHtml,
  highlight,
  snippet,
  wordCount,
  scoreRow,
  registerFuzzySearch,
  fuzzyMatch,
  fuzzyScore,
  multiFuzzyScore,
  highlightExpr,
  snippetExpr,
  SearchIndex,
  createSearchIndex,
  searchInMemory,
  ngrams,
  wordNgrams,
  ngramSimilarity,
  ngramSimilarityExpr,
  BM25Index,
  bm25Score,
} from '@ahmadmoussawi/webdb/search';

describe('Search Add-on: Text Primitives', () => {
  it('normalizes text by lowercasing and stripping diacritics', () => {
    expect(normalizeText('Café')).toBe('cafe');
    expect(normalizeText('München')).toBe('munchen');
    expect(normalizeText('Crème Brûlée')).toBe('creme brulee');
    expect(normalizeText('  HELLO WORLD  ')).toBe('hello world');
    expect(normalizeText(null)).toBe('');
    expect(normalizeText(undefined)).toBe('');
  });

  it('tokenizes text into words across locales', () => {
    expect(tokenize('WebDB: ultra-fast relational database!'))
      .toEqual(['webdb', 'ultra', 'fast', 'relational', 'database']);
    expect(tokenize('Déjà vu')).toEqual(['deja', 'vu']);
    expect(tokenize('')).toEqual([]);
    expect(tokenize(null)).toEqual([]);
  });

  it('computes Damerau-Levenshtein distance including transpositions', () => {
    expect(damerauLevenshtein('test', 'test')).toBe(0);
    // Substitution
    expect(damerauLevenshtein('cat', 'bat')).toBe(1);
    // Insertion
    expect(damerauLevenshtein('cat', 'cats')).toBe(1);
    // Deletion
    expect(damerauLevenshtein('cats', 'cat')).toBe(1);
    // Transposition: adjacent characters swapped
    expect(damerauLevenshtein('tehs', 'thes')).toBe(1);
    expect(damerauLevenshtein('wierd', 'weird')).toBe(1);
    // Classical Levenshtein would give 2, Damerau gives 1
    expect(damerauLevenshtein('indexeddb', 'indexddb')).toBe(1);

    // Bounded early exit
    expect(damerauLevenshtein('completelydifferent', 'short', 2)).toBeGreaterThan(2);
    expect(withinEdits('thes', 'tehs', 1)).toBe(true);
    expect(withinEdits('thes', 'tehs', 0)).toBe(false);
  });

  it('splits text into character n-grams', () => {
    expect(ngrams('webdb', 3)).toEqual(['web', 'ebd', 'bdb']);
    expect(ngrams('cat', 2)).toEqual(['ca', 'at']);
    expect(ngrams('', 3)).toEqual([]);
    expect(ngrams('hi', 3)).toEqual(['hi']);
    expect(ngrams('cat', 3, { pad: true })).toEqual(['^^c', '^ca', 'cat', 'at$', 't$$']);
  });

  it('splits text into word-level n-grams', () => {
    expect(wordNgrams('hello world foo bar', 2)).toEqual([
      'hello world',
      'world foo',
      'foo bar',
    ]);
    expect(wordNgrams('hello world', 3)).toEqual(['hello world']);
    expect(wordNgrams('', 2)).toEqual([]);
  });

  it('computes Sorensen-Dice ngram similarity', () => {
    expect(ngramSimilarity('database', 'database')).toBe(1.0);
    expect(ngramSimilarity('relational', 'relatinal', 2)).toBeGreaterThan(0.7);
    expect(ngramSimilarity('relational', 'relatinal', 3)).toBeGreaterThan(0.6);
    expect(ngramSimilarity('apple', 'banana')).toBe(0.0);
    expect(ngramSimilarity('', 'test')).toBe(0.0);
  });

  it('matches words according to exact, prefix, and typo rules', () => {
    // Exact = 3
    expect(matchWord('database', 'database')).toBe(3);

    // Prefix = 2 (token len >= 2)
    expect(matchWord('database', 'data')).toBe(2);
    expect(matchWord('performance', 'perf')).toBe(2);
    expect(matchWord('performance', 'p')).toBe(0); // < prefixMinLength (2)

    // Typo / Fuzzy = 1
    // Short token (< 4 chars) allows 0 edits by default
    expect(matchWord('cat', 'cta')).toBe(0);
    // Medium token (4..7 chars) allows 1 edit
    expect(matchWord('database', 'databaes')).toBe(1); // transposition
    expect(matchWord('storage', 'storge')).toBe(1); // deletion
    // Long token (>= 8 chars) allows 2 edits
    expect(matchWord('transactions', 'transactinos')).toBe(1);
  });

  it('finds best match across document word list', () => {
    const docWords = ['fast', 'relational', 'database', 'engine'];
    expect(bestMatch(docWords, 'database')).toBe(3);
    expect(bestMatch(docWords, 'relat')).toBe(2);
    expect(bestMatch(docWords, 'databaes')).toBe(1);
    expect(bestMatch(docWords, 'unrelated')).toBe(0);
  });
});

describe('Search Add-on: Highlighting and Snippets', () => {
  it('escapes HTML correctly', () => {
    expect(escapeHtml('<script>alert("xss & fun")</script>'))
      .toBe('&lt;script&gt;alert(&quot;xss &amp; fun&quot;)&lt;/script&gt;');
  });

  it('highlights matching terms with <mark> tags', () => {
    const text = 'WebDB is a fast relational database for browsers.';
    const hl = highlight(text, 'relatinal databaes'); // typos
    expect(hl).toContain('<mark>relational</mark>');
    expect(hl).toContain('<mark>database</mark>');
    expect(hl).toContain('WebDB is a fast');
  });

  it('supports custom highlight tag and class', () => {
    const text = 'IndexedDB persistence is reliable.';
    const hl = highlight(text, 'indexeddb', { tag: 'span', className: 'hit' });
    expect(hl).toBe('<span class="hit">IndexedDB</span> persistence is reliable.');
  });

  it('generates context snippets around matches with ellipses', () => {
    const body = 'WebDB is a browser database. The Origin Private File System gives dedicated workers synchronous handles for high performance writes. It is crash safe.';
    const snip = snippet(body, 'synchronous', { size: 60 });
    expect(snip).toContain('<mark>synchronous</mark>');
    expect(snip.startsWith('…') || snip.endsWith('…')).toBe(true);
  });

  it('counts words', () => {
    expect(wordCount('One two three four five')).toBe(5);
    expect(wordCount('')).toBe(0);
  });
});

describe('Search Add-on: In-Memory Search', () => {
  const articles = [
    { id: 1, title: 'Getting started with WebDB', body: 'WebDB is a relational database for browsers.' },
    { id: 2, title: 'Persistent storage with IndexedDB', body: 'IndexedDB stores data reliably offline.' },
    { id: 3, title: 'OPFS high performance', body: 'The Origin Private File System provides ultra fast storage.' },
  ];

  it('searches in-memory array with ranking, highlights, and snippets', () => {
    const result = searchInMemory(articles, 'databaes', {
      fields: [
        { name: 'title', weight: 10, highlight: true },
        { name: 'body', weight: 1, snippet: true },
      ],
      idField: 'id',
    });

    expect(result.hits.length).toBe(1);
    expect(result.hits[0].id).toBe(1);
    expect(result.hits[0].score).toBeGreaterThan(0);
    expect(result.hits[0].snippets.body).toContain('<mark>database</mark>');
  });

  it('honors empty query behavior', () => {
    const result = searchInMemory(articles, '', {
      fields: ['title'],
      idField: 'id',
      limit: 2,
    });
    expect(result.hits.length).toBe(2);
    expect(result.total).toBe(3);
  });

  it('scores and ranks documents using probabilistic BM25', () => {
    const bm25 = new BM25Index({
      fields: [
        { name: 'title', weight: 10, highlight: true },
        { name: 'body', weight: 1, snippet: true },
      ],
      idField: 'id',
    });
    bm25.addDocuments(articles);

    expect(bm25.totalDocuments).toBe(3);
    expect(bm25.averageDocumentLength).toBeGreaterThan(0);

    // "opfs" appears only in article 3 -> high IDF
    const res = bm25.search('opfs storage');
    expect(res.hits.length).toBe(2);
    expect(res.hits[0].id).toBe(3);
    expect(res.hits[0].highlights.title).toContain('<mark>OPFS</mark>');
  });

  it('supports algorithm: "bm25" in searchInMemory', () => {
    const res = searchInMemory(articles, 'indexeddb offline', {
      fields: [{ name: 'title', weight: 5 }, { name: 'body', weight: 2 }],
      idField: 'id',
      algorithm: 'bm25',
    });

    expect(res.hits.length).toBe(1);
    expect(res.hits[0].id).toBe(2);
  });
});

describe('Search Add-on: Low-Level UDFs and Expression Helpers', () => {
  let db: WebDB;

  beforeEach(async () => {
    db = await WebDB.open({
      name: `test_search_udfs_${Math.random()}`,
      storage: 'memory',
    });

    registerFuzzySearch(db);

    await db.createTable('docs', [
      { name: 'id', type: 'INT32', primaryKey: true },
      { name: 'title', type: 'TEXT', notNull: true },
      { name: 'content', type: 'TEXT', notNull: true },
      { name: 'category', type: 'TEXT' },
    ]);

    await db.insertMany('docs', [
      { id: 1, title: 'Getting started with WebDB', content: 'WebDB is a fast browser database.', category: 'Guides' },
      { id: 2, title: 'OPFS storage engine', content: 'Origin private file system for high throughput.', category: 'Storage' },
      { id: 3, title: 'IndexedDB durability', content: 'ACID transactions and crash safety with WAL.', category: 'Storage' },
    ]);
  });

  it('filters rows using fuzzyMatch in where clause', async () => {
    // "webdb" with typo "webd" or "webbd"
    const rows = await db
      .from('docs')
      .where(fuzzyMatch('title', 'webbd'))
      .toArray();

    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(1);
  });

  it('projects fuzzyScore and orders by it', async () => {
    const rows = await db
      .from('docs')
      .select([
        'id',
        'title',
        fuzzyScore('title', 'storage').as('score'),
      ])
      .where(fuzzyScore('title', 'storage').gt(0))
      .orderBy('score', 'desc')
      .toArray();

    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(2);
    expect(rows[0].score).toBeGreaterThan(0);
  });

  it('projects multiFuzzyScore across multiple columns with weights', async () => {
    const score = multiFuzzyScore(
      [
        { name: 'title', weight: 10 },
        { name: 'content', weight: 1 },
      ],
      'database'
    );

    const rows = await db
      .from('docs')
      .select(['id', 'title', score.as('rel_score')])
      .where(score.gt(0))
      .orderBy('rel_score', 'desc')
      .toArray();

    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(1);
    expect(rows[0].rel_score).toBeGreaterThan(0);
  });

  it('projects highlight and snippet expressions in SELECT', async () => {
    const rows = await db
      .from('docs')
      .select([
        'id',
        highlightExpr('title', 'webdb').as('title_hl'),
        snippetExpr('content', 'browser', { size: 50 }).as('content_snip'),
      ])
      .where('id', '=', 1)
      .toArray();

    expect(rows.length).toBe(1);
    expect(rows[0].title_hl).toContain('<mark>WebDB</mark>');
    expect(rows[0].content_snip).toContain('<mark>browser</mark>');
  });

  it('evaluates ngramSimilarityExpr and bm25Score in query expressions', async () => {
    const rows = await db
      .from('docs')
      .select([
        'id',
        ngramSimilarityExpr('title', 'getting started').as('ngram_sim'),
        bm25Score(['title', 'content'], 'database browser').as('bm25'),
      ])
      .toArray();

    expect(rows.length).toBe(3);
    expect(rows[0].ngram_sim).toBeGreaterThan(0.5);
    expect(rows[0].bm25).toBeGreaterThan(0);
  });
});

describe('Search Add-on: High-Level SearchIndex', () => {
  let db: WebDB;

  beforeEach(async () => {
    db = await WebDB.open({
      name: `test_search_index_${Math.random()}`,
      storage: 'memory',
    });

    await db.createTable('articles', [
      { name: 'id', type: 'INT32', primaryKey: true },
      { name: 'title', type: 'TEXT', notNull: true },
      { name: 'body', type: 'TEXT', notNull: true },
      { name: 'tags', type: 'TEXT' },
      { name: 'category', type: 'TEXT' },
    ]);

    await db.insertMany('articles', [
      {
        id: 1,
        title: 'Getting started with WebDB',
        body: 'WebDB is a relational database that runs entirely in the browser.',
        tags: 'intro, quickstart',
        category: 'Guides',
      },
      {
        id: 2,
        title: 'Persistent storage with IndexedDB',
        body: 'IndexedDB is available in every browser. WebDB stores pages there.',
        tags: 'storage, persistence',
        category: 'Storage',
      },
      {
        id: 3,
        title: 'OPFS: the fastest browser storage',
        body: 'The Origin Private File System gives dedicated workers high write throughput.',
        tags: 'opfs, workers, performance',
        category: 'Storage',
      },
    ]);
  });

  it('searches with typo tolerance and field weighting', async () => {
    const index = createSearchIndex(db, {
      table: 'articles',
      fields: [
        { name: 'title', weight: 10, highlight: true },
        { name: 'body', weight: 1, highlight: true, snippet: true },
        { name: 'tags', weight: 5 },
      ],
    });

    // Typo search across title & body: "startd databaes"
    const res = await index.search('startd databaes');
    expect(res.hits.length).toBe(1);
    const hit = res.hits[0];
    expect(hit.id).toBe(1);
    expect(hit.score).toBeGreaterThan(0);
    expect(hit.highlights.title).toContain('<mark>started</mark>');
    expect(hit.highlights.body).toContain('<mark>database</mark>');
    expect(hit.snippets.body).toContain('<mark>database</mark>');
    expect(hit.row.category).toBe('Guides');
  });

  it('supports prefix matching while typing', async () => {
    const index = new SearchIndex(db, {
      table: 'articles',
      fields: ['title', 'body'],
    });

    // Prefix search: "persis" matches "Persistent"
    const res = await index.search('persis');
    expect(res.hits.length).toBe(1);
    expect(res.hits[0].id).toBe(2);
  });

  it('applies custom relational filters via options.filter', async () => {
    const index = new SearchIndex(db, {
      table: 'articles',
      fields: ['title', 'body'],
    });

    // Search for "storage" in "Storage" category vs "Guides"
    const res = await index.search('storage', {
      filter: (qb) => qb.where('category', '=', 'Storage'),
    });

    expect(res.hits.length).toBe(2);
    expect(res.hits.every((h) => h.row.category === 'Storage')).toBe(true);
  });

  it('supports buildQuery to return a composable QueryBuilder', async () => {
    const index = new SearchIndex(db, {
      table: 'articles',
      fields: ['title', 'body'],
    });

    const qb = index.buildQuery('webdb', { limit: 1 });
    const rows = await qb.toArray();
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(1);
  });

  it('handles empty query with emptyBehavior', async () => {
    const index = new SearchIndex(db, {
      table: 'articles',
      fields: ['title'],
    });

    const emptyRes = await index.search('', { emptyBehavior: 'empty' });
    expect(emptyRes.hits.length).toBe(0);

    const allRes = await index.search('', { emptyBehavior: 'all' });
    expect(allRes.hits.length).toBe(3);
  });

  it('supports BM25 ranking mode in SearchIndex', async () => {
    const bm25Index = new SearchIndex(db, {
      table: 'articles',
      fields: [
        { name: 'title', weight: 10, highlight: true },
        { name: 'body', weight: 1, snippet: true },
      ],
      algorithm: 'bm25',
    });

    const res = await bm25Index.search('database browser');
    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.hits[0].id).toBe(1);
    expect(res.hits[0].score).toBeGreaterThan(0);
  });
});

describe('Native VDBE Opcodes & UDF Batching', () => {
  let db: WebDB;

  beforeEach(async () => {
    db = await WebDB.open({
      name: `test-native-search-${Math.random()}`,
      storage: 'memory',
    });

    await db.createTable('products', [
      { name: 'id', type: 'INT32', primaryKey: true },
      { name: 'name', type: 'TEXT' },
      { name: 'quantity', type: 'INT32' },
    ]);

    await db.insertMany('products', [
      { id: 1, name: 'Apple iPhone', quantity: 10 },
      { id: 2, name: 'Samsung Galaxy', quantity: 15 },
      { id: 3, name: 'Google Pixel', quantity: 8 },
      { id: 4, name: 'Pineapple Slice', quantity: 20 },
    ]);
  });

  it('filters rows natively via OP_STR_FUZZY_MATCH using "fuzzy" operator', async () => {
    // "iphne" (typo) matches "Apple iPhone"
    const rows = await db.from('products').where('name', 'fuzzy', 'iphne').toArray();
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(1);

    // "glaxy" matches "Samsung Galaxy"
    const galaxyRows = await db.from('products').where('name', 'fuzzy', 'glaxy').toArray();
    expect(galaxyRows.length).toBe(1);
    expect(galaxyRows[0].id).toBe(2);
  });

  it('filters rows via expression fuzzy / fn.fuzzy', async () => {
    const rows = await db.from('products').where("fuzzy(name, 'pixl')").toArray();
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(3);
  });

  it('computes distance in select via levenshtein / edit_distance', async () => {
    const rows = await db
      .from('products')
      .where('id', '=', 1)
      .select(['id', "levenshtein(name, 'Apple iPhone') as exact_dist", "levenshtein(name, 'Apple iPhon') as typo_dist"])
      .toArray();

    expect(rows.length).toBe(1);
    expect(rows[0].exact_dist).toBe(0);
    expect(rows[0].typo_dist).toBe(1);
  });

  it('supports registerBatchedFunction with vectorized chunking across rows', async () => {
    // Populate 150 rows to test multi-chunk batching
    await db.createTable('numbers', [
      { name: 'id', type: 'INT32', primaryKey: true },
      { name: 'val', type: 'INT32' },
    ]);

    const items = [];
    for (let i = 1; i <= 150; i++) {
      items.push({ id: i, val: i });
    }
    await db.insertMany('numbers', items);

    let batchCallCount = 0;
    let totalItemsProcessed = 0;

    db.registerBatchedFunction('double_num', (argsBatch) => {
      batchCallCount++;
      totalItemsProcessed += argsBatch.length;
      return argsBatch.map(([x]) => Number(x) * 2);
    }, { returnType: DataType.INT32 });

    const results = await db
      .from('numbers')
      .select(['id', 'val', 'double_num(val) as doubled'])
      .toArray();

    expect(results.length).toBe(150);
    expect(results[0].doubled).toBe(2);
    expect(results[149].doubled).toBe(300);
    expect(batchCallCount).toBeGreaterThan(0);
    expect(totalItemsProcessed).toBe(150);
  });

  it('supports batched filter execution in WHERE expressions', async () => {
    let filterBatchCalls = 0;
    db.registerBatchedFunction('is_high_stock', (argsBatch) => {
      filterBatchCalls++;
      return argsBatch.map(([qty]) => (Number(qty) >= 15 ? 1 : 0));
    });

    const matching = await db.from('products').where('is_high_stock(quantity)').toArray();
    expect(matching.length).toBe(2); // Samsung Galaxy (15), Pineapple Slice (20)
    expect(matching.map((r) => r.id).sort()).toEqual([2, 4]);
    expect(filterBatchCalls).toBeGreaterThan(0);
  });
});
