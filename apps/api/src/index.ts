import {createApiComponents} from './composition.js';
import {loadApiConfig} from './config.js';
import {migrateDatabase} from './database-migrations.js';
import {createApiServer} from './server.js';
import {createGracefulShutdown, SHUTDOWN_GRACE_PERIOD_MS} from './shutdown.js';

const config = loadApiConfig(process.env);
await migrateDatabase(config.databaseUrl);

const components = createApiComponents(config.databaseUrl);
const server = createApiServer(components.dependencies, {logger: true});

await server.listen(config.port);

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
