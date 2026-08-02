import type {Comment, CommentPage} from '@threadbridge/comments';

/**
 * The public shape of a comment. Idempotency keys, optimistic-lock versions, and platform metadata
 * are deliberately absent: they are internal or provider-owned and must not reach API clients.
 */
export interface CommentResponse {
    readonly id: string;
    readonly postId: string;
    readonly parentCommentId: string | null;
    readonly externalCommentId: string;
    readonly externalAuthorId: string;
    readonly content: string;
    readonly platformCreatedAt: string;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export interface CommentPageResponse {
    readonly items: readonly CommentResponse[];
    readonly nextCursor: string | null;
}

export const toCommentResponse = (comment: Comment): CommentResponse => ({
    id: comment.id,
    postId: comment.postId,
    parentCommentId: comment.parentCommentId,
    externalCommentId: comment.externalCommentId,
    externalAuthorId: comment.externalAuthorId,
    content: comment.content,
    platformCreatedAt: comment.platformCreatedAt.toISOString(),
    createdAt: comment.createdAt.toISOString(),
    updatedAt: comment.updatedAt.toISOString(),
});

export const toCommentPageResponse = (page: CommentPage): CommentPageResponse => ({
    items: page.items.map(toCommentResponse),
    nextCursor: page.nextCursor,
});
