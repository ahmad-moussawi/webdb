import { CliUsageError, hasHelpFlag, type FlagDef } from './args.js';
import {
  CHECKPOINT_FLAG_DEFS,
  COMPACT_FLAG_DEFS,
  DUMP_FLAG_DEFS,
  EXPLAIN_FLAG_DEFS,
  INDEXES_FLAG_DEFS,
  INFO_FLAG_DEFS,
  PAGE_FLAG_DEFS,
  QUERY_FLAG_DEFS,
  RECOVER_FLAG_DEFS,
  SCHEMA_FLAG_DEFS,
  TABLES_FLAG_DEFS,
  VERIFY_FLAG_DEFS,
  cmdCheckpoint,
  cmdCompact,
  cmdDump,
  cmdExplain,
  cmdIndexes,
  cmdInfo,
  cmdPage,
  cmdQuery,
  cmdRecover,
  cmdSchema,
  cmdTables,
  cmdVerify,
  type CliIo,
} from './commands.js';
import type { CoreMode } from './open.js';

export type { CliIo, CoreMode };
export { NodeFsStorage, type NodeFsStorageOptions } from '../host/storage/node_fs.js';
export {
  buildRecoverySchemaTemplate,
  extractRecoverySchemaFromTables,
  inspectDatabaseStructure,
  parseRecoverySchemaJson,
  recoverDatabaseBuffer,
  type RecoverOptions,
  type RecoveryColumnSchema,
  type RecoveryIndexSchema,
  type RecoveryReport,
  type RecoverySchemaMap,
  type RecoveryTableSchema,
  type StructuralCheckResult,
  type TableRecoverySummary,
} from './recover.js';

declare const __WEBDB_CLI_VERSION__: string | undefined;

export const CLI_VERSION: string =
  typeof __WEBDB_CLI_VERSION__ !== 'undefined' ? __WEBDB_CLI_VERSION__ : '0.8.0';

export const HELP_TEXT = `webdb v${CLI_VERSION} — Inspect and query WebDB database files without writing JS

Usage:
  webdb [--core wasm|js] <command> [arguments] [options]

Commands:
  info <file>                         Show file header, WAL status, and page breakdown
  tables <file>                       List all tables in the database
  schema <file> [table]               Inspect column definitions and indexes
  indexes <file> [table]              List all indexes (or indexes for a table)
  query <file> <table> [options]      Query rows using WebDB expressions
  explain <file> <table> [options]    Show query plan and VDBE bytecode disassembly
  page <file> <pageId> [options]      Inspect a raw 4 KB page (--rows, --hex, --raw)
  verify <file>                       Verify Page 1, checksums, structure, and WAL
  recover <file> --out <out> [opts]   Deterministically recover a damaged .db file
  compact <file> [options]            Repack fragmented pages and shrink .db file
  dump <file> [table] [options]       Export table or full database (json, ndjson, csv)
  checkpoint <file>                   Replay WAL frames into main .db file (writes to disk)

Query / Explain Options:
  -s, --select <expr>                 Comma-separated columns/expressions (repeatable)
  -w, --where <expr>                  Filter expression, AND-ed (repeatable)
      --or-where <expr>               Filter expression, OR-ed (repeatable)
      --join <table>:<l>=<r>          INNER JOIN specification (repeatable)
      --left-join <table>:<l>=<r>     LEFT JOIN specification (repeatable)
  -g, --group-by <cols>               GROUP BY columns/expressions (repeatable)
      --having <expr>                 HAVING filter expression (repeatable)
  -o, --order <col[:asc|desc]>        ORDER BY clause (repeatable, e.g. "score desc")
  -l, --limit <n>                     Maximum rows to return
      --offset <n>                    Number of rows to skip
      --count                         Return only the matching row count (query only)
  -f, --format <fmt>                  Output format: table | json | ndjson | csv

Global Options:
      --core <wasm|js>                Execution engine core (default: wasm)
  -h, --help                          Show this help message
  -v, --version                       Show CLI version

Examples:
  webdb info app.db
  webdb tables app.db --exact-count
  webdb schema app.db users
  webdb schema app.db --recovery --out schema.json
  webdb query app.db users -s "name, score * 2 as doubled" -w "age >= 21" -o "score desc" -l 10
  webdb explain app.db users -w "score > 80"
  webdb page app.db 2 --rows --hex
  webdb verify app.db
  webdb recover damaged.db --out recovered.db --schema-from healthy.db
  webdb compact app.db --out app.compacted.db
  webdb dump app.db users --format csv --out users.csv
`;

