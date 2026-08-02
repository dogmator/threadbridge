import {describe, expect, it} from 'vitest';
import {
    err,
    GetCommentReplies,
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
    type CommentId,
    type CommentPage,
    type CommentReplyContext,
    type CommentReplyContextRepository,
    type CommentRepository,
    type GetCommentRepliesFailure,
    type GetPlatformRepliesInput,
    type NormalizedComment,
    type PlatformComment,
    type PlatformCommentPage,
    type PlatformFailure,
    type Result,
    type SocialCommentsGateway,
    type SocialPlatform,
} from '../packages/comments/src/index.js';

const demoPlatform = toSocialPlatform('demo');
const otherPlatform = toSocialPlatform('other');
const commentId = toCommentId('comment-parent');
const postId = toPostId('post-1');
const accountId = toAccountId('account-1');
const externalParentCommentId = toExternalCommentId('external-comment-parent');
const platformCreatedAt = new Date('2026-01-01T10:00:00.000Z');
const storedAt = new Date('2026-02-01T00:00:00.000Z');

const replyContext: CommentReplyContext = {
    postId,
    accountId,
    platform: demoPlatform,
    externalParentCommentId,
};

const platformReply = (suffix: string): PlatformComment => ({
    externalCommentId: toExternalCommentId(`external-reply-${suffix}`),
    externalAuthorId: toExternalAuthorId(`external-author-${suffix}`),
    content: `Reply ${suffix}`,
    createdAt: platformCreatedAt,
    metadata: {likes: 7},
});

const normalizedReply = (suffix: string): NormalizedComment => ({
    postId,
    parentCommentId: commentId,
    externalCommentId: toExternalCommentId(`external-reply-${suffix}`),
    externalAuthorId: toExternalAuthorId(`external-author-${suffix}`),
    content: `Reply ${suffix}`,
    platformCreatedAt,
    metadata: {likes: 7},
});

const storedReply = (suffix: string, id: string, version: number): Comment => ({
    ...normalizedReply(suffix),
    id: toCommentId(id),
    createdAt: storedAt,
    updatedAt: storedAt,
    version,
});

const okValueOf = (result: Result<CommentPage, GetCommentRepliesFailure>): CommentPage => {
    if (!result.ok) {
        throw new Error(`Expected a successful result, received ${result.error.code}.`);
    }

    return result.value;
};

class StubCommentReplyContextRepository implements CommentReplyContextRepository {
    public readonly receivedCommentIds: CommentId[] = [];

    public constructor(private readonly context: CommentReplyContext | null) {}

    public findByCommentId(commentIdToResolve: CommentId): Promise<CommentReplyContext | null> {
        this.receivedCommentIds.push(commentIdToResolve);

        return Promise.resolve(this.context);
    }
}

class StubSocialCommentsGateway implements SocialCommentsGateway {
    public readonly receivedInputs: GetPlatformRepliesInput[] = [];

    public constructor(private readonly response: Result<PlatformCommentPage, PlatformFailure>) {}

    public getComments(): Promise<Result<PlatformCommentPage, PlatformFailure>> {
        throw new Error('GetCommentReplies must not request root comments.');
    }

    public getReplies(
        input: GetPlatformRepliesInput,
    ): Promise<Result<PlatformCommentPage, PlatformFailure>> {
        this.receivedInputs.push(input);

        return Promise.resolve(this.response);
    }
}

class InMemoryCommentRepository implements CommentRepository {
    public readonly savedBatches: (readonly NormalizedComment[])[] = [];

    public lastReturned: readonly Comment[] | null = null;

    private readonly comments = new Map<string, Comment>();

    private nextId = 1;

    public saveMany(comments: readonly NormalizedComment[]): Promise<readonly Comment[]> {
        this.savedBatches.push(comments);

        const stored = comments.map((comment): Comment => this.upsert(comment));

        this.lastReturned = stored;

        return Promise.resolve(stored);
    }

