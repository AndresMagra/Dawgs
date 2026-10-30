/**
 * Repeating weekly daycare ("every Mon, Wed, Fri until March"). The schedule
 * is kept as a rule for display, and every day it covers becomes an ordinary
 * booking, so capacity, the board, billing and cancellations all work as they
 * do for one-off days.
 */

import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { ConflictError, NotFoundError, ValidationError, addLocalDays, datesOnWeekdays, localDateKey, withPolicyDefaults } from '@dawgs/core';
import { bookingSeries, bookings, dogs } from '@dawgs/db';
import type { AppContext } from './context.js';
import { createBooking, loadBusiness, setBookingStatus } from './ops.js';
import { audit } from './audit.js';

const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const seriesShape = z.object({
  dogId: z.string().uuid(),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  plan: z.enum(['half', 'full', 'hourly']),
  pickupTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  from: dateKey,
  until: dateKey,
});
export type SeriesInput = z.infer<typeof seriesShape>;

/** Half a year at most; longer schedules are renewed, so prices and plans get a look now and then. */
const MAX_DAYS = 183;

export async function createSeries(ctx: AppContext, args: { businessId: string; input: SeriesInput; source: 'staff' | 'owner'; actor: string }) {
  const { input } = args;
  const b = await loadBusiness(ctx.db, args.businessId);
  const today = localDateKey(ctx.now(), b.timezone);
  if (input.from < today) throw new ValidationError('the schedule must start today or later');
  let until = input.until;
  if (until < input.from) throw new ValidationError('the end date is before the start');
  if (until > addLocalDays(input.from, MAX_DAYS)) throw new ValidationError('a repeating schedule can run for six months at most');
  if (args.source === 'owner') {
    const rules = withPolicyDefaults(b.policies).onlineBooking;
    until = until > addLocalDays(today, rules.daysAhead) ? addLocalDays(today, rules.daysAhead) : until;
  }
  const dates = datesOnWeekdays(input.from, until, [...new Set(input.weekdays)]);
  if (!dates.length) throw new ValidationError('none of those weekdays fall in that range');

  const [series] = await ctx.db
    .insert(bookingSeries)
    .values({
      businessId: args.businessId,
      dogId: input.dogId,
      weekdays: [...new Set(input.weekdays)].sort(),
      plan: input.plan,
      pickupTime: input.pickupTime ?? null,
      fromDate: input.from,
      untilDate: until,
      createdBy: args.actor,
    })
    .returning();
  const made: { date: string; status: string }[] = [];
  const skipped: { date: string; reason: string }[] = [];
  for (const date of dates) {
    try {
      const bk = await createBooking(ctx, {
        businessId: args.businessId,
        source: args.source,
        actor: args.actor,
        input: { dogId: input.dogId, service: 'daycare', plan: input.plan, date, pickupTime: input.pickupTime ?? null, seriesId: series!.id },
      });
      made.push({ date, status: bk.status });
    } catch (e) {
      // A day that's already booked or full is skipped; anything else (vaccines, waivers) stops the whole schedule.
      if (e instanceof ConflictError) skipped.push({ date, reason: e.message });
      else {
        await ctx.db.delete(bookingSeries).where(eq(bookingSeries.id, series!.id));
        throw e;
      }
    }
  }
  if (!made.length) {
    await ctx.db.delete(bookingSeries).where(eq(bookingSeries.id, series!.id));
    throw new ValidationError(`no days could be booked: ${skipped[0]?.reason ?? 'all full'}`);
  }
  await audit(ctx.db, args.businessId, args.actor, 'booking.series', `Repeating daycare ${input.from} → ${until}: ${made.length} days`);
  return { series: series!, booked: made.length, waitlisted: made.filter((m) => m.status === 'waitlist').length, skipped, until };
}

/** Stop a schedule from a day on: those bookings are cancelled with the usual fee rules. */
export async function stopSeries(ctx: AppContext, args: { businessId: string; seriesId: string; from: string; actor: string; ownerId?: string; waiveFee?: boolean }) {
  const [s] = await ctx.db.select().from(bookingSeries).where(eq(bookingSeries.id, args.seriesId));
  if (!s || s.businessId !== args.businessId) throw new NotFoundError('schedule');
  if (args.ownerId) {
    const [d] = await ctx.db.select({ ownerId: dogs.ownerId }).from(dogs).where(eq(dogs.id, s.dogId));
    if (d?.ownerId !== args.ownerId) throw new NotFoundError('schedule');
  }
  const rows = await ctx.db
    .select()
    .from(bookings)
    .where(and(eq(bookings.seriesId, s.id), gte(bookings.date, args.from), inArray(bookings.status, ['requested', 'confirmed', 'waitlist'])));
  let fees = 0;
  for (const r of rows) {
    const out = await setBookingStatus(ctx, { businessId: args.businessId, bookingId: r.id, status: 'cancelled', actor: args.actor, ...(args.waiveFee ? { waiveFee: true } : {}) });
    if (out.feeInvoiceId) fees++;
  }
  await ctx.db.update(bookingSeries).set({ stoppedFrom: args.from }).where(eq(bookingSeries.id, s.id));
  await audit(ctx.db, args.businessId, args.actor, 'booking.series.stop', `Stopped a repeating schedule from ${args.from}: ${rows.length} days cancelled`);
  return { cancelled: rows.length, fees };
}

export async function listSeries(ctx: AppContext, businessId: string, dogIds?: readonly string[]) {
  const b = await loadBusiness(ctx.db, businessId);
  const today = localDateKey(ctx.now(), b.timezone);
  const rows = await ctx.db
    .select({ s: bookingSeries, dog: dogs.name })
    .from(bookingSeries)
    .innerJoin(dogs, eq(dogs.id, bookingSeries.dogId))
    .where(and(eq(bookingSeries.businessId, businessId), gte(bookingSeries.untilDate, today), ...(dogIds ? [inArray(bookingSeries.dogId, dogIds.length ? [...dogIds] : ['00000000-0000-0000-0000-000000000000'])] : [])))
    .orderBy(desc(bookingSeries.createdAt));
  return rows.filter((r) => !r.s.stoppedFrom || r.s.stoppedFrom > today).map((r) => ({ ...r.s, dog: r.dog }));
}
