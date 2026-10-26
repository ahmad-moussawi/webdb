import fs from 'fs';
import path from 'path';
import { TsToCTranspiler } from './transpiler.ts';

const CORE_JS_DIR = path.resolve('src/core/js');
const CORE_C_DIR = path.resolve('src/core/c');

export function transpileFile(fileName: string, writeToDisk: boolean = false): { cSource: string; hHeader: string } {
  let filePath = fileName;
  if (!fs.existsSync(filePath)) {
    filePath = path.join(CORE_JS_DIR, fileName);
  }
  if (!fs.existsSync(filePath)) {
    filePath = path.resolve(fileName);
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`Source file not found: ${fileName} (tried ${filePath})`);
  }

  const baseFileName = path.basename(filePath);
  const tsCode = fs.readFileSync(filePath, 'utf-8');
  if (tsCode.includes('@manual_file') || (!tsCode.includes('@export_c') && !tsCode.includes('@manual_c'))) {
    console.log(`- Skipped ${fileName} (no @export_c / manual module)`);
    return { cSource: '', hHeader: '', hasExports: false };
  }

  const baseName = baseFileName.replace(/\.c\.ts$/, '').replace(/\.ts$/, '').replace(/\./g, '_');
  const companionPath = path.join(CORE_C_DIR, `${baseName}.manual.c`);
  const companionFile = fs.existsSync(companionPath) ? `${baseName}.manual.c` : undefined;

  const transpiler = new TsToCTranspiler({ companionFile });
  const result = transpiler.transpile(tsCode, baseFileName);

  if (writeToDisk) {
    if (!result.hasExports) {
      console.log(`- Skipped ${fileName} (no exported functions)`);
      return result;
    }
    const baseName = baseFileName.replace(/\.c\.ts$/, '').replace(/\.ts$/, '').replace(/\./g, '_');
    const cOutPath = path.join(CORE_C_DIR, `${baseName}.c`);
    const hOutPath = path.join(CORE_C_DIR, `${baseName}.h`);

    fs.writeFileSync(cOutPath, result.cSource, 'utf-8');
    fs.writeFileSync(hOutPath, result.hHeader, 'utf-8');
    console.log(`✓ Transpiled ${fileName} -> ${path.relative(process.cwd(), cOutPath)} & ${path.relative(process.cwd(), hOutPath)}`);
  }

  return result;
}

export function transpileAll(writeToDisk: boolean = false): void {
  const files = fs.readdirSync(CORE_JS_DIR).filter((f) => f.endsWith('.c.ts'));
  console.log(`Transpiling ${files.length} core files...`);
  for (const file of files) {
    try {
      transpileFile(file, writeToDisk);
    } catch (e: any) {
      console.error(`✗ Error transpiling ${file}:`, e.message);
    }
  }
}

// CLI execution
const args = process.argv.slice(2);
const shouldWrite = args.includes('--write');
const isAll = args.includes('--all');
const fileArg = args.find((a) => !a.startsWith('--')) ?? 'page_table.c.ts';

if (isAll) {
  transpileAll(shouldWrite);
} else {
  console.log(`Transpiling ${fileArg} (write: ${shouldWrite})...`);
  const res = transpileFile(fileArg, shouldWrite);
  if (!shouldWrite) {
    console.log('\n=== GENERATED C SOURCE ===\n');
    console.log(res.cSource);
    console.log('\n=== GENERATED C HEADER ===\n');
    console.log(res.hHeader);
  }
}
