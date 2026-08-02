import {describe, expect, it} from 'vitest';
import {toHttpErrorResponse} from '../apps/api/src/http-error.js';
import {
    toCommentId,
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
};

const expected = {
    POST_NOT_FOUND: {status: 404, message: 'Post was not found'},
    COMMENT_NOT_FOUND: {status: 404, message: 'Comment was not found'},
    UNSUPPORTED_PLATFORM: {status: 422, message: 'Platform is not supported'},
    PLATFORM_AUTHENTICATION_FAILED: {status: 502, message: 'Platform authentication failed'},
    PLATFORM_RATE_LIMITED: {status: 429, message: 'Platform rate limit was exceeded'},
    PLATFORM_UNAVAILABLE: {status: 503, message: 'Platform is unavailable'},
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
});
