/**
 * Consistent copy of the live database (safe while the server runs), e.g. before an upgrade.
 *
 *   dev:        npm run db:snapshot
 *   production: docker compose exec app node dist/cli/snapshot.js
 *
 * Writes <database dir>/snapshots/shipnod-YYYYMMDD-HHMMSS.db using SQLite's VACUUM INTO.
 */
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../config.js';

const config = loadConfig();
const source = resolve(config.databasePath);
const dir = join(dirname(source), 'snapshots');
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const target = join(dir, `shipnod-${stamp}.db`);

const db = new DatabaseSync(source, { readOnly: true });
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
db.close();
console.log(`Snapshot written: ${target} (${(statSync(target).size / 1024).toFixed(0)} KB)`);
