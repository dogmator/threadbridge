import type {IncomingMessage, ServerResponse} from 'node:http';
import {
    toCommentId,
    toCursor,
    toIdempotencyKey,
    toPostId,
    type CommentPage,
    type CommentsFailure,
    type Cursor,
    type ReplyToCommentQuery,
    type Result,
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
    headers: Readonly<Record<string, string>> = {},
): void => {
    response.writeHead(statusCode, {
        ...headers,
        'content-type': 'application/json; charset=utf-8',
    }).end(JSON.stringify(body));
};

const writeFailure = (
    response: ServerResponse,
    failure: CommentsFailure,
    dependencies: ApiServerDependencies,
): void => {
    const mapped = toHttpErrorResponse(failure, dependencies.requestIdFactory());

    writeJson(response, mapped.status, mapped.body, mapped.headers);
};

const TRANSPORT_ERRORS = {
    validation: [400, 'VALIDATION_ERROR', 'Request validation failed'],
    unsupportedMediaType: [415, 'UNSUPPORTED_MEDIA_TYPE', 'Content type must be application/json'],
    payloadTooLarge: [413, 'PAYLOAD_TOO_LARGE', 'Request body is too large'],
    routeNotFound: [404, 'ROUTE_NOT_FOUND', 'Route was not found'],
    internal: [500, 'INTERNAL_ERROR', 'Internal error'],
} as const;

type TransportError = (typeof TRANSPORT_ERRORS)[keyof typeof TRANSPORT_ERRORS];

const writeTransportError = (
    response: ServerResponse,
    dependencies: ApiServerDependencies,
    [statusCode, code, message]: TransportError,
): void => {
    writeJson(
        response,
        statusCode,
        toErrorEnvelope(code, message, dependencies.requestIdFactory()),
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
        writeTransportError(response, dependencies, TRANSPORT_ERRORS.unsupportedMediaType);
        return;
    }

    const body = await readBoundedBody(request);

    if (body.kind === 'too-large') {
        makeConnectionNonReusable(request, response);
        writeTransportError(response, dependencies, TRANSPORT_ERRORS.payloadTooLarge);
        return;
    }

    const query = parseReplyRequest(body.text, request.headers['idempotency-key']);

    if (query === null) {
        writeTransportError(response, dependencies, TRANSPORT_ERRORS.validation);
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

type CommentPageLoader = (
    rawId: string,
    cursor: Cursor | null,
) => Promise<Result<CommentPage, CommentsFailure>>;

const respondWithCommentPage = async (
    response: ServerResponse,
    dependencies: ApiServerDependencies,
    rawId: string,
    url: URL,
    load: CommentPageLoader,
): Promise<void> => {
    if (!UUID_PATTERN.test(rawId)) {
        writeTransportError(response, dependencies, TRANSPORT_ERRORS.validation);
        return;
    }

    const cursor = readCursor(url);

    if (cursor.kind === 'too-long') {
        writeTransportError(response, dependencies, TRANSPORT_ERRORS.validation);
        return;
    }

    const result = await load(rawId, cursor.kind === 'none' ? null : cursor.cursor);

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
        await respondWithCommentPage(
            response,
            dependencies,
            segments[1] ?? '',
            url,
            async (rawId, cursor) => {
                const postId = toPostId(rawId);
                return await dependencies.getPostComments.execute(
                    cursor === null ? {postId} : {postId, cursor},
                );
            },
        );
        return;
    }

    if (isGet && segments.length === 3 && segments[0] === 'comments' && segments[2] === 'replies') {
        await respondWithCommentPage(
            response,
            dependencies,
            segments[1] ?? '',
            url,
            async (rawId, cursor) => {
                const commentId = toCommentId(rawId);
                return await dependencies.getCommentReplies.execute(
                    cursor === null ? {commentId} : {commentId, cursor},
                );
            },
        );
        return;
    }

    if (request.method === 'POST' && segments.length === 1 && segments[0] === 'comments') {
        await publishReply(request, response, dependencies);
        return;
    }

    writeTransportError(response, dependencies, TRANSPORT_ERRORS.routeNotFound);
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
            writeTransportError(response, dependencies, TRANSPORT_ERRORS.internal);
        }
    }
};
