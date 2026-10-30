import { useState } from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { time, type ChatMessage } from '@dawgs/client';
import { Button, Card, Field, P, Row, Screen, useLoad, useTheme } from '@dawgs/ui';
import { api, useSession } from '../../lib/session';
import { attempt } from '../../lib/alert';

export default function ChatRoom() {
  const t = useTheme();
  const { channel, name } = useLocalSearchParams<{ channel: string; name?: string }>();
  const { user, business } = useSession();
  const msgs = useLoad(() => api.get<ChatMessage[]>(`/chat/${encodeURIComponent(channel)}`), [channel], 5_000);
  const [body, setBody] = useState('');
  return (
    <Screen>
      <Stack.Screen options={{ title: name ?? 'Chat' }} />
      {msgs.data?.map((m) => {
        const mine = m.fromUserId === user?.id;
        return (
          <View key={m.id} style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '85%' }}>
            <Card style={mine ? { backgroundColor: t.brand } : undefined}>
              {!mine ? <P small bold>{m.fromName}</P> : null}
              <P style={mine ? { color: '#fff' } : undefined}>{m.body}</P>
              <P small style={{ color: mine ? '#ffffffaa' : t.muted }}>{time(m.createdAt, business?.timezone)}</P>
            </Card>
          </View>
        );
      })}
      <Row>
        <View style={{ flex: 1 }}>
          <Field label="Message" value={body} onChangeText={setBody} />
        </View>
        <Button
          variant="primary"
          title="Send"
          disabled={!body.trim()}
          onPress={async () => {
            if (await attempt(() => api.post(`/chat/${encodeURIComponent(channel)}`, { body: body.trim() }))) {
              setBody('');
              void msgs.reload();
            }
          }}
        />
      </Row>
    </Screen>
  );
}
