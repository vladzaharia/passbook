import { beforeAll, describe, expect, it } from 'vitest';
import { makeUser } from '../../../../test/helpers/index.ts';
import { makeJoinLink } from '../../../../test/helpers/join.ts';
import { run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { attachWaitingPassesForEmail } from '../holders/service-attach.ts';
import { resumeVerifiedHolderAttachments } from '../holders/transfer-jobs.ts';
import { createPassRow } from '../passes/create.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { joinTemplate } from './join-test-fixtures.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit({ template: (id) => joinTemplate(id) });
});

const owner = async (id: string) => (await getPass(kit.env.DB, id))?.ownerUserId ?? null;

describe('a joined pass is attached only by its owner signing in', () => {
  it("the minute sweep leaves the owner NULL; the verified owner's sign-in attaches it", async () => {
    const email = `join-attach-${kit.fx.ids.token(6).toLowerCase()}@example.com`;
    const user = await makeUser(kit.fx, { primaryEmail: email });
    const live = kit.liveRelease;
    if (!live) throw new Error('release');
    const l = await makeJoinLink(kit.fx, { orgId: kit.org.id, templateId: kit.template.id });
    await run(kit.env.DB, 'UPDATE join_links SET ask_email = 1 WHERE id = ?', [l.id]);
    const joined = await createPassRow(kit.ctx, {
      orgId: kit.org.id,
      templateId: kit.template.id,
      templateVersion: live.version,
      input: { memberName: 'Joined' },
      holderEmail: email,
      source: 'manual',
      mode: 'live',
      execution: { kind: 'join', linkId: l.id, generation: l.generation, orgDailyCap: 1000 },
      actor: { type: 'system', id: `join:${l.id}` },
    });
    // The sweep pages the whole table; run it until it has passed this pass.
    for (let i = 0; i < 4; i++) await resumeVerifiedHolderAttachments(jobCtxOf(kit));
    expect(await owner(joined.id)).toBeNull();
    // Positive control: an operator pass with the same address attaches by the sweep.
    const operated = await kit.pass({ holderEmail: email });
    for (let i = 0; i < 4 && (await owner(operated.id)) === null; i++)
      await resumeVerifiedHolderAttachments(jobCtxOf(kit));
    expect(await owner(operated.id)).toBe(user.id);
    expect(await owner(joined.id)).toBeNull();
    // The owner's own sign-in is the proof for the joined card; another account's is not.
    const stranger = await makeUser(kit.fx, {
      primaryEmail: `join-attach-${kit.fx.ids.token(6).toLowerCase()}@example.com`,
    });
    expect(await attachWaitingPassesForEmail(jobCtxOf(kit), stranger.id, email)).toBe(0);
    expect(await owner(joined.id)).toBeNull();
    expect(await attachWaitingPassesForEmail(jobCtxOf(kit), user.id, email)).toBe(1);
    expect(await owner(joined.id)).toBe(user.id);
  });
});
