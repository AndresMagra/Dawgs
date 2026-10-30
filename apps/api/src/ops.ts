/**
 * The front desk's day: bookings, check-in, the board, check-out.
 *
 * Booking rules are enforced here once, for both apps:
 *   - a dog with missing/expired required vaccines or unsigned required
 *     waivers cannot be booked or checked in;
 *   - daycare is capped per day; a full day puts staff bookings on the
 *     waitlist and refuses owner requests;
 *   - a kennel holds one stay per night.
 */

import { and, eq, gte, inArray, isNull, lt, lte, ne, notInArray, or, sql } from 'drizzle-orm';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  addLocalDays,
  atLocalTime,
  computeBill,
  finishBill,
  lateCancelFee,
  withPolicyDefaults,
  type Extras,
  dateKeyToInstant,
  estimateStay,
  kennelIsFree,
  localDateKey,
  nightsOf,
  yardFits,
  type AddOn,
  type BillLine,
} from '@dawgs/core';
import {
  addOns,
  bookingAddOns,
  bookings,
  businesses,
  careTasks,
  dogs,
  inventoryItems,
  kennels,
  visits,
  yards,
  type BookingStatus,
  type Database,
} from '@dawgs/db';
import type { AppContext } from './context.js';
import { dogSummaries } from './people.js';
import { spendCredits, walletOf } from './credits.js';
import { createInvoice, payInvoice, type PayOutcome } from './payments.js';
import type { PayInput } from './util.js';
import { audit } from './audit.js';
import { addOnsForBookings, insertPlanned, planAddOns, type AddOnRequest } from './addons.js';

const ACTIVE: BookingStatus[] = ['requested', 'confirmed', 'checked_in'];

export async function loadBusiness(db: Database, businessId: string) {
  const [b] = await db.select().from(businesses).where(eq(businesses.id, businessId));
  if (!b) throw new NotFoundError('business');
  return b;
}

export async function daycareCount(db: Database, businessId: string, date: string, ignoreId?: string) {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(bookings)
    .where(
      and(
        eq(bookings.businessId, businessId),
        eq(bookings.service, 'daycare'),
        eq(bookings.date, date),
        inArray(bookings.status, ACTIVE),
        ...(ignoreId ? [ne(bookings.id, ignoreId)] : []),
      ),
    );
  return r?.n ?? 0;
}

export async function activeStays(db: Database, businessId: string, from: string, to: string) {
  return db
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.businessId, businessId),
        eq(bookings.service, 'boarding'),
        inArray(bookings.status, ACTIVE),
        lt(bookings.arrive, to),
        gte(bookings.depart, from),
      ),
    );
}

export async function availability(
  db: Database,
  businessId: string,
  q: { service: 'daycare'; date: string } | { service: 'boarding'; arrive: string; depart: string },
) {
  const b = await loadBusiness(db, businessId);
  if (q.service === 'daycare') {
    const n = await daycareCount(db, businessId, q.date);
    return { service: 'daycare' as const, capacity: b.daycareCapacity, booked: n, spotsLeft: Math.max(0, b.daycareCapacity - n) };
  }
  if (nightsOf(q) < 1) throw new ValidationError('departure must be after arrival');
  const all = await db.select().from(kennels).where(and(eq(kennels.businessId, businessId), eq(kennels.active, true)));
  const stays = await activeStays(db, businessId, q.arrive, q.depart);
  const shaped = stays.map((s) => ({ id: s.id, kennelId: s.kennelId, arrive: s.arrive!, depart: s.depart! }));
  const free = all.filter((k) => kennelIsFree(k.id, q, shaped));
  return {
    service: 'boarding' as const,
    nights: nightsOf(q),
    freeKennels: free.map((k) => ({
      id: k.id,
      name: k.name,
      type: k.type,
      estimateCents: estimateStay({ nights: nightsOf(q), kennelType: k.type, play: false, prices: b.prices }),
    })),
  };
}

async function assertDogMayCome(db: Database, businessId: string, dogId: string, now: number) {
  const [s] = await dogSummaries(db, businessId, [dogId], now);
  if (!s) throw new NotFoundError('dog');
  if (!s.active) throw new ValidationError(`${s.name} is archived`);
  if (s.vaccineState === 'expired' || s.vaccineState === 'missing') {
    const bad = s.vaccines.filter((v) => v.state === 'expired' || v.state === 'missing').map((v) => v.name);
    throw new ValidationError(`${s.name} needs up-to-date vaccines first: ${bad.join(', ')}`);
  }
  if (s.waiversMissing.length) {
    throw new ValidationError(`${s.owner.name} still needs to sign: ${s.waiversMissing.join(', ')}`);
  }
  return s;
}

