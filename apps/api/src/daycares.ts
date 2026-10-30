/**
 * Creating a daycare: the sign-up a new customer of Dawgs goes through, and
 * the starting setup every daycare gets (yards, kennels, prices, a waiver).
 */

import { eq } from 'drizzle-orm';
import { ConflictError, DEFAULT_HOURS, DEFAULT_PRICES, DEFAULT_REQUIRED_VACCINES, ValidationError } from '@dawgs/core';
import { addOns, businesses, kennels, users, waivers, walkTypes, yards, type Database } from '@dawgs/db';
import { hashPassword } from './crypto.js';
import { checkPassword } from './auth.js';

export const TRIAL_DAYS = 30;

export const STARTER_WAIVER = `I am the owner (or authorized agent) of the dog(s) on my account and agree to the following.

1. My dog is in good health, has not been aggressive toward people or other dogs, and is current on the vaccines this daycare requires.
2. Dogs in group play can be injured, even with careful supervision: scratches, bites, sprains, and illness passed between dogs. I accept these risks.
3. If my dog needs urgent care, staff may take my dog to a veterinarian and I will pay the cost. Staff will try to reach me and my emergency contact first.
4. I am responsible for any harm my dog causes to people, other dogs, or property.
5. I release the daycare and its staff from liability for injury, illness, or loss, except where caused by their gross negligence.
6. Photos and video of my dog may be shared with me and, unless I say otherwise, on the daycare's social media.

THIS IS A STARTING TEMPLATE. Have a lawyer in your state review it before use.`;

export function slugify(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

export async function createDaycare(
  db: Database,
  input: {
    name: string;
    slug?: string;
    timezone?: string;
    managerName: string;
    managerEmail: string;
    managerPassword: string;
    plan?: 'free' | 'trial' | 'standard';
    now: number;
  },
) {
  checkPassword(input.managerPassword);
  const slug = input.slug ?? slugify(input.name);
  if (!/^[a-z0-9-]{3,40}$/.test(slug)) throw new ValidationError('the short name may use letters, numbers and dashes');
  const [taken] = await db.select({ id: businesses.id }).from(businesses).where(eq(businesses.slug, slug));
  if (taken) throw new ConflictError('that short name is taken');
  const plan = input.plan ?? 'trial';
  const [b] = await db
    .insert(businesses)
    .values({
      name: input.name,
      slug,
      timezone: input.timezone ?? 'America/New_York',
      prices: DEFAULT_PRICES,
      hours: DEFAULT_HOURS,
      requiredVaccines: [...DEFAULT_REQUIRED_VACCINES],
      plan,
      trialEndsAt: plan === 'trial' ? new Date(input.now + TRIAL_DAYS * 86_400_000) : null,
    })
    .returning();
  const businessId = b!.id;
  const [manager] = await db
    .insert(users)
    .values({
      businessId,
      role: 'manager',
      name: input.managerName,
      email: input.managerEmail.toLowerCase(),
      passwordHash: hashPassword(input.managerPassword),
      jobTitle: 'Owner',
    })
    .returning();
  await db.insert(yards).values([
    { businessId, name: 'Big yard', capacity: 15, note: 'Large, social dogs', sort: 1 },
    { businessId, name: 'Small dog yard', capacity: 10, maxWeightLb: 30, note: 'Under 30 lb', sort: 2 },
    { businessId, name: 'Calm yard', capacity: 6, note: 'Seniors and shy dogs', sort: 3 },
    { businessId, name: 'Nap room', capacity: 12, note: 'Crated rest', sort: 4 },
  ]);
  await db.insert(kennels).values([
    ...[1, 2, 3].map((n) => ({ businessId, name: `Suite ${n}`, type: 'suite' as const, sort: n })),
    ...[1, 2, 3, 4, 5].map((n) => ({ businessId, name: `Run ${n}`, type: 'run' as const, sort: 10 + n })),
  ]);
  await db.insert(addOns).values([
    { businessId, code: 'bath', name: 'Exit bath', priceCents: 2500 },
    { businessId, code: 'nails', name: 'Nail trim', priceCents: 1500 },
    { businessId, code: 'walk', name: 'One-on-one walk', priceCents: 1000 },
    { businessId, code: 'pupcup', name: 'Pup cup', priceCents: 400 },
  ]);
  await db.insert(walkTypes).values([
    { businessId, name: 'Park loop, 20 min', minutes: 20, priceCents: 1500 },
    { businessId, name: 'Neighborhood walk, 30 min', minutes: 30, priceCents: 2000 },
    { businessId, name: 'River walk, 60 min', minutes: 60, priceCents: 3500 },
  ]);
  await db.insert(waivers).values({ businessId, title: 'Liability waiver', body: STARTER_WAIVER, required: true, scope: 'owner' });
  return { business: b!, manager: manager! };
}
