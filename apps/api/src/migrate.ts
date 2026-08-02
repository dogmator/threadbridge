import {resolve} from 'node:path';
import postgres from 'postgres';
import {runMigrations} from './migrations.js';

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined) {
    throw new Error('DATABASE_URL is required');
}

const sql = postgres(databaseUrl, {max: 1});

try {
    await runMigrations(sql, resolve(process.cwd(), 'db/migrations'));
} finally {
    await sql.end();
}
