// Snatch on the Worker (APP-LG-032): voting status, Miss Congeniality, the admin
// voting controls, contestants and photos. Port of src/votes.js and the Snatch
// routes in src/routes.js; D1 instead of node:sqlite. Same rules, same errors.
import { isNight, DEFAULT_NIGHT, NIGHTS } from './nights.js';
import { broadcast } from './workerPush.js';

const REVEAL_PHASES = ['hidden', 'third', 'second', 'first', 'all'];
const CONG_PHASES = ['closed', 'open', 'revealed'];
const MAX_PHOTO_BYTES = 400 * 1024;

// Tie-break state lives in settings. The outfit vote's keys are unprefixed, Miss Congeniality's start with cong_.
const runoffKeys = (p) => ({
  round: (n) => `${p}runoff_round_${n}`, ids: (n) => `${p}runoff_ids_${n}`,
  rank: (n) => `${p}runoff_rank_${n}`, order: (n) => `${p}tiebreak_order_${n}`,
});
const OUTFIT = runoffKeys('');
const CONG = runoffKeys('cong_');

const getSetting = async (env, key, dflt = null) => {
  const r = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return r ? r.value : dflt;
};
const setStmt = (env, key, value) => env.DB.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, String(value));
const setSetting = (env, key, value) => setStmt(env, key, value).run();
const nightStatus = async (env, night) => {
  const s = await getSetting(env, `voting_status_${night}`, 'closed');
  return s === 'registration' || s === 'open' ? s : 'closed';
};
const roundFor = async (env, keys, night) => Number(await getSetting(env, keys.round(night), 0)) || 0;
const idsFor = async (env, keys, night) => {
  const raw = await getSetting(env, keys.ids(night));
  return raw ? JSON.parse(raw) : null;
};
const orderFor = async (env, keys, night) => {
  const raw = await getSetting(env, keys.order(night));
  if (!raw) return [];
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch { return []; }
};
const discardStmts = (env, keys, night) => [
  setStmt(env, keys.ids(night), ''), setStmt(env, keys.round(night), '0'),
  setStmt(env, keys.rank(night), ''), setStmt(env, keys.order(night), '')];

function rankRows(rows, order) {
  const byVotes = new Map();
  for (const r of rows) {
    if (!byVotes.has(r.votes)) byVotes.set(r.votes, []);
    byVotes.get(r.votes).push(r);
  }
  const out = [];
  let place = 1;
  for (const votes of [...byVotes.keys()].sort((a, b) => b - a)) {
    const group = byVotes.get(votes);
    const isRealTie = group.length > 1 && votes > 0;
    const settled = isRealTie && group.every((r) => order.includes(r.id));
    const ordered = settled ? [...group].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)) : group;
    ordered.forEach((r, i) => out.push({ ...r, rank: settled ? place + i : place, tied: isRealTie && !settled }));
    place += group.length;
  }
  return out;
}

async function beginRunoff(env, keys, night, results, atRank) {
  const tiedPlaces = [...new Set(results.filter((r) => r.tied).map((r) => r.rank))].sort((a, b) => a - b);
  const rank = atRank == null ? tiedPlaces[0] : Number(atRank);
  if (rank == null || Number.isNaN(rank)) return { error: 'err_no_tie' };
  const tied = results.filter((r) => r.tied && r.rank === rank);
  if (tied.length < 2) return { error: 'err_no_tie' };
  // A new round, not a wipe: the real tally survives and the placings below the tie stay.
  const next = (await roundFor(env, keys, night)) + 1;
  await env.DB.batch([
    setStmt(env, keys.round(night), next), setStmt(env, keys.ids(night), JSON.stringify(tied.map((r) => r.id))),
    setStmt(env, keys.rank(night), rank)]);
  return { ok: true, rank, ids: tied.map((r) => r.id) };
}

async function endRunoff(env, keys, night, tallies) {
  const ids = await idsFor(env, keys, night);
  if (!ids) return { error: 'err_no_runoff' };
  const order = [...ids].sort((a, b) => tallies.get(b) - tallies.get(a));
  const stillTied = tallies.get(order[0]) === tallies.get(order[order.length - 1]);
  const stmts = [setStmt(env, keys.round(night), '0'), setStmt(env, keys.ids(night), ''), setStmt(env, keys.rank(night), '')];
  if (!stillTied) {
    const kept = (await orderFor(env, keys, night)).filter((id) => !ids.includes(id));
    stmts.push(setStmt(env, keys.order(night), JSON.stringify([...kept, ...order])));
  }
  await env.DB.batch(stmts);
  return stillTied ? { ok: true, stillTied: true } : { ok: true, stillTied: false, order };
}

