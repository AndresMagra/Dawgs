import { useState } from 'react';
import { View } from 'react-native';
import { Stack } from 'expo-router';
import { day, duration, money, time, todayKey, type StaffMember } from '@dawgs/client';
import { Button, Card, Chip, Empty, Field, H2, Line, P, Pick, Row, Screen, Segmented, Sheet, Stat, useLoad, useNow } from '@dawgs/ui';
import { api, useSession } from '../lib/session';
import { attempt, confirm } from '../lib/alert';
import { FormSheet, orNull } from '../lib/sheets';
import { zonedToEpoch } from './(tabs)/walks';

interface Shift {
  id: string;
  userId: string;
  startsAt: string;
  endsAt: string;
}
interface StaffRequest {
  id: string;
  userName: string;
  kind: 'time_off' | 'swap' | 'other';
  fromDate: string | null;
  toDate: string | null;
  hours: number | null;
  note: string | null;
  status: 'pending' | 'approved' | 'denied';
  decidedBy: string | null;
}
interface Payroll {
  rows: { userId: string; name: string; rateCents: number | null; hours: number; regular: number; overtime: number; gross: number; openPunch: boolean }[];
  totalGrossCents: number;
}

function monday(key: string) {
  const d = new Date(`${key}T12:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * 86_400_000).toISOString().slice(0, 10);
}
const plus = (key: string, n: number) => new Date(Date.parse(`${key}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export default function TeamScreen() {
  const { business, user, isManager, can } = useSession();
  const tz = business?.timezone ?? 'America/New_York';
  const now = useNow(30_000);
  const [tab, setTab] = useState<'clock' | 'schedule' | 'requests' | 'team' | 'payroll'>('clock');
  const [week, setWeek] = useState(monday(todayKey(tz)));
  const [sheet, setSheet] = useState<null | 'request' | 'shift' | 'staff' | 'cert'>(null);
  const [editing, setEditing] = useState<StaffMember | null>(null);
  const from = zonedToEpoch(week, '00:00', tz);
  const to = zonedToEpoch(plus(week, 7), '00:00', tz);
  const clock = useLoad(() => api.get<{ onClock: boolean; since: string | null }>('/clock'), []);
  const staff = useLoad(() => api.get<StaffMember[]>('/staff'), []);
  const shifts = useLoad(() => api.get<Shift[]>(`/shifts?from=${from}&to=${to}`), [from, to]);
  const requests = useLoad(() => api.get<StaffRequest[]>('/requests'), []);
  const payroll = useLoad(() => (isManager && tab === 'payroll' ? api.get<Payroll>(`/payroll?weekStart=${week}`) : Promise.resolve(null)), [week, tab, isManager]);
  const nameOf = (id: string) => staff.data?.find((s) => s.id === id)?.name ?? '';
  const pending = (requests.data ?? []).filter((r) => r.status === 'pending').length;

  const weekNav = (
    <Row>
      <Button small title="‹" onPress={() => setWeek(plus(week, -7))} />
      <P bold>Week of {day(`${week}T12:00:00Z`)}</P>
      <Button small title="›" onPress={() => setWeek(plus(week, 7))} />
    </Row>
  );

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Team' }} />
      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: 'clock', label: 'Clock' },
          { value: 'schedule', label: 'Schedule' },
          { value: 'requests', label: `Requests${pending && isManager ? ` (${pending})` : ''}` },
          ...(isManager ? [{ value: 'team' as const, label: 'Staff' }, { value: 'payroll' as const, label: 'Payroll' }] : []),
        ]}
      />

      {tab === 'clock' ? (
        <Card>
          <P bold>{user?.name}</P>
          {clock.data?.onClock ? <Stat label={`On the clock since ${time(clock.data.since!, tz)}`} value={duration(now - Date.parse(clock.data.since!))} tone="ok" /> : <P muted>You are off the clock.</P>}
          <Button
            variant="primary"
            title={clock.data?.onClock ? 'Clock out' : 'Clock in'}
            onPress={async () => {
              if (await attempt(() => api.post(clock.data?.onClock ? '/clock/out' : '/clock/in', {}))) {
                void clock.reload();
                void staff.reload();
              }
            }}
          />
          <H2>Who's on now</H2>
          {(staff.data ?? []).filter((s) => s.onClock).map((s) => (
            <P key={s.id}>{s.name}</P>
          ))}
        </Card>
      ) : null}

      {tab === 'schedule' ? (
        <>
          <Row between wrap>
            {weekNav}
            {can.editSchedule ? <Button variant="primary" title="Add shift" onPress={() => setSheet('shift')} /> : null}
          </Row>
          {Array.from({ length: 7 }, (_, i) => plus(week, i)).map((k) => {
            const list = (shifts.data ?? []).filter((s) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(s.startsAt)) === k);
            return (
              <Card key={k}>
                <P bold>{day(`${k}T12:00:00Z`)}</P>
                {list.length === 0 ? <P small muted>No shifts</P> : null}
                {list.map((s) => (
                  <Row key={s.id} between>
                    <P style={s.userId === user?.id ? { fontWeight: '700' } : undefined}>
                      {nameOf(s.userId)} · {time(s.startsAt, tz)}–{time(s.endsAt, tz)}
                    </P>
                    {can.editSchedule ? <Button small variant="ghost" title="Remove" onPress={async () => (await attempt(() => api.del(`/shifts/${s.id}`))) && void shifts.reload()} /> : null}
                  </Row>
                ))}
              </Card>
            );
          })}
        </>
      ) : null}

      {tab === 'requests' ? (
        <>
          <Button variant="primary" title="Ask for time off or a swap" onPress={() => setSheet('request')} />
          {requests.data?.length === 0 ? <Empty text="No requests." /> : null}
          {requests.data?.map((r) => (
            <Card key={r.id}>
              <Row between>
                <View style={{ flex: 1 }}>
                  <P bold>
                    {r.userName} · {r.kind === 'time_off' ? 'Time off' : r.kind === 'swap' ? 'Shift swap' : 'Other'}
                  </P>
                  <P small muted>
                    {[r.fromDate && r.toDate ? `${r.fromDate} → ${r.toDate}` : r.fromDate, r.hours ? `${r.hours} h` : null, r.note].filter(Boolean).join(' · ')}
                  </P>
                </View>
                <Chip text={r.status} tone={r.status === 'approved' ? 'ok' : r.status === 'denied' ? 'bad' : 'warn'} />
              </Row>
              {isManager && r.status === 'pending' ? (
                <Row>
                  <Button small variant="primary" title="Approve" onPress={async () => (await attempt(() => api.post(`/requests/${r.id}/decide`, { status: 'approved' }))) && void requests.reload()} />
                  <Button small title="Deny" onPress={async () => (await attempt(() => api.post(`/requests/${r.id}/decide`, { status: 'denied' }))) && void requests.reload()} />
                </Row>
              ) : null}
            </Card>
          ))}
        </>
      ) : null}

      {tab === 'team' && isManager ? (
        <>
          <Button variant="primary" title="Add staff member" onPress={() => setSheet('staff')} />
          {staff.data?.map((s) => (
            <Card key={s.id} onPress={() => setEditing(s)}>
              <Row between>
                <View>
                  <P bold>{s.name}</P>
                  <P small muted>
                    {s.jobTitle ?? s.role} · {s.email}
                    {s.payRateCents ? ` · ${money(s.payRateCents)}/h` : ''} · {s.ptoHours ?? 0} h PTO
                  </P>
                  {s.certifications?.map((c) => (
                    <P key={c.id} small muted>
                      ✓ {c.name}
                      {c.expiresOn ? ` (until ${c.expiresOn})` : ''}
                    </P>
                  ))}
                </View>
                <Row>
                  {s.onClock ? <Chip text="On clock" tone="ok" /> : null}
                  {!s.active ? <Chip text="Inactive" /> : null}
                </Row>
              </Row>
            </Card>
          ))}
        </>
      ) : null}

      {tab === 'payroll' && isManager ? (
        <>
          {weekNav}
          <Card>
            {payroll.data?.rows.map((r) => (
              <Line key={r.userId} left={`${r.name}${r.openPunch ? ' (still on clock)' : ''}`} right={`${r.hours.toFixed(2)} h${r.overtime ? ` (${r.overtime.toFixed(2)} OT)` : ''} · ${money(r.gross)}`} />
            ))}
            <Line left="Total gross" right={money(payroll.data?.totalGrossCents ?? 0)} bold />
          </Card>
          <P small muted>Overtime is paid at 1.5× past 40 hours a week. Hand these totals to your payroll provider.</P>
        </>
      ) : null}

      <RequestSheet open={sheet === 'request'} onClose={() => setSheet(null)} onDone={() => (setSheet(null), void requests.reload())} />
      <ShiftSheet open={sheet === 'shift'} tz={tz} staff={staff.data ?? []} onClose={() => setSheet(null)} onDone={() => (setSheet(null), void shifts.reload())} />
      <FormSheet
        open={sheet === 'staff'}
        title="Add staff member"
        fields={[
          { key: 'name', label: 'Name' },
          { key: 'email', label: 'Email (their login)', keyboard: 'email-address' },
          { key: 'phone', label: 'Phone', keyboard: 'phone-pad' },
          { key: 'jobTitle', label: 'Job title' },
          { key: 'rate', label: 'Pay per hour ($)', keyboard: 'numeric' },
          { key: 'password', label: 'Temporary password (10+ characters)' },
        ]}
        onClose={() => setSheet(null)}
        onSave={async (v) => {
          const r = await attempt(() =>
            api.post('/staff', { name: v.name, email: v.email, phone: orNull(v.phone), jobTitle: orNull(v.jobTitle), role: 'staff', payRateCents: v.rate ? Math.round(Number(v.rate) * 100) : null, password: v.password }),
          );
          if (r) {
            setSheet(null);
            void staff.reload();
          }
          return r;
        }}
      />
      <EditStaffSheet member={editing} onClose={() => setEditing(null)} onDone={() => (setEditing(null), void staff.reload())} />
    </Screen>
  );
}

