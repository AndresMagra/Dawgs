import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { duration, money, time, type Board, type Dog } from '@dawgs/client';
import {
  Avatar,
  Button,
  Card,
  Chips,
  Empty,
  Grid,
  H2,
  P,
  Pick,
  Row,
  Screen,
  Segmented,
  Sheet,
  Stat,
  useLoad,
  useNow,
  useTheme,
} from '@dawgs/ui';
import { api, useSession } from '../../lib/session';
import { attempt } from '../../lib/alert';
import { CheckoutSheet } from '../../lib/CheckoutSheet';
import { DogPicker } from '../../lib/DogPicker';

export default function BoardScreen() {
  const t = useTheme();
  const now = useNow();
  const { business } = useSession();
  const tz = business?.timezone;
  const board = useLoad(() => api.get<Board>('/board'), [], 20_000);
  const [view, setView] = useState<'here' | 'yards' | 'tasks'>('here');
  const [checkout, setCheckout] = useState<{ id: string; name: string; card: string | null } | null>(null);
  const [walkIn, setWalkIn] = useState(false);
  const [moving, setMoving] = useState<{ visitId: string; name: string } | null>(null);
  const b = board.data;

  async function checkIn(args: Record<string, unknown>) {
    const r = await attempt(() => api.post('/visits', args));
    if (r) void board.reload();
    return r;
  }

  const daycare = b?.inBuilding.filter((x) => x.visit.service === 'daycare') ?? [];
  const boarders = b?.inBuilding.filter((x) => x.visit.service === 'boarding') ?? [];
  const tasksDue = b?.tasks.filter((x) => !x.doneAt) ?? [];

  return (
    <Screen refreshing={board.loading && !!b}>
      <Row wrap>
        <Stat label="Here now" value={String(b?.inBuilding.length ?? '–')} />
        <Stat label="Daycare booked today" value={b ? `${b.daycareBooked} / ${b.capacity}` : '–'} />
        <Stat label="Still to arrive" value={String(b?.expected.length ?? '–')} />
        <Stat label="Care tasks due" value={String(tasksDue.length)} tone={tasksDue.length ? 'warn' : undefined} />
      </Row>
      <Row between wrap>
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: 'here', label: 'In the building' },
            { value: 'yards', label: 'Yards & kennels' },
            { value: 'tasks', label: `Tasks${tasksDue.length ? ` (${tasksDue.length})` : ''}` },
          ]}
        />
        <Button variant="primary" title="Walk-in check-in" onPress={() => setWalkIn(true)} />
      </Row>

      {board.error ? <Empty text={board.error} /> : null}

      {view === 'here' && b ? (
        <>
          <H2>Daycare</H2>
          {daycare.length === 0 ? <Empty text="No daycare dogs checked in yet." /> : null}
          <Grid min={300}>
            {daycare.map((x) => {
              const inMs = now - Date.parse(x.visit.checkedInAt);
              return (
                <Card key={x.visit.id} style={x.late ? { borderColor: t.bad, borderWidth: 2 } : undefined}>
                  <Row>
                    <Avatar name={x.dog.name} color={x.dog.color} />
                    <View style={{ flex: 1 }}>
                      <P bold onPress={() => router.push(`/dog/${x.dog.id}`)}>{x.dog.name}</P>
                      <P small muted>
                        {x.visit.plan} day · in {time(x.visit.checkedInAt, tz)}
                        {x.visit.plannedPickupAt ? ` · pickup ${time(x.visit.plannedPickupAt, tz)}` : ''}
                      </P>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <P bold>{duration(inMs)}</P>
                      <P small muted>{money(x.runningTotalCents)}</P>
                    </View>
                  </Row>
                  <Chips items={[...(x.late ? [{ tone: 'bad' as const, text: 'Late pickup' }] : []), ...(x.yard ? [{ tone: 'info' as const, text: x.yard }] : []), ...x.dog.flags]} />
                  <Row wrap>
                    <Button small title="Move yard" onPress={() => setMoving({ visitId: x.visit.id, name: x.dog.name })} />
                    <Button small variant="primary" title="Check out" onPress={() => setCheckout({ id: x.visit.id, name: x.dog.name, card: x.dog.card ? `${x.dog.card.brand} ${x.dog.card.last4}` : null })} />
                  </Row>
                </Card>
              );
            })}
          </Grid>

          <H2>Boarding</H2>
          {boarders.length === 0 ? <Empty text="No boarders right now." /> : null}
          <Grid min={300}>
            {boarders.map((x) => (
              <Card key={x.visit.id}>
                <Row>
                  <Avatar name={x.dog.name} color={x.dog.color} />
                  <View style={{ flex: 1 }}>
                    <P bold onPress={() => router.push(`/dog/${x.dog.id}`)}>{x.dog.name}</P>
                    <P small muted>
                      {x.kennel} · goes home {x.visit.departDate}
                    </P>
                  </View>
                  <P bold>{money(x.runningTotalCents)}</P>
                </Row>
                <Chips items={[...(x.goesHomeToday ? [{ tone: 'warn' as const, text: `Goes home today by ${business?.hours.checkoutBy}` }] : []), ...x.dog.flags]} />
                <Button small variant="primary" title="Check out" onPress={() => setCheckout({ id: x.visit.id, name: x.dog.name, card: x.dog.card ? `${x.dog.card.brand} ${x.dog.card.last4}` : null })} />
              </Card>
            ))}
          </Grid>

          <H2>Still to arrive</H2>
          {b.expected.length === 0 ? <Empty text="Everyone booked for today is here." /> : null}
          <Grid min={300}>
            {b.expected.map(({ booking, dog }) => (
              <Card key={booking.id}>
                <Row>
                  <Avatar name={dog.name} color={dog.color} />
                  <View style={{ flex: 1 }}>
                    <P bold>{dog.name}</P>
                    <P small muted>
                      {booking.service === 'boarding' ? `Boarding until ${booking.depart}` : `${booking.plan} day`} · {booking.status}
                    </P>
                  </View>
                </Row>
                {!dog.canEnter ? <Chips items={[{ tone: 'bad', text: dog.waiversMissing.length ? `Needs: ${dog.waiversMissing.join(', ')}` : 'Vaccines not current' }]} /> : null}
                <Button small variant="primary" title="Check in" disabled={!dog.canEnter} onPress={() => checkIn({ bookingId: booking.id })} />
              </Card>
            ))}
          </Grid>
        </>
      ) : null}

      {view === 'yards' && b ? (
        <Grid min={220}>
          {[
            ...b.yards.map((y) => (
              <Card key={y.id}>
                <P bold>{y.name}</P>
                <P muted small>{y.note}</P>
                <P style={{ fontSize: 22, fontWeight: '700', color: (y.count ?? 0) >= y.capacity ? t.bad : t.text }}>
                  {y.count} / {y.capacity}
                </P>
              </Card>
            )),
            ...b.kennels.map((k) => {
              const dog = b.inBuilding.find((x) => x.visit.kennelId === k.id)?.dog;
              return (
                <Card key={k.id}>
                  <P bold>{k.name}</P>
                  <P muted small>{k.type === 'suite' ? 'Suite' : 'Run'}</P>
                  <P>{dog ? dog.name : 'Empty'}</P>
                </Card>
              );
            }),
          ]}
        </Grid>
      ) : null}

      {view === 'tasks' && b ? (
        <>
          {b.tasks.length === 0 ? <Empty text="No care tasks today." /> : null}
          {b.tasks.map((task) => (
            <Card key={task.id}>
              <Row between>
                <View style={{ flex: 1 }}>
                  <P bold style={task.doneAt ? { textDecorationLine: 'line-through', color: t.muted } : undefined}>{task.title}</P>
                  <P small muted>
                    Due {time(task.dueAt, tz)}
                    {task.doneBy ? ` · done by ${task.doneBy}` : ''}
                  </P>
                </View>
                <Button
                  small
                  variant={task.doneAt ? 'secondary' : 'primary'}
                  title={task.doneAt ? 'Undo' : 'Done'}
                  onPress={async () => {
                    await attempt(() => api.post(`/tasks/${task.id}/done`, { done: !task.doneAt }));
                    void board.reload();
                  }}
                />
              </Row>
            </Card>
          ))}
        </>
      ) : null}

      <CheckoutSheet
        visitId={checkout?.id ?? null}
        dogName={checkout?.name ?? ''}
        card={checkout?.card ?? null}
        onClose={() => setCheckout(null)}
        onDone={() => {
          setCheckout(null);
          void board.reload();
        }}
      />
      <WalkInSheet
        open={walkIn}
        yards={b?.yards ?? []}
        onClose={() => setWalkIn(false)}
        onCheckIn={async (args) => {
          if (await checkIn(args)) setWalkIn(false);
        }}
      />
      <Sheet visible={!!moving} onClose={() => setMoving(null)} title={`Move ${moving?.name ?? ''}`}>
        <Pick
          value={null}
          options={(b?.yards ?? []).map((y) => ({ value: y.id, label: `${y.name} (${y.count}/${y.capacity})`, disabled: (y.count ?? 0) >= y.capacity }))}
          onChange={async (yardId) => {
            if (!moving) return;
            if (await attempt(() => api.patch(`/visits/${moving.visitId}`, { yardId }))) {
              setMoving(null);
              void board.reload();
            }
          }}
        />
      </Sheet>
    </Screen>
  );
}

