import {resolve} from 'node:path';
import postgres, {type Sql} from 'postgres';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {runMigrations} from '../apps/api/src/migrations.js';

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL is required to run publication-operation invariant tests.');
}

const migrationsDirectory = resolve(process.cwd(), 'db/migrations');
const admin = postgres(databaseUrl, {onnotice: (): void => undefined});
const schema = `publication_invariants_${String(process.pid)}`;
const prefix = `publication-invariant-${String(process.pid)}`;

interface IdRow {
    readonly id: string;
}

let sql: Sql;
let accountId: string;
let parentCommentId: string;

const createPendingOperation = async (suffix: string): Promise<string> => {
    const rows = await sql<IdRow[]>`
        insert into reply_publication_operations (
            account_id,
            parent_comment_id,
            idempotency_key,
            request_fingerprint,
            status
        ) values (
            ${accountId},
            ${parentCommentId},
            ${`${prefix}-${suffix}`},
            ${`fingerprint-${suffix}`},
            'pending'
        )
        returning id
    `;
    const row = rows.at(0);

    if (row === undefined) {
        throw new Error('The publication-operation fixture was not created.');
    }

    return row.id;
};

beforeAll(async (): Promise<void> => {
    await admin`drop schema if exists ${admin(schema)} cascade`;
    await admin`create schema ${admin(schema)}`;

    sql = postgres(databaseUrl, {
        max: 1,
        onnotice: (): void => undefined,
        connection: {search_path: schema},
    });

    await runMigrations(sql, migrationsDirectory);

    const accounts = await sql<IdRow[]>`
        insert into accounts (platform, external_account_id)
        values ('demo', ${`${prefix}-account`})
        returning id
    `;
    const account = accounts.at(0);

    if (account === undefined) {
        throw new Error('The publication-operation account fixture was not created.');
    }

    accountId = account.id;

    const posts = await sql<IdRow[]>`
        insert into posts (account_id, external_post_id, published_at)
        values (${accountId}, ${`${prefix}-post`}, now())
        returning id
    `;
    const post = posts.at(0);

    if (post === undefined) {
        throw new Error('The publication-operation post fixture was not created.');
    }

    const comments = await sql<IdRow[]>`
        insert into comments (
            post_id,
            external_comment_id,
            external_author_id,
            content,
            platform_created_at
        ) values (
            ${post.id},
            ${`${prefix}-parent`},
            ${`${prefix}-author`},
            'Parent comment',
            now()
        )
        returning id
    `;
    const comment = comments.at(0);

    if (comment === undefined) {
        throw new Error('The publication-operation parent fixture was not created.');
    }

    parentCommentId = comment.id;
});

afterAll(async (): Promise<void> => {
    await sql.end();
    await admin`drop schema if exists ${admin(schema)} cascade`;
    await admin.end();
});

describe('reply publication operation database invariants', () => {
    it('rejects a published operation without an attached comment', async () => {
        const operationId = await createPendingOperation('published-without-comment');

        await expect(sql`
            update reply_publication_operations
            set status = 'published'
            where id = ${operationId}
        `).rejects.toThrow(/reply_publication_operations_published_comment_check/u);
    });

    it('keeps failure codes consistent with failure statuses', async () => {
        const missingCodeId = await createPendingOperation('failed-without-code');
        const unexpectedCodeId = await createPendingOperation('pending-with-code');

        await expect(sql`
            update reply_publication_operations
            set status = 'failed',
                last_failure_code = null
            where id = ${missingCodeId}
        `).rejects.toThrow(/reply_publication_operations_failure_check/u);

        await expect(sql`
            update reply_publication_operations
            set last_failure_code = 'PLATFORM_TIMEOUT'
            where id = ${unexpectedCodeId}
        `).rejects.toThrow(/reply_publication_operations_failure_check/u);
    });

    it('rejects a published operation that references a missing comment', async () => {
        const operationId = await createPendingOperation('missing-comment-reference');

        await expect(sql`
            update reply_publication_operations
            set status = 'published',
                comment_id = '0198ffff-ffff-7fff-8fff-ffffffffffff'
            where id = ${operationId}
        `).rejects.toThrow(/reply_publication_operations_comment_id_fkey/u);
    });
});
