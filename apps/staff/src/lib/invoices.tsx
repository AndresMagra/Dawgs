import { useState } from 'react';
import { View } from 'react-native';
import { day, invoiceStage, money, time, todayKey, type Invoice, type InvoiceSend, type PayOutcome } from '@dawgs/client';
import { Button, Chip, Divider, Field, H2, Line, Notice, P, Pick, Row, Sheet, Toggle, useLoad } from '@dawgs/ui';
import { api, useSession } from './session';
import { attempt, confirm, say } from './alert';
import { orNull } from './sheets';

interface Detail {
  invoice: Invoice;
  owner: { name: string; email: string | null; phone: string | null };
  payments: { id: string; method: string; amountCents: number; refundedCents: number; status: string; createdAt: string }[];
  sends: InvoiceSend[];
}

/** Email and/or text toggles, defaulting to whatever the owner can receive. */
function SendChoice({ email, phone, value, onChange }: { email: string | null; phone: string | null; value: { email: boolean; sms: boolean }; onChange: (v: { email: boolean; sms: boolean }) => void }) {
  return (
    <>
      <Toggle label={email ? `Email to ${email}` : 'Email (no address on file)'} value={value.email && !!email} onChange={(v) => onChange({ ...value, email: v })} />
      <Toggle label={phone ? `Text to ${phone}` : 'Text (no mobile on file)'} value={value.sms && !!phone} onChange={(v) => onChange({ ...value, sms: v })} />
    </>
  );
}

/** One invoice: lines, where it stands, send or resend, take payment, refund. */
export function InvoiceSheet({ invoiceId, hasCard, onClose, onDone }: { invoiceId: string | null; hasCard?: boolean; onClose: () => void; onDone: () => void }) {
  const { isManager, business } = useSession();
  const tz = business?.timezone ?? 'America/New_York';
  const d = useLoad(() => (invoiceId ? api.get<Detail>(`/invoices/${invoiceId}`) : Promise.resolve(null)), [invoiceId]);
  const [send, setSend] = useState({ email: true, sms: true });
  const [message, setMessage] = useState('');
  const [due, setDue] = useState<string | null>(null);
  if (!invoiceId) return null;
  const x = d.data;
  const inv = x?.invoice;
  const stage = inv ? invoiceStage(inv, todayKey(tz)) : null;
  const reload = () => {
    void d.reload();
    onDone();
  };
  async function pay(method: 'card' | 'cash') {
    const r = await attempt(() => api.post<PayOutcome>(`/invoices/${invoiceId}/pay`, { pay: { method } }));
    if (r?.declined) return say('Card declined', r.declined.message);
    if (r) reload();
  }
  return (
    <Sheet visible onClose={onClose} title={inv ? `Invoice #${inv.number}` : 'Invoice'}>
      {!inv || !x ? (
        <P muted>Loading…</P>
      ) : (
        <>
          <Row between>
            <P bold>{x.owner.name}</P>
            {stage ? <Chip text={stage.text} tone={stage.tone} /> : null}
          </Row>
          <P small muted>
            {day(inv.createdAt, tz)}
            {inv.dueDate ? ` · due ${inv.dueDate}` : ''}
            {inv.sentAt ? ` · sent ${day(inv.sentAt, tz)}` : ''}
            {inv.viewedAt ? ` · opened ${day(inv.viewedAt, tz)}` : ''}
            {inv.remindersSent ? ` · ${inv.remindersSent} reminder${inv.remindersSent > 1 ? 's' : ''}` : ''}
          </P>
          {inv.lines.map((l, i) => (
            <Line key={i} left={l.text} right={money(l.amount)} muted={l.kind === 'credit'} />
          ))}
          <Divider />
          <Line left="Total" right={money(inv.totalCents)} bold />
          {inv.memo ? <P small muted>{inv.memo}</P> : null}
          {x.payments.map((p) => (
            <Row key={p.id} between>
              <P small muted>
                {p.status === 'succeeded' ? 'Paid' : 'Failed'} {money(p.amountCents)} by {p.method} · {day(p.createdAt, tz)}
                {p.refundedCents ? ` · refunded ${money(p.refundedCents)}` : ''}
              </P>
              {isManager && p.status === 'succeeded' && p.refundedCents < p.amountCents ? (
                <Button
                  small
                  variant="ghost"
                  title="Refund"
                  onPress={async () => {
                    const left = p.amountCents - p.refundedCents;
                    if (!(await confirm('Refund?', `Refund ${money(left)} to the owner.`))) return;
                    if (await attempt(() => api.post(`/payments/${p.id}/refund`, { amountCents: left }))) reload();
                  }}
                />
              ) : null}
            </Row>
          ))}

          {inv.status === 'open' ? (
            <>
              <H2>{inv.sentAt ? 'Send again' : 'Send to the client'}</H2>
              <SendChoice email={x.owner.email} phone={x.owner.phone} value={send} onChange={setSend} />
              <Field label="Personal note (optional)" value={message} onChangeText={setMessage} />
              <Button
                variant="primary"
                title="Send with a pay link"
                disabled={!(send.email && x.owner.email) && !(send.sms && x.owner.phone)}
                onPress={async () => {
                  const r = await attempt(() => api.post<{ sends: InvoiceSend[] }>(`/invoices/${invoiceId}/send`, { email: send.email && !!x.owner.email, sms: send.sms && !!x.owner.phone, message: orNull(message) }));
                  if (!r) return;
                  const bad = r.sends.filter((s) => s.status !== 'sent');
                  if (bad.length) say('Partly sent', bad.map((s) => `${s.channel === 'email' ? 'Email' : 'Text'}: ${s.error ?? s.status}`).join('\n'));
                  setMessage('');
                  reload();
                }}
              />
              <Row wrap>
                <Button title="Charge card on file" disabled={hasCard === false} onPress={() => pay('card')} />
                <Button title="Cash" onPress={() => pay('cash')} />
                {isManager ? <Button variant="ghost" title="Void" onPress={async () => (await confirm('Void invoice?', 'It will no longer be owed.')) && (await attempt(() => api.post(`/invoices/${invoiceId}/void`, {}))) && reload()} /> : null}
              </Row>
              <Row>
                <Field label="Due date (YYYY-MM-DD)" value={due ?? inv.dueDate ?? ''} onChangeText={setDue} />
                <Button small title="Save" disabled={due === null} onPress={async () => (await attempt(() => api.patch(`/invoices/${invoiceId}`, { dueDate: orNull(due ?? '') }))) && (setDue(null), reload())} />
              </Row>
            </>
          ) : null}

          {x.sends.length ? <H2>History</H2> : null}
          {x.sends.map((s) => (
            <P key={s.id} small muted>
              {day(s.createdAt, tz)} {time(s.createdAt, tz)} · {s.kind === 'reminder' ? 'Reminder' : 'Invoice'} by {s.channel === 'email' ? 'email' : 'text'} to {s.to || '—'} ·{' '}
              {s.status === 'sent' ? 'delivered to provider' : `${s.status}${s.error ? `: ${s.error}` : ''}`} · {s.sentBy}
            </P>
          ))}
        </>
      )}
    </Sheet>
  );
}

