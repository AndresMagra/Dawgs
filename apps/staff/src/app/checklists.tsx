import { useState } from 'react';
import { Stack } from 'expo-router';
import { time, todayKey, dateKeyLabel } from '@dawgs/client';
import { Button, Card, Chip, Empty, Field, H2, P, Row, Screen, Sheet, Toggle, useLoad } from '@dawgs/ui';
import { api, useSession } from '../lib/session';
import { attempt } from '../lib/alert';

type Item = { item: string; doneBy: string | null; doneAt: string | null };
type List = { id: string; name: string; items: Item[]; done: number; active: boolean; sort: number };

/** Opening, closing and cleaning routines: tick them off today; managers write them. */
export default function Checklists() {
  const { business, isManager } = useSession();
  const tz = business?.timezone ?? 'America/New_York';
  const today = todayKey(tz);
  const lists = useLoad(() => api.get<List[]>(`/checklists${isManager ? '?all=1' : ''}`), [isManager], 30_000);
  const [editing, setEditing] = useState<List | 'new' | null>(null);
  const tick = async (l: List, i: Item) => {
    if (await attempt(() => api.post(`/checklists/${l.id}/check`, { item: i.item, done: !i.doneBy, date: today }))) void lists.reload();
  };

  return (
    <Screen refreshing={lists.loading}>
      <Stack.Screen options={{ title: 'Checklists' }} />
      <Row between>
        <P muted>{dateKeyLabel(today)}</P>
        {isManager ? <Button variant="primary" title="New checklist" onPress={() => setEditing('new')} /> : null}
      </Row>
      {lists.data?.length === 0 ? <Empty text={isManager ? 'Add an opening and a closing checklist so nothing gets missed.' : 'No checklists yet.'} /> : null}
      {lists.data?.map((l) => (
        <Card key={l.id}>
          <H2 right={isManager ? <Button small variant="ghost" title="Edit" onPress={() => setEditing(l)} /> : undefined}>{l.name}</H2>
          <Row>
            <Chip text={`${l.done} of ${l.items.length}`} tone={l.done === l.items.length ? 'ok' : l.done ? 'warn' : ''} />
            {!l.active ? <Chip text="Hidden from staff" /> : null}
          </Row>
          {l.items.map((i) => (
            <Row key={i.item} between>
              <Toggle label={i.item} value={!!i.doneBy} onChange={() => void tick(l, i)} />
              {i.doneBy ? <P small muted>{`${i.doneBy.split(' ')[0]} · ${time(i.doneAt!, tz)}`}</P> : null}
            </Row>
          ))}
        </Card>
      ))}
      {editing ? <EditChecklist list={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onDone={() => (setEditing(null), void lists.reload())} /> : null}
    </Screen>
  );
}

function EditChecklist({ list, onClose, onDone }: { list: List | null; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(list?.name ?? '');
  const [items, setItems] = useState(list?.items.map((i) => i.item).join('\n') ?? '');
  const [active, setActive] = useState(list?.active ?? true);
  const lines = items.split('\n').map((x) => x.trim()).filter(Boolean);
  return (
    <Sheet visible onClose={onClose} title={list ? 'Edit checklist' : 'New checklist'}>
      <Field label="Name" value={name} onChangeText={setName} placeholder="Opening" />
      <Field label="Items, one per line" value={items} onChangeText={setItems} multiline placeholder={'Unlock gates\nFill water bowls\nCheck yard for hazards'} />
      {list ? <Toggle label="Show to staff" value={active} onChange={setActive} /> : null}
      <Button
        variant="primary"
        title="Save"
        disabled={!name.trim() || !lines.length}
        onPress={async () => {
          const body = { name: name.trim(), items: lines, active };
          if (await attempt(() => (list ? api.patch(`/checklists/${list.id}`, body) : api.post('/checklists', body)))) onDone();
        }}
      />
    </Sheet>
  );
}
