import { useEffect, useState } from 'react';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { Button, Notice, Screen } from '@dawgs/ui';
import { api } from '../lib/session';

/** Stripe sends the manager back here after they approve the connection. */
export default function StripeReturn() {
  const { code, state, error_description } = useLocalSearchParams<{ code?: string; state?: string; error_description?: string }>();
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad' | 'info'; text: string }>({ tone: 'info', text: 'Connecting your Stripe account…' });
  useEffect(() => {
    if (error_description) return setMsg({ tone: 'bad', text: error_description });
    if (!code || !state) return setMsg({ tone: 'bad', text: 'Stripe did not send a code back. Try connecting again.' });
    api
      .post('/settings/stripe/finish', { code, state })
      .then(() => setMsg({ tone: 'ok', text: 'Stripe is connected. You can take cards now.' }))
      .catch((e: Error) => setMsg({ tone: 'bad', text: e.message }));
  }, [code, state, error_description]);
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Stripe' }} />
      <Notice tone={msg.tone} text={msg.text} />
      <Button title="Back to settings" onPress={() => router.replace('/settings')} />
    </Screen>
  );
}
