import { useState } from 'react';
import { ADD_ON_KINDS, addOnPrice, type AddOn } from '@dawgs/client';
import { Button, Chip, Field, P, Pick, Row, Segmented, Sheet, Toggle } from '@dawgs/ui';
import { api } from './session';
import { attempt, confirm } from './alert';
import { orNull } from './sheets';

/** The manager's editor for one add-on: whatever they sell, priced their way. */
export function AddOnSheet({ row, onClose, onDone }: { row?: AddOn; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({
    name: row?.name ?? '',
    description: row?.description ?? '',
    category: row?.category ?? '',
    price: row ? String(row.priceCents / 100) : '',
    duration: row?.durationMinutes ? String(row.durationMinutes) : '',
    limit: row?.dailyLimit ? String(row.dailyLimit) : '',
  });
  const [kind, setKind] = useState<AddOn['kind']>(row?.kind ?? 'extra');
  const [pricing, setPricing] = useState<AddOn['pricing']>(row?.pricing ?? 'flat');
  const [services, setServices] = useState<AddOn['services']>(row?.services ?? ['daycare', 'boarding']);
  const [ownerBookable, setOwnerBookable] = useState(row?.ownerBookable ?? true);
  const [needsTime, setNeedsTime] = useState(row?.needsTime ?? false);
  const [active, setActive] = useState(row?.active ?? true);
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));
  const toggleService = (s: 'daycare' | 'boarding') => setServices((v) => (v.includes(s) ? v.filter((x) => x !== s) : [...v, s]));
  const price = Number(f.price);
  const valid = f.name.trim() && f.price.trim() !== '' && Number.isFinite(price) && price >= 0 && services.length > 0;

  return (
    <Sheet visible onClose={onClose} title={row ? `Edit ${row.name}` : 'New add-on'}>
      <Field label="Name" value={f.name} onChangeText={set('name')} placeholder="Exit bath, Pickup from home, Pup cup…" />
      <Pick label="What is it" value={kind} onChange={setKind} options={ADD_ON_KINDS.map((k) => ({ value: k.key, label: k.label }))} />
      {kind !== 'extra' ? (
        <P small muted>{kind === 'pickup' ? 'Goes on the run sheet for the first day, with the time and address the client gives.' : 'Goes on the run sheet for the last day, with the time and address.'}</P>
      ) : null}
      <Field label="Description clients see (optional)" value={f.description} onChangeText={set('description')} multiline placeholder="Within 10 miles. We text when we're on the way." />
      <Field label="Category (optional)" value={f.category} onChangeText={set('category')} placeholder="Grooming, Care, Treats…" />
      <Field label="Price ($)" value={f.price} onChangeText={set('price')} keyboardType="decimal-pad" />
      <Segmented value={pricing} onChange={setPricing} options={[{ value: 'flat', label: 'Once per booking' }, { value: 'per_day', label: 'Per day / night' }]} />
      <Field label="Takes about (minutes, optional)" value={f.duration} onChangeText={set('duration')} keyboardType="number-pad" />
      <Field label="Most per day (optional)" value={f.limit} onChangeText={set('limit')} keyboardType="number-pad" hint="Van seats, groomer slots. Empty means no limit." />
      <P small muted>Offered with</P>
      <Row>
        <Button small title="Daycare" variant={services.includes('daycare') ? 'primary' : 'secondary'} onPress={() => toggleService('daycare')} />
        <Button small title="Boarding" variant={services.includes('boarding') ? 'primary' : 'secondary'} onPress={() => toggleService('boarding')} />
      </Row>
      <Toggle label="Clients can book it in their app" value={ownerBookable} onChange={setOwnerBookable} />
      {kind === 'extra' ? <Toggle label="Ask for a time" value={needsTime} onChange={setNeedsTime} /> : null}
      <Toggle label="Offered" value={active} onChange={setActive} />
      {valid ? <Chip text={`Shows as ${addOnPrice({ priceCents: Math.round(price * 100), pricing, durationMinutes: f.duration ? Number(f.duration) : null })}`} /> : null}
      <Row>
        <Button
          variant="primary"
          title="Save"
          disabled={!valid}
          onPress={async () => {
            const body = {
              name: f.name.trim(),
              description: orNull(f.description),
              category: orNull(f.category),
              kind,
              priceCents: Math.round(price * 100),
              pricing,
              durationMinutes: f.duration ? Number(f.duration) : null,
              dailyLimit: f.limit ? Number(f.limit) : null,
              services,
              ownerBookable,
              needsTime: kind !== 'extra' || needsTime,
              active,
            };
            const r = await attempt(() => (row ? api.patch(`/settings/add-ons/${row.id}`, body) : api.post('/settings/add-ons', body)));
            if (r) onDone();
          }}
        />
        {row ? (
          <Button
            variant="ghost"
            title="Delete"
            onPress={async () => (await confirm('Delete this add-on?', 'If it has been booked before, switch it off instead.')) && (await attempt(() => api.del(`/settings/add-ons/${row.id}`))) && onDone()}
          />
        ) : null}
      </Row>
      {row ? <Chip text="Changes apply from now on; bookings already made keep their price." /> : null}
    </Sheet>
  );
}
