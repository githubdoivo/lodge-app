# lodge-app

**Lodge**, the party app (first called appdoivo, then Festa; renamed Lodge on 2026-11-06). Try the demo at **[lodge-demo.appdoivo.com](https://lodge-demo.appdoivo.com)**.

A private-party PWA (~50 guests) with four features, all behind one login:

1. **Wall** (internal name `plaza`) - the owner/admins post announcements or
   polls (2-6 options) for everyone to see. Posts can be pinned to the top.
   Publishing sends a push notification to the group.
2. **Rata** - each user suggests one "consequence" per day through a
   free-text form. Every 3 hours (14:00-02:00) a random pending consequence
   is drawn, everyone is notified, and it is removed from the draw. The
   owner can record who's actually holding the rata for the current
   consequence (only knowable by looking around the party).
3. **Snatch** (internal name `outfit`) - per-night outfit voting. This
   edition has two nights, each with its own name and aesthetic: Furnished
   and Swamp. A switch at the top selects the active night; changing it
   re-skins the whole page with that night's look (other tabs stay clean).
   Users can self-register their own persona (solo or as a duo). Each night
   is controlled manually by the admin (open registration, open voting,
   close, then reveal results in stages: 3rd -> 2nd -> 1st -> everyone).
   The nights are fixed per edition - to change year, edit `src/nights.js`
   (names/themes) and the `body.theme-*` classes in `public/css/styles.css`.
4. **Plaza** (internal name `chat`) - an open, ephemeral group chat. Every
   post is anonymous to everyone except the owner (each user gets a stable
   per-device pseudonym; the owner alone can see who's behind it). Keeps
   only the 15 most recent messages, no time-based expiry.

Login is by a unique access key per user (a first-time "find my name"
search flow lets a new guest claim their own key without the owner handing
it out). There are three roles:

- **Owner** - the one account created on first boot. Full access, including
  everyone's plaintext access keys and who's behind each Plaza pseudonym.
- **Admin** - a promoted regular user (only possible where
  `ENABLE_ADMIN_PROMOTION=true`, e.g. QA). Gets the admin panel (post to the
  Wall, run Snatch voting, reveal consequences) but never sees other users'
  access keys or Plaza identities - those stay owner-only regardless.
- **User** - a regular guest: votes, suggests consequences, posts to Plaza,
  reads the Wall.

The interface has a PT/EN language switch everywhere.

> **Status:** built for, and used at, a real private party (~50 guests, two
> nights). The app is now shut down; this repo is kept as a reference.

## Live demo

**[lodge-demo.appdoivo.com](https://lodge-demo.appdoivo.com)**: the app with mock data. The login screen
offers two keys, a **guest** and an **admin**, so no account is needed.

Demo mode (`src/demo.js`) keeps it safe to leave open: photo uploads become a
placeholder, and link posts, the anonymous chat, wipes, deletions and key
changes are turned off. The demo has no persistent storage and sleeps when
idle, so it wakes up fresh, with the demo data, after a quiet spell (the
first load after that takes a few seconds).

## Screenshots

<p align="center">
  <img src="docs/demo.gif" width="260" alt="Walkthrough: logging in, then the Wall, Rata, Snatch and Plaza tabs, the theme toggle and the language switch">
</p>
<p align="center"><a href="docs/demo.mp4">Watch the walkthrough as video</a></p>

| Login | Wall | Rata |
|---|---|---|
| <img src="docs/screenshots/1-login.jpg" width="240" alt="Login screen"> | <img src="docs/screenshots/2-wall.jpg" width="240" alt="Wall with announcements"> | <img src="docs/screenshots/3-rata.jpg" width="240" alt="Rata consequence game"> |
| **Snatch** | **Plaza** | **Admin: voting control** |
| <img src="docs/screenshots/4-outfit.jpg" width="240" alt="Snatch outfit voting"> | <img src="docs/screenshots/5-chat.jpg" width="240" alt="Plaza anonymous chat"> | <img src="docs/screenshots/6-admin.jpg" width="240" alt="Admin voting control"> |

All captured with mock data by `npm run screenshots` (Playwright WebKit,
iPhone 13 profile), so they can be regenerated after any UI change.

## Engineering & quality

This is a side project, but it was built the way I'd want a production
system to be tested: quality gates first, then features.

**Test suite: ~250 automated tests** (Node's built-in `node:test`, no extra
test framework)

| Suite | Tests | What it covers |
|---|---|---|
| `test/api.test.js` | 137 | API and business logic: auth, roles, voting rules, ties and runoffs, duo confirmations, rate limits, wipe/seed flows |
| `test/ui.test.js` | 104 | Real-browser UI tests with Playwright (WebKit, the iOS Safari engine) on iPhone SE / 13 / Pro Max viewports: layout overflow, alignment, end-to-end flows |
| `test/migration.test.js` | 1 | Schema migrations run cleanly against an existing database |
| `test/ci-smoke.test.js`, `test/demoSeed.test.js` | 8 | Boot smoke test and seeded QA data |

Every suite runs against a temporary database and never touches real data.

**End-to-end, from the outside:** a separate BDD suite,
[lodge-app-e2e](https://github.com/githubdoivo/lodge-app-e2e) (Playwright + Cucumber,
TypeScript), runs every day against the [live demo](https://lodge-demo.appdoivo.com):
API scenarios plus UI scenarios on iPhone and desktop, with a
[published report](https://githubdoivo.github.io/lodge-app-e2e/).

**Quality gates**

- **Pre-commit hook** (`.githooks/pre-commit`, plain git hook, no husky) runs
  the full suite and blocks the commit if anything fails.
- **GitHub Actions** (`.github/workflows/test.yml`) runs the same suite on
  every pull request and on `main`. A red check means the branch can't be merged.
- **Branch-per-change workflow**: `feat/`, `fix/`, `test/`, `chore/`; nothing
  goes straight to `main`. ~75 pull requests merged. See
  [CONTRIBUTING.md](CONTRIBUTING.md).
- **Dependabot** keeps dependencies current.

**Environments**

- **Demo and production** run as Cloudflare Workers (`wrangler.toml`), deployed from `main` with `npm run deploy`.
- The public demo holds mock data only and resets daily.

**Flaky test investigation**

The UI suite started failing about half of its tests on CI, on `main` too.
The cause was the API and UI suites running in parallel on a two-core runner,
which starved the browser. I measured both modes (206 tests: 116s serial vs
120s parallel locally) and switched to serial everywhere. It turned out to be
both faster and deterministic. The reasoning is written up in
`scripts/run-tests.js`.

**Security & privacy by design**

- Access keys are stored hashed (for lookup) and encrypted (`TOKEN_SECRET`),
  never in plaintext.
- Three roles (owner / admin / user) with checks on the server; the
  most sensitive data (other users' keys, who's behind the anonymous
  pseudonyms) is owner-only, even for admins.
- Rate limiting on login and key-claim endpoints (`src/rateLimit.js`).

## Stack

- Cloudflare Workers (the API and static pages), D1 (database) and R2 (files), with a cron trigger for the daily jobs
- Frontend: PWA in plain HTML/CSS/JS (works on iPhone and Android without an app store)

## Running locally

```
npm install
npx wrangler dev --local
```

Sign in with the demo keys the sign-in page offers, then use Settings to create users, post to the Wall, manage nights and reveal consequences. See [SETUP.md](SETUP.md).

## Tests

A local suite (Node's built-in `node:test`, no extra dependencies) covering
both the API/logic (`test/api.test.js`) and a real-browser UI suite
(`test/ui.test.js`, Playwright WebKit, same engine as iOS Safari) across
iPhone SE/13/Pro Max viewports. Runs against a temporary database and never
touches the real one. Run it before deploying:

```powershell
npm test
```

A pre-commit hook and CI (GitHub Actions) both run this same suite - see
[CONTRIBUTING.md](CONTRIBUTING.md) for the full process.

## Push notifications

Every feature notifies the group when something happens - a new Wall post,
a revealed consequence, Snatch registration/voting opening or closing and
results being revealed, or a new Plaza post (skipping the poster's own
device). Each notification opens the app straight to the relevant tab. See
`broadcast(` calls in `src/worker.js`, `src/workerVotes.js`, and
`src/workerMemo.js` for the exact copy.

- Android/Chrome: just tap the notifications button inside the app.
- iPhone (iOS 16.4+): first use "Add to Home Screen" (Share > Add to Home
  Screen) and open the app from the icon. Only then does iOS allow enabling
  notifications.
- Push requires HTTPS. It works on `localhost`; in production use a host with
  HTTPS (the ones suggested in [SETUP.md](SETUP.md) provide it automatically).

## Configuration

Variables live in `wrangler.toml` (`[vars]`) or as Worker secrets; see [SETUP.md](SETUP.md).

## Deploy & hosting

Cloudflare Workers with D1 and R2. `npm run deploy` runs `wrangler deploy`; [SETUP.md](SETUP.md) has the details.

## Face ID (APP-LG-001)

- **Owner and admins** sign in with Face ID. The key alone opens nothing for them: the first sign-in with the key asks them to add Face ID on that phone, and after that the key must be confirmed with it (or they tap "sign in with face id" and skip the key).
- **Guests** keep using their key. Face ID is optional, added from Settings.
- **Lost phone:** the owner clears anyone's Face ID from Manage Users (the face icon), which also signs them out. If the owner loses theirs, run `npm run reset-owner-faceid` from the project folder, then sign in with the owner key.
- The public demo's shared accounts have no Face ID. To try it there, the **face id** demo button makes a private admin for that browser that works like the real owner and admins (key needs Face ID; *entrar com face id* signs in alone). Kept in memory, gone on restart. Test suites other than `test/passkeys.test.js` set `ADMIN_PASSKEY=off`; production never sets it.
