<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import type { WebDB } from '@ahmadmoussawi/webdb';
import { useLiveQuery } from '@ahmadmoussawi/webdb/vue';
import {
  addCard,
  addList,
  cardCountsQuery,
  cardsQuery,
  deleteCard,
  deleteList,
  listsQuery,
  moveCard,
  renameCard,
  type KanbanCard,
  type KanbanList,
} from './db';

const props = defineProps<{ db: WebDB }>();

// Three independent live queries: the lists, every card, and a GROUP BY for the badges.
// Any change (drag & drop here, or an edit made in another tab) refreshes all of them.
const { data: listRows } = useLiveQuery(() => listsQuery(props.db), { db: props.db, initialData: [] });
const { data: cardRows } = useLiveQuery(() => cardsQuery(props.db), { db: props.db, initialData: [] });
const { data: countRows } = useLiveQuery(() => cardCountsQuery(props.db), { db: props.db, initialData: [] });

const lists = computed(() => (listRows.value ?? []) as unknown as KanbanList[]);
const cards = computed(() => (cardRows.value ?? []) as unknown as KanbanCard[]);
const cardsByList = computed(() => {
  const map = new Map<number, KanbanCard[]>();
  for (const l of lists.value) map.set(l.id, []);
  for (const c of cards.value) map.get(c.list_id)?.push(c);
  return map;
});
const countOf = (listId: number) => Number((countRows.value ?? []).find((r) => r.list_id === listId)?.n ?? 0);

// ---- drag & drop (HTML5) -------------------------------------------------------------
const dragId = ref<number | null>(null);
const hover = ref<{ listId: number; index: number } | null>(null);

function onDragStart(e: DragEvent, card: KanbanCard) {
  dragId.value = card.id;
  e.dataTransfer?.setData('text/plain', String(card.id));
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
}

function onCardOver(e: DragEvent, listId: number, index: number) {
  if (dragId.value === null) return;
  e.preventDefault();
  const el = e.currentTarget as HTMLElement;
  const rect = el.getBoundingClientRect();
  const after = e.clientY > rect.top + rect.height / 2;
  hover.value = { listId, index: after ? index + 1 : index };
}

function onListOver(e: DragEvent, listId: number) {
  if (dragId.value === null) return;
  e.preventDefault();
  if (hover.value?.listId !== listId) hover.value = { listId, index: cardsByList.value.get(listId)?.length ?? 0 };
}

async function onDrop(e: DragEvent, listId: number) {
  e.preventDefault();
  const id = dragId.value;
  const target = hover.value && hover.value.listId === listId ? hover.value : null;
  dragId.value = null;
  hover.value = null;
  if (id === null) return;
  const siblings = cardsByList.value.get(listId) ?? [];
  let index = target ? target.index : siblings.length;
  // `moveCard` removes the card first, so account for it when moving down inside one list.
  const from = siblings.findIndex((c) => c.id === id);
  if (from !== -1 && from < index) index -= 1;
  await moveCard(props.db, id, listId, index);
}

function onDragEnd() {
  dragId.value = null;
  hover.value = null;
}

// ---- editing -------------------------------------------------------------------------
const newCard = ref<Record<number, string>>({});
const newList = ref('');
const editingId = ref<number | null>(null);
const editText = ref('');

async function submitCard(listId: number) {
  const title = newCard.value[listId] ?? '';
  newCard.value[listId] = '';
  await addCard(props.db, listId, title);
}

async function submitList() {
  const title = newList.value;
  newList.value = '';
  await addList(props.db, title);
}

async function startEdit(card: KanbanCard) {
  editingId.value = card.id;
  editText.value = card.title;
  await nextTick();
  (document.querySelector('.kb-edit') as HTMLInputElement | null)?.focus();
}

async function commitEdit() {
  const id = editingId.value;
  if (id === null) return;
  editingId.value = null;
  await renameCard(props.db, id, editText.value);
}

async function moveTo(card: KanbanCard, listId: number) {
  if (listId === card.list_id) return;
  await moveCard(props.db, card.id, listId, cardsByList.value.get(listId)?.length ?? 0);
}

async function removeList(list: KanbanList) {
  if (countOf(list.id) > 0 && !window.confirm(`Delete “${list.title}” and its ${countOf(list.id)} card(s)?`)) return;
  await deleteList(props.db, list.id);
}
</script>

