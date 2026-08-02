import {createApiComponents} from './composition.js';
import {createApiServer} from './server.js';

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined) {
    throw new Error('DATABASE_URL is required');
}

const components = createApiComponents(databaseUrl);
const server = createApiServer(components.dependencies);

server.listen(Number.parseInt(process.env.API_PORT ?? '3000', 10));

const shutdown = async (): Promise<void> => {
    await new Promise<void>((resolve): void => {
        server.close((): void => {
            resolve();
        });
    });
    server.closeAllConnections();
    await components.close();
};

process.once('SIGTERM', (): void => {
    void shutdown();
});

process.once('SIGINT', (): void => {
    void shutdown();
});
