/**
 * Staff routes for the day's work: bookings, the board, check-in/out, care
 * tasks, and the manager's "haven't seen them" list.
 */

import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import { ValidationError, addLocalDays, inactiveDogs, localDateKey, dateKeyToInstant, tipOptions, withPolicyDefaults, type Extras } from '@dawgs/core';
import { bookings, careTasks, dogs, visits } from '@dawgs/db';
import type { AppContext } from '../context.js';
import { requireManager, requirePermission, requireStaff, sameBusiness } from '../auth.js';
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
import { maybeAskForReview, reportCards, sendReportCards } from '../messaging.js';
import { createSeries, listSeries, seriesShape, stopSeries } from '../recurring.js';
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
    const { status, waiveFee } = parse(z.object({ status: z.enum(['confirmed', 'declined', 'cancelled', 'no_show']), waiveFee: z.boolean().optional() }), req.body);
    if (waiveFee) requireManager(req);
    return setBookingStatus(ctx, { businessId: a.businessId, bookingId: id, status, actor: a.name, ...(waiveFee ? { waiveFee } : {}) });
  });

  app.get('/booking-series', async (req) => listSeries(ctx, requireStaff(req).businessId));
  app.post('/booking-series', async (req) => {
    const a = requireStaff(req);
    return createSeries(ctx, { businessId: a.businessId, input: parse(seriesShape, req.body), source: 'staff', actor: a.name });
  });
  app.post('/booking-series/:id/stop', async (req) => {
    const a = requireStaff(req);
    const b = parse(z.object({ from: dateKey, waiveFee: z.boolean().optional() }), req.body);
    if (b.waiveFee) requireManager(req);
    return stopSeries(ctx, { businessId: a.businessId, seriesId: (req.params as { id: string }).id, from: b.from, actor: a.name, ...(b.waiveFee ? { waiveFee: true } : {}) });
  });

  app.get('/report-cards', async (req) => {
    const a = requireStaff(req);
    const { date } = parse(z.object({ date: dateKey.optional() }), req.query);
    return reportCards(ctx, a.businessId, date);
  });
  app.post('/report-cards/send', async (req) => {
    const a = requireStaff(req);
    const { ids } = parse(z.object({ ids: z.array(uuid).min(1).max(200) }), req.body);
    return sendReportCards(ctx, { businessId: a.businessId, ids, actor: a.name });
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

  // A discount needs a reason and a manager (or allowed staff); tips are anyone's to take.
  const extrasShape = z.object({
    discountCents: z.coerce.number().int().min(1).optional(),
    discountPercent: z.coerce.number().min(1).max(100).optional(),
    discountReason: z.string().min(1).max(120).optional(),
    tipCents: z.coerce.number().int().min(0).max(100_000).optional(),
  });
  const toExtras = async (req: Parameters<typeof requireStaff>[0], e: z.infer<typeof extrasShape>): Promise<Extras> => {
    const discount = e.discountCents || e.discountPercent;
    if (discount) {
      await requirePermission(ctx, req, 'discount');
      if (!e.discountReason?.trim()) throw new ValidationError('say why the discount is given');
    }
    return {
      ...(discount ? { discount: { ...(e.discountCents ? { cents: e.discountCents } : { percent: e.discountPercent! }), reason: e.discountReason!.trim() } } : {}),
      ...(e.tipCents ? { tipCents: e.tipCents } : {}),
    };
  };

  app.get('/visits/:id/bill', async (req) => {
    const a = requireStaff(req);
    const { id } = req.params as { id: string };
    const q = parse(extrasShape.extend({ addOns: z.string().optional() }), req.query);
    const bill = await previewBill(ctx, a.businessId, id, q.addOns ? q.addOns.split(',').filter(Boolean) : [], await toExtras(req, q));
    const b = await loadBusiness(ctx.db, a.businessId);
    return { ...bill, tipOptions: tipOptions(bill, withPolicyDefaults(b.policies)) };
  });

  app.post('/visits/:id/checkout', async (req) => {
    const a = requireStaff(req);
    const { id } = req.params as { id: string };
    const b = parse(extrasShape.extend({ addOns: z.array(z.string()).optional(), pay: payShape, pickedUpBy: z.string().min(1).max(120).optional() }), req.body);
    const out = await checkOut(ctx, {
      businessId: a.businessId,
      visitId: id,
      pay: b.pay,
      actor: a.name,
      extras: await toExtras(req, b),
      ...(b.addOns ? { addOns: b.addOns } : {}),
      ...(b.pickedUpBy ? { pickedUpBy: b.pickedUpBy } : {}),
    });
    if (b.pickedUpBy) await notifyPickup(ctx, id, b.pickedUpBy);
    // A thank-you and review link must never get in the way of the check-out itself.
    await maybeAskForReview(ctx, a.businessId, out.invoice.ownerId).catch(() => undefined);
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
