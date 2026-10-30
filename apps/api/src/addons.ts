/**
 * Add-ons booked with a stay: extras like a bath or a nail trim, and transport
 * (pickup from home, drop-off home). Each daycare defines its own in Settings;
 * booked ones are billed at check-out and show on the day's run sheet.
 */

import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';
import { ConflictError, NotFoundError, ValidationError, nightsOf } from '@dawgs/core';
import { addOns, bookingAddOns, bookings, dogs, owners } from '@dawgs/db';
import type { AppContext } from './context.js';
import { audit } from './audit.js';
import { pushToOwner } from './texts.js';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const addOnRequestShape = z.object({
  addOnId: z.string().uuid(),
  quantity: z.number().int().min(1).max(20).optional(),
  time: hhmm.nullable().optional(),
  address: z.string().max(300).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});
export type AddOnRequest = z.infer<typeof addOnRequestShape>;

export const addOnSettingsShape = z.object({
  name: z.string().min(1).max(80),
  code: z.string().min(1).max(40).optional(),
  description: z.string().max(500).nullable().optional(),
  kind: z.enum(['extra', 'pickup', 'dropoff']).optional(),
  category: z.string().max(40).nullable().optional(),
  priceCents: z.number().int().min(0).max(10_000_00),
  pricing: z.enum(['flat', 'per_day']).optional(),
  durationMinutes: z.number().int().min(1).max(24 * 60).nullable().optional(),
  services: z.array(z.enum(['daycare', 'boarding'])).min(1).optional(),
  ownerBookable: z.boolean().optional(),
  needsTime: z.boolean().optional(),
  dailyLimit: z.number().int().min(1).max(1000).nullable().optional(),
  sort: z.number().int().optional(),
  active: z.boolean().optional(),
});

type Booking = typeof bookings.$inferSelect;
type Stay = Pick<Booking, 'service' | 'date' | 'arrive' | 'depart' | 'dogId'>;

export function slugCode(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'extra';
}

/** The day an add-on happens: a drop-off on the way home, everything else on arrival. */
function dayFor(kind: 'extra' | 'pickup' | 'dropoff', stay: Stay) {
  if (stay.service === 'daycare') return stay.date!;
  return kind === 'dropoff' ? stay.depart! : stay.arrive!;
}

/**
 * Check every requested add-on against its settings and the day's limit, and
 * return the rows to insert. Runs before the booking is written so a bad
 * request leaves nothing half-made.
 */
export async function planAddOns(
  ctx: AppContext,
  args: { businessId: string; stay: Stay; requests: readonly AddOnRequest[]; source: 'staff' | 'owner'; actor: string; ignoreBookingId?: string },
) {
  if (!args.requests.length) return [];
  const ids = [...new Set(args.requests.map((r) => r.addOnId))];
  const defs = await ctx.db.select().from(addOns).where(and(eq(addOns.businessId, args.businessId), inArray(addOns.id, ids)));
  const [dog] = await ctx.db.select().from(dogs).where(eq(dogs.id, args.stay.dogId));
  const [owner] = dog ? await ctx.db.select().from(owners).where(eq(owners.id, dog.ownerId)) : [];
  const out: (typeof bookingAddOns.$inferInsert)[] = [];
  const kinds = new Set<string>();
  for (const r of args.requests) {
    const d = defs.find((x) => x.id === r.addOnId);
    if (!d || !d.active) throw new NotFoundError('add-on');
    if (args.source === 'owner' && !d.ownerBookable) throw new ValidationError(`${d.name} is booked through the front desk`);
    if (!d.services.includes(args.stay.service)) throw new ValidationError(`${d.name} isn't offered with ${args.stay.service}`);
    if (d.kind !== 'extra') {
      if (kinds.has(d.kind)) throw new ValidationError(`only one ${d.kind === 'pickup' ? 'pickup' : 'drop-off'} per booking`);
      kinds.add(d.kind);
    }
    const transport = d.kind !== 'extra';
    if ((transport || d.needsTime) && !r.time) throw new ValidationError(`pick a time for ${d.name}`);
    const address = transport ? r.address?.trim() || owner?.address?.trim() || null : null;
    if (transport && !address) throw new ValidationError(`add the address for ${d.name}`);
    const date = dayFor(d.kind, args.stay);
    if (d.dailyLimit) {
      const taken = await ctx.db
        .select({ id: bookingAddOns.id, bookingId: bookingAddOns.bookingId })
        .from(bookingAddOns)
        .innerJoin(bookings, eq(bookings.id, bookingAddOns.bookingId))
        .where(
          and(
            eq(bookingAddOns.addOnId, d.id),
            eq(bookingAddOns.date, date),
            ne(bookingAddOns.status, 'cancelled'),
            inArray(bookings.status, ['requested', 'confirmed', 'waitlist', 'checked_in', 'checked_out']),
          ),
        );
      const count = taken.filter((t) => t.bookingId !== args.ignoreBookingId).length + out.filter((o) => o.addOnId === d.id).length;
      if (count >= d.dailyLimit) throw new ConflictError(`${d.name} is fully booked that day`);
    }
    const quantity =
      d.pricing === 'per_day' ? (args.stay.service === 'boarding' ? Math.max(1, nightsOf({ arrive: args.stay.arrive!, depart: args.stay.depart! })) : 1) : (r.quantity ?? 1);
    out.push({
      businessId: args.businessId,
      bookingId: '',
      addOnId: d.id,
      kind: d.kind,
      name: d.name,
      code: d.code,
      unitCents: d.priceCents,
      quantity,
      date,
      time: r.time ?? null,
      address,
      notes: r.notes?.trim() || null,
      createdBy: args.actor,
    });
  }
  return out;
}

