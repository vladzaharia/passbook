import { batch } from '../../platform/db.ts';
import { ForbiddenError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditStmt } from '../audit/repo.ts';
import { resolveTemplate } from '../passes/builder.ts';
import { createPassRow } from '../passes/create.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { requireApprovedRelease } from '../templates/releases.ts';
import { firstSampleTemplate, getConsoleScanner } from './repo-scanners.ts';
import { requirePairingAuthority } from './repo-scanners-pair.ts';
import { scanningDeviceRow } from './repo-scanning-devices.ts';
import { scanningSessionForDevice } from './repo-scanning-sessions.ts';
import { readScannerScope } from './repo-scope.ts';
import type { SampleScannerScope } from './sample-scope-fence.ts';
import {
  conflictsWithAllScope,
  effectiveSessionSettings,
  resolveSessionScope,
} from './scanning-session-dto.ts';

/** One test pass of the first accepted template, filled from its sample inputs, with no holder. */
export async function createSamplePass(
  ctx: ServiceContext,
  userId: string,
  id: string,
  authority: TenantPassWrite,
  passAuthority: TenantPassWrite,
) {
  const db = ctx.env.DB;
  const row = await getConsoleScanner(db, id);
  if (!row) throw new ValidationError('Scanner not found.', [], 'SCANNER_NOT_FOUND');
  requirePairingAuthority(authority, userId, row.orgId);
  if (
    authority.mode !== 'test' ||
    !passAuthority ||
    passAuthority.kind !== 'session' ||
    passAuthority.orgId !== row.orgId ||
    passAuthority.userId !== userId ||
    passAuthority.capability !== 'passes:operate' ||
    passAuthority.mode !== 'test' ||
    passAuthority.sessionId !== authority.sessionId ||
    passAuthority.membershipId !== authority.membershipId
  )
    throw new ForbiddenError();
  if (row.mode !== 'test')
    throw new ValidationError('Sample passes are for test scanners.', [], 'SAMPLE_TEST_ONLY');
  const [scope, session, device] = await Promise.all([
    readScannerScope(db, row, null),
    scanningSessionForDevice(db, row.orgId, row.id),
    scanningDeviceRow(db, row.orgId, row.id),
  ]);
  if (!!session !== !!device)
    throw new ValidationError('Choose what this scanner accepts first.', [], 'SCANNER_UNASSIGNED');
  let templateIds = row.eventId !== null ? scope.templateIds : row.templateIds;
  let sessionSnapshot: SampleScannerScope['session'] = null;
  if (session && device) {
    const sessionScope = await resolveSessionScope(ctx, session);
    const settings = effectiveSessionSettings(session, device);
    if (
      session.mode !== row.mode ||
      device.mode !== row.mode ||
      device.session_id !== session.id ||
      !sessionScope.valid ||
      !settings ||
      (await conflictsWithAllScope(ctx, row, sessionScope, settings))
    )
      throw new ValidationError(
        'Choose what this scanner accepts first.',
        [],
        'SCANNER_UNASSIGNED',
      );
    templateIds = sessionScope.templateIds;
    sessionSnapshot = {
      row: {
        id: session.id,
        org_id: session.org_id,
        mode: session.mode,
        status: session.status,
        accepts: session.accepts,
        settings: session.settings,
        time_zone: session.time_zone,
        updated_at: session.updated_at,
      },
      device: {
        scanner_id: device.scanner_id,
        session_id: device.session_id,
        org_id: device.org_id,
        mode: device.mode,
        surface: device.surface,
        effective_surface: device.effective_surface,
        overrides: device.overrides,
        admin_user_id: device.admin_user_id,
        device_key: device.device_key,
      },
      scope: {
        event: sessionScope.event ? { ...sessionScope.event } : null,
        templateIds: [...sessionScope.templateIds],
        restricted: sessionScope.restricted,
      },
    };
  }
  const template = templateIds.length
    ? await firstSampleTemplate(db, row.orgId, templateIds)
    : null;
  if (!template)
    throw new ValidationError('Choose what this scanner accepts first.', [], 'SCANNER_UNASSIGNED');
  const release = await requireApprovedRelease(ctx, template.id, row.orgId, row.mode, 'apple');
  if (!scope.valid || (!sessionSnapshot && !scope.templateIds.includes(template.id)))
    throw new ValidationError('Choose what this scanner accepts first.', [], 'SCANNER_UNASSIGNED');
  const sampleScannerScope: SampleScannerScope = {
    scanner: {
      id: row.id,
      orgId: row.orgId,
      mode: row.mode,
      kind: row.kind,
      deviceRole: row.deviceRole,
      eventId: row.eventId,
      settings: row.settings,
      timeZone: row.timeZone,
      updatedAt: row.updatedAt,
      revokedAt: row.revokedAt,
    },
    scannerScope: {
      event: scope.event ? { ...scope.event } : null,
      templateIds: [...scope.templateIds],
    },
    session: sessionSnapshot,
  };
  const manifest = (await resolveTemplate(ctx, row.orgId, template.id, release.version)).manifest;
  const pass = await createPassRow(ctx, {
    orgId: row.orgId,
    templateId: template.id,
    templateVersion: release.version,
    releaseId: release.id,
    releaseGeneration: release.generation,
    input: manifest.sample,
    source: 'manual',
    mode: row.mode,
    actor: { type: 'user', id: userId },
    execution: {
      kind: 'tenant',
      authority: passAuthority,
      additionalAuthority: authority,
      sampleScannerScope,
    },
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
