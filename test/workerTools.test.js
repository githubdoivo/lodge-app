// Owner tools on the Worker (APP-LG-035): dedications PDF, guest seeding,
// Face ID tryout admin, automatic translations.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import worker from '../src/worker.js';

const SECRET = 'test-secret';
const hash = (t) => createHmac('sha256', SECRET).update(t).digest('hex');
let env; let prod; let db;
const pending = [];
const exec = { waitUntil: (p) => pending.push(p.catch(() => {})) };
const settle = async () => { while (pending.length) await pending.shift(); };
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
  u.run('Ivo', hash('ivo'), 'x', 1, 1); u.run('Rui', hash('rui'), 'x', 1, 0); u.run('Ana', hash('ana'), 'x', 0, 0);
  // On the real Lodge the owner and admins sign in with Face ID: a session stands in for it.
  const sess = db.prepare('INSERT INTO sessions (token_hash, user_id) VALUES (?, ?)');
  sess.run(hash('s.ivo'), 1); sess.run(hash('s.rui'), 2);
  env = { DB: d1(db), TOKEN_SECRET: SECRET, APP_ENV: 'demo', DEMO_GUARD: 'off', ENABLE_PLAZA: 'true', ASSETS: { fetch: async () => new Response('x') } };
  prod = { ...env, APP_ENV: 'production' };
});
const call = (method, path, key, body, e = env) => worker.fetch(new Request('https://x.test' + path, {
  method, headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body) }), e, exec);

test('dedications pdf: owner only, 404 when empty, a real pdf otherwise', async () => {
  assert.equal((await call('GET', '/api/admin/dedications.pdf', 'rui')).status, 403);
  assert.equal((await call('GET', '/api/admin/dedications.pdf', 'ivo')).status, 404);
  db.prepare('INSERT INTO dedications (user_id, text) VALUES (2, ?)').run('happy birthday, ivo');
  db.prepare('INSERT INTO dedications (user_id, text) VALUES (3, ?)').run('parabéns!');
  const res = await call('GET', '/api/admin/dedications.pdf', 'ivo');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.match(res.headers.get('content-disposition'), /dedicatorias\.pdf/);
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.equal(String.fromCharCode(...bytes.slice(0, 5)), '%PDF-');
});

test('seed guests: owner only, refused on the demo, never doubles up', async () => {
  assert.equal((await call('POST', '/api/admin/users/seed-guests', 'ivo', {}, env)).status, 403);
  assert.equal((await call('POST', '/api/admin/users/seed-guests', 's.rui', {}, prod)).status, 403);
  const first = await (await call('POST', '/api/admin/users/seed-guests', 's.ivo', {}, prod)).json();
  assert.ok(first.created > 5);
  const again = await (await call('POST', '/api/admin/users/seed-guests', 's.ivo', {}, prod)).json();
  assert.equal(again.created, 0);
  db.prepare("INSERT INTO settings (key, value) VALUES ('guest_list', ?)").run('Zed One\nZed Two\n\nRui');
  const third = await (await call('POST', '/api/admin/users/seed-guests', 's.ivo', {}, prod)).json();
  assert.equal(third.created, 2);
});

test('face id tryout: demo only, a private admin each time', async () => {
  assert.equal((await call('POST', '/api/demo/faceid-admin', null, {}, prod)).status, 403);
  const a = await call('POST', '/api/demo/faceid-admin', null, {});
  assert.equal(a.status, 201);
  const one = await a.json();
  const two = await (await call('POST', '/api/demo/faceid-admin', null, {})).json();
  assert.notEqual(one.name, two.name);
  // A tryout admin is a real admin, so the key alone is not enough: Face ID is asked for (test/demo.test.js).
  const me = await (await call('GET', '/api/me', one.key)).json();
  assert.equal(me.error, 'err_passkey_required');
});

const realFetch = globalThis.fetch;
function fakeAnthropic(replies) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.anthropic.com')) return realFetch(url, init);
    const body = JSON.parse(init.body);
    calls.push({ headers: init.headers, body });
    const r = replies(body.messages[0].content);
    if (r === 'fail') return new Response('no', { status: 500 });
    return new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ already_in_target: false, translation: r }) }] }));
  };
  return calls;
}

