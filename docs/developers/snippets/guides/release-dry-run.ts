import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });
const templateId = '0193a1b2-7c00-7000-8000-0000000000b1';

// The newest saved version is the one to release.
const template = await pb.templates.retrieve(templateId);
const version = template.versions[0]?.version ?? '';

// dryRun writes nothing. It answers the plan: what each mode does, the impact and the diff.
const plan = await pb.templates.releases.release(
  templateId,
  { version, modes: ['test'] },
  { query: { dryRun: 'true' } },
);

console.log(plan);
