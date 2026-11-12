import { z } from 'zod';
import { IdSchema, ModeSchema, TimestampSchema } from '../../../shared/contracts/common.ts';
import {
  ScanningSessionStatusSchema,
  ScanSurfaceChoiceSchema,
  ScanSurfaceSchema,
} from '../../../shared/contracts/scanning-sessions.ts';
import type { ScanActor } from './actor.ts';
import type { ConfigurationScopeSnapshot } from './repo-scanner-configuration-scope.ts';
import type { ScanningDeviceRow } from './repo-scanning-devices.ts';
import type { ScanningSessionRow } from './repo-scanning-sessions.ts';
import { copyScanEpochs } from './scan-epochs.ts';

export interface ObservedScanningSessionSnapshot {
  parent: ScanningSessionRow;
  device: ScanningDeviceRow;
  accepts: string;
  scope: ConfigurationScopeSnapshot | null;
}

const observedSessions = new WeakMap<
  NonNullable<ScanActor['scanningSession']>,
  ObservedScanningSessionSnapshot
>();

/** The original binding used to evaluate this actor, never a fresh configuration read. */
export function observedScanningSession(actor: ScanActor): Readonly<{
  parent: Readonly<ScanningSessionRow>;
  device: Readonly<ScanningDeviceRow>;
  accepts: string;
  scope: Readonly<ConfigurationScopeSnapshot> | null;
}> | null {
  return actor.scanningSession ? (observedSessions.get(actor.scanningSession) ?? null) : null;
}

/** Copy the original observation for an authenticated, encrypted internal envelope only. */
export function captureObservedScanningSession(
  actor: ScanActor,
): ObservedScanningSessionSnapshot | null {
  const observed = actor.scanningSession && observedSessions.get(actor.scanningSession);
  return validatedScanningObservation(actor, observed);
}

/** Restore an authenticated original observation; never reconstruct it from current rows. */
export function restoreObservedScanningSession(actor: ScanActor, value: unknown): boolean {
  const binding = actor.scanningSession;
  if (!binding) return value === null;
  observedSessions.delete(binding);
  const observed = validatedScanningObservation(actor, value);
  if (!observed) return false;
  observedSessions.set(binding, observed);
  return true;
}

/** Preserve the original session observation without sharing mutable action authority. */
export function cloneObservedScanActor(actor: ScanActor): ScanActor {
  const scanner = actor.scanner;
  const authority = actor.tenantAuthority;
  // Credential identifiers are copied as request-local scalars, never through structuredClone.
  const cloned: ScanActor = structuredClone({
    ...actor,
    platformSessionId: undefined,
    tenantAuthority: authority ? { ...authority, sessionId: '' } : undefined,
    scanner: scanner ? { ...scanner, tokenHash: null, tokenPrefix: null, csrfSecret: null } : null,
  });
  copyScanEpochs(actor, cloned);
  if (actor.platformSessionId !== undefined) cloned.platformSessionId = actor.platformSessionId;
  else delete cloned.platformSessionId;
  if (authority && cloned.tenantAuthority) cloned.tenantAuthority.sessionId = authority.sessionId;
  if (scanner && cloned.scanner) {
    cloned.scanner.tokenHash = scanner.tokenHash;
    cloned.scanner.tokenPrefix = scanner.tokenPrefix;
  }
  const observed = actor.scanningSession ? observedSessions.get(actor.scanningSession) : undefined;
  if (observed && cloned.scanningSession) {
    const tokenHash = observed.device.token_hash;
    const safe = structuredClone({ ...observed, device: { ...observed.device, token_hash: null } });
    observedSessions.set(cloned.scanningSession, {
      ...safe,
      device: { ...safe.device, token_hash: tokenHash },
    });
  }
  return cloned;
}

/** Record the workspace bound during the current guard evaluation. */
export function recordObservedScanningSession(
  binding: NonNullable<ScanActor['scanningSession']>,
  observed: ObservedScanningSessionSnapshot,
): void {
  observedSessions.set(binding, observed);
}

