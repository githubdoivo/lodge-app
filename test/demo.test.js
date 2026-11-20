// Public demo mode (src/demo.js). DEMO_MODE is read once at startup, so it
// gets its own file: everything here boots the app with it on, against a
// throwaway database seeded the way the demo server seeds itself.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

// The public demo (APP_ENV demo) on the real Worker code (test/harness.js): the 23 sample people
// are seeded on the first request, like on lodge-demo.appdoivo.com.
const { startWorker } = await import('./harness.js');
const w = await startWorker({ owner: false, claimOpen: false, env: { APP_ENV: 'demo', ADMIN_PASSKEY: undefined } });
const { seedDemoContent } = await import('../src/worker.js');
await fetch(w.base + '/api/demo'); // first request seeds the demo people
await seedDemoContent(w.env);

let server;
let base;
before(async () => {
  base = `${w.base}/api`;
});
after(async () => { await w.close(); });

async function api(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function demoKeys() {
  const { data } = await api('GET', '/demo');
  return Object.fromEntries(data.keys.map((k) => [k.role, k.key]));
}

test('the demo offers a guest key and an admin key, and both log in as what they say', async () => {
  const keys = await demoKeys();
  const guest = await api('POST', '/auth/login', { body: { token: keys.guest } });
  const admin = await api('POST', '/auth/login', { body: { token: keys.admin } });
  assert.equal(guest.status, 200);
  assert.equal(admin.status, 200);

  const guestMe = await api('GET', '/me', { token: keys.guest });
  const adminMe = await api('GET', '/me', { token: keys.admin });
  assert.ok(!guestMe.data.isAdmin, 'the guest key is a regular guest');
  assert.ok(adminMe.data.isAdmin, 'the admin key opens the admin panel');
  assert.ok(!adminMe.data.isOwner, 'but it is not the owner - keys and pseudonyms stay hidden');
});

test('nobody can lock the next visitor out of the shared keys', async () => {
  const keys = await demoKeys();
  const changed = await api('POST', '/me/change-token', { token: keys.guest, body: { currentToken: keys.guest, newToken: 'mine12345' } });
  assert.equal(changed.status, 403);
  assert.equal(changed.data.error, 'err_demo_disabled');
  assert.equal((await api('POST', '/auth/login', { body: { token: keys.guest } })).status, 200, 'the shared key still works');
});

test('a visitor can try Face ID on a private admin of their own; the shared keys stay free of it', async () => {
  const keys = await demoKeys();
  const a = await api('POST', '/demo/faceid-admin');
  const b = await api('POST', '/demo/faceid-admin');
  assert.equal(a.status, 201);
  assert.notEqual(a.data.key, b.data.key, 'each visitor gets their own account');
  // Like the real owner and admins: the key alone opens nothing, Face ID is asked for.
  const me = await api('GET', '/me', { token: a.data.key });
  assert.equal(me.status, 401);
  assert.equal(me.data.error, 'err_passkey_required');
  const step = await api('POST', '/auth/login', { body: { token: a.data.key } });
  assert.equal(step.data.step, 'passkey');
  assert.equal(step.data.mode, 'create');
  // A wrong Face ID answer opens nothing.
  const bad = await api('POST', '/auth/passkey/finish', { body: { token: a.data.key, mode: 'create', credential: {} } });
  assert.equal(bad.status, 401);
  // The shared admin and guest keys still sign straight in, with no Face ID asked.
  assert.equal((await api('GET', '/me', { token: keys.admin })).status, 200);
  assert.equal((await api('GET', '/me', { token: keys.guest })).status, 200);
  assert.equal((await api('POST', '/me/passkeys/options', { token: keys.admin })).status, 403, 'shared admin cannot add Face ID');
});

test('what a stranger could abuse, or what wipes the demo for everyone, is refused', async () => {
  const { guest, admin } = await demoKeys();
  const refused = [
    ['POST', '/chat/messages', guest, { text: 'hello' }],
    ['POST', '/admin/plaza-posts', admin, { type: 'links', text: 'links', links: [{ emoji: '🔗', label: 'x', url: 'https://example.com' }] }],
    ['POST', '/admin/consequences/wipe', admin],
    ['POST', '/admin/plaza-posts/wipe', admin],
    ['POST', '/admin/voting/furnished/reset-all', admin],
    ['DELETE', '/admin/contestants/1', admin],
    ['PUT', '/admin/settings', admin, {}],
  ];
  for (const [method, path, token, body] of refused) {
    const res = await api(method, path, { token, body });
    assert.equal(res.status, 403, `${method} ${path} should be refused in the demo`);
    assert.equal(res.data.error, 'err_demo_disabled');
  }
});

test('the rest of the app still works: a plain announcement and a guest vote', async () => {
  const { guest, admin } = await demoKeys();
  const post = await api('POST', '/admin/plaza-posts', { token: admin, body: { type: 'announcement', text: 'hello from the demo' } });
  assert.ok(post.status < 300, `an announcement is fine: ${JSON.stringify(post.data)}`);

  const { posts } = (await api('GET', '/plaza-posts', { token: guest })).data;
  const poll = posts.find((p) => p.type === 'poll');
  assert.ok(poll, 'the demo seeds a poll');
  const vote = await api('POST', `/plaza-posts/${poll.id}/vote`, { token: guest, body: { optionId: poll.options[0].id } });
  assert.ok(vote.status < 300, `voting on the seeded poll works: ${JSON.stringify(vote.data)}`);
});

test('an uploaded photo is swapped for the placeholder, so entering an outfit still works', async () => {
  const { guest, admin } = await demoKeys();
  await api('POST', '/admin/voting/swamp/registration', { token: admin });

  // Not a real JPEG at all - in the demo it never reaches the decoder.
  const res = await api('POST', '/outfit/register', { token: guest, body: { night: 'swamp', name: 'Lily Pad', photoBase64: 'data:image/png;base64,AAAA' } });
  assert.ok(res.status < 300, `registration with a photo works in the demo: ${JSON.stringify(res.data)}`);
});

// GET with a chosen Host header (fetch() won't let you set Host).
function getAs(host, path) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, headers: { Host: host } }, (res) => { res.resume(); resolve(res); }).on('error', reject).end();
  });
}

