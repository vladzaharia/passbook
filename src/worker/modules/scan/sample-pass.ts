import type { TemplateManifest } from '../../../passkit/types.ts';
import { batch } from '../../platform/db.ts';
import { ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditStmt } from '../audit/repo.ts';
import { createPassRow } from '../passes/service.ts';
import { firstTemplateManifest, getConsoleScanner } from './repo-scanners.ts';
import { eventTemplateIds } from './repo-scope.ts';

/** One test pass of the first accepted template, filled from its sample inputs, with no holder. */
export async function createSamplePass(ctx: ServiceContext, userId: string, id: string) {
  const db = ctx.env.DB;
  const row = await getConsoleScanner(db, id);
  if (!row) throw new ValidationError('Scanner not found.', [], 'SCANNER_NOT_FOUND');
  if (row.mode !== 'test')
    throw new ValidationError('Sample passes are for test scanners.', [], 'SAMPLE_TEST_ONLY');
  const templateIds = row.eventId
    ? await eventTemplateIds(db, row.orgId, row.eventId)
    : row.templateIds;
  const template = templateIds.length
    ? await firstTemplateManifest(db, row.orgId, templateIds)
    : null;
  if (!template)
    throw new ValidationError('Choose what this scanner accepts first.', [], 'SCANNER_UNASSIGNED');
  const manifest = JSON.parse(template.manifest) as TemplateManifest;
  const pass = await createPassRow(ctx, {
    orgId: row.orgId,
    templateId: template.id,
    input: manifest.sample,
    source: 'manual',
    mode: 'test',
    actor: { type: 'user', id: userId },
  });
  await batch(db, [
    auditStmt(db, ctx, {
      orgId: row.orgId,
      actorType: 'user',
      actorId: userId,
      action: 'scanner.sample_pass',
      targetType: 'scanner',
      targetId: id,
      detail: { passId: pass.id, templateId: template.id },
    }),
  ]);
  return { passId: pass.id, templateId: template.id };
}
