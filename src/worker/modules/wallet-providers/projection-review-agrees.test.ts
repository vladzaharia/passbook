import { afterEach, describe, expect, it } from 'vitest';
import type { TemplateCandidate } from '../../../shared/contracts/template-releases.ts';
import { walletReview } from '../../../web/admin/templates/releases/wallet-review.ts';
import { offersPaused } from './projection-pause.ts';
import { getApprovedProjection } from './projection-service.ts';
import { currentReview } from './projection-review-current.ts';
import {
  addsSharingLoss,
  candidateOf,
  installV2Env,
  type Kit,
  lookup,
  pinsOf,
  released,
  request,
  setup,
  updateCompiler,
} from './projection-v2-test-fixtures.ts';

installV2Env();

let restore: (() => void)[] = [];
afterEach(() => {
  for (const undo of restore.reverse()) undo();
  restore = [];
});
const patch = (...args: Parameters<typeof updateCompiler>) => {
  restore.push(updateCompiler(...args));
};

/**
 * The release row's state (CW8c, from the report compiled now against the pinned approval) and the
 * offer paths' Q21 pause (from the pipeline) are two computations. They must say the same thing about
 * the same release: a row that reads Released while offers wait, or Review needed while they flow, is a bug.
 */
async function both(
  kit: Kit,
  candidate: TemplateCandidate,
  release: Awaited<ReturnType<typeof released>>,
) {
  const current = await currentReview(kit.ctx, { ...kit.scope, templateId: kit.templateId });
  if (!current) throw new Error('No current review.');
  const approved = await getApprovedProjection(kit.ctx, lookup(kit));
  if (!approved) throw new Error('Release is not current.');
  return {
    row: walletReview(current, release, [candidate]).kind,
    paused: await offersPaused(kit.ctx, approved),
  };
}

async function published(kit: Kit) {
  const candidate = await candidateOf(kit, request((await pinsOf(kit)).approvedOmissions));
  return { candidate, release: await released(kit, candidate) };
}

describe('the release row and the Q21 pause agree', () => {
  it('reads Released while offers flow when nothing changed', async () => {
    const kit = await setup();
    const { candidate, release } = await published(kit);
    expect(await both(kit, candidate, release)).toEqual({ row: 'released', paused: false });
  });

  it('reads Released while offers flow when a compiler update only carries forward', async () => {
    const kit = await setup();
    const { candidate, release } = await published(kit);
    patch(undefined, 1);
    expect(await both(kit, candidate, release)).toEqual({ row: 'released', paused: false });
  });

  it('reads Review needed while offers wait when a compiler update adds an omission', async () => {
    const kit = await setup();
    const { candidate, release } = await published(kit);
    patch(addsSharingLoss, 2);
    expect(await both(kit, candidate, release)).toEqual({ row: 'review', paused: true });
  });

  it('does not read Released while offers wait when a compiler update changes the type', async () => {
    const kit = await setup();
    const { candidate, release } = await published(kit);
    patch((result) => ({ ...result, type: `${result.type}-other` }), 1);
    const state = await both(kit, candidate, release);
    expect(state.paused).toBe(true);
    expect(state.row).not.toBe('released');
  });

  it('reads Blocked while offers wait when a compiler update blocks the pass', async () => {
    const kit = await setup();
    const { candidate, release } = await published(kit);
    patch(
      (result) => ({ ...result, blocked: { code: 'REQUIRED_ROLE_EMPTY', message: 'No title.' } }),
      1,
    );
    expect(await both(kit, candidate, release)).toEqual({ row: 'blocked', paused: true });
  });
});
