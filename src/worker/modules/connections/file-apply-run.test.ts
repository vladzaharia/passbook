import { beforeEach, describe, expect, it } from 'vitest';
import { makeSession } from '../../../../test/helpers/index.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { all, run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { authorizeConnection, type ConnectionAuthority } from './access.ts';
import * as actions from './actions.ts';
import { csvBody } from './files-fixtures.ts';
import { uploadRevision } from './files-revisions.ts';
import { createDraft } from './files-service.ts';
import * as service from './service.ts';
import { addMembership, type Kit, makeKit, withWorkflow } from './test-kit.ts';

let kit: Kit;
let authority: ConnectionAuthority;
beforeEach(async () => {
  kit = await makeKit();
  await addMembership(kit, kit.actor.id, ['integration_admin']);
  const fixture = await makeSession(kit, { userId: kit.actor.id });
  const session = (await createSessionStore(kit.env, kit.clock).resolve(
    fixture.cookieValue,
  )) as SessionAuth;
  authority = await authorizeConnection(kit.sctx, session, kit.org.id, 'integrations:manage');
});

const rows = (...ids: string[]) => [['id', 'name'], ...ids.map((id) => [id, `Name ${id}`])];
const SIX = rows('m-1', 'm-2', 'm-3', 'm-4', 'm-5', 'm-6');

async function connect() {
  const draft = await createDraft(kit.sctx, kit.actor, authority, csvBody(SIX));
  return service.create(kit.sctx, kit.actor, {
    orgId: kit.org.id,
    connectorType: 'file-upload',
    name: 'F',
    config: { idColumn: '/id' },
    mode: 'manual',
    fileId: draft.id,
  } as never);
}

/** Closes the run the way a finished workflow does. */
const finishRuns = async (connectionId: string) => {
  await run(
    kit.env.DB,
    "UPDATE connection_runs SET outcome = 'changed', finished_at = 1 WHERE connection_id = ? AND outcome = 'running'",
    [connectionId],
  );
  await run(
    kit.env.DB,
    "UPDATE workflow_runs SET status = 'complete', finished_at = 1 WHERE target_id = ?",
    [connectionId],
  );
};

describe('Apply starts a run of its own', () => {
  it('starts one for each applied file, even in the same 30 seconds as a finished run', async () => {
    const dto = await connect();
    const wf = withWorkflow(kit, undefined, () => 'complete');
    const up = (csv: string[][]) =>
      uploadRevision(wf.sctx, kit.actor, authority, dto.id, csvBody(csv), true);
    await up(rows('m-1', 'm-2', 'm-3', 'm-4', 'm-5'));
    await finishRuns(dto.id);
    await up(SIX);
    expect(wf.created).toHaveLength(2);
    expect(new Set(wf.created.map((c) => c.id)).size).toBe(2);
  });

  it('replaces a Sync now that is still running, and records it as superseded', async () => {
    const dto = await connect();
    const wf = withWorkflow(kit, undefined, () => 'running');
    const first = await actions.syncNow(wf.sctx, kit.actor, dto.id, authority);
    await uploadRevision(wf.sctx, kit.actor, authority, dto.id, csvBody(rows('m-1', 'm-2')), true);
    expect(wf.created).toHaveLength(2);
    expect(wf.created[1]?.id).not.toBe(first.runId);
    const runs = await all<{ id: string; outcome: string; error_code: string | null }>(
      kit.env.DB,
      'SELECT id, outcome, error_code FROM connection_runs WHERE connection_id = ?',
      [dto.id],
    );
    expect(runs.find((r) => r.id === first.runId)).toMatchObject({
      outcome: 'skipped',
      error_code: 'SUPERSEDED',
    });
    expect(runs.find((r) => r.id === wf.created[1]?.id)?.outcome).toBe('running');
  });

  it('asks the old workflow instance to stop', async () => {
    const dto = await connect();
    const wf = withWorkflow(kit, undefined, () => 'running');
    const terminated: string[] = [];
    const binding = wf.sctx.env.CONNECTION_SYNC as unknown as {
      get: (id: string) => Promise<unknown>;
    };
    const get = binding.get;
    binding.get = async (id: string) => ({
      ...((await get(id)) as object),
      terminate: async () => void terminated.push(id),
    });
    const first = await actions.syncNow(wf.sctx, kit.actor, dto.id, authority);
    await uploadRevision(wf.sctx, kit.actor, authority, dto.id, csvBody(rows('m-1', 'm-2')), true);
    expect(terminated).toContain(first.runId);
  });
});
