import {describe, expect, it} from 'vitest';
import {DemoSocialCommentsGateway}
    from '../apps/api/src/adapters/demo/demo-comments-gateway.js';
import {
    GetPostComments,
    toAccountId,
    toCursor,
    toExternalCommentId,
    toExternalPostId,
    toPostId,
    toSocialPlatform,
    type Comment,
    type CommentRepository,
    type Cursor,
    type NormalizedComment,
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

    it('treats a cursor it did not issue as an empty page instead of throwing', async () => {
        const page = okPage(
            await new DemoSocialCommentsGateway().getComments({
                accountId,
                externalPostId: demoPost,
                cursor: toCursor('not-a-demo-cursor'),
            }),
        );

        expect(page).toEqual({items: [], nextCursor: null});
    });

    it('translates a platform authentication failure', async () => {
        const result = await new DemoSocialCommentsGateway().getComments({
            accountId,
            externalPostId: toExternalPostId('demo-authentication-failure'),
            cursor: null,
        });

        expect(failureOf(result)).toEqual({code: 'PLATFORM_AUTHENTICATION_FAILED'});
    });

    it('translates a platform rate limit failure', async () => {
        const result = await new DemoSocialCommentsGateway().getComments({
            accountId,
            externalPostId: toExternalPostId('demo-rate-limited'),
            cursor: null,
        });

        expect(failureOf(result)).toEqual({code: 'PLATFORM_RATE_LIMITED'});
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
            getComments: (): Promise<Result<PlatformCommentPage, PlatformFailure>> => {
                recorded.push(platform);

                return Promise.resolve({
                    ok: true,
                    value: {items: [], nextCursor: null satisfies Cursor | null},
                });
            },
            getReplies: (): Promise<Result<PlatformCommentPage, PlatformFailure>> =>
                Promise.resolve({ok: true, value: {items: [], nextCursor: null}}),
        });
        const comments: CommentRepository = {
            saveMany: (stored: readonly NormalizedComment[]): Promise<readonly Comment[]> => {
                expect(stored).toEqual([]);

                return Promise.resolve([]);
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
