/**
 * Who is calling, and what they may touch.
 *
 * Three roles share one login: `manager`, `staff`, `owner` (a pet owner in
 * the customer app). Every route is protected unless it opts out with
 * `config: { public: true }`; the hook below runs first for all of them, so a
 * route added without thinking is closed, not open (the MeDu rule).
 *
 * Owners are confined to their own records by `ownerScope`, which every
 * customer route calls; staff are confined to their business by comparing
 * `businessId` on every row they load.
 */

import { and, eq, gt, lt } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DawgsError, ValidationError } from '@dawgs/core';
import { businesses, owners, sessions, users } from '@dawgs/db';
import type { AppContext } from './context.js';
import { hashPassword, hashToken, randomToken, verifyPassword } from './crypto.js';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 8;

export type Role = 'manager' | 'staff' | 'owner';

export interface AuthContext {
  userId: string;
  businessId: string;
  role: Role;
  name: string;
  ownerId: string | null;
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
  interface FastifyContextConfig {
    public?: boolean;
  }
}

export class UnauthorizedError extends DawgsError {
  constructor(message = 'please sign in') {
    super('UNAUTHORIZED', message);
  }
}

export class ForbiddenError extends DawgsError {
  constructor(message = 'not allowed') {
    super('FORBIDDEN', message);
  }
}

export function auth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw new UnauthorizedError();
  return req.auth;
}

export function requireStaff(req: FastifyRequest): AuthContext {
  const a = auth(req);
  if (a.role !== 'manager' && a.role !== 'staff') throw new ForbiddenError('staff only');
  return a;
}

export function requireManager(req: FastifyRequest): AuthContext {
  const a = auth(req);
  if (a.role !== 'manager') throw new ForbiddenError('managers only');
  return a;
}

export function requireOwner(req: FastifyRequest): AuthContext & { ownerId: string } {
  const a = auth(req);
  if (a.role !== 'owner' || !a.ownerId) throw new ForbiddenError('owner accounts only');
  return a as AuthContext & { ownerId: string };
}

export const isManager = (a: AuthContext) => a.role === 'manager';

/** Throw unless `row` exists and belongs to the caller's business. */
export function sameBusiness<T extends { businessId: string }>(a: AuthContext, row: T | undefined, what: string): T {
  if (!row || row.businessId !== a.businessId) throw new DawgsError('NOT_FOUND', `${what} not found`);
  return row;
}

export async function createSession(ctx: AppContext, userId: string) {
  const token = randomToken();
  await ctx.db.insert(sessions).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(ctx.now() + SESSION_TTL_MS),
  });
  return token;
}

export async function login(ctx: AppContext, email: string, password: string, businessId?: string) {
  const rows = await ctx.db
    .select()
    .from(users)
    .where(and(eq(users.email, email.trim().toLowerCase()), eq(users.active, true)));
  const candidates = businessId ? rows.filter((u) => u.businessId === businessId) : rows;
  const user = candidates.find((u) => verifyPassword(password, u.passwordHash));
  if (!user) throw new UnauthorizedError('wrong email or password');
  return { token: await createSession(ctx, user.id), user: publicUser(user) };
}

export function publicUser(u: typeof users.$inferSelect) {
  return {
    id: u.id,
    businessId: u.businessId,
    role: u.role,
    name: u.name,
    email: u.email,
    phone: u.phone,
    ownerId: u.ownerId,
    jobTitle: u.jobTitle,
  };
}

export function checkPassword(p: string) {
  if (p.length < MIN_PASSWORD_LENGTH) throw new ValidationError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
}

/**
 * The customer app's sign-up. If the front desk already created an owner
 * with this email, the new login is linked to it so the owner sees the dogs
 * that are already on file instead of an empty account.
 */
export async function signUpOwner(
  ctx: AppContext,
  input: { businessId: string; name: string; email: string; phone?: string | undefined; password: string },
) {
  if (!ctx.ownerSignupOpen) throw new ForbiddenError('sign-up is closed; ask the front desk for an invite');
  checkPassword(input.password);
  const email = input.email.trim().toLowerCase();
  const [b] = await ctx.db.select({ id: businesses.id }).from(businesses).where(eq(businesses.id, input.businessId));
  if (!b) throw new ValidationError('unknown business');
  const [taken] = await ctx.db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.businessId, input.businessId), eq(users.email, email)));
  if (taken) throw new ValidationError('an account with this email already exists; sign in instead');

  let [owner] = await ctx.db
    .select()
    .from(owners)
    .where(and(eq(owners.businessId, input.businessId), eq(owners.email, email)));
  if (!owner) {
    [owner] = await ctx.db
      .insert(owners)
      .values({ businessId: input.businessId, name: input.name, email, phone: input.phone ?? null })
      .returning();
  }
  const [user] = await ctx.db
    .insert(users)
    .values({
      businessId: input.businessId,
      role: 'owner',
      name: input.name,
      email,
      phone: input.phone ?? null,
      passwordHash: hashPassword(input.password),
      ownerId: owner!.id,
    })
    .returning();
  return { token: await createSession(ctx, user!.id), user: publicUser(user!) };
}

export async function resolveSession(ctx: AppContext, token: string): Promise<AuthContext | null> {
  const [row] = await ctx.db
    .select({ s: sessions, u: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date(ctx.now()))));
  if (!row || !row.u.active) return null;
  return {
    userId: row.u.id,
    businessId: row.u.businessId,
    role: row.u.role,
    name: row.u.name,
    ownerId: row.u.ownerId,
    sessionId: row.s.id,
  };
}

export async function purgeExpiredSessions(ctx: AppContext) {
  await ctx.db.delete(sessions).where(lt(sessions.expiresAt, new Date(ctx.now())));
}

export function registerAuth(app: FastifyInstance, ctx: AppContext) {
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) req.auth = await resolveSession(ctx, header.slice(7));
    if (!req.auth && !req.routeOptions.config?.public && req.method !== 'OPTIONS') {
      throw new UnauthorizedError();
    }
  });
}
