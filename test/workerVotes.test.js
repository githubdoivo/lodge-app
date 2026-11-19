// Snatch on the Worker (APP-LG-032): admin voting controls, congeniality, contestants, photos.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import worker from '../src/worker.js';

const SECRET = 'test-secret';
const hash = (t) => createHmac('sha256', SECRET).update(t).digest('hex');
let env; let db;
function d1(raw) {
  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    first: async () => raw.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: raw.prepare(sql).all(...args) }),
    run: async () => { const r = raw.prepare(sql).run(...args); return { ...r, meta: { changes: Number(r.changes) } }; },
  });
  return { prepare: (sql) => wrap(sql), batch: async (stmts) => { for (const st of stmts) await st.run(); } };
}
// owner Ivo(1), admin Rui(2), guests Ana(3) Bea(4) Cat(5)
before(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  const u = db.prepare('INSERT INTO users (name, token_hash, token_enc, is_admin, is_owner) VALUES (?, ?, ?, ?, ?)');
  u.run('Ivo', hash('ivo'), 'x', 1, 1); u.run('Rui', hash('rui'), 'x', 1, 0);
  u.run('Ana', hash('ana'), 'x', 0, 0); u.run('Bea', hash('bea'), 'x', 0, 0); u.run('Cat', hash('cat'), 'x', 0, 0);
  env = { DB: d1(db), TOKEN_SECRET: SECRET, APP_ENV: 'demo', ASSETS: { fetch: async () => new Response('x') } };
});
const call = (method, path, key, body) => worker.fetch(new Request('https://x.test' + path, {
  method, headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body) }), env);
const errOf = async (r) => (await r.json()).error;
const JPEG = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
const N = 'furnished';
const status = async (key = 'ana') => (await call('GET', `/api/votes/status?night=${N}`, key)).json();

test('guests cannot use the admin voting controls; the admin can', async () => {
  for (const [m, p] of [['POST', `/api/admin/voting/${N}/open`], ['POST', `/api/admin/voting/${N}/reset-all`], ['GET', '/api/admin/voting'],
    ['GET', '/api/admin/contestants'], ['POST', `/api/admin/voting/${N}/congeniality`]]) {
    assert.equal((await call(m, p, 'ana', m === 'GET' ? undefined : {})).status, 403, p);
  }
  assert.equal((await call('POST', '/api/admin/voting/nope/open', 'rui', {})).status, 404);
  assert.equal((await call('GET', '/api/admin/voting', 'rui')).status, 200);
});

