import {createHash} from 'node:crypto';
import {readdir, readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {Sql} from 'postgres';

interface AppliedMigrationRow {
    readonly checksum: string;
}

const checksumOf = (content: string): string =>
    createHash('sha256').update(content, 'utf8').digest('hex');

/**
 * Applies every pending migration in deterministic filename order, each one in its own
 * transaction. An already applied migration is verified against its recorded SHA-256 checksum and
 * is never re-applied or silently re-recorded, so an edited migration fails loudly instead of
 * drifting away from the deployed schema.
 */
export const runMigrations = async (sql: Sql, directory: string): Promise<readonly string[]> => {
    await sql`
        create table if not exists schema_migrations (
            name text primary key,
            checksum text not null,
            applied_at timestamptz not null default now()
        )
    `;

    // An earlier runner created schema_migrations without a checksum column. It could never record
    // a row, because no migration existed yet, so the column can be added and constrained here.
    // Should a checksum-less row ever exist, the constraint fails loudly rather than inventing one.
    await sql`alter table schema_migrations add column if not exists checksum text`;
    await sql`alter table schema_migrations alter column checksum set not null`;

    const fileNames = (await readdir(directory))
        .filter((fileName): boolean => fileName.endsWith('.sql'))
        .sort((left, right): number => left.localeCompare(right));

    const applied: string[] = [];

    for (const fileName of fileNames) {
        const content = await readFile(resolve(directory, fileName), 'utf8');
        const checksum = checksumOf(content);
        const recorded = await sql<AppliedMigrationRow[]>`
            select checksum from schema_migrations where name = ${fileName}
        `;
        const existing = recorded.at(0);

        if (existing !== undefined) {
            if (existing.checksum !== checksum) {
                throw new Error(
                    `Migration ${fileName} was modified after it was applied: `
                    + `recorded checksum ${existing.checksum}, current checksum ${checksum}.`,
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
