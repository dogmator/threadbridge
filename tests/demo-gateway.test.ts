import {describe, expect, it} from 'vitest';
import {DemoSocialCommentsGateway}
    from '../apps/api/src/adapters/demo/demo-comments-gateway.js';
import {
    GetPostComments,
    toAccountId,
    toCursor,
    toExternalCommentId,
    toExternalPostId,
    toIdempotencyKey,
    toPostId,
    toSocialPlatform,
    type Comment,
    type CommentRepository,
    type Cursor,
    type NormalizedComment,
    type IndeterminatePlatformResultFailure,
    type PlatformComment,
    type PlatformCommentPage,
    type PlatformFailure,
    type PublishedPostContext,
    type PublishedPostRepository,
    type Result,
    type SocialCommentsGateway,
    type SocialPlatform,
} from '@threadbridge/comments';

const accountId = toAccountId('account-1');
const demoPost = toExternalPostId('demo-post-1');

const okPage = (result: Result<PlatformCommentPage, PlatformFailure>): PlatformCommentPage => {
    if (!result.ok) {
        throw new Error(`Expected a page, received ${result.error.code}.`);
    }

    return result.value;
};

const failureOf = (result: Result<PlatformCommentPage, PlatformFailure>): PlatformFailure => {
    if (result.ok) {
        throw new Error('Expected a platform failure.');
    }

    return result.error;
};

describe('DemoSocialCommentsGateway', () => {
    it('returns the first page of root comments', async () => {
        const page = okPage(
            await new DemoSocialCommentsGateway().getComments({
                accountId,
                externalPostId: demoPost,
                cursor: null,
            }),
        );

        expect(page.items.map((item): string => item.externalCommentId)).toEqual([
            'demo-comment-1',
            'demo-comment-2',
        ]);
        expect(page.nextCursor).not.toBeNull();
    });

    it('returns the second page for the cursor of the first page', async () => {
        const gateway = new DemoSocialCommentsGateway();
        const first = okPage(
            await gateway.getComments({accountId, externalPostId: demoPost, cursor: null}),
        );

        const second = okPage(
            await gateway.getComments({
                accountId,
                externalPostId: demoPost,
                cursor: first.nextCursor,
            }),
        );

        expect(second.items.map((item): string => item.externalCommentId)).toEqual([
            'demo-comment-3',
        ]);
        expect(second.nextCursor).toBeNull();
    });

    it('returns the direct replies of a comment', async () => {
        const page = okPage(
            await new DemoSocialCommentsGateway().getReplies({
                accountId,
                externalParentCommentId: toExternalCommentId('demo-comment-1'),
                cursor: null,
            }),
        );

        expect(page.items.map((item): string => item.externalCommentId)).toEqual([
            'demo-comment-1-reply-1',
            'demo-comment-1-reply-2',
        ]);
        expect(page.nextCursor).toBeNull();
    });

    it('reports a cursor it did not issue as invalid', async () => {
        const result = await new DemoSocialCommentsGateway().getComments({
            accountId,
            externalPostId: demoPost,
            cursor: toCursor('not-a-demo-cursor'),
        });

        expect(failureOf(result)).toEqual({code: 'PLATFORM_CURSOR_INVALID'});
    });

    it('translates a platform authentication failure', async () => {
        const result = await new DemoSocialCommentsGateway().getComments({
            accountId,
            externalPostId: toExternalPostId('demo-authentication-failure'),
            cursor: null,
        });

        expect(failureOf(result)).toEqual({code: 'PLATFORM_AUTHENTICATION_FAILED'});
    });

    it('translates a platform rate limit failure with a retry hint', async () => {
        const result = await new DemoSocialCommentsGateway().getComments({
            accountId,
            externalPostId: toExternalPostId('demo-rate-limited'),
            cursor: null,
        });

        expect(failureOf(result)).toEqual({
            code: 'PLATFORM_RATE_LIMITED',
            retryAfterSeconds: 30,
        });
    });

    it('translates a platform unavailable failure for replies as well', async () => {
        const result = await new DemoSocialCommentsGateway().getReplies({
            accountId,
            externalParentCommentId: toExternalCommentId('demo-unavailable'),
            cursor: null,
        });

        expect(failureOf(result)).toEqual({code: 'PLATFORM_UNAVAILABLE'});
    });
});

