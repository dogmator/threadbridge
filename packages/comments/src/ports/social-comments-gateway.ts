import type {IndeterminatePlatformResultFailure, PlatformFailure} from '../domain/errors.js';
import type {
    AccountId,
    Cursor,
    ExternalCommentId,
    ExternalPostId,
    IdempotencyKey,
} from '../domain/identifiers.js';
import type {PlatformComment, PlatformCommentPage} from '../domain/platform.js';
import type {Result} from '../domain/result.js';

export interface GetPlatformCommentsInput {
    readonly accountId: AccountId;
    readonly externalPostId: ExternalPostId;
    readonly cursor: Cursor | null;
}

export interface GetPlatformRepliesInput {
    readonly accountId: AccountId;
    readonly externalParentCommentId: ExternalCommentId;
    readonly cursor: Cursor | null;
}

export interface ReplyToPlatformCommentInput {
    readonly accountId: AccountId;
    readonly externalParentCommentId: ExternalCommentId;
    readonly content: string;
    readonly idempotencyKey: IdempotencyKey;
}

export interface SocialCommentsGateway {
    /**
     * Requests a single page of root comments from the external platform and translates external
     * failures into typed platform failures.
     */
    getComments(
        input: GetPlatformCommentsInput,
    ): Promise<Result<PlatformCommentPage, PlatformFailure>>;

    /**
     * Requests a single page of direct replies to a comment. It never walks the subtree.
     */
    getReplies(
        input: GetPlatformRepliesInput,
    ): Promise<Result<PlatformCommentPage, PlatformFailure>>;

    /**
     * Publishes a reply.
     *
     * The idempotency key of the request is passed through to the provider unchanged, so an
     * adapter can forward it as the provider's own idempotency token.
     *
     * Preventing a *duplicate external effect* is the adapter's responsibility, and it can only be
     * honoured by provider-side idempotency or an equivalent provider guarantee. Two concurrent
     * requests carrying one key may both reach this method: the application deliberately does not
     * hold a database transaction or lock across the call, so PostgreSQL cannot and does not
     * arbitrate what happens on the provider. What the application guarantees is local: one stored
     * row per key, and one converged result for both callers. An adapter that cannot deduplicate
     * on the provider side must not be described as exactly-once.
     *
     * An adapter that cannot determine whether the external write happened must return
     * `INDETERMINATE_PLATFORM_RESULT` rather than guess in either direction. Nothing is persisted
     * for that outcome, and retrying it automatically remains forbidden, because a retry may
     * duplicate a write that already succeeded.
     */
    replyToComment(
        input: ReplyToPlatformCommentInput,
    ): Promise<Result<PlatformComment, PlatformFailure | IndeterminatePlatformResultFailure>>;
}
