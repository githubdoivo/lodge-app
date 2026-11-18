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
let testDb;

function d1(db) {
  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => db.prepare(sql).run(...args),
  });
  return { prepare: (sql) => wrap(sql), batch: async (stmts) => { for (const st of stmts) await st.run(); } };
}

before(() => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON'); // D1 enforces them
  db.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  const u = db.prepare('INSERT INTO users (name, token_hash, token_enc, is_admin) VALUES (?, ?, ?, ?)');
  u.run('Ana', hash('ana-key'), 'x', 0);
  u.run('Rui', hash('rui-key'), 'x', 1);
  db.prepare("INSERT INTO users (name, token_hash, token_enc, is_owner, is_admin) VALUES ('Ivo', ?, 'x', 1, 1)").run(hash('ivo-key'));
  db.prepare('INSERT INTO sessions (token_hash, user_id) VALUES (?, 3)').run(hash('s.abc'));
  testDb = db;
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
  assert.deepEqual(await (await get('/api/users/basic', 'ana-key')).json(), [{ id: 3, name: 'Ivo' }, { id: 2, name: 'Rui' }]);
});
test('writes not ported yet and unknown routes are refused', async () => {
  const post = await worker.fetch(new Request('https://x.test/api/consequences', { method: 'POST' }), env);
  assert.equal(post.status, 405);
  assert.equal((await get('/api/nope', 'ana-key')).status, 404);
});
test('a missing TOKEN_SECRET is a server error, not a login pass', async () => {
  assert.equal((await get('/api/me', 'ana-key', { ...env, TOKEN_SECRET: undefined })).status, 500);
});

const send = (method, path, key, body, e = env) => worker.fetch(new Request('https://x.test' + path, {
  method, headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) },
  body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
}), e);

