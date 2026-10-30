import { useState } from 'react';
import { View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { creditsText, day, money, todayKey, type Dog, type ReportCard } from '@dawgs/client';
import { Avatar, Button, Card, Chip, Chips, Empty, Field, H1, H2, Line, Notice, P, Pick, Row, Screen, Segmented, Sheet, Toggle, useLoad } from '@dawgs/ui';
import { api, useSession } from '../../lib/session';
import { attempt, confirm } from '../../lib/alert';
import { FormSheet, SellPackageSheet, orNull } from '../../lib/sheets';
import { NewBookingSheet } from '../(tabs)/bookings';

interface VaccineRecord {
  id: string;
  name: string;
  expiresAt: string;
  documentUrl: string | null;
  verifiedBy: string | null;
}
interface Grant {
  id: string;
  kind: string;
  amount: number;
  remaining: number;
  expiresAt: string | null;
  note: string | null;
  createdAt: string;
}
interface DogDetail {
  dog: Dog;
  vaccineRecords: VaccineRecord[];
  notes: (ReportCard & { sharedWithOwner: boolean })[];
  visits: { id: string; service: string; plan: string | null; checkedInAt: string; checkedOutAt: string | null }[];
  walks: { id: string; scheduledAt: string; status: string; meters: number | null }[];
  credits: Grant[];
}
interface Progress {
  skills: { skill: string; level: number; label: string; at: string }[];
  history: { id: string; skill: string; level: number; note: string | null; homework: string | null; author: string; createdAt: string }[];
}
const LEVELS = ['Introduced', 'Learning', 'With help', 'Reliable', 'Mastered'];

export default function DogScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { business, isManager } = useSession();
  const tz = business?.timezone ?? 'America/New_York';
  const d = useLoad(() => api.get<DogDetail>(`/dogs/${id}`), [id]);
  const prog = useLoad(() => api.get<Progress>(`/dogs/${id}/progress`), [id]);
  const [tab, setTab] = useState<'about' | 'health' | 'reports' | 'training' | 'history'>('about');
  const [sheet, setSheet] = useState<null | 'edit' | 'vaccine' | 'note' | 'sell' | 'book' | 'credits' | 'progress'>(null);
  const dog = d.data?.dog;
  if (!dog) return <Screen>{d.error ? <Empty text={d.error} /> : <P muted>Loading…</P>}</Screen>;
  const reload = () => {
    setSheet(null);
    void d.reload();
    void prog.reload();
  };
  const card = dog.card ? `${dog.card.brand} ${dog.card.last4}` : null;

  return (
    <Screen refreshing={d.loading}>
      <Stack.Screen options={{ title: dog.name }} />
      <Row>
        <Avatar name={dog.name} color={dog.color} size={64} />
        <View style={{ flex: 1, gap: 2 }}>
          <H1>{dog.name}</H1>
          <P muted>
            {[dog.breed, dog.sex, dog.weightLb ? `${dog.weightLb} lb` : null, dog.birthDate ? `born ${dog.birthDate}` : null].filter(Boolean).join(' · ')}
          </P>
          <P onPress={() => router.push(`/owner/${dog.owner.id}`)} style={{ textDecorationLine: 'underline' }}>
            {dog.owner.name} {dog.owner.phone ? `· ${dog.owner.phone}` : ''}
          </P>
        </View>
      </Row>
      {!dog.canEnter ? (
        <Notice tone="bad" text={dog.waiversMissing.length ? `Can't come in until the owner signs: ${dog.waiversMissing.join(', ')}` : "Can't come in: vaccines are not current."} />
      ) : null}
      <Chips items={dog.flags} />
      <Row wrap>
        <Button variant="primary" title="Book" disabled={!dog.canEnter} onPress={() => setSheet('book')} />
        <Button title="Report card" onPress={() => setSheet('note')} />
        <Button title="Sell pack / membership" onPress={() => setSheet('sell')} />
        <Button title="Edit" onPress={() => setSheet('edit')} />
      </Row>
      <Card>
        <Row between>
          <P bold>Credits</P>
          {isManager ? <Button small variant="ghost" title="Adjust" onPress={() => setSheet('credits')} /> : null}
        </Row>
        <P>{creditsText(dog.wallet) || 'None'}</P>
      </Card>
      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: 'about', label: 'Care' },
          { value: 'health', label: `Vaccines${dog.vaccinesAwaitingReview ? ` (${dog.vaccinesAwaitingReview})` : ''}` },
          { value: 'reports', label: 'Reports' },
          { value: 'training', label: 'Training' },
          { value: 'history', label: 'History' },
        ]}
      />

      {tab === 'about' ? (
        <Card>
          <Line left="Feeding" right={dog.feeding ?? '—'} />
          <Line left="Allergies" right={dog.allergies.join(', ') || 'None'} />
          <Line left="Medications" right={dog.medications.map((m) => `${m.name} ${m.dose} (${m.when})`).join('; ') || 'None'} />
          <Line left="Escape risk" right={dog.behaviour.escapeRisk ? 'Yes' : 'No'} />
          <Line left="Leash reactive" right={dog.behaviour.leashReactive ? 'Yes' : 'No'} />
          <Line left="Eats alone" right={dog.behaviour.eatsAlone ? 'Yes' : 'No'} />
          {dog.behaviour.notes ? <P muted>{dog.behaviour.notes}</P> : null}
          {isManager ? (
            <Button
              small
              variant="ghost"
              title={dog.active ? 'Archive dog' : 'Restore dog'}
              onPress={async () => {
                if (dog.active && !(await confirm('Archive?', `${dog.name} will be hidden from lists. Nothing is deleted.`))) return;
                if (await attempt(() => api.patch(`/dogs/${dog.id}`, { active: !dog.active }))) reload();
              }}
            />
          ) : null}
        </Card>
      ) : null}

      {tab === 'health' ? (
        <>
          <Card>
            {dog.vaccines.map((v) => (
              <Line key={v.name} left={v.name} right={<Chip text={v.state === 'ok' ? `OK until ${v.expiresAt ? day(v.expiresAt, tz) : ''}` : v.state.replace('_', ' ')} tone={v.state === 'ok' ? 'ok' : v.state === 'due_soon' ? 'warn' : 'bad'} />} />
            ))}
          </Card>
          <H2 right={<Button small title="Add record" onPress={() => setSheet('vaccine')} />}>Records</H2>
          {d.data!.vaccineRecords.length === 0 ? <Empty text="No vaccine records." /> : null}
          {d.data!.vaccineRecords.map((v) => (
            <Card key={v.id}>
              <Row between>
                <View>
                  <P bold>{v.name}</P>
                  <P small muted>
                    Expires {day(v.expiresAt, tz)} · {v.verifiedBy ? `verified by ${v.verifiedBy}` : 'uploaded by owner, not verified'}
                  </P>
                  {v.documentUrl ? <P small style={{ textDecorationLine: 'underline' }} onPress={() => void import('expo-linking').then((L) => L.openURL(v.documentUrl!))}>View document</P> : null}
                </View>
                <Row>
                  {!v.verifiedBy ? <Button small variant="primary" title="Verify" onPress={async () => (await attempt(() => api.post(`/vaccines/${v.id}/verify`, {}))) && reload()} /> : null}
                  <Button small variant="ghost" title="Remove" onPress={async () => (await confirm('Remove record?', v.name)) && (await attempt(() => api.del(`/vaccines/${v.id}`))) && reload()} />
                </Row>
              </Row>
            </Card>
          ))}
        </>
      ) : null}

      {tab === 'reports' ? (
        <>
          {d.data!.notes.length === 0 ? <Empty text="No report cards or notes yet." /> : null}
          {d.data!.notes.map((n) => (
            <Card key={n.id}>
              <Row between>
                <Chip text={n.kind === 'report' ? 'Report card' : n.kind === 'incident' ? 'Incident' : 'Staff note'} tone={n.kind === 'incident' ? 'bad' : n.kind === 'report' ? 'ok' : ''} />
                <P small muted>
                  {day(n.createdAt, tz)} · {n.author}
                  {n.sharedWithOwner ? ' · owner sees this' : ''}
                </P>
              </Row>
              <P>{n.body}</P>
            </Card>
          ))}
        </>
      ) : null}

      {tab === 'training' ? (
        <>
          <H2 right={<Button small title="Record progress" onPress={() => setSheet('progress')} />}>Skills</H2>
          {(prog.data?.skills ?? []).length === 0 ? <Empty text="No training progress yet." /> : null}
          {prog.data?.skills.map((s) => (
            <Card key={s.skill}>
              <Row between>
                <P bold>{s.skill}</P>
                <Chip text={s.label} tone={s.level >= 3 ? 'ok' : s.level >= 1 ? 'info' : ''} />
              </Row>
              <View style={{ flexDirection: 'row', gap: 4 }}>
                {LEVELS.map((_, i) => (
                  <View key={i} style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: i <= s.level ? '#3b82f6' : '#d4d4d8' }} />
                ))}
              </View>
            </Card>
          ))}
          {prog.data?.history.slice(0, 15).map((h) => (
            <P key={h.id} small muted>
              {day(h.createdAt, tz)} · {h.skill}: {LEVELS[h.level]} · {h.author}
              {h.note ? ` — ${h.note}` : ''}
              {h.homework ? ` · Homework: ${h.homework}` : ''}
            </P>
          ))}
        </>
      ) : null}

      {tab === 'history' ? (
        <>
          <H2>Visits</H2>
          {d.data!.visits.length === 0 ? <Empty text="No visits yet." /> : null}
          {d.data!.visits.map((v) => (
            <Line key={v.id} left={`${day(v.checkedInAt, tz)} · ${v.service}${v.plan ? ` (${v.plan})` : ''}`} right={v.checkedOutAt ? 'done' : 'here now'} />
          ))}
          <H2>Walks</H2>
          {d.data!.walks.map((w) => (
            <Line key={w.id} left={day(w.scheduledAt, tz)} right={w.status} />
          ))}
          <H2>Credit history</H2>
          {d.data!.credits.map((g) => (
            <Line key={g.id} left={`${g.amount} ${g.kind} · ${g.note ?? ''}`} right={`${g.remaining} left${g.expiresAt ? ` · until ${day(g.expiresAt, tz)}` : ''}`} muted={g.remaining === 0} />
          ))}
        </>
      ) : null}

      <EditDog open={sheet === 'edit'} dog={dog} onClose={() => setSheet(null)} onDone={reload} />
      <FormSheet
        open={sheet === 'vaccine'}
        title="Add vaccine record"
        fields={[
          { key: 'name', label: 'Vaccine (e.g. Rabies)' },
          { key: 'expiresOn', label: 'Expires (YYYY-MM-DD)' },
          { key: 'documentUrl', label: 'Document link (optional)' },
        ]}
        initial={{ expiresOn: todayKey(tz, 365) }}
        onClose={() => setSheet(null)}
        onSave={async (v) => {
          const r = await attempt(() => api.post(`/dogs/${dog.id}/vaccines`, { name: v.name, expiresOn: v.expiresOn, documentUrl: orNull(v.documentUrl) }));
          if (r) reload();
          return r;
        }}
      />
      <NoteSheet open={sheet === 'note'} dogId={dog.id} dogName={dog.name} onClose={() => setSheet(null)} onDone={reload} />
      <SellPackageSheet open={sheet === 'sell'} dogId={dog.id} dogName={dog.name} card={card} onClose={() => setSheet(null)} onDone={reload} />
      <NewBookingSheet open={sheet === 'book'} tz={tz} presetDog={dog} onClose={() => setSheet(null)} onDone={reload} />
      <CreditsSheet open={sheet === 'credits'} dogId={dog.id} onClose={() => setSheet(null)} onDone={reload} />
      <ProgressSheet open={sheet === 'progress'} dogId={dog.id} known={(prog.data?.skills ?? []).map((s) => s.skill)} onClose={() => setSheet(null)} onDone={reload} />
    </Screen>
  );
}

