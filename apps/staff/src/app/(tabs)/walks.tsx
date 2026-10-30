import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { dateKeyLabel, miles, time, todayKey, type Dog, type StaffMember, type Walk, type WalkType } from '@dawgs/client';
import { Avatar, Button, Card, Chip, Empty, Field, P, Pick, Row, Screen, Segmented, Sheet, useLoad } from '@dawgs/ui';
import { api, useSession } from '../../lib/session';
import { attempt } from '../../lib/alert';
import { DogPicker } from '../../lib/DogPicker';

const STATUS_TONE = { requested: 'warn', scheduled: 'info', in_progress: 'ok', done: '', cancelled: '' } as const;

export default function WalksScreen() {
  const { business, isManager } = useSession();
  const tz = business?.timezone ?? 'America/New_York';
  const [day, setDay] = useState(todayKey(tz));
  const [mine, setMine] = useState<'all' | 'mine'>(isManager ? 'all' : 'mine');
  const [adding, setAdding] = useState(false);
  const [assigning, setAssigning] = useState<Walk | null>(null);
  const walks = useLoad(() => api.get<Walk[]>(`/walks?from=${day}&to=${day}${mine === 'mine' ? '&mine=1' : ''}`), [day, mine], 30_000);
  const staff = useLoad(() => (isManager ? api.get<StaffMember[]>('/staff') : Promise.resolve([] as StaffMember[])), [isManager]);
  const shift = (n: number) => {
    const [y, m, d] = day.split('-').map(Number);
    setDay(new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10));
  };
  return (
    <Screen refreshing={walks.loading && !!walks.data}>
      <Row between wrap>
        <Row>
          <Button small title="‹" onPress={() => shift(-1)} />
          <P bold>{dateKeyLabel(day)}</P>
          <Button small title="›" onPress={() => shift(1)} />
        </Row>
        <Row>
          <Segmented value={mine} onChange={setMine} options={[{ value: 'mine', label: 'My walks' }, { value: 'all', label: 'Everyone' }]} />
          <Button variant="primary" title="Schedule walk" onPress={() => setAdding(true)} />
        </Row>
      </Row>
      {walks.data?.length === 0 ? <Empty text="No walks this day." /> : null}
      {walks.data?.map((w) => (
        <Card key={w.id} onPress={() => router.push(`/walk/${w.id}`)}>
          <Row>
            <Avatar name={w.dog?.name ?? '?'} color={w.dog?.color} size={36} />
            <View style={{ flex: 1 }}>
              <P bold>
                {time(w.scheduledAt, tz)} · {w.dog?.name}
              </P>
              <P small muted>
                {w.walkerName ? `Walker: ${w.walkerName}` : 'No walker yet'}
                {w.status === 'done' ? ` · ${miles(w.meters)}` : ''}
              </P>
            </View>
            <Chip text={w.status.replace('_', ' ')} tone={STATUS_TONE[w.status]} />
          </Row>
          {isManager && (w.status === 'requested' || w.status === 'scheduled') ? (
            <Row>
              <Button small title={w.walkerId ? 'Reassign' : 'Assign walker'} onPress={() => setAssigning(w)} />
            </Row>
          ) : null}
        </Card>
      ))}
      <ScheduleWalkSheet open={adding} tz={tz} day={day} staff={staff.data ?? []} onClose={() => setAdding(false)} onDone={() => (setAdding(false), void walks.reload())} />
      <Sheet visible={!!assigning} onClose={() => setAssigning(null)} title="Assign a walker">
        <Pick
          value={assigning?.walkerId ?? null}
          options={(staff.data ?? []).filter((s) => s.active).map((s) => ({ value: s.id, label: s.name }))}
          onChange={async (walkerId) => {
            if (assigning && (await attempt(() => api.post(`/walks/${assigning.id}/assign`, { walkerId })))) {
              setAssigning(null);
              void walks.reload();
            }
          }}
        />
      </Sheet>
    </Screen>
  );
}

function ScheduleWalkSheet({ open, tz, day, staff, onClose, onDone }: { open: boolean; tz: string; day: string; staff: StaffMember[]; onClose: () => void; onDone: () => void }) {
  const settings = useLoad(() => api.get<{ walkTypes: WalkType[] }>('/settings'), []);
  const [dog, setDog] = useState<Dog | null>(null);
  const [typeId, setTypeId] = useState<string | null>(null);
  const [at, setAt] = useState('12:00');
  const [walkerId, setWalkerId] = useState<string | null>(null);
  return (
    <Sheet visible={open} onClose={onClose} title="Schedule a walk">
      {!dog ? (
        <DogPicker onPick={setDog} />
      ) : (
        <>
          <Row between>
            <P bold>{dog.name}</P>
            <Button small variant="ghost" title="Change" onPress={() => setDog(null)} />
          </Row>
          <P small muted>{dog.wallet.walk ? `${dog.wallet.walk} walk credits left` : 'No walk credits: it will be billed.'}</P>
          <Pick label="Walk" value={typeId} onChange={setTypeId} options={(settings.data?.walkTypes ?? []).filter((t) => t.active).map((t) => ({ value: t.id, label: `${t.name} (${t.minutes} min)` }))} />
          <Field label={`Time on ${dateKeyLabel(day)} (HH:MM)`} value={at} onChangeText={setAt} />
          {staff.length ? <Pick label="Walker" value={walkerId} onChange={setWalkerId} options={staff.filter((s) => s.active).map((s) => ({ value: s.id, label: s.name }))} /> : null}
          <Button
            variant="primary"
            title="Schedule"
            disabled={!typeId || !/^\d{1,2}:\d{2}$/.test(at)}
            onPress={async () => {
              const scheduledAt = zonedToEpoch(day, at, tz);
              if (await attempt(() => api.post('/walks', { dogId: dog.id, walkTypeId: typeId, scheduledAt, walkerId }))) {
                setDog(null);
                onDone();
              }
            }}
          />
        </>
      )}
    </Sheet>
  );
}

/** Wall-clock time in the daycare's zone → epoch ms, without a date library. */
export function zonedToEpoch(dayKey: string, hhmm: string, tz: string) {
  const [h, m] = hhmm.split(':').map(Number);
  const guess = Date.parse(`${dayKey}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return guess - (asIfUtc - guess);
}
