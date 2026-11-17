import type { TemplateManifest } from '../../../passkit/types.ts';
import type { ScanRole } from '../../../shared/contracts/scan.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  currentHistoryTitle,
  type HistoryManifest,
  type HistoryPolicy,
  type HistoryPolicyInput,
  historyPolicy,
} from './history-policy.ts';
import {
  type HistoryRaw,
  type HistoryRow,
  policyCandidateOf,
  projectionCurrentOf,
  scanReferenceOf,
} from './history-row.ts';
import { pinKeyset } from './keyset-pin.ts';
import {
  loadManifests,
  type ManifestCache,
  type ManifestKey,
  manifestCacheKey,
} from './repo-template-manifests.ts';
import { type ScanEventProofCache, verifyScanEventProvenance } from './scan-event-proof.ts';

/** Request-local: event MACs and immutable template manifests are verified and read once. */
export interface HistoryEvidenceCache {
  proofs: ScanEventProofCache;
  manifests: ManifestCache;
}

export const createHistoryEvidenceCache = (): HistoryEvidenceCache => ({
  proofs: new Map(),
  manifests: new Map(),
});

/**
 * Run `work` beside the keyset pin of the page's pass-bearing rows: a deployment whose stored keyset
 * is not this one's fails such a page closed (503), and an empty or passless page needs no keyset.
 * The pin is read once per request, in parallel with the page's other reads.
 */
export async function withKeyset<T>(
  ctx: ServiceContext,
  rows: readonly HistoryRow[],
  work: () => Promise<T>,
): Promise<T> {
  const pin = rows.some((row) => row.passId !== null) ? pinKeyset(ctx) : null;
  const [result] = await Promise.all([work(), pin]);
  return result;
}

/**
 * The row's provenance: a passless refusal is its own fact; a pass-bearing scan needs the pass and
 * recorded-proof checks of its snapshot and a valid event MAC. Rows come back marked.
 */
export async function checkProvenance(
  ctx: ServiceContext,
  rows: readonly HistoryRow[],
  cache: HistoryEvidenceCache,
): Promise<HistoryRow[]> {
  return Promise.all(
    rows.map(async (row) => {
      if (row.passlessProofCandidate)
        return { ...row, policyAvailable: row.raw.scan_state === 'done' };
      const scan = scanReferenceOf(row.raw);
      if (row.passId === null || !row.ledger || !scan || !policyCandidateOf(row.raw)) return row;
      const verified = await verifyScanEventProvenance(ctx.env, row.ledger, scan, cache.proofs);
      return verified ? { ...row, policyAvailable: true } : row;
    }),
  );
}

/** What policy evaluation reads, assembled from one row and the keyed manifests. */
export interface HistoryPolicySources extends Omit<HistoryPolicyInput, 'role' | 'proofCache'> {
  currentTitle: string | null;
  currentScannerName: string | null;
}

export interface HistoryEvidence {
  sources: HistoryPolicySources;
  /** The viewer's disclosure policy; null when the event-time policy does not hold. */
  policy: HistoryPolicy | null;
}

function privateValues(raw: HistoryRaw): string[] | null {
  if (!raw.current_wallet_private_values) return null;
  try {
    const values = [
      raw.pass_serial,
      raw.pass_auth_token,
      raw.pass_download_token,
      raw.pass_web_service_url,
      raw.pass_scan_code,
      raw.pass_external_id,
      raw.pass_holder_email,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);
    const collect = (value: unknown): void => {
      if (typeof value === 'string' && value.length > 0) values.push(value);
      else if (Array.isArray(value)) value.forEach(collect);
    };
    collect(JSON.parse(raw.current_wallet_private_values));
    return values;
  } catch {
    return null;
  }
}

function manifestOf(
  cache: ManifestCache,
  org: string,
  template: string | null,
  version: string | null,
): HistoryManifest | null {
  if (!template || !version) return null;
  const raw = cache.get(manifestCacheKey({ orgId: org, templateId: template, version }));
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return { version, manifest: value as TemplateManifest };
  } catch {
    return null;
  }
}

