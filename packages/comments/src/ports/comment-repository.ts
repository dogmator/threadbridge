import type {Comment, NormalizedComment, PublishedReply} from '../domain/comment.js';
import type {AccountId, IdempotencyKey} from '../domain/identifiers.js';

/**
 * Tells the application whether a publication attempt inserted the reply or converged on a row
 * another request had already persisted under the same account-scoped idempotency key.
 */
export type SavePublishedReplyResult =
    | {readonly kind: 'created'; readonly comment: Comment}
    | {readonly kind: 'existing'; readonly comment: Comment};

export interface CommentRepository {
    /**
     * Persists comments idempotently, keyed by post and external comment identifier, so repeated
     * retrieval of the same external comment does not create duplicates. Returns the stored
     * comments, carrying store-owned identity, in the order of the input.
     */
    saveMany(comments: readonly NormalizedComment[]): Promise<readonly Comment[]>;

    /**
     * Returns the comment published under an idempotency key for one connected account, or null
     * when that account has not used the key.
     */
    findByIdempotencyKey(
        accountId: AccountId,
        idempotencyKey: IdempotencyKey,
    ): Promise<Comment | null>;

    /**
     * Persists a confirmed platform reply after the platform has already answered, never around an
     * external call. Two requests carrying the same account-scoped idempotency key converge on a
     * single row, and an already imported projection of the same platform comment is reconciled
     * rather than duplicated. A key already recorded on that row is never replaced.
     */
    savePublishedReply(reply: PublishedReply): Promise<SavePublishedReplyResult>;
}
