import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const pass = await pb.passes.restore('0193a1b2-7c00-7000-8000-0000000000c1');

console.log(pass.status);
