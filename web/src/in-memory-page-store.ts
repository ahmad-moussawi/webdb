import { AsyncPageStore, DATABASE_PAGE_SIZE } from "./protocol.js";

function copyPage(page: Uint8Array): Uint8Array {
  if (page.byteLength !== DATABASE_PAGE_SIZE) {
    throw new RangeError(`Page must contain exactly ${DATABASE_PAGE_SIZE} bytes.`);
  }
  return page.slice();
}

// Models bytes that have survived host persistence. All boundaries copy pages to prevent aliases
// between the scheduler, callers, and durable state.
export class InMemoryAsyncPageStore implements AsyncPageStore {
  private readonly pages = new Map<number, Uint8Array>();
  public failReads = false;
  public failWrites = false;

  constructor(initialPages: ReadonlyMap<number, Uint8Array> = new Map()) {
    for (const [pageId, page] of initialPages) {
      this.pages.set(pageId, copyPage(page));
    }
  }

  async readPages(pageIds: readonly number[]): Promise<Map<number, Uint8Array>> {
    if (this.failReads) throw new Error("Injected page-read failure.");

    const result = new Map<number, Uint8Array>();
    for (const pageId of pageIds) {
      const page = this.pages.get(pageId);
      if (!Number.isSafeInteger(pageId) || pageId < 2 || !page) {
        throw new Error(`Page ${pageId} is unavailable.`);
      }
      result.set(pageId, copyPage(page));
    }
    return result;
  }

  async writePages(pages: ReadonlyMap<number, Uint8Array>): Promise<void> {
    if (this.failWrites) throw new Error("Injected page-write failure.");

    // Validate and copy the whole batch before changing durable state.
    const replacement = new Map(this.pages);
    for (const [pageId, page] of pages) {
      if (!Number.isSafeInteger(pageId) || pageId < 2) {
        throw new RangeError(`Invalid page ID: ${pageId}`);
      }
      replacement.set(pageId, copyPage(page));
    }
    this.pages.clear();
    for (const [pageId, page] of replacement) this.pages.set(pageId, page);
  }

  snapshot(): Map<number, Uint8Array> {
    return new Map([...this.pages].map(([pageId, page]) => [pageId, page.slice()]));
  }
}