export async function insertPlanned(ctx: AppContext, bookingId: string, rows: (typeof bookingAddOns.$inferInsert)[]) {
  if (!rows.length) return [];
  return ctx.db
    .insert(bookingAddOns)
    .values(rows.map((r) => ({ ...r, bookingId })))
    .returning();
}

export async function addOnsForBookings(ctx: AppContext, bookingIds: readonly string[]) {
  if (!bookingIds.length) return new Map<string, (typeof bookingAddOns.$inferSelect)[]>();
  const rows = await ctx.db
    .select()
    .from(bookingAddOns)
    .where(and(inArray(bookingAddOns.bookingId, [...bookingIds]), ne(bookingAddOns.status, 'cancelled')))
    .orderBy(asc(bookingAddOns.createdAt));
  const m = new Map<string, typeof rows>();
  for (const r of rows) m.set(r.bookingId, [...(m.get(r.bookingId) ?? []), r]);
  return m;
}

async function loadBooking(ctx: AppContext, businessId: string, id: string) {
  const [bk] = await ctx.db.select().from(bookings).where(eq(bookings.id, id));
  if (!bk || bk.businessId !== businessId) throw new NotFoundError('booking');
  return bk;
}

/** Add to a booking that already exists, until the dog has gone home. */
export async function addToBooking(ctx: AppContext, args: { businessId: string; bookingId: string; request: AddOnRequest; source: 'staff' | 'owner'; actor: string }) {
  const bk = await loadBooking(ctx, args.businessId, args.bookingId);
  if (['checked_out', 'cancelled', 'declined', 'no_show'].includes(bk.status)) throw new ValidationError('this booking is closed');
  const existing = (await addOnsForBookings(ctx, [bk.id])).get(bk.id) ?? [];
  const def = (await ctx.db.select({ kind: addOns.kind }).from(addOns).where(eq(addOns.id, args.request.addOnId)))[0];
  if (def && def.kind !== 'extra' && existing.some((e) => e.kind === def.kind)) throw new ValidationError(`this booking already has a ${def.kind === 'pickup' ? 'pickup' : 'drop-off'}`);
  const rows = await planAddOns(ctx, { businessId: args.businessId, stay: bk, requests: [args.request], source: args.source, actor: args.actor, ignoreBookingId: bk.id });
  const [row] = await insertPlanned(ctx, bk.id, rows);
  await audit(ctx.db, args.businessId, args.actor, 'booking.addon', `Added ${row!.name} to booking ${bk.date ?? bk.arrive}`);
  return row!;
}

