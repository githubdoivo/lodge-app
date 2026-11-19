// The Worker's read routes, run against a node:sqlite database shaped like D1
// (same migration file). No Cloudflare runtime needed.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHmac, createHash, createDecipheriv, createCipheriv } from 'node:crypto';
import worker, { resetDemoSeedFlag } from '../src/worker.js';
import { generateDemoUserToken, MOCK_NAMES } from '../src/demoUsers.js';

const SECRET = 'test-secret';
const hash = (t) => createHmac('sha256', SECRET).update(t).digest('hex');
let env;
let testDb;

function d1(db) {
  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { ...r, meta: { changes: Number(r.changes) } }; },
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
  const post = await worker.fetch(new Request('https://x.test/api/chat', { method: 'POST' }), env);
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

test('wall edit: admins only, text and poll options (votes kept on rename), links replaced, photo refused', async () => {
  const poll = (await (await send('POST', '/api/admin/plaza-posts', 'rui-key', { type: 'poll', text: 'q?', options: ['a', 'b', 'c'] })).json()).id;
  const opt = testDb.prepare('SELECT id FROM plaza_poll_options WHERE post_id = ? AND position = 0').get(poll).id;
  testDb.prepare('INSERT INTO plaza_poll_votes (post_id, option_id, user_id) VALUES (?, ?, 1)').run(poll, opt);
  assert.equal((await send('PATCH', `/api/admin/plaza-posts/${poll}`, 'ana-key', { text: 'x' })).status, 403);
  assert.equal((await send('PATCH', '/api/admin/plaza-posts/9999', 'rui-key', { text: 'x' })).status, 404);
  assert.equal((await (await send('PATCH', `/api/admin/plaza-posts/${poll}`, 'rui-key', { text: ' ', options: ['a', 'b'] })).json()).error, 'err_post_text_required');
  assert.equal((await send('PATCH', `/api/admin/plaza-posts/${poll}`, 'rui-key', { text: 'q', options: ['a', 'b'], photoBase64: 'data:x' })).status, 400);
  assert.equal((await send('PATCH', `/api/admin/plaza-posts/${poll}`, 'rui-key', { text: 'new q', options: ['A!', 'b'] })).status, 200);
  assert.deepEqual(testDb.prepare('SELECT label FROM plaza_poll_options WHERE post_id = ? ORDER BY position').all(poll).map((o) => o.label), ['A!', 'b']);
  assert.equal(testDb.prepare('SELECT COUNT(*) n FROM plaza_poll_votes WHERE option_id = ?').get(opt).n, 1);
  const l = (await (await send('POST', '/api/admin/plaza-posts', 'rui-key', { type: 'links', text: 'l', links: [{ label: 'a', url: 'a.example.com' }] })).json()).id;
  await send('PATCH', `/api/admin/plaza-posts/${l}`, 'rui-key', { text: 'l2', links: [{ label: 'b', url: 'b.example.com' }, { label: 'c', url: 'c.example.com' }] });
  assert.equal(testDb.prepare('SELECT COUNT(*) n FROM plaza_link_items WHERE post_id = ?').get(l).n, 2);
});
test('rata: one suggestion a day, empty and long ones refused, a double tap makes one', async () => {
  assert.equal((await send('POST', '/api/consequences', 'ana-key', { text: '  ' })).status, 400);
  assert.equal((await (await send('POST', '/api/consequences', 'ana-key', { text: 'x'.repeat(201) })).json()).error, 'err_max_200_chars');
  const two = await Promise.all([1, 2].map(() => send('POST', '/api/consequences', 'ana-key', { text: 'juggle' })));
  assert.deepEqual(two.map((r) => r.status).sort(), [201, 409]);
  assert.equal(testDb.prepare("SELECT COUNT(*) n FROM consequences WHERE text = 'juggle'").get().n, 1);
});
test('rata: reveal, assign, mark done and approve follow the same order and roles as Node', async () => {
  assert.equal((await send('POST', '/api/admin/consequences/reveal', 'ana-key')).status, 403);
  const revealed = await (await send('POST', '/api/admin/consequences/reveal', 'rui-key')).json();
  assert.ok(revealed.ok);
  const id = revealed.revealed.id;
  assert.equal((await send('POST', '/api/admin/consequences/reveal', 'rui-key').then((r) => r.json())).revealed?.id === id, false);
  assert.equal((await send('PATCH', `/api/admin/consequences/${id}/assign`, 'ana-key', { userId: 1 })).status, 403);
  assert.equal((await send('PATCH', `/api/admin/consequences/${id}/assign`, 'rui-key', { userId: 99 })).status, 404);
  assert.equal((await send('PATCH', '/api/admin/consequences/9999/assign', 'rui-key', { userId: 1 })).status, 404);
  const a = await (await send('PATCH', `/api/admin/consequences/${id}/assign`, 'rui-key', { userId: 1 })).json();
  assert.equal(a.consequence.assignedName, 'Ana');
  assert.equal((await send('POST', `/api/consequences/${id}/mark-done`, 'rui-key')).status, 400);
  assert.equal((await (await send('PATCH', `/api/admin/consequences/${id}/approve`, 'ivo-key')).json()).error, 'err_consequence_not_done_yet');
  assert.equal((await send('POST', `/api/consequences/${id}/mark-done`, 'ana-key')).status, 200);
  assert.equal((await (await send('POST', `/api/consequences/${id}/mark-done`, 'ana-key')).json()).error, 'err_consequence_already_done');
  assert.equal((await send('PATCH', `/api/admin/consequences/${id}/approve`, 'rui-key')).status, 403);
  assert.equal((await send('PATCH', `/api/admin/consequences/${id}/approve`, 'ivo-key')).status, 200);
  assert.equal((await (await send('PATCH', `/api/admin/consequences/${id}/approve`, 'ivo-key')).json()).error, 'err_consequence_already_approved');
  const un = await (await send('PATCH', `/api/admin/consequences/${id}/assign`, 'rui-key', { userId: null })).json();
  assert.equal(un.consequence.assigned_user_id, null);
});
test('rata: reveal with nothing pending is a 404', async () => {
  testDb.prepare("UPDATE consequences SET status = 'used' WHERE status = 'pending'").run();
  assert.equal((await send('POST', '/api/admin/consequences/reveal', 'rui-key')).status, 404);
});
const JPEG = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
const setStatus = (night, v) => testDb.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`voting_status_${night}`, v);
const errOf = async (r) => (await r.json()).error;
const post = (path, key, body) => send('POST', path, key, body);
test('snatch: registration needs it open, a name, a good photo; one entry each', async () => {
  const body = { night: 'furnished', name: 'lamp', photoBase64: JPEG };
  assert.equal(await errOf(await post('/api/outfit/register', 'ana-key', body)), 'err_registration_not_open');
  setStatus('furnished', 'registration');
  assert.equal(await errOf(await post('/api/outfit/register', 'ana-key', { ...body, name: ' ' })), 'err_persona_name_required');
  assert.equal(await errOf(await post('/api/outfit/register', 'ana-key', { ...body, name: 'x'.repeat(61) })), 'err_max_60_chars');
  assert.equal(await errOf(await post('/api/outfit/register', 'ana-key', { ...body, photoBase64: null })), 'err_photo_required');
  assert.equal(await errOf(await post('/api/outfit/register', 'ana-key', { ...body, photoBase64: 'data:image/jpeg;base64,AAAA' })), 'err_photo_invalid');
  assert.equal(await errOf(await post('/api/outfit/register', 'ana-key', { ...body, partnerUserId: 1 })), 'err_cannot_partner_with_self');
  assert.equal((await post('/api/outfit/register', 'ana-key', body)).status, 201);
  assert.equal(await errOf(await post('/api/outfit/register', 'ana-key', body)), 'err_you_already_registered');
  assert.equal(testDb.prepare('SELECT COUNT(*) n FROM contestants WHERE user_id = 1').get().n, 1);
});
test('snatch: duo entry waits for the partner, who can confirm; the registrant cannot', async () => {
  const r = await (await post('/api/outfit/register', 'rui-key', { night: 'furnished', name: 'duo', photoBase64: JPEG, partnerUserId: 3 })).json();
  assert.equal(r.pending, true);
  assert.equal(await errOf(await post('/api/outfit/register', 'ivo-key', { night: 'furnished', name: 'z', photoBase64: JPEG })), 'err_you_already_registered');
  assert.equal(await errOf(await post('/api/outfit/register/confirm', 'rui-key', { night: 'furnished' })), 'err_partner_must_confirm_entry');
  assert.equal((await post('/api/outfit/register/confirm', 'ivo-key', { night: 'furnished' })).status, 200);
  assert.equal(await errOf(await send('DELETE', '/api/outfit/register/pending', 'ivo-key', { night: 'furnished' })), 'err_you_already_registered');
});
test('snatch: cancelling a pending duo frees both', async () => {
  setStatus('swamp', 'registration');
  await post('/api/outfit/register', 'rui-key', { night: 'swamp', name: 'duo2', photoBase64: JPEG, partnerUserId: 3 });
  assert.equal((await send('DELETE', '/api/outfit/register/pending', 'ivo-key', { night: 'swamp' })).status, 200);
  assert.equal(await errOf(await send('DELETE', '/api/outfit/register/pending', 'ivo-key', { night: 'swamp' })), 'err_no_pending_entry');
});
test('snatch: votes follow the night status, own entry, one vote, duo confirm', async () => {
  const ana = testDb.prepare("SELECT id FROM contestants WHERE user_id = 1 AND night = 'furnished'").get().id;
  const duo = testDb.prepare("SELECT id FROM contestants WHERE user_id = 2 AND night = 'furnished'").get().id;
  const vote = (key, contestantId) => post('/api/votes', key, { contestantId, night: 'furnished' });
  assert.equal(await errOf(await vote('rui-key', ana)), 'err_voting_not_open');
  setStatus('furnished', 'open');
  assert.equal(await errOf(await vote('rui-key', 9999)), 'err_contestant_invalid_for_night');
  assert.equal(await errOf(await vote('ana-key', ana)), 'err_cannot_vote_self');
  assert.equal(await errOf(await post('/api/votes', 'rui-key', { night: 'furnished' })), 'err_choose_contestant');
  assert.equal(await errOf(await vote('ivo-key', duo)), 'err_cannot_vote_self');
  assert.equal((await (await vote('ana-key', duo)).json()).pending, false);
  assert.equal(await errOf(await vote('ana-key', duo)), 'err_already_voted');
});
test('snatch: a duo shares one vote that the other half must confirm', async () => {
  const ana = testDb.prepare("SELECT id FROM contestants WHERE user_id = 1 AND night = 'furnished'").get().id;
  const vote = (key) => post('/api/votes', key, { contestantId: ana, night: 'furnished' });
  assert.equal((await (await vote('rui-key')).json()).pending, true);
  assert.equal(await errOf(await vote('ivo-key')), 'err_duo_already_voted');
  assert.equal(await errOf(await post('/api/votes/confirm', 'rui-key', { night: 'furnished' })), 'err_partner_must_confirm');
  assert.equal((await post('/api/votes/confirm', 'ivo-key', { night: 'furnished' })).status, 200);
  assert.equal(await errOf(await send('DELETE', '/api/votes/pending', 'ivo-key', { night: 'furnished' })), 'err_already_voted');
  assert.equal(testDb.prepare("SELECT COUNT(*) n FROM votes WHERE confirmed_at IS NOT NULL").get().n, 2);
  setStatus('furnished', 'closed');
  assert.equal(await errOf(await post('/api/votes/confirm', 'ivo-key', { night: 'furnished' })), 'err_voting_not_open');
});
test('plaza chat: lowercase, empty and long refused, stable pseudonym, only the last 15 kept', async () => {
  assert.equal(await errOf(await post('/api/chat/messages', 'ana-key', { text: '   ' })), 'err_empty_message');
  assert.equal(await errOf(await post('/api/chat/messages', 'ana-key', { text: 'x'.repeat(301) })), 'err_message_too_long');
  assert.equal((await post('/api/chat/messages', 'ana-key', { text: 'Hello   THERE' })).status, 201);
  assert.equal(testDb.prepare('SELECT text FROM messages').get().text, 'hello there');
  for (let i = 0; i < 17; i++) await post('/api/chat/messages', 'ana-key', { text: `m${i}` });
  assert.equal(testDb.prepare('SELECT COUNT(*) n FROM messages').get().n, 15);
  assert.equal(testDb.prepare('SELECT COUNT(DISTINCT pseudonym) n FROM messages').get().n, 1);
  assert.equal(testDb.prepare('SELECT COUNT(*) n FROM wall_pseudonym_history WHERE user_id = 1').get().n, 1);
});

