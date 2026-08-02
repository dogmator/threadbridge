import {once} from 'node:events';
import {describe, expect, it} from 'vitest';
import type {HttpErrorEnvelope} from '../apps/api/src/http-error.js';
import {createApiServer, type ApiServerDependencies} from '../apps/api/src/server.js';

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
    dependencies?: ApiServerDependencies,
): Promise<void> => {
    const server = dependencies === undefined ? createApiServer() : createApiServer(dependencies);

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

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

    it('does not spend a request identifier on a successful health response', async () => {
        const requestIds = new CountingRequestIdFactory('request-1');

        await withApiServer(
            async (baseUrl): Promise<void> => {
                await fetch(`${baseUrl}/health`);
            },
            {requestIdFactory: requestIds.create},
        );

        expect(requestIds.calls).toBe(0);
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
            {requestIdFactory: requestIds.create},
        );
    });

    it('generates one request identifier for one error response', async () => {
        const requestIds = new CountingRequestIdFactory('request-1');

        await withApiServer(
            async (baseUrl): Promise<void> => {
                await fetch(`${baseUrl}/unknown`);
            },
            {requestIdFactory: requestIds.create},
        );

        expect(requestIds.calls).toBe(1);
    });

    it('generates a non-empty request identifier by default', async () => {
        await withApiServer(async (baseUrl): Promise<void> => {
            const response = await fetch(`${baseUrl}/unknown`);
            const body = (await response.json()) as HttpErrorEnvelope;

            expect(body.error.code).toBe('ROUTE_NOT_FOUND');
            expect(body.error.requestId.length).toBeGreaterThan(0);
        });
    });
});
