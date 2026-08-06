import {describe, expect, it} from 'vitest';
import {DemoSocialCommentsGateway}
    from '../apps/api/src/adapters/demo/demo-comments-gateway.js';
import {LimitedDemoSocialCommentsGateway}
    from '../apps/api/src/adapters/demo/limited-demo-comments-gateway.js';
import {
    toAccountId,
    toCursor,
    toExternalCommentId,
    toExternalPostId,
    toIdempotencyKey,
    type Cursor,
    type PlatformComment,
    type PlatformCommentPage,
    type PlatformFailure,
    type Result,
    type SocialCommentsCapabilities,
    type SocialCommentsGateway,
} from '@threadbridge/comments';

interface GatewayFixture {
    readonly name: string;
    readonly create: () => SocialCommentsGateway;
    readonly expectedCapabilities: SocialCommentsCapabilities;
    readonly externalPostId: string;
    readonly expectedFirstPageSize: number;
    readonly invalidForeignCursor: Cursor;
}

const accountId = toAccountId('contract-account');

const fixtures: readonly GatewayFixture[] = [
    {
        name: 'demo',
        create: (): SocialCommentsGateway => new DemoSocialCommentsGateway(),
        expectedCapabilities: {
            rootComments: true,
            directReplies: true,
            replyPublication: true,
            publicationIdempotency: 'native',
        },
        externalPostId: 'demo-post-1',
        expectedFirstPageSize: 2,
        invalidForeignCursor: toCursor('limited-offset:1'),
    },
    {
        name: 'demo-limited',
        create: (): SocialCommentsGateway => new LimitedDemoSocialCommentsGateway(),
        expectedCapabilities: {
            rootComments: true,
            directReplies: false,
            replyPublication: true,
            publicationIdempotency: 'none',
        },
        externalPostId: 'limited-post-1',
        expectedFirstPageSize: 1,
        invalidForeignCursor: toCursor('Mg'),
    },
];

const pageOf = (result: Result<PlatformCommentPage, PlatformFailure>): PlatformCommentPage => {
    if (!result.ok) {
        throw new Error(`Expected a page, received ${result.error.code}.`);
    }

    return result.value;
};

const commentOf = (
    result: Awaited<ReturnType<SocialCommentsGateway['replyToComment']>>,
): PlatformComment => {
    if (!result.ok) {
        throw new Error(`Expected a published comment, received ${result.error.code}.`);
    }

    return result.value;
};

describe.each(fixtures)('$name SocialCommentsGateway contract', (fixture: GatewayFixture) => {
    it('declares its externally relevant capabilities', () => {
        expect(fixture.create().capabilities).toEqual(fixture.expectedCapabilities);
    });

    it('uses its own opaque cursor format and rejects a foreign cursor', async () => {
        const gateway = fixture.create();
        const first = pageOf(await gateway.getComments({
            accountId,
            externalPostId: toExternalPostId(fixture.externalPostId),
            cursor: null,
        }));

        expect(first.items).toHaveLength(fixture.expectedFirstPageSize);
        expect(first.nextCursor).not.toBeNull();

        const invalid = await gateway.getComments({
            accountId,
            externalPostId: toExternalPostId(fixture.externalPostId),
            cursor: fixture.invalidForeignCursor,
        });

        expect(invalid).toEqual({ok: false, error: {code: 'PLATFORM_CURSOR_INVALID'}});
    });

    it('matches direct-reply behavior to the declared capability', async () => {
        const result = await fixture.create().getReplies({
            accountId,
            externalParentCommentId: toExternalCommentId('demo-comment-1'),
            cursor: null,
        });

        if (fixture.expectedCapabilities.directReplies) {
            expect(result.ok).toBe(true);
        } else {
            expect(result).toEqual({
                ok: false,
                error: {code: 'PLATFORM_OPERATION_UNSUPPORTED'},
            });
        }
    });

    it('matches publication replay behavior to the declared idempotency guarantee', async () => {
        const gateway = fixture.create();
        const input = {
            accountId,
            externalParentCommentId: toExternalCommentId('contract-parent'),
            content: 'Contract publication',
            idempotencyKey: toIdempotencyKey('contract-key'),
        };

        const first = commentOf(await gateway.replyToComment(input));
        const second = commentOf(await gateway.replyToComment(input));

        if (fixture.expectedCapabilities.publicationIdempotency === 'native') {
            expect(second.externalCommentId).toBe(first.externalCommentId);
        } else {
            expect(second.externalCommentId).not.toBe(first.externalCommentId);
        }
    });
});

const translatedFailures = [
    ['demo-permission-denied', 'PLATFORM_PERMISSION_DENIED'],
    ['demo-resource-not-found', 'PLATFORM_RESOURCE_NOT_FOUND'],
    ['demo-validation-failure', 'PLATFORM_VALIDATION_FAILED'],
    ['demo-timeout', 'PLATFORM_TIMEOUT'],
] as const;

describe('demo provider failure translation', () => {
    for (const [externalPostId, code] of translatedFailures) {
        it(`translates ${externalPostId} to ${code}`, async () => {
            const result = await new DemoSocialCommentsGateway().getComments({
                accountId,
                externalPostId: toExternalPostId(externalPostId),
                cursor: null,
            });

            expect(result).toEqual({ok: false, error: {code}});
        });
    }
});
