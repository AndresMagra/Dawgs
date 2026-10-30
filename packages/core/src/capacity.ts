/**
 * Room for one more dog.
 *
 * Daycare is capped per day for the building and per yard at any moment.
 * Kennels hold one reservation per night; a stay occupies the nights from its
 * arrival date up to (not including) its departure date, so a dog leaving on
 * the 5th and another arriving on the 5th can share a kennel.
 */

export interface DateRange {
  /** `YYYY-MM-DD`, first night. */
  arrive: string;
  /** `YYYY-MM-DD`, the morning they leave. */
  depart: string;
}

export function nightsOf(r: DateRange): number {
  const a = Date.parse(`${r.arrive}T00:00:00Z`);
  const d = Date.parse(`${r.depart}T00:00:00Z`);
  return Math.round((d - a) / 86_400_000);
}

export function rangesOverlap(a: DateRange, b: DateRange): boolean {
  return a.arrive < b.depart && b.arrive < a.depart;
}

export function kennelIsFree(
  kennelId: string,
  wanted: DateRange,
  stays: readonly (DateRange & { kennelId: string | null; id?: string })[],
  ignoreStayId?: string,
): boolean {
  return !stays.some(
    (s) => s.kennelId === kennelId && s.id !== ignoreStayId && rangesOverlap(s, wanted),
  );
}

export function daycareSpotsLeft(capacity: number, bookedThatDay: number): number {
  return Math.max(0, capacity - bookedThatDay);
}

export type YardFit = { ok: true } | { ok: false; reason: string };

/** Yard rules from the prototype: size limits and a hard headcount. */
export function yardFits(args: {
  yard: { name: string; capacity: number; maxWeightLb?: number | null };
  inYardNow: number;
  dogWeightLb?: number | null;
}): YardFit {
  const { yard, inYardNow, dogWeightLb } = args;
  if (inYardNow >= yard.capacity) return { ok: false, reason: `${yard.name} is full (${yard.capacity})` };
  if (yard.maxWeightLb && dogWeightLb && dogWeightLb > yard.maxWeightLb)
    return { ok: false, reason: `${yard.name} is for dogs under ${yard.maxWeightLb} lb` };
  return { ok: true };
}
