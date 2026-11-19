// Face ID / passkeys (APP-LG-001): WebAuthn checked here, no library.
//
// A passkey is a key pair kept by the phone; the server stores only the
// public key. Signing in proves the phone holds the private key by signing a
// one-time challenge (5 minutes, used once). Ported from boarddoivo's own
// checks so both apps behave the same.
//
// Signing in with a passkey (or confirming a key sign-in with one) opens a
// session: a random token the browser keeps in place of the key. Only its
// hash is stored, the same way keys are.
import { randomBytes, createHash, webcrypto } from 'node:crypto';
import db from './db.js';
import { hashToken } from './tokens.js';
import { isFaceIdTryout } from './demo.js';
import { cbor, coseToJwk, derToRaw } from './webauthn.js';   // shared with the Worker (APP-LG-024)

const { subtle } = webcrypto;
const CHALLENGE_MS = 5 * 60 * 1000;

export const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const unb64u = (s) => new Uint8Array(Buffer.from(String(s || ''), 'base64url'));

/** Owners and admins must use a passkey; the public demo and older test suites switch it off. */
// On the demo, only a visitor's own Face ID tryout admin needs one (src/demo.js).
export function passkeyRequired(user) {
  if (process.env.DEMO_MODE === 'true') return !!user && isFaceIdTryout(user.id);
  if (process.env.ADMIN_PASSKEY === 'off') return false;
  return !!(user && (user.is_admin || user.is_owner || user.isAdmin || user.isOwner));
}

/** Our site as the browser sees it: the host the request came to, and its origin. */
export function siteOf(req) {
  const host = String(req.get('host') || '').toLowerCase();
  const hostname = host.replace(/:\d+$/, '');
  const local = hostname === 'localhost' || hostname === '127.0.0.1';
  return { rpId: hostname, origin: `${local ? 'http' : 'https'}://${host}`, local };
}

export function newChallenge(userId = null) {
  const c = b64u(randomBytes(32));
  db.prepare('DELETE FROM passkey_challenges WHERE expires < ?').run(Date.now());
  db.prepare('INSERT INTO passkey_challenges (challenge, user_id, expires) VALUES (?, ?, ?)').run(c, userId, Date.now() + CHALLENGE_MS);
  return c;
}

// clientDataJSON (type, our one-time challenge, our origin) and the
// authenticator data (our site; the person was present and verified, i.e. Face ID).
function checkClient(site, clientDataB64, authData, type, userId) {
  const cd = JSON.parse(new TextDecoder().decode(unb64u(clientDataB64)));
  const originOk = cd.origin === site.origin || (site.local && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(cd.origin));
  if (cd.type !== type || !originOk) throw new Error('bad_client');
  const ch = db.prepare('SELECT * FROM passkey_challenges WHERE challenge = ?').get(String(cd.challenge));
  if (!ch || ch.expires < Date.now() || (userId != null && ch.user_id !== userId)) throw new Error('bad_challenge');
  db.prepare('DELETE FROM passkey_challenges WHERE challenge = ?').run(String(cd.challenge));
  const rpHash = createHash('sha256').update(site.rpId).digest();
  if (!rpHash.every((v, i) => v === authData[i])) throw new Error('bad_rp');
  if ((authData[32] & 0x05) !== 0x05) throw new Error('not_verified');   // user present + verified
}

/** Options for adding a passkey to this account. */
export function registrationOptions(req, user) {
  const mine = db.prepare('SELECT id FROM passkeys WHERE user_id = ?').all(user.id);
  return {
    challenge: newChallenge(user.id),
    rp: { name: 'lodgedoivo', id: siteOf(req).rpId },
    user: { id: b64u(Buffer.from(`lodge-${user.id}`)), name: user.name, displayName: user.name },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    timeout: 300000, attestation: 'none',
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    excludeCredentials: mine.map((m) => ({ type: 'public-key', id: m.id })),
  };
}

/** Saves a new passkey for this account; throws if anything doesn't check out. */
export function savePasskey(req, user, body) {
  const [att] = cbor(unb64u(body?.attestationObject));
  const ad = att.get('authData');
  checkClient(siteOf(req), body.clientDataJSON, ad, 'webauthn.create', user.id);
  if (!(ad[32] & 0x40)) throw new Error('no_key');
  const idLen = (ad[53] << 8) | ad[54], credId = b64u(ad.slice(55, 55 + idLen));
  const [cose] = cbor(ad, 55 + idLen);
  const { alg, jwk } = coseToJwk(cose);
  const counter = ((ad[33] << 24) >>> 0) + (ad[34] << 16) + (ad[35] << 8) + ad[36];
  const name = String(body.name || '').trim().slice(0, 40) || 'face id';
  db.prepare('INSERT INTO passkeys (id, user_id, jwk, alg, counter, name) VALUES (?, ?, ?, ?, ?, ?)').run(credId, user.id, JSON.stringify(jwk), alg, counter, name);
  return { id: credId, name };
}

/** Options for signing in: any passkey on this phone (signed out), or only this account's. */
export function signInOptions(req, userId = null) {
  const allow = userId == null ? [] : db.prepare('SELECT id FROM passkeys WHERE user_id = ?').all(userId).map((p) => ({ type: 'public-key', id: p.id }));
  return { challenge: newChallenge(userId), rpId: siteOf(req).rpId, timeout: 300000, userVerification: 'required', ...(allow.length ? { allowCredentials: allow } : {}) };
}

/** The account a passkey signature proves, or null. With userId, the passkey must be theirs. */
export async function verifySignIn(req, body, userId = null) {
  try {
    const pk = db.prepare('SELECT * FROM passkeys WHERE id = ?').get(String(body?.id || ''));
    if (!pk || (userId != null && pk.user_id !== userId)) return null;
    const ad = unb64u(body.authenticatorData), cdRaw = unb64u(body.clientDataJSON);
    checkClient(siteOf(req), body.clientDataJSON, ad, 'webauthn.get', userId);
    const signed = new Uint8Array(ad.length + 32);
    signed.set(ad); signed.set(createHash('sha256').update(cdRaw).digest(), ad.length);
    const ec = pk.alg === -7, sig = unb64u(body.signature);
    const key = await subtle.importKey('jwk', JSON.parse(pk.jwk), ec ? { name: 'ECDSA', namedCurve: 'P-256' } : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await subtle.verify(ec ? { name: 'ECDSA', hash: 'SHA-256' } : 'RSASSA-PKCS1-v1_5', key, ec ? derToRaw(sig) : sig, signed);
    if (!ok) return null;
    db.prepare("UPDATE passkeys SET used_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?").run(pk.id);
    return pk.user_id;
  } catch {
    return null;
  }
}

/** Opens a session: the browser keeps this token in place of the key. */
export function openSession(userId) {
  const token = `s.${randomBytes(32).toString('hex')}`;   // lowercase: keys are lowercased on every request
  db.prepare('INSERT INTO sessions (token_hash, user_id) VALUES (?, ?)').run(hashToken(token), userId);
  return token;
}
export const isSessionToken = (token) => String(token || '').startsWith('s.');
export function endSessions(userId) { db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId); }
export function endSession(token) { db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token)); }
