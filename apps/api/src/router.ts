import type {IncomingMessage, ServerResponse} from 'node:http';
import {
    Type,
    TypeBoxValidatorCompiler,
    type TypeBoxTypeProvider,
} from '@fastify/type-provider-typebox';
import Fastify, {
    LogController,
    type FastifyError,
    type FastifyInstance,
    type FastifyReply,
    type FastifyRequest,
} from 'fastify';
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
import {toCommentPageResponse, toCommentResponse} from './comment-response.js';
import {toErrorEnvelope, toHttpErrorResponse} from './http-error.js';
import type {ApiServerDependencies, ApiServerOptions} from './server.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const MAX_IDEMPOTENCY_KEY_CHARACTERS = 200;
const MAX_CONTENT_CHARACTERS = 10_000;
const MAX_CURSOR_CHARACTERS = 4_096;
const REQUEST_RECEIVE_TIMEOUT_MS = 30_000;
const JSON_MEDIA_TYPE = 'application/json';
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const UNMATCHED_ROUTE = '<unmatched>';
const QUIET_ROUTES = new Set(['/health', '/ready']);

const TRANSPORT_ERRORS = {
    validation: [400, 'VALIDATION_ERROR', 'Request validation failed'],
    unsupportedMediaType: [415, 'UNSUPPORTED_MEDIA_TYPE', 'Content type must be application/json'],
    payloadTooLarge: [413, 'PAYLOAD_TOO_LARGE', 'Request body is too large'],
    routeNotFound: [404, 'ROUTE_NOT_FOUND', 'Route was not found'],
    internal: [500, 'INTERNAL_ERROR', 'Internal error'],
} as const;

type TransportError = (typeof TRANSPORT_ERRORS)[keyof typeof TRANSPORT_ERRORS];

const sendJson = (
    reply: FastifyReply,
    statusCode: number,
    body: unknown,
    headers: Readonly<Record<string, string>> = {},
): FastifyReply => reply.headers(headers).code(statusCode).type(JSON_CONTENT_TYPE).send(body);

const sendFailure = (
    reply: FastifyReply,
    failure: CommentsFailure,
    requestId: string,
): FastifyReply => {
    const mapped = toHttpErrorResponse(failure, requestId);

    return sendJson(reply, mapped.status, mapped.body, mapped.headers);
};

const sendTransportError = (
    reply: FastifyReply,
    requestId: string,
    [statusCode, code, message]: TransportError,
): FastifyReply => sendJson(
    reply,
    statusCode,
    toErrorEnvelope(code, message, requestId),
);

const makeConnectionNonReusable = (request: IncomingMessage, response: ServerResponse): void => {
    response.shouldKeepAlive = false;
    response.setHeader('connection', 'close');
    request.once('error', (): void => undefined);
    request.resume();
};

const isJsonMediaType = (header: string | readonly string[] | undefined): boolean => {
    if (typeof header !== 'string') {
        return false;
    }

    return header.split(';')[0]?.trim().toLowerCase() === JSON_MEDIA_TYPE;
};

const ReplyBodySchema = Type.Object(
    {parentCommentId: Type.String(), content: Type.String()},
    {additionalProperties: true},
);
const PostParamsSchema = Type.Object({postId: Type.String()});
const CommentParamsSchema = Type.Object({commentId: Type.String()});

const parseReplyRequest = (
    body: {readonly parentCommentId: string; readonly content: string},
    idempotencyHeader: string | readonly string[] | undefined,
): ReplyToCommentQuery | null => {
    if (typeof idempotencyHeader !== 'string') {
        return null;
    }

    if (idempotencyHeader === '' || idempotencyHeader.length > MAX_IDEMPOTENCY_KEY_CHARACTERS) {
        return null;
    }

    if (!UUID_PATTERN.test(body.parentCommentId)
        || body.content.trim() === ''
        || body.content.length > MAX_CONTENT_CHARACTERS) {
        return null;
    }

    return {
        parentCommentId: toCommentId(body.parentCommentId),
        content: body.content,
        idempotencyKey: toIdempotencyKey(idempotencyHeader),
    };
};

const readCursor = (request: FastifyRequest): Cursor | null | undefined => {
    const raw = new URL(request.raw.url ?? '/', 'http://127.0.0.1').searchParams.get('cursor');

    if (raw === null || raw === '') {
        return null;
    }

    return raw.length > MAX_CURSOR_CHARACTERS ? undefined : toCursor(raw);
};

type CommentPageLoader = (
    rawId: string,
    cursor: Cursor | null,
) => Promise<Result<CommentPage, CommentsFailure>>;

const respondWithCommentPage = async (
    request: FastifyRequest,
    reply: FastifyReply,
    rawId: string,
    load: CommentPageLoader,
): Promise<FastifyReply> => {
    const cursor = readCursor(request);

    if (!UUID_PATTERN.test(rawId) || cursor === undefined) {
        return await sendTransportError(reply, request.id, TRANSPORT_ERRORS.validation);
    }

    const result = await load(rawId, cursor);

    return result.ok
        ? await sendJson(reply, 200, toCommentPageResponse(result.value))
        : await sendFailure(reply, result.error, request.id);
};

