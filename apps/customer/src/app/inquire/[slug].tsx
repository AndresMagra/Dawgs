import { useState } from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import type { Business } from '@dawgs/client';
import { Button, Card, Field, H1, Notice, P, Row, Screen, ThemeProvider, useLoad } from '@dawgs/ui';
import { api } from '../../lib/session';

const INTERESTS = [
  { key: 'daycare', label: 'Daycare' },
  { key: 'boarding', label: 'Boarding' },
  { key: 'training', label: 'Training' },
  { key: 'grooming', label: 'Grooming' },
  { key: 'walks', label: 'Walks' },
];

/** The daycare's public "ask us anything" form. Each message becomes a lead on the desk. */
export default function Inquire() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const biz = useLoad(() => api.get<Business>(`/public/daycares/${encodeURIComponent(slug ?? '')}`), [slug]);
  const [f, setF] = useState<Record<string, string>>({});
  const [interest, setInterest] = useState<string[]>([]);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string) => (v: string) => setF((s) => ({ ...s, [k]: v }));
  const b = biz.data;
  const reachable = !!f.email?.trim() || !!f.phone?.trim();

  return (
    <ThemeProvider brand={b?.brandColor}>
      <Screen>
        <Stack.Screen options={{ title: b ? `Contact ${b.name}` : 'Contact us' }} />
        <View style={{ maxWidth: 560, width: '100%', alignSelf: 'center', gap: 12 }}>
          {biz.error ? <Notice tone="bad" text="We couldn't find this daycare. Check the link and try again." /> : null}
          {b ? (
            <>
              <H1>{b.name}</H1>
              <P muted>{[b.address, b.phone].filter(Boolean).join(' · ')}</P>
              {sent ? (
                <Card>
                  <P bold>Thanks! We got your message.</P>
                  <P muted>{`Someone from ${b.name} will get back to you soon.${b.phone ? ` If it can't wait, call us at ${b.phone}.` : ''}`}</P>
                </Card>
              ) : (
                <Card>
                  <P>Tell us about you and your dog, and we'll be in touch.</P>
                  <Field label="Your name" value={f.name ?? ''} onChangeText={set('name')} autoComplete="name" />
                  <Field label="Email" value={f.email ?? ''} onChangeText={set('email')} keyboardType="email-address" autoCapitalize="none" autoComplete="email" />
                  <Field label="Mobile" value={f.phone ?? ''} onChangeText={set('phone')} keyboardType="phone-pad" autoComplete="tel" hint="An email or a phone number, so we can reply." />
                  <Field label="Dog's name" value={f.dogName ?? ''} onChangeText={set('dogName')} />
                  <Field label="Breed" value={f.dogBreed ?? ''} onChangeText={set('dogBreed')} />
                  <P small muted>Interested in</P>
                  <Row wrap>
                    {INTERESTS.map((i) => (
                      <Button
                        key={i.key}
                        small
                        title={i.label}
                        variant={interest.includes(i.key) ? 'primary' : 'secondary'}
                        onPress={() => setInterest((v) => (v.includes(i.key) ? v.filter((x) => x !== i.key) : [...v, i.key]))}
                      />
                    ))}
                  </Row>
                  <Field label="Message" value={f.message ?? ''} onChangeText={set('message')} multiline placeholder="Questions, dates you have in mind, anything we should know" />
                  {error ? <Notice tone="bad" text={error} /> : null}
                  <Button
                    variant="primary"
                    title="Send"
                    disabled={!f.name?.trim() || !reachable}
                    onPress={async () => {
                      setError(null);
                      try {
                        await api.post(`/public/daycares/${encodeURIComponent(slug ?? '')}/inquiry`, {
                          name: f.name!.trim(),
                          email: f.email?.trim() || null,
                          phone: f.phone?.trim() || null,
                          dogName: f.dogName?.trim() || null,
                          dogBreed: f.dogBreed?.trim() || null,
                          message: f.message?.trim() || null,
                          interest,
                        });
                        setSent(true);
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  />
                </Card>
              )}
            </>
          ) : null}
        </View>
      </Screen>
    </ThemeProvider>
  );
}
