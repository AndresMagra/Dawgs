export function money(cents: number) {
  const sign = cents < 0 ? '−' : '';
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function time(iso: string | number | Date, tz?: string) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) });
}

export function day(iso: string | number | Date, tz?: string) {
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', ...(tz ? { timeZone: tz } : {}) });
}

/** A `YYYY-MM-DD` local date shown as "Thu, Nov 6" without time-zone drift. */
export function dateKeyLabel(key: string) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function todayKey(tz: string, offsetDays = 0) {
  const t = Date.now() + offsetDays * 86_400_000;
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
  return p;
}

export function duration(ms: number) {
  const m = Math.max(0, Math.floor(ms / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

export function miles(meters: number | null | undefined) {
  return `${((meters ?? 0) / 1609.344).toFixed(2)} mi`;
}

export function creditsText(c: Partial<Record<string, number>>) {
  const names: Record<string, [string, string]> = {
    daycare: ['daycare day', 'daycare days'],
    night: ['night', 'nights'],
    walk: ['walk', 'walks'],
    bath: ['bath', 'baths'],
    training: ['lesson', 'lessons'],
  };
  return Object.entries(c)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([k, n]) => `${n} ${names[k]?.[n === 1 ? 0 : 1] ?? k}`)
    .join(' · ');
}

export const BOOKING_STATUS: Record<string, string> = {
  requested: 'Requested',
  confirmed: 'Confirmed',
  waitlist: 'Waitlist',
  checked_in: 'Here now',
  checked_out: 'Done',
  cancelled: 'Cancelled',
  declined: 'Declined',
  no_show: 'No-show',
};

/** Where an open invoice stands, in the words the desk uses. */
export function invoiceStage(i: { status: string; sentAt: string | null; viewedAt: string | null; dueDate: string | null }, today: string) {
  if (i.status !== 'open') return { text: i.status.replace('_', ' '), tone: i.status === 'paid' ? ('ok' as const) : ('' as const) };
  if (i.dueDate && i.dueDate < today) return { text: 'Overdue', tone: 'bad' as const };
  if (i.viewedAt) return { text: 'Viewed', tone: 'info' as const };
  if (i.sentAt) return { text: 'Sent', tone: 'warn' as const };
  return { text: 'Not sent', tone: 'warn' as const };
}

export const LEAD_STAGES = [
  { key: 'new', label: 'New' },
  { key: 'contacted', label: 'Contacted' },
  { key: 'tour', label: 'Tour booked' },
  { key: 'trial', label: 'Trial day' },
  { key: 'won', label: 'Won' },
  { key: 'lost', label: 'Lost' },
] as const;

export const LEAD_SOURCES = [
  { key: 'website', label: 'Website' },
  { key: 'phone', label: 'Phone call' },
  { key: 'walk_in', label: 'Walk-in' },
  { key: 'referral', label: 'Referral' },
  { key: 'social', label: 'Social media' },
  { key: 'other', label: 'Other' },
] as const;

/** "$15", "$3 a day", "$25 · 30 min" for an add-on on a menu. */
export function addOnPrice(a: { priceCents: number; pricing: 'flat' | 'per_day'; durationMinutes?: number | null }) {
  return `${money(a.priceCents)}${a.pricing === 'per_day' ? ' a day' : ''}${a.durationMinutes ? ` · ${a.durationMinutes} min` : ''}`;
}

export const ADD_ON_KINDS = [
  { key: 'extra', label: 'Service or extra' },
  { key: 'pickup', label: 'Pickup from home' },
  { key: 'dropoff', label: 'Drop-off at home' },
] as const;
