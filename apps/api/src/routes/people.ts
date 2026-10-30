/**
 * Staff screens for owners, dogs, vaccines, notes and cards.
 */

import type { FastifyInstance } from 'fastify';
import { and, desc, eq, ilike, inArray, or } from 'drizzle-orm';
import { z } from 'zod';
import { NotFoundError, ValidationError } from '@dawgs/core';
import {
  creditGrants,
  dogs,
  invoices,
  memberships,
  owners,
  smsMessages,
  vaccines,
  visitNotes,
  walks,
  waiverSignatures,
} from '@dawgs/db';
import type { AppContext } from '../context.js';
import { requireManager, requireStaff, sameBusiness } from '../auth.js';
import { dateKey, parse, uuid, walletShape } from '../util.js';
import { peopleFor } from '../authorized.js';
import { dogSummaries, lastVisits, ownerCards } from '../people.js';
import { ensureStripeCustomer, removeCard, saveCard, setDefaultCard } from '../payments.js';
import { grantCredits, spendCredits, walletOf } from '../credits.js';
import { audit } from '../audit.js';

export const ownerShape = z.object({
  name: z.string().min(1),
  email: z.string().email().nullable().optional(),
  phone: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  emergencyName: z.string().nullable().optional(),
  emergencyPhone: z.string().nullable().optional(),
  vetName: z.string().nullable().optional(),
  vetPhone: z.string().nullable().optional(),
  smsOptIn: z.boolean().optional(),
  notes: z.string().nullable().optional(),
});

export const dogShape = z.object({
  name: z.string().min(1),
  breed: z.string().nullable().optional(),
  sex: z.enum(['male', 'female']).nullable().optional(),
  fixed: z.boolean().nullable().optional(),
  birthDate: dateKey.nullable().optional(),
  weightLb: z.number().positive().nullable().optional(),
  color: z.string().nullable().optional(),
  photoUrl: z.string().nullable().optional(),
  feeding: z.string().nullable().optional(),
  behaviour: z
    .object({
      escapeRisk: z.boolean().optional(),
      leashReactive: z.boolean().optional(),
      eatsAlone: z.boolean().optional(),
      notes: z.string().optional(),
    })
    .optional(),
  allergies: z.array(z.string().min(1)).optional(),
  medications: z.array(z.object({ name: z.string(), dose: z.string(), when: z.string() })).optional(),
  defaultYardId: uuid.nullable().optional(),
  active: z.boolean().optional(),
});

export const vaccineShape = z.object({
  name: z.string().min(1),
  expiresOn: dateKey,
  documentUrl: z.string().nullable().optional(),
});

const clean = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

