import { useState } from 'react';
import { View } from 'react-native';
import { dateKeyLabel, time, todayKey, type CalendarEvent } from '@dawgs/client';
import { Button, Card, Chip, Empty, H2, P, Row, Screen, Segmented, useLoad, useTheme } from '@dawgs/ui';
import { api, useSession } from '../../lib/session';

const TONE: Record<string, 'ok' | 'info' | 'warn' | 'bad' | ''> = { daycare: 'ok', boarding: 'info', walk: 'warn', training: 'bad', shift: '' };
const LABEL: Record<string, string> = { daycare: 'Daycare', boarding: 'Boarding', walk: 'Walk', training: 'Training', shift: 'Shift' };

function addDays(key: string, n: number) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}

function localKey(iso: string, tz: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

/** Everything on one calendar: daycare, boarding, walks, training, shifts. */
export default function CalendarScreen() {
  const t = useTheme();
  const { business } = useSession();
  const tz = business?.timezone ?? 'America/New_York';
  const [start, setStart] = useState(todayKey(tz));
  const [span, setSpan] = useState<'1' | '7' | '31'>('7');
  const [show, setShow] = useState<Record<string, boolean>>({ daycare: true, boarding: true, walk: true, training: true, shift: true });
  const end = addDays(start, Number(span) - 1);
  const cal = useLoad(() => api.get<{ events: CalendarEvent[] }>(`/calendar?from=${start}&to=${end}`), [start, end]);

  const days = Array.from({ length: Number(span) }, (_, i) => addDays(start, i));
  const on = (e: CalendarEvent, day: string) => {
    if (e.date) return e.date === day;
    if (e.start && e.end) return e.start <= day && day < e.end;
    if (e.startsAt) return localKey(e.startsAt, tz) === day;
    return false;
  };
  return (
    <Screen refreshing={cal.loading && !!cal.data}>
      <Row between wrap>
        <Row>
          <Button small title="‹" onPress={() => setStart(addDays(start, -Number(span)))} />
          <Button small title="Today" onPress={() => setStart(todayKey(tz))} />
          <Button small title="›" onPress={() => setStart(addDays(start, Number(span)))} />
          <P bold>
            {dateKeyLabel(start)}
            {span !== '1' ? ` – ${dateKeyLabel(end)}` : ''}
          </P>
        </Row>
        <Segmented value={span} onChange={setSpan} options={[{ value: '1', label: 'Day' }, { value: '7', label: 'Week' }, { value: '31', label: 'Month' }]} />
      </Row>
      <Row wrap gap={6}>
        {Object.keys(LABEL).map((k) => (
          <Button key={k} small variant={show[k] ? 'primary' : 'secondary'} title={LABEL[k]!} onPress={() => setShow((s) => ({ ...s, [k]: !s[k] }))} />
        ))}
      </Row>
      {cal.error ? <Empty text={cal.error} /> : null}
      {days.map((day) => {
        const items = (cal.data?.events ?? []).filter((e) => show[e.type] && on(e, day));
        if (span === '31' && items.length === 0) return null;
        return (
          <View key={day} style={{ gap: 6 }}>
            <H2>{dateKeyLabel(day)}</H2>
            {items.length === 0 ? <P muted small>Nothing scheduled.</P> : null}
            <Card style={{ gap: 6 }}>
              {items
                .sort((a, b) => (a.startsAt ?? '').localeCompare(b.startsAt ?? ''))
                .map((e) => (
                  <Row key={`${e.type}-${e.id}`} between>
                    <Row style={{ flex: 1 }}>
                      <Chip text={LABEL[e.type]!} tone={TONE[e.type]} />
                      <P numberOfLines={1} style={{ flex: 1, color: e.status === 'requested' ? t.warn : t.text }}>
                        {e.title}
                      </P>
                    </Row>
                    <P small muted>
                      {e.startsAt ? `${time(e.startsAt, tz)}${e.endsAt ? `–${time(e.endsAt, tz)}` : ''}` : e.start ? (e.start === day ? 'arrives' : e.end && addDays(day, 1) === e.end ? 'last night' : 'staying') : ''}
                    </P>
                  </Row>
                ))}
            </Card>
          </View>
        );
      })}
    </Screen>
  );
}