const isValidationError = (error: FastifyError): boolean =>
    error.validation !== undefined || error.code === 'FST_ERR_CTP_INVALID_JSON_BODY';

export const createHttpRouter = (
    dependencies: ApiServerDependencies,
    options: ApiServerOptions,
): FastifyInstance => {
    const server = Fastify({
        bodyLimit: MAX_REQUEST_BODY_BYTES,
        exposeHeadRoutes: false,
        genReqId: (): string => dependencies.requestIdFactory(),
        logger: options.logger ? {level: 'info'} : false,
        logController: new LogController({disableRequestLogging: true}),
        requestIdHeader: false,
        requestTimeout: REQUEST_RECEIVE_TIMEOUT_MS,
        routerOptions: {
            ignoreDuplicateSlashes: true,
            ignoreTrailingSlash: true,
        },
    })
        .withTypeProvider<TypeBoxTypeProvider>()
        .setValidatorCompiler(TypeBoxValidatorCompiler);

    if (options.logger) {
        server.addHook('onResponse', (request, reply, done): void => {
            const route = request.routeOptions.url ?? UNMATCHED_ROUTE;

            if (!QUIET_ROUTES.has(route)) {
                request.log.info(
                    {
                        requestId: request.id,
                        method: request.method,
                        route,
                        statusCode: reply.statusCode,
                        durationMs: reply.elapsedTime,
                    },
                    'HTTP request completed',
                );
            }

            done();
        });
    }

    server.removeContentTypeParser('application/json');
    server.addContentTypeParser(
        /^application\/json(?:\s*;.*)?$/iu,
        {parseAs: 'string'},
        server.getDefaultJsonParser('ignore', 'ignore'),
    );

    server.setErrorHandler((error: FastifyError, request, reply): void => {
        if (reply.sent) {
            return;
        }

        if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
            makeConnectionNonReusable(request.raw, reply.raw);
            sendTransportError(reply, request.id, TRANSPORT_ERRORS.payloadTooLarge);
            return;
        }

        if (!isValidationError(error)) {
            request.log.error(
                {requestId: request.id, errorName: error.name},
                'Unexpected request failure',
            );
        }

        sendTransportError(
            reply,
            request.id,
            isValidationError(error) ? TRANSPORT_ERRORS.validation : TRANSPORT_ERRORS.internal,
        );
    });

    server.setNotFoundHandler((request, reply): void => {
        sendTransportError(reply, request.id, TRANSPORT_ERRORS.routeNotFound);
    });

    server.get('/health', (_request, reply): void => {
        sendJson(reply, 200, {status: 'ok'});
    });

    server.get('/ready', async (request, reply): Promise<FastifyReply> => {
        try {
            await dependencies.checkReadiness();
            return await sendJson(reply, 200, {status: 'ready'});
        } catch {
            request.log.warn(
                {requestId: request.id, route: '/ready'},
                'Readiness check failed',
            );
            return await sendJson(reply, 503, {status: 'unavailable'});
        }
    });

    server.get('/posts/:postId/comments', {schema: {params: PostParamsSchema}}, async (request, reply) =>
        await respondWithCommentPage(
            request,
            reply,
            request.params.postId,
            async (rawId, cursor) => {
                const postId = toPostId(rawId);
                return await dependencies.getPostComments.execute(
                    cursor === null ? {postId} : {postId, cursor},
                );
            },
        ));

    server.get(
        '/comments/:commentId/replies',
        {schema: {params: CommentParamsSchema}},
        async (request, reply) => await respondWithCommentPage(
            request,
            reply,
            request.params.commentId,
            async (rawId, cursor) => {
                const commentId = toCommentId(rawId);
                return await dependencies.getCommentReplies.execute(
                    cursor === null ? {commentId} : {commentId, cursor},
                );
            },
        ),
    );

    server.post(
        '/comments',
        {
            onRequest: async (request, reply): Promise<FastifyReply | undefined> => {
                if (isJsonMediaType(request.headers['content-type'])) {
                    return undefined;
                }

                makeConnectionNonReusable(request.raw, reply.raw);
                return await sendTransportError(
                    reply,
                    request.id,
                    TRANSPORT_ERRORS.unsupportedMediaType,
                );
            },
            schema: {body: ReplyBodySchema},
        },
        async (request, reply): Promise<FastifyReply> => {
            const query = parseReplyRequest(request.body, request.headers['idempotency-key']);

            if (query === null) {
                return await sendTransportError(reply, request.id, TRANSPORT_ERRORS.validation);
            }

            const result = await dependencies.replyToComment.execute(query);

            return result.ok
                ? await sendJson(
                    reply,
                    result.value.kind === 'created' ? 201 : 200,
                    toCommentResponse(result.value.comment),
                )
                : await sendFailure(reply, result.error, request.id);
        },
    );

    return server;
};