/** Write an invoice by hand for any client, and send it straight away if wanted. */
export function NewInvoiceSheet({
  open,
  owner,
  dogs,
  onClose,
  onDone,
}: {
  open: boolean;
  owner: { id: string; name: string; email: string | null; phone: string | null };
  dogs: { id: string; name: string }[];
  onClose: () => void;
  onDone: (invoiceId: string) => void;
}) {
  const { business } = useSession();
  const tz = business?.timezone ?? 'America/New_York';
  const [lines, setLines] = useState([{ text: '', amount: '' }]);
  const [dogId, setDogId] = useState<string | null>(null);
  const [due, setDue] = useState(todayKey(tz, 14));
  const [memo, setMemo] = useState('');
  const [send, setSend] = useState({ email: true, sms: true });
  const total = lines.reduce((s, l) => s + Math.round((Number(l.amount) || 0) * 100), 0);
  const ready = lines.every((l) => l.text.trim() && l.amount.trim() && !Number.isNaN(Number(l.amount))) && total >= 0;
  async function save(sendNow: boolean) {
    const body = {
      ownerId: owner.id,
      dogId,
      lines: lines.map((l) => ({ text: l.text.trim(), amountCents: Math.round(Number(l.amount) * 100) })),
      dueDate: orNull(due),
      memo: orNull(memo),
      ...(sendNow ? { send: { email: send.email && !!owner.email, sms: send.sms && !!owner.phone } } : {}),
    };
    const r = await attempt(() => api.post<{ invoice: Invoice; sends: InvoiceSend[] }>('/invoices', body));
    if (!r) return;
    const bad = r.sends.filter((s) => s.status !== 'sent');
    if (bad.length) say('Saved, partly sent', bad.map((s) => `${s.channel === 'email' ? 'Email' : 'Text'}: ${s.error ?? s.status}`).join('\n'));
    setLines([{ text: '', amount: '' }]);
    setMemo('');
    onDone(r.invoice.id);
  }
  return (
    <Sheet visible={open} onClose={onClose} title={`New invoice for ${owner.name}`}>
      {dogs.length ? <Pick label="For which dog (optional)" value={dogId} onChange={setDogId} options={dogs.map((x) => ({ value: x.id, label: x.name }))} /> : null}
      {lines.map((l, i) => (
        <Row key={i}>
          <View style={{ flex: 3 }}>
            <Field label={i === 0 ? 'Item' : `Item ${i + 1}`} value={l.text} onChangeText={(v) => setLines(lines.map((x, j) => (j === i ? { ...x, text: v } : x)))} />
          </View>
          <View style={{ flex: 1.3 }}>
            <Field label="$ (−for discount)" value={l.amount} onChangeText={(v) => setLines(lines.map((x, j) => (j === i ? { ...x, amount: v } : x)))} keyboardType="numbers-and-punctuation" />
          </View>
          {lines.length > 1 ? <Button small variant="ghost" title="✕" onPress={() => setLines(lines.filter((_, j) => j !== i))} /> : null}
        </Row>
      ))}
      <Button small title="Add a line" onPress={() => setLines([...lines, { text: '', amount: '' }])} />
      <Line left="Total" right={money(total)} bold />
      {total < 0 ? <Notice tone="bad" text="The total can't be below zero." /> : null}
      <Field label="Due date (blank = due on receipt, no reminders)" value={due} onChangeText={setDue} />
      <Field label="Note on the invoice" value={memo} onChangeText={setMemo} multiline />
      <SendChoice email={owner.email} phone={owner.phone} value={send} onChange={setSend} />
      <Row wrap>
        <Button variant="primary" title="Create and send" disabled={!ready || (!(send.email && owner.email) && !(send.sms && owner.phone))} onPress={() => save(true)} />
        <Button title="Save without sending" disabled={!ready} onPress={() => save(false)} />
      </Row>
    </Sheet>
  );
}
