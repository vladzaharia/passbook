import type { ServiceContext } from '../../platform/service-context.ts';

export interface Adoption {
  hash: string;
  workerId: string | null;
  uploadedAt: number | null;
}

export function workerAdoption(ctx: ServiceContext, hash: string): Adoption {
  const worker = ctx.env.CF_VERSION;
  const parsed = worker?.timestamp ? Date.parse(worker.timestamp) : NaN;
  const ordered = Boolean(worker?.id) && Number.isFinite(parsed);
  return {
    hash,
    workerId: ordered ? worker.id : null,
    uploadedAt: ordered ? parsed : null,
  };
}

export function readAdoption(value: string | null): Adoption | null {
  if (value === null) return null;
  const parsed: unknown = JSON.parse(value);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('hash' in parsed) ||
    typeof parsed.hash !== 'string' ||
    !('workerId' in parsed) ||
    (parsed.workerId !== null && typeof parsed.workerId !== 'string') ||
    !('uploadedAt' in parsed) ||
    (parsed.uploadedAt !== null &&
      (typeof parsed.uploadedAt !== 'number' || !Number.isFinite(parsed.uploadedAt))) ||
    (parsed.uploadedAt !== null && (typeof parsed.workerId !== 'string' || !parsed.workerId))
  )
    throw new Error('Baked template adoption state is malformed');
  return parsed as Adoption;
}

export function selectAdoption(
  current: Adoption | null,
  incoming: Adoption,
  legacy: string | null,
  legacyUpdatedAt: number | null,
): { value: Adoption; replaceHead: boolean; stale: boolean } {
  let stale = false;
  let replaceHead = true;
  if (!current) {
    if (legacy !== null) {
      const hash: unknown = JSON.parse(legacy);
      if (typeof hash !== 'string') throw new Error('Legacy baked template hash is malformed');
      stale =
        hash !== incoming.hash &&
        (incoming.uploadedAt === null ||
          legacyUpdatedAt === null ||
          incoming.uploadedAt <= legacyUpdatedAt);
    }
  } else if (current.uploadedAt === null || incoming.uploadedAt === null) {
    stale = current.hash !== incoming.hash;
    replaceHead = false;
  } else {
    stale =
      incoming.uploadedAt < current.uploadedAt ||
      (incoming.uploadedAt === current.uploadedAt &&
        (incoming.workerId !== current.workerId || incoming.hash !== current.hash));
  }
  return {
    stale,
    value:
      current && incoming.uploadedAt === null && current.uploadedAt !== null ? current : incoming,
    replaceHead,
  };
}