export async function cancelBookingAddOn(ctx: AppContext, args: { businessId: string; id: string; actor: string; ownerId?: string }) {
  const [r] = await ctx.db.select().from(bookingAddOns).where(eq(bookingAddOns.id, args.id));
  if (!r || r.businessId !== args.businessId) throw new NotFoundError('add-on');
  if (args.ownerId) {
    const [bk] = await ctx.db.select({ dogId: bookings.dogId }).from(bookings).where(eq(bookings.id, r.bookingId));
    const [d] = await ctx.db.select({ ownerId: dogs.ownerId }).from(dogs).where(eq(dogs.id, bk!.dogId));
    if (d?.ownerId !== args.ownerId) throw new NotFoundError('add-on');
  }
  if (r.status !== 'scheduled') throw new ValidationError(r.status === 'cancelled' ? 'already cancelled' : 'it has already started');
  await ctx.db.update(bookingAddOns).set({ status: 'cancelled' }).where(eq(bookingAddOns.id, r.id));
  await audit(ctx.db, args.businessId, args.actor, 'booking.addon.cancel', `Cancelled ${r.name} on ${r.date}`);
  return { ok: true };
}

/** The day's run sheet: transport in time order, then the other services. */
export async function runSheet(ctx: AppContext, businessId: string, date: string) {
  const rows = await ctx.db
    .select({ a: bookingAddOns, dog: dogs.name, dogId: dogs.id, owner: owners.name, phone: owners.phone, bookingStatus: bookings.status })
    .from(bookingAddOns)
    .innerJoin(bookings, eq(bookings.id, bookingAddOns.bookingId))
    .innerJoin(dogs, eq(dogs.id, bookings.dogId))
    .innerJoin(owners, eq(owners.id, dogs.ownerId))
    .where(
      and(
        eq(bookingAddOns.businessId, businessId),
        eq(bookingAddOns.date, date),
        ne(bookingAddOns.status, 'cancelled'),
        inArray(bookings.status, ['requested', 'confirmed', 'checked_in', 'checked_out']),
      ),
    );
  const items = rows
    .map((r) => ({ ...r.a, dog: r.dog, dogId: r.dogId, owner: r.owner, phone: r.phone, bookingStatus: r.bookingStatus }))
    .sort((x, y) => (x.time ?? '99').localeCompare(y.time ?? '99') || x.dog.localeCompare(y.dog));
  return { date, transport: items.filter((i) => i.kind !== 'extra'), services: items.filter((i) => i.kind === 'extra') };
}

/** Staff move an add-on along; owners hear when the van is on its way and when their dog is home. */
export async function setAddOnStatus(ctx: AppContext, args: { businessId: string; id: string; status: 'scheduled' | 'on_way' | 'done'; actor: string }) {
  const [r] = await ctx.db.select().from(bookingAddOns).where(eq(bookingAddOns.id, args.id));
  if (!r || r.businessId !== args.businessId) throw new NotFoundError('add-on');
  if (r.status === 'cancelled') throw new ValidationError('this add-on was cancelled');
  if (args.status === 'on_way' && r.kind === 'extra') throw new ValidationError('only transport goes on the way');
  const done = args.status === 'done';
  await ctx.db
    .update(bookingAddOns)
    .set({ status: args.status, doneBy: done ? args.actor : null, doneAt: done ? new Date(ctx.now()) : null })
    .where(eq(bookingAddOns.id, r.id));
  if (r.kind !== 'extra' && args.status !== 'scheduled' && args.status !== r.status) {
    const [bk] = await ctx.db.select({ dogId: bookings.dogId }).from(bookings).where(eq(bookings.id, r.bookingId));
    const [d] = await ctx.db.select().from(dogs).where(eq(dogs.id, bk!.dogId));
    const first = args.actor.split(' ')[0];
    const msg =
      r.kind === 'pickup'
        ? args.status === 'on_way'
          ? [`On the way for ${d!.name}`, `${first} is heading to you to pick up ${d!.name}.`]
          : [`${d!.name} is on board`, `${first} picked up ${d!.name}. See you at the daycare!`]
        : args.status === 'on_way'
          ? [`${d!.name} is on the way home`, `${first} is bringing ${d!.name} home now.`]
          : [`${d!.name} is home`, `${first} dropped ${d!.name} off at home.`];
    await pushToOwner(ctx, d!.ownerId, msg[0]!, msg[1]!, { dogId: d!.id });
  }
  return { ok: true };
}
