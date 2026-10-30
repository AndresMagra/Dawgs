import { useState } from 'react';
import { Linking, View } from 'react-native';
import { Stack, router } from 'expo-router';
import { LEAD_SOURCES, LEAD_STAGES, dateKeyLabel, day, time, todayKey, type Lead, type LeadActivity, type LeadSource, type LeadStage } from '@dawgs/client';
import { Button, Card, Chip, Chips, Empty, Field, H2, Notice, P, Pick, Row, Screen, Segmented, Sheet, Stat, useLoad } from '@dawgs/ui';
import { api, useSession } from '../lib/session';
import { attempt, confirm } from '../lib/alert';
import { orNull } from '../lib/sheets';

type Staff = { id: string; name: string };
const OPEN: LeadStage[] = ['new', 'contacted', 'tour', 'trial'];
const stageLabel = (s: LeadStage) => LEAD_STAGES.find((x) => x.key === s)!.label;
const sourceLabel = (s: LeadSource) => LEAD_SOURCES.find((x) => x.key === s)!.label;
const INTERESTS = ['daycare', 'boarding', 'training', 'grooming', 'walks'];

/** Prospective clients, from first inquiry to their first visit. */
export default function LeadsScreen() {
  const { business } = useSession();
  const tz = business?.timezone ?? 'America/New_York';
  const today = todayKey(tz);
  const [view, setView] = useState<'open' | 'all'>('open');
  const [stage, setStage] = useState<LeadStage | 'any'>('any');
  const list = useLoad(() => api.get<{ leads: Lead[]; staff: Staff[]; inquiryUrl: string | null }>(`/leads${view === 'all' ? '?all=1' : ''}`), [view]);
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const leads = list.data?.leads ?? [];
  const due = leads.filter((l) => l.followUpOn && l.followUpOn <= today && OPEN.includes(l.stage));
  const shown = leads.filter((l) => stage === 'any' || l.stage === stage);
  const inquiryUrl = list.data?.inquiryUrl ?? null;

  return (
    <Screen refreshing={list.loading}>
      <Stack.Screen options={{ title: 'Leads' }} />
      <Row wrap>
        {OPEN.map((s) => (
          <View key={s} style={{ flexGrow: 1, minWidth: 130 }}>
            <Stat label={stageLabel(s)} value={String(leads.filter((l) => l.stage === s).length)} />
          </View>
        ))}
      </Row>
      <Row between wrap>
        <Segmented value={view} onChange={(v) => { setView(v); setStage('any'); }} options={[{ value: 'open', label: 'Open' }, { value: 'all', label: 'All, incl. won & lost' }]} />
        <Button variant="primary" title="New lead" onPress={() => setAdding(true)} />
      </Row>
      <Pick
        value={stage}
        onChange={setStage}
        options={[{ value: 'any' as const, label: 'Every stage' }, ...(view === 'all' ? LEAD_STAGES : LEAD_STAGES.filter((s) => OPEN.includes(s.key))).map((s) => ({ value: s.key, label: stageLabel(s.key) }))]}
      />
      {due.length ? <Notice tone="warn" text={`${due.length} follow-up${due.length === 1 ? '' : 's'} due: ${due.map((l) => l.name).join(', ')}`} /> : null}
      {list.error ? <Notice tone="bad" text={list.error} /> : null}
      {list.data && shown.length === 0 ? <Empty text={view === 'open' ? 'No open leads. Share your inquiry link below to collect them.' : 'No leads yet.'} /> : null}
      {shown.map((l) => (
        <Card key={l.id} onPress={() => setOpenId(l.id)}>
          <Row between>
            <View style={{ flex: 1 }}>
              <P bold>{l.name}{l.dogName ? ` · ${l.dogName}` : ''}{l.dogBreed ? ` (${l.dogBreed})` : ''}</P>
              <P small muted>{[sourceLabel(l.source), l.interest.join(', '), `added ${day(l.createdAt, tz)}`].filter(Boolean).join(' · ')}</P>
            </View>
            <Chips
              items={[
                { text: stageLabel(l.stage), tone: l.stage === 'won' ? 'ok' : l.stage === 'lost' ? '' : l.stage === 'new' ? 'info' : '' },
                ...(l.followUpOn && OPEN.includes(l.stage) ? [{ text: l.followUpOn <= today ? 'Follow up today' : `Follow up ${dateKeyLabel(l.followUpOn)}`, tone: l.followUpOn <= today ? ('warn' as const) : ('' as const) }] : []),
              ]}
            />
          </Row>
        </Card>
      ))}
      {inquiryUrl ? (
        <Card>
          <H2>Inquiry form for your website</H2>
          <P small muted>Link this from your website or social pages. Each inquiry lands here as a new lead, you get a notification, and the person gets a thank-you email.</P>
          <P small>{inquiryUrl}</P>
        </Card>
      ) : null}
      <NewLeadSheet open={adding} staff={list.data?.staff ?? []} onClose={() => setAdding(false)} onDone={() => void list.reload()} />
      {openId ? <LeadSheet id={openId} staff={list.data?.staff ?? []} tz={tz} onClose={() => { setOpenId(null); void list.reload(); }} /> : null}
    </Screen>
  );
}

function InterestPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <Row wrap>
      {INTERESTS.map((i) => (
        <Button key={i} small title={i} variant={value.includes(i) ? 'primary' : 'secondary'} onPress={() => onChange(value.includes(i) ? value.filter((x) => x !== i) : [...value, i])} />
      ))}
    </Row>
  );
}

function NewLeadSheet({ open, staff, onClose, onDone }: { open: boolean; staff: Staff[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState<Record<string, string>>({});
  const [source, setSource] = useState<LeadSource>('phone');
  const [interest, setInterest] = useState<string[]>([]);
  const [who, setWho] = useState<string>('');
  const set = (k: string) => (v: string) => setF((s) => ({ ...s, [k]: v }));
  return (
    <Sheet visible={open} onClose={onClose} title="New lead">
      <Field label="Name" value={f.name ?? ''} onChangeText={set('name')} />
      <Field label="Mobile" value={f.phone ?? ''} onChangeText={set('phone')} keyboardType="phone-pad" />
      <Field label="Email" value={f.email ?? ''} onChangeText={set('email')} keyboardType="email-address" autoCapitalize="none" />
      <Field label="Dog's name" value={f.dogName ?? ''} onChangeText={set('dogName')} />
      <Field label="Breed" value={f.dogBreed ?? ''} onChangeText={set('dogBreed')} />
      <Pick label="How they found us" value={source} onChange={setSource} options={LEAD_SOURCES.filter((s) => s.key !== 'website').map((s) => ({ value: s.key, label: s.label }))} />
      <P small muted>Interested in</P>
      <InterestPicker value={interest} onChange={setInterest} />
      <Field label="Notes" value={f.message ?? ''} onChangeText={set('message')} multiline />
      <Field label="Follow up on" value={f.followUpOn ?? ''} onChangeText={set('followUpOn')} placeholder="YYYY-MM-DD" />
      <Pick label="Who follows up" value={who} onChange={setWho} options={[{ value: '', label: 'Managers' }, ...staff.map((s) => ({ value: s.id, label: s.name }))]} />
      <Button
        variant="primary"
        title="Add lead"
        disabled={!f.name?.trim() || (!f.phone?.trim() && !f.email?.trim())}
        onPress={async () => {
          const ok = await attempt(() =>
            api.post('/leads', {
              name: f.name!.trim(),
              phone: orNull(f.phone ?? ''),
              email: orNull(f.email ?? ''),
              dogName: orNull(f.dogName ?? ''),
              dogBreed: orNull(f.dogBreed ?? ''),
              message: orNull(f.message ?? ''),
              followUpOn: orNull(f.followUpOn ?? ''),
              assignedTo: who || null,
              source,
              interest,
            }),
          );
          if (!ok) return;
          setF({});
          setInterest([]);
          onDone();
          onClose();
        }}
      />
    </Sheet>
  );
}

const KIND_LABEL: Record<LeadActivity['kind'], string> = { note: 'Note', call: 'Call', text: 'Text', email: 'Email', stage: 'Stage', tour: 'Tour' };

function LeadSheet({ id, staff, tz, onClose }: { id: string; staff: Staff[]; tz: string; onClose: () => void }) {
  const d = useLoad(() => api.get<{ lead: Lead; activity: LeadActivity[] }>(`/leads/${id}`), [id]);
  const [mode, setMode] = useState<'log' | 'text' | 'email'>('log');
  const [kind, setKind] = useState<'note' | 'call' | 'tour'>('call');
  const [body, setBody] = useState('');
  const [subject, setSubject] = useState('');
  const [lost, setLost] = useState(false);
  const [lostReason, setLostReason] = useState('');
  const l = d.data?.lead;
  const patch = async (input: Record<string, unknown>) => {
    if (await attempt(() => api.patch(`/leads/${id}`, input))) void d.reload();
  };
  return (
    <Sheet visible onClose={onClose} title={l ? l.name : 'Lead'}>
      {!l ? null : (
        <>
          <P small muted>{[l.phone, l.email].filter(Boolean).join(' · ')}</P>
          <P small muted>{[l.dogName ? `${l.dogName}${l.dogBreed ? ` (${l.dogBreed})` : ''}` : null, sourceLabel(l.source), l.interest.join(', ')].filter(Boolean).join(' · ')}</P>
          <Row wrap>
            {l.phone ? <Button small title="Call" onPress={() => void Linking.openURL(`tel:${l.phone}`)} /> : null}
            {l.ownerId ? <Button small title="Open client" onPress={() => { onClose(); router.push(`/owner/${l.ownerId}`); }} /> : null}
          </Row>
          {l.ownerId ? <Notice tone="ok" text="This lead is now a client." /> : null}
          {l.stage === 'lost' && l.lostReason ? <Notice tone="info" text={`Lost: ${l.lostReason}`} /> : null}

          {!l.ownerId ? (
            <>
              <H2>Stage</H2>
              <Row wrap>
                {(['new', 'contacted', 'tour', 'trial'] as const).map((s) => (
                  <Button key={s} small title={stageLabel(s)} variant={l.stage === s ? 'primary' : 'secondary'} onPress={() => patch({ stage: s })} />
                ))}
                <Button small title="Lost" variant={l.stage === 'lost' ? 'primary' : 'secondary'} onPress={() => setLost(true)} />
              </Row>
              {lost ? (
                <>
                  <Field label="Why? (optional)" value={lostReason} onChangeText={setLostReason} placeholder="Too far, price, went elsewhere…" />
                  <Button small title="Mark lost" onPress={async () => { await patch({ stage: 'lost', lostReason: orNull(lostReason) }); setLost(false); }} />
                </>
              ) : null}
              <Button
                variant="primary"
                title={l.dogName ? `Make ${l.name.split(' ')[0]} a client, with ${l.dogName}` : `Make ${l.name.split(' ')[0]} a client`}
                onPress={async () => {
                  if (!(await confirm('Make this lead a client?', 'This creates their client record' + (l.dogName ? ` and adds ${l.dogName}.` : '.')))) return;
                  const r = await attempt(() => api.post<{ ownerId: string }>(`/leads/${id}/convert`));
                  if (!r) return;
                  onClose();
                  router.push(`/owner/${r.ownerId}`);
                }}
              />
              <H2>Follow-up</H2>
              <Field label="Follow up on" value={l.followUpOn ?? ''} onChangeText={(v) => d.setData({ ...d.data!, lead: { ...l, followUpOn: v || null } })} placeholder="YYYY-MM-DD" />
              <Row wrap>
                <Button small title="Save date" onPress={() => patch({ followUpOn: l.followUpOn && /^\d{4}-\d{2}-\d{2}$/.test(l.followUpOn) ? l.followUpOn : null })} />
                <Button small title="Tomorrow" onPress={() => patch({ followUpOn: todayKey(tz, 1) })} />
                <Button small title="In a week" onPress={() => patch({ followUpOn: todayKey(tz, 7) })} />
                {l.followUpOn ? <Button small title="Clear" onPress={() => patch({ followUpOn: null })} /> : null}
              </Row>
              <Pick label="Who follows up" value={l.assignedTo ?? ''} onChange={(v) => patch({ assignedTo: v || null })} options={[{ value: '', label: 'Managers' }, ...staff.map((s) => ({ value: s.id, label: s.name }))]} />
            </>
          ) : null}

          <H2>Reach out or log</H2>
          <Segmented value={mode} onChange={setMode} options={[{ value: 'log', label: 'Log' }, { value: 'text', label: 'Text' }, { value: 'email', label: 'Email' }]} />
          {mode === 'log' ? <Pick value={kind} onChange={setKind} options={[{ value: 'call', label: 'Call' }, { value: 'tour', label: 'Tour' }, { value: 'note', label: 'Note' }]} /> : null}
          {mode === 'email' ? <Field label="Subject" value={subject} onChangeText={setSubject} /> : null}
          <Field label={mode === 'log' ? 'What happened' : 'Message'} value={body} onChangeText={setBody} multiline />
          <Button
            title={mode === 'log' ? 'Add to timeline' : mode === 'text' ? 'Send text' : 'Send email'}
            disabled={!body.trim() || (mode === 'text' && !l.phone) || (mode === 'email' && !l.email)}
            onPress={async () => {
              const ok = await attempt(() =>
                mode === 'log'
                  ? api.post(`/leads/${id}/activities`, { kind, body: body.trim() })
                  : api.post(`/leads/${id}/message`, { channel: mode === 'text' ? 'sms' : 'email', body: body.trim(), subject: orNull(subject) }),
              );
              if (!ok) return;
              setBody('');
              setSubject('');
              void d.reload();
            }}
          />

          <H2>Timeline</H2>
          {d.data!.activity.map((a) => (
            <Card key={a.id}>
              <Row between>
                <Chip text={KIND_LABEL[a.kind]} tone={a.kind === 'stage' ? 'info' : ''} />
                <P small muted>{`${day(a.at, tz)} ${time(a.at, tz)} · ${a.by}`}</P>
              </Row>
              <P>{a.body}</P>
            </Card>
          ))}
        </>
      )}
    </Sheet>
  );
}

