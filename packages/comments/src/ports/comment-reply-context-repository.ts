import type {CommentReplyContext} from '../domain/comment-reply.js';
import type {CommentId} from '../domain/identifiers.js';

export interface CommentReplyContextRepository {
    /**
     * Resolves the reply context of a comment by its internal identifier, or null when no such
     * comment exists.
     */
    findByCommentId(commentId: CommentId): Promise<CommentReplyContext | null>;
}
