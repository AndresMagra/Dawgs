/**
 * Money in: invoices, payments, refunds, pay links, Stripe webhooks, packs,
 * memberships and retail sales.
 */

import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { NotFoundError, ValidationError, formatMoney } from '@dawgs/core';
import {
  businesses,
  dogs,
  inventoryItems,
  invoices,
  memberships,
  owners,
  packages,
  payments,
} from '@dawgs/db';
import type { AppContext } from '../context.js';
import { requireManager, requireStaff, sameBusiness } from '../auth.js';
import { cents, parse, payShape, uuid, walletShape } from '../util.js';
import {
  createInvoice,
  createPayLink,
  openPayLink,
  payInvoice,
  recordIntentSucceeded,
  refundPayment,
} from '../payments.js';
import { cancelMembership, sellPackage } from '../sales.js';
import { sendText } from '../texts.js';
import { SimulatedGateway } from '../gateway.js';

export const packageShape = z.object({
  name: z.string().min(1),
  credits: walletShape,
  priceCents: cents,
  expiresDays: z.number().int().min(1).nullable().optional(),
  recurring: z.boolean().optional(),
  rolloverMax: z.number().int().min(0).optional(),
  badge: z.string().nullable().optional(),
  sellOnline: z.boolean().optional(),
  active: z.boolean().optional(),
});

