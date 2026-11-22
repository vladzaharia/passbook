import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const setup = await pb.orgs.retrievePassSetup('0193a1b2-7c00-7000-8000-0000000000a1');

console.log(setup.revision, setup.checks.map((c) => `${c.code} ${c.fix.action}`));
