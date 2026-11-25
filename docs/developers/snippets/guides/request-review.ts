import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

// The draft from the first step. In your code, keep its id and version from the answer.
const { items } = await pb.templates.list();
const templateId = items.find((t) => t.name === 'Door tickets')?.id ?? '';
const template = await pb.templates.retrieve(templateId);
const version = template.versions[0]?.version ?? '';

// Makes the candidates and emails the org's other reviewers. Nothing is released.
// With no other reviewer, as in a sandbox, no review opens and state.review.state stays none.
const requested = await pb.templates.reviews.request(templateId, { version });

console.log(requested.state.review);
