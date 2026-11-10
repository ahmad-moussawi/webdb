import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { WebDB } from '../src/index.ts';
import * as todo from '../docs/.vitepress/theme/demos/todo/db.ts';
import * as kanban from '../docs/.vitepress/theme/demos/kanban/db.ts';
import * as cal from '../docs/.vitepress/theme/demos/calendar/db.ts';
import * as search from '../docs/.vitepress/theme/demos/search/db.ts';
import * as dates from '../docs/.vitepress/theme/demos/calendar/dates.ts';

// Unique names + closing: instances with the same name share a BroadcastChannel inside one process.
let opened: WebDB[] = [];
let seq = 0;
const open = async (name: string) => {
  const db = await WebDB.open({ name: `${name}_${seq++}`, storage: 'memory' });
  opened.push(db);
  return db;
};
afterEach(async () => {
  await Promise.all(opened.map((d) => d.close().catch(() => {})));
  opened = [];
});

describe('docs demo: todo', () => {
  let db: WebDB;
  beforeEach(async () => {
    db = await open('todo');
    await todo.setupTodoDb(db);
  });

  it('is idempotent and seeds once', async () => {
    await todo.setupTodoDb(db);
    expect(await db.from('todos').toArray()).toHaveLength(4);
  });

  it('adds, filters, searches, toggles and clears', async () => {
    await todo.addTodo(db, '  Buy milk ');
    await todo.addTodo(db, '   ');
    expect(await todo.todosQuery(db, 'all', '').toArray()).toHaveLength(5);
    const milk = (await todo.todosQuery(db, 'all', 'milk').toArray())[0];
    expect(milk.title).toBe('Buy milk');

    await todo.setTodoDone(db, milk.id as number, true);
    expect(await todo.todosQuery(db, 'done', '').toArray()).toHaveLength(2);
    expect(await todo.todosQuery(db, 'active', '').toArray()).toHaveLength(3);

    const stats = await todo.todoStatsQuery(db).toArray();
    expect(Object.fromEntries(stats.map((s) => [s.done, s.n]))).toEqual({ 0: 3, 1: 2 });

    expect(await todo.clearCompleted(db)).toBe(2);
    await todo.setAllDone(db, true);
    expect(await todo.todosQuery(db, 'active', '').toArray()).toHaveLength(0);
  });

  it('live query re-runs on changes', async () => {
    const seen: number[] = [];
    const live = todo.todosQuery(db, 'all', '').live((rows) => seen.push(rows.length));
    await new Promise((r) => setTimeout(r, 20));
    await todo.addTodo(db, 'x');
    await new Promise((r) => setTimeout(r, 40));
    live.destroy();
    expect(seen[seen.length - 1]).toBe(5);
  });

  it('reset restores the seed', async () => {
    await todo.addTodo(db, 'x');
    await todo.resetTodoData(db);
    expect(await db.from('todos').toArray()).toHaveLength(4);
  });
});

