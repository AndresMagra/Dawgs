import { useState } from 'react';
import { Platform, Share, View } from 'react-native';
import { Stack } from 'expo-router';
import { dateKeyLabel, money, todayKey } from '@dawgs/client';
import { Button, Card, Empty, Grid, H2, Line, P, Row, Screen, Segmented, Stat, useLoad, useTheme } from '@dawgs/ui';
import { api, useSession } from '../lib/session';
import { attempt } from '../lib/alert';

interface Reports {
  from: string;
  to: string;
  revenue: { totalCents: number; tipsCents: number; taxCents: number; byService: { service: string; cents: number }[]; byDay: { day: string; cents: number }[] };
  topClients: { ownerId: string; name: string; cents: number; payments: number }[];
  occupancy: { night: string; booked: number; kennels: number }[];
  credits: { cents: number; byKind: { kind: string; credits: number; cents: number }[] };
  staffHours: { userId: string; name: string; hours: number; shifts: number }[];
}

const SERVICE: Record<string, string> = { daycare: 'Daycare', boarding: 'Boarding', packages: 'Packs & memberships', walks: 'Walks', training: 'Training', retail: 'Retail', other: 'Other' };
const EXPORTS = [
  { kind: 'payments', label: 'Payments' },
  { kind: 'invoices', label: 'Invoices' },
  { kind: 'clients', label: 'Clients & dogs' },
  { kind: 'bookings', label: 'Bookings' },
  { kind: 'staff-hours', label: 'Staff hours' },
] as const;

/** Bars drawn with plain views, so the same screen works on the web and in the apps. */
function Bars({ values, labels, max, format }: { values: number[]; labels: string[]; max: number; format: (n: number) => string }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 140 }}>
      {values.map((v, i) => (
        <View key={i} style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end', height: '100%' }} accessibilityLabel={`${labels[i]}: ${format(v)}`}>
          <View style={{ width: '100%', height: `${max ? Math.max(v ? 3 : 0, (v / max) * 100) : 0}%`, backgroundColor: t.brand, borderTopLeftRadius: 3, borderTopRightRadius: 3 }} />
        </View>
      ))}
    </View>
  );
}

async function download(filename: string, csv: string) {
  if (Platform.OS === 'web') {
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } else {
    await Share.share({ title: filename, message: csv });
  }
}

export default function ReportsScreen() {
  const { business, can } = useSession();
  const tz = business?.timezone ?? 'America/New_York';
  const today = todayKey(tz);
  const [span, setSpan] = useState<'7' | '30' | 'month' | 'year'>('30');
  const from = span === '7' ? todayKey(tz, -6) : span === '30' ? todayKey(tz, -29) : span === 'month' ? `${today.slice(0, 7)}-01` : `${today.slice(0, 4)}-01-01`;
  const r = useLoad(() => api.get<Reports>(`/reports?from=${from}&to=${today}`), [from, today]);
  const d = r.data;
  const byDay = d?.revenue.byDay ?? [];
  const dayMax = Math.max(0, ...byDay.map((x) => x.cents));
  const occMax = Math.max(1, ...(d?.occupancy.map((x) => x.kennels) ?? [1]));

  return (
    <Screen refreshing={r.loading}>
      <Stack.Screen options={{ title: 'Reports' }} />
      <Segmented value={span} onChange={setSpan} options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: 'month', label: 'This month' }, { value: 'year', label: 'This year' }]} />
      {d ? (
        <>
          <P muted>{`${dateKeyLabel(d.from)} – ${dateKeyLabel(d.to)}`}</P>
          <Row wrap>
            <Stat label="Taken in" value={money(d.revenue.totalCents)} />
            <Stat label="of which tips" value={money(d.revenue.tipsCents)} />
            <Stat label="of which sales tax" value={money(d.revenue.taxCents)} />
            <Stat label="Prepaid, not used yet" value={money(d.credits.cents)} tone={d.credits.cents ? 'warn' : undefined} />
          </Row>
          <Grid>
            <Card>
              <H2>By day</H2>
              {byDay.length <= 62 ? <Bars values={byDay.map((x) => x.cents)} labels={byDay.map((x) => x.day)} max={dayMax} format={money} /> : null}
              {dayMax ? <P small muted>{`Best day: ${dateKeyLabel(byDay.find((x) => x.cents === dayMax)!.day)}, ${money(dayMax)}`}</P> : <Empty text="Nothing taken in yet." />}
            </Card>
            <Card>
              <H2>By service</H2>
              {d.revenue.byService.length === 0 ? <Empty text="Nothing yet." /> : null}
              {d.revenue.byService.map((s) => (
                <Line key={s.service} left={SERVICE[s.service] ?? s.service} right={`${money(s.cents)} · ${d.revenue.totalCents ? Math.round((s.cents / d.revenue.totalCents) * 100) : 0}%`} />
              ))}
            </Card>
            <Card>
              <H2>Boarding, next 14 nights</H2>
              <Bars values={d.occupancy.map((x) => x.booked)} labels={d.occupancy.map((x) => x.night)} max={occMax} format={(n) => `${n} of ${occMax} kennels`} />
              <P small muted>
                {`Busiest: ${(() => {
                  const top = [...d.occupancy].sort((a, b) => b.booked - a.booked)[0]!;
                  return `${dateKeyLabel(top.night)}, ${top.booked} of ${top.kennels} kennels`;
                })()}`}
              </P>
            </Card>
            <Card>
              <H2>Top clients</H2>
              {d.topClients.length === 0 ? <Empty text="No payments in this range." /> : null}
              {d.topClients.map((c, i) => (
                <Line key={c.ownerId} left={`${i + 1}. ${c.name}`} right={money(c.cents)} />
              ))}
            </Card>
            <Card>
              <H2>Prepaid credits still owed</H2>
              <P small muted>Money already paid for days, nights and extras not used yet. Gifted credits count as $0.</P>
              {d.credits.byKind.map((k) => (
                <Line key={k.kind} left={`${k.credits} ${k.kind} credit${k.credits === 1 ? '' : 's'}`} right={money(k.cents)} />
              ))}
            </Card>
            <Card>
              <H2>Staff hours</H2>
              {d.staffHours.length === 0 ? <Empty text="No one clocked in." /> : null}
              {d.staffHours.map((h) => (
                <Line key={h.userId} left={h.name} right={`${h.hours} h · ${h.shifts} shift${h.shifts === 1 ? '' : 's'}`} />
              ))}
            </Card>
          </Grid>
          {can.export ? (
          <Card>
            <H2>Export to a spreadsheet</H2>
            <P small muted>CSV files for Excel, Google Sheets or your accountant, for the dates above.</P>
            <Row wrap>
              {EXPORTS.map((e) => (
                <Button
                  key={e.kind}
                  small
                  title={e.label}
                  onPress={async () => {
                    const f = await attempt(() => api.get<{ filename: string; csv: string }>(`/reports/export?kind=${e.kind}&from=${from}&to=${today}`));
                    if (f) await download(f.filename, f.csv);
                  }}
                />
              ))}
            </Row>
          </Card>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}
