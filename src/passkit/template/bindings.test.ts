import { describe, expect, it } from 'vitest';
import type { PassField, PassJson, TemplateManifest } from '../types.ts';
import { bindPass } from './bindings.ts';
import { InMemoryTemplateRegistry } from './in-memory-registry.ts';
import { isAllowedPointer } from './pointer.ts';

function bind(
  bindings: unknown[],
  input: Record<string, unknown>,
  extra = {},
  server: { scanCode?: string } = {},
) {
  const passJson = {
    formatVersion: 1,
    serialNumber: 'keep',
    barcodes: [
      { format: 'PKBarcodeFormatCode128', message: 'x', messageEncoding: 'iso-8859-1' },
      { format: 'PKBarcodeFormatQR', message: 'x', messageEncoding: 'iso-8859-1' },
    ],
    featuredActions: [
      { identifier: 'a', type: 'url', url: 'https://old.test' },
      { identifier: 'b', type: 'place', placeIdentifier: 'I1' },
    ],
    generic: {
      primaryFields: [{ key: 'name', label: 'Name', value: 'sample' }],
      footerFields: [{ key: 'foot', value: 'f' }],
      backFields: [{ key: 'link', value: 'l', attributedValue: '<a href="https://a.test">a</a>' }],
    },
    ...extra,
  } as unknown as PassJson;
  const manifest: TemplateManifest = {
    schema: 1,
    name: 't',
    inputs: { type: 'object', properties: {} },
    sample: {},
    bindings: bindings as TemplateManifest['bindings'],
    display: { title: 'x' },
  };
  const template = new InMemoryTemplateRegistry().add({ id: 't', manifest, passJson });
  return bindPass(template, input as never, server);
}

describe('pass.scanCode', () => {
  const to = { barcode: 0, prop: 'message' };
  it('binds the server scan code into a barcode', () => {
    const { pass } = bind([{ to, value: '{{pass.scanCode}}' }], {}, {}, { scanCode: 'ABCD234' });
    expect(pass.barcodes?.[0]?.message).toBe('ABCD234');
  });
  it('joins it with text and is empty without one', () => {
    const joined = bind(
      [{ to, value: 'https://x.test/{{pass.scanCode}}' }],
      {},
      {},
      { scanCode: 'Q' },
    );
    expect(joined.pass.barcodes?.[0]?.message).toBe('https://x.test/Q');
    expect(bind([{ to, value: '{{pass.scanCode}}' }], {}).pass.barcodes?.[0]?.message).toBe('');
  });
  it('is not an input and cannot be shadowed by one', () => {
    const { pass } = bind(
      [{ to, value: '{{pass.scanCode}}' }],
      { pass: { scanCode: 'evil' } },
      {},
      {
        scanCode: 'REAL',
      },
    );
    expect(pass.barcodes?.[0]?.message).toBe('REAL');
  });
});

