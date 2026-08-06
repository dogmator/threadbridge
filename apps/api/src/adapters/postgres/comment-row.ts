import {
    toCommentId,
    toExternalAuthorId,
    toExternalCommentId,
    toIdempotencyKey,
    toPostId,
    type Comment,
    type PlatformMetadata,
} from '@threadbridge/comments';

export interface CommentRow {
    readonly id: string;
    readonly post_id: string;
    readonly parent_comment_id: string | null;
    readonly external_comment_id: string;
    readonly external_author_id: string;
    readonly content: string;
    readonly platform_created_at: Date;
    readonly created_at: Date;
    readonly updated_at: Date;
    readonly version: number;
    readonly idempotency_key: string | null;
    readonly platform_data: PlatformMetadata | null;
}

export const toComment = (row: CommentRow): Comment => ({
    id: toCommentId(row.id),
    postId: toPostId(row.post_id),
    parentCommentId: row.parent_comment_id === null ? null : toCommentId(row.parent_comment_id),
    externalCommentId: toExternalCommentId(row.external_comment_id),
    externalAuthorId: toExternalAuthorId(row.external_author_id),
    content: row.content,
    platformCreatedAt: row.platform_created_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
    metadata: row.platform_data,
    ...(row.idempotency_key === null
        ? {}
        : {idempotencyKey: toIdempotencyKey(row.idempotency_key)}),
});
