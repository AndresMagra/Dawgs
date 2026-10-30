import { useState } from 'react';
import { View } from 'react-native';
import { BOOKING_STATUS, dateKeyLabel, money, todayKey, type AddOn, type AddOnRequest, type Booking, type Dog } from '@dawgs/client';
import { AddOnPicker, WeekdayPicker, weekdayNames, Avatar, Button, Card, Chip, Empty, Field, H2, Notice, P, Pick, Row, Screen, Segmented, Sheet, Toggle, normalizeAddOns, useLoad } from '@dawgs/ui';
import { api, useSession } from '../../lib/session';
import { attempt, confirm, say } from '../../lib/alert';
import { DogPicker } from '../../lib/DogPicker';

export default function BookingsScreen() {
  const { business } = useSession();
  const tz = business?.timezone ?? 'America/New_York';
  const [filter, setFilter] = useState<'all' | 'requests' | 'waitlist'>('all');
  const [adding, setAdding] = useState(false);
  const list = useLoad(() => api.get<{ bookings: Booking[] }>(`/bookings?from=${todayKey(tz)}&to=${todayKey(tz, 30)}`), [tz]);
  const rows = (list.data?.bookings ?? []).filter((b) =>
    filter === 'requests' ? b.status === 'requested' : filter === 'waitlist' ? b.status === 'waitlist' : !['cancelled', 'checked_out'].includes(b.status),
  );
  const byDay = new Map<string, Booking[]>();
  for (const b of rows) {
    const k = (b.date ?? b.arrive)!;
    byDay.set(k, [...(byDay.get(k) ?? []), b]);
  }
  const requests = (list.data?.bookings ?? []).filter((b) => b.status === 'requested').length;

  const { user } = useSession();
  const series = useLoad(() => api.get<{ id: string; dog: string; weekdays: number[]; plan: string; untilDate: string }[]>('/booking-series'), []);
  async function setStatus(id: string, status: string, waiveFee = false) {
    const r = await attempt(() => api.post<{ feeInvoiceId: string | null }>(`/bookings/${id}/status`, { status, ...(waiveFee ? { waiveFee } : {}) }));
    if (!r) return;
    if (r.feeInvoiceId) say('Fee added', `A ${status === 'no_show' ? 'no-show' : 'late-cancel'} fee is now an open invoice on the client's account.`);
    void list.reload();
  }

  return (
    <Screen refreshing={list.loading && !!list.data}>
      <Row between wrap>
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'Next 30 days' },
            { value: 'requests', label: `Requests${requests ? ` (${requests})` : ''}` },
            { value: 'waitlist', label: 'Waitlist' },
          ]}
        />
        <Button variant="primary" title="New booking" onPress={() => setAdding(true)} />
      </Row>
      {series.data?.length ? (
        <Card>
          <H2>Repeating schedules</H2>
          {series.data.map((x) => (
            <Row key={x.id} between>
              <P small>{`${x.dog}: ${weekdayNames(x.weekdays)}, ${x.plan} day, until ${dateKeyLabel(x.untilDate)}`}</P>
              <Button
                small
                variant="ghost"
                title="Stop"
                onPress={async () => {
                  if (!(await confirm(`Stop ${x.dog}'s schedule?`, 'Days from tomorrow on are cancelled. Fees follow your cancellation rules.'))) return;
                  if (await attempt(() => api.post(`/booking-series/${x.id}/stop`, { from: todayKey(tz, 1) }))) {
                    void series.reload();
                    void list.reload();
                  }
                }}
              />
            </Row>
          ))}
        </Card>
      ) : null}
      {rows.length === 0 ? <Empty text="Nothing booked here yet." /> : null}
      {[...byDay.entries()].map(([day, items]) => (
        <View key={day} style={{ gap: 8 }}>
          <H2>{dateKeyLabel(day)}</H2>
          {items.map((b) => (
            <Card key={b.id}>
              <Row>
                <Avatar name={b.dog?.name ?? '?'} color={b.dog?.color} size={34} />
                <View style={{ flex: 1 }}>
                  <P bold>{b.dog?.name}</P>
                  <P small muted>
                    {b.service === 'boarding' ? `Boarding ${dateKeyLabel(b.arrive!)} → ${dateKeyLabel(b.depart!)}${b.play ? ' · with play' : ''}` : `${b.plan} day${b.pickupTime ? ` · pickup ${b.pickupTime}` : ''}`}
                    {b.estimateCents ? ` · est. ${money(b.estimateCents)}` : ''}
                    {b.source === 'owner' ? ' · booked in app' : ''}
                  </P>
                  {b.addOns?.length ? (
                    <P small>{`+ ${b.addOns.map((a) => `${a.name}${a.time ? ` ${a.time}` : ''}${a.quantity > 1 ? ` × ${a.quantity}` : ''}`).join(', ')}`}</P>
                  ) : null}
                </View>
                <Chip text={BOOKING_STATUS[b.status] ?? b.status} tone={b.status === 'requested' ? 'warn' : b.status === 'waitlist' ? 'info' : b.status === 'confirmed' ? 'ok' : ''} />
              </Row>
              <Row wrap>
                {b.status === 'requested' || b.status === 'waitlist' ? <Button small variant="primary" title="Confirm" onPress={() => setStatus(b.id, 'confirmed')} /> : null}
                {b.status === 'requested' ? <Button small title="Decline" onPress={() => setStatus(b.id, 'declined')} /> : null}
                {['requested', 'confirmed', 'waitlist'].includes(b.status) ? <Button small variant="ghost" title="Cancel" onPress={() => setStatus(b.id, 'cancelled')} /> : null}
                {b.status === 'confirmed' && user?.role === 'manager' ? <Button small variant="ghost" title="Cancel, no fee" onPress={() => setStatus(b.id, 'cancelled', true)} /> : null}
                {b.status === 'confirmed' && day < todayKey(tz, 1) ? <Button small variant="ghost" title="No-show" onPress={() => setStatus(b.id, 'no_show')} /> : null}
              </Row>
            </Card>
          ))}
        </View>
      ))}
      <NewBookingSheet
        open={adding}
        tz={tz}
        onClose={() => setAdding(false)}
        onDone={() => {
          setAdding(false);
          void list.reload();
          void series.reload();
        }}
      />
    </Screen>
  );
}

