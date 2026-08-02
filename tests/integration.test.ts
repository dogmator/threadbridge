import {once} from 'node:events';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import postgres from 'postgres';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {PostgresCommentReplyContextRepository}
    from '../apps/api/src/adapters/postgres/comment-reply-context-repository.js';
import {PostgresCommentRepository}
    from '../apps/api/src/adapters/postgres/comment-repository.js';
import {PostgresPublishedPostRepository}
    from '../apps/api/src/adapters/postgres/published-post-repository.js';
import {createApiComponents, type ApiComponents} from '../apps/api/src/composition.js';
import {runMigrations} from '../apps/api/src/migrations.js';
import {createApiServer} from '../apps/api/src/server.js';
import type {CommentPageResponse} from '../apps/api/src/comment-response.js';
import type {HttpErrorEnvelope} from '../apps/api/src/http-error.js';
import {
    toAccountId,
    toCommentId,
    toExternalAuthorId,
    toExternalCommentId,
    toPostId,
    type AccountId,
    type Comment,
    type NormalizedComment,
    type PostId,
} from '@threadbridge/comments';

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error(
        'DATABASE_URL is required to run the integration tests. '
        + 'Start PostgreSQL with "docker compose up -d postgres" and set DATABASE_URL.',
    );
}

const migrationsDirectory = resolve(process.cwd(), 'db/migrations');
const sql = postgres(databaseUrl, {max: 4, onnotice: (): void => undefined});

/** Owned by these tests only; the demo seed is never deleted. */
const fixtureExternalAccountId = 'integration-account';
const fixtureExternalPostId = 'integration-post';

interface IdRow {
    readonly id: string;
}

const platformCreatedAt = new Date('2026-03-01T09:00:00.000Z');

let fixtureAccountId: AccountId;
let fixturePostId: PostId;

const importedComment = (suffix: string, parentCommentId: string | null): NormalizedComment => ({
    postId: fixturePostId,
    parentCommentId: parentCommentId === null ? null : toCommentId(parentCommentId),
    externalCommentId: toExternalCommentId(`integration-external-${suffix}`),
    externalAuthorId: toExternalAuthorId(`integration-author-${suffix}`),
    content: `Imported ${suffix}`,
    platformCreatedAt,
    metadata: {likes: 4, tags: ['a', 'b']},
});

beforeAll(async (): Promise<void> => {
    await runMigrations(sql, migrationsDirectory);

    const accounts = await sql<IdRow[]>`
        insert into accounts (platform, external_account_id)
        values ('demo', ${fixtureExternalAccountId})
        on conflict (platform, external_account_id) do update set updated_at = now()
        returning id
    `;
    const account = accounts.at(0);

    if (account === undefined) {
        throw new Error('The integration account fixture was not created.');
    }

    const posts = await sql<IdRow[]>`
        insert into posts (account_id, external_post_id, published_at)
        values (${account.id}, ${fixtureExternalPostId}, now())
        on conflict (account_id, external_post_id) do update set updated_at = now()
        returning id
    `;
    const post = posts.at(0);

    if (post === undefined) {
        throw new Error('The integration post fixture was not created.');
    }

    fixtureAccountId = toAccountId(account.id);
    fixturePostId = toPostId(post.id);
});

afterAll(async (): Promise<void> => {
    await sql`
        delete from comments
        where post_id in (
            select posts.id from posts
            join accounts on accounts.id = posts.account_id
            where accounts.external_account_id = ${fixtureExternalAccountId}
        )
    `;
    await sql`
        delete from posts
        where account_id in (
            select id from accounts where external_account_id = ${fixtureExternalAccountId}
        )
    `;
    await sql`delete from accounts where external_account_id = ${fixtureExternalAccountId}`;
    await sql.end();
});

describe('migrations', () => {
    it('applies the checked-in migration set and records a checksum for each file', async () => {
        const rows = await sql<{name: string; checksum: string}[]>`
            select name, checksum from schema_migrations order by name
        `;

        expect(rows.map((row): string => row.name)).toEqual([
            '0001_initial_schema.sql',
            '0002_demo_seed.sql',
        ]);
        expect(rows.every((row): boolean => row.checksum.length === 64)).toBe(true);
    });

    it('applies the unchanged migration set repeatedly without re-applying anything', async () => {
        const applied = await runMigrations(sql, migrationsDirectory);

        expect(applied).toEqual([]);
    });

    it('creates the specified schema and the demo seed', async () => {
        const tables = await sql<{table_name: string}[]>`
            select table_name from information_schema.tables
            where table_schema = 'public'
            order by table_name
        `;
        const seededPosts = await sql<IdRow[]>`
            select posts.id from posts
            join accounts on accounts.id = posts.account_id
            where accounts.external_account_id = 'demo-account-1'
              and posts.external_post_id = 'demo-post-1'
        `;

        expect(tables.map((row): string => row.table_name)).toEqual([
            'accounts',
            'comments',
            'posts',
            'schema_migrations',
        ]);
        expect(seededPosts.at(0)?.id).toBe('0198f000-0000-7000-8000-000000000002');
    });

    it('rejects an applied migration whose content changed', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'threadbridge-migrations-'));
        const fileName = '9999_checksum_probe.sql';
        const file = join(directory, fileName);

        try {
            await writeFile(file, 'create table if not exists checksum_probe (id integer);\n');
            await runMigrations(sql, directory);

            await writeFile(
                file,
                'create table if not exists checksum_probe (id integer, extra text);\n',
            );

            await expect(runMigrations(sql, directory)).rejects.toThrow(
                /9999_checksum_probe\.sql was modified after it was applied/u,
            );
        } finally {
            await sql`delete from schema_migrations where name = ${fileName}`;
            await sql`drop table if exists checksum_probe`;
            await rm(directory, {recursive: true, force: true});
        }
    });
});

