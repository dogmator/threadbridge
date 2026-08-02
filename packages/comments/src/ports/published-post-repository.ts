import type {PostId} from '../domain/identifiers.js';
import type {PublishedPostContext} from '../domain/post.js';

export interface PublishedPostRepository {
    /**
     * Resolves the platform binding of a published post by its internal identifier, or null when
     * no such post exists.
     */
    findContextByPostId(postId: PostId): Promise<PublishedPostContext | null>;
}
