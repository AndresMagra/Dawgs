/**
 * Invoices and the money that settles them.
 *
 * Every sale — a visit at check-out, a pack, a membership month, a walk, a
 * retail item — becomes an invoice with lines, then is paid by a saved card,
 * cash, or a pay link the owner opens on their phone. A declined card leaves
 * the invoice open with the decline recorded; nothing is lost and the desk
 * can try another card.
 *
 * Ported from MeDu's online-payments.ts: pay links store only a token hash,
 * webhooks are verified before they are believed, and a payment intent is
 * recorded at most once however many times its webhook arrives.
 */

import { and, desc, eq, max, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { NotFoundError, PaymentError, ValidationError, type BillLine, formatMoney } from '@dawgs/core';
import {
  businesses,
  invoices,
  owners,
  paymentLinks,
  paymentMethods,
  payments,
  type Database,
  type Fulfilment,
} from '@dawgs/db';
import type { AppContext } from './context.js';
import type { PayInput } from './util.js';
import { hashToken } from './crypto.js';
import { audit } from './audit.js';
import { fulfilInvoice } from './fulfil.js';

export type InvoiceCategory = (typeof invoices.$inferSelect)['category'];

export async function createInvoice(
  db: Database,
  args: {
    businessId: string;
    ownerId: string;
    dogId?: string | null;
    visitId?: string | null;
    category: InvoiceCategory;
    lines: BillLine[];
    fulfilment?: Fulfilment | null;
  },
) {
  const total = args.lines.reduce((s, l) => s + l.amount, 0);
  if (total < 0) throw new ValidationError('an invoice cannot total less than zero');
  // Numbers are per business and gapless enough for a front desk; the unique
  // index turns a race between two tills into a retry instead of a duplicate.
  for (let attempt = 0; ; attempt++) {
    const [{ n }] = (await db
      .select({ n: max(invoices.number) })
      .from(invoices)
      .where(eq(invoices.businessId, args.businessId))) as [{ n: number | null }];
    try {
      const [inv] = await db
        .insert(invoices)
        .values({
          businessId: args.businessId,
          number: (n ?? 1000) + 1,
          ownerId: args.ownerId,
          dogId: args.dogId ?? null,
          visitId: args.visitId ?? null,
          category: args.category,
          lines: args.lines,
          fulfilment: args.fulfilment ?? null,
          totalCents: total,
          // Even a $0 invoice starts open: payInvoice settles it, which is
          // also what runs its fulfilment.
          status: 'open',
        })
        .returning();
      return inv!;
    } catch (e) {
      if (attempt < 3 && String(e).includes('invoices_number')) continue;
      throw e;
    }
  }
}

export async function paidSoFar(db: Database, invoiceId: string): Promise<number> {
  const [r] = await db
    .select({ s: sql<number>`coalesce(sum(${payments.amountCents} - ${payments.refundedCents}), 0)::int` })
    .from(payments)
    .where(and(eq(payments.invoiceId, invoiceId), eq(payments.status, 'succeeded')));
  return r?.s ?? 0;
}

async function loadInvoice(db: Database, businessId: string, invoiceId: string) {
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!inv || inv.businessId !== businessId) throw new NotFoundError('invoice');
  return inv;
}

export async function ensureStripeCustomer(ctx: AppContext, ownerId: string): Promise<string> {
  const [o] = await ctx.db.select().from(owners).where(eq(owners.id, ownerId));
  if (!o) throw new NotFoundError('owner');
  if (o.stripeCustomerId) return o.stripeCustomerId;
  const gw = await ctx.gatewayFor(o.businessId);
  const id = await gw.createCustomer({ name: o.name, email: o.email, phone: o.phone, ownerId: o.id });
  await ctx.db.update(owners).set({ stripeCustomerId: id }).where(eq(owners.id, ownerId));
  return id;
}

