// Cloudflare Worker for Lodge: API from D1 (reads APP-LG-011, sign-in and
// first writes APP-LG-012). Pages are served by the assets binding; only
// /api/* reaches this file. Writes not ported yet answer 405.
import pkg from '../package.json' with { type: 'json' };
import { validatePostContent, POST_TYPES } from './plaza-rules.js';
import { FURNISHED_OBJECTS, SWAMP_BEINGS } from './pseudonyms.js';
import { isNight, DEFAULT_NIGHT, NIGHTS } from './nights.js';
import { addMemoRoutes } from './workerMemo.js';
import { addVotesRoutes, ensureVoteRounds } from './workerVotes.js';
import { addPushRoutes, broadcast, notifyUser } from './workerPush.js';
import { addPasskeyRoutes, passkeyRequired } from './workerPasskeys.js';
import { clientIp, lockedFor, countFail, tooMany } from './workerRateLimit.js';
import { MOCK_NAMES, PRESET_ADMIN_NAME, DEMO_GUEST_NAME, generateDemoUserToken, tokenBase } from './demoUsers.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

async function hashToken(secret, token) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(token)));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Same format as encryptToken() in src/tokens.js (AES-256-GCM, key = sha256(secret),
// iv:tag:ciphertext in base64), so the Node app can read keys the Worker writes.
async function encryptToken(secret, token) {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(String(token))));
  const b64 = (u8) => btoa(String.fromCharCode(...u8));
  return `${b64(iv)}:${b64(out.slice(-16))}:${b64(out.slice(0, -16))}`;
}

// Demo only: an empty D1 gets the demo people (same names and keys as the Fly
// demo, src/seedDemo.js), so nobody has to run a D1 command. Each insert skips
// a name already there, so two first requests at once can't double anyone up.
let demoSeeded = false;
export async function ensureDemoUsers(env) {
  if (demoSeeded || env.APP_ENV !== 'demo' || !env.TOKEN_SECRET) return;
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE is_owner = 0').first();
  if (n === 0) {
    const stmts = [];
    for (const name of MOCK_NAMES) {
      const key = generateDemoUserToken(name);
      stmts.push(env.DB.prepare(
        `INSERT INTO users (name, token_hash, token_enc, is_admin, updated_at)
         SELECT ?, ?, ?, ?, ${now} WHERE NOT EXISTS (SELECT 1 FROM users WHERE name = ?)`)
        .bind(name, await hashToken(env.TOKEN_SECRET, key), await encryptToken(env.TOKEN_SECRET, key), name === PRESET_ADMIN_NAME ? 1 : 0, name));
    }
    await env.DB.batch(stmts);
    await seedDemoContent(env);
  }
  demoSeeded = true;
}

// Sample posts and games for a freshly seeded demo (mirrors src/seedDemo.js), so
// Wall, Rata and Snatch are not empty after each reset. Authors and entrants are
// looked up by name; a single batch keeps it all-or-nothing.
const SAMPLE_PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
const SAMPLE_CONSEQUENCES = ['Give the closest person a pedicure.', 'Confess the last time you lied.',
  'Let the nearest person pick an accessory for you to wear the rest of the night.',
  "Sit on someone's lap until the next consequence drops.", 'Use your best pickup line on a stranger in the room.'];
const SAMPLE_PERSONAS = {
  furnished: ['Velvet Armchair', 'Grandfather Clock', 'Lava Lamp', 'Persian Rug', 'Crystal Chandelier'],
  swamp: ['Bog Spirit', 'Firefly', 'Mossy Toad', "Will-o'-the-Wisp", 'Lily Pad'],
};
const SAMPLE_LINKS = [['📃', 'Form', 'https://www.google.com/forms/about/'], ['🏠', 'Location', 'https://www.google.com/maps/search/?api=1&query=Braga%2C+Portugal'],
  ['🎹', 'Playlist', 'https://open.spotify.com/'], ['📷', 'Album', 'https://photos.google.com/']];
