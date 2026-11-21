import type { AppleRpc, CallRow } from '../../../../workers/apple-provisioner/src/types.ts';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  UnavailableError,
  UpstreamError,
} from '../../platform/errors.ts';

const CODE = /^(ASC_[A-Z_]+): ?(.*)$/s;

/** Maps an RPC failure to an AppError. The provisioner sends its code as the message prefix. */
export function mapAscError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const message = error instanceof Error ? error.message : '';
  const [, code, text] = CODE.exec(message) ?? [];
  switch (code) {
    case 'ASC_REFUSED':
      return new ForbiddenError(text || 'Apple provisioner refused the request.', 'ASC_REFUSED');
    case 'ASC_BUDGET':
      return new RateLimitedError(60, 'Apple provisioner budget reached. Try again later.');
    case 'ASC_NOT_FOUND':
      return new NotFoundError(text || 'Apple has no such resource.', 'ASC_NOT_FOUND');
    case 'ASC_CONFLICT':
      return new ConflictError(text || 'Apple reports a conflict.', 'ASC_CONFLICT');
    case 'ASC_AUTH':
      return new UnavailableError('Apple rejected the provisioner key.', 'ASC_AUTH');
    case 'ASC_UPSTREAM':
      return new UpstreamError(text || 'Apple request failed.', 'ASC_UPSTREAM');
    default:
      return new UpstreamError('Apple provisioner call failed.', 'ASC_UPSTREAM');
  }
}

/** Typed wrapper over the `APPLE` service binding. Every failure is an AppError. */
export function ascClient(env: { APPLE?: unknown }): AppleRpc {
  const rpc = env.APPLE as AppleRpc | undefined;
  const call = async <T>(run: (r: AppleRpc) => Promise<T>): Promise<T> => {
    if (!rpc) throw new UnavailableError('Apple provisioner is not configured.', 'ASC_UNAVAILABLE');
    try {
      return await run(rpc);
    } catch (error) {
      throw mapAscError(error);
    }
  };
  return {
    createPassType: (handle, name, runId) => call((r) => r.createPassType(handle, name, runId)),
    createCertificate: (id, csr, nfc, runId) =>
      call((r) => r.createCertificate(id, csr, nfc, runId)),
    listCertificates: (id, runId) => call((r) => r.listCertificates(id, runId)),
    revokeCertificate: (id, reason, runId) => call((r) => r.revokeCertificate(id, reason, runId)),
    findPassType: (identifier, runId) => call((r) => r.findPassType(identifier, runId)),
    calls: (since) => call((r) => r.calls(since)),
  };
}

/** The provisioner's call ledger since `since` (ms), without Apple's request ids. `available: false` when it is not bound. */
export async function listAppleCalls(
  env: object,
  since: number,
): Promise<{ available: boolean; items: Omit<CallRow, 'appleRequestId'>[] }> {
  try {
    const calls = await ascClient(env as { APPLE?: unknown }).calls(since);
    return { available: true, items: calls.map(({ appleRequestId: _id, ...c }) => c) };
  } catch (error) {
    if (error instanceof UnavailableError && error.code === 'ASC_UNAVAILABLE')
      return { available: false, items: [] };
    throw error;
  }
}
