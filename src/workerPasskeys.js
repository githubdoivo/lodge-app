// Face ID / passkeys on the Worker (APP-LG-024): the same routes and checks as
// src/passkeys.js + src/routes.js, on D1 and WebCrypto.
//
// Owner and admins need Face ID off the demo: their key alone is answered with
// a passkey step, and /auth/passkey/finish opens a session (s.<hex>). On the
// demo nobody needs it, so anyone may add Face ID to the account they use and
// sign in with it; the daily reset removes it with the people (ON DELETE CASCADE).
import { b64u, unb64u, readAttestation, derToRaw, siteOfUrl, originOk } from './webauthn.js';

const CHALLENGE_MS = 5 * 60 * 1000;
const enc = (s) => new TextEncoder().encode(s);
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
const countPasskeys = async (DB, userId) => (await DB.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').bind(userId).first()).n;

export const passkeyRequired = (env, user) => env.APP_ENV !== 'demo' && !!(user.is_admin || user.is_owner);

async function newChallenge(DB, userId = null) {
  const c = b64u(crypto.getRandomValues(new Uint8Array(32)));
  await DB.batch([
    DB.prepare('DELETE FROM passkey_challenges WHERE expires < ?').bind(Date.now()),
    DB.prepare('INSERT INTO passkey_challenges (challenge, user_id, expires) VALUES (?, ?, ?)').bind(c, userId, Date.now() + CHALLENGE_MS),
  ]);
  return c;
}

// clientDataJSON (type, our one-time challenge, our origin) and the authenticator
// data (our site; the person was present and verified, i.e. Face ID).
async function checkClient(DB, site, clientDataB64, authData, type, userId) {
  const cd = JSON.parse(new TextDecoder().decode(unb64u(clientDataB64)));
  if (cd.type !== type || !originOk(site, cd.origin)) throw new Error('bad_client');
  const ch = await DB.prepare('SELECT * FROM passkey_challenges WHERE challenge = ?').bind(String(cd.challenge)).first();
  if (!ch || ch.expires < Date.now() || (userId != null && ch.user_id !== userId)) throw new Error('bad_challenge');
  // Used once: of two requests with the same challenge, only the one that deletes it goes on.
  const del = await DB.prepare('DELETE FROM passkey_challenges WHERE challenge = ?').bind(String(cd.challenge)).run();
  if (!del.meta.changes) throw new Error('bad_challenge');
  const rpHash = await sha256(enc(site.rpId));
  if (!rpHash.every((v, i) => v === authData[i])) throw new Error('bad_rp');
  if ((authData[32] & 0x05) !== 0x05) throw new Error('not_verified');
}

async function registrationOptions(DB, site, user) {
  const { results: mine } = await DB.prepare('SELECT id FROM passkeys WHERE user_id = ?').bind(user.id).all();
  return {
    challenge: await newChallenge(DB, user.id),
    rp: { name: 'lodgedoivo', id: site.rpId },
    user: { id: b64u(enc(`lodge-${user.id}`)), name: user.name, displayName: user.name },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    timeout: 300000, attestation: 'none',
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    excludeCredentials: mine.map((m) => ({ type: 'public-key', id: m.id })),
  };
}

async function savePasskey(DB, site, user, body) {
  const { ad, credId, alg, jwk, counter } = readAttestation(body?.attestationObject);
  await checkClient(DB, site, body.clientDataJSON, ad, 'webauthn.create', user.id);
  const name = String(body.name || '').trim().slice(0, 40) || 'face id';
  await DB.prepare('INSERT INTO passkeys (id, user_id, jwk, alg, counter, name) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(credId, user.id, JSON.stringify(jwk), alg, counter, name).run();
  return { id: credId, name };
}

async function signInOptions(DB, site, userId = null) {
  const allow = userId == null ? [] : (await DB.prepare('SELECT id FROM passkeys WHERE user_id = ?').bind(userId).all()).results.map((p) => ({ type: 'public-key', id: p.id }));
  return { challenge: await newChallenge(DB, userId), rpId: site.rpId, timeout: 300000, userVerification: 'required', ...(allow.length ? { allowCredentials: allow } : {}) };
}

/** The account a passkey signature proves, or null. With userId, the passkey must be theirs. */
async function verifySignIn(DB, site, body, userId = null) {
  try {
    const pk = await DB.prepare('SELECT * FROM passkeys WHERE id = ?').bind(String(body?.id || '')).first();
    if (!pk || (userId != null && pk.user_id !== userId)) return null;
    const ad = unb64u(body.authenticatorData), cdRaw = unb64u(body.clientDataJSON);
    await checkClient(DB, site, body.clientDataJSON, ad, 'webauthn.get', userId);
    const signed = new Uint8Array(ad.length + 32);
    signed.set(ad); signed.set(await sha256(cdRaw), ad.length);
    const ec = pk.alg === -7, sig = unb64u(body.signature);
    const key = await crypto.subtle.importKey('jwk', JSON.parse(pk.jwk), ec ? { name: 'ECDSA', namedCurve: 'P-256' } : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify(ec ? { name: 'ECDSA', hash: 'SHA-256' } : 'RSASSA-PKCS1-v1_5', key, ec ? derToRaw(sig) : sig, signed);
    if (!ok) return null;
    await DB.prepare("UPDATE passkeys SET used_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?").bind(pk.id).run();
    return pk.user_id;
  } catch {
    return null;
  }
}

async function openSession(env, hashToken, userId) {
  const hex = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const token = `s.${hex}`;   // lowercase: keys are lowercased on every request
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id) VALUES (?, ?)').bind(await hashToken(env.TOKEN_SECRET, token), userId).run();
  return token;
}

export function addPasskeyRoutes({ routes, writes, writeDyn, publicKeys, json, hashToken, findUser, ownerOnly }) {
  const site = (ctx) => siteOfUrl(ctx.request.url);
  const signedIn = async (ctx, user) => json({ session: await openSession(ctx.env, hashToken, user.id), id: user.id, name: user.name, isAdmin: !!user.is_admin });

  /** Used by /auth/login: the Face ID step the owner and admins get instead of a plain yes. */
  const loginStep = async (ctx, user) => {
    const has = (await countPasskeys(ctx.env.DB, user.id)) > 0;
    return json({ step: 'passkey', mode: has ? 'get' : 'create', options: has ? await signInOptions(ctx.env.DB, site(ctx), user.id) : await registrationOptions(ctx.env.DB, site(ctx), user) });
  };

  // The second half of a key sign-in: the key again, plus Face ID. A new passkey
  // can be added this way only while the account has none.
  writes['POST /api/auth/passkey/finish'] = async (ctx) => {
    const token = (typeof ctx.body.token === 'string' ? ctx.body.token : '').trim().toLowerCase();
    const user = token && !token.startsWith('s.') && ctx.env.TOKEN_SECRET ? await findUser(ctx.env, token) : null;
    if (!user) return json({ error: 'err_token_invalid' }, 401);
    const has = (await countPasskeys(ctx.env.DB, user.id)) > 0;
    let ok = false;
    if (ctx.body.mode === 'create' && !has) {
      try { await savePasskey(ctx.env.DB, site(ctx), user, ctx.body.credential || {}); ok = true; } catch { ok = false; }
    } else {
      ok = (await verifySignIn(ctx.env.DB, site(ctx), ctx.body.credential, user.id)) === user.id;
    }
    if (!ok) return json({ error: 'err_passkey_failed' }, 401);
    return signedIn(ctx, user);
  };
  // Signing in with Face ID alone: the phone picks the account.
  writes['POST /api/auth/passkey/options'] = async (ctx) => json(await signInOptions(ctx.env.DB, site(ctx)));
  writes['POST /api/auth/passkey/signin'] = async (ctx) => {
    if (!ctx.env.TOKEN_SECRET) return json({ error: 'err_server' }, 500);
    const userId = await verifySignIn(ctx.env.DB, site(ctx), ctx.body.credential);
    const user = userId && await ctx.env.DB.prepare('SELECT id, name, is_admin FROM users WHERE id = ?').bind(userId).first();
    if (!user) return json({ error: 'err_passkey_failed' }, 401);
    return signedIn(ctx, user);
  };
  for (const k of ['POST /api/auth/passkey/finish', 'POST /api/auth/passkey/options', 'POST /api/auth/passkey/signin']) publicKeys.add(k);

  // My Face ID passkeys: list, add, remove.
  routes['/api/me/passkeys'] = async (ctx) => {
    const { results } = await ctx.env.DB.prepare('SELECT id, name, created_at, used_at FROM passkeys WHERE user_id = ? ORDER BY created_at').bind(ctx.user.id).all();
    return json({ passkeys: results, required: passkeyRequired(ctx.env, ctx.user), available: true });
  };
  writes['POST /api/me/passkeys/options'] = async (ctx) => json(await registrationOptions(ctx.env.DB, site(ctx), ctx.user));
  writes['POST /api/me/passkeys'] = async (ctx) => {
    try { return json({ ok: true, ...(await savePasskey(ctx.env.DB, site(ctx), ctx.user, ctx.body)) }); }
    catch { return json({ error: 'err_passkey_failed' }, 400); }
  };
  writeDyn.push(['DELETE', /^\/api\/me\/passkeys\/([^/]+)$/, async (ctx, m) => {
    const n = await countPasskeys(ctx.env.DB, ctx.user.id);
    if (n <= 1 && passkeyRequired(ctx.env, ctx.user)) return json({ error: 'err_last_passkey' }, 400);
    await ctx.env.DB.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').bind(decodeURIComponent(m[1]), ctx.user.id).run();
    return json({ ok: true });
  }]);

  // Lost phone: the owner clears someone's Face ID and ends their sessions.
  writes['DELETE /api/admin/users/:id/passkeys'] = async (ctx) => {
    const off = ownerOnly(ctx); if (off) return off;
    if (!(await ctx.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(ctx.id).first())) return json({ error: 'err_user_not_found' }, 404);
    await ctx.env.DB.batch([
      ctx.env.DB.prepare('DELETE FROM passkeys WHERE user_id = ?').bind(ctx.id),
      ctx.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(ctx.id),
    ]);
    return json({ ok: true });
  };

  return { loginStep };
}
