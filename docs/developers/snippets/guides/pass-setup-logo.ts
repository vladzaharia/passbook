import { readFile } from 'node:fs/promises';
import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const png = Buffer.from(await readFile('logo@3x.png')).toString('base64');
const staged = await pb.orgs.stageBrandAsset('0193a1b2-7c00-7000-8000-0000000000a1', {
  slot: 'logo',
  png,
});

console.log(staged.sha, staged.version);
