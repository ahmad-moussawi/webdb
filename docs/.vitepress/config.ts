import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'WebDB',
  description: 'Ultra-lean browser-native relational database engine with 4KB slotted pages and VDBE execution',
  base: '/webdb/',

  markdown: {
    math: true,
  },

  head: [
    [
      'script',
      {
        async: '',
        src: 'https://www.googletagmanager.com/gtag/js?id=G-SK750XLF2Y',
      },
    ],
    [
      'script',
      {},
      `window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', 'G-SK750XLF2Y');`,
    ],
  ],

  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'WebDB',

    nav: [
      { text: 'Getting Started', link: '/getting-started' },
      { text: 'Roadmap & Plans', link: '/plans/plan' },
      { text: 'Future Extensions', link: '/plans/future_extensions_roadmap' },
      { text: 'Limitations', link: '/plans/limitations' },
      {
        text: 'Phase Specs',
        items: [
          { text: '01: Storage & Memory', link: '/plans/01_storage_memory_arch' },
          { text: '02: Components & Scope', link: '/plans/02_components_v1_scope' },
          { text: '03: VDBE Execution Engine', link: '/plans/03_vdbe_execution_engine' },
          { text: '04: Transactions & WAL', link: '/plans/04_transactions_acid_wal' },
          { text: '05: JavaScript UDFs', link: '/plans/05_javascript_udf_support' },
          { text: '06: Strict C-Style Rules', link: '/plans/06_c_style_rules_v1' },
          { text: '07: Multi-Tab Concurrency', link: '/plans/07_concurrency_multitab_coordination' },
          { text: '08: V2 C/Wasm Pipeline', link: '/plans/08_v2_c_wasm_build_pipeline' },
          { text: '09: QA & Verification', link: '/plans/09_qa_verification_differential_testing' },
        ],
      },
      { text: 'GitHub', link: 'https://github.com/ahmad-moussawi/webdb' },
    ],

    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting Started', link: '/getting-started' },
        ],
      },
      {
        text: 'Architecture & Strategy',
        items: [
          { text: 'Strategic Master Plan', link: '/plans/plan' },
          { text: 'Prototype ("Walking Skeleton")', link: '/plans/prototype' },
          { text: 'System Limits & Invariants', link: '/plans/limitations' },
          { text: 'Future Extensions & Search Roadmap', link: '/plans/future_extensions_roadmap' },
        ],
      },
      {
        text: 'Phase Specifications',
        collapsed: false,
        items: [
          { text: 'Phase 1: Storage & Memory', link: '/plans/01_storage_memory_arch' },
          { text: 'Phase 2: Components & V1 Scope', link: '/plans/02_components_v1_scope' },
          { text: 'Phase 3: VDBE Bytecode Engine', link: '/plans/03_vdbe_execution_engine' },
          { text: 'Phase 4: Transactions, ACID & WAL', link: '/plans/04_transactions_acid_wal' },
          { text: 'Phase 5: JavaScript UDF Support', link: '/plans/05_javascript_udf_support' },
          { text: 'Phase 6: Strict C-Style Rules (V1)', link: '/plans/06_c_style_rules_v1' },
          { text: 'Phase 7: Multi-Tab Coordination', link: '/plans/07_concurrency_multitab_coordination' },
          { text: 'Phase 8: V2 C/Wasm Build Pipeline', link: '/plans/08_v2_c_wasm_build_pipeline' },
          { text: 'Phase 9: QA & Differential Testing', link: '/plans/09_qa_verification_differential_testing' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/ahmad-moussawi/webdb' },
    ],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 WebDB Authors',
    },

    search: {
      provider: 'local',
    },
  },
});