export type BookingInput =
  | { dogId: string; service: 'daycare'; plan: 'half' | 'full' | 'hourly'; date: string; pickupTime?: string | null; notes?: string | null; addOns?: AddOnRequest[]; seriesId?: string }
  | {
      dogId: string;
      service: 'boarding';
      arrive: string;
      depart: string;
      kennelId?: string | null;
      kennelType?: 'suite' | 'run' | null;
      play?: boolean;
      notes?: string | null;
      addOns?: AddOnRequest[];
    };

export async function createBooking(
  ctx: AppContext,
  args: { businessId: string; input: BookingInput; source: 'staff' | 'owner'; actor: string },
) {
  const { businessId, input, source } = args;
  const b = await loadBusiness(ctx.db, businessId);
  const dog = await assertDogMayCome(ctx.db, businessId, input.dogId, ctx.now());
  const today = localDateKey(ctx.now(), b.timezone);
  const rules = withPolicyDefaults(b.policies).onlineBooking;
  if (source === 'owner') {
    if (!rules.enabled) throw new ValidationError(`${b.name} takes bookings by phone or at the desk`);
    const first = input.service === 'daycare' ? input.date : input.arrive;
    if (first > addLocalDays(today, rules.daysAhead)) throw new ValidationError(`bookings open ${rules.daysAhead} days ahead`);
  }
  // With auto-approve on, an owner's booking is confirmed straight away when there is room.
  const ownerStatus: BookingStatus = rules.autoApprove ? 'confirmed' : 'requested';

  if (input.service === 'daycare') {
    if (input.date < today) throw new ValidationError('that date has passed');
    const dup = await ctx.db
      .select({ id: bookings.id })
      .from(bookings)
      .where(and(eq(bookings.dogId, input.dogId), eq(bookings.date, input.date), inArray(bookings.status, ACTIVE)));
    if (dup.length) throw new ConflictError(`${dog.name} is already booked that day`);
    const full = (await daycareCount(ctx.db, businessId, input.date)) >= b.daycareCapacity;
    if (full && source === 'owner') throw new ConflictError('that day is full; try another day or ask to be waitlisted');
    const status: BookingStatus = full ? 'waitlist' : source === 'owner' ? ownerStatus : 'confirmed';
    const extras = await planAddOns(ctx, { businessId, stay: { service: 'daycare', date: input.date, arrive: null, depart: null, dogId: input.dogId }, requests: input.addOns ?? [], source, actor: args.actor });
    const [row] = await ctx.db
      .insert(bookings)
      .values({
        businessId,
        dogId: input.dogId,
        service: 'daycare',
        plan: input.plan,
        date: input.date,
        pickupTime: input.pickupTime ?? null,
        seriesId: input.seriesId ?? null,
        status,
        source,
        notes: input.notes ?? null,
        estimateCents: input.plan === 'full' ? b.prices.fullDay : input.plan === 'half' ? b.prices.halfDay : null,
      })
      .returning();
    const added = await insertPlanned(ctx, row!.id, extras);
    await audit(ctx.db, businessId, args.actor, 'booking.create', `${dog.name}: daycare ${input.date} (${status})`);
    return { ...row!, addOns: added };
  }

  const range = { arrive: input.arrive, depart: input.depart };
  if (nightsOf(range) < 1) throw new ValidationError('departure must be after arrival');
  if (input.arrive < today) throw new ValidationError('that date has passed');
  const all = await ctx.db.select().from(kennels).where(and(eq(kennels.businessId, businessId), eq(kennels.active, true)));
  const stays = (await activeStays(ctx.db, businessId, range.arrive, range.depart)).map((s) => ({
    id: s.id,
    kennelId: s.kennelId,
    arrive: s.arrive!,
    depart: s.depart!,
  }));
  let kennel = input.kennelId ? all.find((k) => k.id === input.kennelId) : undefined;
  if (input.kennelId && !kennel) throw new NotFoundError('kennel');
  if (kennel && !kennelIsFree(kennel.id, range, stays)) throw new ConflictError(`${kennel.name} is taken those nights`);
  if (!kennel) {
    kennel = all.find((k) => (!input.kennelType || k.type === input.kennelType) && kennelIsFree(k.id, range, stays));
    if (!kennel) throw new ConflictError('no kennel is free for those nights');
  }
  const extras = await planAddOns(ctx, { businessId, stay: { service: 'boarding', date: null, ...range, dogId: input.dogId }, requests: input.addOns ?? [], source, actor: args.actor });
  const [row] = await ctx.db
    .insert(bookings)
    .values({
      businessId,
      dogId: input.dogId,
      service: 'boarding',
      arrive: range.arrive,
      depart: range.depart,
      kennelId: kennel.id,
      play: input.play ?? false,
      status: source === 'owner' ? ownerStatus : 'confirmed',
      source,
      notes: input.notes ?? null,
      estimateCents: estimateStay({ nights: nightsOf(range), kennelType: kennel.type, play: input.play ?? false, prices: b.prices }),
    })
    .returning();
  const added = await insertPlanned(ctx, row!.id, extras);
  await audit(ctx.db, businessId, args.actor, 'booking.create', `${dog.name}: ${kennel.name} ${range.arrive} → ${range.depart}`);
  return { ...row!, addOns: added };
}

