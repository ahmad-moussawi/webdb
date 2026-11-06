<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { WebDB } from '@ahmadmoussawi/webdb';
import { useLiveQuery } from '@ahmadmoussawi/webdb/vue';
import {
  addArticle,
  articleCountQuery,
  CATEGORIES,
  deleteArticle,
  SHORT_ARTICLE_WORDS,
  searchQuery,
  type Category,
  type SearchRow,
} from './db';

const props = defineProps<{ db: WebDB }>();

const query = ref('');
const debounced = ref('');
const fuzzy = ref(true);
const shortOnly = ref(false);
const category = ref('');

// Debounce typing so the query runs ~7 times per second at most, not on every keystroke.
let timer: ReturnType<typeof setTimeout> | undefined;
watch(query, (value) => {
  clearTimeout(timer);
  timer = setTimeout(() => (debounced.value = value), 120);
});
onBeforeUnmount(() => clearTimeout(timer));

// The search itself: relevance(), highlight(), snippet() and word_count() are UDFs running in the query.
const { data: rows } = useLiveQuery(
  () => searchQuery(props.db, { q: debounced.value, fuzzy: fuzzy.value, shortOnly: shortOnly.value, category: category.value }),
  [debounced, fuzzy, shortOnly, category],
  { db: props.db, initialData: [] },
);
const { data: countRows } = useLiveQuery(() => articleCountQuery(props.db), { db: props.db, initialData: [] });

const results = computed(() => (rows.value ?? []) as unknown as SearchRow[]);
const total = computed(() => Number(countRows.value?.[0]?.n ?? 0));
const searching = computed(() => debounced.value.trim().length > 0);

const examples = [
  { label: 'reactve', hint: 'typo' },
  { label: 'cafe', hint: 'accent' },
  { label: 'index perf', hint: 'two words' },
  { label: 'persist', hint: 'prefix' },
  { label: 'udf search', hint: 'tags + title' },
];

function useExample(text: string) {
  query.value = text;
  debounced.value = text;
}

const tagList = (tags: string) => tags.split(',').map((t) => t.trim()).filter(Boolean);

// ---- add an article (shows the results updating live) ----------------------------------
const draft = ref({ title: '', body: '', tags: '', category: 'Guides' as Category });
const added = ref('');

async function submit() {
  const { title } = draft.value;
  await addArticle(props.db, draft.value);
  if (title.trim()) {
    added.value = `Added “${title.trim()}”. Search for one of its words to find it.`;
    draft.value = { title: '', body: '', tags: '', category: draft.value.category };
  }
}
</script>

<template>
  <div class="srch">
    <div class="srch-box">
      <input
        v-model="query"
        class="wd-input srch-input"
        type="search"
        placeholder="Search articles… try “reactve”, “cafe” or “index perf”"
        aria-label="Search articles"
        autocomplete="off"
        spellcheck="false"
      />
    </div>

    <div class="srch-examples">
      <span>Try:</span>
      <button v-for="e in examples" :key="e.label" type="button" class="srch-example" @click="useExample(e.label)">
        {{ e.label }} <small>{{ e.hint }}</small>
      </button>
    </div>

    <div class="srch-options">
      <label><input v-model="fuzzy" type="checkbox" /> Typo tolerance</label>
      <label><input v-model="shortOnly" type="checkbox" /> Short articles (&lt; {{ SHORT_ARTICLE_WORDS }} words)</label>
      <label>
        Category
        <select v-model="category" class="srch-select">
          <option value="">All</option>
          <option v-for="c in CATEGORIES" :key="c" :value="c">{{ c }}</option>
        </select>
      </label>
      <span class="srch-count" aria-live="polite">{{ results.length }} of {{ total }} articles</span>
    </div>

    <ul v-if="results.length" class="srch-results">
      <li v-for="r in results" :key="r.id" class="srch-item">
        <div class="srch-head">
          <!-- title_html / snippet_html come from the highlight() / snippet() UDFs, which HTML-escape the text -->
          <h4 class="srch-title" v-html="r.title_html" />
          <span v-if="searching" class="wd-badge" title="relevance() score returned by the UDF">score {{ r.score }}</span>
          <button class="wd-btn wd-btn-sm wd-btn-danger" type="button" :aria-label="`Delete ${r.title}`" @click="deleteArticle(props.db, r.id)">
            ✕
          </button>
        </div>
        <p class="srch-snippet" v-html="r.snippet_html" />
        <div class="srch-meta">
          <span class="srch-cat">{{ r.category }}</span>
          <span>{{ r.author }} · {{ r.created_at }} · {{ r.words }} words</span>
          <span class="srch-tags">
            <button v-for="t in tagList(r.tags)" :key="t" type="button" class="srch-tag" @click="useExample(t)">#{{ t }}</button>
          </span>
        </div>
      </li>
    </ul>
    <p v-else class="srch-empty">
      No articles match <strong>{{ debounced }}</strong
      >.
      <template v-if="!fuzzy">Turn on typo tolerance, or</template>
      <template v-else>Try</template>
      another word.
    </p>

    <details class="srch-add">
      <summary>Add an article</summary>
      <form class="srch-form" @submit.prevent="submit">
        <input v-model="draft.title" class="wd-input" placeholder="Title (e.g. Quantum notes)" aria-label="Title" />
        <textarea v-model="draft.body" class="wd-input" rows="3" placeholder="Body" aria-label="Body" />
        <div class="srch-form-row">
          <input v-model="draft.tags" class="wd-input" placeholder="tags, comma separated" aria-label="Tags" />
          <select v-model="draft.category" class="srch-select" aria-label="Category">
            <option v-for="c in CATEGORIES" :key="c" :value="c">{{ c }}</option>
          </select>
          <button class="wd-btn wd-btn-primary" type="submit" :disabled="!draft.title.trim() || !draft.body.trim()">Add</button>
        </div>
        <p v-if="added" class="srch-added">{{ added }}</p>
      </form>
    </details>

    <details class="wd-code">
      <summary>Show the UDFs and the query</summary>
      <pre><code>// 1) Plain JavaScript functions, registered once after WebDB.open()
