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
import {LimitedDemoSocialCommentsGateway}
    from './adapters/demo/limited-demo-comments-gateway.js';
import {PostgresCommentReplyContextRepository}
    from './adapters/postgres/comment-reply-context-repository.js';
import {PostgresCommentRepository} from './adapters/postgres/comment-repository.js';
import {PostgresPublishedPostRepository} from './adapters/postgres/published-post-repository.js';
import {PostgresReplyPublicationOperationRepository}
    from './adapters/postgres/reply-publication-operation-repository.js';
import {DATABASE_CONNECT_TIMEOUT_SECONDS} from './config.js';
import type {ApiServerDependencies} from './server.js';
import {SHUTDOWN_GRACE_PERIOD_MS} from './shutdown.js';

const DEMO_PLATFORM = toSocialPlatform('demo');
const LIMITED_DEMO_PLATFORM = toSocialPlatform('demo-limited');
const DATABASE_APPLICATION_NAME = 'threadbridge-api';

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
    const sql = postgres(databaseUrl, {
        connect_timeout: DATABASE_CONNECT_TIMEOUT_SECONDS,
        connection: {application_name: DATABASE_APPLICATION_NAME},
    });
    const publishedPosts = new PostgresPublishedPostRepository(sql);
    const replyContexts = new PostgresCommentReplyContextRepository(sql);
    const comments = new PostgresCommentRepository(sql);
    const publicationOperations = new PostgresReplyPublicationOperationRepository(sql);
    const gateways = new Map<SocialPlatform, SocialCommentsGateway>([
        [DEMO_PLATFORM, new DemoSocialCommentsGateway()],
        [LIMITED_DEMO_PLATFORM, new LimitedDemoSocialCommentsGateway()],
    ]);

    return {
        dependencies: {
            requestIdFactory: randomUUID,
            checkReadiness: async (): Promise<void> => {
                await sql`select 1`;
            },
            getPostComments: new GetPostComments(publishedPosts, gateways, comments),
            getCommentReplies: new GetCommentReplies(replyContexts, gateways, comments),
            // This adapter owns both active reply-context reads and explicit
            // projection-deletion writes, so the same instance satisfies two narrow ports.
            replyToComment: new ReplyToComment(
                replyContexts,
                gateways,
                comments,
                publicationOperations,
                replyContexts,
            ),
        },
        close: async (): Promise<void> => {
            await sql.end({timeout: SHUTDOWN_GRACE_PERIOD_MS / 1_000});
        },
    };
};
