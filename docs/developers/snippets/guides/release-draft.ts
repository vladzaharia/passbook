import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

// A copy of a blueprint is a template with one saved version and nothing released.
const template = await pb.blueprints.use('baked:starter-event-ticket', {
  orgId: '0193a1b2-7c00-7000-8000-0000000000a1',
  name: 'Door tickets',
});
console.log(template.id, template.versions[0]?.version);
