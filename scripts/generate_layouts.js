#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const schemasDir = path.join(rootDir, "src", "layouts", "schemas");
const layoutsDir = path.join(rootDir, "src", "layouts");

function formatDoc(description) {
  if (!description) return "";
  const lines = description.split("\n");
  if (lines.length === 1) {
    return `/**\n * ${lines[0]}\n */\n`;
  }
  return `/**\n${lines.map((l) => (l ? ` * ${l}` : " *")).join("\n")}\n */\n`;
}

function formatWarning(lines) {
  if (!lines || lines.length === 0) return "";
  const bar = "=".repeat(76);
  const formatted = lines
    .map((l) => (l ? ` * ${l}` : " *"))
    .join("\n");
  return `/**\n * ${bar}\n${formatted}\n * ${bar}\n */\n\n`;
}

function cleanDescriptionForTable(desc, maxLen = 46) {
  if (!desc) return "";
  let firstLine = desc.split("\n")[0].trim();
  firstLine = firstLine.replace(/`([^`]+)`/g, "$1");
  firstLine = firstLine.replace(/^(Byte offset \d+.*?:|\d+\.\.\d+:)\s*/i, "");
  firstLine = firstLine.trim();
  if (firstLine.length > maxLen) {
    return firstLine.substring(0, maxLen - 3) + "...";
  }
  return firstLine;
}

function renderAsciiTable(headers, rows, summaryLine = "") {
  const colWidths = headers.map((h, i) => {
    let max = h.length;
    for (const r of rows) {
      if (r[i] && r[i].length > max) max = r[i].length;
    }
    return max;
  });

  const sep = "+-" + colWidths.map((w) => "-".repeat(w)).join("-+-") + "-+";
  const formatRow = (r) =>
    "| " + r.map((c, i) => (c || "").padEnd(colWidths[i])).join(" | ") + " |";

  const totalInnerWidth =
    colWidths.reduce((sum, w) => sum + w, 0) + (colWidths.length - 1) * 3;

  const lines = [
    sep,
    formatRow(headers),
    sep,
    ...rows.map(formatRow),
    sep,
  ];

  if (summaryLine) {
    lines.push(
      `| ${summaryLine.padEnd(totalInnerWidth)} |`,
      `+-` + "-".repeat(totalInnerWidth) + `-+`,
    );
  }

  return lines.map((line) => ` * ${line}`).join("\n");
}

/**
 * Generates an RFC-style 32-bit (4-byte word) proportional byte grid diagram.
 * 1 byte = 1 slot, 2 bytes = 2 slots, 4 bytes = full row.
 */
function renderRfcByteGrid(fields) {
  const BYTE_WIDTH = 15;
  let totalBytes = 0;
  for (const f of fields) totalBytes += f.size;

  const byteMap = [];
  let curr = 0;
  for (const f of fields) {
    for (let b = 0; b < f.size; b++) {
      byteMap.push({ field: f, byteIndexInField: b, globalOffset: curr });
      curr++;
    }
  }

  const lines = [];
  const colHeader = "  " + ["Byte 0", "Byte 1", "Byte 2", "Byte 3"]
    .map((h) => h.padEnd(BYTE_WIDTH))
    .join("  ");
  lines.push(colHeader);

  const fullInnerWidth = 4 * BYTE_WIDTH + 3 * 3;
  const topBorder =
    "+-" +
    [
      "-".repeat(BYTE_WIDTH),
      "-".repeat(BYTE_WIDTH),
      "-".repeat(BYTE_WIDTH),
      "-".repeat(BYTE_WIDTH),
    ].join("-+-") +
    "-+";
  lines.push(topBorder);

  let byteIdx = 0;
  while (byteIdx < totalBytes) {
    const rowStart = byteIdx;
    const rowEnd = Math.min(byteIdx + 4, totalBytes);
    const rowLen = rowEnd - rowStart;

    const currentField = byteMap[byteIdx].field;
    // Collapse fields >= 8 bytes that start at a 4-byte boundary
    if (currentField.size >= 8 && byteMap[byteIdx].byteIndexInField === 0 && rowStart % 4 === 0) {
      const fieldBytes = currentField.size;
      const typeStr = currentField.type ? ` (${currentField.type})` : "";
      const label = `Bytes ${byteIdx}..${byteIdx + fieldBytes - 1} (${fieldBytes}B): ${currentField.name}${typeStr}`;
      lines.push("| " + label.padEnd(fullInnerWidth) + " |");
      lines.push("+-" + "-".repeat(fullInnerWidth) + "-+");
      byteIdx += fieldBytes;
      continue;
    }

    const segments = [];
    let segStart = 0;
    while (segStart < rowLen) {
      const f = byteMap[rowStart + segStart].field;
      let segEnd = segStart + 1;
      while (segEnd < rowLen && byteMap[rowStart + segEnd].field === f) {
        segEnd++;
      }
      segments.push({
        field: f,
        startCol: segStart,
        endCol: segEnd - 1,
        count: segEnd - segStart,
      });
      segStart = segEnd;
    }

    const cellStrings = segments.map((seg) => {
      const width = seg.count * BYTE_WIDTH + (seg.count - 1) * 3;
      let text = seg.field.name;
      if (seg.field.size > seg.count) {
        const b0 = byteMap[rowStart + seg.startCol].byteIndexInField;
        const b1 = byteMap[rowStart + seg.endCol].byteIndexInField;
        text += ` [${b0}..${b1}]`;
      } else {
        text += ` (${seg.field.size}B)`;
      }
      return text.padEnd(width);
    });

    lines.push("| " + cellStrings.join(" | ") + " |");

    let borderLine = "+";
    for (const seg of segments) {
      const segWidth = seg.count * BYTE_WIDTH + (seg.count - 1) * 3;
      borderLine += "-".repeat(segWidth + 2) + "+";
    }
    lines.push(borderLine);

    byteIdx += rowLen;
  }

  return lines.map((line) => ` * ${line}`).join("\n");
}

function generatePageFormat() {
  const schemaPath = path.join(schemasDir, "page_format.json");
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));

  let out = `/**
 * AUTO-GENERATED AT BUILD TIME FROM src/layouts/schemas/page_format.json
 * DO NOT EDIT MANUALLY. Run 'npm run generate:layouts' to rebuild.
 */

