/**
 * Automatic heads-ups to owners, from the scheduler:
 *
 *   - the day before a confirmed daycare day or boarding arrival;
 *   - when a verified vaccine is about to expire (unless a newer certificate
 *     for the same shot is already on file).
 *
 * Each row is claimed by setting `reminder_sent_at` before the text goes
 * out, so two servers never send the same reminder. Texts honour STOP through
 * `sendText`; the push goes to the owner's app either way.
 */

import { and, eq, gt, isNotNull, isNull, lte, or } from 'drizzle-orm';
import {
  addLocalDays,
  bookingReminderDue,
  bookingReminderText,
  localDateKey,
  vaccineReminderDue,
  vaccineReminderText,
  withPolicyDefaults,
} from '@dawgs/core';
import { bookings, businesses, dogs, vaccines } from '@dawgs/db';
import type { AppContext } from './context.js';
import { pushToOwner, sendText } from './texts.js';

export async function runBookingReminders(ctx: AppContext) {
  let sent = 0;
  for (const b of await ctx.db.select().from(businesses)) {
    if (!withPolicyDefaults(b.policies).bookingReminders) continue;
    const tomorrow = addLocalDays(localDateKey(ctx.now(), b.timezone), 1);
    if (!bookingReminderDue({ startDay: tomorrow, now: ctx.now(), tz: b.timezone, alreadySent: false })) continue;
    const due = await ctx.db
      .select({ booking: bookings, dog: dogs })
      .from(bookings)
      .innerJoin(dogs, eq(dogs.id, bookings.dogId))
      .where(
        and(
          eq(bookings.businessId, b.id),
          eq(bookings.status, 'confirmed'),
          isNull(bookings.reminderSentAt),
          or(and(eq(bookings.service, 'daycare'), eq(bookings.date, tomorrow)), and(eq(bookings.service, 'boarding'), eq(bookings.arrive, tomorrow))),
        ),
      );
    for (const { booking, dog } of due) {
      const [claimed] = await ctx.db
        .update(bookings)
        .set({ reminderSentAt: new Date(ctx.now()) })
        .where(and(eq(bookings.id, booking.id), isNull(bookings.reminderSentAt)))
        .returning({ id: bookings.id });
      if (!claimed) continue;
      const body = bookingReminderText({ dogName: dog.name, service: booking.service, startDay: tomorrow, departDay: booking.depart, business: b.name });
      await sendText(ctx, { businessId: b.id, ownerId: dog.ownerId, kind: 'reminder', body });
      await pushToOwner(ctx, dog.ownerId, `${dog.name} tomorrow`, body, { bookingId: booking.id }).catch(() => undefined);
      sent++;
    }
  }
  return sent;
}

export async function runVaccineReminders(ctx: AppContext) {
  let sent = 0;
  const now = ctx.now();
  for (const b of await ctx.db.select().from(businesses)) {
    const days = withPolicyDefaults(b.policies).vaccineReminderDays;
    if (days <= 0) continue;
    const rows = await ctx.db
      .select({ vaccine: vaccines, dog: dogs })
      .from(vaccines)
      .innerJoin(dogs, eq(dogs.id, vaccines.dogId))
      .where(
        and(
          eq(vaccines.businessId, b.id),
          eq(dogs.active, true),
          isNotNull(vaccines.verifiedBy),
          isNull(vaccines.reminderSentAt),
          gt(vaccines.expiresAt, new Date(now)),
          lte(vaccines.expiresAt, new Date(now + days * 86_400_000)),
        ),
      );
    for (const { vaccine, dog } of rows) {
      if (!vaccineReminderDue({ expiresAt: vaccine.expiresAt.getTime(), now, days, tz: b.timezone, alreadySent: false })) continue;
      // A newer certificate for the same shot (even one still waiting for staff) means the owner already acted.
      const [newer] = await ctx.db
        .select({ id: vaccines.id })
        .from(vaccines)
        .where(and(eq(vaccines.dogId, dog.id), eq(vaccines.name, vaccine.name), gt(vaccines.expiresAt, vaccine.expiresAt)))
        .limit(1);
      const [claimed] = await ctx.db
        .update(vaccines)
        .set({ reminderSentAt: new Date(now) })
        .where(and(eq(vaccines.id, vaccine.id), isNull(vaccines.reminderSentAt)))
        .returning({ id: vaccines.id });
      if (!claimed || newer) continue;
      const body = vaccineReminderText({ dogName: dog.name, vaccine: vaccine.name, expiresDay: localDateKey(vaccine.expiresAt.getTime(), b.timezone), business: b.name });
      await sendText(ctx, { businessId: b.id, ownerId: dog.ownerId, kind: 'reminder', body });
      await pushToOwner(ctx, dog.ownerId, `${dog.name}'s ${vaccine.name} expires soon`, body, { dogId: dog.id }).catch(() => undefined);
      sent++;
    }
  }
  return sent;
}