function NoteSheet({ open, dogId, dogName, onClose, onDone }: { open: boolean; dogId: string; dogName: string; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<'report' | 'incident' | 'note'>('report');
  const [body, setBody] = useState('');
  const [share, setShare] = useState(true);
  return (
    <Sheet visible={open} onClose={onClose} title={`Write about ${dogName}`}>
      <Segmented
        value={kind}
        onChange={(k) => {
          setKind(k);
          setShare(k === 'report');
        }}
        options={[{ value: 'report', label: 'Report card' }, { value: 'incident', label: 'Incident' }, { value: 'note', label: 'Staff note' }]}
      />
      <Field label={kind === 'report' ? 'How was the day?' : 'What happened?'} value={body} onChangeText={setBody} multiline style={{ minHeight: 110, textAlignVertical: 'top' }} />
      <Toggle label="Owner can see this" value={share} onChange={setShare} />
      <Button
        variant="primary"
        title="Save"
        disabled={!body.trim()}
        onPress={async () => {
          if (await attempt(() => api.post(`/dogs/${dogId}/notes`, { kind, body, sharedWithOwner: share }))) {
            setBody('');
            onDone();
          }
        }}
      />
    </Sheet>
  );
}

function CreditsSheet({ open, dogId, onClose, onDone }: { open: boolean; dogId: string; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<string | null>('daycare');
  const [n, setN] = useState('1');
  const [note, setNote] = useState('');
  async function go(dir: 'add' | 'remove') {
    if (!kind) return;
    const amount = Number(n);
    if (await attempt(() => api.post(`/dogs/${dogId}/credits`, { [dir]: { [kind]: amount }, note }))) onDone();
  }
  return (
    <Sheet visible={open} onClose={onClose} title="Adjust credits">
      <Pick value={kind} onChange={setKind} options={['daycare', 'night', 'walk', 'bath', 'training'].map((k) => ({ value: k, label: k }))} />
      <Field label="How many" value={n} onChangeText={setN} keyboardType="numeric" />
      <Field label="Why (kept in the log)" value={note} onChangeText={setNote} />
      <Row>
        <Button variant="primary" title="Add" disabled={!note.trim()} onPress={() => go('add')} />
        <Button title="Remove" disabled={!note.trim()} onPress={() => go('remove')} />
      </Row>
    </Sheet>
  );
}

function ProgressSheet({ open, dogId, known, onClose, onDone }: { open: boolean; dogId: string; known: string[]; onClose: () => void; onDone: () => void }) {
  const [skill, setSkill] = useState('');
  const [level, setLevel] = useState<string | null>('1');
  const [note, setNote] = useState('');
  const [homework, setHomework] = useState('');
  const presets = [...new Set([...known, 'Sit', 'Down', 'Stay', 'Come', 'Loose-leash walking', 'Leave it', 'Place'])];
  return (
    <Sheet visible={open} onClose={onClose} title="Record training progress">
      <Pick value={presets.includes(skill) ? skill : null} onChange={setSkill} options={presets.map((s) => ({ value: s, label: s }))} />
      <Field label="Or another skill" value={skill} onChangeText={setSkill} />
      <Pick label="Level" value={level} onChange={setLevel} options={LEVELS.map((l, i) => ({ value: String(i), label: l }))} />
      <Field label="Note" value={note} onChangeText={setNote} />
      <Field label="Homework for the owner" value={homework} onChangeText={setHomework} />
      <Button
        variant="primary"
        title="Save and share with owner"
        disabled={!skill.trim()}
        onPress={async () => {
          if (await attempt(() => api.post(`/dogs/${dogId}/progress`, { skill: skill.trim(), level: Number(level), note: orNull(note), homework: orNull(homework), sharedWithOwner: true }))) {
            setNote('');
            setHomework('');
            onDone();
          }
        }}
      />
    </Sheet>
  );
}

function EditDog({ open, dog, onClose, onDone }: { open: boolean; dog: Dog; onClose: () => void; onDone: () => void }) {
  return (
    <FormSheet
      open={open}
      title={`Edit ${dog.name}`}
      fields={[
        { key: 'name', label: 'Name' },
        { key: 'breed', label: 'Breed' },
        { key: 'weightLb', label: 'Weight (lb)', keyboard: 'numeric' },
        { key: 'birthDate', label: 'Birthday (YYYY-MM-DD)' },
        { key: 'feeding', label: 'Feeding', multiline: true },
        { key: 'allergies', label: 'Allergies (comma separated)' },
        { key: 'behaviour', label: 'Behaviour notes', multiline: true },
      ]}
      initial={{
        name: dog.name,
        breed: dog.breed ?? '',
        weightLb: dog.weightLb ? String(dog.weightLb) : '',
        birthDate: dog.birthDate ?? '',
        feeding: dog.feeding ?? '',
        allergies: dog.allergies.join(', '),
        behaviour: dog.behaviour.notes ?? '',
      }}
      onClose={onClose}
      onSave={async (v) => {
        const r = await attempt(() =>
          api.patch(`/dogs/${dog.id}`, {
            name: v.name,
            breed: orNull(v.breed),
            weightLb: v.weightLb ? Number(v.weightLb) : null,
            birthDate: orNull(v.birthDate),
            feeding: orNull(v.feeding),
            allergies: v.allergies.split(',').map((s) => s.trim()).filter(Boolean),
            behaviour: { ...dog.behaviour, notes: v.behaviour },
          }),
        );
        if (r) onDone();
        return r;
      }}
    />
  );
}
