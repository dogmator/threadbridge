import type {
    CommentId,
    Cursor,
    ExternalAuthorId,
    ExternalCommentId,
    IdempotencyKey,
    PostId,
} from './identifiers.js';
import type {PlatformMetadata} from './platform.js';

/**
 * Comment data normalized by the application and ready to be projected into local storage. It has
 * no local identity yet: the store owns internal identifiers, versions, and local timestamps.
 */
export interface NormalizedComment {
    readonly postId: PostId;
    readonly parentCommentId: CommentId | null;
    readonly externalCommentId: ExternalCommentId;
    readonly externalAuthorId: ExternalAuthorId;
    readonly content: string;
    readonly platformCreatedAt: Date;
    readonly metadata: PlatformMetadata | null;
}

/**
 * The latest known local projection of a comment. A reply is a comment with a parent comment.
 *
 * An idempotency key is present only on replies published through ThreadBridge; comments imported
 * from a platform carry none.
 */
export interface Comment extends NormalizedComment {
    readonly id: CommentId;
    readonly createdAt: Date;
    readonly updatedAt: Date;
    readonly version: number;
    readonly idempotencyKey?: IdempotencyKey;
}

/**
 * A reply confirmed by a platform and ready to be projected locally. Unlike an imported comment it
 * always has a parent and always carries the idempotency key of the request that published it.
 */
export interface PublishedReply extends NormalizedComment {
    readonly parentCommentId: CommentId;
    readonly idempotencyKey: IdempotencyKey;
}

export interface CommentPage {
    readonly items: readonly Comment[];
    readonly nextCursor: Cursor | null;
}
