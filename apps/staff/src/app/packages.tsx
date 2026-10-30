import { useState } from 'react';
import { View } from 'react-native';
import { Stack } from 'expo-router';
import { creditsText, day, money, type Membership, type Package } from '@dawgs/client';
import { Button, Card, Chip, Empty, Field, P, Row, Screen, Segmented, Sheet, Toggle, useLoad } from '@dawgs/ui';
import { api, useSession } from '../lib/session';
import { attempt, confirm } from '../lib/alert';

const KINDS = [
  ['daycare', 'Daycare days'],
  ['night', 'Boarding nights'],
  ['walk', 'Walks'],
  ['bath', 'Baths'],
  ['training', 'Training lessons'],
] as const;

export default function PackagesScreen() {
  const { isManager, business } = useSession();
  const [tab, setTab] = useState<'packs' | 'members'>('packs');
  const list = useLoad(() => api.get<Package[]>('/packages'), []);
  const members = useLoad(() => api.get<Membership[]>('/memberships'), []);
  const [editing, setEditing] = useState<Package | 'new' | null>(null);
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Packs & memberships' }} />
      <Row between wrap>
        <Segmented value={tab} onChange={setTab} options={[{ value: 'packs', label: 'Packs' }, { value: 'members', label: 'Memberships' }]} />
        {isManager && tab === 'packs' ? <Button variant="primary" title="New pack" onPress={() => setEditing('new')} /> : null}
      </Row>
      {tab === 'packs' ? (
        <>
          {list.data?.length === 0 ? <Empty text="No packs yet." /> : null}
          {list.data?.map((p) => (
            <Card key={p.id} onPress={isManager ? () => setEditing(p) : undefined}>
              <Row between>
                <View style={{ flex: 1 }}>
                  <P bold>
                    {p.name} · {money(p.priceCents)}
                    {p.recurring ? '/month' : ''}
                  </P>
                  <P small muted>
                    {creditsText(p.credits)}
                    {p.expiresDays ? ` · use within ${p.expiresDays} days` : ''}
                    {p.recurring && p.rolloverMax ? ` · up to ${p.rolloverMax} roll over` : ''}
                  </P>
                </View>
                <Row>
                  {p.badge ? <Chip text={p.badge} tone="info" /> : null}
                  {p.sellOnline ? <Chip text="In owner app" tone="ok" /> : null}
                  {!p.active ? <Chip text="Off" /> : null}
                </Row>
              </Row>
            </Card>
          ))}
        </>
      ) : (
        <>
          {members.data?.length === 0 ? <Empty text="No memberships yet." /> : null}
          {members.data?.map((m) => (
            <Card key={m.id}>
              <Row between>
                <View style={{ flex: 1 }}>
                  <P bold>
                    {m.dogName} · {m.packageName}
                  </P>
                  <P small muted>
                    {m.ownerName} · {money(m.priceCents ?? 0)}/mo · {m.status === 'past_due' ? `card failed ${m.failures}×, next try ${m.nextAttemptAt ? day(m.nextAttemptAt, business?.timezone) : '—'}` : `renews ${day(m.currentPeriodEnd, business?.timezone)}`}
                  </P>
                </View>
                <Chip text={m.status.replace('_', ' ')} tone={m.status === 'active' ? 'ok' : m.status === 'past_due' ? 'warn' : ''} />
              </Row>
              {m.status !== 'cancelled' ? (
                <Button small variant="ghost" title="Cancel" onPress={async () => (await confirm('Cancel membership?', 'No more monthly charges. Credits already given stay.')) && (await attempt(() => api.post(`/memberships/${m.id}/cancel`, {}))) && void members.reload()} />
              ) : null}
            </Card>
          ))}
        </>
      )}
      <PackSheet pack={editing} onClose={() => setEditing(null)} onDone={() => (setEditing(null), void list.reload())} />
    </Screen>
  );
}

function PackSheet({ pack, onClose, onDone }: { pack: Package | 'new' | null; onClose: () => void; onDone: () => void }) {
  const p = pack && pack !== 'new' ? pack : null;
  const [f, setF] = useState<Record<string, string>>({});
  const [b, setB] = useState<Record<string, boolean>>({});
  const v = (k: string, d: string) => f[k] ?? d;
  const flag = (k: 'recurring' | 'sellOnline' | 'active', d: boolean) => b[k] ?? d;
  const close = () => {
    setF({});
    setB({});
    onClose();
  };
  if (!pack) return null;
  return (
    <Sheet visible onClose={close} title={p ? `Edit ${p.name}` : 'New pack'}>
      <Field label="Name" value={v('name', p?.name ?? '')} onChangeText={(x) => setF({ ...f, name: x })} />
      <Field label="Price ($)" value={v('price', p ? String(p.priceCents / 100) : '')} onChangeText={(x) => setF({ ...f, price: x })} keyboardType="numeric" />
      <P bold>What it includes</P>
      {KINDS.map(([k, label]) => (
        <Field key={k} label={label} value={v(k, String(p?.credits[k] ?? ''))} onChangeText={(x) => setF({ ...f, [k]: x })} keyboardType="numeric" />
      ))}
      <Toggle label="Monthly membership (charged automatically)" value={flag('recurring', p?.recurring ?? false)} onChange={(x) => setB({ ...b, recurring: x })} />
      {flag('recurring', p?.recurring ?? false) ? (
        <Field label="Unused credits that roll over" value={v('rollover', String(p?.rolloverMax ?? 0))} onChangeText={(x) => setF({ ...f, rollover: x })} keyboardType="numeric" />
      ) : (
        <Field label="Expires after (days, blank = never)" value={v('expires', p?.expiresDays ? String(p.expiresDays) : '')} onChangeText={(x) => setF({ ...f, expires: x })} keyboardType="numeric" />
      )}
      <Field label="Badge (e.g. Best value)" value={v('badge', p?.badge ?? '')} onChangeText={(x) => setF({ ...f, badge: x })} />
      <Toggle label="Owners can buy it in the app" value={flag('sellOnline', p?.sellOnline ?? true)} onChange={(x) => setB({ ...b, sellOnline: x })} />
      {p ? <Toggle label="On sale" value={flag('active', p.active)} onChange={(x) => setB({ ...b, active: x })} /> : null}
      <Button
        variant="primary"
        title="Save"
        onPress={async () => {
          const recurring = flag('recurring', p?.recurring ?? false);
          const credits = Object.fromEntries(KINDS.map(([k]) => [k, Number(v(k, String(p?.credits[k] ?? '0'))) || 0]));
          const body = {
            name: v('name', p?.name ?? '').trim(),
            priceCents: Math.round(Number(v('price', p ? String(p.priceCents / 100) : '0')) * 100),
            credits,
            recurring,
            rolloverMax: recurring ? Number(v('rollover', String(p?.rolloverMax ?? 0))) : 0,
            expiresDays: recurring ? null : v('expires', p?.expiresDays ? String(p.expiresDays) : '') ? Number(v('expires', String(p?.expiresDays ?? ''))) : null,
            badge: v('badge', p?.badge ?? '').trim() || null,
            sellOnline: flag('sellOnline', p?.sellOnline ?? true),
            ...(p ? { active: flag('active', p.active) } : {}),
          };
          if (await attempt(() => (p ? api.patch(`/packages/${p.id}`, body) : api.post('/packages', body)))) {
            close();
            onDone();
          }
        }}
      />
    </Sheet>
  );
}