describe('PostgresPublishedPostRepository', () => {
    it('resolves the account, platform, and external post id of a published post', async () => {
        const repository = new PostgresPublishedPostRepository(sql);

        const context = await repository.findContextByPostId(fixturePostId);

        expect(context).toEqual({
            accountId: fixtureAccountId,
            platform: 'demo',
            externalPostId: fixtureExternalPostId,
        });
    });

    it('returns null for an unknown post', async () => {
        const repository = new PostgresPublishedPostRepository(sql);

        const context = await repository.findContextByPostId(
            toPostId('0198f000-0000-7000-8000-0000000000ff'),
        );

        expect(context).toBeNull();
    });
});

describe('PostgresCommentRepository', () => {
    it('returns an empty array for empty input', async () => {
        const repository = new PostgresCommentRepository(sql);

        expect(await repository.saveMany([])).toEqual([]);
    });

    it('persists imported comments and preserves the input order', async () => {
        const repository = new PostgresCommentRepository(sql);

        const stored = await repository.saveMany([
            importedComment('order-b', null),
            importedComment('order-a', null),
        ]);

        expect(stored.map((comment): string => comment.externalCommentId)).toEqual([
            'integration-external-order-b',
            'integration-external-order-a',
        ]);
        expect(stored.every((comment): boolean => comment.postId === fixturePostId)).toBe(true);
    });

    it('round-trips the parent comment and the platform metadata', async () => {
        const repository = new PostgresCommentRepository(sql);

        const [parent] = await repository.saveMany([importedComment('parent', null)]);

        if (parent === undefined) {
            throw new Error('The parent comment was not persisted.');
        }

        const [reply] = await repository.saveMany([importedComment('child', parent.id)]);

        expect(reply?.parentCommentId).toBe(parent.id);
        expect(reply?.metadata).toEqual({likes: 4, tags: ['a', 'b']});
        expect(parent.parentCommentId).toBeNull();
    });

    it('imports the same external comment repeatedly without creating a duplicate row', async () => {
        const repository = new PostgresCommentRepository(sql);

        const [first] = await repository.saveMany([importedComment('repeat', null)]);
        const [second] = await repository.saveMany([importedComment('repeat', null)]);
        const rows = await sql<IdRow[]>`
            select id from comments
            where post_id = ${fixturePostId}
              and external_comment_id = 'integration-external-repeat'
        `;

        expect(rows).toHaveLength(1);
        expect(second?.id).toBe(first?.id);
        expect(second?.createdAt).toEqual(first?.createdAt);
        expect(first?.version).toBe(1);
        expect(second?.version).toBe(2);
    });

    it('stores imported comments without an idempotency key', async () => {
        const repository = new PostgresCommentRepository(sql);

        const [stored] = await repository.saveMany([importedComment('no-key', null)]);
        const rows = await sql<{idempotency_key: string | null}[]>`
            select idempotency_key from comments
            where post_id = ${fixturePostId}
              and external_comment_id = 'integration-external-no-key'
        `;

        expect(stored).not.toHaveProperty('idempotencyKey');
        expect(rows.at(0)?.idempotency_key).toBeNull();
    });
});

describe('PostgresCommentReplyContextRepository', () => {
    it('resolves the reply context of a stored comment', async () => {
        const comments = new PostgresCommentRepository(sql);
        const contexts = new PostgresCommentReplyContextRepository(sql);
        const [stored] = await comments.saveMany([importedComment('context', null)]);

        if (stored === undefined) {
            throw new Error('The comment fixture was not persisted.');
        }

        const context = await contexts.findByCommentId(stored.id);

        expect(context).toEqual({
            postId: fixturePostId,
            accountId: fixtureAccountId,
            platform: 'demo',
            externalParentCommentId: 'integration-external-context',
        });
    });

    it('returns null for an unknown comment', async (): Promise<void> => {
        const contexts = new PostgresCommentReplyContextRepository(sql);

        const context = await contexts.findByCommentId(
            toCommentId('0198f000-0000-7000-8000-0000000000fe'),
        );

        expect(context).toBeNull();
    });
});

describe('imported comment entities', () => {
    it('expose store-owned identity and local timestamps', async () => {
        const repository = new PostgresCommentRepository(sql);

        const [stored] = await repository.saveMany([importedComment('identity', null)]);
        const comment: Comment | undefined = stored;

        expect(comment?.id).toMatch(/^[0-9a-f-]{36}$/u);
        expect(comment?.createdAt).toBeInstanceOf(Date);
        expect(comment?.updatedAt).toBeInstanceOf(Date);
        expect(comment?.platformCreatedAt).toEqual(platformCreatedAt);
    });
});

