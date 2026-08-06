import {describe, expect, it} from 'vitest';
import {
    err,
    ok,
    ReplyToComment,
    toAccountId,
    toCommentId,
    toExternalAuthorId,
    toExternalCommentId,
    toIdempotencyKey,
    toPostId,
    toSocialPlatform,
    type AccountId,
    type Comment,
    type CommentId,
    type CommentReplyContext,
    type CommentReplyContextRepository,
    type CommentRepository,
    type IdempotencyKey,
    type IndeterminatePlatformResultFailure,
    type NormalizedComment,
    type PlatformComment,
    type PlatformFailure,
    type PublishedReply,
    type ReplyToPlatformCommentInput,
    type Result,
    type SavePublishedReplyResult,
    type SocialCommentsGateway,
    type SocialPlatform,
} from '@threadbridge/comments';

const demoPlatform = toSocialPlatform('demo');
const otherPlatform = toSocialPlatform('other');
const parentCommentId = toCommentId('0198f000-0000-7000-8000-00000000000a');
const otherParentCommentId = toCommentId('0198f000-0000-7000-8000-00000000000b');
const postId = toPostId('0198f000-0000-7000-8000-000000000002');
const accountId = toAccountId('0198f000-0000-7000-8000-000000000001');
const externalParentCommentId = toExternalCommentId('demo-comment-1');
const idempotencyKey = toIdempotencyKey('key-1');
const storedAt = new Date('2026-02-01T00:00:00.000Z');

const replyContext: CommentReplyContext = {
    postId,
    accountId,
    platform: demoPlatform,
    externalParentCommentId,
};

const publishedPlatformComment: PlatformComment = {
    externalCommentId: toExternalCommentId('demo-published-key-1'),
    externalAuthorId: toExternalAuthorId('demo-author-self'),
    content: 'Thank you for your comment',
    createdAt: new Date('2026-01-03T00:00:00.000Z'),
    metadata: {source: 'demo'},
};

const storedComment = (
    content: string,
    parent: CommentId = parentCommentId,
    key: IdempotencyKey = idempotencyKey,
): Comment => ({
    id: toCommentId('0198f000-0000-7000-8000-0000000000c1'),
    postId,
    parentCommentId: parent,
    externalCommentId: toExternalCommentId('demo-published-key-1'),
    externalAuthorId: toExternalAuthorId('demo-author-self'),
    content,
    platformCreatedAt: new Date('2026-01-03T00:00:00.000Z'),
    metadata: {source: 'demo'},
    createdAt: storedAt,
    updatedAt: storedAt,
    version: 1,
    idempotencyKey: key,
});

class StubReplyContextRepository implements CommentReplyContextRepository {
    public readonly receivedCommentIds: CommentId[] = [];

    public constructor(private readonly context: CommentReplyContext | null) {}

    public findByCommentId(commentId: CommentId): Promise<CommentReplyContext | null> {
        this.receivedCommentIds.push(commentId);

        return Promise.resolve(this.context);
    }
}

class StubGateway implements SocialCommentsGateway {
    public readonly capabilities = {
        rootComments: false,
        directReplies: false,
        replyPublication: true,
        publicationIdempotency: 'none',
    } as const;

    public readonly receivedInputs: ReplyToPlatformCommentInput[] = [];

    public constructor(
        private readonly response: Result<
            PlatformComment,
            PlatformFailure | IndeterminatePlatformResultFailure
        >,
        private readonly calls: string[] = [],
    ) {}

    public getComments(): never {
        throw new Error('ReplyToComment must not retrieve root comments.');
    }

    public getReplies(): never {
        throw new Error('ReplyToComment must not retrieve replies.');
    }

    public replyToComment(
        input: ReplyToPlatformCommentInput,
    ): Promise<Result<PlatformComment, PlatformFailure | IndeterminatePlatformResultFailure>> {
        this.receivedInputs.push(input);
        this.calls.push('gateway');

        return Promise.resolve(this.response);
    }
}

