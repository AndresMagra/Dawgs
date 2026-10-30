import { useState } from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { day, money, time, todayKey, type Dog, type PayOutcome, type StaffMember, type TrainingProgram, type TrainingSession } from '@dawgs/client';
import { Button, Card, Chip, Empty, Field, H1, H2, P, Pick, Row, Screen, Sheet, Toggle, useLoad } from '@dawgs/ui';
import { api, useSession } from '../../lib/session';
import { attempt, confirm, say } from '../../lib/alert';
import { DogPicker } from '../../lib/DogPicker';
import { zonedToEpoch } from '../(tabs)/walks';

interface Enrollment {
  id: string;
  dogId: string;
  status: 'pending_payment' | 'enrolled' | 'completed' | 'dropped';
  dogName: string;
  ownerName: string;
}

export default function ProgramScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { business, isManager } = useSession();
  const tz = business?.timezone ?? 'America/New_York';
  const d = useLoad(() => api.get<{ program: TrainingProgram; enrollments: Enrollment[]; sessions: TrainingSession[] }>(`/training/programs/${id}`), [id]);
  const staff = useLoad(() => api.get<StaffMember[]>('/staff'), []);
  const [sheet, setSheet] = useState<null | 'enroll' | 'sessions' | 'private'>(null);
  const [rosterOf, setRosterOf] = useState<TrainingSession | null>(null);
  const p = d.data?.program;
  if (!p) return <Screen><P muted>Loading…</P></Screen>;
  const reload = () => {
    setSheet(null);
    setRosterOf(null);
    void d.reload();
  };
  const live = d.data!.enrollments.filter((e) => e.status !== 'dropped');
  const trainer = staff.data?.find((s) => s.id === p.trainerId)?.name;

  return (
    <Screen refreshing={d.loading}>
      <Stack.Screen options={{ title: p.name }} />
      <H1>{p.name}</H1>
      <P muted>
        {p.kind === 'class' ? `Group class · ${p.sessionCount} sessions of ${p.sessionMinutes} min · ${live.length}/${p.capacity} dogs` : `Private lesson · ${p.sessionMinutes} min`} · {money(p.priceCents)}
        {trainer ? ` · with ${trainer}` : ''}
      </P>
      {p.description ? <P>{p.description}</P> : null}
      <Row wrap>
        {p.kind === 'class' ? <Button variant="primary" title="Enroll a dog" onPress={() => setSheet('enroll')} /> : <Button variant="primary" title="Book a lesson" onPress={() => setSheet('private')} />}
        {isManager && p.kind === 'class' ? <Button title="Add sessions" onPress={() => setSheet('sessions')} /> : null}
      </Row>

      {p.kind === 'class' ? (
        <>
          <H2>Dogs</H2>
          {live.length === 0 ? <Empty text="Nobody enrolled yet." /> : null}
          {live.map((e) => (
            <Card key={e.id}>
              <Row between>
                <View>
                  <P bold>{e.dogName}</P>
                  <P small muted>{e.ownerName}</P>
                </View>
                <Row>
                  <Chip text={e.status === 'pending_payment' ? 'Awaiting payment' : e.status} tone={e.status === 'enrolled' ? 'ok' : 'warn'} />
                  <Button small variant="ghost" title="Drop" onPress={async () => (await confirm('Drop from class?', e.dogName)) && (await attempt(() => api.post(`/training/enrollments/${e.id}/drop`, {}))) && reload()} />
                </Row>
              </Row>
            </Card>
          ))}
        </>
      ) : null}

      <H2>Sessions</H2>
      {d.data!.sessions.length === 0 ? <Empty text={p.kind === 'class' ? 'No sessions scheduled. Add them to start the class.' : 'No lessons booked.'} /> : null}
      {d.data!.sessions.map((s) => (
        <Card key={s.id} onPress={() => setRosterOf(s)}>
          <Row between>
            <P>
              {day(s.startsAt, tz)} · {time(s.startsAt, tz)}–{time(s.endsAt, tz)}
              {s.location ? ` · ${s.location}` : ''}
            </P>
            <Chip text={s.status} tone={s.status === 'done' ? 'ok' : s.status === 'cancelled' ? '' : 'info'} />
          </Row>
        </Card>
      ))}

      <EnrollSheet open={sheet === 'enroll'} programId={p.id} price={p.priceCents} onClose={() => setSheet(null)} onDone={reload} />
      <PrivateSheet open={sheet === 'private'} program={p} tz={tz} staff={staff.data ?? []} onClose={() => setSheet(null)} onDone={reload} />
      <SessionsSheet open={sheet === 'sessions'} program={p} tz={tz} onClose={() => setSheet(null)} onDone={reload} />
      <RosterSheet session={rosterOf} onClose={() => setRosterOf(null)} onDone={reload} />
    </Screen>
  );
}

function PayButtons({ dog, onPay }: { dog: Dog; onPay: (m: 'card' | 'cash' | 'later') => void }) {
  return (
    <Row wrap>
      <Button variant="primary" title={dog.card ? `Charge ${dog.card.brand} ${dog.card.last4}` : 'No card on file'} disabled={!dog.card} onPress={() => onPay('card')} />
      <Button title="Cash" onPress={() => onPay('cash')} />
      <Button title="Text a pay link" onPress={() => onPay('later')} />
    </Row>
  );
}

