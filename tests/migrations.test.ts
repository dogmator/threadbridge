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

interface CountRow {
    readonly count: string;
}

/** The advisory-lock key runMigrations takes, mirrored here to observe it in pg_locks. */
const MIGRATION_LOCK_NAMESPACE = 0x54_42_00_01;
const MIGRATION_LOCK_ID = 1;

const heldMigrationLocks = async (sql: Sql): Promise<number> => {
    const rows = await sql<CountRow[]>`
        select count(*)::text as count from pg_locks
        where locktype = 'advisory'
          and classid = ${MIGRATION_LOCK_NAMESPACE}
          and objid = ${MIGRATION_LOCK_ID}
          and granted
    `;

    return Number.parseInt(rows.at(0)?.count ?? '0', 10);
};

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

/**
 * The same private schema, reached through two independent clients, which is what two application
 * instances starting against one database look like from PostgreSQL's side.
 */
const withTwoInstances = async (
    use: (first: Sql, second: Sql, directory: string) => Promise<void>,
): Promise<void> => {
    schemaIndex += 1;

    const schema = `migration_race_${String(process.pid)}_${String(schemaIndex)}`;
    const directory = await mkdtemp(join(tmpdir(), 'threadbridge-migrations-'));
    const connect = (): Sql =>
        postgres(databaseUrl, {
            max: 1,
            onnotice: (): void => undefined,
            connection: {search_path: schema},
        });

    await admin`drop schema if exists ${admin(schema)} cascade`;
    await admin`create schema ${admin(schema)}`;

    const first = connect();
    const second = connect();

    try {
        await use(first, second, directory);
    } finally {
        await first.end();
        await second.end();
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

            expect(applied).toEqual([
                '0001_initial_schema.sql',
                '0002_demo_seed.sql',
                '0003_comment_parent_post_consistency.sql',
            ]);
            expect(records.map((record): string => record.name)).toEqual([
                '0001_initial_schema.sql',
                '0002_demo_seed.sql',
                '0003_comment_parent_post_consistency.sql',
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

describe('runMigrations across instances', () => {
    it('lets only one of two concurrent instances apply a pending migration', async () => {
        await withTwoInstances(async (first, second, directory): Promise<void> => {
            // The sleep is the synchronization point: whichever instance takes the lock holds it
            // long enough that the other is certainly waiting rather than merely scheduled later.
            // Neither statement tolerates being run twice, so a duplicate run cannot pass silently.
            await writeFile(
                join(directory, '0001_concurrent.sql'),
                'select pg_sleep(0.25);\ncreate table concurrent_probe (id integer);\n',
            );

            const results = await Promise.all([
                runMigrations(first, directory),
                runMigrations(second, directory),
            ]);
            const applied = results.flat();
            const records = await recordsOf(first);
            const relations = await first<RelationRow[]>`
                select to_regclass('concurrent_probe')::text as relation
            `;

            expect(applied).toEqual(['0001_concurrent.sql']);
            expect(results.filter((result): boolean => result.length === 0)).toHaveLength(1);
            expect(records).toHaveLength(1);
            expect(records.at(0)?.name).toBe('0001_concurrent.sql');
            expect(relations.at(0)?.relation).not.toBeNull();
        });
    });

    it('releases the lock when the run succeeds', async () => {
        await withTwoInstances(async (first, second, directory): Promise<void> => {
            await writeFile(join(directory, '0001_probe.sql'), 'create table probe (id integer);\n');

            await runMigrations(first, directory);

            expect(await heldMigrationLocks(second)).toBe(0);
        });
    });

    it('releases the lock after a failing migration and reports the original error', async () => {
        await withTwoInstances(async (first, second, directory): Promise<void> => {
            const file = join(directory, '0001_broken.sql');

            await writeFile(file, 'create table broken (id integer);\nthis is not valid sql;\n');

            await expect(runMigrations(first, directory)).rejects.toThrow(/syntax error/iu);

            expect(await heldMigrationLocks(second)).toBe(0);
            expect(await recordsOf(second)).toEqual([]);

            // The lock is free, so a corrected run proceeds instead of waiting for a lost holder.
            await writeFile(file, 'create table repaired (id integer);\n');

            const applied = await runMigrations(second, directory);
            const relations = await second<RelationRow[]>`
                select to_regclass('repaired')::text as relation
            `;

            expect(applied).toEqual(['0001_broken.sql']);
            expect(relations.at(0)?.relation).not.toBeNull();
            expect(await heldMigrationLocks(first)).toBe(0);
        });
    });

    it('rolls back and releases the lock when commit rejects a deferred constraint', async () => {
        await withTwoInstances(async (first, second, directory): Promise<void> => {
            const file = join(directory, '0001_deferred.sql');

            await writeFile(
                file,
                'create table migration_parent (id integer primary key);\n'
                + 'create table migration_child (parent_id integer references migration_parent (id) '
                + 'deferrable initially deferred);\n'
                + 'insert into migration_child (parent_id) values (1);\n',
            );

            await expect(runMigrations(first, directory)).rejects.toThrow(/foreign key/iu);

            expect(await heldMigrationLocks(second)).toBe(0);
            expect(await recordsOf(second)).toEqual([]);

            await writeFile(file, 'create table repaired_after_commit_failure (id integer);\n');

            expect(await runMigrations(second, directory)).toEqual(['0001_deferred.sql']);
            expect(await heldMigrationLocks(first)).toBe(0);
        });
    });

    it('releases the lock when validation rejects the history', async () => {
        await withTwoInstances(async (first, second, directory): Promise<void> => {
            const file = join(directory, '0001_probe.sql');

            await writeFile(file, 'create table probe (id integer);\n');
            await runMigrations(first, directory);
            await rm(file);

            await expect(runMigrations(first, directory)).rejects.toThrow(
                /Applied migrations are missing/u,
            );

            expect(await heldMigrationLocks(second)).toBe(0);
        });
    });
});
