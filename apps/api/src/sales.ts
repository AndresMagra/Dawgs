/**
 * Selling packs and memberships, and the monthly renewal run.
 */

import { and, eq, lte, or, isNull, sql } from 'drizzle-orm';
import { NotFoundError, ValidationError, afterFailedCharge, formatMoney, type BillLine } from '@dawgs/core';
import { dogs, invoices, memberships, owners, packages, paymentMethods } from '@dawgs/db';
import type { AppContext } from './context.js';
import { createInvoice, payInvoice } from './payments.js';
import type { PayInput } from './util.js';
import { audit } from './audit.js';

function creditText(c: Record<string, number | undefined>) {
  const names: Record<string, [string, string]> = {
    daycare: ['daycare day', 'daycare days'],
    night: ['boarding night', 'boarding nights'],
    walk: ['walk', 'walks'],
    bath: ['bath', 'baths'],
    training: ['training session', 'training sessions'],
  };
  return Object.entries(c)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([k, n]) => `${n} ${names[k]![n === 1 ? 0 : 1]}`)
    .join(', ');
}

async function loadDogAndPackage(ctx: AppContext, businessId: string, dogId: string, packageId: string) {
  const [dog] = await ctx.db.select().from(dogs).where(eq(dogs.id, dogId));
  if (!dog || dog.businessId !== businessId) throw new NotFoundError('dog');
  const [pkg] = await ctx.db.select().from(packages).where(eq(packages.id, packageId));
  if (!pkg || pkg.businessId !== businessId || !pkg.active) throw new NotFoundError('package');
  return { dog, pkg };
}

/** A one-off pack. Credits are granted once the invoice is paid. */
export async function sellPackage(
  ctx: AppContext,
  args: { businessId: string; dogId: string; packageId: string; pay: PayInput; actor: string },
) {
  const { dog, pkg } = await loadDogAndPackage(ctx, args.businessId, args.dogId, args.packageId);
  if (pkg.recurring) return startMembership(ctx, args);
  const lines: BillLine[] = [
    { kind: 'service', text: `${pkg.name} for ${dog.name} (${creditText(pkg.credits)})`, amount: pkg.priceCents },
  ];
  const inv = await createInvoice(ctx.db, {
    businessId: args.businessId,
    ownerId: dog.ownerId,
    dogId: dog.id,
    category: 'packages',
    lines,
    fulfilment: { type: 'package', packageId: pkg.id, dogId: dog.id },
  });
  await audit(ctx.db, args.businessId, args.actor, 'package.sell', `${pkg.name} for ${dog.name}, invoice #${inv.number}`);
  return payInvoice(ctx, { businessId: args.businessId, invoiceId: inv.id, pay: args.pay, actor: args.actor });
}

/**
 * Start a monthly membership. The first month is charged now; a card on
 * file is required because later months are charged with nobody present.
 */
export async function startMembership(
  ctx: AppContext,
  args: { businessId: string; dogId: string; packageId: string; pay: PayInput; actor: string },
) {
  const { dog, pkg } = await loadDogAndPackage(ctx, args.businessId, args.dogId, args.packageId);
  if (!pkg.recurring) throw new ValidationError('that package does not renew monthly');
  if (args.pay.method !== 'card') throw new ValidationError('memberships renew on a card, so the first month must be paid by card');
  const cards = await ctx.db.select().from(paymentMethods).where(eq(paymentMethods.ownerId, dog.ownerId));
  if (!cards.length) throw new ValidationError('add a card first; memberships renew on it every month');
  const existing = await ctx.db
    .select()
    .from(memberships)
    .where(and(eq(memberships.dogId, dog.id), eq(memberships.packageId, pkg.id), or(eq(memberships.status, 'active'), eq(memberships.status, 'past_due'))));
  if (existing.length) throw new ValidationError(`${dog.name} already has this membership`);
  const [m] = await ctx.db
    .insert(memberships)
    .values({
      businessId: args.businessId,
      dogId: dog.id,
      ownerId: dog.ownerId,
      packageId: pkg.id,
      status: 'past_due',
      currentPeriodEnd: new Date(ctx.now()),
    })
    .returning();
  const out = await chargeMembershipMonth(ctx, m!.id, args.actor, args.pay);
  if (!out.paid) {
    // A first month that fails is not a membership; don't leave it to retry.
    await ctx.db.update(memberships).set({ status: 'cancelled', cancelledAt: new Date(ctx.now()) }).where(eq(memberships.id, m!.id));
  }
  return { ...out, membershipId: m!.id };
}

