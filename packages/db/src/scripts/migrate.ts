import { createDb } from '../client';
import { dbConfigFromEnv, loadRootEnv } from '../env';
import { migrateDb } from '../migrate';

loadRootEnv();
const config = dbConfigFromEnv();
console.log(`Migrating ${config.url.replace('file:', '')}`);
await migrateDb(createDb(config));
console.log('Done.');
