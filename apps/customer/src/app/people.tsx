import { Stack } from 'expo-router';
import { Screen } from '@dawgs/ui';
import { PeopleList } from '../lib/people';
import { useMe } from '../lib/me';

export default function People() {
  const me = useMe();
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Who can pick up' }} />
      <PeopleList base="/me/people" people={me.data?.people ?? []} onChange={() => void me.reload()} />
    </Screen>
  );
}
