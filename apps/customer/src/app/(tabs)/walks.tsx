import { useState } from 'react';
import { router } from 'expo-router';
import { dateKeyLabel, duration, miles, money, time, todayKey, type Walk, type WalkType } from '@dawgs/client';
import { Button, Card, Chip, Empty, Field, H2, P, Pick, Row, Screen, useLoad } from '@dawgs/ui';
import { api, useSession } from '../../lib/session';
import { attempt, say } from '../../lib/alert';
import { useMe } from '../../lib/me';

function zonedToEpoch(dayKey: string, hhmm: string, tz: string) {
  const guess = Date.parse(`${dayKey}T${hhmm.padStart(5, '0')}:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return guess - (Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute')) - guess);
}

export default function Walks() {
  const { business } = useSession();
  const tz = business?.timezone ?? 'America/New_York';
  const me = useMe();
  const walks = useLoad(() => api.get<Walk[]>('/me/walks'), [], 15_000);
  const types = useLoad(() => api.get<WalkType[]>('/me/walk-types'), []);
  const [dogId, setDogId] = useState<string | null>(null);
  const [typeId, setTypeId] = useState<string | null>(null);
  const [day, setDay] = useState(todayKey(tz, 1));
  const [at, setAt] = useState<string | null>('12:00');
  const dogs = me.data?.dogs ?? [];
  const dog = dogs.find((d) => d.id === (dogId ?? dogs[0]?.id));
  const name = (id: string) => dogs.find((d) => d.id === id)?.name ?? '';
  const list = walks.data ?? [];

  return (
    <Screen refreshing={walks.loading && !!walks.data}>
      <H2>Request a walk</H2>
      <Card>
        {dogs.length > 1 ? <Pick label="Who" value={dog?.id ?? null} onChange={setDogId} options={dogs.map((d) => ({ value: d.id, label: d.name }))} /> : <P bold>{dog?.name}</P>}
        <Pick label="Walk" value={typeId} onChange={setTypeId} options={(types.data ?? []).map((t) => ({ value: t.id, label: `${t.name} · ${t.minutes} min · ${money(t.priceCents)}` }))} />
        <Field label="Day (YYYY-MM-DD)" value={day} onChangeText={setDay} />
        <Pick label="Around" value={at} onChange={setAt} options={['08:00', '10:00', '12:00', '14:00', '16:00', '18:00'].map((h) => ({ value: h, label: h }))} />
        {dog?.wallet.walk ? <P small muted>Uses 1 of {dog.wallet.walk} walk credits.</P> : null}
        <Button
          variant="primary"
          title="Request walk"
          disabled={!dog || !typeId || !at}
          onPress={async () => {
            if (await attempt(() => api.post('/me/walks', { dogId: dog!.id, walkTypeId: typeId, scheduledAt: zonedToEpoch(day, at!, tz) }))) {
              say('Walk requested', "We'll confirm who's walking.");
              void walks.reload();
            }
          }}
        />
      </Card>
      <H2>Walks</H2>
      {list.length === 0 ? <Empty text="No walks yet." /> : null}
      {list.map((w) => (
        <Card key={w.id} onPress={() => router.push(`/walk/${w.id}`)}>
          <Row between>
            <P bold>
              {name(w.dogId)} · {dateKeyLabel(new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(w.scheduledAt)))} {time(w.scheduledAt, tz)}
            </P>
            <Chip text={w.status === 'in_progress' ? 'Live now' : w.status === 'done' ? `${miles(w.meters)} · ${duration(w.durationMs ?? 0)}` : w.status} tone={w.status === 'in_progress' ? 'ok' : w.status === 'requested' ? 'warn' : ''} />
          </Row>
          {w.report ? <P small muted numberOfLines={2}>{w.report}</P> : null}
        </Card>
      ))}
    </Screen>
  );
}
