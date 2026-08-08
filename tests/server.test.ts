import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {describe, expect, it} from 'vitest';
import type {HttpErrorEnvelope} from '../apps/api/src/http-error.js';
import {createApiServer, type ApiServerDependencies} from '../apps/api/src/server.js';
import {createGracefulShutdown} from '../apps/api/src/shutdown.js';
import {
    GetCommentReplies,
    GetPostComments,
    ReplyToComment,
    type Comment,
    type CommentReplyContext,
    type CommentReplyContextRepository,
    type CommentRepository,
    type PublishedPostContext,
    type PublishedPostRepository,
    type SocialCommentsGateway,
    type SocialPlatform,
} from '@threadbridge/comments';

const noGateways = new Map<SocialPlatform, SocialCommentsGateway>();

const noPosts: PublishedPostRepository = {
    findContextByPostId: (): Promise<PublishedPostContext | null> => Promise.resolve(null),
};

const noReplyContexts: CommentReplyContextRepository = {
    findByCommentId: (): Promise<CommentReplyContext | null> => Promise.resolve(null),
};

const noComments: CommentRepository = {
    saveMany: (): Promise<readonly Comment[]> => Promise.resolve([]),
    findByIdempotencyKey: (): Promise<Comment | null> => Promise.resolve(null),
    savePublishedReply: (): never => {
        throw new Error('These tests never publish a reply.');
    },
};

const dependenciesWith = (requestIdFactory: () => string): ApiServerDependencies => ({
    requestIdFactory,
    checkReadiness: (): Promise<void> => Promise.resolve(),
    getPostComments: new GetPostComments(noPosts, noGateways, noComments),
    getCommentReplies: new GetCommentReplies(noReplyContexts, noGateways, noComments),
    replyToComment: new ReplyToComment(noReplyContexts, noGateways, noComments),
});

/**
 * Stands in for an adapter failing in a way no client may ever see: the message carries a
 * credential, a connection string, and an internal relation name.
 */
const leakyFailure = (): never => {
    throw new Error(
        'relation "comments" does not exist '
        + '(postgresql://threadbridge:hunter2@db:5432/threadbridge)',
    );
};

const failingPosts: PublishedPostRepository = {findContextByPostId: leakyFailure};

const failingReplyContexts: CommentReplyContextRepository = {findByCommentId: leakyFailure};

const failingDependenciesWith = (requestIdFactory: () => string): ApiServerDependencies => ({
    requestIdFactory,
    checkReadiness: (): Promise<void> => Promise.resolve(),
    getPostComments: new GetPostComments(failingPosts, noGateways, noComments),
    getCommentReplies: new GetCommentReplies(failingReplyContexts, noGateways, noComments),
    replyToComment: new ReplyToComment(failingReplyContexts, noGateways, noComments),
});

const unavailableDependenciesWith = (requestIdFactory: () => string): ApiServerDependencies => ({
    ...dependenciesWith(requestIdFactory),
    checkReadiness: (): Promise<void> => Promise.reject(
        new Error('postgresql://threadbridge:hunter2@db:5432/threadbridge is unavailable'),
    ),
});

class CountingRequestIdFactory {
    public calls = 0;

    public constructor(private readonly requestId: string) {}

    public readonly create = (): string => {
        this.calls += 1;

        return this.requestId;
    };
}

const withApiServer = async (
    use: (baseUrl: string) => Promise<void>,
    requestIdFactory: () => string = randomUUID,
    dependenciesFor: (factory: () => string) => ApiServerDependencies = dependenciesWith,
): Promise<void> => {
    const server = createApiServer(dependenciesFor(requestIdFactory));

    await server.listen(0, '127.0.0.1');

    try {
        const address = server.address();

        if (address === null || typeof address === 'string') {
            throw new Error('The API server is not listening on a TCP port.');
        }

        await use(`http://127.0.0.1:${String(address.port)}`);
    } finally {
        server.close();
        server.closeAllConnections();
        await once(server, 'close');
    }
};

