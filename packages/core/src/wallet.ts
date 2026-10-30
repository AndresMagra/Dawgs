/**
 * Prepaid credits a dog carries, bought in packages or memberships.
 *
 * Credits belong to the dog, not the owner, matching how the front desk talks
 * ("Biscuit has 6 days left"). A package grants credits; a visit spends them.
 */

export const CREDIT_KINDS = ['daycare', 'night', 'walk', 'bath', 'training'] as const;
export type CreditKind = (typeof CREDIT_KINDS)[number];
export type Wallet = Record<CreditKind, number>;

export function emptyWallet(): Wallet {
  return { daycare: 0, night: 0, walk: 0, bath: 0, training: 0 };
}

export function addCredits(w: Wallet, add: Partial<Wallet>): Wallet {
  const out = { ...w };
  for (const k of CREDIT_KINDS) out[k] += add[k] ?? 0;
  return out;
}

export function spendCredits(w: Wallet, spend: Partial<Wallet>): Wallet {
  const out = { ...w };
  for (const k of CREDIT_KINDS) {
    const n = spend[k] ?? 0;
    if (n > out[k]) throw new Error(`not enough ${k} credits`);
    out[k] -= n;
  }
  return out;
}