export function NewBookingSheet({ open, tz, onClose, onDone, presetDog }: { open: boolean; tz: string; onClose: () => void; onDone: () => void; presetDog?: Dog }) {
  const [dog, setDog] = useState<Dog | null>(presetDog ?? null);
  const [service, setService] = useState<'daycare' | 'boarding'>('daycare');
  const [plan, setPlan] = useState<'half' | 'full' | 'hourly'>('full');
  const [date, setDate] = useState(todayKey(tz, 1));
  const [arrive, setArrive] = useState(todayKey(tz, 1));
  const [depart, setDepart] = useState(todayKey(tz, 3));
  const [kennelId, setKennelId] = useState<string | null>(null);
  const [play, setPlay] = useState(false);
  const [pickup, setPickup] = useState<string | null>('17:00');
  const [extras, setExtras] = useState<AddOnRequest[]>([]);
  const [repeat, setRepeat] = useState(false);
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [until, setUntil] = useState(todayKey(tz, 56));
  const menu = useLoad(() => api.get<{ addOns: AddOn[] }>('/settings').then((s) => s.addOns), []);
  type Avail = { freeKennels?: { id: string; name: string; type: string; estimateCents: number }[]; spotsLeft?: number; capacity?: number };
  const avail = useLoad<Avail>(
    () =>
      service === 'boarding' && arrive < depart
        ? api.get<Avail>(`/availability?service=boarding&arrive=${arrive}&depart=${depart}`)
        : api.get<Avail>(`/availability?service=daycare&date=${date}`),
    [service, arrive, depart, date],
  );
  const d = avail.data;

  async function save() {
    if (!dog) return;
    if (service === 'daycare' && repeat) {
      const r = await attempt(() =>
        api.post<{ booked: number; waitlisted: number; skipped: { date: string }[] }>('/booking-series', { dogId: dog.id, weekdays, plan, pickupTime: pickup, from: date, until }),
      );
      if (!r) return;
      say(
        `${r.booked} days booked`,
        [r.waitlisted ? `${r.waitlisted} on the waitlist (full).` : '', r.skipped.length ? `Skipped, already booked: ${r.skipped.map((x) => dateKeyLabel(x.date)).join(', ')}.` : ''].filter(Boolean).join(' '),
      );
      setRepeat(false);
      setWeekdays([]);
      if (!presetDog) setDog(null);
      onDone();
      return;
    }
    const body =
      service === 'daycare' ? { dogId: dog.id, service, plan, date, pickupTime: pickup } : { dogId: dog.id, service, arrive, depart, kennelId, play };
    const chosen = normalizeAddOns(extras).filter((x) => menu.data?.find((a) => a.id === x.addOnId)?.services.includes(service));
    if (await attempt(() => api.post('/bookings', { ...body, addOns: chosen }))) {
      if (!presetDog) setDog(null);
      setExtras([]);
      onDone();
    }
  }

  return (
    <Sheet visible={open} onClose={onClose} title="New booking">
      {!dog ? (
        <DogPicker onPick={setDog} />
      ) : (
        <>
          <Row between>
            <P bold>{dog.name}</P>
            {!presetDog ? <Button small variant="ghost" title="Change dog" onPress={() => setDog(null)} /> : null}
          </Row>
          {!dog.canEnter ? <Notice tone="bad" text={dog.waiversMissing.length ? `Owner must sign: ${dog.waiversMissing.join(', ')}` : 'Vaccines are not current.'} /> : null}
          <Pick label="Service" value={service} onChange={setService} options={[{ value: 'daycare', label: 'Daycare' }, { value: 'boarding', label: 'Boarding' }]} />
          {service === 'daycare' ? (
            <>
              <Field label={repeat ? 'Starting (YYYY-MM-DD)' : 'Date (YYYY-MM-DD)'} value={date} onChangeText={setDate} />
              <Toggle label="Repeat every week" value={repeat} onChange={setRepeat} />
              {repeat ? (
                <>
                  <WeekdayPicker value={weekdays} onChange={setWeekdays} />
                  <Field label="Until (YYYY-MM-DD, up to 6 months)" value={until} onChangeText={setUntil} />
                </>
              ) : null}
              <Pick label="Plan" value={plan} onChange={setPlan} options={[{ value: 'half', label: 'Half day' }, { value: 'full', label: 'Full day' }, { value: 'hourly', label: 'Hourly' }]} />
              <Pick label="Pickup around" value={pickup} onChange={setPickup} options={['12:00', '15:00', '16:00', '17:00', '18:00', '19:00'].map((h) => ({ value: h, label: h }))} />
              {d?.spotsLeft !== undefined ? (
                <Notice tone={d.spotsLeft > 0 ? 'ok' : 'warn'} text={d.spotsLeft > 0 ? `${d.spotsLeft} of ${d.capacity} spots left` : 'Full: this goes on the waitlist'} />
              ) : null}
            </>
          ) : (
            <>
              <Row>
                <Field label="Arrive" value={arrive} onChangeText={setArrive} />
                <Field label="Leave" value={depart} onChangeText={setDepart} />
              </Row>
              <Pick
                label="Kennel"
                value={kennelId}
                onChange={setKennelId}
                options={(d?.freeKennels ?? []).map((k) => ({ value: k.id, label: `${k.name} · ${money(k.estimateCents)}` }))}
              />
              {d?.freeKennels && d.freeKennels.length === 0 ? <Notice tone="warn" text="No kennel is free for those nights." /> : null}
              <Toggle label="Daycare play every day" value={play} onChange={setPlay} />
            </>
          )}
          {menu.data?.length ? (
            <>
              <H2>Add-ons</H2>
              <AddOnPicker options={menu.data} service={service} value={extras} onChange={setExtras} defaultAddress={dog.owner.address ?? null} />
            </>
          ) : null}
          <Button variant="primary" title={service === 'daycare' && repeat ? 'Book every week' : 'Book it'} disabled={!dog.canEnter || (service === 'boarding' && !kennelId) || (service === 'daycare' && repeat && !weekdays.length)} onPress={save} />
        </>
      )}
    </Sheet>
  );
}
