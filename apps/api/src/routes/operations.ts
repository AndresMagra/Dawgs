/**
 * Staff routes for the day's work: bookings, the board, check-in/out, care
 * tasks, and the manager's "haven't seen them" list.
 */

import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import { addLocalDays, inactiveDogs, localDateKey, dateKeyToInstant } from '@dawgs/core';
import { bookings, careTasks, dogs, visits } from '@dawgs/db';
import type { AppContext } from '../context.js';
import { requireManager, requireStaff, sameBusiness } from '../auth.js';
import { dateKey, hhmm, parse, payShape, uuid } from '../util.js';
import {
  availability,
  board,
  checkIn,
  checkOut,
  createBooking,
  listBookings,
  loadBusiness,
  moveVisit,
  previewBill,
  setBookingStatus,
} from '../ops.js';
import { dogSummaries } from '../people.js';
import { notifyPickup } from '../authorized.js';
import { addOnRequestShape, addOnsForBookings, addToBooking, cancelBookingAddOn, runSheet, setAddOnStatus } from '../addons.js';

export const bookingShape = z.discriminatedUnion('service', [
  z.object({
    dogId: uuid,
    service: z.literal('daycare'),
    plan: z.enum(['half', 'full', 'hourly']),
    date: dateKey,
    pickupTime: hhmm.nullable().optional(),
    notes: z.string().nullable().optional(),
    addOns: z.array(addOnRequestShape).max(10).optional(),
  }),
  z.object({
    dogId: uuid,
    service: z.literal('boarding'),
    arrive: dateKey,
    depart: dateKey,
    kennelId: uuid.nullable().optional(),
    kennelType: z.enum(['suite', 'run']).nullable().optional(),
    play: z.boolean().optional(),
    notes: z.string().nullable().optional(),
    addOns: z.array(addOnRequestShape).max(10).optional(),
  }),
]);

export const availabilityShape = z.union([
  z.object({ service: z.literal('daycare'), date: dateKey }),
  z.object({ service: z.literal('boarding'), arrive: dateKey, depart: dateKey }),
]);

