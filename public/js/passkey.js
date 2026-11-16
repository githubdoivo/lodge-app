// Face ID / passkeys in the browser (APP-LG-001): turns the server's JSON
// into WebAuthn calls and back. The server checks everything (src/passkeys.js).
const toBuf = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4)), (c) => c.charCodeAt(0));
const toB64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const passkeySupported = () => !!(window.PublicKeyCredential && navigator.credentials);

/** A friendly name for the device being added. */
export const deviceName = () => {
  const u = navigator.userAgent;
  return /iPhone/.test(u) ? 'iphone' : /iPad/.test(u) ? 'ipad' : /Android/.test(u) ? 'android' : /Mac/.test(u) ? 'mac' : /Windows/.test(u) ? 'windows' : 'this device';
};

/** Makes a new passkey from the server's options; returns what the server saves. */
export async function createPasskey(o) {
  const cred = await navigator.credentials.create({ publicKey: {
    ...o, challenge: toBuf(o.challenge), user: { ...o.user, id: toBuf(o.user.id) },
    excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: toBuf(c.id) })),
  } });
  return { name: deviceName(), clientDataJSON: toB64u(cred.response.clientDataJSON), attestationObject: toB64u(cred.response.attestationObject) };
}

/** Signs the server's challenge with a passkey on this phone (Face ID). */
export async function usePasskey(o) {
  const cred = await navigator.credentials.get({ publicKey: {
    ...o, challenge: toBuf(o.challenge),
    ...(o.allowCredentials ? { allowCredentials: o.allowCredentials.map((c) => ({ ...c, id: toBuf(c.id) })) } : {}),
  } });
  return { id: cred.id, clientDataJSON: toB64u(cred.response.clientDataJSON), authenticatorData: toB64u(cred.response.authenticatorData), signature: toB64u(cred.response.signature) };
}
