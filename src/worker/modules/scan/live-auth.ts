import { ZodError, z } from 'zod';
import { IdSchema } from '../../../shared/contracts/common.ts';
import { SESSION_DEVICE_CAP } from '../../../shared/contracts/scan-access.ts';
import { ScanWatchSchema } from '../../../shared/contracts/scan-setups.ts';
import {
  ScanDeviceOverridesSchema,
  ScanningSessionSettingsSchema,
  type SessionCustomerSettings,
} from '../../../shared/contracts/scanning-sessions.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { credentialRefKeysetCommitment } from '../passes/credential-keyset.ts';
import type { ScanActor } from './actor.ts';
import { liveActorSchema } from './live-actor-schema.ts';
import {
  type LiveAttachmentTenant,
  sameAuthorityValue,
  sameSession,
  tenantReadAuthority,
} from './live-auth-guards.ts';
import { liveRecipientStmt } from './repo-live-render.ts';
import { scanReadAuthority } from './repo-read-authority.ts';
import { type ScanAuthorityEpochs, scanEpochsOf, setScanEpochs } from './scan-epochs.ts';
import {
  captureObservedScanningSession,
  cloneObservedScanActor,
  type ObservedScanningSessionSnapshot,
  restoreObservedScanningSession,
} from './scanning-workspace-observation.ts';

type SessionBinding = NonNullable<ScanActor['scanningSession']>;

export interface LiveAttachment extends LiveAttachmentTenant {
  scannerId: string;
  /** `device`: the control socket of a scan-role device, which carries no rows. */
  role: 'customer' | 'monitor' | 'device';
  tokenHash: string;
  /** The original scanner proof; null is an explicit unpaired-admin credential. */
  scannerCsrfProof: string | null;
  credentialKeysetCommitment: string;
  revision: number;
  expiresAt: number;
  /** The exact workspace binding observed when the connection was opened. */
  session: SessionBinding | null;
  actor: ScanActor;
  epochs: ScanAuthorityEpochs; // their symbol key does not survive transport
  observation: ObservedScanningSessionSnapshot | null;
}

/** Preserve the guard observation without cloning raw scanner or session credentials. */
export function cloneLiveAttachment(a: LiveAttachment): LiveAttachment | null {
  if (!validLiveAttachment(a)) return null;
  const epochs = scanEpochsOf(a.actor) ?? a.epochs;
  if (!epochs) return null;
  const actor = cloneObservedScanActor(a.actor);
  setScanEpochs(actor, structuredClone(epochs));
  if (!restoreObservedScanningSession(actor, a.observation)) return null;
  const observation = captureObservedScanningSession(actor);
  if (actor.scanningSession && !observation) return null;
  return {
    ...a,
    session: a.session ? { ...a.session } : null,
    actor,
    epochs: structuredClone(epochs),
    observation,
    ...(a.admin
      ? {
          admin: {
            ...a.admin,
            tenantAuthority: {
              ...a.admin.tenantAuthority,
              roles: [...a.admin.tenantAuthority.roles],
              sessionRoles: [...a.admin.tenantAuthority.sessionRoles],
            },
          },
        }
      : {}),
  };
}

export interface LiveRecipient {
  actor: ScanActor;
  /** A customer screen's session settings: welcome, refused line, greet. Empty means the defaults. */
  customer: SessionCustomerSettings;
  watch: z.infer<typeof ScanWatchSchema>;
  attachment: LiveAttachment;
}

function validLiveAttachment(a: LiveAttachment): boolean {
  if (
    !a ||
    typeof a !== 'object' ||
    typeof a.orgId !== 'string' ||
    !a.orgId ||
    typeof a.scannerId !== 'string' ||
    !a.scannerId ||
    (a.mode !== 'live' && a.mode !== 'test') ||
    (a.role !== 'customer' && a.role !== 'monitor' && a.role !== 'device') ||
    typeof a.tokenHash !== 'string' ||
    !(
      a.scannerCsrfProof === null ||
      (typeof a.scannerCsrfProof === 'string' && /^[A-Za-z0-9_-]{43}$/.test(a.scannerCsrfProof))
    ) ||
    typeof a.credentialKeysetCommitment !== 'string' ||
    !/^[a-f0-9]{64}$/.test(a.credentialKeysetCommitment) ||
    !Number.isSafeInteger(a.revision) ||
    a.revision < 0 ||
    !Number.isSafeInteger(a.expiresAt) ||
    a.expiresAt < 0 ||
    !Object.hasOwn(a, 'session') ||
    !Object.hasOwn(a, 'actor') ||
    !Object.hasOwn(a, 'observation') ||
    !liveActorSchema.safeParse(a.actor).success
  )
    return false;
  const session = a.session;
  if (
    session !== null &&
    (typeof session !== 'object' ||
      !session ||
      typeof session.id !== 'string' ||
      !session.id ||
      (session.status !== 'active' && session.status !== 'paused' && session.status !== 'ended') ||
      !Number.isSafeInteger(session.updatedAt) ||
      session.updatedAt < 0)
  )
    return false;
  const actor = a.actor;
  if (
    !actor.scanner ||
    actor.scanner.csrfSecret !== null ||
    actor.terminal ||
    actor.orgId !== a.orgId ||
    actor.mode !== a.mode ||
    actor.scanner.orgId !== actor.orgId ||
    actor.scanner.mode !== actor.mode ||
    actor.scanner.id !== a.scannerId ||
    actor.scanner.deviceRole !== (a.role === 'device' ? 'scan' : a.role) ||
    actor.scanner.updatedAt !== a.revision ||
    (actor.scanner.tokenHash ?? '') !== a.tokenHash ||
    actor.scannerCsrfProof !== a.scannerCsrfProof ||
    actor.credentialKeysetCommitment !== a.credentialKeysetCommitment ||
    !sameSession(session, actor.scanningSession ?? null) ||
    (actor.principal === 'admin'
      ? !actor.tenantAuthority || a.expiresAt > actor.tenantAuthority.sessionExpiresAt
      : a.expiresAt > (actor.scanner.expiresAt ?? Infinity)) ||
    !restoreObservedScanningSession(cloneObservedScanActor(actor), a.observation) ||
    (actor.principal === 'admin'
      ? !a.admin ||
        actor.actor.type !== 'user' ||
        actor.actor.id !== a.admin.userId ||
        actor.platformSessionId !== a.admin.sessionId ||
        !sameAuthorityValue(actor.tenantAuthority, a.admin.tenantAuthority)
      : !!a.admin || actor.actor.type !== 'scanner' || actor.actor.id !== a.scannerId)
  )
    return false;
  return true;
}

