/**
 * Signing in, the public face of a daycare, and a daycare's settings.
 */

import type { FastifyInstance } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { ValidationError } from '@dawgs/core';
import { addOns, businesses, kennels, pushTokens, sessions, users, walkTypes, yards } from '@dawgs/db';
import type { AppContext } from '../context.js';
import { withPolicyDefaults } from '@dawgs/core';
import { addOnSettingsShape, slugCode } from '../addons.js';
import {
  auth,
  checkPassword,
  createSession,
  login,
  publicUser,
  requireManager,
  requireStaff,
  sameBusiness,
  signUpOwner,
  UnauthorizedError,
} from '../auth.js';
import { hashPassword, hashToken, verifyPassword } from '../crypto.js';
import { cents, hhmm, parse } from '../util.js';
import { saveTwilio } from '../tenants.js';
import { audit } from '../audit.js';
import { createDaycare } from '../daycares.js';

const pricesShape = z.object({
  halfDay: cents,
  fullDay: cents,
  hourly: cents,
  latePickupPerMinute: cents,
  suiteNight: cents,
  runNight: cents,
  boarderPlay: cents,
  lateCheckout: cents,
});

const hoursShape = z.object({
  closesAt: hhmm,
  checkoutBy: hhmm,
  halfDayLimitMinutes: z.number().int().min(60).max(720),
  hourlyMinimumMinutes: z.number().int().min(15).max(240),
});

export function publicBusiness(b: typeof businesses.$inferSelect) {
  return {
    id: b.id,
    slug: b.slug,
    name: b.name,
    phone: b.phone,
    email: b.email,
    address: b.address,
    timezone: b.timezone,
    logoUrl: b.logoUrl,
    brandColor: b.brandColor,
    prices: b.prices,
    hours: b.hours,
    // What clients need to know before booking; tax and tip settings stay with the desk.
    bookingPolicy: (({ cancelWindowHours, lateCancelFeeCents, noShowFeeCents, onlineBooking }) => ({ cancelWindowHours, lateCancelFeeCents, noShowFeeCents, onlineBooking }))(withPolicyDefaults(b.policies)),
    requiredVaccines: b.requiredVaccines,
  };
}

/** Pending Stripe Connect states, keyed by the random state value. Short-lived, so memory is enough. */
const connectStates = new Map<string, { businessId: string; expires: number }>();

