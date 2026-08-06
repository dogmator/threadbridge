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
        const context = await this.contexts.findByCommentId(query.parentCommentId);

        if (context === null) {
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

        if (this.operations === null) {
            return await this.executeLegacy(query, context, gateway);
        }

        const requestFingerprint = JSON.stringify([query.parentCommentId, query.content]);
        const begun = await this.operations.begin({
            accountId: context.accountId,
            parentCommentId: query.parentCommentId,
            idempotencyKey: query.idempotencyKey,
            requestFingerprint,
        });

        if (begun.kind === 'conflict') {
            return err<ReplyToCommentFailure>({
                code: 'IDEMPOTENCY_CONFLICT',
                idempotencyKey: query.idempotencyKey,
            });
        }

        const operation = begun.operation;

        if (begun.kind === 'existing') {
            if (operation.status === 'published') {
                if (operation.comment === null) {
                    throw new Error('A published operation has no stored comment.');
                }

                return this.replayOf(operation.comment, query);
            }

            const recovered = await this.recoverStoredReply(query, context, operation);

            if (recovered !== null) {
                return recovered;
            }

            if (operation.status === 'indeterminate') {
                return err<ReplyToCommentFailure>({
                    code: 'INDETERMINATE_PLATFORM_RESULT',
                    platform: context.platform,
                });
            }

            if (operation.status === 'failed') {
                return this.replayTerminalFailure(operation.lastFailureCode);
            }
        }

        // Capability changes affect only a new external attempt. A completed or locally
        // recoverable operation above is replayed without consulting the provider.
        if (!gateway.capabilities.replyPublication) {
            await this.operations.markFailed(
                operation.id,
                'failed',
                'PLATFORM_OPERATION_UNSUPPORTED',
            );

            return err<ReplyToCommentFailure>({code: 'PLATFORM_OPERATION_UNSUPPORTED'});
        }

        if (begun.kind === 'existing'
            && operation.status === 'pending'
            && gateway.capabilities.publicationIdempotency === 'none') {
            await this.operations.markFailed(
                operation.id,
                'indeterminate',
                'INDETERMINATE_PLATFORM_RESULT',
            );

            return err<ReplyToCommentFailure>({
                code: 'INDETERMINATE_PLATFORM_RESULT',
                platform: context.platform,
            });
        }

        return await this.publishAndRecord(query, context, gateway, operation.id);
    }

    private async executeLegacy(
        query: ReplyToCommentQuery,
        context: CommentReplyContext,
        gateway: SocialCommentsGateway,
    ): Promise<Result<ReplyToCommentSuccess, ReplyToCommentFailure>> {
        const alreadyPublished = await this.comments.findByIdempotencyKey(
            context.accountId,
            query.idempotencyKey,
        );

        if (alreadyPublished !== null) {
            return this.replayOf(alreadyPublished, query);
        }

        if (!gateway.capabilities.replyPublication) {
            return err<ReplyToCommentFailure>({code: 'PLATFORM_OPERATION_UNSUPPORTED'});
        }

        return await this.publishAndRecord(query, context, gateway, null);
    }

    private async recoverStoredReply(
        query: ReplyToCommentQuery,
        context: CommentReplyContext,
        operation: ReplyPublicationOperation,
    ): Promise<Result<ReplyToCommentSuccess, ReplyToCommentFailure> | null> {
        if (this.operations === null) {
  return null;
        }

        const stored = await this.comments.findByIdempotencyKey(
  context.accountId,
  query.idempotencyKey,
        );

        if (stored === null) {
  return null;
        }

        const replay = this.replayOf(stored, query);

        if (!replay.ok) {
  await this.operations.markFailed(
      operation.id,
      'indeterminate',
      'IDEMPOTENCY_CONFLICT',
  );

  return replay;
        }

        await this.operations.markPublished(operation.id, stored.id);

        return replay;
    }

    private async publishAndRecord(
        query: ReplyToCommentQuery,
        context: CommentReplyContext,
        gateway: SocialCommentsGateway,
        operationId: string | null,
    ): Promise<Result<ReplyToCommentSuccess, ReplyToCommentFailure>> {
        const published = await gateway.replyToComment({
  accountId: context.accountId,
  externalParentCommentId: context.externalParentCommentId,
  content: query.content,
  idempotencyKey: query.idempotencyKey,
        });

        if (!published.ok) {
  if (published.error.code === 'PLATFORM_RESOURCE_NOT_FOUND'
      && this.projectionStates !== null) {
      await this.projectionStates.markDeleted(query.parentCommentId);
  }

  if (operationId !== null && this.operations !== null) {
      await this.operations.markFailed(
          operationId,
          statusOf(published.error),
          published.error.code,
      );
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

        if (!this.isReplayOf(stored.comment, query)) {
  if (operationId !== null && this.operations !== null) {
      await this.operations.markFailed(
          operationId,
          'indeterminate',
          'IDEMPOTENCY_CONFLICT',
      );
  }

  return err<ReplyToCommentFailure>({
      code: 'IDEMPOTENCY_CONFLICT',
      idempotencyKey: query.idempotencyKey,
  });
        }

        if (operationId !== null && this.operations !== null) {
  await this.operations.markPublished(operationId, stored.comment.id);
        }

        return ok<ReplyToCommentSuccess>(stored);
    }

    private replayTerminalFailure(
        code: ReplyPublicationFailureCode | null,
    ): Result<ReplyToCommentSuccess, ReplyToCommentFailure> {
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
    }

    private replayOf(
        comment: Comment,
        query: ReplyToCommentQuery,
    ): Result<ReplyToCommentSuccess, ReplyToCommentFailure> {
        if (!this.isReplayOf(comment, query)) {
  return err<ReplyToCommentFailure>({
      code: 'IDEMPOTENCY_CONFLICT',
      idempotencyKey: query.idempotencyKey,
  });
        }

        return ok<ReplyToCommentSuccess>({kind: 'existing', comment});
    }

    private isReplayOf(comment: Comment, query: ReplyToCommentQuery): boolean {
        return comment.idempotencyKey === query.idempotencyKey
  && comment.parentCommentId === query.parentCommentId
  && comment.content === query.content;
    }
}
