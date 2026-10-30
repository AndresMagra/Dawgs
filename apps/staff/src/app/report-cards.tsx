import { useState } from 'react';
import { View } from 'react-native';
import { Stack } from 'expo-router';
import { Button, Card, Chip, Empty, Field, H2, Notice, P, Pick, Row, Screen, Sheet, useLoad } from '@dawgs/ui';
import { api } from '../lib/session';
import { attempt, say } from '../lib/alert';

type Details = { mood?: string; ate?: string; potty?: string; energy?: string; playmates?: string[] };
type CardRow = { id: string; dogId: string; dog: string; owner: string; body: string; details: Details | null; sentAt: string | null; author: string };
type Day = { date: string; cards: CardRow[]; missing: { dogId: string; dog: string; visitId: string }[] };

const MOOD = [
  { value: 'great', label: 'Great day' },
  { value: 'good', label: 'Good day' },
  { value: 'shy', label: 'A bit shy' },
  { value: 'tired', label: 'Tired out' },
];
const ATE = [
  { value: 'all', label: 'Ate it all' },
  { value: 'some', label: 'Ate some' },
  { value: 'none', label: "Didn't eat" },
];
const POTTY = [
  { value: 'normal', label: 'Normal' },
  { value: 'soft', label: 'Soft' },
  { value: 'none', label: 'None' },
];
const ENERGY = [
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

/** Write report cards through the day, then send them all when the dogs go home. */
export default function ReportCards() {
  const day = useLoad(() => api.get<Day>('/report-cards'), [], 30_000);
  const [writing, setWriting] = useState<{ dogId: string; dog: string; visitId: string } | null>(null);
  const unsent = day.data?.cards.filter((c) => !c.sentAt) ?? [];
  const playmates = [...new Set([...(day.data?.cards.map((c) => c.dog) ?? []), ...(day.data?.missing.map((m) => m.dog) ?? [])])];

  return (
    <Screen refreshing={day.loading}>
      <Stack.Screen options={{ title: 'Report cards' }} />
      {unsent.length ? (
        <Button
          variant="primary"
          title={`Send ${unsent.length} report card${unsent.length === 1 ? '' : 's'}`}
          onPress={async () => {
            const r = await attempt(() => api.post<{ sent: number }>('/report-cards/send', { ids: unsent.map((c) => c.id) }));
            if (!r) return;
            say('Sent', `${r.sent} owner${r.sent === 1 ? '' : 's'} can see today's report card in the app.`);
            void day.reload();
          }}
        />
      ) : null}
      <H2>Still to write</H2>
      {day.data?.missing.length === 0 ? <Empty text="Every dog that came in today has a report card." /> : null}
      {day.data?.missing.map((m) => (
        <Card key={m.dogId} onPress={() => setWriting(m)}>
          <Row between>
            <P bold>{m.dog}</P>
            <P small muted>Write ›</P>
          </Row>
        </Card>
      ))}
      <H2>Written today</H2>
      {day.data?.cards.length === 0 ? <Empty text="None yet." /> : null}
      {day.data?.cards.map((c) => (
        <Card key={c.id}>
          <Row between>
            <P bold>{`${c.dog} · ${c.owner}`}</P>
            <Chip text={c.sentAt ? 'Sent' : 'Draft'} tone={c.sentAt ? 'ok' : 'warn'} />
          </Row>
          {c.details ? (
            <P small muted>
              {[MOOD.find((x) => x.value === c.details!.mood)?.label, ATE.find((x) => x.value === c.details!.ate)?.label, c.details.energy ? `${c.details.energy} energy` : null, c.details.playmates?.length ? `with ${c.details.playmates.join(', ')}` : null]
                .filter(Boolean)
                .join(' · ')}
            </P>
          ) : null}
          <P>{c.body}</P>
          <P small muted>{`By ${c.author}`}</P>
        </Card>
      ))}
      {writing ? (
        <WriteSheet
          target={writing}
          playmates={playmates.filter((p) => p !== writing.dog)}
          onClose={() => setWriting(null)}
          onDone={() => {
            setWriting(null);
            void day.reload();
          }}
        />
      ) : null}
    </Screen>
  );
}

function WriteSheet({ target, playmates, onClose, onDone }: { target: { dogId: string; dog: string; visitId: string }; playmates: string[]; onClose: () => void; onDone: () => void }) {
  const [d, setD] = useState<Details>({ mood: 'good' });
  const [friends, setFriends] = useState<string[]>([]);
  const [body, setBody] = useState('');
  const save = async (draft: boolean) => {
    const ok = await attempt(() =>
      api.post(`/dogs/${target.dogId}/notes`, { kind: 'report', body: body.trim() || `${target.dog} had a ${d.mood === 'great' ? 'great' : 'good'} day!`, visitId: target.visitId, details: { ...d, playmates: friends }, draft }),
    );
    if (ok) onDone();
  };
  return (
    <Sheet visible onClose={onClose} title={`${target.dog}'s report card`}>
      <Pick label="Mood" value={d.mood ?? null} onChange={(v) => setD({ ...d, mood: v })} options={MOOD} />
      <Pick label="Lunch" value={d.ate ?? null} onChange={(v) => setD({ ...d, ate: v })} options={ATE} />
      <Pick label="Potty" value={d.potty ?? null} onChange={(v) => setD({ ...d, potty: v })} options={POTTY} />
      <Pick label="Energy" value={d.energy ?? null} onChange={(v) => setD({ ...d, energy: v })} options={ENERGY} />
      {playmates.length ? (
        <View style={{ gap: 4 }}>
          <P small muted>Played with</P>
          <Row wrap>
            {playmates.map((p) => (
              <Button key={p} small title={p} variant={friends.includes(p) ? 'primary' : 'secondary'} onPress={() => setFriends((f) => (f.includes(p) ? f.filter((x) => x !== p) : [...f, p]))} />
            ))}
          </Row>
        </View>
      ) : null}
      <Field label="Note for the owner" value={body} onChangeText={setBody} multiline placeholder="Highlights of the day, anything they should know" />
      <Notice tone="info" text="Drafts wait for the Send button on the report cards screen; Send now tells the owner right away." />
      <Row>
        <Button title="Save draft" onPress={() => save(true)} />
        <Button variant="primary" title="Send now" onPress={() => save(false)} />
      </Row>
    </Sheet>
  );
}