    public get storedComments(): readonly Comment[] {
        return [...this.comments.values()];
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
    contexts: CommentReplyContextRepository,
    gateway: SocialCommentsGateway,
    comments: CommentRepository,
): GetCommentReplies =>
    new GetCommentReplies(
        contexts,
        new Map<SocialPlatform, SocialCommentsGateway>([[demoPlatform, gateway]]),
        comments,
    );

const emptyPage = (): Result<PlatformCommentPage, PlatformFailure> =>
    ok<PlatformCommentPage>({items: [], nextCursor: null});

describe('GetCommentReplies', () => {
    it('resolves the reply context from the internal comment identifier', async () => {
        const contexts = new StubCommentReplyContextRepository(replyContext);

        await useCaseFor(
            contexts,
            new StubSocialCommentsGateway(emptyPage()),
            new InMemoryCommentRepository(),
        ).execute({commentId});

        expect(contexts.receivedCommentIds).toEqual(['comment-parent']);
    });

    it('rejects a caller-supplied platform, account, post, or external identifier', async () => {
        const gateway = new StubSocialCommentsGateway(emptyPage());
        const useCase = useCaseFor(
            new StubCommentReplyContextRepository(replyContext),
            gateway,
            new InMemoryCommentRepository(),
        );

        await useCase.execute({
            commentId,
            // @ts-expect-error the platform is resolved from the reply context, never supplied
            platform: otherPlatform,
        });
        await useCase.execute({
            commentId,
            // @ts-expect-error the account is resolved from the reply context, never supplied
            accountId: toAccountId('account-from-caller'),
        });
        await useCase.execute({
            commentId,
            // @ts-expect-error the post is resolved from the reply context, never supplied
            postId: toPostId('post-from-caller'),
        });
        await useCase.execute({
            commentId,
            // @ts-expect-error the external parent comment id is resolved, never supplied
            externalParentCommentId: toExternalCommentId('external-comment-from-caller'),
        });
        await useCase.execute({
            commentId,
            // @ts-expect-error no external post identifier may be supplied by the caller
            externalPostId: toExternalPostId('external-post-from-caller'),
        });

        expect(gateway.receivedInputs).toEqual(
            Array.from({length: 5}, () => ({
                accountId: 'account-1',
                externalParentCommentId: 'external-comment-parent',
                cursor: null,
            })),
        );
    });

    it('reports a missing comment without calling the gateway or the repository', async () => {
        const gateway = new StubSocialCommentsGateway(emptyPage());
        const repository = new InMemoryCommentRepository();

        const result = await useCaseFor(
            new StubCommentReplyContextRepository(null),
            gateway,
            repository,
        ).execute({commentId});

        expect(result).toEqual({
            ok: false,
            error: {code: 'COMMENT_NOT_FOUND', commentId: 'comment-parent'},
        });
        expect(result).not.toHaveProperty('error.message');
        expect(gateway.receivedInputs).toEqual([]);
        expect(repository.savedBatches).toEqual([]);
    });

    it('selects the gateway registered for the platform of the resolved context', async () => {
        const demoGateway = new StubSocialCommentsGateway(emptyPage());
        const otherGateway = new StubSocialCommentsGateway(emptyPage());
        const useCase = new GetCommentReplies(
            new StubCommentReplyContextRepository({...replyContext, platform: otherPlatform}),
            new Map<SocialPlatform, SocialCommentsGateway>([
                [demoPlatform, demoGateway],
                [otherPlatform, otherGateway],
            ]),
            new InMemoryCommentRepository(),
        );

        await useCase.execute({commentId});

        expect(otherGateway.receivedInputs).toHaveLength(1);
        expect(demoGateway.receivedInputs).toEqual([]);
    });

    it('reports an unregistered platform without persisting', async () => {
        const repository = new InMemoryCommentRepository();
        const gateway = new StubSocialCommentsGateway(emptyPage());
        const useCase = new GetCommentReplies(
            new StubCommentReplyContextRepository({...replyContext, platform: otherPlatform}),
            new Map<SocialPlatform, SocialCommentsGateway>([[demoPlatform, gateway]]),
            repository,
        );

        const result = await useCase.execute({commentId});

        expect(result).toEqual({
            ok: false,
            error: {code: 'UNSUPPORTED_PLATFORM', platform: 'other'},
        });
        expect(gateway.receivedInputs).toEqual([]);
        expect(repository.savedBatches).toEqual([]);
    });

    it('passes the resolved account, external parent comment, and cursor to the gateway', async () => {
        const gateway = new StubSocialCommentsGateway(emptyPage());

        await useCaseFor(
            new StubCommentReplyContextRepository(replyContext),
            gateway,
            new InMemoryCommentRepository(),
        ).execute({commentId, cursor: toCursor('platform-page-2')});

        expect(gateway.receivedInputs).toEqual([
            {
                accountId: 'account-1',
                externalParentCommentId: 'external-comment-parent',
                cursor: 'platform-page-2',
            },
        ]);
    });

    it('converts an omitted cursor to null before calling the gateway', async () => {
        const gateway = new StubSocialCommentsGateway(emptyPage());

        await useCaseFor(
            new StubCommentReplyContextRepository(replyContext),
            gateway,
            new InMemoryCommentRepository(),
        ).execute({commentId});

        expect(gateway.receivedInputs).toEqual([
            {
                accountId: 'account-1',
                externalParentCommentId: 'external-comment-parent',
                cursor: null,
            },
        ]);
    });

    it('persists the replies under the resolved post and the requested parent comment', async () => {
        const repository = new InMemoryCommentRepository();
        const gateway = new StubSocialCommentsGateway(
            ok<PlatformCommentPage>({items: [platformReply('a')], nextCursor: null}),
        );

        await useCaseFor(
            new StubCommentReplyContextRepository(replyContext),
            gateway,
            repository,
        ).execute({commentId});

        expect(repository.savedBatches).toEqual([[normalizedReply('a')]]);
        expect(repository.storedComments).toEqual([storedReply('a', 'comment-1', 1)]);
        expect(repository.storedComments).not.toHaveProperty('0.idempotencyKey');
    });

    it('returns the exact comment entities produced by the repository', async () => {
        const repository = new InMemoryCommentRepository();
        const gateway = new StubSocialCommentsGateway(
            ok<PlatformCommentPage>({
                items: [platformReply('a'), platformReply('b')],
                nextCursor: toCursor('platform-page-2'),
            }),
        );

        const result = await useCaseFor(
            new StubCommentReplyContextRepository(replyContext),
            gateway,
            repository,
        ).execute({commentId});

        const page = okValueOf(result);

        expect(page.items).toBe(repository.lastReturned);
        expect(page).toEqual({
            items: [storedReply('a', 'comment-1', 1), storedReply('b', 'comment-2', 1)],
            nextCursor: 'platform-page-2',
        });
    });

    it('returns a null next cursor unchanged', async () => {
        const gateway = new StubSocialCommentsGateway(
            ok<PlatformCommentPage>({items: [platformReply('a')], nextCursor: null}),
        );

        const result = await useCaseFor(
            new StubCommentReplyContextRepository(replyContext),
            gateway,
            new InMemoryCommentRepository(),
        ).execute({commentId});

        expect(okValueOf(result).nextCursor).toBeNull();
    });

    it('supports an empty page that still reports a next cursor', async () => {
        const repository = new InMemoryCommentRepository();
        const gateway = new StubSocialCommentsGateway(
            ok<PlatformCommentPage>({items: [], nextCursor: toCursor('platform-page-2')}),
        );

        const result = await useCaseFor(
            new StubCommentReplyContextRepository(replyContext),
            gateway,
            repository,
        ).execute({commentId});

        expect(okValueOf(result)).toEqual({items: [], nextCursor: 'platform-page-2'});
        expect(repository.savedBatches).toEqual([[]]);
    });

    it('returns the typed platform failure and persists nothing when the platform fails', async () => {
        const repository = new InMemoryCommentRepository();
        const gateway = new StubSocialCommentsGateway(
            err<PlatformFailure>({code: 'PLATFORM_UNAVAILABLE'}),
        );

        const result = await useCaseFor(
            new StubCommentReplyContextRepository(replyContext),
            gateway,
            repository,
        ).execute({commentId});

        expect(result).toEqual({
            ok: false,
            error: {code: 'PLATFORM_UNAVAILABLE'},
        });
        expect(repository.savedBatches).toEqual([]);
    });

    it('keeps one stored row with the same identifier when the same reply is retrieved twice', async () => {
        const repository = new InMemoryCommentRepository();
        const gateway = new StubSocialCommentsGateway(
            ok<PlatformCommentPage>({items: [platformReply('a')], nextCursor: null}),
        );
        const useCase = useCaseFor(
            new StubCommentReplyContextRepository(replyContext),
            gateway,
            repository,
        );

        const first = await useCase.execute({commentId});
        const second = await useCase.execute({commentId});

        expect(repository.storedComments).toEqual([storedReply('a', 'comment-1', 2)]);
        expect(okValueOf(first).items).toEqual([storedReply('a', 'comment-1', 1)]);
        expect(okValueOf(second).items).toEqual([storedReply('a', 'comment-1', 2)]);
        expect(repository.savedBatches).toEqual([[normalizedReply('a')], [normalizedReply('a')]]);
    });
});
