/**
 * A dog's prepaid credits, kept as grants so expiry is exact.
 *
 * Each pack or membership month is a grant with its own expiry and what is
 * left of it. The wallet a screen shows is the sum of unexpired grants, and a
 * visit spends from the grant that expires soonest — the order an owner would
 * want, since it wastes nothing.
 */

import { and, asc, eq, gt, isNull, or } from 'drizzle-orm';
import { CREDIT_KINDS, emptyWallet, type CreditKind, type Wallet } from '@dawgs/core';
import { creditGrants, type Database } from '@dawgs/db';

function live(dogId: string, now: number) {
  return and(
    eq(creditGrants.dogId, dogId),
    or(isNull(creditGrants.expiresAt), gt(creditGrants.expiresAt, new Date(now))),
  );
}

export async function walletOf(db: Database, dogId: string, now: number): Promise<Wallet> {
  const grants = await db.select().from(creditGrants).where(live(dogId, now));
  const w = emptyWallet();
  for (const g of grants) for (const k of CREDIT_KINDS) w[k] += g.remaining[k] ?? 0;
  return w;
}

export async function walletsOf(db: Database, dogIds: readonly string[], now: number): Promise<Map<string, Wallet>> {
  const out = new Map<string, Wallet>();
  for (const id of dogIds) out.set(id, emptyWallet());
  if (dogIds.length === 0) return out;
  const grants = await db
    .select()
    .from(creditGrants)
    .where(or(isNull(creditGrants.expiresAt), gt(creditGrants.expiresAt, new Date(now))));
  for (const g of grants) {
    const w = out.get(g.dogId);
    if (!w) continue;
    for (const k of CREDIT_KINDS) w[k] += g.remaining[k] ?? 0;
  }
  return out;
}

export async function grantCredits(
  db: Database,
  args: {
    businessId: string;
    dogId: string;
    credits: Partial<Wallet>;
    expiresAt?: Date | null;
    packageId?: string | null;
    membershipId?: string | null;
    invoiceId?: string | null;
    note?: string | null;
  },
) {
  const remaining = emptyWallet();
  for (const k of CREDIT_KINDS) remaining[k] = args.credits[k] ?? 0;
  const [g] = await db
    .insert(creditGrants)
    .values({
      businessId: args.businessId,
      dogId: args.dogId,
      credits: args.credits,
      remaining,
      expiresAt: args.expiresAt ?? null,
      packageId: args.packageId ?? null,
      membershipId: args.membershipId ?? null,
      invoiceId: args.invoiceId ?? null,
      note: args.note ?? null,
    })
    .returning();
  return g!;
}

/** Spend credits soonest-expiring first. Throws if the dog does not have them. */
export async function spendCredits(db: Database, dogId: string, spend: Partial<Wallet>, now: number) {
  const grants = await db
    .select()
    .from(creditGrants)
    .where(live(dogId, now))
    .orderBy(asc(creditGrants.expiresAt), asc(creditGrants.createdAt));
  // Postgres sorts NULL last in ascending order: grants that never expire are spent last.
  const need: Record<CreditKind, number> = { ...emptyWallet() };
  for (const k of CREDIT_KINDS) need[k] = spend[k] ?? 0;
  for (const g of grants) {
    let changed = false;
    const rem = { ...emptyWallet(), ...g.remaining };
    for (const k of CREDIT_KINDS) {
      const take = Math.min(need[k], rem[k]);
      if (take > 0) {
        rem[k] -= take;
        need[k] -= take;
        changed = true;
      }
    }
    if (changed) await db.update(creditGrants).set({ remaining: rem }).where(eq(creditGrants.id, g.id));
  }
  for (const k of CREDIT_KINDS) if (need[k] > 0) throw new Error(`not enough ${k} credits`);
}
