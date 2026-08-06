import {
    toAccountId,
    toExternalCommentId,
    toPostId,
    toSocialPlatform,
    type CommentId,
    type CommentProjectionStateRepository,
    type CommentReplyContext,
    type CommentReplyContextRepository,
} from '@threadbridge/comments';
import type {Sql} from 'postgres';

interface CommentReplyContextRow {
    readonly post_id: string;
    readonly account_id: string;
    readonly platform: string;
    readonly external_parent_comment_id: string;
}

export class PostgresCommentReplyContextRepository
implements CommentReplyContextRepository, CommentProjectionStateRepository {
    public constructor(private readonly sql: Sql) {}

    public async findByCommentId(commentId: CommentId): Promise<CommentReplyContext | null> {
        const rows = await this.sql<CommentReplyContextRow[]>`
            select comments.post_id,
                   accounts.id as account_id,
                   accounts.platform,
                   comments.external_comment_id as external_parent_comment_id
            from comments
            join posts on posts.id = comments.post_id
            join accounts on accounts.id = posts.account_id
            where comments.id = ${commentId}
              and comments.projection_state = 'active'
        `;
        const row = rows.at(0);

        if (row === undefined) {
            return null;
        }

        return {
            postId: toPostId(row.post_id),
            accountId: toAccountId(row.account_id),
            platform: toSocialPlatform(row.platform),
            externalParentCommentId: toExternalCommentId(row.external_parent_comment_id),
        };
    }

    public async markDeleted(commentId: CommentId): Promise<void> {
        await this.sql`
            update comments
            set projection_state = 'deleted',
                deleted_at = coalesce(deleted_at, now()),
                updated_at = now(),
                version = version + 1
            where id = ${commentId}
              and projection_state <> 'deleted'
        `;
    }
}
