---
layout: home

hero:
  name: "WebDB Internals"
  text: "How to Build an In-Browser Relational Database"
  tagline: "A deep-dive handbook explaining C++ storage engines, WebAssembly cooperative scheduling, and buffer pools from first principles."
  actions:
    - theme: brand
      text: "Start Reading"
      link: /webdb_internals_handbook
    - theme: alt
      text: "Phase 1: Storage Format"
      link: /phase1_storage_format_guide
    - theme: alt
      text: "View on GitHub"
      link: https://github.com/ahmad-moussawi/webdb

features:
  - icon: 💾
    title: "Phase 1: Storage Format & Slotted Pages"
    details: "Fixed 4 KiB pages, Little-Endian binary safety, CRC-32 checksums, Dual Master Pages (Ping-Pong), and compact slotted page layouts."
    link: /phase1_storage_format_guide
  - icon: ⚡
    title: "Phase 2: Host-Driven Async Scheduler"
    details: "Bridging C++ with asynchronous browser storage (IndexedDB). A 6-state cooperative state machine that avoids freezing the browser event loop."
    link: /phase2_async_scheduler_guide
  - icon: 🔄
    title: "Phase 3: Buffer Pool Manager"
    details: "Fixed-frame shared caching, scan-resistant Clock replacement, pin token lifecycles, and generation-aware dirty page flushing."
    link: /phase3_buffer_pool_guide
---
