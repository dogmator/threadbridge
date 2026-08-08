import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {request as httpRequest, type IncomingMessage} from 'node:http';
import {connect} from 'node:net';
import {describe, expect, it} from 'vitest';
import type {HttpErrorEnvelope} from '../apps/api/src/http-error.js';
import {MAX_REQUEST_BODY_BYTES} from '../apps/api/src/router.js';
import {createApiServer, type ApiServerDependencies} from '../apps/api/src/server.js';
import {
    ok,
    GetCommentReplies,
    GetPostComments,
    ReplyToComment,
    toAccountId,
    toExternalPostId,
    toSocialPlatform,
    type Comment,
    type CommentReplyContext,
    type CommentReplyContextRepository,
    type CommentRepository,
    type Cursor,
    type GetPlatformCommentsInput,
    type PlatformCommentPage,
    type PlatformFailure,
    type PublishedPostContext,
    type PublishedPostRepository,
    type Result,
    type SocialCommentsCapabilities,
    type SocialCommentsGateway,
    type SocialPlatform,
} from '@threadbridge/comments';

const PARENT_UUID = '0198f000-0000-7000-8000-0000000000ac';
const POST_UUID = '0198f000-0000-7000-8000-000000000002';
const demoPlatform = toSocialPlatform('demo');

/** Records the cursor the transport handed over, so an opaque value can be checked end to end. */
class RecordingGateway implements SocialCommentsGateway {
    public readonly capabilities: SocialCommentsCapabilities = {
        rootComments: true,
        directReplies: false,
        replyPublication: false,
        publicationIdempotency: 'none',
    };

    public readonly cursors: (Cursor | null)[] = [];

    public getComments(
        input: GetPlatformCommentsInput,
    ): Promise<Result<PlatformCommentPage, PlatformFailure>> {
        this.cursors.push(input.cursor);

        return Promise.resolve(ok<PlatformCommentPage>({items: [], nextCursor: null}));
    }

    public getReplies(): never {
        throw new Error('These tests never retrieve replies.');
    }

    public replyToComment(): never {
        throw new Error('These tests never publish through the gateway.');
    }
}

const knownPost: PublishedPostRepository = {
    findContextByPostId: (): Promise<PublishedPostContext | null> =>
        Promise.resolve({
            accountId: toAccountId('0198f000-0000-7000-8000-000000000001'),
            platform: demoPlatform,
            externalPostId: toExternalPostId('demo-post-1'),
        }),
};

const noReplyContexts: CommentReplyContextRepository = {
    findByCommentId: (): Promise<CommentReplyContext | null> => Promise.resolve(null),
};

const noComments: CommentRepository = {
    saveMany: (): Promise<readonly Comment[]> => Promise.resolve([]),
    findByIdempotencyKey: (): Promise<Comment | null> => Promise.resolve(null),
    savePublishedReply: (): never => {
        throw new Error('These tests never persist a reply.');
    },
};

class CountingRequestIdFactory {
    public calls = 0;

    public readonly create = (): string => {
        this.calls += 1;

        return 'request-1';
    };
}

interface Harness {
    readonly baseUrl: string;
    readonly gateway: RecordingGateway;
    readonly requestIds: CountingRequestIdFactory;
}

const withApiServer = async (use: (harness: Harness) => Promise<void>): Promise<void> => {
    const gateway = new RecordingGateway();
    const requestIds = new CountingRequestIdFactory();
    const gateways = new Map<SocialPlatform, SocialCommentsGateway>([[demoPlatform, gateway]]);
    const dependencies: ApiServerDependencies = {
        requestIdFactory: requestIds.create,
        checkReadiness: (): Promise<void> => Promise.resolve(),
        getPostComments: new GetPostComments(knownPost, gateways, noComments),
        getCommentReplies: new GetCommentReplies(noReplyContexts, gateways, noComments),
        replyToComment: new ReplyToComment(noReplyContexts, gateways, noComments),
    };
    const server = createApiServer(dependencies);

    await server.listen(0, '127.0.0.1');

    try {
        const address = server.address();

        if (address === null || typeof address === 'string') {
            throw new Error('The API server is not listening on a TCP port.');
        }

        await use({baseUrl: `http://127.0.0.1:${String(address.port)}`, gateway, requestIds});
    } finally {
        server.close();
        server.closeAllConnections();
        await once(server, 'close');
    }
};

