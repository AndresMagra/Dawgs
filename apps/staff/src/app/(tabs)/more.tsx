import { router } from 'expo-router';
import { Avatar, Button, Card, Chip, Grid, H2, P, Row, Screen, useLoad } from '@dawgs/ui';
import type { ChatChannel } from '@dawgs/client';
import { api, useSession } from '../../lib/session';

const ITEMS: { href: string; title: string; text: string; manager?: boolean }[] = [
  { href: '/owners', title: 'Owners', text: 'Clients, cards, invoices, forms' },
  { href: '/training', title: 'Training', text: 'Classes, private lessons, progress' },
  { href: '/packages', title: 'Packs & memberships', text: 'Prepaid credits and monthly plans' },
  { href: '/chat', title: 'Team chat', text: 'The whole team and direct messages' },
  { href: '/team', title: 'Team', text: 'Clock in, schedule, time off, payroll' },
  { href: '/waivers', title: 'Waivers & forms', text: 'What owners sign, and who signed' },
  { href: '/texts', title: 'Texts', text: 'Every text sent and received' },
  { href: '/money', title: 'Money', text: 'Income, expenses, budgets, retail stock', manager: true },
  { href: '/settings', title: 'Settings', text: 'Prices, hours, yards, Stripe, Twilio', manager: true },
  { href: '/log', title: 'Activity log', text: 'Who did what, and when', manager: true },
];

export default function MoreScreen() {
  const { user, business, isManager, signOut } = useSession();
  const chat = useLoad(() => api.get<ChatChannel[]>('/chat'), [], 30_000);
  const unread = (chat.data ?? []).reduce((s, c) => s + c.unread, 0);
  return (
    <Screen>
      <Card>
        <Row>
          <Avatar name={user?.name ?? '?'} />
          <P bold>
            {user?.name} · {business?.name}
          </P>
        </Row>
        <P small muted>{isManager ? 'Manager' : 'Staff'}</P>
      </Card>
      <Grid min={240}>
        {ITEMS.filter((i) => !i.manager || isManager).map((i) => (
          <Card key={i.href} onPress={() => router.push(i.href as never)}>
            <Row between>
              <H2>{i.title}</H2>
              {i.href === '/chat' && unread ? <Chip text={String(unread)} tone="bad" /> : null}
            </Row>
            <P small muted>{i.text}</P>
          </Card>
        ))}
      </Grid>
      <Button variant="ghost" title="Sign out" onPress={() => void signOut()} />
    </Screen>
  );
}
