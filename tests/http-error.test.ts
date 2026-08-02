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
    PLATFORM_RATE_LIMITED: {code: 'PLATFORM_RATE_LIMITED'},
    PLATFORM_UNAVAILABLE: {code: 'PLATFORM_UNAVAILABLE'},
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
    PLATFORM_RATE_LIMITED: {status: 429, message: 'Platform rate limit was exceeded'},
    PLATFORM_UNAVAILABLE: {status: 503, message: 'Platform is unavailable'},
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