async function chargeMembershipMonth(ctx: AppContext, membershipId: string, actor: string, pay?: PayInput) {
  const [m] = await ctx.db.select().from(memberships).where(eq(memberships.id, membershipId));
  if (!m) throw new NotFoundError('membership');
  const [pkg] = await ctx.db.select().from(packages).where(eq(packages.id, m.packageId));
  const [dog] = await ctx.db.select().from(dogs).where(eq(dogs.id, m.dogId));
  // A retry pays the month's invoice that is already open instead of piling up a new one each time.
  const [openInv] = await ctx.db
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.ownerId, m.ownerId),
        eq(invoices.status, 'open'),
        isNull(invoices.fulfilledAt),
        sql`${invoices.fulfilment}->>'membershipId' = ${m.id}`,
      ),
    );
  const inv = openInv ?? await createInvoice(ctx.db, {
    businessId: m.businessId,
    ownerId: m.ownerId,
    dogId: m.dogId,
    category: 'packages',
    lines: [{ kind: 'service', text: `${pkg!.name} for ${dog!.name}, monthly (${creditText(pkg!.credits)})`, amount: pkg!.priceCents }],
    fulfilment: { type: 'membership', membershipId: m.id },
  });
  return payInvoice(ctx, {
    businessId: m.businessId,
    invoiceId: inv.id,
    pay: pay ?? { method: 'card' },
    actor,
    idempotencyKey: `mem-${m.id}-${inv.id}-${m.failures}`,
  });
}

export async function cancelMembership(ctx: AppContext, args: { businessId: string; membershipId: string; actor: string; ownerId?: string }) {
  const [m] = await ctx.db.select().from(memberships).where(eq(memberships.id, args.membershipId));
  if (!m || m.businessId !== args.businessId || (args.ownerId && m.ownerId !== args.ownerId)) throw new NotFoundError('membership');
  await ctx.db.update(memberships).set({ status: 'cancelled', cancelledAt: new Date(ctx.now()) }).where(eq(memberships.id, m.id));
  await audit(ctx.db, args.businessId, args.actor, 'membership.cancel', `Membership cancelled`);
  return { ok: true };
}

/**
 * The scheduler's renewal pass: charge memberships whose month has ended and
 * retry past-due ones on the core schedule (every 3 days, cancel after 4).
 */
export async function runMemberships(ctx: AppContext) {
  const now = new Date(ctx.now());
  const due = await ctx.db
    .select()
    .from(memberships)
    .where(
      or(
        and(eq(memberships.status, 'active'), lte(memberships.currentPeriodEnd, now)),
        and(eq(memberships.status, 'past_due'), or(isNull(memberships.nextAttemptAt), lte(memberships.nextAttemptAt, now))),
      ),
    );
  const results: { membershipId: string; outcome: 'renewed' | 'retry' | 'cancelled' }[] = [];
  for (const m of due) {
    let out;
    try {
      out = await chargeMembershipMonth(ctx, m.id, 'Monthly renewal');
    } catch (e) {
      out = { paid: false, declined: { message: String((e as Error).message), code: null } };
    }
    if (out.paid) {
      results.push({ membershipId: m.id, outcome: 'renewed' });
      continue;
    }
    const next = afterFailedCharge(m.failures, ctx.now());
    if (next.action === 'cancel') {
      await ctx.db
        .update(memberships)
        .set({ status: 'cancelled', failures: next.failures, cancelledAt: now, nextAttemptAt: null })
        .where(eq(memberships.id, m.id));
      results.push({ membershipId: m.id, outcome: 'cancelled' });
    } else {
      await ctx.db
        .update(memberships)
        .set({ status: 'past_due', failures: next.failures, nextAttemptAt: new Date(next.nextAttemptAt) })
        .where(eq(memberships.id, m.id));
      results.push({ membershipId: m.id, outcome: 'retry' });
    }
    const [o] = await ctx.db.select().from(owners).where(eq(owners.id, m.ownerId));
    await audit(
      ctx.db,
      m.businessId,
      'Monthly renewal',
      'membership.failed',
      `${o?.name ?? 'Owner'}: membership charge failed (${next.failures} of 4)${next.action === 'cancel' ? ', membership cancelled' : ''}`,
    );
  }
  return results;
}

export { formatMoney };