interface RawResponse {
    readonly status: number;
    readonly body: string;
}

/**
 * A raw client, because these cases are about framing: a body sent without any content length has
 * to be rejected on the bytes actually received, which a helper that always sets one cannot show.
 */
const postRaw = async (
    baseUrl: string,
    headers: Readonly<Record<string, string>>,
    body: string,
): Promise<RawResponse> => {
    const url = new URL('/comments', baseUrl);
    const call = httpRequest({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers,
    });

    call.end(body);

    const [response] = (await once(call, 'response')) as [IncomingMessage];
    const chunks: Buffer[] = [];

    for await (const chunk of response as AsyncIterable<Buffer>) {
        chunks.push(chunk);
    }

    return {
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
    };
};

/**
 * Sends the body in several writes with an explicit chunked encoding and no content length, so the
 * limit can only be enforced on the bytes actually received. `end(body)` would not do: node:http
 * then computes a content length itself, and the declared-length check would take the decision.
 */
const postChunked = async (
    baseUrl: string,
    headers: Readonly<Record<string, string>>,
    chunks: readonly string[],
): Promise<RawResponse> => {
    const url = new URL('/comments', baseUrl);
    const call = httpRequest({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {...headers, 'transfer-encoding': 'chunked'},
    });

    for (const chunk of chunks) {
        call.write(chunk);
    }

    call.end();

    const [response] = (await once(call, 'response')) as [IncomingMessage];
    const received: Buffer[] = [];

    for await (const chunk of response as AsyncIterable<Buffer>) {
        received.push(chunk);
    }

    return {
        status: response.statusCode ?? 0,
        body: Buffer.concat(received).toString('utf8'),
    };
};

const replyBody = (content: string): string =>
    JSON.stringify({parentCommentId: PARENT_UUID, content});

/** Pads a valid publication body to exactly `bytes`, so a size limit can be probed on the edge. */
const paddedBody = (bytes: number): string => {
    const base = {parentCommentId: PARENT_UUID, content: 'A reply', pad: ''};
    const padding = bytes - Buffer.byteLength(JSON.stringify(base), 'utf8');

    if (padding < 0) {
        throw new Error('The requested body is smaller than the smallest valid one.');
    }

    return JSON.stringify({...base, pad: 'a'.repeat(padding)});
};

const envelopeOf = (raw: string): HttpErrorEnvelope => JSON.parse(raw) as HttpErrorEnvelope;

/** Writes an intentionally unfinished HTTP/1.1 request and waits for the server to close it. */
const unfinishedRequest = async (baseUrl: string, rawRequest: string): Promise<string> =>
    await new Promise<string>((resolve, reject): void => {
        const url = new URL(baseUrl);
        const socket = connect(Number(url.port), url.hostname);
        const received: Buffer[] = [];
        const timer = setTimeout((): void => {
            socket.destroy();
            reject(new Error('The server did not close an unfinished request promptly.'));
        }, 500);

        socket.on('connect', (): void => {
            socket.write(rawRequest);
        });
        socket.on('data', (chunk: Buffer): void => {
            received.push(chunk);
        });
        socket.on('error', (error: Error): void => {
            clearTimeout(timer);
            reject(error);
        });
        socket.on('close', (): void => {
            clearTimeout(timer);
            resolve(Buffer.concat(received).toString('utf8'));
        });
    });

