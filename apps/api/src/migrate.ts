import {resolve} from 'node:path';
import postgres from 'postgres';
import {requireDatabaseUrl} from './config.js';
import {runMigrations} from './migrations.js';

const databaseUrl = requireDatabaseUrl(process.env);
const sql = postgres(databaseUrl, {max: 1});

try {
    await runMigrations(sql, resolve(process.cwd(), 'db/migrations'));
} finally {
    await sql.end();
}
