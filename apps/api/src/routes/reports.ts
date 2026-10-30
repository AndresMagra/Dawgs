import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError, addLocalDays, localDateKey } from '@dawgs/core';
import type { AppContext } from '../context.js';
import { requirePermission } from '../auth.js';
import { dateKey, parse } from '../util.js';
import { loadBusiness } from '../ops.js';
import { EXPORTS, creditLiability, exportCsv, occupancy, revenueReport, staffHours, topClients } from '../reports.js';
import { audit } from '../audit.js';

/** Money and people reports are for managers only, like the money screen. */
export function registerReportRoutes(app: FastifyInstance, ctx: AppContext) {
  const range = async (businessId: string, q: unknown) => {
    const b = await loadBusiness(ctx.db, businessId);
    const today = localDateKey(ctx.now(), b.timezone);
    const r = parse(z.object({ from: dateKey.optional(), to: dateKey.optional() }), q);
    const to = r.to ?? today;
    const from = r.from ?? addLocalDays(to, -29);
    if (from > to) throw new ValidationError('the start is after the end');
    if (from < addLocalDays(to, -366)) throw new ValidationError('pick a year or less');
    return { from, to };
  };

  app.get('/reports', async (req) => {
    const a = await requirePermission(ctx, req, 'seeMoney');
    const { from, to } = await range(a.businessId, req.query);
    const [revenue, clients, nights, credits, hours] = await Promise.all([
      revenueReport(ctx, a.businessId, from, to),
      topClients(ctx, a.businessId, from, to),
      occupancy(ctx, a.businessId),
      creditLiability(ctx, a.businessId),
      staffHours(ctx, a.businessId, from, to),
    ]);
    return { from, to, revenue, topClients: clients, occupancy: nights, credits, staffHours: hours };
  });

  app.get('/reports/export', async (req) => {
    const a = await requirePermission(ctx, req, 'export');
    const { kind } = parse(z.object({ kind: z.enum(EXPORTS), from: z.string().optional(), to: z.string().optional() }), req.query);
    const { from, to } = await range(a.businessId, req.query);
    // Client lists leave the building; keep a record of who took one.
    await audit(ctx.db, a.businessId, a.name, 'report.export', `Exported ${kind} ${from} → ${to}`);
    return exportCsv(ctx, a.businessId, kind, from, to);
  });
}
