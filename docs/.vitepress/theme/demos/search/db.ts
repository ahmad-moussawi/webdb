import { col, ExpressionBuilder, fn, type WebDB } from '@ahmadmoussawi/webdb';
import { registerSearchUdfs } from './udfs';

export const SEARCH_DB_NAME = 'demo_search';

export const CATEGORIES = ['Storage', 'Queries', 'Performance', 'Browser', 'Guides'] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Article {
  id: number;
  title: string;
  body: string;
  tags: string;
  author: string;
  category: Category;
  created_at: string;
}

export interface SearchRow {
  id: number;
  title: string;
  author: string;
  category: string;
  tags: string;
  created_at: string;
  words: number;
  /** HTML-escaped, with <mark> around matches (produced by the `highlight` UDF). */
  title_html: string;
  snippet_html: string;
  score: number;
}

export interface SearchOptions {
  q: string;
  fuzzy: boolean;
  shortOnly: boolean;
  category: string;
}

export const SHORT_ARTICLE_WORDS = 26;

type Seed = Omit<Article, 'id'>;
const a = (title: string, category: Category, author: string, created_at: string, tags: string, body: string): Seed => ({
  title,
  category,
  author,
  created_at,
  tags,
  body,
});

export const SEED_ARTICLES: Seed[] = [
  a('Getting started with WebDB', 'Guides', 'Lina', '2026-10-30', 'intro, install, quickstart',
    'WebDB is a relational database that runs entirely in the browser. Install it from npm, open a database, create a table and start querying in a few lines of TypeScript.'),
  a('Persistent storage with IndexedDB', 'Storage', 'Omar', '2026-10-28', 'indexeddb, persistence, offline',
    'IndexedDB is available in every browser, including mobile Safari. WebDB stores its pages there, so your data survives reloads, restarts and offline sessions without any server.'),
  a('OPFS: the fastest browser storage', 'Storage', 'Omar', '2026-10-26', 'opfs, workers, performance',
    'The Origin Private File System gives dedicated workers synchronous file handles. WebDB uses them for high throughput writes when it runs inside a worker.'),
  a('Reactive UIs with live queries', 'Queries', 'Lina', '2026-10-25', 'live queries, reactivity, vue, react',
    'A live query re-runs whenever a table it reads changes. Bind it to your component and the interface updates itself, even when the change was made in another browser tab.'),
  a('Indexes make queries fast', 'Performance', 'Sam', '2026-10-22', 'index, btree, performance, queries',
    'A B+Tree index turns a full table scan into a handful of page reads. Create an index on the columns you filter and sort by, and use explain to confirm it is used.'),
  a('Transactions and savepoints', 'Queries', 'Sam', '2026-10-20', 'transactions, acid, savepoints',
    'Wrap related writes in db.transaction so they succeed or fail together. Nested calls become savepoints, which lets you roll back just one part of a larger operation.'),
  a('Crash-safe writes with a write-ahead log', 'Storage', 'Omar', '2026-10-18', 'wal, durability, acid, recovery',
    'Every commit is appended to a write-ahead log before it touches the main file. After a crash or a closed tab, the log is replayed so committed data is never lost.'),
  a('Joins and aggregations', 'Queries', 'Lina', '2026-10-16', 'join, group by, aggregation, sql',
    'Combine tables with join and leftJoin, then summarise with groupBy, count, sum and avg. The query builder compiles straight to bytecode, with no SQL string to parse.'),
  a('Writing user-defined functions', 'Guides', 'Sam', '2026-10-14', 'udf, functions, javascript, search',
    'Register any synchronous JavaScript function with registerFunction and call it from select, where and orderBy. It is the easiest way to add slugs, scoring, regex matching or fuzzy search.'),
  a('Typo-tolerant search without a search engine', 'Guides', 'Lina', '2026-10-12', 'search, fuzzy, typo, udf',
    'A tiny Levenshtein function registered as a UDF is enough to forgive a mistyped word. Combine it with prefix matching and a relevance score to rank the best results first.'),
  a('Café-style caching for repeated reads', 'Performance', 'Noor', '2026-10-10', 'cache, buffer pool, reads',
    'The buffer pool keeps hot pages in memory, so repeated reads never touch storage. Size it with slotCount: bigger pools help read heavy dashboards, smaller ones suit phones.'),
  a('Why we avoid naïve full table scans', 'Performance', 'Noor', '2026-10-08', 'scan, index, performance, planner',
    'A scan reads every row. The planner prefers an index whenever a filter allows it, and joins reorder tables so the smaller one drives the loop.'),
  a('Syncing the same database across tabs', 'Browser', 'Omar', '2026-10-06', 'tabs, broadcastchannel, web locks, sync',
    'Web Locks serialise writers and a BroadcastChannel announces every commit. Open two tabs and each one sees the other tab changes immediately.'),
  a('Using WebDB on a static site', 'Browser', 'Lina', '2026-10-04', 'static, cdn, headers, coop',
    'No special COOP or COEP headers are needed. WebDB is an ordinary module, so it runs on any static host, CDN or PWA.'),
  a('Exporting and restoring snapshots', 'Storage', 'Sam', '2026-10-02', 'backup, export, snapshot, gzip',
    'exportBinary produces a checksummed image of the whole database that you can download, compress with gzip and later restore with importBinary.'),
  a('Streaming a remote database over HTTP', 'Browser', 'Omar', '2026-09-30', 'http, range, s3, remote',
    'Host a read-only database on object storage and query it with HTTP range requests. Only the pages a query needs are downloaded, not the whole file.'),
  a('Schema migrations that keep your data', 'Guides', 'Sam', '2026-09-28', 'migrations, alter table, schema',
    'addColumn, renameColumn and dropColumn evolve a table in place. Run them inside a versioned migration function so every client reaches the same schema.'),
  a('Primary keys, unique indexes and upserts', 'Queries', 'Noor', '2026-09-26', 'primary key, unique, upsert, constraints',
    'Declare a primary key for fast lookups and updates by id. Upsert inserts a new row or updates the existing one when a unique key conflicts.'),
  a('Subqueries in WHERE and FROM', 'Queries', 'Lina', '2026-09-24', 'subquery, whereIn, exists, derived table',
    'Pass a query builder to whereIn, whereExists or from to nest queries. Uncorrelated subqueries run once and their result is reused.'),
  a('Testing your data layer', 'Guides', 'Noor', '2026-09-22', 'testing, vitest, memory',
    'Use the in-memory storage adapter in unit tests. It behaves like the real thing but starts empty, runs in milliseconds and needs no cleanup.'),
  a('Memory limits on mobile browsers', 'Browser', 'Noor', '2026-09-20', 'mobile, memory, safari, limits',
    'Phones give tabs far less memory. Keep the page cache small, page your result sets with limit and offset, and avoid loading entire tables into arrays.'),
  a('Debugging queries with explain', 'Performance', 'Sam', '2026-09-18', 'explain, debugging, bytecode, planner',
    'explain returns the chosen plan, the estimated cost and the generated bytecode. Read it to learn whether a query scans a table or walks an index.'),
  a('Designing a todo app on WebDB', 'Guides', 'Lina', '2026-09-16', 'todo, example, vue, live queries',
    'Two live queries are enough: one for the list and one with groupBy for the counters. Writes are plain inserts and updates, and the interface never needs a manual refresh.'),
];

