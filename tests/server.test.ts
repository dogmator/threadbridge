import {once} from 'node:events';
import {describe, expect, it} from 'vitest';
import {createApiServer} from '../apps/api/src/server.js';

const withApiServer = async (
    use: (baseUrl: string) => Promise<void>,
): Promise<void> => {
    const server = createApiServer();

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

    it('answers an unknown route with status 404', async () => {
        await withApiServer(async (baseUrl): Promise<void> => {
            const response = await fetch(`${baseUrl}/unknown`);

            expect(response.status).toBe(404);
        });
    });

    it('answers an unknown route with a not_found body', async () => {
        await withApiServer(async (baseUrl): Promise<void> => {
            const response = await fetch(`${baseUrl}/unknown`);

            expect(await response.json()).toEqual({error: 'not_found'});
        });
    });
});
