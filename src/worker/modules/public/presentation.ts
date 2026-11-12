import type { PassJson } from '../../../passkit/types.ts';
import { BARCODE_FORMATS } from '../../../shared/pass-view/barcode.ts';
import { validityOf } from '../../../shared/pass-view/validity.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { parseStoredPassJson } from '../passes/detail.ts';
import type { Pass } from '../passes/repo.ts';
import { getOrg } from '../passes/repo-read-issuance.ts';
import { passJsonAtVersion } from './repo.ts';
import { assertPassSnapshot, capturePassSnapshot } from './snapshot.ts';

export interface PresentationBarcode {
  format: string;
  bcid: string;
  message: string;
  square: boolean;
  encoding: string;
}

/** A credential is never projected from an inactive pass, even if its old Wallet copy exists. */
export function canPresent(
  pass: {
    status: string;
    removedAt: number | null;
    deletedAt: number | null;
    testDataQuarantined: boolean;
  },
  json: { voided?: unknown; expirationDate?: unknown },
  now: number,
): boolean {
  return (
    pass.status === 'active' &&
    pass.removedAt === null &&
    pass.deletedAt === null &&
    !pass.testDataQuarantined &&
    validityOf(json, now).status === 'active'
  );
}

/** Match the scanner's primary-barcode rule, not the preview's first supported-format rule. */
function barcodeOf(json: PassJson, scanCode: string | null): PresentationBarcode | null {
  if (json.barcodes !== null && json.barcodes !== undefined && !Array.isArray(json.barcodes)) {
    return null;
  }
  const modern = Array.isArray(json.barcodes) && json.barcodes.length > 0;
  const primary: unknown = modern ? json.barcodes?.[0] : json.barcode;
  if (modern || (primary !== null && primary !== undefined)) {
    if (!primary || typeof primary !== 'object' || Array.isArray(primary)) return null;
    const { format, message, messageEncoding } = primary as Record<string, unknown>;
    const supported =
      typeof format === 'string' && Object.hasOwn(BARCODE_FORMATS, format)
        ? BARCODE_FORMATS[format]
        : undefined;
    if (!supported || typeof format !== 'string' || typeof message !== 'string' || !message) {
      return null;
    }
    const encoding =
      messageEncoding === undefined
        ? 'iso-8859-1'
        : typeof messageEncoding === 'string' && messageEncoding.trim()
          ? messageEncoding
          : null;
    if (!encoding) return null;
    return {
      format,
      bcid: supported.bcid,
      message,
      square: supported.square,
      encoding,
    };
  }
  return scanCode
    ? {
        format: 'PKBarcodeFormatQR',
        bcid: 'qrcode',
        message: scanCode,
        square: true,
        encoding: 'utf-8',
      }
    : null;
}

/** Resolve the current stored credential; possession of this model never authorizes a scan. */
export async function presentationForPass(ctx: ServiceContext, pass: Pass) {
  const snapshot = await capturePassSnapshot(ctx, pass);
  const [raw, org] = await Promise.all([
    passJsonAtVersion(ctx.env.DB, pass.id, pass.version),
    getOrg(ctx.env.DB, pass.orgId),
  ]);
  if (
    pass.status !== 'active' ||
    pass.removedAt !== null ||
    pass.deletedAt !== null ||
    pass.testDataQuarantined
  ) {
    throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  }
  // Without the stored version, validity cannot be established: never expose even the scan code.
  const json = raw ? parseStoredPassJson(raw) : null;
  if (json && !canPresent(pass, json, ctx.clock.now())) {
    throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  }
  const orgName = org?.name ?? '';
  const model = {
    barcode: json ? barcodeOf(json, pass.scanCode) : null,
    orgName,
    passTitle: pass.displayTitle ?? json?.description ?? orgName,
    mode: pass.mode,
  };
  await assertPassSnapshot(ctx, snapshot);
  return model;
}