const resultsPhase = (env, night) => getSetting(env, `results_phase_${night}`, 'hidden');

async function resultsForNight(env, night) {
  const round = await roundFor(env, OUTFIT, night);
  const { results: rows } = await env.DB.prepare(`
    SELECT c.id, c.name, u1.name AS registeredBy, u2.name AS partnerName, COUNT(v.id) AS votes,
           c.photo IS NOT NULL AS hasPhoto
    FROM contestants c
    LEFT JOIN users u1 ON u1.id = c.user_id
    LEFT JOIN users u2 ON u2.id = c.partner_user_id
    LEFT JOIN votes v ON v.contestant_id = c.id AND v.night = c.night AND v.round = ? AND v.confirmed_at IS NOT NULL
    WHERE c.night = ? AND c.confirmed_at IS NOT NULL
    GROUP BY c.id ORDER BY votes DESC, c.name COLLATE NOCASE`).bind(round, night).all();
  const runoff = await idsFor(env, OUTFIT, night);
  const scoped = runoff ? rows.filter((r) => runoff.includes(r.id)) : rows;
  return rankRows(scoped.map((r) => ({ ...r, hasPhoto: !!r.hasPhoto })), await orderFor(env, OUTFIT, night));
}

async function visibleResults(env, night) {
  const all = await resultsForNight(env, night);
  const phase = await resultsPhase(env, night);
  let results;
  if (phase === 'hidden') results = [];
  else if (phase === 'third') results = all.filter((r) => r.rank === 3);
  else if (phase === 'second') results = all.filter((r) => r.rank === 2 || r.rank === 3);
  else if (phase === 'first') results = all.filter((r) => r.rank <= 3);
  else results = all;
  return { phase, results };
}

async function contestantsForNight(env, night) {
  const { results: rows } = await env.DB.prepare(`
    SELECT c.id, c.name, u1.name AS registeredBy, u2.name AS partnerName
    FROM contestants c LEFT JOIN users u1 ON u1.id = c.user_id LEFT JOIN users u2 ON u2.id = c.partner_user_id
    WHERE c.night = ? AND c.confirmed_at IS NOT NULL ORDER BY c.name COLLATE NOCASE`).bind(night).all();
  const runoff = await idsFor(env, OUTFIT, night);
  return runoff ? rows.filter((r) => runoff.includes(r.id)) : rows;
}

async function myVoteForNight(env, userId, night) {
  const e = await env.DB.prepare('SELECT user_id, partner_user_id FROM contestants WHERE night = ? AND (user_id = ? OR partner_user_id = ?)')
    .bind(night, userId, userId).first();
  const partnerId = e ? (e.user_id === userId ? e.partner_user_id : e.user_id) : null;
  const row = await env.DB.prepare(
    'SELECT user_id, contestant_id, confirmed_at FROM votes WHERE night = ? AND round = ? AND user_id IN (?, ?)')
    .bind(night, await roundFor(env, OUTFIT, night), userId, partnerId ?? userId).first();
  if (!row) return null;
  const partnerName = partnerId ? (await env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(partnerId).first())?.name ?? null : null;
  return { contestant_id: row.contestant_id, confirmed: !!row.confirmed_at, proposedByMe: row.user_id === userId, partnerName };
}

async function myContestantForNight(env, userId, night) {
  const row = await env.DB.prepare(`
    SELECT c.id, c.name, c.user_id, c.confirmed_at, c.photo IS NOT NULL AS hasPhoto,
           u1.name AS registrant_name, u2.name AS partner_name
    FROM contestants c LEFT JOIN users u1 ON u1.id = c.user_id LEFT JOIN users u2 ON u2.id = c.partner_user_id
    WHERE c.night = ? AND (c.user_id = ? OR c.partner_user_id = ?)`).bind(night, userId, userId).first();
  if (!row) return null;
  return {
    id: row.id, name: row.name, partnerName: (row.user_id === userId ? row.partner_name : row.registrant_name) || null,
    confirmed: !!row.confirmed_at, registeredByMe: row.user_id === userId, hasPhoto: !!row.hasPhoto,
  };
}

const congStatus = async (env, night) => {
  const s = await getSetting(env, `congeniality_status_${night}`, 'closed');
  return CONG_PHASES.includes(s) ? s : 'closed';
};
const allCandidates = async (env) => (await env.DB.prepare(
  'SELECT id, name FROM users WHERE is_owner = 0 ORDER BY name COLLATE NOCASE').all()).results;
