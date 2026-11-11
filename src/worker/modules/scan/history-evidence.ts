import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './guard.ts';
import { type HistoryPolicy, historyPolicy } from './history-policy.ts';
import { historyProofPolicySources, historyProofSnapshots } from './history-proof.ts';
import type { VerifiedHistoryProof } from './repo-history-proof-cas.ts';
import type { HistoryProofFenceStmt } from './repo-scan-history.ts';

/** Read proof, manifest and personalization evidence in bounded pages, without Wallet or R2 reads. */
export async function historyEvidence(
  ctx: ServiceContext,
  actor: ScanActor,
  ids: readonly string[],
) {
  const unique = [...new Set(ids)];
  const cache = new Map<string, VerifiedHistoryProof | null>();
  const proofCache = new Map<string, Promise<boolean>>();
  const proofs = new Map<string, VerifiedHistoryProof>();
  const policies = new Map<string, HistoryPolicy>();
  for (let at = 0; at < unique.length; at += 100) {
    const page = await historyProofSnapshots(
      ctx,
      actor,
      unique.slice(at, at + 100),
      cache,
      proofCache,
    );
    await Promise.all(
      [...page].map(async ([id, proof]) => {
        proofs.set(id, proof);
        const sources = historyProofPolicySources(proof);
        if (!proof.projectionCurrent || !sources) return;
        const policy = await historyPolicy(ctx.env, { ...sources, role: actor.role, proofCache });
        if (policy) policies.set(id, policy);
      }),
    );
  }
  return { proofs, policies };
}

/** Count a scan once only when every corresponding fragment returned the same exact row. */
export function verifiedHistoryRows(
  entries: readonly HistoryProofFenceStmt[],
  results: readonly D1Result[],
): Map<string, string | null> {
  if (entries.length !== results.length) return new Map();
  const seen = new Map<
    string,
    { expected: number; matched: number; action: string | null | undefined; valid: boolean }
  >();
  entries.forEach(({ scanId }, index) => {
    const state = seen.get(scanId) ?? { expected: 0, matched: 0, action: undefined, valid: true };
    state.expected++;
    const rows = results[index]?.results;
    const row = rows?.[0] as { id?: unknown; action_id?: unknown } | undefined;
    if (
      rows?.length !== 1 ||
      !row ||
      row.id !== scanId ||
      (row.action_id !== null && typeof row.action_id !== 'string') ||
      (state.action !== undefined && state.action !== row.action_id)
    ) {
      state.valid = false;
    } else {
      state.action = row.action_id as string | null;
      state.matched++;
    }
    seen.set(scanId, state);
  });
  return new Map(
    [...seen].flatMap(([id, state]) =>
      state.valid &&
      state.expected > 0 &&
      state.matched === state.expected &&
      state.action !== undefined
        ? [[id, state.action] as const]
        : [],
    ),
  );
}
