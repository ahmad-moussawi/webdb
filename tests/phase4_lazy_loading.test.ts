import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  WebDB as SlimWebDB,
  BufferPoolDriver,
  createWasmMemory,
  createVmContext,
  resetVmContext,
  OpCode,
  VmStatus,
} from "@ahmadmoussawi/webdb/slim";
import { createJsEngine } from "@ahmadmoussawi/webdb/core/js";
import { createWasmEngine } from "@ahmadmoussawi/webdb/core/wasm";
import { MemoryVfsAdapter } from "@ahmadmoussawi/webdb/storage/memory";
import { IndexedDbVfsAdapter } from "@ahmadmoussawi/webdb/storage/idb";
import { OpfsVfsAdapter } from "@ahmadmoussawi/webdb/storage/opfs";
import { getWebDbCoreWasmBytes } from "@ahmadmoussawi/webdb";
import * as vmHost from "../src/core/js/vm_host.ts";
import * as vmHelpers from "../src/core/js/vm.helpers.c.ts";

describe("Phase 4 — On-Demand Lazy Engines & VFS Adapters", () => {
  it("runs queries via @ahmadmoussawi/webdb/slim with explicit JS engine + MemoryVfsAdapter", async () => {
    const db = await SlimWebDB.open({
      name: "phase4_explicit_js",
      vfs: new MemoryVfsAdapter(),
      engine: createJsEngine(),
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

  it("runs queries via @ahmadmoussawi/webdb/slim with explicit WASM engine (embedded, wasmBinary, and wasmUrl Response)", async () => {
    const rawBytes = getWebDbCoreWasmBytes();

    const configs = [
      { name: "phase4_wasm_default", engine: createWasmEngine() },
      {
        name: "phase4_wasm_binary",
        engine: createWasmEngine({ wasmBinary: rawBytes }),
      },
      {
        name: "phase4_wasm_response",
        engine: createWasmEngine({
          wasmUrl: new Response(rawBytes as unknown as BodyInit, {
            status: 200,
            headers: { "Content-Type": "application/wasm" },
          }),
        }),
      },
    ];

    for (const cfg of configs) {
      const db = await SlimWebDB.open({
        name: cfg.name,
        vfs: new MemoryVfsAdapter(),
        engine: cfg.engine,
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

  it("supports WebDB.open({ wasmUrl }) inferring WASM mode without explicit core: 'wasm'", async () => {
    const rawBytes = getWebDbCoreWasmBytes();
    const db = await SlimWebDB.open({
      name: "phase4_open_wasm_url",
      storage: "memory",
      wasmUrl: Promise.resolve(
        new Response(rawBytes as unknown as BodyInit, {
          status: 200,
          headers: { "Content-Type": "application/wasm" },
        }),
      ),
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
    const baseEngine = createWasmEngine({ wasmBinary: getWebDbCoreWasmBytes() });
    let stepCalls = 0;
    const db = await SlimWebDB.open({
      name: "phase4_custom_wrapped_wasm",
      vfs: new MemoryVfsAdapter(),
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
      vfs: new MemoryVfsAdapter(),
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

  it("exposes all VFS adapter subpath classes cleanly", () => {
    expect(typeof MemoryVfsAdapter).toBe("function");
    expect(typeof IndexedDbVfsAdapter).toBe("function");
    expect(typeof OpfsVfsAdapter).toBe("function");
  });

  it("keeps all VM_* layout constants in sync between vm_host.ts and vm.helpers.c.ts", () => {
    const vmConstKeys = Object.keys(vmHost).filter((k) => k.startsWith("VM_"));
    expect(vmConstKeys.length).toBeGreaterThanOrEqual(55);
    for (const key of vmConstKeys) {
      expect((vmHost as any)[key], `Mismatch for ${key}`).toBe((vmHelpers as any)[key]);
    }
  });

  it("keeps dist/slim.js, dist/core-wasm.js, and dist/**/*.d.ts clean when built", () => {
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
    // slim.js must not dynamically reference the monolithic core/index barrel either
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
