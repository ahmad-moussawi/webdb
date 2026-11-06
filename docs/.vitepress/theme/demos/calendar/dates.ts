/** Local date helpers. Appointments are stored as sortable local strings: `YYYY-MM-DD HH:mm`. */

const pad = (n: number) => String(n).padStart(2, '0');

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function ymdhm(d: Date): string {
  return `${ymd(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function addDays(d: Date, days: number): Date {
  const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
  return c;
}

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/** The 6x7 grid of days shown for the month containing `month` (weeks start on Monday). */
export function monthGrid(month: Date): Date[] {
  const first = startOfMonth(month);
  const offset = (first.getDay() + 6) % 7;
  const start = addDays(first, -offset);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

/** Start (inclusive) and end (exclusive) strings covering the visible month grid. */
export function gridRange(month: Date): { from: string; to: string } {
  const days = monthGrid(month);
  return { from: `${ymd(days[0])} 00:00`, to: `${ymd(addDays(days[41], 1))} 00:00` };
}

export function timeOf(dt: string): string {
  return dt.slice(11, 16);
}

export function dateOf(dt: string): string {
  return dt.slice(0, 10);
}

export function addMinutes(dt: string, minutes: number): string {
  const [date, time] = dt.split(' ');
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return ymdhm(new Date(y, m - 1, d, hh, mm + minutes));
}
