import {randomUUID} from 'node:crypto';
import {
    GetCommentReplies,
    GetPostComments,
    ReplyToComment,
    toSocialPlatform,
    type SocialCommentsGateway,
    type SocialPlatform,
} from '@threadbridge/comments';
import postgres from 'postgres';
import {DemoSocialCommentsGateway} from './adapters/demo/demo-comments-gateway.js';
import {PostgresCommentReplyContextRepository}
    from './adapters/postgres/comment-reply-context-repository.js';
import {PostgresCommentRepository} from './adapters/postgres/comment-repository.js';
import {PostgresPublishedPostRepository} from './adapters/postgres/published-post-repository.js';
import type {ApiServerDependencies} from './server.js';

const DEMO_PLATFORM = toSocialPlatform('demo');

export interface ApiComponents {
    readonly dependencies: ApiServerDependencies;
    close(): Promise<void>;
}

/**
 * The composition root. It is the only place that knows which concrete adapter implements which
 * port, and the only place that registers a platform gateway. Adding a platform means adding one
 * entry to the registry below.
 */
export const createApiComponents = (databaseUrl: string): ApiComponents => {
    const sql = postgres(databaseUrl);
    const publishedPosts = new PostgresPublishedPostRepository(sql);
    const replyContexts = new PostgresCommentReplyContextRepository(sql);
    const comments = new PostgresCommentRepository(sql);
    const gateways = new Map<SocialPlatform, SocialCommentsGateway>([
        [DEMO_PLATFORM, new DemoSocialCommentsGateway()],
    ]);

    return {
        dependencies: {
            requestIdFactory: randomUUID,
            getPostComments: new GetPostComments(publishedPosts, gateways, comments),
            getCommentReplies: new GetCommentReplies(replyContexts, gateways, comments),
            replyToComment: new ReplyToComment(replyContexts, gateways, comments),
        },
        close: async (): Promise<void> => {
            await sql.end();
        },
    };
};
