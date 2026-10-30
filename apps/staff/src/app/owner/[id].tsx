import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { creditsText, day, money, time, type Card as SavedCard, type Dog, type AuthorizedPerson, type Invoice, type Membership, type Owner, type SmsMessage, type Waiver, invoiceStage, todayKey } from '@dawgs/client';
import { Avatar, Button, Card, Chip, Empty, Field, H1, H2, Line, Notice, P, Pick, Row, Screen, Segmented, Sheet, SignaturePad, useLoad } from '@dawgs/ui';
import { api, useSession } from '../../lib/session';
import { attempt, confirm } from '../../lib/alert';
import { AddCardSheet, FormSheet, orNull } from '../../lib/sheets';
import { InvoiceSheet, NewInvoiceSheet } from '../../lib/invoices';
import { PeopleList } from '../../lib/people';

interface OwnerDetail {
  owner: Owner;
  dogs: Dog[];
  cards: SavedCard[];
  invoices: Invoice[];
  memberships: Membership[];
  texts: SmsMessage[];
  waivers: { id: string; title: string; version: number; dogId: string | null; signedName: string; signedAt: string }[];
  people: AuthorizedPerson[];
}

export default function OwnerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { business } = useSession();
  const tz = business?.timezone;
  const d = useLoad(() => api.get<OwnerDetail>(`/owners/${id}`), [id]);
  const [tab, setTab] = useState<'dogs' | 'people' | 'billing' | 'forms' | 'texts'>('dogs');
  const [sheet, setSheet] = useState<null | 'edit' | 'card' | 'text' | 'sign' | 'dog' | 'invoice'>(null);
  const [invoice, setInvoice] = useState<string | null>(null);
  const o = d.data?.owner;
  if (!o) return <Screen>{d.error ? <Empty text={d.error} /> : <P muted>Loading…</P>}</Screen>;
  const data = d.data!;
  const reload = () => {
    setSheet(null);
    setInvoice(null);
    void d.reload();
  };
  const missing = [...new Set(data.dogs.flatMap((x) => x.waiversMissing))];
  const balance = data.invoices.filter((i) => i.status === 'open').reduce((s, i) => s + i.totalCents, 0);

  return (
    <Screen refreshing={d.loading}>
      <Stack.Screen options={{ title: o.name }} />
      <H1>{o.name}</H1>
      <P muted>{[o.phone, o.email].filter(Boolean).join(' · ')}</P>
      {o.emergencyName ? <P small muted>Emergency: {o.emergencyName} {o.emergencyPhone ?? ''}</P> : null}
      {o.vetName ? <P small muted>Vet: {o.vetName} {o.vetPhone ?? ''}</P> : null}
      {missing.length ? <Notice tone="bad" text={`Still to sign: ${missing.join(', ')}`} /> : null}
      {balance > 0 ? <Notice tone="warn" text={`Open balance ${money(balance)}`} /> : null}
      <Row wrap>
        <Button title="Text" disabled={!o.phone} onPress={() => setSheet('text')} />
        <Button title="Collect a signature" onPress={() => setSheet('sign')} />
        <Button title="Add dog" onPress={() => setSheet('dog')} />
        <Button title="Edit" onPress={() => setSheet('edit')} />
      </Row>
      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: 'dogs', label: 'Dogs' },
          { value: 'people', label: `Pickup${data.people.length ? ` (${data.people.length})` : ''}` },
          { value: 'billing', label: 'Billing' },
          { value: 'forms', label: 'Forms' },
          { value: 'texts', label: 'Texts' },
        ]}
      />

      {tab === 'dogs' ? (
        <>
          {data.dogs.length === 0 ? <Empty text="No dogs yet." /> : null}
          {data.dogs.map((x) => (
            <Card key={x.id} onPress={() => router.push(`/dog/${x.id}`)}>
              <Row>
                <Avatar name={x.name} color={x.color} />
                <View style={{ flex: 1 }}>
                  <P bold>{x.name}</P>
                  <P small muted>{creditsText(x.wallet) || 'No credits'}</P>
                </View>
                {!x.canEnter ? <Chip text="Can't come in" tone="bad" /> : null}
              </Row>
            </Card>
          ))}
          {data.memberships.length ? <H2>Memberships</H2> : null}
          {data.memberships.map((m) => (
            <Card key={m.id}>
              <Row between>
                <P>
                  {data.dogs.find((x) => x.id === m.dogId)?.name} · renews {day(m.currentPeriodEnd, tz)}
                </P>
                <Chip text={m.status.replace('_', ' ')} tone={m.status === 'active' ? 'ok' : m.status === 'past_due' ? 'warn' : ''} />
              </Row>
              {m.status !== 'cancelled' ? (
                <Button
                  small
                  variant="ghost"
                  title="Cancel membership"
                  onPress={async () => (await confirm('Cancel membership?', 'Credits already given stay on the dog.')) && (await attempt(() => api.post(`/memberships/${m.id}/cancel`, {}))) && reload()}
                />
              ) : null}
            </Card>
          ))}
        </>
      ) : null}

      {tab === 'people' ? <PeopleList base={`/owners/${o.id}/people`} people={data.people} onChange={reload} /> : null}

      {tab === 'billing' ? (
        <>
          <H2 right={<Button small title="Add card" onPress={() => setSheet('card')} />}>Cards</H2>
          {data.cards.length === 0 ? <Empty text="No card on file." /> : null}
          {data.cards.map((c) => (
            <Card key={c.id}>
              <Row between>
                <P>
                  {c.brand} •••• {c.last4} · {c.expMonth}/{c.expYear}
                </P>
                <Row>
                  {c.isDefault ? <Chip text="Default" tone="ok" /> : <Button small title="Make default" onPress={async () => (await attempt(() => api.post(`/owners/${o.id}/cards/${c.id}/default`, {}))) && reload()} />}
                  <Button small variant="ghost" title="Remove" onPress={async () => (await confirm('Remove card?', `${c.brand} ${c.last4}`)) && (await attempt(() => api.del(`/owners/${o.id}/cards/${c.id}`))) && reload()} />
                </Row>
              </Row>
            </Card>
          ))}
          <H2 right={<Button small variant="primary" title="New invoice" onPress={() => setSheet('invoice')} />}>Invoices</H2>
          {data.invoices.length === 0 ? <Empty text="No invoices yet." /> : null}
          {data.invoices.map((i) => (
            <Card key={i.id} onPress={() => setInvoice(i.id)}>
              <Row between>
                <View>
                  <P bold>
                    #{i.number} · {money(i.totalCents)}
                  </P>
                  <P small muted>
                    {day(i.createdAt, tz)} · {i.lines.map((l) => l.text).slice(0, 2).join(', ')}
                  </P>
                </View>
                <Chip {...invoiceStage(i, todayKey(tz ?? 'America/New_York'))} />
              </Row>
            </Card>
          ))}
        </>
      ) : null}

      {tab === 'forms' ? (
        <>
          {data.waivers.length === 0 ? <Empty text="Nothing signed yet." /> : null}
          {data.waivers.map((w) => (
            <Line key={w.id} left={`${w.title} v${w.version}${w.dogId ? ` · ${data.dogs.find((x) => x.id === w.dogId)?.name ?? ''}` : ''}`} right={`${w.signedName} · ${day(w.signedAt, tz)}`} />
          ))}
        </>
      ) : null}

      {tab === 'texts' ? (
        <>
          {data.texts.length === 0 ? <Empty text="No texts yet." /> : null}
          {data.texts.map((t) => (
            <Card key={t.id} style={{ alignSelf: t.direction === 'out' ? 'flex-end' : 'flex-start', maxWidth: '85%' }}>
              <P>{t.body}</P>
              <P small muted>
                {day(t.createdAt, tz)} {time(t.createdAt, tz)} · {t.direction === 'out' ? (t.sentBy ?? 'automatic') : 'reply'}
                {t.status === 'failed' ? ` · failed: ${t.error ?? ''}` : ''}
              </P>
            </Card>
          ))}
        </>
      ) : null}

      <InvoiceSheet invoiceId={invoice} hasCard={data.cards.length > 0} onClose={() => setInvoice(null)} onDone={() => void d.reload()} />
      <NewInvoiceSheet
        open={sheet === 'invoice'}
        owner={o}
        dogs={data.dogs}
        onClose={() => setSheet(null)}
        onDone={(invId) => {
          setSheet(null);
          void d.reload();
          setInvoice(invId);
        }}
      />
      <AddCardSheet ownerId={o.id} open={sheet === 'card'} onClose={() => setSheet(null)} onDone={reload} />
      <SignSheet open={sheet === 'sign'} owner={o} dogs={data.dogs} onClose={() => setSheet(null)} onDone={reload} />
      <FormSheet
        open={sheet === 'text'}
        title={`Text ${o.name}`}
        fields={[{ key: 'body', label: 'Message', multiline: true }]}
        onClose={() => setSheet(null)}
        onSave={async (v) => {
          const r = await attempt(() => api.post(`/owners/${o.id}/text`, { body: v.body }));
          if (r) reload();
          return r;
        }}
      />
      <FormSheet
        open={sheet === 'dog'}
        title="Add a dog"
        fields={[
          { key: 'name', label: 'Name' },
          { key: 'breed', label: 'Breed' },
        ]}
        onClose={() => setSheet(null)}
        onSave={async (v) => {
          const r = await attempt(() => api.post<{ id: string }>('/dogs', { ownerId: o.id, name: v.name, breed: orNull(v.breed) }));
          if (r) router.push(`/dog/${r.id}`);
          return r;
        }}
      />
      <FormSheet
        open={sheet === 'edit'}
        title="Edit owner"
        fields={[
          { key: 'name', label: 'Name' },
          { key: 'phone', label: 'Mobile', keyboard: 'phone-pad' },
          { key: 'email', label: 'Email', keyboard: 'email-address' },
          { key: 'address', label: 'Address' },
          { key: 'emergencyName', label: 'Emergency contact' },
          { key: 'emergencyPhone', label: 'Emergency phone', keyboard: 'phone-pad' },
          { key: 'vetName', label: 'Vet' },
          { key: 'vetPhone', label: 'Vet phone', keyboard: 'phone-pad' },
          { key: 'notes', label: 'Notes', multiline: true },
        ]}
        initial={Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v == null ? '' : String(v)]))}
        onClose={() => setSheet(null)}
        onSave={async (v) => {
          const body = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'name' ? x : orNull(x)]));
          const r = await attempt(() => api.patch(`/owners/${o.id}`, body));
          if (r) reload();
          return r;
        }}
      />
    </Screen>
  );
}

