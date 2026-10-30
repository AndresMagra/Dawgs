import { useState } from 'react';
import { money, type Policies } from '@dawgs/client';
import { Button, Card, Field, H2, P, Row, Toggle } from '@dawgs/ui';

const dollars = (c: number) => (c ? String(c / 100) : '');
const toCents = (s: string) => Math.round((Number(s) || 0) * 100);

/** The daycare's own rules for tax, tips, discounts, cancellations and online booking. */
export function PoliciesForm({ value, onSave }: { value: Policies; onSave: (p: Policies) => Promise<unknown> }) {
  const [p, setP] = useState(value);
  const [tax, setTax] = useState(value.salesTaxBps ? String(value.salesTaxBps / 100) : '');
  const [tips, setTips] = useState(value.tipChoices.join(', '));
  const [late, setLate] = useState(dollars(value.lateCancelFeeCents));
  const [noShow, setNoShow] = useState(dollars(value.noShowFeeCents));
  const set = <K extends keyof Policies>(k: K, v: Policies[K]) => setP((x) => ({ ...x, [k]: v }));
  const setOnline = (patch: Partial<Policies['onlineBooking']>) => setP((x) => ({ ...x, onlineBooking: { ...x.onlineBooking, ...patch } }));
  const save = () =>
    onSave({
      ...p,
      salesTaxBps: Math.round((Number(tax) || 0) * 100),
      tipChoices: tips
        .split(',')
        .map((x) => Math.round(Number(x.trim())))
        .filter((n) => n > 0 && n <= 100)
        .slice(0, 5),
      lateCancelFeeCents: toCents(late),
      noShowFeeCents: toCents(noShow),
    });

  return (
    <>
      <Card>
        <H2>Sales tax</H2>
        <Field label="Rate (%)" value={tax} onChangeText={setTax} keyboardType="decimal-pad" placeholder="0" hint="Check with your accountant which of your sales are taxable where you are." />
        <Toggle label="Tax add-ons and retail" value={p.taxAddOns} onChange={(v) => set('taxAddOns', v)} />
        <Toggle label="Tax daycare and boarding too" value={p.taxServices} onChange={(v) => set('taxServices', v)} />
      </Card>
      <Card>
        <H2>Tips and discounts</H2>
        <Toggle label="Offer tips at check-out" value={p.tipsEnabled} onChange={(v) => set('tipsEnabled', v)} />
        {p.tipsEnabled ? <Field label="Tip buttons (%)" value={tips} onChangeText={setTips} placeholder="15, 18, 20" /> : null}
        <Field
          label="Multi-dog discount (% off each extra dog's daycare day)"
          value={p.multiDogPercent ? String(p.multiDogPercent) : ''}
          onChangeText={(v) => set('multiDogPercent', Math.min(100, Math.max(0, Math.round(Number(v) || 0))))}
          keyboardType="number-pad"
          placeholder="0"
        />
        <P small muted>Managers can also give a one-off discount at check-out, with a reason that prints on the receipt.</P>
      </Card>
      <Card>
        <H2>Cancellations and no-shows</H2>
        <Field
          label="Free to cancel until (hours before the day)"
          value={String(p.cancelWindowHours)}
          onChangeText={(v) => set('cancelWindowHours', Math.max(0, Math.round(Number(v) || 0)))}
          keyboardType="number-pad"
        />
        <Field label="Late-cancel fee ($)" value={late} onChangeText={setLate} keyboardType="decimal-pad" placeholder="0 = no fee" />
        <Field label="No-show fee ($)" value={noShow} onChangeText={setNoShow} keyboardType="decimal-pad" placeholder="0 = no fee" />
        <P small muted>Fees only apply to confirmed bookings. They become an open invoice on the client's account, and a manager can waive one when cancelling.</P>
      </Card>
      <Card>
        <H2>Online booking</H2>
        <Toggle label="Clients can book in their app" value={p.onlineBooking.enabled} onChange={(v) => setOnline({ enabled: v })} />
        <Toggle label="Confirm automatically when there's room" value={p.onlineBooking.autoApprove} onChange={(v) => setOnline({ autoApprove: v })} />
        <Field
          label="How far ahead (days)"
          value={String(p.onlineBooking.daysAhead)}
          onChangeText={(v) => setOnline({ daysAhead: Math.min(365, Math.max(1, Math.round(Number(v) || 1))) })}
          keyboardType="number-pad"
        />
      </Card>
      <Row>
        <Button variant="primary" title="Save rules" onPress={save} />
        {toCents(late) || toCents(noShow) ? <P small muted>{`Clients see: late cancel ${money(toCents(late))}, no-show ${money(toCents(noShow))}`}</P> : null}
      </Row>
    </>
  );
}
