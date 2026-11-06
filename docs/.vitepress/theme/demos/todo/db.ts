import type { WebDB } from '@ahmadmoussawi/webdb';

export const TODO_DB_NAME = 'demo_todo';

export type TodoFilter = 'all' | 'active' | 'done';

export interface Todo {
  id: number;
  title: string;
  done: number; // 0 | 1 (WebDB has no BOOLEAN type, INT32 is the idiomatic flag)
  created_at: string;
}

const SEED: Array<Pick<Todo, 'title' | 'done'>> = [
  { title: 'Open this page in a second tab and watch it update', done: 0 },
  { title: 'Add a todo using the box above', done: 0 },
  { title: 'Tick me to move the counters', done: 0 },
  { title: 'Reload the page: data is persisted in IndexedDB', done: 1 },
];

/** Creates the schema on first run, then seeds it. Safe to call on every page load. */
export async function setupTodoDb(db: WebDB): Promise<void> {
  const tables = await db.listTables();
  if (!tables.some((t) => t.name === 'todos')) {
    await db.createTable('todos', [
      { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
      { name: 'title', type: 'TEXT', notNull: true },
      { name: 'done', type: 'INT32', notNull: true },
      { name: 'created_at', type: 'TEXT', notNull: true },
    ]);
    await resetTodoData(db);
  }
}

/** Replaces all rows with the seed data in ONE transaction (live queries refresh once). */
export async function resetTodoData(db: WebDB): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.from('todos').delete();
    await tx.insertMany(
      'todos',
      SEED.map((t) => ({ ...t, created_at: new Date().toISOString() })),
    );
  });
}

export async function addTodo(db: WebDB, title: string): Promise<void> {
  const clean = title.trim();
  if (!clean) return;
  await db.insert('todos', { title: clean, done: 0, created_at: new Date().toISOString() });
}

export async function setTodoDone(db: WebDB, id: number, done: boolean): Promise<void> {
  await db.update('todos', id, { done: done ? 1 : 0 });
}

export async function renameTodo(db: WebDB, id: number, title: string): Promise<void> {
  const clean = title.trim();
  if (!clean) return;
  await db.update('todos', id, { title: clean });
}

export async function deleteTodo(db: WebDB, id: number): Promise<void> {
  await db.delete('todos', id);
}

export async function clearCompleted(db: WebDB): Promise<number> {
  return db.from('todos').where('done', '=', 1).delete();
}

export async function setAllDone(db: WebDB, done: boolean): Promise<void> {
  await db.from('todos').where('done', '=', done ? 0 : 1).update({ done: done ? 1 : 0 });
}

/** The query behind the list. Re-run automatically by `useLiveQuery` whenever `todos` changes. */
export function todosQuery(db: WebDB, filter: TodoFilter, search: string) {
  let q = db.from('todos');
  if (filter === 'active') q = q.where('done', '=', 0);
  if (filter === 'done') q = q.where('done', '=', 1);
  const s = search.trim();
  if (s) q = q.whereContains('title', s);
  return q.orderBy('id', 'desc');
}

/** `SELECT done, COUNT(*) FROM todos GROUP BY done` */
export function todoStatsQuery(db: WebDB) {
  return db.from('todos').groupBy('done').count('id', 'n');
}
