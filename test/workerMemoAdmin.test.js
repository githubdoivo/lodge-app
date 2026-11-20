// Rata and Memo admin tools on the Worker (APP-LG-034).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import worker from '../src/worker.js';

const SECRET = 'test-secret';
const hash = (t) => createHmac('sha256', SECRET).update(t).digest('hex');
let env; let db; const store = new Map();
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
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  const u = db.prepare('INSERT INTO users (name, token_hash, token_enc, is_admin, is_owner) VALUES (?, ?, ?, ?, ?)');
  u.run('Ivo', hash('ivo'), 'x', 1, 1); u.run('Rui', hash('rui'), 'x', 1, 0); u.run('Ana', hash('ana'), 'x', 0, 0);
  const FILES = {
    get: async (k) => (store.has(k) ? { arrayBuffer: async () => store.get(k) } : null),
    delete: async (keys) => { for (const k of [].concat(keys)) store.delete(k); },
  };
  env = { DB: d1(db), FILES, TOKEN_SECRET: SECRET, APP_ENV: 'demo', DEMO_GUARD: 'off', ENABLE_MEMO: 'true', ASSETS: { fetch: async () => new Response('x') } };
});
const call = (method, path, key) => worker.fetch(new Request('https://x.test' + path, {
  method, headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) },
  body: method === 'GET' ? undefined : '{}' }), env);

test('admin consequences list: admins only, newest first, includes pending', async () => {
  db.prepare("INSERT INTO consequences (user_id, text, day, status, revealed_at) VALUES (3, 'old', '2026-01-01', 'used', '2026-01-01 10:00:00.000')").run();
  db.prepare("INSERT INTO consequences (user_id, text, day) VALUES (3, 'waiting', '2026-01-02')").run();
  assert.equal((await call('GET', '/api/admin/consequences', 'ana')).status, 403);
  const list = await (await call('GET', '/api/admin/consequences', 'rui')).json();
  assert.equal(list.length, 2);
  assert.equal(list[0].author, 'Ana');
  assert.deepEqual(list.map((c) => c.status).sort(), ['pending', 'used']);
});

test('memo uploads.zip: admin only, 404 when empty, zips R2 files with unique names', async () => {
  assert.equal((await call('GET', '/api/admin/memo/2026-01-01/uploads.zip', 'ana')).status, 403);
  assert.equal((await call('GET', '/api/admin/memo/2026-01-01/uploads.zip', 'rui')).status, 404);
  db.prepare("INSERT INTO memo_slots (id, day, slot_index, scheduled_at) VALUES (1, '2026-01-01', 0, '2026-01-01 15:00:00')").run();
  db.prepare("INSERT INTO memo_uploads (slot_id, user_id, day, kind, mime_type, file_path, file_size) VALUES (1, 3, '2026-01-01', 'photo', 'image/jpeg', 'k1.jpg', 3)").run();
  db.prepare("INSERT INTO memo_recaps (day, file_path, mime_type, file_size, uploaded_by) VALUES ('2026-01-01', 'r.mp4', 'video/mp4', 1, 2)").run();
  store.set('k1.jpg', new Uint8Array([1, 2, 3]).buffer); store.set('r.mp4', new Uint8Array([9]).buffer);
  const res = await call('GET', '/api/admin/memo/2026-01-01/uploads.zip', 'rui');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.match(res.headers.get('content-disposition'), /memo-2026-01-01\.zip/);
  assert.match(Buffer.from(await res.arrayBuffer()).toString('latin1'), /ana-momento1\.jpg/);
  // a file missing from R2 leaves nothing to zip
  store.delete('k1.jpg');
  assert.equal((await call('GET', '/api/admin/memo/2026-01-01/uploads.zip', 'rui')).status, 404);
  store.set('k1.jpg', new Uint8Array([1, 2, 3]).buffer);
});

test('memo recap status: idle without a recap, done with the photo count', async () => {
  assert.equal((await call('GET', '/api/admin/memo/2026-01-01/recap/status', 'ana')).status, 403);
  assert.deepEqual(await (await call('GET', '/api/admin/memo/2030-01-01/recap/status', 'rui')).json(), { status: 'idle' });
  assert.deepEqual(await (await call('GET', '/api/admin/memo/2026-01-01/recap/status', 'rui')).json(), { status: 'done', photoCount: 1 });
});

test('memo wipe: owner only, clears rows and R2 files', async () => {
  assert.equal((await call('POST', '/api/admin/memo/wipe', 'ana')).status, 403);
  assert.equal((await call('POST', '/api/admin/memo/wipe', 'rui')).status, 403);
  assert.equal(store.size, 2);
  assert.equal((await call('POST', '/api/admin/memo/wipe', 'ivo')).status, 200);
  assert.equal(store.size, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memo_uploads').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memo_recaps').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memo_slots').get().n, 0);
});
