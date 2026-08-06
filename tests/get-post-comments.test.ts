import {describe, expect, it} from 'vitest';
import {
    err,
    GetPostComments,
    ok,
    toAccountId,
    toCommentId,
    toCursor,
    toExternalAuthorId,
    toExternalCommentId,
    toExternalPostId,
    toPostId,
    toSocialPlatform,
    type Comment,
    type CommentRepository,
    type GetPlatformCommentsInput,
    type NormalizedComment,
    type PlatformComment,
    type PlatformCommentPage,
    type PlatformFailure,
    type PostId,
    type PublishedPostContext,
    type PublishedPostRepository,
    type Result,
    type SocialCommentsGateway,
    type SocialPlatform,
} from '../packages/comments/src/index.js';

const demoPlatform = toSocialPlatform('demo');
const postId = toPostId('post-1');
const accountId = toAccountId('account-1');
const externalPostId = toExternalPostId('external-post-1');
const platformCreatedAt = new Date('2026-01-01T10:00:00.000Z');
const storedAt = new Date('2026-02-01T00:00:00.000Z');

const postContext: PublishedPostContext = {
    accountId,
    platform: demoPlatform,
    externalPostId,
};

const platformComment = (suffix: string): PlatformComment => ({
    externalCommentId: toExternalCommentId(`external-comment-${suffix}`),
    externalAuthorId: toExternalAuthorId(`external-author-${suffix}`),
    content: `Comment ${suffix}`,
    createdAt: platformCreatedAt,
    metadata: {likes: 3},
});

const normalizedComment = (suffix: string): NormalizedComment => ({
    postId,
    parentCommentId: null,
    externalCommentId: toExternalCommentId(`external-comment-${suffix}`),
    externalAuthorId: toExternalAuthorId(`external-author-${suffix}`),
    content: `Comment ${suffix}`,
    platformCreatedAt,
    metadata: {likes: 3},
});

const storedComment = (suffix: string, id: string, version: number): Comment => ({
    ...normalizedComment(suffix),
    id: toCommentId(id),
    createdAt: storedAt,
    updatedAt: storedAt,
    version,
});

class StubPublishedPostRepository implements PublishedPostRepository {
    public readonly receivedPostIds: PostId[] = [];

    public constructor(private readonly context: PublishedPostContext | null) {}

    public findContextByPostId(postIdToResolve: PostId): Promise<PublishedPostContext | null> {
        this.receivedPostIds.push(postIdToResolve);

        return Promise.resolve(this.context);
    }
}

class StubSocialCommentsGateway implements SocialCommentsGateway {
    public readonly capabilities = {
        rootComments: true,
        directReplies: true,
        replyPublication: false,
        publicationIdempotency: 'none',
    } as const;

    public readonly receivedInputs: GetPlatformCommentsInput[] = [];

    public constructor(private readonly response: Result<PlatformCommentPage, PlatformFailure>) {}

    public getComments(
        input: GetPlatformCommentsInput,
    ): Promise<Result<PlatformCommentPage, PlatformFailure>> {
        this.receivedInputs.push(input);

        return Promise.resolve(this.response);
    }

    public getReplies(): Promise<Result<PlatformCommentPage, PlatformFailure>> {
        throw new Error('GetPostComments must not request replies.');
    }

    public replyToComment(): never {
        throw new Error('GetPostComments must not publish replies.');
    }
}

class InMemoryCommentRepository implements CommentRepository {
    public readonly savedBatches: (readonly NormalizedComment[])[] = [];

    private readonly comments = new Map<string, Comment>();

    private nextId = 1;

    public saveMany(comments: readonly NormalizedComment[]): Promise<readonly Comment[]> {
        this.savedBatches.push(comments);

        return Promise.resolve(comments.map((comment): Comment => this.upsert(comment)));
    }

    public get storedComments(): readonly Comment[] {
        return [...this.comments.values()];
    }

    public findByIdempotencyKey(): never {
        throw new Error('Retrieval must not look up idempotency keys.');
    }

    public savePublishedReply(): never {
        throw new Error('Retrieval must not publish replies.');
    }

