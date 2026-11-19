// Web Push from the Worker (APP-LG-023): VAPID (RFC 8292) and aes128gcm
// payload encryption (RFC 8291) with WebCrypto, so no Node library is needed.
// Same payload shape as src/push.js: title/body plain or { pt, en }.
const enc = new TextEncoder();
const b64uToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const bytesToB64u = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const concat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

export async function encryptPayload(subscription, text) {
  const uaPub = b64uToBytes(subscription.keys.p256dh);
  const auth = b64uToBytes(subscription.keys.auth);
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, pair.privateKey, 256));
  const prk = await hkdf(auth, secret, concat(enc.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, prk, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, prk, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(enc.encode(text), new Uint8Array([2]))));
  return concat(salt, new Uint8Array([0, 0, 0x10, 0]), new Uint8Array([asPub.length]), asPub, body);
}

async function vapidHeader(env, endpoint) {
  const pub = b64uToBytes(env.VAPID_PUBLIC_KEY);
  const key = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256', d: env.VAPID_PRIVATE_KEY, x: bytesToB64u(pub.slice(1, 33)), y: bytesToB64u(pub.slice(33, 65)),
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = bytesToB64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = bytesToB64u(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || 'mailto:admin@example.com' })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${claims}`)));
  return `vapid t=${head}.${claims}.${bytesToB64u(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

export const pushConfigured = (env) => !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
const localize = (f, lang) => (f && typeof f === 'object' ? f[lang] || f.pt || f.en : f);

async function sendAll(env, rows, payload) {
  let sent = 0, failed = 0;
  await Promise.all(rows.map(async (row) => {
    const lang = row.lang === 'en' ? 'en' : 'pt';
    try {
      const sub = JSON.parse(row.subscription);
      const text = JSON.stringify({ ...payload, title: localize(payload.title, lang), body: localize(payload.body, lang) });
      const res = await fetch(sub.endpoint, {
        method: 'POST',
        headers: { Authorization: await vapidHeader(env, sub.endpoint), 'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream', TTL: '86400' },
        body: await encryptPayload(sub, text),
      });
      if (res.ok) sent++;
      else {
        failed++;
        if (res.status === 404 || res.status === 410) await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(row.endpoint).run();
      }
    } catch (err) { failed++; console.error('[push]', err?.message); }
  }));
  return { sent, failed };
}

const SELECT = 'SELECT s.endpoint, s.subscription, u.lang FROM push_subscriptions s JOIN users u ON u.id = s.user_id';

export async function broadcast(env, payload, { excludeUserId } = {}) {
  if (!pushConfigured(env)) return { sent: 0, failed: 0 };
  const { results } = excludeUserId
    ? await env.DB.prepare(`${SELECT} WHERE u.id != ?`).bind(excludeUserId).all()
    : await env.DB.prepare(SELECT).all();
  return sendAll(env, results, payload);
}

export async function notifyUser(env, userId, payload) {
  if (!pushConfigured(env)) return { sent: 0, failed: 0 };
  const { results } = await env.DB.prepare(`${SELECT} WHERE u.id = ?`).bind(userId).all();
  return sendAll(env, results, payload);
}

export function addPushRoutes({ routes, writes, json }) {
  routes['/api/push/vapid-public-key'] = async (ctx) => json({ publicKey: ctx.env.VAPID_PUBLIC_KEY || null, enabled: pushConfigured(ctx.env) });
  writes['POST /api/push/subscribe'] = async (ctx) => {
    const sub = ctx.body.subscription;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return json({ error: 'err_invalid_subscription' }, 400);
    await ctx.env.DB.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, subscription) VALUES (?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, subscription = excluded.subscription`)
      .bind(ctx.user.id, sub.endpoint, JSON.stringify(sub)).run();
    return json({ ok: true }, 201);
  };
  writes['POST /api/push/unsubscribe'] = async (ctx) => {
    const endpoint = typeof ctx.body.endpoint === 'string' ? ctx.body.endpoint : '';
    if (endpoint) await ctx.env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).run();
    return json({ ok: true });
  };
}