export async function seedDemoContent(env) {
  const DB = env.DB;
  // Whoever claims this row seeds; a request racing in at the same moment gets 0 changes and skips.
  const claim = await DB.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('demo_content_seeded', '1')`).run();
  if (!claim.meta?.changes) return;
  const day = await votingDay(env);
  const uid = (name) => '(SELECT id FROM users WHERE name = ?)';
  const author = MOCK_NAMES[0];
  const stmts = [];
  const post = (type, text) => DB.prepare(`INSERT INTO plaza_posts (type, author_id, text) VALUES (?, ${uid()}, ?)`).bind(type, author, text);
  const last = '(SELECT MAX(id) FROM plaza_posts)';
  stmts.push(post('announcement', 'Boas-vindas à festa, a password do wifi é party-wifi-2026.'));
  stmts.push(post('poll', 'Qual foi o melhor momento da noite até agora?'));
  ['Rata', 'Snatch', 'Plaza', 'Ainda não sei'].forEach((label, i) =>
    stmts.push(DB.prepare(`INSERT INTO plaza_poll_options (post_id, label, position) VALUES (${last}, ?, ?)`).bind(label, i)));
  stmts.push(post('links', 'useful links 🔗'));
  SAMPLE_LINKS.forEach(([emoji, label, url], i) =>
    stmts.push(DB.prepare(`INSERT INTO plaza_link_items (post_id, emoji, label, url, position) VALUES (${last}, ?, ?, ?, ?)`).bind(emoji, label, url, i)));
  stmts.push(DB.prepare(`INSERT INTO consequences (user_id, text, day, status, revealed_at) VALUES (${uid()}, ?, ?, 'used', ${now})`)
    .bind(MOCK_NAMES[0], 'Act like a rat for 5 minutes.', day));
  SAMPLE_CONSEQUENCES.forEach((text, i) =>
    stmts.push(DB.prepare(`INSERT INTO consequences (user_id, text, day) VALUES (${uid()}, ?, ?)`).bind(MOCK_NAMES[(i + 1) % MOCK_NAMES.length], text, day)));
  NIGHTS.forEach((night, i) => SAMPLE_PERSONAS[night].forEach((persona, j) =>
    stmts.push(DB.prepare(`INSERT INTO contestants (name, night, user_id, photo, photo_mime, confirmed_at) VALUES (?, ?, ${uid()}, ?, 'image/png', datetime('now'))`)
      .bind(persona, night, MOCK_NAMES[i * 5 + j], SAMPLE_PNG))));
  await DB.batch(stmts);
}
export const resetDemoSeedFlag = () => { demoSeeded = false; };

const USER_COLUMNS = 'id, name, is_admin, is_owner, tutorial_seen, lang, key_claimed_at, logo_customized';

const now = "strftime('%Y-%m-%d %H:%M:%f', 'now')";
const isSessionToken = (t) => String(t || '').startsWith('s.');

// Owner and admins confirm with Face ID outside the demo: passkeyRequired() and
// the passkey routes are in src/workerPasskeys.js (APP-LG-024).

// Same as findUserByToken() in src/auth.js: a Face ID session (s.<hex>) or a key.
async function findUser(env, token) {
  const hash = await hashToken(env.TOKEN_SECRET, token);
  if (isSessionToken(token)) {
    const cols = USER_COLUMNS.split(', ').map((c) => 'u.' + c).join(', ');
    const row = await env.DB.prepare(`SELECT ${cols} FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).bind(hash).first();
    return row ? { ...row, viaPasskey: true } : null;
  }
  return env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE token_hash = ?`).bind(hash).first();
}

const stampClaimed = (env, id) => env.DB.prepare(
  `UPDATE users SET key_claimed_at = COALESCE(key_claimed_at, ${now}) WHERE id = ?`).bind(id).run();

// Same rule as src/auth.js: Bearer header (or ?token=), lowercased, HMAC-hashed.
async function authenticate(request, env, url) {
  const header = request.headers.get('authorization') || '';
  const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : url.searchParams.get('token');
  if (!raw) return { error: json({ error: 'err_token_missing' }, 401) };
  if (!env.TOKEN_SECRET) return { error: json({ error: 'err_server' }, 500) };
  const token = String(raw).trim().toLowerCase();
  // A key (not a random session) in the header is a guess like any sign-in: same budget.
  const guessable = !isSessionToken(token);
  const ip = clientIp(request);
  if (guessable) { const wait = await lockedFor(env, ip); if (wait) return { error: tooMany(json, wait) }; }
  const user = await findUser(env, token);
  if (!user) {
    if (guessable) await countFail(env, ip);
    return { error: json({ error: 'err_token_invalid' }, 401) };
  }
  if (!user.viaPasskey && passkeyRequired(env, user)) return { error: json({ error: 'err_passkey_required' }, 401) };
  if (!user.key_claimed_at) await stampClaimed(env, user.id);
  return { user, token };
}

const readBody = async (request) => {
  try { const b = await request.json(); return b && typeof b === 'object' ? b : {}; } catch { return {}; }
};

async function plazaPosts(env, userId) {
  const { results: posts } = await env.DB.prepare(`
    SELECT p.id, p.type, p.text, p.pinned_at AS pinnedAt, p.created_at, u.name AS author,
           (p.photo IS NOT NULL) AS hasPhoto
    FROM plaza_posts p JOIN users u ON u.id = p.author_id
    ORDER BY (p.pinned_at IS NULL) ASC, p.pinned_at DESC, p.created_at DESC, p.id DESC`).all();
  const { results: options } = await env.DB.prepare(`
    SELECT o.id, o.post_id, o.label, COUNT(v.id) AS votes
    FROM plaza_poll_options o LEFT JOIN plaza_poll_votes v ON v.option_id = o.id
    GROUP BY o.id ORDER BY o.position ASC, o.id ASC`).all();
  const { results: links } = await env.DB.prepare(
    'SELECT id, post_id, emoji, label, url FROM plaza_link_items ORDER BY position ASC, id ASC').all();
  const { results: mine } = await env.DB.prepare(
    'SELECT post_id, option_id FROM plaza_poll_votes WHERE user_id = ?').bind(userId).all();
  const strip = ({ post_id, ...rest }) => rest; // eslint-disable-line no-unused-vars
  return posts.map((p) => {
    if (p.type === 'links') return { ...p, links: links.filter((l) => l.post_id === p.id).map(strip) };
    if (p.type !== 'poll') return p;
    const v = mine.find((m) => m.post_id === p.id);
    return { ...p, options: options.filter((o) => o.post_id === p.id).map(strip), myOptionId: v ? v.option_id : null };
  });
}

const REVEALED = `
  SELECT c.id, c.text, c.revealed_at, u.name AS author,
         c.assigned_user_id, a.name AS assignedName, c.done_at, c.approved_at
  FROM consequences c JOIN users u ON u.id = c.user_id
  LEFT JOIN users a ON a.id = c.assigned_user_id
  WHERE c.status = 'used' ORDER BY c.revealed_at DESC`;

const routes = {
  '/api/version': async (ctx) => json({ version: pkg.version, env: ctx.env.APP_ENV || null, runtime: 'worker' }),
  // The shared logins the demo's sign-in screen offers (src/demo.js demoKeys()).
  '/api/demo': async (ctx) => json({ partyOn: await claimOpen(ctx.env), keys: ctx.env.APP_ENV !== 'demo' ? [] : [
    { role: 'guest', name: DEMO_GUEST_NAME, key: generateDemoUserToken(DEMO_GUEST_NAME) },
    { role: 'admin', name: PRESET_ADMIN_NAME, key: generateDemoUserToken(PRESET_ADMIN_NAME) },
  ] }),
  '/api/me': async (ctx) => json({
    ...ctx.user,
    // Same shape as the Node server (src/auth.js): the app reads these.
    isAdmin: !!ctx.user.is_admin,
    isOwner: !!ctx.user.is_owner,
    tutorialSeen: !!ctx.user.tutorial_seen,
    logo_customized: !!ctx.user.logo_customized,
    plazaEnabled: ctx.env.ENABLE_PLAZA === 'true',
    adminPromotionEnabled: ctx.env.ENABLE_ADMIN_PROMOTION === 'true',
  }),
  '/api/plaza-posts': async (ctx) => {
    if (ctx.env.ENABLE_PLAZA !== 'true') return json({ error: 'err_not_found' }, 404);
    return json({ posts: await plazaPosts(ctx.env, ctx.user.id) });
  },
  '/api/consequences/current': async (ctx) => {
    const { results } = await ctx.env.DB.prepare(`${REVEALED} LIMIT 1`).all();
    const pending = await ctx.env.DB.prepare(`SELECT COUNT(*) AS n FROM consequences WHERE status = 'pending'`).first();
    return json({ current: results[0] || null, pending: pending.n });
  },
  '/api/consequences/revealed': async (ctx) => {
    const { results } = await ctx.env.DB.prepare(REVEALED).all();
    return json({ consequences: results });
  },
  '/api/users/basic': async (ctx) => {
    const { results } = await ctx.env.DB.prepare(
      'SELECT id, name FROM users WHERE id != ? ORDER BY name COLLATE NOCASE').bind(ctx.user.id).all();
    return json(results);
  },
};

const plazaOff = (ctx) => (ctx.env.ENABLE_PLAZA !== 'true' ? json({ error: 'err_not_found' }, 404) : null);
const adminOnly = (ctx) => (!ctx.user.is_admin && !ctx.user.is_owner ? json({ error: 'err_admin_only' }, 403) : null);
const ownerOnly =(ctx) => (!ctx.user.is_owner ? json({ error: 'err_owner_only' }, 403) : null);
const postExists = (ctx, id) => ctx.env.DB.prepare('SELECT id, type FROM plaza_posts WHERE id = ?').bind(id).first();

// Writes, by "METHOD path"; :id is the number in the path.
const writes = {
  // Sign-in (src/routes.js /auth/login): case-insensitive key, stamps the claim.
  'POST /api/auth/login': async (ctx) => {
    const token = (typeof ctx.body.token === 'string' ? ctx.body.token : '').trim().toLowerCase();
    if (!token) return json({ error: 'err_token_missing' }, 400);
    if (!ctx.env.TOKEN_SECRET) return json({ error: 'err_server' }, 500);
    const wait = await lockedFor(ctx.env, ctx.ip);
    if (wait) return tooMany(json, wait);
    const user = await findUser(ctx.env, token);
    if (!user) { await countFail(ctx.env, ctx.ip); return json({ error: 'err_token_invalid' }, 401); }
    await stampClaimed(ctx.env, user.id);
    // Owner and admins: the key alone opens nothing; Face ID confirms it (or is added now, once).
    if (!user.viaPasskey && passkeyRequired(ctx.env, user)) return passkeys.loginStep(ctx, user);
    return json({ id: user.id, name: user.name, isAdmin: !!user.is_admin });
  },
  'POST /api/auth/logout': async (ctx) => {
    if (isSessionToken(ctx.token)) {
      await ctx.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await hashToken(ctx.env.TOKEN_SECRET, ctx.token)).run();
    }
    return json({ ok: true });
  },
  'POST /api/me/tutorial-seen': async (ctx) => {
    await ctx.env.DB.prepare('UPDATE users SET tutorial_seen = 1 WHERE id = ?').bind(ctx.user.id).run();
    return json({ ok: true });
  },
  'POST /api/me/lang': async (ctx) => {
    const lang = ctx.body.lang === 'en' ? 'en' : 'pt';
    await ctx.env.DB.prepare('UPDATE users SET lang = ? WHERE id = ?').bind(lang, ctx.user.id).run();
    return json({ ok: true });
  },
  // Wall (internal name plaza): vote, pin, delete - same rules as src/plaza.js.
  'POST /api/plaza-posts/:id/vote': async (ctx) => {
    const off = plazaOff(ctx); if (off) return off;
    const post = await postExists(ctx, ctx.id);
    if (!post) return json({ error: 'err_post_not_found' }, 400);
    if (post.type !== 'poll') return json({ error: 'err_not_a_poll' }, 400);
    const opt = await ctx.env.DB.prepare('SELECT id FROM plaza_poll_options WHERE id = ? AND post_id = ?').bind(Number(ctx.body.optionId), ctx.id).first();
    if (!opt) return json({ error: 'err_invalid_option' }, 400);
    try {
      await ctx.env.DB.prepare('INSERT INTO plaza_poll_votes (post_id, option_id, user_id) VALUES (?, ?, ?)').bind(ctx.id, opt.id, ctx.user.id).run();
    } catch (err) {
      if (/UNIQUE constraint failed/.test(String(err?.message))) return json({ error: 'err_already_voted_poll' }, 400);
      throw err;
    }
    return json({ posts: await plazaPosts(ctx.env, ctx.user.id) });
  },
  // New Wall post (src/plaza.js createPlazaPost), any admin. Photos wait for
  // R2 (APP-LG-010); translations and push are not on the Worker yet.
  'POST /api/admin/plaza-posts': async (ctx) => {
    const off = plazaOff(ctx) || adminOnly(ctx); if (off) return off;
    const { type, text, options, links, photoBase64 } = ctx.body;
    const clean = validatePostContent(type, { text, options, links });
    if (clean.error) return json({ error: clean.error }, 400);
    if (photoBase64) return json({ error: 'err_photo_not_yet' }, 400);
    const DB = ctx.env.DB;
    const post = await DB.prepare('INSERT INTO plaza_posts (type, author_id, text) VALUES (?, ?, ?) RETURNING id')
      .bind(type, ctx.user.id, clean.text).first();
    const extra = type === 'poll'
      ? clean.options.map((label, i) => DB.prepare('INSERT INTO plaza_poll_options (post_id, label, position) VALUES (?, ?, ?)').bind(post.id, label, i))
      : clean.links.map((l, i) => DB.prepare('INSERT INTO plaza_link_items (post_id, emoji, label, url, position) VALUES (?, ?, ?, ?, ?)').bind(post.id, l.emoji, l.label, l.url, i));
    if (extra.length) await DB.batch(extra);
    const bodyByType = {
      poll: { pt: 'há uma nova sondagem na wall, vem votar.', en: 'there’s a new poll on the wall, come and vote.' },
      links: { pt: 'há links novos na wall.', en: 'there are new links on the wall.' },
      announcement: { pt: 'a organização deixou um novo anúncio na wall.', en: 'the hosts left a new announcement on the wall.' },
    };
    ctx.exec.waitUntil(broadcast(ctx.env, { title: { pt: 'wall', en: 'wall' }, body: bodyByType[type] || bodyByType.announcement,
      tag: 'plaza-announcement', url: '/?tab=plaza' }));
    return json({ ok: true, id: post.id });
  },
  'PATCH /api/admin/plaza-posts/:id/pin': async (ctx) => {
    const off = plazaOff(ctx) || ownerOnly(ctx); if (off) return off;
    if (!(await postExists(ctx, ctx.id))) return json({ error: 'err_post_not_found' }, 400);
    await ctx.env.DB.prepare(`UPDATE plaza_posts SET pinned_at = ${ctx.body.pinned ? now : 'NULL'} WHERE id = ?`).bind(ctx.id).run();
    return json({ ok: true });
  },
  'DELETE /api/admin/plaza-posts/:id': async (ctx) => {
    const off = plazaOff(ctx) || ownerOnly(ctx); if (off) return off;
    if (!(await postExists(ctx, ctx.id))) return json({ error: 'err_post_not_found' }, 404);
    await ctx.env.DB.batch([
      ctx.env.DB.prepare('DELETE FROM plaza_posts WHERE id = ?').bind(ctx.id),
      ctx.env.DB.prepare("DELETE FROM translations WHERE entity_type = 'plaza_post' AND entity_id = ?").bind(ctx.id),
    ]);
    return json({ ok: true });
  },
};

// Voting day (YYYY-MM-DD, Europe/Lisbon), rolling over at day_rollover_hour
// (default 6) like today() in src/time.js, which cannot load here (node:sqlite).
async function votingDay(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'day_rollover_hour'").first();
  const rollover = row ? Number(row.value) : 6;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  if (Number(parts.hour) >= rollover) return date;
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

const ONE_CONSEQUENCE = `
  SELECT c.id, c.text, c.revealed_at, u.name AS author,
         c.assigned_user_id, a.name AS assignedName, c.done_at, c.approved_at
  FROM consequences c JOIN users u ON u.id = c.user_id
  LEFT JOIN users a ON a.id = c.assigned_user_id WHERE c.id = ?`;
const oneConsequence = (env, id) => env.DB.prepare(ONE_CONSEQUENCE).bind(id).first();

// Wall edit (src/plaza.js updatePlazaPost). Photos wait for R2 (APP-LG-010);
// translations are not on the Worker yet, so old ones are cleared.
writes['PATCH /api/admin/plaza-posts/:id'] = async (ctx) => {
  const off = plazaOff(ctx) || adminOnly(ctx); if (off) return off;
  const DB = ctx.env.DB;
  const post = await postExists(ctx, ctx.id);
  if (!post) return json({ error: 'err_post_not_found' }, 404);
  if (!POST_TYPES.includes(post.type)) return json({ error: 'err_post_not_editable' }, 400);
  const { text, options, links, photoBase64 } = ctx.body;
  const clean = validatePostContent(post.type, { text, options, links });
  if (clean.error) return json({ error: clean.error }, 400);
  if (photoBase64) return json({ error: 'err_photo_not_yet' }, 400);
  const stmts = [DB.prepare('UPDATE plaza_posts SET text = ? WHERE id = ?').bind(clean.text, ctx.id)];
  if (photoBase64 === null || photoBase64 === '') stmts.push(DB.prepare('UPDATE plaza_posts SET photo = NULL, photo_mime = NULL WHERE id = ?').bind(ctx.id));
  if (post.type === 'poll') {
    // By position, so renaming an option keeps its votes.
    const { results: existing } = await DB.prepare('SELECT id FROM plaza_poll_options WHERE post_id = ? ORDER BY position ASC, id ASC').bind(ctx.id).all();
    clean.options.forEach((label, i) => stmts.push(existing[i]
      ? DB.prepare('UPDATE plaza_poll_options SET label = ? WHERE id = ?').bind(label, existing[i].id)
      : DB.prepare('INSERT INTO plaza_poll_options (post_id, label, position) VALUES (?, ?, ?)').bind(ctx.id, label, i)));
    existing.slice(clean.options.length).forEach((o) => stmts.push(DB.prepare('DELETE FROM plaza_poll_options WHERE id = ?').bind(o.id)));
  }
  if (post.type === 'links') {
    stmts.push(DB.prepare('DELETE FROM plaza_link_items WHERE post_id = ?').bind(ctx.id));
    clean.links.forEach((l, i) => stmts.push(DB.prepare('INSERT INTO plaza_link_items (post_id, emoji, label, url, position) VALUES (?, ?, ?, ?, ?)').bind(ctx.id, l.emoji, l.label, l.url, i)));
  }
  stmts.push(DB.prepare("DELETE FROM translations WHERE entity_type = 'plaza_post' AND entity_id = ?").bind(ctx.id));
  await DB.batch(stmts);
  return json({ ok: true, id: ctx.id });
};

// Rata (src/routes.js + src/consequences.js). Push and translations are not on the Worker yet.
writes['POST /api/consequences'] = async (ctx) => {
  const text = (typeof ctx.body.text === 'string' ? ctx.body.text : '').trim();
  if (!text) return json({ error: 'err_consequence_text_required' }, 400);
  if (text.length > 200) return json({ error: 'err_max_200_chars' }, 400);
  const day = await votingDay(ctx.env);
  const mine = await ctx.env.DB.prepare('SELECT id FROM consequences WHERE user_id = ? AND day = ?').bind(ctx.user.id, day).first();
  if (mine) return json({ error: 'err_consequence_already_suggested_today' }, 409);
  try {
    await ctx.env.DB.prepare(`INSERT INTO consequences (user_id, text, day, created_at) VALUES (?, ?, ?, ${now})`).bind(ctx.user.id, text, day).run();
  } catch (err) {
    if (/UNIQUE constraint failed/.test(String(err?.message))) return json({ error: 'err_consequence_already_suggested_today' }, 409);
    throw err;
  }
  return json({ ok: true }, 201);
};
writes['POST /api/consequences/:id/mark-done'] = async (ctx) => {
  const c = await ctx.env.DB.prepare("SELECT id, assigned_user_id, done_at FROM consequences WHERE id = ? AND status = 'used'").bind(ctx.id).first();
  if (!c) return json({ error: 'err_consequence_not_found' }, 400);
  if (c.assigned_user_id !== ctx.user.id) return json({ error: 'err_consequence_not_assigned_to_you' }, 400);
  if (c.done_at) return json({ error: 'err_consequence_already_done' }, 400);
  await ctx.env.DB.prepare(`UPDATE consequences SET done_at = ${now} WHERE id = ? AND done_at IS NULL`).bind(ctx.id).run();
  return json({ ok: true, consequence: await oneConsequence(ctx.env, ctx.id) });
};
writes['PATCH /api/admin/consequences/:id/assign'] = async (ctx) => {
  const off = adminOnly(ctx); if (off) return off;
  const userId = ctx.body.userId === null ? null : Number(ctx.body.userId);
  if (userId !== null && !(await ctx.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first())) return json({ error: 'err_user_not_found' }, 404);
  const c = await ctx.env.DB.prepare("SELECT id FROM consequences WHERE id = ? AND status = 'used'").bind(ctx.id).first();
  if (!c) return json({ error: 'err_consequence_not_found' }, 404);
  await ctx.env.DB.prepare(`UPDATE consequences SET assigned_user_id = ?, assigned_at = CASE WHEN ? IS NULL THEN NULL ELSE ${now} END WHERE id = ?`).bind(userId, userId, ctx.id).run();
  return json({ ok: true, consequence: await oneConsequence(ctx.env, ctx.id) });
};
writes['PATCH /api/admin/consequences/:id/approve'] = async (ctx) => {
  const off = ownerOnly(ctx); if (off) return off;
  const c = await ctx.env.DB.prepare('SELECT id, done_at, approved_at FROM consequences WHERE id = ?').bind(ctx.id).first();
  if (!c) return json({ error: 'err_consequence_not_found' }, 400);
  if (!c.done_at) return json({ error: 'err_consequence_not_done_yet' }, 400);
  if (c.approved_at) return json({ error: 'err_consequence_already_approved' }, 400);
  await ctx.env.DB.prepare(`UPDATE consequences SET approved_at = ${now} WHERE id = ?`).bind(ctx.id).run();
  return json({ ok: true, consequence: await oneConsequence(ctx.env, ctx.id) });
};
writes['POST /api/admin/consequences/reveal'] = async (ctx) => {
  const off = adminOnly(ctx); if (off) return off;
  const pick = await ctx.env.DB.prepare(`SELECT c.id, c.text, u.name AS author FROM consequences c JOIN users u ON u.id = c.user_id
    WHERE c.status = 'pending' ORDER BY RANDOM() LIMIT 1`).first();
  if (!pick) return json({ error: 'err_no_pending_consequences' }, 404);
  await ctx.env.DB.prepare(`UPDATE consequences SET status = 'used', revealed_at = ${now} WHERE id = ? AND status = 'pending'`).bind(pick.id).run();
  ctx.exec.waitUntil(broadcast(ctx.env, { title: { pt: 'rata', en: 'rata' },
    body: { pt: 'saiu uma nova consequência, abre a app para a veres.', en: 'a new consequence was drawn, open the app to see it.' },
    tag: 'consequence', url: '/?tab=rata' }));
  return json({ ok: true, revealed: pick });
};


// ---- Snatch (src/votes.js) and Plaza chat (src/chat.js) -------------------
// Push and translations are not on the Worker yet.
const setting = async (env, key, dflt = null) => {
  const r = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return r ? r.value : dflt;
};
const nightStatus = async (env, night) => {
  const s = await setting(env, `voting_status_${night}`, 'closed');
  return s === 'registration' || s === 'open' ? s : 'closed';
};
const nightOf = (body) => (isNight(body?.night) ? body.night : DEFAULT_NIGHT);
const err = (error) => json({ error }, 400);
const MAX_PHOTO_BYTES = 400 * 1024;
// Same rules as decodeJpegDataUrl() in src/photos.js, without Buffer.
function decodePhoto(data) {
  const prefix = 'data:image/jpeg;base64,';
  if (typeof data !== 'string' || !data.startsWith(prefix)) return { error: 'err_photo_invalid' };
  let bytes;
  try { bytes = Uint8Array.from(atob(data.slice(prefix.length)), (c) => c.charCodeAt(0)); } catch { return { error: 'err_photo_invalid' }; }
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return { error: 'err_photo_invalid' };
  if (bytes.length > MAX_PHOTO_BYTES) return { error: 'err_photo_too_large' };
  return { bytes, mime: 'image/jpeg' };
}
const entryOf = (env, userId, night, cols) => env.DB.prepare(
  `SELECT ${cols} FROM contestants WHERE night = ? AND (user_id = ? OR partner_user_id = ?)`).bind(night, userId, userId).first();

// The single vote row that belongs to this user tonight (their own, or the one shared with a duo partner).
async function voteRowFor(env, userId, night) {
  const e = await entryOf(env, userId, night, 'user_id, partner_user_id');
  const partnerId = e ? (e.user_id === userId ? e.partner_user_id : e.user_id) : null;
  const round = Number(await setting(env, `runoff_round_${night}`, 0)) || 0;
  const row = await env.DB.prepare(
    'SELECT id, user_id, contestant_id, confirmed_at FROM votes WHERE night = ? AND round = ? AND user_id IN (?, ?)')
    .bind(night, round, userId, partnerId ?? userId).first();
  return { row, partnerId, round };
}

writes['POST /api/outfit/register'] = async (ctx) => {
  const { env, user, body } = ctx;
  const night = nightOf(body);
  if ((await nightStatus(env, night)) !== 'registration') return err('err_registration_not_open');
  if (await entryOf(env, user.id, night, 'id')) return err('err_you_already_registered');
  const name = String(body.name || '').trim();
  if (!name) return err('err_persona_name_required');
  if (name.length > 60) return err('err_max_60_chars');
  if (!body.photoBase64) return err('err_photo_required');
  const photo = decodePhoto(body.photoBase64);
  if (photo.error) return err(photo.error);
  let partnerId = null;
  if (body.partnerUserId) {
    partnerId = Number(body.partnerUserId);
    if (partnerId === user.id) return err('err_cannot_partner_with_self');
    if (!(await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(partnerId).first())) return err('err_user_invalid');
    if (await entryOf(env, partnerId, night, 'id')) return err('err_already_registered_this_night');
  }
  const pending = !!partnerId;
  const row = await env.DB.prepare(
    `INSERT INTO contestants (name, night, user_id, partner_user_id, photo, photo_mime, confirmed_at)
     VALUES (?, ?, ?, ?, ?, ?, ${pending ? 'NULL' : "datetime('now')"}) RETURNING id`)
    .bind(name, night, user.id, partnerId, photo.bytes, photo.mime).first();
  return json({ ok: true, id: row.id, name, pending }, 201);
};
writes['POST /api/outfit/register/confirm'] = async (ctx) => {
  const night = nightOf(ctx.body);
  if ((await nightStatus(ctx.env, night)) !== 'registration') return err('err_registration_not_open');
  const row = await entryOf(ctx.env, ctx.user.id, night, 'id, user_id, confirmed_at');
  if (!row) return err('err_no_pending_entry');
  if (row.confirmed_at) return err('err_you_already_registered');
  if (row.user_id === ctx.user.id) return err('err_partner_must_confirm_entry');
  await ctx.env.DB.prepare("UPDATE contestants SET confirmed_at = datetime('now') WHERE id = ? AND confirmed_at IS NULL").bind(row.id).run();
  return json({ ok: true });
};
writes['DELETE /api/outfit/register/pending'] = async (ctx) => {
  const night = nightOf(ctx.body);
  if ((await nightStatus(ctx.env, night)) !== 'registration') return err('err_registration_not_open');
  const row = await entryOf(ctx.env, ctx.user.id, night, 'id, confirmed_at');
  if (!row) return err('err_no_pending_entry');
  if (row.confirmed_at) return err('err_you_already_registered');
  await ctx.env.DB.prepare('DELETE FROM contestants WHERE id = ?').bind(row.id).run();
  return json({ ok: true });
};
writes['POST /api/votes'] = async (ctx) => {
  const { env, user, body } = ctx;
  const contestantId = Number(body.contestantId);
  if (!contestantId) return err('err_choose_contestant');
  if (!isNight(body.night)) return err('err_invalid_night');
  const night = body.night;
  if ((await nightStatus(env, night)) !== 'open') return err('err_voting_not_open');
  if (!(await env.DB.prepare('SELECT id FROM contestants WHERE id = ? AND night = ?').bind(contestantId, night).first())) return err('err_contestant_invalid_for_night');
  const raw = await setting(env, `runoff_ids_${night}`);
  if (raw && !JSON.parse(raw).includes(contestantId)) return err('err_not_in_runoff');
  const own = await entryOf(env, user.id, night, 'id');
  if (own && own.id === contestantId) return err('err_cannot_vote_self');
  const { row, partnerId, round } = await voteRowFor(env, user.id, night);
  if (row) return err(partnerId ? 'err_duo_already_voted' : 'err_already_voted');
  await ensureVoteRounds(env);
  await env.DB.prepare(`INSERT INTO votes (user_id, contestant_id, night, round, confirmed_at) VALUES (?, ?, ?, ?, ${partnerId ? 'NULL' : "datetime('now')"})`)
    .bind(user.id, contestantId, night, round).run();
  return json({ ok: true, pending: !!partnerId }, 201);
};
writes['POST /api/votes/confirm'] = async (ctx) => {
  if (!isNight(ctx.body.night)) return err('err_invalid_night');
  if ((await nightStatus(ctx.env, ctx.body.night)) !== 'open') return err('err_voting_not_open');
  const { row, partnerId } = await voteRowFor(ctx.env, ctx.user.id, ctx.body.night);
  if (!partnerId) return err('err_not_a_duo');
  if (!row) return err('err_no_pending_vote');
  if (row.confirmed_at) return err('err_already_voted');
  if (row.user_id === ctx.user.id) return err('err_partner_must_confirm');
  await ctx.env.DB.prepare("UPDATE votes SET confirmed_at = datetime('now') WHERE id = ? AND confirmed_at IS NULL").bind(row.id).run();
  return json({ ok: true });
};
writes['DELETE /api/votes/pending'] = async (ctx) => {
  if (!isNight(ctx.body.night)) return err('err_invalid_night');
  if ((await nightStatus(ctx.env, ctx.body.night)) !== 'open') return err('err_voting_not_open');
  const { row, partnerId } = await voteRowFor(ctx.env, ctx.user.id, ctx.body.night);
  if (!partnerId) return err('err_not_a_duo');
  if (!row) return err('err_no_pending_vote');
  if (row.confirmed_at) return err('err_already_voted');
  await ctx.env.DB.prepare('DELETE FROM votes WHERE id = ? AND confirmed_at IS NULL').bind(row.id).run();
  return json({ ok: true });
};

const pick = (list) => list[crypto.getRandomValues(new Uint32Array(1))[0] % list.length];
writes['POST /api/chat/messages'] = async (ctx) => {
  const { DB } = ctx.env;
  const text = String(ctx.body.text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!text) return err('err_empty_message');
  if (text.length > 300) return err('err_message_too_long');
  let { wall_pseudonym: pseudonym } = await DB.prepare('SELECT wall_pseudonym FROM users WHERE id = ?').bind(ctx.user.id).first();
  if (!pseudonym) {
    pseudonym = `${pick(FURNISHED_OBJECTS)}${pick(SWAMP_BEINGS)}`;
    await DB.batch([
      DB.prepare('UPDATE users SET wall_pseudonym = ? WHERE id = ?').bind(pseudonym, ctx.user.id),
      DB.prepare('INSERT INTO wall_pseudonym_history (user_id, pseudonym) VALUES (?, ?)').bind(ctx.user.id, pseudonym),
    ]);
  }
  await DB.prepare('INSERT INTO messages (user_id, text, pseudonym) VALUES (?, ?, ?)').bind(ctx.user.id, text, pseudonym).run();
  await DB.prepare('DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT 15)').run();
  ctx.exec.waitUntil(broadcast(ctx.env, { title: { pt: 'plaza', en: 'plaza' },
    body: { pt: `${pseudonym} acabou de partilhar algo novo na plaza.`, en: `${pseudonym} just shared something new in the plaza.` },
    tag: 'plaza-share', url: '/?tab=chat' }, { excludeUserId: ctx.user.id }));
  return json({ ok: true }, 201);
};

// ---- Manage Users, settings, dedications (APP-LG-015 slice 1) ----
async function decryptToken(secret, enc) {
  try {
    const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
    const [iv, tag, ct] = String(enc).split(':').map((x) => Uint8Array.from(atob(x), (c) => c.charCodeAt(0)));
    const joined = new Uint8Array(ct.length + tag.length); joined.set(ct); joined.set(tag, ct.length);
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, joined));
  } catch { return null; }
}
async function newUserKey(env, name) {
  const base = tokenBase(name);
  for (;;) {
    const token = `${base}${String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0')}`;
    const hash = await hashToken(env.TOKEN_SECRET, token);
    if (!(await env.DB.prepare('SELECT 1 AS x FROM users WHERE token_hash = ?').bind(hash).first())) return { token, hash };
  }
}
const cleanName = (b) => String(b?.name ?? '').trim();
const userExists = (ctx, id) => ctx.env.DB.prepare('SELECT id, name, is_owner, is_admin FROM users WHERE id = ?').bind(id).first();
const myDedication = (ctx) => ctx.env.DB.prepare('SELECT text, updated_at FROM dedications WHERE user_id = ?').bind(ctx.user.id).first();

