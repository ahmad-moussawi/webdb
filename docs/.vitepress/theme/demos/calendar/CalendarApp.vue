<script setup lang="ts">
import { computed, ref } from 'vue';
import type { WebDB } from '@ahmadmoussawi/webdb';
import { useLiveQuery } from '@ahmadmoussawi/webdb/vue';
import {
  addAppointment,
  appointmentsBetween,
  COLORS,
  defaultNewAppointment,
  deleteAppointment,
  monthCountQuery,
  updateAppointment,
  upcomingQuery,
  type Appointment,
} from './db';
import { addMinutes, dateOf, gridRange, monthGrid, startOfMonth, timeOf, ymd, ymdhm } from './dates';

const props = defineProps<{ db: WebDB }>();

const today = new Date();
const month = ref(startOfMonth(today));
const selected = ref(ymd(today));
const nowStamp = ref(ymdhm(today));

// Live query #1: only the appointments inside the visible 6-week grid.
// Changing `month` re-runs it; any insert/update/delete (in any tab) re-runs it too.
const { data: rows } = useLiveQuery(
  () => {
    const r = gridRange(month.value);
    return appointmentsBetween(props.db, r.from, r.to);
  },
  [month],
  { db: props.db, initialData: [] },
);
// Live query #2: the next appointments, whatever month is on screen.
const { data: upcomingRows } = useLiveQuery(() => upcomingQuery(props.db, nowStamp.value, 5), { db: props.db, initialData: [] });
// Live query #3: an aggregate for the header badge.
const { data: countRows } = useLiveQuery(
  () => monthCountQuery(props.db, month.value.getFullYear(), month.value.getMonth()),
  [month],
  { db: props.db, initialData: [] },
);

const appointments = computed(() => (rows.value ?? []) as unknown as Appointment[]);
const upcoming = computed(() => (upcomingRows.value ?? []) as unknown as Appointment[]);
const monthTotal = computed(() => Number(countRows.value?.[0]?.n ?? 0));

const days = computed(() => monthGrid(month.value));
const byDay = computed(() => {
  const map = new Map<string, Appointment[]>();
  for (const a of appointments.value) {
    const key = dateOf(a.start_at);
    (map.get(key) ?? map.set(key, []).get(key)!).push(a);
  }
  return map;
});
const selectedList = computed(() => byDay.value.get(selected.value) ?? []);
const monthLabel = computed(() => month.value.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }));
const weekdays = computed(() =>
  Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'short' })),
);

function shift(delta: number) {
  month.value = new Date(month.value.getFullYear(), month.value.getMonth() + delta, 1);
}
function goToday() {
  month.value = startOfMonth(new Date());
  selected.value = ymd(new Date());
}
function pick(d: Date) {
  selected.value = ymd(d);
  if (d.getMonth() !== month.value.getMonth()) month.value = startOfMonth(d);
}

// ---- editor ---------------------------------------------------------------------------
interface Draft {
  id: number | null;
  title: string;
  date: string;
  start: string;
  end: string;
  color: string;
  notes: string;
}
const draft = ref<Draft | null>(null);
const formError = ref('');

function openNew(dateStr = selected.value) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const base = defaultNewAppointment(new Date(y, m - 1, d));
  draft.value = {
    id: null,
    title: '',
    date: dateStr,
    start: timeOf(base.start_at),
    end: timeOf(base.end_at),
    color: base.color,
    notes: '',
  };
  formError.value = '';
}
function openEdit(a: Appointment) {
  draft.value = {
    id: a.id,
    title: a.title,
    date: dateOf(a.start_at),
    start: timeOf(a.start_at),
    end: timeOf(a.end_at),
    color: a.color,
    notes: a.notes,
  };
  formError.value = '';
}
async function save() {
  const d = draft.value;
  if (!d) return;
  if (!d.title.trim()) return void (formError.value = 'Please enter a title.');
  if (!d.date || !d.start || !d.end) return void (formError.value = 'Date and times are required.');
  const start_at = `${d.date} ${d.start}`;
  let end_at = `${d.date} ${d.end}`;
  if (end_at <= start_at) end_at = addMinutes(start_at, 30);
  const payload = { title: d.title.trim(), start_at, end_at, color: d.color, notes: d.notes };
  if (d.id === null) await addAppointment(props.db, payload);
  else await updateAppointment(props.db, d.id, payload);
  selected.value = d.date;
  draft.value = null;
}
async function remove() {
  const d = draft.value;
  if (d?.id == null) return;
  await deleteAppointment(props.db, d.id);
  draft.value = null;
}

