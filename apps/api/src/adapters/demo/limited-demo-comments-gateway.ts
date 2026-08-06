import {
    ok,
    toCursor,
    toExternalAuthorId,
    toExternalCommentId,
    type Cursor,
    type GetPlatformCommentsInput,
    type IndeterminatePlatformResultFailure,
    type PlatformComment,
    type PlatformCommentPage,
    type PlatformFailure,
    type ReplyToPlatformCommentInput,
    type Result,
    type SocialCommentsCapabilities,
    type SocialCommentsGateway,
} from '@threadbridge/comments';

const PAGE_SIZE = 1;
const CURSOR_PREFIX = 'limited-offset:';

const rootComments = new Map<string, readonly PlatformComment[]>([
    [
        'limited-post-1',
        [
            {
                externalCommentId: toExternalCommentId('limited-comment-1'),
                externalAuthorId: toExternalAuthorId('limited-author-1'),
                content: 'A limited-provider comment',
                createdAt: new Date('2026-01-04T10:00:00.000Z'),
                metadata: {source: 'demo-limited'},
            },
            {
                externalCommentId: toExternalCommentId('limited-comment-2'),
                externalAuthorId: toExternalAuthorId('limited-author-2'),
                content: 'Another limited-provider comment',
                createdAt: new Date('2026-01-04T10:01:00.000Z'),
                metadata: {source: 'demo-limited'},
            },
        ],
    ],
]);

const encodeCursor = (offset: number): Cursor => toCursor(`${CURSOR_PREFIX}${String(offset)}`);

const decodeOffset = (cursor: Cursor | null): number | null => {
    if (cursor === null) {
        return 0;
    }

    if (!cursor.startsWith(CURSOR_PREFIX)) {
        return null;
    }

    const rawOffset = cursor.slice(CURSOR_PREFIX.length);
    const offset = Number.parseInt(rawOffset, 10);

    if (!Number.isInteger(offset) || offset < 0 || String(offset) !== rawOffset) {
        return null;
    }

    return offset;
};

export class LimitedDemoSocialCommentsGateway implements SocialCommentsGateway {
    public readonly capabilities: SocialCommentsCapabilities = {
        rootComments: true,
        directReplies: false,
        replyPublication: true,
        publicationIdempotency: 'none',
    };

    private publicationSequence = 0;

    public getComments(
        input: GetPlatformCommentsInput,
    ): Promise<Result<PlatformCommentPage, PlatformFailure>> {
        const offset = decodeOffset(input.cursor);

        if (offset === null) {
            return Promise.resolve({ok: false, error: {code: 'PLATFORM_CURSOR_INVALID'}});
        }

        const items = rootComments.get(input.externalPostId) ?? [];
        const nextOffset = offset + PAGE_SIZE;

        return Promise.resolve(ok<PlatformCommentPage>({
            items: items.slice(offset, nextOffset),
            nextCursor: nextOffset < items.length ? encodeCursor(nextOffset) : null,
        }));
    }

    public getReplies(): Promise<Result<PlatformCommentPage, PlatformFailure>> {
        return Promise.resolve({
            ok: false,
            error: {code: 'PLATFORM_OPERATION_UNSUPPORTED'},
        });
    }

    public replyToComment(
        input: ReplyToPlatformCommentInput,
    ): Promise<Result<PlatformComment, PlatformFailure | IndeterminatePlatformResultFailure>> {
        this.publicationSequence += 1;

        return Promise.resolve(ok<PlatformComment>({
            externalCommentId: toExternalCommentId(
                `limited-published-${String(this.publicationSequence)}`,
            ),
            externalAuthorId: toExternalAuthorId('limited-author-self'),
            content: input.content,
            createdAt: new Date('2026-01-05T00:00:00.000Z'),
            metadata: {source: 'demo-limited', published: true},
        }));
    }
}
