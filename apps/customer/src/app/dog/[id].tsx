import { useState } from 'react';
import { Image, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { creditsText, day, todayKey, type Dog, type ReportCard } from '@dawgs/client';
import { Avatar, Button, Card, Chip, Empty, Field, H1, H2, Line, Notice, P, Row, Screen, Segmented, Toggle, useLoad } from '@dawgs/ui';
import { api, useSession } from '../../lib/session';
import { attempt, say } from '../../lib/alert';

interface Detail {
  dog: Dog;
  vaccineRecords: { id: string; name: string; expiresAt: string; verifiedBy: string | null; documentUrl: string | null }[];
  reportCards: ReportCard[];
  training: { skills: { skill: string; level: number; label: string }[]; history: { id: string; skill: string; label?: string; level: number; note: string | null; homework: string | null; createdAt: string }[] };
}
const LEVELS = ['Introduced', 'Learning', 'With help', 'Reliable', 'Mastered'];
const orNull = (s: string) => (s.trim() ? s.trim() : null);

export default function DogScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  if (id === 'new') return <DogForm />;
  return <DogDetail id={id} />;
}

function DogDetail({ id }: { id: string }) {
  const { business } = useSession();
  const tz = business?.timezone ?? 'America/New_York';
  const d = useLoad(() => api.get<Detail>(`/me/dogs/${id}`), [id]);
  const [tab, setTab] = useState<'reports' | 'vaccines' | 'training' | 'profile'>('reports');
  const [vax, setVax] = useState({ name: '', expiresOn: todayKey(tz, 365) });
  const [photo, setPhoto] = useState<string | null>(null);
  const dog = d.data?.dog;
  if (!dog) return <Screen><P muted>Loading…</P></Screen>;

  async function pick(camera: boolean) {
    const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.4, base64: true };
    const r = camera ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
    const a = r.assets?.[0];
    if (!r.canceled && a?.base64) {
      if (a.base64.length > 4_000_000) return say('That photo is too large', 'Try again a little further away, or crop it.');
      setPhoto(`data:${a.mimeType ?? 'image/jpeg'};base64,${a.base64}`);
    }
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: dog.name }} />
      <Row>
        <Avatar name={dog.name} color={dog.color} size={64} />
        <View style={{ flex: 1 }}>
          <H1>{dog.name}</H1>
          <P muted>{[dog.breed, dog.weightLb ? `${dog.weightLb} lb` : null].filter(Boolean).join(' · ')}</P>
          <P small>{creditsText(dog.wallet) || 'No credits'}</P>
        </View>
      </Row>
      {!dog.canEnter ? <Notice tone="warn" text={dog.waiversMissing.length ? `Please sign: ${dog.waiversMissing.join(', ')}` : dog.vaccinesAwaitingReview ? "Thanks! We're checking the records you sent." : 'Please add current vaccine records so we can book.'} /> : null}
      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: 'reports', label: 'Report cards' },
          { value: 'vaccines', label: 'Vaccines' },
          { value: 'training', label: 'Training' },
          { value: 'profile', label: 'Profile' },
        ]}
      />
      {tab === 'reports' ? (
        <>
          {d.data!.reportCards.length === 0 ? <Empty text="Report cards from the team show up here." /> : null}
          {d.data!.reportCards.map((r) => (
            <Card key={r.id}>
              <Row between>
                <Chip text={r.kind === 'incident' ? 'Incident' : 'Report card'} tone={r.kind === 'incident' ? 'bad' : 'ok'} />
                <P small muted>
                  {day(r.createdAt, tz)} · {r.author}
                </P>
              </Row>
              <P>{r.body}</P>
              {r.photoUrl ? <Image source={{ uri: r.photoUrl }} style={{ width: '100%', height: 220, borderRadius: 10 }} resizeMode="cover" /> : null}
            </Card>
          ))}
        </>
      ) : null}
      {tab === 'vaccines' ? (
        <>
          <Card>
            {dog.vaccines.map((v) => (
              <Line key={v.name} left={v.name} right={<Chip text={v.state === 'ok' ? `Good until ${v.expiresAt ? day(v.expiresAt, tz) : ''}` : v.state === 'due_soon' ? 'Due soon' : v.state === 'expired' ? 'Expired' : 'Needed'} tone={v.state === 'ok' ? 'ok' : v.state === 'due_soon' ? 'warn' : 'bad'} />} />
            ))}
          </Card>
          {d.data!.vaccineRecords.map((v) => (
            <P key={v.id} small muted>
              {v.name} until {day(v.expiresAt, tz)} · {v.verifiedBy ? 'checked by the daycare' : 'waiting to be checked'}
            </P>
          ))}
          <H2>Add a record</H2>
          <Card>
            <Field label="Vaccine (Rabies, DHPP, Bordetella…)" value={vax.name} onChangeText={(x) => setVax({ ...vax, name: x })} />
            <Field label="Expires (YYYY-MM-DD)" value={vax.expiresOn} onChangeText={(x) => setVax({ ...vax, expiresOn: x })} />
            <Row>
              <Button title="Take a photo" onPress={() => pick(true)} />
              <Button title="Choose a photo" onPress={() => pick(false)} />
            </Row>
            {photo ? <Image source={{ uri: photo }} style={{ width: '100%', height: 200, borderRadius: 10 }} resizeMode="contain" /> : null}
            <Button
              variant="primary"
              title="Send to the daycare"
              disabled={!vax.name.trim() || !photo}
              onPress={async () => {
                if (await attempt(() => api.post(`/me/dogs/${id}/vaccines`, { name: vax.name.trim(), expiresOn: vax.expiresOn, documentUrl: photo }))) {
                  say('Sent', 'The daycare will check it and let you know.');
                  setVax({ name: '', expiresOn: vax.expiresOn });
                  setPhoto(null);
                  void d.reload();
                }
              }}
            />
          </Card>
        </>
      ) : null}
      {tab === 'training' ? (
        <>
          {d.data!.training.skills.length === 0 ? <Empty text="Progress from training classes and lessons shows up here." /> : null}
          {d.data!.training.skills.map((s) => (
            <Card key={s.skill}>
              <Row between>
                <P bold>{s.skill}</P>
                <Chip text={s.label} tone={s.level >= 3 ? 'ok' : 'info'} />
              </Row>
              <View style={{ flexDirection: 'row', gap: 4 }}>
                {LEVELS.map((_, i) => (
                  <View key={i} style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: i <= s.level ? '#3b82f6' : '#d4d4d8' }} />
                ))}
              </View>
            </Card>
          ))}
          {d.data!.training.history.filter((h) => h.homework).slice(0, 5).map((h) => (
            <Notice key={h.id} tone="info" text={`Homework (${h.skill}): ${h.homework}`} />
          ))}
        </>
      ) : null}
      {tab === 'profile' ? <DogForm dog={dog} onSaved={() => void d.reload()} /> : null}
    </Screen>
  );
}

