import {
    toAccountId,
    toCommentId,
    toExternalAuthorId,
    toExternalCommentId,
    toIdempotencyKey,
    toPostId,
    type BeginReplyPublicationInput,
    type BeginReplyPublicationResult,
    type Comment,
    type CommentId,
    type PlatformMetadata,
    type ReplyPublicationFailureCode,
    type ReplyPublicationOperation,
    type ReplyPublicationOperationRepository,
    type ReplyPublicationStatus,
} from '@threadbridge/comments';
import type {Sql, TransactionSql} from 'postgres';

interface OperationRow {
    readonly id: string;
    readonly account_id: string;
    readonly parent_comment_id: string;
    readonly idempotency_key: string;
    readonly request_fingerprint: string;
    readonly status: ReplyPublicationStatus;
    readonly comment_id: string | null;
    readonly last_failure_code: ReplyPublicationFailureCode | null;
}

interface CommentRow {
    readonly id: string;
    readonly post_id: string;
    readonly parent_comment_id: string | null;
    readonly external_comment_id: string;
    readonly external_author_id: string;
    readonly content: string;
    readonly platform_created_at: Date;
    readonly created_at: Date;
    readonly updated_at: Date;
    readonly version: number;
    readonly idempotency_key: string | null;
    readonly platform_data: PlatformMetadata | null;
}

const toComment = (row: CommentRow): Comment => ({
    id: toCommentId(row.id),
    postId: toPostId(row.post_id),
    parentCommentId: row.parent_comment_id === null ? null : toCommentId(row.parent_comment_id),
    externalCommentId: toExternalCommentId(row.external_comment_id),
    externalAuthorId: toExternalAuthorId(row.external_author_id),
    content: row.content,
    platformCreatedAt: row.platform_created_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
    metadata: row.platform_data,
    ...(row.idempotency_key === null
        ? {}
        : {idempotencyKey: toIdempotencyKey(row.idempotency_key)}),
});

const readOperation = async (
    transaction: TransactionSql,
    accountId: string,
    idempotencyKey: string,
): Promise<ReplyPublicationOperation | null> => {
    const rows = await transaction<OperationRow[]>`
        select * from reply_publication_operations
        where account_id = ${accountId}
          and idempotency_key = ${idempotencyKey}
    `;
    const row = rows.at(0);

    if (row === undefined) {
        return null;
    }

    let comment: Comment | null = null;

    if (row.comment_id !== null) {
        const comments = await transaction<CommentRow[]>`
            select * from comments where id = ${row.comment_id}
        `;
        const stored = comments.at(0);

        if (stored === undefined) {
            throw new Error('A published operation references a missing comment.');
        }

        comment = toComment(stored);
    }

    return {
        id: row.id,
        accountId: toAccountId(row.account_id),
        parentCommentId: toCommentId(row.parent_comment_id),
        idempotencyKey: toIdempotencyKey(row.idempotency_key),
        requestFingerprint: row.request_fingerprint,
        status: row.status,
        comment,
        lastFailureCode: row.last_failure_code,
    };
};

export class PostgresReplyPublicationOperationRepository
implements ReplyPublicationOperationRepository {
    public constructor(private readonly sql: Sql) {}

    public async begin(input: BeginReplyPublicationInput): Promise<BeginReplyPublicationResult> {
        return await this.sql.begin<BeginReplyPublicationResult>(
            async (transaction): Promise<BeginReplyPublicationResult> => {
                await transaction`
                    select pg_advisory_xact_lock(
                        hashtextextended(${`${input.accountId}:${input.idempotencyKey}`}::text, 0)
                    )
                `;

                const existing = await readOperation(
                    transaction,
                    input.accountId,
                    input.idempotencyKey,
                );

                if (existing !== null) {
                    if (existing.parentCommentId !== input.parentCommentId
                        || existing.requestFingerprint !== input.requestFingerprint) {
                        return {kind: 'conflict'};
                    }

                    return {kind: 'existing', operation: existing};
                }

                const rows = await transaction<OperationRow[]>`
                    insert into reply_publication_operations (
                        account_id,
                        parent_comment_id,
                        idempotency_key,
                        request_fingerprint,
                        status
                    ) values (
                        ${input.accountId},
                        ${input.parentCommentId},
                        ${input.idempotencyKey},
                        ${input.requestFingerprint},
                        'pending'
                    )
                    returning *
                `;
                const row = rows.at(0);

                if (row === undefined) {
                    throw new Error('Creating a reply publication operation returned no row.');
                }

                return {
                    kind: 'started',
                    operation: {
                        id: row.id,
                        accountId: toAccountId(row.account_id),
                        parentCommentId: toCommentId(row.parent_comment_id),
                        idempotencyKey: toIdempotencyKey(row.idempotency_key),
                        requestFingerprint: row.request_fingerprint,
                        status: row.status,
                        comment: null,
                        lastFailureCode: null,
                    },
                };
            },
        );
    }

    public async markPublished(operationId: string, commentId: CommentId): Promise<void> {
        const rows = await this.sql<OperationRow[]>`
            update reply_publication_operations
            set status = 'published',
                comment_id = ${commentId},
                last_failure_code = null,
                updated_at = now()
            where id = ${operationId}
            returning *
        `;

        if (rows.length !== 1) {
            throw new Error('Publishing an operation did not update exactly one row.');
        }
    }

    public async markFailed(
        operationId: string,
        status: Extract<
            ReplyPublicationStatus,
            'retryable_failed' | 'failed' | 'indeterminate'
        >,
        failureCode: ReplyPublicationFailureCode,
    ): Promise<void> {
        const rows = await this.sql<OperationRow[]>`
            update reply_publication_operations
            set status = ${status},
                comment_id = null,
                last_failure_code = ${failureCode},
                updated_at = now()
            where id = ${operationId}
            returning *
        `;

        if (rows.length !== 1) {
            throw new Error('Failing an operation did not update exactly one row.');
        }
    }
}