routes['/api/admin/users'] = async (ctx) => {
  const off = adminOnly(ctx); if (off) return off;
  const { results } = await ctx.env.DB.prepare(
    'SELECT id, name, token_enc, is_admin, is_owner, created_at FROM users ORDER BY is_owner DESC, name COLLATE NOCASE ASC').all();
  const visible = ctx.user.is_owner ? results : results.filter((u) => u.id === ctx.user.id);
  return json(await Promise.all(visible.map(async (u) => ({
    id: u.id, name: u.name, token: await decryptToken(ctx.env.TOKEN_SECRET, u.token_enc),
    is_admin: !!u.is_admin, is_owner: !!u.is_owner, created_at: u.created_at,
  }))));
};
routes['/api/admin/settings'] = async (ctx) => {
  const off = adminOnly(ctx); if (off) return off;
  const row = await ctx.env.DB.prepare("SELECT value FROM settings WHERE key = 'day_rollover_hour'").first();
  return json({ dayRolloverHour: Number(row ? row.value : 6), partyOn: await claimOpen(ctx.env) });
};
routes['/api/dedications/mine'] = async (ctx) => json({ dedication: await myDedication(ctx) });
routes['/api/admin/dedications'] = async (ctx) => {
  const off = ownerOnly(ctx); if (off) return off;
  const { results } = await ctx.env.DB.prepare(`SELECT d.id, d.text, d.created_at, d.updated_at, u.name AS author
    FROM dedications d JOIN users u ON u.id = d.user_id ORDER BY d.created_at`).all();
  return json({ dedications: results });
};

