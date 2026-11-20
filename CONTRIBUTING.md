# Development & deploy process

## Branches

Every change happens on its own branch off `main`, named by type:

- `feat/<description>` - new features
- `fix/<description>` - bug fixes
- `test/<description>` - test-only changes
- `chore/<description>` - config, docs, tooling (no app behaviour change)

Never commit straight to `main`.

## Environments

- **Production** (Worker `lodge`, https://lodge.appdoivo.com) - the real app, real data in
  D1 `lodge` and R2 `lodge-files` (EU). Config `wrangler.prod.toml`; deployed from `main` with
  `npx wrangler deploy --config wrangler.prod.toml` (`~/bin/ship` does both apps).
- **Demo** (Worker `lodge-demo`, https://lodge-demo.appdoivo.com) - public, for
  anyone to try (the README links it). Sample data only, `APP_ENV=demo` (the demo guard in
  `src/worker.js`), wiped every night at 04:00 UTC. Config `wrangler.toml`; `npm run deploy`.

Databases are intentionally isolated between the two. There is no QA copy any
more (removed 2026-11-16, APP-LG-003): changes are tested by `npm test`, then
go to production and the demo.

## Process for a change

Changes are batched: a work session typically covers several features/fixes
on one branch, tested and deployed together rather than one-change-per-branch
and one-deploy-per-change. Don't deploy after every small feature - batch the
session's work and deploy once at the end.

1. Branch off `main` with the right prefix (one branch can carry the whole
   session's worth of work).
2. Implement each change. `npm test` covers both API/logic tests
   (`test/api.test.js`) and a real-browser UI/UX suite (`test/ui.test.js`)
   that drives the app with Playwright's WebKit engine (same engine as iOS
   Safari) across iPhone SE/13/Pro Max viewports, catching layout overflow,
   misalignment, and regressions on real device sizes before they reach QA.
   One-time setup: `npx playwright install webkit chromium`. Run just the UI
   suite with `npm run test:ui`.
3. Commit. A pre-commit hook (`.githooks/pre-commit`, wired up automatically
   via `npm install`'s `postinstall` - no husky, plain git hook) runs
   `npm test` and blocks the commit if anything fails, so this doesn't rely
   on remembering to run it manually.
4. Push the branch. Once a PR is open, every push to it also runs the same
   suite via GitHub Actions (`.github/workflows/test.yml`) - a red check
   there means the branch isn't safe to deploy or merge. Plain pushes
   without an open PR don't trigger CI, to avoid noise on WIP commits that
   aren't close to main yet.
5. Open a PR and merge it into `main` once CI is green
   (delete the branch on merge - `gh pr merge --merge --delete-branch`).
   There is no QA step any more (removed 2026-11-16, APP-LG-003).
6. Only after merging: `npm run deploy` (`wrangler deploy`) puts `main` on
   Cloudflare Workers. `~/bin/ship` tests first and deploys only if they pass.
7. Verify production directly (HTTP check, login, and whatever the batch
   actually touched) before considering the session's work done.

## Before the party: clear the test data

Ivo and friends tested on production from 13 September, on the real
accounts - which was the right call, because QA has no real accounts and
so cannot exercise the one thing that matters most: a guest finding their
name, claiming their key, and getting in.

What that leaves behind is test content, and the party should not open on
it. Settings has a wipe per feature; run all five, ideally on the 17th:

- Wall (posts, polls, links, votes)
- Rata (consequences)
- Plaza (chat)
- Snatch (contestants and votes)
- Memo (uploads, moments, and the files on the volume)

**None of them touch accounts.** Guest rows, keys and claimed status all
survive every wipe, which is the point: anyone who claimed their key while
testing stays claimed, and nobody has to do it twice on the day.

Translations of wiped content go with it - the wipes clear those rows too,
so nothing is left pointing at a post that no longer exists.

## The golden rule stops at the guests' own words

`body { text-transform: lowercase }` makes the app lowercase everywhere, and
that is the house style - it applies to every string the app itself writes.
It does not apply to what guests write.

The dedications PDF is where the two meet, and the split there is
deliberate (Ivo's call, 12 Sept 2026): the heading and the signature line
are the app talking, so they are lowercased in code, because a PDF is the
one artefact no stylesheet reaches. The **messages** are printed exactly as
they were typed, capitals and all - they are his friends' voices, written
to him, and the book should read the way they wrote it.

This looks like an oversight and is not. There is an assertion pinning it
in `test/api.test.js`; read the note beside it before changing anything.

## Domain and email

`security.txt` is **not** served from this repo. `public/.well-known/security.txt`
exists as a fallback, but Cloudflare's Security Center serves its own copy at
the edge and that is what the world (and Cloudflare's own scanner) sees - the
scanner will keep flagging the domain as unconfigured however correct the file
in here is. Edit it via the zone's `security-center/securitytxt` API, or under
Security -> Settings in the dashboard.

It names `mail@appdoivo.com`, the one address on the domain (it used to be
`security@appdoivo.com`, retired with the app). Since November 2026 it is an
iCloud+ custom-domain mailbox (MX `mx01/mx02.mail.icloud.com`, DKIM `sig1`
via iCloud); the old Cloudflare Email Routing to Gmail is gone. The only real
test is still to send the address an email and see whether it arrives.

The same address receives DMARC aggregate reports, so if it breaks, those are
lost too - not just vulnerability reports.

## Version numbering

Step the patch by **5** (`1.5.0`, `1.5.5`, ... `1.5.95`, then bump the
minor). Briefly tried stepping by 1 and reverted - the gaps are the point,
they make one build obviously different from the next at a glance (the
on-screen badge is gone since 2026-11-16; `GET /api/version` still answers).
Prod and the demo carry the same version for a given release.

**The number was wound back from `1.9.50` to `1.5.0` on 10 August 2026** -
stepping by 5 was eating the minor far faster than the app was actually
changing, and 2.0 was going to arrive for no reason. Nothing reads the
version except the badge and `/api/version` (this package is never
published, and no client checks it), so going backwards costs nothing.
Carry on from `1.5.0`; don't "correct" it back up to the 1.9.x line.

## Secrets

- `.env` (local) and `wrangler secret put` (per Worker) are the only place secrets
  live - never in a committed file.
- Production and QA have distinct `TOKEN_SECRET` and VAPID keys. The admin
  password is intentionally shared across environments for convenience.
