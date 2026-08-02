import type {PlatformFailure} from '../domain/errors.js';
import type {AccountId, Cursor, ExternalCommentId, ExternalPostId} from '../domain/identifiers.js';
import type {PlatformCommentPage} from '../domain/platform.js';
import type {Result} from '../domain/result.js';

export interface GetPlatformCommentsInput {
    readonly accountId: AccountId;
    readonly externalPostId: ExternalPostId;
    readonly cursor: Cursor | null;
}

export interface GetPlatformRepliesInput {
    readonly accountId: AccountId;
    readonly externalParentCommentId: ExternalCommentId;
    readonly cursor: Cursor | null;
}

export interface SocialCommentsGateway {
    /**
     * Requests a single page of root comments from the external platform and translates external
     * failures into typed platform failures.
     */
    getComments(
        input: GetPlatformCommentsInput,
    ): Promise<Result<PlatformCommentPage, PlatformFailure>>;

    /**
     * Requests a single page of direct replies to a comment. It never walks the subtree.
     */
    getReplies(
        input: GetPlatformRepliesInput,
    ): Promise<Result<PlatformCommentPage, PlatformFailure>>;
}
