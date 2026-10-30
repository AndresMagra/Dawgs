import { useEffect, useState } from 'react';
import { money, type AuthorizedPerson, type Bill, type PayOutcome } from '@dawgs/client';
import { Button, Divider, Line, Notice, P, Pick, Row, Sheet, useLoad } from '@dawgs/ui';
import { api } from './session';
import { attempt, say } from './alert';

interface AddOn {
  id: string;
  code: string;
  name: string;
  priceCents: number;
  active: boolean;
}

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
  useEffect(() => {
    if (!visitId) return;
    setDeclined(null);
    setOpenInvoice(null);
    setPickedUpBy(null);
    void api.get<Bill>(`/visits/${visitId}/bill?addOns=${extras.join(',')}`).then(setBill).catch(() => setBill(null));
  }, [visitId, extras]);

  // Choosing who collects the dog comes before payment; a retry after a decline skips it.
  const needsPickup = !openInvoice && !pickedUpBy;

  async function pay(method: 'card' | 'cash' | 'later') {
    if (!visitId) return;
    const r = openInvoice
      ? await attempt(() => api.post<PayOutcome>(`/invoices/${openInvoice}/pay`, { pay: { method } }))
      : await attempt(() => api.post<PayOutcome>(`/visits/${visitId}/checkout`, { addOns: extras, pay: { method }, ...(pickedUpBy ? { pickedUpBy } : {}) }));
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
          options={(settings.data?.addOns ?? []).filter((a) => a.active).map((a) => ({ value: a.code, label: `${extras.includes(a.code) ? '✓ ' : ''}${a.name} ${money(a.priceCents)}` }))}
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
            <Line key={i} left={l.text} right={money(l.amount)} muted={l.kind === 'credit'} />
          ))}
          <Divider />
          <Line left="Total" right={money(bill.total)} bold />
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