/** The owner reads and signs on the front-desk tablet; the server keeps the exact text signed. */
function SignSheet({ open, owner, dogs, onClose, onDone }: { open: boolean; owner: Owner; dogs: Dog[]; onClose: () => void; onDone: () => void }) {
  const forms = useLoad(() => api.get<Waiver[]>('/waivers'), []);
  const [waiverId, setWaiverId] = useState<string | null>(null);
  const [dogId, setDogId] = useState<string | null>(null);
  const [name, setName] = useState(owner.name);
  const [sig, setSig] = useState<string | null>(null);
  const w = forms.data?.find((x) => x.id === waiverId);
  return (
    <Sheet visible={open} onClose={onClose} title="Sign a form">
      <Pick value={waiverId} onChange={setWaiverId} options={(forms.data ?? []).filter((x) => x.active).map((x) => ({ value: x.id, label: `${x.title} (v${x.version})` }))} />
      {w ? (
        <>
          {w.scope === 'dog' ? <Pick label="For which dog" value={dogId} onChange={setDogId} options={dogs.map((x) => ({ value: x.id, label: x.name }))} /> : null}
          <ScrollView style={{ maxHeight: 260, borderWidth: 1, borderColor: '#d4d4d8', borderRadius: 10, padding: 10 }}>
            <P>{w.body}</P>
          </ScrollView>
          <Field label="Type your full name" value={name} onChangeText={setName} />
          <P small muted>Sign below</P>
          <SignaturePad onChange={setSig} />
          <Button
            variant="primary"
            title="I agree and sign"
            disabled={name.trim().length < 2 || !sig || (w.scope === 'dog' && !dogId)}
            onPress={async () => {
              const r = await attempt(() => api.post(`/waivers/${w.id}/sign`, { ownerId: owner.id, dogId: w.scope === 'dog' ? dogId : null, signedName: name.trim(), signatureImage: sig, version: w.version }));
              if (r) {
                setWaiverId(null);
                setSig(null);
                onDone();
              }
            }}
          />
        </>
      ) : null}
    </Sheet>
  );
}
