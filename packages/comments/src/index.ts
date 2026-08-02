export {GetCommentReplies} from './application/get-comment-replies.js';
export type {
    GetCommentRepliesFailure,
    GetCommentRepliesQuery,
} from './application/get-comment-replies.js';
export {GetPostComments} from './application/get-post-comments.js';
export {ReplyToComment} from './application/reply-to-comment.js';
export type {
    ReplyToCommentFailure,
    ReplyToCommentQuery,
    ReplyToCommentSuccess,
} from './application/reply-to-comment.js';
export type {
    GetPostCommentsFailure,
    GetPostCommentsQuery,
} from './application/get-post-comments.js';
export type {Comment, CommentPage, NormalizedComment, PublishedReply} from './domain/comment.js';
export type {CommentReplyContext} from './domain/comment-reply.js';
export type {
    CommentNotFoundFailure,
    CommentsFailure,
    IdempotencyConflictFailure,
    IndeterminatePlatformResultFailure,
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
    toIdempotencyKey,
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
export type {CommentReplyContextRepository} from './ports/comment-reply-context-repository.js';
export type {CommentRepository, SavePublishedReplyResult} from './ports/comment-repository.js';
export type {PublishedPostRepository} from './ports/published-post-repository.js';
export type {
    GetPlatformCommentsInput,
    GetPlatformRepliesInput,
    ReplyToPlatformCommentInput,
    SocialCommentsGateway,
} from './ports/social-comments-gateway.js';
