import type {IncomingMessage, ServerResponse} from 'node:http';
import {
    toCommentId,
    toCursor,
    toPostId,
    type CommentsFailure,
    type Cursor,
    type GetCommentRepliesQuery,
    type GetPostCommentsQuery,
} from '@threadbridge/comments';
import {toCommentPageResponse, type CommentPageResponse} from './comment-response.js';
import {toErrorEnvelope, toHttpErrorResponse, type HttpErrorEnvelope} from './http-error.js';
import type {ApiServerDependencies} from './server.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const writeJson = (
    response: ServerResponse,
    statusCode: number,
    body: Readonly<Record<string, string>> | CommentPageResponse | HttpErrorEnvelope,
): void => {
    response.writeHead(statusCode, {
        'content-type': 'application/json; charset=utf-8',
    }).end(JSON.stringify(body));
};

const writeFailure = (
    response: ServerResponse,
    failure: CommentsFailure,
    dependencies: ApiServerDependencies,
): void => {
    const mapped = toHttpErrorResponse(failure, dependencies.requestIdFactory());

    writeJson(response, mapped.status, mapped.body);
};

const readCursor = (url: URL): Cursor | undefined => {
    const cursor = url.searchParams.get('cursor');

    return cursor === null || cursor === '' ? undefined : toCursor(cursor);
};

const respondWithPostComments = async (
    response: ServerResponse,
    dependencies: ApiServerDependencies,
    rawPostId: string,
    url: URL,
): Promise<void> => {
    const postId = toPostId(rawPostId);

    if (!UUID_PATTERN.test(rawPostId)) {
        writeFailure(response, {code: 'POST_NOT_FOUND', postId}, dependencies);
        return;
    }

    const cursor = readCursor(url);
    const query: GetPostCommentsQuery = cursor === undefined ? {postId} : {postId, cursor};
    const result = await dependencies.getPostComments.execute(query);

    if (!result.ok) {
        writeFailure(response, result.error, dependencies);
        return;
    }

    writeJson(response, 200, toCommentPageResponse(result.value));
};

const respondWithCommentReplies = async (
    response: ServerResponse,
    dependencies: ApiServerDependencies,
    rawCommentId: string,
    url: URL,
): Promise<void> => {
    const commentId = toCommentId(rawCommentId);

    if (!UUID_PATTERN.test(rawCommentId)) {
        writeFailure(response, {code: 'COMMENT_NOT_FOUND', commentId}, dependencies);
        return;
    }

    const cursor = readCursor(url);
    const query: GetCommentRepliesQuery = cursor === undefined ? {commentId} : {commentId, cursor};
    const result = await dependencies.getCommentReplies.execute(query);

    if (!result.ok) {
        writeFailure(response, result.error, dependencies);
        return;
    }

    writeJson(response, 200, toCommentPageResponse(result.value));
};

const route = async (
    request: IncomingMessage,
    response: ServerResponse,
    dependencies: ApiServerDependencies,
): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const segments = url.pathname.split('/').filter((segment): boolean => segment !== '');
    const isGet = request.method === 'GET';

    if (isGet && segments.length === 1 && segments[0] === 'health') {
        writeJson(response, 200, {status: 'ok'});
        return;
    }

    if (isGet && segments.length === 3 && segments[0] === 'posts' && segments[2] === 'comments') {
        await respondWithPostComments(response, dependencies, segments[1] ?? '', url);
        return;
    }

    if (isGet && segments.length === 3 && segments[0] === 'comments' && segments[2] === 'replies') {
        await respondWithCommentReplies(response, dependencies, segments[1] ?? '', url);
        return;
    }

    writeJson(
        response,
        404,
        toErrorEnvelope('ROUTE_NOT_FOUND', 'Route was not found', dependencies.requestIdFactory()),
    );
};

/**
 * Never rejects: an unexpected failure becomes a transport-local internal error, so one bad
 * request cannot take the process down or leave a connection hanging.
 */
export const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
    dependencies: ApiServerDependencies,
): Promise<void> => {
    try {
        await route(request, response, dependencies);
    } catch {
        if (!response.headersSent) {
            writeJson(
                response,
                500,
                toErrorEnvelope(
                    'INTERNAL_ERROR',
                    'Internal error',
                    dependencies.requestIdFactory(),
                ),
            );
        }
    }
};