export async function setBookingStatus(
  ctx: AppContext,
  args: { businessId: string; bookingId: string; status: 'confirmed' | 'declined' | 'cancelled' | 'no_show'; actor: string; waiveFee?: boolean },
) {
  const [bk] = await ctx.db.select().from(bookings).where(eq(bookings.id, args.bookingId));
  if (!bk || bk.businessId !== args.businessId) throw new NotFoundError('booking');
  if (bk.status === 'checked_in' || bk.status === 'checked_out') throw new ValidationError('the dog has already come in');
  if (args.status === 'confirmed' && bk.service === 'daycare' && bk.status === 'waitlist') {
    const b = await loadBusiness(ctx.db, args.businessId);
    if ((await daycareCount(ctx.db, args.businessId, bk.date!, bk.id)) >= b.daycareCapacity) {
      throw new ConflictError('the day is still full');
    }
  }
  await ctx.db.update(bookings).set({ status: args.status }).where(eq(bookings.id, bk.id));
  await audit(ctx.db, args.businessId, args.actor, `booking.${args.status}`, `Booking ${bk.service} ${bk.date ?? bk.arrive} → ${args.status}`);
  let feeInvoiceId: string | null = null;
  // Only a booking the daycare had agreed to costs anything to cancel or miss.
  if ((args.status === 'cancelled' || args.status === 'no_show') && bk.status === 'confirmed' && !args.waiveFee) {
    const b = await loadBusiness(ctx.db, args.businessId);
    const policies = withPolicyDefaults(b.policies);
    const first = bk.date ?? bk.arrive!;
    const fee = args.status === 'no_show' ? policies.noShowFeeCents : lateCancelFee(policies, first, b.timezone, ctx.now());
    if (fee > 0) {
      const [dog] = await ctx.db.select().from(dogs).where(eq(dogs.id, bk.dogId));
      const inv = await createInvoice(ctx.db, {
        businessId: args.businessId,
        ownerId: dog!.ownerId,
        dogId: dog!.id,
        category: 'other',
        lines: [{ kind: 'fee', text: `${args.status === 'no_show' ? 'No-show' : 'Late cancellation'}: ${dog!.name}, ${bk.service} ${first}`, amount: fee }],
      });
      feeInvoiceId = inv.id;
      await audit(ctx.db, args.businessId, args.actor, 'booking.fee', `${args.status === 'no_show' ? 'No-show' : 'Late-cancel'} fee invoice #${inv.number}`);
    }
  }
  return { ...bk, status: args.status, feeInvoiceId };
}

