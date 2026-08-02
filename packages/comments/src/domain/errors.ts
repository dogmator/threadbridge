/**
 * Failures a social-platform adapter translates external errors into. Raw platform payloads and
 * credentials must never reach these messages.
 */
export type PlatformFailure =
    | {readonly code: 'PLATFORM_AUTHENTICATION_FAILED'; readonly message: string}
    | {readonly code: 'PLATFORM_RATE_LIMITED'; readonly message: string}
    | {readonly code: 'PLATFORM_UNAVAILABLE'; readonly message: string};

export interface CommentNotFoundFailure {
    readonly code: 'COMMENT_NOT_FOUND';
    readonly message: string;
}

export interface PostNotFoundFailure {
    readonly code: 'POST_NOT_FOUND';
    readonly message: string;
}

export interface UnsupportedPlatformFailure {
    readonly code: 'UNSUPPORTED_PLATFORM';
    readonly message: string;
}
