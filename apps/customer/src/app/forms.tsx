import { Stack, router } from 'expo-router';
import { day } from '@dawgs/client';
import { Card, Chip, Empty, P, Row, Screen } from '@dawgs/ui';
import { useMe } from '../lib/me';

export default function Forms() {
  const me = useMe();
  const forms = me.data?.forms ?? [];
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Waivers and forms' }} />
      {me.data && forms.length === 0 ? <Empty text="Nothing to sign." /> : null}
      {forms.map((f) => (
        <Card key={`${f.waiverId}-${f.dog?.id ?? 'owner'}`} onPress={() => router.push(`/form/${f.waiverId}${f.dog ? `?dog=${f.dog.id}` : ''}`)}>
          <Row between>
            <P bold>
              {f.title}
              {f.dog ? ` · ${f.dog.name}` : ''}
            </P>
            {f.needsSignature ? (
              <Chip text={f.signedVersion ? 'Updated: sign again' : f.required ? 'Please sign' : 'Optional'} tone={f.required ? 'bad' : 'warn'} />
            ) : (
              <Chip text={`Signed ${day(f.signedAt!)}`} tone="ok" />
            )}
          </Row>
        </Card>
      ))}
    </Screen>
  );
}
