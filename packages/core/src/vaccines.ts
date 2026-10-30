/**
 * Whether a dog may come in, as far as shots go.
 *
 * A dog with a missing or expired required vaccine is blocked at check-in and
 * at booking (staff and the owner's app both ask the same function). "Due
 * soon" is a warning only: the owner gets reminded, the dog still plays.
 */

import { DAY } from './time.js';

export const DEFAULT_REQUIRED_VACCINES = ['Rabies', 'DHPP', 'Bordetella'] as const;

export interface VaccineRecord {
  name: string;
  /** Epoch ms the shot expires. */
  expiresAt: number;
}

export type VaccineState = 'ok' | 'due_soon' | 'expired' | 'missing';

export interface VaccineStatus {
  name: string;
  state: VaccineState;
  expiresAt?: number;
}

export function vaccineStatuses(
  records: readonly VaccineRecord[],
  now: number,
  required: readonly string[] = DEFAULT_REQUIRED_VACCINES,
  dueSoonDays = 30,
): VaccineStatus[] {
  return required.map((name) => {
    const latest = records
      .filter((r) => r.name.toLowerCase() === name.toLowerCase())
      .sort((a, b) => b.expiresAt - a.expiresAt)[0];
    if (!latest) return { name, state: 'missing' };
    if (latest.expiresAt <= now) return { name, state: 'expired', expiresAt: latest.expiresAt };
    if (latest.expiresAt - now <= dueSoonDays * DAY)
      return { name, state: 'due_soon', expiresAt: latest.expiresAt };
    return { name, state: 'ok', expiresAt: latest.expiresAt };
  });
}

const RANK: Record<VaccineState, number> = { ok: 0, due_soon: 1, expired: 2, missing: 3 };

export function worstVaccineState(statuses: readonly VaccineStatus[]): VaccineState {
  return statuses.reduce<VaccineState>((w, s) => (RANK[s.state] > RANK[w] ? s.state : w), 'ok');
}

export function vaccinesAllowEntry(statuses: readonly VaccineStatus[]): boolean {
  const w = worstVaccineState(statuses);
  return w === 'ok' || w === 'due_soon';
}
