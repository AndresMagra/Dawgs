import { useState } from 'react';
import { Platform } from 'react-native';
import { Stack } from 'expo-router';
import * as Linking from 'expo-linking';
import { money, type Business, type PriceList, type WalkType } from '@dawgs/client';
import { Button, Card, Chip, Field, H2, Line, Notice, P, Row, Screen, Segmented, Sheet, Toggle, useLoad } from '@dawgs/ui';
import { api, useSession } from '../lib/session';
import { attempt, confirm, say } from '../lib/alert';
import { FormSheet, orNull } from '../lib/sheets';

interface Settings {
  business: Business & {
    daycareCapacity: number;
    inactiveAfterDays: number;
    pickupTextsEnabled: boolean;
    invoiceRemindersEnabled: boolean;
    emailMode: 'console' | 'resend';
    plan: string;
    trialEndsAt: string | null;
    stripeConnected: boolean;
    paymentsMode: 'stripe' | 'not_connected' | 'simulated';
    twilio: { accountSid: string; from: string } | null;
  };
  yards: { id: string; name: string; capacity: number; note: string | null; maxWeightLb: number | null }[];
  kennels: { id: string; name: string; type: 'suite' | 'run'; active: boolean }[];
  addOns: { id: string; code: string; name: string; priceCents: number; active: boolean }[];
  walkTypes: WalkType[];
}

const PRICE_LABELS: Record<keyof PriceList, string> = {
  halfDay: 'Half day',
  fullDay: 'Full day',
  hourly: 'Per hour',
  latePickupPerMinute: 'Late pickup, per minute',
  suiteNight: 'Suite, per night',
  runNight: 'Run, per night',
  boarderPlay: 'Daycare play for boarders, per day',
  lateCheckout: 'Late boarding checkout',
};

type ListPath = 'yards' | 'kennels' | 'add-ons' | 'walk-types';

