/**
 * HTTP API: error mapping, authentication, and the route modules.
 *
 * As in MeDu, every screen of every app uses exactly these routes, and the
 * auth hook is installed before any route so a new route is closed by
 * default (see auth.ts).
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { DawgsError } from '@dawgs/core';
import type { AppContext } from './context.js';
import { registerAuth } from './auth.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerPeopleRoutes } from './routes/people.js';
import { registerOperationsRoutes } from './routes/operations.js';
import { registerCommerceRoutes } from './routes/commerce.js';
import { registerTextRoutes } from './routes/texts.js';
import { registerWalkRoutes } from './routes/walks.js';
import { registerTeamRoutes } from './routes/team.js';
import { registerManageRoutes } from './routes/manage.js';
import { registerMeRoutes } from './routes/me.js';
import { registerPickupRoutes } from './routes/pickup.js';
import { serveSites, type WebSite } from './web.js';

const STATUS: Record<string, number> = {
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  PAYMENT_FAILED: 402,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  STRIPE_NOT_CONNECTED: 409,
};

export async function buildApp(
  ctx: AppContext,
  options: { logger?: boolean; corsOrigins?: string[] | true; apiPrefix?: string; sites?: WebSite[] } = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 1_000_000, trustProxy: true });
  await app.register(cors, { origin: options.corsOrigins ?? true });

  // Keep the raw JSON body: Stripe signs the exact bytes it sent.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as unknown as { rawBody: string }).rawBody = body as string;
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new DawgsError('VALIDATION', 'body is not valid JSON'), undefined);
    }
  });
  // Twilio posts forms.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof DawgsError) {
      return reply.code(STATUS[err.code] ?? 400).send({ error: err.code, message: err.message });
    }
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: 'BAD_REQUEST', message: e.message });
    app.log.error(err);
    return reply.code(500).send({ error: 'INTERNAL', message: 'something went wrong' });
  });

  app.get('/health', { config: { public: true } }, async () => ({ ok: true }));

  // The auth hook and every route live in one scope, so the hook covers all of
  // them; when the web apps are served from the same box, the API moves under a prefix.
  await app.register(
    async (api) => {
      registerAuth(api, ctx);
      registerAccountRoutes(api, ctx);
      registerPeopleRoutes(api, ctx);
      registerOperationsRoutes(api, ctx);
      registerCommerceRoutes(api, ctx);
      registerTextRoutes(api, ctx);
      registerWalkRoutes(api, ctx);
      registerTeamRoutes(api, ctx);
      registerManageRoutes(api, ctx);
      registerMeRoutes(api, ctx);
      registerPickupRoutes(api, ctx);
    },
    { prefix: options.apiPrefix ?? '' },
  );
  if (options.sites?.length) serveSites(app, options.sites);
  return app;
}
