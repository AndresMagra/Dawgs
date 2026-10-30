import type { TokenStore } from '@dawgs/client';

const KEY = 'dawgs-staff-token';

/** SecureStore has no web build; the browser keeps the token in localStorage. */
export const tokenStore: TokenStore = {
  get: async () => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  set: async (t) => {
    try {
      if (t) localStorage.setItem(KEY, t);
      else localStorage.removeItem(KEY);
    } catch {
      /* private mode: stay signed in for this tab only */
    }
  },
};
