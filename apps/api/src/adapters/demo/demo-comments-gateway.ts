import {
    ok,
    toCursor,
    toExternalAuthorId,
    toExternalCommentId,
    toSocialPlatform,
    type Cursor,
    type GetPlatformCommentsInput,
    type GetPlatformRepliesInput,
    type IndeterminatePlatformResultFailure,
    type PlatformComment,
    type PlatformCommentPage,
    type PlatformFailure,
    type ReplyToPlatformCommentInput,
    type Result,
    type SocialCommentsGateway,
} from '@threadbridge/comments';

const DEMO_PLATFORM = toSocialPlatform('demo');

/** Publishing against this parent reports an unknown outcome instead of a success or a failure. */
const INDETERMINATE_TRIGGER = 'demo-indeterminate';

const PAGE_SIZE = 2;

const comment = (suffix: string, content: string): PlatformComment => ({
    externalCommentId: toExternalCommentId(`demo-comment-${suffix}`),
    externalAuthorId: toExternalAuthorId(`demo-author-${suffix}`),
    content,
    createdAt: new Date(`2026-01-02T10:0${suffix.slice(-1)}:00.000Z`),
    metadata: {source: 'demo'},
});

/** Root comments keyed by external post id. Three comments force a second page. */
const rootComments = new Map<string, readonly PlatformComment[]>([
    [
        'demo-post-1',
        [
            comment('1', 'A first demo comment'),
            comment('2', 'A second demo comment'),
            comment('3', 'A third demo comment'),
        ],
    ],
]);

/** Direct replies keyed by external parent comment id. */
const replies = new Map<string, readonly PlatformComment[]>([
    [
        'demo-comment-1',
        [comment('1-reply-1', 'A reply to the first comment'), comment('1-reply-2', 'Another reply')],
    ],
]);

/**
 * External identifiers reserved for demonstrating failure translation. They apply to posts and to
 * parent comments alike, so both gateway operations can be exercised.
 */
const failures = new Map<string, PlatformFailure>([
    ['demo-authentication-failure', {code: 'PLATFORM_AUTHENTICATION_FAILED'}],
    ['demo-rate-limited', {code: 'PLATFORM_RATE_LIMITED'}],
    ['demo-unavailable', {code: 'PLATFORM_UNAVAILABLE'}],
]);

const encodeCursor = (offset: number): Cursor =>
    toCursor(Buffer.from(String(offset), 'utf8').toString('base64url'));

/** Returns null for a cursor this adapter did not issue, which yields an empty page. */
const decodeOffset = (cursor: Cursor | null): number | null => {
    if (cursor === null) {
        return 0;
    }

    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const offset = Number.parseInt(decoded, 10);

    if (!Number.isInteger(offset) || offset < 0 || String(offset) !== decoded) {
        return null;
    }

    return offset;
};

const pageOf = (
    externalId: string,
    items: readonly PlatformComment[],
    cursor: Cursor | null,
): Result<PlatformCommentPage, PlatformFailure> => {
    const failure = failures.get(externalId);

    if (failure !== undefined) {
        return {ok: false, error: failure};
    }

    const offset = decodeOffset(cursor);

    if (offset === null) {
        return ok<PlatformCommentPage>({items: [], nextCursor: null});
    }

    const nextOffset = offset + PAGE_SIZE;

    return ok<PlatformCommentPage>({
        items: items.slice(offset, nextOffset),
        nextCursor: nextOffset < items.length ? encodeCursor(nextOffset) : null,
    });
};

/**
 * A deterministic in-memory social platform. It exists to prove the gateway port end to end
 * without credentials or network access; it is the only component that knows it is the demo
 * platform.
 */
export class DemoSocialCommentsGateway implements SocialCommentsGateway {
    /** Replies published through this adapter instance, keyed by idempotency key. */
    private readonly publishedByKey = new Map<string, PlatformComment>();

    /** The same replies, keyed by external parent comment id, so getReplies can return them. */
    private readonly publishedByParent = new Map<string, PlatformComment[]>();

    public getComments(
        input: GetPlatformCommentsInput,
    ): Promise<Result<PlatformCommentPage, PlatformFailure>> {
        return Promise.resolve(
            pageOf(input.externalPostId, rootComments.get(input.externalPostId) ?? [], input.cursor),
        );
    }

    public getReplies(
        input: GetPlatformRepliesInput,
    ): Promise<Result<PlatformCommentPage, PlatformFailure>> {
        const parent = input.externalParentCommentId;
        const items = [
            ...(replies.get(parent) ?? []),
            ...(this.publishedByParent.get(parent) ?? []),
        ];

        return Promise.resolve(pageOf(parent, items, input.cursor));
    }

    /**
     * Publishing is idempotent on the platform side: a key that was already used returns the reply
     * it originally created, even when the new input differs. The application detects that
     * mismatch from its own persisted request data.
     */
    public replyToComment(
        input: ReplyToPlatformCommentInput,
    ): Promise<Result<PlatformComment, PlatformFailure | IndeterminatePlatformResultFailure>> {
        const parent = input.externalParentCommentId;
        const failure = failures.get(parent);

        if (failure !== undefined) {
            return Promise.resolve({ok: false, error: failure});
        }

        if (parent === INDETERMINATE_TRIGGER) {
            return Promise.resolve({
                ok: false,
                error: {code: 'INDETERMINATE_PLATFORM_RESULT', platform: DEMO_PLATFORM},
            });
        }

        const alreadyPublished = this.publishedByKey.get(input.idempotencyKey);

        if (alreadyPublished !== undefined) {
            return Promise.resolve(ok<PlatformComment>(alreadyPublished));
        }

        const published: PlatformComment = {
            externalCommentId: toExternalCommentId(`demo-published-${input.idempotencyKey}`),
            externalAuthorId: toExternalAuthorId('demo-author-self'),
            content: input.content,
            createdAt: new Date('2026-01-03T00:00:00.000Z'),
            metadata: {source: 'demo', published: true},
        };

        this.publishedByKey.set(input.idempotencyKey, published);
        this.publishedByParent.set(parent, [
            ...(this.publishedByParent.get(parent) ?? []),
            published,
        ]);

        return Promise.resolve(ok<PlatformComment>(published));
    }
}
