// Pure rules for Wall posts (no database): shared by src/plaza.js on Node
// and src/worker.js on Cloudflare, so the two can never drift apart.

export const MAX_TEXT_LENGTH = 500;
export const MAX_OPTION_LENGTH = 60;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 6;
export const MAX_LINK_LABEL_LENGTH = 60;
// Room for a multi-codepoint emoji (skin tone, ZWJ sequence) without being
// a second label field in disguise.
export const MAX_LINK_EMOJI_LENGTH = 16;
export const MAX_LINK_URL_LENGTH = 500;
export const MIN_LINKS = 1;
export const MAX_LINKS = 12;

/**
 * Links are typed in by hand, so they arrive the way people write them -
 * "shorturl.at/abc", no scheme. Assume https rather than rejecting: http is
 * the only other thing that would work and nobody means it on purpose.
 * Anything that still won't parse, or isn't http(s) once it does, is
 * refused - `javascript:` in an href the whole party can tap is not a
 * theoretical worry.
 */
export function normaliseUrl(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_LINK_URL_LENGTH) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed;
  try { parsed = new URL(candidate); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.href;
}

export const POST_TYPES = ['announcement', 'poll', 'links'];

/**
 * The rules a post's contents have to satisfy, shared by creating and
 * editing so the two can never drift apart - an edit that accepted what a
 * create refuses would be a way around the limits rather than a feature.
 * Returns { text, options, links } or { error }.
 */
export function validatePostContent(type, { text, options, links }) {
  const trimmedText = String(text ?? '').trim();
  if (!trimmedText) return { error: 'err_post_text_required' };
  if (trimmedText.length > MAX_TEXT_LENGTH) return { error: 'err_post_too_long' };
  if (!POST_TYPES.includes(type)) return { error: 'err_invalid_post_type' };

  let cleanOptions = [];
  if (type === 'poll') {
    cleanOptions = Array.isArray(options)
      ? options.map((o) => String(o ?? '').trim()).filter(Boolean)
      : [];
    if (cleanOptions.length < MIN_OPTIONS) return { error: 'err_poll_min_options' };
    if (cleanOptions.length > MAX_OPTIONS) return { error: 'err_poll_max_options' };
    if (cleanOptions.some((o) => o.length > MAX_OPTION_LENGTH)) return { error: 'err_poll_option_too_long' };
  }

  let cleanLinks = [];
  if (type === 'links') {
    // A row needs both halves to mean anything, so a half-filled one is a
    // mistake worth naming rather than quietly dropping - except a wholly
    // empty row, which is just the spare input nobody typed into.
    const rows = (Array.isArray(links) ? links : [])
      .map((l) => ({
        emoji: String(l?.emoji ?? '').trim(),
        label: String(l?.label ?? '').trim(),
        url: String(l?.url ?? '').trim(),
      }))
      .filter((l) => l.emoji || l.label || l.url);
    if (rows.some((l) => !l.label || !l.url)) return { error: 'err_link_incomplete' };
    if (rows.length < MIN_LINKS) return { error: 'err_link_min_items' };
    if (rows.length > MAX_LINKS) return { error: 'err_link_max_items' };
    if (rows.some((l) => l.label.length > MAX_LINK_LABEL_LENGTH)) return { error: 'err_link_label_too_long' };
    if (rows.some((l) => [...l.emoji].length > MAX_LINK_EMOJI_LENGTH)) return { error: 'err_link_emoji_too_long' };
    cleanLinks = rows.map((l) => ({ emoji: l.emoji, label: l.label, url: normaliseUrl(l.url) }));
    if (cleanLinks.some((l) => !l.url)) return { error: 'err_link_invalid_url' };
  }

  return { text: trimmedText, options: cleanOptions, links: cleanLinks };
}
