/**
 * Uploading and serving photos and documents (see storage.ts).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { auth } from '../auth.js';
import { parse } from '../util.js';
import { saveFile } from '../storage.js';

export function registerFileRoutes(app: FastifyInstance, ctx: AppContext) {
  /** Any signed-in user: a photo or PDF as a data URL in, a URL to put on a record out. */
  app.post('/uploads', { bodyLimit: 12_000_000 }, async (req) => {
    const a = auth(req);
    const b = parse(z.object({ dataUrl: z.string().min(10) }), req.body);
    return { url: await saveFile(ctx, { businessId: a.businessId, dataUrl: b.dataUrl, uploadedBy: a.userId }) };
  });

  app.get('/files/:key', { config: { public: true } }, async (req, reply) => {
    const { key } = req.params as { key: string };
    if (!/^[A-Za-z0-9_-]{40,}\.[a-z]{3,4}$/.test(key)) return reply.code(404).send({ error: 'NOT_FOUND', message: 'not found' });
    const f = await ctx.files.get(key);
    if (!f) return reply.code(404).send({ error: 'NOT_FOUND', message: 'not found' });
    return reply
      .header('content-type', f.type)
      .header('cache-control', 'private, max-age=31536000, immutable')
      .header('cross-origin-resource-policy', 'cross-origin')
      .send(f.bytes);
  });
}
