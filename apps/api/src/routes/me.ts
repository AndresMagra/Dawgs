/**
 * The customer app: everything a pet owner can see and do.
 *
 * Every route here is confined to the signed-in owner by `requireOwner` and
 * the `myDog` check, so an owner can only ever reach their own dogs, cards,
 * invoices and walks however they shape a request.
 */

import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, gte, inArray, lt, ne, or } from 'drizzle-orm';
import { z } from 'zod';
import { NotFoundError, ValidationError, addLocalDays, lateCancelFee, localDateKey, withPolicyDefaults } from '@dawgs/core';
import {
  addOns,
  bookings,
  dogs,
  invoices,
  memberships,
  owners,
  packages,
  payments,
  trainingEnrollments,
  trainingPrograms,
  trainingSessions,
  vaccines,
  visitNotes,
  walkTypes,
  walks,
  waiverSignatures,
  waivers,
} from '@dawgs/db';
import type { AppContext } from '../context.js';
import { peopleFor } from '../authorized.js';
import { requireOwner } from '../auth.js';
import { dateKey, parse, payShape, uuid } from '../util.js';
import { dogSummaries, ownerCards } from '../people.js';
import { ensureStripeCustomer, payInvoice, recordIntentSucceeded, removeCard, saveCard, setDefaultCard, paidSoFar } from '../payments.js';
import { availability, createBooking, listBookings, loadBusiness, setBookingStatus } from '../ops.js';
import { cancelMembership, sellPackage } from '../sales.js';
import { scheduleWalk, walkTrack } from '../walks.js';
import { bookPrivate, enroll, enrolledCount, progressFor } from '../training.js';
import { availabilityShape, bookingShape } from './operations.js';
import { dogShape, ownerShape, resolveNewCard, vaccineShape } from './people.js';
import { signWaiver } from './manage.js';
import { audit } from '../audit.js';
import { createSeries, listSeries, seriesShape, stopSeries } from '../recurring.js';
import { addOnRequestShape, addOnsForBookings, addToBooking, cancelBookingAddOn } from '../addons.js';

