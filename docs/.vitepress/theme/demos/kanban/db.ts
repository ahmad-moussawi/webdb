import type { WebDB } from '@ahmadmoussawi/webdb';

export const KANBAN_DB_NAME = 'demo_kanban';

export interface KanbanList {
  id: number;
  title: string;
  position: number;
}

export interface KanbanCard {
  id: number;
  list_id: number;
  title: string;
  position: number;
}

export async function setupKanbanDb(db: WebDB): Promise<void> {
  const tables = await db.listTables();
  if (tables.some((t) => t.name === 'lists') && tables.some((t) => t.name === 'cards')) return;
  await db.createTable('lists', [
    { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
    { name: 'title', type: 'TEXT', notNull: true },
    { name: 'position', type: 'INT32', notNull: true },
  ]);
  await db.createTable('cards', [
    { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
    { name: 'list_id', type: 'INT32', notNull: true, indexed: true },
    { name: 'title', type: 'TEXT', notNull: true },
    { name: 'position', type: 'INT32', notNull: true },
  ]);
  await resetKanbanData(db);
}

export async function resetKanbanData(db: WebDB): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.from('cards').delete();
    await tx.from('lists').delete();
    await tx.insertMany('lists', [
      { title: 'To do', position: 0 },
      { title: 'In progress', position: 1 },
      { title: 'Done', position: 2 },
    ]);
    const lists = await tx.from('lists').orderBy('position').toArray();
    const [todo, doing, done] = lists.map((l) => l.id as number);
    const card = (list_id: number, position: number, title: string) => ({ list_id, position, title });
    await tx.insertMany('cards', [
      card(todo, 0, 'Drag me to another column'),
      card(todo, 1, 'Open a second tab: moves appear instantly'),
      card(todo, 2, 'Double-click a card to rename it'),
      card(doing, 0, 'Build a Trello-style board with WebDB'),
      card(done, 0, 'Create tables with db.createTable()'),
      card(done, 1, 'Subscribe with useLiveQuery()'),
    ]);
  });
}

export function listsQuery(db: WebDB) {
  return db.from('lists').orderBy('position');
}

/** All cards in board order. The board groups them by list_id in the UI. */
export function cardsQuery(db: WebDB) {
  return db.from('cards').orderBy('list_id').orderBy('position');
}

/** `SELECT list_id, COUNT(*) FROM cards GROUP BY list_id` */
export function cardCountsQuery(db: WebDB) {
  return db.from('cards').groupBy('list_id').count('id', 'n');
}

export async function addList(db: WebDB, title: string): Promise<void> {
  const clean = title.trim();
  if (!clean) return;
  const last = await db.from('lists').orderBy('position', 'desc').first();
  await db.insert('lists', { title: clean, position: ((last?.position as number) ?? -1) + 1 });
}

export async function deleteList(db: WebDB, listId: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete('cards', { list_id: listId });
    await tx.delete('lists', listId);
  });
}

export async function addCard(db: WebDB, listId: number, title: string): Promise<void> {
  const clean = title.trim();
  if (!clean) return;
  const last = await db.from('cards').where('list_id', '=', listId).orderBy('position', 'desc').first();
  await db.insert('cards', {
    list_id: listId,
    title: clean,
    position: ((last?.position as number) ?? -1) + 1,
  });
}

export async function renameCard(db: WebDB, cardId: number, title: string): Promise<void> {
  const clean = title.trim();
  if (!clean) return;
  await db.update('cards', cardId, { title: clean });
}

export async function deleteCard(db: WebDB, cardId: number): Promise<void> {
  await db.delete('cards', cardId);
}

/**
 * Moves a card to `toIndex` of `toListId` and renumbers positions so both the source and
 * target lists stay gap-free. Runs in one transaction, so every open live query (and every
 * other tab) sees a single consistent change.
 */
export async function moveCard(db: WebDB, cardId: number, toListId: number, toIndex: number): Promise<void> {
  await db.transaction(async (tx) => {
    const card = await tx.from('cards').where('id', '=', cardId).first();
    if (!card) return;
    const fromListId = card.list_id as number;

    const target = (await tx.from('cards').where('list_id', '=', toListId).orderBy('position').toArray()).filter(
      (c) => c.id !== cardId,
    );
    const index = Math.max(0, Math.min(toIndex, target.length));
    target.splice(index, 0, { ...card, list_id: toListId });

    for (let i = 0; i < target.length; i++) {
      const c = target[i];
      if (c.id === cardId ? c.position !== i || fromListId !== toListId : c.position !== i) {
        await tx.update('cards', c.id as number, { list_id: toListId, position: i });
      }
    }

    if (fromListId !== toListId) {
      const source = (await tx.from('cards').where('list_id', '=', fromListId).orderBy('position').toArray());
      for (let i = 0; i < source.length; i++) {
        if (source[i].position !== i) await tx.update('cards', source[i].id as number, { position: i });
      }
    }
  });
}
