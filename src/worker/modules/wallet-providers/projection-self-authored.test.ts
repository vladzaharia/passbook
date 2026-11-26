import { describe, expect, it } from 'vitest';
import { listProjectionCandidates } from './projection-service.ts';
import { isSelfAuthored, SYSTEM_AUTHOR } from './projection-system-authority.ts';
import {
  approveOf,
  candidateOf,
  installV2Env,
  pinsOf,
  request,
  setup,
} from './projection-v2-test-fixtures.ts';

installV2Env();

describe('isSelfAuthored', () => {
  it('counts a person own candidate and own version', () => {
    expect(isSelfAuthored('u1', { authorId: 'u1', versionAuthorId: 'u2' })).toBe(true);
    expect(isSelfAuthored('u1', { authorId: 'u2', versionAuthorId: 'u1' })).toBe(true);
    expect(isSelfAuthored('u3', { authorId: 'u2', versionAuthorId: 'u1' })).toBe(false);
  });

  it('does not count the version author as the author of a platform candidate', () => {
    expect(isSelfAuthored('u1', { authorId: SYSTEM_AUTHOR, versionAuthorId: 'u1' })).toBe(false);
  });
});

describe('the candidate list says whose work approving would be', () => {
  it('marks the author own candidate and not another reviewer', async () => {
    const kit = await setup();
    await candidateOf(kit, request((await pinsOf(kit)).approvedOmissions));
    const asAuthor = await listProjectionCandidates(kit.ctx, kit.author, kit.templateId, kit.scope);
    const asReviewer = await listProjectionCandidates(
      kit.ctx,
      kit.reviewer,
      kit.templateId,
      kit.scope,
    );
    expect(asAuthor.items.map((c) => c.selfAuthored)).toEqual([true]);
    expect(asReviewer.items.map((c) => c.selfAuthored)).toEqual([false]);
  });
});

describe('the candidate list says how an approval was recorded', () => {
  it('carries the approval kind', async () => {
    const kit = await setup();
    const candidate = await candidateOf(kit, request((await pinsOf(kit)).approvedOmissions));
    await approveOf(kit, candidate);
    const list = await listProjectionCandidates(kit.ctx, kit.author, kit.templateId, kit.scope);
    expect(list.items[0]?.approvals.map((a) => a.kind)).toEqual(['peer']);
  });
});
