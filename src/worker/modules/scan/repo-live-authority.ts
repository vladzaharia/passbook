import type { SqlValue } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import {
  actorCsrfAuthorityStmt,
  actorCsrfSnapshotFence,
  actorCsrfSnapshotFromResult,
} from './actor-csrf.ts';
import { type CredentialTombstoneSnapshot, snapshotCredentialEnv } from './credential-input.ts';
import type { LiveRecipient } from './live-auth.ts';
import { liveActorDeadline, liveActorLifetimeFence, liveLifetimeStmt } from './live-lifetime.ts';
import { livePredicatesCurrent } from './live-read-fences.ts';
import { eventPassPredicate } from './repo-action-authority.ts';
import { actorAuthorityPredicate } from './repo-actor-authority.ts';
import {
  noCredentialTombstonesSql,
  validCredentialTombstoneRefs,
} from './repo-credential-tombstones.ts';
import { type LiveWatchStamp, liveRecipientFenceParts } from './repo-live-recipient.ts';
import type { Candidate } from './repo-lookup.ts';
import { passOutputPredicate } from './repo-output-authority.ts';
import {
  type SessionLegacyStamp,
  type SessionReleaseStamp,
  sessionTemplateStampsPredicate,
} from './repo-scope-releases.ts';
import { sessionReadAuthorityPredicate } from './repo-session-authority.ts';
import {
  cloneObservedScanActor,
  observedScanningSession,
} from './scanning-workspace-observation.ts';

/** Fence recipient credential, complete scope, releases and watch in one final D1 read. */
export async function liveRecipientFencesCurrent(
  ctx: ServiceContext,
  actor: ScanActor,
  _now: number,
  releases: readonly SessionReleaseStamp[],
  legacy: readonly SessionLegacyStamp[],
  watch: LiveWatchStamp,
  expiresAt: number,
  lifetimeResult?: D1Result,
): Promise<boolean> {
  ctx = { ...ctx, env: snapshotCredentialEnv(ctx.env) };
  actor = cloneObservedScanActor(actor);
  releases = structuredClone(releases);
  legacy = structuredClone(legacy);
  watch = structuredClone(watch);
  const { orgId, mode } = actor;
  const query = lifetimeResult === undefined ? liveLifetimeStmt(ctx.env.DB, actor) : null;
  const observed = lifetimeResult ?? (await query?.all());
  expiresAt = Math.min(expiresAt, liveActorDeadline(actor, observed));
  const now = ctx.clock.now();
  if (expiresAt <= now) return false;
  const lifetime = liveActorLifetimeFence(actor, observed);
  if (!lifetime) return false;
  const pieces = liveRecipientFenceParts(actor, now, releases, legacy, watch);
  return (
    (await livePredicatesCurrent(ctx, [...pieces, lifetime], orgId, mode)) &&
    expiresAt > ctx.clock.now()
  );
}

/** Add these statements to a batch with recipient, pass and grant reads. */
export function liveDisclosureCsrfStmts(db: D1Database, source: ScanActor, recipient: ScanActor) {
  return {
    source: actorCsrfAuthorityStmt(db, source),
    recipient: actorCsrfAuthorityStmt(db, recipient),
  };
}

export interface LiveDisclosureInput {
  source: ScanActor;
  recipient: LiveRecipient;
  credentialContext: CredentialTombstoneSnapshot;
  candidate: Candidate | null;
  requirePhoto: boolean;
  /** A withheld passful event depends on its presented credential, not the other mode. */
  sameModeOnly?: boolean;
  extra?: (now: number) => readonly { sql: string; params: readonly SqlValue[] }[];
}

export interface LiveDisclosureCsrfResults {
  sourceResult: D1Result | undefined;
  recipientResult: D1Result | undefined;
}

