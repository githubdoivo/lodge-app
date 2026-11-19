// Plaza on the Worker (APP-LG-033): chat history, Wall post photos, admin post list,
// Wall pseudonyms. Port of src/chat.js and the Plaza routes in src/routes.js.
import { FURNISHED_OBJECTS, SWAMP_BEINGS } from './pseudonyms.js';

const pick = (list) => list[crypto.getRandomValues(new Uint32Array(1))[0] % list.length];
const timeIn = (ts) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Lisbon', hour: '2-digit', minute: '2-digit', hour12: false })
  .format(new Date(`${String(ts).replace(' ', 'T')}Z`));

export function addPlazaRoutes({ routes, getDyn, writeDyn, json, adminOnly, ownerOnly, plazaOff, votingDay }) {
  // Last 15 messages, oldest first; "author" is the pseudonym, never the name.
  routes['/api/chat/messages'] = async (ctx) => {
    const { DB } = ctx.env;
    await DB.prepare('DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT 15)').run();
    const { results } = await DB.prepare('SELECT id, text, created_at, pseudonym AS author FROM messages ORDER BY id ASC').all();
    return json({ messages: results.map((m) => ({ ...m, time: timeIn(m.created_at) })) });
  };

  // Any signed-in guest, same as the post itself.
  getDyn.push([/^\/api\/plaza-posts\/(\d+)\/photo$/, async (ctx, m) => {
    const off = plazaOff(ctx); if (off) return off;
    const row = await ctx.env.DB.prepare('SELECT photo, photo_mime FROM plaza_posts WHERE id = ? AND photo IS NOT NULL').bind(Number(m[1])).first();
    if (!row) return new Response(null, { status: 404 });
    const bytes = row.photo instanceof ArrayBuffer ? new Uint8Array(row.photo) : Uint8Array.from(row.photo);
    return new Response(bytes, { headers: { 'content-type': row.photo_mime || 'image/jpeg', 'cache-control': 'no-store' } });
  }]);

  routes['/api/admin/plaza-posts'] = async (ctx) => {
    const off = plazaOff(ctx) || adminOnly(ctx); if (off) return off;
    const { DB } = ctx.env;
    const { results: posts } = await DB.prepare(`
      SELECT p.id, p.type, p.text, p.pinned_at AS pinnedAt, p.created_at, u.name AS author, (p.photo IS NOT NULL) AS hasPhoto
      FROM plaza_posts p JOIN users u ON u.id = p.author_id
      ORDER BY (p.pinned_at IS NULL) ASC, p.pinned_at DESC, p.created_at DESC, p.id DESC`).all();
    const { results: options } = await DB.prepare(`
      SELECT o.id, o.post_id, o.label, COUNT(v.id) AS votes FROM plaza_poll_options o
      LEFT JOIN plaza_poll_votes v ON v.option_id = o.id GROUP BY o.id ORDER BY o.position ASC, o.id ASC`).all();
    const { results: voters } = await DB.prepare(`
      SELECT v.post_id, u.name AS name, o.label AS option FROM plaza_poll_votes v
      JOIN users u ON u.id = v.user_id JOIN plaza_poll_options o ON o.id = v.option_id ORDER BY u.name COLLATE NOCASE`).all();
    const { results: links } = await DB.prepare(
      'SELECT id, post_id, emoji, label, url FROM plaza_link_items ORDER BY position ASC, id ASC').all();
    const strip = ({ post_id, ...rest }) => rest; // eslint-disable-line no-unused-vars
    return json({ posts: posts.map((p) => {
      if (p.type === 'links') return { ...p, links: links.filter((l) => l.post_id === p.id).map(strip) };
      if (p.type !== 'poll') return p;
      return { ...p, options: options.filter((o) => o.post_id === p.id).map(strip), voters: voters.filter((v) => v.post_id === p.id).map(strip) };
    }) });
  };

  // Owner only: every pseudonym each guest has ever had, oldest first.
  routes['/api/admin/wall-pseudonyms'] = async (ctx) => {
    const off = ownerOnly(ctx); if (off) return off;
    const { results } = await ctx.env.DB.prepare(`
      SELECT u.id, u.name, h.pseudonym FROM users u JOIN wall_pseudonym_history h ON h.user_id = u.id
      ORDER BY u.name COLLATE NOCASE ASC, h.id ASC`).all();
    const by = new Map();
    for (const r of results) {
      if (!by.has(r.id)) by.set(r.id, { id: r.id, name: r.name, pseudonyms: [] });
      by.get(r.id).pseudonyms.push(r.pseudonym);
    }
    return json([...by.values()]);
  };

  // Owner only: a fresh pseudonym, at most once a day; the old one stays in history.
  writeDyn.push(['POST', /^\/api\/admin\/users\/(\d+)\/wall-pseudonym\/reset$/, async (ctx, m) => {
    const off = ownerOnly(ctx); if (off) return off;
    const { DB } = ctx.env;
    ctx.id = Number(m[1]);
    const user = await DB.prepare('SELECT wall_pseudonym_reset_day FROM users WHERE id = ?').bind(ctx.id).first();
    if (!user) return json({ error: 'err_user_not_found' }, 400);
    const day = await votingDay(ctx.env);
    if (user.wall_pseudonym_reset_day === day) return json({ error: 'err_pseudonym_reset_limit' }, 400);
    const pseudonym = `${pick(FURNISHED_OBJECTS)}${pick(SWAMP_BEINGS)}`;
    await DB.batch([
      DB.prepare('UPDATE users SET wall_pseudonym = ? WHERE id = ?').bind(pseudonym, ctx.id),
      DB.prepare('INSERT INTO wall_pseudonym_history (user_id, pseudonym) VALUES (?, ?)').bind(ctx.id, pseudonym),
      DB.prepare('UPDATE users SET wall_pseudonym_reset_day = ? WHERE id = ?').bind(day, ctx.id),
    ]);
    return json({ ok: true, pseudonym });
  }]);
}