writes['PUT /api/admin/settings'] = async (ctx) => {
  const off = adminOnly(ctx); if (off) return off;
  const { dayRolloverHour, partyOn } = ctx.body;
  if (partyOn !== undefined) {
    // Party On (APP-LG-030): the owner's one switch. Off sends strangers to the demo and closes claiming a key by name.
    const off2 = ownerOnly(ctx); if (off2) return off2;
    await setSettingStmt(ctx.env.DB, 'claim_open', partyOn ? '1' : '0').run();
  }
  if (dayRolloverHour !== undefined) {
    const h = Number(dayRolloverHour);
    if (!Number.isInteger(h) || h < 0 || h > 23) return json({ error: 'err_invalid_rollover_hour' }, 400);
    await ctx.env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('day_rollover_hour', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(String(h)).run();
  }
  return json({ ok: true });
};
writes['PUT /api/dedications/mine'] = async (ctx) => {
  const text = String(ctx.body.text ?? '').trim();
  if (!text) return json({ error: 'err_dedication_empty' }, 400);
  await ctx.env.DB.prepare(`INSERT INTO dedications (user_id, text) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET text = excluded.text, updated_at = ${now}`).bind(ctx.user.id, text).run();
  return json({ ok: true, dedication: await myDedication(ctx) });
};
writes['POST /api/admin/dedications/wipe'] = async (ctx) => {
  const off = ownerOnly(ctx); if (off) return off;
  await ctx.env.DB.prepare('DELETE FROM dedications').run();
  return json({ ok: true });
};
writes['POST /api/me/logo-customized'] = async (ctx) => {
  const c = ctx.body.customized;
  if (c !== true && c !== false) return json({ error: 'err_invalid_logo_value' }, 400);
  await ctx.env.DB.prepare('UPDATE users SET logo_customized = ? WHERE id = ?').bind(c ? 1 : 0, ctx.user.id).run();
  return json({ ok: true, logo_customized: c });
};
writes['POST /api/admin/users'] = async (ctx) => {
  const off = ownerOnly(ctx); if (off) return off;
  const name = cleanName(ctx.body);
  if (!name) return json({ error: 'err_name_missing' }, 400);
  const { token, hash } = await newUserKey(ctx.env, name);
  const row = await ctx.env.DB.prepare(
    `INSERT INTO users (name, token_hash, token_enc, is_admin, updated_at) VALUES (?, ?, ?, 0, ${now}) RETURNING id`)
    .bind(name, hash, await encryptToken(ctx.env.TOKEN_SECRET, token)).first();
  return json({ id: row.id, name, token }, 201);
};
writes['PATCH /api/admin/users/:id/name'] = async (ctx) => {
  const off = ownerOnly(ctx); if (off) return off;
  const name = cleanName(ctx.body);
  if (!name) return json({ error: 'err_name_missing' }, 400);
  if (!(await userExists(ctx, ctx.id))) return json({ error: 'err_user_not_found' }, 404);
  await ctx.env.DB.prepare(`UPDATE users SET name = ?, updated_at = ${now} WHERE id = ?`).bind(name, ctx.id).run();
  return json({ ok: true, id: ctx.id, name });
};
writes['POST /api/admin/users/:id/regenerate-token'] = async (ctx) => {
  const off = ownerOnly(ctx); if (off) return off;
  const user = await userExists(ctx, ctx.id);
  if (!user) return json({ error: 'err_user_not_found' }, 404);
  const { token, hash } = await newUserKey(ctx.env, user.name);
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(`UPDATE users SET token_hash = ?, token_enc = ?, updated_at = ${now}, key_claimed_at = NULL WHERE id = ?`)
      .bind(hash, await encryptToken(ctx.env.TOKEN_SECRET, token), ctx.id),
    ctx.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(ctx.id),
  ]);
  return json({ ok: true, id: ctx.id, name: user.name, token });
};
writes['DELETE /api/admin/users/:id'] = async (ctx) => {
  const off = ownerOnly(ctx); if (off) return off;
  const user = await userExists(ctx, ctx.id);
  if (!user) return json({ error: 'err_user_not_found' }, 404);
  if (user.is_owner) return json({ error: 'err_cannot_remove_owner' }, 400);
  await ctx.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(ctx.id).run();
  return json({ ok: true });
};
writes['PATCH /api/admin/users/:id/admin'] = async (ctx) => {
  const off = ownerOnly(ctx); if (off) return off;
  if (ctx.env.ENABLE_ADMIN_PROMOTION !== 'true') return json({ error: 'err_feature_disabled' }, 403);
  const isAdmin = !!ctx.body.isAdmin;
  const user = await userExists(ctx, ctx.id);
  if (!user) return json({ error: 'err_user_not_found' }, 404);
  if (!isAdmin && user.is_owner) return json({ error: 'err_cannot_demote_owner' }, 400);
  if (!isAdmin && user.is_admin) {
    const { c } = await ctx.env.DB.prepare('SELECT count(*) AS c FROM users WHERE is_admin = 1').first();
    if (c <= 1) return json({ error: 'err_last_admin' }, 400);
  }
  await ctx.env.DB.prepare(`UPDATE users SET is_admin = ?, updated_at = ${now} WHERE id = ?`).bind(isAdmin ? 1 : 0, ctx.id).run();
  ctx.exec.waitUntil(notifyUser(ctx.env, ctx.id, { title: { pt: 'lodgedoivo', en: 'lodgedoivo' },
    body: isAdmin
      ? { pt: 'agora és admin e tens acesso ao painel de administração.', en: 'you are an admin now and have access to the admin panel.' }
      : { pt: 'já não és admin, mas continuas a ter acesso a tudo o resto.', en: 'you are no longer an admin, but you keep access to everything else.' },
    url: '/settings.html' }));
  return json({ ok: true, is_admin: isAdmin });
};

