import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });
const templateId = '0193a1b2-7c00-7000-8000-0000000000b1';
const template = await pb.templates.retrieve(templateId);
const version = template.versions[0]?.version ?? '';

// Try: release to Test only. A key may name only test.
const options = { idempotencyKey: `try-${version}` };
const body = { version, modes: ['test' as const] };
const first = await pb.templates.releases.release(templateId, body, options);

// The same key returns the stored answer; nothing is released twice.
const again = await pb.templates.releases.release(templateId, body, options);

console.log(first.modes.test?.outcome, JSON.stringify(first) === JSON.stringify(again));
