import type {AccountId, CommentId, IdempotencyKey} from '../domain/identifiers.js';
import type {
    ReplyPublicationFailureCode,
    ReplyPublicationOperation,
    ReplyPublicationStatus,
} from '../domain/reply-publication-operation.js';

export interface BeginReplyPublicationInput {
    readonly accountId: AccountId;
    readonly parentCommentId: CommentId;
    readonly idempotencyKey: IdempotencyKey;
    readonly requestFingerprint: string;
}

export type BeginReplyPublicationResult =
    | {readonly kind: 'started'; readonly operation: ReplyPublicationOperation}
    | {readonly kind: 'existing'; readonly operation: ReplyPublicationOperation}
    | {readonly kind: 'conflict'};

export interface ReplyPublicationOperationRepository {
    begin(input: BeginReplyPublicationInput): Promise<BeginReplyPublicationResult>;
    markPublished(operationId: string, commentId: CommentId): Promise<void>;
    markFailed(
        operationId: string,
        status: Extract<
  ReplyPublicationStatus,
  'retryable_failed' | 'failed' | 'indeterminate'
        >,
        failureCode: ReplyPublicationFailureCode,
    ): Promise<void>;
}
