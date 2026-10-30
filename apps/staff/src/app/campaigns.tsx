import { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import { day, money } from '@dawgs/client';
import { Button, Card, Chip, Empty, Field, H2, Line, Notice, P, Pick, Row, Screen, Sheet, useLoad } from '@dawgs/ui';
import { api } from '../lib/session';
import { attempt, confirm, say } from '../lib/alert';

type Audience = 'all' | 'active' | 'lapsed' | 'boarding' | 'members' | 'no_visit_yet';
type Channel = 'sms' | 'email' | 'both';
type Campaign = {
  id: string;
  name: string;
  audience: Audience;
  channel: Channel;
  subject: string | null;
  body: string;
  recipients: number;
  delivered: number;
  skipped: number;
  sentBy: string;
  sentAt: string;
  results: { bookings: number; clientsWhoBooked: number; revenueCents: number };
};
type Preview = { count: number; optedOut: number; withPhone: number; withEmail: number; sample: string[] };

const AUDIENCES: { value: Audience; label: string }[] = [
  { value: 'all', label: 'Every client' },
  { value: 'active', label: 'Came in the last 60 days' },
  { value: 'lapsed', label: "Haven't been in 60+ days" },
  { value: 'no_visit_yet', label: 'Signed up, never came' },
  { value: 'boarding', label: 'Have boarded before' },
  { value: 'members', label: 'Members' },
];
const CHANNELS: { value: Channel; label: string }[] = [
  { value: 'sms', label: 'Text' },
  { value: 'email', label: 'Email' },
  { value: 'both', label: 'Text and email' },
];

/** Text or email a group of clients, then see who booked in the two weeks after. */
export default function Campaigns() {
  const list = useLoad(() => api.get<Campaign[]>('/campaigns'), []);
  const [open, setOpen] = useState(false);
  return (
    <Screen refreshing={list.loading}>
      <Stack.Screen options={{ title: 'Campaigns' }} />
      <Button variant="primary" title="New campaign" onPress={() => setOpen(true)} />
      <H2>Sent</H2>
      {list.data?.length === 0 ? <Empty text="No campaigns yet. Try a note to clients who haven't been in for a while." /> : null}
      {list.data?.map((c) => (
        <Card key={c.id}>
          <Row between>
            <P bold>{c.name}</P>
            <Chip text={CHANNELS.find((x) => x.value === c.channel)!.label} />
          </Row>
          <P small muted>{`${AUDIENCES.find((a) => a.value === c.audience)!.label} · ${day(c.sentAt)} · by ${c.sentBy}`}</P>
          <P small numberOfLines={2}>{c.body}</P>
          <Line left="Reached" right={`${c.delivered} of ${c.recipients}`} />
          <Line left="Booked within 2 weeks" right={`${c.results.clientsWhoBooked} client${c.results.clientsWhoBooked === 1 ? '' : 's'} · ${c.results.bookings} booking${c.results.bookings === 1 ? '' : 's'}`} bold />
          <Line left="Paid within 2 weeks" right={money(c.results.revenueCents)} />
        </Card>
      ))}
      <NewCampaign visible={open} onClose={() => setOpen(false)} onSent={() => (setOpen(false), void list.reload())} />
    </Screen>
  );
}

function NewCampaign({ visible, onClose, onSent }: { visible: boolean; onClose: () => void; onSent: () => void }) {
  const [name, setName] = useState('');
  const [audience, setAudience] = useState<Audience>('lapsed');
  const [channel, setChannel] = useState<Channel>('sms');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  useEffect(() => {
    if (!visible) return;
    setPreview(null);
    void api.get<Preview>(`/campaigns/audience?audience=${audience}`).then(setPreview, () => undefined);
  }, [audience, visible]);
  const reach = !preview ? null : channel === 'sms' ? preview.withPhone : channel === 'email' ? preview.withEmail : preview.count;
  const ready = name.trim() && body.trim() && (channel === 'sms' || subject.trim()) && (reach ?? 0) > 0;

  return (
    <Sheet visible={visible} onClose={onClose} title="New campaign">
      <Field label="Name (only you see it)" value={name} onChangeText={setName} placeholder="Fall bath special" />
      <Pick label="Who" value={audience} options={AUDIENCES} onChange={setAudience} />
      {preview ? (
        <P small muted>
          {`${preview.count} client${preview.count === 1 ? '' : 's'}${preview.sample.length ? ` (${preview.sample.join(', ')}${preview.count > preview.sample.length ? '…' : ''})` : ''} · ${preview.withPhone} can get texts · ${preview.withEmail} have email${preview.optedOut ? ` · ${preview.optedOut} opted out` : ''}`}
        </P>
      ) : null}
      <Pick label="How" value={channel} options={CHANNELS} onChange={setChannel} />
      {channel !== 'sms' ? <Field label="Email subject" value={subject} onChangeText={setSubject} /> : null}
      <Field label="Message" value={body} onChangeText={setBody} multiline placeholder="We miss Biscuit! Book a day this week and the bath is on us." />
      <P small muted>Texts end with "Reply STOP to opt out." Emails include your address and how to unsubscribe. Clients who opted out are skipped.</P>
      {reach === 0 ? <Notice tone="warn" text="Nobody in this group can be reached that way." /> : null}
      <Button
        variant="primary"
        title={reach ? `Send to ${reach}` : 'Send'}
        disabled={!ready}
        onPress={async () => {
          if (!(await confirm('Send now?', `This goes out to ${reach} client${reach === 1 ? '' : 's'} right away.`))) return;
          const c = await attempt(() => api.post<{ delivered: number; skipped: number }>('/campaigns', { name: name.trim(), audience, channel, subject: channel === 'sms' ? null : subject.trim(), body: body.trim() }));
          if (!c) return;
          say('Sent', `${c.delivered} reached${c.skipped ? `, ${c.skipped} couldn't be reached` : ''}.`);
          setName('');
          setBody('');
          setSubject('');
          onSent();
        }}
      />
    </Sheet>
  );
}
