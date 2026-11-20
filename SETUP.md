# appdoivo - Setup & Hosting Guide

A small PWA for a private group of friends, with four features:

- **Wall** - the owner/admins post announcements or polls; the group gets
  notified and can vote on polls. Gated behind `ENABLE_PLAZA=true` - off
  by default locally, on in QA and production.
- **Rata** - every 3 hours a random "consequence" (suggested by users) is
  revealed and everyone is notified. The owner can record who's actually
  holding it.
- **Snatch** - per-night outfit voting; the admin controls registration,
  opens/closes each night, and reveals a staged ranking when it closes.
- **Plaza** - an open, anonymous, ephemeral group chat (pseudonyms only;
  the owner alone can see real identities).

This guide explains how to run it locally, how to host it safely for free, and how to buy a domain.

## Push notifications

Automatic notifications are sent to every subscribed device for each
feature, in the recipient's own last-selected app language (PT or EN,
stored per user and synced whenever they switch languages in the app).
Every notification opens the app straight to the tab it's about:

- **Wall:** a new announcement or poll is published.
- **Rata (every 3 hours, 16:00-04:00):** when a new consequence is
  revealed. The consequence itself is not shown in the notification, on
  purpose, so people open the app to see it.
- **Snatch:** registration opens, voting opens, voting closes, and each
  stage of the results reveal (3rd -> 2nd -> 1st -> everyone).
- **Plaza:** a new message is posted (skipping the poster's own device).

The exact title/body strings live in `src/worker.js`, `src/workerVotes.js`
and `src/workerMemo.js` (search for `broadcast(`) - update this doc if you change them.

Notes:

- Push requires HTTPS. It works on `localhost`; in production you need a host with HTTPS (all the recommended hosts below provide it automatically).
- Android/Chrome: tap the notifications button inside the app.
- iPhone (iOS 16.4+): first use "Add to Home Screen", open the app from that icon, then enable notifications.

## How it runs

A single Cloudflare Worker (`src/worker.js`) serves the API and the PWA files in `public/`.

- **Cloudflare Workers** - the API and the static pages (the free plan is enough).
- **D1** (EU) - the database; the schema is `migrations/0001_init.sql`.
- **R2** (EU) - photos and videos (Memo).
- **Cron trigger** - runs the daily demo reset and the Rata reveal.
- **Secrets** - set with `npx wrangler secret put TOKEN_SECRET` (and the VAPID keys); never in `wrangler.toml` or the repository.

## Running locally

Requires Node.js 23.4 or newer.

```
npm install
npx wrangler dev --local
```

## Deploying

```
npm test          # the suite
npm run deploy    # wrangler deploy
```

Check it with `curl https://<your-worker>/api/version`.

## Domain

The Worker answers on its `workers.dev` address, or on a domain routed to it in `wrangler.toml` (`routes`). Keep the same domain, or passkeys have to be registered again.

## Environment variables

Set in `wrangler.toml` under `[vars]`, or as secrets:

- `APP_ENV` - `demo` turns on the public demo (sample users and daily reset).
- `TOKEN_SECRET` (secret) - HMAC secret that indexes access keys. If you change it, nobody can sign in.
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` - Web Push (`npm run genkeys`).
- `ENABLE_PLAZA`, `ENABLE_MEMO`, `ENABLE_ADMIN_PROMOTION` - feature switches.

## Operational notes

- Always set secrets through `wrangler secret put`.
- HTTPS is on by default on Cloudflare.
- Back up D1 before changing the schema.
