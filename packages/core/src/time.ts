/**
 * Wall-clock time in the business's own time zone.
 *
 * "Late pickup after 7 PM" and "check-out by noon" are local times, and the
 * server runs in UTC. Everything that asks "what day is it" or "when is 7 PM
 * today" goes through here with the location's IANA zone, so a dog checked out
 * at 11:30 PM Eastern is not billed on tomorrow's date.
 */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

export function zonedParts(t: number, tz: string): Parts {
  const out: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(t))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return {
    year: out.year!,
    month: out.month!,
    day: out.day!,
    hour: out.hour! % 24,
    minute: out.minute!,
    second: out.second!,
  };
}

/** Offset of `tz` from UTC at instant `t`, in ms (negative west of Greenwich). */
function offsetAt(t: number, tz: string): number {
  const p = zonedParts(t, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(t / 1000) * 1000;
}

/**
 * The instant at which local wall time y-m-d h:m happens in `tz`.
 *
 * Two passes, because the offset at the guessed instant may differ from the
 * offset at the answer on the two days a year the clocks change.
 */
export function zonedInstant(
  tz: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let t = naive - offsetAt(naive, tz);
  t = naive - offsetAt(t, tz);
  return t;
}

export function startOfLocalDay(t: number, tz: string): number {
  const p = zonedParts(t, tz);
  return zonedInstant(tz, p.year, p.month, p.day);
}

/** `HH:MM` local time on the same local day as `t`. */
export function atLocalTime(t: number, tz: string, hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  const p = zonedParts(t, tz);
  return zonedInstant(tz, p.year, p.month, p.day, h ?? 0, m ?? 0);
}

/** `YYYY-MM-DD` of the local day `t` falls on. */
export function localDateKey(t: number, tz: string): string {
  const p = zonedParts(t, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Start of the local day named by `YYYY-MM-DD`. */
export function dateKeyToInstant(key: string, tz: string, hhmm = '00:00'): number {
  const [y, mo, d] = key.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  return zonedInstant(tz, y!, mo!, d!, h ?? 0, mi ?? 0);
}

/** Whole local calendar days from the day of `a` to the day of `b`. */
export function localDaysBetween(a: number, b: number, tz: string): number {
  const pa = zonedParts(a, tz);
  const pb = zonedParts(b, tz);
  return Math.round(
    (Date.UTC(pb.year, pb.month - 1, pb.day) - Date.UTC(pa.year, pa.month - 1, pa.day)) / DAY,
  );
}

export function addLocalDays(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + n));
  return dt.toISOString().slice(0, 10);
}

/** Day of the week for a `YYYY-MM-DD` key, 0 = Sunday. Calendar arithmetic, so no time zone is involved. */
export function weekdayOf(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

/** Every date from `from` to `until` (inclusive) that falls on one of `weekdays`. */
export function datesOnWeekdays(from: string, until: string, weekdays: readonly number[]): string[] {
  const out: string[] = [];
  for (let k = from; k <= until; k = addLocalDays(k, 1)) if (weekdays.includes(weekdayOf(k))) out.push(k);
  return out;
}