async function congCandidates(env, night) {
  const rows = await allCandidates(env);
  const runoff = await idsFor(env, CONG, night);
  return runoff ? rows.filter((r) => runoff.includes(r.id)) : rows;
}
async function myCongVote(env, userId, night) {
  const row = await env.DB.prepare('SELECT target_user_id FROM congeniality_votes WHERE user_id = ? AND night = ? AND round = ?')
    .bind(userId, night, await roundFor(env, CONG, night)).first();
  return row ? row.target_user_id : null;
}
async function congResults(env, night) {
  const { results: rows } = await env.DB.prepare(`
    SELECT u.id, u.name, COUNT(v.id) AS votes FROM users u
    LEFT JOIN congeniality_votes v ON v.target_user_id = u.id AND v.night = ? AND v.round = ?
    WHERE u.is_owner = 0 GROUP BY u.id ORDER BY votes DESC, u.name COLLATE NOCASE`)
    .bind(night, await roundFor(env, CONG, night)).all();
  const runoff = await idsFor(env, CONG, night);
  return rankRows(runoff ? rows.filter((r) => runoff.includes(r.id)) : rows, await orderFor(env, CONG, night));
}
async function congWinner(env, night) {
  if ((await congStatus(env, night)) !== 'revealed') return null;
  const top = (await congResults(env, night)).filter((r) => r.rank === 1);
  return top.length === 1 && top[0].votes > 0 ? top[0] : null;
}

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

// A zip with the files stored, not compressed (jpegs do not shrink): no library needed on a Worker.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
export function makeZip(files) {
  const enc = new TextEncoder();
  const parts = []; const central = []; let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name); const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint32(14, crc, true); local.setUint32(18, f.data.length, true); local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint32(16, crc, true); c.setUint32(20, f.data.length, true); c.setUint32(24, f.data.length, true);
    c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const size = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, size, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

// D1 was seeded with the old one-vote-per-night indexes next to the per-round ones, so a runoff ballot
// (round 1) would be refused. Dropping them is idempotent; done once per Worker instance, no D1 command needed.
let roundsFixed = false;
export async function ensureVoteRounds(env) {
  if (roundsFixed) return;
  await env.DB.prepare('DROP INDEX IF EXISTS idx_vote_user_night').run();
  await env.DB.prepare('DROP INDEX IF EXISTS idx_congeniality_user_night').run();
  roundsFixed = true;
}

const NIGHT_LABEL = { furnished: 'furnished', swamp: 'swamp' };
const REVEAL_NOTIFY = {
  third: { pt: 'já sabes quem ficou em 3º lugar!', en: 'the 3rd place result is in!' },
  second: { pt: 'já sabes quem ficou em 2º lugar!', en: 'the 2nd place result is in!' },
  first: { pt: 'já sabes quem ficou em 1º lugar!', en: 'the 1st place result is in!' },
  all: { pt: 'já podes ver quem ganhou o snatch!', en: 'you can now see who won snatch!' },
};
const CONG_NOTIFY = {
  open: { pt: (n) => `miss congeniality: a votação abriu para a noite ${n}.`, en: (n) => `miss congeniality: voting is open for ${n} night.` },
  revealed: { pt: (n) => `miss congeniality: já se sabe quem ganhou a noite ${n}.`, en: (n) => `miss congeniality: the winner for ${n} night is in.` },
};

