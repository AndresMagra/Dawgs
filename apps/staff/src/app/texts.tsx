import { Stack, router } from 'expo-router';
import { day, time, type SmsMessage } from '@dawgs/client';
import { Card, Chip, Empty, P, Row, Screen, useLoad } from '@dawgs/ui';
import { api, useSession } from '../lib/session';

/** Every text sent and received, newest first. Replies land here too. */
export default function TextsScreen() {
  const { business } = useSession();
  const tz = business?.timezone;
  const list = useLoad(() => api.get<(SmsMessage & { ownerId: string | null })[]>('/texts'), [], 30_000);
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Texts' }} />
      {list.data?.length === 0 ? <Empty text="No texts yet." /> : null}
      {list.data?.map((m) => (
        <Card key={m.id} onPress={m.ownerId ? () => router.push(`/owner/${m.ownerId}`) : undefined}>
          <Row between>
            <P bold>
              {m.direction === 'in' ? '← ' : '→ '}
              {m.ownerName ?? m.to}
            </P>
            <Row>
              {m.status === 'failed' ? <Chip text="Failed" tone="bad" /> : null}
              {m.status === 'skipped' ? <Chip text="Not sent" tone="warn" /> : null}
              <P small muted>
                {day(m.createdAt, tz)} {time(m.createdAt, tz)}
              </P>
            </Row>
          </Row>
          <P>{m.body}</P>
          <P small muted>
            {m.kind.replace('_', ' ')}
            {m.sentBy ? ` · ${m.sentBy}` : ''}
            {m.error ? ` · ${m.error}` : ''}
          </P>
        </Card>
      ))}
    </Screen>
  );
}