function WalkInSheet({ open, yards, onClose, onCheckIn }: { open: boolean; yards: Board['yards']; onClose: () => void; onCheckIn: (args: Record<string, unknown>) => Promise<void> }) {
  const [dog, setDog] = useState<Dog | null>(null);
  const [plan, setPlan] = useState<'half' | 'full' | 'hourly'>('full');
  const [yardId, setYardId] = useState<string | null>(null);
  const [pickup, setPickup] = useState<string | null>('17:00');
  return (
    <Sheet
      visible={open}
      onClose={() => {
        setDog(null);
        onClose();
      }}
      title="Walk-in check-in"
    >
      {!dog ? (
        <DogPicker onPick={setDog} />
      ) : (
        <>
          <P bold>{dog.name}</P>
          <Pick label="Plan" value={plan} onChange={setPlan} options={[{ value: 'half', label: 'Half day' }, { value: 'full', label: 'Full day' }, { value: 'hourly', label: 'Hourly' }]} />
          <Pick label="Yard" value={yardId} onChange={setYardId} options={yards.map((y) => ({ value: y.id, label: `${y.name} (${y.count}/${y.capacity})` }))} />
          <Pick label="Pickup around" value={pickup} onChange={setPickup} options={['12:00', '15:00', '16:00', '17:00', '18:00', '19:00'].map((h) => ({ value: h, label: h }))} />
          <Row>
            <Button title="Back" onPress={() => setDog(null)} />
            <Button
              variant="primary"
              title="Check in"
              onPress={async () => {
                await onCheckIn({ dogId: dog.id, service: 'daycare', plan, yardId, pickupTime: pickup });
                setDog(null);
              }}
            />
          </Row>
        </>
      )}
    </Sheet>
  );
}
