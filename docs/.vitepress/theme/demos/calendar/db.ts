import type { WebDB } from '@ahmadmoussawi/webdb';
import { addDays, addMinutes, ymd, ymdhm } from './dates';

export const CALENDAR_DB_NAME = 'demo_calendar';

export const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'] as const;

export interface Appointment {
  id: number;
  title: string;
  start_at: string; // 'YYYY-MM-DD HH:mm' (local time, lexicographically sortable)
  end_at: string;
  color: string;
  notes: string;
}

export type AppointmentInput = Omit<Appointment, 'id'>;

export async function setupCalendarDb(db: WebDB): Promise<void> {
  const tables = await db.listTables();
  if (tables.some((t) => t.name === 'appointments')) return;
  await db.createTable('appointments', [
    { name: 'id', type: 'INT32', primaryKey: true, autoInc: true },
    { name: 'title', type: 'TEXT', notNull: true },
    { name: 'start_at', type: 'TEXT', notNull: true, indexed: true },
    { name: 'end_at', type: 'TEXT', notNull: true },
    { name: 'color', type: 'TEXT', notNull: true },
    { name: 'notes', type: 'TEXT', notNull: true },
  ]);
  await resetCalendarData(db);
}

/** Seed data is generated relative to "today" so the calendar always looks alive. */
export function seedAppointments(today = new Date()): AppointmentInput[] {
  const at = (dayOffset: number, h: number, m = 0) =>
    ymdhm(new Date(today.getFullYear(), today.getMonth(), today.getDate() + dayOffset, h, m));
  const mk = (title: string, start: string, minutes: number, color: string, notes = ''): AppointmentInput => ({
    title,
    start_at: start,
    end_at: addMinutes(start, minutes),
    color,
    notes,
  });
  return [
    mk('Team stand-up', at(0, 9, 30), 15, COLORS[0]),
    mk('Lunch with Sam', at(0, 12, 30), 60, COLORS[1]),
    mk('Design review', at(1, 14), 90, COLORS[4], 'Bring the new onboarding mockups'),
    mk('Dentist', at(2, 8, 45), 45, COLORS[3]),
    mk('Sprint planning', at(3, 10), 120, COLORS[0]),
    mk('Gym', at(3, 18), 60, COLORS[2]),
    mk('Birthday dinner', at(5, 19, 30), 150, COLORS[5]),
    mk('1:1 with manager', at(-2, 11), 30, COLORS[4]),
    mk('Release v1.0', at(-5, 16), 60, COLORS[1]),
    mk('Quarterly review', at(9, 13), 120, COLORS[0]),
  ];
}

export async function resetCalendarData(db: WebDB): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.from('appointments').delete();
    await tx.insertMany('appointments', seedAppointments());
  });
}

/** `WHERE start_at >= :from AND start_at < :to ORDER BY start_at`, served by the start_at index. */
export function appointmentsBetween(db: WebDB, from: string, to: string) {
  return db.from('appointments').where('start_at', '>=', from).where('start_at', '<', to).orderBy('start_at');
}

export function upcomingQuery(db: WebDB, fromNow: string, limit = 6) {
  return db.from('appointments').where('start_at', '>=', fromNow).orderBy('start_at').limit(limit);
}

/** `SELECT COUNT(*) ... WHERE start_at LIKE 'YYYY-MM-%'` for the header badge. */
export function monthCountQuery(db: WebDB, year: number, month0: number) {
  const prefix = `${year}-${String(month0 + 1).padStart(2, '0')}-`;
  return db.from('appointments').whereStartsWith('start_at', prefix).count('id', 'n');
}

export async function addAppointment(db: WebDB, a: AppointmentInput): Promise<void> {
  await db.insert('appointments', a);
}

export async function updateAppointment(db: WebDB, id: number, a: Partial<AppointmentInput>): Promise<void> {
  await db.update('appointments', id, a);
}

export async function deleteAppointment(db: WebDB, id: number): Promise<void> {
  await db.delete('appointments', id);
}

export function defaultNewAppointment(day: Date): AppointmentInput {
  const start = `${ymd(day)} 09:00`;
  return { title: '', start_at: start, end_at: addMinutes(start, 60), color: COLORS[0], notes: '' };
}

export { addDays };
