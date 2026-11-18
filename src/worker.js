// Cloudflare Worker for Lodge: API from D1 (reads APP-LG-011, sign-in and
// first writes APP-LG-012). Pages are served by the assets binding; only
// /api/* reaches this file. Writes not ported yet answer 405.
import pkg from '../package.json' with { type: 'json' };
import { validatePostContent } from './plaza-rules.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

async function hashToken(secret, token) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(token)));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const USER_COLUMNS = 'id, name, is_admin, is_owner, tutorial_seen, lang, key_claimed_at, logo_customized';

const now = "strftime('%Y-%m-%d %H:%M:%f', 'now')";
const isSessionToken = (t) => String(t || '').startsWith('s.');

// Owner and admins confirm with Face ID outside the demo (src/passkeys.js).
// Face ID is not on the Worker yet, so off the demo their key alone opens nothing.
const passkeyRequired = (env, user) => env.APP_ENV !== 'demo' && !!(user.is_admin || user.is_owner);

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
  const user = await findUser(env, token);
  if (!user) return { error: json({ error: 'err_token_invalid' }, 401) };
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
  '/api/me': async (ctx) => json({
    ...ctx.user,
    plazaEnabled: ctx.env.ENABLE_PLAZA === 'true',
    adminPromotionEnabled: false,
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
    const user = await findUser(ctx.env, token);
    if (!user) return json({ error: 'err_token_invalid' }, 401);
    if (!user.viaPasskey && passkeyRequired(ctx.env, user)) return json({ error: 'err_passkey_required' }, 401);
    await stampClaimed(ctx.env, user.id);
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
const PUBLIC = new Set(['/api/version', 'POST /api/auth/login']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    const path = url.pathname.replace(/\/+$/, '');
    const ctx = { env, url };
    let handler, key;
    if (request.method === 'GET') {
      handler = routes[path]; key = path;
    } else {
      const m = path.match(/^(.*\/)(\d+)(\/[^/]+)?$/);
      key = `${request.method} ${m ? `${m[1]}:id${m[3] || ''}` : path}`;
      if (m) ctx.id = Number(m[2]);
      handler = writes[key];
      if (!handler) return json({ error: 'err_read_only' }, 405);
      ctx.body = await readBody(request);
    }
    if (!handler) return json({ error: 'err_not_found' }, 404);
    if (!PUBLIC.has(key)) {
      const auth = await authenticate(request, env, url);
      if (auth.error) return auth.error;
      ctx.user = auth.user;
      ctx.token = auth.token;
    }
    return handler(ctx);
  },
};
