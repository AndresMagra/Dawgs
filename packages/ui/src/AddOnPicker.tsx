import { View } from 'react-native';
import { addOnPrice, type AddOn, type AddOnRequest } from '@dawgs/client';
import { Card, Field, P, Row } from './components';
import { space, useTheme } from './theme';

/**
 * Choose add-ons for a booking, grouped the way the daycare set them up.
 * Transport asks for a time and an address; anything marked "needs a time" asks
 * for the time.
 */
export function AddOnPicker({
  options,
  service,
  value,
  onChange,
  defaultAddress,
}: {
  options: AddOn[];
  service: 'daycare' | 'boarding';
  value: AddOnRequest[];
  onChange: (v: AddOnRequest[]) => void;
  defaultAddress?: string | null;
}) {
  const t = useTheme();
  const offered = options.filter((a) => a.active && a.services.includes(service));
  if (!offered.length) return null;
  const groups = new Map<string, AddOn[]>();
  for (const a of offered) {
    const g = a.kind !== 'extra' ? 'Transport' : a.category?.trim() || 'Extras';
    groups.set(g, [...(groups.get(g) ?? []), a]);
  }
  const chosen = (id: string) => value.find((v) => v.addOnId === id);
  const toggle = (a: AddOn) => {
    if (chosen(a.id)) return onChange(value.filter((v) => v.addOnId !== a.id));
    // One pickup and one drop-off at most: choosing another replaces it.
    const other = value.filter((v) => a.kind === 'extra' || offered.find((o) => o.id === v.addOnId)?.kind !== a.kind);
    onChange([...other, { addOnId: a.id, ...(a.kind !== 'extra' ? { address: defaultAddress ?? '' } : {}) }]);
  };
  const edit = (id: string, patch: Partial<AddOnRequest>) => onChange(value.map((v) => (v.addOnId === id ? { ...v, ...patch } : v)));

  return (
    <View style={{ gap: space.sm }}>
      {[...groups].map(([group, list]) => (
        <View key={group} style={{ gap: space.xs }}>
          <P small bold>{group}</P>
          {list.map((a) => {
            const c = chosen(a.id);
            return (
              <Card key={a.id} onPress={() => toggle(a)} style={c ? { borderColor: t.brand, borderWidth: 2 } : undefined}>
                <Row between>
                  <View style={{ flex: 1 }}>
                    <P bold>{`${c ? '✓ ' : ''}${a.name}`}</P>
                    {a.description ? <P small muted>{a.description}</P> : null}
                  </View>
                  <P small>{addOnPrice(a)}</P>
                </Row>
              </Card>
            );
          })}
          {list
            .filter((a) => chosen(a.id) && (a.kind !== 'extra' || a.needsTime))
            .map((a) => {
              const c = chosen(a.id)!;
              return (
                <View key={`${a.id}-details`} style={{ gap: space.xs, paddingLeft: space.md }}>
                  <Field
                    label={`${a.name}: time`}
                    value={c.time ?? ''}
                    onChangeText={(v) => edit(a.id, { time: v || null })}
                    placeholder={a.kind === 'dropoff' ? '17:30' : '08:00'}
                    hint="24-hour time, like 08:00 or 17:30"
                  />
                  {a.kind !== 'extra' ? (
                    <>
                      <Field label={a.kind === 'pickup' ? 'Pick up from' : 'Drop off at'} value={c.address ?? ''} onChangeText={(v) => edit(a.id, { address: v })} />
                      <Field label="Notes for the driver" value={c.notes ?? ''} onChangeText={(v) => edit(a.id, { notes: v || null })} placeholder="Gate code, where the leash is…" />
                    </>
                  ) : null}
                </View>
              );
            })}
        </View>
      ))}
    </View>
  );
}

/** Times are typed by hand; this keeps "8:00" or "8" from being refused by the server. */
export function normalizeAddOns(list: AddOnRequest[]): AddOnRequest[] {
  return list.map((r) => {
    if (!r.time) return r;
    const m = /^(\d{1,2})(?::?(\d{2}))?$/.exec(r.time.trim());
    return m ? { ...r, time: `${m[1]!.padStart(2, '0')}:${m[2] ?? '00'}` } : r;
  });
}