const key = (value: string): ReturnType<typeof toIdempotencyKey> => toIdempotencyKey(value);

const publishedOf = (
    result: Result<PlatformComment, PlatformFailure | IndeterminatePlatformResultFailure>,
): PlatformComment => {
    if (!result.ok) {
        throw new Error(`Expected a published reply, received ${result.error.code}.`);
    }

    return result.value;
};

const publicationFailureOf = (
    result: Result<PlatformComment, PlatformFailure | IndeterminatePlatformResultFailure>,
): PlatformFailure | IndeterminatePlatformResultFailure => {
    if (result.ok) {
        throw new Error('Expected a platform failure.');
    }

    return result.error;
};

const parentOf = (value: string): ReturnType<typeof toExternalCommentId> =>
    toExternalCommentId(value);

describe('DemoSocialCommentsGateway publication', () => {
    it('publishes a deterministic reply', async () => {
        const published = publishedOf(
            await new DemoSocialCommentsGateway().replyToComment({
                accountId,
                externalParentCommentId: parentOf('demo-comment-1'),
                content: 'Thank you',
                idempotencyKey: key('key-1'),
            }),
        );

        expect(published.externalCommentId).toBe('demo-published-key-1');
        expect(published.content).toBe('Thank you');
    });

    it('returns the original reply for a repeated key with identical input', async () => {
        const gateway = new DemoSocialCommentsGateway();
        const input = {
            accountId,
            externalParentCommentId: parentOf('demo-comment-1'),
            content: 'Thank you',
            idempotencyKey: key('key-2'),
        };

        const first = publishedOf(await gateway.replyToComment(input));
        const second = publishedOf(await gateway.replyToComment(input));

        expect(second).toEqual(first);
    });

    it('creates one external reply for concurrent publications of one key', async () => {
        const gateway = new DemoSocialCommentsGateway();
        // A parent without reply fixtures, so the single page returned holds only what is published
        // here and the assertion cannot be satisfied by fixture data.
        const parent = parentOf('demo-comment-2');
        const input = {
            accountId,
            externalParentCommentId: parent,
            content: 'Concurrent',
            idempotencyKey: key('key-concurrent'),
        };

        // The adapter deduplicates on its own side, which is what an application-level guarantee
        // cannot provide: the local database is not involved here at all.
        const published = await Promise.all([
            gateway.replyToComment(input),
            gateway.replyToComment(input),
            gateway.replyToComment(input),
        ]);
        const externalIds = published.map(
            (result): string => publishedOf(result).externalCommentId,
        );
        const page = okPage(
            await gateway.getReplies({
                accountId,
                externalParentCommentId: parent,
                cursor: null,
            }),
        );

        expect(new Set(externalIds).size).toBe(1);
        expect(page.items.filter((item): boolean => item.content === 'Concurrent')).toHaveLength(1);
    });

    it('creates no second external reply for a repeated key with different input', async () => {
        const gateway = new DemoSocialCommentsGateway();
        const parent = parentOf('demo-comment-2');

        await gateway.replyToComment({
            accountId,
            externalParentCommentId: parent,
            content: 'Original',
            idempotencyKey: key('key-3'),
        });
        const second = publishedOf(
            await gateway.replyToComment({
                accountId,
                externalParentCommentId: parent,
                content: 'Changed',
                idempotencyKey: key('key-3'),
            }),
        );
        const page = okPage(
            await gateway.getReplies({
                accountId,
                externalParentCommentId: parent,
                cursor: null,
            }),
        );

        expect(second.content).toBe('Original');
        expect(page.items).toHaveLength(1);
    });

    it('returns a published reply through getReplies', async () => {
        const gateway = new DemoSocialCommentsGateway();
        const parent = parentOf('demo-comment-3');

        const published = publishedOf(
            await gateway.replyToComment({
                accountId,
                externalParentCommentId: parent,
                content: 'Visible afterwards',
                idempotencyKey: key('key-4'),
            }),
        );
        const page = okPage(
            await gateway.getReplies({accountId, externalParentCommentId: parent, cursor: null}),
        );

        expect(page.items.map((item): string => item.externalCommentId)).toEqual([
            published.externalCommentId,
        ]);
    });

    it('publishes a reply to a reply', async () => {
        const gateway = new DemoSocialCommentsGateway();

        const published = publishedOf(
            await gateway.replyToComment({
                accountId,
                externalParentCommentId: parentOf('demo-comment-1-reply-1'),
                content: 'Deeper',
                idempotencyKey: key('key-5'),
            }),
        );
        const page = okPage(
            await gateway.getReplies({
                accountId,
                externalParentCommentId: parentOf('demo-comment-1-reply-1'),
                cursor: null,
            }),
        );

        expect(page.items.map((item): string => item.externalCommentId)).toEqual([
            published.externalCommentId,
        ]);
    });

    it('does not add a published reply to the root comment fixtures', async () => {
        const gateway = new DemoSocialCommentsGateway();

        await gateway.replyToComment({
            accountId,
            externalParentCommentId: parentOf('demo-comment-1'),
            content: 'Not a root comment',
            idempotencyKey: key('key-6'),
        });
        const roots = okPage(
            await gateway.getComments({accountId, externalPostId: demoPost, cursor: null}),
        );

        expect(roots.items.map((item): string => item.externalCommentId)).toEqual([
            'demo-comment-1',
            'demo-comment-2',
        ]);
    });

    it.each([
        ['demo-authentication-failure', 'PLATFORM_AUTHENTICATION_FAILED'],
        ['demo-rate-limited', 'PLATFORM_RATE_LIMITED'],
        ['demo-unavailable', 'PLATFORM_UNAVAILABLE'],
        ['demo-indeterminate', 'INDETERMINATE_PLATFORM_RESULT'],
    ])('translates %s into %s', async (parent: string, code: string) => {
        const result = await new DemoSocialCommentsGateway().replyToComment({
            accountId,
            externalParentCommentId: parentOf(parent),
            content: 'Whatever',
            idempotencyKey: key(`key-${parent}`),
        });

        expect(publicationFailureOf(result).code).toBe(code);
    });
});