export function registerCommerceRoutes(app: FastifyInstance, ctx: AppContext) {
  // ─── Invoices ────────────────────────────────────────────────────────────
  app.get('/invoices', async (req) => {
    const a = requireStaff(req);
    const q = parse(z.object({ status: z.string().optional(), ownerId: uuid.optional() }), req.query);
    const rows = await ctx.db
      .select({ inv: invoices, owner: owners.name })
      .from(invoices)
      .innerJoin(owners, eq(owners.id, invoices.ownerId))
      .where(
        and(
          eq(invoices.businessId, a.businessId),
          ...(q.status ? [eq(invoices.status, q.status as 'open')] : []),
          ...(q.ownerId ? [eq(invoices.ownerId, q.ownerId)] : []),
        ),
      )
      .orderBy(desc(invoices.createdAt))
      .limit(200);
    return rows.map((r) => ({ ...r.inv, ownerName: r.owner }));
  });

  app.get('/invoices/:id', async (req) => {
    const a = requireStaff(req);
    const { id } = req.params as { id: string };
    const [inv] = await ctx.db.select().from(invoices).where(eq(invoices.id, id));
    sameBusiness(a, inv, 'invoice');
    return { invoice: inv, payments: await ctx.db.select().from(payments).where(eq(payments.invoiceId, id)) };
  });

  app.post('/invoices/:id/pay', async (req) => {
    const a = requireStaff(req);
    const { id } = req.params as { id: string };
    const { pay } = parse(z.object({ pay: payShape }), req.body);
    return payInvoice(ctx, { businessId: a.businessId, invoiceId: id, pay, actor: a.name });
  });

  app.post('/invoices/:id/void', async (req) => {
    const a = requireManager(req);
    const { id } = req.params as { id: string };
    const [inv] = await ctx.db.select().from(invoices).where(eq(invoices.id, id));
    sameBusiness(a, inv, 'invoice');
    if (inv!.status !== 'open') throw new ValidationError('only open invoices can be voided; refund a paid one');
    await ctx.db.update(invoices).set({ status: 'void' }).where(eq(invoices.id, id));
    return { ok: true };
  });

  /** Make a pay link and optionally text it to the owner. */
  app.post('/invoices/:id/link', async (req) => {
    const a = requireStaff(req);
    const { id } = req.params as { id: string };
    const { text } = parse(z.object({ text: z.boolean().default(true) }), req.body);
    const link = await createPayLink(ctx, a.businessId, id);
    if (text && link.url) {
      const [o] = await ctx.db.select().from(owners).where(eq(owners.id, link.invoice.ownerId));
      const [b] = await ctx.db.select().from(businesses).where(eq(businesses.id, a.businessId));
      await sendText(ctx, {
        businessId: a.businessId,
        ownerId: o!.id,
        kind: 'payment_link',
        body: `${b!.name}: your invoice #${link.invoice.number} for ${formatMoney(link.invoice.totalCents)} is ready. Pay here: ${link.url}`,
        sentBy: a.name,
      });
    }
    return { url: link.url, token: link.token };
  });

  app.post('/payments/:id/refund', async (req) => {
    const a = requireManager(req);
    const { id } = req.params as { id: string };
    const { amountCents } = parse(z.object({ amountCents: z.number().int().positive() }), req.body);
    return refundPayment(ctx, { businessId: a.businessId, paymentId: id, amountCents, actor: a.name });
  });

  // ─── Public pay page ─────────────────────────────────────────────────────
  app.get('/pay/:token', { config: { public: true } }, async (req) => {
    const { token } = req.params as { token: string };
    return openPayLink(ctx, token);
  });

  /** Simulation only: stands in for the payer completing Stripe's form. */
  app.post('/pay/:token/simulate', { config: { public: true } }, async (req) => {
    const { token } = req.params as { token: string };
    const b = parse(z.object({ paymentIntentId: z.string(), testCard: z.string() }), req.body);
    const page = await openPayLink(ctx, token);
    if (page.mode !== 'simulated') throw new ValidationError('not in simulation');
    const sim = ctx.webhookGateway as SimulatedGateway;
    const ev = sim.simulateConfirmPayment(b.paymentIntentId, b.testCard);
    if (ev.type !== 'payment_intent.succeeded') return { paid: false, message: 'Your card was declined.' };
    const businessId = ev.metadata.businessId!;
    await recordIntentSucceeded(ctx, businessId, b.paymentIntentId);
    return { paid: true };
  });

  /**
   * Stripe webhooks for every connected daycare. The raw body is needed for
   * the signature, so this route parses its own JSON (see app.ts).
   */
  app.post('/webhooks/stripe', { config: { public: true } }, async (req) => {
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? JSON.stringify(req.body);
    const sig = req.headers['stripe-signature'] as string | undefined;
    let ev;
    try {
      ev = ctx.webhookGateway.parseWebhook(raw, sig);
    } catch {
      throw new ValidationError('bad signature');
    }
    if (ev.type !== 'payment_intent.succeeded' || !ev.paymentIntentId) return { received: true };
    let businessId = ev.metadata.businessId;
    if (ev.account) {
      const [b] = await ctx.db.select({ id: businesses.id }).from(businesses).where(eq(businesses.stripeAccountId, ev.account));
      businessId = b?.id;
    }
    if (!businessId) return { received: true };
    await recordIntentSucceeded(ctx, businessId, ev.paymentIntentId);
    return { received: true };
  });

  // ─── Packages and memberships ────────────────────────────────────────────
  app.get('/packages', async (req) => {
    const a = requireStaff(req);
    return ctx.db.select().from(packages).where(eq(packages.businessId, a.businessId)).orderBy(packages.priceCents);
  });

  app.post('/packages', async (req) => {
    const a = requireManager(req);
    const b = parse(packageShape, req.body);
    const [p] = await ctx.db
      .insert(packages)
      .values({ ...b, businessId: a.businessId, expiresDays: b.expiresDays ?? null, badge: b.badge ?? null })
      .returning();
    return p;
  });

  app.patch('/packages/:id', async (req) => {
    const a = requireManager(req);
    const { id } = req.params as { id: string };
    const b = parse(packageShape.partial(), req.body);
    const [p] = await ctx.db.select().from(packages).where(eq(packages.id, id));
    sameBusiness(a, p, 'package');
    const set = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined));
    const [out] = await ctx.db.update(packages).set(set).where(eq(packages.id, id)).returning();
    return out;
  });

  /** Credits already sold stay valid; a deleted package is only switched off. */
  app.delete('/packages/:id', async (req) => {
    const a = requireManager(req);
    const { id } = req.params as { id: string };
    const [p] = await ctx.db.select().from(packages).where(eq(packages.id, id));
    sameBusiness(a, p, 'package');
    await ctx.db.update(packages).set({ active: false }).where(eq(packages.id, id));
    return { ok: true };
  });

  app.post('/packages/:id/sell', async (req) => {
    const a = requireStaff(req);
    const { id } = req.params as { id: string };
    const b = parse(z.object({ dogId: uuid, pay: payShape }), req.body);
    return sellPackage(ctx, { businessId: a.businessId, dogId: b.dogId, packageId: id, pay: b.pay, actor: a.name });
  });

  app.get('/memberships', async (req) => {
    const a = requireStaff(req);
    const rows = await ctx.db
      .select({ m: memberships, dog: dogs.name, owner: owners.name, pkg: packages.name, price: packages.priceCents })
      .from(memberships)
      .innerJoin(dogs, eq(dogs.id, memberships.dogId))
      .innerJoin(owners, eq(owners.id, memberships.ownerId))
      .innerJoin(packages, eq(packages.id, memberships.packageId))
      .where(eq(memberships.businessId, a.businessId))
      .orderBy(desc(memberships.createdAt));
    return rows.map((r) => ({ ...r.m, dogName: r.dog, ownerName: r.owner, packageName: r.pkg, priceCents: r.price }));
  });

  app.post('/memberships/:id/cancel', async (req) => {
    const a = requireStaff(req);
    const { id } = req.params as { id: string };
    return cancelMembership(ctx, { businessId: a.businessId, membershipId: id, actor: a.name });
  });

  // ─── Retail ──────────────────────────────────────────────────────────────
  app.post('/retail/sale', async (req) => {
    const a = requireStaff(req);
    const b = parse(
      z.object({ ownerId: uuid, items: z.array(z.object({ id: uuid, qty: z.number().int().min(1) })).min(1), pay: payShape }),
      req.body,
    );
    const [o] = await ctx.db.select().from(owners).where(eq(owners.id, b.ownerId));
    sameBusiness(a, o, 'owner');
    const stock = await ctx.db
      .select()
      .from(inventoryItems)
      .where(and(eq(inventoryItems.businessId, a.businessId), inArray(inventoryItems.id, b.items.map((i) => i.id))));
    const lines = b.items.map((i) => {
      const s = stock.find((x) => x.id === i.id);
      if (!s) throw new NotFoundError('item');
      return { kind: 'addon' as const, text: `${s.name}${i.qty > 1 ? ` × ${i.qty}` : ''}`, amount: s.priceCents * i.qty };
    });
    for (const i of b.items) {
      const s = stock.find((x) => x.id === i.id)!;
      await ctx.db.update(inventoryItems).set({ onHand: s.onHand - i.qty }).where(eq(inventoryItems.id, s.id));
    }
    const inv = await createInvoice(ctx.db, { businessId: a.businessId, ownerId: o!.id, category: 'retail', lines });
    return payInvoice(ctx, { businessId: a.businessId, invoiceId: inv.id, pay: b.pay, actor: a.name });
  });
}
