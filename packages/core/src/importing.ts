/**
 * Moving a daycare's clients over from another system (PetExec, Gingr,
 * Revelation, a spreadsheet): read a CSV export, recognise its columns by
 * their usual names, and turn each row into an owner and a dog.
 */

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes, CRLF, a leading BOM. */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',' || c === ';' || c === '\t') {
      // Excel in some locales saves with semicolons; tabs come from pasting a sheet.
      if (c !== ',' && !delimiterIs(s, c)) field += c;
      else {
        row.push(field);
        field = '';
      }
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows.map((r) => r.map((f) => f.trim()));
}

/** The first line decides: a file is semicolon- or tab-separated only if its header has no commas. */
function delimiterIs(s: string, c: string) {
  const first = s.slice(0, s.search(/\r?\n|$/));
  return !first.includes(',') && first.includes(c);
}

export type ImportField =
  | 'ownerName'
  | 'ownerFirst'
  | 'ownerLast'
  | 'email'
  | 'phone'
  | 'address'
  | 'city'
  | 'state'
  | 'zip'
  | 'emergencyName'
  | 'emergencyPhone'
  | 'vetName'
  | 'vetPhone'
  | 'dogName'
  | 'breed'
  | 'sex'
  | 'fixed'
  | 'birthDate'
  | 'weight'
  | 'color'
  | 'feeding'
  | 'allergies'
  | 'medications'
  | 'notes';

const ALIASES: Record<ImportField, string[]> = {
  ownerName: ['owner', 'owner name', 'owners name', 'client', 'client name', 'customer', 'customer name', 'parent', 'pet parent', 'household', 'full name'],
  ownerFirst: ['first name', 'owner first name', 'client first name', 'customer first name', 'first'],
  ownerLast: ['last name', 'owner last name', 'client last name', 'customer last name', 'last', 'surname'],
  email: ['email', 'e mail', 'email address', 'owner email', 'client email', 'primary email'],
  phone: ['phone', 'cell', 'cell phone', 'mobile', 'mobile phone', 'phone number', 'primary phone', 'owner phone', 'client phone', 'home phone', 'telephone'],
  address: ['address', 'street', 'street address', 'address 1', 'address line 1', 'address1'],
  city: ['city', 'town'],
  state: ['state', 'province', 'st'],
  zip: ['zip', 'zip code', 'zipcode', 'postal code', 'postcode'],
  emergencyName: ['emergency contact', 'emergency contact name', 'emergency name'],
  emergencyPhone: ['emergency phone', 'emergency contact phone', 'emergency number'],
  vetName: ['vet', 'veterinarian', 'vet name', 'veterinarian name', 'vet clinic', 'veterinary clinic'],
  vetPhone: ['vet phone', 'veterinarian phone', 'vet clinic phone'],
  dogName: ['pet', 'pet name', 'dog', 'dog name', 'animal', 'animal name', 'pets name', 'dogs name', 'name of pet'],
  breed: ['breed', 'pet breed', 'dog breed'],
  sex: ['sex', 'gender', 'pet sex', 'pet gender'],
  fixed: ['fixed', 'spayed neutered', 'spayed or neutered', 'altered', 'neutered', 'spayed', 'spay neuter'],
  birthDate: ['birthday', 'birth date', 'birthdate', 'date of birth', 'dob', 'pet birthday', 'pet dob'],
  weight: ['weight', 'weight lbs', 'weight lb', 'pet weight', 'lbs'],
  color: ['color', 'colour', 'markings', 'color markings'],
  feeding: ['feeding', 'feeding instructions', 'feeding notes', 'food', 'diet'],
  allergies: ['allergies', 'allergy', 'food allergies'],
  medications: ['medications', 'medication', 'meds', 'medical conditions', 'medical notes'],
  notes: ['notes', 'pet notes', 'behavior', 'behaviour', 'behavior notes', 'temperament', 'comments', 'alerts', 'special instructions'],
};

