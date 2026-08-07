const DEFAULT_API_PORT = 3_000;
const MINIMUM_TCP_PORT = 1;
const MAXIMUM_TCP_PORT = 65_535;
const DECIMAL_INTEGER_PATTERN = /^[1-9]\d*$/u;
const INVALID_API_PORT_MESSAGE = 'API_PORT must be an integer between 1 and 65535.';

export interface ApiConfig {
    readonly databaseUrl: string;
    readonly port: number;
}

export const requireDatabaseUrl = (env: Readonly<NodeJS.ProcessEnv>): string => {
    const databaseUrl = env.DATABASE_URL;

    if (databaseUrl === undefined || databaseUrl.trim() === '') {
        throw new Error('DATABASE_URL is required.');
    }

    return databaseUrl;
};

export const parseApiPort = (raw: string | undefined): number => {
    if (raw === undefined) {
        return DEFAULT_API_PORT;
    }

    if (!DECIMAL_INTEGER_PATTERN.test(raw)) {
        throw new Error(INVALID_API_PORT_MESSAGE);
    }

    const port = Number(raw);

    if (!Number.isSafeInteger(port) || port < MINIMUM_TCP_PORT || port > MAXIMUM_TCP_PORT) {
        throw new Error(INVALID_API_PORT_MESSAGE);
    }

    return port;
};

export const loadApiConfig = (env: Readonly<NodeJS.ProcessEnv>): ApiConfig => ({
    databaseUrl: requireDatabaseUrl(env),
    port: parseApiPort(env.API_PORT),
});
