import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  WebDB,
  BufferPoolDriver,
  createWasmMemory,
  createVmContext,
  resetVmContext,
  OpCode,
  VmStatus,
  getWebDbCoreWasmBytes,
} from "@ahmadmoussawi/webdb/slim";
import { WasmEngine } from "@ahmadmoussawi/webdb/core/wasm";
import { JsEngine } from "@ahmadmoussawi/webdb/core/js";
import { MemoryStorage } from "@ahmadmoussawi/webdb/storage/memory";
import { IdbStorage } from "@ahmadmoussawi/webdb/storage/idb";
import { OpfsStorage } from "@ahmadmoussawi/webdb/storage/opfs";
import { getWebDbCoreWasmBytes as rootGetWasmBytes } from "@ahmadmoussawi/webdb";
import * as vmHost from "../src/core/js/vm_host.ts";
import * as vmHelpers from "../src/core/js/vm.helpers.c.ts";

describe("Phase 4 — Explicit Engine & Storage Classes and Subpath Tree-Shaking", () => {
  it("runs queries with explicit JsEngine + MemoryStorage without needing options.name", async () => {
    const db = await WebDB.open({
      storage: new MemoryStorage(),
      engine: new JsEngine(),
      crossTabSync: false,
    });
    expect(db.coreMode).toBe("js");
    expect(db.wasmCore).toBeUndefined();

    await db.createTable("items", [
      { name: "id", type: "INT32", primaryKey: true },
      { name: "label", type: "TEXT" },
      { name: "price", type: "FLOAT64" },
    ]);
    await db.insertMany("items", [
      { id: 1, label: "apple", price: 1.5 },
      { id: 2, label: "apricot", price: 2.25 },
      { id: 3, label: "banana", price: 0.75 },
    ]);

    const rows = await db
      .from("items")
      .where("label", "like", "ap%")
      .orderBy("price", "desc")
      .toArray();

    expect(rows).toEqual([
      { id: 2, label: "apricot", price: 2.25 },
      { id: 1, label: "apple", price: 1.5 },
    ]);
    await db.close();
  });

  it("runs queries with explicit WasmEngine (zero-arg embedded, wasmBinary, and wasmUrl Response)", async () => {
    const rawBytes = rootGetWasmBytes();

    const engines = [
      new WasmEngine(),
      new WasmEngine({ wasmBinary: rawBytes }),
      new WasmEngine({
        wasmUrl: new Response(rawBytes as unknown as BodyInit, {
          status: 200,
          headers: { "Content-Type": "application/wasm" },
        }),
      }),
    ];

    for (const engine of engines) {
      const db = await WebDB.open({
        storage: new MemoryStorage(),
        engine,
        crossTabSync: false,
      });
      expect(db.coreMode).toBe("wasm");
      expect(db.wasmCore).toBeDefined();

      await db.createTable("metrics", [
        { name: "id", type: "INT32", primaryKey: true },
        { name: "val", type: "INT32" },
      ]);
      await db.insertMany("metrics", [
        { id: 1, val: 10 },
        { id: 2, val: 25 },
        { id: 3, val: 5 },
      ]);

      const rows = await db
        .from("metrics")
        .where("val", ">=", 10)
        .orderBy("val", "asc")
        .toArray();

      expect(rows).toEqual([
        { id: 1, val: 10 },
        { id: 2, val: 25 },
      ]);
      await db.close();
    }
  });

  it("supports Promise<Response> in WasmEngine({ wasmUrl })", async () => {
    const rawBytes = rootGetWasmBytes();
    const db = await WebDB.open({
      storage: new MemoryStorage(),
      engine: new WasmEngine({
        wasmUrl: Promise.resolve(
          new Response(rawBytes as unknown as BodyInit, {
            status: 200,
            headers: { "Content-Type": "application/wasm" },
          }),
        ),
      }),
      crossTabSync: false,
    });
    expect(db.coreMode).toBe("wasm");
    expect(db.wasmCore).toBeDefined();

    await db.createTable("t", [{ name: "id", type: "INT32", primaryKey: true }]);
    await db.insert("t", { id: 7 });
    expect(await db.from("t").toArray()).toEqual([{ id: 7 }]);
    await db.close();
  });

  it("invokes custom engine.init().vm_step even when wasmCore is also returned", async () => {
    const baseEngine = new WasmEngine({ wasmBinary: rootGetWasmBytes() });
    let stepCalls = 0;
    const db = await WebDB.open({
      storage: new MemoryStorage(),
      engine: {
        mode: "wasm",
        async init(memory) {
          const res = await baseEngine.init(memory);
          return {
            wasmCore: res.wasmCore,
            vm_step: (ctx, view, bytecode) => {
              stepCalls++;
              return res.vm_step(ctx, view, bytecode);
            },
          };
        },
      },
      crossTabSync: false,
    });

    await db.createTable("t", [{ name: "id", type: "INT32", primaryKey: true }]);
    await db.insert("t", { id: 1 });
    expect(await db.from("t").toArray()).toEqual([{ id: 1 }]);
    expect(stepCalls).toBeGreaterThan(0);
    await db.close();
  });

  it("caches the lazy-loaded WASM runner across repeated BufferPoolDriver.stepVm calls", async () => {
    const driver = new BufferPoolDriver({
      vfs: new MemoryStorage(),
      memory: createWasmMemory(),
    });
    const haltBytecode = new Uint8Array([OpCode.OP_HALT]);
    const prevEnv = process.env.WEBDB_CORE;
    const prevGlobal = (globalThis as any).__WEBDB_DEFAULT_CORE__;
    const instantiateSpy = vi.spyOn(WebAssembly, "instantiate");

    try {
      process.env.WEBDB_CORE = "wasm";
      const ctx = createVmContext();

      // Concurrent + sequential calls must share a single WASM instantiation
      const [s1, s2] = await Promise.all([
        driver.stepVm(ctx, haltBytecode),
        driver.stepVm(createVmContext(), haltBytecode),
      ]);
      resetVmContext(ctx);
      const s3 = await driver.stepVm(ctx, haltBytecode);

      expect(s1).toBe(VmStatus.DONE);
      expect(s2).toBe(VmStatus.DONE);
      expect(s3).toBe(VmStatus.DONE);
      expect(instantiateSpy).toHaveBeenCalledTimes(1);
    } finally {
      instantiateSpy.mockRestore();
      if (prevEnv === undefined) {
        delete process.env.WEBDB_CORE;
      } else {
        process.env.WEBDB_CORE = prevEnv;
      }
      (globalThis as any).__WEBDB_DEFAULT_CORE__ = prevGlobal;
    }
  });

  it("exposes storage subpath classes cleanly, derives cross-tab ids from databaseName, and validates required options", async () => {
    expect(typeof MemoryStorage).toBe("function");
    expect(typeof IdbStorage).toBe("function");
    expect(typeof OpfsStorage).toBe("function");
    expect(new IdbStorage("crm_app").databaseName).toBe("crm_app");
    expect(new OpfsStorage("analytics_db").databaseName).toBe("analytics_db");

    // 1. Named persistent-like storage derives crossTabLockName and BroadcastChannel from databaseName
    const backing = new MemoryStorage();
    const namedIdbLikeStorage = {
      name: "idb",
      databaseName: "shared_crm",
      isSynchronous: false,
      readPages: backing.readPages.bind(backing),
      writePages: backing.writePages.bind(backing),
      truncate: backing.truncate.bind(backing),
      readWalHeader: backing.readWalHeader.bind(backing),
      writeWalHeader: backing.writeWalHeader.bind(backing),
      readWalFrames: backing.readWalFrames.bind(backing),
      appendWalFrames: backing.appendWalFrames.bind(backing),
      truncateWal: backing.truncateWal.bind(backing),
      getWalFrameCount: backing.getWalFrameCount.bind(backing),
    };

    const derivedDb = await WebDB.open({
      storage: namedIdbLikeStorage,
      engine: new JsEngine(),
    });
    expect((derivedDb.coordinator.leaseQueue as any).crossTabLockName).toBe(
      "webdb_lock_idb_shared_crm",
    );
    if (typeof BroadcastChannel !== "undefined") {
      expect((derivedDb as any).broadcastChannel?.name).toBe(
        "webdb_sync_idb_shared_crm",
      );
    }
    await derivedDb.close();

    // 2. Explicit `options.name` overrides `storage.databaseName` when provided
    const overrideDb = await WebDB.open({
      name: "custom_lock_id",
      storage: namedIdbLikeStorage,
      engine: new JsEngine(),
    });
    expect((overrideDb.coordinator.leaseQueue as any).crossTabLockName).toBe(
      "webdb_lock_idb_custom_lock_id",
    );
    await overrideDb.close();

    // 3. Omitting `storage` or `engine` at runtime throws TypeError
    await expect(
      WebDB.open({ engine: new JsEngine() } as any),
    ).rejects.toThrow(TypeError);
    await expect(
      WebDB.open({ storage: new MemoryStorage() } as any),
    ).rejects.toThrow(TypeError);
  });

  it("keeps all VM_* layout constants in sync between vm_host.ts and vm.helpers.c.ts", () => {
    const vmConstKeys = Object.keys(vmHost).filter((k) => k.startsWith("VM_"));
    expect(vmConstKeys.length).toBeGreaterThanOrEqual(55);
    for (const key of vmConstKeys) {
      expect((vmHost as any)[key], `Mismatch for ${key}`).toBe((vmHelpers as any)[key]);
    }
  });

  it("keeps dist/slim.js, dist/core-wasm.js, dist/core-js.js, and dist/**/*.d.ts clean when built", () => {
    const distDir = path.resolve(process.cwd(), "dist");
    const slimPath = path.join(distDir, "slim.js");
    const coreWasmPath = path.join(distDir, "core-wasm.js");
    const coreJsPath = path.join(distDir, "core-js.js");

    if (!fs.existsSync(slimPath)) {
      return; // Skip when running tests prior to `npm run build`
    }

    const extractStaticImports = (code: string): string[] => {
      const matches = code.matchAll(/^import\s+[^;]*?from\s*["']([^"']+)["'];?/gm);
      return Array.from(matches, (m) => m[1]);
    };

    const slimCode = fs.readFileSync(slimPath, "utf-8");
    const slimStatic = extractStaticImports(slimCode);
    for (const specifier of slimStatic) {
      expect(specifier).not.toMatch(/vm\.c|embedded_wasm|wasm_runtime|wasm_core|storage-(idb|opfs|memory)/);
    }
    expect(slimCode).not.toMatch(/chunks\/index-[A-Za-z0-9_-]+\.js/);

    if (fs.existsSync(coreWasmPath)) {
      const wasmStatic = extractStaticImports(fs.readFileSync(coreWasmPath, "utf-8"));
      for (const specifier of wasmStatic) {
        expect(specifier).not.toMatch(/vm\.c|embedded_wasm|storage-(idb|opfs|memory)/);
      }
    }

    if (fs.existsSync(coreJsPath)) {
      const jsStatic = extractStaticImports(fs.readFileSync(coreJsPath, "utf-8"));
      for (const specifier of jsStatic) {
        expect(specifier).not.toMatch(/wasm|storage-(idb|opfs|memory)/);
      }
    }

    // Verify published .d.ts files contain zero raw relative .ts specifiers
    const walkDts = (dir: string): string[] => {
      const files: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...walkDts(full));
        else if (entry.name.endsWith(".d.ts")) files.push(full);
      }
      return files;
    };
    for (const dtsFile of walkDts(distDir)) {
      const text = fs.readFileSync(dtsFile, "utf-8");
      expect(
        text,
        `Found raw .ts specifier in published declaration ${path.relative(distDir, dtsFile)}`,
      ).not.toMatch(/(?:from|import)\s*\(?\s*['"]\.\.?\/[^'"]+\.ts['"]/);
    }
  });
});
