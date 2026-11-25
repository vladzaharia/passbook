import { describe, expect, it } from 'vitest';
import { readUpload } from './read-upload.ts';

const named = (bytes: number[] | string, name: string) =>
  new File(
    [new Uint8Array(typeof bytes === 'string' ? [...new TextEncoder().encode(bytes)] : bytes)],
    name,
  );

describe('readUpload', () => {
  it('sends UTF-8 text as text', async () => {
    expect(await readUpload(named('id,name\n1,Zoë\n', 'a.csv'))).toEqual({
      name: 'a.csv',
      content: 'id,name\n1,Zoë\n',
      encoding: 'utf8',
    });
  });

  it('sends a zip (an XLSX) as base64', async () => {
    const body = await readUpload(named([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00], 'a.xlsx'));
    expect(body).toEqual({
      name: 'a.xlsx',
      content: btoa('PK\u0003\u0004ÿ\u0000'),
      encoding: 'base64',
    });
  });

  it('sends bytes that are not UTF-8 as base64, so the server names the format', async () => {
    const body = await readUpload(named([0xd0, 0xcf, 0x11, 0xe0], 'old.xls'));
    expect(body.encoding).toBe('base64');
  });
});
