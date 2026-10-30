import { useEffect, useRef, useState } from 'react';
import { Stack, useLocalSearchParams } from 'expo-router';
import { duration, miles, money, time, type GpsPoint, type Walk } from '@dawgs/client';
import { Button, Card, H1, Line, Notice, P, RouteMap, Row, Screen, Stat, useNow } from '@dawgs/ui';
import { api, useSession } from '../../lib/session';
import { attempt } from '../../lib/alert';

/** Follows a walk live: polls only the new GPS points every few seconds while it runs. */
export default function WalkLive() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { business } = useSession();
  const now = useNow();
  const [walk, setWalk] = useState<Walk | null>(null);
  const [track, setTrack] = useState<GpsPoint[]>([]);
  const last = useRef<number | undefined>(undefined);

  useEffect(() => {
    let stop = false;
    async function poll() {
      try {
        const r = await api.get<{ walk: Walk; track: GpsPoint[] }>(`/me/walks/${id}${last.current ? `?since=${last.current + 1}` : ''}`);
        if (stop) return;
        setWalk(r.walk);
        if (r.track.length) {
          last.current = r.track[r.track.length - 1]!.at;
          setTrack((t) => [...t, ...r.track]);
        }
        if (r.walk.status === 'in_progress' || r.walk.status === 'scheduled') setTimeout(poll, r.walk.status === 'in_progress' ? 5000 : 30_000);
      } catch {
        if (!stop) setTimeout(poll, 10_000);
      }
    }
    void poll();
    return () => {
      stop = true;
    };
  }, [id]);

  if (!walk) return <Screen><P muted>Loading…</P></Screen>;
  const tz = business?.timezone;
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Walk' }} />
      <H1>{walk.status === 'in_progress' ? 'On a walk now' : walk.status === 'done' ? 'Walk report' : `Walk at ${time(walk.scheduledAt, tz)}`}</H1>
      {walk.status === 'requested' ? <Notice tone="warn" text="Waiting for the daycare to confirm a walker." /> : null}
      <Row wrap>
        <Stat label="Time" value={walk.status === 'done' ? duration(walk.durationMs ?? 0) : walk.startedAt ? duration(now - Date.parse(walk.startedAt)) : '–'} />
        <Stat label="Distance" value={miles(walk.meters ?? null)} />
        <Stat label="Price" value={money(walk.priceCents)} />
      </Row>
      {track.length > 1 ? <RouteMap points={track} height={300} /> : walk.status === 'in_progress' ? <Card><P muted>Waiting for the walker's GPS…</P></Card> : null}
      {walk.status === 'done' ? (
        <Card>
          <Line left="Pee" right={walk.pee ? 'Yes' : 'No'} />
          <Line left="Poop" right={walk.poop ? 'Yes' : 'No'} />
          {walk.report ? <P>{walk.report}</P> : null}
        </Card>
      ) : null}
      {walk.status === 'requested' || walk.status === 'scheduled' ? (
        <Button variant="ghost" title="Cancel walk" onPress={async () => (await attempt(() => api.post(`/me/walks/${id}/cancel`, {}))) && setWalk({ ...walk, status: 'cancelled' })} />
      ) : null}
    </Screen>
  );
}
