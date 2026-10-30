import { useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { money } from '@dawgs/client';
import { Button, Card, Divider, H1, Line, Notice, P, Pick, Screen } from '@dawgs/ui';
import { api } from '../../lib/session';

interface PayPage {
  business: string;
  brandColor: string;
  number: number;
  lines: { text: string; amount: number; kind: string }[];
  totalCents: number;
  dueCents: number;
  status: string;
  dueDate: string | null;
  memo: string | null;
  mode: 'simulated' | 'test' | 'live';
  publishableKey: string | null;
  stripeAccount: string | null;
  clientSecret: string | null;
  paymentIntentId: string | null;
}

type StripeJs = {
  elements(o: { clientSecret: string; appearance?: object }): { create(t: 'payment'): { mount(el: string): void } };
  confirmPayment(o: { elements: unknown; redirect: 'if_required'; confirmParams?: object }): Promise<{ error?: { message?: string }; paymentIntent?: { status: string } }>;
};

/** Stripe.js is loaded only on this page, straight from Stripe, as Stripe requires. */
function loadStripe(): Promise<(key: string, o: { stripeAccount?: string }) => StripeJs> {
  const w = window as unknown as { Stripe?: (key: string, o: { stripeAccount?: string }) => StripeJs };
  if (w.Stripe) return Promise.resolve(w.Stripe);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://js.stripe.com/v3/';
    s.onload = () => (w.Stripe ? resolve(w.Stripe) : reject(new Error('Stripe did not load')));
    s.onerror = () => reject(new Error('Could not reach Stripe'));
    document.head.appendChild(s);
  });
}

/** The page behind a texted or emailed pay link. No account needed. */
export default function PayLink() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const [page, setPage] = useState<PayPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [testCard, setTestCard] = useState<string | null>('pm_card_visa');
  const stripe = useRef<{ s: StripeJs; elements: unknown } | null>(null);

  useEffect(() => {
    api
      .get<PayPage>(`/pay/${token}`)
      .then(setPage)
      .catch(() => setError('This link has expired or was already used. Ask the daycare for a new one.'));
  }, [token]);

  useEffect(() => {
    if (!page?.clientSecret || page.mode === 'simulated' || Platform.OS !== 'web' || !page.publishableKey) return;
    loadStripe()
      .then((Stripe) => {
        const s = Stripe(page.publishableKey!, page.stripeAccount ? { stripeAccount: page.stripeAccount } : {});
        const elements = s.elements({ clientSecret: page.clientSecret!, appearance: { variables: { colorPrimary: page.brandColor } } });
        elements.create('payment').mount('#stripe-payment');
        stripe.current = { s, elements };
      })
      .catch((e: Error) => setError(e.message));
  }, [page]);

  if (error) return <Screen><Notice tone="bad" text={error} /></Screen>;
  if (!page) return <Screen><P muted>Loading…</P></Screen>;
  const paid = done || page.status === 'paid' || page.dueCents === 0;

  return (
    <Screen>
      <Stack.Screen options={{ title: `${page.business} · invoice #${page.number}` }} />
      <View style={{ width: '100%', maxWidth: 520, alignSelf: 'center', gap: 12 }}>
        <H1>{page.business}</H1>
        <P muted>
          Invoice #{page.number}
          {page.dueDate && !paid ? ` · due ${page.dueDate}` : ''}
        </P>
        <Card>
          {page.lines.map((l, i) => (
            <Line key={i} left={l.text} right={money(l.amount)} muted={l.kind === 'credit'} />
          ))}
          <Divider />
          <Line left={paid ? 'Paid' : 'Amount due'} right={money(paid ? page.totalCents : page.dueCents)} bold />
        </Card>
        {page.memo ? <P>{page.memo}</P> : null}
        {paid ? (
          <Notice tone="ok" text="Paid. Thank you! A receipt is in your Dawgs app." />
        ) : page.mode === 'simulated' ? (
          <Card>
            <Notice tone="warn" text="Demo mode: pick a test card. No money moves." />
            <Pick value={testCard} onChange={setTestCard} options={[{ value: 'pm_card_visa', label: 'Visa 4242 (works)' }, { value: 'pm_card_chargeDeclined', label: 'A card that is declined' }]} />
            <Button
              variant="primary"
              title={`Pay ${money(page.dueCents)}`}
              onPress={async () => {
                try {
                  const r = await api.post<{ paid: boolean; message?: string }>(`/pay/${token}/simulate`, { paymentIntentId: page.paymentIntentId, testCard });
                  if (r.paid) setDone(true);
                  else setError(r.message ?? 'Your card was declined.');
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            />
          </Card>
        ) : Platform.OS === 'web' ? (
          <Card>
            <View nativeID="stripe-payment" style={{ minHeight: 200 }} />
            <Button
              variant="primary"
              title={`Pay ${money(page.dueCents)}`}
              onPress={async () => {
                if (!stripe.current) return;
                const r = await stripe.current.s.confirmPayment({ elements: stripe.current.elements, redirect: 'if_required' });
                if (r.error) return setError(r.error.message ?? 'Payment failed');
                if (r.paymentIntent?.status === 'succeeded' || r.paymentIntent?.status === 'processing') setDone(true);
              }}
            />
            <P small muted>Payments are processed by Stripe for {page.business}.</P>
          </Card>
        ) : (
          <Notice tone="info" text="Open this link in your browser to pay." />
        )}
      </View>
    </Screen>
  );
}