describe('API server', () => {
    it('rejects startup when the requested address is already in use', async () => {
        const owner = createApiServer(dependenciesWith(randomUUID));

        await owner.listen(0, '127.0.0.1');

        try {
            const address = owner.address();

            if (address === null || typeof address === 'string') {
                throw new Error('The owner server is not listening on a TCP port.');
            }

            const contender = createApiServer(dependenciesWith(randomUUID));

            await expect(contender.listen(address.port, '127.0.0.1'))
                .rejects.toMatchObject({code: 'EADDRINUSE'});
            expect(contender.address()).toBeNull();
        } finally {
            owner.close();
            await once(owner, 'close');
        }
    });

    it('does not reopen the listener after shutdown begins following awaited startup', async () => {
        const server = createApiServer(dependenciesWith(randomUUID));
        const exitCodes: number[] = [];
        let resourceClosures = 0;

        await server.listen(0, '127.0.0.1');
        const shutdown = createGracefulShutdown({
            server,
            closeResources: (): Promise<void> => {
                resourceClosures += 1;
                return Promise.resolve();
            },
            gracePeriodMs: 500,
            writeDiagnostic: (): void => undefined,
            setExitCode: (code): void => {
                exitCodes.push(code);
            },
        });

        await shutdown();
        await nextTurn();

        expect(server.address()).toBeNull();
        expect(resourceClosures).toBe(1);
        expect(exitCodes).toEqual([0]);
    });

    it('answers GET /health with status 200', async () => {
        await withApiServer(async (baseUrl): Promise<void> => {
            const response = await fetch(`${baseUrl}/health`);

            expect(response.status).toBe(200);
        });
    });

    it('answers GET /health with a JSON content type', async () => {
        await withApiServer(async (baseUrl): Promise<void> => {
            const response = await fetch(`${baseUrl}/health`);

            expect(response.headers.get('content-type'))
                .toBe('application/json; charset=utf-8');
        });
    });

    it('answers GET /health with an ok status body', async () => {
        await withApiServer(async (baseUrl): Promise<void> => {
            const response = await fetch(`${baseUrl}/health`);

            expect(await response.json()).toEqual({status: 'ok'});
        });
    });

    it('keeps liveness independent from PostgreSQL readiness', async () => {
        await withApiServer(
            async (baseUrl): Promise<void> => {
                const response = await fetch(`${baseUrl}/health`);

                expect(response.status).toBe(200);
                expect(await response.json()).toEqual({status: 'ok'});
            },
            randomUUID,
            unavailableDependenciesWith,
        );
    });

    it('answers GET /ready with status 200 when PostgreSQL is reachable', async () => {
        await withApiServer(async (baseUrl): Promise<void> => {
            const response = await fetch(`${baseUrl}/ready`);

            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({status: 'ready'});
        });
    });

    it('answers GET /ready with a safe 503 when PostgreSQL is unavailable', async () => {
        const requestIds = new CountingRequestIdFactory('request-1');

        await withApiServer(
            async (baseUrl): Promise<void> => {
                const response = await fetch(`${baseUrl}/ready`);
                const raw = await response.text();

                expect(response.status).toBe(503);
                expect(response.headers.get('content-type'))
                    .toBe('application/json; charset=utf-8');
                expect(JSON.parse(raw) as unknown).toEqual({status: 'unavailable'});
                expect(raw).not.toContain('hunter2');
                expect(raw).not.toContain('postgresql://');
            },
            requestIds.create,
            unavailableDependenciesWith,
        );

        expect(requestIds.calls).toBe(1);
    });

    it('generates exactly one request identifier for a successful health request', async () => {
        const requestIds = new CountingRequestIdFactory('request-1');

        await withApiServer(
            async (baseUrl): Promise<void> => {
                await fetch(`${baseUrl}/health`);
            },
            requestIds.create,
        );

        expect(requestIds.calls).toBe(1);
    });

    it('answers an unknown route with status 404', async () => {
        await withApiServer(async (baseUrl): Promise<void> => {
            const response = await fetch(`${baseUrl}/unknown`);

            expect(response.status).toBe(404);
        });
    });

    it('answers an unknown route with a JSON content type', async () => {
        await withApiServer(async (baseUrl): Promise<void> => {
            const response = await fetch(`${baseUrl}/unknown`);

            expect(response.headers.get('content-type'))
                .toBe('application/json; charset=utf-8');
        });
    });

    it('answers an unknown route with the uniform error envelope', async () => {
        const requestIds = new CountingRequestIdFactory('request-1');

        await withApiServer(
            async (baseUrl): Promise<void> => {
                const response = await fetch(`${baseUrl}/unknown`);

                expect(await response.json()).toEqual({
                    error: {
                        code: 'ROUTE_NOT_FOUND',
                        message: 'Route was not found',
                        requestId: 'request-1',
                    },
                });
            },
            requestIds.create,
        );
    });

    it('does not trust a client-supplied request identifier', async () => {
        const requestIds = new CountingRequestIdFactory('request-1');

        await withApiServer(
            async (baseUrl): Promise<void> => {
                const response = await fetch(`${baseUrl}/unknown`, {
                    headers: {'x-request-id': 'client-controlled'},
                });
                const body = (await response.json()) as HttpErrorEnvelope;

                expect(body.error.requestId).toBe('request-1');
                expect(body.error.requestId).not.toBe('client-controlled');
            },
            requestIds.create,
        );

        expect(requestIds.calls).toBe(1);
    });

    it('generates one request identifier for one error response', async () => {
        const requestIds = new CountingRequestIdFactory('request-1');

        await withApiServer(
            async (baseUrl): Promise<void> => {
                await fetch(`${baseUrl}/unknown`);
            },
            requestIds.create,
        );

        expect(requestIds.calls).toBe(1);
    });

    it('generates a non-empty request identifier with the production factory', async () => {
        await withApiServer(async (baseUrl): Promise<void> => {
            const response = await fetch(`${baseUrl}/unknown`);
            const body = (await response.json()) as HttpErrorEnvelope;

            expect(body.error.code).toBe('ROUTE_NOT_FOUND');
            expect(body.error.requestId.length).toBeGreaterThan(0);
        });
    });
});

