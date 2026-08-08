import type {Comment, PublishedReply} from '../domain/comment.js';
import type {CommentReplyContext} from '../domain/comment-reply.js';
import type {
    CommentNotFoundFailure,
    IdempotencyConflictFailure,
    IndeterminatePlatformResultFailure,
    PlatformFailure,
    UnsupportedPlatformFailure,
} from '../domain/errors.js';
import type {CommentId, IdempotencyKey, SocialPlatform} from '../domain/identifiers.js';
import type {
    ReplyPublicationFailureCode,
    ReplyPublicationOperation,
    ReplyPublicationStatus,
} from '../domain/reply-publication-operation.js';
import {err, ok, type Result} from '../domain/result.js';
import type {CommentProjectionStateRepository}
    from '../ports/comment-projection-state-repository.js';
import type {CommentReplyContextRepository} from '../ports/comment-reply-context-repository.js';
import type {CommentRepository} from '../ports/comment-repository.js';
import type {ReplyPublicationOperationRepository}
    from '../ports/reply-publication-operation-repository.js';
import type {SocialCommentsGateway} from '../ports/social-comments-gateway.js';

export interface ReplyToCommentQuery {
    readonly parentCommentId: CommentId;
    readonly content: string;
    readonly idempotencyKey: IdempotencyKey;
}

export type ReplyToCommentSuccess =
    | {readonly kind: 'created'; readonly comment: Comment}
    | {readonly kind: 'existing'; readonly comment: Comment};

export type ReplyToCommentFailure =
    | CommentNotFoundFailure
    | UnsupportedPlatformFailure
    | IdempotencyConflictFailure
    | IndeterminatePlatformResultFailure
    | PlatformFailure;

type FailedPublicationStatus = Extract<
    ReplyPublicationStatus,
    'retryable_failed' | 'failed' | 'indeterminate'
>;

interface OperationHandle {
    readonly id: string;
    readonly repository: ReplyPublicationOperationRepository;
}

const statusOf = (
    failure: PlatformFailure | IndeterminatePlatformResultFailure,
): FailedPublicationStatus => {
    switch (failure.code) {
        case 'INDETERMINATE_PLATFORM_RESULT':
            return 'indeterminate';
        case 'PLATFORM_RATE_LIMITED':
        case 'PLATFORM_TIMEOUT':
        case 'PLATFORM_UNAVAILABLE':
            return 'retryable_failed';
        case 'PLATFORM_AUTHENTICATION_FAILED':
        case 'PLATFORM_PERMISSION_DENIED':
        case 'PLATFORM_RESOURCE_NOT_FOUND':
        case 'PLATFORM_VALIDATION_FAILED':
        case 'PLATFORM_OPERATION_UNSUPPORTED':
        case 'PLATFORM_CURSOR_INVALID':
            return 'failed';
    }
};

const conflict = (
    idempotencyKey: IdempotencyKey,
): Result<ReplyToCommentSuccess, ReplyToCommentFailure> =>
    err<ReplyToCommentFailure>({code: 'IDEMPOTENCY_CONFLICT', idempotencyKey});

const indeterminate = (
    platform: SocialPlatform,
): Result<ReplyToCommentSuccess, ReplyToCommentFailure> =>
    err<ReplyToCommentFailure>({code: 'INDETERMINATE_PLATFORM_RESULT', platform});

const isReplayOf = (comment: Comment, query: ReplyToCommentQuery): boolean =>
    comment.idempotencyKey === query.idempotencyKey
    && comment.parentCommentId === query.parentCommentId
    && comment.content === query.content;

const replayOf = (
    comment: Comment,
    query: ReplyToCommentQuery,
): Result<ReplyToCommentSuccess, ReplyToCommentFailure> =>
    isReplayOf(comment, query)
        ? ok<ReplyToCommentSuccess>({kind: 'existing', comment})
        : conflict(query.idempotencyKey);