test('translations: with no key nothing is queued to run and originals show', async () => {
  const made = await (await call('POST', '/api/admin/plaza-posts', 'rui', { type: 'announcement', text: 'the party starts at eight' })).json();
  await settle();
  const posts = (await (await call('GET', '/api/plaza-posts?lang=pt', 'ana')).json()).posts;
  const post = posts.find((p) => p.id === made.id);
  assert.equal(post.text, 'the party starts at eight');
  assert.equal(post.originalText, undefined);
  assert.equal(db.prepare("SELECT status FROM translations WHERE entity_type = 'plaza_post'").get().status, 'pending');
});

test('translations: a new post and message are translated and shown with their original', async () => {
  const calls = fakeAnthropic((t) => `PT:${t}`);
  try {
    const keyed = { ...env, ANTHROPIC_API_KEY: 'k' };
    const made = await (await call('POST', '/api/admin/plaza-posts', 'rui', { type: 'poll', text: 'where do we eat tonight', options: ['pizza place', 'the pub'] }, keyed)).json();
    await call('POST', '/api/chat/messages', 'ana', { text: 'see you all at the cottage' }, keyed);
    await settle();
    assert.equal(calls[0].headers['x-api-key'], 'k');
    assert.match(calls[0].body.system, /European Portuguese/);
    const posts = (await (await call('GET', '/api/plaza-posts?lang=pt', 'ana', undefined, keyed)).json()).posts;
    const post = posts.find((p) => p.id === made.id);
    assert.equal(post.text, 'PT:where do we eat tonight');
    assert.equal(post.originalText, 'where do we eat tonight');
    assert.equal(post.options[0].label, 'PT:pizza place');
    // the reader's stored language is used when none is asked for; english readers get the original
    const en = (await (await call('GET', '/api/plaza-posts?lang=en', 'ana', undefined, keyed)).json()).posts.find((p) => p.id === made.id);
    assert.equal(en.text, 'where do we eat tonight');
    const chat = (await (await call('GET', '/api/chat/messages?lang=pt', 'ana', undefined, keyed)).json()).messages;
    assert.equal(chat.at(-1).text, 'PT:see you all at the cottage');
    // editing the post throws the stale translation away and asks again
    await call('PATCH', `/api/admin/plaza-posts/${made.id}`, 'rui', { text: 'where do we eat tomorrow', options: ['pizza place', 'the pub'] }, keyed);
    await settle();
    const edited = (await (await call('GET', '/api/plaza-posts?lang=pt', 'ana', undefined, keyed)).json()).posts.find((p) => p.id === made.id);
    assert.equal(edited.text, 'PT:where do we eat tomorrow');
  } finally { globalThis.fetch = realFetch; }
});

test('translations: failures retry twice then stop; the daily cap stops spending', async () => {
  const calls = fakeAnthropic(() => 'fail');
  db.prepare('DELETE FROM translations').run();
  db.prepare("DELETE FROM settings WHERE key LIKE 'translation_calls_%'").run();
  try {
    const keyed = { ...env, ANTHROPIC_API_KEY: 'k', TRANSLATION_DAILY_CAP: '3' };
    await call('POST', '/api/chat/messages', 'ana', { text: 'one more message for the road' }, keyed);
    await settle();
    const row = db.prepare("SELECT status, attempts FROM translations WHERE entity_type = 'message' ORDER BY id DESC").get();
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 1);
    assert.equal(calls.length, 1);
    // the budget: three calls a day, counted before each call
    const day = new Date().toISOString().slice(0, 10);
    assert.equal(db.prepare('SELECT value FROM settings WHERE key = ?').get(`translation_calls_${day}`).value, '1');
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`translation_calls_${day}`, '3');
    const before = calls.length;
    await call('POST', '/api/chat/messages', 'ana', { text: 'and one beyond the cap' }, keyed);
    await settle();
    assert.equal(calls.length, before);
  } finally { globalThis.fetch = realFetch; }
});

test('translation backfill: owner only, refused on the demo, queues old rows once', async () => {
  assert.equal((await call('POST', '/api/admin/translations/backfill', 'ivo', {}, env)).status, 403);
  assert.equal((await call('POST', '/api/admin/translations/backfill', 's.rui', {}, prod)).status, 403);
  db.prepare("INSERT INTO messages (user_id, text, pseudonym) VALUES (3, 'an old message before translations', 'x')").run();
  const first = await (await call('POST', '/api/admin/translations/backfill', 's.ivo', {}, prod)).json();
  assert.ok(first.queued >= 1);
  const second = await (await call('POST', '/api/admin/translations/backfill', 's.ivo', {}, prod)).json();
  assert.equal(second.queued, 0);
});
