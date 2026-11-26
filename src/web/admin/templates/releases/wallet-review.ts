import { omissionKey, omissionKeys } from '@/passkit/wallets/fidelity.ts';
import type {
  TemplateCandidate,
  TemplateCandidateCurrent,
  TemplateRelease,
} from '@/shared/contracts/template-releases.ts';

/** One thing the wallet will not show, as a reviewer approves it. */
export interface Omission {
  key: string;
  capability: string;
  path: string;
  message: string;
  /** Who notices: a customer or the door. */
  group: 'holder' | 'door';
}

export type WalletReview =
  | { kind: 'off' }
  | { kind: 'blocked'; reason: string }
  | {
      kind: 'ready' | 'omissions' | 'released' | 'review';
      /** Every omission the report has, sorted by key. */
      items: readonly Omission[];
      /** The keys the pinned approval covers. */
      approved: ReadonlySet<string>;
      /** Omissions with no approval yet: all of them before a release, the new ones after it. */
      pending: readonly Omission[];
      /** The compiled type moved off the approved one: a Q21 pause the omissions do not show. */
      typeChanged?: { from: string; to: string };
    };

/** The compiled type a schema 2 candidate pinned. */
function pinnedType(candidate: TemplateCandidate | undefined): string | undefined {
  const projection = candidate?.projection as { schema?: unknown; type?: unknown } | undefined;
  return projection?.schema === 2 && typeof projection.type === 'string'
    ? projection.type
    : undefined;
}

/** The omissions a schema 2 candidate pinned; none for schema 1 or no candidate. */
function pinnedKeys(candidate: TemplateCandidate | undefined): Set<string> {
  const projection = candidate?.projection as
    | { schema?: unknown; approvedOmissions?: unknown }
    | undefined;
  return projection?.schema === 2 && Array.isArray(projection.approvedOmissions)
    ? new Set(projection.approvedOmissions.filter((k): k is string => typeof k === 'string'))
    : new Set();
}

/**
 * One wallet's review from the report the server compiles now and the release it serves. The
 * rules (what needs approval, the keys) are the engine's; this only compares the two.
 */
export function walletReview(
  current: TemplateCandidateCurrent,
  active: TemplateRelease | null,
  candidates: readonly TemplateCandidate[],
): WalletReview {
  const { report } = current;
  if (report.status.kind === 'off') return { kind: 'off' };
  if (report.status.kind === 'blocked') return { kind: 'blocked', reason: report.status.reason };
  const keys = new Set(omissionKeys(report));
  const items: Omission[] = report.items
    .filter((item) => keys.has(omissionKey(item)))
    .map((item) => ({
      key: omissionKey(item),
      capability: item.capability,
      path: item.path,
      message: item.message,
      group: item.group === 'door' ? ('door' as const) : ('holder' as const),
    }))
    .filter((item, at, all) => all.findIndex((other) => other.key === item.key) === at)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const serving = active?.version === current.version ? active : null;
  const source = serving ? candidates.find((c) => c.id === serving.candidateId) : undefined;
  const approved = serving ? pinnedKeys(source) : new Set<string>();
  const pending = items.filter((item) => !approved.has(item.key));
  // The offer paths pause on a changed type too (Q21), so the row must not read Released.
  const from = pinnedType(source);
  const typeChanged = serving && from !== undefined && from !== report.type;
  const kind = serving
    ? pending.length > 0 || typeChanged
      ? 'review'
      : 'released'
    : items.length > 0
      ? 'omissions'
      : 'ready';
  return {
    kind,
    items,
    approved,
    pending,
    ...(typeChanged && from !== undefined ? { typeChanged: { from, to: report.type } } : {}),
  };
}

/** The fidelity words of the report: "Ready" or "Ready with omissions (n)". */
export const fidelityWords = (count: number): string =>
  count > 0 ? `Ready with omissions (${count})` : 'Ready';