export function registerAccountRoutes(app: FastifyInstance, ctx: AppContext) {
  // ─── Sign-in ─────────────────────────────────────────────────────────────
  app.post('/auth/login', { config: { public: true } }, async (req) => {
    const b = parse(z.object({ email: z.string().email(), password: z.string().min(1), businessId: z.string().uuid().optional() }), req.body);
    return login(ctx, b.email, b.password, b.businessId);
  });

  app.post('/auth/signup', { config: { public: true } }, async (req) => {
    const b = parse(
      z.object({
        business: z.string().min(1),
        name: z.string().min(1),
        email: z.string().email(),
        phone: z.string().optional(),
        password: z.string(),
      }),
      req.body,
    );
    const [biz] = await ctx.db.select().from(businesses).where(eq(businesses.slug, b.business.toLowerCase()));
    if (!biz) throw new ValidationError('unknown daycare');
    return signUpOwner(ctx, { businessId: biz.id, name: b.name, email: b.email, phone: b.phone, password: b.password });
  });

  app.get('/auth/me', async (req) => {
    const a = auth(req);
    const [u] = await ctx.db.select().from(users).where(eq(users.id, a.userId));
    const [b] = await ctx.db.select().from(businesses).where(eq(businesses.id, a.businessId));
    return { user: publicUser(u!), business: publicBusiness(b!) };
  });

  app.post('/auth/logout', async (req) => {
    await ctx.db.delete(sessions).where(eq(sessions.id, auth(req).sessionId));
    return { ok: true };
  });

  app.post('/auth/password', async (req) => {
    const a = auth(req);
    const b = parse(z.object({ current: z.string(), next: z.string() }), req.body);
    checkPassword(b.next);
    const [u] = await ctx.db.select().from(users).where(eq(users.id, a.userId));
    if (!u || !verifyPassword(b.current, u.passwordHash)) throw new ValidationError('current password is wrong');
    await ctx.db.update(users).set({ passwordHash: hashPassword(b.next) }).where(eq(users.id, a.userId));
    return { ok: true };
  });

  app.post('/auth/push-token', async (req) => {
    const a = auth(req);
    const b = parse(z.object({ token: z.string().min(10), platform: z.enum(['ios', 'android', 'web']) }), req.body);
    await ctx.db.delete(pushTokens).where(eq(pushTokens.token, b.token));
    await ctx.db.insert(pushTokens).values({ userId: a.userId, token: b.token, platform: b.platform });
    return { ok: true };
  });

  // ─── Public ──────────────────────────────────────────────────────────────
  /** A new daycare signs up for Dawgs and starts a trial. */
  app.post('/public/daycares', { config: { public: true } }, async (req) => {
    if (!ctx.daycareSignupOpen) throw new ValidationError('sign-up is by invitation for now');
    const b = parse(
      z.object({
        name: z.string().min(2),
        slug: z.string().optional(),
        timezone: z.string().optional(),
        managerName: z.string().min(1),
        managerEmail: z.string().email(),
        managerPassword: z.string(),
      }),
      req.body,
    );
    const { business, manager } = await createDaycare(ctx.db, { ...b, now: ctx.now() } as Parameters<typeof createDaycare>[1]);
    return { business: publicBusiness(business), token: await createSession(ctx, manager.id), user: publicUser(manager) };
  });

  app.get('/public/daycares/:slug', { config: { public: true } }, async (req) => {
    const { slug } = req.params as { slug: string };
    const [b] = await ctx.db.select().from(businesses).where(eq(businesses.slug, slug.toLowerCase()));
    if (!b) throw new ValidationError('unknown daycare');
    const types = await ctx.db.select().from(walkTypes).where(and(eq(walkTypes.businessId, b.id), eq(walkTypes.active, true)));
    return { ...publicBusiness(b), walkTypes: types };
  });

  // ─── Settings ────────────────────────────────────────────────────────────
  app.get('/settings', async (req) => {
    const a = requireStaff(req);
    const [b] = await ctx.db.select().from(businesses).where(eq(businesses.id, a.businessId));
    const by = <T extends { businessId: string }>(rows: T[]) => rows;
    return {
      business: {
        ...publicBusiness(b!),
        daycareCapacity: b!.daycareCapacity,
        inactiveAfterDays: b!.inactiveAfterDays,
        pickupTextsEnabled: b!.pickupTextsEnabled,
        invoiceRemindersEnabled: b!.invoiceRemindersEnabled,
        policies: withPolicyDefaults(b!.policies),
        emailMode: ctx.mail.mode,
        plan: b!.plan,
        trialEndsAt: b!.trialEndsAt,
        stripeConnected: Boolean(b!.stripeAccountId),
        paymentsMode: ctx.connect ? (b!.stripeAccountId ? 'stripe' : 'not_connected') : 'simulated',
        twilio: b!.twilioAccountSid ? { accountSid: b!.twilioAccountSid, from: b!.twilioFrom } : null,
      },
      yards: by(await ctx.db.select().from(yards).where(eq(yards.businessId, a.businessId)).orderBy(asc(yards.sort))),
      kennels: await ctx.db.select().from(kennels).where(eq(kennels.businessId, a.businessId)).orderBy(asc(kennels.sort)),
      addOns: await ctx.db.select().from(addOns).where(eq(addOns.businessId, a.businessId)).orderBy(asc(addOns.sort), asc(addOns.name)),
      walkTypes: await ctx.db.select().from(walkTypes).where(eq(walkTypes.businessId, a.businessId)),
    };
  });

  app.patch('/settings', async (req) => {
    const a = requireManager(req);
    const b = parse(
      z.object({
        name: z.string().min(1).optional(),
        phone: z.string().nullable().optional(),
        email: z.string().email().nullable().optional(),
        address: z.string().nullable().optional(),
        timezone: z.string().optional(),
        logoUrl: z.string().url().nullable().optional(),
        brandColor: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
        prices: pricesShape.optional(),
        hours: hoursShape.optional(),
        daycareCapacity: z.number().int().min(1).max(1000).optional(),
        requiredVaccines: z.array(z.string().min(1)).optional(),
        inactiveAfterDays: z.number().int().min(1).max(365).optional(),
        pickupTextsEnabled: z.boolean().optional(),
        invoiceRemindersEnabled: z.boolean().optional(),
        policies: z
          .object({
            salesTaxBps: z.number().int().min(0).max(2500),
            taxServices: z.boolean(),
            taxAddOns: z.boolean(),
            tipsEnabled: z.boolean(),
            tipChoices: z.array(z.number().int().min(1).max(100)).max(5),
            multiDogPercent: z.number().int().min(0).max(100),
            cancelWindowHours: z.number().int().min(0).max(24 * 14),
            lateCancelFeeCents: cents,
            noShowFeeCents: cents,
            onlineBooking: z.object({ enabled: z.boolean(), autoApprove: z.boolean(), daysAhead: z.number().int().min(1).max(365) }).partial(),
            reviewRequests: z
              .object({ enabled: z.boolean(), url: z.union([z.literal(''), z.string().url().startsWith('https://')]), everyDays: z.number().int().min(7).max(730) })
              .partial(),
            birthdayTexts: z.boolean(),
            reportCardTexts: z.boolean(),
          })
          .partial()
          .optional(),
      }),
      req.body,
    );
    if (b.policies) {
      // Merge into what is stored so a screen that edits one rule can't wipe the others.
      const [cur] = await ctx.db.select({ p: businesses.policies }).from(businesses).where(eq(businesses.id, a.businessId));
      const was = withPolicyDefaults(cur!.p);
      const merged = withPolicyDefaults({
        ...was,
        ...b.policies,
        onlineBooking: { ...was.onlineBooking, ...(b.policies.onlineBooking ?? {}) },
        reviewRequests: { ...was.reviewRequests, ...(b.policies.reviewRequests ?? {}) },
      });
      (b as { policies: unknown }).policies = merged;
    }
    if (b.timezone) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: b.timezone });
      } catch {
        throw new ValidationError('unknown time zone');
      }
    }
    const set = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined));
    if (Object.keys(set).length) await ctx.db.update(businesses).set(set).where(eq(businesses.id, a.businessId));
    await audit(ctx.db, a.businessId, a.name, 'settings.update', `Settings changed: ${Object.keys(set).join(', ')}`);
    return { ok: true };
  });

  // Yards, kennels, add-ons and walk types share one shape of CRUD.
  const lists = [
    {
      path: 'yards',
      table: yards,
      shape: z.object({
        name: z.string().min(1),
        capacity: z.number().int().min(1),
        maxWeightLb: z.number().positive().nullable().optional(),
        note: z.string().nullable().optional(),
        sort: z.number().int().optional(),
      }),
    },
    {
      path: 'kennels',
      table: kennels,
      shape: z.object({
        name: z.string().min(1),
        type: z.enum(['suite', 'run']),
        active: z.boolean().optional(),
        sort: z.number().int().optional(),
      }),
    },
    {
      path: 'add-ons',
      table: addOns,
      shape: addOnSettingsShape,
    },
    {
      path: 'walk-types',
      table: walkTypes,
      shape: z.object({
        name: z.string().min(1),
        minutes: z.number().int().min(5),
        priceCents: cents,
        active: z.boolean().optional(),
      }),
    },
  ] as const;

  for (const l of lists) {
    const table = l.table as typeof yards;
    app.post(`/settings/${l.path}`, async (req) => {
      const a = requireManager(req);
      const parsed = parse(l.shape, req.body);
      // An add-on's code is only an internal handle; derive it from the name when not given.
      const body = l.path === 'add-ons' ? { code: slugCode((parsed as { name: string }).name), ...parsed } : parsed;
      const [row] = await ctx.db
        .insert(table)
        .values({ ...(body as object), businessId: a.businessId } as typeof yards.$inferInsert)
        .returning();
      return row;
    });
    app.patch(`/settings/${l.path}/:id`, async (req) => {
      const a = requireManager(req);
      const { id } = req.params as { id: string };
      const body = parse(l.shape.partial(), req.body);
      const [row] = await ctx.db.select().from(table).where(eq(table.id, id));
      sameBusiness(a, row, l.path);
      const [out] = await ctx.db.update(table).set(body as object).where(eq(table.id, id)).returning();
      return out;
    });
    app.delete(`/settings/${l.path}/:id`, async (req) => {
      const a = requireManager(req);
      const { id } = req.params as { id: string };
      const [row] = await ctx.db.select().from(table).where(eq(table.id, id));
      sameBusiness(a, row, l.path);
      try {
        await ctx.db.delete(table).where(eq(table.id, id));
      } catch {
        throw new ValidationError(`this is in use; switch it off instead of deleting it`);
      }
      return { ok: true };
    });
  }

  // ─── Stripe Connect and Twilio ───────────────────────────────────────────
  app.post('/settings/stripe/connect', async (req) => {
    const a = requireManager(req);
    if (!ctx.connect) throw new ValidationError('payments run in simulation on this server; there is nothing to connect');
    const b = parse(z.object({ returnUrl: z.string().url() }), req.body);
    const state = randomBytes(18).toString('base64url');
    connectStates.set(hashToken(state), { businessId: a.businessId, expires: ctx.now() + 30 * 60_000 });
    return { url: ctx.connect.authorizeUrl(state, b.returnUrl) };
  });

  app.post('/settings/stripe/finish', async (req) => {
    const a = requireManager(req);
    if (!ctx.connect) throw new ValidationError('Stripe is not configured');
    const b = parse(z.object({ code: z.string().min(1), state: z.string().min(1) }), req.body);
    const pending = connectStates.get(hashToken(b.state));
    connectStates.delete(hashToken(b.state));
    if (!pending || pending.businessId !== a.businessId || pending.expires < ctx.now()) {
      throw new UnauthorizedError('that Stripe link expired; start again');
    }
    const accountId = await ctx.connect.finish(b.code);
    await ctx.db.update(businesses).set({ stripeAccountId: accountId }).where(eq(businesses.id, a.businessId));
    await audit(ctx.db, a.businessId, a.name, 'stripe.connect', `Stripe account ${accountId} connected`);
    return { ok: true };
  });

  app.delete('/settings/stripe', async (req) => {
    const a = requireManager(req);
    const [b] = await ctx.db.select().from(businesses).where(eq(businesses.id, a.businessId));
    if (b?.stripeAccountId && ctx.connect) await ctx.connect.disconnect(b.stripeAccountId).catch(() => undefined);
    await ctx.db.update(businesses).set({ stripeAccountId: null }).where(eq(businesses.id, a.businessId));
    await audit(ctx.db, a.businessId, a.name, 'stripe.disconnect', 'Stripe disconnected');
    return { ok: true };
  });

  app.put('/settings/twilio', async (req) => {
    const a = requireManager(req);
    const b = parse(
      z.object({ accountSid: z.string(), authToken: z.string().min(10), from: z.string() }).nullable(),
      req.body ?? null,
    );
    await saveTwilio(ctx.db, ctx.secret, a.businessId, b);
    await audit(ctx.db, a.businessId, a.name, 'twilio.update', b ? `Texts now sent from ${b.from}` : 'Twilio removed');
    return { ok: true };
  });

  app.post('/settings/twilio/test', async (req) => {
    const a = requireManager(req);
    const b = parse(z.object({ to: z.string().min(7) }), req.body);
    const sms = await ctx.smsFor(a.businessId);
    const r = await sms.send(b.to, 'Test text from Dawgs. Your texts are set up.');
    return { ok: true, mode: sms.mode, id: r.id };
  });
}