export default function SettingsScreen() {
  const { refresh } = useSession();
  const s = useLoad(() => api.get<Settings>('/settings'), []);
  const [tab, setTab] = useState<'business' | 'prices' | 'rooms' | 'services' | 'payments' | 'texts'>('business');
  const [sheet, setSheet] = useState<null | 'business' | 'prices' | 'twilio' | { path: ListPath; row?: Record<string, unknown> }>(null);
  const [testTo, setTestTo] = useState('');
  const b = s.data?.business;
  if (!b) return <Screen><P muted>Loading…</P></Screen>;
  const reload = () => {
    setSheet(null);
    void s.reload();
    void refresh();
  };
  const patch = async (body: Record<string, unknown>) => {
    const r = await attempt(() => api.patch('/settings', body));
    if (r) reload();
    return r;
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Settings' }} />
      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: 'business', label: 'Business' },
          { value: 'prices', label: 'Prices & hours' },
          { value: 'rooms', label: 'Yards & kennels' },
          { value: 'services', label: 'Add-ons & walks' },
          { value: 'payments', label: 'Payments' },
          { value: 'texts', label: 'Texts' },
        ]}
      />

      {tab === 'business' ? (
        <>
          <Card>
            <Line left="Name" right={b.name} />
            <Line left="Phone" right={b.phone ?? '—'} />
            <Line left="Email" right={b.email ?? '—'} />
            <Line left="Address" right={b.address ?? '—'} />
            <Line left="Time zone" right={b.timezone} />
            <Line left="Brand colour" right={b.brandColor} />
            <Line left="Owner app sign-up code" right={b.slug} />
            <Line left="Plan" right={b.plan === 'free' ? 'Free' : b.plan === 'trial' ? `Trial${b.trialEndsAt ? ` until ${b.trialEndsAt.slice(0, 10)}` : ''}` : b.plan} />
            <Button title="Edit" onPress={() => setSheet('business')} />
          </Card>
          <Card>
            <Line left="Daycare dogs per day" right={String(b.daycareCapacity)} />
            <Line left="Required vaccines" right={b.requiredVaccines.join(', ')} />
            <Line left="Flag dogs inactive after" right={`${b.inactiveAfterDays} days`} />
            <Toggle label="Text owners 30 minutes before closing" value={b.pickupTextsEnabled} onChange={(v) => void patch({ pickupTextsEnabled: v })} />
            <Toggle label="Remind owners of overdue invoices (1, 7 and 14 days late)" value={b.invoiceRemindersEnabled} onChange={(v) => void patch({ invoiceRemindersEnabled: v })} />
            {b.emailMode === 'console' ? <Notice tone="warn" text="Email isn't switched on for this server yet, so invoices go out by text only. It is turned on when Dawgs is deployed." /> : <P small muted>Invoices are emailed from Dawgs with your business name; replies go to {b.email ?? 'your business email (set one above)'}.</P>}
          </Card>
        </>
      ) : null}

      {tab === 'prices' ? (
        <Card>
          {(Object.keys(PRICE_LABELS) as (keyof PriceList)[]).map((k) => (
            <Line key={k} left={PRICE_LABELS[k]} right={money(b.prices[k])} />
          ))}
          <Line left="Closes at" right={b.hours.closesAt} />
          <Line left="Boarding checkout by" right={b.hours.checkoutBy} />
          <Line left="Half day is up to" right={`${b.hours.halfDayLimitMinutes / 60} h`} />
          <Line left="Hourly minimum" right={`${b.hours.hourlyMinimumMinutes} min`} />
          <Button title="Edit prices and hours" onPress={() => setSheet('prices')} />
        </Card>
      ) : null}

      {tab === 'rooms' ? (
        <>
          <H2 right={<Button small title="Add yard" onPress={() => setSheet({ path: 'yards' })} />}>Yards</H2>
          {s.data!.yards.map((y) => (
            <Card key={y.id} onPress={() => setSheet({ path: 'yards', row: y })}>
              <Line left={y.name} right={`${y.capacity} dogs${y.maxWeightLb ? ` · up to ${y.maxWeightLb} lb` : ''}`} />
            </Card>
          ))}
          <H2 right={<Button small title="Add kennel" onPress={() => setSheet({ path: 'kennels' })} />}>Kennels</H2>
          {s.data!.kennels.map((k) => (
            <Card key={k.id} onPress={() => setSheet({ path: 'kennels', row: k })}>
              <Line left={k.name} right={`${k.type === 'suite' ? 'Suite' : 'Run'}${k.active ? '' : ' · off'}`} muted={!k.active} />
            </Card>
          ))}
        </>
      ) : null}

      {tab === 'services' ? (
        <>
          <H2 right={<Button small title="Add" onPress={() => setSheet({ path: 'add-ons' })} />}>Add-ons at checkout</H2>
          {s.data!.addOns.map((a) => (
            <Card key={a.id} onPress={() => setSheet({ path: 'add-ons', row: a })}>
              <Line left={a.name} right={`${money(a.priceCents)}${a.active ? '' : ' · off'}`} muted={!a.active} />
            </Card>
          ))}
          <H2 right={<Button small title="Add" onPress={() => setSheet({ path: 'walk-types' })} />}>Walks</H2>
          {s.data!.walkTypes.map((w) => (
            <Card key={w.id} onPress={() => setSheet({ path: 'walk-types', row: w as unknown as Record<string, unknown> })}>
              <Line left={`${w.name} (${w.minutes} min)`} right={`${money(w.priceCents)}${w.active ? '' : ' · off'}`} muted={!w.active} />
            </Card>
          ))}
        </>
      ) : null}

      {tab === 'payments' ? (
        <Card>
          {b.paymentsMode === 'simulated' ? (
            <Notice tone="warn" text="This server runs payments in simulation: test cards only, no money moves. Real Stripe is switched on when Dawgs is deployed." />
          ) : b.stripeConnected ? (
            <Notice tone="ok" text="Your Stripe account is connected. Card payments go straight to your Stripe balance." />
          ) : (
            <Notice tone="warn" text="Connect your own Stripe account to take cards. Dawgs never holds your money." />
          )}
          {b.paymentsMode !== 'simulated' ? (
            b.stripeConnected ? (
              <Button
                title="Disconnect Stripe"
                onPress={async () => (await confirm('Disconnect Stripe?', 'Cards on file stop working until you connect again.')) && (await attempt(() => api.del('/settings/stripe'))) && reload()}
              />
            ) : (
              <Button
                variant="primary"
                title="Connect Stripe"
                onPress={async () => {
                  const returnUrl = Platform.OS === 'web' ? `${window.location.origin}${process.env.EXPO_PUBLIC_BASE_URL ?? ''}/stripe-return` : Linking.createURL('/stripe-return');
                  const r = await attempt(() => api.post<{ url: string }>('/settings/stripe/connect', { returnUrl }));
                  if (r) await Linking.openURL(r.url);
                }}
              />
            )
          ) : null}
        </Card>
      ) : null}

      {tab === 'texts' ? (
        <Card>
          {b.twilio ? <Notice tone="ok" text={`Texts go out from ${b.twilio.from} on your Twilio account.`} /> : <Notice tone="warn" text="Texts are not set up. Until they are, Dawgs logs texts instead of sending them." />}
          <P small muted>Use your own Twilio account: in the Twilio console copy the Account SID, the Auth Token and your Twilio phone number. Then set the number's incoming message webhook to /webhooks/twilio on your Dawgs address so replies and STOP reach Dawgs.</P>
          <Row wrap>
            <Button variant="primary" title={b.twilio ? 'Change Twilio keys' : 'Set up Twilio'} onPress={() => setSheet('twilio')} />
            {b.twilio ? <Button title="Remove" onPress={async () => (await confirm('Remove Twilio?', 'Texts will stop going out.')) && (await attempt(() => api.put('/settings/twilio', null))) && reload()} /> : null}
          </Row>
          <Row>
            <Field label="Send a test text to" value={testTo} onChangeText={setTestTo} keyboardType="phone-pad" />
            <Button
              title="Send test"
              disabled={testTo.length < 7}
              onPress={async () => {
                const r = await attempt(() => api.post<{ mode: string }>('/settings/twilio/test', { to: testTo }));
                if (r) say(r.mode === 'twilio' ? 'Test text sent' : 'Logged, not sent', r.mode === 'twilio' ? '' : 'Twilio is not set up yet.');
              }}
            />
          </Row>
        </Card>
      ) : null}

      <FormSheet
        open={sheet === 'business'}
        title="Business"
        fields={[
          { key: 'name', label: 'Name' },
          { key: 'phone', label: 'Phone', keyboard: 'phone-pad' },
          { key: 'email', label: 'Email', keyboard: 'email-address' },
          { key: 'address', label: 'Address' },
          { key: 'timezone', label: 'Time zone (e.g. America/New_York)' },
          { key: 'brandColor', label: 'Brand colour (#RRGGBB)' },
          { key: 'logoUrl', label: 'Logo link' },
          { key: 'daycareCapacity', label: 'Daycare dogs per day', keyboard: 'numeric' },
          { key: 'requiredVaccines', label: 'Required vaccines (comma separated)' },
          { key: 'inactiveAfterDays', label: 'Inactive after (days)', keyboard: 'numeric' },
        ]}
        initial={{
          name: b.name,
          phone: b.phone ?? '',
          email: b.email ?? '',
          address: b.address ?? '',
          timezone: b.timezone,
          brandColor: b.brandColor,
          logoUrl: b.logoUrl ?? '',
          daycareCapacity: String(b.daycareCapacity),
          requiredVaccines: b.requiredVaccines.join(', '),
          inactiveAfterDays: String(b.inactiveAfterDays),
        }}
        onClose={() => setSheet(null)}
        onSave={(v) =>
          patch({
            name: v.name,
            phone: orNull(v.phone),
            email: orNull(v.email),
            address: orNull(v.address),
            timezone: v.timezone,
            brandColor: v.brandColor,
            logoUrl: orNull(v.logoUrl),
            daycareCapacity: Number(v.daycareCapacity),
            requiredVaccines: v.requiredVaccines.split(',').map((x) => x.trim()).filter(Boolean),
            inactiveAfterDays: Number(v.inactiveAfterDays),
          })
        }
      />
      <FormSheet
        open={sheet === 'prices'}
        title="Prices and hours"
        fields={[
          ...(Object.keys(PRICE_LABELS) as (keyof PriceList)[]).map((k) => ({ key: k as string, label: `${PRICE_LABELS[k]} ($)`, keyboard: 'numeric' as const })),
          { key: 'closesAt', label: 'Closes at (HH:MM)' },
          { key: 'checkoutBy', label: 'Boarding checkout by (HH:MM)' },
          { key: 'halfDayLimitMinutes', label: 'Half day is up to (minutes)', keyboard: 'numeric' },
          { key: 'hourlyMinimumMinutes', label: 'Hourly minimum (minutes)', keyboard: 'numeric' },
        ]}
        initial={{
          ...Object.fromEntries(Object.entries(b.prices).map(([k, c]) => [k, String(c / 100)])),
          closesAt: b.hours.closesAt,
          checkoutBy: b.hours.checkoutBy,
          halfDayLimitMinutes: String(b.hours.halfDayLimitMinutes),
          hourlyMinimumMinutes: String(b.hours.hourlyMinimumMinutes),
        }}
        onClose={() => setSheet(null)}
        onSave={(v) =>
          patch({
            prices: Object.fromEntries(Object.keys(PRICE_LABELS).map((k) => [k, Math.round(Number(v[k]) * 100)])),
            hours: { closesAt: v.closesAt, checkoutBy: v.checkoutBy, halfDayLimitMinutes: Number(v.halfDayLimitMinutes), hourlyMinimumMinutes: Number(v.hourlyMinimumMinutes) },
          })
        }
      />
      <FormSheet
        open={sheet === 'twilio'}
        title="Twilio"
        fields={[
          { key: 'accountSid', label: 'Account SID (starts AC…)' },
          { key: 'authToken', label: 'Auth Token (stored encrypted)' },
          { key: 'from', label: 'Twilio phone number' },
        ]}
        initial={{ accountSid: b.twilio?.accountSid ?? '', from: b.twilio?.from ?? '' }}
        onClose={() => setSheet(null)}
        onSave={async (v) => {
          const r = await attempt(() => api.put('/settings/twilio', v));
          if (r) reload();
          return r;
        }}
      />
      {sheet && typeof sheet === 'object' ? <ListItemSheet path={sheet.path} row={sheet.row} onClose={() => setSheet(null)} onDone={reload} /> : null}
    </Screen>
  );
}

