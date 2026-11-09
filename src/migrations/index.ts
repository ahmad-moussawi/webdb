import type { WebDB } from '@ahmadmoussawi/webdb';

export interface Migration {
  /** Numeric or alphanumeric version identifier (e.g. 1, 2, "20261109010000") */
  version: number | string;
  /** Descriptive name of the migration (e.g. "create_users_table") */
  name: string;
  /** Migration forward upgrade handler */
  up: (db: WebDB) => Promise<void>;
  /** Optional rollback handler */
  down?: (db: WebDB) => Promise<void>;
}

export interface MigrationRecord {
  version: string;
  name: string;
  applied_at: number;
  batch: number;
  duration_ms: number;
}

export type MigrationExecutionMode = 'atomic' | 'per-migration';

export interface MigratorOptions {
  /** Tracking table name. Defaults to `'_migrations'`. */
  tableName?: string;
  /** List of registered migrations */
  migrations?: Migration[];
  /**
   * Execution mode:
   * - `'atomic'` (default): all pending migrations run within a single ACID transaction.
   * - `'per-migration'`: each migration runs in its own individual transaction.
   */
  mode?: MigrationExecutionMode;
  /** Callback fired before a migration executes */
  onMigrationStart?: (
    migration: Migration,
    direction: 'up' | 'down',
  ) => void | Promise<void>;
  /** Callback fired after a migration completes successfully */
  onMigrationSuccess?: (
    migration: Migration,
    direction: 'up' | 'down',
    durationMs: number,
  ) => void | Promise<void>;
  /** Callback fired when a migration throws an error */
  onMigrationError?: (
    migration: Migration,
    direction: 'up' | 'down',
    error: unknown,
  ) => void | Promise<void>;
}

export interface MigrationItemStatus {
  version: string;
  name: string;
  applied: boolean;
  appliedAt?: number;
  batch?: number;
}

export interface MigrationStatus {
  applied: MigrationRecord[];
  pending: Migration[];
  all: MigrationItemStatus[];
}

export interface ExecutedMigration {
  version: string;
  name: string;
  direction: 'up' | 'down';
  durationMs: number;
}

export interface MigrationResult {
  executed: ExecutedMigration[];
  batch?: number;
}

export interface MigrateUpOptions {
  /** Maximum number of pending migrations to execute */
  step?: number;
}

export interface MigrateDownOptions {
  /**
   * Number of migrations to roll back. If omitted and `all` is not set,
   * rolls back the most recent batch.
   */
  step?: number;
  /** Roll back all applied migrations to step zero */
  all?: boolean;
}

export function normalizeVersion(v: number | string): string {
  return String(v).trim();
}

