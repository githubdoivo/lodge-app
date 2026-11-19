// The one place this app talks to the Anthropic API.
//
// It translates what guests and admins write - Rata consequences and Wall
// posts - so everyone reads the party in the language they picked. Nothing
// here is on a request path: the write returns first and this runs after,
// because a post should never wait on somebody else's network.
//
// With no API key configured, every function here no-ops and the app
// behaves exactly as it did before the feature existed: originals
// everywhere, nothing queued, nothing logged as broken. That is deliberate
// - shipping this to an environment without a key must be a non-event.
import Anthropic from '@anthropic-ai/sdk';
import db, { getSetting, setSetting } from './db.js';
import * as store from './translations.js';
import { MODEL, MAX_TOKENS, SCHEMA, LANG_NAMES, SYSTEM, detectLang, interpretResponse, systemPromptFor } from './translateCore.js';

export { detectLang, interpretResponse, systemPromptFor };

// Ivo's call, 13 Sept 2026: Haiku, cheapest tier. Roughly 300 short strings
// across the whole party works out at well under a euro either way, so the
// model is a preference rather than a cost decision - it lives here as one
// constant so changing tier later is this line, not a hunt through the file.
//
// Note there is no `effort` setting: that parameter exists on Opus 4.5+ and
// the 5-series, and Haiku 4.5 returns a 400 if it is sent. The equivalent
// of "low effort" on this model is simply not turning thinking on, which is
// already its default - so the absence of a thinking parameter below is the
// setting, not an oversight.
// A hard ceiling on API calls per day, enforced by the app on itself.
//
// This exists because on 16 Sept 2026 a queueing bug bought the same twenty
// sentences hundreds of times per boot and emptied the account. That bug is
// fixed and tested - this is for the next one. A spend limit in the console
// is the real backstop and belongs there; this is the part the app can own,
// and it fails in the direction the app already handles gracefully: with no
// budget left, translate.js behaves exactly as it does with no API key at
// all, which is to say the originals are shown and nothing breaks.
//
// 1000/day is roughly 5x the busiest plausible real day (24 guests, a Wall
// that only admins post to, a chat pruned to 20 messages) and caps a runaway
// at about a euro rather than an account. TRANSLATION_DAILY_CAP overrides it.
const DAILY_CAP = Number(process.env.TRANSLATION_DAILY_CAP || 1000);

/** Calls used today, and whether there is room for another. Counted in the
 * settings table so a restart cannot reset the budget - a crash-loop that
 * forgot its own spending is exactly how this would go wrong twice. */
function budgetKeyForToday() {
  return `translation_calls_${new Date().toISOString().slice(0, 10)}`;
}

export function callsUsedToday() {
  return Number(getSetting(budgetKeyForToday(), 0)) || 0;
}

function takeFromBudget() {
  const used = callsUsedToday();
  if (used >= DAILY_CAP) {
    // Once per day, not once per attempt - a capped day should not also
    // produce a thousand log lines.
    if (used === DAILY_CAP) {
      console.warn(`[translate] daily cap of ${DAILY_CAP} reached - translations paused until tomorrow`);
      setSetting(budgetKeyForToday(), String(used + 1));
    }
    return false;
  }
  setSetting(budgetKeyForToday(), String(used + 1));
  return true;
}

let client = null;

/** True when a key is configured - everything here is a no-op without one. */
export function isConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function getClient() {
  if (!isConfigured()) return null;
  if (!client) client = new Anthropic();
  return client;
}

/**
 * Translates one string. Returns the text, or null if it could not be done
 * - a refusal, an API error, an empty answer. Never throws: every caller is
 * a background pass whose job is to leave the original in place on failure.
 */
export async function translateText(text, targetLang) {
  const anthropic = getClient();
  if (!anthropic) return null;
  const source = String(text ?? '').trim();
  if (!source) return null;
  // Taken before the call, not after: a budget decremented on success only
  // is no budget at all when the failure mode is a loop.
  if (!takeFromBudget()) return null;

  try {
    const target = LANG_NAMES[targetLang] ?? targetLang;
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM.split('{TARGET}').join(target),
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: source }],
    });

    // stop_reason is checked before the content is read. A refused request
    // comes back as a perfectly successful 200 with an empty content array,
    // so indexing content[0] first is how this would crash on the one input
    // most likely to trip it - somebody's deliberately obscene dare.
    if (res.stop_reason === 'refusal') return null;

    const raw = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    return interpretResponse(raw, source);
  } catch (err) {
    // Includes rate limits and overloads. The row stays pending and the
    // next pass picks it up; after MAX_ATTEMPTS it is left alone.
    console.error(`[translate] ${targetLang}: ${err?.message ?? err}`);
    return null;
  }
}

