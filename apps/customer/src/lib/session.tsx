import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { Api, type Business, type User } from '@dawgs/client';
import { tokenStore } from './tokens';

export const api = new Api(process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3001', tokenStore);

interface Session {
  user: User | null;
  business: Business | null;
  ready: boolean;
  signIn(email: string, password: string): Promise<void>;
  signUp(input: { business: string; name: string; email: string; phone?: string; password: string }): Promise<void>;
  signOut(): Promise<void>;
  refresh(): Promise<void>;
}

const Ctx = createContext<Session | null>(null);

/** Registers this phone for push (report cards, walk reports, pickups). Quietly does nothing where push isn't set up. */
async function registerPush() {
  if (Platform.OS === 'web') return;
  try {
    const Notifications = await import('expo-notifications');
    const Constants = (await import('expo-constants')).default;
    const perm = await Notifications.requestPermissionsAsync();
    if (perm.status !== 'granted') return;
    const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
    if (!projectId) return;
    const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
    await api.post('/auth/push-token', { token: data, platform: Platform.OS === 'ios' ? 'ios' : 'android' });
  } catch {
    // Push is a nicety; the app works without it.
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [business, setBusiness] = useState<Business | null>(null);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    if (!(await api.hasToken())) {
      setUser(null);
      setReady(true);
      return;
    }
    try {
      const me = await api.get<{ user: User; business: Business }>('/auth/me');
      if (me.user.role !== 'owner') {
        await api.setToken(null);
        setUser(null);
      } else {
        setUser(me.user);
        setBusiness(me.business);
        void registerPush();
      }
    } catch {
      setUser(null);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    api.onUnauthorized = () => setUser(null);
    void refresh();
  }, [refresh]);

  const value: Session = {
    user,
    business,
    ready,
    async signIn(email, password) {
      const u = await api.login(email, password);
      if (u.role !== 'owner') {
        await api.setToken(null);
        throw new Error('This app is for pet parents. Staff use the Dawgs Staff app.');
      }
      await refresh();
    },
    async signUp(input) {
      const r = await api.post<{ token: string }>('/auth/signup', input);
      await api.setToken(r.token);
      await refresh();
    },
    async signOut() {
      await api.logout();
      setUser(null);
    },
    refresh,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  const s = useContext(Ctx);
  if (!s) throw new Error('SessionProvider missing');
  return s;
}
