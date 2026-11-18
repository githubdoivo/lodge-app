// The Worker's read routes, run against a node:sqlite database shaped like D1
// (same migration file). No Cloudflare runtime needed.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import worker from '../src/worker.js';

const SECRET = 'test-secret';
const hash = (t) => createHmac('sha256', SECRET).update(t).digest('hex');
let env;

function d1(db) {
  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
  });
  return { prepare: (sql) => wrap(sql) };
}

before(() => {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  const u = db.prepare('INSERT INTO users (name, token_hash, token_enc, is_admin) VALUES (?, ?, ?, ?)');
  u.run('Ana', hash('ana-key'), 'x', 0);
  u.run('Rui', hash('rui-key'), 'x', 1);
  const p = db.prepare('INSERT INTO plaza_posts (type, author_id, text, pinned_at, created_at) VALUES (?, 2, ?, ?, ?)');
  p.run('announcement', 'old', null, '2026-01-01 10:00:00');
  p.run('poll', 'which?', null, '2026-01-02 10:00:00');
  p.run('announcement', 'pinned', '2026-01-03 10:00:00', '2026-01-01 09:00:00');
  db.prepare('INSERT INTO plaza_poll_options (post_id, label, position) VALUES (2, ?, ?)').run('yes', 0);
  db.prepare('INSERT INTO plaza_poll_options (post_id, label, position) VALUES (2, ?, ?)').run('no', 1);
  db.prepare('INSERT INTO plaza_poll_votes (post_id, option_id, user_id) VALUES (2, 1, 1)').run();
  db.prepare("INSERT INTO consequences (user_id, text, day, status, revealed_at) VALUES (2, 'sing', '2026-01-01', 'used', '2026-01-01 12:00:00')").run();
  db.prepare("INSERT INTO consequences (user_id, text, day, status) VALUES (2, 'dance', '2026-01-02', 'pending')").run();
  env = {
    DB: d1(db), TOKEN_SECRET: SECRET, ENABLE_PLAZA: 'true', APP_ENV: 'demo',
    ASSETS: { fetch: async () => new Response('<html>page</html>') },
  };
});

const get = (path, key, e = env) => worker.fetch(
  new Request('https://x.test' + path, { headers: key ? { authorization: 'Bearer ' + key } : {} }), e);

test('pages go to the assets binding', async () => {
  assert.equal(await (await get('/')).text(), '<html>page</html>');
});
test('version is public', async () => {
  const b = await (await get('/api/version')).json();
  assert.equal(b.runtime, 'worker');
  assert.match(b.version, /^\d+\.\d+\.\d+/);
});
test('guest routes refuse a missing or wrong key', async () => {
  for (const p of ['/api/me', '/api/plaza-posts', '/api/consequences/revealed', '/api/consequences/current', '/api/users/basic']) {
    assert.equal((await get(p)).status, 401, p);
    assert.equal((await get(p, 'nope')).status, 401, p);
  }
});
test('a key typed in capitals still works', async () => {
  assert.equal((await get('/api/me', 'ANA-KEY')).status, 200);
});
test('me returns the guest without token fields', async () => {
  const b = await (await get('/api/me', 'ana-key')).json();
  assert.equal(b.name, 'Ana');
  assert.equal(b.token_hash, undefined);
});
test('wall: pinned first, then newest; poll has tallies and my vote', async () => {
  const { posts } = await (await get('/api/plaza-posts', 'ana-key')).json();
  assert.deepEqual(posts.map((p) => p.text), ['pinned', 'which?', 'old']);
  const poll = posts[1];
  assert.deepEqual(poll.options.map((o) => [o.label, o.votes]), [['yes', 1], ['no', 0]]);
  assert.equal(poll.myOptionId, 1);
  assert.equal((await (await get('/api/plaza-posts', 'rui-key')).json()).posts[1].myOptionId, null);
});
test('wall is hidden when the flag is off', async () => {
  assert.equal((await get('/api/plaza-posts', 'ana-key', { ...env, ENABLE_PLAZA: 'false' })).status, 404);
});
test('rata: only revealed ones, pending counted', async () => {
  const r = await (await get('/api/consequences/revealed', 'ana-key')).json();
  assert.deepEqual(r.consequences.map((c) => c.text), ['sing']);
  const c = await (await get('/api/consequences/current', 'ana-key')).json();
  assert.equal(c.current.text, 'sing');
  assert.equal(c.pending, 1);
});
test('users/basic leaves out the caller', async () => {
  assert.deepEqual(await (await get('/api/users/basic', 'ana-key')).json(), [{ id: 2, name: 'Rui' }]);
});
test('writes and unknown routes are refused', async () => {
  const post = await worker.fetch(new Request('https://x.test/api/plaza-posts', { method: 'POST' }), env);
  assert.equal(post.status, 405);
  assert.equal((await get('/api/nope', 'ana-key')).status, 404);
});
test('a missing TOKEN_SECRET is a server error, not a login pass', async () => {
  assert.equal((await get('/api/me', 'ana-key', { ...env, TOKEN_SECRET: undefined })).status, 500);
});