const requestFingerprintOf = (query: ReplyToCommentQuery): string =>
    JSON.stringify([query.parentCommentId, query.content]);

const terminalFailureOf = (
    code: ReplyPublicationFailureCode | null,
): Result<ReplyToCommentSuccess, ReplyToCommentFailure> => {
    switch (code) {
        case 'PLATFORM_AUTHENTICATION_FAILED':
        case 'PLATFORM_PERMISSION_DENIED':
        case 'PLATFORM_RESOURCE_NOT_FOUND':
        case 'PLATFORM_VALIDATION_FAILED':
        case 'PLATFORM_OPERATION_UNSUPPORTED':
        case 'PLATFORM_CURSOR_INVALID':
            return err<ReplyToCommentFailure>({code});
        case null:
        case 'PLATFORM_RATE_LIMITED':
        case 'PLATFORM_TIMEOUT':
        case 'PLATFORM_UNAVAILABLE':
        case 'IDEMPOTENCY_CONFLICT':
        case 'INDETERMINATE_PLATFORM_RESULT':
            throw new Error('A terminally failed operation has an invalid failure code.');
    }
};

const replayWithoutActiveContext = (
    query: ReplyToCommentQuery,
    operation: ReplyPublicationOperation,
    platform: SocialPlatform,
): Result<ReplyToCommentSuccess, ReplyToCommentFailure> | null => {
    if (
        operation.parentCommentId !== query.parentCommentId
        || operation.requestFingerprint !== requestFingerprintOf(query)
    ) {
        return conflict(query.idempotencyKey);
    }

    switch (operation.status) {
        case 'published':
            if (operation.comment === null) {
                throw new Error('A published operation has no stored comment.');
            }

            return replayOf(operation.comment, query);
        case 'failed':
            return terminalFailureOf(operation.lastFailureCode);
        case 'indeterminate':
            return indeterminate(platform);
        case 'pending':
        case 'retryable_failed':
            return null;
    }
};

const markFailed = async (
    operation: OperationHandle | null,
    status: FailedPublicationStatus,
    code: ReplyPublicationFailureCode,
): Promise<void> => {
    if (operation !== null) {
        await operation.repository.markFailed(operation.id, status, code);
    }
};

export class ReplyToComment {
    public constructor(
        private readonly contexts: CommentReplyContextRepository,
        private readonly gateways: ReadonlyMap<SocialPlatform, SocialCommentsGateway>,
        private readonly comments: CommentRepository,
        private readonly operations: ReplyPublicationOperationRepository | null = null,
        private readonly projectionStates: CommentProjectionStateRepository | null = null,
    ) {}

