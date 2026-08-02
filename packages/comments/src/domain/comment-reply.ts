import type {AccountId, ExternalCommentId, PostId, SocialPlatform} from './identifiers.js';

/**
 * Everything retrieving the direct replies of a comment needs, resolved from the internal comment
 * identifier so callers never choose the platform or any external identifier themselves.
 */
export interface CommentReplyContext {
    readonly postId: PostId;
    readonly accountId: AccountId;
    readonly platform: SocialPlatform;
    readonly externalParentCommentId: ExternalCommentId;
}
