import {requireDatabaseUrl} from './config.js';
import {migrateDatabase} from './database-migrations.js';

await migrateDatabase(requireDatabaseUrl(process.env));