// APP-LG-012: an empty demo D1 seeds its own people, so the demo keys sign in.
function emptyEnv(appEnv = 'demo') {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  resetDemoSeedFlag();
  return { db, env: { ...env, DB: d1(db), APP_ENV: appEnv } };
}
const login = (e, token) => worker.fetch(new Request('https://x.test/api/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) }), e);
test('demo: an empty D1 seeds the demo people and both login-screen keys sign in', async () => {
  const { db, env: e } = emptyEnv();
  const { keys } = await (await get('/api/demo', null, e)).json();
  assert.deepEqual(keys.map((k) => k.role), ['guest', 'admin']);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, MOCK_NAMES.length);
  const guest = await (await login(e, keys[0].key.toUpperCase())).json();
  assert.deepEqual([guest.name, guest.isAdmin], ['Alice Moreira', false]);
  const admin = await (await login(e, keys[1].key)).json();
  assert.deepEqual([admin.name, admin.isAdmin], ['Elisa Carvalho', true]);
  assert.equal((await login(e, 'alicemoreira0000')).status, 401);
});
test('demo: the stored key decrypts the same way the Node app does', async () => {
  const { db, env: e } = emptyEnv();
  await get('/api/demo', null, e);
  const enc = db.prepare("SELECT token_enc FROM users WHERE name = 'Carla Mendes'").get().token_enc;
  const [iv, tag, ct] = enc.split(':').map((x) => Buffer.from(x, 'base64'));
  const d = createDecipheriv('aes-256-gcm', createHash('sha256').update(SECRET).digest(), iv);
  d.setAuthTag(tag);
  assert.equal(Buffer.concat([d.update(ct), d.final()]).toString(), generateDemoUserToken('Carla Mendes'));
});
test('demo: seeding never doubles up, even after a restart or many requests at once', async () => {
  const { db, env: e } = emptyEnv();
  await Promise.all([1, 2, 3].map(() => get('/api/demo', null, e)));
  resetDemoSeedFlag();
  await get('/api/demo', null, e);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, MOCK_NAMES.length);
});
test('off the demo: nothing is seeded and no keys are offered', async () => {
  const { db, env: e } = emptyEnv('production');
  assert.deepEqual((await (await get('/api/demo', null, e)).json()).keys, []);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 0);
});

