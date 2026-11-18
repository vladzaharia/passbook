import { describe, expect, it } from 'vitest';
import { normalizeRead } from './normalize.ts';

const ORIGINS = ['https://passbook.mobile'];
const norm = (code: string, over = {}) =>
  normalizeRead({ method: 'wedge', code, ...over }, ORIGINS);

describe('normalizeRead', () => {
  it('strips controls and trailing CR, LF and Tab, and trims', () => {
    expect(norm('  ABC123\r\n')).toMatchObject({ code: 'ABC123', sig: 'c:ABC123' });
    expect(norm('AB\u0000C\u0007D\t')).toMatchObject({ code: 'ABCD' });
  });

  it('leaves case and encoding alone: the server normalizes again', () => {
    expect(norm('abc-DEF/ghi')).toMatchObject({ code: 'abc-DEF/ghi' });
  });

  it('refuses an empty read or one over 1,024 UTF-8 bytes as not_found', () => {
    expect(norm('   \r\n').local).toBe('not_found');
    expect(norm('A'.repeat(1024)).local).toBeUndefined();
    expect(norm('A'.repeat(1025)).local).toBe('not_found');
    expect(norm('é'.repeat(513)).local).toBe('not_found');
  });

  it('refuses our /p/ and /b/ links as add_link, never to be sent', () => {
    expect(norm('https://passbook.mobile/p/abc123').local).toBe('add_link');
    expect(norm('https://passbook.mobile/b/abc123?x=1').local).toBe('add_link');
  });

  it('refuses a pairing link and any other path on our origin as not_found', () => {
    expect(norm('https://passbook.mobile/scan#pair=ABCD-EFGH').local).toBe('not_found');
    expect(norm('https://passbook.mobile/admin').local).toBe('not_found');
    expect(norm('https://passbook.mobile/').local).toBe('not_found');
  });

  it('sends a URL of another origin as an ordinary code', () => {
    expect(norm('https://example.com/p/abc')).toMatchObject({ code: 'https://example.com/p/abc' });
    expect(norm('https://example.com/p/abc').local).toBeUndefined();
  });

  it('a picked row has the p: signature and no code', () => {
    expect(normalizeRead({ method: 'manual', passId: 'abc' }, ORIGINS)).toEqual({
      passId: 'abc',
      sig: 'p:abc',
    });
  });

  it('a read with neither is not_found', () => {
    expect(normalizeRead({ method: 'manual' }, ORIGINS).local).toBe('not_found');
  });
});

describe('tag reads', () => {
  const read = (tag: Parameters<typeof normalizeRead>[0]['tag']) =>
    normalizeRead({ method: 'nfc', tag }, []);

  it('signs a read t:<uid>, lowercase, so both readers dedupe together', () => {
    expect(read({ uid: '04A2B3C4', tech: 'a', source: 'native' }).sig).toBe('t:04a2b3c4');
    expect(read({ uid: '04a2b3c4', tech: 'unknown', source: 'webnfc' }).sig).toBe('t:04a2b3c4');
  });

  it('signs an NDEF-only read with a hash that differs per record and is stable', () => {
    const a = read({ tech: 'unknown', source: 'webnfc', ndef: { type: 'T', value: 'abc' } }).sig;
    const b = read({ tech: 'unknown', source: 'webnfc', ndef: { type: 'T', value: 'abd' } }).sig;
    expect(a).toMatch(/^t:n[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
    expect(read({ tech: 'unknown', source: 'webnfc', ndef: { type: 'T', value: 'abc' } }).sig).toBe(
      a,
    );
  });

  it('never puts the tag in the code and keeps it for the request', () => {
    const n = read({ uid: '04a2b3c4', tech: 'a', source: 'native' });
    expect(n.code).toBeUndefined();
    expect(n.tag?.uid).toBe('04a2b3c4');
  });

  it('refuses an empty read locally but keeps it so assign can say why', () => {
    const n = read({ tech: 'unknown', source: 'webnfc' });
    expect(n.local).toBe('not_found');
    expect(n.tag).toBeDefined();
  });
});