describe('bindings', () => {
  it('sets field props and reaches footer fields', () => {
    const { pass } = bind(
      [
        { to: { field: 'name', prop: 'label' }, value: 'L' },
        { to: { field: 'name', prop: 'changeMessage' }, value: 'Now %@' },
        { to: { field: 'foot' }, value: '{{n}}' },
      ],
      { n: 7 },
    );
    expect(pass.generic?.primaryFields?.[0]).toMatchObject({ label: 'L', changeMessage: 'Now %@' });
    expect((pass.generic?.footerFields as PassField[] | undefined)?.[0]?.value).toBe(7);
  });

  it('blanks a value that resolves to nothing instead of leaking the sample', () => {
    const { pass } = bind([{ to: { field: 'name' }, value: '{{missing}}' }], {});
    expect(pass.generic?.primaryFields?.[0]?.value).toBe('');
  });

  it('omitIfEmpty drops only the prop for non-value props', () => {
    const { pass } = bind(
      [
        { to: { field: 'link', prop: 'attributedValue' }, value: '{{x}}', omitIfEmpty: true },
        { to: { field: 'name' }, value: '{{x}}', omitIfEmpty: true },
      ],
      { x: '' },
    );
    expect(pass.generic?.backFields?.[0]).toEqual({ key: 'link', value: 'l' });
    expect(pass.generic?.primaryFields).toEqual([]);
  });

  it('honors when and remove', () => {
    const { pass } = bind(
      [
        { to: { field: 'name' }, value: 'skipped', when: { input: 'go', eq: true } },
        { to: { field: 'foot' }, remove: { input: 'go', eq: false } },
      ],
      { go: false },
    );
    expect(pass.generic?.primaryFields?.[0]?.value).toBe('sample');
    expect(pass.generic?.footerFields).toEqual([]);
  });

  it('targets barcodes by index and wildcard, and can remove them', () => {
    const { pass } = bind(
      [
        { to: { barcode: '*', prop: 'message' }, value: '{{id}}' },
        { to: { barcode: 1, prop: 'altText' }, value: 'alt' },
        { to: { barcode: 0, prop: 'altText' }, value: '{{none}}', omitIfEmpty: true },
      ],
      { id: 'M1' },
    );
    expect(pass.barcodes).toHaveLength(1);
    expect(pass.barcodes?.[0]).toMatchObject({ message: 'M1', altText: 'alt' });
  });

  it('removes a featured action whose url is empty', () => {
    const { pass } = bind(
      [{ to: { action: 'a', prop: 'url' }, value: '{{u}}', omitIfEmpty: true }],
      { u: '' },
    );
    expect(pass.featuredActions?.map((a) => (a as { identifier: string }).identifier)).toEqual([
      'b',
    ]);
  });

  it('sets, creates and deletes pointer targets', () => {
    const { pass } = bind(
      [
        { to: { pointer: '/expirationDate' }, value: '{{d}}', omitIfEmpty: true },
        { to: { pointer: '/semantics/flightNumber' }, value: { const: 12 } },
        { to: { pointer: '/backgroundColor' }, value: 'rgb(1,2,3)' },
        { to: { pointer: '/voided' }, value: '{{v}}' },
        { to: { pointer: '/userInfo' }, remove: { input: 'v', eq: true } },
      ],
      { d: '', v: true },
      { expirationDate: '2020-01-01T00:00:00Z', userInfo: { a: 1 } },
    );
    expect(pass.expirationDate).toBeUndefined();
    expect(pass.semantics).toEqual({ flightNumber: 12 });
    expect(pass.backgroundColor).toBe('rgb(1,2,3)');
    expect(pass.voided).toBe(true);
    expect(pass.userInfo).toBeUndefined();
  });

  it('refuses server-owned and style-dictionary pointers', () => {
    for (const pointer of [
      '/serialNumber',
      '/authenticationToken',
      '/generic/primaryFields/0/value',
      '/barcodes/0/message',
      '/__proto__/x',
      '/a/_id',
    ]) {
      expect(isAllowedPointer(pointer), pointer).not.toBeNull();
      expect(() => bind([{ to: { pointer }, value: 'x' }], {})).toThrow();
    }
    expect(isAllowedPointer('/boardingPass/transitType')).toBeNull();
    expect(isAllowedPointer('/semantics/airlineCode')).toBeNull();
    expect(isAllowedPointer('/relevantDates/0/startDate')).toBeNull();
    expect(isAllowedPointer('/nfc/message')).toBeNull();
  });

  it('fails when a pointer parent is not a container', () => {
    expect(() =>
      bind([{ to: { pointer: '/voided/x' }, value: 'x' }], {}, { voided: false }),
    ).toThrow(/Cannot set/);
  });

  it('records dropped image slots', () => {
    const { droppedImages } = bind(
      [
        { to: { image: 'thumbnail' }, remove: { input: 'photo', empty: true } },
        { to: { image: 'strip' }, remove: { input: 'photo', empty: false } },
      ],
      { photo: '' },
    );
    expect(droppedImages).toEqual(['thumbnail']);
  });

  it('does not mutate the template', () => {
    const before = bind([], {});
    const { pass } = bind([{ to: { field: 'name' }, value: 'x' }], {});
    expect(pass.generic?.primaryFields?.[0]?.value).toBe('x');
    expect(before.pass.generic?.primaryFields?.[0]?.value).toBe('sample');
  });
});
