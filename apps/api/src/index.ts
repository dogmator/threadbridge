import {createApiComponents} from './composition.js';
import {loadApiConfig} from './config.js';
import {createApiServer} from './server.js';
import {installGracefulShutdown} from './shutdown.js';

const config = loadApiConfig(process.env);
const components = createApiComponents(config.databaseUrl);
const server = createApiServer(components.dependencies);

server.listen(config.port);

installGracefulShutdown(
    server,
    async (): Promise<void> => {
        await components.close();
    },
    {
        setExitCode: (code): void => {
            process.exitCode = code;
        },
        reportFailure: (message): void => {
            process.stderr.write(`${message}\n`);
        },
    },
);