/** Check a dog in, from a booking or as a walk-in. */
export async function checkIn(
  ctx: AppContext,
  args: {
    businessId: string;
    actor: string;
    bookingId?: string | null;
    dogId?: string | null;
    service?: 'daycare' | 'boarding';
    plan?: 'half' | 'full' | 'hourly';
    yardId?: string | null;
    pickupTime?: string | null;
    kennelId?: string | null;
    departDate?: string | null;
    play?: boolean;
  },
) {
  const b = await loadBusiness(ctx.db, args.businessId);
  const now = ctx.now();
  let booking: typeof bookings.$inferSelect | undefined;
  if (args.bookingId) {
    [booking] = await ctx.db.select().from(bookings).where(eq(bookings.id, args.bookingId));
    if (!booking || booking.businessId !== args.businessId) throw new NotFoundError('booking');
    if (!['confirmed', 'requested', 'waitlist'].includes(booking.status)) throw new ValidationError(`booking is ${booking.status}`);
  }
  const dogId = booking?.dogId ?? args.dogId;
  if (!dogId) throw new ValidationError('dogId or bookingId is required');
  const dog = await assertDogMayCome(ctx.db, args.businessId, dogId, now);
  const [open] = await ctx.db.select().from(visits).where(and(eq(visits.dogId, dogId), isNull(visits.checkedOutAt)));
  if (open) throw new ConflictError(`${dog.name} is already checked in`);

  const service = booking?.service ?? args.service ?? 'daycare';
  const yardId = args.yardId ?? dog.defaultYardId ?? null;
  if (yardId) {
    const [y] = await ctx.db.select().from(yards).where(eq(yards.id, yardId));
    if (!y || y.businessId !== args.businessId) throw new NotFoundError('yard');
    const [{ n }] = (await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(visits)
      .where(and(eq(visits.yardId, yardId), isNull(visits.checkedOutAt)))) as [{ n: number }];
    const fit = yardFits({ yard: y, inYardNow: n, dogWeightLb: dog.weightLb });
    if (!fit.ok) throw new ConflictError(fit.reason);
  }

  let kennelId: string | null = null;
  let departDate: string | null = null;
  if (service === 'boarding') {
    kennelId = booking?.kennelId ?? args.kennelId ?? null;
    departDate = booking?.depart ?? args.departDate ?? null;
    if (!kennelId || !departDate) throw new ValidationError('boarding needs a kennel and a departure date');
    if (!booking) {
      const stays = (await activeStays(ctx.db, args.businessId, localDateKey(now, b.timezone), departDate)).map((s) => ({
        id: s.id,
        kennelId: s.kennelId,
        arrive: s.arrive!,
        depart: s.depart!,
      }));
      if (!kennelIsFree(kennelId, { arrive: localDateKey(now, b.timezone), depart: departDate }, stays)) {
        throw new ConflictError('that kennel is taken');
      }
    }
  }
  const pickupTime = booking?.pickupTime ?? args.pickupTime ?? null;
  const [v] = await ctx.db
    .insert(visits)
    .values({
      businessId: args.businessId,
      bookingId: booking?.id ?? null,
      dogId,
      service,
      plan: service === 'daycare' ? (booking?.plan ?? args.plan ?? 'full') : null,
      kennelId,
      departDate,
      play: booking?.play ?? args.play ?? false,
      yardId,
      checkedInAt: new Date(now),
      checkedInBy: args.actor,
      plannedPickupAt: pickupTime && service === 'daycare' ? new Date(atLocalTime(now, b.timezone, pickupTime)) : null,
    })
    .returning();
  if (booking) {
    await ctx.db.update(bookings).set({ status: 'checked_in' }).where(eq(bookings.id, booking.id));
  } else if (service === 'boarding') {
    // A walk-in boarder still has to hold the kennel on the calendar.
    const [bk] = await ctx.db
      .insert(bookings)
      .values({
        businessId: args.businessId,
        dogId,
        service: 'boarding',
        arrive: localDateKey(now, b.timezone),
        depart: departDate!,
        kennelId,
        play: args.play ?? false,
        status: 'checked_in',
        source: 'staff',
      })
      .returning();
    await ctx.db.update(visits).set({ bookingId: bk!.id }).where(eq(visits.id, v!.id));
  }
  await makeCareTasks(ctx, v!, dog, b.timezone);
  await audit(ctx.db, args.businessId, args.actor, 'visit.checkin', `${dog.name} checked in (${service})`);
  return v!;
}

