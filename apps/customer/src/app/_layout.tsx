import { Stack, usePathname } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Loading, ThemeProvider, useTheme } from '@dawgs/ui';
import { SessionProvider, useSession } from '../lib/session';
import Login from '../lib/Login';

function Gate() {
  const { ready, user, business } = useSession();
  const t = useTheme();
  const path = usePathname();
  // A pay link from a text or email works without an account.
  const isPublic = path.startsWith('/pay/');
  if (!ready) return <Loading />;
  if (!user && !isPublic) return <Login />;
  return (
    <ThemeProvider brand={business?.brandColor}>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: t.surface },
          headerTintColor: t.text,
          contentStyle: { backgroundColor: t.bg },
          headerBackTitle: 'Back',
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      </Stack>
    </ThemeProvider>
  );
}

export default function Root() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <StatusBar style="auto" />
        <SessionProvider>
          <Gate />
        </SessionProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