/** Save a card the app confirmed with Stripe's UI. The first card becomes the default. */
export async function saveCard(ctx: AppContext, businessId: string, ownerId: string, stripePaymentMethodId: string) {
  const customerId = await ensureStripeCustomer(ctx, ownerId);
  const gw = await ctx.gatewayFor(businessId);
  const pm = await gw.retrievePaymentMethod(stripePaymentMethodId);
  if (pm.customerId && pm.customerId !== customerId) throw new ValidationError('that card belongs to someone else');
  if (!pm.customerId) await gw.attachPaymentMethod(stripePaymentMethodId, customerId);
  const existing = await ctx.db.select().from(paymentMethods).where(eq(paymentMethods.ownerId, ownerId));
  const dup = existing.find((c) => c.stripePaymentMethodId === stripePaymentMethodId);
  if (dup) return dup;
  const [row] = await ctx.db
    .insert(paymentMethods)
    .values({
      businessId,
      ownerId,
      stripePaymentMethodId,
      brand: pm.brand,
      last4: pm.last4,
      expMonth: pm.expMonth,
      expYear: pm.expYear,
      isDefault: existing.length === 0,
    })
    .returning();
  return row!;
}

export async function removeCard(ctx: AppContext, ownerId: string, cardId: string) {
  const [c] = await ctx.db.select().from(paymentMethods).where(eq(paymentMethods.id, cardId));
  if (!c || c.ownerId !== ownerId) throw new NotFoundError('card');
  const gw = await ctx.gatewayFor(c.businessId);
  await gw.detachPaymentMethod(c.stripePaymentMethodId).catch(() => undefined);
  await ctx.db.delete(paymentMethods).where(eq(paymentMethods.id, cardId));
  if (c.isDefault) {
    const [next] = await ctx.db.select().from(paymentMethods).where(eq(paymentMethods.ownerId, ownerId)).limit(1);
    if (next) await ctx.db.update(paymentMethods).set({ isDefault: true }).where(eq(paymentMethods.id, next.id));
  }
}

export async function setDefaultCard(ctx: AppContext, ownerId: string, cardId: string) {
  const [c] = await ctx.db.select().from(paymentMethods).where(eq(paymentMethods.id, cardId));
  if (!c || c.ownerId !== ownerId) throw new NotFoundError('card');
  await ctx.db.update(paymentMethods).set({ isDefault: false }).where(eq(paymentMethods.ownerId, ownerId));
  await ctx.db.update(paymentMethods).set({ isDefault: true }).where(eq(paymentMethods.id, cardId));
}

export const cardLabel = (c: { brand: string; last4: string }) =>
  `${c.brand.charAt(0).toUpperCase()}${c.brand.slice(1)} •••• ${c.last4}`;

async function markPaidIfSettled(ctx: AppContext, invoiceId: string, total: number) {
  if ((await paidSoFar(ctx.db, invoiceId)) >= total) {
    await ctx.db.update(invoices).set({ status: 'paid', paidAt: new Date(ctx.now()) }).where(eq(invoices.id, invoiceId));
    await fulfilInvoice(ctx, invoiceId);
    return true;
  }
  return false;
}

export interface PayOutcome {
  invoice: typeof invoices.$inferSelect;
  paid: boolean;
  /** Present when a card was declined. */
  declined?: { message: string; code: string | null };
}

/**
 * Settle an open invoice. `later` leaves it open (for a pay link or the
 * owner's app). A declined card is not an exception: the caller gets the
 * decline to show, and the attempt is kept in the payment history.
 */
