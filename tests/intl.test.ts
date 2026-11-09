import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { WebDB, col } from "../src";
import {
  formatDate,
  formatTime,
  timeAgo,
  datePart,
  daysSince,
  dateAdd,
  dateDiff,
  isoDate,
  toTimestamp,
  formatCurrency,
  formatNumber,
  formatCompact,
  formatPercent,
  formatBytes,
  plural,
  regexpMatch,
  regexpReplace,
  slugify,
  unaccent,
  padLeft,
  padRight,
  registerIntlFunctions,
  registerDateFunctions,
  registerNumberFunctions,
  registerStringFunctions,
  formatDateExpr,
  formatCurrencyExpr,
  daysSinceExpr,
  regexpMatchExpr,
  slugifyExpr,
} from "../src/intl";

describe("Intl Formatting & Standard Library (@ahmadmoussawi/webdb/intl)", () => {
  let db: WebDB;

  beforeEach(async () => {
    db = await WebDB.open({
      name: `intl_test_${Date.now()}_${Math.random()}`,
      storage: "memory",
    });
  });

  afterEach(async () => {
    if (db) await db.close();
  });

  // ==========================================================================
  // 1. Standalone Date & Time Functions
  // ==========================================================================
  describe("Standalone Date & Time Functions", () => {
    // 2026-11-09T14:30:00.000Z = 1794234600000 ms
    const fixedTs = 1794234600000;

    it("formatDate formats timestamps with localized styles", () => {
      const medium = formatDate(fixedTs, "medium", "en-US", "UTC");
      expect(medium).toBe("Nov 9, 2026");

      const short = formatDate(fixedTs, "short", "en-US", "UTC");
      expect(short).toBe("11/9/26");

      // Handles ISO string input
      expect(formatDate("2026-11-09T14:30:00Z", "medium", "en-US", "UTC")).toBe(
        "Nov 9, 2026",
      );

      // Handles null / undefined
      expect(formatDate(null)).toBeNull();
      expect(formatDate(undefined)).toBeNull();
      expect(formatDate("invalid-date")).toBeNull();
    });

    it("formatTime formats time portion of timestamps", () => {
      const short = formatTime(fixedTs, "short", "en-US", "UTC");
      expect(short).toBe("2:30 PM");

      expect(formatTime(null)).toBeNull();
    });

    it("timeAgo produces relative time descriptions", () => {
      const base = fixedTs;
      // 10 minutes ago
      expect(timeAgo(base - 10 * 60 * 1000, base, "en")).toBe("10 minutes ago");
      // 2 hours ago
      expect(timeAgo(base - 2 * 3600 * 1000, base, "en")).toBe("2 hours ago");
      // 3 days ago
      expect(timeAgo(base - 3 * 86400 * 1000, base, "en")).toBe("3 days ago");
      // 2 days in future
      expect(timeAgo(base + 2 * 86400 * 1000, base, "en")).toBe("in 2 days");
      // 1 day ago -> yesterday
      expect(timeAgo(base - 86400 * 1000, base, "en")).toBe("yesterday");

      expect(timeAgo(null)).toBeNull();
    });

    it("datePart extracts components correctly", () => {
      // 2026-11-09 14:30:00 UTC
      // Note: Date methods use local or specified time
      const d = new Date(fixedTs);
      expect(datePart("year", fixedTs)).toBe(d.getFullYear());
      expect(datePart("month", fixedTs)).toBe(d.getMonth() + 1);
      expect(datePart("day", fixedTs)).toBe(d.getDate());
      expect(datePart("quarter", fixedTs)).toBe(
        Math.floor(d.getMonth() / 3) + 1,
      );
      expect(datePart("unknown", fixedTs)).toBeNull();
      expect(datePart("year", null)).toBeNull();
    });

    it("daysSince calculates day difference from base timestamp", () => {
      const base = fixedTs;
      const fiveDaysBefore = base - 5 * 86_400_000;
      expect(daysSince(fiveDaysBefore, base)).toBe(5);

      const twoDaysFuture = base + 2 * 86_400_000;
      expect(daysSince(twoDaysFuture, base)).toBe(-2);

      expect(daysSince(null)).toBeNull();
    });

    it("dateAdd and dateDiff compute arithmetic on timestamps", () => {
      const base = fixedTs;
      const plusTwoDays = dateAdd(base, 2, "day");
      expect(plusTwoDays).toBe(base + 2 * 86_400_000);

      const minusThreeHours = dateAdd(base, -3, "hour");
      expect(minusThreeHours).toBe(base - 3 * 3_600_000);

      expect(dateDiff(plusTwoDays, base, "day")).toBe(2);
      expect(dateDiff(base, plusTwoDays, "day")).toBe(-2);

      expect(dateAdd(null, 1, "day")).toBeNull();
      expect(dateDiff(null, base, "day")).toBeNull();
    });

    it("isoDate and toTimestamp perform bidirectional conversions", () => {
      const d = new Date(fixedTs);
      const expectedIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      expect(isoDate(fixedTs)).toBe(expectedIso);
      expect(isoDate(null)).toBeNull();

      expect(toTimestamp("2026-11-09T00:00:00.000Z")).toBe(
        Date.parse("2026-11-09T00:00:00.000Z"),
      );
      expect(toTimestamp(null)).toBeNull();
    });
  });

  // ==========================================================================
  // 2. Standalone Number & Currency Functions
  // ==========================================================================
  describe("Standalone Number & Currency Functions", () => {
    it("formatCurrency formats numbers into localized currency strings", () => {
      const usd = formatCurrency(1249.5, "USD", "en-US");
      expect(usd).toBe("$1,249.50");

      const jpy = formatCurrency(1500, "JPY", "en-US");
      expect(jpy).toBe("¥1,500");

      expect(formatCurrency(null)).toBeNull();
      expect(formatCurrency("abc")).toBeNull();
    });

    it("formatNumber formats numbers with grouping and decimal control", () => {
      const formatted = formatNumber(1234567.891, 2, "en-US");
      expect(formatted).toBe("1,234,567.89");

      const zeroDec = formatNumber(1234.56, 0, "en-US");
      expect(zeroDec).toBe("1,235");

      expect(formatNumber(null)).toBeNull();
    });

    it("formatCompact produces metric abbreviation strings", () => {
      expect(formatCompact(1500, "en-US")).toBe("1.5K");
      expect(formatCompact(2500000, "en-US")).toBe("2.5M");
      expect(formatCompact(500, "en-US")).toBe("500");
      expect(formatCompact(null)).toBeNull();
    });

    it("formatPercent formats ratios as percentages", () => {
      expect(formatPercent(0.8525, 1, "en-US")).toBe("85.3%");
      expect(formatPercent(0.5, 0, "en-US")).toBe("50%");
      expect(formatPercent(null)).toBeNull();
    });

    it("formatBytes produces human-readable byte sizes", () => {
      expect(formatBytes(0)).toBe("0 B");
      expect(formatBytes(512)).toBe("512.0 B");
      expect(formatBytes(1024)).toBe("1.0 KB");
      expect(formatBytes(1048576)).toBe("1.0 MB");
      expect(formatBytes(1073741824)).toBe("1.0 GB");
      expect(formatBytes(1536, 1)).toBe("1.5 KB");
      expect(formatBytes(null)).toBeNull();
    });

    it("plural handles singular and plural labels", () => {
      expect(plural(1, "order")).toBe("order");
      expect(plural(5, "order")).toBe("orders");
      expect(plural(0, "order", "orders", "no orders")).toBe("no orders");
      expect(plural(3, "box", "boxes")).toBe("boxes");
      expect(plural(null, "item")).toBeNull();
    });
  });

  // ==========================================================================
  // 3. Standalone String & Regex Functions
  // ==========================================================================
  describe("Standalone String & Regex Functions", () => {
    it("regexpMatch tests regex pattern against strings", () => {
      expect(regexpMatch("john@acme.com", "^[^@]+@acme\\.com$")).toBe(1);
      expect(regexpMatch("john@other.com", "^[^@]+@acme\\.com$")).toBe(0);
      expect(regexpMatch("ABC-123", "\\d+")).toBe(1);
      expect(regexpMatch(null, "\\d+")).toBe(0);
      expect(regexpMatch("test", null)).toBe(0);
    });

    it("regexpReplace performs global regex replacements", () => {
      expect(regexpReplace("Hello 123 World 456", "\\d+", "#")).toBe(
        "Hello # World #",
      );
      expect(regexpReplace("(555) 123-4567", "[^0-9]", "")).toBe("5551234567");
      expect(regexpReplace(null, "\\d+", "")).toBeNull();
    });

    it("slugify converts titles to URL-safe slugs", () => {
      expect(slugify("Hello World! 2026")).toBe("hello-world-2026");
      expect(slugify("  Café Münchën  -- Guide  ")).toBe("cafe-munchen-guide");
      expect(slugify("")).toBeNull();
      expect(slugify(null)).toBeNull();
    });

    it("unaccent strips diacritics while preserving casing", () => {
      expect(unaccent("Café Münchën Über")).toBe("Cafe Munchen Uber");
      expect(unaccent("plain text")).toBe("plain text");
      expect(unaccent(null)).toBeNull();
    });

    it("padLeft and padRight pad text with custom characters", () => {
      expect(padLeft(42, 6, "0")).toBe("000042");
      expect(padRight("ID", 5, "_")).toBe("ID___");
      expect(padLeft(null, 5)).toBeNull();
    });
  });

  // ==========================================================================
  // 4. Database Query Integration with UDFs
  // ==========================================================================
  describe("WebDB Query Integration with UDFs", () => {
    beforeEach(async () => {
      registerIntlFunctions(db);

      await db.createTable("products", [
        { name: "id", type: "INT32", primaryKey: true },
        { name: "name", type: "TEXT" },
        { name: "price", type: "FLOAT64" },
        { name: "downloads", type: "INT32" },
        { name: "sku", type: "TEXT" },
        { name: "created_at", type: "FLOAT64" },
      ]);

      await db.insertMany("products", [
        {
          id: 1,
          name: "Super Laptop Pro",
          price: 1299.99,
          downloads: 1450000,
          sku: "LAP-001",
          created_at: 1794234600000, // 2026-11-09T14:30:00Z
        },
        {
          id: 2,
          name: "Wireless Mouse",
          price: 24.5,
          downloads: 8500,
          sku: "ACC-042",
          created_at: 1794234600000 - 10 * 86_400_000, // 10 days earlier
        },
        {
          id: 3,
          name: "Mechanical Keyboard RGB",
          price: 89.0,
          downloads: 45000,
          sku: "ACC-099",
          created_at: 1794234600000 - 45 * 86_400_000, // 45 days earlier
        },
      ]);
    });

    it("evaluates number and currency UDFs in .select() projection", async () => {
      const rows = await db
        .from("products")
        .select([
          "id",
          "name",
          "format_currency(price, 'USD') as price_usd",
          "format_compact(downloads) as dl_compact",
          "slugify(name) as slug",
        ])
        .orderBy("id", "asc")
        .toArray();

      expect(rows.length).toBe(3);
      expect(rows[0].price_usd).toBe("$1,299.99");
      expect(rows[0].dl_compact).toBe("1.5M");
      expect(rows[0].slug).toBe("super-laptop-pro");

      expect(rows[1].price_usd).toBe("$24.50");
      expect(rows[1].dl_compact).toBe("8.5K");
      expect(rows[1].slug).toBe("wireless-mouse");
    });

    it("evaluates date formatting UDFs in .select() projection", async () => {
      const rows = await db
        .from("products")
        .select([
          "id",
          "format_date(created_at, 'medium', 'en-US', 'UTC') as date_med",
          "iso_date(created_at) as date_iso",
          "date_part('year', created_at) as yr",
        ])
        .where("id", "=", 1)
        .toArray();

      expect(rows.length).toBe(1);
      expect(rows[0].date_med).toBe("Nov 9, 2026");
      expect(rows[0].date_iso).toBe("2026-11-09");
      expect(rows[0].yr).toBe(2026);
    });

    it("evaluates UDFs in .where() filters", async () => {
      const refTs = 1794234600000;
      // Filter products created within last 20 days: days_since(created_at, refTs) <= 20
      const recent = await db
        .from("products")
        .where(`days_since(created_at, ${refTs}) <= 20`)
        .orderBy("id", "asc")
        .toArray();

      expect(recent.length).toBe(2);
      expect(recent[0].id).toBe(1); // 0 days
      expect(recent[1].id).toBe(2); // 10 days
    });

    it("evaluates regexp_match in .where() filters", async () => {
      // Find accessories where SKU starts with 'ACC-'
      const accessories = await db
        .from("products")
        .where("regexp_match(sku, '^ACC-') = 1")
        .orderBy("id", "asc")
        .toArray();

      expect(accessories.length).toBe(2);
      expect(accessories[0].id).toBe(2);
      expect(accessories[1].id).toBe(3);
    });

    it("works with ExpressionBuilder type-safe helpers", async () => {
      const refTs = 1794234600000;
      const rows = await db
        .from("products")
        .select([
          "id",
          formatCurrencyExpr("price", "USD").as("formatted_price"),
          formatCurrencyExpr(col("price").mul(2), "USD").as("double_price"),
          formatDateExpr("created_at", "medium", "en-US", "UTC").as(
            "formatted_date",
          ),
          slugifyExpr("name").as("url_slug"),
        ])
        .where(daysSinceExpr("created_at", refTs).lt(30))
        .where(regexpMatchExpr("sku", "^LAP-").eq(1))
        .toArray();

      expect(rows.length).toBe(1);
      expect(rows[0].id).toBe(1);
      expect(rows[0].formatted_price).toBe("$1,299.99");
      expect(rows[0].double_price).toBe("$2,599.98");
      expect(rows[0].formatted_date).toBe("Nov 9, 2026");
      expect(rows[0].url_slug).toBe("super-laptop-pro");
    });

    it("supports vectorized UDF batching across multi-chunk rows (150 rows)", async () => {
      // Populate 150 items to span across multiple 128-row vector batches
      const items = [];
      const baseTs = 1794234600000;
      for (let i = 1; i <= 150; i++) {
        items.push({
          id: 100 + i,
          name: `Item Number ${i} (Café Edition)`,
          price: i * 2.5,
          downloads: i * 1000,
          sku: `SKU-${String(i).padStart(4, "0")}`,
          created_at: baseTs - i * 86_400_000,
        });
      }
      await db.insertMany("products", items);

      const results = await db
        .from("products")
        .select([
          "id",
          "format_currency(price, 'USD') as price_fmt",
          "slugify(name) as slug",
          'pad_left(id, 6, "0") as padded_id',
        ])
        .where("id", ">", 100)
        .orderBy("id", "asc")
        .toArray();

      expect(results.length).toBe(150);
      expect(results[0].price_fmt).toBe("$2.50");
      expect(results[0].slug).toBe("item-number-1-cafe-edition");
      expect(results[0].padded_id).toBe("000101");

      expect(results[149].price_fmt).toBe("$375.00");
      expect(results[149].slug).toBe("item-number-150-cafe-edition");
      expect(results[149].padded_id).toBe("000250");
    });
  });

  // ==========================================================================
  // 5. Granular Domain Registrars
  // ==========================================================================
  describe("Granular Domain Registrars", () => {
    it("registerDateFunctions registers only date functions", async () => {
      registerDateFunctions(db);
      expect(db.getUdf("format_date")).toBeDefined();
      expect(db.getUdf("time_ago")).toBeDefined();
      expect(db.getUdf("format_currency")).toBeUndefined();
    });

    it("registerNumberFunctions registers only number functions", async () => {
      registerNumberFunctions(db);
      expect(db.getUdf("format_currency")).toBeDefined();
      expect(db.getUdf("format_number")).toBeDefined();
      expect(db.getUdf("format_date")).toBeUndefined();
    });

    it("registerStringFunctions registers only string functions", async () => {
      registerStringFunctions(db);
      expect(db.getUdf("regexp_match")).toBeDefined();
      expect(db.getUdf("slugify")).toBeDefined();
      expect(db.getUdf("format_date")).toBeUndefined();
    });
  });
});
