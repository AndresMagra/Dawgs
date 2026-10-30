import { useState } from 'react';
import { View } from 'react-native';
import type { AuthorizedPerson } from '@dawgs/client';
import { Button, Card, Chip, Empty, Field, P, Row, Sheet, Toggle } from '@dawgs/ui';
import { api } from './session';
import { attempt, confirm } from './alert';
import { orNull } from './sheets';

/**
 * The pickup list on an owner's account. `base` is `/owners/:id/people` at the
 * desk; the customer app has its own copy against `/me/people`.
 */
export function PeopleList({ base, people, onChange }: { base: string; people: AuthorizedPerson[]; onChange: () => void }) {
  const [editing, setEditing] = useState<AuthorizedPerson | 'new' | null>(null);
  return (
    <>
      <Row between>
        <P muted small>People allowed to pick up. Co-owners can also sign in to the Dawgs app with their own email.</P>
        <Button small variant="primary" title="Add person" onPress={() => setEditing('new')} />
      </Row>
      {people.length === 0 ? <Empty text="Only the account holder can pick up." /> : null}
      {people.map((p) => (
        <Card key={p.id} onPress={() => setEditing(p)}>
          <Row between>
            <View style={{ flex: 1 }}>
              <P bold>{p.name}</P>
              <P small muted>{[p.relation, p.phone, p.email].filter(Boolean).join(' · ')}</P>
              {p.notes ? <P small muted>{p.notes}</P> : null}
            </View>
            <Row>
              {p.coOwner ? <Chip text={p.hasLogin ? 'Co-owner · has app' : 'Co-owner'} tone="info" /> : <Chip text="Pickup" />}
            </Row>
          </Row>
        </Card>
      ))}
      {editing ? <PersonSheet base={base} person={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onDone={() => (setEditing(null), onChange())} /> : null}
    </>
  );
}

function PersonSheet({ base, person, onClose, onDone }: { base: string; person: AuthorizedPerson | null; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({
    name: person?.name ?? '',
    relation: person?.relation ?? '',
    phone: person?.phone ?? '',
    email: person?.email ?? '',
    notes: person?.notes ?? '',
  });
  const [coOwner, setCoOwner] = useState(person?.coOwner ?? false);
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });
  return (
    <Sheet visible onClose={onClose} title={person ? person.name : 'Add someone who can pick up'}>
      <Field label="Full name" value={f.name} onChangeText={set('name')} />
      <Field label="Relation (partner, walker, grandparent…)" value={f.relation} onChangeText={set('relation')} />
      <Field label="Phone" value={f.phone} onChangeText={set('phone')} keyboardType="phone-pad" />
      <Field label="Email" value={f.email} onChangeText={set('email')} keyboardType="email-address" autoCapitalize="none" />
      <Field label="Notes for staff (e.g. ask for ID)" value={f.notes} onChangeText={set('notes')} />
      <Toggle label="Co-owner: can sign in to the Dawgs app and manage the account" value={coOwner} onChange={setCoOwner} />
      {coOwner ? <P small muted>They sign up in the Dawgs app with this email and land on this account.</P> : null}
      <Row>
        <Button
          variant="primary"
          title="Save"
          disabled={f.name.trim().length < 2 || (coOwner && !f.email.trim())}
          onPress={async () => {
            const body = { name: f.name.trim(), relation: orNull(f.relation), phone: orNull(f.phone), email: orNull(f.email), notes: orNull(f.notes), coOwner };
            if (await attempt(() => (person ? api.patch(`${base}/${person.id}`, body) : api.post(base, body)))) onDone();
          }}
        />
        {person ? (
          <Button
            variant="ghost"
            title="Remove"
            onPress={async () => (await confirm('Remove?', `${person.name} will no longer be allowed to pick up${person.coOwner ? ' or sign in' : ''}.`)) && (await attempt(() => api.del(`${base}/${person.id}`))) && onDone()}
          />
        ) : null}
      </Row>
    </Sheet>
  );
}
