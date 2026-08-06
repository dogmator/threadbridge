import {describe, expect, it} from 'vitest';
import {toHttpErrorResponse} from '../apps/api/src/http-error.js';
import {
    toCommentId,
    toIdempotencyKey,
    toPostId,
    toSocialPlatform,
    type CommentsFailure,
} from '@threadbridge/comments';

/**
 * A value for every implemented failure code. The mapped type fails to compile when a new code
 * joins CommentsFailure without a fixture, and the mapper's exhaustive switch fails to compile
 * when that code is not handled.
 */
const failures: {
    readonly [Code in CommentsFailure['code']]: Extract<CommentsFailure, {code: Code}>;
} = {
    POST_NOT_FOUND: {code: 'POST_NOT_FOUND', postId: toPostId('post-1')},
    COMMENT_NOT_FOUND: {code: 'COMMENT_NOT_FOUND', commentId: toCommentId('comment-1')},
    UNSUPPORTED_PLATFORM: {
        code: 'UNSUPPORTED_PLATFORM',
        platform: toSocialPlatform('unregistered'),
    },
    PLATFORM_AUTHENTICATION_FAILED: {code: 'PLATFORM_AUTHENTICATION_FAILED'},
    PLATFORM_PERMISSION_DENIED: {code: 'PLATFORM_PERMISSION_DENIED'},
    PLATFORM_RESOURCE_NOT_FOUND: {code: 'PLATFORM_RESOURCE_NOT_FOUND'},
    PLATFORM_VALIDATION_FAILED: {code: 'PLATFORM_VALIDATION_FAILED'},
    PLATFORM_RATE_LIMITED: {code: 'PLATFORM_RATE_LIMITED'},
    PLATFORM_TIMEOUT: {code: 'PLATFORM_TIMEOUT'},
    PLATFORM_UNAVAILABLE: {code: 'PLATFORM_UNAVAILABLE'},
    PLATFORM_OPERATION_UNSUPPORTED: {code: 'PLATFORM_OPERATION_UNSUPPORTED'},
    PLATFORM_CURSOR_INVALID: {code: 'PLATFORM_CURSOR_INVALID'},
    IDEMPOTENCY_CONFLICT: {
        code: 'IDEMPOTENCY_CONFLICT',
        idempotencyKey: toIdempotencyKey('key-1'),
    },
    INDETERMINATE_PLATFORM_RESULT: {
        code: 'INDETERMINATE_PLATFORM_RESULT',
        platform: toSocialPlatform('demo'),
    },
};

const expected = {
    POST_NOT_FOUND: {status: 404, message: 'Post was not found'},
    COMMENT_NOT_FOUND: {status: 404, message: 'Comment was not found'},
    UNSUPPORTED_PLATFORM: {status: 422, message: 'Platform is not supported'},
    PLATFORM_AUTHENTICATION_FAILED: {status: 502, message: 'Platform authentication failed'},
    PLATFORM_PERMISSION_DENIED: {status: 502, message: 'Platform permission was denied'},
    PLATFORM_RESOURCE_NOT_FOUND: {status: 404, message: 'Platform resource was not found'},
    PLATFORM_VALIDATION_FAILED: {status: 422, message: 'Platform rejected the request'},
    PLATFORM_RATE_LIMITED: {status: 429, message: 'Platform rate limit was exceeded'},
    PLATFORM_TIMEOUT: {status: 504, message: 'Platform request timed out'},
    PLATFORM_UNAVAILABLE: {status: 503, message: 'Platform is unavailable'},
    PLATFORM_OPERATION_UNSUPPORTED: {
        status: 422,
        message: 'Platform operation is not supported',
    },
    PLATFORM_CURSOR_INVALID: {status: 400, message: 'Platform cursor is invalid'},
    IDEMPOTENCY_CONFLICT: {
        status: 409,
        message: 'Idempotency key conflicts with an existing request',
    },
    INDETERMINATE_PLATFORM_RESULT: {status: 502, message: 'Platform result is indeterminate'},
} as const satisfies Record<CommentsFailure['code'], {status: number; message: string}>;

describe('toHttpErrorResponse', () => {
    it.each(Object.values(failures))(
        'maps $code to its required status and safe message',
        (failure: CommentsFailure) => {
            const {status, message} = expected[failure.code];

            expect(toHttpErrorResponse(failure, 'request-1')).toEqual({
                status,
                body: {error: {code: failure.code, message, requestId: 'request-1'}},
            });
        },
    );

    it('preserves the provided request identifier exactly', () => {
        const response = toHttpErrorResponse(failures.PLATFORM_RATE_LIMITED, '019-abc-request');

        expect(response.body.error.requestId).toBe('019-abc-request');
    });

    it('returns Retry-After when a provider supplies a valid delay hint', () => {
        const response = toHttpErrorResponse(
            {code: 'PLATFORM_RATE_LIMITED', retryAfterSeconds: 30},
            'request-1',
        );

        expect(response.headers).toEqual({'retry-after': '30'});
    });

    it('does not emit an invalid Retry-After value', () => {
        const response = toHttpErrorResponse(
            {code: 'PLATFORM_RATE_LIMITED', retryAfterSeconds: -1},
            'request-1',
        );

        expect(response).not.toHaveProperty('headers');
    });

    it('never leaks structured failure fields into the response body', () => {
        const response = toHttpErrorResponse(failures.POST_NOT_FOUND, 'request-1');

        expect(Object.keys(response.body.error)).toEqual(['code', 'message', 'requestId']);
        expect(JSON.stringify(response.body)).not.toContain('post-1');
    });

    it('never leaks the idempotency key or the platform of a publication failure', () => {
        const conflict = toHttpErrorResponse(failures.IDEMPOTENCY_CONFLICT, 'request-1');
        const indeterminate = toHttpErrorResponse(
            failures.INDETERMINATE_PLATFORM_RESULT,
            'request-1',
        );

        expect(JSON.stringify(conflict.body)).not.toContain('key-1');
        expect(JSON.stringify(indeterminate.body)).not.toContain('demo');
    });
});
