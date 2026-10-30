import { useState } from 'react';
import { View } from 'react-native';
import { Stack, router } from 'expo-router';
import { money, type StaffMember, type TrainingProgram } from '@dawgs/client';
import { Button, Card, Chip, Empty, Field, P, Pick, Row, Screen, Sheet, Toggle, useLoad } from '@dawgs/ui';
import { api, useSession } from '../lib/session';
import { attempt } from '../lib/alert';

export default function TrainingScreen() {
  const { isManager } = useSession();
  const list = useLoad(() => api.get<TrainingProgram[]>('/training/programs'), []);
  const [editing, setEditing] = useState<TrainingProgram | 'new' | null>(null);
  return (
    <Screen refreshing={list.loading && !!list.data}>
      <Stack.Screen options={{ title: 'Training' }} />
      <Row between>
        <P muted>Group classes and private lessons. Progress you record is shared with owners.</P>
        {isManager ? <Button variant="primary" title="New program" onPress={() => setEditing('new')} /> : null}
      </Row>
      {list.data?.length === 0 ? <Empty text="No training programs yet." /> : null}
      {list.data?.map((p) => (
        <Card key={p.id} onPress={() => router.push(`/program/${p.id}`)}>
          <Row between>
            <View style={{ flex: 1 }}>
              <P bold>{p.name}</P>
              <P small muted>
                {p.kind === 'class' ? `${p.sessionCount} × ${p.sessionMinutes} min · ${p.enrolled ?? 0}/${p.capacity} enrolled` : `${p.sessionMinutes} min private lesson`} · {money(p.priceCents)}
              </P>
            </View>
            <Row>
              {!p.active ? <Chip text="Off" /> : null}
              {p.sellOnline ? <Chip text="In owner app" tone="info" /> : null}
              {isManager ? <Button small variant="ghost" title="Edit" onPress={() => setEditing(p)} /> : null}
            </Row>
          </Row>
        </Card>
      ))}
      <ProgramSheet program={editing} onClose={() => setEditing(null)} onDone={() => (setEditing(null), void list.reload())} />
    </Screen>
  );
}

function ProgramSheet({ program, onClose, onDone }: { program: TrainingProgram | 'new' | null; onClose: () => void; onDone: () => void }) {
  const p = program && program !== 'new' ? program : null;
  const staff = useLoad(() => api.get<StaffMember[]>('/staff'), []);
  const [f, setF] = useState<Record<string, string>>({});
  const [kind, setKind] = useState<'class' | 'private' | null>(null);
  const [trainerId, setTrainerId] = useState<string | null | undefined>(undefined);
  const [online, setOnline] = useState<boolean | null>(null);
  const [active, setActive] = useState<boolean | null>(null);
  const v = (k: string, d: string) => f[k] ?? d;
  const set = (k: string) => (x: string) => setF((s) => ({ ...s, [k]: x }));
  const k = kind ?? p?.kind ?? 'class';
  const close = () => {
    setF({});
    setKind(null);
    setTrainerId(undefined);
    setOnline(null);
    setActive(null);
    onClose();
  };
  return (
    <Sheet visible={!!program} onClose={close} title={p ? `Edit ${p.name}` : 'New training program'}>
      <Field label="Name" value={v('name', p?.name ?? '')} onChangeText={set('name')} />
      <Field label="Description" value={v('description', p?.description ?? '')} onChangeText={set('description')} multiline />
      {!p ? <Pick label="Kind" value={k} onChange={setKind} options={[{ value: 'class', label: 'Group class' }, { value: 'private', label: 'Private lesson' }]} /> : null}
      <Row>
        <Field label="Price ($)" value={v('price', p ? String(p.priceCents / 100) : '')} onChangeText={set('price')} keyboardType="numeric" />
        <Field label="Minutes" value={v('minutes', String(p?.sessionMinutes ?? 60))} onChangeText={set('minutes')} keyboardType="numeric" />
      </Row>
      {k === 'class' ? (
        <Row>
          <Field label="Sessions" value={v('sessions', String(p?.sessionCount ?? 6))} onChangeText={set('sessions')} keyboardType="numeric" />
          <Field label="Max dogs" value={v('capacity', String(p?.capacity ?? 8))} onChangeText={set('capacity')} keyboardType="numeric" />
        </Row>
      ) : null}
      <Field label="Skills taught (comma separated)" value={v('skills', p?.skills.join(', ') ?? 'Sit, Down, Stay, Come')} onChangeText={set('skills')} />
      <Pick label="Trainer" value={trainerId === undefined ? (p?.trainerId ?? null) : trainerId} onChange={setTrainerId} options={(staff.data ?? []).filter((s) => s.active).map((s) => ({ value: s.id, label: s.name }))} />
      <Toggle label="Owners can sign up in the app" value={online ?? p?.sellOnline ?? true} onChange={setOnline} />
      {p ? <Toggle label="Active" value={active ?? p.active} onChange={setActive} /> : null}
      <Button
        variant="primary"
        title="Save"
        onPress={async () => {
          const body = {
            name: v('name', p?.name ?? '').trim(),
            description: v('description', p?.description ?? '').trim() || null,
            ...(p ? {} : { kind: k }),
            priceCents: Math.round(Number(v('price', p ? String(p.priceCents / 100) : '0')) * 100),
            sessionMinutes: Number(v('minutes', String(p?.sessionMinutes ?? 60))),
            ...(k === 'class' ? { sessionCount: Number(v('sessions', String(p?.sessionCount ?? 6))), capacity: Number(v('capacity', String(p?.capacity ?? 8))) } : {}),
            skills: v('skills', p?.skills.join(', ') ?? 'Sit, Down, Stay, Come').split(',').map((s) => s.trim()).filter(Boolean),
            trainerId: trainerId === undefined ? (p?.trainerId ?? null) : trainerId,
            sellOnline: online ?? p?.sellOnline ?? true,
            ...(p ? { active: active ?? p.active } : {}),
          };
          const r = await attempt(() => (p ? api.patch(`/training/programs/${p.id}`, body) : api.post('/training/programs', body)));
          if (r) {
            close();
            onDone();
          }
        }}
      />
    </Sheet>
  );
}
