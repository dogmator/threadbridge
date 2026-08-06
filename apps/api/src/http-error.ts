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
    readonly headers?: Readonly<Record<string, string>>;
    readonly body: HttpErrorEnvelope;
}

export const toErrorEnvelope = (
    code: string,
    message: string,
    requestId: string,
): HttpErrorEnvelope => ({error: {code, message, requestId}});

const response = (
    status: number,
    failure: CommentsFailure,
    message: string,
    requestId: string,
): HttpErrorResponse => ({
    status,
    body: toErrorEnvelope(failure.code, message, requestId),
});

const retryAfterHeader = (seconds: number | undefined): Readonly<Record<string, string>> | undefined =>
    seconds !== undefined && Number.isSafeInteger(seconds) && seconds >= 0
        ? {'retry-after': String(seconds)}
        : undefined;

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
            return response(404, failure, 'Post was not found', requestId);
        case 'COMMENT_NOT_FOUND':
            return response(404, failure, 'Comment was not found', requestId);
        case 'UNSUPPORTED_PLATFORM':
            return response(422, failure, 'Platform is not supported', requestId);
        case 'PLATFORM_AUTHENTICATION_FAILED':
            return response(502, failure, 'Platform authentication failed', requestId);
        case 'PLATFORM_PERMISSION_DENIED':
            return response(502, failure, 'Platform permission was denied', requestId);
        case 'PLATFORM_RESOURCE_NOT_FOUND':
            return response(404, failure, 'Platform resource was not found', requestId);
        case 'PLATFORM_VALIDATION_FAILED':
            return response(422, failure, 'Platform rejected the request', requestId);
        case 'PLATFORM_RATE_LIMITED': {
            const mapped = response(
                429,
                failure,
                'Platform rate limit was exceeded',
                requestId,
            );
            const headers = retryAfterHeader(failure.retryAfterSeconds);

            return headers === undefined ? mapped : {...mapped, headers};
        }
        case 'PLATFORM_TIMEOUT':
            return response(504, failure, 'Platform request timed out', requestId);
        case 'PLATFORM_UNAVAILABLE':
            return response(503, failure, 'Platform is unavailable', requestId);
        case 'PLATFORM_OPERATION_UNSUPPORTED':
            return response(422, failure, 'Platform operation is not supported', requestId);
        case 'PLATFORM_CURSOR_INVALID':
            return response(400, failure, 'Platform cursor is invalid', requestId);
        case 'IDEMPOTENCY_CONFLICT':
            return response(
                409,
                failure,
                'Idempotency key conflicts with an existing request',
                requestId,
            );
        case 'INDETERMINATE_PLATFORM_RESULT':
            return response(502, failure, 'Platform result is indeterminate', requestId);
    }
};