// Where each queued row's source text actually lives. Keyed by the
// entity_type written into the translations table.
const SOURCES = {
  consequence: (id) => db.prepare('SELECT text FROM consequences WHERE id = ?').get(id)?.text,
  plaza_post: (id) => db.prepare('SELECT text FROM plaza_posts WHERE id = ?').get(id)?.text,
  poll_option: (id) => db.prepare('SELECT label AS text FROM plaza_poll_options WHERE id = ?').get(id)?.text,
  link_item: (id) => db.prepare('SELECT label AS text FROM plaza_link_items WHERE id = ?').get(id)?.text,
  message: (id) => db.prepare('SELECT text FROM messages WHERE id = ?').get(id)?.text,
};

// Everything that can be translated, and where to find the rows. Used by
// the backfill below; SOURCES above resolves one row at a time.
const BACKFILLABLE = [
  ['consequence', 'text', 'SELECT id, text AS src FROM consequences'],
  ['plaza_post', 'text', "SELECT id, text AS src FROM plaza_posts WHERE type IN ('announcement','poll','links')"],
  ['poll_option', 'label', 'SELECT id, label AS src FROM plaza_poll_options'],
  ['link_item', 'label', 'SELECT id, label AS src FROM plaza_link_items'],
  ['message', 'text', 'SELECT id, text AS src FROM messages'],
];

/**
 * Queues anything that has never been queued. Needed because queueing
 * happens when something is written, so everything written before the
 * feature existed - a month of real posts and consequences on production -
 * had no rows and silently read as "translations are broken".
 *
 * Skips anything that already has a row in any state, so running it twice
 * costs nothing and it will not re-try a translation that already failed
 * its attempts. Returns how many it queued.
 */
export function backfill() {
  let queued = 0;
  const has = db.prepare('SELECT 1 FROM translations WHERE entity_type = ? AND entity_id = ? AND field = ? LIMIT 1');
  for (const [type, field, sql] of BACKFILLABLE) {
    for (const row of db.prepare(sql).all()) {
      if (has.get(type, row.id, field)) continue;
      if (!String(row.src ?? '').trim()) continue;
      store.queue(type, row.id, field, detectLang(row.src), row.src);
      queued += 1;
    }
  }
  if (queued && isConfigured()) setImmediate(() => { runPending(500).catch(() => {}); });
  return queued;
}

/**
 * Works through the queue once. Returns how many rows were translated.
 * Serial rather than parallel on purpose: the queue is tiny, and a burst of
 * concurrent calls is the one way a party-sized workload could ever meet a
 * rate limit.
 */
// Only one sweep at a time, ever.
//
// This is the bug that emptied Ivo's API credits on 16 Sept 2026. Every
// write fired setImmediate(runPending), and every sweep read the whole
// pending queue. Nothing marked a row as in flight, so N writes arriving
// together produced N overlapping sweeps that each translated the SAME
// rows. seedDemo writes about nineteen things at once on every QA boot -
// nineteen sentences, hundreds of API calls, on every single deploy.
//
// A boolean is enough because this is one process with one event loop. The
// trailing flag covers the case that matters: work queued while a sweep is
// already running is not lost, it just waits for the current one to finish
// instead of starting a second one beside it.
let sweeping = false;
let sweepAgain = false;

export async function runPending(limit = 25) {
  if (!isConfigured()) return 0;
  if (sweeping) { sweepAgain = true; return 0; }
  sweeping = true;
  try {
    return await sweep(limit);
  } finally {
    sweeping = false;
    if (sweepAgain) {
      sweepAgain = false;
      setImmediate(() => { runPending(limit).catch(() => {}); });
    }
  }
}

async function sweep(limit) {
  let done = 0;
  for (const row of store.pending(limit)) {
    const source = SOURCES[row.entity_type]?.(row.entity_id);
    if (!source) {
      // The post or consequence was deleted while this sat in the queue.
      store.wipeFor(row.entity_type, row.entity_id);
      continue;
    }
    const text = await translateText(source, row.lang);
    if (text) {
      store.markOk(row.id, text);
      done += 1;
    } else {
      store.markFailed(row.id);
    }
  }
  return done;
}

/**
 * Queues a piece of text and kicks the queue, without making the caller
 * wait. The write path calls this after it has already responded.
 */
export function queueAndRun(entityType, entityId, field, text) {
  store.queue(entityType, entityId, field, detectLang(text), text);
  if (!isConfigured()) return;
  setImmediate(() => { runPending().catch(() => {}); });
}
