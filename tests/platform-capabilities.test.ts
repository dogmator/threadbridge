import {describe, expect, it} from 'vitest';
import {
    GetCommentReplies,
    GetPostComments,
    ReplyToComment,
    toAccountId,
    toCommentId,
    toExternalCommentId,
    toExternalPostId,
    toIdempotencyKey,
    toPostId,
    toSocialPlatform,
    type Comment,
    type CommentReplyContext,
    type CommentReplyContextRepository,
    type CommentRepository,
    type NormalizedComment,
    type PlatformComment,
    type PlatformCommentPage,
    type PlatformFailure,
    type PublishedPostContext,
    type PublishedPostRepository,
    type Result,
    type SavePublishedReplyResult,
    type SocialCommentsCapabilities,
    type SocialCommentsGateway,
    type SocialPlatform,
} from '@threadbridge/comments';

const accountId = toAccountId('account-1');
const postId = toPostId('post-1');
const commentId = toCommentId('comment-1');
const platform = toSocialPlatform('limited');

const capabilities = (
    overrides: Partial<SocialCommentsCapabilities>,
): SocialCommentsCapabilities => ({
    rootComments: true,
    directReplies: true,
    replyPublication: true,
    publicationIdempotency: 'none',
    ...overrides,
});

class RecordingGateway implements SocialCommentsGateway {
    public getCommentsCalls = 0;
    public getRepliesCalls = 0;
    public replyToCommentCalls = 0;

    public constructor(public readonly capabilities: SocialCommentsCapabilities) {}

    public getComments(): Promise<Result<PlatformCommentPage, PlatformFailure>> {
        this.getCommentsCalls += 1;

        return Promise.resolve({ok: true, value: {items: [], nextCursor: null}});
    }

    public getReplies(): Promise<Result<PlatformCommentPage, PlatformFailure>> {
        this.getRepliesCalls += 1;

        return Promise.resolve({ok: true, value: {items: [], nextCursor: null}});
    }

    public replyToComment(): Promise<Result<PlatformComment, PlatformFailure>> {
        this.replyToCommentCalls += 1;

        throw new Error('Unsupported publication must not reach the adapter.');
    }
}

class NoWriteCommentRepository implements CommentRepository {
    public saveMany(comments: readonly NormalizedComment[]): Promise<readonly Comment[]> {
        if (comments.length !== 0) {
            throw new Error('The capability tests only use empty pages.');
        }

        return Promise.resolve([]);
    }

    public findByIdempotencyKey(): Promise<Comment | null> {
        return Promise.resolve(null);
    }

    public savePublishedReply(): Promise<SavePublishedReplyResult> {
        throw new Error('Unsupported publication must not be persisted.');
    }
}

const posts: PublishedPostRepository = {
    findContextByPostId: (): Promise<PublishedPostContext | null> => Promise.resolve({
        accountId,
        platform,
        externalPostId: toExternalPostId('external-post-1'),
    }),
};

const contexts: CommentReplyContextRepository = {
    findByCommentId: (): Promise<CommentReplyContext | null> => Promise.resolve({
        postId,
        accountId,
        platform,
        externalParentCommentId: toExternalCommentId('external-comment-1'),
    }),
};

const registry = (gateway: SocialCommentsGateway): ReadonlyMap<SocialPlatform, SocialCommentsGateway> =>
    new Map<SocialPlatform, SocialCommentsGateway>([[platform, gateway]]);

describe('provider capability checks', () => {
    it('rejects unsupported root-comment retrieval without invoking the adapter', async () => {
        const gateway = new RecordingGateway(capabilities({rootComments: false}));
        const result = await new GetPostComments(
            posts,
            registry(gateway),
            new NoWriteCommentRepository(),
        ).execute({postId});

        expect(result).toEqual({
            ok: false,
            error: {code: 'PLATFORM_OPERATION_UNSUPPORTED'},
        });
        expect(gateway.getCommentsCalls).toBe(0);
    });

    it('rejects unsupported direct-reply retrieval without invoking the adapter', async () => {
        const gateway = new RecordingGateway(capabilities({directReplies: false}));
        const result = await new GetCommentReplies(
            contexts,
            registry(gateway),
            new NoWriteCommentRepository(),
        ).execute({commentId});

        expect(result).toEqual({
            ok: false,
            error: {code: 'PLATFORM_OPERATION_UNSUPPORTED'},
        });
        expect(gateway.getRepliesCalls).toBe(0);
    });

    it('rejects unsupported reply publication without invoking or persisting', async () => {
        const gateway = new RecordingGateway(capabilities({replyPublication: false}));
        const result = await new ReplyToComment(
            contexts,
            registry(gateway),
            new NoWriteCommentRepository(),
        ).execute({
            parentCommentId: commentId,
            content: 'Reply',
            idempotencyKey: toIdempotencyKey('key-1'),
        });

        expect(result).toEqual({
            ok: false,
            error: {code: 'PLATFORM_OPERATION_UNSUPPORTED'},
        });
        expect(gateway.replyToCommentCalls).toBe(0);
    });
});
