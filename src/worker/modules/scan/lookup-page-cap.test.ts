import { beforeEach, describe, expect, it } from 'vitest';
import {
  cloneLookupPasses,
  kit,
  roleRestrictedTemplate,
  search,
  setupLookupIdsFixture,
  templateId,
} from './repo-lookup-ids-test-fixtures.ts';

beforeEach(setupLookupIdsFixture);

describe('lookup paging cap', () => {
  it('stops after four pages of names hidden for the role and answers more', async () => {
    const restricted = await roleRestrictedTemplate();
    const hidden = await kit.scanPass(restricted, { memberName: 'Capped Alpha' });
    await cloneLookupPasses(hidden.id, 'hidden', 'Capped Alpha ', 199);
    const visible = await kit.scanPass(templateId, { memberName: 'Capped Zulu' });
    const scanner = await kit.scanner({ templateIds: [restricted, templateId] });

    // Control: the visible name is found when the hidden ones are not in the way.
    const direct = await search('Capped Zulu', scanner.headers);
    expect(direct.items.map((item) => item.passId)).toEqual([visible.id]);

    // 200 hidden matches fill the four examined pages; the visible one sorts after them.
    const capped = await search('Capped', scanner.headers);
    expect(capped).toEqual({ items: [], more: true });
  }, 30_000);
});
