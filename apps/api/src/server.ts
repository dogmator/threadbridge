import {createServer, type Server, type ServerResponse} from 'node:http';

const writeJson = (
    response: ServerResponse,
    statusCode: number,
    body: Readonly<Record<string, string>>,
): void => {
    response.writeHead(statusCode, {
        'content-type': 'application/json; charset=utf-8',
    }).end(JSON.stringify(body));
};

export const createApiServer = (): Server =>
    createServer((request, response): void => {
        if (request.method === 'GET' && request.url === '/health') {
            writeJson(response, 200, {status: 'ok'});
            return;
        }

        writeJson(response, 404, {error: 'not_found'});
    });
