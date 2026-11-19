// Plaza on the Worker (APP-LG-033): chat history, post photos, admin list, pseudonyms.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import worker from '../src/worker.js';

const SECRET = 'test-secret';
const hash = (t) => createHmac('sha256', SECRET).update(t).digest('hex');
let env; let db;
function d1(raw) {
  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    first: async () => raw.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: raw.prepare(sql).all(...args) }),
    run: async () => { const r = raw.prepare(sql).run(...args); return { ...r, meta: { changes: Number(r.changes) } }; },
  });
  return { prepare: (sql) => wrap(sql), batch: async (stmts) => { for (const st of stmts) await st.run(); } };
}
before(() => {
  db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  const u = db.prepare('INSERT INTO users (name, token_hash, token_enc, is_admin, is_owner) VALUES (?, ?, ?, ?, ?)');
  u.run('Ivo', hash('ivo'), 'x', 1, 1); u.run('Rui', hash('rui'), 'x', 1, 0); u.run('Ana', hash('ana'), 'x', 0, 0); u.run('Bea', hash('bea'), 'x', 0, 0);
  env = { DB: d1(db), TOKEN_SECRET: SECRET, APP_ENV: 'demo', ENABLE_PLAZA: 'true', ASSETS: { fetch: async () => new Response('x') } };
});
const call = (method, path, key, body, e = env) => worker.fetch(new Request('https://x.test' + path, {
  method, headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body) }), e);
const JPEG = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');

test('chat history shows pseudonyms and keeps the last 15, oldest first', async () => {
  assert.equal((await call('GET', '/api/chat/messages', null)).status, 401);
  for (let i = 1; i <= 17; i++) assert.equal((await call('POST', '/api/chat/messages', i % 2 ? 'ana' : 'bea', { text: `Hello ${i}` })).status, 201);
  const { messages } = await (await call('GET', '/api/chat/messages', 'ana')).json();
  assert.equal(messages.length, 15);
  assert.equal(messages[0].text, 'hello 3');
  assert.equal(messages[14].text, 'hello 17');
  assert.match(messages[0].time, /^\d\d:\d\d$/);
  assert.ok(messages[0].author && messages[0].author !== 'Ana');
  assert.equal((await call('POST', '/api/chat/messages', 'ana', { text: '  ' })).status, 400);
});

test('a post with a photo: guests see it, bad photos are refused, edit removes it', async () => {
  const bad = await call('POST', '/api/admin/plaza-posts', 'rui', { type: 'announcement', text: 'x', photoBase64: 'nope' });
  assert.equal((await bad.json()).error, 'err_photo_invalid');
  const made = await call('POST', '/api/admin/plaza-posts', 'rui', { type: 'announcement', text: 'hello', photoBase64: JPEG });
  const { id } = await made.json();
  const photo = await call('GET', `/api/plaza-posts/${id}/photo`, 'ana');
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual([...new Uint8Array(await photo.arrayBuffer())], [0xff, 0xd8, 0xff, 0xd9]);
  assert.equal((await call('GET', `/api/plaza-posts/${id}/photo`, null)).status, 401);
  assert.equal((await call('GET', '/api/plaza-posts/999/photo', 'ana')).status, 404);
  assert.equal((await call('GET', `/api/plaza-posts/${id}/photo`, 'ana', undefined, { ...env, ENABLE_PLAZA: 'false' })).status, 404);
  assert.ok((await (await call('GET', '/api/plaza-posts', 'ana')).json()).posts.find((p) => p.id === id).hasPhoto);
  assert.equal((await call('PATCH', `/api/admin/plaza-posts/${id}`, 'rui', { text: 'hello', photoBase64: null })).status, 200);
  assert.equal((await call('GET', `/api/plaza-posts/${id}/photo`, 'ana')).status, 404);
});

test('admin post list: admins only, polls carry voters', async () => {
  const poll = await (await call('POST', '/api/admin/plaza-posts', 'rui', { type: 'poll', text: 'pick', options: ['a', 'b'] })).json();
  const opt = db.prepare('SELECT id FROM plaza_poll_options WHERE post_id = ? ORDER BY position').get(poll.id).id;
  await call('POST', `/api/plaza-posts/${poll.id}/vote`, 'ana', { optionId: opt });
  assert.equal((await call('GET', '/api/admin/plaza-posts', 'ana')).status, 403);
  const { posts } = await (await call('GET', '/api/admin/plaza-posts', 'rui')).json();
  const p = posts.find((x) => x.id === poll.id);
  assert.deepEqual(p.voters, [{ name: 'Ana', option: 'a' }]);
  assert.equal(p.options.length, 2);
});

test('wall pseudonyms: owner only, reset once a day, history kept', async () => {
  assert.equal((await call('GET', '/api/admin/wall-pseudonyms', 'rui')).status, 403);
  const dir = await (await call('GET', '/api/admin/wall-pseudonyms', 'ivo')).json();
  const ana = dir.find((d) => d.name === 'Ana');
  assert.equal(ana.pseudonyms.length, 1);
  assert.equal((await call('POST', `/api/admin/users/${ana.id}/wall-pseudonym/reset`, 'rui', {})).status, 403);
  assert.equal((await call('POST', `/api/admin/users/${ana.id}/wall-pseudonym/reset`, 'ivo', {})).status, 200);
  const again = await call('POST', `/api/admin/users/${ana.id}/wall-pseudonym/reset`, 'ivo', {});
  assert.equal((await again.json()).error, 'err_pseudonym_reset_limit');
  assert.equal((await call('POST', '/api/admin/users/999/wall-pseudonym/reset', 'ivo', {})).status, 400);
  const after = (await (await call('GET', '/api/admin/wall-pseudonyms', 'ivo')).json()).find((d) => d.name === 'Ana');
  assert.equal(after.pseudonyms.length, 2);
});
