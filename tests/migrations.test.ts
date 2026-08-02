import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import postgres, {type Sql} from 'postgres';
import {afterAll, describe, expect, it} from 'vitest';
import {runMigrations} from '../apps/api/src/migrations.js';

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error(
        'DATABASE_URL is required to run the migration integrity tests. '
        + 'Start PostgreSQL with "docker compose up -d postgres" and set DATABASE_URL.',
    );
}

const checkedInMigrations = resolve(process.cwd(), 'db/migrations');
const admin = postgres(databaseUrl, {onnotice: (): void => undefined});

let schemaIndex = 0;

interface MigrationRecordRow {
    readonly name: string;
    readonly checksum: string | null;
}

interface RelationRow {
    readonly relation: string | null;
}

/**
 * Runs one scenario against a private PostgreSQL schema and a private migration directory. A
 * history that has to be broken on purpose therefore never touches the schema the rest of the
 * suite depends on, and no checked-in migration file is ever modified.
 */
const withMigrationScenario = async (
    use: (sql: Sql, directory: string) => Promise<void>,
): Promise<void> => {
    schemaIndex += 1;

    const schema = `migration_test_${String(process.pid)}_${String(schemaIndex)}`;
    const directory = await mkdtemp(join(tmpdir(), 'threadbridge-migrations-'));

    await admin`drop schema if exists ${admin(schema)} cascade`;
    await admin`create schema ${admin(schema)}`;

    const sql = postgres(databaseUrl, {
        max: 1,
        onnotice: (): void => undefined,
        connection: {search_path: schema},
    });

    try {
        await use(sql, directory);
    } finally {
        await sql.end();
        await admin`drop schema if exists ${admin(schema)} cascade`;
        await rm(directory, {recursive: true, force: true});
    }
};

const recordsOf = async (sql: Sql): Promise<readonly MigrationRecordRow[]> =>
    await sql<MigrationRecordRow[]>`select name, checksum from schema_migrations order by name`;

const createLegacyTable = async (sql: Sql): Promise<void> => {
    await sql`
        create table schema_migrations (
            name text primary key,
            applied_at timestamptz not null default now()
        )
    `;
};

afterAll(async (): Promise<void> => {
    await admin.end();
});