export async function payInvoice(
  ctx: AppContext,
  args: { businessId: string; invoiceId: string; pay: PayInput; actor: string; idempotencyKey?: string },
): Promise<PayOutcome> {
  const inv = await loadInvoice(ctx.db, args.businessId, args.invoiceId);
  if (inv.status === 'paid') return { invoice: inv, paid: true };
  if (inv.status !== 'open') throw new ValidationError(`invoice is ${inv.status}`);
  const due = inv.totalCents - (await paidSoFar(ctx.db, inv.id));
  if (args.pay.method === 'later' || due <= 0) {
    const paid = due <= 0 ? await markPaidIfSettled(ctx, inv.id, inv.totalCents) : false;
    return { invoice: await loadInvoice(ctx.db, args.businessId, inv.id), paid };
  }

  if (args.pay.method === 'cash') {
    await ctx.db.insert(payments).values({
      businessId: inv.businessId,
      invoiceId: inv.id,
      ownerId: inv.ownerId,
      method: 'cash',
      amountCents: due,
      status: 'succeeded',
      takenBy: args.actor,
    });
    await markPaidIfSettled(ctx, inv.id, inv.totalCents);
    await audit(ctx.db, inv.businessId, args.actor, 'payment.cash', `Invoice #${inv.number}: ${formatMoney(due)} cash`);
    return { invoice: await loadInvoice(ctx.db, args.businessId, inv.id), paid: true };
  }

  const cards = await ctx.db.select().from(paymentMethods).where(eq(paymentMethods.ownerId, inv.ownerId));
  const card = args.pay.paymentMethodId
    ? cards.find((c) => c.id === (args.pay as { paymentMethodId: string }).paymentMethodId)
    : (cards.find((c) => c.isDefault) ?? cards[0]);
  if (!card) throw new PaymentError('no card on file for this owner');
  const customerId = await ensureStripeCustomer(ctx, inv.ownerId);
  const attempt = (await ctx.db.select({ id: payments.id }).from(payments).where(eq(payments.invoiceId, inv.id))).length;
  const gw = await ctx.gatewayFor(inv.businessId);
  const result = await gw.chargeSavedCard({
    customerId,
    paymentMethodId: card.stripePaymentMethodId,
    amountCents: due,
    description: `Invoice #${inv.number}`,
    metadata: { invoiceId: inv.id, businessId: inv.businessId },
    idempotencyKey: args.idempotencyKey ?? `inv-${inv.id}-${attempt}`,
  });
  await ctx.db.insert(payments).values({
    businessId: inv.businessId,
    invoiceId: inv.id,
    ownerId: inv.ownerId,
    method: 'card',
    amountCents: due,
    feeCents: result.ok ? result.feeCents : 0,
    stripePaymentIntentId: result.paymentIntentId,
    cardLabel: cardLabel(card),
    status: result.ok ? 'succeeded' : 'failed',
    failureMessage: result.ok ? null : result.message,
    takenBy: args.actor,
  });
  if (!result.ok) {
    await audit(ctx.db, inv.businessId, args.actor, 'payment.declined', `Invoice #${inv.number}: ${cardLabel(card)} declined (${result.message})`);
    return { invoice: inv, paid: false, declined: { message: result.message, code: result.declineCode } };
  }
  await markPaidIfSettled(ctx, inv.id, inv.totalCents);
  await audit(ctx.db, inv.businessId, args.actor, 'payment.card', `Invoice #${inv.number}: ${formatMoney(due)} on ${cardLabel(card)}`);
  return { invoice: await loadInvoice(ctx.db, args.businessId, inv.id), paid: true };
}

/** Refund part or all of a card or cash payment. Card refunds go back through Stripe. */
export async function refundPayment(
  ctx: AppContext,
  args: { businessId: string; paymentId: string; amountCents: number; actor: string },
) {
  const [p] = await ctx.db.select().from(payments).where(eq(payments.id, args.paymentId));
  if (!p || p.businessId !== args.businessId || p.status !== 'succeeded') throw new NotFoundError('payment');
  const refundable = p.amountCents - p.refundedCents;
  if (args.amountCents <= 0 || args.amountCents > refundable)
    throw new ValidationError(`can refund up to ${formatMoney(refundable)}`);
  if (p.method !== 'cash' && p.stripePaymentIntentId) {
    await (await ctx.gatewayFor(p.businessId)).refund({ paymentIntentId: p.stripePaymentIntentId, amountCents: args.amountCents });
  }
  await ctx.db
    .update(payments)
    .set({ refundedCents: p.refundedCents + args.amountCents })
    .where(eq(payments.id, p.id));
  const inv = await loadInvoice(ctx.db, args.businessId, p.invoiceId);
  const net = await paidSoFar(ctx.db, inv.id);
  await ctx.db
    .update(invoices)
    .set({ status: net <= 0 ? 'refunded' : 'partially_refunded' })
    .where(eq(invoices.id, inv.id));
  await audit(ctx.db, args.businessId, args.actor, 'payment.refund', `Invoice #${inv.number}: refunded ${formatMoney(args.amountCents)}`);
  return { refundedCents: args.amountCents };
}

// ─── Pay links ──────────────────────────────────────────────────────────────

export const LINK_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export async function createPayLink(ctx: AppContext, businessId: string, invoiceId: string) {
  const inv = await loadInvoice(ctx.db, businessId, invoiceId);
  if (inv.status !== 'open') throw new ValidationError('invoice is not open');
  const token = randomBytes(18).toString('base64url');
  await ctx.db.insert(paymentLinks).values({
    businessId,
    invoiceId,
    tokenHash: hashToken(token),
    expiresAt: new Date(ctx.now() + LINK_TTL_MS),
  });
  const url = ctx.publicUrl ? `${ctx.publicUrl.replace(/\/$/, '')}/pay/${token}` : null;
  return { token, url, invoice: inv };
}

