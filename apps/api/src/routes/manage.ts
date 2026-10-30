/**
 * Training, the calendar, waivers, money (P&L, bills, budgets, inventory)
 * and the activity log.
 */

import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ConflictError, NotFoundError, ValidationError, addLocalDays, dateKeyToInstant, localDateKey } from '@dawgs/core';
import {
  auditLog,
  bookings,
  budgets,
  dogs,
  expenses,
  inventoryItems,
  invoices,
  owners,
  payments,
  shifts,
  trainingEnrollments,
  trainingPrograms,
  trainingSessions,
  users,
  walks,
  waiverSignatures,
  waivers,
} from '@dawgs/db';
import type { AppContext } from '../context.js';
import { requireManager, requireStaff, sameBusiness, type AuthContext } from '../auth.js';
import { cents, dateKey, parse, payShape, uuid } from '../util.js';
import { loadBusiness } from '../ops.js';
import { addProgress, bookPrivate, enroll, enrolledCount, markAttendance, progressFor, roster } from '../training.js';
import { audit } from '../audit.js';

const programShape = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  kind: z.enum(['class', 'private']),
  sessionCount: z.number().int().min(1).optional(),
  sessionMinutes: z.number().int().min(15).optional(),
  capacity: z.number().int().min(1).optional(),
  priceCents: cents,
  trainerId: uuid.nullable().optional(),
  skills: z.array(z.string().min(1)).optional(),
  sellOnline: z.boolean().optional(),
  active: z.boolean().optional(),
});

const waiverShape = z.object({
  title: z.string().min(1),
  body: z.string().min(20),
  required: z.boolean().optional(),
  scope: z.enum(['owner', 'dog']).optional(),
  active: z.boolean().optional(),
});

export const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * Record a signature on the CURRENT version of a waiver, keeping the exact
 * text signed. Used by the customer app and by staff collecting a signature
 * on the front-desk tablet.
 */
export async function signWaiver(
  ctx: AppContext,
  args: {
    businessId: string;
    waiverId: string;
    ownerId: string;
    dogId?: string | null;
    signedName: string;
    signatureImage?: string | null;
    version: number;
    ip?: string | null;
    userAgent?: string | null;
    collectedBy: string;
  },
) {
  const [w] = await ctx.db.select().from(waivers).where(eq(waivers.id, args.waiverId));
  if (!w || w.businessId !== args.businessId || !w.active) throw new NotFoundError('waiver');
  // The signer saw a version; if the manager edited the form since, they must read the new one.
  if (args.version !== w.version) throw new ConflictError('this form was updated; please read the new version');
  if (w.scope === 'dog') {
    if (!args.dogId) throw new ValidationError('choose which dog this form is for');
    const [d] = await ctx.db.select().from(dogs).where(eq(dogs.id, args.dogId));
    if (!d || d.ownerId !== args.ownerId) throw new NotFoundError('dog');
  }
  if (args.signatureImage && args.signatureImage.length > 200_000) throw new ValidationError('signature image is too large');
  const [row] = await ctx.db
    .insert(waiverSignatures)
    .values({
      businessId: args.businessId,
      waiverId: w.id,
      version: w.version,
      ownerId: args.ownerId,
      dogId: w.scope === 'dog' ? (args.dogId ?? null) : null,
      title: w.title,
      bodySigned: w.body,
      bodySha256: sha256(w.body),
      signedName: args.signedName,
      signatureImage: args.signatureImage ?? null,
      ip: args.ip ?? null,
      userAgent: args.userAgent ?? null,
      collectedBy: args.collectedBy,
      signedAt: new Date(ctx.now()),
    })
    .returning();
  return row!;
}

