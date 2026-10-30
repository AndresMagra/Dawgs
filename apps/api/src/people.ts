/**
 * Owners and dogs: the records everything else hangs off.
 *
 * Shared by the staff routes and the customer routes so both apps show the
 * same vaccine status, the same flags and the same credit balance.
 */

import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  vaccineStatuses,
  vaccinesAllowEntry,
  worstVaccineState,
  type Wallet,
} from '@dawgs/core';
import {
  businesses,
  dogs,
  owners,
  paymentMethods,
  vaccines,
  visits,
  waiverSignatures,
  waivers,
  type Database,
} from '@dawgs/db';
import { walletsOf } from './credits.js';

export type DogRow = typeof dogs.$inferSelect;

export interface Flag {
  tone: 'bad' | 'warn' | 'info' | 'ok' | '';
  text: string;
}

export function dogFlags(d: DogRow, wallet: Wallet, now: number): Flag[] {
  const f: Flag[] = [];
  for (const a of d.allergies) f.push({ tone: 'bad', text: `Allergy: ${a}` });
  if (d.medications.length) f.push({ tone: 'info', text: 'Meds' });
  if (d.behaviour.escapeRisk) f.push({ tone: 'warn', text: 'Escape risk' });
  if (d.behaviour.leashReactive) f.push({ tone: 'warn', text: 'Leash reactive' });
  if (d.behaviour.eatsAlone) f.push({ tone: '', text: 'Eats alone' });
  if (d.birthDate && now - Date.parse(d.birthDate) >= 10 * 365.25 * 86_400_000) f.push({ tone: '', text: 'Senior' });
  if (wallet.daycare) f.push({ tone: 'ok', text: `${wallet.daycare} day credits` });
  if (wallet.night) f.push({ tone: 'ok', text: `${wallet.night} night credits` });
  if (wallet.walk) f.push({ tone: 'ok', text: `${wallet.walk} walk credits` });
  if (wallet.bath) f.push({ tone: 'ok', text: `${wallet.bath} bath credits` });
  if (wallet.training) f.push({ tone: 'ok', text: `${wallet.training} training credits` });
  return f;
}

/**
 * Dogs with everything a list or a board needs, in a fixed number of queries
 * however many dogs there are.
 */
export async function dogSummaries(db: Database, businessId: string, dogIds: readonly string[] | null, now: number) {
  const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));
  const rows = await db
    .select({ dog: dogs, owner: owners })
    .from(dogs)
    .innerJoin(owners, eq(owners.id, dogs.ownerId))
    .where(
      dogIds
        ? and(eq(dogs.businessId, businessId), inArray(dogs.id, dogIds.length ? [...dogIds] : ['00000000-0000-0000-0000-000000000000']))
        : eq(dogs.businessId, businessId),
    )
    .orderBy(dogs.name);
  const ids = rows.map((r) => r.dog.id);
  const shots = ids.length ? await db.select().from(vaccines).where(inArray(vaccines.dogId, ids)) : [];
  const wallets = await walletsOf(db, ids, now);
  const last = ids.length
    ? await db
        .select({
          dogId: visits.dogId,
          last: sql<Date>`max(${visits.checkedInAt})`,
          count: sql<number>`count(*)::int`,
        })
        .from(visits)
        .where(inArray(visits.dogId, ids))
        .groupBy(visits.dogId)
    : [];
  const lastBy = new Map(last.map((l) => [l.dogId, l]));
  const ownerIds = [...new Set(rows.map((r) => r.owner.id))];
  const cards = ownerIds.length
    ? await db.select().from(paymentMethods).where(inArray(paymentMethods.ownerId, ownerIds))
    : [];
  const missingWaivers = await waiversMissingByOwner(db, businessId, ownerIds, ids);

  return rows.map(({ dog, owner }) => {
    // Only records staff have checked count; an owner's upload waits for a look.
    const mine = shots.filter((s) => s.dogId === dog.id);
    const status = vaccineStatuses(
      mine.filter((s) => s.verifiedBy).map((s) => ({ name: s.name, expiresAt: s.expiresAt.getTime() })),
      now,
      biz!.requiredVaccines,
    );
    const wallet = wallets.get(dog.id)!;
    const l = lastBy.get(dog.id);
    const card = cards.find((c) => c.ownerId === owner.id && c.isDefault) ?? cards.find((c) => c.ownerId === owner.id);
    const waiversMissing = [
      ...(missingWaivers.byOwner.get(owner.id) ?? []),
      ...(missingWaivers.byDog.get(dog.id) ?? []),
    ];
    return {
      ...dog,
      owner: { id: owner.id, name: owner.name, phone: owner.phone, email: owner.email },
      vaccines: status,
      vaccineState: worstVaccineState(status),
      vaccinesAwaitingReview: mine.filter((s) => !s.verifiedBy).length,
      canEnter: vaccinesAllowEntry(status) && waiversMissing.length === 0,
      waiversMissing,
      wallet,
      flags: dogFlags(dog, wallet, now),
      lastVisitAt: l?.last ? new Date(l.last).getTime() : null,
      visitCount: l?.count ?? 0,
      card: card ? { id: card.id, brand: card.brand, last4: card.last4 } : null,
    };
  });
}

