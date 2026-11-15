import { describe, expect, it } from 'vitest';
import { mapColumns, parseCsv, parseLooseDate, phoneKey, readImport } from './importing.js';

describe('CSV', () => {
  it('handles quotes, commas, newlines and CRLF', () => {
    expect(parseCsv('﻿a,b,c\r\n"x, y","he said ""hi""","line\nbreak"\r\n\r\n')).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'he said "hi"', 'line\nbreak'],
    ]);
  });
  it('reads semicolon and tab files', () => {
    expect(parseCsv('a;b\n1;2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('a,b\n"1;2",3')).toEqual([['a', 'b'], ['1;2', '3']]);
  });
});

describe('columns', () => {
  it('recognises the usual export headers and vaccine columns', () => {
    const m = mapColumns(['Owner First Name', 'Owner Last Name', 'E-mail', 'Cell Phone', 'Pet Name', 'Breed', 'Rabies Expiration', 'Bordetella Exp', 'Rabies Given', 'Favorite toy']);
    expect(m.fields).toMatchObject({ ownerFirst: 0, ownerLast: 1, email: 2, phone: 3, dogName: 4, breed: 5 });
    expect(m.vaccines).toEqual([
      { index: 6, name: 'Rabies' },
      { index: 7, name: 'Bordetella' },
    ]);
    expect(m.ignored).toEqual(['Rabies Given', 'Favorite toy']);
  });
  it('a lone Name is the dog when an owner column exists', () => {
    expect(mapColumns(['Client', 'Name']).fields).toMatchObject({ ownerName: 0, dogName: 1 });
    expect(mapColumns(['Name', 'Email']).fields).toMatchObject({ ownerName: 0 });
  });
});

describe('dates and phones', () => {
  it('understands US dates', () => {
    expect(parseLooseDate('3/14/2027')).toBe('2027-03-14');
    expect(parseLooseDate('03-14-27')).toBe('2027-03-14');
    expect(parseLooseDate('2027-03-14')).toBe('2027-03-14');
    expect(parseLooseDate('2/30/2027')).toBeNull();
    expect(parseLooseDate('soon')).toBeNull();
  });
  it('matches phones however they are written', () => {
    expect(phoneKey('+1 (555) 201-3344')).toBe(phoneKey('555.201.3344'));
  });
});

describe('rows', () => {
  it('turns rows into owners, dogs and shots, and reports problems', () => {
    const csv = [
      'First Name,Last Name,Email,Phone,Pet Name,Breed,Sex,Spayed/Neutered,Birthday,Weight,Rabies Exp,Allergies',
      'Dana,Whitfield,DANA@EXAMPLE.COM,555-201-3344,Bowie,Goldendoodle,M,Yes,4/2/2021,52 lbs,3/14/2027,none',
      ',,x@y.com,,Ghost,,,,,,,',
      'Sam,Lee,not-an-email,,,,,,someday,,,',
    ].join('\n');
    const r = readImport(csv);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({
      owner: { name: 'Dana Whitfield', email: 'dana@example.com', phone: '555-201-3344' },
      dog: { name: 'Bowie', sex: 'male', fixed: true, birthDate: '2021-04-02', weightLb: 52, allergies: [] },
      vaccines: [{ name: 'Rabies', expiresOn: '2027-03-14' }],
    });
    expect(r.rows[1]!.dog).toBeNull();
    expect(r.problems.map((p) => p.line)).toEqual([3, 4, 4]);
  });
});
