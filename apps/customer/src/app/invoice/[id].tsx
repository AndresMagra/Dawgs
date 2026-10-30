import { Stack, useLocalSearchParams } from 'expo-router';
import { day, money, type Invoice } from '@dawgs/client';
import { Card, Divider, H1, Line, Notice, P, Screen, useLoad } from '@dawgs/ui';
import { api, useSession } from '../../lib/session';
import { say } from '../../lib/alert';
import { useMe } from '../../lib/me';
import { PayWithCard } from '../../lib/pay';

export default function InvoiceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { business } = useSession();
  const tz = business?.timezone;
  const me = useMe();
  const d = useLoad(() => api.get<{ invoice: Invoice; dueCents: number; payments: { id: string; method: string; amountCents: number; refundedCents: number; cardLabel: string | null; createdAt: string }[] }>(`/me/invoices/${id}`), [id]);
  const inv = d.data?.invoice;
  if (!inv) return <Screen><P muted>Loading…</P></Screen>;
  return (
    <Screen>
      <Stack.Screen options={{ title: `Invoice #${inv.number}` }} />
      <H1>{inv.status === 'paid' ? 'Receipt' : 'Invoice'} #{inv.number}</H1>
      <P muted>
        {business?.name} · {day(inv.createdAt, tz)}
        {inv.dueDate && inv.status === 'open' ? ` · due ${inv.dueDate}` : ''}
      </P>
      <Card>
        {inv.lines.map((l, i) => (
          <Line key={i} left={l.text} right={money(l.amount)} muted={l.kind === 'credit'} />
        ))}
        <Divider />
        <Line left="Total" right={money(inv.totalCents)} bold />
        {d.data!.payments.map((p) => (
          <Line key={p.id} left={`Paid ${day(p.createdAt, tz)}${p.cardLabel ? ` · ${p.cardLabel}` : ` · ${p.method}`}`} right={`${money(p.amountCents)}${p.refundedCents ? ` (refunded ${money(p.refundedCents)})` : ''}`} muted />
        ))}
      </Card>
      {inv.memo ? <P>{inv.memo}</P> : null}
      {inv.status === 'open' && d.data!.dueCents > 0 && me.data ? (
        <PayWithCard
          cards={me.data.cards}
          label={`Pay ${money(d.data!.dueCents)}`}
          run={(paymentMethodId) => api.post(`/me/invoices/${id}/pay`, paymentMethodId ? { paymentMethodId } : {})}
          onPaid={() => {
            say('Paid', 'Thank you!');
            void d.reload();
          }}
        />
      ) : null}
      {inv.status === 'paid' ? <Notice tone="ok" text="Paid in full. Thank you!" /> : null}
    </Screen>
  );
}