/** Feeding and medication reminders for the day, from the dog's profile. */
async function makeCareTasks(
  ctx: AppContext,
  v: typeof visits.$inferSelect,
  dog: { id: string; name: string; feeding: string | null; medications: { name: string; dose: string; when: string }[] },
  tz: string,
) {
  const now = ctx.now();
  const at = (hhmm: string) => {
    const t = atLocalTime(now, tz, hhmm);
    return new Date(t > now ? t : now + 30 * 60_000);
  };
  const rows: (typeof careTasks.$inferInsert)[] = [];
  if (dog.feeding) rows.push({ businessId: v.businessId, dogId: dog.id, visitId: v.id, kind: 'feeding', title: `Feed ${dog.name}: ${dog.feeding}`, dueAt: at('12:00') });
  for (const m of dog.medications) {
    const when = /^\d{2}:\d{2}$/.test(m.when) ? m.when : /pm|evening|dinner/i.test(m.when) ? '17:00' : '12:00';
    rows.push({ businessId: v.businessId, dogId: dog.id, visitId: v.id, kind: 'meds', title: `${dog.name}: ${m.name} ${m.dose} (${m.when})`, dueAt: at(when) });
  }
  if (rows.length) await ctx.db.insert(careTasks).values(rows);
}

export async function moveVisit(
  ctx: AppContext,
  args: { businessId: string; visitId: string; yardId?: string | null; pickupTime?: string | null; actor: string },
) {
  const [v] = await ctx.db.select().from(visits).where(eq(visits.id, args.visitId));
  if (!v || v.businessId !== args.businessId || v.checkedOutAt) throw new NotFoundError('visit');
  const set: Partial<typeof visits.$inferInsert> = {};
  if (args.yardId !== undefined) {
    if (args.yardId) {
      const [y] = await ctx.db.select().from(yards).where(eq(yards.id, args.yardId));
      if (!y || y.businessId !== args.businessId) throw new NotFoundError('yard');
      const [d] = await ctx.db.select().from(dogs).where(eq(dogs.id, v.dogId));
      const [{ n }] = (await ctx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(visits)
        .where(and(eq(visits.yardId, args.yardId), isNull(visits.checkedOutAt), ne(visits.id, v.id)))) as [{ n: number }];
      const fit = yardFits({ yard: y, inYardNow: n, dogWeightLb: d?.weightLb });
      if (!fit.ok) throw new ConflictError(fit.reason);
    }
    set.yardId = args.yardId;
  }
  if (args.pickupTime !== undefined) {
    const b = await loadBusiness(ctx.db, args.businessId);
    set.plannedPickupAt = args.pickupTime ? new Date(atLocalTime(ctx.now(), b.timezone, args.pickupTime)) : null;
    set.pickupTextSentAt = null;
  }
  const [out] = await ctx.db.update(visits).set(set).where(eq(visits.id, v.id)).returning();
  return out!;
}

async function resolveAddOns(db: Database, businessId: string, codes: readonly string[]): Promise<AddOn[]> {
  if (!codes.length) return [];
  const extras = await db.select().from(addOns).where(eq(addOns.businessId, businessId));
  const stock = await db.select().from(inventoryItems).where(eq(inventoryItems.businessId, businessId));
  return codes.map((c) => {
    const x = extras.find((e) => e.code === c || e.id === c);
    if (x) return { code: x.code, name: x.name, price: x.priceCents };
    const s = stock.find((i) => i.id === c);
    if (s) return { code: `item:${s.id}`, name: s.name, price: s.priceCents };
    throw new ValidationError(`unknown add-on ${c}`);
  });
}

/** What was booked with the stay goes on the bill without anyone ticking it again. */
async function bookedAddOns(ctx: AppContext, bookingId: string | null): Promise<AddOn[]> {
  if (!bookingId) return [];
  const rows = (await addOnsForBookings(ctx, [bookingId])).get(bookingId) ?? [];
  return rows.map((r) => ({
    code: r.code,
    name: `${r.name}${r.quantity > 1 ? ` × ${r.quantity}` : ''}${r.time ? ` (${r.time})` : ''}`,
    price: r.unitCents * r.quantity,
  }));
}