export function compareVersions(
  a: number | string,
  b: number | string,
): number {
  const strA = normalizeVersion(a);
  const strB = normalizeVersion(b);
  const numA = Number(strA);
  const numB = Number(strB);
  if (!Number.isNaN(numA) && !Number.isNaN(numB)) {
    return numA - numB;
  }
  return strA.localeCompare(strB, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

export class Migrator {
  private readonly db: WebDB;
  private readonly tableName: string;
  private readonly mode: 'atomic' | 'per-migration';
  private migrations: Migration[];
  private readonly onMigrationStart?: (
    migration: Migration,
    direction: 'up' | 'down',
  ) => void | Promise<void>;
  private readonly onMigrationSuccess?: (
    migration: Migration,
    direction: 'up' | 'down',
    durationMs: number,
  ) => void | Promise<void>;
  private readonly onMigrationError?: (
    migration: Migration,
    direction: 'up' | 'down',
    error: unknown,
  ) => void | Promise<void>;

  constructor(db: WebDB, options?: MigratorOptions) {
    this.db = db;
    this.tableName = options?.tableName ?? '_migrations';
    this.mode = options?.mode ?? 'atomic';
    this.migrations = [...(options?.migrations ?? [])];
    this.onMigrationStart = options?.onMigrationStart;
    this.onMigrationSuccess = options?.onMigrationSuccess;
    this.onMigrationError = options?.onMigrationError;
  }

  /**
   * Registers one or more migrations into the runner.
   */
  register(migrationOrList: Migration | Migration[]): this {
    const list = Array.isArray(migrationOrList)
      ? migrationOrList
      : [migrationOrList];
    this.migrations.push(...list);
    return this;
  }

  /**
   * Returns current sorted list of registered migrations.
   */
  getRegisteredMigrations(): Migration[] {
    return [...this.migrations].sort((a, b) =>
      compareVersions(a.version, b.version),
    );
  }

  /**
   * Ensures the migration history tracking table exists.
   */
  async ensureTrackingTable(tx: WebDB = this.db): Promise<void> {
    await tx.createTableIfNotExists(this.tableName, [
      { name: 'version', type: 'TEXT', flags: { primaryKey: true } },
      { name: 'name', type: 'TEXT', flags: { notNull: true } },
      { name: 'applied_at', type: 'INT64', flags: { notNull: true } },
      { name: 'batch', type: 'INT32', flags: { notNull: true } },
      { name: 'duration_ms', type: 'INT32', flags: { notNull: true } },
    ]);
  }

  /**
   * Fetches all applied migration records from the tracking table.
   */
  async getAppliedRecords(tx: WebDB = this.db): Promise<MigrationRecord[]> {
    const has = await tx.hasTable(this.tableName);
    if (!has) {
      return [];
    }

    const rows = await tx
      .from(this.tableName)
      .select('version', 'name', 'applied_at', 'batch', 'duration_ms')
      .toArray();

    return rows.map((r) => ({
      version: String(r.version),
      name: String(r.name),
      applied_at: Number(r.applied_at),
      batch: Number(r.batch),
      duration_ms: Number(r.duration_ms ?? 0),
    }));
  }

  /**
   * Returns complete status of applied and pending migrations.
   */
  async status(): Promise<MigrationStatus> {
    await this.ensureTrackingTable(this.db);
    const applied = await this.getAppliedRecords(this.db);
    const appliedMap = new Map<string, MigrationRecord>();
    for (const r of applied) {
      appliedMap.set(r.version, r);
    }

    const sorted = this.getRegisteredMigrations();
    const pending: Migration[] = [];
    const all: MigrationItemStatus[] = [];

    for (const m of sorted) {
      const vStr = normalizeVersion(m.version);
      const record = appliedMap.get(vStr);
      if (record) {
        all.push({
          version: vStr,
          name: m.name,
          applied: true,
          appliedAt: record.applied_at,
          batch: record.batch,
        });
      } else {
        pending.push(m);
        all.push({
          version: vStr,
          name: m.name,
          applied: false,
        });
      }
    }

    return { applied, pending, all };
  }

  /**
   * Executes pending migrations up to the latest registered version (or up to `step`).
   */
  async up(options?: MigrateUpOptions): Promise<MigrationResult> {
    if (this.mode === 'atomic') {
      return this.db.transaction(async (tx) => {
        return this.runUpInternal(tx, options);
      });
    }

    // per-migration mode
    await this.ensureTrackingTable(this.db);
    const executed: ExecutedMigration[] = [];
    const applied = await this.getAppliedRecords(this.db);
    const currentMaxBatch = applied.reduce(
      (max, r) => Math.max(max, r.batch),
      0,
    );
    const nextBatch = currentMaxBatch + 1;

    const sorted = this.getRegisteredMigrations();
    const appliedSet = new Set(applied.map((r) => r.version));
    let pending = sorted.filter(
      (m) => !appliedSet.has(normalizeVersion(m.version)),
    );

    if (options?.step !== undefined && options.step > 0) {
      pending = pending.slice(0, options.step);
    }

    for (const migration of pending) {
      await this.db.transaction(async (tx) => {
        // Re-check under lock
        const currentApplied = await this.getAppliedRecords(tx);
        if (
          currentApplied.some(
            (r) => r.version === normalizeVersion(migration.version),
          )
        ) {
          return;
        }

        const res = await this.executeMigrationUp(tx, migration, nextBatch);
        executed.push(res);
      });
    }

    return { executed, batch: executed.length > 0 ? nextBatch : undefined };
  }

  /**
   * Rolls back previously applied migrations. By default rolls back the most recent batch.
   */
  async down(options?: MigrateDownOptions): Promise<MigrationResult> {
    return this.db.transaction(async (tx) => {
      await this.ensureTrackingTable(tx);
      const applied = await this.getAppliedRecords(tx);
      if (applied.length === 0) {
        return { executed: [] };
      }

      // Group & order records to revert
      let toRevert: MigrationRecord[];

      if (options?.all) {
        // Roll back everything in reverse order
        toRevert = [...applied].sort((a, b) => {
          if (b.batch !== a.batch) return b.batch - a.batch;
          return compareVersions(b.version, a.version);
        });
      } else if (options?.step !== undefined && options.step > 0) {
        // Roll back last N migrations
        const sorted = [...applied].sort((a, b) => {
          if (b.batch !== a.batch) return b.batch - a.batch;
          return compareVersions(b.version, a.version);
        });
        toRevert = sorted.slice(0, options.step);
      } else {
        // Roll back the latest batch
        const maxBatch = applied.reduce((max, r) => Math.max(max, r.batch), 0);
        toRevert = applied
          .filter((r) => r.batch === maxBatch)
          .sort((a, b) => compareVersions(b.version, a.version));
      }

      if (toRevert.length === 0) {
        return { executed: [] };
      }

      const migrationMap = new Map<string, Migration>();
      for (const m of this.migrations) {
        migrationMap.set(normalizeVersion(m.version), m);
      }

      const executed: ExecutedMigration[] = [];

      for (const record of toRevert) {
        const migration = migrationMap.get(record.version);
        if (!migration) {
          throw new Error(
            `Cannot roll back migration "${record.name}" (version: ${record.version}): migration definition not registered.`,
          );
        }
        if (!migration.down) {
          throw new Error(
            `Cannot roll back migration "${record.name}" (version: ${record.version}): no down() rollback handler provided.`,
          );
        }

        if (this.onMigrationStart) {
          await this.onMigrationStart(migration, 'down');
        }

        const start = Date.now();
        try {
          await migration.down(tx);
        } catch (err) {
          if (this.onMigrationError) {
            await this.onMigrationError(migration, 'down', err);
          }
          throw err;
        }
        const duration = Date.now() - start;

        // Remove from tracking table
        await tx.delete(this.tableName, record.version);

        if (this.onMigrationSuccess) {
          await this.onMigrationSuccess(migration, 'down', duration);
        }

        executed.push({
          version: record.version,
          name: migration.name,
          direction: 'down',
          durationMs: duration,
        });
      }

      return { executed, batch: toRevert[0]?.batch };
    });
  }

  /**
   * Alias for `up()`. Migrates to the latest registered version.
   */
  latest(options?: MigrateUpOptions): Promise<MigrationResult> {
    return this.up(options);
  }

  /**
   * Alias for `down()`. Rolls back the latest batch or specified steps.
   */
  rollback(options?: MigrateDownOptions): Promise<MigrationResult> {
    return this.down(options);
  }

  /**
   * Rolls back all applied migrations.
   */
  reset(): Promise<MigrationResult> {
    return this.down({ all: true });
  }

  private async runUpInternal(
    tx: WebDB,
    options?: MigrateUpOptions,
  ): Promise<MigrationResult> {
    await this.ensureTrackingTable(tx);
    const applied = await this.getAppliedRecords(tx);
    const currentMaxBatch = applied.reduce(
      (max, r) => Math.max(max, r.batch),
      0,
    );
    const nextBatch = currentMaxBatch + 1;

    const sorted = this.getRegisteredMigrations();
    const appliedSet = new Set(applied.map((r) => r.version));
    let pending = sorted.filter(
      (m) => !appliedSet.has(normalizeVersion(m.version)),
    );

    if (options?.step !== undefined && options.step > 0) {
      pending = pending.slice(0, options.step);
    }

    if (pending.length === 0) {
      return { executed: [] };
    }

    const executed: ExecutedMigration[] = [];
    for (const migration of pending) {
      const res = await this.executeMigrationUp(tx, migration, nextBatch);
      executed.push(res);
    }

    return { executed, batch: nextBatch };
  }

  private async executeMigrationUp(
    tx: WebDB,
    migration: Migration,
    batch: number,
  ): Promise<ExecutedMigration> {
    const vStr = normalizeVersion(migration.version);
    if (this.onMigrationStart) {
      await this.onMigrationStart(migration, 'up');
    }

    const start = Date.now();
    try {
      await migration.up(tx);
    } catch (err) {
      if (this.onMigrationError) {
        await this.onMigrationError(migration, 'up', err);
      }
      throw err;
    }
    const duration = Date.now() - start;

    await tx.insert(this.tableName, {
      version: vStr,
      name: migration.name,
      applied_at: BigInt(Date.now()),
      batch,
      duration_ms: duration,
    });

    if (this.onMigrationSuccess) {
      await this.onMigrationSuccess(migration, 'up', duration);
    }

    return {
      version: vStr,
      name: migration.name,
      direction: 'up',
      durationMs: duration,
    };
  }
}

/**
 * Convenient standalone runner function for running pending migrations on startup.
 */
export async function runMigrations(
  db: WebDB,
  migrations: Migration[],
  options?: Omit<MigratorOptions, 'migrations'>,
): Promise<MigrationResult> {
  const migrator = new Migrator(db, {
    ...options,
    migrations,
  });
  return migrator.up();
}