<template>
  <div class="kb">
    <div class="kb-board">
      <section
        v-for="list in lists"
        :key="list.id"
        :class="['kb-list', { 'is-target': hover?.listId === list.id }]"
        @dragover="onListOver($event, list.id)"
        @drop="onDrop($event, list.id)"
      >
        <header class="kb-list-head">
          <h4 class="kb-list-title">{{ list.title }}</h4>
          <span class="wd-badge" :title="`${countOf(list.id)} cards (live GROUP BY)`">{{ countOf(list.id) }}</span>
          <button class="wd-btn wd-btn-sm wd-btn-danger" type="button" :aria-label="`Delete list ${list.title}`" @click="removeList(list)">
            ✕
          </button>
        </header>

        <ul class="kb-cards">
          <template v-for="(card, i) in cardsByList.get(list.id)" :key="card.id">
            <li v-if="hover?.listId === list.id && hover.index === i" class="kb-drop-line" aria-hidden="true" />
            <li
              :class="['kb-card', { dragging: dragId === card.id }]"
              draggable="true"
              @dragstart="onDragStart($event, card)"
              @dragover="onCardOver($event, list.id, i)"
              @dragend="onDragEnd"
            >
              <input
                v-if="editingId === card.id"
                v-model="editText"
                class="wd-input kb-edit"
                @keydown.enter.prevent="commitEdit"
                @keydown.esc.prevent="editingId = null"
                @blur="commitEdit"
              />
              <span v-else class="kb-card-title" title="Double-click to rename" @dblclick="startEdit(card)">{{ card.title }}</span>
              <div class="kb-card-tools">
                <select
                  class="kb-move"
                  :value="card.list_id"
                  :aria-label="`Move “${card.title}” to another list`"
                  @change="moveTo(card, Number(($event.target as HTMLSelectElement).value))"
                >
                  <option v-for="l in lists" :key="l.id" :value="l.id">{{ l.title }}</option>
                </select>
                <button class="wd-btn wd-btn-sm wd-btn-danger" type="button" :aria-label="`Delete card ${card.title}`" @click="deleteCard(props.db, card.id)">
                  ✕
                </button>
              </div>
            </li>
          </template>
          <li
            v-if="hover?.listId === list.id && hover.index >= (cardsByList.get(list.id)?.length ?? 0)"
            class="kb-drop-line"
            aria-hidden="true"
          />
        </ul>

        <form class="kb-add" @submit.prevent="submitCard(list.id)">
          <input v-model="newCard[list.id]" class="wd-input" placeholder="+ Add a card" :aria-label="`New card in ${list.title}`" />
        </form>
      </section>

      <form class="kb-list kb-new-list" @submit.prevent="submitList">
        <input v-model="newList" class="wd-input" placeholder="+ Add another list" aria-label="New list title" />
      </form>
    </div>

    <details class="wd-code">
      <summary>Show how a drop is saved (one transaction)</summary>
      <pre><code>// Live queries: lists, cards and per-list counts. No manual refresh anywhere.
const { data: cards } = useLiveQuery(
  () =&gt; db.from('cards').orderBy('list_id').orderBy('position'),
);
const { data: counts } = useLiveQuery(
  () =&gt; db.from('cards').groupBy('list_id').count('id', 'n'),
);

// Dropping a card renumbers both lists atomically
await db.transaction(async (tx) =&gt; {
  const target = (await tx.from('cards').where('list_id', '=', toListId)
                          .orderBy('position').toArray()).filter(c =&gt; c.id !== cardId);
  target.splice(toIndex, 0, { ...card, list_id: toListId });
  for (const [i, c] of target.entries()) {
    await tx.update('cards', c.id, { list_id: toListId, position: i });
  }
});</code></pre>
    </details>
  </div>
</template>

<style scoped>
.kb {
  min-width: 0;
}
.kb-board {
  display: flex;
  gap: 0.9rem;
  align-items: flex-start;
  overflow-x: auto;
  padding-bottom: 0.5rem;
}
.kb-list {
  flex: 0 0 250px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 0.7rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
  transition: border-color 0.15s, background 0.15s;
}
.kb-list.is-target {
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
}
.kb-new-list {
  background: transparent;
  border-style: dashed;
}
.kb-list-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.kb-list-title {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 0.9rem;
  font-weight: 700;
  overflow-wrap: anywhere;
}
.kb-cards {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  min-height: 12px;
}
.kb-cards > li {
  margin: 0;
}
.kb-card {
  padding: 0.55rem 0.65rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg);
  cursor: grab;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}
.kb-card.dragging {
  opacity: 0.4;
}
.kb-card-title {
  display: block;
  font-size: 0.85rem;
  overflow-wrap: anywhere;
}
.kb-card-tools {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.4rem;
  margin-top: 0.45rem;
}
.kb-move {
  min-width: 0;
  max-width: 120px;
  padding: 0.1rem 0.25rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-2);
  font-size: 0.72rem;
}
.kb-drop-line {
  height: 3px;
  border-radius: 2px;
  background: var(--vp-c-brand-1);
}
.kb-add .wd-input,
.kb-new-list .wd-input {
  width: 100%;
  box-sizing: border-box;
}
</style>
