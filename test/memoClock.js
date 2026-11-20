// The Memo helpers the old Node tests used (src/time.js + src/memo.js), rebuilt on the Worker's own
// Memo code (src/workerMemo.js), so those tests check what runs on Cloudflare.
import { setMemoClock, ensureSlots, zonedToUtc, todayOf } from '../src/workerMemo.js';

export const MEMO_SLOTS_PER_DAY = 5;
export const MEMO_MIN_GAP_MINUTES = 45;
const TZ = 'Europe/Lisbon';

export function memoClock(w) {
  let pinned = null;
  const now = () => (pinned ?? Date.now());
  const setClockForTests = (at) => {
    const prev = pinned;
    pinned = new Date(at).getTime();
    const restore = setMemoClock(pinned);
    return () => { pinned = prev; restore(); };
  };
  // Same rule as todayOf in the Worker, but synchronous: the day rolls over at day_rollover_hour (default 6).
  const today = () => {
    const row = w.db.prepare("SELECT value FROM settings WHERE key = 'day_rollover_hour'").get();
    const rollover = Number(row ? row.value : 6);
    const t = now();
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
    const hour = parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(new Date(t)), 10) % 24;
    if (hour >= rollover) return date;
    const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  };
  const ensureTodaysSlots = async () => ensureSlots(w.env, await todayOf(w.env));
  const zonedTimeToUtc = (day, hour, minute) => zonedToUtc(day, hour, minute);
  const getTimezone = () => TZ;
  return { now, today, setClockForTests, ensureTodaysSlots, zonedTimeToUtc, getTimezone };
}
