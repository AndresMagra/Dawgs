import { useState } from 'react';
import { Stack } from 'expo-router';
import { Button, Card, Chip, Empty, Notice, P, Pick, Row, Screen } from '@dawgs/ui';
import { api } from '../lib/session';
import { attempt, confirm } from '../lib/alert';
import { useMe } from '../lib/me';

const TEST_CARDS = [
  { value: 'pm_card_visa', label: 'Visa ending 4242' },
  { value: 'pm_card_mastercard', label: 'Mastercard ending 4444' },
  { value: 'pm_card_amex', label: 'Amex ending 8431' },
  { value: 'pm_card_chargeDeclined', label: 'A card that will be declined' },
];

export default function Cards() {
  const me = useMe();
  const [mode, setMode] = useState<string | null>(null);
  const [testCard, setTestCard] = useState<string | null>('pm_card_visa');
  const cards = me.data?.cards ?? [];
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Payment cards' }} />
      {cards.length === 0 ? <Empty text="No cards saved yet." /> : null}
      {cards.map((c) => (
        <Card key={c.id}>
          <Row between>
            <P bold>
              {c.brand} •••• {c.last4} · {c.expMonth}/{c.expYear}
            </P>
            <Row>
              {c.isDefault ? <Chip text="Default" tone="ok" /> : <Button small title="Make default" onPress={async () => (await attempt(() => api.post(`/me/cards/${c.id}/default`, {}))) && void me.reload()} />}
              <Button small variant="ghost" title="Remove" onPress={async () => (await confirm('Remove card?', `${c.brand} ${c.last4}`)) && (await attempt(() => api.del(`/me/cards/${c.id}`))) && void me.reload()} />
            </Row>
          </Row>
        </Card>
      ))}
      {mode === null ? (
        <Button
          variant="primary"
          title="Add a card"
          onPress={async () => {
            const s = await attempt(() => api.post<{ mode: string }>('/me/cards/setup', {}));
            if (s) setMode(s.mode);
          }}
        />
      ) : mode === 'simulated' ? (
        <Card>
          <Notice tone="warn" text="This is a demo: the daycare hasn't connected Stripe, so pick a test card. No money moves." />
          <Pick value={testCard} onChange={setTestCard} options={TEST_CARDS} />
          <Button
            variant="primary"
            title="Save card"
            onPress={async () => {
              if (await attempt(() => api.post('/me/cards', { testCard }))) {
                setMode(null);
                void me.reload();
              }
            }}
          />
        </Card>
      ) : (
        <Notice tone="info" text="Card entry on Stripe's secure form comes with the App Store and Play Store builds." />
      )}
      <P small muted>Cards are stored by Stripe on the daycare's own account. Dawgs never sees your card number.</P>
    </Screen>
  );
}
