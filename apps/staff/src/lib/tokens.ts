import * as SecureStore from 'expo-secure-store';
import type { TokenStore } from '@dawgs/client';

const KEY = 'dawgs-staff-token';

export const tokenStore: TokenStore = {
  get: () => SecureStore.getItemAsync(KEY),
  set: async (t) => {
    if (t) await SecureStore.setItemAsync(KEY, t);
    else await SecureStore.deleteItemAsync(KEY);
  },
};
