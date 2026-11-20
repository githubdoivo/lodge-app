// Runs the real Worker (src/worker.js) inside Node for the browser and API suites:
// a local SQLite file stands in for D1, a Map for R2, public/ for the assets binding.
// Tests keep reading and writing the same database directly through `db`.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createHmac } from 'node:crypto';
import worker, { resetDemoSeedFlag } from '../src/worker.js';

export const SECRET = 'test-secret-not-used-anywhere-real';
const PUBLIC = new URL('../public/', import.meta.url).pathname;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.txt': 'text/plain' };

export const hash = (key) => createHmac('sha256', SECRET).update(String(key).toLowerCase()).digest('hex');
// token_enc exactly as the Worker writes it.
export async function encrypt(key) {
  const { encryptToken } = await import('../src/worker.js');
  return encryptToken(SECRET, key);
}

function d1(db) {
  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    first: async (col) => { const r = db.prepare(sql).get(...args) ?? null; return col && r ? r[col] : r; },
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    raw: async () => db.prepare(sql).all(...args).map(Object.values),
    run: async () => { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
  });
  return {
    prepare: (sql) => wrap(sql),
    batch: async (stmts) => { db.exec('BEGIN'); try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } },
    exec: async (sql) => db.exec(sql),
  };
}

function r2() {
  const files = new Map();
  const obj = (key, v) => ({ key, size: v.body.byteLength, httpMetadata: v.meta, uploaded: v.at,
    body: new Response(v.body).body, arrayBuffer: async () => v.body.buffer.slice(v.body.byteOffset, v.body.byteOffset + v.body.byteLength),
    text: async () => new TextDecoder().decode(v.body), writeHttpMetadata: (h) => { if (v.meta?.contentType) h.set('content-type', v.meta.contentType); },
    httpEtag: '"t"' });
  return {
    files,
    put: async (key, body, opts = {}) => { const b = new Uint8Array(body instanceof ArrayBuffer ? body : await new Response(body).arrayBuffer()); files.set(key, { body: b, meta: opts.httpMetadata || {}, at: new Date() }); return { key }; },
    get: async (key) => (files.has(key) ? obj(key, files.get(key)) : null),
    head: async (key) => (files.has(key) ? obj(key, files.get(key)) : null),
    delete: async (keys) => { for (const k of [].concat(keys)) files.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ objects: [...files.keys()].filter((k) => k.startsWith(prefix)).map((k) => obj(k, files.get(k))), truncated: false }),
  };
}

const assets = {
  fetch: async (request) => {
    let p = decodeURIComponent(new URL(request.url).pathname);
    if (p.endsWith('/')) p += 'index.html';
    let f = join(PUBLIC, p);
    if (!f.startsWith(PUBLIC)) return new Response('no', { status: 403 });
    if (!existsSync(f) && !extname(f) && existsSync(f + '.html')) f += '.html';
    if (!existsSync(f) || !statSync(f).isFile()) f = join(PUBLIC, 'index.html');
    return new Response(readFileSync(f), { headers: { 'content-type': TYPES[extname(f)] || 'application/octet-stream' } });
  },
};

// opts.env overrides env values (APP_ENV, ENABLE_* flags, ADMIN_PASSKEY ...).
export async function startWorker(opts = {}) {
  const db = new DatabaseSync(opts.file || ':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of ['0001_init.sql', ...(opts.migrations || [])]) db.exec(readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8'));
  const FILES = r2();
  const env = { DB: d1(db), FILES, ASSETS: assets, TOKEN_SECRET: SECRET, APP_ENV: 'test', ADMIN_PASSKEY: 'off',
    ENABLE_PLAZA: 'true', ENABLE_MEMO: 'true', ENABLE_ADMIN_PROMOTION: 'true', ...opts.env };
  resetDemoSeedFlag();
  const errors = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    const url = `http://${req.headers.host}${req.url}`;
    let out;
    try {
      out = await worker.fetch(new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body, duplex: 'half' }), env, { waitUntil: (p) => p?.catch?.(() => {}) });
    } catch (e) { out = new Response(JSON.stringify({ error: 'crash', message: String(e) }), { status: 500 }); }
    const buf = Buffer.from(await out.arrayBuffer());
    if (out.status >= 400) errors.push(`${req.method} ${req.url} -> ${out.status} ${buf.toString().slice(0, 80)}`);
    const h = {}; out.headers.forEach((v, k) => { h[k] = k === 'set-cookie' ? out.headers.getSetCookie() : v; });
    res.writeHead(out.status, h); res.end(buf);
  });
  server.listen(0); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  // An owner who signs in with a plain key (ADMIN_PASSKEY off), like the Node suites' seeded admin.
  const ownerKey = opts.ownerKey || 'ownerkey123456';
  if (opts.owner !== false) {
    db.prepare('INSERT INTO users (name, token_hash, token_enc, is_owner, is_admin) VALUES (?, ?, ?, 1, 1)')
      .run(opts.ownerName || 'UI Test Admin', hash(ownerKey), await encrypt(ownerKey));
  }
  // Guests may claim their key by name, as during a party (it is closed by default on the real Lodge).
  if (opts.claimOpen !== false) db.prepare("INSERT INTO settings (key, value) VALUES ('claim_open', '1')").run();
  return { base, db, env, FILES, errors, ownerKey, worker, close: async () => { server.close(); db.close(); } };
}
