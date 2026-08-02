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
 * Applies every pending migration in deterministic filename order, each one in its own
 * transaction. An already applied migration is verified against its recorded SHA-256 checksum and
 * is never re-applied or silently re-recorded, so an edited or deleted migration fails loudly
 * instead of drifting away from the deployed schema.
 */
export const runMigrations = async (sql: Sql, directory: string): Promise<readonly string[]> => {
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

        await sql.begin(async (transaction): Promise<void> => {
            await transaction.unsafe(content).simple();
            await transaction`
                insert into schema_migrations (name, checksum) values (${fileName}, ${checksum})
            `;
        });

        applied.push(fileName);
    }

    return applied;
};
