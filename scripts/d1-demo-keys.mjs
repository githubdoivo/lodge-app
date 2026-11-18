// Prints SQL that re-hashes the demo keys in D1 lodge-demo with the Worker's
// own TOKEN_SECRET, so the same demo keys as on Fly sign in on the Worker.
// Usage (the secret comes from the Keychain, never typed or printed):
//   TOKEN_SECRET=$(security find-generic-password -s lodge-demo-token-secret -w) \
//     node scripts/d1-demo-keys.mjs > /tmp/d1-demo-keys.sql
//   npx wrangler d1 execute lodge-demo --remote --file /tmp/d1-demo-keys.sql
import { createHmac } from 'node:crypto';

const secret = process.env.TOKEN_SECRET;
if (!secret) { console.error('TOKEN_SECRET is not set'); process.exit(1); }

const { generateDemoUserToken } = await import('../src/db.js');
const { DEMO_NAMES } = await import('../src/seedDemo.js');

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
for (const name of DEMO_NAMES) {
  const hash = createHmac('sha256', secret).update(generateDemoUserToken(name)).digest('hex');
  console.log(`UPDATE users SET token_hash = ${q(hash)} WHERE name = ${q(name)} AND is_owner = 0;`);
}