async function afterPay(r: PayOutcome | undefined, method: string, ok: string) {
  if (!r) return false;
  if (r.declined) {
    say('Card declined', `${r.declined.message}. The invoice is open on the owner's account.`);
    return true;
  }
  if (method === 'later') await attempt(() => api.post(`/invoices/${r.invoice.id}/link`, { text: true }));
  say(ok, r.paid ? '' : 'It is confirmed once the owner pays.');
  return true;
}

function EnrollSheet({ open, programId, price, onClose, onDone }: { open: boolean; programId: string; price: number; onClose: () => void; onDone: () => void }) {
  const [dog, setDog] = useState<Dog | null>(null);
  return (
    <Sheet visible={open} onClose={onClose} title="Enroll a dog">
      {!dog ? (
        <DogPicker onPick={setDog} />
      ) : (
        <>
          <P bold>
            {dog.name} · {money(price)}
          </P>
          <PayButtons
            dog={dog}
            onPay={async (method) => {
              const r = await attempt(() => api.post<PayOutcome>(`/training/programs/${programId}/enroll`, { dogId: dog.id, pay: { method } }));
              if (await afterPay(r, method, `${dog.name} is enrolled`)) {
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

function PrivateSheet({ open, program, tz, staff, onClose, onDone }: { open: boolean; program: TrainingProgram; tz: string; staff: StaffMember[]; onClose: () => void; onDone: () => void }) {
  const [dog, setDog] = useState<Dog | null>(null);
  const [date, setDate] = useState(todayKey(tz, 1));
  const [at, setAt] = useState('10:00');
  const [trainerId, setTrainerId] = useState<string | null>(program.trainerId);
  return (
    <Sheet visible={open} onClose={onClose} title="Book a private lesson">
      {!dog ? (
        <DogPicker onPick={setDog} />
      ) : (
        <>
          <P bold>{dog.name}</P>
          <P small muted>{dog.wallet.training ? `Uses 1 of ${dog.wallet.training} lesson credits` : `${money(program.priceCents)}, no lesson credits`}</P>
          <Row>
            <Field label="Date" value={date} onChangeText={setDate} />
            <Field label="Time" value={at} onChangeText={setAt} />
          </Row>
          <Pick label="Trainer" value={trainerId} onChange={setTrainerId} options={staff.filter((s) => s.active).map((s) => ({ value: s.id, label: s.name }))} />
          <PayButtons
            dog={dog}
            onPay={async (method) => {
              const r = await attempt(() =>
                api.post<PayOutcome>(`/training/programs/${program.id}/private`, { dogId: dog.id, startsAt: zonedToEpoch(date, at, tz), trainerId, pay: { method } }),
              );
              if (await afterPay(r, method, 'Lesson booked')) {
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

function SessionsSheet({ open, program, tz, onClose, onDone }: { open: boolean; program: TrainingProgram; tz: string; onClose: () => void; onDone: () => void }) {
  const [date, setDate] = useState(todayKey(tz, 7));
  const [at, setAt] = useState('18:00');
  const [count, setCount] = useState(String(program.sessionCount));
  const [every, setEvery] = useState('7');
  const [location, setLocation] = useState('');
  return (
    <Sheet visible={open} onClose={onClose} title="Schedule sessions">
      <Row>
        <Field label="First date" value={date} onChangeText={setDate} />
        <Field label="Time" value={at} onChangeText={setAt} />
      </Row>
      <Row>
        <Field label="How many" value={count} onChangeText={setCount} keyboardType="numeric" />
        <Field label="Every N days" value={every} onChangeText={setEvery} keyboardType="numeric" />
      </Row>
      <Field label="Where" value={location} onChangeText={setLocation} />
      <Button
        variant="primary"
        title="Add to calendar"
        onPress={async () => {
          if (await attempt(() => api.post(`/training/programs/${program.id}/sessions`, { firstStartsAt: zonedToEpoch(date, at, tz), count: Number(count), everyDays: Number(every), location: location.trim() || null }))) onDone();
        }}
      />
    </Sheet>
  );
}

function RosterSheet({ session, onClose, onDone }: { session: TrainingSession | null; onClose: () => void; onDone: () => void }) {
  const r = useLoad(() => (session ? api.get<{ dogs: { id: string; name: string; attendance: { attended: boolean } | null }[] }>(`/training/sessions/${session.id}`) : Promise.resolve(null)), [session?.id]);
  const [marks, setMarks] = useState<Record<string, boolean>>({});
  if (!session) return null;
  const dogs = r.data?.dogs ?? [];
  const here = (id: string) => marks[id] ?? dogs.find((x) => x.id === id)?.attendance?.attended ?? true;
  return (
    <Sheet visible onClose={onClose} title="Attendance">
      {dogs.length === 0 ? <Empty text="No dogs on this session." /> : null}
      {dogs.map((x) => (
        <Toggle key={x.id} label={x.name} value={here(x.id)} onChange={(v) => setMarks((m) => ({ ...m, [x.id]: v }))} />
      ))}
      <Row>
        <Button
          variant="primary"
          title="Save attendance"
          disabled={!dogs.length}
          onPress={async () => {
            if (await attempt(() => api.post(`/training/sessions/${session.id}/attendance`, { marks: dogs.map((x) => ({ dogId: x.id, attended: here(x.id) })) }))) {
              setMarks({});
              onDone();
            }
          }}
        />
        {session.status === 'scheduled' ? (
          <Button variant="ghost" title="Cancel session" onPress={async () => (await confirm('Cancel this session?', 'It comes off the calendar.')) && (await attempt(() => api.post(`/training/sessions/${session.id}/cancel`, {}))) && onDone()} />
        ) : null}
      </Row>
    </Sheet>
  );
}