export function registerOperationsRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/availability', async (req) => {
    const a = requireStaff(req);
    return availability(ctx.db, a.businessId, parse(availabilityShape, req.query));
  });

  app.get('/bookings', async (req) => {
    const a = requireStaff(req);
    const b = await loadBusiness(ctx.db, a.businessId);
    const today = localDateKey(ctx.now(), b.timezone);
    const q = parse(z.object({ from: dateKey.optional(), to: dateKey.optional() }), req.query);
    const from = q.from ?? today;
    const to = q.to ?? addLocalDays(from, 13);
    const rows = await listBookings(ctx.db, a.businessId, from, to);
    const summaries = await dogSummaries(ctx.db, a.businessId, [...new Set(rows.map((r) => r.dogId))], ctx.now());
    const byId = new Map(summaries.map((s) => [s.id, s]));
    const extras = await addOnsForBookings(ctx, rows.map((r) => r.id));
    return { from, to, bookings: rows.map((r) => ({ ...r, dog: byId.get(r.dogId), addOns: extras.get(r.id) ?? [] })) };
  });

  app.post('/bookings', async (req) => {
    const a = requireStaff(req);
    return createBooking(ctx, { businessId: a.businessId, input: parse(bookingShape, req.body), source: 'staff', actor: a.name });
  });

  app.post('/bookings/:id/status', async (req) => {
    const a = requireStaff(req);
    const { id } = req.params as { id: string };
    const { status } = parse(z.object({ status: z.enum(['confirmed', 'declined', 'cancelled', 'no_show']) }), req.body);
    return setBookingStatus(ctx, { businessId: a.businessId, bookingId: id, status, actor: a.name });
  });

  app.post('/bookings/:id/add-ons', async (req) => {
    const a = requireStaff(req);
    const { id } = req.params as { id: string };
    return addToBooking(ctx, { businessId: a.businessId, bookingId: id, request: parse(addOnRequestShape, req.body), source: 'staff', actor: a.name });
  });
  app.delete('/booking-add-ons/:id', async (req) => {
    const a = requireStaff(req);
    return cancelBookingAddOn(ctx, { businessId: a.businessId, id: (req.params as { id: string }).id, actor: a.name });
  });
  app.post('/booking-add-ons/:id/status', async (req) => {
    const a = requireStaff(req);
    const { status } = parse(z.object({ status: z.enum(['scheduled', 'on_way', 'done']) }), req.body);
    return setAddOnStatus(ctx, { businessId: a.businessId, id: (req.params as { id: string }).id, status, actor: a.name });
  });
  /** Today's pickups, drop-offs and booked extras. */
  app.get('/run-sheet', async (req) => {
    const a = requireStaff(req);
    const b = await loadBusiness(ctx.db, a.businessId);
    const { date } = parse(z.object({ date: dateKey.optional() }), req.query);
    return runSheet(ctx, a.businessId, date ?? localDateKey(ctx.now(), b.timezone));
  });

  app.get('/board', async (req) => {
    const a = requireStaff(req);
    const { date } = parse(z.object({ date: dateKey.optional() }), req.query);
    return board(ctx, a.businessId, date);
  });

  app.post('/visits', async (req) => {
    const a = requireStaff(req);
    const b = parse(
      z.object({
        bookingId: uuid.nullable().optional(),
        dogId: uuid.nullable().optional(),
        service: z.enum(['daycare', 'boarding']).optional(),
        plan: z.enum(['half', 'full', 'hourly']).optional(),
        yardId: uuid.nullable().optional(),
        pickupTime: hhmm.nullable().optional(),
        kennelId: uuid.nullable().optional(),
        departDate: dateKey.nullable().optional(),
        play: z.boolean().optional(),
      }),
      req.body,
    );
    return checkIn(ctx, { ...b, businessId: a.businessId, actor: a.name } as Parameters<typeof checkIn>[1]);
  });

  app.patch('/visits/:id', async (req) => {
    const a = requireStaff(req);
    const { id } = req.params as { id: string };
    const b = parse(z.object({ yardId: uuid.nullable().optional(), pickupTime: hhmm.nullable().optional() }), req.body);
    return moveVisit(ctx, { businessId: a.businessId, visitId: id, actor: a.name, ...b } as Parameters<typeof moveVisit>[1]);
  });

  app.get('/visits/:id/bill', async (req) => {
    const a = requireStaff(req);
    const { id } = req.params as { id: string };
    const { addOns } = parse(z.object({ addOns: z.string().optional() }), req.query);
    return previewBill(ctx, a.businessId, id, addOns ? addOns.split(',').filter(Boolean) : []);
  });

  app.post('/visits/:id/checkout', async (req) => {
    const a = requireStaff(req);
    const { id } = req.params as { id: string };
    const b = parse(z.object({ addOns: z.array(z.string()).optional(), pay: payShape, pickedUpBy: z.string().min(1).max(120).optional() }), req.body);
    const out = await checkOut(ctx, { businessId: a.businessId, visitId: id, pay: b.pay, actor: a.name, ...(b.addOns ? { addOns: b.addOns } : {}), ...(b.pickedUpBy ? { pickedUpBy: b.pickedUpBy } : {}) });
    if (b.pickedUpBy) await notifyPickup(ctx, id, b.pickedUpBy);
    return out;
  });

  app.get('/visits', async (req) => {
    const a = requireStaff(req);
    const q = parse(z.object({ from: dateKey, to: dateKey }), req.query);
    const b = await loadBusiness(ctx.db, a.businessId);
    return ctx.db
      .select()
      .from(visits)
      .where(
        and(
          eq(visits.businessId, a.businessId),
          gte(visits.checkedInAt, new Date(dateKeyToInstant(q.from, b.timezone))),
          lte(visits.checkedInAt, new Date(dateKeyToInstant(addLocalDays(q.to, 1), b.timezone))),
        ),
      )
      .orderBy(desc(visits.checkedInAt));
  });

  // ─── Care tasks ──────────────────────────────────────────────────────────
  app.post('/tasks', async (req) => {
    const a = requireStaff(req);
    const b = parse(
      z.object({ dogId: uuid, kind: z.enum(['feeding', 'meds', 'potty', 'other']), title: z.string().min(1), dueAt: z.number().int() }),
      req.body,
    );
    const [d] = await ctx.db.select().from(dogs).where(eq(dogs.id, b.dogId));
    sameBusiness(a, d, 'dog');
    const [t] = await ctx.db
      .insert(careTasks)
      .values({ businessId: a.businessId, dogId: b.dogId, kind: b.kind, title: b.title, dueAt: new Date(b.dueAt) })
      .returning();
    return t;
  });

  app.post('/tasks/:id/done', async (req) => {
    const a = requireStaff(req);
    const { id } = req.params as { id: string };
    const { done } = parse(z.object({ done: z.boolean().default(true) }), req.body);
    const [t] = await ctx.db.select().from(careTasks).where(eq(careTasks.id, id));
    sameBusiness(a, t, 'task');
    const [out] = await ctx.db
      .update(careTasks)
      .set(done ? { doneAt: new Date(ctx.now()), doneBy: a.name } : { doneAt: null, doneBy: null })
      .where(eq(careTasks.id, id))
      .returning();
    return out;
  });

  // ─── Reminders (managers only) ───────────────────────────────────────────
  app.get('/reminders/inactive', async (req) => {
    const a = requireManager(req);
    const b = await loadBusiness(ctx.db, a.businessId);
    const all = await dogSummaries(ctx.db, a.businessId, null, ctx.now());
    const upcoming = new Set(
      (await ctx.db.select({ dogId: bookings.dogId }).from(bookings).where(and(eq(bookings.businessId, a.businessId), eq(bookings.status, 'confirmed')))).map(
        (x) => x.dogId,
      ),
    );
    const list = inactiveDogs(
      all.filter((d) => d.active && !upcoming.has(d.id)).map((d) => ({ dogId: d.id, visits: d.visitCount, lastVisitAt: d.lastVisitAt })),
      ctx.now(),
      b.inactiveAfterDays,
    );
    const byId = new Map(all.map((d) => [d.id, d]));
    return list.map((x) => ({ ...x, dog: byId.get(x.dogId) }));
  });
}
