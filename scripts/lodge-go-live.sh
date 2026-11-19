#!/bin/zsh
# Moves the real Lodge onto Cloudflare (APP-LG-022). Run once, from ~/projects/lodge-app:  ./scripts/lodge-go-live.sh
# 1) TOKEN_SECRET from .env becomes the Worker secret (personal links keep working)
# 2) schema + the Mac copy's data go into D1 'lodge' (EU)
# 3) the old "see you next year" Worker lets go of lodge.appdoivo.com, the real Lodge takes it
set -e
cd "$(dirname "$0")/.."
grep '^TOKEN_SECRET=' .env | cut -d= -f2- | npx wrangler secret put TOKEN_SECRET --config wrangler.prod.toml

out=$(mktemp -d)
sqlite3 data/app.sqlite .dump | grep -E '^INSERT INTO' | grep -vE '^INSERT INTO "?(sessions|passkey_challenges|sqlite_sequence)"? ' > "$out/data.sql"
npx wrangler d1 execute lodge --remote --config wrangler.prod.toml --file migrations/0001_init.sql
npx wrangler d1 execute lodge --remote --config wrangler.prod.toml --file "$out/data.sql"
npx wrangler d1 execute lodge --remote --config wrangler.prod.toml --command "select (select count(*) from users) users, (select count(*) from messages) messages, (select count(*) from plaza_posts) plaza, (select count(*) from contestants) contestants, (select count(*) from memo_slots) memo_slots"

# hand the address over: old page worker without a route, then the real Lodge
(cd ~/projects/lodge.appdoivo.com && sed -i '' 's|"routes": .*|"routes": []|' wrangler.jsonc && npx wrangler deploy)
npx wrangler deploy --config wrangler.prod.toml
curl -s https://lodge.appdoivo.com/api/version
echo
