import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import * as Location from 'expo-location';
import { duration, miles, money, time, type GpsPoint, type Walk } from '@dawgs/client';
import { Button, Card, Field, H1, Line, Notice, P, RouteMap, Row, Screen, Stat, Toggle, useLoad, useNow } from '@dawgs/ui';
import { api, useSession } from '../../lib/session';
import { attempt, say } from '../../lib/alert';

/**
 * Runs a walk: the phone's GPS is read while this screen is open and points are
 * sent in batches, so the owner's app can follow the walk live. Points that
 * can't be sent (no signal) are kept and sent with the next batch.
 */
export default function WalkScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { business, user } = useSession();
  const tz = business?.timezone;
  const now = useNow();
  const w = useLoad(() => api.get<{ walk: Walk; track: GpsPoint[] }>(`/walks/${id}`), [id]);
  const [track, setTrack] = useState<GpsPoint[]>([]);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [pee, setPee] = useState(false);
  const [poop, setPoop] = useState(false);
  const [report, setReport] = useState('');
  const pending = useRef<GpsPoint[]>([]);
  const walk = w.data?.walk;
  const running = walk?.status === 'in_progress';

  useEffect(() => {
    if (w.data) setTrack(w.data.track);
  }, [w.data]);

  useEffect(() => {
    if (!running || walk?.walkerId !== user?.id) return;
    let sub: Location.LocationSubscription | null = null;
    let stopped = false;
    void (async () => {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') {
        setGpsError('Location is off for Dawgs. Turn it on so the owner can follow the walk.');
        return;
      }
      sub = await Location.watchPositionAsync({ accuracy: Location.Accuracy.High, distanceInterval: 8, timeInterval: 5000 }, (pos) => {
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude, at: Math.round(pos.timestamp), accuracy: pos.coords.accuracy ?? null };
        pending.current.push(p);
        setTrack((t) => [...t, p]);
      });
      if (stopped) sub.remove();
    })();
    const flush = setInterval(() => void send(), 15_000);
    return () => {
      stopped = true;
      sub?.remove();
      clearInterval(flush);
      void send();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, walk?.walkerId, user?.id]);

  async function send() {
    if (!pending.current.length) return;
    const batch = pending.current.splice(0, 500);
    try {
      await api.post(`/walks/${id}/points`, { points: batch });
    } catch {
      pending.current.unshift(...batch);
    }
  }

  if (!walk) return <Screen><P muted>Loading…</P></Screen>;
  const startedMs = walk.startedAt ? Date.parse(walk.startedAt) : null;
  const dist = track.reduce((m, p, i) => (i ? m + meters(track[i - 1]!, p) : 0), 0);

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Walk' }} />
      <H1>{walk.status === 'done' ? 'Walk report' : running ? 'Walking now' : `Walk at ${time(walk.scheduledAt, tz)}`}</H1>
      {gpsError ? <Notice tone="warn" text={gpsError} /> : null}
      {running ? <Notice tone="info" text={Platform.OS === 'web' ? 'Keep this page open while walking.' : 'Keep Dawgs open on this screen while walking.'} /> : null}
      <Row wrap>
        <Stat label="Time" value={walk.status === 'done' ? duration(walk.durationMs ?? 0) : startedMs ? duration(now - startedMs) : '–'} />
        <Stat label="Distance" value={miles(walk.status === 'done' ? walk.meters : dist)} />
        <Stat label="Price" value={money(walk.priceCents)} />
      </Row>
      {track.length > 1 ? <RouteMap points={track} height={260} /> : <Card><P muted>{running ? 'Waiting for the first GPS fix…' : 'No route recorded.'}</P></Card>}

      {walk.status === 'scheduled' || walk.status === 'requested' ? (
        <Button
          variant="primary"
          title="Start walk"
          onPress={async () => {
            if (await attempt(() => api.post(`/walks/${id}/start`, {}))) void w.reload();
          }}
        />
      ) : null}

      {running ? (
        <Card>
          <Toggle label="Pee" value={pee} onChange={setPee} />
          <Toggle label="Poop" value={poop} onChange={setPoop} />
          <Field label="Note for the owner" value={report} onChangeText={setReport} multiline style={{ minHeight: 80, textAlignVertical: 'top' }} />
          <Button
            variant="primary"
            title="Finish walk and send report"
            onPress={async () => {
              await send();
              if (await attempt(() => api.post(`/walks/${id}/finish`, { pee, poop, report: report.trim() || null }))) {
                say('Walk finished', 'The owner got the report.');
                void w.reload();
              }
            }}
          />
        </Card>
      ) : null}

      {walk.status === 'done' ? (
        <Card>
          <Line left="Pee" right={walk.pee ? 'Yes' : 'No'} />
          <Line left="Poop" right={walk.poop ? 'Yes' : 'No'} />
          {walk.report ? <P>{walk.report}</P> : null}
        </Card>
      ) : null}
    </Screen>
  );
}

function meters(a: GpsPoint, b: GpsPoint) {
  const R = 6371000;
  const r = (x: number) => (x * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