test('registration, entries, open (needs everyone unless forced), vote, close, reveal in stages, podium', async () => {
  assert.equal((await status()).status, 'closed');
  assert.equal((await call('POST', `/api/admin/voting/${N}/registration`, 'rui', {})).status, 200);
  assert.equal((await status()).status, 'registration');
  // organiser enters Ana with a photo, adds Bea by name only, and a double register is refused
  const reg = await call('POST', '/api/admin/contestants/register', 'rui', { night: N, userId: 3, name: 'lamp', photoBase64: JPEG });
  assert.equal(reg.status, 201);
  assert.equal(await errOf(await call('POST', '/api/admin/contestants/register', 'rui', { night: N, userId: 3, name: 'again' })), 'err_you_already_registered');
  assert.equal(await errOf(await call('POST', '/api/admin/contestants', 'rui', { night: N })), 'err_name_missing');
  assert.equal((await call('POST', '/api/admin/contestants', 'rui', { night: N, name: 'rug', userId: 4 })).status, 201);
  assert.equal(await errOf(await call('POST', '/api/admin/contestants', 'rui', { night: N, name: 'rug2', userId: 4 })), 'err_already_registered_this_night');
  const list = await (await call('GET', `/api/admin/contestants?night=${N}`, 'rui')).json();
  assert.deepEqual(list.contestants.map((c) => [c.name, !!c.hasPhoto]), [['lamp', true], ['rug', false]]);
  const [lamp, rug] = list.contestants.map((c) => c.id);
  // rename: admin; delete: owner only
  assert.equal(await errOf(await call('PATCH', `/api/admin/contestants/${rug}`, 'rui', { name: ' ' })), 'err_name_missing');
  assert.equal((await call('PATCH', `/api/admin/contestants/${rug}`, 'rui', { name: 'rug!' })).status, 200);
  assert.equal((await call('PATCH', '/api/admin/contestants/9999', 'rui', { name: 'x' })).status, 404);
  assert.equal((await call('DELETE', `/api/admin/contestants/${rug}`, 'rui')).status, 403);
  // not everyone entered (5 users, 3 entered... only 2): refused, then forced
  const refused = await call('POST', `/api/admin/voting/${N}/open`, 'rui', {});
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error, 'err_not_everyone_entered');
  assert.equal((await call('POST', `/api/admin/voting/${N}/open`, 'rui', { force: true })).status, 200);
  assert.equal((await status()).status, 'open');
  assert.equal((await status()).results, null);
  // photos: own entry yes; a stranger no until revealed; admin yes
  assert.equal((await call('GET', `/api/outfit/contestants/${lamp}/photo`, 'ana')).status, 200);
  assert.equal((await call('GET', `/api/outfit/contestants/${lamp}/photo`, 'cat')).status, 404);
  const adminPhoto = await call('GET', `/api/outfit/contestants/${lamp}/photo`, 'rui');
  assert.equal(adminPhoto.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual([...new Uint8Array(await adminPhoto.arrayBuffer())], [0xff, 0xd8, 0xff, 0xd9]);
  assert.equal((await call('GET', '/api/outfit/contestants/9999/photo', 'rui')).status, 404);
  // votes: Cat -> lamp, Bea -> lamp, Rui -> rug
  for (const [k, c] of [['cat', lamp], ['bea', lamp], ['rui', rug]]) assert.equal((await call('POST', '/api/votes', k, { contestantId: c, night: N })).status, 201);
  assert.equal((await call('GET', `/api/admin/voting`, 'rui').then((r) => r.json())).nights[0].notVoted, 2);
  // closing hides results until revealed; reveal goes third -> second -> first -> all
  assert.equal((await call('POST', `/api/admin/voting/${N}/close`, 'rui', {})).status, 200);
  assert.deepEqual((await status()).results, []);
  const phases = [];
  for (let i = 0; i < 5; i++) phases.push((await (await call('POST', `/api/admin/voting/${N}/reveal-next`, 'rui', {})).json()).resultsPhase);
  assert.deepEqual(phases, ['third', 'second', 'first', 'all', 'all']);
  const s = await status();
  assert.deepEqual(s.results.map((r) => [r.name, r.votes, r.rank]), [['lamp', 2, 1], ['rug!', 1, 2]]);
  // now revealed: a stranger sees the photo
  assert.equal((await call('GET', `/api/outfit/contestants/${lamp}/photo`, 'cat')).status, 200);
  // podium: owner only, once; republishing replaces it
  assert.equal(await errOf(await call('POST', `/api/admin/voting/${N}/publish-podium`, 'rui', {})), 'err_owner_only');
  const pub = await call('POST', `/api/admin/voting/${N}/publish-podium`, 'ivo', {});
  assert.equal(pub.status, 201);
  assert.equal((await (await call('POST', `/api/admin/voting/${N}/publish-podium`, 'ivo', {})).json()).replaced, true);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM plaza_posts WHERE type = 'podium'").get().n, 1);
  // zip: store-only, has both names when both have photos; 404 for nights with none
  const zip = await call('GET', `/api/admin/outfit/${N}/photos.zip`, 'rui');
  assert.equal(zip.headers.get('content-type'), 'application/zip');
  const bytes = new Uint8Array(await zip.arrayBuffer());
  assert.equal(bytes[0], 0x50); assert.equal(bytes[1], 0x4b);
  assert.match(Buffer.from(bytes).toString('latin1'), /lamp\.jpg/);
  assert.equal(await errOf(await call('GET', '/api/admin/outfit/swamp/photos.zip', 'rui')), 'err_no_photos');
  assert.equal((await call('GET', '/api/admin/outfit/swamp/photos.zip', 'ana')).status, 403);
});

test('a tie can be broken by a runoff, and a runoff that ties again says so', async () => {
  const n = 'swamp';
  await call('POST', `/api/admin/voting/${n}/registration`, 'rui', {});
  const ids = [];
  for (const [uid, name] of [[3, 'a'], [4, 'b']]) ids.push((await (await call('POST', '/api/admin/contestants/register', 'rui', { night: n, userId: uid, name })).json()).id);
  await call('POST', `/api/admin/voting/${n}/open`, 'rui', { force: true });
  await call('POST', '/api/votes', 'cat', { contestantId: ids[0], night: n });
  await call('POST', '/api/votes', 'rui', { contestantId: ids[1], night: n });
  assert.equal(await errOf(await call('POST', `/api/admin/voting/${n}/runoff`, 'rui', {})), 'err_voting_not_closed');
  await call('POST', `/api/admin/voting/${n}/close`, 'rui', {});
  const ro = await call('POST', `/api/admin/voting/${n}/runoff`, 'rui', {});
  assert.equal(ro.status, 200);
  assert.deepEqual((await ro.json()).contestantIds.sort(), ids.sort());
  assert.equal(await errOf(await call('POST', `/api/admin/voting/${n}/runoff`, 'rui', {})), 'err_voting_not_closed');
  // nobody can be voted twice; Cat votes a (round 1), Rui votes a too, closing settles a first
  assert.equal((await call('POST', '/api/votes', 'cat', { contestantId: ids[0], night: n })).status, 201);
  assert.equal((await call('POST', '/api/votes', 'rui', { contestantId: ids[0], night: n })).status, 201);
  const closed = await (await call('POST', `/api/admin/voting/${n}/close`, 'rui', {})).json();
  assert.equal(closed.runoffResolved, true);
  assert.equal(closed.stillTied, false);
  for (let i = 0; i < 4; i++) await call('POST', `/api/admin/voting/${n}/reveal-next`, 'rui', {});
  const r = (await (await call('GET', `/api/votes/status?night=${n}`, 'ana')).json()).results;
  assert.deepEqual(r.map((x) => [x.name, x.rank, x.tied]), [['a', 1, false], ['b', 2, false]]);
  // reset-all clears the roster and closes the night
  assert.equal((await call('POST', `/api/admin/voting/${n}/reset-all`, 'rui', {})).status, 200);
  const after = await (await call('GET', `/api/votes/status?night=${n}`, 'ana')).json();
  assert.deepEqual([after.status, after.started, after.contestants.length], ['closed', false, 0]);
});

