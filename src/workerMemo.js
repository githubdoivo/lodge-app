// Memo on the Worker (APP-LG-016): the daily moments, uploads (files in R2,
// binding FILES), the feed, flip, reactions and the day recaps. Port of
// src/memo.js and the Memo routes in src/routes.js; D1 instead of node:sqlite.
// The day video is made on the admin's phone, so nothing here encodes video.

const SLOTS_PER_DAY = 5;
const WINDOW_OPEN_MINUTES = 15;
const MIN_GAP_MINUTES = 45;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const WINDOW_START_HOUR = 14; // 14:00 to 02:00 Lisbon time
const WINDOW_END_HOUR = 2;
const TZ = 'Europe/Lisbon';
const REACTIONS = ['❤️', '💦', '👎'];
import { makeZip } from './workerVotes.js';
const RECAP_SECONDS_PER_PHOTO = 1;
const EXT = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'image/heif': '.heif',
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm',
};
const extFor = (mime) => EXT[mime] || '';
const stamp = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
const addDays = (day, n) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// Tests pin the clock here, as setClockForTests() does for Node.
let clock = () => Date.now();
export const setMemoClock = (at) => { const prev = clock; clock = typeof at === 'function' ? at : () => new Date(at).getTime(); return () => { clock = prev; }; };

