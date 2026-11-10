import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import config from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Load all numbered SQL migrations in application order.
 */
export function getMigrationSQL() {
  const migrationDir = path.join(__dirname, 'migrations');
  const migrationFiles = fs.readdirSync(migrationDir)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort();

  if (migrationFiles.length === 0) {
    throw new Error(`No SQL migrations found in ${migrationDir}`);
  }

  return migrationFiles
    .map((name) => fs.readFileSync(path.join(migrationDir, name), 'utf-8'))
    .join('\n\n');
}

export function getInitialSchemaSQL() {
  return getMigrationSQL();
}

export async function runMigrations() {
  console.log('--- Database Migration Runner ---');
  const sql = getMigrationSQL();
  console.log(`Loaded migration SQL (bytes: ${sql.length})`);

  if (!config.supabase.databaseUrl && !config.supabase.url) {
    console.warn('Notice: DATABASE_URL / SUPABASE_URL not configured. Copy server/.env.example to .env with valid credentials.');
    return { success: false, reason: 'Credentials not configured' };
  }

  console.log('Migration scripts ready for execution in Supabase SQL editor or direct Postgres connection.');
  return { success: true, sqlLength: sql.length };
}

// Execute directly if run as main
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMigrations().then(() => process.exit(0)).catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}

export default runMigrations;
