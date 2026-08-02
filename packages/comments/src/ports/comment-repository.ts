import type {Comment, NormalizedComment, PublishedReply} from '../domain/comment.js';
import type {IdempotencyKey} from '../domain/identifiers.js';

/**
 * Tells the application whether a publication attempt inserted the reply or converged on a row
 * another request had already persisted under the same idempotency key.
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
     * Returns the comment published under an idempotency key, or null when the key is unused.
     */
    findByIdempotencyKey(idempotencyKey: IdempotencyKey): Promise<Comment | null>;

    /**
     * Persists a confirmed platform reply after the platform has already answered, never around an
     * external call. Two requests carrying the same idempotency key converge on a single row, and
     * an already imported projection of the same platform comment is reconciled rather than
     * duplicated. A key already recorded on that row is never replaced, so a request whose key did
     * not reach the row is answered with the stored row and its own key, not with a rewritten one.
     */
    savePublishedReply(reply: PublishedReply): Promise<SavePublishedReplyResult>;
}
