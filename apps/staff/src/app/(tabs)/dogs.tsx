import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import type { Dog } from '@dawgs/client';
import { Avatar, Button, Card, Chips, Empty, Field, Grid, P, Row, Screen, Segmented, useLoad } from '@dawgs/ui';
import { api } from '../../lib/session';

export default function DogsScreen() {
  const dogs = useLoad(() => api.get<Dog[]>('/dogs'), []);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'attention' | 'archived'>('all');
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (dogs.data ?? [])
      .filter((d) => (filter === 'archived' ? !d.active : d.active))
      .filter((d) => filter !== 'attention' || !d.canEnter || d.vaccineState === 'due_soon' || d.vaccinesAwaitingReview > 0)
      .filter((d) => !s || `${d.name} ${d.breed ?? ''} ${d.owner.name} ${d.owner.phone ?? ''}`.toLowerCase().includes(s));
  }, [dogs.data, q, filter]);
  return (
    <Screen refreshing={dogs.loading && !!dogs.data}>
      <Row between wrap>
        <Segmented value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All dogs' }, { value: 'attention', label: 'Needs attention' }, { value: 'archived', label: 'Archived' }]} />
        <Row>
          <Button title="Owners" onPress={() => router.push('/owners')} />
          <Button variant="primary" title="New client" onPress={() => router.push('/owners?new=1')} />
        </Row>
      </Row>
      <Field label="Search" value={q} onChangeText={setQ} placeholder="Dog, breed, owner or phone" />
      {list.length === 0 && dogs.data ? <Empty text="No dogs match." /> : null}
      <Grid min={280}>
        {list.map((d) => (
          <Card key={d.id} onPress={() => router.push(`/dog/${d.id}`)}>
            <Row>
              <Avatar name={d.name} color={d.color} />
              <View style={{ flex: 1 }}>
                <P bold>{d.name}</P>
                <P small muted numberOfLines={1}>
                  {d.breed ?? 'Dog'} · {d.owner.name}
                </P>
              </View>
            </Row>
            <Chips
              items={[
                ...(d.vaccineState === 'expired' || d.vaccineState === 'missing' ? [{ tone: 'bad' as const, text: 'Vaccines' }] : d.vaccineState === 'due_soon' ? [{ tone: 'warn' as const, text: 'Vaccine due soon' }] : []),
                ...(d.vaccinesAwaitingReview ? [{ tone: 'info' as const, text: `${d.vaccinesAwaitingReview} to verify` }] : []),
                ...(d.waiversMissing.length ? [{ tone: 'bad' as const, text: 'Waiver unsigned' }] : []),
                ...d.flags,
              ]}
            />
          </Card>
        ))}
      </Grid>
    </Screen>
  );
}