export function addVotesRoutes({ routes, writes, getDyn, writeDyn, json, adminOnly, ownerOnly }) {
  const bad = (error, status = 400, extra = {}) => json({ error, ...extra }, status);
  const nightOf = (v) => (isNight(v) ? v : DEFAULT_NIGHT);
  const url = (night) => `/?tab=outfit&night=${encodeURIComponent(night)}`;
  const tell = (ctx, tag, pt, en) => ctx.exec.waitUntil(broadcast(ctx.env, { title: { pt: 'snatch', en: 'snatch' }, body: { pt, en }, tag, url: url(ctx.night) }));

  routes['/api/votes/status'] = async (ctx) => {
    const { env, user } = ctx;
    const night = nightOf(ctx.url.searchParams.get('night'));
    const status = await nightStatus(env, night);
    const { phase, results } = status === 'closed' ? await visibleResults(env, night) : { phase: null, results: null };
    return json({
      night, status, started: (await getSetting(env, `voting_started_${night}`)) === '1',
      contestants: await contestantsForNight(env, night),
      myVote: await myVoteForNight(env, user.id, night),
      myContestant: await myContestantForNight(env, user.id, night),
      results, resultsPhase: phase, runoffActive: (await idsFor(env, OUTFIT, night)) !== null,
      congeniality: {
        status: await congStatus(env, night), candidates: await congCandidates(env, night),
        myVote: await myCongVote(env, user.id, night), winner: await congWinner(env, night),
        runoffActive: (await idsFor(env, CONG, night)) !== null,
      },
    });
  };

  writes['POST /api/congeniality/vote'] = async (ctx) => {
    const { env, user, body } = ctx;
    await ensureVoteRounds(env);
    const night = nightOf(body.night);
    const target = Number(body.targetUserId);
    if ((await congStatus(env, night)) !== 'open') return bad('err_congeniality_not_open');
    if (target === user.id) return bad('err_cannot_vote_self');
    if (!(await allCandidates(env)).some((c) => c.id === target)) return bad('err_not_a_candidate');
    const runoff = await idsFor(env, CONG, night);
    if (runoff && !runoff.includes(target)) return bad('err_not_in_runoff');
    if ((await myCongVote(env, user.id, night)) !== null) return bad('err_already_voted');
    try {
      await env.DB.prepare('INSERT INTO congeniality_votes (user_id, target_user_id, night, round) VALUES (?, ?, ?, ?)')
        .bind(user.id, target, night, await roundFor(env, CONG, night)).run();
    } catch (e) { if (String(e?.message || '').includes('UNIQUE')) return bad('err_already_voted'); throw e; }
    return json({ ok: true }, 201);
  };

  writes['PUT /api/outfit/register/photo'] = async (ctx) => {
    const { env, user, body } = ctx;
    const night = nightOf(body.night);
    if ((await nightStatus(env, night)) !== 'registration') return bad('err_registration_not_open');
    const row = await env.DB.prepare('SELECT id FROM contestants WHERE night = ? AND (user_id = ? OR partner_user_id = ?)').bind(night, user.id, user.id).first();
    if (!row) return bad('err_no_contestant_entry');
    const photo = decodePhoto(body.photoBase64 || '');
    if (photo.error) return bad(photo.error);
    await env.DB.prepare('UPDATE contestants SET photo = ?, photo_mime = ? WHERE id = ?').bind(photo.bytes, photo.mime, row.id).run();
    return json({ ok: true });
  };

  // Own entry and admins always; everyone else only once that rank has been revealed.
  getDyn.push([/^\/api\/outfit\/contestants\/(\d+)\/photo$/, async (ctx, m) => {
    const row = await ctx.env.DB.prepare(
      'SELECT id, night, user_id, partner_user_id, photo, photo_mime FROM contestants WHERE id = ? AND photo IS NOT NULL').bind(Number(m[1])).first();
    const missing = new Response(null, { status: 404 });
    if (!row) return missing;
    const own = row.user_id === ctx.user.id || row.partner_user_id === ctx.user.id;
    if (!own && !ctx.user.is_admin && !ctx.user.is_owner) {
      const { results } = await visibleResults(ctx.env, row.night);
      if (!results.some((r) => r.id === row.id)) return missing;
    }
    const bytes = row.photo instanceof ArrayBuffer ? new Uint8Array(row.photo) : Uint8Array.from(row.photo);
    return new Response(bytes, { headers: { 'content-type': row.photo_mime || 'image/jpeg', 'cache-control': 'no-store' } });
  }]);

  // ---- admin ----
  routes['/api/admin/voting'] = async (ctx) => {
    const off = adminOnly(ctx); if (off) return off;
    const { env } = ctx;
    const { n: eligible } = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
    const nights = [];
    for (const night of NIGHTS) {
      const round = await roundFor(env, OUTFIT, night);
      // Users without a confirmed vote: duo partners share one vote row, as myVoteForNight() sees it.
      const { results: users } = await env.DB.prepare('SELECT id FROM users').all();
      const { results: cs } = await env.DB.prepare('SELECT user_id, partner_user_id FROM contestants WHERE night = ?').bind(night).all();
      const { results: vs } = await env.DB.prepare(
        'SELECT user_id FROM votes WHERE night = ? AND round = ? AND confirmed_at IS NOT NULL').bind(night, round).all();
      const voted = new Set(vs.map((v) => v.user_id));
      const partner = new Map();
      for (const c of cs) { if (c.user_id && c.partner_user_id) { partner.set(c.user_id, c.partner_user_id); partner.set(c.partner_user_id, c.user_id); } }
      const notVoted = users.filter((u) => !voted.has(u.id) && !(partner.has(u.id) && voted.has(partner.get(u.id)))).length;
      nights.push({
        night, status: await nightStatus(env, night), resultsPhase: await resultsPhase(env, night),
        started: (await getSetting(env, `voting_started_${night}`)) === '1', notVoted, eligibleVoters: eligible,
        runoffActive: (await idsFor(env, OUTFIT, night)) !== null, congenialityStatus: await congStatus(env, night),
        congenialityResults: await congResults(env, night), congenialityRunoffActive: (await idsFor(env, CONG, night)) !== null,
      });
    }
    return json({ nights });
  };

  routes['/api/admin/contestants'] = async (ctx) => {
    const off = adminOnly(ctx); if (off) return off;
    const night = nightOf(ctx.url.searchParams.get('night'));
    const { results } = await ctx.env.DB.prepare(`
      SELECT c.id, c.name, c.night, u1.name AS registered_by, u2.name AS partner_name,
             c.confirmed_at IS NOT NULL AS confirmed, c.photo IS NOT NULL AS hasPhoto
      FROM contestants c LEFT JOIN users u1 ON u1.id = c.user_id LEFT JOIN users u2 ON u2.id = c.partner_user_id
      WHERE c.night = ? ORDER BY c.name COLLATE NOCASE`).bind(night).all();
    return json({ night, contestants: results });
  };

  getDyn.push([/^\/api\/admin\/outfit\/([^/]+)\/photos\.zip$/, async (ctx, m) => {
    const off = adminOnly(ctx); if (off) return off;
    const night = m[1];
    if (!isNight(night)) return bad('err_invalid_night');
    const { results } = await ctx.env.DB.prepare(
      'SELECT id, name, photo FROM contestants WHERE night = ? AND photo IS NOT NULL ORDER BY name COLLATE NOCASE').bind(night).all();
    if (!results.length) return bad('err_no_photos', 404);
    const used = new Set();
    const files = results.map((p) => {
      const base = p.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'sem-nome';
      let name = `${base}.jpg`;
      if (used.has(name)) name = `${base}-${p.id}.jpg`;
      used.add(name);
      return { name, data: p.photo instanceof ArrayBuffer ? new Uint8Array(p.photo) : Uint8Array.from(p.photo) };
    });
    return new Response(makeZip(files), { headers: { 'content-type': 'application/zip',
      'content-disposition': `attachment; filename="snatch-${night}-photos.zip"`, 'cache-control': 'no-store' } });
  }]);

  writes['POST /api/admin/contestants'] = async (ctx) => {
    const off = adminOnly(ctx); if (off) return off;
    const { env, body } = ctx;
    const name = String(body.name ?? '').trim();
    const night = nightOf(body.night);
    if (!name) return bad('err_name_missing');
    let userId = null;
    if (body.userId) {
      userId = Number(body.userId);
      if (!(await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first())) return bad('err_user_invalid');
      if (await env.DB.prepare('SELECT id FROM contestants WHERE night = ? AND (user_id = ? OR partner_user_id = ?)').bind(night, userId, userId).first()) {
        return bad('err_already_registered_this_night');
      }
    }
    const row = await env.DB.prepare(
      "INSERT INTO contestants (name, night, user_id, confirmed_at) VALUES (?, ?, ?, datetime('now')) RETURNING id").bind(name, night, userId).first();
    return json({ id: row.id, name, night }, 201);
  };

  writes['POST /api/admin/contestants/register'] = async (ctx) => {
    const off = adminOnly(ctx); if (off) return off;
    const { env, body } = ctx;
    const night = nightOf(body.night);
    const userId = Number(body.userId);
    if (!userId) return bad('err_choose_user');
    if ((await nightStatus(env, night)) !== 'registration') return bad('err_registration_not_open');
    if (await env.DB.prepare('SELECT id FROM contestants WHERE night = ? AND (user_id = ? OR partner_user_id = ?)').bind(night, userId, userId).first()) return bad('err_you_already_registered');
    const name = String(body.name || '').trim();
    if (!name) return bad('err_persona_name_required');
    if (name.length > 60) return bad('err_max_60_chars');
    let photo = null;
    if (body.photoBase64) { photo = decodePhoto(body.photoBase64); if (photo.error) return bad(photo.error); }
    let partnerId = null;
    if (body.partnerUserId) {
      partnerId = Number(body.partnerUserId);
      if (partnerId === userId) return bad('err_cannot_partner_with_self');
      if (!(await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(partnerId).first())) return bad('err_user_invalid');
      if (await env.DB.prepare('SELECT id FROM contestants WHERE night = ? AND (user_id = ? OR partner_user_id = ?)').bind(night, partnerId, partnerId).first()) return bad('err_already_registered_this_night');
    }
    const row = await env.DB.prepare(
      `INSERT INTO contestants (name, night, user_id, partner_user_id, photo, photo_mime, confirmed_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now')) RETURNING id`).bind(name, night, userId, partnerId, photo?.bytes ?? null, photo?.mime ?? null).first();
    return json({ ok: true, id: row.id, name, pending: false }, 201);
  };

  writes['PATCH /api/admin/contestants/:id'] = async (ctx) => {
    const off = adminOnly(ctx); if (off) return off;
    const name = String(ctx.body.name ?? '').trim();
    if (!name) return bad('err_name_missing');
    if (name.length > 60) return bad('err_max_60_chars');
    const res = await ctx.env.DB.prepare('UPDATE contestants SET name = ? WHERE id = ?').bind(name, ctx.id).run();
    if (!res.meta.changes) return bad('err_contestant_not_found', 404);
    return json({ ok: true });
  };
  writes['DELETE /api/admin/contestants/:id'] = async (ctx) => {
    const off = ownerOnly(ctx); if (off) return off;
    await ctx.env.DB.prepare('DELETE FROM contestants WHERE id = ?').bind(ctx.id).run();
    return json({ ok: true });
  };

  // /api/admin/voting/:night/<action>[/<sub>]
  const actions = {};
  actions.registration = async (ctx, night) => {
    const { env } = ctx;
    await env.DB.batch([env.DB.prepare('DELETE FROM votes WHERE night = ?').bind(night), setStmt(env, `runoff_ids_${night}`, ''),
      ...discardStmts(env, CONG, night), env.DB.prepare('DELETE FROM congeniality_votes WHERE night = ?').bind(night),
      setStmt(env, `congeniality_status_${night}`, 'closed'), setStmt(env, `voting_status_${night}`, 'registration'),
      setStmt(env, `voting_started_${night}`, '1'), setStmt(env, `results_phase_${night}`, 'hidden')]);
    tell(ctx, 'outfit-registration', `as inscrições para a noite ${NIGHT_LABEL[night]} estão abertas!`, `entries for ${NIGHT_LABEL[night]} night are open!`);
    return json({ ok: true, night, votingStatus: 'registration' });
  };
  actions.open = async (ctx, night) => {
    const { env, body } = ctx;
    const { n: pending } = await env.DB.prepare('SELECT COUNT(*) AS n FROM contestants WHERE night = ? AND confirmed_at IS NULL').bind(night).first();
    if (pending > 0 && !body.force) return bad('err_pending_duo_entries', 409, { pending });
    const { results: rows } = await env.DB.prepare('SELECT user_id, partner_user_id FROM contestants WHERE night = ? AND confirmed_at IS NOT NULL').bind(night).all();
    const people = new Set();
    for (const r of rows) { if (r.user_id) people.add(r.user_id); if (r.partner_user_id) people.add(r.partner_user_id); }
    const { n: expected } = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
    if (people.size < expected && !body.force) return bad('err_not_everyone_entered', 409, { entered: people.size, expected });
    await env.DB.batch([setStmt(env, `voting_status_${night}`, 'open'), setStmt(env, `voting_started_${night}`, '1'), setStmt(env, `results_phase_${night}`, 'hidden')]);
    tell(ctx, 'outfit-voting', `a votação da noite ${NIGHT_LABEL[night]} está aberta!`, `voting for ${NIGHT_LABEL[night]} night is open!`);
    return json({ ok: true, night, votingStatus: 'open' });
  };
  actions.close = async (ctx, night) => {
    const { env, body } = ctx;
    const { n: pending } = await env.DB.prepare('SELECT COUNT(*) AS n FROM votes WHERE night = ? AND round = ? AND confirmed_at IS NULL')
      .bind(night, await roundFor(env, OUTFIT, night)).first();
    if (pending > 0 && !body.force) return bad('err_pending_duo_votes', 409, { pending });
    await setSetting(env, `voting_status_${night}`, 'closed');
    let settled = null;
    const ids = await idsFor(env, OUTFIT, night);
    if (ids) {
      const tallies = new Map(ids.map((id) => [id, 0]));
      const { results } = await env.DB.prepare(
        'SELECT contestant_id AS id, COUNT(*) AS votes FROM votes WHERE night = ? AND round = ? AND confirmed_at IS NOT NULL GROUP BY contestant_id')
        .bind(night, await roundFor(env, OUTFIT, night)).all();
      for (const r of results) if (tallies.has(r.id)) tallies.set(r.id, r.votes);
      settled = await endRunoff(env, OUTFIT, night, tallies);
    }
    await setSetting(env, `results_phase_${night}`, 'hidden');
    tell(ctx, 'outfit-closed', `a votação da noite ${NIGHT_LABEL[night]} fechou, os resultados vêm aí.`, `voting for ${NIGHT_LABEL[night]} night is closed, results coming soon.`);
    return json({ ok: true, night, votingStatus: 'closed', ...(settled ? { runoffResolved: true, stillTied: !!settled.stillTied } : {}) });
  };
  actions['reveal-next'] = async (ctx, night) => {
    const idx = REVEAL_PHASES.indexOf(await resultsPhase(ctx.env, night));
    const phase = REVEAL_PHASES[Math.min(idx + 1, REVEAL_PHASES.length - 1)];
    await setSetting(ctx.env, `results_phase_${night}`, phase);
    if (REVEAL_NOTIFY[phase]) ctx.exec.waitUntil(broadcast(ctx.env, { title: { pt: 'snatch', en: 'snatch' }, body: REVEAL_NOTIFY[phase], tag: 'results', url: url(night) }));
    return json({ ok: true, night, resultsPhase: phase });
  };
  actions.reset = async (ctx, night) => {
    const { env } = ctx;
    await env.DB.batch([env.DB.prepare('DELETE FROM votes WHERE night = ?').bind(night), setStmt(env, `runoff_ids_${night}`, ''),
      env.DB.prepare('DELETE FROM congeniality_votes WHERE night = ?').bind(night), ...discardStmts(env, CONG, night),
      setStmt(env, `congeniality_status_${night}`, 'closed'), setStmt(env, `voting_status_${night}`, 'open'),
      setStmt(env, `voting_started_${night}`, '1'), setStmt(env, `results_phase_${night}`, 'hidden')]);
    return json({ ok: true, night, votingStatus: 'open' });
  };
  actions['reset-all'] = async (ctx, night) => {
    const { env } = ctx;
    await env.DB.batch([env.DB.prepare('DELETE FROM contestants WHERE night = ?').bind(night), setStmt(env, `runoff_ids_${night}`, ''),
      env.DB.prepare('DELETE FROM congeniality_votes WHERE night = ?').bind(night), ...discardStmts(env, CONG, night),
      setStmt(env, `congeniality_status_${night}`, 'closed'), setStmt(env, `voting_status_${night}`, 'closed'),
      setStmt(env, `voting_started_${night}`, '0'), setStmt(env, `results_phase_${night}`, 'hidden')]);
    return json({ ok: true, night, votingStatus: 'closed' });
  };
  actions.runoff = async (ctx, night) => {
    const { env, body } = ctx;
    if ((await nightStatus(env, night)) !== 'closed') return bad('err_voting_not_closed', 409);
    const started = await beginRunoff(env, OUTFIT, night, await resultsForNight(env, night), body.rank ?? null);
    if (started.error) return bad(started.error, 409);
    await env.DB.batch([setStmt(env, `results_phase_${night}`, 'hidden'), setStmt(env, `voting_status_${night}`, 'open')]);
    tell(ctx, 'outfit-voting', `houve um empate na noite ${NIGHT_LABEL[night]}, vota outra vez!`, `it's a tie on ${NIGHT_LABEL[night]} night, vote again!`);
    return json({ ok: true, night, votingStatus: 'open', rank: started.rank, contestantIds: started.ids });
  };
  actions['publish-podium'] = async (ctx, night) => {
    const off = ownerOnly(ctx); if (off) return off;
    const { env } = ctx;
    if ((await resultsPhase(env, night)) !== 'all') return bad('err_results_not_revealed');
    const cs = await congStatus(env, night);
    const congVotes = (await congResults(env, night)).reduce((n, r) => n + r.votes, 0);
    if (cs === 'open' || (cs === 'closed' && congVotes > 0)) return bad('err_congeniality_not_revealed');
    const standings = await resultsForNight(env, night);
    const unsettled = standings.find((r) => r.tied && r.rank <= 3);
    if (unsettled) return bad('err_tie_unresolved', 400, { rank: unsettled.rank });
    const podium = standings.filter((r) => r.rank <= 3).map((r) => ({
      rank: r.rank, id: r.id, name: r.name, votes: r.votes, hasPhoto: r.hasPhoto, registeredBy: r.registeredBy, partnerName: r.partnerName }));
    if (!podium.length) return bad('err_no_results');
    const payload = JSON.stringify({ night, podium, congeniality: (await congWinner(env, night)) ?? null });
    // One podium post per night: republishing replaces it and keeps the pin.
    const { results: existing } = await env.DB.prepare("SELECT id, pinned_at, text FROM plaza_posts WHERE type = 'podium'").all();
    let pinnedAt = null; const stmts = [];
    for (const row of existing) {
      let snap; try { snap = JSON.parse(row.text); } catch { continue; }
      if (snap?.night !== night) continue;
      if (row.pinned_at && !pinnedAt) pinnedAt = row.pinned_at;
      stmts.push(env.DB.prepare('DELETE FROM plaza_posts WHERE id = ?').bind(row.id));
    }
    if (stmts.length) await env.DB.batch(stmts);
    const made = await env.DB.prepare("INSERT INTO plaza_posts (type, author_id, text, pinned_at) VALUES ('podium', ?, ?, ?) RETURNING id")
      .bind(ctx.user.id, payload, pinnedAt).first();
    return json({ ok: true, id: made.id, replaced: stmts.length > 0 }, 201);
  };
  const congActions = {};
  congActions[''] = async (ctx, night) => {
    const { env, body } = ctx;
    const status = body.status;
    if (!CONG_PHASES.includes(status)) return bad('err_invalid_congeniality_status');
    const closingRunoff = status === 'closed' && (await idsFor(env, CONG, night)) !== null;
    if (status === 'revealed') {
      const tie = (await congResults(env, night)).find((r) => r.tied && r.rank === 1);
      if (tie) return bad('err_congeniality_tie_unresolved', 400, { rank: tie.rank });
    }
    await setSetting(env, `congeniality_status_${night}`, status);
    let settled = null;
    if (closingRunoff) {
      const ids = await idsFor(env, CONG, night);
      const tallies = new Map(ids.map((id) => [id, 0]));
      const { results } = await env.DB.prepare(
        'SELECT target_user_id AS id, COUNT(*) AS votes FROM congeniality_votes WHERE night = ? AND round = ? GROUP BY target_user_id')
        .bind(night, await roundFor(env, CONG, night)).all();
      for (const r of results) if (tallies.has(r.id)) tallies.set(r.id, r.votes);
      settled = await endRunoff(env, CONG, night, tallies);
    }
    const n = CONG_NOTIFY[status];
    if (n) tell(ctx, 'congeniality', n.pt(NIGHT_LABEL[night]), n.en(NIGHT_LABEL[night]));
    return json({ ok: true, night, congenialityStatus: status, ...(settled ? { runoffResolved: true, stillTied: !!settled.stillTied } : {}) });
  };
  congActions.runoff = async (ctx, night) => {
    const { env, body } = ctx;
    if ((await congStatus(env, night)) !== 'closed') return bad('err_congeniality_not_closed', 409);
    const started = await beginRunoff(env, CONG, night, await congResults(env, night), body.rank ?? null);
    if (started.error) return bad(started.error, 409);
    await setSetting(env, `congeniality_status_${night}`, 'open');
    tell(ctx, 'congeniality', `miss congeniality: houve um empate na noite ${NIGHT_LABEL[night]}, vota outra vez!`, `miss congeniality: it's a tie on ${NIGHT_LABEL[night]} night, vote again!`);
    return json({ ok: true, night, congenialityStatus: 'open', rank: started.rank, userIds: started.ids });
  };
  congActions.reset = async (ctx, night) => {
    const { env } = ctx;
    await env.DB.batch([env.DB.prepare('DELETE FROM congeniality_votes WHERE night = ?').bind(night), ...discardStmts(env, CONG, night), setStmt(env, `congeniality_status_${night}`, 'closed')]);
    return json({ ok: true, night });
  };
  congActions['reset-votes'] = async (ctx, night) => {
    const { env } = ctx;
    await env.DB.batch([env.DB.prepare('DELETE FROM congeniality_votes WHERE night = ?').bind(night), ...discardStmts(env, CONG, night), setStmt(env, `congeniality_status_${night}`, 'open')]);
    return json({ ok: true, night, congenialityStatus: 'open' });
  };

  writeDyn.push(['POST', /^\/api\/admin\/voting\/([^/]+)\/(congeniality)(?:\/([a-z-]+))?$/, async (ctx, m) => {
    const off = adminOnly(ctx); if (off) return off;
    const night = m[1];
    const run = congActions[m[3] || ''];
    if (!run) return bad('err_not_found', 404);
    // The status route validates its own night through the status value; the others 404 on a bad night.
    if (!isNight(night)) return m[3] ? bad('err_invalid_night', 404) : bad('err_invalid_night');
    ctx.night = night;
    return run(ctx, night);
  }]);
  writeDyn.push(['POST', /^\/api\/admin\/voting\/([^/]+)\/([a-z-]+)$/, async (ctx, m) => {
    const off = adminOnly(ctx); if (off) return off;
    const run = actions[m[2]];
    if (!run) return bad('err_not_found', 404);
    if (!isNight(m[1])) return bad('err_invalid_night', 404);
    ctx.night = m[1];
    return run(ctx, m[1]);
  }]);
}
