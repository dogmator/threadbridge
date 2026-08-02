import {createHash} from 'node:crypto';
import {readdir, readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {Sql} from 'postgres';

interface AppliedMigrationRow {
    readonly name: string;
    readonly checksum: string;
}

interface MigrationNameRow {
    readonly name: string;
}

interface ChecksumColumnRow {
    readonly attnotnull: boolean;
}

const checksumOf = (content: string): string =>
    createHash('sha256').update(content, 'utf8').digest('hex');

const asError = (value: unknown): Error =>
    value instanceof Error ? value : new Error('Migration failed with a non-Error value.');

/**
 * Runs one migration in its own transaction on the caller's session.
 *
 * The transaction is driven explicitly instead of through `sql.begin`, because the whole migration
 * sequence runs on the single reserved session that holds the advisory lock, and the reserved
 * handle of the checked-in postgres client exposes no `begin`. A failed rollback never replaces the
 * failure that caused it.
 */
const inTransaction = async (sql: Sql, run: () => Promise<void>): Promise<void> => {
    await sql`begin`;

    try {
        await run();
        await sql`commit`;
    } catch (error: unknown) {
        try {
            await sql`rollback`;
        } catch {
            // A rollback that cannot be sent means the session is already gone; the original
            // migration failure is the one worth reporting.
        }

        throw error;
    }
};

const namesOf = (rows: readonly MigrationNameRow[]): string =>
    rows.map((row): string => row.name).join(', ');

/**
 * Refuses a migration history that records applied migrations without a checksum. No checksum can
 * be reconstructed for a migration applied before checksums existed, and inventing one would
 * certify a schema nobody verified.
 */
const rejectUntrustworthyHistory = (rows: readonly MigrationNameRow[]): void => {
    if (rows.length === 0) {
        return;
    }

    throw new Error(
        'schema_migrations predates checksum verification and already records applied migrations '
        + `without a checksum: ${namesOf(rows)}. Verify the deployed schema and record the `
        + 'checksums deliberately; a checksum is never invented for an applied migration.',
    );
};

/**
 * Brings a schema_migrations table created by an earlier, checksum-less runner up to the current
 * shape. An empty legacy table is upgraded in place, because nothing was certified yet.
 */
const ensureChecksumColumn = async (sql: Sql): Promise<void> => {
    const columns = await sql<ChecksumColumnRow[]>`
        select attnotnull from pg_attribute
        where attrelid = 'schema_migrations'::regclass
          and attname = 'checksum'
          and attnum > 0
          and not attisdropped
    `;
    const column = columns.at(0);

    if (column === undefined) {
        rejectUntrustworthyHistory(
            await sql<MigrationNameRow[]>`select name from schema_migrations order by name`,
        );
        await sql`alter table schema_migrations add column checksum text not null`;

        return;
    }

    if (column.attnotnull) {
        return;
    }

    rejectUntrustworthyHistory(
        await sql<MigrationNameRow[]>`
            select name from schema_migrations where checksum is null order by name
        `,
    );
    await sql`alter table schema_migrations alter column checksum set not null`;
};

/**
 * Rejects a history that records a migration the directory no longer contains. The recorded row is
 * never deleted and the file is never treated as optional: a deployed schema whose source has
 * disappeared can no longer be verified, so the whole run stops before anything else is applied.
 */
const ensureEveryAppliedMigrationExists = (
    applied: readonly AppliedMigrationRow[],
    fileNames: readonly string[],
    directory: string,
): void => {
    const onDisk = new Set(fileNames);
    const missing = applied.filter((row): boolean => !onDisk.has(row.name));

    if (missing.length === 0) {
        return;
    }

    throw new Error(
        `Applied migrations are missing from ${directory}: ${namesOf(missing)}. `
        + 'Restore the files or remove the records deliberately; no migration was applied and no '
        + 'record was changed.',
    );
};

/**
 * The key of the global ThreadBridge migration lock, as the two 32-bit halves PostgreSQL accepts.
 * The namespace is the ASCII of "TB" followed by a version byte, which keeps it recognisable in
 * `pg_locks` and unlikely to collide with an unrelated application sharing the database.
 */
const MIGRATION_LOCK_NAMESPACE = 0x54_42_00_01;
const MIGRATION_LOCK_ID = 1;

/**
 * Applies every pending migration in deterministic filename order, each one in its own
 * transaction. An already applied migration is verified against its recorded SHA-256 checksum and
 * is never re-applied or silently re-recorded, so an edited or deleted migration fails loudly
 * instead of drifting away from the deployed schema.
 */
const applyMigrations = async (sql: Sql, directory: string): Promise<readonly string[]> => {
    await sql`
        create table if not exists schema_migrations (
            name text primary key,
            checksum text not null,
            applied_at timestamptz not null default now()
        )
    `;
    await ensureChecksumColumn(sql);

    const fileNames = (await readdir(directory))
        .filter((fileName): boolean => fileName.endsWith('.sql'))
        .sort((left, right): number => left.localeCompare(right));
    const appliedMigrations = await sql<AppliedMigrationRow[]>`
        select name, checksum from schema_migrations order by name
    `;

    ensureEveryAppliedMigrationExists(appliedMigrations, fileNames, directory);

    const recorded = new Map(
        appliedMigrations.map((row): readonly [string, string] => [row.name, row.checksum]),
    );
    const applied: string[] = [];

    for (const fileName of fileNames) {
        const content = await readFile(resolve(directory, fileName), 'utf8');
        const checksum = checksumOf(content);
        const existing = recorded.get(fileName);

        if (existing !== undefined) {
            if (existing !== checksum) {
                throw new Error(
                    `Migration ${fileName} was modified after it was applied: `
                    + `recorded checksum ${existing}, current checksum ${checksum}.`,
                );
            }

            continue;
        }

        await inTransaction(sql, async (): Promise<void> => {
            await sql.unsafe(content).simple();
            await sql`
                insert into schema_migrations (name, checksum) values (${fileName}, ${checksum})
            `;
        });

        applied.push(fileName);
    }

    return applied;
};

/**
 * Serializes the whole migration run across application instances.
 *
 * Every instance takes one session-level advisory lock on a reserved connection before it inspects
 * the history and holds it until the last pending migration is applied, so two instances starting
 * together cannot both run the same DDL: the second one waits, then observes a completed history
 * and applies nothing. The lock is session-scoped rather than transaction-scoped precisely because
 * each migration keeps its own transaction; wrapping every migration in one transaction to obtain
 * a transaction-scoped lock would trade a real guarantee for a worse one.
 *
 * The lock is released whether the run succeeded, found an edited or missing migration, or failed
 * inside a migration, and the original error is never replaced by a failure to release.
 */
export const runMigrations = async (sql: Sql, directory: string): Promise<readonly string[]> => {
    const reserved = await sql.reserve();
    let lockHeld = false;
    let applied: readonly string[] = [];
    let failure: Error | null = null;

    try {
        await reserved`
            select pg_advisory_lock(${MIGRATION_LOCK_NAMESPACE}, ${MIGRATION_LOCK_ID})
        `;
        lockHeld = true;

        applied = await applyMigrations(reserved, directory);
    } catch (error: unknown) {
        failure = asError(error);
    } finally {
        if (lockHeld) {
            try {
                await reserved`
                    select pg_advisory_unlock(${MIGRATION_LOCK_NAMESPACE}, ${MIGRATION_LOCK_ID})
                `;
            } catch (error: unknown) {
                // A broken session has already released its session-scoped lock. Preserve the
                // original migration failure when there was one; otherwise report this release
                // failure to the caller.
                failure ??= asError(error);
            }
        }

        try {
            reserved.release();
        } catch (error: unknown) {
            failure ??= asError(error);
        }
    }

    if (failure !== null) {
        throw failure;
    }

    return applied;
};
