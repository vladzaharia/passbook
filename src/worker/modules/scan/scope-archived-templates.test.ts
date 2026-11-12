import { describe, expect, it } from 'vitest';
import { makeTemplate } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import {
  admin,
  f,
  orgId,
  persistApprovedTemplate,
  send,
  setupScannerFixture,
} from './scanners-split-test-fixtures.ts';

setupScannerFixture();

async function template(): Promise<string> {
  const t = makeTemplate({ id: f.ids.id(), orgId });
  await persistApprovedTemplate(t);
  return t.resolved.id;
}
const setStatus = (id: string, status: 'archived' | 'deleted') =>
  run(f.env.DB, 'UPDATE templates SET status=? WHERE id=?', [status, id]);

/** Each console scope that holds templates: where it is created and edited. */
const SCOPES = {
  scanner: { base: '/api/v1/scanners', extra: { kind: 'device' } },
  setup: { base: '/api/v1/scan-setups', extra: {} },
  session: { base: '/api/v1/scanning-sessions', extra: {} },
} as const;

describe.each(Object.keys(SCOPES) as (keyof typeof SCOPES)[])(
  'archived templates on a %s',
  (kind) => {
    const { base, extra } = SCOPES[kind];
    const create = (templateIds: string[]) =>
      send('POST', base, admin(), {
        orgId,
        name: `Scope ${f.ids.token(3)}`,
        timeZone: 'UTC',
        accepts: { templateIds },
        ...extra,
      });
    const edit = (id: string, templateIds: string[], name = `Renamed ${f.ids.token(3)}`) =>
      send('PATCH', `${base}/${id}`, admin(), { name, accepts: { templateIds } });

    it('keeps an archived template already attached and refuses a deleted one', async () => {
      const kept = await template();
      const other = await template();
      const made = await create([kept, other]);
      expect(made.status).toBe(201);
      const { id } = (await made.json()) as { id: string };
      await setStatus(kept, 'archived');
      // The console sends the whole scope on every save.
      const saved = await edit(id, [kept, other]);
      expect(saved.status).toBe(200);
      await setStatus(other, 'deleted');
      const deleted = await edit(id, [kept, other]);
      expect(deleted.status).toBe(404);
      expect(await deleted.json()).toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
    });

    it('refuses a newly added archived template with 422 TEMPLATE_ARCHIVED, and takes an active one', async () => {
      const kept = await template();
      const archived = await template();
      await setStatus(archived, 'archived');
      const refusedCreate = await create([archived]);
      expect(refusedCreate.status).toBe(422);
      expect(await refusedCreate.json()).toMatchObject({ code: 'TEMPLATE_ARCHIVED' });
      const made = await create([kept]);
      expect(made.status).toBe(201);
      const { id } = (await made.json()) as { id: string };
      const refusedAdd = await edit(id, [kept, archived]);
      expect(refusedAdd.status).toBe(422);
      expect(await refusedAdd.json()).toMatchObject({ code: 'TEMPLATE_ARCHIVED' });
      const active = await template();
      expect((await edit(id, [kept, active])).status).toBe(200);
    });
  },
);

describe('a scanning session holding an archived template', () => {
  it('still takes a new device, which inherits the template', async () => {
    const kept = await template();
    const made = await send('POST', '/api/v1/scanning-sessions', admin(), {
      orgId,
      name: 'Archived scope',
      timeZone: 'UTC',
      accepts: { templateIds: [kept] },
    });
    expect(made.status).toBe(201);
    const { id } = (await made.json()) as { id: string };
    await setStatus(kept, 'archived');
    const added = await send('POST', `/api/v1/scanning-sessions/${id}/devices`, admin(), {
      name: 'Door after archive',
    });
    expect(added.status).toBe(201);
  });
});