describe('docs demo: kanban', () => {
  let db: WebDB;
  beforeEach(async () => {
    db = await open('kanban');
    await kanban.setupKanbanDb(db);
  });

  const board = async () => {
    const lists = await kanban.listsQuery(db).toArray();
    const cards = await kanban.cardsQuery(db).toArray();
    return lists.map((l) => ({
      title: l.title as string,
      cards: cards.filter((c) => c.list_id === l.id).map((c) => c.title as string),
      positions: cards.filter((c) => c.list_id === l.id).map((c) => c.position as number),
    }));
  };

  it('seeds three lists', async () => {
    const b = await board();
    expect(b.map((l) => l.title)).toEqual(['To do', 'In progress', 'Done']);
    expect(b[0].cards).toHaveLength(3);
  });

  it('moves a card across lists keeping positions gap-free', async () => {
    const first = (await db.from('cards').where('title', '=', 'Drag me to another column').first())!;
    const doing = (await db.from('lists').where('title', '=', 'In progress').first())!;
    await kanban.moveCard(db, first.id as number, doing.id as number, 0);
    const b = await board();
    expect(b[1].cards[0]).toBe('Drag me to another column');
    expect(b[1].positions).toEqual([0, 1]);
    expect(b[0].cards).toHaveLength(2);
    expect(b[0].positions).toEqual([0, 1]);
  });

  it('reorders within a list', async () => {
    const todoList = (await db.from('lists').where('title', '=', 'To do').first())!;
    const cards = await db.from('cards').where('list_id', '=', todoList.id).orderBy('position').toArray();
    await kanban.moveCard(db, cards[2].id as number, todoList.id as number, 0);
    const b = await board();
    expect(b[0].cards[0]).toBe(cards[2].title);
    expect(b[0].positions).toEqual([0, 1, 2]);
  });

  it('adds/renames/deletes cards and lists, and counts per list', async () => {
    const lists = await kanban.listsQuery(db).toArray();
    await kanban.addCard(db, lists[2].id as number, 'New');
    const created = (await db.from('cards').where('title', '=', 'New').first())!;
    expect(created.position).toBe(2);
    await kanban.renameCard(db, created.id as number, 'Renamed');
    expect((await db.from('cards').where('id', '=', created.id).first())!.title).toBe('Renamed');
    const counts = await kanban.cardCountsQuery(db).toArray();
    expect(counts.find((c) => c.list_id === lists[2].id)!.n).toBe(3);
    await kanban.deleteList(db, lists[2].id as number);
    expect(await db.from('cards').where('list_id', '=', lists[2].id).toArray()).toHaveLength(0);
    await kanban.addList(db, 'Archive');
    expect((await kanban.listsQuery(db).toArray()).map((l) => l.title)).toEqual(['To do', 'In progress', 'Archive']);
  });
});

describe('docs demo: calendar', () => {
  let db: WebDB;
  beforeEach(async () => {
    db = await open('calendar');
    await cal.setupCalendarDb(db);
  });

  it('month grid is 6 Monday-first weeks covering the month', () => {
    const grid = dates.monthGrid(new Date(2026, 10, 15)); // Nov 2026
    expect(grid).toHaveLength(42);
    expect(grid[0].getDay()).toBe(1);
    expect(dates.ymd(grid[0])).toBe('2026-10-26');
    expect(grid.some((d) => dates.ymd(d) === '2026-11-30')).toBe(true);
    expect(dates.gridRange(new Date(2026, 10, 15))).toEqual({ from: '2026-10-26 00:00', to: '2026-12-07 00:00' });
    expect(dates.addMinutes('2026-11-30 23:30', 60)).toBe('2026-12-01 00:30');
  });

  it('queries a visible range in order and supports CRUD', async () => {
    await cal.addAppointment(db, {
      title: 'Far future',
      start_at: '2099-01-02 10:00',
      end_at: '2099-01-02 11:00',
      color: cal.COLORS[0],
      notes: '',
    });
    const jan = dates.gridRange(new Date(2099, 0, 1));
    const rows = await cal.appointmentsBetween(db, jan.from, jan.to).toArray();
    expect(rows.map((r) => r.title)).toEqual(['Far future']);

    await cal.updateAppointment(db, rows[0].id as number, { title: 'Moved', start_at: '2099-01-03 09:00' });
    const after = await cal.appointmentsBetween(db, jan.from, jan.to).toArray();
    expect(after[0]).toMatchObject({ title: 'Moved', start_at: '2099-01-03 09:00' });

    const count = await cal.monthCountQuery(db, 2099, 0).toArray();
    expect(count[0].n).toBe(1);
    await cal.deleteAppointment(db, rows[0].id as number);
    expect(await cal.appointmentsBetween(db, jan.from, jan.to).toArray()).toHaveLength(0);
  });

  it('upcoming returns only future items, soonest first, limited', async () => {
    const now = dates.ymdhm(new Date());
    const up = await cal.upcomingQuery(db, now, 3).toArray();
    expect(up.length).toBeLessThanOrEqual(3);
    for (const a of up) expect((a.start_at as string) >= now).toBe(true);
    const sorted = [...up].sort((a, b) => (a.start_at as string).localeCompare(b.start_at as string));
    expect(up).toEqual(sorted);
  });
});

import * as search from '../docs/.vitepress/theme/demos/search/db.ts';
import * as udfs from '../docs/.vitepress/theme/demos/search/udfs.ts';

