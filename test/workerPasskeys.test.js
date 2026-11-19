// Face ID on the Worker (APP-LG-024). A software phone makes real P-256 keys and
// signs real WebAuthn data, so the Worker's checks run as they would on an iPhone.
// D1 is stood in for by node:sqlite with the same migration, as in worker.test.js.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHmac, createHash, generateKeyPairSync, sign, randomBytes } from 'node:crypto';
import worker from '../src/worker.js';

const SECRET = 'test-secret';
const HOST = 'lodge.test';
const hash = (t) => createHmac('sha256', SECRET).update(t).digest('hex');
let db, demo, prod;

function d1(sqlite) {
  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => { const r = sqlite.prepare(sql).run(...args); return { ...r, meta: { changes: Number(r.changes) } }; },
  });
  return { prepare: (sql) => wrap(sql), batch: async (stmts) => { for (const st of stmts) await st.run(); } };
}

before(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  const u = db.prepare('INSERT INTO users (name, token_hash, token_enc, is_admin, is_owner) VALUES (?, ?, ?, ?, ?)');
  u.run('Ana', hash('ana-key'), 'x', 0, 0);
  u.run('Rui', hash('rui-key'), 'x', 1, 0);
  u.run('Ivo', hash('ivo-key'), 'x', 1, 1);
  u.run('Zé', hash('ze-key'), 'x', 0, 0);   // has a non-owner name so the demo seed stays out of the way
  demo = { DB: d1(db), TOKEN_SECRET: SECRET, APP_ENV: 'demo' };
  prod = { ...demo, APP_ENV: 'production' };
});

const call = async (method, path, { key, body, env = demo, origin = `https://${HOST}` } = {}) => {
  const r = await worker.fetch(new Request(origin + path, {
    method, headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

// ---- a pretend phone ----
const b64u = (b) => Buffer.from(b).toString('base64url');
function cborEnc(v) {
  const head = (major, n) => n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cborEnc(k), cborEnc(x)])]);
  throw new Error('cbor');
}
function phone({ origin = `https://${HOST}` } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }), credId = randomBytes(16);
  let counter = 0;
  const rpHash = (rpId) => createHash('sha256').update(rpId).digest();
  const clientData = (type, challenge) => Buffer.from(JSON.stringify({ type, challenge, origin }));
  return {
    id: b64u(credId),
    create(o) {
      const cose = cborEnc(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
      const authData = Buffer.concat([rpHash(o.rp.id), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), Buffer.from([0, credId.length]), credId, cose]);
      const att = cborEnc(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return { name: 'test phone', clientDataJSON: b64u(clientData('webauthn.create', o.challenge)), attestationObject: b64u(att) };
    },
    get(o, { verified = true } = {}) {
      counter++;
      const authData = Buffer.concat([rpHash(o.rpId), Buffer.from([verified ? 0x05 : 0x01]), Buffer.from([0, 0, 0, counter])]);
      const cd = clientData('webauthn.get', o.challenge);
      const signature = sign('sha256', Buffer.concat([authData, createHash('sha256').update(cd).digest()]), privateKey);
      return { id: b64u(credId), clientDataJSON: b64u(cd), authenticatorData: b64u(authData), signature: b64u(signature) };
    },
  };
}

test('demo: a guest adds Face ID in settings, then signs in with it alone', async () => {
  const list0 = await call('GET', '/api/me/passkeys', { key: 'ana-key' });
  assert.deepEqual(list0.body, { passkeys: [], required: false, available: true });
  const p = phone();
  const opts = (await call('POST', '/api/me/passkeys/options', { key: 'ana-key' })).body;
  assert.equal(opts.rp.id, HOST);
  const added = await call('POST', '/api/me/passkeys', { key: 'ana-key', body: p.create(opts) });
  assert.equal(added.status, 200);
  assert.equal(added.body.id, p.id);

  const so = (await call('POST', '/api/auth/passkey/options')).body;
  assert.equal(so.allowCredentials, undefined);   // signed out: the phone picks the account
  const s = await call('POST', '/api/auth/passkey/signin', { body: { credential: p.get(so) } });
  assert.equal(s.status, 200);
  assert.equal(s.body.name, 'Ana');
  assert.match(s.body.session, /^s\.[0-9a-f]{64}$/);
  assert.equal((await call('GET', '/api/me', { key: s.body.session })).body.name, 'Ana');
  assert.ok(db.prepare('SELECT used_at FROM passkeys WHERE id = ?').get(p.id).used_at);
  // the key still works on the demo
  assert.equal((await call('GET', '/api/me', { key: 'ana-key' })).status, 200);
});

test('demo: the shared admin is never asked for Face ID', async () => {
  const r = await call('POST', '/api/auth/login', { body: { token: 'rui-key' } });
  assert.deepEqual(r.body, { id: 2, name: 'Rui', isAdmin: true });
  assert.equal((await call('GET', '/api/me/passkeys', { key: 'rui-key' })).body.required, false);
});

test('a challenge works once; replaying the same signature is refused', async () => {
  const p = phone();
  const opts = (await call('POST', '/api/me/passkeys/options', { key: 'ze-key' })).body;
  await call('POST', '/api/me/passkeys', { key: 'ze-key', body: p.create(opts) });
  const so = (await call('POST', '/api/auth/passkey/options')).body;
  const cred = p.get(so);
  assert.equal((await call('POST', '/api/auth/passkey/signin', { body: { credential: cred } })).status, 200);
  assert.equal((await call('POST', '/api/auth/passkey/signin', { body: { credential: cred } })).status, 401);
  // double tap: two sign-ins with one challenge at once, only one wins
  const so2 = (await call('POST', '/api/auth/passkey/options')).body;
  const both = await Promise.all([call('POST', '/api/auth/passkey/signin', { body: { credential: p.get(so2) } }),
    call('POST', '/api/auth/passkey/signin', { body: { credential: p.get(so2) } })]);
  assert.deepEqual(both.map((b) => b.status).sort(), [200, 401]);
});

