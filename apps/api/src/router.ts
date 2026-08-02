import type {IncomingMessage, ServerResponse} from 'node:http';
import {
    toCommentId,
    toCursor,
    toIdempotencyKey,
    toPostId,
    type CommentsFailure,
    type Cursor,
    type GetCommentRepliesQuery,
    type GetPostCommentsQuery,
    type ReplyToCommentQuery,
} from '@threadbridge/comments';
import {
    toCommentPageResponse,
    toCommentResponse,
    type CommentPageResponse,
    type CommentResponse,
} from './comment-response.js';
import {toErrorEnvelope, toHttpErrorResponse, type HttpErrorEnvelope} from './http-error.js';
import {readBoundedBody} from './request-body.js';
import type {ApiServerDependencies} from './server.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Transport limits. They bound what an untrusted client can make this process hold or forward, and
 * they are deliberately checked here rather than in the core: a request that is too large or too
 * long is never a domain failure.
 */
const MAX_IDEMPOTENCY_KEY_CHARACTERS = 200;
const MAX_CONTENT_CHARACTERS = 10_000;
const MAX_CURSOR_CHARACTERS = 4_096;

const JSON_MEDIA_TYPE = 'application/json';

const writeJson = (
    response: ServerResponse,
    statusCode: number,
    body:
        | Readonly<Record<string, string>>
        | CommentPageResponse
        | CommentResponse
        | HttpErrorEnvelope,
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

/**
 * Transport-local: the specification lists a validation error category, but a malformed request is
 * a transport concern and never becomes a core failure.
 */
const writeValidationError = (
    response: ServerResponse,
    dependencies: ApiServerDependencies,
): void => {
    writeJson(
        response,
        400,
        toErrorEnvelope(
            'VALIDATION_ERROR',
            'Request validation failed',
            dependencies.requestIdFactory(),
        ),
    );
};

/** Transport-local: the request never reached a use case, so this is not a core failure. */
const writeUnsupportedMediaType = (
    response: ServerResponse,
    dependencies: ApiServerDependencies,
): void => {
    writeJson(
        response,
        415,
        toErrorEnvelope(
            'UNSUPPORTED_MEDIA_TYPE',
            'Content type must be application/json',
            dependencies.requestIdFactory(),
        ),
    );
};

/** Transport-local, for the same reason. */
const writePayloadTooLarge = (
    response: ServerResponse,
    dependencies: ApiServerDependencies,
): void => {
    writeJson(
        response,
        413,
        toErrorEnvelope(
            'PAYLOAD_TOO_LARGE',
            'Request body is too large',
            dependencies.requestIdFactory(),
        ),
    );
};

/**
 * A response sent before the whole request body is read must not share its connection with a
 * subsequent request: the remaining bytes belong to this request's framing. The response is still
 * allowed to flush promptly; the stream is resumed only to discard those bytes until the socket
 * closes after this response.
 */
const makeConnectionNonReusable = (request: IncomingMessage, response: ServerResponse): void => {
    response.shouldKeepAlive = false;
    response.setHeader('connection', 'close');
    request.once('error', (): void => undefined);
    request.resume();
};

/**
 * Accepts `application/json` with any parameters, such as a charset. Media types are
 * case-insensitive, and a missing header is not treated as a guess in favour of JSON.
 */
const isJsonMediaType = (header: string | readonly string[] | undefined): boolean => {
    if (typeof header !== 'string') {
        return false;
    }

    const mediaType = header.split(';')[0]?.trim().toLowerCase();

    return mediaType === JSON_MEDIA_TYPE;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const parseJson = (raw: string): unknown => {
    try {
        return JSON.parse(raw) as unknown;
    } catch {
        return undefined;
    }
};

/**
 * Builds the publication query from untrusted input. Emptiness is judged on trimmed content and
 * the key is trimmed before it is measured, but the exact accepted content is never rewritten: it
 * is published and compared for idempotency exactly as it arrived.
 */
const parseReplyRequest = (
    raw: string,
    idempotencyHeader: string | readonly string[] | undefined,
): ReplyToCommentQuery | null => {
    if (typeof idempotencyHeader !== 'string') {
        return null;
    }

    const idempotencyKey = idempotencyHeader.trim();

    if (idempotencyKey === '' || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_CHARACTERS) {
        return null;
    }

    const body = parseJson(raw);

    if (!isRecord(body)) {
        return null;
    }

    const {parentCommentId, content} = body;

    if (typeof parentCommentId !== 'string' || !UUID_PATTERN.test(parentCommentId)) {
        return null;
    }

    if (typeof content !== 'string' || content.trim() === '') {
        return null;
    }

    if (content.length > MAX_CONTENT_CHARACTERS) {
        return null;
    }

    return {
        parentCommentId: toCommentId(parentCommentId),
        content,
        idempotencyKey: toIdempotencyKey(idempotencyKey),
    };
};

const publishReply = async (
    request: IncomingMessage,
    response: ServerResponse,
    dependencies: ApiServerDependencies,
): Promise<void> => {
    if (!isJsonMediaType(request.headers['content-type'])) {
        makeConnectionNonReusable(request, response);
        writeUnsupportedMediaType(response, dependencies);
        return;
    }

    const body = await readBoundedBody(request);

    if (body.kind === 'too-large') {
        makeConnectionNonReusable(request, response);
        writePayloadTooLarge(response, dependencies);
        return;
    }

    const query = parseReplyRequest(body.text, request.headers['idempotency-key']);

    if (query === null) {
        writeValidationError(response, dependencies);
        return;
    }

    const result = await dependencies.replyToComment.execute(query);

    if (!result.ok) {
        writeFailure(response, result.error, dependencies);
        return;
    }

    writeJson(
        response,
        result.value.kind === 'created' ? 201 : 200,
        toCommentResponse(result.value.comment),
    );
};

type CursorSelection =
    | {readonly kind: 'none'}
    | {readonly kind: 'cursor'; readonly cursor: Cursor}
    | {readonly kind: 'too-long'};

/**
 * A cursor stays opaque here: it is only measured, never decoded or rewritten, and it reaches the
 * adapter exactly as the client sent it.
 */
const readCursor = (url: URL): CursorSelection => {
    const raw = url.searchParams.get('cursor');

    if (raw === null || raw === '') {
        return {kind: 'none'};
    }

    if (raw.length > MAX_CURSOR_CHARACTERS) {
        return {kind: 'too-long'};
    }

    return {kind: 'cursor', cursor: toCursor(raw)};
};

const respondWithPostComments = async (
    response: ServerResponse,
    dependencies: ApiServerDependencies,
    rawPostId: string,
    url: URL,
): Promise<void> => {
    if (!UUID_PATTERN.test(rawPostId)) {
        writeValidationError(response, dependencies);
        return;
    }

    const cursor = readCursor(url);

    if (cursor.kind === 'too-long') {
        writeValidationError(response, dependencies);
        return;
    }

    const postId = toPostId(rawPostId);
    const query: GetPostCommentsQuery =
        cursor.kind === 'none' ? {postId} : {postId, cursor: cursor.cursor};
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
    if (!UUID_PATTERN.test(rawCommentId)) {
        writeValidationError(response, dependencies);
        return;
    }

    const cursor = readCursor(url);

    if (cursor.kind === 'too-long') {
        writeValidationError(response, dependencies);
        return;
    }

    const commentId = toCommentId(rawCommentId);
    const query: GetCommentRepliesQuery =
        cursor.kind === 'none' ? {commentId} : {commentId, cursor: cursor.cursor};
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

    if (request.method === 'POST' && segments.length === 1 && segments[0] === 'comments') {
        await publishReply(request, response, dependencies);
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