/** Build independently bindable predicates from one original source/recipient observation. */
export async function prepareLiveDisclosurePredicates(
  ctx: ServiceContext,
  input: LiveDisclosureInput,
  results: LiveDisclosureCsrfResults,
): Promise<readonly { sql: string; params: readonly SqlValue[] }[] | null> {
  ctx = { ...ctx, env: snapshotCredentialEnv(ctx.env) };
  const originalContext = input.credentialContext;
  if (
    !originalContext ||
    !validCredentialTombstoneRefs(originalContext.credentialTombstoneRefs) ||
    !validCredentialTombstoneRefs(originalContext.otherModeCredentialTombstoneRefs) ||
    new Set(originalContext.credentialTombstoneRefs).size !==
      originalContext.credentialTombstoneRefs.length ||
    new Set(originalContext.otherModeCredentialTombstoneRefs).size !==
      originalContext.otherModeCredentialTombstoneRefs.length
  )
    return null;
  const source = cloneObservedScanActor(input.source);
  const recipient: LiveRecipient = {
    ...input.recipient,
    actor: cloneObservedScanActor(input.recipient.actor),
    attachment: { ...input.recipient.attachment },
    watch: { ...input.recipient.watch, scannerIds: [...input.recipient.watch.scannerIds] },
    fences: structuredClone(input.recipient.fences),
  };
  const credentialContext: CredentialTombstoneSnapshot = {
    credentialKeysetCommitment: originalContext.credentialKeysetCommitment,
    credentialTombstoneRefs: [...originalContext.credentialTombstoneRefs],
    otherModeCredentialTombstoneRefs: [...originalContext.otherModeCredentialTombstoneRefs],
  };
  if (
    input.candidate &&
    (!input.candidate.pass ||
      !validCredentialTombstoneRefs(input.candidate.credentialTombstoneRefs) ||
      !validCredentialTombstoneRefs(input.candidate.otherModeCredentialTombstoneRefs))
  )
    return null;
  const { requirePhoto, extra, sameModeOnly } = input;
  const candidate = input.candidate
    ? {
        ...input.candidate,
        pass: {
          ...input.candidate.pass,
          personalization: structuredClone(input.candidate.pass.personalization),
          fieldSources: structuredClone(input.candidate.pass.fieldSources),
        },
        assetPhoto: input.candidate.assetPhoto ? { ...input.candidate.assetPhoto } : null,
        templateSnapshot: input.candidate.templateSnapshot
          ? { ...input.candidate.templateSnapshot }
          : null,
        credentialTombstoneRefs: [...input.candidate.credentialTombstoneRefs],
        otherModeCredentialTombstoneRefs: [...input.candidate.otherModeCredentialTombstoneRefs],
        ...(input.candidate.checkInRules
          ? { checkInRules: structuredClone(input.candidate.checkInRules) }
          : {}),
      }
    : null;
  const scanner = source.scanner;
  const screen = recipient.actor.scanner;
  if (
    !scanner ||
    !screen ||
    scanner.id === screen.id ||
    scanner.deviceRole !== 'scan' ||
    source.orgId !== recipient.actor.orgId ||
    source.mode !== recipient.actor.mode ||
    (screen.deviceRole !== 'monitor' && screen.deviceRole !== 'customer') ||
    (screen.deviceRole === 'customer' && recipient.watch.allOrg) ||
    (!recipient.watch.allOrg && !recipient.watch.scannerIds.includes(scanner.id)) ||
    !credentialContext ||
    !validCredentialTombstoneRefs(credentialContext.credentialTombstoneRefs) ||
    !validCredentialTombstoneRefs(credentialContext.otherModeCredentialTombstoneRefs) ||
    !/^[a-f0-9]{64}$/.test(credentialContext.credentialKeysetCommitment) ||
    source.credentialKeysetCommitment !== credentialContext.credentialKeysetCommitment ||
    (requirePhoto && (!candidate || screen.deviceRole !== 'monitor'))
  )
    return null;
  if (
    candidate &&
    (candidate.pass.orgId !== source.orgId ||
      candidate.pass.mode !== source.mode ||
      !validCredentialTombstoneRefs(candidate.credentialTombstoneRefs) ||
      !validCredentialTombstoneRefs(candidate.otherModeCredentialTombstoneRefs) ||
      candidate.credentialKeysetCommitment !== credentialContext.credentialKeysetCommitment ||
      candidate.credentialTombstoneRefs.length !==
        credentialContext.credentialTombstoneRefs.length ||
      candidate.credentialTombstoneRefs.some(
        (value, index) => value !== credentialContext.credentialTombstoneRefs[index],
      ) ||
      candidate.otherModeCredentialTombstoneRefs.length !==
        credentialContext.otherModeCredentialTombstoneRefs.length ||
      candidate.otherModeCredentialTombstoneRefs.some(
        (value, index) => value !== credentialContext.otherModeCredentialTombstoneRefs[index],
      ))
  )
    return null;
  if (results.sourceResult?.success !== true || results.recipientResult?.success !== true)
    return null;

  const [sourceSnapshot, recipientSnapshot] = await Promise.all([
    actorCsrfSnapshotFromResult(ctx, source, results.sourceResult),
    actorCsrfSnapshotFromResult(ctx, recipient.actor, results.recipientResult),
  ]);
  if (!sourceSnapshot || !recipientSnapshot) return null;
  const now = ctx.clock.now();
  if (sourceSnapshot.session) sourceSnapshot.session.now = now;
  if (recipientSnapshot.session) recipientSnapshot.session.now = now;
  const sourceCsrf = actorCsrfSnapshotFence(source, sourceSnapshot, 'source');
  const recipientCsrf = actorCsrfSnapshotFence(recipient.actor, recipientSnapshot, 'recipient');
  const sourceLifetime = liveActorLifetimeFence(source, results.sourceResult);
  const recipientLifetime = liveActorLifetimeFence(recipient.actor, results.recipientResult);
  if (!sourceCsrf || !recipientCsrf || !sourceLifetime || !recipientLifetime) return null;
  const fences = recipient.fences;
  const watcher = liveRecipientFenceParts(
    recipient.actor,
    now,
    fences.releases,
    fences.legacy,
    fences.watch,
  );
  if (watcher.some((part) => part.sql === '0') || recipient.attachment.expiresAt <= now)
    return null;
  const extras = extra?.(now) ?? [];
  let pieces: { sql: string; params: readonly SqlValue[] }[];
  const sourceAuthority = actorAuthorityPredicate({
    actor: source,
    now,
    event: source.event,
    adminEventTemplates: source.adminEventTemplates === true,
    ...(candidate ? { templateId: candidate.pass.templateId } : {}),
  });
  const workspace = sessionReadAuthorityPredicate(source, now);
  const workspaceStamps =
    observedScanningSession(source)?.scope?.stamps.map((stamp) =>
      sessionTemplateStampsPredicate(stamp.releases, stamp.legacy, 'scope.org_id', 'scope.mode'),
    ) ?? [];
  if (candidate) {
    const passInput = {
      actor: source,
      event: source.event,
      now,
      pass: candidate.pass,
      connectionGeneration: candidate.connectionGeneration,
      activeTemplateVersion: candidate.activeTemplateVersion,
      orgRevision: candidate.orgRevision,
      templateRevision: candidate.templateRevision,
      credentialTombstoneRefs: credentialContext.credentialTombstoneRefs,
      credentialKeysetCommitment: credentialContext.credentialKeysetCommitment,
      release: candidate,
      templateId: candidate.pass.templateId,
      displayTemplateVersion: candidate.displayTemplateVersion,
      checkInRules: candidate.checkInRules,
      lookupHash: candidate.lookupHash,
      purpose: 'commit' as const,
      requireActive: true,
      requirePhoto,
    };
    const pass = passOutputPredicate(passInput);
    const event = eventPassPredicate(source, source.event);
    const matchingPass = event.params.length
      ? {
          sql: `EXISTS (SELECT 1 FROM passes p WHERE p.id=?/* scan-ephemeral-pass-id */
            AND p.org_id=? AND p.mode=? AND (${event.sql}))`,
          params: [candidate.pass.id, candidate.pass.orgId, candidate.pass.mode, ...event.params],
        }
      : { sql: '1', params: [] };
    pieces = [
      sourceAuthority,
      workspace,
      ...workspaceStamps,
      pass,
      matchingPass,
      ...watcher,
      ...extras,
    ];
  } else {
    const own = noCredentialTombstonesSql(
      credentialContext.credentialTombstoneRefs,
      {
        orgIdSql: 'scope.org_id',
        modeSql: 'scope.mode',
      },
      credentialContext.credentialKeysetCommitment,
    );
    const other = sameModeOnly
      ? []
      : [
          noCredentialTombstonesSql(
            credentialContext.otherModeCredentialTombstoneRefs,
            {
              orgIdSql: 'scope.org_id',
              modeSql: "CASE scope.mode WHEN 'live' THEN 'test' ELSE 'live' END",
            },
            credentialContext.credentialKeysetCommitment,
          ),
        ];
    pieces = [sourceAuthority, workspace, ...workspaceStamps, own, ...other, ...watcher, ...extras];
  }
  return [
    ...pieces,
    sourceLifetime,
    recipientLifetime,
    {
      sql: `(${sourceCsrf.sql}) AND (${recipientCsrf.sql})`,
      params: [...sourceCsrf.params, ...recipientCsrf.params],
    },
  ];
}

/** Bind source, recipient, pass and watch in one SELECT or one atomic read-only batch. */
export async function liveDisclosureCurrent(
  ctx: ServiceContext,
  input: LiveDisclosureInput,
  results: LiveDisclosureCsrfResults,
): Promise<boolean> {
  ctx = { ...ctx, env: snapshotCredentialEnv(ctx.env) };
  const { orgId, mode } = input.source;
  const expiresAt = Math.min(
    input.recipient.attachment.expiresAt,
    liveActorDeadline(input.source, results.sourceResult),
    liveActorDeadline(input.recipient.actor, results.recipientResult),
  );
  const pieces = await prepareLiveDisclosurePredicates(ctx, input, results);
  if (!pieces) return false;
  return (await livePredicatesCurrent(ctx, pieces, orgId, mode)) && expiresAt > ctx.clock.now();
}
