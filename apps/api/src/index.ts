import {createApiComponents} from './composition.js';
import {createApiServer} from './server.js';
import {createGracefulShutdown, SHUTDOWN_GRACE_PERIOD_MS} from './shutdown.js';

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined) {
    throw new Error('DATABASE_URL is required');
}

const components = createApiComponents(databaseUrl);
const server = createApiServer(components.dependencies);

server.listen(Number.parseInt(process.env.API_PORT ?? '3000', 10));

const shutdown = createGracefulShutdown({
    server,
    closeResources: (): Promise<void> => components.close(),
    gracePeriodMs: SHUTDOWN_GRACE_PERIOD_MS,
    writeDiagnostic: (message: string): void => {
        process.stderr.write(message);
    },
    setExitCode: (code: number): void => {
        process.exitCode = code;
    },
});

// The shutdown routine is idempotent, so a second signal joins the run already in progress instead
// of starting a competing one. It never rejects, so nothing is left unobserved here.
const onSignal = (): void => {
    void shutdown();
};

process.on('SIGTERM', onSignal);
process.on('SIGINT', onSignal);
