import {
    toCommentId,
    toExternalAuthorId,
    toExternalCommentId,
    toIdempotencyKey,
    toPostId,
    type Comment,
    type CommentRepository,
    type NormalizedComment,
    type PlatformMetadata,
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

    /**
     * Upserts on the external identity of a comment, so re-importing the same platform comment
     * updates the existing projection instead of creating a duplicate. The internal identifier and
     * the local creation timestamp survive a conflict; the version advances monotonically. The
     * whole batch runs in one transaction and the results keep the order of the input.
     */
    public async saveMany(comments: readonly NormalizedComment[]): Promise<readonly Comment[]> {
        if (comments.length === 0) {
            return [];
        }

        return await this.sql.begin<Comment[]>(async (transaction): Promise<Comment[]> => {
            const stored: Comment[] = [];

            for (const comment of comments) {
                // Serialized once here and parsed by PostgreSQL: describing the parameter as text
                // stops the driver from encoding an already encoded JSON document a second time.
                const metadata =
                    comment.metadata === null ? null : JSON.stringify(comment.metadata);
                const rows = await transaction<CommentRow[]>`
                    insert into comments (
                        post_id,
                        parent_comment_id,
                        external_comment_id,
                        external_author_id,
                        content,
                        platform_created_at,
                        platform_data
                    ) values (
                        ${comment.postId},
                        ${comment.parentCommentId},
                        ${comment.externalCommentId},
                        ${comment.externalAuthorId},
                        ${comment.content},
                        ${comment.platformCreatedAt},
                        ${metadata}::text::jsonb
                    )
                    on conflict (post_id, external_comment_id) do update set
                        parent_comment_id = excluded.parent_comment_id,
                        external_author_id = excluded.external_author_id,
                        content = excluded.content,
                        platform_created_at = excluded.platform_created_at,
                        platform_data = excluded.platform_data,
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
}
