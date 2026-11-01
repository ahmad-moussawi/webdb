import { describe, it, expect } from 'vitest';
import {
  WebDB,
  DataType,
  UniqueConstraintViolationError,
  NotNullConstraintError,
  ColumnNotFoundError,
  Changeset,
  TableChangeEvent,
  MemoryVfsAdapter,
} from '../src/index.ts';

describe('Low-Level Sync Primitives & High-Level DML (update, delete, upsert, hooks, subscribe)', () => {
  it('1. executes in-place and page-overflow updates while keeping secondary indexes exact', async () => {
    const db = await WebDB.open({ name: 'dml_update_db' });

    await db.createTable('items', [
      { name: 'id', type: DataType.INT32, primaryKey: true },
      { name: 'code', type: DataType.TEXT },
      { name: 'payload', type: DataType.TEXT },
      { name: 'qty', type: DataType.INT32 },
    ]);
    await db.createIndex('items', 'code', { unique: true });
    await db.createIndex('items', 'qty');

    // Insert 15 rows with ~250-byte payloads so Page 2 is mostly full (~3.8 KB)
    const initialRows = Array.from({ length: 15 }, (_, i) => ({
      id: i + 1,
      code: `CODE_${String(i + 1).padStart(2, '0')}`,
      payload: 'x'.repeat(220),
      qty: (i + 1) * 10,
    }));
    await db.insertMany('items', initialRows);

    // Scenario A/B: In-place update by primary key
    const updated1 = await db.update('items', 3, {
      code: 'CODE_03_UPDATED',
      qty: 350,
    });
    expect(updated1).toBe(1);

    // Verify old index key is gone and new index key resolves
    const oldLookup = await db
      .from('items')
      .where('code', '=', 'CODE_03')
      .toArray();
    expect(oldLookup).toHaveLength(0);

    const newLookup = await db
      .from('items')
      .where('code', '=', 'CODE_03_UPDATED')
      .toArray();
    expect(newLookup).toHaveLength(1);
    expect(newLookup[0].id).toBe(3);
    expect(newLookup[0].qty).toBe(350);

    // Scenario C: Page-overflow update (expand row 5 payload to 1,600 bytes so it moves to a new tail page
    // and shifts cells 6..15 on the original page!)
    const bigPayload = 'LARGE_'.repeat(250);
    const updatedOverflow = await db
      .from('items')
      .where('id', '=', 5)
      .update({ code: 'CODE_05_BIG', payload: bigPayload, qty: 999 });
    expect(updatedOverflow).toBe(1);

    // Verify the moved row is found via secondary index
    const movedRow = await db
      .from('items')
      .where('code', '=', 'CODE_05_BIG')
      .first();
    expect(movedRow).not.toBeNull();
    expect(movedRow!.id).toBe(5);
    expect(movedRow!.payload).toBe(bigPayload);
    expect(movedRow!.qty).toBe(999);

    // Verify all subsequent rows (6..15) whose slot index shifted on the original page
    // still resolve accurately via secondary index lookups!
    for (let id = 6; id <= 15; id++) {
      const code = `CODE_${String(id).padStart(2, '0')}`;
      const found = await db.from('items').where('code', '=', code).first();
      expect(found).not.toBeNull();
      expect(found!.id).toBe(id);
      expect(found!.qty).toBe(id * 10);
    }

    // Constraint validation on update: unique violation, PK null violation, unknown column
    await expect(
      db.update('items', 1, { code: 'CODE_02' }),
    ).rejects.toThrow(UniqueConstraintViolationError);

    await expect(
      db.update('items', 1, { id: null }),
    ).rejects.toThrow(NotNullConstraintError);

    await expect(
      db.update('items', 1, { non_existent: 'val' }),
    ).rejects.toThrow(ColumnNotFoundError);

    await db.close();
  });

  it('2. deletes rows and shifts surviving cell index rowids on the same page accurately', async () => {
    const db = await WebDB.open({ name: 'dml_delete_db' });

    await db.createTable('users', [
      { name: 'id', type: DataType.INT32, primaryKey: true },
      { name: 'email', type: DataType.TEXT },
      { name: 'role', type: DataType.TEXT },
    ]);
    await db.createIndex('users', 'email', { unique: true });
    await db.createIndex('users', 'role');

    await db.insertMany('users', [
      { id: 1, email: 'u1@test.com', role: 'admin' },
      { id: 2, email: 'u2@test.com', role: 'guest' },
      { id: 3, email: 'u3@test.com', role: 'member' },
      { id: 4, email: 'u4@test.com', role: 'guest' },
      { id: 5, email: 'u5@test.com', role: 'member' },
      { id: 6, email: 'u6@test.com', role: 'admin' },
    ]);

    // Delete by PK (id = 2)
    const del1 = await db.delete('users', 2);
    expect(del1).toBe(1);

    // Delete via QueryBuilder (role = 'guest' -> deletes id = 4)
    const del2 = await db.from('users').where('role', '=', 'guest').delete();
    expect(del2).toBe(1);

    // Verify deleted emails are gone from unique index (and can be re-inserted!)
    expect(
      await db.from('users').where('email', '=', 'u2@test.com').first(),
    ).toBeNull();
    expect(
      await db.from('users').where('email', '=', 'u4@test.com').first(),
    ).toBeNull();

    // Verify all surviving rows (1, 3, 5, 6) whose slot indices shifted on the page
    // are still found via both unique email index and role index!
    for (const id of [1, 3, 5, 6]) {
      const row = await db
        .from('users')
        .where('email', '=', `u${id}@test.com`)
        .first();
      expect(row).not.toBeNull();
      expect(row!.id).toBe(id);
    }

    const members = await db
      .from('users')
      .where('role', '=', 'member')
      .orderBy('id', 'asc')
      .toArray();
    expect(members.map((m) => m.id)).toEqual([3, 5]);

    // Re-inserting previously deleted unique key succeeds cleanly
    await db.insert('users', { id: 20, email: 'u2@test.com', role: 'member' });
    const reinserted = await db
      .from('users')
      .where('email', '=', 'u2@test.com')
      .first();
    expect(reinserted?.id).toBe(20);

    await db.close();
  });

  it('3. supports upsert and upsertMany with merge, replace, ignore, custom conflictTarget, and LWW where guard', async () => {
    const db = await WebDB.open({ name: 'dml_upsert_db' });

    await db.createTable('docs', [
      { name: 'id', type: DataType.TEXT, primaryKey: true },
      { name: 'slug', type: DataType.TEXT },
      { name: 'title', type: DataType.TEXT },
      { name: 'body', type: DataType.TEXT },
      { name: 'updated_at', type: DataType.INT64 },
    ]);
    await db.createIndex('docs', 'slug', { unique: true });

    // Initial insert via upsert
    const r1 = await db.upsert('docs', {
      id: 'doc-1',
      slug: 'welcome',
      title: 'Welcome v1',
      body: 'Initial body',
      updated_at: 1000n,
    });
    expect(r1).toBe('inserted');

    // 1. mode: 'merge' (default) updates only provided fields, preserving body
    const r2 = await db.upsert('docs', {
      id: 'doc-1',
      title: 'Welcome v2',
      updated_at: 2000n,
    });
    expect(r2).toBe('updated');
    let doc1 = await db.from('docs').where('id', '=', 'doc-1').first();
    expect(doc1).toEqual({
      id: 'doc-1',
      slug: 'welcome',
      title: 'Welcome v2',
      body: 'Initial body',
      updated_at: 2000n,
    });

    // 2. Conditional LWW guard: stale incoming row (updated_at: 1500n < 2000n) is ignored
    const r3 = await db.upsert(
      'docs',
      {
        id: 'doc-1',
        title: 'Stale Title',
        updated_at: 1500n,
      },
      {
        where: (existing, incoming) =>
          (incoming.updated_at as bigint) > (existing.updated_at as bigint),
      },
    );
    expect(r3).toBe('ignored');
    doc1 = await db.from('docs').where('id', '=', 'doc-1').first();
    expect(doc1!.title).toBe('Welcome v2');

    // 3. Conditional LWW guard: newer incoming row (updated_at: 3000n > 2000n) is applied
    const r4 = await db.upsert(
      'docs',
      {
        id: 'doc-1',
        title: 'Fresh Title v3',
        updated_at: 3000n,
      },
      {
        where: (existing, incoming) =>
          (incoming.updated_at as bigint) > (existing.updated_at as bigint),
      },
    );
    expect(r4).toBe('updated');
    doc1 = await db.from('docs').where('id', '=', 'doc-1').first();
    expect(doc1!.title).toBe('Fresh Title v3');

    // 4. Custom conflictTarget on unique column 'slug' + mode: 'replace'
    const r5 = await db.upsert(
      'docs',
      {
        slug: 'welcome',
        title: 'Replaced via Slug',
        updated_at: 4000n,
      },
      {
        conflictTarget: 'slug',
        mode: 'replace',
      },
    );
    expect(r5).toBe('updated');
    doc1 = await db.from('docs').where('id', '=', 'doc-1').first();
    expect(doc1).toEqual({
      id: 'doc-1',
      slug: 'welcome',
      title: 'Replaced via Slug',
      body: null, // cleared by replace mode since body was omitted
      updated_at: 4000n,
    });

    // 5. Batch upsertMany with mixed insert, update, and ignore
    const batchStats = await db.upsertMany(
      'docs',
      [
        {
          id: 'doc-1',
          slug: 'welcome',
          title: 'Older Remote',
          body: 'Ignored',
          updated_at: 3500n,
        },
        {
          id: 'doc-1',
          slug: 'welcome',
          title: 'Newer Remote',
          body: 'Updated body',
          updated_at: 5000n,
        },
        {
          id: 'doc-2',
          slug: 'second',
          title: 'Second Doc',
          body: 'Body 2',
          updated_at: 1000n,
        },
      ],
      {
        origin: 'remote',
        where: (existing, incoming) =>
          (incoming.updated_at as bigint) > (existing.updated_at as bigint),
      },
    );
    expect(batchStats).toEqual({ inserted: 1, updated: 1, ignored: 1 });

    await db.close();
  });

  it('4. captures Changesets, coalesces intra-transaction mutations, and respects nested savepoints', async () => {
    const db = await WebDB.open({ name: 'sync_coalesce_db' });

    await db.createTable('tasks', [
      { name: 'id', type: DataType.INT32, primaryKey: true },
      { name: 'title', type: DataType.TEXT },
      { name: 'done', type: DataType.INT32 },
    ]);

    // Seed rows 1 and 2 before tracking
    await db.insertMany('tasks', [
      { id: 1, title: 'Task 1', done: 0 },
      { id: 2, title: 'Task 2', done: 0 },
    ]);

    const committedChangesets: Changeset[] = [];
    db.onCommit((cs) => {
      committedChangesets.push(cs);
    });

    await db.transaction(
      async (tx) => {
        // Case A: update + update on existing row 1 -> coalesces into single update with original oldRow & combined changedColumns
        await tx.update('tasks', 1, { title: 'Task 1 Edited' });
        await tx.update('tasks', 1, { done: 1 });

        // Case B: update + delete on existing row 2 -> coalesces into single delete with original oldRow
        await tx.update('tasks', 2, { title: 'Temp before delete' });
        await tx.delete('tasks', 2);

        // Case C: insert + update on new row 3 -> coalesces into single insert with final newRow
        await tx.insert('tasks', { id: 3, title: 'Draft 3', done: 0 });
        await tx.update('tasks', 3, { title: 'Final 3', done: 1 });

        // Case D: insert + delete on new row 4 -> coalesces into nothing (net no-op!)
        await tx.insert('tasks', { id: 4, title: 'Ephemeral 4', done: 0 });
        await tx.delete('tasks', 4);

        // Case E: nested savepoint that aborts -> its mutations must be rolled back from changeset!
        await expect(
          tx.transaction(async (nested) => {
            await nested.insert('tasks', {
              id: 5,
              title: 'Rolled back 5',
              done: 0,
            });
            await nested.update('tasks', 1, { title: 'Aborted Title' });
            throw new Error('Abort savepoint');
          }),
        ).rejects.toThrow('Abort savepoint');
      },
      { origin: 'local', meta: { actor: 'user-42' } },
    );

    expect(committedChangesets).toHaveLength(1);
    const cs = committedChangesets[0];
    expect(cs.origin).toBe('local');
    expect(cs.meta).toEqual({ actor: 'user-42' });
    expect(cs.changes).toHaveLength(8); // 8 raw operations outside the rolled-back savepoint

    const coalesced = cs.coalesced();
    expect(coalesced).toEqual([
      {
        table: 'tasks',
        op: 'update',
        pk: 1,
        oldRow: { id: 1, title: 'Task 1', done: 0 },
        newRow: { id: 1, title: 'Task 1 Edited', done: 1 },
        changedColumns: ['title', 'done'],
      },
      {
        table: 'tasks',
        op: 'delete',
        pk: 2,
        oldRow: { id: 2, title: 'Task 2', done: 0 },
      },
      {
        table: 'tasks',
        op: 'insert',
        pk: 3,
        newRow: { id: 3, title: 'Final 3', done: 1 },
      },
    ]);

    await db.close();
  });

  it('5. supports atomic outbox pattern via onBeforeCommit with origin filtering and rollback safety', async () => {
    const db = await WebDB.open({ name: 'sync_outbox_db' });

    await db.createTable('notes', [
      { name: 'id', type: DataType.INT32, primaryKey: true },
      { name: 'text', type: DataType.TEXT },
    ]);
    await db.createTable('_outbox', [
      { name: 'seq', type: DataType.INT32, primaryKey: true, autoIncrement: true },
      { name: 'table_name', type: DataType.TEXT },
      { name: 'op', type: DataType.TEXT },
      { name: 'pk', type: DataType.INT32 },
      { name: 'payload', type: DataType.TEXT },
    ]);

    let shouldFailOutbox = false;

    db.onBeforeCommit(async (cs, tx) => {
      // Only record local mutations in the outbox (ignore remote sync pulls)
      if (cs.origin !== 'local') return;
      if (shouldFailOutbox) {
        throw new Error('Simulated outbox failure');
      }
      for (const m of cs.coalesced()) {
        await tx.insert('_outbox', {
          table_name: m.table,
          op: m.op,
          pk: m.pk as number,
          payload: JSON.stringify(m.newRow ?? m.oldRow),
        });
      }
    });

    // 1. Standalone local insert automatically wraps in a transaction with onBeforeCommit
    await db.insert('notes', { id: 1, text: 'Local Note 1' });

    let outboxRows = await db.from('_outbox').orderBy('seq', 'asc').toArray();
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]).toMatchObject({
      seq: 1,
      table_name: 'notes',
      op: 'insert',
      pk: 1,
      payload: JSON.stringify({ id: 1, text: 'Local Note 1' }),
    });

    // 2. Remote upsert (origin: 'remote') applies to 'notes' without adding to '_outbox'
    await db.upsert(
      'notes',
      { id: 2, text: 'Remote Note 2' },
      { origin: 'remote' },
    );
    expect(await db.from('notes').toArray()).toHaveLength(2);
    expect(await db.from('_outbox').toArray()).toHaveLength(1);

    // 3. If onBeforeCommit throws, both the note mutation and outbox write roll back atomically!
    shouldFailOutbox = true;
    await expect(
      db.insert('notes', { id: 3, text: 'Should Rollback' }),
    ).rejects.toThrow('Simulated outbox failure');

    expect(await db.from('notes').where('id', '=', 3).first()).toBeNull();
    expect(await db.from('_outbox').toArray()).toHaveLength(1);

    await db.close();
  });

  it('6. notifies db.subscribe() locally and across instances in real time via BroadcastChannel', async () => {
    const sharedVfs = new MemoryVfsAdapter();
    const dbTab1 = await WebDB.open({
      name: 'shared_realtime_db',
      vfs: sharedVfs,
    });

    await dbTab1.createTable('messages', [
      { name: 'id', type: DataType.INT32, primaryKey: true },
      { name: 'body', type: DataType.TEXT },
    ]);
    await dbTab1.checkpoint();

    const dbTab2 = await WebDB.open({
      name: 'shared_realtime_db',
      vfs: sharedVfs,
    });

    const tab1Events: TableChangeEvent[] = [];
    const tab2Events: TableChangeEvent[] = [];

    const unsub1 = dbTab1.subscribe('messages', (ev) => {
      tab1Events.push(ev);
    });

    const crossTabPromise = new Promise<TableChangeEvent>((resolve) => {
      dbTab2.subscribe('messages', (ev) => {
        tab2Events.push(ev);
        if (ev.crossTab) {
          resolve(ev);
        }
      });
    });

    // Insert on Tab 1 and checkpoint so shared VFS has the latest pages
    await dbTab1.insert(
      'messages',
      { id: 101, body: 'Hello from Tab 1' },
      { origin: 'local', meta: { tab: 1 } },
    );

    expect(tab1Events).toHaveLength(1);
    expect(tab1Events[0].crossTab).toBe(false);
    expect(tab1Events[0].tables).toEqual(['messages']);

    const crossEvent = await crossTabPromise;
    expect(crossEvent.crossTab).toBe(true);
    expect(crossEvent.tables).toEqual(['messages']);
    expect(crossEvent.meta).toEqual({ tab: 1 });

    // Tab 2 immediately sees the row committed by Tab 1!
    const rowsInTab2 = await dbTab2.from('messages').toArray();
    expect(rowsInTab2).toEqual([{ id: 101, body: 'Hello from Tab 1' }]);

    unsub1();
    await dbTab1.close();
    await dbTab2.close();
  });
});

