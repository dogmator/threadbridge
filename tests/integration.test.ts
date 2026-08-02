import {once} from 'node:events';
import {setTimeout} from 'node:timers/promises';
import {resolve} from 'node:path';
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
import type {CommentPageResponse, CommentResponse} from '../apps/api/src/comment-response.js';
import type {HttpErrorEnvelope} from '../apps/api/src/http-error.js';
import {
    ok,
    ReplyToComment,
    toAccountId,
    toCommentId,
    toExternalAuthorId,
    toExternalCommentId,
    toIdempotencyKey,
    toPostId,
    toSocialPlatform,
    type AccountId,
    type Comment,
    type CommentId,
    type ExternalCommentId,
    type IdempotencyKey,
    type IndeterminatePlatformResultFailure,
    type NormalizedComment,
    type PlatformComment,
    type PlatformFailure,
    type PostId,
    type PublishedReply,
    type ReplyToPlatformCommentInput,
    type Result,
    type SocialCommentsGateway,
    type SocialPlatform,
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

interface KeyedRow {
    readonly id: string;
    readonly idempotency_key: string | null;
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
            '0003_comment_parent_post_consistency.sql',
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

interface VersionedRow {
    readonly id: string;
    readonly content: string;
    readonly version: number;
}

describe('comments optimistic locking', () => {
    /**
     * The schema, not a use case, is what has to support optimistic locking today: the current
     * scope has no editing command, so no caller supplies an expected version. This proves the
     * compare-and-set pattern a future versioned mutation would rely on.
     */
    it('accepts a compare-and-set on the current version and ignores a stale one', async () => {
        const repository = new PostgresCommentRepository(sql);
        const [stored] = await repository.saveMany([importedComment('optimistic', null)]);

        if (stored === undefined) {
            throw new Error('The comment fixture was not persisted.');
        }

        expect(stored.version).toBe(1);

        const updated = await sql<VersionedRow[]>`
            update comments
            set content = 'Compare-and-set', updated_at = now(), version = version + 1
            where id = ${stored.id} and version = 1
            returning id, content, version
        `;

        expect(updated).toHaveLength(1);
        expect(updated.at(0)?.version).toBe(2);

        const stale = await sql<VersionedRow[]>`
            update comments
            set content = 'Stale write', updated_at = now(), version = version + 1
            where id = ${stored.id} and version = 1
            returning id, content, version
        `;

        expect(stale).toHaveLength(0);

        const current = await sql<VersionedRow[]>`
            select id, content, version from comments where id = ${stored.id}
        `;

        expect(current.at(0)).toEqual({
            id: stored.id,
            content: 'Compare-and-set',
            version: 2,
        });
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

const publishedReply = (
    suffix: string,
    parentCommentId: CommentId,
    content: string,
    idempotencyKey: IdempotencyKey,
): PublishedReply => ({
    postId: fixturePostId,
    parentCommentId,
    externalCommentId: toExternalCommentId(`integration-published-${suffix}`),
    externalAuthorId: toExternalAuthorId('integration-author-self'),
    content,
    platformCreatedAt,
    metadata: {source: 'integration'},
    idempotencyKey,
});

describe('PostgresCommentRepository publication', () => {
    it('returns null for an unused idempotency key', async () => {
        const repository = new PostgresCommentRepository(sql);

        expect(await repository.findByIdempotencyKey(toIdempotencyKey('unused-key'))).toBeNull();
    });

    it('persists a published reply with every field and a fresh identity', async () => {
        const repository = new PostgresCommentRepository(sql);
        const [parent] = await repository.saveMany([importedComment('publish-parent', null)]);

        if (parent === undefined) {
            throw new Error('The parent comment was not persisted.');
        }

        const key = toIdempotencyKey('integration-key-1');
        const saved = await repository.savePublishedReply(
            publishedReply('one', parent.id, 'A published reply', key),
        );

        expect(saved.kind).toBe('created');
        expect(saved.comment.id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        );
        expect(saved.comment.version).toBe(1);
        expect(saved.comment.parentCommentId).toBe(parent.id);
        expect(saved.comment.postId).toBe(fixturePostId);
        expect(saved.comment.content).toBe('A published reply');
        expect(saved.comment.idempotencyKey).toBe(key);
        expect(saved.comment.metadata).toEqual({source: 'integration'});
        expect(await repository.findByIdempotencyKey(key)).toEqual(saved.comment);
    });

    it('converges a repeated publication of the same key on one row', async () => {
        const repository = new PostgresCommentRepository(sql);
        const [parent] = await repository.saveMany([importedComment('publish-repeat', null)]);

        if (parent === undefined) {
            throw new Error('The parent comment was not persisted.');
        }

        const key = toIdempotencyKey('integration-key-2');
        const reply = publishedReply('two', parent.id, 'Repeated', key);
        const first = await repository.savePublishedReply(reply);
        const second = await repository.savePublishedReply(reply);
        const rows = await sql<IdRow[]>`
            select id from comments where idempotency_key = ${key}
        `;

        expect(first.kind).toBe('created');
        expect(second.kind).toBe('existing');
        expect(second.comment.id).toBe(first.comment.id);
        expect(rows).toHaveLength(1);
    });

    it('converges concurrent publications of the same key on one identity', async () => {
        const repository = new PostgresCommentRepository(sql);
        const [parent] = await repository.saveMany([importedComment('publish-race', null)]);

        if (parent === undefined) {
            throw new Error('The parent comment was not persisted.');
        }

        const key = toIdempotencyKey('integration-key-3');
        const reply = publishedReply('three', parent.id, 'Concurrent', key);
        const results = await Promise.all([
            repository.savePublishedReply(reply),
            repository.savePublishedReply(reply),
            repository.savePublishedReply(reply),
        ]);
        const rows = await sql<IdRow[]>`
            select id from comments where idempotency_key = ${key}
        `;

        expect(rows).toHaveLength(1);
        expect(new Set(results.map((result): string => result.comment.id)).size).toBe(1);
        expect(results.filter((result): boolean => result.kind === 'created')).toHaveLength(1);
    });

    it('converges concurrent publications of one key that returned different external ids',
        async () => {
            const repository = new PostgresCommentRepository(sql);
            const [parent] = await repository.saveMany([importedComment('publish-diverge', null)]);

            if (parent === undefined) {
                throw new Error('The parent comment was not persisted.');
            }

            const key = toIdempotencyKey('integration-key-diverge');
            const results = await Promise.all([
                repository.savePublishedReply(
                    publishedReply('diverge-a', parent.id, 'Diverging', key),
                ),
                repository.savePublishedReply(
                    publishedReply('diverge-b', parent.id, 'Diverging', key),
                ),
                repository.savePublishedReply(
                    publishedReply('diverge-c', parent.id, 'Diverging', key),
                ),
            ]);
            const rows = await sql<IdRow[]>`
                select id from comments where idempotency_key = ${key}
            `;

            expect(rows).toHaveLength(1);
            expect(new Set(results.map((result): string => result.comment.id)).size).toBe(1);
            expect(results.filter((result): boolean => result.kind === 'created')).toHaveLength(1);
            expect(results.filter((result): boolean => result.kind === 'existing')).toHaveLength(2);
        });

    it('waits for a concurrent holder of the same key and adopts its row', async () => {
        const repository = new PostgresCommentRepository(sql);
        const [parent] = await repository.saveMany([importedComment('publish-lockstep', null)]);

        if (parent === undefined) {
            throw new Error('The parent comment was not persisted.');
        }

        const key = toIdempotencyKey('integration-key-lockstep');
        let winnerId = '';

        // Holds the advisory lock for this key, inserts a competing row under a different external
        // identity, and commits only after the repository call is certainly blocked on the lock.
        // Without the lock the repository would insert concurrently and hit the unique index.
        const holder = sql.begin<string>(async (transaction): Promise<string> => {
            await transaction`
                select pg_advisory_xact_lock(hashtextextended(${key}::text, 0))
            `;

            const rows = await transaction<IdRow[]>`
                insert into comments (
                    post_id, parent_comment_id, external_comment_id, external_author_id,
                    content, platform_created_at, idempotency_key
                ) values (
                    ${fixturePostId}, ${parent.id}, 'integration-lockstep-winner',
                    'integration-author-self', 'Winner', ${platformCreatedAt}, ${key}
                )
                returning id
            `;
            const inserted = rows.at(0);

            if (inserted === undefined) {
                throw new Error('The competing row was not inserted.');
            }

            winnerId = inserted.id;
            await setTimeout(150);

            return inserted.id;
        });

        await setTimeout(50);
        const saved = await repository.savePublishedReply(
            publishedReply('lockstep-loser', parent.id, 'Loser', key),
        );
        await holder;

        const rows = await sql<IdRow[]>`
            select id from comments where idempotency_key = ${key}
        `;

        expect(saved.kind).toBe('existing');
        expect(saved.comment.id).toBe(winnerId);
        expect(saved.comment.content).toBe('Winner');
        expect(rows).toHaveLength(1);
    });

    it('creates separate rows for different idempotency keys', async () => {
        const repository = new PostgresCommentRepository(sql);
        const [parent] = await repository.saveMany([importedComment('publish-distinct', null)]);

        if (parent === undefined) {
            throw new Error('The parent comment was not persisted.');
        }

        const first = await repository.savePublishedReply(
            publishedReply('four', parent.id, 'First', toIdempotencyKey('integration-key-4')),
        );
        const second = await repository.savePublishedReply(
            publishedReply('five', parent.id, 'Second', toIdempotencyKey('integration-key-5')),
        );

        expect(second.comment.id).not.toBe(first.comment.id);
        expect(second.kind).toBe('created');
    });

    it('publishes a reply to a reply', async () => {
        const repository = new PostgresCommentRepository(sql);
        const [parent] = await repository.saveMany([importedComment('publish-depth', null)]);

        if (parent === undefined) {
            throw new Error('The parent comment was not persisted.');
        }

        const first = await repository.savePublishedReply(
            publishedReply('depth-1', parent.id, 'Depth one', toIdempotencyKey('integration-key-6')),
        );
        const second = await repository.savePublishedReply(
            publishedReply(
                'depth-2',
                first.comment.id,
                'Depth two',
                toIdempotencyKey('integration-key-7'),
            ),
        );

        expect(second.comment.parentCommentId).toBe(first.comment.id);
        expect(first.comment.parentCommentId).toBe(parent.id);
    });

    it('reconciles an already imported reply instead of duplicating it', async () => {
        const repository = new PostgresCommentRepository(sql);
        const [parent] = await repository.saveMany([importedComment('publish-import', null)]);

        if (parent === undefined) {
            throw new Error('The parent comment was not persisted.');
        }

        const key = toIdempotencyKey('integration-key-8');
        const reply = publishedReply('imported', parent.id, 'Imported first', key);
        const [imported] = await repository.saveMany([
            {
                postId: reply.postId,
                parentCommentId: reply.parentCommentId,
                externalCommentId: reply.externalCommentId,
                externalAuthorId: reply.externalAuthorId,
                content: reply.content,
                platformCreatedAt: reply.platformCreatedAt,
                metadata: reply.metadata,
            },
        ]);

        const saved = await repository.savePublishedReply(reply);
        const rows = await sql<IdRow[]>`
            select id from comments
            where post_id = ${fixturePostId}
              and external_comment_id = ${reply.externalCommentId}
        `;

        expect(rows).toHaveLength(1);
        expect(saved.kind).toBe('existing');
        expect(saved.comment.id).toBe(imported?.id);
        expect(saved.comment.createdAt).toEqual(imported?.createdAt);
        expect(saved.comment.idempotencyKey).toBe(key);
    });

    it('never replaces an idempotency key that is already recorded', async () => {
        const repository = new PostgresCommentRepository(sql);
        const [parent] = await repository.saveMany([importedComment('publish-keep-key', null)]);

        if (parent === undefined) {
            throw new Error('The parent comment was not persisted.');
        }

        const original = toIdempotencyKey('integration-key-9');
        const reply = publishedReply('keep', parent.id, 'Keep the key', original);
        const first = await repository.savePublishedReply(reply);

        const saved = await repository.savePublishedReply({
            ...reply,
            idempotencyKey: toIdempotencyKey('integration-key-10'),
        });
        const rows = await sql<IdRow[]>`
            select id from comments
            where post_id = ${fixturePostId}
              and external_comment_id = ${reply.externalCommentId}
        `;

        expect(saved.kind).toBe('existing');
        expect(saved.comment.idempotencyKey).toBe(original);
        expect(saved.comment.id).toBe(first.comment.id);
        expect(saved.comment.createdAt).toEqual(first.comment.createdAt);
        expect(rows).toHaveLength(1);
        expect(await repository.findByIdempotencyKey(toIdempotencyKey('integration-key-10')))
            .toBeNull();
    });
});

/** Answers each publication with a distinct external comment id, as a real platform might. */
class DivergingGateway implements SocialCommentsGateway {
    private calls = 0;

    public constructor(private readonly externalIdPrefix: string) {}

    public getComments(): never {
        throw new Error('This gateway only publishes.');
    }

    public getReplies(): never {
        throw new Error('This gateway only publishes.');
    }

    public replyToComment(
        input: ReplyToPlatformCommentInput,
    ): Promise<Result<PlatformComment, PlatformFailure | IndeterminatePlatformResultFailure>> {
        this.calls += 1;

        return Promise.resolve(
            ok<PlatformComment>({
                externalCommentId: toExternalCommentId(
                    `${this.externalIdPrefix}-${String(this.calls)}`,
                ),
                externalAuthorId: toExternalAuthorId('integration-author-self'),
                content: input.content,
                createdAt: platformCreatedAt,
                metadata: null,
            }),
        );
    }
}

/** Releases every caller only once the expected number of callers has arrived. */
class Barrier {
    private arrived = 0;

    private release: () => void = (): void => undefined;

    private readonly opened = new Promise<void>((resolve): void => {
        this.release = resolve;
    });

    public constructor(private readonly expected: number) {}

    public async arrive(): Promise<void> {
        this.arrived += 1;

        if (this.arrived >= this.expected) {
            this.release();
        }

        await this.opened;
    }
}

/**
 * Answers every publication with one external comment id, as a platform that deduplicates on its
 * own side would. An optional barrier holds each caller until the expected number of requests has
 * reached the platform, so both requests provably enter persistence with the same external
 * identity in hand instead of relying on scheduling luck.
 */
class ConvergingGateway implements SocialCommentsGateway {
    public constructor(
        private readonly externalCommentId: ExternalCommentId,
        private readonly barrier: Barrier | null = null,
    ) {}

    public getComments(): never {
        throw new Error('This gateway only publishes.');
    }

    public getReplies(): never {
        throw new Error('This gateway only publishes.');
    }

    public async replyToComment(
        input: ReplyToPlatformCommentInput,
    ): Promise<Result<PlatformComment, PlatformFailure | IndeterminatePlatformResultFailure>> {
        if (this.barrier !== null) {
            await this.barrier.arrive();
        }

        return ok<PlatformComment>({
            externalCommentId: this.externalCommentId,
            externalAuthorId: toExternalAuthorId('integration-author-self'),
            content: input.content,
            createdAt: platformCreatedAt,
            metadata: null,
        });
    }
}

describe('ReplyToComment against real PostgreSQL', () => {
    it('resolves a same-key race as one row plus an idempotency conflict', async () => {
        const comments = new PostgresCommentRepository(sql);
        const contexts = new PostgresCommentReplyContextRepository(sql);
        const [parent] = await comments.saveMany([importedComment('race-parent', null)]);

        if (parent === undefined) {
            throw new Error('The parent comment was not persisted.');
        }

        const platform = toSocialPlatform('demo');
        const useCase = new ReplyToComment(
            contexts,
            new Map<SocialPlatform, SocialCommentsGateway>([
                [platform, new DivergingGateway('integration-diverging-conflict')],
            ]),
            comments,
        );
        const key = toIdempotencyKey('integration-key-race');

        const results = await Promise.all([
            useCase.execute({parentCommentId: parent.id, content: 'First', idempotencyKey: key}),
            useCase.execute({parentCommentId: parent.id, content: 'Second', idempotencyKey: key}),
        ]);
        const rows = await sql<IdRow[]>`
            select id from comments where idempotency_key = ${key}
        `;

        expect(rows).toHaveLength(1);
        expect(results.filter((result): boolean => result.ok)).toHaveLength(1);

        const conflicts = results.filter(
            (result): boolean => !result.ok && result.error.code === 'IDEMPOTENCY_CONFLICT',
        );

        expect(conflicts).toHaveLength(1);
    });

    it('replays an identical concurrent request instead of conflicting', async () => {
        const comments = new PostgresCommentRepository(sql);
        const contexts = new PostgresCommentReplyContextRepository(sql);
        const [parent] = await comments.saveMany([importedComment('race-identical', null)]);

        if (parent === undefined) {
            throw new Error('The parent comment was not persisted.');
        }

        const platform = toSocialPlatform('demo');
        const useCase = new ReplyToComment(
            contexts,
            new Map<SocialPlatform, SocialCommentsGateway>([
                [platform, new DivergingGateway('integration-diverging-identical')],
            ]),
            comments,
        );
        const key = toIdempotencyKey('integration-key-race-same');
        const request = {parentCommentId: parent.id, content: 'Same', idempotencyKey: key};

        const results = await Promise.all([useCase.execute(request), useCase.execute(request)]);
        const rows = await sql<IdRow[]>`
            select id from comments where idempotency_key = ${key}
        `;
        const outcomes = results.map((result): string =>
            result.ok ? result.value.comment.id : result.error.code);

        expect(rows).toHaveLength(1);
        expect(results.every((result): boolean => result.ok)).toBe(true);
        expect(new Set(outcomes).size).toBe(1);
    });

    it('adopts an imported external comment that carries no key yet', async () => {
        const comments = new PostgresCommentRepository(sql);
        const contexts = new PostgresCommentReplyContextRepository(sql);
        const [parent] = await comments.saveMany([importedComment('adopt-parent', null)]);

        if (parent === undefined) {
            throw new Error('The parent comment was not persisted.');
        }

        const [imported] = await comments.saveMany([
            {...importedComment('adopt-target', parent.id), content: 'Adopted content'},
        ]);

        if (imported === undefined) {
            throw new Error('The imported reply was not persisted.');
        }

        const useCase = new ReplyToComment(
            contexts,
            new Map<SocialPlatform, SocialCommentsGateway>([
                [
                    toSocialPlatform('demo'),
                    new ConvergingGateway(imported.externalCommentId),
                ],
            ]),
            comments,
        );
        const key = toIdempotencyKey('integration-key-adopt');

        const result = await useCase.execute({
            parentCommentId: parent.id,
            content: 'Adopted content',
            idempotencyKey: key,
        });
        const rows = await sql<KeyedRow[]>`
            select id, idempotency_key from comments
            where post_id = ${fixturePostId}
              and external_comment_id = ${imported.externalCommentId}
        `;

        expect(result.ok).toBe(true);
        expect(result.ok ? result.value.comment.id : null).toBe(imported.id);
        expect(result.ok ? result.value.comment.createdAt : null).toEqual(imported.createdAt);
        expect(rows).toHaveLength(1);
        expect(rows.at(0)?.idempotency_key).toBe(key);
    });

    it('reports a conflict when another key already owns the returned external comment', async () => {
        const comments = new PostgresCommentRepository(sql);
        const contexts = new PostgresCommentReplyContextRepository(sql);
        const [parent] = await comments.saveMany([importedComment('collide-sequential', null)]);

        if (parent === undefined) {
            throw new Error('The parent comment was not persisted.');
        }

        const externalCommentId = toExternalCommentId('integration-converging-sequential');
        const useCase = new ReplyToComment(
            contexts,
            new Map<SocialPlatform, SocialCommentsGateway>([
                [toSocialPlatform('demo'), new ConvergingGateway(externalCommentId)],
            ]),
            comments,
        );
        const owner = toIdempotencyKey('integration-key-owner');
        const loser = toIdempotencyKey('integration-key-loser');
        const request = {parentCommentId: parent.id, content: 'Converging'};

        const first = await useCase.execute({...request, idempotencyKey: owner});
        const second = await useCase.execute({...request, idempotencyKey: loser});
        const repeated = await useCase.execute({...request, idempotencyKey: loser});
        const rows = await sql<KeyedRow[]>`
            select id, idempotency_key from comments
            where post_id = ${fixturePostId} and external_comment_id = ${externalCommentId}
        `;

        expect(first.ok).toBe(true);
        expect(second).toEqual({
            ok: false,
            error: {code: 'IDEMPOTENCY_CONFLICT', idempotencyKey: loser},
        });
        expect(repeated).toEqual({
            ok: false,
            error: {code: 'IDEMPOTENCY_CONFLICT', idempotencyKey: loser},
        });
        expect(rows).toHaveLength(1);
        expect(rows.at(0)?.idempotency_key).toBe(owner);
        expect(await comments.findByIdempotencyKey(loser)).toBeNull();
    });

    it('resolves a concurrent different-key collision as one row and one conflict', async () => {
        const comments = new PostgresCommentRepository(sql);
        const contexts = new PostgresCommentReplyContextRepository(sql);
        const [parent] = await comments.saveMany([importedComment('collide-parent', null)]);

        if (parent === undefined) {
            throw new Error('The parent comment was not persisted.');
        }

        const externalCommentId = toExternalCommentId('integration-converging-concurrent');
        const useCase = new ReplyToComment(
            contexts,
            new Map<SocialPlatform, SocialCommentsGateway>([
                [
                    toSocialPlatform('demo'),
                    new ConvergingGateway(externalCommentId, new Barrier(2)),
                ],
            ]),
            comments,
        );
        const first = toIdempotencyKey('integration-key-collide-a');
        const second = toIdempotencyKey('integration-key-collide-b');
        const request = {parentCommentId: parent.id, content: 'Collide'};

        // Neither call rejects: a unique-constraint violation would surface here as a rejection.
        const results = await Promise.all([
            useCase.execute({...request, idempotencyKey: first}),
            useCase.execute({...request, idempotencyKey: second}),
        ]);
        const rows = await sql<KeyedRow[]>`
            select id, idempotency_key from comments
            where post_id = ${fixturePostId} and external_comment_id = ${externalCommentId}
        `;
        const claimed = await sql<KeyedRow[]>`
            select id, idempotency_key from comments
            where idempotency_key in (${first}, ${second})
        `;
        const outcomes = results.map((result): string | null =>
            result.ok ? (result.value.comment.idempotencyKey ?? null) : result.error.code);

        expect(rows).toHaveLength(1);
        expect(claimed).toHaveLength(1);
        expect(rows.at(0)?.idempotency_key).toBe(claimed.at(0)?.idempotency_key);
        expect(outcomes.filter((outcome): boolean => outcome === 'IDEMPOTENCY_CONFLICT'))
            .toHaveLength(1);
        expect(outcomes).toContain(rows.at(0)?.idempotency_key);
    });
});

/**
 * A controlled platform that deduplicates on its own side, the way a provider honouring an
 * idempotency token does. The barrier holds both callers inside the publish call, so neither the
 * local key lookup nor any PostgreSQL lock can be what prevents the second external effect: only
 * the provider guarantee can.
 */
class ProviderIdempotentGateway implements SocialCommentsGateway {
    public externalPublications = 0;

    private readonly publishedByKey = new Map<string, PlatformComment>();

    public constructor(private readonly barrier: Barrier) {}

    public getComments(): never {
        throw new Error('This gateway only publishes.');
    }

    public getReplies(): never {
        throw new Error('This gateway only publishes.');
    }

    public async replyToComment(
        input: ReplyToPlatformCommentInput,
    ): Promise<Result<PlatformComment, PlatformFailure | IndeterminatePlatformResultFailure>> {
        await this.barrier.arrive();

        const alreadyPublished = this.publishedByKey.get(input.idempotencyKey);

        if (alreadyPublished !== undefined) {
            return ok<PlatformComment>(alreadyPublished);
        }

        this.externalPublications += 1;

        const published: PlatformComment = {
            externalCommentId: toExternalCommentId(`integration-provider-${input.idempotencyKey}`),
            externalAuthorId: toExternalAuthorId('integration-author-self'),
            content: input.content,
            createdAt: platformCreatedAt,
            metadata: null,
        };

        this.publishedByKey.set(input.idempotencyKey, published);

        return ok<PlatformComment>(published);
    }
}

describe('external publication under concurrency', () => {
    it('creates one external publication for two concurrent requests with one key', async () => {
        const comments = new PostgresCommentRepository(sql);
        const contexts = new PostgresCommentReplyContextRepository(sql);
        const [parent] = await comments.saveMany([importedComment('provider-idempotent', null)]);

        if (parent === undefined) {
            throw new Error('The parent comment was not persisted.');
        }

        const gateway = new ProviderIdempotentGateway(new Barrier(2));
        const useCase = new ReplyToComment(
            contexts,
            new Map<SocialPlatform, SocialCommentsGateway>([[toSocialPlatform('demo'), gateway]]),
            comments,
        );
        const key = toIdempotencyKey('integration-key-provider');
        const request = {
            parentCommentId: parent.id,
            content: 'Concurrent publication',
            idempotencyKey: key,
        };

        // Neither call rejects: a database exception would surface here as a rejected promise.
        const results = await Promise.all([useCase.execute(request), useCase.execute(request)]);
        const rows = await sql<IdRow[]>`
            select id from comments where idempotency_key = ${key}
        `;
        const identifiers = results.map((result): string =>
            result.ok ? result.value.comment.id : `failed:${result.error.code}`);

        expect(gateway.externalPublications).toBe(1);
        expect(results.every((result): boolean => result.ok)).toBe(true);
        expect(new Set(identifiers).size).toBe(1);
        expect(rows).toHaveLength(1);
        expect(identifiers.at(0)).toBe(rows.at(0)?.id);
    });
});

describe('comment parent and post consistency', () => {
    const insertComment = async (
        postId: string,
        parentCommentId: string | null,
        suffix: string,
    ): Promise<readonly IdRow[]> =>
        await sql<IdRow[]>`
            insert into comments (
                post_id, parent_comment_id, external_comment_id, external_author_id,
                content, platform_created_at
            ) values (
                ${postId}, ${parentCommentId}, ${`integration-consistency-${suffix}`},
                'integration-author-consistency', ${`Consistency ${suffix}`}, ${platformCreatedAt}
            )
            returning id
        `;

    it('accepts a root comment, a direct reply, and a reply to that reply', async () => {
        const [root] = await insertComment(fixturePostId, null, 'root');

        if (root === undefined) {
            throw new Error('The root comment was not inserted.');
        }

        const [reply] = await insertComment(fixturePostId, root.id, 'reply');

        if (reply === undefined) {
            throw new Error('The reply was not inserted.');
        }

        const [deeper] = await insertComment(fixturePostId, reply.id, 'deeper');

        expect(deeper?.id).toBeDefined();
    });

    it('rejects a reply whose parent belongs to another post', async () => {
        const otherPosts = await sql<IdRow[]>`
            insert into posts (account_id, external_post_id, published_at)
            values (${fixtureAccountId}, 'integration-other-post', now())
            on conflict (account_id, external_post_id) do update set updated_at = now()
            returning id
        `;
        const otherPost = otherPosts.at(0);

        if (otherPost === undefined) {
            throw new Error('The second post fixture was not created.');
        }

        const [parent] = await insertComment(fixturePostId, null, 'cross-parent');

        if (parent === undefined) {
            throw new Error('The parent comment was not inserted.');
        }

        await expect(insertComment(otherPost.id, parent.id, 'cross-child')).rejects.toThrow(
            /comments_parent_comment_same_post_fkey/u,
        );

        const orphans = await sql<IdRow[]>`
            select id from comments where external_comment_id = 'integration-consistency-cross-child'
        `;

        expect(orphans).toEqual([]);
    });

    it('keeps the unique key that supports the composite reference', async () => {
        const constraints = await sql<{conname: string}[]>`
            select conname from pg_constraint
            where conrelid = 'comments'::regclass
              and conname in (
                  'comments_id_post_id_key',
                  'comments_parent_comment_same_post_fkey'
              )
            order by conname
        `;

        expect(constraints.map((row): string => row.conname)).toEqual([
            'comments_id_post_id_key',
            'comments_parent_comment_same_post_fkey',
        ]);
    });
});

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

    it('rejects a malformed post identifier before it reaches PostgreSQL', async () => {
        const response = await fetch(`${baseUrl}/posts/not-a-uuid/comments`);
        const body = (await response.json()) as HttpErrorEnvelope;

        expect(response.status).toBe(400);
        expect(body.error.code).toBe('VALIDATION_ERROR');
        expect(body.error.message).toBe('Request validation failed');
        expect(body.error.requestId.length).toBeGreaterThan(0);
    });

    it('rejects a malformed comment identifier before it reaches PostgreSQL', async () => {
        const response = await fetch(`${baseUrl}/comments/not-a-uuid/replies`);
        const body = (await response.json()) as HttpErrorEnvelope;

        expect(response.status).toBe(400);
        expect(body.error.code).toBe('VALIDATION_ERROR');
        expect(body.error.message).toBe('Request validation failed');
        expect(body.error.requestId.length).toBeGreaterThan(0);
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

    it('does not match GET on the publication route', async () => {
        const response = await fetch(`${baseUrl}/comments`);
        const body = (await response.json()) as HttpErrorEnvelope;

        expect(response.status).toBe(404);
        expect(body.error.code).toBe('ROUTE_NOT_FOUND');
    });

    describe('publication', () => {
        const publish = async (
            body: string,
            idempotencyKey: string | null,
        ): Promise<Response> =>
            await fetch(`${baseUrl}/comments`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    ...(idempotencyKey === null ? {} : {'idempotency-key': idempotencyKey}),
                },
                body,
            });

        const rootCommentId = async (): Promise<string> => {
            const page = await readPage(`/posts/${DEMO_POST_ID}/comments`);
            const parent = page.items.find(
                (item): boolean => item.externalCommentId === 'demo-comment-1',
            );

            if (parent === undefined) {
                throw new Error('The demo root comment was not returned.');
            }

            return parent.id;
        };

        it('creates a reply and returns 201 with the public comment shape', async () => {
            const parentCommentId = await rootCommentId();
            const response = await publish(
                JSON.stringify({parentCommentId, content: 'Thank you for your comment'}),
                'rest-key-1',
            );
            const body = (await response.json()) as CommentResponse;

            expect(response.status).toBe(201);
            expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
            expect(body.parentCommentId).toBe(parentCommentId);
            expect(body.postId).toBe(DEMO_POST_ID);
            expect(body.content).toBe('Thank you for your comment');
            expect(Object.keys(body).sort()).toEqual([
                'content',
                'createdAt',
                'externalAuthorId',
                'externalCommentId',
                'id',
                'parentCommentId',
                'platformCreatedAt',
                'postId',
                'updatedAt',
            ]);
        });

        it('persists the created reply in PostgreSQL', async () => {
            const parentCommentId = await rootCommentId();
            const response = await publish(
                JSON.stringify({parentCommentId, content: 'Persisted reply'}),
                'rest-key-2',
            );
            const body = (await response.json()) as CommentResponse;
            const rows = await sql<{content: string; idempotency_key: string | null}[]>`
                select content, idempotency_key from comments where id = ${body.id}
            `;

            expect(rows.at(0)).toEqual({content: 'Persisted reply', idempotency_key: 'rest-key-2'});
        });

        it('replays an identical request with 200 and the same identifier', async () => {
            const parentCommentId = await rootCommentId();
            const body = JSON.stringify({parentCommentId, content: 'Replayed reply'});

            const first = await publish(body, 'rest-key-3');
            const created = (await first.json()) as CommentResponse;
            const second = await publish(body, 'rest-key-3');
            const replayed = (await second.json()) as CommentResponse;

            expect(first.status).toBe(201);
            expect(second.status).toBe(200);
            expect(replayed.id).toBe(created.id);
        });

        it('reports a conflict when the same key carries different content', async () => {
            const parentCommentId = await rootCommentId();

            await publish(
                JSON.stringify({parentCommentId, content: 'Original content'}),
                'rest-key-4',
            );
            const response = await publish(
                JSON.stringify({parentCommentId, content: 'Different content'}),
                'rest-key-4',
            );
            const body = (await response.json()) as HttpErrorEnvelope;

            expect(response.status).toBe(409);
            expect(body.error.code).toBe('IDEMPOTENCY_CONFLICT');
            expect(body.error.message).toBe('Idempotency key conflicts with an existing request');
            expect(JSON.stringify(body)).not.toContain('rest-key-4');
        });

        it('reports a conflict when the same key targets a different parent', async () => {
            const parentCommentId = await rootCommentId();
            const page = await readPage(`/posts/${DEMO_POST_ID}/comments`);
            const otherParent = page.items.find(
                (item): boolean => item.externalCommentId === 'demo-comment-2',
            );

            if (otherParent === undefined) {
                throw new Error('The second demo root comment was not returned.');
            }

            await publish(JSON.stringify({parentCommentId, content: 'Same content'}), 'rest-key-5');
            const response = await publish(
                JSON.stringify({parentCommentId: otherParent.id, content: 'Same content'}),
                'rest-key-5',
            );

            expect(response.status).toBe(409);
        });

        it.each([
            ['a missing idempotency key', '{"parentCommentId":"x","content":"y"}', null],
            ['an empty idempotency key', '{"parentCommentId":"x","content":"y"}', '   '],
            ['malformed JSON', '{not json', 'rest-key-invalid'],
            ['a body that is not an object', '["array"]', 'rest-key-invalid'],
            ['a missing parent', '{"content":"y"}', 'rest-key-invalid'],
            ['a malformed parent uuid', '{"parentCommentId":"nope","content":"y"}', 'rest-key-invalid'],
            [
                'missing content',
                '{"parentCommentId":"0198f000-0000-7000-8000-0000000000aa"}',
                'rest-key-invalid',
            ],
            [
                'blank content',
                '{"parentCommentId":"0198f000-0000-7000-8000-0000000000aa","content":"   "}',
                'rest-key-invalid',
            ],
            [
                'non-string content',
                '{"parentCommentId":"0198f000-0000-7000-8000-0000000000aa","content":42}',
                'rest-key-invalid',
            ],
        ])('rejects %s with a validation error', async (
            _name: string,
            body: string,
            idempotencyKey: string | null,
        ) => {
            const response = await publish(body, idempotencyKey);
            const envelope = (await response.json()) as HttpErrorEnvelope;

            expect(response.status).toBe(400);
            expect(envelope.error.code).toBe('VALIDATION_ERROR');
            expect(envelope.error.message).toBe('Request validation failed');
            expect(envelope.error.requestId.length).toBeGreaterThan(0);
        });

        it('reports an unknown parent comment as not found', async () => {
            const response = await publish(
                JSON.stringify({
                    parentCommentId: '0198f000-0000-7000-8000-0000000000ac',
                    content: 'Orphan reply',
                }),
                'rest-key-6',
            );
            const body = (await response.json()) as HttpErrorEnvelope;

            expect(response.status).toBe(404);
            expect(body.error.code).toBe('COMMENT_NOT_FOUND');
        });

        it('publishes a reply to a reply and exposes it through the replies endpoint', async () => {
            const parentCommentId = await rootCommentId();
            const first = await publish(
                JSON.stringify({parentCommentId, content: 'Depth one'}),
                'rest-key-7',
            );
            const created = (await first.json()) as CommentResponse;

            const second = await publish(
                JSON.stringify({parentCommentId: created.id, content: 'Depth two'}),
                'rest-key-8',
            );
            const deeper = (await second.json()) as CommentResponse;
            const replies = await readPage(`/comments/${created.id}/replies`);

            expect(second.status).toBe(201);
            expect(deeper.parentCommentId).toBe(created.id);
            expect(replies.items.map((item): string => item.id)).toContain(deeper.id);
        });

        it('maps a platform rate limit to 429 and an indeterminate result to 502', async () => {
            const imported = await sql<IdRow[]>`
                insert into comments (
                    post_id, external_comment_id, external_author_id, content, platform_created_at
                ) values
                    (${DEMO_POST_ID}, 'demo-rate-limited', 'demo-author', 'x', now()),
                    (${DEMO_POST_ID}, 'demo-indeterminate', 'demo-author', 'y', now())
                on conflict (post_id, external_comment_id) do update set updated_at = now()
                returning id
            `;
            const [rateLimited, indeterminate] = [imported.at(0), imported.at(1)];

            if (rateLimited === undefined || indeterminate === undefined) {
                throw new Error('The failure-trigger comments were not persisted.');
            }

            const limited = await publish(
                JSON.stringify({parentCommentId: rateLimited.id, content: 'Rate limited'}),
                'rest-key-9',
            );
            const unknown = await publish(
                JSON.stringify({parentCommentId: indeterminate.id, content: 'Unknown outcome'}),
                'rest-key-10',
            );
            const unknownBody = (await unknown.json()) as HttpErrorEnvelope;
            const stored = await sql<IdRow[]>`
                select id from comments where idempotency_key in ('rest-key-9', 'rest-key-10')
            `;

            expect(limited.status).toBe(429);
            expect(unknown.status).toBe(502);
            expect(unknownBody.error.code).toBe('INDETERMINATE_PLATFORM_RESULT');
            expect(stored).toEqual([]);
        });
    });
});