// ---- Key change, first-time key claim, wipes (APP-LG-017 slice 1) ----
// Same rules as /me/change-token in src/routes.js: a wrong current key or a taken key
// counts as a failed try ("taken" says the key belongs to someone).
writes['POST /api/me/change-token'] = async (ctx) => {
  const { DB, TOKEN_SECRET } = ctx.env;
  const current = String(ctx.body.currentToken ?? '').toLowerCase();
  const next = String(ctx.body.newToken ?? '').trim().toLowerCase();
  const failed = async (status, error) => { await countFail(ctx.env, ctx.ip); return json({ error }, status); };
  const wait = await lockedFor(ctx.env, ctx.ip);
  if (wait) return tooMany(json, wait);
  const row = await DB.prepare('SELECT token_hash FROM users WHERE id = ?').bind(ctx.user.id).first();
  if (!row || (await hashToken(TOKEN_SECRET, current)) !== row.token_hash) return failed(401, 'err_current_key_wrong');
  if (!/^[a-z0-9]+$/.test(next)) return json({ error: 'err_key_invalid_chars' }, 400);
  if (next.length < 7) return json({ error: 'err_key_too_short' }, 400);
  const hash = await hashToken(TOKEN_SECRET, next);
  if (await DB.prepare('SELECT id FROM users WHERE token_hash = ? AND id != ?').bind(hash, ctx.user.id).first()) {
    return failed(409, 'err_key_taken');
  }
  try {
    await DB.prepare(`UPDATE users SET token_hash = ?, token_enc = ?, updated_at = ${now} WHERE id = ?`)
      .bind(hash, await encryptToken(TOKEN_SECRET, next), ctx.user.id).run();
  } catch (err) {
    // token_hash is UNIQUE: two people picking the same key at once is "taken", not a 500.
    if (String(err?.message || '').includes('UNIQUE')) return json({ error: 'err_key_taken' }, 409);
    throw err;
  }
  return json({ ok: true });
};