test('sign-in: right key in any case, wrong or empty key refused, broken body is a 400', async () => {
  const ok = await send('POST', '/api/auth/login', null, { token: '  RUI-KEY ' });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { id: 2, name: 'Rui', isAdmin: true });
  assert.ok(testDb.prepare('SELECT key_claimed_at FROM users WHERE id = 2').get().key_claimed_at);
  assert.equal((await send('POST', '/api/auth/login', null, { token: 'nope' })).status, 401);
  assert.equal((await send('POST', '/api/auth/login', null, { token: 42 })).status, 400);
  assert.equal((await send('POST', '/api/auth/login', null, '{not json')).status, 400);
});
test('off the demo, an admin key alone needs Face ID; a session does not', async () => {
  const prod = { ...env, APP_ENV: undefined };
  const r = await send('POST', '/api/auth/login', null, { token: 'rui-key' }, prod);
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, 'err_passkey_required');
  assert.equal((await get('/api/me', 'rui-key', prod)).status, 401);
  assert.equal((await get('/api/me', 'ana-key', prod)).status, 200);
  assert.equal((await (await get('/api/me', 's.abc', prod)).json()).name, 'Ivo');
});
test('logout ends a Face ID session; twice is harmless', async () => {
  testDb.prepare('INSERT INTO sessions (token_hash, user_id) VALUES (?, 3)').run(hash('s.bye'));
  assert.equal((await send('POST', '/api/auth/logout', 's.bye')).status, 200);
  assert.equal((await get('/api/me', 's.bye')).status, 401);
  assert.equal((await send('POST', '/api/auth/logout', 's.bye')).status, 401);
  assert.equal((await send('POST', '/api/auth/logout', 'ana-key')).status, 200);
});
test('my settings: tutorial seen and language (anything odd becomes pt)', async () => {
  assert.equal((await send('POST', '/api/me/tutorial-seen', 'ana-key')).status, 200);
  await send('POST', '/api/me/lang', 'ana-key', { lang: 'en' });
  let me = await (await get('/api/me', 'ana-key')).json();
  assert.equal(me.tutorial_seen, 1);
  assert.equal(me.lang, 'en');
  await send('POST', '/api/me/lang', 'ana-key', { lang: 'xx' });
  me = await (await get('/api/me', 'ana-key')).json();
  assert.equal(me.lang, 'pt');
  assert.equal((await send('POST', '/api/me/lang', null, { lang: 'en' })).status, 401);
});
test('wall vote: once only, also on a double and triple tap; bad option or not a poll refused', async () => {
  const r = await send('POST', '/api/plaza-posts/2/vote', 'rui-key', { optionId: 2 });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).posts[1].myOptionId, 2);
  const again = await Promise.all([1, 2].map(() => send('POST', '/api/plaza-posts/2/vote', 'rui-key', { optionId: 1 })));
  for (const a of again) assert.equal((await a.json()).error, 'err_already_voted_poll');
  assert.equal((await (await send('POST', '/api/plaza-posts/2/vote', 'ivo-key', { optionId: 99 })).json()).error, 'err_invalid_option');
  assert.equal((await (await send('POST', '/api/plaza-posts/1/vote', 'ivo-key', { optionId: 1 })).json()).error, 'err_not_a_poll');
  assert.equal((await (await send('POST', '/api/plaza-posts/999/vote', 'ivo-key', { optionId: 1 })).json()).error, 'err_post_not_found');
});
test('wall pin and delete: owner only; deleting removes its options and votes', async () => {
  assert.equal((await send('PATCH', '/api/admin/plaza-posts/1/pin', 'rui-key', { pinned: true })).status, 403);
  assert.equal((await send('PATCH', '/api/admin/plaza-posts/1/pin', 'ivo-key', { pinned: true })).status, 200);
  let posts = (await (await get('/api/plaza-posts', 'ana-key')).json()).posts;
  assert.equal(posts[0].text, 'old');
  await send('PATCH', '/api/admin/plaza-posts/1/pin', 'ivo-key', { pinned: false });
  assert.equal((await send('DELETE', '/api/admin/plaza-posts/2', 'ana-key')).status, 403);
  assert.equal((await send('DELETE', '/api/admin/plaza-posts/2', 'ivo-key')).status, 200);
  assert.equal((await send('DELETE', '/api/admin/plaza-posts/2', 'ivo-key')).status, 404);
  posts = (await (await get('/api/plaza-posts', 'ana-key')).json()).posts;
  assert.deepEqual(posts.map((p) => p.text), ['pinned', 'old']);
  assert.equal(testDb.prepare('SELECT COUNT(*) n FROM plaza_poll_votes').get().n, 0);
});
test('new wall post: admins only, same rules as Node, poll options and links saved', async () => {
  assert.equal((await send('POST', '/api/admin/plaza-posts', 'ana-key', { type: 'announcement', text: 'hi' })).status, 403);
  assert.equal((await (await send('POST', '/api/admin/plaza-posts', 'rui-key', { type: 'poll', text: 'q', options: ['a'] })).json()).error, 'err_poll_min_options');
  assert.equal((await (await send('POST', '/api/admin/plaza-posts', 'rui-key', { type: 'announcement', text: '  ' })).json()).error, 'err_post_text_required');
  assert.equal((await (await send('POST', '/api/admin/plaza-posts', 'rui-key', { type: 'links', text: 'l', links: [{ label: 'x', url: 'javascript:alert(1)' }] })).json()).error, 'err_link_invalid_url');
  assert.equal((await send('POST', '/api/admin/plaza-posts', 'rui-key', { type: 'announcement', text: 'p', photoBase64: 'data:x' })).status, 400);
  const poll = await (await send('POST', '/api/admin/plaza-posts', 'rui-key', { type: 'poll', text: ' lunch? ', options: ['soup', ' ', 'fish'] })).json();
  assert.ok(poll.ok);
  const links = await (await send('POST', '/api/admin/plaza-posts', 'ivo-key', { type: 'links', text: 'maps', links: [{ emoji: '📍', label: 'lodge', url: 'maps.example.com' }] })).json();
  const posts = (await (await get('/api/plaza-posts', 'ana-key')).json()).posts;
  const p = posts.find((x) => x.id === poll.id);
  assert.equal(p.text, 'lunch?');
  assert.deepEqual(p.options.map((o) => o.label), ['soup', 'fish']);
  assert.equal(testDb.prepare('SELECT url FROM plaza_link_items WHERE post_id = ?').get(links.id).url, 'https://maps.example.com/');
});
