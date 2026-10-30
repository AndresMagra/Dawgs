import { Stack } from 'expo-router';
import { dateKeyLabel, time, type CalendarEvent } from '@dawgs/client';
import { Card, Chip, Empty, P, Row, Screen, useLoad } from '@dawgs/ui';
import { api, useSession } from '../lib/session';

const LABEL: Record<string, string> = { daycare: 'Daycare', boarding: 'Boarding', walk: 'Walk', training: 'Training' };

export default function Calendar() {
  const { business } = useSession();
  const tz = business?.timezone;
  const cal = useLoad(() => api.get<{ events: CalendarEvent[] }>('/me/calendar'), []);
  const key = (e: CalendarEvent) => e.date ?? e.start ?? (e.startsAt ? new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(e.startsAt)) : '');
  const events = (cal.data?.events ?? []).filter((e) => !['cancelled', 'declined'].includes(e.status ?? '')).sort((a, b) => key(a).localeCompare(key(b)));
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Calendar' }} />
      {cal.data && events.length === 0 ? <Empty text="Nothing in the next month." /> : null}
      {events.map((e) => (
        <Card key={`${e.type}-${e.id}`}>
          <Row between>
            <P>
              <P bold>{dateKeyLabel(key(e))}</P> {e.title}
              {e.startsAt ? ` · ${time(e.startsAt, tz)}` : ''}
              {e.end ? ` → ${dateKeyLabel(e.end)}` : ''}
            </P>
            <Chip text={LABEL[e.type] ?? e.type} tone={e.type === 'boarding' ? 'info' : e.type === 'training' ? 'warn' : 'ok'} />
          </Row>
        </Card>
      ))}
    </Screen>
  );
}
