// Demo sample buttons and the admin votes log on the Worker (APP-LG-029).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import worker from '../src/worker.js';
import { MOCK_NAMES } from '../src/demoUsers.js';

const SECRET = 'test-secret';
const hash = (t) => createHmac('sha256', SECRET).update(t).digest('hex');
let env; let db; const files = new Map();
function d1(raw) {
  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    first: async () => raw.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: raw.prepare(sql).all(...args) }),
    run: async () => { const r = raw.prepare(sql).run(...args); return { ...r, meta: { changes: Number(r.changes) } }; },
  });
  return { prepare: (sql) => wrap(sql), batch: async (stmts) => { for (const st of stmts) await st.run(); } };
}
const mkEnv = (appEnv) => ({ DB: d1(db), TOKEN_SECRET: SECRET, APP_ENV: appEnv, ENABLE_MEMO: 'true',
  FILES: { put: async (k, v) => files.set(k, v), get: async () => null, delete: async () => {} },
  ASSETS: { fetch: async () => new Response(new Uint8Array([1, 2, 3])) } });
before(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  const u = db.prepare('INSERT INTO users (name, token_hash, token_enc, is_admin, is_owner) VALUES (?, ?, ?, ?, ?)');
  u.run('Ivo', hash('ivo'), 'x', 1, 1); u.run('Rui', hash('rui'), 'x', 1, 0);
  for (const n of MOCK_NAMES) u.run(n, hash(n.toLowerCase()), 'x', 0, 0);
  u.run('Ana', hash('ana'), 'x', 0, 0);
  db.prepare('INSERT INTO sessions (token_hash, user_id) VALUES (?, 1)').run(hash('s.owner'));
  env = mkEnv('demo');
});
const call = (method, path, key, e = env) => worker.fetch(new Request('https://x.test' + path, {
  method, headers: { authorization: 'Bearer ' + key } }), e);
const count = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;

test('seed buttons are owner only', async () => {
  for (const p of ['chat', 'consequences', 'contestants', 'memo', 'plaza-posts']) {
    assert.equal((await call('POST', `/api/admin/${p}/seed-demo`, 'rui')).status, 403);
    assert.equal((await call('POST', `/api/admin/${p}/seed-demo`, 'ana')).status, 403);
  }
});
test('seed buttons add sample content on the demo', async () => {
  for (const p of ['chat', 'consequences', 'contestants', 'memo', 'plaza-posts']) {
    const r = await call('POST', `/api/admin/${p}/seed-demo`, 'ivo');
    assert.equal(r.status, 200, p);
  }
  assert.ok(count('messages') >= 4); assert.ok(count('consequences') >= 5);
  assert.ok(count('contestants') >= 10); assert.ok(count('plaza_posts') >= 3); assert.ok(count('memo_uploads') >= 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE pseudonym IS NULL OR pseudonym = ''").get().n, 0);
});
test('pressing chat or memo seed twice does not double up', async () => {
  const m = count('messages'); const u = count('memo_uploads');
  await call('POST', '/api/admin/chat/seed-demo', 'ivo'); await call('POST', '/api/admin/memo/seed-demo', 'ivo');
  assert.equal(count('messages'), m); assert.equal(count('memo_uploads'), u);
});
test('seed buttons are closed outside the demo', async () => {
  const r = await call('POST', '/api/admin/chat/seed-demo', 's.owner', mkEnv('prod'));
  assert.equal(r.status, 403);
});
test('admin votes: owner sees the log, admin only the tally, guest nothing', async () => {
  const o = await (await call('GET', '/api/admin/votes?night=furnished', 'ivo')).json();
  assert.ok(Array.isArray(o.votes) && Array.isArray(o.congenialityVotes) && Array.isArray(o.results));
  const a = await (await call('GET', '/api/admin/votes?night=furnished', 'rui')).json();
  assert.ok(a.results && !('votes' in a));
  assert.equal((await call('GET', '/api/admin/votes', 'ana')).status, 403);
});
