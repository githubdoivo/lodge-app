// Face ID / passkeys (APP-LG-001): owner and admins can't use their key
// alone; guests may add Face ID or keep the key. A small software
// authenticator below stands in for the phone: it makes real P-256 keys and
// signs real WebAuthn data, so the server's checks run exactly as on an iPhone.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createHash, generateKeyPairSync, sign, randomBytes } from 'node:crypto';

const DB = join(tmpdir(), `lodge-passkeys-${process.pid}-${Date.now()}.sqlite`);
process.env.ANTHROPIC_API_KEY = '';
process.env.TOKEN_SECRET ||= 'test-secret-not-used-anywhere-real';
process.env.DB_FILE = DB;
process.env.ADMIN_NAME = 'Test Owner';
delete process.env.ADMIN_PASSKEY;   // the rule is on, as in production

const { default: app, seedResult } = await import('../src/app.js');
const { default: db } = await import('../src/db.js');
const { resetAuthAttempts } = await import('../src/rateLimit.js');
const OWNER = seedResult.token;
let server, base, host;

before(async () => {
  server = app.listen(0); await once(server, 'listening');
  host = `localhost:${server.address().port}`; base = `http://${host}/api`;
});
after(() => { server?.close(); for (const ext of ['', '-wal', '-shm']) { try { rmSync(DB + ext); } catch { /* ignore */ } } });

const call = async (path, { method = 'GET', body, token } = {}) => {
  resetAuthAttempts();
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

// ---- a pretend phone: CBOR just big enough for a "none" attestation ----
const b64u = (b) => Buffer.from(b).toString('base64url');
function cborEnc(v) {
  const head = (major, n) => n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cborEnc(k), cborEnc(x)])]);
  throw new Error('cbor');
}
function phone() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }), credId = randomBytes(16);
  let counter = 0;
  const rpHash = (rpId) => createHash('sha256').update(rpId).digest();
  const clientData = (type, challenge) => Buffer.from(JSON.stringify({ type, challenge, origin: `http://${host}` }));
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

test('the owner key alone opens nothing; the first sign-in adds Face ID, later ones use it', async () => {
  assert.equal((await call('/me', { token: OWNER })).body.error, 'err_passkey_required');
  const first = await call('/auth/login', { method: 'POST', body: { token: OWNER } });
  assert.equal(first.body.step, 'passkey'); assert.equal(first.body.mode, 'create');
  const iphone = phone();
  const done = await call('/auth/passkey/finish', { method: 'POST', body: { token: OWNER, mode: 'create', credential: iphone.create(first.body.options) } });
  assert.equal(done.status, 200); assert.match(done.body.session, /^s\.[0-9a-f]{64}$/);
  assert.equal((await call('/me', { token: done.body.session })).status, 200, 'the session works');

  // next time: the key plus this phone's Face ID
  const again = await call('/auth/login', { method: 'POST', body: { token: OWNER } });
  assert.equal(again.body.mode, 'get');
  const ok = await call('/auth/passkey/finish', { method: 'POST', body: { token: OWNER, mode: 'get', credential: iphone.get(again.body.options) } });
  assert.equal(ok.status, 200);

  // with a passkey already there, the key can't add another one: a stolen key gets nowhere
  const thief = phone();
  const t1 = await call('/auth/login', { method: 'POST', body: { token: OWNER } });
  assert.equal((await call('/auth/passkey/finish', { method: 'POST', body: { token: OWNER, mode: 'create', credential: thief.create({ ...t1.body.options, rp: { id: 'localhost' } }) } })).status, 401);

  // Face ID alone, no key typed
  const o = (await call('/auth/passkey/options', { method: 'POST' })).body;
  const fid = await call('/auth/passkey/signin', { method: 'POST', body: { credential: iphone.get(o) } });
  assert.equal(fid.status, 200); assert.equal(fid.body.name, 'Test Owner');

  // a challenge works once; a signature without Face ID (no user verification) is refused
  const o2 = (await call('/auth/passkey/options', { method: 'POST' })).body;
  const c2 = iphone.get(o2);
  assert.equal((await call('/auth/passkey/signin', { method: 'POST', body: { credential: c2 } })).status, 200);
  assert.equal((await call('/auth/passkey/signin', { method: 'POST', body: { credential: c2 } })).status, 401, 'replayed');
  const o3 = (await call('/auth/passkey/options', { method: 'POST' })).body;
  assert.equal((await call('/auth/passkey/signin', { method: 'POST', body: { credential: iphone.get(o3, { verified: false }) } })).status, 401, 'no face id');

  // the last one can't be removed by an admin; logout ends the session
  const mine = (await call('/me/passkeys', { token: fid.body.session })).body;
  assert.equal(mine.required, true); assert.equal(mine.passkeys.length, 1);
  assert.equal((await call(`/me/passkeys/${mine.passkeys[0].id}`, { method: 'DELETE', token: fid.body.session })).body.error, 'err_last_passkey');
  await call('/auth/logout', { method: 'POST', token: fid.body.session });
  assert.equal((await call('/me', { token: fid.body.session })).status, 401, 'signed out for good');
});

test('guests keep their key, and may add Face ID; the owner can clear it after a lost phone', async () => {
  // the owner signs in through a session made directly here (the first test covered the ceremony)
  const { openSession } = await import('../src/passkeys.js');
  const ownerId = db.prepare('SELECT id FROM users WHERE is_owner = 1').get().id;
  const S = openSession(ownerId);
  const made = await call('/admin/users', { method: 'POST', token: S, body: { name: 'Rita Guest' } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const guestKey = made.body.token, guestId = made.body.id;
  assert.equal((await call('/me', { token: guestKey })).status, 200, 'a guest key works on its own');
  assert.equal((await call('/me/passkeys', { token: guestKey })).body.required, false);

  const phoneB = phone();
  const opts = (await call('/me/passkeys/options', { method: 'POST', token: guestKey })).body;
  assert.equal((await call('/me/passkeys', { method: 'POST', token: guestKey, body: phoneB.create(opts) })).status, 200);
  const o = (await call('/auth/passkey/options', { method: 'POST' })).body;
  const signed = await call('/auth/passkey/signin', { method: 'POST', body: { credential: phoneB.get(o) } });
  assert.equal(signed.body.name, 'Rita Guest');

  // lost phone: the owner clears it; the session ends, the key still works
  assert.equal((await call(`/admin/users/${guestId}/passkeys`, { method: 'DELETE', token: S })).status, 200);
  assert.equal((await call('/me', { token: signed.body.session })).status, 401);
  assert.equal((await call('/me', { token: guestKey })).status, 200);
  assert.equal((await call('/me/passkeys', { token: guestKey })).body.passkeys.length, 0);
});