const fmtDay = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
};
const fmtShort = (a: Appointment) => {
  const [y, m, d] = dateOf(a.start_at).split('-').map(Number);
  return `${new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${timeOf(a.start_at)}`;
};
</script>

<template>
  <div class="cal">
    <div class="cal-main">
      <div class="cal-toolbar">
        <div class="cal-nav">
          <button class="wd-btn wd-btn-sm" type="button" aria-label="Previous month" @click="shift(-1)">‹</button>
          <button class="wd-btn wd-btn-sm" type="button" @click="goToday">Today</button>
          <button class="wd-btn wd-btn-sm" type="button" aria-label="Next month" @click="shift(1)">›</button>
        </div>
        <h3 class="cal-month">{{ monthLabel }}</h3>
        <span class="wd-badge" title="Live COUNT(*) for this month">{{ monthTotal }} this month</span>
        <button class="wd-btn wd-btn-sm wd-btn-primary cal-new" type="button" @click="openNew()">+ New</button>
      </div>

      <div class="cal-grid" role="grid" :aria-label="monthLabel">
        <div v-for="w in weekdays" :key="w" class="cal-dow" role="columnheader">{{ w }}</div>
        <div
          v-for="d in days"
          :key="ymd(d)"
          role="gridcell"
          tabindex="0"
          :class="[
            'cal-day',
            {
              'is-other': d.getMonth() !== month.getMonth(),
              'is-today': ymd(d) === ymd(today),
              'is-selected': ymd(d) === selected,
            },
          ]"
          :aria-label="fmtDay(ymd(d))"
          @click="pick(d)"
          @dblclick="openNew(ymd(d))"
          @keydown.enter.prevent="pick(d)"
        >
          <span class="cal-num">{{ d.getDate() }}</span>
          <div class="cal-chips">
            <button
              v-for="a in (byDay.get(ymd(d)) ?? []).slice(0, 3)"
              :key="a.id"
              type="button"
              class="cal-chip"
              :style="{ '--c': a.color }"
              :title="`${timeOf(a.start_at)} ${a.title}`"
              @click.stop="pick(d); openEdit(a)"
            >
              <span class="cal-chip-time">{{ timeOf(a.start_at) }}</span>
              <span class="cal-chip-title">{{ a.title }}</span>
            </button>
            <span v-if="(byDay.get(ymd(d))?.length ?? 0) > 3" class="cal-more">+{{ (byDay.get(ymd(d))?.length ?? 0) - 3 }} more</span>
          </div>
        </div>
      </div>
    </div>

    <aside class="cal-side">
      <section class="cal-card">
        <header class="cal-card-head">
          <h4>{{ fmtDay(selected) }}</h4>
          <button class="wd-btn wd-btn-sm" type="button" @click="openNew()">+ Add</button>
        </header>
        <ul v-if="selectedList.length" class="cal-list">
          <li v-for="a in selectedList" :key="a.id" :style="{ '--c': a.color }">
            <button type="button" class="cal-item" @click="openEdit(a)">
              <span class="cal-dot" />
              <span class="cal-item-time">{{ timeOf(a.start_at) }}–{{ timeOf(a.end_at) }}</span>
              <span class="cal-item-title">{{ a.title }}</span>
            </button>
          </li>
        </ul>
        <p v-else class="cal-empty">Nothing scheduled.</p>
      </section>

      <section class="cal-card">
        <header class="cal-card-head"><h4>Upcoming</h4></header>
        <ul v-if="upcoming.length" class="cal-list">
          <li v-for="a in upcoming" :key="a.id" :style="{ '--c': a.color }">
            <button type="button" class="cal-item" @click="openEdit(a)">
              <span class="cal-dot" />
              <span class="cal-item-time">{{ fmtShort(a) }}</span>
              <span class="cal-item-title">{{ a.title }}</span>
            </button>
          </li>
        </ul>
        <p v-else class="cal-empty">No upcoming appointments.</p>
      </section>
    </aside>

    <div v-if="draft" class="cal-overlay" @click.self="draft = null" @keydown.esc="draft = null">
      <form class="cal-dialog" role="dialog" aria-modal="true" aria-label="Appointment" @submit.prevent="save">
        <h4>{{ draft.id === null ? 'New appointment' : 'Edit appointment' }}</h4>
        <label>Title <input v-model="draft.title" class="wd-input" autofocus /></label>
        <label>Date <input v-model="draft.date" class="wd-input" type="date" /></label>
        <div class="cal-row">
          <label>Start <input v-model="draft.start" class="wd-input" type="time" /></label>
          <label>End <input v-model="draft.end" class="wd-input" type="time" /></label>
        </div>
        <div class="cal-colors" role="radiogroup" aria-label="Color">
          <button
            v-for="c in COLORS"
            :key="c"
            type="button"
            role="radio"
            :aria-checked="draft.color === c"
            :class="['cal-color', { on: draft.color === c }]"
            :style="{ background: c }"
            :aria-label="c"
            @click="draft.color = c"
          />
        </div>
        <label>Notes <textarea v-model="draft.notes" class="wd-input" rows="2" /></label>
        <p v-if="formError" class="cal-error">{{ formError }}</p>
        <div class="cal-dialog-actions">
          <button v-if="draft.id !== null" class="wd-btn wd-btn-danger" type="button" @click="remove">Delete</button>
          <span class="cal-spacer" />
          <button class="wd-btn" type="button" @click="draft = null">Cancel</button>
          <button class="wd-btn wd-btn-primary" type="submit">Save</button>
        </div>
      </form>
    </div>

    <details class="wd-code cal-code">
      <summary>Show the live queries behind this calendar</summary>
      <pre><code>// Only the visible 6-week grid is loaded (uses the start_at index).
