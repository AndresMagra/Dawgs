import { useState } from 'react';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { day, time, type Waiver } from '@dawgs/client';
import { Button, Card, Field, H1, Notice, P, Screen, SignaturePad, Toggle, useLoad } from '@dawgs/ui';
import { api, useSession } from '../../lib/session';
import { attempt, say } from '../../lib/alert';
import { useMe } from '../../lib/me';

/** Read and sign one form. The server keeps the exact text signed, with its fingerprint. */
export default function SignForm() {
  const { id, dog } = useLocalSearchParams<{ id: string; dog?: string }>();
  const { user } = useSession();
  const me = useMe();
  const d = useLoad(() => api.get<{ waiver: Waiver; signatures: { id: string; version: number; signedName: string; signedAt: string; dogId: string | null }[] }>(`/me/waivers/${id}`), [id]);
  const [name, setName] = useState(user?.name ?? '');
  const [sig, setSig] = useState<string | null>(null);
  const [agree, setAgree] = useState(false);
  const w = d.data?.waiver;
  if (!w) return <Screen><P muted>Loading…</P></Screen>;
  const dogName = me.data?.dogs.find((x) => x.id === dog)?.name;
  const current = d.data!.signatures.find((s) => s.version === w.version && (s.dogId ?? undefined) === (dog ?? undefined));
  return (
    <Screen>
      <Stack.Screen options={{ title: w.title }} />
      <H1>
        {w.title}
        {dogName ? ` · ${dogName}` : ''}
      </H1>
      <P small muted>Version {w.version}</P>
      <Card>
        <P>{w.body}</P>
      </Card>
      {current ? (
        <Notice tone="ok" text={`You signed this as “${current.signedName}” on ${day(current.signedAt)} at ${time(current.signedAt)}.`} />
      ) : (
        <Card>
          <Toggle label="I have read this and agree to it" value={agree} onChange={setAgree} />
          <Field label="Type your full legal name" value={name} onChangeText={setName} />
          <P small muted>Sign with your finger or mouse</P>
          <SignaturePad onChange={setSig} />
          <Button
            variant="primary"
            title="Sign"
            disabled={!agree || name.trim().length < 2 || !sig}
            onPress={async () => {
              const r = await attempt(() => api.post(`/me/waivers/${w.id}/sign`, { dogId: dog ?? null, signedName: name.trim(), signatureImage: sig, version: w.version, agree: true }));
              if (r) {
                say('Signed', 'Thank you. A copy is kept with your account.');
                router.back();
              }
            }}
          />
        </Card>
      )}
    </Screen>
  );
}
