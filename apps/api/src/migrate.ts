import {resolve} from 'node:path';
import postgres from 'postgres';
import {DATABASE_CONNECT_TIMEOUT_SECONDS, requireDatabaseUrl} from './config.js';
import {runMigrations} from './migrations.js';

const DATABASE_APPLICATION_NAME = 'threadbridge-migrations';
const databaseUrl = requireDatabaseUrl(process.env);
const sql = postgres(databaseUrl, {
    connect_timeout: DATABASE_CONNECT_TIMEOUT_SECONDS,
    connection: {application_name: DATABASE_APPLICATION_NAME},
    max: 1,
    onnotice: (): void => undefined,
});

try {
    await runMigrations(sql, resolve(process.cwd(), 'db/migrations'));
} finally {
    await sql.end();
}
