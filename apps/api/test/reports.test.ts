import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp } from './helpers.js';

type App = Awaited<ReturnType<typeof makeApp>>;

let t: App;
let mgr: string;
let staff: string;
beforeAll(async () => {
  t = await makeApp(); // Wed 4 Nov 2026, 08:00 Eastern
  mgr = await t.login('priya@happytails.test');
  staff = await t.login('marco@happytails.test');
});
afterAll(async () => t.close());

const dog = async (name: string) => (await t.call<any[]>('GET', '/dogs', mgr)).body.find((d) => d.name === name)!;

describe('reports and exports', () => {
  it('adds up revenue by service and day, tips and tax apart, top clients and staff hours', async () => {
    await t.call('PATCH', '/settings', mgr, { policies: { salesTaxBps: 1000 } });
    await t.call('POST', '/clock/in', staff);
    const olive = await dog('Olive');
    const v = (await t.call<any>('POST', '/visits', staff, { dogId: olive.id, service: 'daycare', plan: 'full' })).body;
    t.clock.t += 4 * 3_600_000;
    const out = await t.call<any>('POST', `/visits/${v.id}/checkout`, staff, { addOns: ['nails'], tipCents: 500, pay: { method: 'cash' } });
    expect(out.status).toBe(200);
    await t.call('POST', '/clock/out', staff);
    // $40 day + $15 nails + $1.50 tax + $5 tip
    // Payments are stamped by the database clock, not the test clock, so take a wide range.
    const r = (await t.call<any>('GET', '/reports?from=2026-10-01&to=2026-11-30', mgr)).body;
    expect(r.revenue.totalCents).toBe(6150);
    expect(r.revenue.tipsCents).toBe(500);
    expect(r.revenue.taxCents).toBe(150);
    expect(r.revenue.byService).toEqual([{ service: 'daycare', cents: 6150 }]);
    expect(r.revenue.byDay).toHaveLength(61);
    expect(r.revenue.byDay.reduce((n: number, d: any) => n + d.cents, 0)).toBe(6150);
    expect(r.topClients[0]).toMatchObject({ name: 'Riley Park', cents: 6150 });
    expect(r.staffHours.find((h: any) => h.name.startsWith('Marco'))).toMatchObject({ shifts: 1, hours: 4 });
    expect(r.occupancy).toHaveLength(14);
    expect(r.credits.cents).toBeGreaterThanOrEqual(0);
  });

  it('counts money paid for credits not used yet as owed', async () => {
    const sam = await t.login('sam@example.com');
    const luna = await dog('Luna');
    const before = (await t.call<any>('GET', '/reports', mgr)).body.credits.cents;
    const pack = (await t.call<any[]>('GET', '/me/packages', sam)).body.find((p) => p.name.startsWith('10-day'));
    await t.call('POST', `/owners/${luna.owner.id}/cards`, staff, { testCard: 'pm_card_visa' });
    const bought = await t.call<any>('POST', `/me/packages/${pack.id}/buy`, sam, { dogId: luna.id });
    expect(bought.status).toBe(200);
    const after = (await t.call<any>('GET', '/reports', mgr)).body.credits.cents;
    expect(after - before).toBe(36000);
  });

  it('exports CSV that spreadsheets read safely, for managers only', async () => {
    expect((await t.call('GET', '/reports', staff)).status).toBe(403);
    expect((await t.call('GET', '/reports/export?kind=clients', staff)).status).toBe(403);
    expect((await t.call('GET', '/reports?from=2026-11-05&to=2026-11-01', mgr)).status).toBe(400);
    const c = (await t.call<any>('GET', '/reports/export?kind=clients', mgr)).body;
    expect(c.filename).toMatch(/^happy-tails-clients-.*\.csv$/);
    const lines = c.csv.trim().split('\r\n');
    expect(lines[0]).toBe('Client,Email,Phone,Address,Texts OK,Dog,Breed');
    expect(lines.some((l: string) => l.startsWith('Dana Whitfield,dana@example.com'))).toBe(true);
    // A name that looks like a formula is defused.
    const owners = (await t.call<any[]>('GET', '/owners', mgr)).body;
    await t.call('PATCH', `/owners/${owners[0].id}`, mgr, { name: '=HYPERLINK("x")' });
    const again = (await t.call<any>('GET', '/reports/export?kind=clients', mgr)).body.csv as string;
    expect(again).toContain(`"'=HYPERLINK(""x"")"`);
    for (const kind of ['payments', 'invoices', 'bookings', 'staff-hours']) {
      const r = await t.call<any>('GET', `/reports/export?kind=${kind}&from=2026-11-01&to=2026-11-30`, mgr);
      expect(r.status).toBe(200);
      expect(r.body.csv.split('\r\n').length).toBeGreaterThan(1);
    }
    const log = (await t.call<any[]>('GET', '/log', mgr)).body;
    expect(JSON.stringify(log)).toContain('Exported clients');
  });
});
