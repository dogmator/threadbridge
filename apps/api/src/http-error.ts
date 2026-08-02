import type {CommentsFailure} from '@threadbridge/comments';

export interface HttpErrorEnvelope {
    readonly error: {
        readonly code: string;
        readonly message: string;
        readonly requestId: string;
    };
}

export interface HttpErrorResponse {
    readonly status: number;
    readonly body: HttpErrorEnvelope;
}

export const toErrorEnvelope = (
    code: string,
    message: string,
    requestId: string,
): HttpErrorEnvelope => ({error: {code, message, requestId}});

/**
 * Chooses the status and the safe client-facing message of a core failure. Structured failure
 * fields stay inside the application: they never reach the response body.
 */
export const toHttpErrorResponse = (
    failure: CommentsFailure,
    requestId: string,
): HttpErrorResponse => {
    switch (failure.code) {
        case 'POST_NOT_FOUND':
            return {
                status: 404,
                body: toErrorEnvelope(failure.code, 'Post was not found', requestId),
            };
        case 'COMMENT_NOT_FOUND':
            return {
                status: 404,
                body: toErrorEnvelope(failure.code, 'Comment was not found', requestId),
            };
        case 'UNSUPPORTED_PLATFORM':
            return {
                status: 422,
                body: toErrorEnvelope(failure.code, 'Platform is not supported', requestId),
            };
        case 'PLATFORM_AUTHENTICATION_FAILED':
            return {
                status: 502,
                body: toErrorEnvelope(failure.code, 'Platform authentication failed', requestId),
            };
        case 'PLATFORM_RATE_LIMITED':
            return {
                status: 429,
                body: toErrorEnvelope(
                    failure.code,
                    'Platform rate limit was exceeded',
                    requestId,
                ),
            };
        case 'PLATFORM_UNAVAILABLE':
            return {
                status: 503,
                body: toErrorEnvelope(failure.code, 'Platform is unavailable', requestId),
            };
        case 'IDEMPOTENCY_CONFLICT':
            return {
                status: 409,
                body: toErrorEnvelope(
                    failure.code,
                    'Idempotency key conflicts with an existing request',
                    requestId,
                ),
            };
        case 'INDETERMINATE_PLATFORM_RESULT':
            return {
                status: 502,
                body: toErrorEnvelope(failure.code, 'Platform result is indeterminate', requestId),
            };
    }
};
