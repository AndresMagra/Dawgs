/**
 * Demo daycare for development and showing the apps: the same names as the
 * prototype. Development only; the production entry never seeds.
 */

import { eq } from 'drizzle-orm';
import { addLocalDays, dateKeyToInstant, localDateKey, type Wallet } from '@dawgs/core';
import {
  businesses,
  dogs,
  owners,
  packages,
  trainingPrograms,
  users,
  vaccines,
  waiverSignatures,
  waivers,
  type Database,
} from '@dawgs/db';
import { createDaycare } from './daycares.js';
import { hashPassword } from './crypto.js';
import { grantCredits } from './credits.js';
import { sha256 } from './routes/manage.js';

export const DEMO_PASSWORD = 'dawgs-demo-2026';
export const DEMO_SLUG = 'happy-tails';

export async function seedDemo(db: Database, now: number) {
  const [existing] = await db.select().from(businesses).where(eq(businesses.slug, DEMO_SLUG));
  if (existing) return existing;
  const { business } = await createDaycare(db, {
    name: 'Happy Tails Dog Daycare',
    slug: DEMO_SLUG,
    managerName: 'Priya',
    managerEmail: 'priya@happytails.test',
    managerPassword: DEMO_PASSWORD,
    plan: 'free',
    now,
  });
  const businessId = business.id;
  await db.update(businesses).set({ phone: '(555) 300-1000', address: '12 Elm Street' }).where(eq(businesses.id, businessId));

  const staff = [
    ['Jess', 'jess@happytails.test', 'Front desk', 1850],
    ['Marco', 'marco@happytails.test', 'Handler', 1700],
    ['Tasha', 'tasha@happytails.test', 'Trainer', 1750],
    ['Leo', 'leo@happytails.test', 'Kennel attendant', 1600],
  ] as const;
  const staffRows = await db
    .insert(users)
    .values(
      staff.map(([name, email, jobTitle, rate]) => ({
        businessId,
        role: 'staff' as const,
        name,
        email,
        jobTitle,
        payRateCents: rate,
        passwordHash: hashPassword(DEMO_PASSWORD),
      })),
    )
    .returning();
  const tasha = staffRows.find((u) => u.name === 'Tasha')!;

  const tz = business.timezone;
  const today = localDateKey(now, tz);
  const inYears = (n: number) => dateKeyToInstant(addLocalDays(today, Math.round(n * 365)), tz);

  const people: [string, string, string, [string, string, number, Partial<Wallet>][]][] = [
    ['Dana Whitfield', 'dana@example.com', '(555) 201-4410', [['Biscuit', 'Golden Retriever', 68, { daycare: 6 }]]],
    ['Sam Ortiz', 'sam@example.com', '(555) 201-7720', [['Luna', 'Border Collie', 41, {}], ['Pepper', 'Beagle', 24, { bath: 1 }]]],
    ['Alex Chen', 'alex@example.com', '(555) 201-3301', [['Mochi', 'Shiba Inu', 22, { daycare: 12, walk: 2 }]]],
    ['Jordan Lee', 'jordan@example.com', '(555) 201-9902', [['Bruno', 'Boxer', 70, { night: 2 }]]],
    ['Riley Park', 'riley@example.com', '(555) 201-5503', [['Olive', 'Cavapoo', 16, {}]]],
  ];
  const [form] = await db.select().from(waivers).where(eq(waivers.businessId, businessId));
  for (const [name, email, phone, ds] of people) {
    const [o] = await db.insert(owners).values({ businessId, name, email, phone }).returning();
    await db.insert(users).values({
      businessId,
      role: 'owner',
      name,
      email,
      phone,
      ownerId: o!.id,
      passwordHash: hashPassword(DEMO_PASSWORD),
    });
    await db.insert(waiverSignatures).values({
      businessId,
      waiverId: form!.id,
      version: form!.version,
      ownerId: o!.id,
      title: form!.title,
      bodySigned: form!.body,
      bodySha256: sha256(form!.body),
      signedName: name,
      collectedBy: 'Seeded demo',
      signedAt: new Date(now),
    });
    for (const [dogName, breed, weightLb, credits] of ds) {
      const [d] = await db
        .insert(dogs)
        .values({
          businessId,
          ownerId: o!.id,
          name: dogName,
          breed,
          weightLb,
          birthDate: addLocalDays(today, -365 * 3),
          feeding: dogName === 'Biscuit' ? '1 cup kibble at noon' : null,
          allergies: dogName === 'Pepper' ? ['Chicken'] : [],
          behaviour: dogName === 'Bruno' ? { leashReactive: true } : {},
        })
        .returning();
      for (const v of ['Rabies', 'DHPP', 'Bordetella']) {
        await db.insert(vaccines).values({
          businessId,
          dogId: d!.id,
          name: v,
          expiresAt: new Date(inYears(v === 'Bordetella' ? 0.4 : 2)),
          verifiedBy: 'Seeded demo',
        });
      }
      if (Object.keys(credits).length) await grantCredits(db, { businessId, dogId: d!.id, credits, note: 'Demo credits' });
    }
  }

  await db.insert(packages).values([
    { businessId, name: '10-day daycare pack', credits: { daycare: 10 }, priceCents: 36000, expiresDays: 120 },
    { businessId, name: '20-day daycare pack', credits: { daycare: 20 }, priceCents: 68000, expiresDays: 180, badge: 'Best value' },
    { businessId, name: '5-night boarding pack', credits: { night: 5 }, priceCents: 27500, expiresDays: 365 },
    { businessId, name: 'Unlimited-ish monthly (12 days)', credits: { daycare: 12, bath: 1 }, priceCents: 39900, recurring: true, rolloverMax: 2 },
    { businessId, name: '4 private lessons', credits: { training: 4 }, priceCents: 30000, expiresDays: 180 },
  ]);
  await db.insert(trainingPrograms).values([
    {
      businessId,
      name: 'Puppy Basics',
      description: 'Six weekly classes for puppies 10 weeks to 6 months.',
      kind: 'class',
      sessionCount: 6,
      sessionMinutes: 60,
      capacity: 8,
      priceCents: 21000,
      trainerId: tasha.id,
      skills: ['Name response', 'Sit', 'Down', 'Come', 'Leave it', 'Loose-leash walking'],
    },
    {
      businessId,
      name: 'Private lesson',
      description: 'One-on-one with a trainer, 45 minutes.',
      kind: 'private',
      sessionMinutes: 45,
      priceCents: 8500,
      trainerId: tasha.id,
      skills: ['Leash manners', 'Recall', 'Greeting politely'],
    },
  ]);
  return business;
}
