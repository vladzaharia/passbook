import type { EventRow } from '../events/repo.ts';
import { canonicalJson } from '../templates/package/hash.ts';

type ObjectValue = Record<string, unknown>;
type ReleaseClass = 'legacy' | 'approved';
type Direction = 'in' | 'out' | null;

function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The null-head sentinel is distinct from every complete approved-head tuple. */
function releaseClass(authority: ObjectValue): ReleaseClass | null {
  if (
    authority.pinnedReleaseId === null &&
    authority.activeReleaseId === null &&
    authority.activeReleaseGeneration === null &&
    authority.activeReleaseVersion === null &&
    authority.activeReleaseCandidateHash === null
  )
    return authority.activeTemplateVersion === authority.pinnedTemplateVersion ? 'legacy' : null;
  return (authority.pinnedReleaseId === null ||
    (typeof authority.pinnedReleaseId === 'string' && authority.pinnedReleaseId.length > 0)) &&
    typeof authority.activeReleaseId === 'string' &&
    authority.activeReleaseId.length > 0 &&
    Number.isSafeInteger(authority.activeReleaseGeneration) &&
    Number(authority.activeReleaseGeneration) > 0 &&
    typeof authority.activeReleaseVersion === 'string' &&
    authority.activeReleaseVersion.length > 0 &&
    authority.activeTemplateVersion === authority.activeReleaseVersion &&
    typeof authority.activeReleaseCandidateHash === 'string' &&
    authority.activeReleaseCandidateHash.length > 0
    ? 'approved'
    : null;
}

function gateSnapshot(value: unknown): value is ObjectValue {
  if (!object(value)) return false;
  return (
    !Object.hasOwn(value, 'actionId') &&
    [
      'passId',
      'actionIdRef',
      'scope',
      'orgId',
      'mode',
      'templateId',
      'kind',
      'state',
      'lastScanId',
    ].every((field) => typeof value[field] === 'string') &&
    /^[0-9a-f]{64}$/.test(value.actionIdRef as string) &&
    ['count', 'firstAt', 'lastAt'].every((field) => Number.isSafeInteger(value[field])) &&
    ['prevState', 'prevScanId', 'holderState', 'holderUndoneBy'].every(
      (field) =>
        Object.hasOwn(value, field) && (value[field] === null || typeof value[field] === 'string'),
    ) &&
    Object.hasOwn(value, 'prevLastAt') &&
    (value.prevLastAt === null || Number.isSafeInteger(value.prevLastAt))
  );
}

function presenceSnapshot(value: unknown): value is ObjectValue {
  if (!object(value)) return false;
  return (
    ['passId', 'orgId', 'scope', 'state', 'lastScanId'].every(
      (field) => typeof value[field] === 'string',
    ) &&
    ['tracking', 'firstAt', 'lastEntryAt'].every((field) => Number.isSafeInteger(value[field])) &&
    ['prevState', 'prevScanId'].every(
      (field) =>
        Object.hasOwn(value, field) && (value[field] === null || typeof value[field] === 'string'),
    ) &&
    ['enteredAt', 'prevTracking', 'prevEnteredAt', 'prevFirstAt', 'prevLastEntryAt'].every(
      (field) =>
        Object.hasOwn(value, field) &&
        (value[field] === null || Number.isSafeInteger(value[field])),
    )
  );
}

const GATE_FIELDS = [
  ['orgId', 'orgId'],
  ['mode', 'mode'],
  ['templateId', 'templateId'],
  ['kind', 'kind'],
  ['scope', 'scope'],
  ['scanId', 'lastScanId'],
  ['state', 'state'],
  ['count', 'count'],
  ['firstAt', 'firstAt'],
  ['lastAt', 'lastAt'],
  ['prevState', 'prevState'],
  ['prevLastAt', 'prevLastAt'],
  ['prevScanId', 'prevScanId'],
  ['scanState', 'holderState'],
  ['undoneBy', 'holderUndoneBy'],
] as const;

