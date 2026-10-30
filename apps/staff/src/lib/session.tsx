import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Api, type Business, type StaffPermissions, type User } from '@dawgs/client';
import { tokenStore } from './tokens';

export const api = new Api(process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3001', tokenStore);

interface Session {
  user: User | null;
  business: Business | null;
  ready: boolean;
  isManager: boolean;
  /** Set by the manager in Settings; everything is true for managers. */
  can: StaffPermissions;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  refresh(): Promise<void>;
}

const NONE: StaffPermissions = { refund: false, discount: false, void: false, seeMoney: false, export: false, editSchedule: false };

const Ctx = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [business, setBusiness] = useState<Business | null>(null);
  const [ready, setReady] = useState(false);
  const [can, setCan] = useState<StaffPermissions>(NONE);

  const refresh = useCallback(async () => {
    if (!(await api.hasToken())) {
      setUser(null);
      setReady(true);
      return;
    }
    try {
      const me = await api.get<{ user: User; business: Business; can: StaffPermissions }>('/auth/me');
      if (me.user.role === 'owner') {
        await api.setToken(null);
        setUser(null);
      } else {
        setUser(me.user);
        setBusiness(me.business);
        setCan(me.can);
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
    isManager: user?.role === 'manager',
    can,
    async signIn(email, password) {
      const u = await api.login(email, password);
      if (u.role === 'owner') {
        await api.setToken(null);
        throw new Error('This is the staff app. Pet owners use the Dawgs app.');
      }
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