/** Another of the family's dogs came to daycare earlier the same day, so this one is the extra dog. */
async function isExtraDog(ctx: AppContext, v: typeof visits.$inferSelect, tz: string) {
  if (v.service !== 'daycare') return false;
  const [dog] = await ctx.db.select({ ownerId: dogs.ownerId }).from(dogs).where(eq(dogs.id, v.dogId));
  const day = localDateKey(v.checkedInAt.getTime(), tz);
  const siblings = await ctx.db
    .select({ id: visits.id, at: visits.checkedInAt })
    .from(visits)
    .innerJoin(dogs, eq(dogs.id, visits.dogId))
    .where(and(eq(dogs.ownerId, dog!.ownerId), ne(visits.dogId, v.dogId), eq(visits.service, 'daycare'), lt(visits.checkedInAt, v.checkedInAt)));
  return siblings.some((x) => localDateKey(x.at.getTime(), tz) === day);
}

export async function previewBill(ctx: AppContext, businessId: string, visitId: string, addOnCodes: readonly string[] = [], extras: Extras = {}) {
  const [v] = await ctx.db.select().from(visits).where(eq(visits.id, visitId));
  if (!v || v.businessId !== businessId) throw new NotFoundError('visit');
  const b = await loadBusiness(ctx.db, businessId);
  const policies = withPolicyDefaults(b.policies);
  const multiDog = policies.multiDogPercent > 0 && (await isExtraDog(ctx, v, b.timezone));
  const kennel = v.kennelId ? (await ctx.db.select().from(kennels).where(eq(kennels.id, v.kennelId)))[0] : undefined;
  const wallet = await walletOf(ctx.db, v.dogId, ctx.now());
  const bill = computeBill({
    visit:
      v.service === 'boarding'
        ? {
            service: 'boarding',
            checkedInAt: v.checkedInAt.getTime(),
            departDate: v.departDate!,
            kennelType: kennel?.type ?? 'run',
            ...(kennel ? { kennelName: kennel.name } : {}),
            play: v.play,
          }
        : { service: 'daycare', plan: v.plan ?? 'full', checkedInAt: v.checkedInAt.getTime() },
    checkoutAt: v.checkedOutAt?.getTime() ?? ctx.now(),
    prices: b.prices,
    hours: b.hours,
    tz: b.timezone,
    wallet,
    addOns: [...(await bookedAddOns(ctx, v.bookingId)), ...(await resolveAddOns(ctx.db, businessId, addOnCodes))],
  });
  return finishBill(bill, policies, { ...extras, multiDog });
}

/**
 * Send a dog home: close the visit, spend credits, invoice, and settle.
 * A declined card does not undo the check-out; the invoice stays open.
 */
export async function checkOut(
  ctx: AppContext,
  args: { businessId: string; visitId: string; addOns?: readonly string[]; pay: PayInput; actor: string; pickedUpBy?: string; extras?: Extras },
): Promise<PayOutcome & { visit: typeof visits.$inferSelect }> {
  const [v] = await ctx.db.select().from(visits).where(eq(visits.id, args.visitId));
  if (!v || v.businessId !== args.businessId) throw new NotFoundError('visit');
  if (v.checkedOutAt) throw new ConflictError('already checked out');
  const bill = await previewBill(ctx, args.businessId, v.id, args.addOns ?? [], args.extras ?? {});
  const [dog] = await ctx.db.select().from(dogs).where(eq(dogs.id, v.dogId));
  const now = ctx.now();
  const [closed] = await ctx.db
    .update(visits)
    .set({ checkedOutAt: new Date(now), checkedOutBy: args.actor, pickedUpBy: args.pickedUpBy ?? null })
    .where(and(eq(visits.id, v.id), isNull(visits.checkedOutAt)))
    .returning();
  if (!closed) throw new ConflictError('already checked out');
  if (Object.values(bill.creditsUsed).some((n) => (n ?? 0) > 0)) await spendCredits(ctx.db, v.dogId, bill.creditsUsed, now);
  for (const code of args.addOns ?? []) {
    if (code.startsWith('item:') || /^[0-9a-f-]{36}$/.test(code)) {
      const id = code.replace('item:', '');
      await ctx.db.update(inventoryItems).set({ onHand: sql`${inventoryItems.onHand} - 1` }).where(eq(inventoryItems.id, id));
    }
  }
  if (v.bookingId) {
    await ctx.db.update(bookings).set({ status: 'checked_out' }).where(eq(bookings.id, v.bookingId));
    // Billed now; a drop-off still waiting stays open for the driver.
    await ctx.db
      .update(bookingAddOns)
      .set({ status: 'done', doneBy: args.actor, doneAt: new Date(now) })
      .where(and(eq(bookingAddOns.bookingId, v.bookingId), eq(bookingAddOns.kind, 'extra'), eq(bookingAddOns.status, 'scheduled')));
  }
  const lines: BillLine[] = bill.lines;
  const inv = await createInvoice(ctx.db, {
    businessId: args.businessId,
    ownerId: dog!.ownerId,
    dogId: dog!.id,
    visitId: v.id,
    category: v.service === 'boarding' ? 'boarding' : 'daycare',
    lines,
  });
  await ctx.db.update(visits).set({ invoiceId: inv.id }).where(eq(visits.id, v.id));
  await audit(ctx.db, args.businessId, args.actor, 'visit.checkout', `${dog!.name} went home${args.pickedUpBy ? ` with ${args.pickedUpBy}` : ''}, invoice #${inv.number}`);
  const out = await payInvoice(ctx, { businessId: args.businessId, invoiceId: inv.id, pay: args.pay, actor: args.actor });
  return { ...out, visit: closed };
}