// src/keyClaim.js: names who never got their key, 3+ letters, accents folded.
const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
// Claiming a key by name is only open on the demo, or on the real Lodge when the owner turns on claim_open.
// Otherwise anyone could claim an unclaimed guest's key by guessing their id.
const claimOpen = async (env) => env.APP_ENV === 'demo' || (await setting(env, 'claim_open', '0')) === '1';
routes['/api/auth/unclaimed-users'] = async (ctx) => {
  if (!(await claimOpen(ctx.env))) return json({ users: [] });
  const term = String(ctx.url.searchParams.get('name') || '').trim();
  if (term.length < 3) return json({ users: [] });
  const { results } = await ctx.env.DB.prepare('SELECT id, name FROM users WHERE key_claimed_at IS NULL').all();
  const f = fold(term);
  return json({ users: results.filter((u) => fold(u.name).includes(f)).sort((a, b) => a.name.localeCompare(b.name)) });
};
// One shot: the conditional UPDATE means two claims at once can't both win.
writes['POST /api/auth/claim-key'] = async (ctx) => {
  if (!(await claimOpen(ctx.env))) return json({ error: 'err_claim_closed' }, 403);
  const wait = await lockedFor(ctx.env, ctx.ip);
  if (wait) return tooMany(json, wait);
  const id = Number(ctx.body.userId);
  const user = await ctx.env.DB.prepare('SELECT id, name, token_enc, key_claimed_at FROM users WHERE id = ?').bind(id).first();
  if (!user) { await countFail(ctx.env, ctx.ip); return json({ error: 'err_user_not_found' }, 400); }
  const res = await ctx.env.DB.prepare(`UPDATE users SET key_claimed_at = ${now} WHERE id = ? AND key_claimed_at IS NULL`).bind(id).run();
  if (user.key_claimed_at || !res.meta.changes) { await countFail(ctx.env, ctx.ip); return json({ error: 'err_key_already_claimed' }, 400); }
  return json({ ok: true, name: user.name, token: await decryptToken(ctx.env.TOKEN_SECRET, user.token_enc) });
};

