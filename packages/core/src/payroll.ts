/**
 * Hours and pay from time-clock punches.
 *
 * US federal overtime: time and a half past 40 hours in a work week. States
 * with daily overtime (California) are not handled here and are called out
 * in the payroll screen; Dawgs exports hours to a payroll provider rather
 * than filing taxes itself.
 */

import type { Cents } from './money.js';
import { HOUR } from './time.js';

export interface Punch {
  inAt: number;
  outAt: number | null;
}

export function workedMs(punches: readonly Punch[], now: number): number {
  return punches.reduce((s, p) => s + Math.max(0, (p.outAt ?? now) - p.inAt), 0);
}

export function weeklyPay(hours: number, rateCents: Cents): { regular: number; overtime: number; gross: Cents } {
  const regular = Math.min(40, hours);
  const overtime = Math.max(0, hours - 40);
  return {
    regular,
    overtime,
    gross: Math.round(regular * rateCents + overtime * rateCents * 1.5),
  };
}

export function msToHours(ms: number): number {
  return Math.round((ms / HOUR) * 100) / 100;
}
