import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import type { Dog } from '@dawgs/client';
import { Avatar, Chips, Field, P, Row, useLoad, useTheme } from '@dawgs/ui';
import { api } from './session';

/** Search-as-you-type list of dogs; tap one to choose it. */
export function DogPicker({ onPick, filter }: { onPick: (d: Dog) => void; filter?: (d: Dog) => boolean }) {
  const t = useTheme();
  const [q, setQ] = useState('');
  const { data } = useLoad(() => api.get<Dog[]>('/dogs'), []);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data ?? [])
      .filter((d) => d.active && (!filter || filter(d)))
      .filter((d) => !s || d.name.toLowerCase().includes(s) || d.owner.name.toLowerCase().includes(s) || (d.breed ?? '').toLowerCase().includes(s))
      .slice(0, 30);
  }, [data, q, filter]);
  return (
    <View style={{ gap: 8 }}>
      <Field label="Find a dog" value={q} onChangeText={setQ} placeholder="Dog, owner or breed" autoFocus />
      {list.map((d) => (
        <Pressable key={d.id} onPress={() => onPick(d)} style={{ padding: 10, borderRadius: 12, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border }}>
          <Row>
            <Avatar name={d.name} color={d.color} size={34} />
            <View style={{ flex: 1, gap: 2 }}>
              <P bold>
                {d.name} <P small muted>{d.breed ?? ''} · {d.owner.name}</P>
              </P>
              {!d.canEnter ? (
                <Chips items={[{ tone: 'bad', text: d.waiversMissing.length ? 'Waiver not signed' : 'Vaccines not current' }]} />
              ) : null}
            </View>
          </Row>
        </Pressable>
      ))}
    </View>
  );
}
