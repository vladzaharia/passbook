import type { z } from 'zod';
import { ScannerSettingsSchema } from '../../../shared/contracts/scan.ts';
import { SESSION_DEVICE_CAP } from '../../../shared/contracts/scan-access.ts';
import type { CreateScanningDeviceSchema } from '../../../shared/contracts/scanning-sessions.ts';
import { storedSurfaceFor, storedSurfaceOf } from '../../../shared/scan-surfaces.ts';
import { ConflictError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { resolveFollows } from './device-follows.ts';
import { scanningDeviceRows } from './repo-scanning-devices.ts';
import type { ScanningSessionRow } from './repo-scanning-sessions.ts';
import { takenScannerNames } from './repo-setup-intent.ts';
import {
  effectiveSessionSettings,
  type ResolvedSessionScope,
  resolveSessionScope,
} from './scanning-session-dto.ts';
import type { SetupCapture } from './setup-capture.ts';
import { numberedName } from './setup-names.ts';
import { planSetup, type SetupPlan, setupStatements } from './setup-statements.ts';

/** A session takes this many live devices. */

/**
 * The reads and rules of a device create under a session: it is active, its scope and settings
 * still hold, it has room, and the setup rules of `planSetup` pass. A session made in the same
 * batch is in the capture: its scope was just planned and it has no devices in the database.
 */
export async function planScanningDevice(
  ctx: ServiceContext,
  parent: ScanningSessionRow,
  input: z.infer<typeof CreateScanningDeviceSchema>,
  capture: SetupCapture,
  admin?: { userId: string; deviceKey: string },
  pairNow = true,
): Promise<{ plan: SetupPlan; scope: ResolvedSessionScope }> {
  if (parent.status !== 'active')
    throw new ConflictError(
      'Resume the scanning session before adding devices.',
      'SCANNING_SESSION_PAUSED',
    );
  const made = capture.sessions.has(parent.id);
  const scope = made
    ? // Views of a batch's devices are read after the commit, with the scope as stored then.
      {
        accepts: null,
        event: null,
        templateIds: [],
        restricted: parent.accepts !== null,
        valid: true,
      }
    : await resolveSessionScope(ctx, parent);
  const parentSettings = effectiveSessionSettings(parent);
  if (!scope.valid || !parentSettings)
    throw new ConflictError(
      'Correct this scanning session’s scope and settings before adding devices.',
      'SCANNING_SESSION_SCOPE_INVALID',
    );
  const stored = made
    ? []
    : (await scanningDeviceRows(ctx.env.DB, parent.org_id, parent.id)).filter(
        (d) => d.revoked_at === null,
      );
  const added = capture.devicesBySession.get(parent.id) ?? 0;
  if (stored.length + added >= SESSION_DEVICE_CAP)
    throw new ValidationError(
      `This session already has ${SESSION_DEVICE_CAP} devices. Remove an unused device.`,
    );
  if (input.overrides.follows && made)
    throw new ValidationError(
      'Pick scanners after the session exists.',
      [],
      'SCANNING_FOLLOWS_INVALID',
    );
  const role = input.deviceRole;
  const surface = storedSurfaceOf(role, input.surface);
  const overrides = resolveFollows(input.overrides, storedSurfaceFor(surface, null), stored);
  const settings = ScannerSettingsSchema.parse({
    ...parentSettings,
    ...overrides,
    ...(scope.restricted ? { acceptAllTemplates: false } : {}),
  });
  const name =
    input.name ??
    numberedName(parent.name, 40, await takenScannerNames(ctx.env.DB, parent.org_id, parent.mode));
  const plan = await planSetup(
    ctx,
    {
      orgId: parent.org_id,
      name,
      kind: 'device',
      deviceRole: role,
      accepts: parent.accepts ? JSON.parse(parent.accepts) : null,
      settings,
      timeZone: parent.time_zone,
      watch: role === 'scan' ? null : { scannerIds: [], allOrg: false },
      ...(admin ? { adminUserId: admin.userId } : {}),
    },
    capture,
    {
      sessionId: parent.id,
      surface,
      overrides,
      deviceKey: admin?.deviceKey,
    },
    parent,
    pairNow,
  );
  capture.devicesBySession.set(parent.id, added + 1);
  return { plan, scope };
}

/** The scanner row with its pairing code, its membership of the session and the audit rows. */
export const scanningDeviceStatements = setupStatements;