/** A session's own scanners are bounded by the session, not by the stored-watch cap. */
const SessionWatchSchema = ScanWatchSchema.extend({
  scannerIds: z.array(IdSchema).max(SESSION_DEVICE_CAP).default([]),
});

/** The watch a screen row stores, or its session's scanners; null when malformed. */
function parseWatch(
  actor: ScanActor,
  scannerId: string,
  row: { watch?: unknown; session_watch?: unknown; screen_overrides?: unknown },
): z.infer<typeof ScanWatchSchema> | null {
  try {
    if (actor.scanningSession && actor.scanningSession.id !== scannerId) {
      if (typeof row.session_watch !== 'string') return null;
      const ids: unknown = JSON.parse(row.session_watch);
      if (
        !Array.isArray(ids) ||
        !ids.every((id) => typeof id === 'string') ||
        new Set(ids).size !== ids.length
      )
        return null;
      return SessionWatchSchema.parse({
        scannerIds: followed(row.screen_overrides, ids),
        allOrg: false,
      });
    }
    if (typeof row.watch !== 'string') return null;
    return ScanWatchSchema.parse(JSON.parse(row.watch));
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) return null;
    throw error;
  }
}

/** The scanners a screen follows within its session; no `follows` is all of them. Malformed: none. */
function followed(raw: unknown, sessionScanners: string[]): string[] {
  if (typeof raw !== 'string') return [];
  const parsed = ScanDeviceOverridesSchema.safeParse(safeJson(raw));
  if (!parsed.success) return [];
  const follows = parsed.data.follows;
  return follows ? sessionScanners.filter((id) => follows.includes(id)) : sessionScanners;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/** The session's customer block; a stored value that no longer parses is the defaults. */
function parseCustomer(raw: unknown): SessionCustomerSettings {
  if (typeof raw !== 'string') return {};
  try {
    const parsed = ScanningSessionSettingsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? (parsed.data.customer ?? {}) : {};
  } catch (error) {
    if (error instanceof SyntaxError) return {};
    throw error;
  }
}

/**
 * The recipient screen, read in one statement under its own authority: the same checks as a scan
 * write (credential, device and staff liveness, session and event epochs), so a cached socket never
 * extends a credential. Null when the attachment is expired, malformed, or its authority failed.
 */
export async function liveRecipient(
  ctx: ServiceContext,
  a: LiveAttachment,
): Promise<LiveRecipient | null> {
  if (
    !validLiveAttachment(a) ||
    a.expiresAt <= ctx.clock.now() ||
    (a.session && a.session.status !== 'active') ||
    (a.admin ? !tenantReadAuthority(a) : !a.tokenHash || typeof a.scannerCsrfProof !== 'string')
  )
    return null;
  const attachment = cloneLiveAttachment(a);
  if (!attachment) return null;
  const actor = attachment.actor;
  const scanner = actor.scanner;
  if (!restoreObservedScanningSession(actor, attachment.observation) || !scanner) return null;
  if (
    actor.invalidScannerScope ||
    scanner.deviceRole !== (attachment.role === 'device' ? 'scan' : attachment.role)
  )
    return null;
  try {
    if ((await credentialRefKeysetCommitment(ctx.env)) !== attachment.credentialKeysetCommitment)
      return null;
    const auth = scanReadAuthority(actor, {
      now: ctx.clock.now(),
      read: attachment.role === 'device' ? { deviceSocket: true } : { stafflessMonitor: true },
    });
    const row = await liveRecipientStmt(ctx.env.DB, auth, actor, scanner.id).first<{
      watch?: unknown;
      session_watch?: unknown;
      session_settings?: unknown;
      screen_overrides?: unknown;
    }>();
    if (!row) return null;
    // A device socket watches nothing: it only proves the device is still entitled to its messages.
    if (attachment.role === 'device')
      return {
        actor: cloneObservedScanActor(actor),
        customer: {},
        watch: ScanWatchSchema.parse({ scannerIds: [], allOrg: false }),
        attachment,
      };
    const watch = parseWatch(actor, scanner.id, row);
    if (!watch || (attachment.role === 'customer' && watch.allOrg)) return null;
    return {
      actor: cloneObservedScanActor(actor),
      customer: parseCustomer(row.session_settings),
      watch,
      attachment,
    };
  } catch (error) {
    if (error instanceof AppError && (error.status < 500 || error.code === 'SCAN_EPOCHS_MISSING'))
      return null;
    throw error;
  }
}
