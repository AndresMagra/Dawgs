import { useState } from 'react';
import { router } from 'expo-router';
import { Button, Card, Chip, Field, H2, Line, P, Row, Screen, Toggle } from '@dawgs/ui';
import { api, useSession } from '../../lib/session';
import { attempt } from '../../lib/alert';
import { defaultCard, useMe } from '../../lib/me';

export default function Account() {
  const { business, signOut } = useSession();
  const me = useMe();
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState<Record<string, string>>({});
  const o = me.data?.owner;
  const card = defaultCard(me.data);
  const v = (k: string) => f[k] ?? ((o as unknown as Record<string, string | null>)?.[k] ?? '');
  const links: { href: string; title: string; right?: string; tone?: 'bad' | 'warn' | 'ok' }[] = [
    { href: '/invoices', title: 'Invoices and receipts' },
    { href: '/cards', title: 'Payment cards', right: card ? `${card.brand} •••• ${card.last4}` : 'None' },
    { href: '/forms', title: 'Waivers and forms', right: me.data?.formsToSign ? `${me.data.formsToSign} to sign` : 'All signed', tone: me.data?.formsToSign ? 'bad' : 'ok' },
    { href: '/people', title: 'Who can pick up', right: me.data?.people.length ? `${me.data.people.length} people` : 'Only you' },
    { href: '/calendar', title: 'Calendar' },
  ];
  return (
    <Screen>
      {links.map((l) => (
        <Card key={l.href} onPress={() => router.push(l.href as never)}>
          <Row between>
            <P bold>{l.title}</P>
            {l.right ? l.tone ? <Chip text={l.right} tone={l.tone} /> : <P muted>{l.right}</P> : <P muted>›</P>}
          </Row>
        </Card>
      ))}
      <H2 right={!editing ? <Button small title="Edit" onPress={() => setEditing(true)} /> : undefined}>Your details</H2>
      {o ? (
        <Card>
          {editing ? (
            <>
              {(
                [
                  ['name', 'Name'],
                  ['phone', 'Mobile'],
                  ['email', 'Email'],
                  ['address', 'Address'],
                  ['emergencyName', 'Emergency contact'],
                  ['emergencyPhone', 'Emergency phone'],
                  ['vetName', 'Vet'],
                  ['vetPhone', 'Vet phone'],
                ] as const
              ).map(([k, label]) => (
                <Field key={k} label={label} value={v(k)} onChangeText={(x) => setF({ ...f, [k]: x })} />
              ))}
              <Button
                variant="primary"
                title="Save"
                onPress={async () => {
                  const body = Object.fromEntries(Object.entries(f).map(([k, x]) => [k, k === 'name' ? x : x.trim() || null]));
                  if (await attempt(() => api.patch('/me', body))) {
                    setEditing(false);
                    setF({});
                    void me.reload();
                  }
                }}
              />
            </>
          ) : (
            <>
              <Line left="Name" right={o.name} />
              <Line left="Mobile" right={o.phone ?? '—'} />
              <Line left="Email" right={o.email ?? '—'} />
              <Line left="Emergency" right={o.emergencyName ? `${o.emergencyName} ${o.emergencyPhone ?? ''}` : '—'} />
              <Line left="Vet" right={o.vetName ?? '—'} />
            </>
          )}
          <Toggle label="Texts from the daycare (pickup reminders, walk reports)" value={o.smsOptIn} onChange={async (smsOptIn) => (await attempt(() => api.patch('/me', { smsOptIn }))) && void me.reload()} />
        </Card>
      ) : null}
      <P small muted>
        {business?.name}
        {business?.phone ? ` · ${business.phone}` : ''}
      </P>
      <Button variant="ghost" title="Sign out" onPress={() => void signOut()} />
    </Screen>
  );
}