function keysOf(raw: HistoryRaw): ManifestKey[] {
  const templateId = raw.template_id;
  if (templateId === null) return [];
  return [
    raw.event_pinned_version,
    raw.recorded_wallet_template_version,
    raw.event_active_version,
    raw.current_pinned_version,
    raw.current_active_version,
  ].flatMap((version) => (version === null ? [] : [{ orgId: raw.org_id, templateId, version }]));
}

/**
 * Policy evidence for the rows a viewer may see pass-derived data of. A row needs a verified
 * provenance, a proof that matches this snapshot's recorded Wallet row, and a pass that is still
 * current. The keyset commitment is pinned once, and only when some row gets this far.
 */
export async function historyEvidenceOf(
  ctx: ServiceContext,
  rows: readonly HistoryRow[],
  options: {
    role: ScanRole | null;
    cache: HistoryEvidenceCache;
    /** Console, API feed: only rows whose provenance was checked. Staff names need no candidate. */
    requireAvailable: boolean;
    wanted?: (row: HistoryRow) => boolean;
  },
): Promise<Map<string, HistoryEvidence>> {
  const { role, cache } = options;
  const evidence = new Map<string, HistoryEvidence>();
  if (!role) return evidence;
  const eligible: { row: HistoryRow; secrets: string[] }[] = [];
  await Promise.all(
    rows.map(async (row) => {
      const raw = row.raw;
      const scan = scanReferenceOf(raw);
      const secrets = privateValues(raw);
      if (
        (options.requireAvailable && !row.policyAvailable) ||
        (options.wanted && !options.wanted(row)) ||
        row.passId === null ||
        !row.ledger ||
        !scan ||
        secrets === null ||
        (raw.approved_proof !== 1 && raw.legacy_proof !== 1) ||
        !projectionCurrentOf(raw) ||
        typeof raw.current_lifecycle_generation !== 'number' ||
        !Number.isSafeInteger(raw.current_lifecycle_generation) ||
        raw.current_lifecycle_generation < 0 ||
        !(await verifyScanEventProvenance(ctx.env, row.ledger, scan, cache.proofs))
      )
        return;
      eligible.push({ row, secrets });
    }),
  );
  if (!eligible.length) return evidence;
  const [commitment] = await Promise.all([
    pinKeyset(ctx),
    loadManifests(
      ctx.env.DB,
      cache.manifests,
      eligible.flatMap(({ row }) => keysOf(row.raw)),
    ),
  ]);
  await Promise.all(
    eligible.map(async ({ row, secrets }) => {
      const raw = row.raw;
      const scan = scanReferenceOf(raw);
      if (!scan || !row.ledger) return;
      const manifest = (version: string | null) =>
        manifestOf(cache.manifests, raw.org_id, raw.template_id, version);
      const currentPinned = manifest(raw.current_pinned_version);
      const sources: HistoryPolicySources = {
        event: row.ledger,
        scan,
        credentialKeysetCommitment: commitment,
        currentPersonalization: raw.current_personalization,
        versionPersonalization: raw.recorded_personalization,
        currentCredentialGeneration: raw.current_credential_generation,
        transferPending: raw.transfer_pending !== 0,
        eventPinned: manifest(raw.event_pinned_version),
        eventWallet: manifest(raw.recorded_wallet_template_version),
        eventActive: manifest(raw.event_active_version),
        currentPinned,
        currentActive: manifest(raw.current_active_version),
        currentTitle: currentHistoryTitle(currentPinned, raw.current_personalization),
        currentScannerName: raw.scanner_name,
        privateValues: secrets,
      };
      const policy = await historyPolicy(ctx.env, { ...sources, role, proofCache: cache.proofs });
      evidence.set(row.id, { sources, policy });
    }),
  );
  return evidence;
}