`;

  if (schema.criticalWarning) {
    out += formatWarning(schema.criticalWarning);
  }

  for (const c of schema.constants) {
    out += formatDoc(c.description);
    out += `export const ${c.name} = ${c.value};\n\n`;
  }

  for (let i = 0; i < schema.layouts.length; i++) {
    const layout = schema.layouts[i];
    out += `// ${"=".repeat(76)}\n`;
    out += `// ${i + 1}. ${layout.id.replace(/_/g, " ")} Layout\n`;
    out += `// ${"=".repeat(76)}\n\n`;

    let currentOffset = layout.baseOffset;
    const computedOffsets = {};
    const tableRows = [];

    for (const f of layout.fields) {
      computedOffsets[f.name] = currentOffset;
      const offsetDisplay = `${currentOffset}`;
      const sizeDisplay = `${f.size}B`;
      const typeDisplay = f.type || "";
      const descDisplay = cleanDescriptionForTable(f.description);
      tableRows.push([offsetDisplay, sizeDisplay, f.name, typeDisplay, descDisplay]);
      currentOffset += f.size;
    }
    const totalSize = currentOffset - layout.baseOffset;

    const rfcGrid = renderRfcByteGrid(layout.fields);
    const asciiTable = renderAsciiTable(
      ["Offset", "Size", "Field Name", "Type", "Description"],
      tableRows,
      `Total: ${totalSize} Bytes`,
    );

    out += `/**\n * 32-bit Word Byte Layout Grid for ${layout.id}:\n${rfcGrid}\n *\n * Field Details:\n${asciiTable}\n */\n`;
    out += formatDoc(layout.fieldsDescription);
    out += `export const ${layout.fieldsName} = [\n`;
    for (const f of layout.fields) {
      out += `  ["${f.name}", ${f.size}], // ${f.type || ""}\n`;
    }
    out += `] as const;\n\n`;

    out += formatDoc(layout.sizeDescription);
    out += `export const ${layout.sizeName} = ${totalSize};\n\n`;

    out += `// Offsets for ${layout.id}\n`;
    for (const f of layout.fields) {
      const offsetConstName = `${layout.offsetPrefix}${f.name}`;
      const offsetVal = computedOffsets[f.name];
      out += formatDoc(f.description);
      out += `export const ${offsetConstName} = ${offsetVal};\n\n`;
    }
  }

  if (schema.postConstants) {
    for (const c of schema.postConstants) {
      out += formatDoc(c.description);
      out += `export const ${c.name} = ${c.value};\n\n`;
    }
  }

  fs.writeFileSync(path.join(layoutsDir, "page_format.ts"), out);
  console.log("✓ Generated src/layouts/page_format.ts");
}

