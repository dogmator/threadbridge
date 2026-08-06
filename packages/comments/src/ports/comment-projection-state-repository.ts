import type {CommentId} from '../domain/identifiers.js';

export interface CommentProjectionStateRepository {
    markDeleted(commentId: CommentId): Promise<void>;
}