    private upsert(comment: NormalizedComment): Comment {
        const key = [comment.postId, comment.externalCommentId].join(':');
        const existing = this.comments.get(key);
        const stored: Comment =
            existing === undefined
                ? {
                      ...comment,
                      id: toCommentId(`comment-${String(this.nextId)}`),
                      createdAt: storedAt,
                      updatedAt: storedAt,
                      version: 1,
                  }
                : {...existing, ...comment, updatedAt: storedAt, version: existing.version + 1};

        if (existing === undefined) {
            this.nextId += 1;
        }

        this.comments.set(key, stored);

        return stored;
    }
}

const useCaseFor = (
    posts: PublishedPostRepository,
    gateway: SocialCommentsGateway,
    comments: CommentRepository,
): GetPostComments =>
    new GetPostComments(
        posts,
        new Map<SocialPlatform, SocialCommentsGateway>([[demoPlatform, gateway]]),
        comments,
    );

describe('GetPostComments', () => {
    it('resolves the post context from the internal post identifier', async () => {
        const posts = new StubPublishedPostRepository(postContext);
        const gateway = new StubSocialCommentsGateway(
            ok<PlatformCommentPage>({items: [], nextCursor: null}),
        );

        await useCaseFor(posts, gateway, new InMemoryCommentRepository()).execute({postId});

        expect(posts.receivedPostIds).toEqual(['post-1']);
    });

    it('returns the normalized page of root comments with the next cursor', async () => {
        const repository = new InMemoryCommentRepository();
        const gateway = new StubSocialCommentsGateway(
            ok<PlatformCommentPage>({
                items: [platformComment('a'), platformComment('b')],
                nextCursor: toCursor('platform-page-2'),
            }),
        );

        const result = await useCaseFor(
            new StubPublishedPostRepository(postContext),
            gateway,
            repository,
        ).execute({postId});

        expect(result).toEqual({
            ok: true,
            value: {
                items: [storedComment('a', 'comment-1', 1), storedComment('b', 'comment-2', 1)],
                nextCursor: 'platform-page-2',
            },
        });
    });

    it('returns a null next cursor when the platform reports the last page', async () => {
        const gateway = new StubSocialCommentsGateway(
            ok<PlatformCommentPage>({items: [], nextCursor: null}),
        );

        const result = await useCaseFor(
            new StubPublishedPostRepository(postContext),
            gateway,
            new InMemoryCommentRepository(),
        ).execute({postId});

        expect(result).toEqual({ok: true, value: {items: [], nextCursor: null}});
    });

    it('passes the resolved account, external post identifier, and cursor to the gateway', async () => {
        const gateway = new StubSocialCommentsGateway(
            ok<PlatformCommentPage>({items: [], nextCursor: null}),
        );

        await useCaseFor(
            new StubPublishedPostRepository(postContext),
            gateway,
            new InMemoryCommentRepository(),
        ).execute({postId, cursor: toCursor('platform-page-2')});

        expect(gateway.receivedInputs).toEqual([
            {
                accountId: 'account-1',
                externalPostId: 'external-post-1',
                cursor: 'platform-page-2',
            },
        ]);
    });

    it('requests the first page when the caller supplies no cursor', async () => {
        const gateway = new StubSocialCommentsGateway(
            ok<PlatformCommentPage>({items: [], nextCursor: null}),
        );

        await useCaseFor(
            new StubPublishedPostRepository(postContext),
            gateway,
            new InMemoryCommentRepository(),
        ).execute({postId});

        expect(gateway.receivedInputs).toEqual([
            {accountId: 'account-1', externalPostId: 'external-post-1', cursor: null},
        ]);
    });

    it('rejects a caller-supplied platform or external post identifier', async () => {
        const gateway = new StubSocialCommentsGateway(
            ok<PlatformCommentPage>({items: [], nextCursor: null}),
        );
        const useCase = useCaseFor(
            new StubPublishedPostRepository(postContext),
            gateway,
            new InMemoryCommentRepository(),
        );

        await useCase.execute({
            postId,
            // @ts-expect-error the platform is resolved from the post context, never supplied
            platform: toSocialPlatform('other'),
        });
        await useCase.execute({
            postId,
            // @ts-expect-error the external post id is resolved from the post context, never supplied
            externalPostId: toExternalPostId('external-post-from-caller'),
        });

        expect(gateway.receivedInputs).toEqual([
            {accountId: 'account-1', externalPostId: 'external-post-1', cursor: null},
            {accountId: 'account-1', externalPostId: 'external-post-1', cursor: null},
        ]);
    });

    it('persists the retrieved comments as normalized root comments without an idempotency key', async () => {
        const repository = new InMemoryCommentRepository();
        const gateway = new StubSocialCommentsGateway(
            ok<PlatformCommentPage>({items: [platformComment('a')], nextCursor: null}),
        );

        await useCaseFor(
            new StubPublishedPostRepository(postContext),
            gateway,
            repository,
        ).execute({postId});

        expect(repository.savedBatches).toEqual([[normalizedComment('a')]]);
        expect(repository.storedComments).toEqual([storedComment('a', 'comment-1', 1)]);
        expect(repository.storedComments).not.toHaveProperty('0.idempotencyKey');
    });

    it('does not duplicate a comment that was already retrieved', async () => {
        const repository = new InMemoryCommentRepository();
        const gateway = new StubSocialCommentsGateway(
            ok<PlatformCommentPage>({items: [platformComment('a')], nextCursor: null}),
        );
        const useCase = useCaseFor(
            new StubPublishedPostRepository(postContext),
            gateway,
            repository,
        );

        const first = await useCase.execute({postId});
        const second = await useCase.execute({postId});

        expect(repository.storedComments).toEqual([storedComment('a', 'comment-1', 2)]);
        expect(first).toEqual({
            ok: true,
            value: {items: [storedComment('a', 'comment-1', 1)], nextCursor: null},
        });
        expect(second).toEqual({
            ok: true,
            value: {items: [storedComment('a', 'comment-1', 2)], nextCursor: null},
        });
    });

    it('reports a missing post without calling the gateway', async () => {
        const repository = new InMemoryCommentRepository();
        const gateway = new StubSocialCommentsGateway(
            ok<PlatformCommentPage>({items: [platformComment('a')], nextCursor: null}),
        );

        const result = await useCaseFor(
            new StubPublishedPostRepository(null),
            gateway,
            repository,
        ).execute({postId});

        expect(result).toEqual({
            ok: false,
            error: {code: 'POST_NOT_FOUND', postId: 'post-1'},
        });
        expect(result).not.toHaveProperty('error.message');
        expect(gateway.receivedInputs).toEqual([]);
        expect(repository.savedBatches).toEqual([]);
    });

    it('returns the typed platform failure and persists nothing when the platform fails', async () => {
        const repository = new InMemoryCommentRepository();
        const gateway = new StubSocialCommentsGateway(
            err<PlatformFailure>({code: 'PLATFORM_RATE_LIMITED'}),
        );

        const result = await useCaseFor(
            new StubPublishedPostRepository(postContext),
            gateway,
            repository,
        ).execute({postId});

        expect(result).toEqual({
            ok: false,
            error: {code: 'PLATFORM_RATE_LIMITED'},
        });
        expect(repository.savedBatches).toEqual([]);
    });

    it('reports an unregistered platform without calling any gateway', async () => {
        const repository = new InMemoryCommentRepository();
        const gateway = new StubSocialCommentsGateway(
            ok<PlatformCommentPage>({items: [], nextCursor: null}),
        );
        const useCase = new GetPostComments(
            new StubPublishedPostRepository({...postContext, platform: toSocialPlatform('other')}),
            new Map<SocialPlatform, SocialCommentsGateway>([[demoPlatform, gateway]]),
            repository,
        );

        const result = await useCase.execute({postId});

        expect(result).toEqual({
            ok: false,
            error: {code: 'UNSUPPORTED_PLATFORM', platform: 'other'},
        });
        expect(gateway.receivedInputs).toEqual([]);
        expect(repository.savedBatches).toEqual([]);
    });
});