// Owner wipes. What people wrote goes with them (ON DELETE CASCADE on users).
const wipeTranslations = (DB, kinds) => kinds.map((k) => DB.prepare('DELETE FROM translations WHERE entity_type = ?').bind(k));
const setSettingStmt = (DB, key, value) => DB.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, String(value));
const ownerWipe = (stmts) => async (ctx) => {
  const off = ownerOnly(ctx); if (off) return off;
  await ctx.env.DB.batch(stmts(ctx.env.DB));
  return json({ ok: true });
};
writes['POST /api/admin/users/wipe'] = async (ctx) => {
  const off = ownerOnly(ctx); if (off) return off;
  const res = await ctx.env.DB.prepare('DELETE FROM users WHERE is_owner = 0').run();
  return json({ ok: true, removed: res.meta.changes });
};
writes['POST /api/admin/consequences/wipe'] = ownerWipe((DB) => [
  DB.prepare('DELETE FROM consequences'), ...wipeTranslations(DB, ['consequence'])]);
writes['POST /api/admin/contestants/wipe'] = ownerWipe((DB) => [
  DB.prepare('DELETE FROM contestants'),
  ...NIGHTS.flatMap((n) => [setSettingStmt(DB, `voting_status_${n}`, 'closed'), setSettingStmt(DB, `voting_started_${n}`, '0'),
    setSettingStmt(DB, `results_phase_${n}`, 'hidden')])]);
