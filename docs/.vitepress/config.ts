import { fileURLToPath } from "node:url";
import { defineConfig, type HeadConfig } from "vitepress";

const src = (p: string) => fileURLToPath(new URL(`../../src/${p}`, import.meta.url));

const siteHostname = process.env.SITE_HOSTNAME;
const basePath = process.env.DOCS_BASE || "/";
const isCI = Boolean(process.env.CI || process.env.SITE_HOSTNAME);
const isWebDbDev = Boolean(
  siteHostname &&
    (siteHostname === "https://webdb.dev" ||
      siteHostname === "http://webdb.dev" ||
      siteHostname.includes("webdb.dev"))
);

const googleAnalyticsHead: HeadConfig[] = isCI
  ? isWebDbDev
    ? [
        [
          "script",
          {
            async: "",
            src: "https://www.googletagmanager.com/gtm.js?id=GTM-TTVXTF3R",
          },
        ],
        [
          "script",
          {},
          `window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());`,
        ],
      ]
    : [
        [
          "script",
          {
            async: "",
            src: "https://www.googletagmanager.com/gtag/js?id=G-SK750XLF2Y",
          },
        ],
        [
          "script",
          {},
          `window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', 'G-SK750XLF2Y');`,
        ],
      ]
  : [];

export default defineConfig({
  title: "WebDB",
  description:
    "Ultra-lean browser-native relational database engine with persistent OPFS & IndexedDB storage, ACID transactions, and fluent queries",
  base: basePath,
  lastUpdated: true,
  ...(siteHostname
    ? {
        sitemap: {
          hostname: siteHostname,
          transformItems(items) {
            items.push(
              { url: "playground/", changefreq: "weekly", priority: 0.9 },
              { url: "benchmark/", changefreq: "weekly", priority: 0.8 },
            );
            return items;
          },
        },
      }
    : {}),

  markdown: {
    math: true,
  },

  // The live demos import the library from source (more specific aliases first)
  vite: {
    resolve: {
      alias: [
        { find: "@ahmadmoussawi/webdb/vue", replacement: src("vue/index.ts") },
        { find: /^@ahmadmoussawi\/webdb$/, replacement: src("index.ts") },
      ],
    },
  },

  head: [
    ["link", { rel: "icon", href: `${basePath}logo.svg`, type: "image/svg+xml" }],
    ["link", { rel: "preconnect", href: "https://fonts.googleapis.com" }],
    [
      "link",
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" },
    ],
    [
      "link",
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Plus+Jakarta+Sans:wght@400;500;600;700;800;900&display=swap",
      },
    ],
    ...googleAnalyticsHead,
  ],

  themeConfig: {
    logo: "/logo.svg",
    siteTitle: "WebDB",

    nav: [
      { text: "Docs", link: "/getting-started" },
      { text: "Live Demos", link: "/demos/" },
      { text: "API", link: "/reference/api-reference" },
      { text: "Studio IDE", link: "/playground/", target: "_self" },
      { text: "Benchmarks", link: "/benchmark/", target: "_self" },
    ],

    sidebar: [
      {
        text: "Getting Started",
        items: [
          { text: "Introduction & Quick Start", link: "/getting-started" },
          {
            text: "Storage Backends & Config",
            link: "/guides/storage-and-configuration",
          },
        ],
      },
      {
        text: "Schema & Data Modeling",
        items: [
          {
            text: "Tables, Columns & Data Types",
            link: "/guides/schema-and-types",
          },
          {
            text: "Indexes & Unique Constraints",
            link: "/guides/indexes",
          },
          {
            text: "Schema Evolution (ALTER TABLE)",
            link: "/guides/migrations-and-alter-table",
          },
          {
            text: "Database Migrations",
            link: "/guides/migrations",
          },
        ],
      },
      {
        text: "Writing & Querying Data",
        items: [
          {
            text: "Insert, Update, Delete & Upsert",
            link: "/guides/mutations",
          },
          {
            text: "Querying Data (SELECT & WHERE)",
            link: "/guides/querying",
          },
          {
            text: "Joins, GROUP BY & Aggregations",
            link: "/guides/joins-and-aggregations",
          },
          {
            text: "Expressions, Functions & UDFs",
            link: "/guides/expressions-and-functions",
          },
        ],
      },
      {
        text: "Transactions, Reactivity & Sync",
        items: [
          {
            text: "Live Queries (React, Vue, Angular, JS)",
            link: "/guides/live-queries-and-frameworks",
          },
          {
            text: "Transactions & Savepoints",
            link: "/guides/transactions",
          },
          {
            text: "Reactivity & Offline Sync",
            link: "/offline-sync",
          },
          {
            text: "Binary Snapshots & Backups",
            link: "/guides/snapshots-and-backups",
          },
        ],
      },
      {
        text: "Live Demos",
        items: [
          { text: "Overview", link: "/demos/" },
          { text: "Two Tabs, One Database", link: "/demos/multi-tab" },
          { text: "Todo List", link: "/demos/todo" },
          { text: "Kanban Board", link: "/demos/kanban" },
          { text: "Calendar & Appointments", link: "/demos/calendar" },
          { text: "Typo-Tolerant Search with UDFs", link: "/demos/search" },
        ],
      },
      {
        text: "Performance & Recipes",
        items: [
          {
            text: "Query Performance & .explain()",
            link: "/query-planner",
          },
          {
            text: "Common Use Cases & Recipes",
            link: "/guides/use-cases",
          },
        ],
      },
      {
        text: "Reference",
        items: [
          {
            text: "Complete API Reference",
            link: "/reference/api-reference",
          },
          {
            text: "Error Handling & System Limits",
            link: "/reference/errors-and-limits",
          },
        ],
      },
      {
        text: "Engine Internals & Specs",
        collapsed: true,
        items: [
          { text: "Strategic Master Plan", link: "/plans/plan" },
          { text: 'Prototype ("Walking Skeleton")', link: "/plans/prototype" },
          {
            text: "Query Builder Grammar Spec",
            link: "/plans/query_builder_api_and_grammar",
          },
          { text: "System Limits & Invariants", link: "/plans/limitations" },
          {
            text: "Future Extensions Roadmap",
            link: "/plans/future_extensions_roadmap",
          },
          {
            text: "Phase 1: Storage & Memory",
            link: "/plans/01_storage_memory_arch",
          },
          {
            text: "Phase 2: Components & V1 Scope",
            link: "/plans/02_components_v1_scope",
          },
          {
            text: "Phase 3: VDBE Bytecode Engine",
            link: "/plans/03_vdbe_execution_engine",
          },
          {
            text: "Phase 4: Transactions, ACID & WAL",
            link: "/plans/04_transactions_acid_wal",
          },
          {
            text: "Phase 5: JavaScript UDF Support",
            link: "/plans/05_javascript_udf_support",
          },
          {
            text: "Phase 6: Strict C-Style Rules (V1)",
            link: "/plans/06_c_style_rules_v1",
          },
          {
            text: "Phase 7: Multi-Tab Coordination",
            link: "/plans/07_concurrency_multitab_coordination",
          },
          {
            text: "Phase 8: V2 C/Wasm Build Pipeline",
            link: "/plans/08_v2_c_wasm_build_pipeline",
          },
          {
            text: "Phase 9: QA & Differential Testing",
            link: "/plans/09_qa_verification_differential_testing",
          },
        ],
      },
    ],

    socialLinks: [
      { icon: "github", link: "https://github.com/ahmad-moussawi/webdb" },
    ],

    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © 2026 WebDB Authors",
    },

    search: {
      provider: "local",
    },
  },
});
