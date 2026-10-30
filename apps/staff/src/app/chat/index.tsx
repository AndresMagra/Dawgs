import { Stack, router } from 'expo-router';
import { day, type ChatChannel } from '@dawgs/client';
import { Card, Chip, P, Row, Screen, useLoad } from '@dawgs/ui';
import { api } from '../../lib/session';

export default function ChatList() {
  const list = useLoad(() => api.get<ChatChannel[]>('/chat'), [], 15_000);
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Team chat' }} />
      {list.data?.map((c) => (
        <Card key={c.channel} onPress={() => router.push(`/chat/${encodeURIComponent(c.channel)}?name=${encodeURIComponent(c.name)}`)}>
          <Row between>
            <P bold>{c.name}</P>
            <Row>
              {c.lastAt ? <P small muted>{day(c.lastAt)}</P> : null}
              {c.unread ? <Chip text={String(c.unread)} tone="bad" /> : null}
            </Row>
          </Row>
        </Card>
      ))}
    </Screen>
  );
}