// ---- Manage Users, settings, dedications (APP-LG-015) ----
const del = (path, key) => send('DELETE', path, key);
const decode = (enc) => {
  const [iv, tag, ct] = enc.split(':').map((x) => Buffer.from(x, 'base64'));
  const d = createDecipheriv('aes-256-gcm', createHash('sha256').update(SECRET).digest(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString();
};
test('users: guests are refused, a plain admin sees only their own row, the owner sees all', async () => {
  assert.equal((await get('/api/admin/users', 'ana-key')).status, 403);
  assert.deepEqual((await (await get('/api/admin/users', 'rui-key')).json()).map((u) => u.name), ['Rui']);
  assert.ok((await (await get('/api/admin/users', 's.abc')).json()).length >= 3);
});
test('users: only the owner adds, renames, regenerates and removes; blanks refused', async () => {
  assert.equal((await post('/api/admin/users', 'rui-key', { name: 'X' })).status, 403);
  assert.equal((await post('/api/admin/users', 's.abc', { name: '  ' })).status, 400);
  const made = await (await post('/api/admin/users', 's.abc', { name: 'Zé Novo' })).json();
  assert.match(made.token, /^zenovo\d{6}$/);
  const row = testDb.prepare('SELECT token_hash, token_enc FROM users WHERE id = ?').get(made.id);
  assert.equal(row.token_hash, hash(made.token));
  assert.equal(decode(row.token_enc), made.token);
  assert.equal((await send('PATCH', `/api/admin/users/${made.id}/name`, 's.abc', { name: 'Zé Velho' })).status, 200);
  assert.equal((await send('PATCH', '/api/admin/users/9999/name', 's.abc', { name: 'a' })).status, 404);
  const re = await (await post(`/api/admin/users/${made.id}/regenerate-token`, 's.abc')).json();
  assert.notEqual(re.token, made.token);
  assert.equal((await get('/api/me', made.token)).status, 401);
  assert.equal((await del(`/api/admin/users/${made.id}`, 's.abc')).status, 200);
  assert.equal((await del('/api/admin/users/3', 's.abc')).status, 400);
});
test('users: promotion keeps one admin and never demotes the owner', async () => {
  const off = { ...env, ENABLE_ADMIN_PROMOTION: 'false' };
  const on = { ...env, ENABLE_ADMIN_PROMOTION: 'true' };
  assert.equal((await send('PATCH', '/api/admin/users/1/admin', 'rui-key', { isAdmin: true }, on)).status, 403);
  assert.equal((await send('PATCH', '/api/admin/users/1/admin', 's.abc', { isAdmin: true }, off)).status, 403);
  assert.equal((await send('PATCH', '/api/admin/users/1/admin', 's.abc', { isAdmin: true }, on)).status, 200);
  assert.equal((await send('PATCH', '/api/admin/users/3/admin', 's.abc', { isAdmin: false }, on)).status, 400);
  assert.equal((await send('PATCH', '/api/admin/users/1/admin', 's.abc', { isAdmin: false }, on)).status, 200);
});
test('settings: rollover hour reads, saves, and refuses bad values', async () => {
  assert.equal((await (await get('/api/admin/settings', 'rui-key')).json()).dayRolloverHour, 6);
  assert.equal((await send('PUT', '/api/admin/settings', 'ana-key', { dayRolloverHour: 5 })).status, 403);
  for (const bad of [24, -1, 1.5, 'x']) assert.equal((await send('PUT', '/api/admin/settings', 'rui-key', { dayRolloverHour: bad })).status, 400);
  assert.equal((await send('PUT', '/api/admin/settings', 'rui-key', { dayRolloverHour: 4 })).status, 200);
  assert.equal((await (await get('/api/admin/settings', 'rui-key')).json()).dayRolloverHour, 4);
  await send('PUT', '/api/admin/settings', 'rui-key', { dayRolloverHour: 6 });
});
test('dedications: one per guest and rewritten in place; only the owner reads or wipes', async () => {
  assert.deepEqual(await (await get('/api/dedications/mine', 'ana-key')).json(), { dedication: null });
  assert.equal((await send('PUT', '/api/dedications/mine', 'ana-key', { text: '   ' })).status, 400);
  await send('PUT', '/api/dedications/mine', 'ana-key', { text: 'one' });
  const r = await (await send('PUT', '/api/dedications/mine', 'ana-key', { text: 'two' })).json();
  assert.equal(r.dedication.text, 'two');
  assert.equal(testDb.prepare('SELECT COUNT(*) n FROM dedications').get().n, 1);
  assert.equal((await get('/api/admin/dedications', 'rui-key')).status, 403);
  assert.equal((await (await get('/api/admin/dedications', 's.abc')).json()).dedications[0].author, 'Ana');
  assert.equal((await post('/api/admin/dedications/wipe', 'rui-key')).status, 403);
  await post('/api/admin/dedications/wipe', 's.abc');
  assert.equal(testDb.prepare('SELECT COUNT(*) n FROM dedications').get().n, 0);
});
test('logo flag: only true or false', async () => {
  assert.equal((await post('/api/me/logo-customized', 'ana-key', { customized: 'yes' })).status, 400);
  assert.equal((await post('/api/me/logo-customized', 'ana-key', { customized: true })).status, 200);
  assert.equal(testDb.prepare('SELECT logo_customized FROM users WHERE id = 1').get().logo_customized, 1);
});

// ---- Key change, key claim, wipes (APP-LG-017) ----
const encrypt = (text) => {
  const iv = Buffer.alloc(12, 1);
  const c = createCipheriv('aes-256-gcm', createHash('sha256').update(SECRET).digest(), iv);
  const ct = Buffer.concat([c.update(text), c.final()]);
  return `${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
};
test('change key: wrong current, bad chars, too short and taken are refused; the new key signs in', async () => {
  const ch = (body, key = 'ana-key') => post('/api/me/change-token', key, body);
  assert.equal(await errOf(await ch({ currentToken: 'nope', newToken: 'anakey2' })), 'err_current_key_wrong');
  assert.equal(await errOf(await ch({ currentToken: 'ana-key', newToken: 'ana key!' })), 'err_key_invalid_chars');
  assert.equal(await errOf(await ch({ currentToken: 'ana-key', newToken: 'ab12' })), 'err_key_too_short');
  assert.equal(await errOf(await ch({ currentToken: 'ana-key', newToken: 'ab12' })), 'err_key_too_short'); // twice, same answer
  testDb.prepare('UPDATE users SET token_hash = ? WHERE id = 2').run(hash('takenkey1'));
  assert.equal(await errOf(await ch({ currentToken: 'ana-key', newToken: 'TakenKey1' })), 'err_key_taken');
  testDb.prepare('UPDATE users SET token_hash = ? WHERE id = 2').run(hash('rui-key'));
  assert.equal((await ch({ currentToken: 'ANA-KEY', newToken: ' AnaNova7 ' })).status, 200);
  assert.equal((await get('/api/me', 'ana-key')).status, 401);
  assert.equal((await get('/api/me', 'ananova7')).status, 200);
  assert.equal(decode(testDb.prepare('SELECT token_enc FROM users WHERE id = 1').get().token_enc), 'ananova7');
  testDb.prepare("UPDATE users SET token_hash = ?, token_enc = 'x' WHERE id = 1").run(hash('ana-key'));
});
test('claim key: 3+ letters, accents folded, works once even when tapped twice at once', async () => {
  const { db, env: e } = emptyEnv('production');
  db.prepare('INSERT INTO users (name, token_hash, token_enc) VALUES (?, ?, ?)').run('César', hash('cesar123456'), encrypt('cesar123456'));
  const find = async (name) => (await (await get('/api/auth/unclaimed-users?name=' + encodeURIComponent(name), null, e)).json()).users;
  assert.deepEqual(await find('ce'), []);
  assert.deepEqual((await find('CESA')).map((u) => u.name), ['César']);
  const claim = (userId) => send('POST', '/api/auth/claim-key', null, { userId }, e);
  assert.equal(await errOf(await claim(999)), 'err_user_not_found');
  const bodies = await Promise.all((await Promise.all([claim(1), claim(1), claim(1)])).map((r) => r.json()));
  assert.equal(bodies.filter((x) => x.token === 'cesar123456').length, 1);
  assert.equal(bodies.filter((x) => x.error === 'err_key_already_claimed').length, 2);
  assert.deepEqual(await find('cesa'), []);
});
test('wipes: only the owner; each clears its own data and translations; voting resets', async () => {
  const { db, env: e } = emptyEnv('production');
  db.prepare("INSERT INTO users (name, token_hash, token_enc, is_owner, is_admin) VALUES ('Ivo', 'h1', 'x', 1, 1)").run();
  db.prepare("INSERT INTO users (name, token_hash, token_enc, is_admin) VALUES ('Rui', 'h2', 'x', 1)").run();
  db.prepare("INSERT INTO users (name, token_hash, token_enc) VALUES ('Ana', 'h3', 'x')").run();
  db.prepare('INSERT INTO sessions (token_hash, user_id) VALUES (?, 1)').run(hash('s.own'));
  db.prepare('INSERT INTO sessions (token_hash, user_id) VALUES (?, 2)').run(hash('s.rui'));
  db.prepare("INSERT INTO messages (user_id, text) VALUES (3, 'hi')").run();
  const tr = db.prepare("INSERT INTO translations (entity_type, entity_id, field, lang, text) VALUES (?, 1, 'text', 'en', 'x')");
  tr.run('message'); tr.run('consequence');
  db.prepare("INSERT INTO settings (key, value) VALUES ('voting_status_furnished', 'open')").run();
  const w = (path, key) => send('POST', path, key, {}, e);
  for (const p of ['users', 'consequences', 'contestants', 'plaza-posts', 'chat']) {
    assert.equal((await w(`/api/admin/${p}/wipe`, 's.rui')).status, 403);
  }
  await w('/api/admin/chat/wipe', 's.own');
  assert.equal((await w('/api/admin/chat/wipe', 's.own')).status, 200); // twice is fine
  assert.equal(db.prepare('SELECT COUNT(*) n FROM messages').get().n, 0);
  assert.deepEqual(db.prepare('SELECT entity_type FROM translations').all().map((r) => r.entity_type), ['consequence']);
  await w('/api/admin/contestants/wipe', 's.own');
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'voting_status_furnished'").get().value, 'closed');
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'results_phase_swamp'").get().value, 'hidden');
  assert.equal((await (await w('/api/admin/users/wipe', 's.own')).json()).removed, 2);
  assert.deepEqual(db.prepare('SELECT name FROM users').all().map((u) => u.name), ['Ivo']);
});

test('daily demo reset: clears what visitors made, files included, and seeds the same people again', async () => {
  const { resetDemo } = await import('../src/worker.js');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  db.prepare("INSERT INTO users (name, token_hash, token_enc, is_owner, is_admin) VALUES ('Ivo', 'h', 'x', 1, 1)").run();
  db.prepare("INSERT INTO users (name, token_hash, token_enc) VALUES ('Visitor', 'h2', 'x')").run();
  db.prepare("INSERT INTO plaza_posts (type, author_id, text) VALUES ('announcement', 2, 'spam')").run();
  let deleted = [];
  const FILES = { list: async () => ({ objects: [{ key: 'a' }, { key: 'b' }], truncated: false }), delete: async (k) => { deleted = k; } };
  const e = { DB: d1(db), FILES, APP_ENV: 'demo', TOKEN_SECRET: SECRET };
  const out = await resetDemo(e);
  assert.equal(out.files, 2);
  assert.deepEqual(deleted, ['a', 'b']);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM plaza_posts').get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE name = 'Visitor'").get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users WHERE is_owner = 0').get().n, MOCK_NAMES.length);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users WHERE is_owner = 1').get().n, 1);
  assert.deepEqual(await resetDemo({ ...e, APP_ENV: 'prod' }), { skipped: true });
});

// ---- Push from the Worker (APP-LG-023) ----
import { encryptPayload, broadcast } from '../src/workerPush.js';
import { createECDH, hkdfSync, createDecipheriv as mkDecipher } from 'node:crypto';

const b64u = (b) => Buffer.from(b).toString('base64url');

test('push: payload encrypts so the browser key can read it (RFC 8291)', async () => {
  const ua = createECDH('prime256v1'); ua.generateKeys();
  const auth = Buffer.from('0123456789abcdef');
  const sub = { endpoint: 'https://push.test/x', keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) } };
  const out = Buffer.from(await encryptPayload(sub, 'olá wall'));
  const salt = out.subarray(0, 16), idlen = out[20], asPub = out.subarray(21, 21 + idlen), body = out.subarray(21 + idlen);
  const secret = ua.computeSecret(asPub);
  const prk = Buffer.from(hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub]), 32));
  const cek = Buffer.from(hkdfSync('sha256', prk, salt, 'Content-Encoding: aes128gcm\0', 16));
  const nonce = Buffer.from(hkdfSync('sha256', prk, salt, 'Content-Encoding: nonce\0', 12));
  const d = mkDecipher('aes-128-gcm', cek, nonce);
  d.setAuthTag(body.subarray(-16));
  const plain = Buffer.concat([d.update(body.subarray(0, -16)), d.final()]);
  assert.equal(plain.subarray(0, -1).toString(), 'olá wall');
  assert.equal(plain.at(-1), 2);
});

test('push: subscribe, send with a VAPID signature, drop expired, quiet without keys', async () => {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  const e = { ...env, VAPID_PUBLIC_KEY: b64u(ecdh.getPublicKey()), VAPID_PRIVATE_KEY: b64u(ecdh.getPrivateKey()), VAPID_SUBJECT: 'mailto:t@test' };
  const ua = createECDH('prime256v1'); ua.generateKeys();
  const mk = (n) => ({ endpoint: `https://push.test/${n}`, keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(Buffer.alloc(16, 1)) } });
  const count = () => testDb.prepare("SELECT count(*) c FROM push_subscriptions WHERE endpoint LIKE 'https://push.test/%'").get().c;
  assert.equal((await send('POST', '/api/push/subscribe', 'ana-key', { subscription: { endpoint: 'x' } }, e)).status, 400);
  assert.equal((await send('POST', '/api/push/subscribe', 'ana-key', { subscription: mk('ok') }, e)).status, 201);
  assert.equal((await send('POST', '/api/push/subscribe', 'ana-key', { subscription: mk('ok') }, e)).status, 201); // twice: one row
  await send('POST', '/api/push/subscribe', 'rui-key', { subscription: mk('gone') }, e);
  assert.equal(count(), 2);
  assert.equal((await (await get('/api/push/vapid-public-key', 'ana-key', e)).json()).enabled, true);
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response(null, { status: url.endsWith('gone') ? 410 : 201 }); };
  try {
    assert.deepEqual(await broadcast(e, { title: 't', body: { pt: 'a', en: 'b' } }), { sent: 1, failed: 1 });
    assert.match(calls[0].init.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
    assert.equal(count(), 1); // the expired one is gone
    calls.length = 0;
    assert.deepEqual(await broadcast(env, { title: 't' }), { sent: 0, failed: 0 }); // no keys: nothing sent
    assert.equal(calls.length, 0);
  } finally { globalThis.fetch = realFetch; }
  await send('POST', '/api/push/unsubscribe', 'ana-key', { endpoint: 'https://push.test/ok' }, e);
  assert.equal(count(), 0);
});
