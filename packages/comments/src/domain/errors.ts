import type {CommentId, PostId, SocialPlatform} from './identifiers.js';

/**
 * Failures a social-platform adapter translates external errors into. They carry the discriminant
 * only: raw provider payloads, credentials, tokens, and provider messages must never leave an
 * adapter.
 */
export type PlatformFailure =
    | {readonly code: 'PLATFORM_AUTHENTICATION_FAILED'}
    | {readonly code: 'PLATFORM_RATE_LIMITED'}
    | {readonly code: 'PLATFORM_UNAVAILABLE'};

export interface CommentNotFoundFailure {
    readonly code: 'COMMENT_NOT_FOUND';
    readonly commentId: CommentId;
}

export interface PostNotFoundFailure {
    readonly code: 'POST_NOT_FOUND';
    readonly postId: PostId;
}

export interface UnsupportedPlatformFailure {
    readonly code: 'UNSUPPORTED_PLATFORM';
    readonly platform: SocialPlatform;
}

/**
 * Every failure the implemented comments use cases can produce. Failures are machine-readable: the
 * client-facing message of each code is chosen by the transport layer, never by the core.
 */
export type CommentsFailure =
    | CommentNotFoundFailure
    | PostNotFoundFailure
    | UnsupportedPlatformFailure
    | PlatformFailure;