async function linkByToken(ctx: AppContext, token: string) {
  const [row] = await ctx.db
    .select({ link: paymentLinks, inv: invoices, biz: businesses })
    .from(paymentLinks)
    .innerJoin(invoices, eq(invoices.id, paymentLinks.invoiceId))
    .innerJoin(businesses, eq(businesses.id, invoices.businessId))
    .where(eq(paymentLinks.tokenHash, hashToken(token)));
  if (!row || row.link.expiresAt.getTime() < ctx.now()) throw new NotFoundError('payment link');
  return row;
}

/** What the public pay page shows, plus a payment intent to confirm with Stripe's UI. */
export async function openPayLink(ctx: AppContext, token: string) {
  const { inv, biz } = await linkByToken(ctx, token);
  const due = inv.totalCents - (await paidSoFar(ctx.db, inv.id));
  const gw = await ctx.gatewayFor(inv.businessId);
  const base = {
    business: biz.name,
    brandColor: biz.brandColor,
    logoUrl: biz.logoUrl,
    number: inv.number,
    lines: inv.lines,
    totalCents: inv.totalCents,
    dueCents: Math.max(0, due),
    status: inv.status,
    mode: gw.mode,
    publishableKey: gw.publishableKey,
    stripeAccount: biz.stripeAccountId,
  };
  if (inv.status !== 'open' || due <= 0) return { ...base, clientSecret: null, paymentIntentId: null };
  const customerId = await ensureStripeCustomer(ctx, inv.ownerId);
  const pi = await gw.createPaymentIntent({
    amountCents: due,
    customerId,
    description: `${biz.name} invoice #${inv.number}`,
    metadata: { invoiceId: inv.id, businessId: inv.businessId, via: 'link' },
    saveCard: false,
  });
  return { ...base, clientSecret: pi.clientSecret, paymentIntentId: pi.id };
}

/**
 * Record a payment intent that succeeded outside a till (pay link, customer
 * app checkout). Called by the webhook and by the app's "I'm done" poll;
 * whichever arrives second finds the payment already recorded.
 */
export async function recordIntentSucceeded(ctx: AppContext, businessId: string, paymentIntentId: string) {
  const [already] = await ctx.db
    .select({ id: payments.id })
    .from(payments)
    .where(and(eq(payments.stripePaymentIntentId, paymentIntentId), eq(payments.status, 'succeeded')));
  if (already) return { recorded: false };
  const pi = await (await ctx.gatewayFor(businessId)).retrievePaymentIntent(paymentIntentId);
  if (pi.status !== 'succeeded') return { recorded: false };
  const invoiceId = pi.metadata.invoiceId;
  if (!invoiceId) return { recorded: false };
  const [inv] = await ctx.db.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!inv || inv.businessId !== businessId) return { recorded: false };
  await ctx.db.insert(payments).values({
    businessId: inv.businessId,
    invoiceId: inv.id,
    ownerId: inv.ownerId,
    method: pi.metadata.via === 'link' ? 'link' : 'card',
    amountCents: pi.amountCents,
    feeCents: pi.feeCents,
    stripePaymentIntentId: paymentIntentId,
    cardLabel: pi.card ? cardLabel(pi.card) : null,
    status: 'succeeded',
    takenBy: pi.metadata.via === 'link' ? 'Pay link' : 'Customer app',
  });
  await ctx.db.update(paymentLinks).set({ usedAt: new Date(ctx.now()) }).where(eq(paymentLinks.invoiceId, inv.id));
  await markPaidIfSettled(ctx, inv.id, inv.totalCents);
  await audit(ctx.db, inv.businessId, 'Stripe', 'payment.online', `Invoice #${inv.number}: ${formatMoney(pi.amountCents)} paid online`);
  return { recorded: true, invoiceId: inv.id, metadata: pi.metadata };
}

export async function invoicesFor(db: Database, where: { businessId: string; ownerId?: string }, limit = 100) {
  const cond = where.ownerId
    ? and(eq(invoices.businessId, where.businessId), eq(invoices.ownerId, where.ownerId))
    : eq(invoices.businessId, where.businessId);
  return db.select().from(invoices).where(cond).orderBy(desc(invoices.createdAt)).limit(limit);
}
