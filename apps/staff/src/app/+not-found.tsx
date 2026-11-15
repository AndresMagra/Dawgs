import { Stack, router } from 'expo-router';
import { Button, Card, H1, P, Screen } from '@dawgs/ui';

/** A friendly dead end for a mistyped or old link. */
export default function NotFound() {
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Not found' }} />
      <Card>
        <H1>That page isn't here</H1>
        <P muted>The link may be old or mistyped.</P>
        <Button variant="primary" title="Go to the start" onPress={() => router.replace('/')} />
      </Card>
    </Screen>
  );
}
