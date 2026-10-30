import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp } from './helpers.js';

type App = Awaited<ReturnType<typeof makeApp>>;

let t: App;
let mgr: string;
let staff: string;
let dana: string;
beforeAll(async () => {
  t = await makeApp();
  mgr = await t.login('priya@happytails.test');
  staff = await t.login('marco@happytails.test');
  dana = await t.login('dana@example.com');
});
afterAll(async () => t.close());

const dog = async (name: string) => (await t.call<any[]>('GET', '/dogs', mgr)).body.find((d) => d.name === name)!;

describe('check-out and booking policies', () => {
  it('lets only managers change the rules, and merges partial edits', async () => {
    expect((await t.call('PATCH', '/settings', staff, { policies: { salesTaxBps: 800 } })).status).toBe(403);
    expect((await t.call('PATCH', '/settings', mgr, { policies: { salesTaxBps: 800, multiDogPercent: 10, lateCancelFeeCents: 2000, noShowFeeCents: 3000 } })).status).toBe(200);
    expect((await t.call('PATCH', '/settings', mgr, { policies: { onlineBooking: { daysAhead: 30 } } })).status).toBe(200);
    const p = (await t.call<any>('GET', '/settings', mgr)).body.business.policies;
    expect(p).toMatchObject({ salesTaxBps: 800, multiDogPercent: 10, lateCancelFeeCents: 2000, taxAddOns: true, onlineBooking: { enabled: true, daysAhead: 30 } });
    // Owners see the cancellation rules, not the tax setup.
    const pub = (await t.call<any>('GET', '/public/daycares/happy-tails')).body;
    expect(pub.bookingPolicy).toMatchObject({ lateCancelFeeCents: 2000, cancelWindowHours: 24 });
    expect(pub.bookingPolicy.salesTaxBps).toBeUndefined();
  });

  it('applies the multi-dog discount, a manager discount, tax on add-ons and a tip', async () => {
    // Luna and Pepper are both Sam's; Mochi is someone else's dog.
    const luna = await dog('Luna');
    const pepper = await dog('Pepper');
    const mochi = await dog('Mochi');
    const first = await t.call<any>('POST', '/visits', staff, { dogId: luna.id, service: 'daycare', plan: 'full' });
    expect(first.status).toBe(200);
    t.clock.t += 60_000;
    const v = (await t.call<any>('POST', '/visits', staff, { dogId: pepper.id, service: 'daycare', plan: 'full' })).body;
    const other = (await t.call<any>('POST', '/visits', staff, { dogId: mochi.id, service: 'daycare', plan: 'full' })).body;
    t.clock.t += 3 * 3_600_000;
    const plain = (await t.call<any>('GET', `/visits/${v.id}/bill`, staff)).body;
    expect(plain.lines.find((l: any) => l.kind === 'discount').text).toBe('Multi-dog discount, 10%');
    expect((await t.call<any>('GET', `/visits/${first.body.id}/bill`, staff)).body.lines.some((l: any) => l.kind === 'discount')).toBe(false);
    expect((await t.call<any>('GET', `/visits/${other.id}/bill`, staff)).body.lines.some((l: any) => l.kind === 'discount')).toBe(false);
    expect(plain.tipOptions.map((o: any) => o.percent)).toEqual([15, 18, 20]);

    // Staff can tip but not discount.
    expect((await t.call('GET', `/visits/${v.id}/bill?discountPercent=10&discountReason=Birthday`, staff)).status).toBe(403);
    expect((await t.call('GET', `/visits/${v.id}/bill?discountPercent=10`, mgr)).status).toBe(400);
    const full = (await t.call<any>('GET', `/visits/${v.id}/bill?addOns=nails&discountCents=500&discountReason=Regular&tipCents=600`, mgr)).body;
    const kinds = full.lines.map((l: any) => l.kind);
    expect(kinds.slice(-3)).toEqual(['discount', 'tax', 'tip']);
    const tax = full.lines.find((l: any) => l.kind === 'tax');
    expect(tax.text).toMatch(/^Sales tax 8%/);
    const out = await t.call<any>('POST', `/visits/${v.id}/checkout`, mgr, { addOns: ['nails'], discountCents: 500, discountReason: 'Regular', tipCents: 600, pay: { method: 'cash' } });
    expect(out.status).toBe(200);
    expect(out.body.invoice.totalCents).toBe(full.total);
    expect(out.body.invoice.lines.filter((l: any) => l.kind === 'discount').map((l: any) => l.text)).toEqual(['Multi-dog discount, 10%', 'Discount: Regular']);
  });

  it('charges late-cancel and no-show fees on confirmed bookings, unless a manager waives them', async () => {
    const olive = await dog('Olive');
    // Tomorrow is inside the 24-hour window.
    const bk = (await t.call<any>('POST', '/bookings', staff, { dogId: olive.id, service: 'daycare', plan: 'full', date: '2026-11-05' })).body;
    const cancelled = await t.call<any>('POST', `/bookings/${bk.id}/status`, staff, { status: 'cancelled' });
    expect(cancelled.body.feeInvoiceId).toBeTruthy();
    const inv = (await t.call<any>('GET', `/invoices/${cancelled.body.feeInvoiceId}`, mgr)).body.invoice;
    expect(inv).toMatchObject({ totalCents: 2000, status: 'open' });
    expect(inv.lines[0].text).toMatch(/^Late cancellation: Olive/);

    // Far ahead: free to cancel.
    const later = (await t.call<any>('POST', '/bookings', staff, { dogId: olive.id, service: 'daycare', plan: 'full', date: '2026-11-20' })).body;
    expect((await t.call<any>('POST', `/bookings/${later.id}/status`, staff, { status: 'cancelled' })).body.feeInvoiceId).toBeNull();

    const missed = (await t.call<any>('POST', '/bookings', staff, { dogId: olive.id, service: 'daycare', plan: 'full', date: '2026-11-06' })).body;
    expect((await t.call('POST', `/bookings/${missed.id}/status`, staff, { status: 'no_show', waiveFee: true })).status).toBe(403);
    expect((await t.call<any>('POST', `/bookings/${missed.id}/status`, mgr, { status: 'no_show', waiveFee: true })).body.feeInvoiceId).toBeNull();
    const missed2 = (await t.call<any>('POST', '/bookings', staff, { dogId: olive.id, service: 'daycare', plan: 'full', date: '2026-11-07' })).body;
    const ns = (await t.call<any>('POST', `/bookings/${missed2.id}/status`, staff, { status: 'no_show' })).body;
    expect((await t.call<any>('GET', `/invoices/${ns.feeInvoiceId}`, mgr)).body.invoice.totalCents).toBe(3000);
  });

  it('enforces online-booking rules for owners and warns them about the fee', async () => {
    const biscuit = await dog('Biscuit');
    expect((await t.call('POST', '/me/bookings', dana, { dogId: biscuit.id, service: 'daycare', plan: 'full', date: '2026-12-30' })).status).toBe(400);
    await t.call('PATCH', '/settings', mgr, { policies: { onlineBooking: { autoApprove: true } } });
    const bk = await t.call<any>('POST', '/me/bookings', dana, { dogId: biscuit.id, service: 'daycare', plan: 'full', date: '2026-11-05' });
    expect(bk.body.status).toBe('confirmed');
    const mine = (await t.call<any[]>('GET', '/me/bookings', dana)).body.find((b) => b.id === bk.body.id);
    expect(mine.cancelFeeCents).toBe(2000);
    await t.call('PATCH', '/settings', mgr, { policies: { onlineBooking: { enabled: false } } });
    expect((await t.call('POST', '/me/bookings', dana, { dogId: biscuit.id, service: 'daycare', plan: 'full', date: '2026-11-09' })).status).toBe(400);
    // The desk can still book.
    expect((await t.call('POST', '/bookings', staff, { dogId: biscuit.id, service: 'daycare', plan: 'full', date: '2026-11-09' })).status).toBe(200);
  });
});
