import {randomUUID} from 'node:crypto';
import {createServer, type Server, type ServerResponse} from 'node:http';
import {toErrorEnvelope, type HttpErrorEnvelope} from './http-error.js';

export interface ApiServerDependencies {
    readonly requestIdFactory: () => string;
}

const writeJson = (
    response: ServerResponse,
    statusCode: number,
    body: Readonly<Record<string, string>> | HttpErrorEnvelope,
): void => {
    response.writeHead(statusCode, {
        'content-type': 'application/json; charset=utf-8',
    }).end(JSON.stringify(body));
};

export const createApiServer = (
    dependencies: ApiServerDependencies = {requestIdFactory: randomUUID},
): Server =>
    createServer((request, response): void => {
        if (request.method === 'GET' && request.url === '/health') {
            writeJson(response, 200, {status: 'ok'});
            return;
        }

        const requestId = dependencies.requestIdFactory();

        writeJson(
            response,
            404,
            toErrorEnvelope('ROUTE_NOT_FOUND', 'Route was not found', requestId),
        );
    });
