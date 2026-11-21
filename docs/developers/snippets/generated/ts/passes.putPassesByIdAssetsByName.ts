import { readFile } from 'node:fs/promises';
import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.passes.assets.upload('0193a1b2-7c00-7000-8000-0000000000c1', 'icon.png', await readFile('image.png'));
console.log(result);
