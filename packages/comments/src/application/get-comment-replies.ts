import type {CommentPage, NormalizedComment} from '../domain/comment.js';
import type {
    CommentNotFoundFailure,
    PlatformFailure,
    UnsupportedPlatformFailure,
} from '../domain/errors.js';
import type {CommentId, Cursor, SocialPlatform} from '../domain/identifiers.js';
import {err, ok, type Result} from '../domain/result.js';
import type {CommentReplyContextRepository} from '../ports/comment-reply-context-repository.js';
import type {CommentRepository} from '../ports/comment-repository.js';
import type {SocialCommentsGateway} from '../ports/social-comments-gateway.js';

/**
 * The caller identifies the parent comment only by its internal identifier. The platform, the
 * account, and the external comment identifier are resolved from the stored reply context.
 */
export interface GetCommentRepliesQuery {
    readonly commentId: CommentId;
    readonly cursor?: Cursor;
}

export type GetCommentRepliesFailure =
    | CommentNotFoundFailure
    | UnsupportedPlatformFailure
    | PlatformFailure;

export class GetCommentReplies {
    public constructor(
        private readonly contexts: CommentReplyContextRepository,
        private readonly gateways: ReadonlyMap<SocialPlatform, SocialCommentsGateway>,
        private readonly comments: CommentRepository,
    ) {}

    public async execute(
        query: GetCommentRepliesQuery,
    ): Promise<Result<CommentPage, GetCommentRepliesFailure>> {
        const context = await this.contexts.findByCommentId(query.commentId);

        if (context === null) {
            return err<GetCommentRepliesFailure>({
                code: 'COMMENT_NOT_FOUND',
                message: 'The requested comment was not found.',
            });
        }

        const gateway = this.gateways.get(context.platform);

        if (gateway === undefined) {
            return err<GetCommentRepliesFailure>({
                code: 'UNSUPPORTED_PLATFORM',
                message: 'The social platform of the requested comment is not supported.',
            });
        }

        const platformPage = await gateway.getReplies({
            accountId: context.accountId,
            externalParentCommentId: context.externalParentCommentId,
            cursor: query.cursor ?? null,
        });

        if (!platformPage.ok) {
            return err<GetCommentRepliesFailure>(platformPage.error);
        }

        const stored = await this.comments.saveMany(
            platformPage.value.items.map((reply): NormalizedComment => ({
                postId: context.postId,
                parentCommentId: query.commentId,
                externalCommentId: reply.externalCommentId,
                externalAuthorId: reply.externalAuthorId,
                content: reply.content,
                platformCreatedAt: reply.createdAt,
                metadata: reply.metadata,
            })),
        );

        return ok<CommentPage>({items: stored, nextCursor: platformPage.value.nextCursor});
    }
}
