import { describe, expect, it } from 'vitest';
import { omissionKeys } from '../../../passkit/wallets/fidelity.ts';
import { listProjectionCandidates } from './projection-service.ts';
import { installV2Env, pinsOf, setup } from './projection-v2-test-fixtures.ts';

installV2Env();

describe('candidate list: current review', () => {
  it('carries the report of the version the Apple release serves, with its source release', async () => {
    const kit = await setup();
    const list = await listProjectionCandidates(kit.ctx, kit.author, kit.templateId, kit.scope);
    expect(list.current).toMatchObject({
      version: kit.version,
      sourceReleaseId: kit.sourceId,
      report: { target: 'google' },
    });
    expect(omissionKeys(list.current?.report ?? ({ items: [] } as never))).toEqual(
      (await pinsOf(kit)).approvedOmissions,
    );
  });
});