export function registerMeRoutes(app: FastifyInstance, ctx: AppContext) {
  async function myDog(ownerId: string, dogId: string) {
    const [d] = await ctx.db.select().from(dogs).where(eq(dogs.id, dogId));
    if (!d || d.ownerId !== ownerId) throw new NotFoundError('dog');
    return d;
  }
  async function myDogIds(ownerId: string) {
    return (await ctx.db.select({ id: dogs.id }).from(dogs).where(eq(dogs.ownerId, ownerId))).map((d) => d.id);
  }

  async function myForms(businessId: string, ownerId: string) {
    const forms = await ctx.db.select().from(waivers).where(and(eq(waivers.businessId, businessId), eq(waivers.active, true)));
    const sigs = await ctx.db.select().from(waiverSignatures).where(eq(waiverSignatures.ownerId, ownerId));
    const ds = await ctx.db.select({ id: dogs.id, name: dogs.name }).from(dogs).where(and(eq(dogs.ownerId, ownerId), eq(dogs.active, true)));
    return forms.flatMap((f) => {
      const targets = f.scope === 'owner' ? [null] : ds;
      return targets.map((d) => {
        const sig = sigs
          .filter((s) => s.waiverId === f.id && (s.dogId ?? null) === (d?.id ?? null))
          .sort((x, y) => y.signedAt.getTime() - x.signedAt.getTime())[0];
        return {
          waiverId: f.id,
          title: f.title,
          version: f.version,
          required: f.required,
          dog: d,
          signedAt: sig?.signedAt ?? null,
          signedVersion: sig?.version ?? null,
          needsSignature: !sig || sig.version !== f.version,
        };
      });
    });
  }

  // ─── Profile ─────────────────────────────────────────────────────────────
  app.get('/me', async (req) => {
    const a = requireOwner(req);
    const [o] = await ctx.db.select().from(owners).where(eq(owners.id, a.ownerId));
    const ids = await myDogIds(a.ownerId);
    const forms = await myForms(a.businessId, a.ownerId);
    return {
      owner: o,
      dogs: await dogSummaries(ctx.db, a.businessId, ids, ctx.now()),
      cards: await ownerCards(ctx.db, a.ownerId),
      people: await peopleFor(ctx, a.ownerId),
      forms,
      formsToSign: forms.filter((f) => f.required && f.needsSignature).length,
    };
  });

  app.patch('/me', async (req) => {
    const a = requireOwner(req);
    const b = parse(ownerShape.omit({ notes: true }).partial(), req.body);
    const set = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined));
    const [o] = await ctx.db.update(owners).set(set).where(eq(owners.id, a.ownerId)).returning();
    return o;
  });

  // ─── Dogs ────────────────────────────────────────────────────────────────
  app.post('/me/dogs', async (req) => {
    const a = requireOwner(req);
    const b = parse(dogShape.omit({ defaultYardId: true, active: true }), req.body);
    const clean = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined));
    const [d] = await ctx.db.insert(dogs).values({ ...clean, name: b.name, ownerId: a.ownerId, businessId: a.businessId }).returning();
    await audit(ctx.db, a.businessId, a.name, 'dog.create', `${d!.name} added by owner in the app`);
    return d;
  });

  app.patch('/me/dogs/:id', async (req) => {
    const a = requireOwner(req);
    const { id } = req.params as { id: string };
    await myDog(a.ownerId, id);
    const b = parse(dogShape.omit({ defaultYardId: true, active: true }).partial(), req.body);
    const set = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined));
    const [d] = await ctx.db.update(dogs).set(set).where(eq(dogs.id, id)).returning();
    return d;
  });

  app.get('/me/dogs/:id', async (req) => {
    const a = requireOwner(req);
    const { id } = req.params as { id: string };
    await myDog(a.ownerId, id);
    const [summary] = await dogSummaries(ctx.db, a.businessId, [id], ctx.now());
    return {
      dog: summary,
      vaccineRecords: await ctx.db.select().from(vaccines).where(eq(vaccines.dogId, id)).orderBy(desc(vaccines.expiresAt)),
      reportCards: await ctx.db
        .select()
        .from(visitNotes)
        .where(and(eq(visitNotes.dogId, id), eq(visitNotes.sharedWithOwner, true)))
        .orderBy(desc(visitNotes.createdAt))
        .limit(50),
      training: await progressFor(ctx, id, true),
    };
  });

  /** An owner's upload counts once staff have checked the certificate. */
  app.post('/me/dogs/:id/vaccines', { bodyLimit: 5_000_000 }, async (req) => {
    const a = requireOwner(req);
    const { id } = req.params as { id: string };
    const d = await myDog(a.ownerId, id);
    const b = parse(vaccineShape, req.body);
    const [v] = await ctx.db
      .insert(vaccines)
      .values({ businessId: a.businessId, dogId: id, name: b.name, expiresAt: new Date(`${b.expiresOn}T23:59:59Z`), documentUrl: b.documentUrl ?? null })
      .returning();
    await audit(ctx.db, a.businessId, a.name, 'vaccine.upload', `${d.name}: ${b.name} uploaded for review`);
    return v;
  });

  // ─── Cards ───────────────────────────────────────────────────────────────
  app.post('/me/cards/setup', async (req) => {
    const a = requireOwner(req);
    const customerId = await ensureStripeCustomer(ctx, a.ownerId);
    const gw = await ctx.gatewayFor(a.businessId);
    const si = await gw.createSetupIntent(customerId);
    return { ...si, customerId, mode: gw.mode, publishableKey: gw.publishableKey };
  });

  app.post('/me/cards', async (req) => {
    const a = requireOwner(req);
    const b = parse(z.object({ paymentMethodId: z.string().optional(), testCard: z.string().optional() }), req.body);
    const pm = await resolveNewCard(ctx, a.businessId, a.ownerId, b);
    return saveCard(ctx, a.businessId, a.ownerId, pm);
  });

  app.delete('/me/cards/:id', async (req) => {
    const a = requireOwner(req);
    await removeCard(ctx, a.ownerId, (req.params as { id: string }).id);
    return { ok: true };
  });

  app.post('/me/cards/:id/default', async (req) => {
    const a = requireOwner(req);
    await setDefaultCard(ctx, a.ownerId, (req.params as { id: string }).id);
    return { ok: true };
  });

  // ─── Waivers ─────────────────────────────────────────────────────────────
  app.get('/me/waivers', async (req) => {
    const a = requireOwner(req);
    return myForms(a.businessId, a.ownerId);
  });

  app.get('/me/waivers/:id', async (req) => {
    const a = requireOwner(req);
    const { id } = req.params as { id: string };
    const [w] = await ctx.db.select().from(waivers).where(eq(waivers.id, id));
    if (!w || w.businessId !== a.businessId || !w.active) throw new NotFoundError('form');
    const mine = await ctx.db
      .select()
      .from(waiverSignatures)
      .where(and(eq(waiverSignatures.waiverId, id), eq(waiverSignatures.ownerId, a.ownerId)))
      .orderBy(desc(waiverSignatures.signedAt));
    return { waiver: w, signatures: mine };
  });

  app.post('/me/waivers/:id/sign', async (req) => {
    const a = requireOwner(req);
    const b = parse(
      z.object({
        dogId: uuid.nullable().optional(),
        signedName: z.string().min(2),
        signatureImage: z.string().nullable().optional(),
        version: z.number().int(),
        agree: z.literal(true),
      }),
      req.body,
    );
    return signWaiver(ctx, {
      businessId: a.businessId,
      waiverId: (req.params as { id: string }).id,
      ownerId: a.ownerId,
      dogId: b.dogId ?? null,
      signedName: b.signedName,
      signatureImage: b.signatureImage ?? null,
      version: b.version,
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
      collectedBy: `${a.name} (customer app)`,
    });
  });

  // ─── Bookings ────────────────────────────────────────────────────────────
  app.get('/me/availability', async (req) => {
    const a = requireOwner(req);
    const r = await availability(ctx.db, a.businessId, parse(availabilityShape, req.query));
    // Owners see whether there is room, not the building's headcount.
    return r.service === 'daycare' ? { service: 'daycare', available: r.spotsLeft > 0 } : r;
  });

  app.get('/me/bookings', async (req) => {
    const a = requireOwner(req);
    const b = await loadBusiness(ctx.db, a.businessId);
    const today = localDateKey(ctx.now(), b.timezone);
    const q = parse(z.object({ from: dateKey.optional(), to: dateKey.optional() }), req.query);
    const rows = await listBookings(ctx.db, a.businessId, q.from ?? addLocalDays(today, -60), q.to ?? addLocalDays(today, 180), await myDogIds(a.ownerId));
    const extras = await addOnsForBookings(ctx, rows.map((r) => r.id));
    const policies = withPolicyDefaults(b.policies);
    return rows.map((r) => ({
      ...r,
      addOns: (extras.get(r.id) ?? []).map(({ doneBy: _by, createdBy: _cb, ...x }) => x),
      // So the app can warn before a cancel that costs money.
      cancelFeeCents: r.status === 'confirmed' ? lateCancelFee(policies, r.date ?? r.arrive!, b.timezone, ctx.now()) : 0,
    }));
  });

  /** What owners can add to a booking: only the add-ons the daycare lets them book. */
  app.get('/me/add-ons', async (req) => {
    const a = requireOwner(req);
    const rows = await ctx.db
      .select()
      .from(addOns)
      .where(and(eq(addOns.businessId, a.businessId), eq(addOns.active, true), eq(addOns.ownerBookable, true)))
      .orderBy(asc(addOns.sort), asc(addOns.name));
    const [me] = await ctx.db.select({ address: owners.address }).from(owners).where(eq(owners.id, a.ownerId));
    return { addOns: rows.map(({ businessId: _b, dailyLimit: _l, ownerBookable: _o, ...x }) => x), address: me?.address ?? null };
  });
  app.post('/me/bookings/:id/add-ons', async (req) => {
    const a = requireOwner(req);
    const { id } = req.params as { id: string };
    const [bk] = await ctx.db.select().from(bookings).where(eq(bookings.id, id));
    if (!bk) throw new NotFoundError('booking');
    await myDog(a.ownerId, bk.dogId);
    return addToBooking(ctx, { businessId: a.businessId, bookingId: id, request: parse(addOnRequestShape, req.body), source: 'owner', actor: `${a.name} (app)` });
  });
  app.delete('/me/booking-add-ons/:id', async (req) => {
    const a = requireOwner(req);
    return cancelBookingAddOn(ctx, { businessId: a.businessId, id: (req.params as { id: string }).id, actor: `${a.name} (app)`, ownerId: a.ownerId });
  });

  app.post('/me/bookings', async (req) => {
    const a = requireOwner(req);
    const input = parse(bookingShape, req.body);
    await myDog(a.ownerId, input.dogId);
    return createBooking(ctx, { businessId: a.businessId, input, source: 'owner', actor: `${a.name} (app)` });
  });

  app.get('/me/booking-series', async (req) => {
    const a = requireOwner(req);
    return listSeries(ctx, a.businessId, await myDogIds(a.ownerId));
  });
  app.post('/me/booking-series', async (req) => {
    const a = requireOwner(req);
    const input = parse(seriesShape, req.body);
    await myDog(a.ownerId, input.dogId);
    return createSeries(ctx, { businessId: a.businessId, input, source: 'owner', actor: `${a.name} (app)` });
  });
  app.post('/me/booking-series/:id/stop', async (req) => {
    const a = requireOwner(req);
    const { from } = parse(z.object({ from: dateKey }), req.body);
    return stopSeries(ctx, { businessId: a.businessId, seriesId: (req.params as { id: string }).id, from, actor: `${a.name} (app)`, ownerId: a.ownerId });
  });

  app.post('/me/bookings/:id/cancel', async (req) => {
    const a = requireOwner(req);
    const { id } = req.params as { id: string };
    const [bk] = await ctx.db.select().from(bookings).where(eq(bookings.id, id));
    if (!bk) throw new NotFoundError('booking');
    await myDog(a.ownerId, bk.dogId);
    return setBookingStatus(ctx, { businessId: a.businessId, bookingId: id, status: 'cancelled', actor: `${a.name} (app)` });
  });

  // ─── Money ───────────────────────────────────────────────────────────────
  app.get('/me/invoices', async (req) => {
    const a = requireOwner(req);
    return ctx.db.select().from(invoices).where(eq(invoices.ownerId, a.ownerId)).orderBy(desc(invoices.createdAt)).limit(100);
  });

  app.get('/me/invoices/:id', async (req) => {
    const a = requireOwner(req);
    const { id } = req.params as { id: string };
    const [inv] = await ctx.db.select().from(invoices).where(eq(invoices.id, id));
    if (!inv || inv.ownerId !== a.ownerId) throw new NotFoundError('invoice');
    const pays = await ctx.db.select().from(payments).where(and(eq(payments.invoiceId, id), eq(payments.status, 'succeeded')));
    return {
      invoice: inv,
      payments: pays.map((p) => ({ id: p.id, method: p.method, amountCents: p.amountCents, refundedCents: p.refundedCents, cardLabel: p.cardLabel, createdAt: p.createdAt })),
      dueCents: Math.max(0, inv.totalCents - (await paidSoFar(ctx.db, id))),
    };
  });

  app.post('/me/invoices/:id/pay', async (req) => {
    const a = requireOwner(req);
    const { id } = req.params as { id: string };
    const { paymentMethodId } = parse(z.object({ paymentMethodId: uuid.optional() }), req.body);
    const [inv] = await ctx.db.select().from(invoices).where(eq(invoices.id, id));
    if (!inv || inv.ownerId !== a.ownerId) throw new NotFoundError('invoice');
    return payInvoice(ctx, {
      businessId: a.businessId,
      invoiceId: id,
      pay: { method: 'card', ...(paymentMethodId ? { paymentMethodId } : {}) },
      actor: `${a.name} (app)`,
    });
  });

  /** After the app confirms a payment with Stripe's sheet, it asks the server to record it. */
  app.post('/me/payments/:intentId/confirm', async (req) => {
    const a = requireOwner(req);
    const { intentId } = req.params as { intentId: string };
    const r = await recordIntentSucceeded(ctx, a.businessId, intentId);
    return { recorded: r.recorded };
  });

  app.get('/me/packages', async (req) => {
    const a = requireOwner(req);
    return ctx.db
      .select()
      .from(packages)
      .where(and(eq(packages.businessId, a.businessId), eq(packages.active, true), eq(packages.sellOnline, true)))
      .orderBy(asc(packages.priceCents));
  });

  app.post('/me/packages/:id/buy', async (req) => {
    const a = requireOwner(req);
    const { id } = req.params as { id: string };
    const b = parse(z.object({ dogId: uuid, paymentMethodId: uuid.optional() }), req.body);
    await myDog(a.ownerId, b.dogId);
    const [p] = await ctx.db.select().from(packages).where(eq(packages.id, id));
    if (!p || p.businessId !== a.businessId || !p.sellOnline) throw new NotFoundError('package');
    return sellPackage(ctx, {
      businessId: a.businessId,
      dogId: b.dogId,
      packageId: id,
      pay: { method: 'card', ...(b.paymentMethodId ? { paymentMethodId: b.paymentMethodId } : {}) },
      actor: `${a.name} (app)`,
    });
  });

  app.get('/me/memberships', async (req) => {
    const a = requireOwner(req);
    const rows = await ctx.db
      .select({ m: memberships, pkg: packages })
      .from(memberships)
      .innerJoin(packages, eq(packages.id, memberships.packageId))
      .where(eq(memberships.ownerId, a.ownerId))
      .orderBy(desc(memberships.createdAt));
    return rows.map((r) => ({ ...r.m, packageName: r.pkg.name, priceCents: r.pkg.priceCents, credits: r.pkg.credits }));
  });

  app.post('/me/memberships/:id/cancel', async (req) => {
    const a = requireOwner(req);
    return cancelMembership(ctx, { businessId: a.businessId, membershipId: (req.params as { id: string }).id, actor: `${a.name} (app)`, ownerId: a.ownerId });
  });

  // ─── Walks ───────────────────────────────────────────────────────────────
  app.get('/me/walk-types', async (req) => {
    const a = requireOwner(req);
    return ctx.db.select().from(walkTypes).where(and(eq(walkTypes.businessId, a.businessId), eq(walkTypes.active, true)));
  });

  app.get('/me/walks', async (req) => {
    const a = requireOwner(req);
    const ids = await myDogIds(a.ownerId);
    if (!ids.length) return [];
    return ctx.db.select().from(walks).where(inArray(walks.dogId, ids)).orderBy(desc(walks.scheduledAt)).limit(100);
  });

  app.post('/me/walks', async (req) => {
    const a = requireOwner(req);
    const b = parse(z.object({ dogId: uuid, walkTypeId: uuid, scheduledAt: z.number().int() }), req.body);
    await myDog(a.ownerId, b.dogId);
    return scheduleWalk(ctx, { ...b, businessId: a.businessId, actor: `${a.name} (app)`, byOwner: true });
  });

  /** The live map polls this with `since` while the walk runs. */
  app.get('/me/walks/:id', async (req) => {
    const a = requireOwner(req);
    const { id } = req.params as { id: string };
    const { since } = parse(z.object({ since: z.coerce.number().int().optional() }), req.query);
    const [w] = await ctx.db.select().from(walks).where(eq(walks.id, id));
    if (!w) throw new NotFoundError('walk');
    await myDog(a.ownerId, w.dogId);
    return { walk: w, track: await walkTrack(ctx, id, since) };
  });

  app.post('/me/walks/:id/cancel', async (req) => {
    const a = requireOwner(req);
    const { id } = req.params as { id: string };
    const [w] = await ctx.db.select().from(walks).where(eq(walks.id, id));
    if (!w) throw new NotFoundError('walk');
    await myDog(a.ownerId, w.dogId);
    if (w.status !== 'requested' && w.status !== 'scheduled') throw new ValidationError('this walk has started');
    await ctx.db.update(walks).set({ status: 'cancelled' }).where(eq(walks.id, id));
    return { ok: true };
  });

  // ─── Training ────────────────────────────────────────────────────────────
  app.get('/me/training', async (req) => {
    const a = requireOwner(req);
    const programs = await ctx.db
      .select()
      .from(trainingPrograms)
      .where(and(eq(trainingPrograms.businessId, a.businessId), eq(trainingPrograms.active, true), eq(trainingPrograms.sellOnline, true)));
    const ids = await myDogIds(a.ownerId);
    const mine = ids.length
      ? await ctx.db.select().from(trainingEnrollments).where(and(inArray(trainingEnrollments.dogId, ids), ne(trainingEnrollments.status, 'dropped')))
      : [];
    const upcoming = await ctx.db
      .select()
      .from(trainingSessions)
      .where(
        and(
          eq(trainingSessions.businessId, a.businessId),
          gte(trainingSessions.startsAt, new Date(ctx.now() - 3_600_000)),
          ne(trainingSessions.status, 'cancelled'),
        ),
      )
      .orderBy(asc(trainingSessions.startsAt));
    return {
      programs: await Promise.all(
        programs.map(async (p) => ({
          ...p,
          spotsLeft: p.kind === 'class' ? Math.max(0, p.capacity - (await enrolledCount(ctx, p.id))) : null,
          nextSessions: upcoming.filter((s) => s.programId === p.id && !s.dogId).slice(0, 3),
        })),
      ),
      enrollments: mine,
      mySessions: upcoming.filter(
        (s) => (s.dogId && ids.includes(s.dogId)) || mine.some((e) => e.programId === s.programId && e.status === 'enrolled' && !s.dogId),
      ),
    };
  });

  app.post('/me/training/:id/enroll', async (req) => {
    const a = requireOwner(req);
    const b = parse(z.object({ dogId: uuid, paymentMethodId: uuid.optional() }), req.body);
    await myDog(a.ownerId, b.dogId);
    return enroll(ctx, {
      businessId: a.businessId,
      programId: (req.params as { id: string }).id,
      dogId: b.dogId,
      pay: { method: 'card', ...(b.paymentMethodId ? { paymentMethodId: b.paymentMethodId } : {}) },
      actor: `${a.name} (app)`,
    });
  });

  app.post('/me/training/:id/private', async (req) => {
    const a = requireOwner(req);
    const b = parse(z.object({ dogId: uuid, startsAt: z.number().int(), paymentMethodId: uuid.optional() }), req.body);
    await myDog(a.ownerId, b.dogId);
    return bookPrivate(ctx, {
      businessId: a.businessId,
      programId: (req.params as { id: string }).id,
      dogId: b.dogId,
      startsAt: b.startsAt,
      pay: { method: 'card', ...(b.paymentMethodId ? { paymentMethodId: b.paymentMethodId } : {}) },
      actor: `${a.name} (app)`,
    });
  });

  // ─── Calendar ────────────────────────────────────────────────────────────
  app.get('/me/calendar', async (req) => {
    const a = requireOwner(req);
    const b = await loadBusiness(ctx.db, a.businessId);
    const today = localDateKey(ctx.now(), b.timezone);
    const q = parse(z.object({ from: dateKey.optional(), to: dateKey.optional() }), req.query);
    const from = q.from ?? today;
    const to = q.to ?? addLocalDays(from, 30);
    const ids = await myDogIds(a.ownerId);
    const names = new Map((await ctx.db.select({ id: dogs.id, name: dogs.name }).from(dogs).where(eq(dogs.ownerId, a.ownerId))).map((d) => [d.id, d.name]));
    const bk = await listBookings(ctx.db, a.businessId, from, to, ids);
    const wk = ids.length
      ? await ctx.db.select().from(walks).where(and(inArray(walks.dogId, ids), ne(walks.status, 'cancelled')))
      : [];
    const tr = (await ctx.db.select().from(trainingSessions).where(and(eq(trainingSessions.businessId, a.businessId), ne(trainingSessions.status, 'cancelled')))).filter(
      (s) => s.dogId && ids.includes(s.dogId),
    );
    return {
      from,
      to,
      events: [
        ...bk.map((x) => ({ type: x.service, id: x.id, title: `${names.get(x.dogId)} · ${x.service}`, date: x.date, start: x.arrive, end: x.depart, status: x.status })),
        ...wk.map((w) => ({ type: 'walk', id: w.id, title: `Walk · ${names.get(w.dogId)}`, startsAt: w.scheduledAt, status: w.status })),
        ...tr.map((s) => ({ type: 'training', id: s.id, title: `Training · ${names.get(s.dogId!)}`, startsAt: s.startsAt, endsAt: s.endsAt, status: s.status })),
      ],
    };
  });
}

export { or, lt };
