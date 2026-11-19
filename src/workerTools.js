// Owner tools on the Worker (APP-LG-035): dedications PDF, guest seeding, the
// Face ID tryout admin, and automatic translations. Ports of src/routes.js,
// src/translate.js and src/translations.js. The prompt and answer checks are
// shared with Node through src/translateCore.js.
import { newDedicationsDocument, renderDedications } from './dedicationsPdf.js';
import { MOCK_NAMES } from './demoUsers.js';
import { MODEL, MAX_TOKENS, SCHEMA, LANG_NAMES, SYSTEM, detectLang, interpretResponse } from './translateCore.js';

export const LANGS = ['pt', 'en'];
const MAX_ATTEMPTS = 2;
const MAX_TRYOUTS = 200;
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const hashOf = async (text) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)))).slice(0, 32);

// ---- Translations ----------------------------------------------------------

export const readerLang = (ctx) => {
  const asked = ctx.url.searchParams.get('lang');
  if (LANGS.includes(asked)) return asked;
  return LANGS.includes(ctx.user?.lang) ? ctx.user.lang : null;
};

/** Map "type:id:field" -> text for one language; only finished rows (same as translationsFor in Node). */
export async function translationsFor(DB, entityType, ids, lang) {
  const map = new Map();
  if (!LANGS.includes(lang) || !ids.length) return map;
  const { results } = await DB.prepare(`SELECT entity_id, field, text FROM translations
    WHERE entity_type = ? AND lang = ? AND status = 'ok' AND text IS NOT NULL
      AND entity_id IN (${ids.map(() => '?').join(',')})`).bind(entityType, lang, ...ids).all();
  for (const r of results) map.set(`${entityType}:${r.entity_id}:${r.field}`, r.text);
  return map;
}

/** Swaps text for the reader's language where one exists, keeping the original as originalText. */
export async function localiseRows(DB, type, rows, lang, field = 'text') {
  if (!lang || !rows.length) return rows;
  const t = await translationsFor(DB, type, rows.map((r) => r.id), lang);
  return rows.map((r) => {
    const text = t.get(`${type}:${r.id}:${field}`);
    return text ? { ...r, [field]: text, [field === 'text' ? 'originalText' : 'originalLabel']: r[field] } : r;
  });
}

/** Queues every language the text is not already written in; never throws. */
export async function queueTranslation(DB, type, id, field, text) {
  try {
    const source = detectLang(text);
    const hash = await hashOf(text);
    const { results: existing } = await DB.prepare(
      'SELECT lang, status, source_hash FROM translations WHERE entity_type = ? AND entity_id = ? AND field = ?').bind(type, id, field).all();
    const stmts = [];
    for (const lang of LANGS) {
      if (lang === source) continue;
      const row = existing.find((r) => r.lang === lang);
      if (row && (row.status === 'ok' || row.status === 'failed') && row.source_hash === hash) continue;
      stmts.push(DB.prepare(`INSERT INTO translations (entity_type, entity_id, field, lang, status, source_hash)
        VALUES (?, ?, ?, ?, 'pending', ?)
        ON CONFLICT(entity_type, entity_id, field, lang) DO UPDATE SET
          status = 'pending', text = NULL, attempts = 0, source_hash = excluded.source_hash`).bind(type, id, field, lang, hash));
    }
    if (stmts.length) await DB.batch(stmts);
  } catch { /* best effort: the post is published either way */ }
}

const SOURCES = {
  consequence: 'SELECT text FROM consequences WHERE id = ?',
  plaza_post: 'SELECT text FROM plaza_posts WHERE id = ?',
  poll_option: 'SELECT label AS text FROM plaza_poll_options WHERE id = ?',
  link_item: 'SELECT label AS text FROM plaza_link_items WHERE id = ?',
  message: 'SELECT text FROM messages WHERE id = ?',
};
const BACKFILLABLE = [
  ['consequence', 'text', 'SELECT id, text AS src FROM consequences'],
  ['plaza_post', 'text', "SELECT id, text AS src FROM plaza_posts WHERE type IN ('announcement','poll','links')"],
  ['poll_option', 'label', 'SELECT id, label AS src FROM plaza_poll_options'],
  ['link_item', 'label', 'SELECT id, label AS src FROM plaza_link_items'],
  ['message', 'text', 'SELECT id, text AS src FROM messages'],
];

