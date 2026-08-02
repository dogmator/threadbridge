import type {CommentPage, NormalizedComment} from '../domain/comment.js';
import type {
    PlatformFailure,
    PostNotFoundFailure,
    UnsupportedPlatformFailure,
} from '../domain/errors.js';
import type {Cursor, PostId, SocialPlatform} from '../domain/identifiers.js';
import {err, ok, type Result} from '../domain/result.js';
import type {CommentRepository} from '../ports/comment-repository.js';
import type {PublishedPostRepository} from '../ports/published-post-repository.js';
import type {SocialCommentsGateway} from '../ports/social-comments-gateway.js';

/**
 * The caller identifies the post only by its internal identifier. The platform and the external
 * post identifier are resolved from the stored post context.
 */
export interface GetPostCommentsQuery {
    readonly postId: PostId;
    readonly cursor?: Cursor;
}

export type GetPostCommentsFailure =
    | PostNotFoundFailure
    | UnsupportedPlatformFailure
    | PlatformFailure;

export class GetPostComments {
    public constructor(
        private readonly posts: PublishedPostRepository,
        private readonly gateways: ReadonlyMap<SocialPlatform, SocialCommentsGateway>,
        private readonly comments: CommentRepository,
    ) {}

    public async execute(
        query: GetPostCommentsQuery,
    ): Promise<Result<CommentPage, GetPostCommentsFailure>> {
        const post = await this.posts.findContextByPostId(query.postId);

        if (post === null) {
            return err<GetPostCommentsFailure>({
                code: 'POST_NOT_FOUND',
                postId: query.postId,
            });
        }

        const gateway = this.gateways.get(post.platform);

        if (gateway === undefined) {
            return err<GetPostCommentsFailure>({
                code: 'UNSUPPORTED_PLATFORM',
                platform: post.platform,
            });
        }

        const platformPage = await gateway.getComments({
            accountId: post.accountId,
            externalPostId: post.externalPostId,
            cursor: query.cursor ?? null,
        });

        if (!platformPage.ok) {
            return err<GetPostCommentsFailure>(platformPage.error);
        }

        const stored = await this.comments.saveMany(
            platformPage.value.items.map((comment): NormalizedComment => ({
                postId: query.postId,
                parentCommentId: null,
                externalCommentId: comment.externalCommentId,
                externalAuthorId: comment.externalAuthorId,
                content: comment.content,
                platformCreatedAt: comment.createdAt,
                metadata: comment.metadata,
            })),
        );

        return ok<CommentPage>({items: stored, nextCursor: platformPage.value.nextCursor});
    }
}
