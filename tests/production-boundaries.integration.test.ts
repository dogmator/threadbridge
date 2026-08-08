import {resolve} from 'node:path';
import postgres from 'postgres';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {DemoSocialCommentsGateway}
    from '../apps/api/src/adapters/demo/demo-comments-gateway.js';
import {PostgresCommentReplyContextRepository}
    from '../apps/api/src/adapters/postgres/comment-reply-context-repository.js';
import {PostgresCommentRepository}
    from '../apps/api/src/adapters/postgres/comment-repository.js';
import {PostgresPublishedPostRepository}
    from '../apps/api/src/adapters/postgres/published-post-repository.js';
import {PostgresReplyPublicationOperationRepository}
    from '../apps/api/src/adapters/postgres/reply-publication-operation-repository.js';
import {runMigrations} from '../apps/api/src/migrations.js';
import {
    GetPostComments,
    toAccountId,
    toCommentId,
    toExternalAuthorId,
    toExternalCommentId,
    toIdempotencyKey,
    toPostId,
    toSocialPlatform,
    type AccountId,
    type CommentId,
    type PostId,
} from '@threadbridge/comments';

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL is required to run production-boundary integration tests.');
}

const sql = postgres(databaseUrl, {onnotice: (): void => undefined});
const migrationsDirectory = resolve(process.cwd(), 'db/migrations');
const prefix = `boundary-${String(process.pid)}`;

interface IdRow {
    readonly id: string;
}

let firstAccountId: AccountId;
let secondAccountId: AccountId;
let firstPostId: PostId;
let secondPostId: PostId;
let firstParentId: CommentId;
let secondParentId: CommentId;

const createAccountAndPost = async (suffix: string): Promise<readonly [AccountId, PostId]> => {
    const accounts = await sql<IdRow[]>`
        insert into accounts (platform, external_account_id)
        values ('demo', ${`${prefix}-account-${suffix}`})
        returning id
    `;
    const account = accounts.at(0);

    if (account === undefined) {
        throw new Error('The boundary account was not created.');
    }

    const posts = await sql<IdRow[]>`
        insert into posts (account_id, external_post_id, published_at)
        values (${account.id}, ${`${prefix}-post-${suffix}`}, now())
        returning id
    `;
    const post = posts.at(0);

    if (post === undefined) {
        throw new Error('The boundary post was not created.');
    }

    return [toAccountId(account.id), toPostId(post.id)];
};

const createParent = async (postId: PostId, suffix: string): Promise<CommentId> => {
    const comments = new PostgresCommentRepository(sql);
    const [parent] = await comments.saveMany([{
        postId,
        parentCommentId: null,
        externalCommentId: toExternalCommentId(`${prefix}-comment-${suffix}`),
        externalAuthorId: toExternalAuthorId(`${prefix}-author-${suffix}`),
        content: `Parent ${suffix}`,
        platformCreatedAt: new Date('2026-08-01T00:00:00.000Z'),
        metadata: null,
    }]);

    if (parent === undefined) {
        throw new Error('The boundary parent was not created.');
    }

    return parent.id;
};

beforeAll(async (): Promise<void> => {
    await runMigrations(sql, migrationsDirectory);
    [firstAccountId, firstPostId] = await createAccountAndPost('a');
    [secondAccountId, secondPostId] = await createAccountAndPost('b');
    firstParentId = await createParent(firstPostId, 'a');
    secondParentId = await createParent(secondPostId, 'b');
});

afterAll(async (): Promise<void> => {
    await sql`
        delete from reply_publication_operations
        where account_id in (${firstAccountId}, ${secondAccountId})
    `;
    await sql`delete from comments where post_id in (${firstPostId}, ${secondPostId})`;
    await sql`delete from posts where id in (${firstPostId}, ${secondPostId})`;
    await sql`delete from accounts where id in (${firstAccountId}, ${secondAccountId})`;
    await sql.end();
});

describe('production boundary persistence', () => {
    it('scopes the same idempotency key independently to each account', async () => {
        const operations = new PostgresReplyPublicationOperationRepository(sql);
        const key = toIdempotencyKey(`${prefix}-same-key`);

        const first = await operations.begin({
            accountId: firstAccountId,
            parentCommentId: firstParentId,
            idempotencyKey: key,
            requestFingerprint: 'first',
        });
        const second = await operations.begin({
            accountId: secondAccountId,
            parentCommentId: secondParentId,
            idempotencyKey: key,
            requestFingerprint: 'second',
        });

        expect(first.kind).toBe('started');
        expect(second.kind).toBe('started');
    });

    it('detects conflicting reuse inside one account before a provider call', async () => {
        const operations = new PostgresReplyPublicationOperationRepository(sql);
        const key = toIdempotencyKey(`${prefix}-conflict`);

        await operations.begin({
            accountId: firstAccountId,
            parentCommentId: firstParentId,
            idempotencyKey: key,
            requestFingerprint: 'one',
        });
        const conflict = await operations.begin({
            accountId: firstAccountId,
            parentCommentId: firstParentId,
            idempotencyKey: key,
            requestFingerprint: 'two',
        });

        expect(conflict).toEqual({kind: 'conflict'});
    });

    it('excludes an explicitly deleted parent and reactivates it when observed again', async () => {
        const contexts = new PostgresCommentReplyContextRepository(sql);
        const comments = new PostgresCommentRepository(sql);

        await contexts.markDeleted(firstParentId);
        expect(await contexts.findByCommentId(firstParentId)).toBeNull();

        const [reactivated] = await comments.saveMany([{
            postId: firstPostId,
            parentCommentId: null,
            externalCommentId: toExternalCommentId(`${prefix}-comment-a`),
            externalAuthorId: toExternalAuthorId(`${prefix}-author-a`),
            content: 'Parent a observed again',
            platformCreatedAt: new Date('2026-08-01T00:00:00.000Z'),
            metadata: null,
        }]);

        expect(reactivated?.id).toBe(firstParentId);
        expect(await contexts.findByCommentId(toCommentId(firstParentId))).not.toBeNull();
    });

    it('does not delete an active projection when a provider page omits it', async () => {
        const contexts = new PostgresCommentReplyContextRepository(sql);
        const useCase = new GetPostComments(
            new PostgresPublishedPostRepository(sql),
            new Map([
                [toSocialPlatform('demo'), new DemoSocialCommentsGateway()],
            ]),
            new PostgresCommentRepository(sql),
        );

        const result = await useCase.execute({postId: secondPostId});

        expect(result).toEqual({ok: true, value: {items: [], nextCursor: null}});
        expect(await contexts.findByCommentId(secondParentId)).not.toBeNull();
    });
});
