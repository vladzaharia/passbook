import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

// The draft from the last step. In your code, keep its id and version from the answer.
const { items } = await pb.templates.list();
const templateId = items.find((t) => t.name === 'Door tickets')?.id ?? '';
const template = await pb.templates.retrieve(templateId);
const version = template.versions[0]?.version ?? '';

// dryRun writes nothing. It answers the plan: what each mode does, the impact and the diff.
const plan = await pb.templates.releases.release(
  templateId,
  { version, modes: ['test'] },
  { query: { dryRun: 'true' } },
);

console.log(plan);
