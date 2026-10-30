import { useEffect, useState } from 'react';
import { money, type AddOn, type AuthorizedPerson, type Bill, type PayOutcome } from '@dawgs/client';
import { Button, Divider, Field, Line, Notice, P, Pick, Row, Sheet, useLoad } from '@dawgs/ui';
import { api, useSession } from './session';
import { attempt, say } from './alert';

/** Bill preview with add-ons, then card on file, cash, or "pay later" (send a link). */
export function CheckoutSheet({ visitId, dogName, card, onClose, onDone }: { visitId: string | null; dogName: string; card: string | null; onClose: () => void; onDone: () => void }) {
  const [extras, setExtras] = useState<string[]>([]);
  const [bill, setBill] = useState<Bill | null>(null);
  const [declined, setDeclined] = useState<string | null>(null);
  const [openInvoice, setOpenInvoice] = useState<string | null>(null);
  const settings = useLoad(() => api.get<{ addOns: AddOn[] }>('/settings'), []);
  const pickup = useLoad(
    () => (visitId ? api.get<{ owner: { name: string }; people: AuthorizedPerson[] }>(`/visits/${visitId}/pickup`) : Promise.resolve(null)),
    [visitId],
  );
  const [pickedUpBy, setPickedUpBy] = useState<string | null>(null);
  const { can } = useSession();
  const [tip, setTip] = useState<number>(0);
  const [customTip, setCustomTip] = useState('');
  const [discountOpen, setDiscountOpen] = useState(false);
  const [discount, setDiscount] = useState({ amount: '', percent: '', reason: '' });
  const discountParams = ((): Record<string, string | number> => {
    const reason = discount.reason.trim();
    if (!reason) return {};
    if (Number(discount.percent) > 0) return { discountPercent: Number(discount.percent), discountReason: reason };
    if (Number(discount.amount) > 0) return { discountCents: Math.round(Number(discount.amount) * 100), discountReason: reason };
    return {};
  })();
  const tipCents = customTip ? Math.round((Number(customTip) || 0) * 100) : tip;
  const extrasParams: Record<string, string | number> = { ...discountParams, ...(tipCents > 0 ? { tipCents } : {}) };
  useEffect(() => {
    if (!visitId) return;
    setDeclined(null);
    setOpenInvoice(null);
    setPickedUpBy(null);
    setTip(0);
    setCustomTip('');
    setDiscount({ amount: '', percent: '', reason: '' });
    setDiscountOpen(false);
  }, [visitId]);
  useEffect(() => {
    if (!visitId) return;
    const q = new URLSearchParams({ addOns: extras.join(','), ...Object.fromEntries(Object.entries(extrasParams).map(([k, v]) => [k, String(v)])) });
    void api.get<Bill>(`/visits/${visitId}/bill?${q.toString()}`).then(setBill).catch(() => setBill(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visitId, extras, JSON.stringify(extrasParams)]);

  // Choosing who collects the dog comes before payment; a retry after a decline skips it.
  const needsPickup = !openInvoice && !pickedUpBy;

  async function pay(method: 'card' | 'cash' | 'later') {
    if (!visitId) return;
    const r = openInvoice
      ? await attempt(() => api.post<PayOutcome>(`/invoices/${openInvoice}/pay`, { pay: { method } }))
      : await attempt(() => api.post<PayOutcome>(`/visits/${visitId}/checkout`, { addOns: extras, ...extrasParams, pay: { method }, ...(pickedUpBy ? { pickedUpBy } : {}) }));
    if (!r) return;
    if (r.declined) {
      setOpenInvoice(r.invoice.id);
      setDeclined(r.declined.message);
      return;
    }
    if (method === 'later') {
      const link = await attempt(() => api.post<{ url: string | null }>(`/invoices/${r.invoice.id}/link`, { text: true }));
      say(`${dogName} is checked out`, link?.url ? 'A pay link was texted to the owner.' : 'The invoice is open on their account.');
    }
    onDone();
  }

  return (
    <Sheet visible={!!visitId} onClose={onClose} title={`Check out ${dogName}`}>
      {openInvoice ? null : (
        <Pick
          label="Add-ons"
          value={null}
          options={(settings.data?.addOns ?? []).filter((a) => a.active && a.kind === 'extra').map((a) => ({ value: a.code, label: `${extras.includes(a.code) ? '✓ ' : ''}${a.name} ${money(a.priceCents)}` }))}
          onChange={(code) => setExtras((x) => (x.includes(code) ? x.filter((c) => c !== code) : [...x, code]))}
        />
      )}
      {!openInvoice && pickup.data ? (
        <>
          <Pick
            label="Who is picking up?"
            value={pickedUpBy}
            onChange={setPickedUpBy}
            options={[
              { value: pickup.data.owner.name, label: `${pickup.data.owner.name} (owner)` },
              ...pickup.data.people.map((p) => ({ value: p.name, label: `${p.name}${p.relation ? ` (${p.relation})` : ''}` })),
            ]}
          />
          {pickedUpBy && pickup.data.people.find((p) => p.name === pickedUpBy)?.notes ? <Notice tone="info" text={pickup.data.people.find((p) => p.name === pickedUpBy)!.notes!} /> : null}
          <P small muted>Not on the list? Don't release the dog; call the owner.</P>
        </>
      ) : null}
      {bill ? (
        <>
          {bill.lines.map((l, i) => (
            <Line key={i} left={l.text} right={money(l.amount)} muted={l.kind === 'credit' || l.kind === 'discount'} />
          ))}
          <Divider />
          <Line left="Total" right={money(bill.total)} bold />
          {!openInvoice && bill.tipOptions?.length ? (
            <>
              <P small muted>Tip</P>
              <Row wrap>
                <Button small title="No tip" variant={!tipCents ? 'primary' : 'secondary'} onPress={() => { setTip(0); setCustomTip(''); }} />
                {bill.tipOptions.filter((o) => o.cents > 0).map((o) => (
                  <Button key={o.percent} small title={`${o.percent}% · ${money(o.cents)}`} variant={!customTip && tip === o.cents ? 'primary' : 'secondary'} onPress={() => { setTip(o.cents); setCustomTip(''); }} />
                ))}
              </Row>
              <Field label="Other tip ($)" value={customTip} onChangeText={setCustomTip} keyboardType="decimal-pad" />
            </>
          ) : null}
          {!openInvoice && can.discount ? (
            discountOpen ? (
              <>
                <Row>
                  <Field label="Discount $" value={discount.amount} onChangeText={(v) => setDiscount({ ...discount, amount: v, percent: '' })} keyboardType="decimal-pad" />
                  <Field label="or %" value={discount.percent} onChangeText={(v) => setDiscount({ ...discount, percent: v, amount: '' })} keyboardType="decimal-pad" />
                </Row>
                <Field label="Reason (shows on the receipt)" value={discount.reason} onChangeText={(v) => setDiscount({ ...discount, reason: v })} placeholder="Birthday, regular, made a mistake…" />
              </>
            ) : (
              <Button small variant="ghost" title="Give a discount" onPress={() => setDiscountOpen(true)} />
            )
          ) : null}
        </>
      ) : (
        <P muted>Working out the bill…</P>
      )}
      {declined ? <Notice tone="bad" text={`Card declined: ${declined}. The dog is checked out; the bill is still open.`} /> : null}
      <Row wrap>
        <Button variant="primary" title={card ? `Charge ${card}` : 'No card on file'} disabled={!card || needsPickup} onPress={() => pay('card')} />
        <Button title="Cash" disabled={needsPickup} onPress={() => pay('cash')} />
        <Button title="Text a pay link" disabled={needsPickup} onPress={() => pay('later')} />
      </Row>
    </Sheet>
  );
}
