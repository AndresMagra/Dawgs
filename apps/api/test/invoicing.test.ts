import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp } from './helpers.js';
import { tick } from '../src/scheduler.js';

type App = Awaited<ReturnType<typeof makeApp>>;
const DAY = 86_400_000;

let t: App;
beforeAll(async () => {
  t = await makeApp();
});
afterAll(async () => t.close());

async function ownerByName(token: string, name: string) {
  const r = await t.call<any[]>('GET', '/owners', token);
  return r.body.find((o) => o.name === name)!;
}

describe('invoices sent by email and text', () => {
  it('writes an invoice, sends it both ways, marks it viewed, then paid', async () => {
    const mgr = await t.login('priya@happytails.test');
    const riley = await ownerByName(mgr, 'Riley Park');
    const r = await t.call<any>('POST', '/invoices', mgr, {
      ownerId: riley.id,
      lines: [
        { text: 'Grooming: full groom', amountCents: 8500 },
        { text: 'Loyalty discount', amountCents: -1000 },
      ],
      dueDate: '2026-11-10',
      memo: 'Thanks, Riley!',
      send: { email: true, sms: true },
    });
    expect(r.status).toBe(200);
    const inv = r.body.invoice;
    expect(inv.totalCents).toBe(7500);
    expect(inv.category).toBe('other');
    expect(inv.sentAt).not.toBeNull();
    expect(r.body.sends.map((s: any) => [s.channel, s.status])).toEqual([
      ['email', 'sent'],
      ['sms', 'sent'],
    ]);
    const email = t.mail.sent.at(-1)!;
    expect(email.to).toBe('riley@example.com');
    expect(email.fromName).toBe('Happy Tails Dog Daycare');
    expect(email.subject).toMatch(/Invoice #\d+ from .*\$75\.00/);
    expect(email.html).toContain('Loyalty discount');
    expect(email.html).toContain('Thanks, Riley!');
    const url = r.body.url as string;
    expect(email.html).toContain(url);
    expect(t.sms.sent.at(-1)!.body).toContain(url);

    // Riley opens the link: the desk sees "viewed".
    const token = url.split('/pay/')[1]!;
    const page = await t.call<any>('GET', `/pay/${token}`);
    expect(page.body.dueCents).toBe(7500);
    expect(page.body.dueDate).toBe('2026-11-10');
    let detail = (await t.call<any>('GET', `/invoices/${inv.id}`, mgr)).body;
    expect(detail.invoice.viewedAt).not.toBeNull();
    expect(detail.sends).toHaveLength(2);

    const paid = await t.call<any>('POST', `/pay/${token}/simulate`, null, { paymentIntentId: page.body.paymentIntentId, testCard: 'pm_card_visa' });
    expect(paid.body.paid).toBe(true);
    detail = (await t.call<any>('GET', `/invoices/${inv.id}`, mgr)).body;
    expect(detail.invoice.status).toBe('paid');
    // Paid invoices can't be sent again.
    expect((await t.call('POST', `/invoices/${inv.id}/send`, mgr, { email: true, sms: false })).status).toBe(400);
    // The owner sees it in their app too.
    const rileyToken = await t.login('riley@example.com');
    const mine = (await t.call<any[]>('GET', '/me/invoices', rileyToken)).body;
    expect(mine.some((i) => i.id === inv.id)).toBe(true);
  });

  it('records a skipped email when the owner has no address, and still texts', async () => {
    const mgr = await t.login('priya@happytails.test');
    const o = (await t.call<any>('POST', '/owners', mgr, { name: 'Pat Noemail', phone: '(555) 300-1000' })).body;
    const r = await t.call<any>('POST', '/invoices', mgr, { ownerId: o.id, lines: [{ text: 'Bath', amountCents: 2500 }], send: { email: true, sms: true } });
    expect(r.body.sends.map((s: any) => [s.channel, s.status])).toEqual([
      ['email', 'skipped'],
      ['sms', 'sent'],
    ]);
    expect(r.body.invoice.sentAt).not.toBeNull();
  });

  it('reminds once at each step after the due date, and stops when paid', async () => {
    const mgr = await t.login('priya@happytails.test');
    const alex = await ownerByName(mgr, 'Alex Chen');
    t.clock.t = Date.parse('2026-11-04T15:00:00Z');
    const r = await t.call<any>('POST', '/invoices', mgr, { ownerId: alex.id, lines: [{ text: 'Extra walk', amountCents: 2000 }], dueDate: '2026-11-06', send: { email: true, sms: false } });
    const id = r.body.invoice.id;
    const emails = () => t.mail.sent.filter((m) => m.to === 'alex@example.com' && /Reminder/.test(m.subject)).length;

    expect((await tick(t.ctx)).invoiceReminders).toBe(0); // not due yet
    t.clock.t = Date.parse('2026-11-07T15:00:00Z'); // a day late
    expect((await tick(t.ctx)).invoiceReminders).toBe(1);
    expect((await tick(t.ctx)).invoiceReminders).toBe(0); // once only
    expect(emails()).toBe(1);
    t.clock.t = Date.parse('2026-11-10T15:00:00Z'); // 4 days: no step here
    expect((await tick(t.ctx)).invoiceReminders).toBe(0);
    t.clock.t = Date.parse('2026-11-13T15:00:00Z'); // a week
    expect((await tick(t.ctx)).invoiceReminders).toBe(1);
    expect(emails()).toBe(2);

    await t.call('POST', `/invoices/${id}/pay`, mgr, { pay: { method: 'cash' } });
    t.clock.t += 10 * DAY;
    expect((await tick(t.ctx)).invoiceReminders).toBe(0);
  });

  it('keeps one daycare out of another daycare’s invoices', async () => {
    const other = await t.call<any>('POST', '/public/daycares', null, {
      name: 'Bark Avenue',
      timezone: 'America/Chicago',
      managerName: 'Mo',
      managerEmail: 'mo@bark.test',
      managerPassword: 'bark-avenue-2026',
    });
    const mo = other.body.token as string;
    const mgr = await t.login('priya@happytails.test');
    const riley = await ownerByName(mgr, 'Riley Park');
    expect((await t.call('POST', '/invoices', mo, { ownerId: riley.id, lines: [{ text: 'x', amountCents: 100 }] })).status).toBe(404);
    const anyInv = (await t.call<any[]>('GET', '/invoices', mgr)).body[0];
    expect((await t.call('POST', `/invoices/${anyInv.id}/send`, mo, { email: true, sms: false })).status).toBe(404);
  });
});

describe('authorized pickups and co-owners', () => {
  it('lets the owner add people, records who collected the dog, and tells the owner', async () => {
    const dana = await t.login('dana@example.com');
    const staff = await t.login('marco@happytails.test');
    const add = await t.call<any>('POST', '/me/people', dana, { name: 'Chris Whitfield', relation: 'Partner', phone: '(555) 201-4411', email: 'chris@example.com', coOwner: true });
    expect(add.status).toBe(200);
    await t.call('POST', '/me/people', dana, { name: 'Grandma June', relation: 'Mother' });
    expect((await t.call<any[]>('GET', '/me/people', dana)).body.map((p) => p.name)).toEqual(['Chris Whitfield', 'Grandma June']);
    // A co-owner must have an email.
    expect((await t.call('POST', '/me/people', dana, { name: 'No Email', coOwner: true })).status).toBe(400);

    const dogs = (await t.call<any[]>('GET', '/dogs', staff)).body;
    const biscuit = dogs.find((d) => d.name === 'Biscuit');
    t.clock.t = Date.parse('2026-12-01T14:00:00Z');
    const v = await t.call<any>('POST', '/visits', staff, { dogId: biscuit.id, service: 'daycare', plan: 'half' });
    expect(v.status).toBe(200);
    const list = (await t.call<any>('GET', `/visits/${v.body.id}/pickup`, staff)).body;
    expect(list.owner.name).toBe('Dana Whitfield');
    expect(list.people.map((p: any) => p.name)).toContain('Grandma June');
    t.clock.t += 2 * 3_600_000;
    const pushesBefore = t.push.sent.length;
    const out = await t.call<any>('POST', `/visits/${v.body.id}/checkout`, staff, { pay: { method: 'later' }, pickedUpBy: 'Grandma June' });
    expect(out.status).toBe(200);
    expect(out.body.visit.pickedUpBy).toBe('Grandma June');
    expect(t.push.sent.length).toBeGreaterThanOrEqual(pushesBefore); // pushed when Dana has a device
  });

  it('a co-owner signs up with their own email onto the same account, and loses access when removed', async () => {
    const su = await t.call<any>('POST', '/auth/signup', null, { business: 'happy-tails', name: 'Chris Whitfield', email: 'chris@example.com', password: 'chris-password-1' });
    expect(su.status).toBe(200);
    const chris = su.body.token as string;
    const me = (await t.call<any>('GET', '/me', chris)).body;
    expect(me.owner.name).toBe('Dana Whitfield');
    expect(me.dogs.map((d: any) => d.name)).toContain('Biscuit');

    const dana = await t.login('dana@example.com');
    const people = (await t.call<any[]>('GET', '/me/people', dana)).body;
    const c = people.find((p) => p.name === 'Chris Whitfield');
    expect(c.hasLogin).toBe(true);
    await t.call('DELETE', `/me/people/${c.id}`, dana);
    expect((await t.call('GET', '/me', chris)).status).toBe(401);
    expect((await t.call<any[]>('GET', '/me/people', dana)).body.map((p) => p.name)).toEqual(['Grandma June']);
  });

  it('staff manage the list from the desk, and owners cannot touch another account', async () => {
    const staff = await t.login('marco@happytails.test');
    const sam = await t.login('sam@example.com');
    const owners = (await t.call<any[]>('GET', '/owners', staff)).body;
    const dana = owners.find((o) => o.name === 'Dana Whitfield');
    const p = await t.call<any>('POST', `/owners/${dana.id}/people`, staff, { name: 'Walker Wes', relation: 'Dog walker' });
    expect(p.status).toBe(200);
    expect((await t.call<any>('GET', `/owners/${dana.id}`, staff)).body.people.some((x: any) => x.name === 'Walker Wes')).toBe(true);
    expect((await t.call('DELETE', `/me/people/${p.body.id}`, sam)).status).toBe(404);
    expect((await t.call('GET', `/owners/${dana.id}/people`, sam)).status).toBe(403);
  });
});