test('wrong site, unverified face, unknown passkey, an expired challenge and junk are all refused', async () => {
  const p = phone();
  const opts = (await call('POST', '/api/me/passkeys/options', { key: 'ze-key' })).body;
  await call('POST', '/api/me/passkeys', { key: 'ze-key', body: p.create(opts) });
  const so = async () => (await call('POST', '/api/auth/passkey/options')).body;
  const signin = async (credential) => (await call('POST', '/api/auth/passkey/signin', { body: { credential } })).status;
  assert.equal(await signin(p.get({ ...(await so()), rpId: 'evil.test' })), 401);
  assert.equal(await signin(phone({ origin: 'https://evil.test' }).get(await so())), 401);
  assert.equal(await signin(p.get(await so(), { verified: false })), 401);
  assert.equal(await signin(phone().get(await so())), 401);   // never added
  const old = await so();
  db.prepare('UPDATE passkey_challenges SET expires = 1 WHERE challenge = ?').run(old.challenge);
  assert.equal(await signin(p.get(old)), 401);
  assert.equal(await signin({ id: p.id, clientDataJSON: 'nope', authenticatorData: '', signature: '' }), 401);
  assert.equal(await signin(undefined), 401);
  assert.equal((await call('POST', '/api/me/passkeys', { key: 'ze-key', body: { attestationObject: 'junk' } })).status, 400);
  assert.equal((await call('GET', '/api/me/passkeys')).status, 401);   // signed out
});

test('off the demo: the admin key alone gets the Face ID step; first time adds, later times use it', async () => {
  const p = phone();
  const first = await call('POST', '/api/auth/login', { env: prod, body: { token: 'rui-key' } });
  assert.equal(first.body.step, 'passkey');
  assert.equal(first.body.mode, 'create');
  const wrongKey = await call('POST', '/api/auth/passkey/finish', { env: prod, body: { token: 'nope', mode: 'create', credential: p.create(first.body.options) } });
  assert.equal(wrongKey.status, 401);
  const again = (await call('POST', '/api/auth/login', { env: prod, body: { token: 'rui-key' } })).body;
  const done = await call('POST', '/api/auth/passkey/finish', { env: prod, body: { token: 'rui-key', mode: 'create', credential: p.create(again.options) } });
  assert.equal(done.status, 200);
  assert.equal((await call('GET', '/api/me', { env: prod, key: done.body.session })).body.name, 'Rui');

  const next = (await call('POST', '/api/auth/login', { env: prod, body: { token: 'RUI-KEY' } })).body;
  assert.equal(next.mode, 'get');
  assert.deepEqual(next.options.allowCredentials, [{ type: 'public-key', id: p.id }]);
  // someone holding the key can't sneak a second phone in with mode=create
  const sneak = await call('POST', '/api/auth/passkey/finish', { env: prod, body: { token: 'rui-key', mode: 'create', credential: phone().create({ ...next.options, rp: { id: HOST }, user: {} }) } });
  assert.equal(sneak.status, 401);
  const ok = await call('POST', '/api/auth/passkey/finish', { env: prod, body: { token: 'rui-key', mode: 'get', credential: p.get(next.options) } });
  assert.equal(ok.status, 200);

  // the last passkey of an admin can't be removed
  const rm = await call('DELETE', `/api/me/passkeys/${p.id}`, { env: prod, key: ok.body.session });
  assert.equal(rm.status, 400);
  assert.equal(rm.body.error, 'err_last_passkey');
});

test('lost phone: only the owner clears Face ID, which ends that person\'s sessions too', async () => {
  const p = phone();
  const opts = (await call('POST', '/api/me/passkeys/options', { key: 'ana-key' })).body;
  await call('POST', '/api/me/passkeys', { key: 'ana-key', body: p.create(opts) });
  const s = (await call('POST', '/api/auth/passkey/signin', { body: { credential: p.get((await call('POST', '/api/auth/passkey/options')).body) } })).body.session;
  assert.equal((await call('DELETE', '/api/admin/users/1/passkeys', { key: 'rui-key' })).status, 403);   // an admin, not the owner
  assert.equal((await call('DELETE', '/api/admin/users/99/passkeys', { key: 'ivo-key' })).status, 404);
  assert.equal((await call('DELETE', '/api/admin/users/1/passkeys', { key: 'ivo-key' })).status, 200);
  assert.equal((await call('DELETE', '/api/admin/users/1/passkeys', { key: 'ivo-key' })).status, 200);   // twice is harmless
  assert.equal((await call('GET', '/api/me/passkeys', { key: 'ana-key' })).body.passkeys.length, 0);
  assert.equal((await call('GET', '/api/me', { key: s })).status, 401);
});

test('a guest removes their own passkey; someone else\'s id removes nothing', async () => {
  const p = phone();
  const opts = (await call('POST', '/api/me/passkeys/options', { key: 'ze-key' })).body;
  await call('POST', '/api/me/passkeys', { key: 'ze-key', body: p.create(opts) });
  assert.equal((await call('DELETE', `/api/me/passkeys/${p.id}`, { key: 'ana-key' })).status, 200);
  assert.ok(db.prepare('SELECT id FROM passkeys WHERE id = ?').get(p.id));
  assert.equal((await call('DELETE', `/api/me/passkeys/${p.id}`, { key: 'ze-key' })).status, 200);
  assert.equal(db.prepare('SELECT id FROM passkeys WHERE id = ?').get(p.id), undefined);
});
