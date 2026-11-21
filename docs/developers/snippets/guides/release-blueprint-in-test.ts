import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });
const orgId = '0193a1b2-7c00-7000-8000-0000000000a1';
const scope = { orgId, mode: 'test', provider: 'apple' } as const;

// Copy a blueprint into your organization.
const template = await pb.blueprints.use('baked:starter-event-ticket', { orgId, name: 'Door tickets' });
const version = template.activeVersion ?? template.versions[0]?.version ?? '';

// Test mode lets a key approve its own candidate; live approval stays with a person.
const candidate = await pb.templates.candidates.create(template.id, { ...scope, version });
const approval = await pb.templates.candidates.approve(template.id, candidate.id, {
  ...scope,
  candidateHash: candidate.candidateHash,
  alone: true,
});
const release = await pb.templates.releases.create(template.id, {
  ...scope,
  candidateId: candidate.id,
  approvalId: approval.id,
  candidateHash: candidate.candidateHash,
  expectedGeneration: 0,
});

const pass = await pb.passes.create({
  orgId,
  templateId: template.id,
  templateVersion: release.version,
  releaseId: release.id,
  releaseGeneration: release.generation,
  mode: 'test',
  input: (template.manifest as { sample?: Record<string, unknown> }).sample ?? {},
  externalId: 'first-pass',
});

console.log(pass.id, pass.mode);
