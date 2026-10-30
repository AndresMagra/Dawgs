import { useState } from 'react';
import { View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import type { Owner } from '@dawgs/client';
import { Button, Card, Empty, Field, P, Row, Screen, Sheet, Toggle, useLoad } from '@dawgs/ui';
import { api } from '../lib/session';
import { attempt } from '../lib/alert';
import { orNull } from '../lib/sheets';

export default function OwnersScreen() {
  const params = useLocalSearchParams<{ new?: string }>();
  const [q, setQ] = useState('');
  const list = useLoad(() => api.get<(Owner & { dogs: { id: string; name: string }[] })[]>(`/owners${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`), [q]);
  const [adding, setAdding] = useState(params.new === '1');
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Owners' }} />
      <Row between>
        <View style={{ flex: 1 }}>
          <Field label="Search" value={q} onChangeText={setQ} placeholder="Name, phone or email" />
        </View>
        <Button variant="primary" title="New client" onPress={() => setAdding(true)} />
      </Row>
      {list.data?.length === 0 ? <Empty text="No owners match." /> : null}
      {list.data?.map((o) => (
        <Card key={o.id} onPress={() => router.push(`/owner/${o.id}`)}>
          <Row between>
            <View style={{ flex: 1 }}>
              <P bold>{o.name}</P>
              <P small muted>{[o.phone, o.email].filter(Boolean).join(' · ')}</P>
            </View>
            <P small muted>{o.dogs.map((d) => d.name).join(', ') || 'No dogs yet'}</P>
          </Row>
        </Card>
      ))}
      <NewClientSheet open={adding} onClose={() => setAdding(false)} />
    </Screen>
  );
}

/** A new owner and their first dog in one go, the way a front desk takes them. */
function NewClientSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [f, setF] = useState<Record<string, string>>({});
  const [sms, setSms] = useState(true);
  const set = (k: string) => (v: string) => setF((s) => ({ ...s, [k]: v }));
  return (
    <Sheet visible={open} onClose={onClose} title="New client">
      <P bold>Owner</P>
      <Field label="Full name" value={f.name ?? ''} onChangeText={set('name')} />
      <Field label="Mobile" value={f.phone ?? ''} onChangeText={set('phone')} keyboardType="phone-pad" />
      <Field label="Email" value={f.email ?? ''} onChangeText={set('email')} keyboardType="email-address" autoCapitalize="none" />
      <Field label="Emergency contact" value={f.emergencyName ?? ''} onChangeText={set('emergencyName')} />
      <Field label="Emergency phone" value={f.emergencyPhone ?? ''} onChangeText={set('emergencyPhone')} keyboardType="phone-pad" />
      <Field label="Vet" value={f.vetName ?? ''} onChangeText={set('vetName')} />
      <Toggle label="OK to text this number" value={sms} onChange={setSms} />
      <P bold>First dog</P>
      <Field label="Dog's name" value={f.dog ?? ''} onChangeText={set('dog')} />
      <Field label="Breed" value={f.breed ?? ''} onChangeText={set('breed')} />
      <Button
        variant="primary"
        title="Add client"
        disabled={!f.name?.trim()}
        onPress={async () => {
          const o = await attempt(() =>
            api.post<Owner>('/owners', {
              name: f.name!.trim(),
              phone: orNull(f.phone ?? ''),
              email: orNull(f.email ?? ''),
              emergencyName: orNull(f.emergencyName ?? ''),
              emergencyPhone: orNull(f.emergencyPhone ?? ''),
              vetName: orNull(f.vetName ?? ''),
              smsOptIn: sms,
            }),
          );
          if (!o) return;
          if (f.dog?.trim()) await attempt(() => api.post('/dogs', { ownerId: o.id, name: f.dog!.trim(), breed: orNull(f.breed ?? '') }));
          setF({});
          onClose();
          router.push(`/owner/${o.id}`);
        }}
      />
    </Sheet>
  );
}
