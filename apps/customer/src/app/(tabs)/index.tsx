import { View } from 'react-native';
import { router } from 'expo-router';
import { creditsText, dateKeyLabel, money, time, type Booking, type Invoice, type ReportCard, type Walk } from '@dawgs/client';
import { Avatar, Button, Card, Chip, Chips, Empty, Grid, H1, H2, Notice, P, Row, Screen, useLoad } from '@dawgs/ui';
import { api, useSession } from '../../lib/session';
import { useMe } from '../../lib/me';

export default function Home() {
  const { user, business } = useSession();
  const tz = business?.timezone;
  const me = useMe();
  const bookings = useLoad(() => api.get<Booking[]>('/me/bookings'), []);
  const invoices = useLoad(() => api.get<Invoice[]>('/me/invoices'), []);
  const walks = useLoad(() => api.get<Walk[]>('/me/walks'), [], 20_000);
  const m = me.data;
  const upcoming = (bookings.data ?? []).filter((b) => ['requested', 'confirmed', 'waitlist', 'checked_in'].includes(b.status)).slice(0, 4);
  const unpaid = (invoices.data ?? []).filter((i) => i.status === 'open');
  const liveWalk = (walks.data ?? []).find((w) => w.status === 'in_progress');
  const name = (dogId: string) => m?.dogs.find((d) => d.id === dogId)?.name ?? '';

  return (
    <Screen refreshing={me.loading && !!m}>
      <H1>Hi {user?.name.split(' ')[0]}</H1>
      <P muted>{business?.name}</P>
      {m && m.formsToSign > 0 ? (
        <Card onPress={() => router.push('/forms')} style={{ borderColor: '#dc2626', borderWidth: 2 }}>
          <P bold>Please sign {m.formsToSign === 1 ? 'a form' : `${m.formsToSign} forms`}</P>
          <P small muted>Your dogs can't be booked until these are signed.</P>
        </Card>
      ) : null}
      {liveWalk ? (
        <Card onPress={() => router.push(`/walk/${liveWalk.id}`)} style={{ borderColor: '#16a34a', borderWidth: 2 }}>
          <P bold>{name(liveWalk.dogId)} is on a walk right now</P>
          <P small muted>Tap to follow along on the map.</P>
        </Card>
      ) : null}
      {unpaid.length ? (
        <Card onPress={() => router.push(unpaid.length === 1 ? `/invoice/${unpaid[0]!.id}` : '/invoices')}>
          <Row between>
            <P bold>
              {unpaid.length === 1 ? `Invoice #${unpaid[0]!.number}` : `${unpaid.length} invoices`} to pay
            </P>
            <P bold>{money(unpaid.reduce((s, i) => s + i.totalCents, 0))}</P>
          </Row>
          {unpaid.some((i) => i.dueDate) ? <P small muted>Due {unpaid.map((i) => i.dueDate).filter(Boolean).sort()[0]}</P> : null}
        </Card>
      ) : null}

      <H2 right={<Button small title="Add a dog" onPress={() => router.push('/dog/new')} />}>Your dogs</H2>
      {m?.dogs.length === 0 ? <Empty text="Add your dog to get started." /> : null}
      <Grid min={260}>
        {m?.dogs.map((d) => (
          <Card key={d.id} onPress={() => router.push(`/dog/${d.id}`)}>
            <Row>
              <Avatar name={d.name} color={d.color} />
              <View style={{ flex: 1 }}>
                <P bold>{d.name}</P>
                <P small muted>{creditsText(d.wallet) || 'No credits'}</P>
              </View>
            </Row>
            <Chips
              items={[
                ...(d.vaccineState === 'expired' || d.vaccineState === 'missing' ? [{ tone: 'bad' as const, text: 'Vaccines needed' }] : d.vaccineState === 'due_soon' ? [{ tone: 'warn' as const, text: 'Vaccine due soon' }] : []),
                ...(d.vaccinesAwaitingReview ? [{ tone: 'info' as const, text: 'Vaccines being checked' }] : []),
              ]}
            />
          </Card>
        ))}
      </Grid>

      <H2 right={<Button small variant="primary" title="Book" onPress={() => router.push('/book')} />}>Coming up</H2>
      {upcoming.length === 0 ? <Empty text="Nothing booked." /> : null}
      {upcoming.map((b) => (
        <Card key={b.id}>
          <Row between>
            <P>
              {name(b.dogId)} · {b.service === 'boarding' ? `boarding ${dateKeyLabel(b.arrive!)} → ${dateKeyLabel(b.depart!)}` : `${b.plan} day ${dateKeyLabel(b.date!)}`}
            </P>
            <Chip text={b.status === 'requested' ? 'Waiting for the daycare' : b.status === 'waitlist' ? 'Waitlist' : b.status === 'checked_in' ? 'There now' : 'Confirmed'} tone={b.status === 'confirmed' || b.status === 'checked_in' ? 'ok' : 'warn'} />
          </Row>
        </Card>
      ))}
      {(walks.data ?? []).filter((w) => w.status === 'scheduled' || w.status === 'requested').slice(0, 3).map((w) => (
        <Card key={w.id} onPress={() => router.push(`/walk/${w.id}`)}>
          <P>
            {name(w.dogId)} · walk {dateKeyLabel(new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(w.scheduledAt)))} at {time(w.scheduledAt, tz)}
          </P>
        </Card>
      ))}
      {!m && me.error ? <Notice tone="bad" text={me.error} /> : null}
    </Screen>
  );
}