    public async execute(
        query: ReplyToCommentQuery,
    ): Promise<Result<ReplyToCommentSuccess, ReplyToCommentFailure>> {
        const operations = this.operations;
        const context = await this.contexts.findByCommentId(query.parentCommentId);

        if (context === null) {
            if (operations !== null) {
                const existing = await operations.findExistingByParent(
                    query.parentCommentId,
                    query.idempotencyKey,
                );

                if (existing !== null) {
                    const replay = replayWithoutActiveContext(
                        query,
                        existing.operation,
                        existing.platform,
                    );

                    if (replay !== null) {
                        return replay;
                    }
                }
            }

            return err<ReplyToCommentFailure>({
                code: 'COMMENT_NOT_FOUND',
                commentId: query.parentCommentId,
            });
        }

        const gateway = this.gateways.get(context.platform);

        if (gateway === undefined) {
            return err<ReplyToCommentFailure>({
                code: 'UNSUPPORTED_PLATFORM',
                platform: context.platform,
            });
        }

        if (operations === null) {
            return await this.executeLegacy(query, context, gateway);
        }

        const begun = await operations.begin({
            accountId: context.accountId,
            parentCommentId: query.parentCommentId,
            idempotencyKey: query.idempotencyKey,
            requestFingerprint: requestFingerprintOf(query),
        });

        if (begun.kind === 'conflict') {
            return conflict(query.idempotencyKey);
        }

        const operation = begun.operation;
        const handle: OperationHandle = {
            id: operation.id,
            repository: operations,
        };

        if (begun.kind === 'existing') {
            if (operation.status === 'published') {
                if (operation.comment === null) {
                    throw new Error('A published operation has no stored comment.');
                }

                return replayOf(operation.comment, query);
            }

            const recovered = await this.recoverStoredReply(query, context, handle);

            if (recovered !== null) {
                return recovered;
            }

            if (operation.status === 'indeterminate') {
                return indeterminate(context.platform);
            }

            if (operation.status === 'failed') {
                return terminalFailureOf(operation.lastFailureCode);
            }
        }

        if (!gateway.capabilities.replyPublication) {
            await markFailed(handle, 'failed', 'PLATFORM_OPERATION_UNSUPPORTED');
            return err<ReplyToCommentFailure>({code: 'PLATFORM_OPERATION_UNSUPPORTED'});
        }

        if (
            begun.kind === 'existing'
            && operation.status === 'pending'
            && gateway.capabilities.publicationIdempotency === 'none'
        ) {
            await markFailed(handle, 'indeterminate', 'INDETERMINATE_PLATFORM_RESULT');
            return indeterminate(context.platform);
        }

        return await this.publishAndRecord(query, context, gateway, handle);
    }

    private async executeLegacy(
        query: ReplyToCommentQuery,
        context: CommentReplyContext,
        gateway: SocialCommentsGateway,
    ): Promise<Result<ReplyToCommentSuccess, ReplyToCommentFailure>> {
        const existing = await this.comments.findByIdempotencyKey(
            context.accountId,
            query.idempotencyKey,
        );

        if (existing !== null) {
            return replayOf(existing, query);
        }

        if (!gateway.capabilities.replyPublication) {
            return err<ReplyToCommentFailure>({code: 'PLATFORM_OPERATION_UNSUPPORTED'});
        }

        return await this.publishAndRecord(query, context, gateway, null);
    }

    private async recoverStoredReply(
        query: ReplyToCommentQuery,
        context: CommentReplyContext,
        operation: OperationHandle,
    ): Promise<Result<ReplyToCommentSuccess, ReplyToCommentFailure> | null> {
        const stored = await this.comments.findByIdempotencyKey(
            context.accountId,
            query.idempotencyKey,
        );

        if (stored === null) {
            return null;
        }

        const replay = replayOf(stored, query);

        if (!replay.ok) {
            await markFailed(operation, 'indeterminate', 'IDEMPOTENCY_CONFLICT');
            return replay;
        }

        await operation.repository.markPublished(operation.id, stored.id);
        return replay;
    }

    private async publishAndRecord(
        query: ReplyToCommentQuery,
        context: CommentReplyContext,
        gateway: SocialCommentsGateway,
        operation: OperationHandle | null,
    ): Promise<Result<ReplyToCommentSuccess, ReplyToCommentFailure>> {
        const published = await gateway.replyToComment({
            accountId: context.accountId,
            externalParentCommentId: context.externalParentCommentId,
            content: query.content,
            idempotencyKey: query.idempotencyKey,
        });

        if (!published.ok) {
            await markFailed(operation, statusOf(published.error), published.error.code);

            if (
                published.error.code === 'PLATFORM_RESOURCE_NOT_FOUND'
                && this.projectionStates !== null
            ) {
                await this.projectionStates.markDeleted(query.parentCommentId);
            }

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

        if (!isReplayOf(stored.comment, query)) {
            await markFailed(operation, 'indeterminate', 'IDEMPOTENCY_CONFLICT');
            return conflict(query.idempotencyKey);
        }

        if (operation !== null) {
            await operation.repository.markPublished(operation.id, stored.comment.id);
        }

        return ok<ReplyToCommentSuccess>(stored);
    }
}
