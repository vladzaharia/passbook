import type { z } from 'zod';
import { ZodError } from 'zod';
import { ScanWatchSchema } from '../../../shared/contracts/scan-setups.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { credentialRefKeysetCommitment } from '../passes/credential-keyset.ts';
import type { ScanActor } from './actor.ts';
import { snapshotCredentialEnv } from './credential-input.ts';
import {
  type LiveAttachmentTenant,
  sameAuthorityValue,
  sameSession,
  tenantReadAuthority,
} from './live-auth-guards.ts';
import { liveLifetimeStmt } from './live-lifetime.ts';
import { liveActorSchema } from './live-provenance.ts';
import { liveRecipientFencesCurrent } from './repo-live-authority.ts';
import { type LiveWatchStamp, liveRecipientWatchStmt } from './repo-live-recipient.ts';
import {
  captureTemplateStampsStmt,
  type SessionLegacyStamp,
  type SessionReleaseStamp,
  templateStampsFromResult,
} from './repo-scope-releases.ts';
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
  role: 'customer' | 'monitor';
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
  watch: z.infer<typeof ScanWatchSchema>;
  attachment: LiveAttachment;
  /** The original recipient authority used in the final combined output fence. */
  fences: {
    releases: readonly SessionReleaseStamp[];
    legacy: readonly SessionLegacyStamp[];
    watch: LiveWatchStamp;
  };
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
    (a.role !== 'customer' && a.role !== 'monitor') ||
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
    actor.scanner.deviceRole !== a.role ||
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

/** Batch the original watch and selected template stamps with photo/grant authority reads. */
export function liveRecipientAcquisitionStmts(
  db: D1Database,
  actor: ScanActor,
): {
  watch: D1PreparedStatement;
  stamps: D1PreparedStatement;
} | null {
  const scanner = actor.scanner;
  const stamps = captureTemplateStampsStmt(db, actor.orgId, actor.mode, actor.templateIds);
  if (!scanner || !stamps || actor.invalidScannerScope) return null;
  return {
    stamps,
    watch: liveRecipientWatchStmt(db, actor, scanner),
  };
}

/** Use only the guard actor and the same batched watch/stamp observation. */
export function liveRecipientFromResults(
  ctx: ServiceContext,
  actor: ScanActor,
  attachment: LiveAttachment,
  results: { watch: D1Result | undefined; stamps: D1Result | undefined },
): LiveRecipient | null {
  const scanner = actor.scanner;
  if (
    !validLiveAttachment(attachment) ||
    !scanner ||
    actor.invalidScannerScope ||
    !sameAuthorityValue(cloneObservedScanActor(actor), attachment.actor) ||
    !restoreObservedScanningSession(actor, attachment.observation) ||
    attachment.expiresAt <= ctx.clock.now() ||
    attachment.orgId !== actor.orgId ||
    attachment.mode !== actor.mode ||
    attachment.scannerId !== scanner.id ||
    attachment.role !== scanner.deviceRole ||
    attachment.revision !== scanner.updatedAt ||
    attachment.tokenHash !== (scanner.tokenHash ?? '') ||
    attachment.scannerCsrfProof !== actor.scannerCsrfProof ||
    attachment.credentialKeysetCommitment !== actor.credentialKeysetCommitment ||
    !sameSession(attachment.session, actor.scanningSession ?? null)
  )
    return null;
  if (actor.principal === 'admin') {
    if (
      !attachment.admin ||
      !tenantReadAuthority(attachment) ||
      attachment.admin.userId !== actor.actor.id ||
      attachment.admin.sessionId !== actor.platformSessionId ||
      !sameAuthorityValue(attachment.admin.tenantAuthority, actor.tenantAuthority)
    )
      return null;
  } else if (
    attachment.admin ||
    !attachment.tokenHash ||
    typeof attachment.scannerCsrfProof !== 'string'
  ) {
    return null;
  }
  if (
    results.watch?.success !== true ||
    results.watch.results?.length !== 1 ||
    results.stamps?.success !== true
  )
    return null;
  const row = results.watch.results?.[0] as
    | { watch?: unknown; session_watch?: unknown }
    | undefined;
  const stamps = templateStampsFromResult(actor.templateIds, results.stamps);
  if (!row || !stamps) return null;
  try {
    let watch: z.infer<typeof ScanWatchSchema>;
    let watchStamp: LiveWatchStamp;
    if (actor.scanningSession && actor.scanningSession.id !== scanner.id) {
      if (typeof row.session_watch !== 'string') return null;
      const ids: unknown = JSON.parse(row.session_watch);
      if (
        !Array.isArray(ids) ||
        !ids.every((id) => typeof id === 'string') ||
        new Set(ids).size !== ids.length
      )
        return null;
      watch = ScanWatchSchema.parse({ scannerIds: ids, allOrg: false });
      watchStamp = {
        kind: 'session',
        sessionId: actor.scanningSession.id,
        scannerIds: watch.scannerIds,
      };
    } else {
      if (typeof row.watch !== 'string') return null;
      watch = ScanWatchSchema.parse(JSON.parse(row.watch));
      watchStamp = { kind: 'standalone', raw: row.watch };
    }
    if (attachment.role === 'customer' && watch.allOrg) return null;
    return {
      actor: cloneObservedScanActor(actor),
      watch,
      attachment,
      fences: { releases: stamps.releases, legacy: stamps.legacy, watch: watchStamp },
    };
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) return null;
    throw error;
  }
}

/** Read authoritative rows before each delivery; a cached socket never extends a credential. */
export async function liveRecipient(
  ctx: ServiceContext,
  a: LiveAttachment,
): Promise<LiveRecipient | null> {
  ctx = { ...ctx, env: snapshotCredentialEnv(ctx.env) };
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
  if (!restoreObservedScanningSession(actor, attachment.observation)) return null;
  const reads = liveRecipientAcquisitionStmts(ctx.env.DB, actor);
  const lifetime = liveLifetimeStmt(ctx.env.DB, actor);
  if (!reads || !lifetime) return null;
  try {
    const [keyset, results] = await Promise.all([
      credentialRefKeysetCommitment(ctx.env),
      ctx.env.DB.batch([reads.watch, reads.stamps, lifetime]),
    ]);
    if (
      keyset !== attachment.credentialKeysetCommitment ||
      results.length !== 3 ||
      results.some((result) => result.success !== true)
    )
      return null;
    const recipient = liveRecipientFromResults(ctx, actor, attachment, {
      watch: results[0],
      stamps: results[1],
    });
    if (
      !recipient ||
      !(await liveRecipientFencesCurrent(
        ctx,
        recipient.actor,
        ctx.clock.now(),
        recipient.fences.releases,
        recipient.fences.legacy,
        recipient.fences.watch,
        attachment.expiresAt,
        results[2],
      ))
    )
      return null;
    return recipient;
  } catch (error) {
    if (
      error instanceof ZodError ||
      error instanceof SyntaxError ||
      (error instanceof AppError && error.status < 500)
    )
      return null;
    throw error;
  }
}