/** Everything the board shows for one local day. */
export async function board(ctx: AppContext, businessId: string, dateKeyArg?: string) {
  const b = await loadBusiness(ctx.db, businessId);
  const now = ctx.now();
  const day = dateKeyArg ?? localDateKey(now, b.timezone);
  const open = await ctx.db.select().from(visits).where(and(eq(visits.businessId, businessId), isNull(visits.checkedOutAt)));
  const expected = await ctx.db
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.businessId, businessId),
        inArray(bookings.status, ['requested', 'confirmed', 'waitlist']),
        or(eq(bookings.date, day), eq(bookings.arrive, day)),
      ),
    );
  const departing = await ctx.db
    .select()
    .from(bookings)
    .where(and(eq(bookings.businessId, businessId), eq(bookings.status, 'checked_in'), eq(bookings.depart, day)));
  const dogIds = [...new Set([...open.map((v) => v.dogId), ...expected.map((x) => x.dogId)])];
  const summaries = new Map((await dogSummaries(ctx.db, businessId, dogIds, now)).map((d) => [d.id, d]));
  const yardList = await ctx.db.select().from(yards).where(eq(yards.businessId, businessId));
  const kennelList = await ctx.db.select().from(kennels).where(eq(kennels.businessId, businessId));
  const dayStart = dateKeyToInstant(day, b.timezone);
  const tasks = await ctx.db
    .select()
    .from(careTasks)
    .where(and(eq(careTasks.businessId, businessId), gte(careTasks.dueAt, new Date(dayStart)), lte(careTasks.dueAt, new Date(dayStart + 86_400_000))));

  const inBuilding = await Promise.all(
    open.map(async (v) => {
      const bill = await previewBill(ctx, businessId, v.id);
      const close = atLocalTime(now, b.timezone, b.hours.closesAt);
      const late = v.service === 'daycare' && now > close;
      return {
        visit: v,
        dog: summaries.get(v.dogId),
        runningTotalCents: bill.total,
        late,
        goesHomeToday: v.service === 'boarding' && v.departDate === day,
        yard: yardList.find((y) => y.id === v.yardId)?.name ?? null,
        kennel: kennelList.find((k) => k.id === v.kennelId)?.name ?? null,
      };
    }),
  );
  return {
    date: day,
    now,
    capacity: b.daycareCapacity,
    daycareBooked: await daycareCount(ctx.db, businessId, day),
    inBuilding,
    expected: expected.map((x) => ({ booking: x, dog: summaries.get(x.dogId) })),
    departing,
    yards: yardList.map((y) => ({ ...y, count: open.filter((v) => v.yardId === y.id).length })),
    kennels: kennelList.map((k) => ({ ...k, occupiedBy: open.find((v) => v.kennelId === k.id)?.dogId ?? null })),
    tasks,
  };
}

export async function listBookings(db: Database, businessId: string, from: string, to: string, dogIds?: readonly string[]) {
  return db
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.businessId, businessId),
        notInArray(bookings.status, ['declined']),
        or(and(gte(bookings.date, from), lte(bookings.date, to)), and(lte(bookings.arrive, to), gte(bookings.depart, from))),
        ...(dogIds ? [inArray(bookings.dogId, dogIds.length ? [...dogIds] : ['00000000-0000-0000-0000-000000000000'])] : []),
      ),
    )
    .orderBy(bookings.date, bookings.arrive);
}
