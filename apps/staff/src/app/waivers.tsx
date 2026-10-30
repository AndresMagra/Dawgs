import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Stack } from 'expo-router';
import { day, time, type Waiver } from '@dawgs/client';
import { Button, Card, Chip, Empty, Field, H2, Notice, P, Row, Screen, Segmented, Sheet, Toggle, useLoad } from '@dawgs/ui';
import { api, useSession } from '../lib/session';
import { attempt, confirm } from '../lib/alert';

interface SignatureRow {
  id: string;
  ownerName: string;
  dogId: string | null;
  version: number;
  signedName: string;
  signedAt: string;
  collectedBy: string;
}
interface SignatureFull extends SignatureRow {
  title: string;
  bodySigned: string;
  bodySha256: string;
  signatureImage: string | null;
  ip: string | null;
  userAgent: string | null;
}

/** Waivers and other forms owners must sign. Changing the wording makes a new version everyone signs again. */
export default function WaiversScreen() {
  const { isManager, business } = useSession();
  const tz = business?.timezone;
  const list = useLoad(() => api.get<Waiver[]>('/waivers'), []);
  const [editing, setEditing] = useState<Waiver | 'new' | null>(null);
  const [viewing, setViewing] = useState<Waiver | null>(null);
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Waivers & forms' }} />
      <Row between>
        <P muted>Owners sign these in the Dawgs app or on the front-desk tablet. A dog can't be booked until every required form is signed.</P>
        {isManager ? <Button variant="primary" title="New form" onPress={() => setEditing('new')} /> : null}
      </Row>
      <Notice tone="warn" text="The starter waiver is a template. Have a lawyer in your state review your forms before you rely on them." />
      {list.data?.length === 0 ? <Empty text="No forms yet." /> : null}
      {list.data?.map((w) => (
        <Card key={w.id} onPress={() => setViewing(w)}>
          <Row between>
            <View style={{ flex: 1 }}>
              <P bold>{w.title}</P>
              <P small muted>
                Version {w.version} · {w.scope === 'dog' ? 'signed per dog' : 'signed once per owner'} · {w.signedCurrent ?? 0} signed this version
              </P>
            </View>
            <Row>
              {w.required ? <Chip text="Required" tone="warn" /> : <Chip text="Optional" />}
              {!w.active ? <Chip text="Off" /> : null}
              {isManager ? <Button small variant="ghost" title="Edit" onPress={() => setEditing(w)} /> : null}
            </Row>
          </Row>
        </Card>
      ))}
      <EditWaiver waiver={editing} onClose={() => setEditing(null)} onDone={() => (setEditing(null), void list.reload())} />
      <Signatures waiver={viewing} tz={tz} onClose={() => setViewing(null)} />
    </Screen>
  );
}

function EditWaiver({ waiver, onClose, onDone }: { waiver: Waiver | 'new' | null; onClose: () => void; onDone: () => void }) {
  const w = waiver && waiver !== 'new' ? waiver : null;
  const [title, setTitle] = useState<string | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [required, setRequired] = useState<boolean | null>(null);
  const [scope, setScope] = useState<'owner' | 'dog' | null>(null);
  const [active, setActive] = useState<boolean | null>(null);
  const close = () => {
    setTitle(null);
    setBody(null);
    setRequired(null);
    setScope(null);
    setActive(null);
    onClose();
  };
  const t = title ?? w?.title ?? '';
  const bd = body ?? w?.body ?? '';
  const changesText = !!w && (t !== w.title || bd !== w.body);
  return (
    <Sheet visible={!!waiver} onClose={close} title={w ? `Edit ${w.title}` : 'New form'}>
      <Field label="Title" value={t} onChangeText={setTitle} />
      <Field label="Text the owner reads and agrees to" value={bd} onChangeText={setBody} multiline style={{ minHeight: 220, textAlignVertical: 'top' }} />
      <Toggle label="Required before booking" value={required ?? w?.required ?? true} onChange={setRequired} />
      <Segmented value={scope ?? w?.scope ?? 'owner'} onChange={setScope} options={[{ value: 'owner', label: 'Once per owner' }, { value: 'dog', label: 'Once per dog' }]} />
      {w ? <Toggle label="In use" value={active ?? w.active} onChange={setActive} /> : null}
      {changesText ? <Notice tone="warn" text={`Saving makes version ${w!.version + 1}. Every owner will need to sign again.`} /> : null}
      <Button
        variant="primary"
        title="Save"
        disabled={!t.trim() || bd.trim().length < 20}
        onPress={async () => {
          if (changesText && !(await confirm('New version?', 'Every owner will be asked to sign again.'))) return;
          const payload = { title: t.trim(), body: bd, required: required ?? w?.required ?? true, scope: scope ?? w?.scope ?? 'owner', ...(w ? { active: active ?? w.active } : {}) };
          if (await attempt(() => (w ? api.patch(`/waivers/${w.id}`, payload) : api.post('/waivers', payload)))) {
            close();
            onDone();
          }
        }}
      />
    </Sheet>
  );
}

function Signatures({ waiver, tz, onClose }: { waiver: Waiver | null; tz?: string; onClose: () => void }) {
  const rows = useLoad(() => (waiver ? api.get<SignatureRow[]>(`/waivers/${waiver.id}/signatures`) : Promise.resolve([])), [waiver?.id]);
  const [open, setOpen] = useState<SignatureFull | null>(null);
  if (!waiver) return null;
  return (
    <Sheet visible onClose={() => (open ? setOpen(null) : onClose())} title={open ? `Signed by ${open.signedName}` : waiver.title}>
      {open ? (
        <>
          <P small muted>
            Version {open.version} · {day(open.signedAt, tz)} {time(open.signedAt, tz)} · {open.collectedBy}
            {open.ip ? ` · IP ${open.ip}` : ''}
          </P>
          <ScrollView style={{ maxHeight: 280, borderWidth: 1, borderColor: '#d4d4d8', borderRadius: 10, padding: 10 }}>
            <P>{open.bodySigned}</P>
          </ScrollView>
          <P small muted>Fingerprint of the signed text (SHA-256): {open.bodySha256}</P>
          {open.signatureImage ? <P small muted>Drawn signature kept with the record.</P> : null}
          <Button title="Back" onPress={() => setOpen(null)} />
        </>
      ) : (
        <>
          <ScrollView style={{ maxHeight: 200 }}>
            <P small>{waiver.body}</P>
          </ScrollView>
          <H2>Signatures</H2>
          {rows.data?.length === 0 ? <Empty text="Nobody has signed yet." /> : null}
          {rows.data?.map((s) => (
            <Card key={s.id} onPress={async () => setOpen((await attempt(() => api.get<SignatureFull>(`/signatures/${s.id}`))) ?? null)}>
              <Row between>
                <P>
                  {s.ownerName} · signed “{s.signedName}”
                </P>
                <Row>
                  {s.version !== waiver.version ? <Chip text={`old v${s.version}`} tone="warn" /> : null}
                  <P small muted>{day(s.signedAt, tz)}</P>
                </Row>
              </Row>
            </Card>
          ))}
        </>
      )}
    </Sheet>
  );
}
