import {describe, expect, it} from 'vitest';
import {
    ReplyToComment,
    toAccountId,
    toCommentId,
    toExternalAuthorId,
    toExternalCommentId,
    toIdempotencyKey,
    toPostId,
    toSocialPlatform,
    type Comment,
    type CommentReplyContext,
    type CommentReplyContextRepository,
    type CommentRepository,
    type ReplyPublicationOperationRepository,
    type SocialCommentsGateway,
} from '@threadbridge/comments';

const platform = toSocialPlatform('demo');
const accountId = toAccountId('account-1');
const postId = toPostId('post-1');
const parentCommentId = toCommentId('comment-1');
const idempotencyKey = toIdempotencyKey('reply-key');
const context: CommentReplyContext = {
    accountId,
    postId,
    platform,
    externalParentCommentId: toExternalCommentId('external-parent'),
};
const comment: Comment = {
    id: toCommentId('comment-2'),
    postId,
    parentCommentId,
    externalCommentId: toExternalCommentId('external-reply'),
    externalAuthorId: toExternalAuthorId('author-self'),
    content: 'Reply',
    platformCreatedAt: new Date('2026-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    version: 1,
    metadata: null,
    idempotencyKey,
};

describe('reply capability changes', () => {
    it('replays a published operation before rejecting a disabled publication capability', async () => {
        let providerCalls = 0;
        const contexts: CommentReplyContextRepository = {
            findByCommentId: (): Promise<CommentReplyContext> => Promise.resolve(context),
        };
        const gateway: SocialCommentsGateway = {
            capabilities: {
                rootComments: false,
                directReplies: false,
                replyPublication: false,
                publicationIdempotency: 'none',
            },
            getComments: (): never => {
                throw new Error('Not used.');
            },
            getReplies: (): never => {
                throw new Error('Not used.');
            },
            replyToComment: (): never => {
                providerCalls += 1;
                throw new Error('A replay must not call the provider.');
            },
        };
        const comments: CommentRepository = {
            saveMany: (): never => {
                throw new Error('Not used.');
            },
            findByIdempotencyKey: (): never => {
                throw new Error('A completed operation does not need projection recovery.');
            },
            savePublishedReply: (): never => {
                throw new Error('A replay must not persist another reply.');
            },
        };
        const operations: ReplyPublicationOperationRepository = {
            findExistingByParent: (): Promise<null> => Promise.resolve(null),
            begin: () => Promise.resolve({
                kind: 'existing',
                operation: {
                    id: 'operation-1',
                    accountId,
                    parentCommentId,
                    idempotencyKey,
                    requestFingerprint: JSON.stringify([parentCommentId, 'Reply']),
                    status: 'published',
                    comment,
                    lastFailureCode: null,
                },
            }),
            markPublished: (): never => {
                throw new Error('A completed operation must not be rewritten.');
            },
            markFailed: (): never => {
                throw new Error('A completed operation must not be failed.');
            },
        };

        const result = await new ReplyToComment(
            contexts,
            new Map([[platform, gateway]]),
            comments,
            operations,
        ).execute({parentCommentId, content: 'Reply', idempotencyKey});

        expect(result).toEqual({
            ok: true,
            value: {kind: 'existing', comment},
        });
        expect(providerCalls).toBe(0);
    });
});
