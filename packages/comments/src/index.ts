export {GetPostComments} from './application/get-post-comments.js';
export type {
    GetPostCommentsFailure,
    GetPostCommentsQuery,
} from './application/get-post-comments.js';
export type {Comment, CommentPage, NormalizedComment} from './domain/comment.js';
export type {
    PlatformFailure,
    PostNotFoundFailure,
    UnsupportedPlatformFailure,
} from './domain/errors.js';
export {
    toAccountId,
    toCommentId,
    toCursor,
    toExternalAuthorId,
    toExternalCommentId,
    toExternalPostId,
    toPostId,
    toSocialPlatform,
} from './domain/identifiers.js';
export type {
    AccountId,
    CommentId,
    Cursor,
    ExternalAuthorId,
    ExternalCommentId,
    ExternalPostId,
    IdempotencyKey,
    PostId,
    SocialPlatform,
} from './domain/identifiers.js';
export type {
    PlatformComment,
    PlatformCommentPage,
    PlatformMetadata,
} from './domain/platform.js';
export type {PublishedPostContext} from './domain/post.js';
export {err, ok} from './domain/result.js';
export type {Result} from './domain/result.js';
export type {CommentRepository} from './ports/comment-repository.js';
export type {PublishedPostRepository} from './ports/published-post-repository.js';
export type {
    GetPlatformCommentsInput,
    SocialCommentsGateway,
} from './ports/social-comments-gateway.js';
