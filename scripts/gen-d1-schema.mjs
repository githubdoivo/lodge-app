// Builds migrations/0001_init.sql from the real schema in src/db.js:
// it runs db.js on an empty in-memory database (all CREATEs and ALTERs
// apply) and writes out what SQLite ended up with.
// Usage: DB_FILE=:memory: node scripts/gen-d1-schema.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import db from '../src/db.js';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations', '0001_init.sql');
const rows = db.prepare(
  "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' " +
  "ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, rowid"
).all();
const sql = rows
  .map((r) => r.sql.replace(/^CREATE (TABLE|UNIQUE INDEX|INDEX) (?!IF NOT EXISTS)/, 'CREATE $1 IF NOT EXISTS ') + ';')
  .join('\n\n');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, '-- Lodge schema for D1, generated from src/db.js (scripts/gen-d1-schema.mjs).\n\n' + sql + '\n');
console.log(rows.length + ' statements');
