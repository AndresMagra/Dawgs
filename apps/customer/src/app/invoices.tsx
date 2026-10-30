import { Stack, router } from 'expo-router';
import { day, money, type Invoice } from '@dawgs/client';
import { Card, Chip, Empty, P, Row, Screen, useLoad } from '@dawgs/ui';
import { api, useSession } from '../lib/session';

export default function Invoices() {
  const { business } = useSession();
  const list = useLoad(() => api.get<Invoice[]>('/me/invoices'), []);
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Invoices' }} />
      {list.data?.length === 0 ? <Empty text="No invoices yet." /> : null}
      {list.data?.map((i) => (
        <Card key={i.id} onPress={() => router.push(`/invoice/${i.id}`)}>
          <Row between>
            <P bold>
              #{i.number} · {money(i.totalCents)}
            </P>
            <Chip text={i.status === 'open' ? (i.dueDate ? `Due ${i.dueDate}` : 'To pay') : i.status.replace('_', ' ')} tone={i.status === 'open' ? 'warn' : i.status === 'paid' ? 'ok' : ''} />
          </Row>
          <P small muted>
            {day(i.createdAt, business?.timezone)} · {i.lines.map((l) => l.text).slice(0, 2).join(', ')}
          </P>
        </Card>
      ))}
    </Screen>
  );
}
