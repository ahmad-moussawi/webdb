<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import type { WebDB } from '@ahmadmoussawi/webdb';
import { useLiveQuery } from '@ahmadmoussawi/webdb/vue';
import {
  addTodo,
  clearCompleted,
  deleteTodo,
  renameTodo,
  setAllDone,
  setTodoDone,
  todosQuery,
  todoStatsQuery,
  type Todo,
  type TodoFilter,
} from './db';

const props = defineProps<{ db: WebDB }>();

const filter = ref<TodoFilter>('all');
const search = ref('');
const draft = ref('');
const editingId = ref<number | null>(null);
const editText = ref('');

// 1) The list. The query function re-runs when `todos` changes (here, in another tab, ...)
//    and whenever `filter` / `search` change.
const { data: rows, isLoading } = useLiveQuery(
  () => todosQuery(props.db, filter.value, search.value),
  [filter, search],
  { db: props.db, initialData: [] },
);
const todos = computed(() => (rows.value ?? []) as unknown as Todo[]);

// 2) Counters: a second, independent live query using GROUP BY.
const { data: stats } = useLiveQuery(() => todoStatsQuery(props.db), { db: props.db, initialData: [] });
const count = (done: number) => Number((stats.value ?? []).find((s) => s.done === done)?.n ?? 0);
const active = computed(() => count(0));
const completed = computed(() => count(1));
const total = computed(() => active.value + completed.value);

const filters: Array<{ id: TodoFilter; label: string; n: () => number }> = [
  { id: 'all', label: 'All', n: () => total.value },
  { id: 'active', label: 'Active', n: () => active.value },
  { id: 'done', label: 'Done', n: () => completed.value },
];

async function submit() {
  const title = draft.value;
  draft.value = '';
  await addTodo(props.db, title);
}

async function startEdit(todo: Todo) {
  editingId.value = todo.id;
  editText.value = todo.title;
  await nextTick();
  (document.querySelector('.todo-edit') as HTMLInputElement | null)?.focus();
}

async function commitEdit() {
  const id = editingId.value;
  if (id === null) return;
  editingId.value = null;
  await renameTodo(props.db, id, editText.value);
}
</script>

<template>
  <div class="todo">
    <form class="todo-add" @submit.prevent="submit">
      <input v-model="draft" class="wd-input todo-add-input" placeholder="What needs to be done?" aria-label="New todo" />
      <button class="wd-btn wd-btn-primary" type="submit" :disabled="!draft.trim()">Add</button>
    </form>

    <div class="todo-bar">
      <div class="todo-filters" role="tablist">
        <button
          v-for="f in filters"
          :key="f.id"
          type="button"
          role="tab"
          :aria-selected="filter === f.id"
          :class="['todo-filter', { active: filter === f.id }]"
          @click="filter = f.id"
        >
          {{ f.label }} <span class="todo-count">{{ f.n() }}</span>
        </button>
      </div>
      <input v-model="search" class="wd-input todo-search" type="search" placeholder="Search…" aria-label="Search todos" />
    </div>

    <p v-if="isLoading" class="todo-empty">Loading…</p>
    <ul v-else-if="todos.length" class="todo-list">
      <li v-for="t in todos" :key="t.id" :class="['todo-item', { done: t.done === 1 }]">
        <input
          type="checkbox"
          class="todo-check"
          :checked="t.done === 1"
          :aria-label="`Mark “${t.title}” as ${t.done === 1 ? 'active' : 'done'}`"
          @change="setTodoDone(props.db, t.id, ($event.target as HTMLInputElement).checked)"
        />
        <input
          v-if="editingId === t.id"
          v-model="editText"
          class="wd-input todo-edit"
          @keydown.enter.prevent="commitEdit"
          @keydown.esc.prevent="editingId = null"
          @blur="commitEdit"
        />
        <span v-else class="todo-title" title="Double-click to edit" @dblclick="startEdit(t)">{{ t.title }}</span>
        <button class="wd-btn wd-btn-sm wd-btn-danger" type="button" :aria-label="`Delete “${t.title}”`" @click="deleteTodo(props.db, t.id)">
          ✕
        </button>
      </li>
    </ul>
    <p v-else class="todo-empty">{{ total === 0 ? 'Nothing here. Add your first todo!' : 'No todos match this filter.' }}</p>

    <div class="todo-footer">
      <span>{{ active }} item{{ active === 1 ? '' : 's' }} left</span>
      <span class="todo-footer-actions">
        <button class="wd-btn wd-btn-sm" type="button" :disabled="!active" @click="setAllDone(props.db, true)">Mark all done</button>
        <button class="wd-btn wd-btn-sm" type="button" :disabled="!completed" @click="clearCompleted(props.db)">
          Clear completed
        </button>
      </span>
    </div>

    <details class="wd-code">
      <summary>Show the live queries behind this list</summary>
      <pre><code>// Re-runs on every change to `todos`, and when `filter` / `search` change
const { data: todos } = useLiveQuery(
  () =&gt; db.from('todos')
        .where('done', '=', 0)            // filter === 'active'
        .whereContains('title', search.value)
        .orderBy('id', 'desc'),
  [filter, search],
);

// Independent live query driving the counters
const { data: stats } = useLiveQuery(
  () =&gt; db.from('todos').groupBy('done').count('id', 'n'),
);</code></pre>
    </details>
  </div>
</template>

<style scoped>
.todo {
  max-width: 640px;
  margin: 0 auto;
}
.todo-add {
  display: flex;
  gap: 0.5rem;
}
.todo-add-input {
  flex: 1;
}
.todo-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin: 1rem 0 0.5rem;
}
.todo-filters {
  display: flex;
  gap: 0.25rem;
}
.todo-filter {
  padding: 0.25rem 0.7rem;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  color: var(--vp-c-text-2);
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
}
.todo-filter.active {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
}
.todo-count {
  margin-left: 0.2rem;
  opacity: 0.75;
}
.todo-search {
  width: 160px;
  max-width: 100%;
}
.todo-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  overflow: hidden;
}
.todo-item {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  padding: 0.55rem 0.8rem;
  border-top: 1px solid var(--vp-c-divider);
  margin: 0;
}
.todo-item:first-child {
  border-top: none;
}
.todo-item.done .todo-title {
  text-decoration: line-through;
  color: var(--vp-c-text-3);
}
.todo-check {
  width: 1.05rem;
  height: 1.05rem;
  flex: none;
  accent-color: var(--vp-c-brand-1);
}
.todo-title {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
  cursor: text;
  font-size: 0.9rem;
}
.todo-edit {
  flex: 1;
}
.todo-empty {
  margin: 1rem 0;
  padding: 1.2rem;
  text-align: center;
  color: var(--vp-c-text-2);
  border: 1px dashed var(--vp-c-divider);
  border-radius: 10px;
}
.todo-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-top: 0.75rem;
  font-size: 0.8rem;
  color: var(--vp-c-text-2);
}
.todo-footer-actions {
  display: flex;
  gap: 0.4rem;
}
</style>
