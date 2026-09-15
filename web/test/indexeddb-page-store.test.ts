import assert from "node:assert/strict";
import test from "node:test";
import { indexedDB } from "fake-indexeddb";

import { IndexedDbPageStore } from "../src/indexeddb-page-store.js";
import { DATABASE_PAGE_SIZE } from "../src/protocol.js";

let nextDatabaseId = 1;

function createStore(): IndexedDbPageStore {
  return new IndexedDbPageStore(`webdb-test-${nextDatabaseId++}`, indexedDB);
}

test("IndexedDB page store persists copied page batches across reopen", async () => {
  const store = createStore();
  const source = new Uint8Array(DATABASE_PAGE_SIZE).fill(0x2A);
  await store.writePages(new Map([[2, source], [3, new Uint8Array(DATABASE_PAGE_SIZE).fill(0x3B)]]));
  source[0] = 0;

  const firstRead = await store.readPages([2, 3]);
  assert.equal(firstRead.get(2)?.[0], 0x2A);
  assert.equal(firstRead.get(3)?.[0], 0x3B);
  firstRead.get(2)![0] = 0;

  store.close();
  const reopened = new IndexedDbPageStore(`webdb-test-${nextDatabaseId - 1}`, indexedDB);
  const restartRead = await reopened.readPages([2]);
  assert.equal(restartRead.get(2)?.[0], 0x2A);
});

test("IndexedDB page store rejects invalid batch input before persisting", async () => {
  const store = createStore();
  await assert.rejects(() => store.writePages(new Map([[2, new Uint8Array(DATABASE_PAGE_SIZE - 1)]])), RangeError);
  await assert.rejects(() => store.writePages(new Map([[1, new Uint8Array(DATABASE_PAGE_SIZE)]])), RangeError);
  await assert.rejects(() => store.readPages([2, 2]), RangeError);
  await assert.rejects(() => store.readPages([2]), /unavailable/);
});