const norm = (h: string) =>
  h
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Common shots; a column whose header names one (and isn't a "given" date) holds its expiry. */
export const VACCINE_NAMES: Record<string, string> = {
  rabies: 'Rabies',
  dhpp: 'DHPP',
  dapp: 'DHPP',
  da2pp: 'DHPP',
  dhlpp: 'DHPP',
  distemper: 'DHPP',
  bordetella: 'Bordetella',
  kennel: 'Bordetella',
  leptospirosis: 'Leptospirosis',
  lepto: 'Leptospirosis',
  influenza: 'Canine influenza',
  civ: 'Canine influenza',
  lyme: 'Lyme',
  parvo: 'DHPP',
};

export interface ColumnMap {
  fields: Partial<Record<ImportField, number>>;
  /** Column index → vaccine name, for expiry-date columns. */
  vaccines: { index: number; name: string }[];
  ignored: string[];
}

export function mapColumns(header: string[]): ColumnMap {
  const fields: Partial<Record<ImportField, number>> = {};
  const vaccines: { index: number; name: string }[] = [];
  const ignored: string[] = [];
  header.forEach((raw, i) => {
    const h = norm(raw);
    const field = (Object.keys(ALIASES) as ImportField[]).find((f) => ALIASES[f].includes(h));
    if (field && fields[field] === undefined) {
      fields[field] = i;
      return;
    }
    const words = h.split(' ');
    const shot = words.map((w) => VACCINE_NAMES[w]).find(Boolean);
    const given = words.some((w) => ['given', 'administered', 'date given', 'received'].includes(w));
    if (shot && !given && !vaccines.some((v) => v.name === shot)) {
      vaccines.push({ index: i, name: shot });
      return;
    }
    ignored.push(raw);
  });
  // A lone "Name" column is the dog's in a pet export, the owner's in a client export.
  const nameAt = header.findIndex((h) => norm(h) === 'name');
  if (nameAt >= 0) {
    if (fields.dogName === undefined && (fields.ownerName !== undefined || fields.ownerFirst !== undefined)) fields.dogName = nameAt;
    else if (fields.ownerName === undefined && fields.ownerFirst === undefined) fields.ownerName = nameAt;
    const k = ignored.indexOf(header[nameAt]!);
    if (k >= 0 && (fields.dogName === nameAt || fields.ownerName === nameAt)) ignored.splice(k, 1);
  }
  return { fields, vaccines, ignored };
}

/** US-style dates as exports write them: 3/14/2027, 03-14-27, 2027-03-14, Mar 14 2027. */
export function parseLooseDate(s: string): string | null {
  const t = s.trim();
  if (!t) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (m) return ymd(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(t);
  if (m) {
    let y = +m[3]!;
    if (y < 100) y += y > 70 ? 1900 : 2000;
    return ymd(y, +m[1]!, +m[2]!);
  }
  const d = Date.parse(t);
  if (!Number.isNaN(d)) {
    const x = new Date(d);
    return ymd(x.getFullYear(), x.getMonth() + 1, x.getDate());
  }
  return null;
}

function ymd(y: number, m: number, d: number) {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export interface ImportRow {
  line: number;
  owner: { name: string; email: string | null; phone: string | null; address: string | null; emergencyName: string | null; emergencyPhone: string | null; vetName: string | null; vetPhone: string | null };
  dog: {
    name: string;
    breed: string | null;
    sex: 'male' | 'female' | null;
    fixed: boolean | null;
    birthDate: string | null;
    weightLb: number | null;
    color: string | null;
    feeding: string | null;
    allergies: string[];
    notes: string | null;
    medications: string | null;
  } | null;
  vaccines: { name: string; expiresOn: string }[];
}

export interface ImportProblem {
  line: number;
  message: string;
}

const yes = (s: string) => /^(y|yes|true|1|x|spayed|neutered|fixed|altered)$/i.test(s.trim());
const no = (s: string) => /^(n|no|false|0|intact)$/i.test(s.trim());
const orNull = (s: string | undefined) => (s && s.trim() ? s.trim() : null);

export function readImport(text: string, maxRows = 5000): { columns: ColumnMap; rows: ImportRow[]; problems: ImportProblem[] } {
  const all = parseCsv(text);
  if (all.length < 2) return { columns: { fields: {}, vaccines: [], ignored: [] }, rows: [], problems: [{ line: 1, message: 'the file needs a header row and at least one client' }] };
  const columns = mapColumns(all[0]!);
  const f = columns.fields;
  const problems: ImportProblem[] = [];
  if (f.ownerName === undefined && f.ownerFirst === undefined && f.ownerLast === undefined) problems.push({ line: 1, message: 'no owner name column found (e.g. "Owner Name" or "First Name" + "Last Name")' });
  if (all.length - 1 > maxRows) problems.push({ line: maxRows + 2, message: `only the first ${maxRows} rows are read; split the file` });
  const rows: ImportRow[] = [];
  const get = (r: string[], k: ImportField) => (f[k] === undefined ? '' : (r[f[k]!] ?? '').trim());
  all.slice(1, maxRows + 1).forEach((r, i) => {
    const line = i + 2;
    const name = get(r, 'ownerName') || [get(r, 'ownerFirst'), get(r, 'ownerLast')].filter(Boolean).join(' ');
    if (!name) return problems.push({ line, message: 'no owner name; row skipped' });
    const email = get(r, 'email').toLowerCase();
    const address = [get(r, 'address'), get(r, 'city'), [get(r, 'state'), get(r, 'zip')].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    const dogName = get(r, 'dogName');
    const sexRaw = get(r, 'sex').toLowerCase();
    const fixedRaw = get(r, 'fixed');
    const birth = get(r, 'birthDate');
    const birthDate = parseLooseDate(birth);
    if (birth && !birthDate) problems.push({ line, message: `birthday "${birth}" not understood; left blank` });
    const weight = parseFloat(get(r, 'weight').replace(/[^0-9.]/g, ''));
    const vaccines: { name: string; expiresOn: string }[] = [];
    for (const v of columns.vaccines) {
      const raw = (r[v.index] ?? '').trim();
      if (!raw) continue;
      const d = parseLooseDate(raw);
      if (d) vaccines.push({ name: v.name, expiresOn: d });
      else problems.push({ line, message: `${v.name} date "${raw}" not understood; skipped` });
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) problems.push({ line, message: `email "${email}" looks wrong; left blank` });
    rows.push({
      line,
      owner: {
        name,
        email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
        phone: orNull(get(r, 'phone')),
        address: address || null,
        emergencyName: orNull(get(r, 'emergencyName')),
        emergencyPhone: orNull(get(r, 'emergencyPhone')),
        vetName: orNull(get(r, 'vetName')),
        vetPhone: orNull(get(r, 'vetPhone')),
      },
      dog: dogName
        ? {
            name: dogName,
            breed: orNull(get(r, 'breed')),
            sex: /^(m|male|boy|mn|neutered male)$/.test(sexRaw) ? 'male' : /^(f|female|girl|fs|spayed female)$/.test(sexRaw) ? 'female' : null,
            fixed: fixedRaw ? (yes(fixedRaw) ? true : no(fixedRaw) ? false : null) : /^(mn|fs|neutered male|spayed female)$/.test(sexRaw) ? true : null,
            birthDate,
            weightLb: Number.isFinite(weight) && weight > 0 && weight < 400 ? weight : null,
            color: orNull(get(r, 'color')),
            feeding: orNull(get(r, 'feeding')),
            allergies: get(r, 'allergies')
              .split(/[,;/]/)
              .map((x) => x.trim())
              .filter((x) => x && !/^(none|n\/a|na|no)$/i.test(x)),
            medications: orNull(get(r, 'medications')),
            notes: orNull(get(r, 'notes')),
          }
        : null,
      vaccines,
    });
  });
  return { columns, rows, problems };
}

/** Phone digits for matching (a leading US 1 dropped). */
export const phoneKey = (p: string | null | undefined) => {
  const d = (p ?? '').replace(/\D/g, '');
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
};