describe('POST /comments media type', () => {
    it.each([
        ['application/json', 'application/json'],
        ['application/json with a charset', 'application/json; charset=utf-8'],
        ['an upper-case media type', 'APPLICATION/JSON'],
        ['a mixed-case media type with parameters', 'Application/Json; Charset=UTF-8'],
    ])('accepts %s', async (_name: string, contentType: string) => {
        await withApiServer(async ({baseUrl}): Promise<void> => {
            const response = await postRaw(
                baseUrl,
                {'content-type': contentType, 'idempotency-key': 'limits-key'},
                replyBody('A reply'),
            );

            // The parent is unknown to these dependencies, which proves the request was accepted
            // by the transport and reached the use case rather than being refused as media type.
            expect(response.status).toBe(404);
            expect(envelopeOf(response.body).error.code).toBe('COMMENT_NOT_FOUND');
        });
    });

    it.each([
        ['a missing content type', {}],
        ['text/plain', {'content-type': 'text/plain'}],
        ['a JSON suffix type', {'content-type': 'application/vnd.api+json'}],
        ['form encoding', {'content-type': 'application/x-www-form-urlencoded'}],
    ])('rejects %s with 415', async (_name: string, headers: Readonly<Record<string, string>>) => {
        await withApiServer(async ({baseUrl, requestIds}): Promise<void> => {
            const response = await postRaw(
                baseUrl,
                {...headers, 'idempotency-key': 'limits-key'},
                replyBody('A reply'),
            );
            const envelope = envelopeOf(response.body);

            expect(response.status).toBe(415);
            expect(envelope.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
            expect(envelope.error.message).toBe('Content type must be application/json');
            expect(envelope.error.requestId).toBe('request-1');
            expect(Object.keys(envelope.error).sort()).toEqual(['code', 'message', 'requestId']);
            expect(requestIds.calls).toBe(1);
        });
    });
});

describe('POST /comments body size', () => {
    it('accepts a body of exactly 64 KiB', async () => {
        await withApiServer(async ({baseUrl}): Promise<void> => {
            const body = paddedBody(MAX_REQUEST_BODY_BYTES);

            expect(Buffer.byteLength(body, 'utf8')).toBe(MAX_REQUEST_BODY_BYTES);

            const response = await postRaw(
                baseUrl,
                {
                    'content-type': 'application/json',
                    'idempotency-key': 'limits-key',
                    'content-length': String(MAX_REQUEST_BODY_BYTES),
                },
                body,
            );

            expect(response.status).not.toBe(413);
            expect(response.status).toBe(404);
        });
    });

    it('measures the 64 KiB limit in UTF-8 bytes', async () => {
        await withApiServer(async ({baseUrl, requestIds}): Promise<void> => {
            const body = replyBody('€'.repeat(22_000));

            expect(body.length).toBeLessThan(MAX_REQUEST_BODY_BYTES);
            expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(MAX_REQUEST_BODY_BYTES);

            const response = await postRaw(
                baseUrl,
                {'content-type': 'application/json', 'idempotency-key': 'limits-key'},
                body,
            );
            const envelope = envelopeOf(response.body);

            expect(response.status).toBe(413);
            expect(envelope.error.code).toBe('PAYLOAD_TOO_LARGE');
            expect(requestIds.calls).toBe(1);
        });
    });

    it('rejects a declared length over the limit with 413', async () => {
        await withApiServer(async ({baseUrl, requestIds}): Promise<void> => {
            const body = paddedBody(MAX_REQUEST_BODY_BYTES + 1);
            const response = await postRaw(
                baseUrl,
                {
                    'content-type': 'application/json',
                    'idempotency-key': 'limits-key',
                    'content-length': String(Buffer.byteLength(body, 'utf8')),
                },
                body,
            );
            const envelope = envelopeOf(response.body);

            expect(response.status).toBe(413);
            expect(envelope.error.code).toBe('PAYLOAD_TOO_LARGE');
            expect(envelope.error.message).toBe('Request body is too large');
            expect(envelope.error.requestId).toBe('request-1');
            expect(Object.keys(envelope.error).sort()).toEqual(['code', 'message', 'requestId']);
            expect(requestIds.calls).toBe(1);
        });
    });

    it('rejects an oversized chunked body that declares no length with 413', async () => {
        await withApiServer(async ({baseUrl, requestIds}): Promise<void> => {
            const body = paddedBody(MAX_REQUEST_BODY_BYTES + 1);
            const half = Math.floor(body.length / 2);
            const response = await postChunked(
                baseUrl,
                {'content-type': 'application/json', 'idempotency-key': 'limits-key'},
                [body.slice(0, half), body.slice(half)],
            );
            const envelope = envelopeOf(response.body);

            expect(response.status).toBe(413);
            expect(envelope.error.code).toBe('PAYLOAD_TOO_LARGE');
            expect(envelope.error.message).toBe('Request body is too large');
            expect(requestIds.calls).toBe(1);
        });
    });

    it('accepts a chunked body of exactly 64 KiB', async () => {
        await withApiServer(async ({baseUrl}): Promise<void> => {
            const body = paddedBody(MAX_REQUEST_BODY_BYTES);
            const half = Math.floor(body.length / 2);
            const response = await postChunked(
                baseUrl,
                {'content-type': 'application/json', 'idempotency-key': 'limits-key'},
                [body.slice(0, half), body.slice(half)],
            );

            expect(response.status).not.toBe(413);
            expect(response.status).toBe(404);
        });
    });

    it('answers 415 before it reads an oversized body', async () => {
        await withApiServer(async ({baseUrl}): Promise<void> => {
            const response = await postRaw(
                baseUrl,
                {'content-type': 'text/plain', 'idempotency-key': 'limits-key'},
                paddedBody(MAX_REQUEST_BODY_BYTES + 1),
            );

            expect(response.status).toBe(415);
        });
    });

    it('writes 413 promptly and closes a chunked upload that never finishes', async () => {
        await withApiServer(async ({baseUrl}): Promise<void> => {
            const payload = 'a'.repeat(MAX_REQUEST_BODY_BYTES + 1);
            const raw = await unfinishedRequest(
                baseUrl,
                'POST /comments HTTP/1.1\r\n'
                + 'Host: localhost\r\n'
                + 'Content-Type: application/json\r\n'
                + 'Idempotency-Key: limits-key\r\n'
                + 'Transfer-Encoding: chunked\r\n'
                + 'Connection: keep-alive\r\n\r\n'
                + `${payload.length.toString(16)}\r\n${payload}\r\n`,
            );

            expect(raw).toContain('HTTP/1.1 413 Payload Too Large');
            expect(raw).toMatch(/\r\nconnection: close\r\n/iu);
            expect(raw).toContain('PAYLOAD_TOO_LARGE');
        });
    });

    it('writes 415 promptly and closes an unsupported upload that never finishes', async () => {
        await withApiServer(async ({baseUrl}): Promise<void> => {
            const raw = await unfinishedRequest(
                baseUrl,
                'POST /comments HTTP/1.1\r\n'
                + 'Host: localhost\r\n'
                + 'Content-Type: text/plain\r\n'
                + 'Idempotency-Key: limits-key\r\n'
                + 'Content-Length: 1000000\r\n'
                + 'Connection: keep-alive\r\n\r\npartial',
            );

            expect(raw).toContain('HTTP/1.1 415 Unsupported Media Type');
            expect(raw).toMatch(/\r\nconnection: close\r\n/iu);
            expect(raw).toContain('UNSUPPORTED_MEDIA_TYPE');
        });
    });
});

describe('POST /comments field limits', () => {
    const publish = async (
        baseUrl: string,
        key: string,
        content: string,
    ): Promise<RawResponse> =>
        await postRaw(
            baseUrl,
            {'content-type': 'application/json', 'idempotency-key': key},
            replyBody(content),
        );

    it('accepts an idempotency key of 200 characters', async () => {
        await withApiServer(async ({baseUrl}): Promise<void> => {
            const response = await publish(baseUrl, 'k'.repeat(200), 'A reply');

            expect(response.status).toBe(404);
        });
    });

    it('rejects an idempotency key of 201 characters', async () => {
        await withApiServer(async ({baseUrl, requestIds}): Promise<void> => {
            const response = await publish(baseUrl, 'k'.repeat(201), 'A reply');
            const envelope = envelopeOf(response.body);

            expect(response.status).toBe(400);
            expect(envelope.error.code).toBe('VALIDATION_ERROR');
            expect(envelope.error.message).toBe('Request validation failed');
            expect(requestIds.calls).toBe(1);
        });
    });

    it('measures the idempotency key after trimming', async () => {
        await withApiServer(async ({baseUrl}): Promise<void> => {
            const response = await publish(baseUrl, `  ${'k'.repeat(200)}  `, 'A reply');

            expect(response.status).toBe(404);
        });
    });

    it('accepts content of 10000 characters', async () => {
        await withApiServer(async ({baseUrl}): Promise<void> => {
            const response = await publish(baseUrl, 'limits-key', 'c'.repeat(10_000));

            expect(response.status).toBe(404);
        });
    });

    it('rejects content of 10001 characters', async () => {
        await withApiServer(async ({baseUrl}): Promise<void> => {
            const response = await publish(baseUrl, 'limits-key', 'c'.repeat(10_001));
            const envelope = envelopeOf(response.body);

            expect(response.status).toBe(400);
            expect(envelope.error.code).toBe('VALIDATION_ERROR');
            expect(Object.keys(envelope.error).sort()).toEqual(['code', 'message', 'requestId']);
        });
    });
});

describe('cursor limits', () => {
    it('hands a cursor of 4096 characters to the adapter unchanged', async () => {
        await withApiServer(async ({baseUrl, gateway}): Promise<void> => {
            const cursor = 'c'.repeat(4_096);
            const response = await fetch(
                `${baseUrl}/posts/${POST_UUID}/comments?cursor=${encodeURIComponent(cursor)}`,
            );

            expect(response.status).toBe(200);
            expect(gateway.cursors).toEqual([cursor]);
        });
    });

    it('rejects a cursor of 4097 characters with a validation error', async () => {
        await withApiServer(async ({baseUrl, gateway, requestIds}): Promise<void> => {
            const cursor = 'c'.repeat(4_097);
            const response = await fetch(
                `${baseUrl}/posts/${POST_UUID}/comments?cursor=${encodeURIComponent(cursor)}`,
            );
            const envelope = (await response.json()) as HttpErrorEnvelope;

            expect(response.status).toBe(400);
            expect(envelope.error.code).toBe('VALIDATION_ERROR');
            expect(envelope.error.message).toBe('Request validation failed');
            expect(gateway.cursors).toEqual([]);
            expect(requestIds.calls).toBe(1);
        });
    });

    it('rejects an oversized cursor on the replies route as well', async () => {
        await withApiServer(async ({baseUrl}): Promise<void> => {
            const response = await fetch(
                `${baseUrl}/comments/${PARENT_UUID}/replies?cursor=${'c'.repeat(4_097)}`,
            );

            expect(response.status).toBe(400);
            expect(((await response.json()) as HttpErrorEnvelope).error.code)
                .toBe('VALIDATION_ERROR');
        });
    });
});

describe('transport error bodies', () => {
    it('never echoes the rejected body, key, or cursor', async () => {
        await withApiServer(async ({baseUrl}): Promise<void> => {
            const secretKey = 'super-secret-key-value';
            const secretContent = 'secret-content-marker';
            const oversized = await postRaw(
                baseUrl,
                {'content-type': 'application/json', 'idempotency-key': secretKey},
                JSON.stringify({
                    parentCommentId: PARENT_UUID,
                    content: secretContent,
                    pad: 'a'.repeat(MAX_REQUEST_BODY_BYTES),
                }),
            );
            const unsupported = await postRaw(
                baseUrl,
                {'content-type': 'text/plain', 'idempotency-key': secretKey},
                replyBody(secretContent),
            );
            const cursorResponse = await fetch(
                `${baseUrl}/posts/${POST_UUID}/comments?cursor=${'s3cr3t-cursor'.repeat(400)}`,
            );
            const bodies = [
                oversized.body,
                unsupported.body,
                JSON.stringify(await cursorResponse.json()),
            ];

            for (const body of bodies) {
                for (const secret of [
                    secretKey,
                    secretContent,
                    's3cr3t-cursor',
                    PARENT_UUID,
                    'at Object',
                    'postgres',
                    'select',
                ]) {
                    expect(body).not.toContain(secret);
                }
            }
        });
    });

    it('spends exactly one request identifier per transport error', async () => {
        await withApiServer(async ({baseUrl, requestIds}): Promise<void> => {
            await postRaw(baseUrl, {'idempotency-key': randomUUID()}, replyBody('A reply'));

            expect(requestIds.calls).toBe(1);
        });
    });
});