const LIST_FIELDS: Record<ListPath, { key: string; label: string; kind?: 'money' | 'int' | 'num' | 'bool' | 'type' }[]> = {
  yards: [
    { key: 'name', label: 'Name' },
    { key: 'capacity', label: 'How many dogs', kind: 'int' },
    { key: 'maxWeightLb', label: 'Max weight (lb, optional)', kind: 'num' },
    { key: 'note', label: 'Note (e.g. small & senior)' },
  ],
  kennels: [
    { key: 'name', label: 'Name' },
    { key: 'type', label: 'Type', kind: 'type' },
    { key: 'active', label: 'In use', kind: 'bool' },
  ],
  'add-ons': [
    { key: 'name', label: 'Name' },
    { key: 'code', label: 'Short code (e.g. bath)' },
    { key: 'priceCents', label: 'Price ($)', kind: 'money' },
    { key: 'active', label: 'Offered', kind: 'bool' },
  ],
  'walk-types': [
    { key: 'name', label: 'Name' },
    { key: 'minutes', label: 'Minutes', kind: 'int' },
    { key: 'priceCents', label: 'Price ($)', kind: 'money' },
    { key: 'active', label: 'Offered', kind: 'bool' },
  ],
};

function ListItemSheet({ path, row, onClose, onDone }: { path: ListPath; row?: Record<string, unknown>; onClose: () => void; onDone: () => void }) {
  const fields = LIST_FIELDS[path];
  const init = (f: (typeof fields)[number]) => {
    const v = row?.[f.key];
    if (f.kind === 'bool') return v === undefined ? true : Boolean(v);
    if (f.kind === 'type') return (v as string) ?? 'run';
    if (f.kind === 'money') return v == null ? '' : String(Number(v) / 100);
    return v == null ? '' : String(v);
  };
  const [vals, setVals] = useState<Record<string, string | boolean>>(Object.fromEntries(fields.map((f) => [f.key, init(f)])));
  return (
    <Sheet visible onClose={onClose} title={row ? 'Edit' : 'Add'}>
      {fields.map((f) =>
        f.kind === 'bool' ? (
          <Toggle key={f.key} label={f.label} value={Boolean(vals[f.key])} onChange={(v) => setVals({ ...vals, [f.key]: v })} />
        ) : f.kind === 'type' ? (
          <Segmented key={f.key} value={vals[f.key] as 'suite' | 'run'} onChange={(v) => setVals({ ...vals, [f.key]: v })} options={[{ value: 'run', label: 'Run' }, { value: 'suite', label: 'Suite' }]} />
        ) : (
          <Field key={f.key} label={f.label} value={String(vals[f.key])} onChangeText={(v) => setVals({ ...vals, [f.key]: v })} keyboardType={f.kind ? 'numeric' : 'default'} />
        ),
      )}
      <Row>
        <Button
          variant="primary"
          title="Save"
          onPress={async () => {
            const body = Object.fromEntries(
              fields.map((f) => {
                const v = vals[f.key];
                if (f.kind === 'money') return [f.key, Math.round(Number(v) * 100)];
                if (f.kind === 'int' || f.kind === 'num') return [f.key, v === '' ? null : Number(v)];
                if (f.kind === 'bool' || f.kind === 'type') return [f.key, v];
                return [f.key, f.key === 'note' ? orNull(String(v)) : String(v)];
              }),
            );
            const r = await attempt(() => (row ? api.patch(`/settings/${path}/${row.id}`, body) : api.post(`/settings/${path}`, body)));
            if (r) onDone();
          }}
        />
        {row ? <Button variant="ghost" title="Delete" onPress={async () => (await confirm('Delete?', 'If it is in use, switch it off instead.')) && (await attempt(() => api.del(`/settings/${path}/${row.id}`))) && onDone()} /> : null}
      </Row>
      {row ? <Chip text="Changes apply from now on; past bills keep their prices." /> : null}
    </Sheet>
  );
}