test('the shared keys are on screen and one tap logs in, on a phone and a desktop', async () => {
  const { webkit, devices } = await import('playwright');
  const browser = await webkit.launch();
  try {
    for (const device of [devices['iPhone 13'], devices['iPhone SE'], { viewport: { width: 1280, height: 800 } }]) {
      const page = await browser.newPage(device);
      await page.goto(base.replace(/\/api$/, '/'), { waitUntil: 'networkidle' });
      const keys = page.locator('#demo-keys-list button');
      assert.equal(await page.locator('#demo-keys-list button').count(), 2);
      assert.equal(await page.locator('#demo-faceid-btn').count(), 0);   // no Face ID button (APP-LG-008)
      for (const k of await keys.all()) {
        const box = await k.evaluate((e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, h: r.height, screen: innerHeight }; });
        assert.ok(box.top >= 0 && box.bottom <= box.screen && box.h > 0, `${JSON.stringify(device.viewport)}: demo key off screen ${JSON.stringify(box)}`);
      }
      await keys.first().click({ timeout: 5000 });
      await page.locator('#app:not(.hidden)').waitFor({ timeout: 5000 });
      await page.close();
    }
  } finally { await browser.close(); }
});

test('on the demo sign-in the key field and enter button stay above the keyboard while typing', async () => {
  const { webkit, devices } = await import('playwright');
  const browser = await webkit.launch();
  try {
    const iphone17Pro = { ...devices['iPhone 13 Pro'], viewport: { width: 402, height: 874 } };
    for (const device of [iphone17Pro, devices['iPhone SE'], devices['iPhone 13 Pro Max']]) {
      const page = await browser.newPage(device);
      await page.goto(base.replace(/\/api$/, '/'), { waitUntil: 'networkidle' });
      await page.locator('#demo-keys-list button').first().waitFor();
      await page.tap('#token-input');
      await page.waitForSelector('#login.typing');
      await page.keyboard.type('abc');
      const r = await page.evaluate(() => {
        const box = (id) => document.getElementById(id).getBoundingClientRect();
        return { field: box('token-input').top, button: box('login-submit-btn').bottom, height: innerHeight, typing: document.getElementById('login').classList.contains('typing') };
      });
      assert.ok(r.typing, 'typing a key must keep the form lifted');
      assert.ok(r.field >= 0, `${JSON.stringify(device.viewport)}: key field above the screen ${JSON.stringify(r)}`);
      // The iPhone keyboard plus its passkey bar covers a bit under half the screen.
      assert.ok(r.button < r.height * 0.55, `${JSON.stringify(device.viewport)}: enter button behind the keyboard ${JSON.stringify(r)}`);
      await page.close();
    }
  } finally { await browser.close(); }
});

test('a memo photo sent to the public demo is kept on the server only as the placeholder', async () => {
  const keys = await demoKeys();
  const { readFileSync } = await import('node:fs');
  const today = (await api('GET', '/memo/today', { token: keys.admin })).data;
  const slot = today.slots[0];
  w.db.prepare('UPDATE memo_slots SET notified_at = ? WHERE id = ?').run(new Date().toISOString().replace('T', ' ').replace('Z', ''), slot.id);
  const form = new FormData();
  form.append('file', new Blob([Buffer.from("a visitor's real photo")], { type: 'image/jpeg' }), 'me.jpg');
  const up = await fetch(`${base}/memo/slots/${slot.id}/upload`, { method: 'POST', headers: { authorization: `Bearer ${keys.guest}` }, body: form });
  assert.ok(up.status < 300, `the upload works: ${up.status} ${await up.clone().text()}`);
  const row = w.db.prepare('SELECT file_path, mime_type FROM memo_uploads WHERE slot_id = ? ORDER BY id DESC').get(slot.id);
  const stored = Buffer.from(w.FILES.files.get(row.file_path).body);
  assert.deepEqual(stored, readFileSync(new URL('../public/images/demo-photo.jpg', import.meta.url)));
  assert.equal(row.mime_type, 'image/jpeg');
});
