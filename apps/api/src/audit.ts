import { auditLog, type Database } from '@dawgs/db';

/** The activity log the prototype kept as `log()`: who did what, in words. */
export async function audit(db: Database, businessId: string, actor: string, action: string, detail: string) {
  await db.insert(auditLog).values({ businessId, actor, action, detail });
}
