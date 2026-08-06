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
    type BeginReplyPublicationResult,
    type Comment,
    type CommentId,
    type CommentProjectionStateRepository,
    type CommentReplyContext,
    type CommentReplyContextRepository,
    type CommentRepository,
    type PlatformComment,
    type PlatformFailure,
    type ReplyPublicationFailureCode,
    type ReplyPublicationOperation,
    type ReplyPublicationOperationRepository,
    type ReplyPublicationStatus,
    type Result,
    type SavePublishedReplyResult,
    type SocialCommentsGateway,
} from '@threadbridge/comments';

const platform = toSocialPlatform('demo');
const accountId = toAccountId('account-1');
const postId = toPostId('post-1');
const parentCommentId = toCommentId('comment-1');
const key = toIdempotencyKey('key-1');
const context: CommentReplyContext = {
    accountId,
    postId,
    platform,
    externalParentCommentId: toExternalCommentId('external-parent'),
};
const stored: Comment = {
    id: toCommentId('comment-2'),
    postId,
    parentCommentId,
    externalCommentId: toExternalCommentId('external-reply'),
    externalAuthorId: toExternalAuthorId('author-self'),
    content: 'Reply',
    platformCreatedAt: new Date('2026-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    version: 1,
    metadata: null,
    idempotencyKey: key,
};

class Contexts implements CommentReplyContextRepository {
    public findByCommentId(): Promise<CommentReplyContext | null> {
        return Promise.resolve(context);
    }
}

class Comments implements CommentRepository {
    public constructor(
        private readonly calls: string[],
        private readonly existing: Comment | null = null,
    ) {}

    public saveMany(): Promise<readonly Comment[]> {
        return Promise.resolve([]);
    }

    public findByIdempotencyKey(): Promise<Comment | null> {
        this.calls.push('lookup');
        return Promise.resolve(this.existing);
    }

    public savePublishedReply(): Promise<SavePublishedReplyResult> {
        this.calls.push('comment');
        return Promise.resolve({kind: 'created', comment: stored});
    }
}

class Operations implements ReplyPublicationOperationRepository {
    public constructor(
        public readonly calls: string[],
        public beginResult: BeginReplyPublicationResult,
    ) {}

    public begin(): Promise<BeginReplyPublicationResult> {
        this.calls.push('operation');
        return Promise.resolve(this.beginResult);
    }

    public markPublished(): Promise<void> {
        this.calls.push('published');
        return Promise.resolve();
    }

    public markFailed(
        _operationId: string,
        status: Extract<
  ReplyPublicationStatus,
  'retryable_failed' | 'failed' | 'indeterminate'
        >,
        _failureCode: ReplyPublicationFailureCode,
    ): Promise<void> {
        void _failureCode;
        this.calls.push(status);
        return Promise.resolve();
    }
}

const operation = (
    status: ReplyPublicationOperation['status'],
    comment: Comment | null = null,
    lastFailureCode: ReplyPublicationFailureCode | null = null,
): ReplyPublicationOperation => ({
    id: 'operation-1',
    accountId,
    parentCommentId,
    idempotencyKey: key,
    requestFingerprint: JSON.stringify([parentCommentId, 'Reply']),
    status,
    comment,
    lastFailureCode,
});

class Gateway implements SocialCommentsGateway {
    public readonly capabilities;

    public constructor(
        private readonly calls: string[],
        idempotency: 'native' | 'none',
        private readonly result: Result<PlatformComment, PlatformFailure>,
    ) {
        this.capabilities = {
  rootComments: false,
  directReplies: false,
  replyPublication: true,
  publicationIdempotency: idempotency,
        } as const;
    }

    public getComments(): never {
        throw new Error('Not used.');
    }

    public getReplies(): never {
        throw new Error('Not used.');
    }

    public replyToComment(): Promise<Result<PlatformComment, PlatformFailure>> {
        this.calls.push('gateway');
        return Promise.resolve(this.result);
    }
}

const published = ok<PlatformComment>({
    externalCommentId: stored.externalCommentId,
    externalAuthorId: stored.externalAuthorId,
    content: stored.content,
    createdAt: stored.platformCreatedAt,
    metadata: null,
});

describe('durable reply publication lifecycle', () => {
    it('records the operation before calling the provider and marks it published afterwards', async () => {
        const calls: string[] = [];
        const operations = new Operations(calls, {kind: 'started', operation: operation('pending')});
        const result = await new ReplyToComment(
  new Contexts(),
  new Map([[platform, new Gateway(calls, 'native', published)]]),
  new Comments(calls),
  operations,
        ).execute({parentCommentId, content: 'Reply', idempotencyKey: key});

        expect(result.ok).toBe(true);
        expect(calls).toEqual(['operation', 'gateway', 'comment', 'published']);
    });

    it('replays a completed operation without calling the provider', async () => {
        const calls: string[] = [];
        const operations = new Operations(calls, {
  kind: 'existing',
  operation: operation('published', stored),
        });
        const result = await new ReplyToComment(
  new Contexts(),
  new Map([[platform, new Gateway(calls, 'native', published)]]),
  new Comments(calls),
  operations,
        ).execute({parentCommentId, content: 'Reply', idempotencyKey: key});

        expect(result).toEqual({ok: true, value: {kind: 'existing', comment: stored}});
        expect(calls).toEqual(['operation']);
    });

    it('recovers a locally stored reply when the operation was not marked published', async () => {
        const calls: string[] = [];
        const operations = new Operations(calls, {
  kind: 'existing',
  operation: operation('pending'),
        });
        const result = await new ReplyToComment(
  new Contexts(),
  new Map([[platform, new Gateway(calls, 'none', published)]]),
  new Comments(calls, stored),
  operations,
        ).execute({parentCommentId, content: 'Reply', idempotencyKey: key});

        expect(result).toEqual({ok: true, value: {kind: 'existing', comment: stored}});
        expect(calls).toEqual(['operation', 'lookup', 'published']);
    });

    it('does not blindly retry a pending operation when the provider has no idempotency', async () => {
        const calls: string[] = [];
        const operations = new Operations(calls, {
  kind: 'existing',
  operation: operation('pending'),
        });
        const result = await new ReplyToComment(
  new Contexts(),
  new Map([[platform, new Gateway(calls, 'none', published)]]),
  new Comments(calls),
  operations,
        ).execute({parentCommentId, content: 'Reply', idempotencyKey: key});

        expect(result).toEqual({
  ok: false,
  error: {code: 'INDETERMINATE_PLATFORM_RESULT', platform},
        });
        expect(calls).toEqual(['operation', 'lookup', 'indeterminate']);
    });

    it('does not repeat a terminal provider failure', async () => {
        const calls: string[] = [];
        const operations = new Operations(calls, {
  kind: 'started',
  operation: operation('pending'),
        });
        const first = await new ReplyToComment(
  new Contexts(),
  new Map([[platform, new Gateway(
      calls,
      'native',
      err<PlatformFailure>({code: 'PLATFORM_PERMISSION_DENIED'}),
  )]]),
  new Comments(calls),
  operations,
        ).execute({parentCommentId, content: 'Reply', idempotencyKey: key});

        expect(first).toEqual({ok: false, error: {code: 'PLATFORM_PERMISSION_DENIED'}});
        expect(calls).toEqual(['operation', 'gateway', 'failed']);

        calls.length = 0;
        operations.beginResult = {
  kind: 'existing',
  operation: operation('failed', null, 'PLATFORM_PERMISSION_DENIED'),
        };
        const second = await new ReplyToComment(
  new Contexts(),
  new Map([[platform, new Gateway(calls, 'native', published)]]),
  new Comments(calls),
  operations,
        ).execute({parentCommentId, content: 'Reply', idempotencyKey: key});

        expect(second).toEqual({ok: false, error: {code: 'PLATFORM_PERMISSION_DENIED'}});
        expect(calls).toEqual(['operation', 'lookup']);
    });

    it('persists an explicit provider not-found as a deleted local projection', async () => {
        const calls: string[] = [];
        const deleted: CommentId[] = [];
        const projections: CommentProjectionStateRepository = {
  markDeleted: (commentId): Promise<void> => {
      deleted.push(commentId);
      return Promise.resolve();
  },
        };
        const result = await new ReplyToComment(
  new Contexts(),
  new Map([[platform, new Gateway(
      calls,
      'native',
      err<PlatformFailure>({code: 'PLATFORM_RESOURCE_NOT_FOUND'}),
  )]]),
  new Comments(calls),
  new Operations(calls, {kind: 'started', operation: operation('pending')}),
  projections,
        ).execute({parentCommentId, content: 'Reply', idempotencyKey: key});

        expect(result).toEqual({ok: false, error: {code: 'PLATFORM_RESOURCE_NOT_FOUND'}});
        expect(deleted).toEqual([parentCommentId]);
        expect(calls).toEqual(['operation', 'gateway', 'failed']);
    });
});
