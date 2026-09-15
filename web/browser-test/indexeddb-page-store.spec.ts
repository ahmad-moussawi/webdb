import { expect, test } from "@playwright/test";

test("IndexedDB page batches persist copied data across a browser reopen", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { IndexedDbPageStore } = await import("/dist/indexeddb-page-store.js");
    const { DATABASE_PAGE_SIZE } = await import("/dist/protocol.js");
    const databaseName = `webdb-browser-${crypto.randomUUID()}`;
    const firstStore = new IndexedDbPageStore(databaseName);
    const source = new Uint8Array(DATABASE_PAGE_SIZE).fill(0x4D);
    await firstStore.writePages(new Map([[2, source]]));
    source[0] = 0;
    const firstRead = await firstStore.readPages([2]);
    firstRead.get(2)[0] = 0;
    firstStore.close();

    const reopenedStore = new IndexedDbPageStore(databaseName);
    const reopened = await reopenedStore.readPages([2]);
    reopenedStore.close();
    return { byte: reopened.get(2)[0] };
  });

  expect(result.byte).toBe(0x4D);
});

test("an aborted IndexedDB write leaves the prior page value durable", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { IndexedDbPageStore } = await import("/dist/indexeddb-page-store.js");
    const { DATABASE_PAGE_SIZE } = await import("/dist/protocol.js");
    const databaseName = `webdb-browser-abort-${crypto.randomUUID()}`;
    const stableStore = new IndexedDbPageStore(databaseName);
    await stableStore.writePages(new Map([[2, new Uint8Array(DATABASE_PAGE_SIZE).fill(0x11)]]));
    stableStore.close();

    const abortingFactory = {
      open(name: string, version?: number) {
        const request = indexedDB.open(name, version);
        request.addEventListener("success", () => {
          const database = request.result;
          const originalTransaction = database.transaction.bind(database);
          database.transaction = ((stores: string | string[], mode?: IDBTransactionMode) => {
            const transaction = originalTransaction(stores, mode);
            if (mode === "readwrite") queueMicrotask(() => transaction.abort());
            return transaction;
          }) as IDBDatabase["transaction"];
        });
        return request;
      },
    } as IDBFactory;

    const abortingStore = new IndexedDbPageStore(databaseName, abortingFactory);
    let rejected = false;
    try {
      await abortingStore.writePages(new Map([[2, new Uint8Array(DATABASE_PAGE_SIZE).fill(0x22)]]));
    } catch {
      rejected = true;
    }
    abortingStore.close();

    const recoveredStore = new IndexedDbPageStore(databaseName);
    const recovered = await recoveredStore.readPages([2]);
    recoveredStore.close();
    return { rejected, byte: recovered.get(2)![0] };
  });

  expect(result.rejected).toBe(true);
  expect(result.byte).toBe(0x11);
});