interface CommandSpec {
  handler: (argv: string[], ctx: { core: CoreMode; io: CliIo }) => Promise<number>;
  flags: FlagDef[];
}

const COMMANDS: Record<string, CommandSpec> = {
  info: { handler: cmdInfo, flags: INFO_FLAG_DEFS },
  tables: { handler: cmdTables, flags: TABLES_FLAG_DEFS },
  schema: { handler: cmdSchema, flags: SCHEMA_FLAG_DEFS },
  indexes: { handler: cmdIndexes, flags: INDEXES_FLAG_DEFS },
  query: { handler: cmdQuery, flags: QUERY_FLAG_DEFS },
  explain: { handler: cmdExplain, flags: EXPLAIN_FLAG_DEFS },
  page: { handler: cmdPage, flags: PAGE_FLAG_DEFS },
  verify: { handler: cmdVerify, flags: VERIFY_FLAG_DEFS },
  recover: { handler: cmdRecover, flags: RECOVER_FLAG_DEFS },
  compact: { handler: cmdCompact, flags: COMPACT_FLAG_DEFS },
  dump: { handler: cmdDump, flags: DUMP_FLAG_DEFS },
  checkpoint: { handler: cmdCheckpoint, flags: CHECKPOINT_FLAG_DEFS },
};

function defaultIo(): CliIo {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}

export async function runCli(argv: string[], io: CliIo = defaultIo()): Promise<number> {
  let core: CoreMode = 'wasm';
  const remaining: string[] = [];

  // Extract global --core option that may appear before or after the command (but not after `--`)
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      remaining.push(...argv.slice(i));
      break;
    }
    if (arg === '--core') {
      if (i + 1 >= argv.length) {
        io.stderr('Error: --core requires a value ("wasm" or "js")\n');
        return 2;
      }
      const val = argv[++i].toLowerCase();
      if (val !== 'wasm' && val !== 'js') {
        io.stderr(`Error: Invalid --core "${val}". Expected "wasm" or "js".\n`);
        return 2;
      }
      core = val;
      continue;
    }
    if (arg.startsWith('--core=')) {
      const val = arg.slice('--core='.length).toLowerCase();
      if (val !== 'wasm' && val !== 'js') {
        io.stderr(`Error: Invalid --core "${val}". Expected "wasm" or "js".\n`);
        return 2;
      }
      core = val;
      continue;
    }
    remaining.push(arg);
  }

  if (
    remaining.length === 0 ||
    remaining[0] === '-h' ||
    remaining[0] === '--help' ||
    remaining[0] === 'help'
  ) {
    io.stdout(HELP_TEXT);
    return 0;
  }

  if (remaining[0] === '-v' || remaining[0] === '--version') {
    io.stdout(`webdb ${CLI_VERSION}\n`);
    return 0;
  }

  const command = remaining[0];
  const rest = remaining.slice(1);

  const spec = COMMANDS[command];
  if (!spec) {
    io.stderr(`Unknown command: "${command}"\nRun "webdb --help" to see available commands.\n`);
    return 2;
  }

  if (hasHelpFlag(rest, spec.flags)) {
    io.stdout(HELP_TEXT);
    return 0;
  }

  try {
    return await spec.handler(rest, { core, io });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    io.stderr(`Error: ${message}\n`);
    return err instanceof CliUsageError ? 2 : 1;
  }
}