export type DogSummary = Awaited<ReturnType<typeof dogSummaries>>[number];

/**
 * Required waivers each owner (and each dog, for per-dog forms) has not
 * signed at the CURRENT version. A new version of a form asks everyone again.
 */
export async function waiversMissingByOwner(
  db: Database,
  businessId: string,
  ownerIds: readonly string[],
  dogIds: readonly string[],
) {
  const byOwner = new Map<string, string[]>();
  const byDog = new Map<string, string[]>();
  const forms = await db
    .select()
    .from(waivers)
    .where(and(eq(waivers.businessId, businessId), eq(waivers.active, true), eq(waivers.required, true)));
  if (!forms.length || !ownerIds.length) return { byOwner, byDog };
  const sigs = await db
    .select()
    .from(waiverSignatures)
    .where(and(eq(waiverSignatures.businessId, businessId), inArray(waiverSignatures.ownerId, [...ownerIds])));
  const signed = new Set(sigs.map((s) => `${s.waiverId}:${s.version}:${s.ownerId}:${s.dogId ?? ''}`));
  for (const f of forms) {
    if (f.scope === 'owner') {
      for (const o of ownerIds) {
        if (!signed.has(`${f.id}:${f.version}:${o}:`)) byOwner.set(o, [...(byOwner.get(o) ?? []), f.title]);
      }
    }
  }
  if (dogIds.length) {
    const dogOwners = await db
      .select({ id: dogs.id, ownerId: dogs.ownerId })
      .from(dogs)
      .where(inArray(dogs.id, [...dogIds]));
    for (const f of forms.filter((x) => x.scope === 'dog')) {
      for (const d of dogOwners) {
        if (!signed.has(`${f.id}:${f.version}:${d.ownerId}:${d.id}`)) byDog.set(d.id, [...(byDog.get(d.id) ?? []), f.title]);
      }
    }
  }
  return { byOwner, byDog };
}

export async function ownerCards(db: Database, ownerId: string) {
  const rows = await db.select().from(paymentMethods).where(eq(paymentMethods.ownerId, ownerId));
  return rows.map((c) => ({
    id: c.id,
    brand: c.brand,
    last4: c.last4,
    expMonth: c.expMonth,
    expYear: c.expYear,
    isDefault: c.isDefault,
  }));
}

export async function lastVisits(db: Database, dogId: string, limit = 20) {
  return db
    .select()
    .from(visits)
    .where(and(eq(visits.dogId, dogId), isNotNull(visits.checkedInAt)))
    .orderBy(desc(visits.checkedInAt))
    .limit(limit);
}