async function calendar(ctx: AppContext, a: AuthContext, from: string, to: string) {
  const b = await loadBusiness(ctx.db, a.businessId);
  const t0 = new Date(dateKeyToInstant(from, b.timezone));
  const t1 = new Date(dateKeyToInstant(addLocalDays(to, 1), b.timezone));
  const bk = await ctx.db
    .select({ b: bookings, dog: dogs.name })
    .from(bookings)
    .innerJoin(dogs, eq(dogs.id, bookings.dogId))
    .where(
      and(
        eq(bookings.businessId, a.businessId),
        inArray(bookings.status, ['requested', 'confirmed', 'waitlist', 'checked_in', 'checked_out']),
        sql`((${bookings.date} >= ${from} and ${bookings.date} <= ${to}) or (${bookings.arrive} <= ${to} and ${bookings.depart} >= ${from}))`,
      ),
    );
  const wk = await ctx.db
    .select({ w: walks, dog: dogs.name })
    .from(walks)
    .innerJoin(dogs, eq(dogs.id, walks.dogId))
    .where(and(eq(walks.businessId, a.businessId), ne(walks.status, 'cancelled'), gte(walks.scheduledAt, t0), lt(walks.scheduledAt, t1)));
  const tr = await ctx.db
    .select({ s: trainingSessions, program: trainingPrograms.name, kind: trainingPrograms.kind })
    .from(trainingSessions)
    .innerJoin(trainingPrograms, eq(trainingPrograms.id, trainingSessions.programId))
    .where(and(eq(trainingSessions.businessId, a.businessId), ne(trainingSessions.status, 'cancelled'), gte(trainingSessions.startsAt, t0), lt(trainingSessions.startsAt, t1)));
  const sh = await ctx.db
    .select({ s: shifts, name: users.name })
    .from(shifts)
    .innerJoin(users, eq(users.id, shifts.userId))
    .where(and(eq(shifts.businessId, a.businessId), gte(shifts.startsAt, t0), lt(shifts.startsAt, t1)));
  return {
    from,
    to,
    timezone: b.timezone,
    events: [
      ...bk.map(({ b: x, dog }) =>
        x.service === 'daycare'
          ? { type: 'daycare', id: x.id, title: `${dog} · ${x.plan} day`, date: x.date, status: x.status }
          : { type: 'boarding', id: x.id, title: `${dog} · boarding`, start: x.arrive, end: x.depart, status: x.status, kennelId: x.kennelId },
      ),
      ...wk.map(({ w, dog }) => ({ type: 'walk', id: w.id, title: `Walk · ${dog}`, startsAt: w.scheduledAt, status: w.status, walkerId: w.walkerId })),
      ...tr.map(({ s, program, kind }) => ({ type: 'training', id: s.id, title: program, kind, startsAt: s.startsAt, endsAt: s.endsAt, trainerId: s.trainerId, status: s.status })),
      ...sh.map(({ s, name }) => ({ type: 'shift', id: s.id, title: name, startsAt: s.startsAt, endsAt: s.endsAt, userId: s.userId })),
    ],
  };
}

