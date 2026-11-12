import type { Personalization, ScanActionKind, ScanRole } from '../../../passkit/types.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import { derivedHmacKey } from '../../platform/crypto.ts';
import { toHex } from '../../platform/ids.ts';
import { cardPrivacy } from './dto-projection.ts';
import {
  ACTION_KINDS,
  actionPolicies,
  appendFieldValues,
  appendOpaqueStyle,
  appendProtected,
  containsProtected,
  PUBLIC_WALLET_ROOT,
  sourceActor,
  WALLET_STYLES,
} from './event-safe-projection-policy.ts';
import type { ScanActor } from './guard.ts';
import { scanIdentity, scanInputVisible } from './projection-privacy.ts';
import type { Found } from './resolve.ts';
import { ROLE_RANK } from './rules.ts';

const ROLES: readonly ScanRole[] = ['door', 'desk', 'manager'];
const TITLE_PURPOSE = 'scan-history-title.v1';
const SCANNER_NAME_PURPOSE = 'scan-history-scanner-name.v1';
const ACTION_LABEL_PURPOSE = 'scan-history-action-label.v1';
const encoder = new TextEncoder();

export interface EventSafeRoleProjection {
  action: { kind: ScanActionKind; labelHash: string | null } | null;
  /** Scoped keyed commitments; the ledger never contains scanner or holder names. */
  scannerNameHash: string | null;
  titleHash: string | null;
}

/** Only present roles were eligible at event time; readers must also apply current policy. */
export interface EventSafeProjection {
  v: 1;
  roles: Partial<Record<ScanRole, EventSafeRoleProjection>>;
}

interface EvaluatedProjection {
  projection: EventSafeProjection;
  titles: Partial<Record<ScanRole, string>>;
  scannerNames: Partial<Record<ScanRole, string>>;
  actionLabels: Partial<Record<ScanRole, string>>;
}

function empty(): EvaluatedProjection {
  return { projection: { v: 1, roles: {} }, titles: {}, scannerNames: {}, actionLabels: {} };
}

/**
 * The Wallet row can predate the evaluated pass. Check its personalization when available;
 * old rows can lack it, so absence alone must not turn a valid scan into an unusable receipt.
 */
function sourceSnapshots(found: Found): Found[] | null {
  const active = found.activePolicy ?? found.activeTemplate ?? found.template;
  if (
    found.template.version !== found.pass.templateVersion ||
    active.version !== found.activeVersion
  )
    return null;
  if (typeof found.versionPersonalization !== 'string') return [found];
  try {
    const value: unknown = JSON.parse(found.versionPersonalization);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? [found, { ...found, pass: { ...found.pass, personalization: value as Personalization } }]
      : [found];
  } catch {
    return [found];
  }
}

/** Compute the event-time role intersection without mutating the evaluated actor or Found. */
function evaluate(
  found: Found | null,
  actor: ScanActor,
  action: ResolvedScanAction | null,
): EvaluatedProjection {
  try {
    if (
      !found ||
      !actor.role ||
      !Object.hasOwn(ROLE_RANK, actor.role) ||
      actor.invalidScannerScope ||
      (actor.scanningSession && actor.scanningSession.status !== 'active') ||
      found.pass.orgId !== actor.orgId ||
      found.pass.mode !== actor.mode
    )
      return empty();
    const snapshots = sourceSnapshots(found);
    if (!snapshots) return empty();
    const policies = actionPolicies(found, action);
    // A current reader may later expose the action id, so don't authorize an id copied
    // from personalization or a non-public Wallet leaf. Text commitments deny opaque Wallet values.
    const privateIds: string[] = [];
    const privateText: string[] = [];
    const unknownWalletInputs: string[] = [];
    for (const snapshot of snapshots) appendProtected(snapshot.pass.personalization, privateIds);
    for (const [name, value] of Object.entries(found.passJson)) {
      if (Object.hasOwn(PUBLIC_WALLET_ROOT, name)) continue;
      if (Object.hasOwn(WALLET_STYLES, name)) {
        // Field labels are template text, not holder data: an action may share a word with one.
        appendFieldValues(value, privateText);
        appendOpaqueStyle(value, unknownWalletInputs);
      } else {
        appendProtected(value, privateText);
        appendProtected(value, unknownWalletInputs);
      }
    }
    for (const value of privateText) privateIds.push(value);
    const active = found.activePolicy ?? found.activeTemplate ?? found.template;
    if (
      snapshots[1] &&
      found.walletTemplateVersion !== found.template.version &&
      found.walletTemplateVersion !== active.version
    )
      appendProtected(snapshots[1].pass.personalization, unknownWalletInputs);
    const result = empty();
    for (const role of ROLES) {
      // No hypothetical reader gets more event-time authority than the evaluated actor had.
      if (ROLE_RANK[role] > ROLE_RANK[actor.role]) continue;
      const simulated = sourceActor(actor, role);
      const privacy = snapshots.map((snapshot) => cardPrivacy(snapshot, simulated));
      const safe = (value: unknown) => privacy.every((policy) => policy.safe(value));
      const visibleAction =
        policies &&
        action &&
        policies.every(
          (policy) =>
            ROLE_RANK[role] >= ROLE_RANK[policy.minRole] &&
            safe(policy.id) &&
            safe(policy.label) &&
            !containsProtected(policy.id, privateIds) &&
            !containsProtected(policy.label, privateText) &&
            !containsProtected(policy.label, unknownWalletInputs),
        ) &&
        (!action.input || scanInputVisible(found, simulated, action.input))
          ? { kind: action.kind, labelHash: null }
          : null;
      if (visibleAction && action) result.actionLabels[role] = action.label;
      const name = actor.scanner?.name;
      if (
        typeof name === 'string' &&
        name !== '' &&
        safe(name) &&
        !containsProtected(name, privateText) &&
        !containsProtected(name, unknownWalletInputs)
      )
        result.scannerNames[role] = name;
      const title = scanIdentity(found, simulated).title;
      if (title !== null && safe(title) && !containsProtected(title, unknownWalletInputs))
        result.titles[role] = title;
      result.projection.roles[role] = {
        action: visibleAction,
        scannerNameHash: null,
        titleHash: null,
      };
    }
    return result;
  } catch {
    // Missing or malformed source/policy must not become a more permissive projection.
    return empty();
  }
}

