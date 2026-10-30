/**
 * Two automatic nudges from the prototype.
 *
 *   - Pickup text: one hour before the planned pickup, once per visit.
 *   - "Haven't seen them": regulars who used to come and have not been in for
 *     a while. Shown to managers only, never sent automatically.
 */

import { DAY, HOUR } from './time.js';

export function pickupTextDue(args: {
  plannedPickupAt: number | null;
  now: number;
  alreadySent: boolean;
  leadMs?: number;
}): boolean {
  const { plannedPickupAt, now, alreadySent } = args;
  const lead = args.leadMs ?? HOUR;
  if (alreadySent || plannedPickupAt == null) return false;
  return now >= plannedPickupAt - lead && now < plannedPickupAt;
}

export interface InactiveDog {
  dogId: string;
  lastVisitAt: number;
  daysAway: number;
}

/**
 * Dogs with at least `minVisits` visits whose last one is older than
 * `afterDays`. Sorted longest-away first so the list reads as a call sheet.
 */
export function inactiveDogs(
  history: readonly { dogId: string; visits: number; lastVisitAt: number | null }[],
  now: number,
  afterDays = 21,
  minVisits = 3,
): InactiveDog[] {
  return history
    .filter((h) => h.lastVisitAt != null && h.visits >= minVisits && now - h.lastVisitAt > afterDays * DAY)
    .map((h) => ({
      dogId: h.dogId,
      lastVisitAt: h.lastVisitAt!,
      daysAway: Math.floor((now - h.lastVisitAt!) / DAY),
    }))
    .sort((a, b) => b.daysAway - a.daysAway);
}

export function pickupText(dogName: string, pickupAt: string, businessName: string): string {
  return `${businessName}: ${dogName} is ready for pickup around ${pickupAt}. See you soon! Reply STOP to opt out.`;
}