export async function setupSearchDb(db: WebDB): Promise<void> {
  registerSearchUdfs(db); // UDFs live in memory: register them on every page load
  const tables = await db.listTables();
  if (tables.some((t) => t.name === 'articles')) return;
  await db.createTable('articles', [
    { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
    { name: 'title', type: 'TEXT', notNull: true },
    { name: 'body', type: 'TEXT', notNull: true },
    { name: 'tags', type: 'TEXT', notNull: true },
    { name: 'author', type: 'TEXT', notNull: true },
    { name: 'category', type: 'TEXT', notNull: true, indexed: true },
    { name: 'created_at', type: 'TEXT', notNull: true },
  ]);
  await resetSearchData(db);
}

export async function resetSearchData(db: WebDB): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.from('articles').delete();
    // Clone: insertMany writes generated ids back onto the objects it is given
    await tx.insertMany('articles', SEED_ARTICLES.map((row) => ({ ...row })));
  });
}

export async function addArticle(db: WebDB, input: Pick<Article, 'title' | 'body' | 'tags' | 'category'>): Promise<void> {
  const title = input.title.trim();
  const body = input.body.trim();
  if (!title || !body) return;
  await db.insert('articles', {
    title,
    body,
    tags: input.tags.trim(),
    category: input.category,
    author: 'You',
    created_at: new Date().toISOString().slice(0, 10),
  });
}

export async function deleteArticle(db: WebDB, id: number): Promise<void> {
  await db.delete('articles', id);
}

/** A string/number as a literal in an expression (a bare string would be read as a column name). */
const lit = (value: string | number) => new ExpressionBuilder({ type: 'literal', value } as never);

/**
 * The search query. All the "intelligence" is in UDFs:
 *   relevance(title, body, tags, q, fuzzy)  -> score used in WHERE and ORDER BY
 *   highlight(title, q, fuzzy) / snippet(body, q, fuzzy)  -> <mark>ed HTML in SELECT
 *   word_count(body)                         -> used in SELECT and WHERE
 */
export function searchQuery(db: WebDB, o: SearchOptions) {
  const q = o.q.trim();
  const fuzzy = o.fuzzy ? 1 : 0;
  const score = () => fn('relevance', col('title'), col('body'), col('tags'), lit(q), lit(fuzzy));
  const wordsOf = () => fn('word_count', col('body'));

  let qb = db.from('articles').select([
    'id',
    'title',
    'author',
    'category',
    'tags',
    'created_at',
    wordsOf().as('words'),
    fn('highlight', col('title'), lit(q), lit(fuzzy)).as('title_html'),
    fn('snippet', col('body'), lit(q), lit(fuzzy)).as('snippet_html'),
    score().as('score'),
  ]);

  if (q) qb = qb.where(score().gt(0));
  if (o.category) qb = qb.where('category', '=', o.category);
  if (o.shortOnly) qb = qb.where(wordsOf().lt(SHORT_ARTICLE_WORDS));

  return q ? qb.orderBy('score', 'desc').orderBy('id', 'desc') : qb.orderBy('id', 'desc');
}

/** Total number of articles (live badge). */
export function articleCountQuery(db: WebDB) {
  return db.from('articles').count('id', 'n');
}
