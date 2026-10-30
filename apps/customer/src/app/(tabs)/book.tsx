import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { dateKeyLabel, money, todayKey, type Booking } from '@dawgs/client';
import { Button, Card, Chip, Empty, Field, H2, Notice, P, Pick, Row, Screen, Segmented, Toggle, useLoad } from '@dawgs/ui';
import { api, useSession } from '../../lib/session';
import { attempt, confirm, say } from '../../lib/alert';
import { useMe } from '../../lib/me';

type Avail = { available?: boolean; nights?: number; freeKennels?: { id: string; name: string; type: string; estimateCents: number }[] };

const STATUS: Record<string, { text: string; tone: 'ok' | 'warn' | 'bad' | 'info' | '' }> = {
  requested: { text: 'Waiting for the daycare', tone: 'warn' },
  confirmed: { text: 'Confirmed', tone: 'ok' },
  waitlist: { text: 'Waitlist', tone: 'info' },
  checked_in: { text: 'There now', tone: 'ok' },
  checked_out: { text: 'Done', tone: '' },
  cancelled: { text: 'Cancelled', tone: '' },
  declined: { text: 'Declined', tone: 'bad' },
  no_show: { text: 'Missed', tone: 'bad' },
};

export default function Book() {
  const { business } = useSession();
  const tz = business?.timezone ?? 'America/New_York';
  const me = useMe();
  const list = useLoad(() => api.get<Booking[]>('/me/bookings'), []);
  const [dogId, setDogId] = useState<string | null>(null);
  const [service, setService] = useState<'daycare' | 'boarding'>('daycare');
  const [plan, setPlan] = useState<'half' | 'full'>('full');
  const [date, setDate] = useState(todayKey(tz, 1));
  const [arrive, setArrive] = useState(todayKey(tz, 7));
  const [depart, setDepart] = useState(todayKey(tz, 9));
  const [suite, setSuite] = useState(false);
  const [play, setPlay] = useState(true);
  const [pickup, setPickup] = useState<string | null>('17:00');
  const valid = (k: string) => /^\d{4}-\d{2}-\d{2}$/.test(k);
  const avail = useLoad<Avail | null>(
    () =>
      service === 'daycare'
        ? valid(date)
          ? api.get<Avail>(`/me/availability?service=daycare&date=${date}`)
          : Promise.resolve(null)
        : valid(arrive) && valid(depart) && arrive < depart
          ? api.get<Avail>(`/me/availability?service=boarding&arrive=${arrive}&depart=${depart}`)
          : Promise.resolve(null),
    [service, date, arrive, depart],
  );
  const dogs = me.data?.dogs.filter((d) => d.active) ?? [];
  const dog = dogs.find((d) => d.id === (dogId ?? dogs[0]?.id));
  const kennel = avail.data?.freeKennels?.find((k) => (suite ? k.type === 'suite' : k.type === 'run')) ?? avail.data?.freeKennels?.[0];
  const mine = (list.data ?? []).filter((b) => b.status !== 'cancelled').slice().reverse();

  async function book() {
    if (!dog) return;
    const body =
      service === 'daycare'
        ? { dogId: dog.id, service, plan, date, pickupTime: pickup }
        : { dogId: dog.id, service, arrive, depart, kennelId: kennel?.id ?? null, play };
    const r = await attempt(() => api.post<Booking>('/me/bookings', body));
    if (!r) return;
    say(r.status === 'waitlist' ? "You're on the waitlist" : 'Request sent', r.status === 'waitlist' ? "We'll let you know if a spot opens." : 'The daycare will confirm it shortly.');
    void list.reload();
  }

  return (
    <Screen>
      <H2>Book a stay</H2>
      {dogs.length === 0 ? <Empty text="Add a dog first, on the Home tab." /> : null}
      {dogs.length ? (
        <Card>
          {dogs.length > 1 ? <Pick label="Who" value={dog?.id ?? null} onChange={setDogId} options={dogs.map((d) => ({ value: d.id, label: d.name }))} /> : <P bold>{dog?.name}</P>}
          {dog && !dog.canEnter ? (
            <Notice
              tone="bad"
              text={dog.waiversMissing.length ? `Please sign first: ${dog.waiversMissing.join(', ')}` : dog.vaccinesAwaitingReview ? "We're checking the vaccine records you sent. You can book once they're approved." : 'Please upload current vaccine records first.'}
            />
          ) : null}
          {dog && !dog.canEnter ? <Button title={dog.waiversMissing.length ? 'Sign forms' : 'Add vaccine records'} onPress={() => router.push(dog.waiversMissing.length ? '/forms' : `/dog/${dog.id}`)} /> : null}
          <Segmented value={service} onChange={setService} options={[{ value: 'daycare', label: 'Daycare' }, { value: 'boarding', label: 'Boarding' }]} />
          {service === 'daycare' ? (
            <>
              <Field label="Day (YYYY-MM-DD)" value={date} onChangeText={setDate} />
              <Segmented value={plan} onChange={setPlan} options={[{ value: 'full', label: `Full day ${money(business?.prices.fullDay ?? 0)}` }, { value: 'half', label: `Half day ${money(business?.prices.halfDay ?? 0)}` }]} />
              <Pick label="Pickup around" value={pickup} onChange={setPickup} options={['12:00', '15:00', '16:00', '17:00', '18:00'].map((h) => ({ value: h, label: h }))} />
              {avail.data?.available !== undefined ? <Notice tone={avail.data.available ? 'ok' : 'warn'} text={avail.data.available ? 'There is room that day.' : "That day is full. You can join the waitlist."} /> : null}
              {dog?.wallet.daycare ? <P small muted>Uses 1 of your {dog.wallet.daycare} daycare credits.</P> : null}
            </>
          ) : (
            <>
              <Row>
                <View style={{ flex: 1 }}>
                  <Field label="Drop off" value={arrive} onChangeText={setArrive} />
                </View>
                <View style={{ flex: 1 }}>
                  <Field label="Pick up" value={depart} onChangeText={setDepart} />
                </View>
              </Row>
              <Toggle label="Suite (bigger, quieter room)" value={suite} onChange={setSuite} />
              <Toggle label={`Daycare play each day (+${money(business?.prices.boarderPlay ?? 0)}/day)`} value={play} onChange={setPlay} />
              {avail.data?.freeKennels ? (
                kennel ? (
                  <Notice tone="ok" text={`${avail.data.nights} night${avail.data.nights === 1 ? '' : 's'}, about ${money(kennel.estimateCents)} before play and extras.`} />
                ) : (
                  <Notice tone="warn" text="No rooms free for those nights." />
                )
              ) : null}
            </>
          )}
          <Button variant="primary" title={service === 'daycare' && avail.data?.available === false ? 'Join the waitlist' : 'Request booking'} disabled={!dog?.canEnter || (service === 'boarding' && !kennel)} onPress={book} />
        </Card>
      ) : null}

      <H2>Your bookings</H2>
      {mine.length === 0 ? <Empty text="No bookings yet." /> : null}
      {mine.map((b) => (
        <Card key={b.id}>
          <Row between>
            <View style={{ flex: 1 }}>
              <P bold>{me.data?.dogs.find((d) => d.id === b.dogId)?.name}</P>
              <P small muted>{b.service === 'boarding' ? `Boarding ${dateKeyLabel(b.arrive!)} → ${dateKeyLabel(b.depart!)}` : `${b.plan === 'half' ? 'Half' : 'Full'} day ${dateKeyLabel(b.date!)}`}</P>
            </View>
            <Chip {...STATUS[b.status]!} />
          </Row>
          {['requested', 'confirmed', 'waitlist'].includes(b.status) ? (
            <Button small variant="ghost" title="Cancel" onPress={async () => (await confirm('Cancel this booking?', '')) && (await attempt(() => api.post(`/me/bookings/${b.id}/cancel`, {}))) && void list.reload()} />
          ) : null}
        </Card>
      ))}
    </Screen>
  );
}
