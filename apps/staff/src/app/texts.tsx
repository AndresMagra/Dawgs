import { useState } from 'react';
import { View } from 'react-native';
import { Stack, router } from 'expo-router';
import { day, time, type SmsMessage } from '@dawgs/client';
import { Button, Card, Chip, Empty, Field, P, Row, Screen, Segmented, Sheet, useLoad, useTheme } from '@dawgs/ui';
import { api, useSession } from '../lib/session';
import { attempt } from '../lib/alert';

type Thread = { key: string; ownerId: string | null; phone: string | null; leadId: string | null; name: string; last: SmsMessage; unread: number };

/** Conversations with clients and anyone who texted in, plus the full log of every text. */
export default function TextsScreen() {
  const { business } = useSession();
  const tz = business?.timezone;
  const [view, setView] = useState<'inbox' | 'log'>('inbox');
  const box = useLoad(() => api.get<Thread[]>('/texts/inbox'), [], 20_000);
  const log = useLoad(() => (view === 'log' ? api.get<(SmsMessage & { ownerId: string | null })[]>('/texts') : Promise.resolve([])), [view], 30_000);
  const [open, setOpen] = useState<Thread | null>(null);

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Texts' }} />
      <Segmented value={view} onChange={setView} options={[{ value: 'inbox', label: 'Conversations' }, { value: 'log', label: 'Every text' }]} />
      {view === 'inbox' ? (
        <>
          {box.data?.length === 0 ? <Empty text="No texts yet. Replies from clients show up here." /> : null}
          {box.data?.map((t) => (
            <Card key={t.key} onPress={() => setOpen(t)}>
              <Row between>
                <P bold>{t.name}</P>
                <Row>
                  {t.leadId ? <Chip text="Lead" tone="info" /> : null}
                  {t.unread ? <Chip text={`${t.unread} new`} tone="bad" /> : null}
                  <P small muted>{`${day(t.last.createdAt, tz)} ${time(t.last.createdAt, tz)}`}</P>
                </Row>
              </Row>
              <P small muted numberOfLines={1}>{`${t.last.direction === 'in' ? '' : 'You: '}${t.last.body}`}</P>
            </Card>
          ))}
        </>
      ) : (
        <>
          {log.data?.length === 0 ? <Empty text="No texts yet." /> : null}
          {log.data?.map((m) => (
            <Card key={m.id} onPress={m.ownerId ? () => router.push(`/owner/${m.ownerId}`) : undefined}>
              <Row between>
                <P bold>{`${m.direction === 'in' ? '← ' : '→ '}${m.ownerName ?? m.to}`}</P>
                <Row>
                  {m.status === 'failed' ? <Chip text="Failed" tone="bad" /> : null}
                  {m.status === 'skipped' ? <Chip text="Not sent" tone="warn" /> : null}
                  <P small muted>{`${day(m.createdAt, tz)} ${time(m.createdAt, tz)}`}</P>
                </Row>
              </Row>
              <P>{m.body}</P>
              <P small muted>{`${m.kind.replace('_', ' ')}${m.sentBy ? ` · ${m.sentBy}` : ''}${m.error ? ` · ${m.error}` : ''}`}</P>
            </Card>
          ))}
        </>
      )}
      {open ? (
        <ThreadSheet
          thread={open}
          tz={tz}
          onClose={() => {
            setOpen(null);
            void box.reload();
          }}
        />
      ) : null}
    </Screen>
  );
}

function ThreadSheet({ thread, tz, onClose }: { thread: Thread; tz: string | undefined; onClose: () => void }) {
  const t = useTheme();
  const q = thread.ownerId ? `ownerId=${thread.ownerId}` : `phone=${encodeURIComponent(thread.phone ?? '')}`;
  const msgs = useLoad(() => api.get<SmsMessage[]>(`/texts/thread?${q}`), [q], 15_000);
  const [body, setBody] = useState('');
  return (
    <Sheet visible onClose={onClose} title={thread.name}>
      <Row wrap>
        {thread.ownerId ? <Button small title="Open client" onPress={() => { onClose(); router.push(`/owner/${thread.ownerId}`); }} /> : null}
        {thread.leadId ? <Button small title="Open lead" onPress={() => { onClose(); router.push('/leads'); }} /> : null}
      </Row>
      {msgs.data?.map((m) => (
        <View
          key={m.id}
          style={{
            alignSelf: m.direction === 'in' ? 'flex-start' : 'flex-end',
            maxWidth: '85%',
            backgroundColor: m.direction === 'in' ? t.surface : t.brand,
            borderColor: t.border,
            borderWidth: m.direction === 'in' ? 1 : 0,
            borderRadius: 14,
            paddingHorizontal: 12,
            paddingVertical: 8,
          }}
        >
          <P style={{ color: m.direction === 'in' ? t.text : t.brandText }}>{m.body}</P>
          <P small style={{ color: m.direction === 'in' ? t.muted : t.brandText, opacity: 0.8 }}>
            {`${time(m.createdAt, tz)}${m.status === 'failed' ? ' · failed' : m.status === 'skipped' ? ' · not sent' : ''}${m.sentBy && m.direction === 'out' ? ` · ${m.sentBy}` : ''}`}
          </P>
        </View>
      ))}
      <Field label="Reply" value={body} onChangeText={setBody} multiline />
      <Button
        variant="primary"
        title="Send"
        disabled={!body.trim()}
        onPress={async () => {
          const ok = await attempt(() => api.post('/texts/reply', { ...(thread.ownerId ? { ownerId: thread.ownerId } : { phone: thread.phone }), body: body.trim() }));
          if (!ok) return;
          setBody('');
          void msgs.reload();
        }}
      />
    </Sheet>
  );
}
