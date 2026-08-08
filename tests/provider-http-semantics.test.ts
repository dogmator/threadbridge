import {once} from 'node:events';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {createApiServer} from '../apps/api/src/server.js';
import type {HttpErrorEnvelope} from '../apps/api/src/http-error.js';
import {
    GetCommentReplies,
    GetPostComments,
    ReplyToComment,
    toAccountId,
    toExternalPostId,
    toSocialPlatform,
    type Comment,
    type CommentReplyContext,
    type CommentReplyContextRepository,
    type CommentRepository,
    type GetPlatformCommentsInput,
    type PlatformComment,
    type PlatformCommentPage,
    type PlatformFailure,
    type PublishedPostContext,
    type PublishedPostRepository,
    type Result,
    type SavePublishedReplyResult,
    type SocialCommentsGateway,
    type SocialPlatform,
} from '@threadbridge/comments';

const POST_ID = '0198f000-0000-7000-8000-000000000021';
const platform = toSocialPlatform('provider-http-test');
const accountId = toAccountId('account-http-test');

class ProviderSemanticsGateway implements SocialCommentsGateway {
    public readonly capabilities = {
        rootComments: true,
        directReplies: false,
        replyPublication: false,
        publicationIdempotency: 'none',
    } as const;

    public getComments(
        input: GetPlatformCommentsInput,
    ): Promise<Result<PlatformCommentPage, PlatformFailure>> {
        if (input.cursor === null) {
            return Promise.resolve({
                ok: false,
                error: {code: 'PLATFORM_RATE_LIMITED', retryAfterSeconds: 30},
            });
        }

        return Promise.resolve({ok: false, error: {code: 'PLATFORM_CURSOR_INVALID'}});
    }

    public getReplies(): Promise<Result<PlatformCommentPage, PlatformFailure>> {
        return Promise.resolve({
            ok: false,
            error: {code: 'PLATFORM_OPERATION_UNSUPPORTED'},
        });
    }

    public replyToComment(): Promise<Result<PlatformComment, PlatformFailure>> {
        return Promise.resolve({
            ok: false,
            error: {code: 'PLATFORM_OPERATION_UNSUPPORTED'},
        });
    }
}

class NoWriteCommentRepository implements CommentRepository {
    public saveMany(): Promise<readonly Comment[]> {
        throw new Error('A provider failure must not persist comments.');
    }

    public findByIdempotencyKey(): Promise<Comment | null> {
        return Promise.resolve(null);
    }

    public savePublishedReply(): Promise<SavePublishedReplyResult> {
        throw new Error('These tests never publish replies.');
    }
}

const posts: PublishedPostRepository = {
    findContextByPostId: (): Promise<PublishedPostContext | null> => Promise.resolve({
        accountId,
        platform,
        externalPostId: toExternalPostId('provider-post'),
    }),
};

const contexts: CommentReplyContextRepository = {
    findByCommentId: (): Promise<CommentReplyContext | null> => Promise.resolve(null),
};

const comments = new NoWriteCommentRepository();
const gateways = new Map<SocialPlatform, SocialCommentsGateway>([
    [platform, new ProviderSemanticsGateway()],
]);

describe('provider HTTP semantics', () => {
    const server = createApiServer({
        requestIdFactory: (): string => 'request-provider-semantics',
        checkReadiness: (): Promise<void> => Promise.resolve(),
        getPostComments: new GetPostComments(posts, gateways, comments),
        getCommentReplies: new GetCommentReplies(contexts, gateways, comments),
        replyToComment: new ReplyToComment(contexts, gateways, comments),
    });
    let baseUrl = '';

    beforeAll(async (): Promise<void> => {
        await server.listen(0, '127.0.0.1');

        const address = server.address();

        if (address === null || typeof address === 'string') {
            throw new Error('The test server is not listening on a TCP port.');
        }

        baseUrl = `http://127.0.0.1:${String(address.port)}`;
    });

    afterAll(async (): Promise<void> => {
        server.close();
        server.closeAllConnections();
        await once(server, 'close');
    });

    it('forwards a valid provider rate-limit hint as Retry-After', async () => {
        const response = await fetch(`${baseUrl}/posts/${POST_ID}/comments`);
        const body = (await response.json()) as HttpErrorEnvelope;

        expect(response.status).toBe(429);
        expect(response.headers.get('retry-after')).toBe('30');
        expect(body.error).toEqual({
            code: 'PLATFORM_RATE_LIMITED',
            message: 'Platform rate limit was exceeded',
            requestId: 'request-provider-semantics',
        });
    });

    it('maps an adapter-rejected cursor to a stable client error', async () => {
        const response = await fetch(`${baseUrl}/posts/${POST_ID}/comments?cursor=foreign`);
        const body = (await response.json()) as HttpErrorEnvelope;

        expect(response.status).toBe(400);
        expect(body.error).toEqual({
            code: 'PLATFORM_CURSOR_INVALID',
            message: 'Platform cursor is invalid',
            requestId: 'request-provider-semantics',
        });
    });
});
