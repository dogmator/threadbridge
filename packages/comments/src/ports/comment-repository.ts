import type {Comment, NormalizedComment} from '../domain/comment.js';

export interface CommentRepository {
    /**
     * Persists comments idempotently, keyed by post and external comment identifier, so repeated
     * retrieval of the same external comment does not create duplicates. Returns the stored
     * comments, carrying store-owned identity, in the order of the input.
     */
    saveMany(comments: readonly NormalizedComment[]): Promise<readonly Comment[]>;
}