test('miss congeniality: open, vote once (not yourself), reveal winner, runoff on a tie, resets', async () => {
  const cong = (b) => call('POST', `/api/admin/voting/${N}/congeniality`, 'rui', b);
  assert.equal(await errOf(await call('POST', '/api/congeniality/vote', 'ana', { night: N, targetUserId: 4 })), 'err_congeniality_not_open');
  assert.equal(await errOf(await cong({ status: 'nonsense' })), 'err_invalid_congeniality_status');
  assert.equal((await cong({ status: 'open' })).status, 200);
  const vote = (k, t) => call('POST', '/api/congeniality/vote', k, { night: N, targetUserId: t });
  assert.equal(await errOf(await vote('ana', 3)), 'err_cannot_vote_self');
  assert.equal(await errOf(await vote('ana', 1)), 'err_not_a_candidate'); // the owner is not a candidate
  assert.equal((await vote('ana', 4)).status, 201);
  assert.equal(await errOf(await vote('ana', 5)), 'err_already_voted');
  assert.equal((await vote('bea', 3)).status, 201);
  assert.equal((await status('ana')).congeniality.myVote, 4);
  // 1-1 tie for first: cannot reveal
  assert.equal(await errOf(await cong({ status: 'revealed' })), 'err_congeniality_tie_unresolved');
  await cong({ status: 'closed' });
  const ro = await call('POST', `/api/admin/voting/${N}/congeniality/runoff`, 'rui', {});
  assert.equal(ro.status, 200);
  assert.deepEqual((await ro.json()).userIds.sort(), [3, 4]);
  assert.deepEqual((await status('cat')).congeniality.candidates.map((c) => c.id).sort(), [3, 4]);
  assert.equal(await errOf(await vote('rui', 5)), 'err_not_in_runoff');
  assert.equal((await vote('cat', 4)).status, 201);
  const closed = await (await cong({ status: 'closed' })).json();
  assert.equal(closed.runoffResolved, true);
  assert.equal((await cong({ status: 'revealed' })).status, 200);
  assert.equal((await status('cat')).congeniality.winner.id, 4);
  // reset-votes keeps it open and empty; reset closes it
  assert.equal((await (await call('POST', `/api/admin/voting/${N}/congeniality/reset-votes`, 'rui', {})).json()).congenialityStatus, 'open');
  assert.equal((await status('cat')).congeniality.myVote, null);
  assert.equal((await call('POST', `/api/admin/voting/${N}/congeniality/reset`, 'rui', {})).status, 200);
  assert.equal((await status('cat')).congeniality.status, 'closed');
});

test('entry photo can be swapped during registration only, by a bad photo it is refused', async () => {
  await call('POST', `/api/admin/voting/${N}/registration`, 'rui', {});
  assert.equal((await call('POST', '/api/outfit/register', 'cat', { night: N, name: 'c', photoBase64: JPEG })).status, 201);
  assert.equal(await errOf(await call('PUT', '/api/outfit/register/photo', 'cat', { night: N, photoBase64: 'nope' })), 'err_photo_invalid');
  assert.equal((await call('PUT', '/api/outfit/register/photo', 'cat', { night: N, photoBase64: JPEG })).status, 200);
  assert.equal(await errOf(await call('PUT', '/api/outfit/register/photo', 'rui', { night: N, photoBase64: JPEG })), 'err_no_contestant_entry');
  await call('POST', `/api/admin/voting/${N}/open`, 'rui', { force: true });
  assert.equal(await errOf(await call('PUT', '/api/outfit/register/photo', 'cat', { night: N, photoBase64: JPEG })), 'err_registration_not_open');
  // double tap on reset-all is harmless
  assert.equal((await call('POST', `/api/admin/voting/${N}/reset-all`, 'rui', {})).status, 200);
  assert.equal((await call('POST', `/api/admin/voting/${N}/reset-all`, 'rui', {})).status, 200);
  assert.equal((await call('DELETE', '/api/admin/contestants/9999', 'ivo')).status, 200);
});