describe('platform registration', () => {
    it('routes to a second registered gateway without changing application code', async () => {
        const secondPlatform = toSocialPlatform('second');
        const context: PublishedPostContext = {
            accountId,
            platform: secondPlatform,
            externalPostId: demoPost,
        };
        const posts: PublishedPostRepository = {
            findContextByPostId: (): Promise<PublishedPostContext | null> =>
                Promise.resolve(context),
        };
        const recorded: SocialPlatform[] = [];
        const recordingGateway = (platform: SocialPlatform): SocialCommentsGateway => ({
            capabilities: {
                rootComments: true,
                directReplies: true,
                replyPublication: false,
                publicationIdempotency: 'none',
            },
            getComments: (): Promise<Result<PlatformCommentPage, PlatformFailure>> => {
                recorded.push(platform);

                return Promise.resolve({
                    ok: true,
                    value: {items: [], nextCursor: null satisfies Cursor | null},
                });
            },
            getReplies: (): Promise<Result<PlatformCommentPage, PlatformFailure>> =>
                Promise.resolve({ok: true, value: {items: [], nextCursor: null}}),
            replyToComment: (): never => {
                throw new Error('Retrieval must not publish replies.');
            },
        });
        const comments: CommentRepository = {
            saveMany: (stored: readonly NormalizedComment[]): Promise<readonly Comment[]> => {
                expect(stored).toEqual([]);

                return Promise.resolve([]);
            },
            findByIdempotencyKey: (): never => {
                throw new Error('Retrieval must not look up idempotency keys.');
            },
            savePublishedReply: (): never => {
                throw new Error('Retrieval must not publish replies.');
            },
        };
        const useCase = new GetPostComments(
            posts,
            new Map<SocialPlatform, SocialCommentsGateway>([
                [toSocialPlatform('demo'), recordingGateway(toSocialPlatform('demo'))],
                [secondPlatform, recordingGateway(secondPlatform)],
            ]),
            comments,
        );

        const result = await useCase.execute({postId: toPostId('post-1')});

        expect(result.ok).toBe(true);
        expect(recorded).toEqual([secondPlatform]);
    });
});
