// Re-hashes the demo keys in D1 lodge-demo with the Worker's own TOKEN_SECRET,
// so the same demo keys as on Fly sign in on the Worker.
// One command, run by Ivo from the lodge-app folder:
//   node scripts/d1-demo-keys.mjs --apply
// The secret comes from the Keychain (service lodge-demo-token-secret); it is
// never typed or printed. Without --apply it only prints the SQL.
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const secret = process.env.TOKEN_SECRET
  || execFileSync('security', ['find-generic-password', '-s', 'lodge-demo-token-secret', '-w']).toString().trim();
if (!secret) { console.error('TOKEN_SECRET not found'); process.exit(1); }

const { generateDemoUserToken } = await import('../src/db.js');
const { DEMO_NAMES } = await import('../src/seedDemo.js');

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const sql = DEMO_NAMES.map((name) => {
  const hash = createHmac('sha256', secret).update(generateDemoUserToken(name)).digest('hex');
  return `UPDATE users SET token_hash = ${q(hash)} WHERE name = ${q(name)} AND is_owner = 0;`;
}).join('\n') + '\n';

if (!process.argv.includes('--apply')) { process.stdout.write(sql); process.exit(0); }

const dir = mkdtempSync(join(tmpdir(), 'd1-demo-keys-'));
const file = join(dir, 'keys.sql');
try {
  writeFileSync(file, sql);
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'lodge-demo', '--remote', '--file', file], { stdio: 'inherit' });
  console.log(`done: ${DEMO_NAMES.length} demo keys re-hashed in lodge-demo`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
