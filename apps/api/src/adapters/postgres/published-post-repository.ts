import {
    toAccountId,
    toExternalPostId,
    toSocialPlatform,
    type PostId,
    type PublishedPostContext,
    type PublishedPostRepository,
} from '@threadbridge/comments';
import type {Sql} from 'postgres';

interface PublishedPostRow {
    readonly account_id: string;
    readonly platform: string;
    readonly external_post_id: string;
}

export class PostgresPublishedPostRepository implements PublishedPostRepository {
    public constructor(private readonly sql: Sql) {}

    public async findContextByPostId(postId: PostId): Promise<PublishedPostContext | null> {
        const rows = await this.sql<PublishedPostRow[]>`
            select accounts.id as account_id,
                   accounts.platform,
                   posts.external_post_id
            from posts
            join accounts on accounts.id = posts.account_id
            where posts.id = ${postId}
        `;
        const row = rows.at(0);

        if (row === undefined) {
            return null;
        }

        return {
            accountId: toAccountId(row.account_id),
            platform: toSocialPlatform(row.platform),
            externalPostId: toExternalPostId(row.external_post_id),
        };
    }
}