function hourIn(ms) {
  return parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(new Date(ms)), 10) % 24;
}
// Same as today() in src/time.js: the day rolls over at day_rollover_hour (default 6), not midnight.
async function todayOf(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'day_rollover_hour'").first();
  const rollover = Number(row ? row.value : 6);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(clock()));
  return hourIn(clock()) < rollover ? addDays(date, -1) : date;
}
function zonedToUtc(day, hour, minute) {
  const guess = new Date(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(guess).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return new Date(guess.getTime() + (guess.getTime() - asUtc));
}

const isAdmin = (u) => !!(u.is_admin || u.is_owner);
function available(env, user, day) {
  if (env.ENABLE_MEMO !== 'true') return false;
  return !env.MEMO_START_DATE || day >= env.MEMO_START_DATE || isAdmin(user);
}

/** Today's shared random slots, made the first time anyone asks (same rules as ensureTodaysSlots). */
async function ensureSlots(env, day) {
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM memo_slots WHERE day = ?').bind(day).first();
  if (n > 0) return;
  const windowStart = zonedToUtc(day, WINDOW_START_HOUR, 0).getTime();
  const windowEnd = zonedToUtc(addDays(day, 1), WINDOW_END_HOUR, 0).getTime();
  const start = Math.max(windowStart, clock());
  if (start >= windowEnd) return; // window already shut: nothing honest to schedule
  const gap = MIN_GAP_MINUTES * 60000;
  const room = windowEnd - start;
  const count = Math.min(SLOTS_PER_DAY, Math.floor(room / gap) + 1);
  const slack = room - gap * (count - 1);
  const offsets = Array.from({ length: count }, () => Math.random() * slack).sort((a, b) => a - b);
  await env.DB.batch(offsets.map((o, i) => env.DB.prepare(
    'INSERT OR IGNORE INTO memo_slots (day, slot_index, scheduled_at) VALUES (?, ?, ?)').bind(day, i, stamp(start + o + i * gap))));
}

async function currentSlotId(env, day) {
  const row = await env.DB.prepare(`SELECT id FROM memo_slots WHERE day = ? AND notified_at IS NOT NULL
    ORDER BY notified_at DESC, slot_index DESC LIMIT 1`).bind(day).first();
  return row ? row.id : null;
}
function statusOf(slot, upload, currentId) {
  if (upload) return { status: 'uploaded', uploadId: upload.id, kind: upload.kind };
  if (!slot.notified_at) return { status: 'waiting' };
  if (slot.id !== currentId) return { status: 'missed' };
  const left = new Date(`${slot.notified_at.replace(' ', 'T')}Z`).getTime() + WINDOW_OPEN_MINUTES * 60000 - clock();
  return left <= 0 ? { status: 'missed' } : { status: 'open', secondsLeft: Math.round(left / 1000) };
}

async function feedOf(env, userId, day) {
  const currentId = await currentSlotId(env, day);
  if (!currentId) return { locked: false, uploads: [] };
  const mine = await env.DB.prepare('SELECT id FROM memo_uploads WHERE slot_id = ? AND user_id = ?').bind(currentId, userId).first();
  if (!mine) return { locked: true, uploads: [] };
  const { results: uploads } = await env.DB.prepare(`SELECT u.*, us.name AS user_name FROM memo_uploads u
    JOIN users us ON us.id = u.user_id WHERE u.day = ? AND u.slot_id = ? ORDER BY u.uploaded_at DESC`).bind(day, currentId).all();
  const { results: counts } = await env.DB.prepare(`SELECT r.upload_id, r.emoji, COUNT(*) AS n FROM memo_reactions r
    JOIN memo_uploads u ON u.id = r.upload_id WHERE u.day = ? GROUP BY r.upload_id, r.emoji`).bind(day).all();
  const { results: mineRows } = await env.DB.prepare(`SELECT r.upload_id, r.emoji FROM memo_reactions r
    JOIN memo_uploads u ON u.id = r.upload_id WHERE u.day = ? AND r.user_id = ?`).bind(day, userId).all();
  return {
    locked: false,
    uploads: uploads.map((u) => ({
      id: u.id, userId: u.user_id, userName: u.user_name, mine: u.user_id === userId, kind: u.kind, flipped: !!u.flipped,
      uploadedAt: u.uploaded_at,
      reactions: Object.fromEntries(counts.filter((c) => c.upload_id === u.id).map((c) => [c.emoji, c.n])),
      myReaction: (mineRows.find((r) => r.upload_id === u.id) || {}).emoji || null,
    })),
  };
}

// The file out of R2, with Range so a video can scrub.
async function serve(env, request, key, mime) {
  if (!env.FILES) return Response.json({ error: 'err_server' }, { status: 500 });
  const range = request.headers.get('range');
  const obj = await env.FILES.get(key, range ? { range: request.headers } : undefined);
  if (!obj) return new Response(null, { status: 404 });
  const headers = new Headers({ 'content-type': mime, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600' });
  if (obj.range && obj.range.offset !== undefined) {
    const end = obj.range.offset + (obj.range.length ?? obj.size - obj.range.offset) - 1;
    headers.set('content-range', `bytes ${obj.range.offset}-${end}/${obj.size}`);
    return new Response(obj.body, { status: 206, headers });
  }
  return new Response(obj.body, { headers });
}

const fileFrom = async (request, kindOk) => {
  let form;
  try { form = await request.formData(); } catch { return { error: 'err_memo_invalid_type' }; }
  const file = form.get('file');
  if (!file || typeof file === 'string' || !kindOk(file.type || '')) return { error: 'err_memo_invalid_type' };
  if (file.size > MAX_FILE_BYTES) return { error: 'err_memo_file_too_large' };
  return { file };
};

export function addMemoRoutes({ routes, writes, getDyn, writeDyn, json, adminOnly, ownerOnly, now }) {
  const off = (ctx, day) => (available(ctx.env, ctx.user, day) ? null : json({ error: 'err_not_found' }, 404));
  const gate = async (ctx) => { const day = await todayOf(ctx.env); return { day, no: off(ctx, day) }; };
  const adminOn = (ctx) => (ctx.env.ENABLE_MEMO !== 'true' ? json({ error: 'err_not_found' }, 404) : adminOnly(ctx));

  routes['/api/memo/today'] = async (ctx) => {
    const { day, no } = await gate(ctx); if (no) return no;
    await ensureSlots(ctx.env, day);
    const { results: slots } = await ctx.env.DB.prepare('SELECT * FROM memo_slots WHERE day = ? ORDER BY slot_index').bind(day).all();
    const { results: ups } = await ctx.env.DB.prepare('SELECT * FROM memo_uploads WHERE user_id = ? AND day = ?').bind(ctx.user.id, day).all();
    const currentId = await currentSlotId(ctx.env, day);
    return json({ slots: slots.map((s) => ({ id: s.id, slotIndex: s.slot_index, ...statusOf(s, ups.find((u) => u.slot_id === s.id), currentId) })) });
  };
  routes['/api/memo/feed'] = async (ctx) => {
    const { day, no } = await gate(ctx); if (no) return no;
    return json(await feedOf(ctx.env, ctx.user.id, day));
  };
  routes['/api/memo/recaps'] = async (ctx) => {
    const { no } = await gate(ctx); if (no) return no;
    const { results } = await ctx.env.DB.prepare('SELECT day FROM memo_recaps ORDER BY day DESC').all();
    return json({ days: results.map((r) => r.day) });
  };
  routes['/api/admin/memo/days'] = async (ctx) => {
    const no = adminOn(ctx); if (no) return no;
    const { results } = await ctx.env.DB.prepare(`SELECT s.day AS day,
        (SELECT COUNT(*) FROM memo_slots s2 WHERE s2.day = s.day) AS totalSlots,
        (SELECT COUNT(*) FROM memo_uploads u2 WHERE u2.day = s.day) AS uploadedCount,
        (SELECT COUNT(*) FROM memo_recaps r WHERE r.day = s.day) AS hasRecap
      FROM memo_slots s WHERE s.notified_at IS NOT NULL GROUP BY s.day ORDER BY s.day DESC`).all();
    return json({ days: results.map((r) => ({ ...r, hasRecap: !!r.hasRecap })) });
  };

  getDyn.push([/^\/api\/memo\/uploads\/(\d+)$/, async (ctx, m) => {
    const { no } = await gate(ctx); if (no) return no;
    const up = await ctx.env.DB.prepare('SELECT file_path, mime_type FROM memo_uploads WHERE id = ?').bind(Number(m[1])).first();
    if (!up) return new Response(null, { status: 404 });
    return serve(ctx.env, ctx.request, up.file_path, up.mime_type); // every guest sees the shared feed
  }]);
  getDyn.push([/^\/api\/memo\/recaps\/([\d-]+)$/, async (ctx, m) => {
    const { no } = await gate(ctx); if (no) return no;
    const r = await ctx.env.DB.prepare('SELECT file_path, mime_type FROM memo_recaps WHERE day = ?').bind(m[1]).first();
    if (!r) return new Response(null, { status: 404 });
    return serve(ctx.env, ctx.request, r.file_path, r.mime_type);
  }]);
  getDyn.push([/^\/api\/admin\/memo\/([\d-]+)\/recap\/photos$/, async (ctx, m) => {
    const no = adminOn(ctx); if (no) return no;
    const { results } = await ctx.env.DB.prepare(
      "SELECT id FROM memo_uploads WHERE day = ? AND kind = 'photo' ORDER BY uploaded_at").bind(m[1]).all();
    if (!results.length) return json({ error: 'err_memo_no_photos' }, 400);
    return json({ ids: results.map((r) => r.id), secondsPerPhoto: RECAP_SECONDS_PER_PHOTO });
  }]);

  // Every upload of a day as one zip, files straight from R2 (same names as src/routes.js).
  getDyn.push([/^\/api\/admin\/memo\/([\d-]+)\/uploads\.zip$/, async (ctx, m) => {
    const no = adminOn(ctx); if (no) return no;
    const { results } = await ctx.env.DB.prepare(`SELECT u.id, u.slot_id, u.file_path, u.mime_type, us.name AS user_name
      FROM memo_uploads u JOIN users us ON us.id = u.user_id WHERE u.day = ? ORDER BY u.uploaded_at`).bind(m[1]).all();
    if (!results.length) return json({ error: 'err_memo_no_uploads' }, 404);
    const used = new Set(); const files = [];
    for (const u of results) {
      const obj = await ctx.env.FILES.get(u.file_path);
      if (!obj) continue;
      const ext = extFor(u.mime_type);
      const base = u.user_name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'sem-nome';
      let name = `${base}-momento${u.slot_id}${ext}`;
      if (used.has(name)) name = `${base}-momento${u.slot_id}-${u.id}${ext}`;
      used.add(name);
      files.push({ name, data: new Uint8Array(await obj.arrayBuffer()) });
    }
    if (!files.length) return json({ error: 'err_memo_no_uploads' }, 404);
    return new Response(makeZip(files), { headers: { 'content-type': 'application/zip',
      'content-disposition': `attachment; filename="memo-${m[1]}.zip"`, 'cache-control': 'no-store' } });
  }]);
  // The video is made on the admin's phone, so nothing runs here: done once stored, else idle.
  getDyn.push([/^\/api\/admin\/memo\/([\d-]+)\/recap\/status$/, async (ctx, m) => {
    const no = adminOn(ctx); if (no) return no;
    if (!(await ctx.env.DB.prepare('SELECT 1 AS x FROM memo_recaps WHERE day = ?').bind(m[1]).first())) return json({ status: 'idle' });
    const { n } = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM memo_uploads WHERE day = ? AND kind = 'photo'").bind(m[1]).first();
    return json({ status: 'done', photoCount: n });
  }]);
  // Owner only: rows and the files in R2 go.
  writes['POST /api/admin/memo/wipe'] = async (ctx) => {
    const off = ownerOnly(ctx); if (off) return off;
    const { results: a } = await ctx.env.DB.prepare('SELECT file_path FROM memo_uploads').all();
    const { results: b } = await ctx.env.DB.prepare('SELECT file_path FROM memo_recaps').all();
    const keys = [...a, ...b].map((r) => r.file_path);
    await ctx.env.DB.batch([ctx.env.DB.prepare('DELETE FROM memo_uploads'), ctx.env.DB.prepare('DELETE FROM memo_recaps'), ctx.env.DB.prepare('DELETE FROM memo_slots')]);
    for (let i = 0; i < keys.length; i += 1000) await ctx.env.FILES.delete(keys.slice(i, i + 1000));
    return json({ ok: true });
  };

  writes['POST /api/memo/slots/:id/upload'] = async (ctx) => {
    const { no } = await gate(ctx); if (no) return no;
    const { file, error } = await fileFrom(ctx.request, (t) => /^(image|video)\//.test(t));
    if (error) return json({ error }, 400);
    const slot = await ctx.env.DB.prepare('SELECT * FROM memo_slots WHERE id = ?').bind(ctx.id).first();
    if (!slot) return json({ error: 'err_memo_slot_not_found' }, 404);
    const mine = await ctx.env.DB.prepare('SELECT * FROM memo_uploads WHERE slot_id = ? AND user_id = ?').bind(ctx.id, ctx.user.id).first();
    const st = statusOf(slot, mine, await currentSlotId(ctx.env, slot.day));
    if (st.status !== 'open') return json({ error: st.status === 'uploaded' ? 'err_memo_already_uploaded' : 'err_memo_slot_not_open' }, 409);
    let body = file.stream(); let mime = file.type; let size = file.size;
    if (ctx.env.APP_ENV === 'demo') { // a visitor's real photo never stays on the demo: it keeps the placeholder
      const ph = await ctx.env.ASSETS.fetch(new Request(new URL('/images/demo-photo.jpg', ctx.request.url)));
      const buf = await ph.arrayBuffer(); body = buf; mime = 'image/jpeg'; size = buf.byteLength;
    }
    const key = `${slot.day}/${ctx.user.id}-slot${ctx.id}${extFor(mime)}`;
    await ctx.env.FILES.put(key, body, { httpMetadata: { contentType: mime } });
    try {
      const row = await ctx.env.DB.prepare(`INSERT INTO memo_uploads (slot_id, user_id, day, kind, mime_type, file_path, file_size)
        VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id, kind`)
        .bind(ctx.id, ctx.user.id, slot.day, mime.startsWith('video/') ? 'video' : 'photo', mime, key, size).first();
      return json({ id: row.id, kind: row.kind }, 201);
    } catch { // a double tap lost the race on UNIQUE(slot_id, user_id)
      return json({ error: 'err_memo_already_uploaded' }, 409);
    }
  };
  writes['POST /api/memo/uploads/:id/flip'] = async (ctx) => {
    const { no } = await gate(ctx); if (no) return no;
    const row = await ctx.env.DB.prepare('SELECT user_id FROM memo_uploads WHERE id = ?').bind(ctx.id).first();
    if (!row) return json({ error: 'err_not_found' }, 404);
    if (row.user_id !== ctx.user.id) return json({ error: 'err_not_your_photo' }, 403);
    const flipped = !!ctx.body.flipped;
    await ctx.env.DB.prepare('UPDATE memo_uploads SET flipped = ? WHERE id = ?').bind(flipped ? 1 : 0, ctx.id).run();
    return json({ flipped });
  };
  writes['POST /api/memo/uploads/:id/react'] = async (ctx) => {
    const { no } = await gate(ctx); if (no) return no;
    const emoji = ctx.body.emoji;
    if (!REACTIONS.includes(emoji)) return json({ error: 'err_memo_invalid_reaction' }, 400);
    if (!(await ctx.env.DB.prepare('SELECT id FROM memo_uploads WHERE id = ?').bind(ctx.id).first())) return json({ error: 'err_memo_slot_not_found' }, 404);
    const had = await ctx.env.DB.prepare('SELECT emoji FROM memo_reactions WHERE upload_id = ? AND user_id = ?').bind(ctx.id, ctx.user.id).first();
    if (had && had.emoji === emoji) {
      await ctx.env.DB.prepare('DELETE FROM memo_reactions WHERE upload_id = ? AND user_id = ?').bind(ctx.id, ctx.user.id).run();
      return json({ emoji: null });
    }
    await ctx.env.DB.prepare(`INSERT INTO memo_reactions (upload_id, user_id, emoji) VALUES (?, ?, ?)
      ON CONFLICT(upload_id, user_id) DO UPDATE SET emoji = excluded.emoji, created_at = ${now}`).bind(ctx.id, ctx.user.id, emoji).run();
    return json({ emoji });
  };
  // Brings today's next unfired moment forward to now (the push that tells guests comes with the push card).
  writes['POST /api/admin/memo/trigger-next'] = async (ctx) => {
    const no = adminOn(ctx); if (no) return no;
    const day = await todayOf(ctx.env);
    await ensureSlots(ctx.env, day);
    const slot = await ctx.env.DB.prepare(`SELECT id, day, slot_index FROM memo_slots
      WHERE day = ? AND notified_at IS NULL ORDER BY scheduled_at LIMIT 1`).bind(day).first();
    if (!slot) return json({ error: 'err_memo_no_slots_left' }, 400);
    await ctx.env.DB.prepare('UPDATE memo_slots SET notified_at = ? WHERE id = ?').bind(stamp(clock()), slot.id).run();
    return json({ ok: true, slotId: slot.id, slotIndex: slot.slot_index });
  };

  const saveRecap = async (ctx, day, publish) => {
    const no = adminOn(ctx); if (no) return no;
    if (publish && !(await ctx.env.DB.prepare("SELECT 1 AS x FROM memo_uploads WHERE day = ? AND kind = 'photo' LIMIT 1").bind(day).first())) {
      return json({ error: 'err_memo_no_photos' }, 400);
    }
    const { file, error } = await fileFrom(ctx.request, (t) => t.startsWith('video/'));
    if (error) return json({ error }, 400);
    const key = `${day}/recap${extFor(file.type)}`;
    await ctx.env.FILES.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
    await ctx.env.DB.prepare(`INSERT INTO memo_recaps (day, file_path, mime_type, file_size, uploaded_by) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET file_path = excluded.file_path, mime_type = excluded.mime_type,
        file_size = excluded.file_size, uploaded_by = excluded.uploaded_by, uploaded_at = ${now}`)
      .bind(day, key, file.type, file.size, ctx.user.id).run();
    if (!publish) return json({ ok: true }, 201);
    // The Wall's video post for that day (createVideoPost in src/plaza.js).
    const old = await ctx.env.DB.prepare("SELECT id FROM plaza_posts WHERE type = 'video' AND text = ?").bind(day).first();
    if (old) await ctx.env.DB.prepare(`UPDATE plaza_posts SET author_id = ?, created_at = ${now} WHERE id = ?`).bind(ctx.user.id, old.id).run();
    else await ctx.env.DB.prepare("INSERT INTO plaza_posts (type, author_id, text) VALUES ('video', ?, ?)").bind(ctx.user.id, day).run();
    const { n } = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM memo_uploads WHERE day = ? AND kind = 'photo'").bind(day).first();
    return json({ ok: true, photoCount: n }, 201);
  };
  writeDyn.push(['POST', /^\/api\/admin\/memo\/([\d-]+)\/recap$/, (ctx, m) => saveRecap(ctx, m[1], false)]);
  writeDyn.push(['POST', /^\/api\/admin\/memo\/([\d-]+)\/recap\/publish$/, (ctx, m) => saveRecap(ctx, m[1], true)]);
}