describe('runMigrations', () => {
    it('applies the checked-in migration set to an empty schema', async () => {
        await withMigrationScenario(async (sql): Promise<void> => {
            const applied = await runMigrations(sql, checkedInMigrations);
            const records = await recordsOf(sql);

            expect(applied).toEqual(['0001_initial_schema.sql', '0002_demo_seed.sql']);
            expect(records.map((record): string => record.name)).toEqual([
                '0001_initial_schema.sql',
                '0002_demo_seed.sql',
            ]);
            expect(records.every((record): boolean => record.checksum?.length === 64)).toBe(true);
        });
    });

    it('applies nothing on an unchanged second run', async () => {
        await withMigrationScenario(async (sql): Promise<void> => {
            await runMigrations(sql, checkedInMigrations);
            const before = await recordsOf(sql);

            const applied = await runMigrations(sql, checkedInMigrations);

            expect(applied).toEqual([]);
            expect(await recordsOf(sql)).toEqual(before);
        });
    });

    it('rejects a migration whose content changed after it was applied', async () => {
        await withMigrationScenario(async (sql, directory): Promise<void> => {
            const file = join(directory, '0001_probe.sql');

            await writeFile(file, 'create table probe (id integer);\n');
            await runMigrations(sql, directory);
            await writeFile(file, 'create table probe (id integer, extra text);\n');

            await expect(runMigrations(sql, directory)).rejects.toThrow(
                /0001_probe\.sql was modified after it was applied/u,
            );
        });
    });

    it('never modifies the recorded checksum of an edited migration', async () => {
        await withMigrationScenario(async (sql, directory): Promise<void> => {
            const file = join(directory, '0001_probe.sql');

            await writeFile(file, 'create table probe (id integer);\n');
            await runMigrations(sql, directory);

            const before = await recordsOf(sql);

            await writeFile(file, 'create table probe (id integer, extra text);\n');
            await expect(runMigrations(sql, directory)).rejects.toThrow();

            expect(await recordsOf(sql)).toEqual(before);
        });
    });

    it('rejects an applied migration that no longer exists on disk and names it', async () => {
        await withMigrationScenario(async (sql, directory): Promise<void> => {
            const file = join(directory, '0001_probe.sql');

            await writeFile(file, 'create table probe (id integer);\n');
            await runMigrations(sql, directory);
            await rm(file);

            await expect(runMigrations(sql, directory)).rejects.toThrow(
                /Applied migrations are missing from .*: 0001_probe\.sql/u,
            );
        });
    });

    it('keeps the record of a missing migration instead of deleting it', async () => {
        await withMigrationScenario(async (sql, directory): Promise<void> => {
            const file = join(directory, '0001_probe.sql');

            await writeFile(file, 'create table probe (id integer);\n');
            await runMigrations(sql, directory);
            await rm(file);
            await expect(runMigrations(sql, directory)).rejects.toThrow();

            const records = await recordsOf(sql);

            expect(records.map((record): string => record.name)).toEqual(['0001_probe.sql']);
        });
    });

    it('applies no pending migration once an applied one is missing from disk', async () => {
        await withMigrationScenario(async (sql, directory): Promise<void> => {
            const applied = join(directory, '0001_probe.sql');

            await writeFile(applied, 'create table probe (id integer);\n');
            await runMigrations(sql, directory);
            await rm(applied);
            await writeFile(join(directory, '0002_late.sql'), 'create table late (id integer);\n');

            await expect(runMigrations(sql, directory)).rejects.toThrow(
                /0001_probe\.sql/u,
            );

            const relations = await sql<RelationRow[]>`
                select to_regclass('late')::text as relation
            `;
            const records = await recordsOf(sql);

            expect(relations.at(0)?.relation).toBeNull();
            expect(records.map((record): string => record.name)).toEqual(['0001_probe.sql']);
        });
    });

    it('upgrades an empty legacy history table that has no checksum column', async () => {
        await withMigrationScenario(async (sql, directory): Promise<void> => {
            await createLegacyTable(sql);
            await writeFile(join(directory, '0001_probe.sql'), 'create table probe (id integer);\n');

            const applied = await runMigrations(sql, directory);
            const records = await recordsOf(sql);

            expect(applied).toEqual(['0001_probe.sql']);
            expect(records.at(0)?.checksum?.length).toBe(64);
        });
    });

    it('refuses a legacy history table that records migrations without a checksum', async () => {
        await withMigrationScenario(async (sql, directory): Promise<void> => {
            await createLegacyTable(sql);
            await sql`insert into schema_migrations (name) values ('0001_probe.sql')`;
            await writeFile(join(directory, '0001_probe.sql'), 'create table probe (id integer);\n');

            await expect(runMigrations(sql, directory)).rejects.toThrow(
                /predates checksum verification .*0001_probe\.sql/su,
            );

            const relations = await sql<RelationRow[]>`
                select to_regclass('probe')::text as relation
            `;

            expect(relations.at(0)?.relation).toBeNull();
        });
    });

    it('refuses a half-upgraded history table that still holds a null checksum', async () => {
        await withMigrationScenario(async (sql, directory): Promise<void> => {
            await createLegacyTable(sql);
            await sql`alter table schema_migrations add column checksum text`;
            await sql`insert into schema_migrations (name) values ('0001_probe.sql')`;
            await writeFile(join(directory, '0001_probe.sql'), 'create table probe (id integer);\n');

            await expect(runMigrations(sql, directory)).rejects.toThrow(
                /predates checksum verification/u,
            );

            const records = await recordsOf(sql);

            expect(records.at(0)?.checksum).toBeNull();
        });
    });
});
