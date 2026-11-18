// Cloudflare Worker for Lodge (APP-LG-011): read-only API from D1.
// Pages are served by the assets binding; only /api/* reaches this file.
// No writes yet - every non-GET answers 405.
import pkg from '../package.json' with { type: 'json' };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

async function hashToken(secret, token) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(token)));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const USER_COLUMNS = 'id, name, is_admin, is_owner, tutorial_seen, lang, key_claimed_at, logo_customized';

// Same rule as src/auth.js: Bearer header (or ?token=), lowercased, HMAC-hashed.
// Face ID sessions (s.<hex>) are not read here yet.
async function authenticate(request, env, url) {
  const header = request.headers.get('authorization') || '';
  const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : url.searchParams.get('token');
  if (!raw) return { error: json({ error: 'err_token_missing' }, 401) };
  if (!env.TOKEN_SECRET) return { error: json({ error: 'err_server' }, 500) };
  const hash = await hashToken(env.TOKEN_SECRET, String(raw).trim().toLowerCase());
  const user = await env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE token_hash = ?`).bind(hash).first();
  if (!user) return { error: json({ error: 'err_token_invalid' }, 401) };
  return { user };
}

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
const PUBLIC = new Set(['/api/version']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (request.method !== 'GET') return json({ error: 'err_read_only' }, 405);
    const path = url.pathname.replace(/\/+$/, '');
    const handler = routes[path];
    if (!handler) return json({ error: 'err_not_found' }, 404);
    const ctx = { env, url };
    if (!PUBLIC.has(path)) {
      const auth = await authenticate(request, env, url);
      if (auth.error) return auth.error;
      ctx.user = auth.user;
    }
    return handler(ctx);
  },
};