function DogForm({ dog, onSaved }: { dog?: Dog; onSaved?: () => void }) {
  const [f, setF] = useState({
    name: dog?.name ?? '',
    breed: dog?.breed ?? '',
    weightLb: dog?.weightLb ? String(dog.weightLb) : '',
    birthDate: dog?.birthDate ?? '',
    feeding: dog?.feeding ?? '',
    allergies: dog?.allergies.join(', ') ?? '',
    notes: dog?.behaviour.notes ?? '',
  });
  const [sex, setSex] = useState<'male' | 'female' | null>(dog?.sex ?? null);
  const [beh, setBeh] = useState({ escapeRisk: !!dog?.behaviour.escapeRisk, leashReactive: !!dog?.behaviour.leashReactive, eatsAlone: !!dog?.behaviour.eatsAlone });
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });
  const body = (
    <Card>
      <Field label="Name" value={f.name} onChangeText={set('name')} />
      <Field label="Breed" value={f.breed} onChangeText={set('breed')} />
      <Segmented value={sex ?? 'male'} onChange={setSex} options={[{ value: 'male', label: 'Boy' }, { value: 'female', label: 'Girl' }]} />
      <Field label="Weight (lb)" value={f.weightLb} onChangeText={set('weightLb')} keyboardType="numeric" />
      <Field label="Birthday (YYYY-MM-DD)" value={f.birthDate} onChangeText={set('birthDate')} />
      <Field label="Feeding instructions" value={f.feeding} onChangeText={set('feeding')} multiline />
      <Field label="Allergies (comma separated)" value={f.allergies} onChangeText={set('allergies')} />
      <Toggle label="Tries to escape" value={beh.escapeRisk} onChange={(v) => setBeh({ ...beh, escapeRisk: v })} />
      <Toggle label="Reactive on a leash" value={beh.leashReactive} onChange={(v) => setBeh({ ...beh, leashReactive: v })} />
      <Toggle label="Needs to eat alone" value={beh.eatsAlone} onChange={(v) => setBeh({ ...beh, eatsAlone: v })} />
      <Field label="Anything else we should know" value={f.notes} onChangeText={set('notes')} multiline />
      <Button
        variant="primary"
        title={dog ? 'Save' : 'Add dog'}
        disabled={!f.name.trim()}
        onPress={async () => {
          const payload = {
            name: f.name.trim(),
            breed: orNull(f.breed),
            sex,
            weightLb: f.weightLb ? Number(f.weightLb) : null,
            birthDate: orNull(f.birthDate),
            feeding: orNull(f.feeding),
            allergies: f.allergies.split(',').map((x) => x.trim()).filter(Boolean),
            behaviour: { ...beh, notes: f.notes },
          };
          const r = await attempt(() => (dog ? api.patch(`/me/dogs/${dog.id}`, payload) : api.post<{ id: string }>('/me/dogs', payload)));
          if (!r) return;
          if (dog) {
            say('Saved');
            onSaved?.();
          } else router.replace(`/dog/${(r as { id: string }).id}`);
        }}
      />
    </Card>
  );
  if (dog) return body;
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Add a dog' }} />
      <H1>Tell us about your dog</H1>
      {body}
    </Screen>
  );
}
