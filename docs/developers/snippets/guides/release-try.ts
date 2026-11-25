import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

// The draft from the first step. In your code, keep its id and version from the answer.
const { items } = await pb.templates.list();
const templateId = items.find((t) => t.name === 'Door tickets')?.id ?? '';
const template = await pb.templates.retrieve(templateId);
const version = template.versions[0]?.version ?? '';

// Try: release to Test only. A key may name only test.
const options = { idempotencyKey: `try-${version}` };
const body = { version, modes: ['test' as const] };
const first = await pb.templates.releases.release(templateId, body, options);

// The same key returns the stored answer; nothing is released twice.
const again = await pb.templates.releases.release(templateId, body, options);

console.log(first.modes.test?.outcome, JSON.stringify(first) === JSON.stringify(again));
