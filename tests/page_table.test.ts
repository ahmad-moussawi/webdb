import { describe, it, expect } from "vitest";
import {
  hashPageId,
  pageTableGet,
  pageTableSet,
  pageTableDelete,
} from "../src/engine/page_table.js";

describe("Test Suite: Page Table Binary Hash Table (src/engine/page_table.ts)", () => {
  it("computes stable 32-bit hash within bucket mask bounds", () => {
    const mask = 15; // 16 buckets
    const h1 = hashPageId(1, mask);
    const h2 = hashPageId(1, mask);
    expect(h1).toBe(h2);
    expect(h1).toBeGreaterThanOrEqual(0);
    expect(h1).toBeLessThanOrEqual(mask);
  });

  it("handles basic insertion, lookup, and deletion", () => {
    const buffer = new ArrayBuffer(16 * 8); // 16 buckets * 8 bytes
    const view = new DataView(buffer);
    const bucketCount = 16;

    // Initially empty
    expect(pageTableGet(view, 0, bucketCount, 10)).toBe(-1);

    // Insert page 10 -> slot 2
    pageTableSet(view, 0, bucketCount, 10, 2);
    expect(pageTableGet(view, 0, bucketCount, 10)).toBe(2);

    // Update existing page 10 -> slot 5
    pageTableSet(view, 0, bucketCount, 10, 5);
    expect(pageTableGet(view, 0, bucketCount, 10)).toBe(5);

    // Delete page 10
    const deleted = pageTableDelete(view, 0, bucketCount, 10);
    expect(deleted).toBe(true);
    expect(pageTableGet(view, 0, bucketCount, 10)).toBe(-1);

    // Deleting again returns false
    expect(pageTableDelete(view, 0, bucketCount, 10)).toBe(false);
  });

  it("handles collision probing and backward-shift deletion across probe chains", () => {
    const bucketCount = 8;
    const buffer = new ArrayBuffer(bucketCount * 8);
    const view = new DataView(buffer);

    // Insert 4 items (50% load factor)
    const pages = [100, 200, 300, 400];
    pages.forEach((p, idx) => {
      pageTableSet(view, 0, bucketCount, p, idx);
    });

    for (let i = 0; i < pages.length; i++) {
      expect(pageTableGet(view, 0, bucketCount, pages[i])).toBe(i);
    }

    // Delete middle item
    expect(pageTableDelete(view, 0, bucketCount, 200)).toBe(true);
    expect(pageTableGet(view, 0, bucketCount, 200)).toBe(-1);

    // Other items must remain discoverable
    expect(pageTableGet(view, 0, bucketCount, 100)).toBe(0);
    expect(pageTableGet(view, 0, bucketCount, 300)).toBe(2);
    expect(pageTableGet(view, 0, bucketCount, 400)).toBe(3);
  });
});
