import { useState } from 'react';
import { View } from 'react-native';
import { creditsText, day, money, time, todayKey, type Membership, type Package, type TrainingProgram, type TrainingSession } from '@dawgs/client';
import { Button, Card, Chip, Empty, Field, H2, P, Pick, Row, Screen, Segmented, Sheet, useLoad } from '@dawgs/ui';
import { api, useSession } from '../../lib/session';
import { attempt, confirm, say } from '../../lib/alert';
import { useMe } from '../../lib/me';
import { PayWithCard } from '../../lib/pay';

interface Training {
  programs: TrainingProgram[];
  enrollments: { id: string; programId: string; dogId: string; status: string }[];
  mySessions: TrainingSession[];
}

export default function Shop() {
  const { business } = useSession();
  const tz = business?.timezone ?? 'America/New_York';
  const me = useMe();
  const [tab, setTab] = useState<'packs' | 'training'>('packs');
  const packs = useLoad(() => api.get<Package[]>('/me/packages'), []);
  const members = useLoad(() => api.get<(Membership & { credits: Record<string, number> })[]>('/me/memberships'), []);
  const training = useLoad(() => api.get<Training>('/me/training'), []);
  const [buying, setBuying] = useState<{ kind: 'pack'; p: Package } | { kind: 'class' | 'private'; p: TrainingProgram } | null>(null);
  const dogs = me.data?.dogs ?? [];
  const name = (id: string) => dogs.find((d) => d.id === id)?.name ?? '';
  const reload = () => {
    setBuying(null);
    void me.reload();
    void members.reload();
    void training.reload();
  };

  return (
    <Screen>
      <Segmented value={tab} onChange={setTab} options={[{ value: 'packs', label: 'Packs & memberships' }, { value: 'training', label: 'Training' }]} />
      {tab === 'packs' ? (
        <>
          <P muted>Prepaid days, nights and walks cost less and are used automatically.</P>
          {packs.data?.length === 0 ? <Empty text="Nothing for sale right now." /> : null}
          {packs.data?.map((p) => (
            <Card key={p.id}>
              <Row between>
                <View style={{ flex: 1 }}>
                  <P bold>{p.name}</P>
                  <P small muted>
                    {creditsText(p.credits)}
                    {p.expiresDays ? ` · use within ${p.expiresDays} days` : ''}
                    {p.recurring ? ' · renews monthly, cancel any time' : ''}
                  </P>
                </View>
                {p.badge ? <Chip text={p.badge} tone="info" /> : null}
              </Row>
              <Button variant="primary" title={`${p.recurring ? 'Join' : 'Buy'} · ${money(p.priceCents)}${p.recurring ? '/month' : ''}`} onPress={() => setBuying({ kind: 'pack', p })} />
            </Card>
          ))}
          {members.data?.length ? <H2>Your memberships</H2> : null}
          {members.data?.map((m) => (
            <Card key={m.id}>
              <Row between>
                <P bold>
                  {name(m.dogId)} · {m.packageName}
                </P>
                <Chip text={m.status === 'past_due' ? 'Card problem' : m.status} tone={m.status === 'active' ? 'ok' : m.status === 'past_due' ? 'bad' : ''} />
              </Row>
              <P small muted>
                {money(m.priceCents ?? 0)}/month · {m.status === 'active' ? `renews ${day(m.currentPeriodEnd, tz)}` : m.status === 'past_due' ? 'Your card was declined. Update it under Account, then we retry automatically.' : 'Cancelled'}
              </P>
              {m.status !== 'cancelled' ? (
                <Button small variant="ghost" title="Cancel membership" onPress={async () => (await confirm('Cancel membership?', 'No more monthly charges. Credits you have stay until used.')) && (await attempt(() => api.post(`/me/memberships/${m.id}/cancel`, {}))) && reload()} />
              ) : null}
            </Card>
          ))}
        </>
      ) : (
        <>
          {training.data?.mySessions.length ? <H2>Your upcoming sessions</H2> : null}
          {training.data?.mySessions.map((s) => (
            <Card key={s.id}>
              <P>
                {training.data!.programs.find((p) => p.id === s.programId)?.name ?? 'Training'} · {day(s.startsAt, tz)} {time(s.startsAt, tz)}
                {s.location ? ` · ${s.location}` : ''}
              </P>
            </Card>
          ))}
          <H2>Classes and lessons</H2>
          {training.data?.programs.length === 0 ? <Empty text="No classes open right now." /> : null}
          {training.data?.programs.map((p) => {
            const enrolled = training.data!.enrollments.filter((e) => e.programId === p.id);
            return (
              <Card key={p.id}>
                <P bold>{p.name}</P>
                {p.description ? <P small>{p.description}</P> : null}
                <P small muted>
                  {p.kind === 'class' ? `${p.sessionCount} weekly sessions · ${p.spotsLeft} spots left` : `${p.sessionMinutes}-minute private lesson`} · {money(p.priceCents)}
                </P>
                {p.kind === 'class' && p.nextSessions?.length ? <P small muted>Starts {day(p.nextSessions[0]!.startsAt, tz)} at {time(p.nextSessions[0]!.startsAt, tz)}</P> : null}
                {p.skills.length ? <P small muted>Covers: {p.skills.join(', ')}</P> : null}
                {enrolled.map((e) => (
                  <Chip key={e.id} text={`${name(e.dogId)}: ${e.status === 'pending_payment' ? 'awaiting payment' : 'enrolled'}`} tone="ok" />
                ))}
                <Button variant="primary" title={p.kind === 'class' ? 'Enroll' : 'Book a lesson'} disabled={p.kind === 'class' && p.spotsLeft === 0} onPress={() => setBuying({ kind: p.kind, p })} />
              </Card>
            );
          })}
        </>
      )}
      {buying && me.data ? <BuySheet item={buying} tz={tz} onClose={() => setBuying(null)} onDone={reload} /> : null}
    </Screen>
  );

  function BuySheet({ item, tz, onClose, onDone }: { item: NonNullable<typeof buying>; tz: string; onClose: () => void; onDone: () => void }) {
    const [dogId, setDogId] = useState<string | null>(dogs[0]?.id ?? null);
    const [date, setDate] = useState(todayKey(tz, 2));
    const [at, setAt] = useState<string | null>('10:00');
    const dog = dogs.find((d) => d.id === dogId);
    const price = item.p.priceCents;
    const usesCredit = item.kind === 'private' && (dog?.wallet.training ?? 0) > 0;
    const startsAt = () => {
      const guess = Date.parse(`${date}T${at}:00Z`);
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess));
      const g = (k: string) => Number(parts.find((x) => x.type === k)?.value);
      return guess - (Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute')) - guess);
    };
    return (
      <Sheet visible onClose={onClose} title={item.p.name}>
        <Pick label="For" value={dogId} onChange={setDogId} options={dogs.map((d) => ({ value: d.id, label: d.name }))} />
        {item.kind === 'private' ? (
          <>
            <Field label="Day (YYYY-MM-DD)" value={date} onChangeText={setDate} />
            <Pick label="Time" value={at} onChange={setAt} options={['09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00', '17:00'].map((h) => ({ value: h, label: h }))} />
            {usesCredit ? <P small muted>Uses 1 of {dog!.wallet.training} lesson credits; nothing to pay.</P> : null}
          </>
        ) : null}
        <PayWithCard
          cards={me.data!.cards}
          label={usesCredit ? 'Book with a credit' : `Pay ${money(price)}`}
          run={(paymentMethodId) => {
            const pm = paymentMethodId ? { paymentMethodId } : {};
            if (item.kind === 'pack') return api.post(`/me/packages/${item.p.id}/buy`, { dogId, ...pm });
            if (item.kind === 'class') return api.post(`/me/training/${item.p.id}/enroll`, { dogId, ...pm });
            return api.post(`/me/training/${item.p.id}/private`, { dogId, startsAt: startsAt(), ...pm });
          }}
          onPaid={() => {
            say('All set', item.kind === 'pack' ? 'Your credits are ready to use.' : item.kind === 'class' ? `${dog?.name} is enrolled.` : 'Your lesson is booked.');
            onDone();
          }}
        />
      </Sheet>
    );
  }
}