const isConfigured = (env) => Boolean(env.ANTHROPIC_API_KEY);
const dailyCap = (env) => Number(env.TRANSLATION_DAILY_CAP || 1000);
const budgetKey = () => `translation_calls_${new Date().toISOString().slice(0, 10)}`;

/** Takes one call from today's budget before the call is made (same rule as Node). */
async function takeFromBudget(env) {
  const key = budgetKey();
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  const used = Number(row?.value) || 0;
  if (used >= dailyCap(env)) {
    if (used === dailyCap(env)) {
      console.warn(`[translate] daily cap of ${dailyCap(env)} reached - translations paused until tomorrow`);
      await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, String(used + 1)).run();
    }
    return false;
  }
  await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, String(used + 1)).run();
  return true;
}

export async function translateText(env, text, targetLang) {
  if (!isConfigured(env)) return null;
  const source = String(text ?? '').trim();
  if (!source || !(await takeFromBudget(env))) return null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL, max_tokens: MAX_TOKENS,
        system: SYSTEM.split('{TARGET}').join(LANG_NAMES[targetLang] ?? targetLang),
        output_config: { format: { type: 'json_schema', schema: SCHEMA } },
        messages: [{ role: 'user', content: source }],
      }),
    });
    if (!res.ok) { console.error(`[translate] ${targetLang}: HTTP ${res.status}`); return null; }
    const data = await res.json();
    if (data.stop_reason === 'refusal') return null;
    const raw = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    return interpretResponse(raw, source);
  } catch (err) {
    console.error(`[translate] ${targetLang}: ${err?.message ?? err}`);
    return null;
  }
}

/** Works through the queue once, one at a time. Returns how many were translated. */
export async function runPending(env, limit = 25) {
  if (!isConfigured(env)) return 0;
  const { DB } = env;
  const { results } = await DB.prepare(`SELECT id, entity_type, entity_id, lang FROM translations
    WHERE status = 'pending' AND attempts < ? ORDER BY id ASC LIMIT ?`).bind(MAX_ATTEMPTS, limit).all();
  let done = 0;
  for (const row of results) {
    const src = SOURCES[row.entity_type] && (await DB.prepare(SOURCES[row.entity_type]).bind(row.entity_id).first())?.text;
    if (!src) {
      await DB.prepare('DELETE FROM translations WHERE entity_type = ? AND entity_id = ?').bind(row.entity_type, row.entity_id).run();
      continue;
    }
    const text = await translateText(env, src, row.lang);
    if (text) {
      await DB.prepare("UPDATE translations SET status = 'ok', text = ?, attempts = attempts + 1 WHERE id = ?").bind(text, row.id).run();
      done += 1;
    } else {
      await DB.prepare(`UPDATE translations SET attempts = attempts + 1,
        status = CASE WHEN attempts + 1 >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END WHERE id = ?`).bind(row.id).run();
    }
  }
  return done;
}

/** Queue, then work the queue after the answer has gone out. */
export function translateAfter(ctx, type, id, field, text) {
  ctx.exec.waitUntil((async () => {
    await queueTranslation(ctx.env.DB, type, id, field, text);
    await runPending(ctx.env).catch(() => {});
  })());
}

async function backfill(env) {
  let queued = 0;
  for (const [type, field, sql] of BACKFILLABLE) {
    const { results } = await env.DB.prepare(sql).all();
    for (const row of results) {
      if (!String(row.src ?? '').trim()) continue;
      const has = await env.DB.prepare('SELECT 1 AS x FROM translations WHERE entity_type = ? AND entity_id = ? AND field = ? LIMIT 1').bind(type, row.id, field).first();
      if (has) continue;
      await queueTranslation(env.DB, type, row.id, field, row.src);
      queued += 1;
    }
  }
  return queued;
}

// ---- Routes ----------------------------------------------------------------