/** Synchronous deterministic disclosure, safe to bind into an event proof as-is. */
export function eventSafeProjection(
  found: Found | null,
  actor: ScanActor,
  action: ResolvedScanAction | null,
): EventSafeProjection {
  return evaluate(found, actor, action).projection;
}

/** JSON array framing avoids ambiguous separators in identifiers or display text. */
function commitmentInput(fields: readonly string[]): Uint8Array {
  return encoder.encode(JSON.stringify(fields));
}

/** Add keyed, role-scoped text commitments without persisting the text. */
export async function eventSafeProjectionWithCommitments(
  env: object,
  found: Found | null,
  actor: ScanActor,
  action: ResolvedScanAction | null,
  scanId: string,
): Promise<EventSafeProjection> {
  // Capture every policy decision and identity tuple before the first await.
  const { projection, titles, scannerNames, actionLabels } = evaluate(found, actor, action);
  if (!found || !scanId) return projection;
  const orgId = found.pass.orgId;
  const passId = found.pass.id;
  const actionId = action?.id;
  const inputs = ROLES.flatMap((role) => {
    const scope = [orgId, passId, scanId, role];
    const title = titles[role];
    const scannerName = scannerNames[role];
    const label = actionLabels[role];
    const projectedAction = projection.roles[role]?.action;
    return [
      ...(title === undefined
        ? []
        : [
            {
              role,
              kind: 'title' as const,
              purpose: TITLE_PURPOSE,
              bytes: commitmentInput([...scope, title]),
            },
          ]),
      ...(scannerName === undefined
        ? []
        : [
            {
              role,
              kind: 'scannerName' as const,
              purpose: SCANNER_NAME_PURPOSE,
              bytes: commitmentInput([...scope, scannerName]),
            },
          ]),
      ...(label === undefined || !projectedAction || !actionId
        ? []
        : [
            {
              role,
              kind: 'action' as const,
              purpose: ACTION_LABEL_PURPOSE,
              bytes: commitmentInput([...scope, actionId, projectedAction.kind, label]),
            },
          ]),
    ];
  });
  const keys = new Map(
    await Promise.all(
      [...new Set(inputs.map((input) => input.purpose))].map(
        async (purpose) => [purpose, await derivedHmacKey(env, purpose)] as const,
      ),
    ),
  );
  const tags = await Promise.all(
    inputs.map(async ({ role, kind, purpose, bytes }) => {
      const key = keys.get(purpose);
      if (key === undefined) throw new Error('Missing projection commitment key');
      return {
        role,
        kind,
        hash: toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes as BufferSource))),
      };
    }),
  );
  for (const { role, kind, hash } of tags) {
    const entry = projection.roles[role];
    if (entry === undefined) throw new Error('Missing role projection');
    if (kind === 'title') entry.titleHash = hash;
    else if (kind === 'scannerName') entry.scannerNameHash = hash;
    else {
      if (entry.action === null) throw new Error('Missing action projection');
      entry.action.labelHash = hash;
    }
  }
  return projection;
}

interface CommitmentScope {
  orgId: string;
  passId: string;
  scanId: string;
  role: ScanRole;
  hash: string | null;
}

/** The caller must separately establish current role, source and text privacy. */
async function verifyCommitment(
  env: object,
  purpose: string,
  scope: CommitmentScope,
  value: readonly string[],
): Promise<boolean> {
  if (
    !scope.hash ||
    !/^[0-9a-f]{64}$/.test(scope.hash) ||
    !Object.hasOwn(ROLE_RANK, scope.role) ||
    !scope.orgId ||
    !scope.passId ||
    !scope.scanId ||
    value.some((part) => !part)
  )
    return false;
  const tag = new Uint8Array(32);
  for (let i = 0; i < tag.length; i++)
    tag[i] = Number.parseInt(scope.hash.slice(i * 2, i * 2 + 2), 16);
  const bytes = commitmentInput([scope.orgId, scope.passId, scope.scanId, scope.role, ...value]);
  const key = await derivedHmacKey(env, purpose);
  return crypto.subtle.verify('HMAC', key, tag as BufferSource, bytes as BufferSource);
}

export async function verifyEventTitleHash(
  env: object,
  input: CommitmentScope & { title: string },
): Promise<boolean> {
  return verifyCommitment(env, TITLE_PURPOSE, input, [input.title]);
}

export async function verifyEventScannerNameHash(
  env: object,
  input: CommitmentScope & { scannerName: string },
): Promise<boolean> {
  return verifyCommitment(env, SCANNER_NAME_PURPOSE, input, [input.scannerName]);
}

export async function verifyEventActionLabelHash(
  env: object,
  input: CommitmentScope & { actionId: string; kind: ScanActionKind; label: string },
): Promise<boolean> {
  if (!ACTION_KINDS.includes(input.kind)) return false;
  return verifyCommitment(env, ACTION_LABEL_PURPOSE, input, [
    input.actionId,
    input.kind,
    input.label,
  ]);
}