function RequestSheet({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<'time_off' | 'swap' | 'other'>('time_off');
  const [f, setF] = useState({ fromDate: '', toDate: '', hours: '', note: '' });
  return (
    <Sheet visible={open} onClose={onClose} title="New request">
      <Segmented value={kind} onChange={setKind} options={[{ value: 'time_off', label: 'Time off' }, { value: 'swap', label: 'Swap' }, { value: 'other', label: 'Other' }]} />
      <Row>
        <Field label="From (YYYY-MM-DD)" value={f.fromDate} onChangeText={(x) => setF({ ...f, fromDate: x })} />
        <Field label="To" value={f.toDate} onChangeText={(x) => setF({ ...f, toDate: x })} />
      </Row>
      {kind === 'time_off' ? <Field label="PTO hours" value={f.hours} onChangeText={(x) => setF({ ...f, hours: x })} keyboardType="numeric" /> : null}
      <Field label="Note" value={f.note} onChangeText={(x) => setF({ ...f, note: x })} multiline />
      <Button
        variant="primary"
        title="Send to manager"
        onPress={async () => {
          if (await attempt(() => api.post('/requests', { kind, fromDate: orNull(f.fromDate), toDate: orNull(f.toDate), hours: f.hours ? Number(f.hours) : null, note: orNull(f.note) }))) {
            setF({ fromDate: '', toDate: '', hours: '', note: '' });
            onDone();
          }
        }}
      />
    </Sheet>
  );
}

function ShiftSheet({ open, tz, staff, onClose, onDone }: { open: boolean; tz: string; staff: StaffMember[]; onClose: () => void; onDone: () => void }) {
  const [userId, setUserId] = useState<string | null>(null);
  const [date, setDate] = useState(todayKey(tz, 1));
  const [start, setStart] = useState('07:00');
  const [end, setEnd] = useState('15:00');
  return (
    <Sheet visible={open} onClose={onClose} title="Add shift">
      <Pick label="Who" value={userId} onChange={setUserId} options={staff.filter((s) => s.active).map((s) => ({ value: s.id, label: s.name }))} />
      <Field label="Date" value={date} onChangeText={setDate} />
      <Row>
        <Field label="Starts" value={start} onChangeText={setStart} />
        <Field label="Ends" value={end} onChangeText={setEnd} />
      </Row>
      <Button
        variant="primary"
        title="Add"
        disabled={!userId}
        onPress={async () => {
          if (await attempt(() => api.post('/shifts', { userId, startsAt: zonedToEpoch(date, start, tz), endsAt: zonedToEpoch(date, end, tz) }))) onDone();
        }}
      />
    </Sheet>
  );
}

function EditStaffSheet({ member, onClose, onDone }: { member: StaffMember | null; onClose: () => void; onDone: () => void }) {
  const [cert, setCert] = useState({ name: '', expiresOn: '' });
  if (!member) return null;
  const save = async (body: Record<string, unknown>) => (await attempt(() => api.patch(`/staff/${member.id}`, body))) && onDone();
  return (
    <Sheet visible onClose={onClose} title={member.name}>
      <Pick label="Role" value={member.role} onChange={(role) => save({ role })} options={[{ value: 'staff', label: 'Staff' }, { value: 'manager', label: 'Manager' }]} />
      <Button title={member.active ? 'Deactivate (can no longer sign in)' : 'Reactivate'} onPress={async () => (!member.active || (await confirm('Deactivate?', `${member.name} will be signed out.`))) && save({ active: !member.active })} />
      <H2>Certifications</H2>
      {member.certifications?.map((c) => (
        <Row key={c.id} between>
          <P>
            {c.name}
            {c.expiresOn ? ` · until ${c.expiresOn}` : ''}
          </P>
          <Button small variant="ghost" title="Remove" onPress={async () => (await attempt(() => api.del(`/certifications/${c.id}`))) && onDone()} />
        </Row>
      ))}
      <Row>
        <Field label="e.g. Pet CPR" value={cert.name} onChangeText={(x) => setCert({ ...cert, name: x })} />
        <Field label="Expires" value={cert.expiresOn} onChangeText={(x) => setCert({ ...cert, expiresOn: x })} />
      </Row>
      <Button
        title="Add certification"
        disabled={!cert.name.trim()}
        onPress={async () => {
          if (await attempt(() => api.post(`/staff/${member.id}/certifications`, { name: cert.name.trim(), expiresOn: orNull(cert.expiresOn) }))) {
            setCert({ name: '', expiresOn: '' });
            onDone();
          }
        }}
      />
    </Sheet>
  );
}
