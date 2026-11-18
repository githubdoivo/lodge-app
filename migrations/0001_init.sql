-- Lodge schema for D1, generated from src/db.js (scripts/gen-d1-schema.mjs).

CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    token_enc  TEXT NOT NULL,
    is_admin   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
    tutorial_seen INTEGER NOT NULL DEFAULT 0,
    lang TEXT NOT NULL DEFAULT 'pt',
    wall_pseudonym TEXT,
    key_claimed_at TEXT
  , is_owner INTEGER NOT NULL DEFAULT 0, wall_pseudonym_reset_day TEXT, logo_customized INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS consequences (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text       TEXT NOT NULL,
    day        TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    revealed_at TEXT,
    assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    done_at TEXT,
    approved_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
  , assigned_at TEXT);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint     TEXT NOT NULL UNIQUE,
    subscription TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text       TEXT NOT NULL,
    pseudonym  TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
  );

CREATE TABLE IF NOT EXISTS wall_pseudonym_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pseudonym  TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
  );

CREATE TABLE IF NOT EXISTS plaza_posts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT NOT NULL,
    author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text       TEXT NOT NULL,
    pinned_at  TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
  , photo BLOB, photo_mime TEXT);

CREATE TABLE IF NOT EXISTS plaza_poll_options (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id  INTEGER NOT NULL REFERENCES plaza_posts(id) ON DELETE CASCADE,
    label    TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
  );

CREATE TABLE IF NOT EXISTS plaza_link_items (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id  INTEGER NOT NULL REFERENCES plaza_posts(id) ON DELETE CASCADE,
    emoji    TEXT NOT NULL DEFAULT '',
    label    TEXT NOT NULL,
    url      TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
  );

CREATE TABLE IF NOT EXISTS plaza_poll_votes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id    INTEGER NOT NULL REFERENCES plaza_posts(id) ON DELETE CASCADE,
    option_id  INTEGER NOT NULL REFERENCES plaza_poll_options(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
  );

CREATE TABLE IF NOT EXISTS contestants (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    night      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  , user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, partner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, confirmed_at TEXT, photo BLOB, photo_mime TEXT);

CREATE TABLE IF NOT EXISTS votes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    contestant_id INTEGER NOT NULL REFERENCES contestants(id) ON DELETE CASCADE,
    night         TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  , confirmed_at TEXT, round INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS congeniality_votes (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    night          TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  , round INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS dedications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
  );

CREATE TABLE IF NOT EXISTS memo_slots (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    day          TEXT NOT NULL,
    slot_index   INTEGER NOT NULL,
    scheduled_at TEXT NOT NULL,
    notified_at  TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
    UNIQUE(day, slot_index)
  );

CREATE TABLE IF NOT EXISTS memo_uploads (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slot_id     INTEGER NOT NULL REFERENCES memo_slots(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day         TEXT NOT NULL,
    kind        TEXT NOT NULL,
    mime_type   TEXT NOT NULL,
    file_path   TEXT NOT NULL,
    file_size   INTEGER NOT NULL,
    uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')), flipped INTEGER NOT NULL DEFAULT 0,
    UNIQUE(slot_id, user_id)
  );

CREATE TABLE IF NOT EXISTS memo_reactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    upload_id   INTEGER NOT NULL REFERENCES memo_uploads(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji       TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
    UNIQUE(upload_id, user_id)
  );

CREATE TABLE IF NOT EXISTS memo_recaps (
    day         TEXT PRIMARY KEY,
    file_path   TEXT NOT NULL,
    mime_type   TEXT NOT NULL,
    file_size   INTEGER NOT NULL,
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
  );

CREATE TABLE IF NOT EXISTS translations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_id   INTEGER NOT NULL,
    field       TEXT NOT NULL,
    lang        TEXT NOT NULL,
    text        TEXT,
    status      TEXT NOT NULL DEFAULT 'pending',
    attempts    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
  , source_hash TEXT);

CREATE TABLE IF NOT EXISTS passkeys (
    id         TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    jwk        TEXT NOT NULL,
    alg        INTEGER NOT NULL,
    counter    INTEGER NOT NULL DEFAULT 0,
    name       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
    used_at    TEXT
  );

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
  );

CREATE TABLE IF NOT EXISTS passkey_challenges (
    challenge TEXT PRIMARY KEY,
    user_id   INTEGER,
    expires   INTEGER NOT NULL
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_consequence_user_day
    ON consequences(user_id, day);

CREATE UNIQUE INDEX IF NOT EXISTS idx_plaza_vote_user_post
    ON plaza_poll_votes(user_id, post_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contestant_user_night
    ON contestants(user_id, night) WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_translation_target
    ON translations(entity_type, entity_id, field, lang);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vote_user_night_round ON votes(user_id, night, round);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vote_user_night
    ON votes(user_id, night);

CREATE UNIQUE INDEX IF NOT EXISTS idx_congeniality_user_night_round ON congeniality_votes(user_id, night, round);

CREATE UNIQUE INDEX IF NOT EXISTS idx_congeniality_user_night
    ON congeniality_votes(user_id, night);
