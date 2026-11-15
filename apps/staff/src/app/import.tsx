import { useState } from 'react';
import { Platform } from 'react-native';
import { Stack, router } from 'expo-router';
import { Button, Card, Chip, Field, H2, Line, Notice, P, Row, Screen } from '@dawgs/ui';
import { api } from '../lib/session';
import { attempt, confirm } from '../lib/alert';

interface ImportResult {
  dryRun: boolean;
  rows: number;
  ownersNew: number;
  ownersMatched: number;
  dogsNew: number;
  dogsSkipped: number;
  vaccines: number;
  columns: { recognised: string[]; vaccines: string[]; ignored: string[] };
  problems: { line: number; message: string }[];
  preview: { line: number; owner: string; ownerIsNew: boolean; dog: string | null; dogIsNew: boolean; vaccines: string[] }[];
}

const FIELD_NAMES: Record<string, string> = {
  ownerName: 'Owner name',
  ownerFirst: 'First name',
  ownerLast: 'Last name',
  email: 'Email',
  phone: 'Phone',
  address: 'Address',
  city: 'City',
  state: 'State',
  zip: 'ZIP',
  emergencyName: 'Emergency contact',
  emergencyPhone: 'Emergency phone',
  vetName: 'Vet',
  vetPhone: 'Vet phone',
  dogName: 'Dog name',
  breed: 'Breed',
  sex: 'Sex',
  fixed: 'Spayed/neutered',
  birthDate: 'Birthday',
  weight: 'Weight',
  color: 'Color',
  feeding: 'Feeding',
  allergies: 'Allergies',
  medications: 'Medications',
  notes: 'Notes',
};

/** Pick a .csv on the website (phones and tablets can paste instead). */
function chooseFile(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,text/csv,text/plain,.txt,.tsv';
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      f.text().then(resolve, () => resolve(null));
    };
    input.click();
  });
}

/** Managers: move clients and dogs over from PetExec, Gingr, Revelation or a spreadsheet. */
export default function ImportClients() {
  const [csv, setCsv] = useState('');
  const [name, setName] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const preview = async (text: string) => {
    const r = await attempt(() => api.post<ImportResult>('/import/clients', { csv: text, dryRun: true }));
    if (r) setResult(r);
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Import clients' }} />
      <Card>
        <H2>Bring your clients over</H2>
        <P muted>
          Export your clients and pets as a CSV (PetExec: Reports → Owner/Pet list; Gingr: Reports → Owners and Animals; or save any spreadsheet as CSV). One row per dog; owners with several dogs can repeat. Column names are recognised automatically, including vaccine expiry columns like "Rabies Expiration".
        </P>
        <P small muted>Nothing is saved until you press Import. Running the same file twice never adds anyone twice.</P>
        <Row wrap>
          {Platform.OS === 'web' ? (
            <Button
              variant="primary"
              title="Choose CSV file"
              onPress={async () => {
                const text = await chooseFile();
                if (!text) return;
                setCsv(text);
                setName(`${text.split(/\r?\n/).length - 1} rows loaded`);
                await preview(text);
              }}
            />
          ) : null}
          {name ? <Chip text={name} tone="ok" /> : null}
        </Row>
        <Field label="…or paste the rows here (with the header row)" value={csv.length > 20_000 ? `${csv.slice(0, 20_000)}\n…` : csv} onChangeText={(v) => { setCsv(v); setName(null); setResult(null); }} multiline numberOfLines={6} autoCapitalize="none" autoCorrect={false} />
        <Button title="Preview" disabled={!csv.trim()} onPress={() => preview(csv)} />
      </Card>

      {result ? (
        <>
          <Card>
            <H2>{result.dryRun ? 'What will happen' : 'Imported'}</H2>
            <Line left="Rows read" right={String(result.rows)} />
            <Line left="New owners" right={String(result.ownersNew)} bold />
            <Line left="Owners already on file (blanks filled in)" right={String(result.ownersMatched)} />
            <Line left="New dogs" right={String(result.dogsNew)} bold />
            <Line left="Dogs already on file (skipped)" right={String(result.dogsSkipped)} />
            <Line left="Vaccine records (counted as checked)" right={String(result.vaccines)} />
            {result.dryRun ? (
              <Button
                variant="primary"
                title={`Import ${result.ownersNew} ${result.ownersNew === 1 ? 'owner' : 'owners'} and ${result.dogsNew} ${result.dogsNew === 1 ? 'dog' : 'dogs'}`}
                disabled={!result.ownersNew && !result.dogsNew}
                onPress={async () => {
                  if (!(await confirm('Import?', `Add ${result.ownersNew} owners and ${result.dogsNew} dogs to Dawgs.`))) return;
                  const r = await attempt(() => api.post<ImportResult>('/import/clients', { csv, dryRun: false }));
                  if (r) setResult(r);
                }}
              />
            ) : (
              <>
                <Notice tone="ok" text="Done. Owners can now create an account in the customer app with the same email and they'll see their dogs." />
                <Button title="See owners" onPress={() => router.push('/owners')} />
              </>
            )}
          </Card>
          <Card>
            <H2>Columns</H2>
            <P small>Recognised: {result.columns.recognised.map((k) => FIELD_NAMES[k] ?? k).join(', ') || 'none'}</P>
            {result.columns.vaccines.length ? <P small>Vaccines: {result.columns.vaccines.join(', ')}</P> : null}
            {result.columns.ignored.length ? <P small muted>Not used: {result.columns.ignored.join(', ')}</P> : null}
          </Card>
          {result.problems.length ? (
            <Card>
              <H2>{`Check these (${result.problems.length})`}</H2>
              {result.problems.slice(0, 30).map((p, i) => (
                <P key={i} small>{`Row ${p.line}: ${p.message}`}</P>
              ))}
            </Card>
          ) : null}
          <Card>
            <H2>First rows</H2>
            {result.preview.map((p) => (
              <Line
                key={p.line}
                left={`${p.owner}${p.dog ? ` · ${p.dog}` : ''}`}
                right={[p.ownerIsNew ? 'new owner' : 'on file', p.dog ? (p.dogIsNew ? 'new dog' : 'dog on file') : null, p.vaccines.length ? `${p.vaccines.length} shots` : null].filter(Boolean).join(' · ')}
              />
            ))}
          </Card>
        </>
      ) : null}
    </Screen>
  );
}