export function registerPeopleRoutes(app: FastifyInstance, ctx: AppContext) {
  // ─── Owners ──────────────────────────────────────────────────────────────
  app.get('/owners', async (req) => {
    const a = requireStaff(req);
    const { q } = parse(z.object({ q: z.string().optional() }), req.query);
    const where = q
      ? and(eq(owners.businessId, a.businessId), or(ilike(owners.name, `%${q}%`), ilike(owners.phone, `%${q}%`), ilike(owners.email, `%${q}%`)))
      : eq(owners.businessId, a.businessId);
    const list = await ctx.db.select().from(owners).where(where).orderBy(owners.name);
    const ds = list.length
      ? await ctx.db.select({ id: dogs.id, name: dogs.name, ownerId: dogs.ownerId }).from(dogs).where(inArray(dogs.ownerId, list.map((o) => o.id)))
      : [];
    return list.map((o) => ({ ...o, dogs: ds.filter((d) => d.ownerId === o.id) }));
  });

  app.post('/owners', async (req) => {
    const a = requireStaff(req);
    const b = parse(ownerShape, req.body);
    const [o] = await ctx.db
      .insert(owners)
      .values({ ...clean(b), name: b.name, email: b.email?.toLowerCase() ?? null, businessId: a.businessId })
      .returning();
    await audit(ctx.db, a.businessId, a.name, 'owner.create', `Owner ${o!.name} added`);
    return o;
  });

  app.get('/owners/:id', async (req) => {
    const a = requireStaff(req);
    const { id } = req.params as { id: string };
    const [o] = await ctx.db.select().from(owners).where(eq(owners.id, id));
    sameBusiness(a, o, 'owner');
    const dogIds = (await ctx.db.select({ id: dogs.id }).from(dogs).where(eq(dogs.ownerId, id))).map((d) => d.id);
    return {
      owner: o,
      dogs: await dogSummaries(ctx.db, a.businessId, dogIds, ctx.now()),
      cards: await ownerCards(ctx.db, id),
      invoices: await ctx.db.select().from(invoices).where(eq(invoices.ownerId, id)).orderBy(desc(invoices.createdAt)).limit(50),
      memberships: await ctx.db.select().from(memberships).where(eq(memberships.ownerId, id)),
      people: await peopleFor(ctx, id),
      texts: await ctx.db.select().from(smsMessages).where(eq(smsMessages.ownerId, id)).orderBy(desc(smsMessages.createdAt)).limit(50),
      waivers: await ctx.db
        .select({
          id: waiverSignatures.id,
          title: waiverSignatures.title,
          version: waiverSignatures.version,
          dogId: waiverSignatures.dogId,
          signedName: waiverSignatures.signedName,
          signedAt: waiverSignatures.signedAt,
        })
        .from(waiverSignatures)
        .where(eq(waiverSignatures.ownerId, id)),
    };
  });

  app.patch('/owners/:id', async (req) => {
    const a = requireStaff(req);
    const { id } = req.params as { id: string };
    const b = parse(ownerShape.partial(), req.body);
    const [o] = await ctx.db.select().from(owners).where(eq(owners.id, id));
    sameBusiness(a, o, 'owner');
    const [out] = await ctx.db.update(owners).set(clean(b)).where(eq(owners.id, id)).returning();
    return out;
  });

  // ─── Cards ───────────────────────────────────────────────────────────────
  // The staff app opens Stripe's card form with this setup intent (or, in
  // simulation, posts a test card name), then saves the resulting method.
  app.post('/owners/:id/cards/setup', async (req) => {
    const a = requireStaff(req);
    const { id } = req.params as { id: string };
    const [o] = await ctx.db.select().from(owners).where(eq(owners.id, id));
    sameBusiness(a, o, 'owner');
    const customerId = await ensureStripeCustomer(ctx, id);
    const gw = await ctx.gatewayFor(a.businessId);
    const si = await gw.createSetupIntent(customerId);
    return { ...si, customerId, mode: gw.mode, publishableKey: gw.publishableKey };
  });

  app.post('/owners/:id/cards', async (req) => {
    const a = requireStaff(req);
    const { id } = req.params as { id: string };
    const b = parse(z.object({ paymentMethodId: z.string().optional(), testCard: z.string().optional() }), req.body);
    const [o] = await ctx.db.select().from(owners).where(eq(owners.id, id));
    sameBusiness(a, o, 'owner');
    const pm = await resolveNewCard(ctx, a.businessId, id, b);
    const card = await saveCard(ctx, a.businessId, id, pm);
    await audit(ctx.db, a.businessId, a.name, 'card.add', `${card.brand} •••• ${card.last4} added for ${o!.name}`);
    return card;
  });

  app.delete('/owners/:id/cards/:cardId', async (req) => {
    const a = requireStaff(req);
    const { id, cardId } = req.params as { id: string; cardId: string };
    const [o] = await ctx.db.select().from(owners).where(eq(owners.id, id));
    sameBusiness(a, o, 'owner');
    await removeCard(ctx, id, cardId);
    return { ok: true };
  });

  app.post('/owners/:id/cards/:cardId/default', async (req) => {
    const a = requireStaff(req);
    const { id, cardId } = req.params as { id: string; cardId: string };
    const [o] = await ctx.db.select().from(owners).where(eq(owners.id, id));
    sameBusiness(a, o, 'owner');
    await setDefaultCard(ctx, id, cardId);
    return { ok: true };
  });

  // ─── Dogs ────────────────────────────────────────────────────────────────
  app.get('/dogs', async (req) => {
    const a = requireStaff(req);
    return dogSummaries(ctx.db, a.businessId, null, ctx.now());
  });

  app.post('/dogs', async (req) => {
    const a = requireStaff(req);
    const b = parse(dogShape.extend({ ownerId: uuid }), req.body);
    const [o] = await ctx.db.select().from(owners).where(eq(owners.id, b.ownerId));
    sameBusiness(a, o, 'owner');
    const [d] = await ctx.db
      .insert(dogs)
      .values({ ...clean(b), name: b.name, ownerId: b.ownerId, businessId: a.businessId })
      .returning();
    await audit(ctx.db, a.businessId, a.name, 'dog.create', `${d!.name} added for ${o!.name}`);
    return d;
  });

  app.get('/dogs/:id', async (req) => {
    const a = requireStaff(req);
    const { id } = req.params as { id: string };
    const [summary] = await dogSummaries(ctx.db, a.businessId, [id], ctx.now());
    if (!summary) throw new NotFoundError('dog');
    return {
      dog: summary,
      vaccineRecords: await ctx.db.select().from(vaccines).where(eq(vaccines.dogId, id)).orderBy(desc(vaccines.expiresAt)),
      notes: await ctx.db.select().from(visitNotes).where(eq(visitNotes.dogId, id)).orderBy(desc(visitNotes.createdAt)).limit(50),
      visits: await lastVisits(ctx.db, id),
      walks: await ctx.db.select().from(walks).where(eq(walks.dogId, id)).orderBy(desc(walks.scheduledAt)).limit(20),
      credits: await ctx.db.select().from(creditGrants).where(eq(creditGrants.dogId, id)).orderBy(desc(creditGrants.createdAt)),
    };
  });

  app.patch('/dogs/:id', async (req) => {
    const a = requireStaff(req);
    const { id } = req.params as { id: string };
    const b = parse(dogShape.partial(), req.body);
    const [d] = await ctx.db.select().from(dogs).where(eq(dogs.id, id));
    sameBusiness(a, d, 'dog');
    const [out] = await ctx.db.update(dogs).set(clean(b)).where(eq(dogs.id, id)).returning();
    return out;
  });

  app.post('/dogs/:id/vaccines', async (req) => {
    const a = requireStaff(req);
    const { id } = req.params as { id: string };
    const b = parse(vaccineShape, req.body);
    const [d] = await ctx.db.select().from(dogs).where(eq(dogs.id, id));
    sameBusiness(a, d, 'dog');
    const [v] = await ctx.db
      .insert(vaccines)
      .values({
        businessId: a.businessId,
        dogId: id,
        name: b.name,
        expiresAt: new Date(`${b.expiresOn}T23:59:59Z`),
        documentUrl: b.documentUrl ?? null,
        verifiedBy: a.name,
      })
      .returning();
    await audit(ctx.db, a.businessId, a.name, 'vaccine.add', `${d!.name}: ${b.name} until ${b.expiresOn}`);
    return v;
  });

  app.post('/vaccines/:id/verify', async (req) => {
    const a = requireStaff(req);
    const { id } = req.params as { id: string };
    const [v] = await ctx.db.select().from(vaccines).where(eq(vaccines.id, id));
    sameBusiness(a, v, 'vaccine');
    await ctx.db.update(vaccines).set({ verifiedBy: a.name }).where(eq(vaccines.id, id));
    return { ok: true };
  });

  app.delete('/vaccines/:id', async (req) => {
    const a = requireStaff(req);
    const { id } = req.params as { id: string };
    const [v] = await ctx.db.select().from(vaccines).where(eq(vaccines.id, id));
    sameBusiness(a, v, 'vaccine');
    await ctx.db.delete(vaccines).where(eq(vaccines.id, id));
    return { ok: true };
  });

  app.post('/dogs/:id/notes', async (req) => {
    const a = requireStaff(req);
    const { id } = req.params as { id: string };
    const b = parse(
      z.object({
        kind: z.enum(['report', 'incident', 'note']),
        body: z.string().min(1),
        photoUrl: z.string().nullable().optional(),
        visitId: uuid.nullable().optional(),
        sharedWithOwner: z.boolean().optional(),
      }),
      req.body,
    );
    const [d] = await ctx.db.select().from(dogs).where(eq(dogs.id, id));
    sameBusiness(a, d, 'dog');
    const [n] = await ctx.db
      .insert(visitNotes)
      .values({
        businessId: a.businessId,
        dogId: id,
        kind: b.kind,
        body: b.body,
        photoUrl: b.photoUrl ?? null,
        visitId: b.visitId ?? null,
        author: a.name,
        // Report cards go to the owner by default; incidents and notes don't.
        sharedWithOwner: b.sharedWithOwner ?? b.kind === 'report',
      })
      .returning();
    if (b.kind === 'incident') await audit(ctx.db, a.businessId, a.name, 'incident', `${d!.name}: ${b.body}`);
    return n;
  });

  /** A manager's manual correction to a dog's credits (goodwill, mistakes). */
  app.post('/dogs/:id/credits', async (req) => {
    const a = requireManager(req);
    const { id } = req.params as { id: string };
    const b = parse(z.object({ add: walletShape.optional(), remove: walletShape.optional(), note: z.string().min(1) }), req.body);
    const [d] = await ctx.db.select().from(dogs).where(eq(dogs.id, id));
    sameBusiness(a, d, 'dog');
    if (b.add) await grantCredits(ctx.db, { businessId: a.businessId, dogId: id, credits: b.add, note: b.note });
    if (b.remove) {
      try {
        await spendCredits(ctx.db, id, b.remove, ctx.now());
      } catch (e) {
        throw new ValidationError(String((e as Error).message));
      }
    }
    await audit(ctx.db, a.businessId, a.name, 'credits.adjust', `${d!.name}: ${JSON.stringify(b)} `);
    return walletOf(ctx.db, id, ctx.now());
  });
}

/**
 * In simulation the apps send a Stripe test-card name instead of running
 * Stripe's form; with real Stripe they send the confirmed PaymentMethod id.
 */
export async function resolveNewCard(
  ctx: AppContext,
  businessId: string,
  ownerId: string,
  b: { paymentMethodId?: string | undefined; testCard?: string | undefined },
): Promise<string> {
  const gw = await ctx.gatewayFor(businessId);
  if (b.paymentMethodId) return b.paymentMethodId;
  if (b.testCard && gw.mode === 'simulated') {
    const customerId = await ensureStripeCustomer(ctx, ownerId);
    return (gw as unknown as { simulateConfirmSetup(c: string, t: string): string }).simulateConfirmSetup(customerId, b.testCard);
  }
  throw new ValidationError('paymentMethodId is required');
}
