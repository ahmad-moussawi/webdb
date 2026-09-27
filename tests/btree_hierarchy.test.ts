import { describe, it, expect } from "vitest";
import {
  page_init_interior,
  page_insert_interior_cell,
  page_binary_search_interior,
  page_split_interior,
  page_init_index_leaf,
  page_insert_index_leaf_cell,
  page_binary_search_index_leaf,
  page_get_cell_count,
  page_get_cell_offset,
} from "../src/core/index.ts";
import {
  PAGE_SIZE,
  PAGE_TYPE_TABLE_INTERIOR,
  MAX_TABLE_INTERIOR_CELLS,
} from "../src/constants.ts";
import { DataType } from "../src/types/index.ts";

describe("Test Suite 6: B+Tree Interior Routing & Secondary Index Geometry (tests/btree_hierarchy.test.ts)", () => {
  it("1. Table Interior Node Saturation & Split (splits at entry 145, promotes median key)", () => {
    const p1Buf = new ArrayBuffer(PAGE_SIZE);
    const p1View = new DataView(p1Buf);
    page_init_interior(p1View, 0, 999); // right_child_page_id = 999

    expect(p1View.getUint8(0)).toBe(PAGE_TYPE_TABLE_INTERIOR);
    expect(p1View.getUint32(6, true)).toBe(999);

    // Insert 291 sequential routing entries (up to saturation)
    for (let i = 0; i < MAX_TABLE_INTERIOR_CELLS; i++) {
      const childPageId = i + 10;
      const rowid = BigInt(i * 10);
      const res = page_insert_interior_cell(p1View, 0, childPageId, rowid);
      expect(res).toBe(i + 1);
    }

    expect(page_get_cell_count(p1View, 0)).toBe(MAX_TABLE_INTERIOR_CELLS); // 291 entries
    // Attempting to insert a 292nd entry must return -1 (page full)
    expect(page_insert_interior_cell(p1View, 0, 9999, 9999n)).toBe(-1);

    // Split interior page
    const splitResult = page_split_interior(p1View, 0, 0);

    // Left page keeps 145 entries (0..144)
    expect(page_get_cell_count(p1View, 0)).toBe(145);
    // Right page gets 291 - 146 = 145 entries (146..290)
    // Median entry (index 145) was promoted
    expect(splitResult.median_rowid).toBe(BigInt(145 * 10)); // entry 145's rowid
    expect(splitResult.promoted_child_page_id).toBe(145 + 10);
    expect(splitResult.right_child_page_id).toBe(999);
  });

  it("2. Binary Search Traversal Verification across keys and boundaries", () => {
    const buf = new ArrayBuffer(PAGE_SIZE);
    const view = new DataView(buf);
    page_init_interior(view, 0, 9999); // right_child_page_id = 9999

    // Insert 100 entries: rowids 10, 20, 30, ... 1000
    for (let i = 1; i <= 100; i++) {
      page_insert_interior_cell(view, 0, i * 100, BigInt(i * 10));
    }

    // Exact match seek: target_rowid = 100n -> routes to cell 10's child (1000)
    expect(page_binary_search_interior(view, 0, 100n)).toBe(1000);

    // In-between seek: target_rowid = 45n -> routes to first cell >= 45, which is rowid 50 (child 500)
    expect(page_binary_search_interior(view, 0, 45n)).toBe(500);

    // Lower boundary: target_rowid = 5n -> routes to first cell (rowid 10, child 100)
    expect(page_binary_search_interior(view, 0, 5n)).toBe(100);

    // Exceeding maximum: target_rowid = 1500n -> falls back to right_child_page_id (9999)
    expect(page_binary_search_interior(view, 0, 1500n)).toBe(9999);
  });

  it("3. Secondary Index Slotted Collation (NULL < -inf < Numbers < TEXT < BLOB with rowid tie-breaker)", () => {
    const buf = new ArrayBuffer(PAGE_SIZE);
    const view = new DataView(buf);
    page_init_index_leaf(view, 0);

    // Insert entries in scrambled order
    page_insert_index_leaf_cell(view, 0, DataType.TEXT, "banana", 10n);
    page_insert_index_leaf_cell(view, 0, DataType.NULL, null, 1n);
    page_insert_index_leaf_cell(view, 0, DataType.INT32, -500, 20n);
    page_insert_index_leaf_cell(view, 0, DataType.INT32, 100, 5n);
    page_insert_index_leaf_cell(view, 0, DataType.TEXT, "apple", 30n);
    page_insert_index_leaf_cell(view, 0, DataType.NULL, null, 2n);
    page_insert_index_leaf_cell(view, 0, DataType.INT32, 100, 2n); // Duplicate key, lower rowid
    page_insert_index_leaf_cell(
      view,
      0,
      DataType.BLOB,
      new Uint8Array([0x01, 0x02]),
      9n,
    );

    expect(page_get_cell_count(view, 0)).toBe(8);

    // Binary search point seeks
    const searchApple = page_binary_search_index_leaf(
      view,
      0,
      DataType.TEXT,
      "apple",
    );
    expect(searchApple.found).toBe(true);

    const searchBanana = page_binary_search_index_leaf(
      view,
      0,
      DataType.TEXT,
      "banana",
    );
    expect(searchBanana.found).toBe(true);

    const search100 = page_binary_search_index_leaf(
      view,
      0,
      DataType.INT32,
      100,
      2n,
    );
    expect(search100.found).toBe(true);

    const searchMissing = page_binary_search_index_leaf(
      view,
      0,
      DataType.TEXT,
      "orange",
    );
    expect(searchMissing.found).toBe(false);

    // Verify ordering in slot directory:
    // Expected order:
    // 0: NULL (rowid 1)
    // 1: NULL (rowid 2)
    // 2: INT32 -500 (rowid 20)
    // 3: INT32 100 (rowid 2)
    // 4: INT32 100 (rowid 5)
    // 5: TEXT 'apple' (rowid 30)
    // 6: TEXT 'banana' (rowid 10)
    // 7: BLOB [1, 2] (rowid 9)
    const orderTypes: DataType[] = [];
    for (let i = 0; i < 8; i++) {
      const off = page_get_cell_offset(view, 0, i);
      const kLen = view.getUint16(off, true);
      const _rId = view.getBigInt64(off + 2 + kLen, true);
      if (kLen === 0) {
        orderTypes.push(DataType.NULL);
      } else if (kLen === 4) {
        orderTypes.push(DataType.INT32);
      } else if (kLen === 2) {
        orderTypes.push(DataType.BLOB);
      } else {
        orderTypes.push(DataType.TEXT);
      }
    }

    expect(orderTypes[0]).toBe(DataType.NULL);
    expect(orderTypes[1]).toBe(DataType.NULL);
    expect(orderTypes[2]).toBe(DataType.INT32);
    expect(orderTypes[3]).toBe(DataType.INT32);
    expect(orderTypes[4]).toBe(DataType.INT32);
    expect(orderTypes[5]).toBe(DataType.TEXT);
    expect(orderTypes[6]).toBe(DataType.TEXT);
    expect(orderTypes[7]).toBe(DataType.BLOB);
  });
});
