/**
 * Money is whole cents, always.
 *
 * Every amount in Dawgs is a US-dollar integer number of cents: Stripe takes
 * cents, Postgres stores them exactly, and $2.25 a quarter-hour times 13
 * quarters never drifts into $29.249999.
 */

export type Cents = number;

export function dollars(n: number): Cents {
  return Math.round(n * 100);
}

export function formatMoney(cents: Cents): string {
  const sign = cents < 0 ? '−' : '';
  const abs = Math.abs(cents) / 100;
  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function sumCents(values: readonly Cents[]): Cents {
  return values.reduce((a, b) => a + b, 0);
}
