// Key-guessing guard on the Worker, same budget as src/rateLimit.js on Node:
// 10 failed tries per address per 15 minutes, shared by every place a key can
// be tried (sign-in, a key in the Authorization header, change-key, claim-key).
// Kept in D1 so every Worker isolate sees the same count. Only failures are
// counted, and a blocked address is refused before the key is even checked,
// so a right guess during the lock-out tells the guesser nothing.
// The table is made here on first use: D1 migrations are not run by the deploy.
export const WINDOW_MS = 15 * 60 * 1000;
// 30 wrong keys per address per 15 minutes (Ivo, 20 Nov 2026): a guest's key is name + 6 digits, so a
// guesser still needs ~170 days on average, while one guest's typos rarely lock out the house Wi-Fi.
export const MAX_FAILS = 30;

const ready = new WeakSet(); // the D1 bindings whose table is known to exist
const ensureTable = async (DB) => {
  if (ready.has(DB)) return;
  await DB.prepare('CREATE TABLE IF NOT EXISTS auth_attempts (ip TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL)').run();
  ready.add(DB);
};

export const clientIp = (request) => request.headers.get('cf-connecting-ip') || 'unknown';

/** Seconds left on the lock-out for this address, or 0 when it may try. */
export async function lockedFor(env, ip) {
  await ensureTable(env.DB);
  const row = await env.DB.prepare('SELECT count, reset_at FROM auth_attempts WHERE ip = ?').bind(ip).first();
  const now = Date.now();
  if (!row || row.reset_at <= now || row.count < MAX_FAILS) return 0;
  return Math.ceil((row.reset_at - now) / 1000);
}

/** One failed try: a fresh 15-minute window when the old one is over. */
export async function countFail(env, ip) {
  await ensureTable(env.DB);
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO auth_attempts (ip, count, reset_at) VALUES (?1, 1, ?2)
    ON CONFLICT(ip) DO UPDATE SET
      count = CASE WHEN reset_at <= ?3 THEN 1 ELSE count + 1 END,
      reset_at = CASE WHEN reset_at <= ?3 THEN ?2 ELSE reset_at END`).bind(ip, now + WINDOW_MS, now).run();
  // Old windows are no use to anyone; drop them as we go.
  await env.DB.prepare('DELETE FROM auth_attempts WHERE reset_at <= ?').bind(now).run();
}

export const tooMany = (json, retryAfter) => {
  const res = json({ error: 'err_rate_limited', retryAfter }, 429);
  res.headers.set('Retry-After', String(retryAfter));
  return res;
};