function generateSyspageFormat() {
  const schemaPath = path.join(schemasDir, "syspage_format.json");
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));

  let out = `/**
 * AUTO-GENERATED AT BUILD TIME FROM src/layouts/schemas/syspage_format.json
 * DO NOT EDIT MANUALLY. Run 'npm run generate:layouts' to rebuild.
 */

`;

  if (schema.criticalWarning) {
    out += formatWarning(schema.criticalWarning);
  }

  for (const c of schema.constants) {
    out += formatDoc(c.description);
    out += `export const ${c.name} = ${c.value};\n\n`;
  }

  for (let i = 0; i < schema.layouts.length; i++) {
    const layout = schema.layouts[i];
    out += `// ${"=".repeat(76)}\n`;
    out += `// ${i + 1}. ${layout.id.replace(/_/g, " ")} Layout\n`;
    out += `// ${"=".repeat(76)}\n\n`;

    let currentOffset = layout.baseOffset;
    const computedOffsets = {};
    const tableRows = [];

    for (const f of layout.fields) {
      computedOffsets[f.name] = currentOffset;
      const offsetDisplay = `${currentOffset}`;
      const sizeDisplay = `${f.size}B`;
      const typeDisplay = f.type || "";
      const descDisplay = cleanDescriptionForTable(f.description);
      tableRows.push([offsetDisplay, sizeDisplay, f.name, typeDisplay, descDisplay]);
      currentOffset += f.size;
    }
    const totalSize = currentOffset - layout.baseOffset;

    const rfcGrid = renderRfcByteGrid(layout.fields);
    const asciiTable = renderAsciiTable(
      ["Offset", "Size", "Field Name", "Type", "Description"],
      tableRows,
      `Total: ${totalSize} Bytes`,
    );

    out += `/**\n * 32-bit Word Byte Layout Grid for ${layout.id}:\n${rfcGrid}\n *\n * Field Details:\n${asciiTable}\n */\n`;
    out += formatDoc(layout.fieldsDescription);
    out += `export const ${layout.fieldsName} = [\n`;
    for (const f of layout.fields) {
      out += `  ["${f.name}", ${f.size}], // ${f.type || ""}\n`;
    }
    out += `] as const;\n\n`;

    out += formatDoc(layout.sizeDescription);
    out += `export const ${layout.sizeName} = ${totalSize};\n\n`;

    if (layout.offsetPrefix) {
      for (const f of layout.fields) {
        const offsetConstName = `${layout.offsetPrefix}${f.name}`;
        const offsetVal = computedOffsets[f.name];
        out += formatDoc(f.description);
        out += `export const ${offsetConstName} = ${offsetVal};\n\n`;
      }
    }

    if (i === 0 && schema.partitionConstants) {
      out += `// ${"=".repeat(76)}\n`;
      out += `// Page 1 & Catalog Space Partition Offsets and Limits\n`;
      out += `// ${"=".repeat(76)}\n\n`;

      const partitionRows = [
        ["0..99", "100B", "FILE_HEADER", "Database file header"],
        ["100..2147", "2048B", "MASTER_TABLE_CATALOG", "16 Table Descriptors (128B each)"],
        ["2148..3171", "1024B", "INDEX_CATALOG", "8 Index Descriptors (128B each)"],
        ["3172..3175", "4B", "NEXT_DESCRIPTOR_PAGE", "Chained descriptor page pointer"],
        ["3176..4095", "920B", "SYSPAGE_RESERVED", "Reserved space for Page 1 extensions"],
      ];
      const partitionTable = renderAsciiTable(
        ["Byte Range", "Size", "Partition Region", "Description"],
        partitionRows,
        "Total: 4096 Bytes (Full Page 1 Allocation)",
      );

      out += `/**\n * Page 1 Space Partition Map (4 KB Total):\n${partitionTable}\n */\n\n`;

      for (const c of schema.partitionConstants) {
        out += formatDoc(c.description);
        out += `export const ${c.name} = ${c.value};\n\n`;
      }
    }
  }

  fs.writeFileSync(path.join(layoutsDir, "syspage_format.ts"), out);
  console.log("✓ Generated src/layouts/syspage_format.ts");
}

