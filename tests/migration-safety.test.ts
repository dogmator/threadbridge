import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import postgres, {type Sql} from 'postgres';
import {afterAll, describe, expect, it} from 'vitest';
import {
    assertSupportedPostgresVersion,
    runMigrations,
} from '../apps/api/src/migrations.js';

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL is required to run migration safety tests.');
}

const checkedInMigrations = resolve(process.cwd(), 'db/migrations');
const admin = postgres(databaseUrl, {onnotice: (): void => undefined});
let schemaIndex = 0;

interface RelationRow {
    readonly relation: string | null;
}

interface IndexDefinitionRow {
    readonly definition: string;
}

const withMigrationScenario = async (
    use: (sql: Sql, directory: string) => Promise<void>,
): Promise<void> => {
    schemaIndex += 1;

    const schema = `migration_safety_${String(process.pid)}_${String(schemaIndex)}`;
    const directory = await mkdtemp(join(tmpdir(), 'threadbridge-migration-safety-'));

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

const copyMigration = async (directory: string, name: string): Promise<void> => {
    await writeFile(
        join(directory, name),
        await readFile(join(checkedInMigrations, name), 'utf8'),
    );
};

afterAll(async (): Promise<void> => {
    await admin.end();
});

describe('PostgreSQL version preflight', () => {
    it('rejects a server older than PostgreSQL 18 with a diagnostic error', () => {
        expect((): void => {
            assertSupportedPostgresVersion('170006', '17.6');
        }).toThrow(/requires PostgreSQL 18 or newer.*17\.6.*No migration was applied/su);
    });

    it('accepts PostgreSQL 18 and newer version numbers', () => {
        expect((): void => {
            assertSupportedPostgresVersion('180000', '18.0');
        }).not.toThrow();
        expect((): void => {
            assertSupportedPostgresVersion('190002', '19.2');
        }).not.toThrow();
    });
});

describe('provider-boundary migration preflight', () => {
    it('refuses to continue when the verified baseline idempotency index is missing', async () => {
        await withMigrationScenario(async (sql, directory): Promise<void> => {
            await copyMigration(directory, '0001_initial_schema.sql');
            await runMigrations(sql, directory);
            await sql`drop index comments_idempotency_key_idx`;
            await copyMigration(directory, '0004_provider_boundary_hardening.sql');

            await expect(runMigrations(sql, directory)).rejects.toThrow(
                /Expected baseline index comments_idempotency_key_idx does not match/u,
            );

            const relations = await sql<RelationRow[]>`
                select to_regclass('reply_publication_operations')::text as relation
            `;

            expect(relations.at(0)?.relation).toBeNull();
        });
    });

    it('refuses to remove a different index that only reuses the expected name', async () => {
        await withMigrationScenario(async (sql, directory): Promise<void> => {
            await copyMigration(directory, '0001_initial_schema.sql');
            await runMigrations(sql, directory);
            await sql`drop index comments_idempotency_key_idx`;
            await sql`create index comments_idempotency_key_idx on comments (content)`;
            await copyMigration(directory, '0004_provider_boundary_hardening.sql');

            await expect(runMigrations(sql, directory)).rejects.toThrow(
                /Expected baseline index comments_idempotency_key_idx does not match/u,
            );

            const definitions = await sql<IndexDefinitionRow[]>`
                select pg_get_indexdef('comments_idempotency_key_idx'::regclass) as definition
            `;

            expect(definitions.at(0)?.definition).toMatch(/\(content\)/u);
        });
    });
});
