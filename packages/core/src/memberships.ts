/**
 * Monthly memberships: a package that renews itself.
 *
 * In production Stripe Billing owns the schedule and the retries (Smart
 * Retries off, a custom schedule of every 3 days, cancel after 4 failures —
 * configured in the dashboard to match). This module owns what Dawgs does
 * when Stripe reports an outcome: grant the month's credits, roll over what
 * the plan allows, and decide whether a failure ends the membership. The
 * simulator in the API uses the same schedule so tests exercise it.
 */

import type { Wallet } from './wallet.js';
import { CREDIT_KINDS } from './wallet.js';

export const RETRY_EVERY_DAYS = 3;
export const MAX_FAILED_CHARGES = 4;

export interface MembershipPlan {
  credits: Partial<Wallet>;
  /** Most unused credits of each kind carried into the next month; 0 = none. */
  rolloverMax: number;
}

/**
 * Credits after a successful renewal.
 *
 * Leftover credits from THIS plan's grant are capped at `rolloverMax` per
 * kind; credits bought separately in packs are never taken away, so the
 * caller passes only the membership's own balance in `membershipLeft`.
 */
export function renewCredits(plan: MembershipPlan, membershipLeft: Partial<Wallet>): Wallet {
  const out = { daycare: 0, night: 0, walk: 0, bath: 0 };
  for (const k of CREDIT_KINDS) {
    const carried = Math.min(membershipLeft[k] ?? 0, plan.rolloverMax);
    out[k] = carried + (plan.credits[k] ?? 0);
  }
  return out;
}

export type FailureOutcome =
  | { action: 'retry'; nextAttemptAt: number; failures: number }
  | { action: 'cancel'; failures: number };

export function afterFailedCharge(failuresSoFar: number, at: number): FailureOutcome {
  const failures = failuresSoFar + 1;
  if (failures >= MAX_FAILED_CHARGES) return { action: 'cancel', failures };
  return { action: 'retry', failures, nextAttemptAt: at + RETRY_EVERY_DAYS * 86_400_000 };
}

/** Same day next month, clamped to the month's last day (Jan 31 → Feb 28). */
export function addOneMonth(t: number): number {
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
}
