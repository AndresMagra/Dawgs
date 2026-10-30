import type { AuthorizedPerson, Card, Dog, Owner, OwnerForm } from '@dawgs/client';
import { useLoad } from '@dawgs/ui';
import { api } from './session';

export interface Me {
  owner: Owner;
  dogs: Dog[];
  cards: Card[];
  people: AuthorizedPerson[];
  forms: OwnerForm[];
  formsToSign: number;
}

export const useMe = () => useLoad(() => api.get<Me>('/me'), []);

export const defaultCard = (me: Me | null) => me?.cards.find((c) => c.isDefault) ?? me?.cards[0] ?? null;