interface FailingRoute {
    readonly name: string;
    readonly path: string;
    readonly init: RequestInit;
}

const failingRoutes: readonly FailingRoute[] = [
    {
        name: 'root comment retrieval',
        path: '/posts/0198f000-0000-7000-8000-0000000000aa/comments',
        init: {},
    },
    {
        name: 'direct reply retrieval',
        path: '/comments/0198f000-0000-7000-8000-0000000000ab/replies',
        init: {},
    },
    {
        name: 'reply publication',
        path: '/comments',
        init: {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'idempotency-key': 'server-secret-key',
            },
            body: JSON.stringify({
                parentCommentId: '0198f000-0000-7000-8000-0000000000ac',
                content: 'A reply',
            }),
        },
    },
];

/** Anything that must never appear in a response, whatever the adapter reported internally. */
const forbiddenFragments = [
    'hunter2',
    'postgresql://',
    'relation',
    'does not exist',
    'server-secret-key',
    '0198f000',
    'at Object',
];

describe('unexpected failures', () => {
    it.each(failingRoutes)(
        'answers an unexpected failure of $name with the internal error envelope',
        async (route: FailingRoute): Promise<void> => {
            const requestIds = new CountingRequestIdFactory('request-1');

            await withApiServer(
                async (baseUrl): Promise<void> => {
                    const response = await fetch(`${baseUrl}${route.path}`, route.init);
                    const raw = await response.text();

                    expect(response.status).toBe(500);
                    expect(response.headers.get('content-type'))
                        .toBe('application/json; charset=utf-8');
                    expect(JSON.parse(raw) as unknown).toEqual({
                        error: {
                            code: 'INTERNAL_ERROR',
                            message: 'Internal error',
                            requestId: 'request-1',
                        },
                    });

                    for (const fragment of forbiddenFragments) {
                        expect(raw).not.toContain(fragment);
                    }
                },
                requestIds.create,
                failingDependenciesWith,
            );

            expect(requestIds.calls).toBe(1);
        },
    );
});