function generatePoolFormat() {
  const schemaPath = path.join(schemasDir, "pool_format.json");
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));

  let out = `/**
 * AUTO-GENERATED AT BUILD TIME FROM src/layouts/schemas/pool_format.json
 * DO NOT EDIT MANUALLY. Run 'npm run generate:layouts' to rebuild.
 */

import { PAGE_SIZE } from "./page_format.js";

// ============================================================================
// Buffer Pool & Shared Memory Architecture Layout
// ============================================================================

`;

  for (const c of schema.constants) {
    out += formatDoc(c.description);
    out += `export const ${c.name} = ${c.value};\n\n`;
  }

  const bp = schema.bufferPool;
  let currentOffset = bp.baseOffset;
  const tableRows = [];

  for (const r of bp.regions) {
    const startHex = `0x${currentOffset.toString(16).toUpperCase()}`;
    const endHex = `0x${(currentOffset + r.size - 1).toString(16).toUpperCase()}`;
    const rangeDisplay = `${startHex}..${endHex}`;
    const sizeDisplay = `${r.size}B`;
    const descDisplay = cleanDescriptionForTable(r.description);
    tableRows.push([rangeDisplay, sizeDisplay, r.name, descDisplay]);
    currentOffset += r.size;
  }

  const asciiTable = renderAsciiTable(
    ["Memory Address Range", "Size", "Region Name", "Description"],
    tableRows,
    `Arena Start: 0x${currentOffset.toString(16).toUpperCase()} | Total Regions: ${currentOffset - bp.baseOffset} Bytes`,
  );

  out += `/**\n * Shared Memory Architecture Map (1024 Slots / 4MB Cache Default):\n${asciiTable}\n */\n`;
  out += `export const ${bp.regionsName} = [\n`;
  for (const r of bp.regions) {
    out += `  ["${r.name}", ${r.size}],\n`;
  }
  out += `] as const;\n\n`;

  currentOffset = bp.baseOffset;
  for (const r of bp.regions) {
    out += formatDoc(r.description);
    out += `export const ${r.offsetName} = ${currentOffset}; // 0x${currentOffset.toString(16).toUpperCase()}\n\n`;
    currentOffset += r.size;
  }

  out += formatDoc(bp.endOffsetDescription);
  out += `export const ${bp.endOffsetName} = ${currentOffset}; // 0x${currentOffset.toString(16).toUpperCase()}\n\n`;

  if (schema.postConstants) {
    for (const c of schema.postConstants) {
      out += formatDoc(c.description);
      out += `export const ${c.name} = ${c.value};\n\n`;
    }
  }

  // Dynamic computation function
  out += `/**
 * Computes memory layout offsets for arbitrary slot counts.
 */
export function computeBufferPoolOffsets(
  slotCount: number,
  _maxQueryMemory: number = DEFAULT_MAX_QUERY_MEMORY,
) {
  const slotsEndOffset = slotCount * PAGE_SIZE;
  const slotToPageBytes = (slotCount * 4 + 7) & ~7;
  let pageToSlotBuckets = 16;
  while (pageToSlotBuckets < slotCount * 2) {
    pageToSlotBuckets <<= 1;
  }
  const pageToSlotBytes = pageToSlotBuckets * 8;
  const dirtyMaskBytes = (Math.ceil(slotCount / 8) + 7) & ~7;

  if (slotCount === DEFAULT_SLOT_COUNT) {
    return {
      slotsEndOffset,
      slotToPageOffset: SLOT_TO_PAGE_OFFSET,
      pageToSlotOffset: PAGE_TO_SLOT_OFFSET,
      pageToSlotBuckets: DEFAULT_PAGE_TO_SLOT_BUCKETS,
      dirtyMaskOffset: DIRTY_MASK_OFFSET,
      vmContextOffset: VM_CONTEXT_OFFSET,
      resultBufferOffset: RESULT_BUFFER_OFFSET,
      bytecodeOffset: BYTECODE_OFFSET,
      pageScratchpadOffset: PAGE_SCRATCHPAD_OFFSET,
      transientArenaOffset: TRANSIENT_ARENA_OFFSET,
    };
  }

  const slotToPageOffset = slotsEndOffset;
  const pageToSlotOffset = slotToPageOffset + slotToPageBytes;
  const dirtyMaskOffset = pageToSlotOffset + pageToSlotBytes;
  const vmContextOffset = dirtyMaskOffset + dirtyMaskBytes;
  const resultBufferOffset = vmContextOffset + VM_CONTEXT_SIZE;
  const bytecodeOffset = resultBufferOffset + RESULT_BUFFER_SIZE;
  const pageScratchpadOffset = bytecodeOffset + BYTECODE_SIZE;
  const transientArenaOffset =
    pageScratchpadOffset + PAGE_SCRATCHPAD_SIZE + ALIGNMENT_PADDING_SIZE;

  return {
    slotsEndOffset,
    slotToPageOffset,
    pageToSlotOffset,
    pageToSlotBuckets,
    dirtyMaskOffset,
    vmContextOffset,
    resultBufferOffset,
    bytecodeOffset,
    pageScratchpadOffset,
    transientArenaOffset,
  };
}
`;

  fs.writeFileSync(path.join(layoutsDir, "pool_format.ts"), out);
  console.log("✓ Generated src/layouts/pool_format.ts");
}

function main() {
  console.log("Generating layout constant modules from JSON schemas...");
  generatePageFormat();
  generateSyspageFormat();
  generatePoolFormat();
  console.log("✓ All layout files successfully generated at build time.");
}

main();
