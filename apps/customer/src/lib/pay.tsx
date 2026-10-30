import { useState } from 'react';
import { router } from 'expo-router';
import type { Card, PayOutcome } from '@dawgs/client';
import { Button, Notice, Pick } from '@dawgs/ui';
import { attempt, say } from './alert';

/**
 * Pay with a saved card. The server charges the daycare's own Stripe account;
 * a decline leaves the invoice open with the reason shown here.
 */
export function PayWithCard({ cards, label, run, onPaid }: { cards: Card[]; label: string; run: (paymentMethodId: string | undefined) => Promise<PayOutcome>; onPaid: (r: PayOutcome) => void }) {
  const [cardId, setCardId] = useState<string | null>(cards.find((c) => c.isDefault)?.id ?? cards[0]?.id ?? null);
  const [declined, setDeclined] = useState<string | null>(null);
  if (!cards.length) return <Button variant="primary" title="Add a card to pay" onPress={() => router.push('/cards')} />;
  return (
    <>
      {cards.length > 1 ? <Pick label="Card" value={cardId} onChange={setCardId} options={cards.map((c) => ({ value: c.id, label: `${c.brand} •••• ${c.last4}` }))} /> : null}
      {declined ? <Notice tone="bad" text={`Your card was declined: ${declined}. Try another card.`} /> : null}
      <Button
        variant="primary"
        title={label}
        onPress={async () => {
          setDeclined(null);
          const r = await attempt(() => run(cardId ?? undefined));
          if (!r) return;
          if (r.declined) return setDeclined(r.declined.message);
          if (!r.paid) return say('Payment pending', 'We will let you know when it goes through.');
          onPaid(r);
        }}
      />
    </>
  );
}