export function registerManageRoutes(app: FastifyInstance, ctx: AppContext) {
  // ─── Calendar ────────────────────────────────────────────────────────────
  app.get('/calendar', async (req) => {
    const a = requireStaff(req);
    const b = await loadBusiness(ctx.db, a.businessId);
    const q = parse(z.object({ from: dateKey.optional(), to: dateKey.optional() }), req.query);
    const from = q.from ?? localDateKey(ctx.now(), b.timezone);
    const to = q.to ?? addLocalDays(from, 6);
    if (dateKeyToInstant(to, 'UTC') - dateKeyToInstant(from, 'UTC') > 62 * 86_400_000) throw new ValidationError('ask for two months at most');
    return calendar(ctx, a, from, to);
  });

  // ─── Training ────────────────────────────────────────────────────────────
  app.get('/training/programs', async (req) => {
    const a = requireStaff(req);
    const list = await ctx.db.select().from(trainingPrograms).where(eq(trainingPrograms.businessId, a.businessId)).orderBy(trainingPrograms.name);
    return Promise.all(list.map(async (p) => ({ ...p, enrolled: p.kind === 'class' ? await enrolledCount(ctx, p.id) : null })));
  });

  app.post('/training/programs', async (req) => {
    const a = requireManager(req);
    const b = parse(programShape, req.body);
    const [p] = await ctx.db
      .insert(trainingPrograms)
      .values({
        ...b,
        businessId: a.businessId,
        description: b.description ?? null,
        trainerId: b.trainerId ?? null,
        capacity: b.kind === 'private' ? 1 : (b.capacity ?? 8),
        sessionCount: b.kind === 'private' ? 1 : (b.sessionCount ?? 6),
      })
      .returning();
    return p;
  });

  app.patch('/training/programs/:id', async (req) => {
    const a = requireManager(req);
    const { id } = req.params as { id: string };
    const b = parse(programShape.partial(), req.body);
    const [p] = await ctx.db.select().from(trainingPrograms).where(eq(trainingPrograms.id, id));
    sameBusiness(a, p, 'program');
    const [out] = await ctx.db
      .update(trainingPrograms)
      .set(Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)))
      .where(eq(trainingPrograms.id, id))
      .returning();
    return out;
  });

  app.get('/training/programs/:id', async (req) => {
    const a = requireStaff(req);
    const { id } = req.params as { id: string };
    const [p] = await ctx.db.select().from(trainingPrograms).where(eq(trainingPrograms.id, id));
    sameBusiness(a, p, 'program');
    const enrolled = await ctx.db
      .select({ e: trainingEnrollments, dog: dogs.name, owner: owners.name })
      .from(trainingEnrollments)
      .innerJoin(dogs, eq(dogs.id, trainingEnrollments.dogId))
      .innerJoin(owners, eq(owners.id, dogs.ownerId))
      .where(eq(trainingEnrollments.programId, id));
    const sessions = await ctx.db.select().from(trainingSessions).where(eq(trainingSessions.programId, id)).orderBy(asc(trainingSessions.startsAt));
    return { program: p, enrollments: enrolled.map((x) => ({ ...x.e, dogName: x.dog, ownerName: x.owner })), sessions };
  });

  /** Lay out a class's sessions: one every `everyDays` from the first. */
  app.post('/training/programs/:id/sessions', async (req) => {
    const a = requireManager(req);
    const { id } = req.params as { id: string };
    const b = parse(
      z.object({ firstStartsAt: z.number().int(), count: z.number().int().min(1).max(52).optional(), everyDays: z.number().int().min(1).optional(), location: z.string().nullable().optional() }),
      req.body,
    );
    const [p] = await ctx.db.select().from(trainingPrograms).where(eq(trainingPrograms.id, id));
    sameBusiness(a, p, 'program');
    const n = b.count ?? p!.sessionCount;
    const every = (b.everyDays ?? 7) * 86_400_000;
    const rows = Array.from({ length: n }, (_, i) => ({
      businessId: a.businessId,
      programId: id,
      trainerId: p!.trainerId,
      startsAt: new Date(b.firstStartsAt + i * every),
      endsAt: new Date(b.firstStartsAt + i * every + p!.sessionMinutes * 60_000),
      location: b.location ?? null,
    }));
    return ctx.db.insert(trainingSessions).values(rows).returning();
  });

  app.post('/training/programs/:id/enroll', async (req) => {
    const a = requireStaff(req);
    const { id } = req.params as { id: string };
    const b = parse(z.object({ dogId: uuid, pay: payShape }), req.body);
    return enroll(ctx, { businessId: a.businessId, programId: id, dogId: b.dogId, pay: b.pay, actor: a.name });
  });

  app.post('/training/programs/:id/private', async (req) => {
    const a = requireStaff(req);
    const { id } = req.params as { id: string };
    const b = parse(z.object({ dogId: uuid, startsAt: z.number().int(), trainerId: uuid.nullable().optional(), pay: payShape }), req.body);
    return bookPrivate(ctx, { businessId: a.businessId, programId: id, actor: a.name, ...b } as Parameters<typeof bookPrivate>[1]);
  });

  app.post('/training/enrollments/:id/drop', async (req) => {
    const a = requireStaff(req);
    const { id } = req.params as { id: string };
    const [e] = await ctx.db.select().from(trainingEnrollments).where(eq(trainingEnrollments.id, id));
    sameBusiness(a, e, 'enrollment');
    await ctx.db.update(trainingEnrollments).set({ status: 'dropped' }).where(eq(trainingEnrollments.id, id));
    return { ok: true };
  });

  app.get('/training/sessions/:id', async (req) => roster(ctx, requireStaff(req).businessId, (req.params as { id: string }).id));

  app.post('/training/sessions/:id/attendance', async (req) => {
    const a = requireStaff(req);
    const b = parse(z.object({ marks: z.array(z.object({ dogId: uuid, attended: z.boolean(), note: z.string().nullable().optional() })) }), req.body);
    return markAttendance(ctx, { businessId: a.businessId, sessionId: (req.params as { id: string }).id, marks: b.marks });
  });

  app.post('/training/sessions/:id/cancel', async (req) => {
    const a = requireStaff(req);
    const { id } = req.params as { id: string };
    const [s] = await ctx.db.select().from(trainingSessions).where(eq(trainingSessions.id, id));
    sameBusiness(a, s, 'session');
    await ctx.db.update(trainingSessions).set({ status: 'cancelled' }).where(eq(trainingSessions.id, id));
    return { ok: true };
  });

  app.post('/dogs/:id/progress', async (req) => {
    const a = requireStaff(req);
    const b = parse(
      z.object({
        programId: uuid.nullable().optional(),
        skill: z.string().min(1),
        level: z.number().int().min(0).max(4),
        note: z.string().nullable().optional(),
        homework: z.string().nullable().optional(),
        sharedWithOwner: z.boolean().optional(),
      }),
      req.body,
    );
    return addProgress(ctx, { ...b, businessId: a.businessId, dogId: (req.params as { id: string }).id, author: a.name } as Parameters<typeof addProgress>[1]);
  });

  app.get('/dogs/:id/progress', async (req) => {
    const a = requireStaff(req);
    const { id } = req.params as { id: string };
    const [d] = await ctx.db.select().from(dogs).where(eq(dogs.id, id));
    sameBusiness(a, d, 'dog');
    return progressFor(ctx, id, false);
  });

  // ─── Waivers ─────────────────────────────────────────────────────────────
  app.get('/waivers', async (req) => {
    const a = requireStaff(req);
    const list = await ctx.db.select().from(waivers).where(eq(waivers.businessId, a.businessId)).orderBy(waivers.title);
    const counts = await ctx.db
      .select({ waiverId: waiverSignatures.waiverId, version: waiverSignatures.version, n: sql<number>`count(*)::int` })
      .from(waiverSignatures)
      .where(eq(waiverSignatures.businessId, a.businessId))
      .groupBy(waiverSignatures.waiverId, waiverSignatures.version);
    return list.map((w) => ({ ...w, signedCurrent: counts.find((c) => c.waiverId === w.id && c.version === w.version)?.n ?? 0 }));
  });

  app.post('/waivers', async (req) => {
    const a = requireManager(req);
    const b = parse(waiverShape, req.body);
    const [w] = await ctx.db.insert(waivers).values({ ...b, businessId: a.businessId }).returning();
    await audit(ctx.db, a.businessId, a.name, 'waiver.create', `Form “${w!.title}” created`);
    return w;
  });

  /** Editing the TEXT makes a new version that everyone must sign again; other fields don't. */
  app.patch('/waivers/:id', async (req) => {
    const a = requireManager(req);
    const { id } = req.params as { id: string };
    const b = parse(waiverShape.partial(), req.body);
    const [w] = await ctx.db.select().from(waivers).where(eq(waivers.id, id));
    sameBusiness(a, w, 'waiver');
    const textChanged = (b.body !== undefined && b.body !== w!.body) || (b.title !== undefined && b.title !== w!.title);
    const set = {
      ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)),
      ...(textChanged ? { version: w!.version + 1 } : {}),
      updatedAt: new Date(ctx.now()),
    };
    const [out] = await ctx.db.update(waivers).set(set).where(eq(waivers.id, id)).returning();
    if (textChanged) await audit(ctx.db, a.businessId, a.name, 'waiver.version', `Form “${out!.title}” is now version ${out!.version}`);
    return out;
  });

  app.get('/waivers/:id/signatures', async (req) => {
    const a = requireStaff(req);
    const { id } = req.params as { id: string };
    const [w] = await ctx.db.select().from(waivers).where(eq(waivers.id, id));
    sameBusiness(a, w, 'waiver');
    const rows = await ctx.db
      .select({ s: waiverSignatures, owner: owners.name })
      .from(waiverSignatures)
      .innerJoin(owners, eq(owners.id, waiverSignatures.ownerId))
      .where(eq(waiverSignatures.waiverId, id))
      .orderBy(desc(waiverSignatures.signedAt));
    return rows.map(({ s, owner }) => ({ ...s, bodySigned: undefined, signatureImage: undefined, ownerName: owner }));
  });

  /** The full signed record: exact text, signature image, when and how it was signed. */
  app.get('/signatures/:id', async (req) => {
    const a = requireStaff(req);
    const { id } = req.params as { id: string };
    const [s] = await ctx.db.select().from(waiverSignatures).where(eq(waiverSignatures.id, id));
    sameBusiness(a, s, 'signature');
    return s;
  });

  /** Staff collecting a signature on the front-desk tablet. */
  app.post('/waivers/:id/sign', async (req) => {
    const a = requireStaff(req);
    const b = parse(
      z.object({ ownerId: uuid, dogId: uuid.nullable().optional(), signedName: z.string().min(2), signatureImage: z.string().nullable().optional(), version: z.number().int() }),
      req.body,
    );
    const [o] = await ctx.db.select().from(owners).where(eq(owners.id, b.ownerId));
    sameBusiness(a, o, 'owner');
    return signWaiver(ctx, {
      ...b,
      businessId: a.businessId,
      waiverId: (req.params as { id: string }).id,
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
      collectedBy: `${a.name} (front desk)`,
    });
  });

  // ─── Money ───────────────────────────────────────────────────────────────
  app.get('/money/summary', async (req) => {
    const a = requireManager(req);
    const b = await loadBusiness(ctx.db, a.businessId);
    const { month } = parse(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() }), req.query);
    const m = month ?? localDateKey(ctx.now(), b.timezone).slice(0, 7);
    const [y, mo] = m.split('-').map(Number);
    const next = mo === 12 ? `${y! + 1}-01` : `${y}-${String(mo! + 1).padStart(2, '0')}`;
    const t0 = new Date(dateKeyToInstant(`${m}-01`, b.timezone));
    const t1 = new Date(dateKeyToInstant(`${next}-01`, b.timezone));
    const income = await ctx.db
      .select({ category: invoices.category, total: sql<number>`coalesce(sum(${payments.amountCents} - ${payments.refundedCents}), 0)::int` })
      .from(payments)
      .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
      .where(and(eq(payments.businessId, a.businessId), eq(payments.status, 'succeeded'), gte(payments.createdAt, t0), lt(payments.createdAt, t1)))
      .groupBy(invoices.category);
    const [fees] = await ctx.db
      .select({ total: sql<number>`coalesce(sum(${payments.feeCents}), 0)::int` })
      .from(payments)
      .where(and(eq(payments.businessId, a.businessId), eq(payments.status, 'succeeded'), gte(payments.createdAt, t0), lt(payments.createdAt, t1)));
    const spend = await ctx.db
      .select({ category: expenses.category, total: sql<number>`sum(${expenses.amountCents})::int` })
      .from(expenses)
      .where(and(eq(expenses.businessId, a.businessId), gte(expenses.dueDate, `${m}-01`), lt(expenses.dueDate, `${next}-01`)))
      .groupBy(expenses.category);
    const plan = await ctx.db.select().from(budgets).where(and(eq(budgets.businessId, a.businessId), eq(budgets.month, m)));
    const [open] = await ctx.db
      .select({ n: sql<number>`count(*)::int`, total: sql<number>`coalesce(sum(${invoices.totalCents}), 0)::int` })
      .from(invoices)
      .where(and(eq(invoices.businessId, a.businessId), eq(invoices.status, 'open')));
    const revenue = income.reduce((s, r) => s + r.total, 0);
    const costs = spend.reduce((s, r) => s + r.total, 0) + (fees?.total ?? 0);
    return {
      month: m,
      income,
      cardFeesCents: fees?.total ?? 0,
      expenses: spend,
      budgets: plan,
      revenueCents: revenue,
      costsCents: costs,
      profitCents: revenue - costs,
      openInvoices: open,
    };
  });

  app.get('/expenses', async (req) => {
    const a = requireManager(req);
    return ctx.db.select().from(expenses).where(eq(expenses.businessId, a.businessId)).orderBy(desc(expenses.dueDate)).limit(300);
  });

  const expenseShape = z.object({
    category: z.string().min(1),
    vendor: z.string().min(1),
    amountCents: z.number().int().positive(),
    dueDate: dateKey,
    note: z.string().nullable().optional(),
  });

  app.post('/expenses', async (req) => {
    const a = requireManager(req);
    const b = parse(expenseShape, req.body);
    const [e] = await ctx.db.insert(expenses).values({ ...b, note: b.note ?? null, businessId: a.businessId }).returning();
    return e;
  });

  app.patch('/expenses/:id', async (req) => {
    const a = requireManager(req);
    const { id } = req.params as { id: string };
    const b = parse(expenseShape.partial().extend({ paid: z.boolean().optional() }), req.body);
    const [e] = await ctx.db.select().from(expenses).where(eq(expenses.id, id));
    sameBusiness(a, e, 'expense');
    const { paid, ...rest } = b;
    const set: Record<string, unknown> = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
    if (paid !== undefined) set.paidAt = paid ? new Date(ctx.now()) : null;
    const [out] = await ctx.db.update(expenses).set(set).where(eq(expenses.id, id)).returning();
    return out;
  });

  app.delete('/expenses/:id', async (req) => {
    const a = requireManager(req);
    const { id } = req.params as { id: string };
    const [e] = await ctx.db.select().from(expenses).where(eq(expenses.id, id));
    sameBusiness(a, e, 'expense');
    await ctx.db.delete(expenses).where(eq(expenses.id, id));
    return { ok: true };
  });

  app.put('/budgets', async (req) => {
    const a = requireManager(req);
    const b = parse(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), category: z.string().min(1), amountCents: cents }), req.body);
    await ctx.db
      .insert(budgets)
      .values({ ...b, businessId: a.businessId })
      .onConflictDoUpdate({ target: [budgets.businessId, budgets.category, budgets.month], set: { amountCents: b.amountCents } });
    return { ok: true };
  });

  const itemShape = z.object({
    name: z.string().min(1),
    sku: z.string().nullable().optional(),
    priceCents: cents,
    costCents: cents.optional(),
    onHand: z.number().int().optional(),
    reorderAt: z.number().int().min(0).optional(),
  });

  app.get('/inventory', async (req) => {
    const a = requireStaff(req);
    return ctx.db.select().from(inventoryItems).where(eq(inventoryItems.businessId, a.businessId)).orderBy(inventoryItems.name);
  });

  app.post('/inventory', async (req) => {
    const a = requireManager(req);
    const b = parse(itemShape, req.body);
    const [i] = await ctx.db.insert(inventoryItems).values({ ...b, sku: b.sku ?? null, businessId: a.businessId }).returning();
    return i;
  });

  app.patch('/inventory/:id', async (req) => {
    const a = requireManager(req);
    const { id } = req.params as { id: string };
    const b = parse(itemShape.partial(), req.body);
    const [i] = await ctx.db.select().from(inventoryItems).where(eq(inventoryItems.id, id));
    sameBusiness(a, i, 'item');
    const [out] = await ctx.db
      .update(inventoryItems)
      .set(Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)))
      .where(eq(inventoryItems.id, id))
      .returning();
    return out;
  });

  app.get('/log', async (req) => {
    const a = requireManager(req);
    return ctx.db.select().from(auditLog).where(eq(auditLog.businessId, a.businessId)).orderBy(desc(auditLog.at)).limit(300);
  });
}
