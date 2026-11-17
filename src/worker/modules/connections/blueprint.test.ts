import { beforeEach, describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { captureConnectionRelease } from './record-issuance.ts';
import { getConnection } from './repo.ts';
import * as service from './service.ts';
import { createDemo, type Kit, makeKit } from './test-kit.ts';

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit();
});

const flag = (blueprint: 0 | 1) =>
  run(kit.env.DB, 'UPDATE templates SET blueprint = ? WHERE id = ?', [blueprint, kit.templateId]);
const refused = { code: 'TEMPLATE_IS_BLUEPRINT', status: 409 };

describe('a blueprint as the connection template', () => {
  it('is refused on create and update; a template is accepted', async () => {
    await flag(1);
    await expect(
      createDemo(kit, { defaultTemplateId: kit.templateId, autoCreate: true }),
    ).rejects.toMatchObject(refused);
    const dto = await createDemo(kit);
    await expect(
      service.update(kit.sctx, kit.actor, dto.id, { defaultTemplateId: kit.templateId }),
    ).rejects.toMatchObject(refused);
    await flag(0);
    const ok = await createDemo(kit, { defaultTemplateId: kit.templateId, autoCreate: true });
    expect(ok.defaultTemplateId).toBe(kit.templateId);
  });

  it('skips new records of a connection left on a blueprint, with the code', async () => {
    const dto = await createDemo(kit, { defaultTemplateId: kit.templateId, autoCreate: true });
    const conn = await getConnection(kit.env.DB, dto.id);
    if (!conn) throw new Error('The connection is missing');
    expect(await captureConnectionRelease(kit.sctx, conn)).toMatchObject({ kind: 'approved' });
    await flag(1);
    expect(await captureConnectionRelease(kit.sctx, conn)).toEqual({
      kind: 'blocked',
      code: 'TEMPLATE_IS_BLUEPRINT',
    });
  });
});