// Changing `month` re-runs it, and so does any change to `appointments`.
const { data: appointments } = useLiveQuery(
  () =&gt; db.from('appointments')
        .where('start_at', '&gt;=', from)
        .where('start_at', '&lt;', to)
        .orderBy('start_at'),
  [month],
);

// "Upcoming" and the month badge are independent live queries
useLiveQuery(() =&gt; db.from('appointments').where('start_at', '&gt;=', now).orderBy('start_at').limit(5));
useLiveQuery(() =&gt; db.from('appointments').whereStartsWith('start_at', '2026-11-').count('id', 'n'), [month]);</code></pre>
    </details>
  </div>
</template>

<style scoped>
.cal {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 250px;
  gap: 1rem;
  min-width: 0;
}
.cal-main {
  min-width: 0;
}
.cal-code {
  grid-column: 1 / -1;
}
.cal-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 0.75rem;
  margin-bottom: 0.6rem;
}
.cal-nav {
  display: flex;
  gap: 0.25rem;
}
.cal-month {
  flex: 1 1 auto;
  min-width: 9.5rem;
  white-space: nowrap;
  margin: 0;
  font-size: 1.05rem;
  font-weight: 700;
  border: none;
  padding: 0;
  letter-spacing: 0;
}
.cal-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  border-top: 1px solid var(--vp-c-divider);
  border-left: 1px solid var(--vp-c-divider);
}
.cal-dow {
  padding: 0.3rem 0.4rem;
  font-size: 0.7rem;
  font-weight: 700;
  text-align: center;
  color: var(--vp-c-text-2);
  background: var(--vp-c-bg-soft);
  border-right: 1px solid var(--vp-c-divider);
  border-bottom: 1px solid var(--vp-c-divider);
}
.cal-day {
  min-width: 0;
  min-height: 84px;
  padding: 0.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  border-right: 1px solid var(--vp-c-divider);
  border-bottom: 1px solid var(--vp-c-divider);
  cursor: pointer;
  background: var(--vp-c-bg);
}
.cal-day:hover {
  background: var(--vp-c-bg-soft);
}
.cal-day.is-other {
  background: var(--vp-c-bg-alt);
  color: var(--vp-c-text-3);
}
.cal-day.is-selected {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: -2px;
}
.cal-num {
  align-self: flex-end;
  min-width: 1.4rem;
  height: 1.4rem;
  line-height: 1.4rem;
  text-align: center;
  border-radius: 999px;
  font-size: 0.74rem;
  font-weight: 600;
}
.is-today .cal-num {
  background: var(--vp-c-brand-1);
  color: #fff;
}
.cal-chips {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.cal-chip {
  display: flex;
  gap: 0.3rem;
  align-items: center;
  min-width: 0;
  padding: 1px 5px;
  border: none;
  border-radius: 4px;
  border-left: 3px solid var(--c);
  background: color-mix(in srgb, var(--c) 16%, transparent);
  color: var(--vp-c-text-1);
  font-size: 0.68rem;
  text-align: left;
  cursor: pointer;
}
.cal-chip-time {
  flex: none;
  opacity: 0.7;
}
.cal-chip-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cal-more {
  font-size: 0.66rem;
  color: var(--vp-c-text-2);
}
.cal-side {
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
  min-width: 0;
}
.cal-card {
  padding: 0.7rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg-soft);
}
.cal-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.4rem;
}
.cal-card-head h4 {
  margin: 0;
  font-size: 0.85rem;
}
.cal-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.cal-list li {
  margin: 0;
}
.cal-item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  column-gap: 0.45rem;
  width: 100%;
  padding: 0.3rem 0.2rem;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--vp-c-text-1);
  text-align: left;
  cursor: pointer;
}
.cal-item:hover {
  background: var(--vp-c-bg);
}
.cal-dot {
  grid-row: 1 / span 2;
  width: 8px;
  height: 8px;
  margin-top: 0.3rem;
  border-radius: 50%;
  background: var(--c);
}
.cal-item-time {
  font-size: 0.68rem;
  color: var(--vp-c-text-2);
}
.cal-item-title {
  font-size: 0.82rem;
  overflow-wrap: anywhere;
}
.cal-empty {
  margin: 0;
  font-size: 0.78rem;
  color: var(--vp-c-text-2);
}
.cal-overlay {
  position: absolute;
  inset: -1rem;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: rgba(0, 0, 0, 0.45);
}
.cal-dialog {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  width: min(380px, 100%);
  max-height: 100%;
  overflow: auto;
  padding: 1rem;
  border-radius: 12px;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
}
.cal-dialog h4 {
  margin: 0;
}
.cal-dialog label {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  min-width: 0;
  font-size: 0.74rem;
  font-weight: 600;
  color: var(--vp-c-text-2);
}
.cal-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.6rem;
}
.cal-colors {
  display: flex;
  gap: 0.4rem;
}
.cal-color {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
}
.cal-color.on {
  border-color: var(--vp-c-text-1);
}
.cal-error {
  margin: 0;
  color: #ef4444;
  font-size: 0.78rem;
}
.cal-dialog-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.cal-spacer {
  flex: 1;
}

/* Narrow frame (typical docs column): stack the side panels under the grid */
@container wd (max-width: 860px) {
  .cal {
    grid-template-columns: minmax(0, 1fr);
  }
  .cal-side {
    flex-direction: row;
    flex-wrap: wrap;
  }
  .cal-card {
    flex: 1 1 240px;
    min-width: 0;
  }
}

/* Very narrow (phones): appointments become colored dots, the selected-day list shows details */
@container wd (max-width: 560px) {
  .cal-day {
    min-height: 54px;
  }
  .cal-chip-title,
  .cal-chip-time,
  .cal-more {
    display: none;
  }
  .cal-chips {
    flex-direction: row;
    flex-wrap: wrap;
  }
  .cal-chip {
    width: 8px;
    height: 8px;
    padding: 0;
    border-radius: 50%;
    border: none;
    background: var(--c);
  }
  .cal-new {
    margin-left: auto;
  }
}
</style>
