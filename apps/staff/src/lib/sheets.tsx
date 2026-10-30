import { useState } from 'react';
import { creditsText, money, type Card as SavedCard, type Package, type PayOutcome } from '@dawgs/client';
import { Button, Field, Notice, P, Pick, Row, Sheet, useLoad } from '@dawgs/ui';
import { api } from './session';
import { attempt, say } from './alert';

const TEST_CARDS = [
  { value: 'pm_card_visa', label: 'Visa (works)' },
  { value: 'pm_card_mastercard', label: 'Mastercard (works)' },
  { value: 'pm_card_amex', label: 'Amex (works)' },
  { value: 'pm_card_chargeDeclined', label: 'Card that is declined' },
  { value: 'pm_card_chargeDeclinedInsufficientFunds', label: 'Card with no funds' },
];

/**
 * Saves a card for an owner. Until the daycare connects Stripe, the server runs
 * a simulator and takes Stripe's test-card names; once connected, the card is
 * entered on Stripe's own form, which is the only place card numbers go.
 */
export function AddCardSheet({ ownerId, open, onClose, onDone }: { ownerId: string; open: boolean; onClose: () => void; onDone: () => void }) {
  const [testCard, setTestCard] = useState<string | null>('pm_card_visa');
  const [mode, setMode] = useState<string | null>(null);
  async function check() {
    const s = await attempt(() => api.post<{ mode: string }>(`/owners/${ownerId}/cards/setup`, {}));
    if (s) setMode(s.mode);
  }
  if (open && mode === null) void check();
  return (
    <Sheet visible={open} onClose={onClose} title="Add a card">
      {mode === 'live' || mode === 'test' ? (
        <Notice tone="info" text="Card entry on Stripe's secure form arrives with the store builds. For now, owners add cards themselves from the Dawgs app." />
      ) : (
        <>
          <Notice tone="warn" text="Stripe isn't connected yet, so this is a test card. Connect Stripe in Settings to take real cards." />
          <Pick label="Test card" value={testCard} onChange={setTestCard} options={TEST_CARDS} />
          <Button
            variant="primary"
            title="Save card"
            onPress={async () => {
              if (await attempt(() => api.post<SavedCard>(`/owners/${ownerId}/cards`, { testCard }))) onDone();
            }}
          />
        </>
      )}
    </Sheet>
  );
}

/** Sell a pack or start a monthly membership for one dog. */
export function SellPackageSheet({ dogId, dogName, card, open, onClose, onDone }: { dogId: string; dogName: string; card: string | null; open: boolean; onClose: () => void; onDone: () => void }) {
  const pk = useLoad(() => api.get<Package[]>('/packages'), []);
  const [chosen, setChosen] = useState<string | null>(null);
  const p = pk.data?.find((x) => x.id === chosen);
  async function sell(method: 'card' | 'cash' | 'later') {
    if (!p) return;
    const r = await attempt(() => api.post<PayOutcome>(`/packages/${p.id}/sell`, { dogId, pay: { method } }));
    if (!r) return;
    if (r.declined) return say('Card declined', `${r.declined.message}. The invoice is open on the owner's account.`);
    if (method === 'later') await attempt(() => api.post(`/invoices/${r.invoice.id}/link`, { text: true }));
    say(r.paid ? `${p.name} added for ${dogName}` : 'Invoice sent', r.paid ? 'The credits are on the dog now.' : 'The credits appear once it is paid.');
    setChosen(null);
    onDone();
  }
  return (
    <Sheet visible={open} onClose={onClose} title={`Sell to ${dogName}`}>
      <Pick
        value={chosen}
        onChange={setChosen}
        options={(pk.data ?? []).filter((x) => x.active).map((x) => ({ value: x.id, label: `${x.name} · ${money(x.priceCents)}${x.recurring ? '/mo' : ''}` }))}
      />
      {p ? (
        <>
          <P muted>
            {creditsText(p.credits)}
            {p.expiresDays ? ` · use within ${p.expiresDays} days` : ''}
            {p.recurring ? ' · renews monthly on the card on file' : ''}
          </P>
          <Row wrap>
            <Button variant="primary" title={card ? `Charge ${card}` : 'No card on file'} disabled={!card} onPress={() => sell('card')} />
            {!p.recurring ? <Button title="Cash" onPress={() => sell('cash')} /> : null}
            {!p.recurring ? <Button title="Text a pay link" onPress={() => sell('later')} /> : null}
          </Row>
        </>
      ) : null}
    </Sheet>
  );
}

/** A plain text form in a sheet: one or more fields, one save. */
export function FormSheet<K extends string>({
  open,
  title,
  fields,
  initial,
  onClose,
  onSave,
}: {
  open: boolean;
  title: string;
  fields: { key: K; label: string; multiline?: boolean; keyboard?: 'numeric' | 'email-address' | 'phone-pad' }[];
  initial?: Partial<Record<K, string>>;
  onClose: () => void;
  onSave: (v: Record<K, string>) => Promise<unknown>;
}) {
  const [v, setV] = useState<Record<string, string>>({});
  const val = (k: K) => v[k] ?? initial?.[k] ?? '';
  return (
    <Sheet
      visible={open}
      onClose={() => {
        setV({});
        onClose();
      }}
      title={title}
    >
      {fields.map((f) => (
        <Field
          key={f.key}
          label={f.label}
          value={val(f.key)}
          onChangeText={(t) => setV((s) => ({ ...s, [f.key]: t }))}
          multiline={f.multiline}
          {...(f.keyboard ? { keyboardType: f.keyboard } : {})}
          style={f.multiline ? { minHeight: 90, textAlignVertical: 'top' } : undefined}
        />
      ))}
      <Button
        variant="primary"
        title="Save"
        onPress={async () => {
          const out = Object.fromEntries(fields.map((f) => [f.key, val(f.key)])) as Record<K, string>;
          const r = await onSave(out);
          if (r !== undefined) setV({});
        }}
      />
    </Sheet>
  );
}

export const orNull = (s: string) => (s.trim() ? s.trim() : null);
