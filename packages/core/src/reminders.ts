/**
 * Two automatic nudges from the prototype.
 *
 *   - Pickup text: one hour before the planned pickup, once per visit.
 *   - "Haven't seen them": regulars who used to come and have not been in for
 *     a while. Shown to managers only, never sent automatically.
 */

import { DAY, HOUR, addLocalDays, atLocalTime, dateKeyToInstant } from './time.js';

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



/** Automatic texts go out from this local time on, never at night. */
export const REMINDER_LOCAL_TIME = '10:00';

/**
 * The day-before reminder for a booking that starts on `startDay` (a local
 * date key): due from 10:00 local the day before, until the day itself starts.
 */
export function bookingReminderDue(args: { startDay: string; now: number; tz: string; alreadySent: boolean }): boolean {
  if (args.alreadySent) return false;
  const opens = dateKeyToInstant(addLocalDays(args.startDay, -1), args.tz, REMINDER_LOCAL_TIME);
  const closes = dateKeyToInstant(args.startDay, args.tz);
  return args.now >= opens && args.now < closes;
}

export function bookingReminderText(args: { dogName: string; service: 'daycare' | 'boarding'; startDay: string; departDay?: string | null; business: string }): string {
  const when = dayLabel(args.startDay);
  if (args.service === 'boarding') {
    const until = args.departDay ? ` until ${dayLabel(args.departDay)}` : '';
    return `${args.business}: reminder, ${args.dogName} checks in for boarding tomorrow, ${when}${until}. Please bring food and any meds. Reply here if plans change.`;
  }
  return `${args.business}: reminder, ${args.dogName} is booked for daycare tomorrow, ${when}. See you then! Reply here if plans change.`;
}

/**
 * A verified vaccine is about to expire: due once it is within `days` of
 * expiring (and not yet expired), from 10:00 local on.
 */
export function vaccineReminderDue(args: { expiresAt: number; now: number; days: number; tz: string; alreadySent: boolean }): boolean {
  if (args.alreadySent || args.days <= 0) return false;
  if (args.now >= args.expiresAt || args.expiresAt - args.now > args.days * DAY) return false;
  return args.now >= atLocalTime(args.now, args.tz, REMINDER_LOCAL_TIME);
}

export function vaccineReminderText(args: { dogName: string; vaccine: string; expiresDay: string; business: string }): string {
  return `${args.business}: ${args.dogName}'s ${args.vaccine} vaccine expires ${dayLabel(args.expiresDay)}. Please upload the new certificate in the app (or send it to us) so ${args.dogName} can keep coming.`;
}

/** "Tue, Nov 5" from a local date key, without touching time zones. */
function dayLabel(key: string): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