const observedSessionSchema = z.object({
  parent: z.object({
    id: IdSchema,
    org_id: IdSchema,
    org_name: z.string(),
    mode: ModeSchema,
    name: z.string(),
    status: ScanningSessionStatusSchema,
    accepts: z.string().nullable(),
    settings: z.string(),
    time_zone: z.string(),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    config_epoch: z.number().int(),
  }),
  device: z.object({
    scanner_id: IdSchema,
    session_id: IdSchema,
    org_id: IdSchema,
    mode: ModeSchema,
    name: z.string(),
    kind: z.enum(['device', 'terminal', 'display']),
    surface: ScanSurfaceChoiceSchema,
    effective_surface: ScanSurfaceSchema,
    overrides: z.string(),
    capabilities: z.string().nullable(),
    reported_at: TimestampSchema.nullable(),
    admin_user_id: IdSchema.nullable(),
    admin_name: z.string().nullable(),
    token_hash: z.string().nullable(),
    last_seen_at: TimestampSchema.nullable(),
    revoked_at: TimestampSchema.nullable(),
    settings: z.string(),
    updated_at: TimestampSchema,
    device_key: z.string().nullable(),
  }),
  accepts: z.string(),
  scope: z
    .object({
      orgId: IdSchema,
      mode: ModeSchema,
      scannerId: IdSchema.nullable(),
      eventIds: z.string(),
      events: z.string(),
      eventTemplates: z.string(),
      scannerTemplates: z.string(),
      templateIds: z.string(),
      templateRows: z.string(),
      stamps: z.array(
        z.object({
          releases: z.array(
            z.object({
              templateId: IdSchema,
              id: IdSchema,
              generation: z.number().int().positive(),
              version: z.string().min(1),
              candidateHash: z.string().regex(/^[0-9a-f]{64}$/),
            }),
          ),
          legacy: z.array(
            z.object({
              templateId: IdSchema,
              versions: z.array(z.string().min(1)),
              identities: z.array(
                z.object({
                  version: z.string().min(1),
                  identityId: IdSchema,
                  identityRevision: z.number().int().positive(),
                }),
              ),
            }),
          ),
        }),
      ),
      unusable: z.array(z.string()),
    })
    .nullable(),
});

/** An authenticated envelope may restore only the same original actor/workspace association. */
function observationMatchesActor(
  actor: ScanActor,
  observed: ObservedScanningSessionSnapshot,
): boolean {
  const binding = actor.scanningSession;
  const scanner = actor.scanner;
  const { parent, device, scope } = observed;
  return (
    !!binding &&
    !!scanner &&
    !!scope &&
    scanner.orgId === actor.orgId &&
    scanner.mode === actor.mode &&
    parent.id === binding.id &&
    parent.status === binding.status &&
    parent.updated_at === binding.updatedAt &&
    parent.org_id === actor.orgId &&
    parent.mode === actor.mode &&
    device.scanner_id === scanner.id &&
    device.session_id === parent.id &&
    device.org_id === actor.orgId &&
    device.mode === actor.mode &&
    device.updated_at === scanner.updatedAt &&
    device.name === scanner.name &&
    device.kind === scanner.kind &&
    device.settings === scanner.settings &&
    device.token_hash === scanner.tokenHash &&
    device.revoked_at === scanner.revokedAt &&
    scope.scannerId === scanner.id &&
    scope.orgId === actor.orgId &&
    scope.mode === actor.mode
  );
}
/** Validate a deserialized observation against its original actor. */
export function validatedScanningObservation(
  actor: ScanActor,
  value: unknown,
): ObservedScanningSessionSnapshot | null {
  const parsed = observedSessionSchema.safeParse(value);
  return parsed.success && observationMatchesActor(actor, parsed.data) ? parsed.data : null;
}
