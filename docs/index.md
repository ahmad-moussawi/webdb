---
layout: home

hero:
  name: "WebDB"
  text: "Ultra-Lean Browser Relational Database"
  tagline: "4KB Slotted Pages • VDBE Bytecode VM • Dual OPFS & IndexedDB • SQLite 3VL Semantics • ~150 KB Wasm"
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: Strategic Roadmap
      link: /plans/plan
    - theme: alt
      text: Prototype Spec
      link: /plans/prototype

features:
  - title: 4KB Slotted Page Engine
    details: Direct binary-level page layout with bottom-up payload packing, top-down slot directories, and dynamic null-bitmaps.
  - title: Bytecode Virtual Machine (VDBE)
    details: Eliminates the call-stack trap on async disk misses without Asyncify overhead. Non-recursive, interruptible single-stack execution.
  - title: Dual First-Class Storage Backends
    details: Unified IVfsAdapter providing bare-metal OPFS sync handles in workers and universal IndexedDB persistence across all browser contexts.
  - title: Multi-Tab Safety & Auto-Failover
    details: Coordinates multi-tab access using SharedWorker and Web Locks (navigator.locks) leader election with sub-5ms failover.
  - title: SQLite-Compatible 3VL NULL Semantics
    details: Battle-tested Three-Valued Logic for comparisons, distinctness operators, unique constraints, and B-Tree collation ordering.
  - title: Two-Phase Zero-Friction Port
    details: V1 written in strict C-style JavaScript; V2 drops in compiled freestanding C/Wasm with 0 host orchestration changes.
---