export function addToolRoutes({ routes, writes, publicKeys, json, ownerOnly, hashToken, encryptToken, newUserKey, now }) {
  const demoOff = (ctx) => (ctx.env.APP_ENV === 'demo' ? json({ error: 'err_demo_disabled' }, 403) : null);

  // The collection as a keepsake PDF, oldest first (src/dedicationsPdf.js).
  routes['/api/admin/dedications.pdf'] = async (ctx) => {
    const off = ownerOnly(ctx); if (off) return off;
    const { DB } = ctx.env;
    const { results: rows } = await DB.prepare(`SELECT d.id, d.text, d.created_at, d.updated_at, u.name AS author
      FROM dedications d JOIN users u ON u.id = d.user_id ORDER BY d.created_at`).all();
    if (!rows.length) return json({ error: 'err_no_dedications' }, 404);
    const owner = await DB.prepare('SELECT name FROM users WHERE is_owner = 1').first();
    const doc = newDedicationsDocument();
    const chunks = [];
    const done = new Promise((resolve, reject) => { doc.on('data', (c) => chunks.push(c)); doc.on('end', resolve); doc.on('error', reject); });
    renderDedications(doc, rows, owner?.name);
    doc.end();
    await done;
    const size = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return new Response(out, { headers: { 'content-type': 'application/pdf',
      'content-disposition': 'attachment; filename="dedicatorias.pdf"', 'cache-control': 'no-store' } });
  };

  // Every name on the guest list with no account yet, random keys (src/seedDemo.js seedGuestList).
  // The list is the setting guest_list (one name per line) or the sample names.
  writes['POST /api/admin/users/seed-guests'] = async (ctx) => {
    const off = ownerOnly(ctx) || demoOff(ctx); if (off) return off;
    const { DB } = ctx.env;
    const row = await DB.prepare("SELECT value FROM settings WHERE key = 'guest_list'").first();
    const listed = String(row?.value ?? '').split('\n').map((n) => n.trim()).filter(Boolean);
    const names = listed.length ? listed : MOCK_NAMES;
    let created = 0;
    for (const name of names) {
      if (await DB.prepare('SELECT 1 AS x FROM users WHERE name = ?').bind(name).first()) continue;
      const { token, hash } = await newUserKey(ctx.env, name);
      await DB.prepare(`INSERT INTO users (name, token_hash, token_enc, is_admin, updated_at) VALUES (?, ?, ?, 0, ${now})`)
        .bind(name, hash, await encryptToken(ctx.env.TOKEN_SECRET, token)).run();
      created += 1;
    }
    return json({ ok: true, created });
  };

  writes['POST /api/admin/translations/backfill'] = async (ctx) => {
    const off = ownerOnly(ctx) || demoOff(ctx); if (off) return off;
    const queued = await backfill(ctx.env);
    if (queued && isConfigured(ctx.env)) ctx.exec.waitUntil(runPending(ctx.env, 500).catch(() => {}));
    return json({ ok: true, queued });
  };

  // Demo only: a private admin to try Face ID with. Public, like sign-in.
  publicKeys.add('POST /api/demo/faceid-admin');
  writes['POST /api/demo/faceid-admin'] = async (ctx) => {
    if (ctx.env.APP_ENV !== 'demo' || !ctx.env.TOKEN_SECRET) return json({ error: 'err_demo_disabled' }, 403);
    const { DB } = ctx.env;
    const { n } = await DB.prepare("SELECT COUNT(*) AS n FROM users WHERE name LIKE 'face id %'").first();
    if (n >= MAX_TRYOUTS) return json({ error: 'err_demo_disabled' }, 403);
    const name = `face id ${n + 1}`;
    const { token, hash } = await newUserKey(ctx.env, name);
    await DB.prepare(`INSERT INTO users (name, token_hash, token_enc, is_admin, key_claimed_at, updated_at) VALUES (?, ?, ?, 1, ${now}, ${now})`)
      .bind(name, hash, await encryptToken(ctx.env.TOKEN_SECRET, token)).run();
    return json({ name, key: token }, 201);
  };
}