db.registerFunction('relevance', relevance);   // (title, body, tags, q, fuzzy) =&gt; score
db.registerFunction('highlight', highlight);   // (text, q, fuzzy) =&gt; HTML with &lt;mark&gt;
db.registerFunction('snippet', snippet);       // (body, q, fuzzy) =&gt; excerpt HTML
db.registerFunction('word_count', wordCount);  // (text) =&gt; number

// 2) Use them anywhere in a query: SELECT, WHERE and ORDER BY
const score = fn('relevance', col('title'), col('body'), col('tags'), lit(q), lit(1));

const { data: results } = useLiveQuery(
  () =&gt; db.from('articles')
        .select(['id', 'title', 'category',
                 fn('highlight', col('title'), lit(q), lit(1)).as('title_html'),
                 fn('snippet',   col('body'),  lit(q), lit(1)).as('snippet_html'),
                 score.as('score')])
        .where(score.gt(0))                    // UDF in WHERE
        .where('category', '=', category)      // mixes with normal filters
        .orderBy('score', 'desc'),             // UDF result in ORDER BY
  [query, category],
);</code></pre>
    </details>
  </div>
</template>

<style scoped>
.srch {
  max-width: 760px;
  margin: 0 auto;
  min-width: 0;
}
.srch-input {
  width: 100%;
  box-sizing: border-box;
  padding: 0.65rem 0.9rem;
  font-size: 1rem;
}
.srch-examples {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  margin: 0.6rem 0;
  font-size: 0.78rem;
  color: var(--vp-c-text-2);
}
.srch-example {
  padding: 0.15rem 0.6rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 999px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  font-size: 0.78rem;
  cursor: pointer;
}
.srch-example:hover {
  border-color: var(--vp-c-brand-1);
}
.srch-example small {
  color: var(--vp-c-text-3);
}
.srch-options {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 1.1rem;
  margin-bottom: 0.9rem;
  font-size: 0.8rem;
  color: var(--vp-c-text-2);
}
.srch-options label {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}
.srch-select {
  padding: 0.2rem 0.4rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font-size: 0.8rem;
}
.srch-count {
  margin-left: auto;
  font-weight: 600;
}
.srch-results {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.srch-item {
  margin: 0;
  padding: 0.7rem 0.9rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg-soft);
}
.srch-head {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
}
.srch-title {
  flex: 1;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: none;
  font-size: 0.98rem;
  font-weight: 700;
  letter-spacing: 0;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.srch-snippet {
  margin: 0.3rem 0 0.4rem;
  font-size: 0.85rem;
  line-height: 1.5;
  color: var(--vp-c-text-2);
  overflow-wrap: anywhere;
}
.srch-title :deep(mark),
.srch-snippet :deep(mark) {
  padding: 0 2px;
  border-radius: 3px;
  background: rgba(250, 204, 21, 0.45);
  color: inherit;
}
.srch-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.3rem 0.7rem;
  font-size: 0.72rem;
  color: var(--vp-c-text-3);
}
.srch-cat {
  padding: 0 0.5rem;
  border-radius: 999px;
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
  font-weight: 600;
}
.srch-tags {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}
.srch-tag {
  padding: 0;
  border: none;
  background: none;
  color: var(--vp-c-text-2);
  font-size: 0.72rem;
  cursor: pointer;
}
.srch-tag:hover {
  color: var(--vp-c-brand-1);
  text-decoration: underline;
}
.srch-empty {
  padding: 1.2rem;
  text-align: center;
  color: var(--vp-c-text-2);
  border: 1px dashed var(--vp-c-divider);
  border-radius: 10px;
}
.srch-add {
  margin-top: 1rem;
  font-size: 0.85rem;
}
.srch-add summary {
  cursor: pointer;
  font-weight: 600;
  color: var(--vp-c-text-2);
}
.srch-form {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: 0.6rem;
}
.srch-form-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.srch-form-row .wd-input {
  flex: 1 1 160px;
}
.srch-added {
  margin: 0;
  color: #10b981;
  font-size: 0.8rem;
}
</style>
