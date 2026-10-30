import { Stack } from 'expo-router';
import { day, time } from '@dawgs/client';
import { Card, P, Screen, useLoad } from '@dawgs/ui';
import { api, useSession } from '../lib/session';

export default function LogScreen() {
  const { business } = useSession();
  const tz = business?.timezone;
  const log = useLoad(() => api.get<{ id: string; at: string; actor: string; action: string; detail: string }[]>('/log'), []);
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Activity log' }} />
      <Card>
        {log.data?.map((r) => (
          <P key={r.id} small>
            <P small muted>
              {day(r.at, tz)} {time(r.at, tz)} · {r.actor}:{' '}
            </P>
            {r.detail}
          </P>
        ))}
      </Card>
    </Screen>
  );
}
