import { useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import { Stack } from 'expo-router';
import { dateKeyLabel, todayKey, type BookingAddOn } from '@dawgs/client';
import { Button, Card, Chip, Empty, H2, P, Row, Screen, Segmented, useLoad } from '@dawgs/ui';
import { api, useSession } from '../lib/session';
import { attempt } from '../lib/alert';

type Item = BookingAddOn & { dog: string; dogId: string; owner: string; phone: string | null; bookingStatus: string };

const STATUS: Record<Item['status'], { text: string; tone: 'ok' | 'warn' | 'info' | '' }> = {
  scheduled: { text: 'To do', tone: '' },
  on_way: { text: 'On the way', tone: 'info' },
  done: { text: 'Done', tone: 'ok' },
  cancelled: { text: 'Cancelled', tone: '' },
};

/** The day's pickups, drop-offs and booked services, in time order, for whoever is driving or grooming. */
export default function RunSheet() {
  const { business } = useSession();
  const tz = business?.timezone ?? 'America/New_York';
  const [offset, setOffset] = useState<'0' | '1'>('0');
  const date = todayKey(tz, Number(offset));
  const sheet = useLoad(() => api.get<{ date: string; transport: Item[]; services: Item[] }>(`/run-sheet?date=${date}`), [date], 30_000);
  const move = async (id: string, status: 'on_way' | 'done' | 'scheduled') => {
    if (await attempt(() => api.post(`/booking-add-ons/${id}/status`, { status }))) void sheet.reload();
  };
  const map = (address: string) =>
    void Linking.openURL(Platform.OS === 'ios' ? `maps://?q=${encodeURIComponent(address)}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`);

  const row = (i: Item) => (
    <Card key={i.id}>
      <Row between>
        <View style={{ flex: 1 }}>
          <P bold>{`${i.time ?? 'Any time'} · ${i.dog}`}</P>
          <P small muted>{`${i.name}${i.quantity > 1 ? ` × ${i.quantity}` : ''} · ${i.owner}`}</P>
          {i.address ? <P small>{i.address}</P> : null}
          {i.notes ? <P small muted>{`Note: ${i.notes}`}</P> : null}
        </View>
        <Chip text={STATUS[i.status].text} tone={STATUS[i.status].tone} />
      </Row>
      <Row wrap>
        {i.address ? <Button small title="Map" onPress={() => map(i.address!)} /> : null}
        {i.phone ? <Button small title="Call" onPress={() => void Linking.openURL(`tel:${i.phone}`)} /> : null}
        {i.kind !== 'extra' && i.status === 'scheduled' ? <Button small title="On the way" onPress={() => move(i.id, 'on_way')} /> : null}
        {i.status !== 'done' ? (
          <Button small variant="primary" title={i.kind === 'pickup' ? 'Picked up' : i.kind === 'dropoff' ? 'Dropped off' : 'Done'} onPress={() => move(i.id, 'done')} />
        ) : (
          <Button small variant="ghost" title="Undo" onPress={() => move(i.id, 'scheduled')} />
        )}
      </Row>
    </Card>
  );

  return (
    <Screen refreshing={sheet.loading}>
      <Stack.Screen options={{ title: 'Run sheet' }} />
      <Segmented value={offset} onChange={setOffset} options={[{ value: '0', label: 'Today' }, { value: '1', label: 'Tomorrow' }]} />
      <P muted>{dateKeyLabel(date)}</P>
      <H2>Pickups and drop-offs</H2>
      {sheet.data?.transport.length === 0 ? <Empty text="No transport booked." /> : null}
      {sheet.data?.transport.map(row)}
      <H2>Services</H2>
      {sheet.data?.services.length === 0 ? <Empty text="No add-on services booked." /> : null}
      {sheet.data?.services.map(row)}
      <P small muted>Clients get a notification when you tap "On the way", "Picked up" and "Dropped off".</P>
    </Screen>
  );
}