describe('docs demo: search UDFs', () => {
  let db: WebDB;
  const run = (o: Partial<search.SearchOptions> = {}) =>
    search.searchQuery(db, { q: '', fuzzy: true, shortOnly: false, category: '', ...o }).toArray();
  const titles = async (o: Partial<search.SearchOptions>) => (await run(o)).map((r) => r.title as string);

  beforeEach(async () => {
    db = await open('search');
    await search.setupSearchDb(db);
  });

  it('pure helpers: normalisation, edit distance, matching', () => {
    expect(udfs.norm('Café NAÏVE')).toBe('cafe naive');
    expect(udfs.withinEdits('reactive', 'reactve', 1)).toBe(true);
    expect(udfs.withinEdits('reactive', 'xeactve', 1)).toBe(false);
    expect(udfs.matchWord('indexes', 'index', false)).toBe(2);
    expect(udfs.matchWord('index', 'index', false)).toBe(3);
    expect(udfs.matchWord('reactive', 'reactve', true)).toBe(1);
    expect(udfs.matchWord('reactive', 'reactve', false)).toBe(0);
    expect(udfs.wordCount('  a b\nc ')).toBe(3);
  });

  it('highlight escapes HTML and marks matches; snippet centres on the first match', () => {
    expect(udfs.highlight('Use <b>index</b> & go', 'index', 0)).toBe('Use &lt;b&gt;<mark>index</mark>&lt;/b&gt; &amp; go');
    expect(udfs.highlight('Café au lait', 'cafe', 0)).toBe('<mark>Café</mark> au lait');
    const long = `${'lorem ipsum '.repeat(30)}needle ${'dolor sit '.repeat(30)}`;
    const s = udfs.snippet(long, 'needle', 0);
    expect(s).toContain('<mark>needle</mark>');
    expect(s.startsWith('…') && s.endsWith('…')).toBe(true);
    expect(s.length).toBeLessThan(260);
    expect(udfs.snippet('short text', '', 0)).toBe('short text');
  });

  it('seeds the articles once (idempotent setup, UDFs re-registered)', async () => {
    await search.setupSearchDb(db);
    expect(await db.from('articles').toArray()).toHaveLength(search.SEED_ARTICLES.length);
  });

  it('empty query lists everything newest first', async () => {
    const rows = await run();
    expect(rows).toHaveLength(search.SEED_ARTICLES.length);
    const ids = rows.map((r) => r.id as number);
    expect(ids).toEqual([...ids].sort((x, y) => y - x));
  });

  it('ranks title matches above body-only matches', async () => {
    const rows = await run({ q: 'index' });
    expect(rows.length).toBeGreaterThan(2);
    expect(rows[0].title).toBe('Indexes make queries fast');
    const scores = rows.map((r) => r.score as number);
    expect(scores).toEqual([...scores].sort((x, y) => y - x));
    expect(rows[0].title_html).toContain('<mark>Indexes</mark>');
    expect(rows[0].snippet_html).toContain('<mark>');
  });

  it('requires every word to match (AND)', async () => {
    const both = await titles({ q: 'live queries' });
    expect(both).toContain('Reactive UIs with live queries');
    expect(await titles({ q: 'live zebra' })).toEqual([]);
  });

  it('typo tolerance is a toggle', async () => {
    expect(await titles({ q: 'reactve', fuzzy: true })).toContain('Reactive UIs with live queries');
    expect(await titles({ q: 'reactve', fuzzy: false })).toEqual([]);
  });

  it('is accent-insensitive in both directions', async () => {
    expect(await titles({ q: 'cafe' })).toContain('Café-style caching for repeated reads');
    expect(await titles({ q: 'café' })).toContain('Café-style caching for repeated reads');
    expect(await titles({ q: 'naive' })).toContain('Why we avoid naïve full table scans');
  });

  it('searches tags and combines with category and the word_count filter', async () => {
    expect(await titles({ q: 'broadcastchannel' })).toEqual(['Syncing the same database across tabs']);
    const storage = await run({ q: 'storage', category: 'Storage' });
    expect(storage.length).toBeGreaterThan(0);
    for (const r of storage) expect(r.category).toBe('Storage');
    const short = await run({ shortOnly: true });
    expect(short.length).toBeGreaterThan(0);
    expect(short.length).toBeLessThan(search.SEED_ARTICLES.length);
    for (const r of short) expect(r.words as number).toBeLessThan(search.SHORT_ARTICLE_WORDS);
  });

  it('treats quotes and HTML in the query as plain text', async () => {
    expect(await run({ q: `it's "<script>"` })).toEqual([]);
    const row = (await run({ q: 'index' }))[0];
    expect(String(row.title_html)).not.toContain('<script');
  });

  it('adds and deletes articles; a live search query follows', async () => {
    const seen: string[][] = [];
    const live = search
      .searchQuery(db, { q: 'quantum', fuzzy: true, shortOnly: false, category: '' })
      .live((rows) => seen.push(rows.map((r) => r.title as string)));
    await new Promise((r) => setTimeout(r, 20));
    expect(seen[seen.length - 1]).toEqual([]);
    await search.addArticle(db, { title: 'Quantum notes', body: 'Nothing to see', tags: 'x', category: 'Guides' });
    await new Promise((r) => setTimeout(r, 40));
    expect(seen[seen.length - 1]).toEqual(['Quantum notes']);
    const added = (await db.from('articles').where('title', '=', 'Quantum notes').first())!;
    await search.deleteArticle(db, added.id as number);
    await new Promise((r) => setTimeout(r, 40));
    live.destroy();
    expect(seen[seen.length - 1]).toEqual([]);
    expect((await search.articleCountQuery(db).toArray())[0].n).toBe(search.SEED_ARTICLES.length);
    await search.addArticle(db, { title: '  ', body: 'x', tags: '', category: 'Guides' });
    expect((await search.articleCountQuery(db).toArray())[0].n).toBe(search.SEED_ARTICLES.length);
  });

  it('reset restores the seed', async () => {
    await search.addArticle(db, { title: 'x', body: 'y', tags: '', category: 'Guides' });
    await search.resetSearchData(db);
    expect(await db.from('articles').toArray()).toHaveLength(search.SEED_ARTICLES.length);
  });
});

