import type {Comment, PublishedReply} from '../domain/comment.js';
import type {
    CommentNotFoundFailure,
    IdempotencyConflictFailure,
    IndeterminatePlatformResultFailure,
    PlatformFailure,
    UnsupportedPlatformFailure,
} from '../domain/errors.js';
import type {CommentId, IdempotencyKey, SocialPlatform} from '../domain/identifiers.js';
import {err, ok, type Result} from '../domain/result.js';
import type {CommentReplyContextRepository} from '../ports/comment-reply-context-repository.js';
import type {CommentRepository} from '../ports/comment-repository.js';
import type {SocialCommentsGateway} from '../ports/social-comments-gateway.js';

/**
 * The caller identifies the parent comment by its internal identifier and supplies nothing about
 * the platform: the post, the account, and every external identifier are resolved from the stored
 * reply context.
 */
export interface ReplyToCommentQuery {
    readonly parentCommentId: CommentId;
    readonly content: string;
    readonly idempotencyKey: IdempotencyKey;
}

/**
 * Distinguishes a reply published by this request from one an earlier request already published,
 * so the transport can answer 201 or 200 without inspecting persistence details.
 */
export type ReplyToCommentSuccess =
    | {readonly kind: 'created'; readonly comment: Comment}
    | {readonly kind: 'existing'; readonly comment: Comment};

export type ReplyToCommentFailure =
    | CommentNotFoundFailure
    | UnsupportedPlatformFailure
    | IdempotencyConflictFailure
    | IndeterminatePlatformResultFailure
    | PlatformFailure;

export class ReplyToComment {
    public constructor(
        private readonly contexts: CommentReplyContextRepository,
        private readonly gateways: ReadonlyMap<SocialPlatform, SocialCommentsGateway>,
        private readonly comments: CommentRepository,
    ) {}

    public async execute(
        query: ReplyToCommentQuery,
    ): Promise<Result<ReplyToCommentSuccess, ReplyToCommentFailure>> {
        const context = await this.contexts.findByCommentId(query.parentCommentId);

        if (context === null) {
            return err<ReplyToCommentFailure>({
                code: 'COMMENT_NOT_FOUND',
                commentId: query.parentCommentId,
            });
        }

        const alreadyPublished = await this.comments.findByIdempotencyKey(query.idempotencyKey);

        if (alreadyPublished !== null) {
            return this.replayOf(alreadyPublished, query);
        }

        const gateway = this.gateways.get(context.platform);

        if (gateway === undefined) {
            return err<ReplyToCommentFailure>({
                code: 'UNSUPPORTED_PLATFORM',
                platform: context.platform,
            });
        }

        // Deliberately outside every database transaction: the platform must never be called with
        // a row locked, and an unknown outcome must not roll back into a retry.
        const published = await gateway.replyToComment({
            accountId: context.accountId,
            externalParentCommentId: context.externalParentCommentId,
            content: query.content,
            idempotencyKey: query.idempotencyKey,
        });

        if (!published.ok) {
            return err<ReplyToCommentFailure>(published.error);
        }

        const reply: PublishedReply = {
            postId: context.postId,
            parentCommentId: query.parentCommentId,
            externalCommentId: published.value.externalCommentId,
            externalAuthorId: published.value.externalAuthorId,
            content: published.value.content,
            platformCreatedAt: published.value.createdAt,
            metadata: published.value.metadata,
            idempotencyKey: query.idempotencyKey,
        };
        const stored = await this.comments.savePublishedReply(reply);

        // A concurrent request carrying the same key may have persisted first, after this request
        // read the key and before it wrote. The stored row decides the outcome.
        if (!this.matchesRequest(stored.comment, query)) {
            return err<ReplyToCommentFailure>({
                code: 'IDEMPOTENCY_CONFLICT',
                idempotencyKey: query.idempotencyKey,
            });
        }

        return ok<ReplyToCommentSuccess>(stored);
    }

    private replayOf(
        comment: Comment,
        query: ReplyToCommentQuery,
    ): Result<ReplyToCommentSuccess, ReplyToCommentFailure> {
        if (!this.matchesRequest(comment, query)) {
            return err<ReplyToCommentFailure>({
                code: 'IDEMPOTENCY_CONFLICT',
                idempotencyKey: query.idempotencyKey,
            });
        }

        return ok<ReplyToCommentSuccess>({kind: 'existing', comment});
    }

    private matchesRequest(comment: Comment, query: ReplyToCommentQuery): boolean {
        return comment.parentCommentId === query.parentCommentId
            && comment.content === query.content;
    }
}