writes['POST /api/admin/plaza-posts/wipe'] = ownerWipe((DB) => [
  DB.prepare('DELETE FROM plaza_posts'), ...wipeTranslations(DB, ['plaza_post', 'poll_option', 'link_item'])]);
writes['POST /api/admin/chat/wipe'] = ownerWipe((DB) => [
  DB.prepare('DELETE FROM messages'), ...wipeTranslations(DB, ['message'])]);

const PUBLIC = new Set(['/api/version', '/api/demo', 'POST /api/auth/login', '/api/auth/unclaimed-users', 'POST /api/auth/claim-key']);

// Routes with a path piece in them that is not a plain number (a day, or file routes).
const getDyn = [];
const writeDyn = [];
addMemoRoutes({ routes, writes, getDyn, writeDyn, json, adminOnly, now });
addVotesRoutes({ routes, writes, getDyn, writeDyn, json, adminOnly, ownerOnly });
addPushRoutes({ routes, writes, json });
const passkeys = addPasskeyRoutes({ routes, writes, writeDyn, publicKeys: PUBLIC, json, hashToken, findUser, ownerOnly });

// Daily reset (cron trigger): the demo goes back to its starting state. People and
// everything they wrote go (ON DELETE CASCADE), then the shared tables and the
// uploaded files are cleared and the demo people are seeded again with the same keys.
const RESET_TABLES = ['consequences', 'contestants', 'dedications', 'memo_recaps', 'memo_slots', 'memo_uploads', 'messages',
  'plaza_posts', 'push_subscriptions', 'sessions', 'passkey_challenges', 'translations', 'votes', 'congeniality_votes', 'wall_pseudonym_history'];
export async function resetDemo(env) {
  if (env.APP_ENV !== 'demo') return { skipped: true };
  await env.DB.batch([
    env.DB.prepare('DELETE FROM users WHERE is_owner = 0'),
    ...RESET_TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
    env.DB.prepare("DELETE FROM settings WHERE key NOT LIKE 'owner%'"),
  ]);
  let cursor, files = 0;
  do {
    const page = await env.FILES.list({ cursor, limit: 500 });
    if (page.objects.length) { await env.FILES.delete(page.objects.map((o) => o.key)); files += page.objects.length; }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  resetDemoSeedFlag();
  await ensureDemoUsers(env);
  return { ok: true, files };
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(resetDemo(env)); },
  async fetch(request, env, exec = { waitUntil: (p) => p.catch(() => {}) }) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    const path = url.pathname.replace(/\/+$/, '');
    const ctx = { env, url, request, exec, ip: clientIp(request) };
    let handler, key, m;
    if (request.method === 'GET') {
      handler = routes[path]; key = path;
      if (!handler) for (const [re, h] of getDyn) { if ((m = path.match(re))) { handler = (c) => h(c, m); break; } }
    } else {
      const n = path.match(/^(.*\/)(\d+)(\/[^/]+)?$/);
      key = `${request.method} ${n ? `${n[1]}:id${n[3] || ''}` : path}`;
      if (n) ctx.id = Number(n[2]);
      handler = writes[key];
      if (!handler) for (const [method, re, h] of writeDyn) { if (method === request.method && (m = path.match(re))) { handler = (c) => h(c, m); break; } }
      if (!handler) return json({ error: 'err_read_only' }, 405);
      // File uploads (multipart) are read by their own handler from ctx.request.
      ctx.body = (request.headers.get('content-type') || '').includes('multipart/form-data') ? {} : await readBody(request);
    }
    if (!handler) return json({ error: 'err_not_found' }, 404);
    await ensureDemoUsers(env);
    if (!PUBLIC.has(key)) {
      const auth = await authenticate(request, env, url);
      if (auth.error) return auth.error;
      ctx.user = auth.user;
      ctx.token = auth.token;
    }
    return handler(ctx);
  },
};