class StubCommentRepository implements CommentRepository {
    public readonly savedReplies: PublishedReply[] = [];

    public readonly lookedUpKeys: IdempotencyKey[] = [];

    public constructor(
        private readonly existing: Comment | null,
        private readonly saved: SavePublishedReplyResult | null = null,
        private readonly calls: string[] = [],
    ) {}

    public saveMany(): never {
        throw new Error('ReplyToComment must not import comments.');
    }

    public findByIdempotencyKey(
        _accountId: AccountId,
        key: IdempotencyKey,
    ): Promise<Comment | null> {
        this.lookedUpKeys.push(key);

        return Promise.resolve(this.existing);
    }

    public savePublishedReply(reply: PublishedReply): Promise<SavePublishedReplyResult> {
        this.savedReplies.push(reply);
        this.calls.push('repository');

        if (this.saved === null) {
            return Promise.resolve({kind: 'created', comment: storedComment(reply.content)});
        }

        return Promise.resolve(this.saved);
    }
}

const query = {parentCommentId, content: 'Thank you for your comment', idempotencyKey} as const;

describe('ReplyToComment', () => {
    it('resolves the reply context from the parent comment identifier', async () => {
        const contexts = new StubReplyContextRepository(replyContext);

        await new ReplyToComment(
            contexts,
            new Map<SocialPlatform, SocialCommentsGateway>([
                [demoPlatform, new StubGateway(ok<PlatformComment>(publishedPlatformComment))],
            ]),
            new StubCommentRepository(null),
        ).execute(query);

        expect(contexts.receivedCommentIds).toEqual([parentCommentId]);
    });

    it('reports an unknown parent without looking up a key or calling the gateway', async () => {
        const gateway = new StubGateway(ok<PlatformComment>(publishedPlatformComment));
        const repository = new StubCommentRepository(null);

        const result = await new ReplyToComment(
            new StubReplyContextRepository(null),
            new Map<SocialPlatform, SocialCommentsGateway>([[demoPlatform, gateway]]),
            repository,
        ).execute(query);

        expect(result).toEqual({
            ok: false,
            error: {code: 'COMMENT_NOT_FOUND', commentId: parentCommentId},
        });
        expect(repository.lookedUpKeys).toEqual([]);
        expect(gateway.receivedInputs).toEqual([]);
    });

    it('replays an identical request as existing without calling the gateway', async () => {
        const gateway = new StubGateway(ok<PlatformComment>(publishedPlatformComment));
        const existing = storedComment('Thank you for your comment');
        const repository = new StubCommentRepository(existing);

        const result = await new ReplyToComment(
            new StubReplyContextRepository(replyContext),
            new Map<SocialPlatform, SocialCommentsGateway>([[demoPlatform, gateway]]),
            repository,
        ).execute(query);

        expect(result).toEqual({ok: true, value: {kind: 'existing', comment: existing}});
        expect(repository.lookedUpKeys).toEqual([idempotencyKey]);
        expect(gateway.receivedInputs).toEqual([]);
        expect(repository.savedReplies).toEqual([]);
    });

    it('reports a conflict when the same key carries different content', async () => {
        const gateway = new StubGateway(ok<PlatformComment>(publishedPlatformComment));

        const result = await new ReplyToComment(
            new StubReplyContextRepository(replyContext),
            new Map<SocialPlatform, SocialCommentsGateway>([[demoPlatform, gateway]]),
            new StubCommentRepository(storedComment('A different reply')),
        ).execute(query);

        expect(result).toEqual({
            ok: false,
            error: {code: 'IDEMPOTENCY_CONFLICT', idempotencyKey},
        });
        expect(gateway.receivedInputs).toEqual([]);
    });

    it('reports a conflict when the same key targets a different parent', async () => {
        const result = await new ReplyToComment(
            new StubReplyContextRepository(replyContext),
            new Map<SocialPlatform, SocialCommentsGateway>([
                [demoPlatform, new StubGateway(ok<PlatformComment>(publishedPlatformComment))],
            ]),
            new StubCommentRepository(
                storedComment('Thank you for your comment', otherParentCommentId),
            ),
        ).execute(query);

        expect(result).toEqual({
            ok: false,
            error: {code: 'IDEMPOTENCY_CONFLICT', idempotencyKey},
        });
    });

    it('selects the gateway registered for the platform of the context', async () => {
        const demoGateway = new StubGateway(ok<PlatformComment>(publishedPlatformComment));
        const otherGateway = new StubGateway(ok<PlatformComment>(publishedPlatformComment));

        await new ReplyToComment(
            new StubReplyContextRepository({...replyContext, platform: otherPlatform}),
            new Map<SocialPlatform, SocialCommentsGateway>([
                [demoPlatform, demoGateway],
                [otherPlatform, otherGateway],
            ]),
            new StubCommentRepository(null),
        ).execute(query);

        expect(otherGateway.receivedInputs).toHaveLength(1);
        expect(demoGateway.receivedInputs).toEqual([]);
    });

    it('reports an unregistered platform without persisting', async () => {
        const repository = new StubCommentRepository(null);

        const result = await new ReplyToComment(
            new StubReplyContextRepository({...replyContext, platform: otherPlatform}),
            new Map<SocialPlatform, SocialCommentsGateway>([
                [demoPlatform, new StubGateway(ok<PlatformComment>(publishedPlatformComment))],
            ]),
            repository,
        ).execute(query);

        expect(result).toEqual({
            ok: false,
            error: {code: 'UNSUPPORTED_PLATFORM', platform: otherPlatform},
        });
        expect(repository.savedReplies).toEqual([]);
    });

    it('passes the resolved account, external parent, content, and key to the gateway', async () => {
        const gateway = new StubGateway(ok<PlatformComment>(publishedPlatformComment));

        await new ReplyToComment(
            new StubReplyContextRepository(replyContext),
            new Map<SocialPlatform, SocialCommentsGateway>([[demoPlatform, gateway]]),
            new StubCommentRepository(null),
        ).execute(query);

        expect(gateway.receivedInputs).toEqual([
            {
                accountId,
                externalParentCommentId,
                content: 'Thank you for your comment',
                idempotencyKey,
            },
        ]);
    });

    it('calls the platform before it persists anything', async () => {
        const calls: string[] = [];
        const gateway = new StubGateway(ok<PlatformComment>(publishedPlatformComment), calls);

        await new ReplyToComment(
            new StubReplyContextRepository(replyContext),
            new Map<SocialPlatform, SocialCommentsGateway>([[demoPlatform, gateway]]),
            new StubCommentRepository(null, null, calls),
        ).execute(query);

        expect(calls).toEqual(['gateway', 'repository']);
    });

    it('persists nothing when the platform reports a typed failure', async () => {
        const repository = new StubCommentRepository(null);

        const result = await new ReplyToComment(
            new StubReplyContextRepository(replyContext),
            new Map<SocialPlatform, SocialCommentsGateway>([
                [demoPlatform, new StubGateway(err<PlatformFailure>({code: 'PLATFORM_RATE_LIMITED'}))],
            ]),
            repository,
        ).execute(query);

        expect(result).toEqual({ok: false, error: {code: 'PLATFORM_RATE_LIMITED'}});
        expect(repository.savedReplies).toEqual([]);
    });

    it('persists nothing and does not retry an indeterminate platform result', async () => {
        const gateway = new StubGateway(
            err<IndeterminatePlatformResultFailure>({
                code: 'INDETERMINATE_PLATFORM_RESULT',
                platform: demoPlatform,
            }),
        );
        const repository = new StubCommentRepository(null);

        const result = await new ReplyToComment(
            new StubReplyContextRepository(replyContext),
            new Map<SocialPlatform, SocialCommentsGateway>([[demoPlatform, gateway]]),
            repository,
        ).execute(query);

        expect(result).toEqual({
            ok: false,
            error: {code: 'INDETERMINATE_PLATFORM_RESULT', platform: demoPlatform},
        });
        expect(repository.savedReplies).toEqual([]);
        expect(gateway.receivedInputs).toHaveLength(1);
    });

    it('maps the confirmed platform reply onto the resolved post and requested parent', async () => {
        const repository = new StubCommentRepository(null);

        await new ReplyToComment(
            new StubReplyContextRepository(replyContext),
            new Map<SocialPlatform, SocialCommentsGateway>([
                [demoPlatform, new StubGateway(ok<PlatformComment>(publishedPlatformComment))],
            ]),
            repository,
        ).execute(query);

        expect(repository.savedReplies).toEqual([
            {
                postId,
                parentCommentId,
                externalCommentId: toExternalCommentId('demo-published-key-1'),
                externalAuthorId: toExternalAuthorId('demo-author-self'),
                content: 'Thank you for your comment',
                platformCreatedAt: new Date('2026-01-03T00:00:00.000Z'),
                metadata: {source: 'demo'},
                idempotencyKey,
            } satisfies PublishedReply,
        ]);
    });

    it('returns created when the repository inserted the reply', async () => {
        const comment = storedComment('Thank you for your comment');

        const result = await new ReplyToComment(
            new StubReplyContextRepository(replyContext),
            new Map<SocialPlatform, SocialCommentsGateway>([
                [demoPlatform, new StubGateway(ok<PlatformComment>(publishedPlatformComment))],
            ]),
            new StubCommentRepository(null, {kind: 'created', comment}),
        ).execute(query);

        expect(result).toEqual({ok: true, value: {kind: 'created', comment}});
    });

    it('returns existing when the repository converged on a stored row', async () => {
        const comment = storedComment('Thank you for your comment');

        const result = await new ReplyToComment(
            new StubReplyContextRepository(replyContext),
            new Map<SocialPlatform, SocialCommentsGateway>([
                [demoPlatform, new StubGateway(ok<PlatformComment>(publishedPlatformComment))],
            ]),
            new StubCommentRepository(null, {kind: 'existing', comment}),
        ).execute(query);

        expect(result).toEqual({ok: true, value: {kind: 'existing', comment}});
    });

    it('accepts a race whose stored row matches the request', async () => {
        const comment = storedComment('Thank you for your comment');

        const result = await new ReplyToComment(
            new StubReplyContextRepository(replyContext),
            new Map<SocialPlatform, SocialCommentsGateway>([
                [demoPlatform, new StubGateway(ok<PlatformComment>(publishedPlatformComment))],
            ]),
            new StubCommentRepository(null, {kind: 'existing', comment}),
        ).execute(query);

        expect(result).toEqual({ok: true, value: {kind: 'existing', comment}});
    });

    it('reports a conflict when a race stored a row with different content', async () => {
        const result = await new ReplyToComment(
            new StubReplyContextRepository(replyContext),
            new Map<SocialPlatform, SocialCommentsGateway>([
                [demoPlatform, new StubGateway(ok<PlatformComment>(publishedPlatformComment))],
            ]),
            new StubCommentRepository(null, {
                kind: 'existing',
                comment: storedComment('A racing reply'),
            }),
        ).execute(query);

        expect(result).toEqual({
            ok: false,
            error: {code: 'IDEMPOTENCY_CONFLICT', idempotencyKey},
        });
    });

    it('reports a conflict when the stored row is owned by another idempotency key', async () => {
        const result = await new ReplyToComment(
            new StubReplyContextRepository(replyContext),
            new Map<SocialPlatform, SocialCommentsGateway>([
                [demoPlatform, new StubGateway(ok<PlatformComment>(publishedPlatformComment))],
            ]),
            new StubCommentRepository(null, {
                kind: 'existing',
                comment: storedComment(
                    'Thank you for your comment',
                    parentCommentId,
                    toIdempotencyKey('key-2'),
                ),
            }),
        ).execute(query);

        expect(result).toEqual({
            ok: false,
            error: {code: 'IDEMPOTENCY_CONFLICT', idempotencyKey},
        });
    });

    it('reports a conflict when the stored row carries no idempotency key at all', async () => {
        const importedRow: Comment = {
            id: toCommentId('0198f000-0000-7000-8000-0000000000c2'),
            postId,
            parentCommentId,
            externalCommentId: toExternalCommentId('demo-imported-earlier'),
            externalAuthorId: toExternalAuthorId('demo-author-self'),
            content: 'Thank you for your comment',
            platformCreatedAt: new Date('2026-01-03T00:00:00.000Z'),
            metadata: null,
            createdAt: storedAt,
            updatedAt: storedAt,
            version: 1,
        };

        const result = await new ReplyToComment(
            new StubReplyContextRepository(replyContext),
            new Map<SocialPlatform, SocialCommentsGateway>([
                [demoPlatform, new StubGateway(ok<PlatformComment>(publishedPlatformComment))],
            ]),
            new StubCommentRepository(null, {kind: 'existing', comment: importedRow}),
        ).execute(query);

        expect(result).toEqual({
            ok: false,
            error: {code: 'IDEMPOTENCY_CONFLICT', idempotencyKey},
        });
    });

    it('accepts a row that adopted the requested key while it was imported earlier', async () => {
        const adopted: Comment = {
            ...storedComment('Thank you for your comment'),
            externalCommentId: toExternalCommentId('demo-imported-earlier'),
        };

        const result = await new ReplyToComment(
            new StubReplyContextRepository(replyContext),
            new Map<SocialPlatform, SocialCommentsGateway>([
                [demoPlatform, new StubGateway(ok<PlatformComment>(publishedPlatformComment))],
            ]),
            new StubCommentRepository(null, {kind: 'existing', comment: adopted}),
        ).execute(query);

        expect(result).toEqual({ok: true, value: {kind: 'existing', comment: adopted}});
    });

    it('does not let the caller supply infrastructure fields', async () => {
        const gateway = new StubGateway(ok<PlatformComment>(publishedPlatformComment));
        const useCase = new ReplyToComment(
            new StubReplyContextRepository(replyContext),
            new Map<SocialPlatform, SocialCommentsGateway>([[demoPlatform, gateway]]),
            new StubCommentRepository(null),
        );

        await useCase.execute({
            ...query,
            // @ts-expect-error the post is resolved from the reply context, never supplied
            postId: toPostId('0198f000-0000-7000-8000-0000000000ff'),
        });
        await useCase.execute({
            ...query,
            // @ts-expect-error the platform is resolved from the reply context, never supplied
            platform: otherPlatform,
        });
        await useCase.execute({
            ...query,
            // @ts-expect-error the external parent id is resolved, never supplied
            externalParentCommentId: toExternalCommentId('caller-supplied'),
        });

        expect(gateway.receivedInputs).toHaveLength(3);
        expect(
            gateway.receivedInputs.every(
                (input): boolean => input.externalParentCommentId === externalParentCommentId,
            ),
        ).toBe(true);
    });
});

/** Guards the mapping contract shared with the import path. */
const normalized: NormalizedComment = {
    postId,
    parentCommentId,
    externalCommentId: toExternalCommentId('demo-published-key-1'),
    externalAuthorId: toExternalAuthorId('demo-author-self'),
    content: 'Thank you for your comment',
    platformCreatedAt: new Date('2026-01-03T00:00:00.000Z'),
    metadata: null,
};

describe('PublishedReply', () => {
    it('is a normalized comment that always has a parent and an idempotency key', () => {
        const reply: PublishedReply = {...normalized, parentCommentId, idempotencyKey};

        expect(reply.parentCommentId).toBe(parentCommentId);
        expect(reply.idempotencyKey).toBe(idempotencyKey);
    });
});