const DEMO_POST_ID = '0198f000-0000-7000-8000-000000000002';

describe('retrieval REST endpoints', () => {
    let components: ApiComponents;
    let server: ReturnType<typeof createApiServer>;
    let baseUrl: string;

    const readPage = async (path: string): Promise<CommentPageResponse> => {
        const response = await fetch(`${baseUrl}${path}`);

        expect(response.status).toBe(200);

        return (await response.json()) as CommentPageResponse;
    };

    beforeAll(async (): Promise<void> => {
        components = createApiComponents(databaseUrl);
        server = createApiServer(components.dependencies);
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');

        const address = server.address();

        if (address === null || typeof address === 'string') {
            throw new Error('The API server is not listening on a TCP port.');
        }

        baseUrl = `http://127.0.0.1:${String(address.port)}`;
    });

    afterAll(async (): Promise<void> => {
        server.close();
        server.closeAllConnections();
        await once(server, 'close');
        await components.close();
        await sql`delete from comments where post_id = ${DEMO_POST_ID}`;
    });

    it('returns the first page of root comments of the demo post', async () => {
        const page = await readPage(`/posts/${DEMO_POST_ID}/comments`);

        expect(page.items.map((item): string => item.externalCommentId)).toEqual([
            'demo-comment-1',
            'demo-comment-2',
        ]);
        expect(page.nextCursor).not.toBeNull();
        expect(page.items.every((item): boolean => item.postId === DEMO_POST_ID)).toBe(true);
        expect(page.items[0]).not.toHaveProperty('idempotencyKey');
    });

    it('persists the retrieved comments in PostgreSQL', async () => {
        await readPage(`/posts/${DEMO_POST_ID}/comments`);

        const rows = await sql<{external_comment_id: string}[]>`
            select external_comment_id from comments
            where post_id = ${DEMO_POST_ID}
            order by external_comment_id
        `;

        expect(rows.map((row): string => row.external_comment_id)).toContain('demo-comment-1');
    });

    it('traverses the root comment pages with the returned cursor', async () => {
        const first = await readPage(`/posts/${DEMO_POST_ID}/comments`);
        const second = await readPage(
            `/posts/${DEMO_POST_ID}/comments?cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
        );

        expect(second.items.map((item): string => item.externalCommentId)).toEqual([
            'demo-comment-3',
        ]);
        expect(second.nextCursor).toBeNull();
    });

    it('returns the direct replies of a comment returned by the root endpoint', async () => {
        const roots = await readPage(`/posts/${DEMO_POST_ID}/comments`);
        const parent = roots.items.find(
            (item): boolean => item.externalCommentId === 'demo-comment-1',
        );

        if (parent === undefined) {
            throw new Error('The demo root comment was not returned.');
        }

        const replies = await readPage(`/comments/${parent.id}/replies`);

        expect(replies.items.map((item): string => item.externalCommentId)).toEqual([
            'demo-comment-1-reply-1',
            'demo-comment-1-reply-2',
        ]);
        expect(replies.items.every((item): boolean => item.parentCommentId === parent.id))
            .toBe(true);
        expect(replies.items.every((item): boolean => item.postId === DEMO_POST_ID)).toBe(true);
    });

    it('reports an unknown post with the uniform error envelope', async () => {
        const response = await fetch(
            `${baseUrl}/posts/0198f000-0000-7000-8000-0000000000aa/comments`,
        );
        const body = (await response.json()) as HttpErrorEnvelope;

        expect(response.status).toBe(404);
        expect(body.error.code).toBe('POST_NOT_FOUND');
        expect(body.error.message).toBe('Post was not found');
        expect(body.error.requestId.length).toBeGreaterThan(0);
    });

    it('reports an unknown comment with the uniform error envelope', async () => {
        const response = await fetch(
            `${baseUrl}/comments/0198f000-0000-7000-8000-0000000000ab/replies`,
        );
        const body = (await response.json()) as HttpErrorEnvelope;

        expect(response.status).toBe(404);
        expect(body.error.code).toBe('COMMENT_NOT_FOUND');
        expect(body.error.message).toBe('Comment was not found');
    });

    it('reports a malformed identifier as not found instead of failing', async () => {
        const response = await fetch(`${baseUrl}/posts/not-a-uuid/comments`);
        const body = (await response.json()) as HttpErrorEnvelope;

        expect(response.status).toBe(404);
        expect(body.error.code).toBe('POST_NOT_FOUND');
    });

    it('keeps the health response unchanged', async () => {
        const response = await fetch(`${baseUrl}/health`);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({status: 'ok'});
    });

    it('keeps the unknown route response unchanged', async () => {
        const response = await fetch(`${baseUrl}/unknown`);
        const body = (await response.json()) as HttpErrorEnvelope;

        expect(response.status).toBe(404);
        expect(body.error.code).toBe('ROUTE_NOT_FOUND');
        expect(body.error.message).toBe('Route was not found');
    });
});
