/**
 * What a paid invoice hands over: credits for a pack, or a membership month.
 *
 * Runs when an invoice becomes paid, however it got paid (card at the desk,
 * the customer app, a pay link, a webhook arriving twice). `fulfilledAt` is
 * set in the same UPDATE that claims the work, so it happens exactly once.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { creditGrants, invoices, memberships, packages, trainingEnrollments } from '@dawgs/db';
import { CREDIT_KINDS, emptyWallet, addOneMonth, renewCredits, type Wallet } from '@dawgs/core';
import type { AppContext } from './context.js';
import { grantCredits } from './credits.js';

export async function fulfilInvoice(ctx: AppContext, invoiceId: string) {
  const [inv] = await ctx.db
    .update(invoices)
    .set({ fulfilledAt: new Date(ctx.now()) })
    .where(and(eq(invoices.id, invoiceId), isNull(invoices.fulfilledAt)))
    .returning();
  if (!inv?.fulfilment) return;
  const f = inv.fulfilment;
  const now = ctx.now();

  if (f.type === 'package') {
    const [pkg] = await ctx.db.select().from(packages).where(eq(packages.id, f.packageId));
    if (!pkg) return;
    await grantCredits(ctx.db, {
      businessId: inv.businessId,
      dogId: f.dogId,
      credits: pkg.credits,
      expiresAt: pkg.expiresDays ? new Date(now + pkg.expiresDays * 86_400_000) : null,
      packageId: pkg.id,
      invoiceId: inv.id,
    });
    return;
  }

  if (f.type === 'training') {
    await ctx.db.update(trainingEnrollments).set({ status: 'enrolled' }).where(eq(trainingEnrollments.id, f.enrollmentId));
    return;
  }

  const [m] = await ctx.db.select().from(memberships).where(eq(memberships.id, f.membershipId));
  if (!m) return;
  const [pkg] = await ctx.db.select().from(packages).where(eq(packages.id, m.packageId));
  if (!pkg) return;
  // Roll over what is left of the membership's previous grants, capped by the plan.
  const prior = await ctx.db
    .select()
    .from(creditGrants)
    .where(eq(creditGrants.membershipId, m.id));
  const left: Partial<Wallet> = {};
  for (const g of prior) for (const k of CREDIT_KINDS) left[k] = (left[k] ?? 0) + (g.remaining[k] ?? 0);
  for (const g of prior) {
    await ctx.db
      .update(creditGrants)
      .set({ remaining: emptyWallet() })
      .where(eq(creditGrants.id, g.id));
  }
  const credits = renewCredits({ credits: pkg.credits, rolloverMax: pkg.rolloverMax }, left);
  const periodEnd = addOneMonth(Math.max(now, m.currentPeriodEnd.getTime()));
  await grantCredits(ctx.db, {
    businessId: inv.businessId,
    dogId: m.dogId,
    credits,
    // Membership credits last until the next renewal plus a day's grace.
    expiresAt: new Date(periodEnd + 86_400_000),
    packageId: pkg.id,
    membershipId: m.id,
    invoiceId: inv.id,
  });
  await ctx.db
    .update(memberships)
    .set({ status: 'active', failures: 0, nextAttemptAt: null, currentPeriodEnd: new Date(periodEnd) })
    .where(eq(memberships.id, m.id));
}
