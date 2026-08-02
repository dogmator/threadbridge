import {describe, expect, it} from 'vitest';
import {
    err,
    GetCommentReplies,
    GetPostComments,
    ok,
    toAccountId,
    toCommentId,
    toCursor,
    toExternalAuthorId,
    toExternalCommentId,
    toExternalPostId,
    toPostId,
    toSocialPlatform,
    type Comment,
    type CommentPage,
    type CommentReplyContext,
    type CommentReplyContextRepository,
    type CommentRepository,
    type CommentsFailure,
    type GetCommentRepliesQuery,
    type GetPostCommentsQuery,
    type NormalizedComment,
    type PlatformComment,
    type PlatformCommentPage,
    type PublishedPostContext,
    type PublishedPostRepository,
    type Result,
    type SocialCommentsGateway,
    type SocialPlatform,
} from '@threadbridge/comments';

describe('@threadbridge/comments package entry point', () => {
    it('exposes the implemented use cases as constructible classes', () => {
        expect(typeof GetPostComments).toBe('function');
        expect(typeof GetCommentReplies).toBe('function');
    });

    it('exposes the result constructors', () => {
        expect(ok('value')).toEqual({ok: true, value: 'value'});
        expect(err('failure')).toEqual({ok: false, error: 'failure'});
    });

    it('exposes every identifier constructor', () => {
        expect([
            toAccountId('account-1'),
            toCommentId('comment-1'),
            toCursor('cursor-1'),
            toExternalAuthorId('author-1'),
            toExternalCommentId('external-comment-1'),
            toExternalPostId('external-post-1'),
            toPostId('post-1'),
            toSocialPlatform('demo'),
        ]).toEqual([
            'account-1',
            'comment-1',
            'cursor-1',
            'author-1',
            'external-comment-1',
            'external-post-1',
            'post-1',
            'demo',
        ]);
    });

    it('exposes the public types needed to implement the ports', () => {
        const failure: CommentsFailure = {code: 'PLATFORM_UNAVAILABLE'};
        const context: PublishedPostContext = {
            accountId: toAccountId('account-1'),
            platform: toSocialPlatform('demo'),
            externalPostId: toExternalPostId('external-post-1'),
        };
        const replyContext: CommentReplyContext = {
            postId: toPostId('post-1'),
            accountId: toAccountId('account-1'),
            platform: toSocialPlatform('demo'),
            externalParentCommentId: toExternalCommentId('external-comment-1'),
        };
        const platformComment: PlatformComment = {
            externalCommentId: toExternalCommentId('external-comment-1'),
            externalAuthorId: toExternalAuthorId('author-1'),
            content: 'Comment',
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            metadata: null,
        };
        const platformPage: PlatformCommentPage = {items: [platformComment], nextCursor: null};
        const normalized: NormalizedComment = {
            postId: toPostId('post-1'),
            parentCommentId: null,
            externalCommentId: toExternalCommentId('external-comment-1'),
            externalAuthorId: toExternalAuthorId('author-1'),
            content: 'Comment',
            platformCreatedAt: new Date('2026-01-01T00:00:00.000Z'),
            metadata: null,
        };
        const stored: Comment = {
            ...normalized,
            id: toCommentId('comment-1'),
            createdAt: new Date('2026-02-01T00:00:00.000Z'),
            updatedAt: new Date('2026-02-01T00:00:00.000Z'),
            version: 1,
        };
        const page: CommentPage = {items: [stored], nextCursor: toCursor('cursor-1')};
        const postQuery: GetPostCommentsQuery = {postId: toPostId('post-1')};
        const replyQuery: GetCommentRepliesQuery = {commentId: toCommentId('comment-1')};
        const gateways: ReadonlyMap<SocialPlatform, SocialCommentsGateway> = new Map();

        expect([
            failure.code,
            context.platform,
            replyContext.postId,
            platformPage.items.length,
            page.items.length,
            postQuery.postId,
            replyQuery.commentId,
            gateways.size,
        ]).toEqual(['PLATFORM_UNAVAILABLE', 'demo', 'post-1', 1, 1, 'post-1', 'comment-1', 0]);
    });

    it('exposes the port contracts so consumers can implement them', () => {
        const posts: PublishedPostRepository = {
            findContextByPostId: (): Promise<PublishedPostContext | null> => Promise.resolve(null),
        };
        const contexts: CommentReplyContextRepository = {
            findByCommentId: (): Promise<CommentReplyContext | null> => Promise.resolve(null),
        };
        const comments: CommentRepository = {
            saveMany: (): Promise<readonly Comment[]> => Promise.resolve([]),
        };
        const gateways = new Map<SocialPlatform, SocialCommentsGateway>();

        const postComments: Result<CommentPage, CommentsFailure> = ok<CommentPage>({
            items: [],
            nextCursor: null,
        });

        expect(new GetPostComments(posts, gateways, comments)).toBeInstanceOf(GetPostComments);
        expect(new GetCommentReplies(contexts, gateways, comments)).toBeInstanceOf(
            GetCommentReplies,
        );
        expect(postComments.ok).toBe(true);
    });
});
