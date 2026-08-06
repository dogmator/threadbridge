import type {Comment} from './comment.js';
import type {PlatformFailure} from './errors.js';
import type {AccountId, CommentId, IdempotencyKey} from './identifiers.js';

export type ReplyPublicationStatus =
    | 'pending'
    | 'published'
    | 'retryable_failed'
    | 'failed'
    | 'indeterminate';

export type ReplyPublicationFailureCode =
    | PlatformFailure['code']
    | 'IDEMPOTENCY_CONFLICT'
    | 'INDETERMINATE_PLATFORM_RESULT';

export interface ReplyPublicationOperation {
    readonly id: string;
    readonly accountId: AccountId;
    readonly parentCommentId: CommentId;
    readonly idempotencyKey: IdempotencyKey;
    readonly requestFingerprint: string;
    readonly status: ReplyPublicationStatus;
    readonly comment: Comment | null;
    readonly lastFailureCode: ReplyPublicationFailureCode | null;
}