/** Check the complete deterministic effect envelope before signing or accepting it. */
function effectValid(
  row: EventRow,
  data: ObjectValue,
  authority: ObjectValue,
  scope: string | null,
): boolean {
  const effect = authority.effect;
  if (
    !object(effect) ||
    !['gateBefore', 'gateAfter', 'presenceBefore', 'presenceAfter'].every((field) =>
      Object.hasOwn(effect, field),
    )
  )
    return false;
  if (
    (effect.gateBefore !== null && !gateSnapshot(effect.gateBefore)) ||
    (effect.gateAfter !== null && !gateSnapshot(effect.gateAfter)) ||
    (effect.presenceBefore !== null && !presenceSnapshot(effect.presenceBefore)) ||
    (effect.presenceAfter !== null && !presenceSnapshot(effect.presenceAfter))
  )
    return false;
  const gate = authority.gate;
  if (
    (object(effect.gateBefore) && effect.gateBefore.actionIdRef !== data.actionIdRef) ||
    (object(effect.gateAfter) && effect.gateAfter.actionIdRef !== data.actionIdRef) ||
    (object(gate) && Object.hasOwn(gate, 'actionId'))
  )
    return false;
  if (data.outcome !== 'ok') {
    if (
      canonicalJson(effect.gateBefore) !== canonicalJson(effect.gateAfter) ||
      canonicalJson(effect.presenceBefore) !== canonicalJson(effect.presenceAfter)
    )
      return false;
    if (gate === undefined) return scope === null && effect.gateBefore === null;
    if (!object(gate) || gate.scope !== scope) return false;
    if (gate.exists === false) return effect.gateBefore === null;
    return (
      gate.exists === true &&
      gateSnapshot(effect.gateBefore) &&
      GATE_FIELDS.every(
        ([alias, field]) =>
          Object.hasOwn(gate, alias) && gate[alias] === (effect.gateBefore as ObjectValue)[field],
      )
    );
  }
  const after = effect.gateAfter;
  if (
    !object(gate) ||
    !gateSnapshot(after) ||
    gate.exists !== true ||
    gate.scope !== scope ||
    after.passId !== row.pass_id ||
    after.actionIdRef !== data.actionIdRef ||
    after.orgId !== row.org_id ||
    after.mode !== row.mode ||
    after.templateId !== authority.templateId ||
    after.kind !== data.actionKind ||
    after.scope !== scope ||
    after.lastScanId !== data.scanId ||
    after.state !== (data.direction ?? 'in') ||
    after.holderState !== 'done' ||
    after.holderUndoneBy !== null
  )
    return false;
  if (
    !GATE_FIELDS.every(
      ([alias, field]) => Object.hasOwn(gate, alias) && gate[alias] === after[field],
    )
  )
    return false;
  const presence = effect.presenceAfter;
  if (authority.presenceScope === null)
    return canonicalJson(effect.presenceBefore) === canonicalJson(presence);
  return (
    presenceSnapshot(presence) &&
    presence.passId === row.pass_id &&
    presence.orgId === row.org_id &&
    presence.scope === authority.presenceScope &&
    presence.lastScanId === data.scanId &&
    presence.state === (data.direction ?? 'in')
  );
}

function payload(
  row: EventRow,
  data: ObjectValue,
  gateScope: string | null,
  scanAt: number,
  direction: Direction,
  presenceScope: string | null,
  kind: ReleaseClass,
): ObjectValue | null {
  const authority = data.authority;
  if (
    !object(authority) ||
    releaseClass(authority) !== kind ||
    typeof data.scanId !== 'string' ||
    !data.scanId ||
    Object.hasOwn(data, 'actionId') ||
    (data.actionIdRef !== null &&
      (typeof data.actionIdRef !== 'string' || !/^[0-9a-f]{64}$/.test(data.actionIdRef))) ||
    (data.actionKind === null) !== (data.actionIdRef === null) ||
    (data.actionKind !== null && typeof data.actionKind !== 'string') ||
    (data.eventId !== null && typeof data.eventId !== 'string') ||
    (data.direction ?? null) !== direction ||
    !['ok', 'heads_up', 'refused'].includes(String(data.outcome)) ||
    !Number.isSafeInteger(data.version) ||
    typeof authority.identityId !== 'string' ||
    typeof authority.identityPassTypeIdentifier !== 'string' ||
    typeof authority.identityTeamIdentifier !== 'string' ||
    !Number.isSafeInteger(authority.identityRevision) ||
    Number(authority.identityRevision) <= 0 ||
    typeof authority.passJsonHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(authority.passJsonHash) ||
    typeof authority.evaluatedPersonalizationHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(authority.evaluatedPersonalizationHash) ||
    (authority.personalizationHash !== null &&
      (typeof authority.personalizationHash !== 'string' ||
        !/^[0-9a-f]{64}$/.test(authority.personalizationHash))) ||
    !Number.isSafeInteger(authority.walletVersion) ||
    Number(authority.walletVersion) <= 0 ||
    Number(authority.walletVersion) > Number(data.version) ||
    typeof authority.templateId !== 'string' ||
    typeof authority.pinnedTemplateVersion !== 'string' ||
    (authority.walletTemplateVersion !== null &&
      typeof authority.walletTemplateVersion !== 'string') ||
    typeof authority.activeTemplateVersion !== 'string' ||
    !Number.isSafeInteger(scanAt) ||
    authority.scanAt !== scanAt ||
    authority.presenceScope !== presenceScope ||
    authority.nonQuarantined !== true ||
    !Number.isSafeInteger(authority.linkGeneration) ||
    !Number.isSafeInteger(authority.credentialGeneration) ||
    Number(authority.credentialGeneration) < 1 ||
    !Number.isSafeInteger(authority.lifecycleGeneration) ||
    Number(authority.lifecycleGeneration) < 0 ||
    authority.noPendingTransfer !== true ||
    !Number.isSafeInteger(authority.orgRevision) ||
    !Number.isSafeInteger(authority.templateRevision) ||
    (authority.connectionGeneration !== null &&
      !Number.isSafeInteger(authority.connectionGeneration)) ||
    !effectValid(row, data, authority, gateScope)
  )
    return null;
  const recordedAuthority = { ...authority };
  delete recordedAuthority.eventProof;
  return {
    v: 1,
    eventId: row.id,
    orgId: row.org_id,
    passId: row.pass_id,
    mode: row.mode,
    eventKind: row.kind,
    device: row.device,
    actorType: row.actor_type,
    actorId: row.actor_id,
    at: row.at,
    data: { ...data, authority: recordedAuthority },
    gateScope,
    scanAt,
    direction,
    presenceScope,
    releaseClass: kind,
    nonQuarantined: true,
    noScopedRelease: kind === 'legacy',
  };
}

export type { Direction, ObjectValue };
export { object, payload, releaseClass };
