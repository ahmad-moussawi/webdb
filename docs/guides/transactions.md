# Transactions, Savepoints & Multi-Tab Safety

WebDB provides full **ACID transactions** backed by a Write-Ahead Log (WAL) with CRC32 checksum verification and automatic multi-tab coordination.

---

## 1. Running a Transaction (`db.transaction`)

Wrap multiple reads and writes inside `db.transaction(async (tx) => ...)`. All operations executed on the `tx` parameter are grouped into a single atomic commit:

- If the callback resolves normally, all changes are flushed atomically to the WAL and committed.
- If the callback throws an error (or rejects), **every change made inside the transaction is automatically rolled back**.

```typescript
await db.transaction(async (tx) => {
  // 1. Deduct from sender
  const sender = await tx.from('accounts').where('id', '=', 'acc_1').first();
  if (!sender || (sender.balance as number) < 100) {
    throw new Error('Insufficient funds'); // Triggers automatic rollback
  }

  await tx.update('accounts', 'acc_1', {
    balance: (sender.balance as number) - 100,
  });

  // 2. Credit receiver
  const receiver = await tx.from('accounts').where('id', '=', 'acc_2').first();
  await tx.update('accounts', 'acc_2', {
    balance: ((receiver?.balance as number) ?? 0) + 100,
  });

  // 3. Record audit entry
  await tx.insert('transfers', {
    id: crypto.randomUUID(),
    from_id: 'acc_1',
    to_id: 'acc_2',
    amount: 100,
  });
});
```

> [!IMPORTANT]
> Always use the `tx` parameter (e.g. `await tx.insert(...)`, `await tx.from(...)`) inside the `db.transaction(async (tx) => ...)` callback rather than the outer `db` reference. Calling methods on the outer `db` while a transaction is open will wait for the active transaction to finish first.

---

## 2. Nested Transactions (Savepoints)

Calling `tx.transaction(async (nestedTx) => ...)` inside an active transaction creates a **savepoint**.

If the inner block throws an error, WebDB rolls back **only the changes made inside that nested block**, allowing you to catch the error and still commit the outer transaction!

```typescript
await db.transaction(async (tx) => {
  // Outer operation (will be kept)
  await tx.insert('users', {
    id: crypto.randomUUID(),
    name: 'Alice',
    role: 'admin',
  });

  try {
    // Nested savepoint
    await tx.transaction(async (nestedTx) => {
      await nestedTx.insert('users', {
        id: crypto.randomUUID(),
        name: 'Temporary Guest',
        role: 'guest',
      });

      // Simulate a validation or business logic failure
      throw new Error('Guest registration disabled');
    });
  } catch (err) {
    // 'Temporary Guest' was rolled back, but 'Alice' is still intact!
    console.warn('Skipped guest insert:', err);
  }
});
```

---

## 3. Multi-Tab Concurrency & Crash Recovery

Web users frequently open multiple browser tabs of the same application or run background sync inside a Web Worker. WebDB handles multi-tab safety automatically:

1. **Cross-Tab Serialization (`navigator.locks`):** When using persistent storage (`'idb'` or `'opfs'`), WebDB coordinates transactions across all open tabs and workers using the browser's native **Web Locks API**. If Tab A is committing a transaction, Tab B waits in a FIFO queue and automatically refreshes any modified pages in its local cache before running.
2. **Crash Recovery on Startup:** If a user closes their laptop, force-quits the browser, or a tab crashes mid-transaction, WebDB automatically replays committed WAL frames and discards incomplete frames the next time `WebDB.open()` is called.
3. **Abandoned Transaction Timeout (30s):** To prevent a hung promise (such as a stalled network call inside a transaction block) from locking the database forever, WebDB automatically aborts and rolls back any transaction that remains completely idle for more than **30 seconds**.

> [!TIP]
> **Best Practice: Keep Network Requests Outside Transactions**
> Perform `fetch()` calls *before* or *after* `db.transaction(...)` so your transactions execute in milliseconds and never hold locks while waiting on slow mobile networks.

---

## 4. Manual WAL Checkpointing (`db.checkpoint`)

WebDB automatically checkpoints its Write-Ahead Log (`.wal`) back to the main database pages after accumulating 256 frames (~1 MB) or 100 committed transactions.

If you want to force an immediate checkpoint and truncate the WAL (for example, right after a massive bulk import), call `db.checkpoint()`:

```typescript
const { pagesWritten } = await db.checkpoint();
console.log(`Checkpointed ${pagesWritten} pages to main storage`);
```

