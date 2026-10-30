/**
 * Database connection.
 *
 * Two drivers, one SQL. PGlite is real PostgreSQL compiled to WebAssembly and
 * running in-process — same SQL, same types, same behaviour, but nothing to
 * install. That is what lets the whole test suite run with no database server,
 * and what a single-location business actually runs on: one process, one file,
 * no DBA.
 *
 * A SERVER connection is the other driver, and it is what a business outgrows
 * into. PGlite's ceiling is that exactly one process may hold the data
 * directory; the second office, the second till, the phone in the delivery van
 * all want their own process. Pointing `DAWGS_DATABASE_URL` at a Postgres server
 * moves the same schema, the same migrations and the same queries onto one.
 *
 * The migration runner below is written against the intersection of the two
 * drivers rather than against either one, because a migration that applies
 * differently depending on how you connected is not a migration.
 */

import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { schema } from './schema.js';

/**
 * One type for both drivers.
 *
 * A union of the two would be more literally true and useless in practice:
 * TypeScript collapses the overloads of every builder method across a union,
 * so `.returning({ id })` stops accepting an argument and hundreds of correct
 * queries fail to compile. Both are `PgDatabase` over the same dialect and
 * differ only in their session and result plumbing, none of which this codebase
 * touches — every query goes through the shared builder surface.
 */
export type Database = ReturnType<typeof drizzlePglite<typeof schema>>;

export interface MemoryDatabase {
  readonly db: Database;
  /** Present only for the in-process driver. */
  readonly pg?: PGlite;
  close(): Promise<void>;
}

/**
 * What the migration runner needs, which both drivers can provide.
 *
 * PGlite exposes `exec`/`query` directly; a pooled `pg` connection is adapted
 * onto the same two methods below. Writing the runner against this instead of
 * against `PGlite` is what stops the two paths from drifting.
 */
export interface SqlRunner {
  exec(sql: string): Promise<unknown>;
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * An in-process PostgreSQL, migrated and ready.
 *
 * `dataDir` persists to disk; omitting it gives an ephemeral database, which is
 * what tests want — every test file gets a clean, isolated instance with no
 * shared state and no teardown to forget.
 */
export async function createMemoryDatabase(options: {
  migrationsDir: string;
  dataDir?: string;
}): Promise<MemoryDatabase> {
  const pg = options.dataDir ? new PGlite(options.dataDir) : new PGlite();
  await pg.waitReady;

  const db = drizzlePglite(pg, { schema });
  await applyMigrations(pg, options.migrationsDir);

  return {
    db,
    pg,
    close: async () => {
      await pg.close();
    },
  };
}

/**
 * A pooled connection to a PostgreSQL server, migrated and ready.
 *
 * MIGRATIONS RUN ON ONE CONNECTION, not across the pool. A pool hands out a
 * different backend per query, and `CREATE TABLE` followed by `INSERT INTO
 * __migrations` on two different backends is two transactions that can
 * interleave with another node doing the same thing at boot.
 *
 * `max` is deliberately small. Postgres charges real memory per backend, and
 * the businesses this serves run on the cheapest instance their host sells; a
 * pool sized for a datacentre is how a 2 GB box starts refusing connections
 * under a load it could otherwise carry.
 */
export async function createServerDatabase(options: {
  url: string;
  migrationsDir: string;
  max?: number;
  ssl?: boolean;
}): Promise<MemoryDatabase> {
  const pool = new Pool({
    connectionString: options.url,
    max: options.max ?? 10,
    // Managed Postgres (Neon, Supabase, RDS) terminates TLS with a certificate
    // chain the client cannot always verify. Refusing to connect would be
    // safer; refusing to connect to every managed host there is would mean
    // nobody uses this path. Opt in explicitly through the URL when the chain
    // is verifiable.
    ...(options.ssl === true ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  const client = await pool.connect();
  try {
    await applyMigrations(adaptPg(client), options.migrationsDir);
  } finally {
    client.release();
  }

  const db = drizzlePg(pool, { schema }) as unknown as Database;
  return {
    db,
    close: async () => {
      await pool.end();
    },
  };
}

/** A `pg` client wearing PGlite's two methods. */
function adaptPg(client: {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
}): SqlRunner {
  return {
    exec: (sql) => client.query(sql),
    query: async <T>(sql: string, params?: unknown[]) =>
      (await client.query(sql, params)) as { rows: T[] },
  };
}

/**
 * Open whichever database this deployment is configured for.
 *
 * A URL wins over a data directory, so a container that is handed
 * `DAWGS_DATABASE_URL` uses the server even if the image also ships a data
 * directory — the alternative is a node that silently writes to its own
 * ephemeral disk and looks like it is working.
 */
export async function openDatabase(options: {
  migrationsDir: string;
  url?: string | undefined;
  dataDir?: string | undefined;
  ssl?: boolean;
}): Promise<MemoryDatabase> {
  if (options.url) {
    return createServerDatabase({
      url: options.url,
      migrationsDir: options.migrationsDir,
      ...(options.ssl !== undefined ? { ssl: options.ssl } : {}),
    });
  }
  return createMemoryDatabase({
    migrationsDir: options.migrationsDir,
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
  });
}

/**
 * Apply the generated SQL migrations in filename order, once each.
 *
 * Drizzle separates statements with `--> statement-breakpoint`; both drivers
 * can take several statements at once, but splitting keeps a failure pointed at
 * the statement that caused it rather than the whole file.
 *
 * WHAT IS APPLIED IS RECORDED. Without a ledger the whole set replays on every
 * boot — which an ephemeral test database never notices, because it is empty
 * each time, and which makes the SECOND start of a persisted database die on
 * `relation "businesses" already exists`. Persistence is the self-hosting case,
 * so the bug is invisible in development and fatal in the deployment this
 * product promises.
 *
 * ONE NODE AT A TIME. The advisory lock below is what makes it safe for two
 * app servers to boot against the same database simultaneously: the second
 * waits, then finds every file already recorded and does nothing. Without it
 * both would run `CREATE TABLE` and one would crash on a schema the other had
 * just created — a failure that only ever appears in production, because
 * development has one node.
 */
export async function applyMigrations(
  runner: SqlRunner,
  migrationsDir: string,
): Promise<void> {
  await runner.exec(`
    CREATE TABLE IF NOT EXISTS __migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  // An arbitrary but fixed key: any two nodes running this code agree on it,
  // and nothing else in the system uses advisory locks.
  await runner.exec('SELECT pg_advisory_lock(4820253)');
  try {
    const existing = await runner.query<{ name: string }>('SELECT name FROM __migrations');
    const applied = new Set(existing.rows.map((row) => row.name));

    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (applied.has(file)) continue;

      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      const statements = sql
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      /**
       * One transaction per file, with the ledger row written inside it.
       *
       * A file that fails halfway would otherwise leave a schema that is
       * neither the old one nor the new one, and — being unrecorded — would
       * retry the same half on the next boot.
       */
      await runner.exec('BEGIN');
      try {
        for (const statement of statements) await runner.exec(statement);
        await runner.query('INSERT INTO __migrations (name) VALUES ($1)', [file]);
        await runner.exec('COMMIT');
      } catch (cause) {
        await runner.exec('ROLLBACK');
        throw new Error(`migration ${file} failed:\n${String(cause)}`);
      }
    }
  } finally {
    await runner.exec('SELECT pg_advisory_unlock(4820253)');
  }
}

export { schema };