describe('docs demos on indexeddb storage (page fault + sorter regression)', () => {
  it('runs todo, calendar, kanban, and search demos smoothly with storage: idb', async () => {
    const todoDb = await WebDB.open({ name: `idb_demo_todo_${seq++}`, storage: 'idb' });
    opened.push(todoDb);
    await todo.setupTodoDb(todoDb);
    const todoRows = await todo.todosQuery(todoDb, 'all', '').toArray();
    expect(todoRows).toHaveLength(4);
    const todoStats = await todo.todoStatsQuery(todoDb).toArray();
    expect(todoStats.length).toBeGreaterThan(0);

    const calDb = await WebDB.open({ name: `idb_demo_cal_${seq++}`, storage: 'idb' });
    opened.push(calDb);
    await cal.setupCalendarDb(calDb);
    const calUpcoming = await cal.upcomingQuery(calDb, new Date().toISOString()).toArray();
    expect(calUpcoming.length).toBeGreaterThan(0);

    const kanbanDb = await WebDB.open({ name: `idb_demo_kanban_${seq++}`, storage: 'idb' });
    opened.push(kanbanDb);
    await kanban.setupKanbanDb(kanbanDb);
    const lists = await kanban.listsQuery(kanbanDb).toArray();
    const cards = await kanban.cardsQuery(kanbanDb).toArray();
    expect(lists).toHaveLength(3);
    expect(cards).toHaveLength(6);

    const searchDb = await WebDB.open({ name: `idb_demo_search_${seq++}`, storage: 'idb' });
    opened.push(searchDb);
    await search.setupSearchDb(searchDb);
    const searchCount = await search.articleCountQuery(searchDb).toArray();
    expect(searchCount[0].n).toBe(search.SEED_ARTICLES.length);
    const searchResults = await search.searchQuery(searchDb, { q: 'WebDB', fuzzy: false }).toArray();
    expect(searchResults.length).toBeGreaterThan(0);
  });
});
