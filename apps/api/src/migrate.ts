import {readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import postgres from 'postgres';

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined) {
    throw new Error('DATABASE_URL is required');
}

const migrationsDirectory = resolve(process.cwd(), 'db/migrations');
const sql = postgres(databaseUrl, {max: 1});

try {
    await sql`
        create table if not exists schema_migrations (
            name text primary key,
            applied_at timestamptz not null default now()
        )
    `;

    const migrationFiles = (await readdir(migrationsDirectory))
        .filter((fileName): boolean => fileName.endsWith('.sql'))
        .sort((left, right): number => left.localeCompare(right));

    for (const fileName of migrationFiles) {
        await sql.begin(async (transaction): Promise<void> => {
            const inserted = await transaction`
                insert into schema_migrations (name)
                values (${fileName})
                on conflict do nothing
                returning name
            `;

            if (inserted.length === 0) {
                return;
            }

            await transaction.file(resolve(migrationsDirectory, fileName));
        });
    }
} finally {
    await sql.end();
}
