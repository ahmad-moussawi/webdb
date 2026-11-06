import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebDB } from '../src/index.ts';

/** Verifies the snippets shown in docs/guides/expressions-and-functions.md ("Embrace the browser"). */
describe('UDFs built on Web platform APIs', () => {
  let db: WebDB;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T12:00:00Z'));
    db = await WebDB.open({ name: `webapi_${Math.random()}`, storage: 'memory' });
    await db.createTable('orders', [
      { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
      { name: 'customer', type: 'TEXT', notNull: true },
      { name: 'total', type: 'FLOAT64', notNull: true },
      { name: 'created_at', type: 'INT64', notNull: true }, // epoch milliseconds
      { name: 'site', type: 'TEXT', notNull: true },
      { name: 'note', type: 'TEXT', notNull: true },
    ]);
    const at = (iso: string) => Date.parse(iso);
    await db.insertMany('orders', [
      { customer: 'Ana', total: 1250.5, created_at: at('2026-09-03T08:15:00Z'), site: 'https://shop.example.com/cart?id=1', note: 'Café order' },
      { customer: 'Ben', total: 99, created_at: at('2026-10-14T23:30:00Z'), site: 'https://www.example.org/', note: '日本語のメモです' },
      { customer: 'Cy', total: 310.25, created_at: at('2026-10-30T10:00:00Z'), site: 'http://localhost:3000/a', note: 'two words' },
      { customer: 'Di', total: 42, created_at: at('2026-11-06T09:00:00Z'), site: 'https://shop.example.com/', note: 'x' },
    ]);

    // ---- the registrations shown in the docs -------------------------------------------------
    const ms = (v: unknown) => Number(v);

    // Date API: 'YYYY-MM' bucket, handy for GROUP BY
    db.registerFunction('month_key', (ts: unknown) => (ts == null ? null : new Date(ms(ts)).toISOString().slice(0, 7)));

    // Intl.DateTimeFormat: locale + time zone aware formatting
    db.registerFunction('format_date', (ts: unknown, locale: string, timeZone: string) =>
      ts == null
        ? null
        : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone }).format(new Date(ms(ts))),
    );

    // Intl.DateTimeFormat again: the weekday name
    db.registerFunction('weekday', (ts: unknown, locale: string) =>
      ts == null ? null : new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(new Date(ms(ts))),
    );

    // Intl.RelativeTimeFormat: "3 days ago"
    const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
    db.registerFunction('time_ago', (ts: unknown) => {
      if (ts == null) return null;
      const days = Math.round((ms(ts) - Date.now()) / 86_400_000);
      return rtf.format(days, 'day');
    });

    // Intl.NumberFormat: currency formatting
    db.registerFunction('money', (amount: unknown, currency: string, locale: string) =>
      new Intl.NumberFormat(locale, { style: 'currency', currency }).format(Number(amount)),
    );

    // Intl.Segmenter: real word counting, even for languages without spaces
    const segmenter = new Intl.Segmenter('und', { granularity: 'word' });
    db.registerFunction('word_count', (text: unknown) => {
      let n = 0;
      for (const s of segmenter.segment(String(text ?? ''))) if (s.isWordLike) n++;
      return n;
    });

    // URL API
    db.registerFunction('url_host', (u: unknown) => {
      try {
        return new URL(String(u)).hostname;
      } catch {
        return null;
      }
    });

    // String.prototype.normalize: accent-insensitive comparison
    db.registerFunction('unaccent', (s: unknown) =>
      String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('month_key works in SELECT, WHERE and GROUP BY (monthly revenue)', async () => {
    const rows = await db.from('orders').select('id', 'month_key(created_at) as month').where("month_key(created_at) = '2026-10'").toArray();
    expect(rows.map((r) => r.id)).toEqual([2, 3]);

    const monthly = await db
      .from('orders')
      .select('month_key(created_at) as month', 'sum(total) as revenue', 'count(id) as orders')
      .groupBy('month_key(created_at)')
      .orderBy('month')
      .toArray();
    expect(monthly).toEqual([
      { month: '2026-09', revenue: 1250.5, orders: 1 },
      { month: '2026-10', revenue: 409.25, orders: 2 },
      { month: '2026-11', revenue: 42, orders: 1 },
    ]);
  });

  it('format_date / weekday use Intl.DateTimeFormat with a locale and time zone', async () => {
    const rows = await db
      .from('orders')
      .select(
        "format_date(created_at, 'en-US', 'UTC') as us",
        "format_date(created_at, 'de-DE', 'Asia/Tokyo') as de_tokyo",
        "weekday(created_at, 'fr-FR') as jour",
      )
      .where('id', '=', 2)
      .toArray();
    expect(rows[0].us).toBe('Oct 14, 2026');
    // 23:30 UTC is already the next day in Tokyo
    expect(String(rows[0].de_tokyo)).toContain('15');
    expect(rows[0].jour).toBe('mercredi');
  });

  it('time_ago uses Intl.RelativeTimeFormat, and days_since-style filtering works in WHERE', async () => {
    const rows = await db.from('orders').select('customer', 'time_ago(created_at) as when').orderBy('id').toArray();
    expect(rows.map((r) => r.when)).toEqual(['64 days ago', '23 days ago', '7 days ago', 'today']);
    const recent = await db.from('orders').select('customer').where('time_ago(created_at) = \'7 days ago\'').toArray();
    expect(recent).toEqual([{ customer: 'Cy' }]);
  });

  it('money uses Intl.NumberFormat per locale', async () => {
    const rows = await db
      .from('orders')
      .select("money(total, 'USD', 'en-US') as usd", "money(total, 'EUR', 'de-DE') as eur")
      .where('id', '=', 1)
      .toArray();
    expect(rows[0].usd).toBe('$1,250.50');
    expect(String(rows[0].eur).replace(/\s/g, ' ')).toBe('1.250,50 €');
  });

  it('word_count uses Intl.Segmenter (works without spaces)', async () => {
    const rows = await db.from('orders').select('customer', 'word_count(note) as words').orderBy('id').toArray();
    expect(rows.map((r) => r.words)).toEqual([2, 4, 2, 1]);
    // plain whitespace splitting would count the Japanese note as 1 word
    expect(String(rows[1].words)).not.toBe('1');
  });

  it('url_host (URL API) and unaccent (normalize) work in WHERE and GROUP BY', async () => {
    const hosts = await db.from('orders').select('url_host(site) as host', 'count(id) as n').groupBy('url_host(site)').orderBy('host').toArray();
    expect(hosts).toEqual([
      { host: 'localhost', n: 1 },
      { host: 'shop.example.com', n: 2 },
      { host: 'www.example.org', n: 1 },
    ]);
    const cafe = await db.from('orders').select('customer').where("unaccent(note) = 'cafe order'").toArray();
    expect(cafe).toEqual([{ customer: 'Ana' }]);
  });
});
