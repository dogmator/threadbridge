import {
    toCommentId,
    toExternalAuthorId,
    toExternalCommentId,
    toIdempotencyKey,
    toPostId,
    type AccountId,
    type Comment,
    type CommentRepository,
    type IdempotencyKey,
    type NormalizedComment,
    type PlatformMetadata,
    type PublishedReply,
    type SavePublishedReplyResult,
} from '@threadbridge/comments';
import type {Sql} from 'postgres';

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

interface AccountRow {
    readonly account_id: string;
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

export class PostgresCommentRepository implements CommentRepository {
    public constructor(private readonly sql: Sql) {}

    public async saveMany(comments: readonly NormalizedComment[]): Promise<readonly Comment[]> {
        if (comments.length === 0) {
            return [];
        }

        return await this.sql.begin<Comment[]>(async (transaction): Promise<Comment[]> => {
            const stored: Comment[] = [];

            for (const comment of comments) {
                const metadata = comment.metadata === null ? null : JSON.stringify(comment.metadata);
                const rows = await transaction<CommentRow[]>`
                    insert into comments (
                        post_id,
                        parent_comment_id,
                        external_comment_id,
                        external_author_id,
                        content,
                        platform_created_at,
                        platform_data,
                        projection_state,
                        last_observed_at,
                        deleted_at
                    ) values (
                        ${comment.postId},
                        ${comment.parentCommentId},
                        ${comment.externalCommentId},
                        ${comment.externalAuthorId},
                        ${comment.content},
                        ${comment.platformCreatedAt},
                        ${metadata}::text::jsonb,
                        'active',
                        now(),
                        null
                    )
                    on conflict (post_id, external_comment_id) do update set
                        parent_comment_id = excluded.parent_comment_id,
                        external_author_id = excluded.external_author_id,
                        content = excluded.content,
                        platform_created_at = excluded.platform_created_at,
                        platform_data = excluded.platform_data,
                        projection_state = 'active',
                        last_observed_at = now(),
                        deleted_at = null,
                        updated_at = now(),
                        version = comments.version + 1
                    returning *
                `;
                const row = rows.at(0);

                if (row === undefined) {
                    throw new Error('Upserting a comment returned no row.');
                }

                stored.push(toComment(row));
            }

            return stored;
        });
    }

    public async findByIdempotencyKey(
        accountId: AccountId,
        idempotencyKey: IdempotencyKey,
    ): Promise<Comment | null> {
        const rows = await this.sql<CommentRow[]>`
            select comments.*
            from comments
            join posts on posts.id = comments.post_id
            where posts.account_id = ${accountId}
              and comments.idempotency_key = ${idempotencyKey}
            order by comments.created_at
            limit 1
        `;
        const row = rows.at(0);

        return row === undefined ? null : toComment(row);
    }

    public async savePublishedReply(reply: PublishedReply): Promise<SavePublishedReplyResult> {
        const metadata = reply.metadata === null ? null : JSON.stringify(reply.metadata);

        return await this.sql.begin<SavePublishedReplyResult>(
            async (transaction): Promise<SavePublishedReplyResult> => {
                const accountRows = await transaction<AccountRow[]>`
                    select account_id from posts where id = ${reply.postId}
                `;
                const account = accountRows.at(0);

                if (account === undefined) {
                    throw new Error('Publishing a reply could not resolve the post account.');
                }

                await transaction`
                    select pg_advisory_xact_lock(
                        hashtextextended(${`${account.account_id}:${reply.idempotencyKey}`}::text, 0)
                    )
                `;

                const claimed = await transaction<CommentRow[]>`
                    select comments.*
                    from comments
                    join posts on posts.id = comments.post_id
                    where posts.account_id = ${account.account_id}
                      and comments.idempotency_key = ${reply.idempotencyKey}
                `;
                const alreadyPublished = claimed.at(0);

                if (alreadyPublished !== undefined) {
                    return {kind: 'existing', comment: toComment(alreadyPublished)};
                }

                const inserted = await transaction<CommentRow[]>`
                    insert into comments (
                        post_id,
                        parent_comment_id,
                        external_comment_id,
                        external_author_id,
                        content,
                        platform_created_at,
                        platform_data,
                        idempotency_key,
                        projection_state,
                        last_observed_at,
                        deleted_at
                    ) values (
                        ${reply.postId},
                        ${reply.parentCommentId},
                        ${reply.externalCommentId},
                        ${reply.externalAuthorId},
                        ${reply.content},
                        ${reply.platformCreatedAt},
                        ${metadata}::text::jsonb,
                        ${reply.idempotencyKey},
                        'active',
                        now(),
                        null
                    )
                    on conflict (post_id, external_comment_id) do nothing
                    returning *
                `;
                const created = inserted.at(0);

                if (created !== undefined) {
                    return {kind: 'created', comment: toComment(created)};
                }

                const reconciled = await transaction<CommentRow[]>`
                    update comments
                    set idempotency_key = ${reply.idempotencyKey},
                        projection_state = 'active',
                        last_observed_at = now(),
                        deleted_at = null,
                        updated_at = now()
                    where post_id = ${reply.postId}
                      and external_comment_id = ${reply.externalCommentId}
                      and idempotency_key is null
                    returning *
                `;
                const attached = reconciled.at(0);

                if (attached !== undefined) {
                    return {kind: 'existing', comment: toComment(attached)};
                }

                const current = await transaction<CommentRow[]>`
                    select * from comments
                    where post_id = ${reply.postId}
                      and external_comment_id = ${reply.externalCommentId}
                `;
                const existing = current.at(0);

                if (existing === undefined) {
                    throw new Error('Publishing a reply neither inserted nor found a row.');
                }

                return {kind: 'existing', comment: toComment(existing)};
            },
        );
    }
}
