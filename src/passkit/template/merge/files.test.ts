import { describe, expect, it } from 'vitest';
import { mergePackages } from './apply.ts';
import { baseDoc, edit, ids, kinds, run, sha, stringsFile } from './merge-test-fixtures.ts';
import { readStrings } from './strings.ts';

const set = (name: string, value: string) => (d: any) => (d.files[name] = { sha1: sha(value) });
const files = (r: ReturnType<typeof run>) => r.merged.files;
const json = (e?: { bytes?: Uint8Array }) => JSON.parse(new TextDecoder().decode(e?.bytes));

describe('files.image', () => {
  it('takes whichever side changed a slot unit', () => {
    const r = run(set('icon@2x.png', 'o'), set('logo@2x.png', 't'));
    expect(r.status).toBe('clean');
    expect(files(r)['icon@2x.png']?.sha1).toBe(sha('o'));
    expect(files(r)['logo@2x.png']?.sha1).toBe(sha('t'));
    expect(r.theirs).toEqual([{ part: 'files.image', path: ['logo'], op: 'change' }]);
  });
  it('scales are never mixed: both changing any scale of one unit conflicts', () => {
    const r = run(set('icon@2x.png', 'o'), set('icon@3x.png', 't'));
    expect(kinds(r)).toEqual({ 'files.image:icon': 'binary' });
    expect(files(r)['icon@2x.png']?.sha1).toBe(sha('o'));
    expect(files(r)['icon@3x.png']?.sha1).toBe(sha('icon3'));
  });
  it('locale units are separate, adds and deletes follow the rules', () => {
    const r = run(set('de.lproj/logo@2x.png', 'o'), set('logo@2x.png', 't'));
    expect(r.status).toBe('clean');
    const add = run(undefined, set('thumbnail@2x.png', 'n'));
    expect(Object.keys(files(add))).toContain('thumbnail@2x.png');
    const del = (d: any) => delete d.files['logo@2x.png'];
    expect(kinds(run(set('logo@2x.png', 'o'), del))).toEqual({
      'files.image:logo': 'modify-delete',
    });
    expect(kinds(run(del, set('logo@2x.png', 't')))).toEqual({
      'files.image:logo': 'delete-modify',
    });
    expect(run(set('x@2x.png', 'same'), set('x@2x.png', 'same')).status).toBe('clean');
    expect(kinds(run(set('x@2x.png', 'a'), set('x@2x.png', 'b')))).toEqual({
      'files.image:x': 'add-add',
    });
  });
});

describe('stamp art, wallet art, other files', () => {
  it('stamp and wallet art are per name; both changed is binary', () => {
    expect(kinds(run(set('stamps/filled.png', 'a'), set('stamps/filled.png', 'b')))).toEqual({
      'files.stampArt:stamps/filled.png': 'binary',
    });
    expect(
      kinds(run(set('wallets/google/hero.png', 'a'), set('wallets/google/hero.png', 'b'))),
    ).toEqual({
      'files.walletArt:wallets/google/hero.png': 'binary',
    });
    const r = run(set('stamps/empty.png', 'o'), set('stamps/filled.png', 't'));
    expect(r.status).toBe('clean');
  });
  it('generated strips and tooling.json are ignored on every side', () => {
    const r = run(set('tooling.json', 'o'), (d) => {
      set('stamps/strips/1/strip@2x.png', 'new')(d);
      set('stamps/strips/2/strip@2x.png', 'new')(d);
    });
    expect(r.status).toBe('clean');
    expect(Object.keys(files(r)).some((n) => n.includes('strips') || n === 'tooling.json')).toBe(
      false,
    );
  });
  it('personalization.json: one side keeps bytes, both changed merge by key', () => {
    const write = (patch: object) => (d: any) => {
      const e = d.files['personalization.json'];
      const next = new TextEncoder().encode(JSON.stringify({ ...json(e), ...patch }));
      d.files['personalization.json'] = { sha1: sha(JSON.stringify(patch)), bytes: next };
    };
    const one = run(undefined, write({ description: 'T' }));
    expect(json(files(one)['personalization.json']).description).toBe('T');
    const both = run(write({ requiredPersonalizationFields: ['b'] }), write({ description: 'T' }));
    expect(both.status).toBe('clean');
    expect(json(files(both)['personalization.json'])).toEqual({
      description: 'T',
      requiredPersonalizationFields: ['b'],
    });
    expect(ids(run(write({ description: 'A' }), write({ description: 'B' })))).toEqual([
      'files.other:personalization.json/description',
    ]);
  });
});

describe('strings', () => {
  const put = (values: Record<string, string>) => (d: any) =>
    (d.files['en.lproj/pass.strings'] = stringsFile(values));
  const file = (r: ReturnType<typeof run>) => files(r)['en.lproj/pass.strings'];
  it('keeps the changed side verbatim when only one changed', () => {
    const t = stringsFile({ Name: 'Name', Tier: 'Level' });
    const r = run(undefined, (d) => (d.files['en.lproj/pass.strings'] = t));
    expect(file(r)).toBe(t);
  });
  it('both changed: merges by string key and writes UTF-8 in ours order with theirs adds after', () => {
    const r = run(
      put({ Name: 'Nom', Tier: 'Tier', Extra: 'E' }),
      put({ Name: 'Name', Tier: 'Niveau', New: 'N' }),
    );
    expect(r.status).toBe('clean');
    const text = new TextDecoder().decode(file(r)?.bytes);
    expect(text).toBe('"Name" = "Nom";\n"Tier" = "Niveau";\n"New" = "N";\n"Extra" = "E";\n');
    expect(file(r)?.sha1).not.toBe(sha(text.slice(1)));
  });
  it('conflicts per key and escapes values', () => {
    const r = run(put({ Name: 'A', Tier: 'Tier' }), put({ Name: 'B', Tier: 'T"\n' }));
    expect(kinds(r)).toEqual({ 'strings:en.lproj/pass.strings/Name': 'both-changed' });
    const merged = readStrings(file(r)?.bytes as Uint8Array);
    expect(merged).toEqual({ Name: 'A', Tier: 'T"\n' });
  });
  it('without bytes or with bad bytes the file is atomic or invalid', () => {
    const noBytes = (v: string) => (d: any) =>
      (d.files['en.lproj/pass.strings'] = { sha1: sha(v) });
    expect(kinds(run(noBytes('a'), noBytes('b')))).toEqual({
      'strings:en.lproj/pass.strings': 'both-changed',
    });
    const bad = (d: any) =>
      (d.files['en.lproj/pass.strings'] = {
        sha1: sha('bad'),
        bytes: new TextEncoder().encode('"a" = '),
      });
    expect(kinds(run(bad, put({ Name: 'T' })))).toEqual({
      'strings:en.lproj/pass.strings': 'invalid',
    });
    // An invalid file takes a side when picked, and the part filed after it is not mislabelled.
    const base = baseDoc();
    const [o, t] = [edit(base, bad), edit(base, put({ Name: 'T' }))];
    const picked = mergePackages(base, o, t, {
      picks: { 'strings:en.lproj/pass.strings': 'theirs' },
    });
    expect(picked.status).toBe('clean');
    expect(picked.merged.files['en.lproj/pass.strings']).toEqual(t.files['en.lproj/pass.strings']);
  });
  it('a new locale from theirs is added', () => {
    const r = run(
      undefined,
      (d) => (d.files['fr.lproj/pass.strings'] = stringsFile({ Name: 'Nom' })),
    );
    expect(Object.keys(files(r))).toContain('fr.lproj/pass.strings');
  });
});
