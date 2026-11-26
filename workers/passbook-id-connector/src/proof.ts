import { alert } from './ledger.ts';
import type { SignupRow } from './store.ts';
import type { ProvedSignup } from './types.ts';

/** Clock difference tolerated between this Worker and Polaris ID around a token's life. */
const SKEW = 120_000;

export interface AuditRow {
  userId: string;
  createdAt: number;
  data: Record<string, string>;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** `ACCOUNT_CREATED` rows of one audit page, and whether older pages exist. Anything else in the body is ignored. */
export function parseAuditPage(body: unknown): { rows: AuditRow[]; totalPages: number } {
  const page = body as { data?: unknown; pagination?: { totalPages?: unknown } } | null;
  const rows: AuditRow[] = [];
  for (const raw of Array.isArray(page?.data) ? page.data : []) {
    const r = raw as {
      event?: unknown;
      userID?: unknown;
      createdAt?: unknown;
      data?: Record<string, unknown> | null;
    };
    const at = typeof r.createdAt === 'string' ? Date.parse(r.createdAt) : Number.NaN;
    if (r.event !== 'ACCOUNT_CREATED' || typeof r.userID !== 'string' || Number.isNaN(at)) continue;
    const data: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.data ?? {})) if (typeof v === 'string') data[k] = v;
    rows.push({ userId: r.userID, createdAt: at, data });
  }
  const total = page?.pagination?.totalPages;
  return { rows, totalPages: typeof total === 'number' ? total : 1 };
}

/**
 * Which account each token created. v2.19.3 audit rows carry the token value (`signupToken`), which is
 * compared by SHA-256; the admin layout carries the token id (`signupTokenID`). A row only counts inside the
 * token's life, and a token that matches two different accounts matches none.
 */
export async function matchTokens(
  rows: AuditRow[],
  tokens: SignupRow[],
): Promise<Map<string, string>> {
  const found = new Map<string, Set<string>>();
  for (const row of rows) {
    const hash = row.data.signupToken ? await sha256Hex(row.data.signupToken) : null;
    for (const t of tokens) {
      if (row.createdAt < t.createdAt - SKEW || row.createdAt > t.expiresAt + SKEW) continue;
      if (hash === t.tokenSha256 || row.data.signupTokenID === t.tokenId) {
        const set = found.get(t.tokenId) ?? new Set<string>();
        set.add(row.userId);
        found.set(t.tokenId, set);
      }
    }
  }
  const out = new Map<string, string>();
  for (const [tokenId, subjects] of found) {
    if (subjects.size === 1) out.set(tokenId, [...subjects][0] as string);
    else alert('error', 'binding.proof_ambiguous', { tokenId });
  }
  return out;
}

/** Earliest time any of `tokens` could have created an account: the audit walk stops once it is older than this. */
export const oldestNeeded = (tokens: SignupRow[]): number =>
  Math.min(...tokens.map((t) => t.createdAt)) - SKEW;

export const asProved = (m: Map<string, string>): ProvedSignup[] =>
  [...m].map(([tokenId, subject]) => ({ tokenId, subject }));
