import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });
const templateId = '0193a1b2-7c00-7000-8000-0000000000b1';
const template = await pb.templates.retrieve(templateId);
const version = template.versions[0]?.version ?? '';

// Makes the Test and Live candidates and emails the org's other reviewers. Nothing is released.
const requested = await pb.templates.reviews.request(templateId, { version });

console.log(requested.modes.live?.outcome);
