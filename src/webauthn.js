// The WebAuthn parsing both runtimes share (APP-LG-024): plain JS, no Node
// built-ins, so the Node app (src/passkeys.js) and the Worker
// (src/workerPasskeys.js) read passkeys exactly the same way.

export const b64u = (buf) => {
  const u8 = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const unb64u = (s) => {
  const t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

// Just enough CBOR for attestation objects and COSE keys: returns [value, nextPos].
export function cbor(bytes, pos = 0) {
  const b = bytes[pos++], major = b >> 5, info = b & 31;
  let len = info;
  if (info === 24) len = bytes[pos++];
  else if (info === 25) { len = (bytes[pos] << 8) | bytes[pos + 1]; pos += 2; }
  else if (info === 26) { len = ((bytes[pos] << 24) >>> 0) + (bytes[pos + 1] << 16) + (bytes[pos + 2] << 8) + bytes[pos + 3]; pos += 4; }
  else if (info > 26) throw new Error('cbor');
  if (major === 0) return [len, pos];
  if (major === 1) return [-1 - len, pos];
  if (major === 2) return [bytes.slice(pos, pos + len), pos + len];
  if (major === 3) return [new TextDecoder().decode(bytes.slice(pos, pos + len)), pos + len];
  if (major === 4) { const a = []; for (let i = 0; i < len; i++) { let v; [v, pos] = cbor(bytes, pos); a.push(v); } return [a, pos]; }
  if (major === 5) { const m = new Map(); for (let i = 0; i < len; i++) { let k, v; [k, pos] = cbor(bytes, pos); [v, pos] = cbor(bytes, pos); m.set(k, v); } return [m, pos]; }
  if (major === 7) return [info === 21 ? true : info === 20 ? false : null, pos];
  throw new Error('cbor');
}

export function coseToJwk(m) {
  if (m.get(1) === 2 && m.get(3) === -7) return { alg: -7, jwk: { kty: 'EC', crv: 'P-256', x: b64u(m.get(-2)), y: b64u(m.get(-3)), ext: true } };
  if (m.get(1) === 3 && m.get(3) === -257) return { alg: -257, jwk: { kty: 'RSA', n: b64u(m.get(-1)), e: b64u(m.get(-2)), alg: 'RS256', ext: true } };
  throw new Error('unsupported_key');
}

// ECDSA signatures come DER-wrapped; WebCrypto wants r||s, 32 bytes each.
export function derToRaw(der) {
  let p = 2; if (der[1] & 0x80) p += der[1] & 0x7f;
  const part = () => { p++; const n = der[p++]; let v = der.slice(p, p + n); p += n; while (v.length > 32 && v[0] === 0) v = v.slice(1); const o = new Uint8Array(32); o.set(v, 32 - v.length); return o; };
  const r = part(), s = part(), out = new Uint8Array(64); out.set(r); out.set(s, 32); return out;
}

/** The new passkey inside an attestation: credential id, public key, counter, and the authenticator data. */
export function readAttestation(attestationObject) {
  const [att] = cbor(unb64u(attestationObject));
  const ad = att.get('authData');
  if (!(ad[32] & 0x40)) throw new Error('no_key');
  const idLen = (ad[53] << 8) | ad[54], credId = b64u(ad.slice(55, 55 + idLen));
  const [cose] = cbor(ad, 55 + idLen);
  const { alg, jwk } = coseToJwk(cose);
  const counter = ((ad[33] << 24) >>> 0) + (ad[34] << 16) + (ad[35] << 8) + ad[36];
  return { ad, credId, alg, jwk, counter };
}

/** The site as the browser sees it, from the request's URL. */
export function siteOfUrl(url) {
  const u = new URL(url);
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  return { rpId: u.hostname, origin: local ? `http://${u.host}` : `https://${u.host}`, local };
}

export const originOk = (site, origin) =>
  origin === site.origin || (site.local && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
