import type { Mode } from '../../../shared/contracts/common.ts';
import type { TemplateAuthority } from '../templates/access.ts';

/** Authors the provider candidate when an Apple release publishes. Never a user id. */
export const SYSTEM_AUTHOR = 'system:wallet-projection';
/** Approves and publishes a system candidate that loses nothing a holder or the door would notice. */
export const SYSTEM_REVIEWER = 'system:wallet-projection:auto';

/**
 * The authority of `wallet.projection_system`, the only caller. It carries no session: the org must be
 * active, and the database decides the rest (the triggers of 0141 let `SYSTEM_REVIEWER` approve only
 * a system candidate whose report has no holder or door item).
 */
export interface SystemAuthority {
  kind: 'system';
  role: 'author' | 'reviewer';
  userId: typeof SYSTEM_AUTHOR | typeof SYSTEM_REVIEWER;
  orgId: string;
  mode: Mode;
}
export type ProjectionAuthority = TemplateAuthority | SystemAuthority;

export const systemAuthority = (
  role: SystemAuthority['role'],
  orgId: string,
  mode: Mode,
): SystemAuthority => ({
  kind: 'system',
  role,
  userId: role === 'author' ? SYSTEM_AUTHOR : SYSTEM_REVIEWER,
  orgId,
  mode,
});

export const isSystemAuthored = (candidate: { authorId: string }): boolean =>
  candidate.authorId === SYSTEM_AUTHOR;

/**
 * Providers whose candidates the platform authors and approves itself. The release, approval, retirement and
 * tombstone proofs (0141, 0230) exempt the system author for exactly these.
 */
export const SYSTEM_AUTHORED_PROVIDERS: readonly string[] = ['google', 'samsung'];

/**
 * Independence from the Apple version author. A system candidate (Google or Samsung) is exempt: its author is
 * the platform, so the person who wrote the version (a solo admin included) may approve it. A human candidate
 * keeps the raw predicate. The author itself is never exempt: `reviewer != author` stays in every statement.
 */
export const versionAuthorIndependentSql = (candidate: string, reviewer: string): string =>
  `(${candidate}.version_author_id IS NULL OR (${candidate}.author_id = '${SYSTEM_AUTHOR}' AND ${candidate}.provider IN (${SYSTEM_AUTHORED_PROVIDERS.map((p) => `'${p}'`).join(', ')})) OR ${reviewer} != ${candidate}.version_author_id)`;

/**
 * A stored approval that stands for this candidate: an independent reviewer's, or a `sole` one, which
 * the approval trigger only writes for the org's only reviewer (the release trigger voids it if a
 * reviewer joined since).
 */
export const approvalStandsSql = (approval: string, candidate: string): string =>
  `(${approval}.kind = 'sole' OR (${approval}.reviewer_id != ${candidate}.author_id AND ${versionAuthorIndependentSql(candidate, `${approval}.reviewer_id`)}))`;
