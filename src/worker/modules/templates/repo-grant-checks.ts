import type { Check } from '../../platform/authority-checks.ts';
import type { DenyReason } from '../../platform/errors.ts';
import {
  APPLE_ADAPTER_CAPABILITIES,
  APPLE_ADAPTER_REVISION,
  AUDIENCE_POLICY_REVISION,
} from './release-content.ts';

const capabilities = JSON.stringify(APPLE_ADAPTER_CAPABILITIES);

/** A custom check reads template tables and compares tenant columns with the actor row `a`. */
const check = (reason: DenyReason, sql: (bind: (v: string | number | null) => string) => string) =>
  ({ reason, ok: (b) => sql((v) => b.bind(v)) }) satisfies Check;

/**
 * Deferred platform work (an import by an administrator) stops when the user is disabled or no longer
 * an administrator (`last_roles`, refreshed at each sign-in; the session that queued it is not checked).
 */
export const userIsActiveAdmin = (userId: string): Check =>
  check(
    'actor',
    (p) => `EXISTS (SELECT 1 FROM users u WHERE u.id = ${p(userId)} AND u.status = 'active'
      AND json_valid(u.last_roles)
      AND EXISTS (SELECT 1 FROM json_each(u.last_roles) r WHERE r.value = 'admin'))`,
  );

/** The version exists, was written by `versionAuthorId`, and its template is an active uploaded one in reach. */
export const candidateTemplate = (
  templateId: string,
  version: string,
  versionAuthorId: string | null,
): Check =>
  check(
    'lineage',
    (p) => `EXISTS (SELECT 1 FROM templates t
      JOIN template_versions v ON v.template_id = t.id AND v.version = ${p(version)}
      WHERE t.id = ${p(templateId)} AND (t.org_id IS NULL OR t.org_id = a.org_id)
        AND t.origin = 'uploaded' AND t.status = 'active' AND v.created_by IS ${p(versionAuthorId)})`,
  );

/**
 * A candidate of the actor's org that this reviewer may approve: same hash, an independent reviewer
 * (not the candidate or version author), its version still the author's, and an active template.
 */
export const approvable = (
  candidateId: string,
  candidateHash: string,
  reviewerId: string,
  membershipId: string,
): Check =>
  check(
    'lineage',
    (p) => `EXISTS (SELECT 1 FROM template_candidates c
      JOIN templates t ON t.id = c.template_id AND (t.org_id IS NULL OR t.org_id = c.org_id)
      JOIN template_versions v ON v.template_id = c.template_id AND v.version = c.version
      WHERE c.id = ${p(candidateId)} AND c.candidate_hash = ${p(candidateHash)} AND c.org_id = a.org_id
        AND EXISTS (SELECT 1 FROM org_memberships m WHERE m.id = ${p(membershipId)} AND m.user_id = ${p(reviewerId)})
        AND c.author_id != ${p(reviewerId)}
        AND (c.version_author_id IS NULL OR c.version_author_id != ${p(reviewerId)})
        AND v.created_by IS c.version_author_id AND t.status = 'active')`,
  );

/** The newest generation of the (template, org, mode, provider) scope is the one the caller read. */
export const headGeneration = (
  templateId: string,
  mode: string,
  provider: string,
  generation: number,
): Check =>
  check(
    'release',
    (p) => `COALESCE((SELECT MAX(r.generation) FROM template_releases r
      WHERE r.template_id = ${p(templateId)} AND r.org_id = a.org_id
        AND r.mode = ${p(mode)} AND r.provider = ${p(provider)}), 0) = ${p(generation)}`,
  );

export interface PublishFacts {
  candidateId: string;
  approvalId: string;
  candidateHash: string;
  expectedStatus: 'active' | 'archived';
  /** The scope's current head, for the adapter and audience monotonic checks. */
  headId: string | null;
  action: 'release' | 'rollback';
  targetReleaseId: string | null;
  expectedGeneration: number;
}

/**
 * The approved candidate may become the head: its approval is independent and matches the hash, the
 * template is uploaded and in the expected state (an archived live template of this org may be rolled
 * back), the adapter and audience policy are current and no older than the head's, and a release
 * is new for its candidate while a rollback targets an earlier approved release of the same candidate.
 */
export const publishable = (f: PublishFacts): Check =>
  check('lineage', (p) => {
    const monotonic = (column: string) =>
      `c.${column} >= COALESCE((SELECT h.${column} FROM template_releases h WHERE h.id = ${p(f.headId)}), 0)`;
    const target = () =>
      f.action === 'release'
        ? `${p(f.targetReleaseId)} IS NULL AND NOT EXISTS (SELECT 1 FROM template_releases r
            WHERE r.candidate_id = c.id AND r.source = 'approved')`
        : `EXISTS (SELECT 1 FROM template_releases r WHERE r.id = ${p(f.targetReleaseId)}
            AND r.template_id = c.template_id AND r.org_id = c.org_id AND r.mode = c.mode
            AND r.provider = c.provider AND r.source = 'approved'
            AND (r.generation < ${p(f.expectedGeneration)}
              OR (r.generation = ${p(f.expectedGeneration)} AND t.status = 'archived'
                AND c.mode = 'live' AND t.org_id = c.org_id))
            AND r.candidate_id = c.id AND r.approval_id = ap.id
            AND r.candidate_hash = c.candidate_hash AND r.version = c.version)`;
    return `EXISTS (SELECT 1 FROM template_candidates c
      JOIN template_approvals ap ON ap.candidate_id = c.id AND ap.candidate_hash = c.candidate_hash
      JOIN templates t ON t.id = c.template_id AND (t.org_id IS NULL OR t.org_id = c.org_id)
      JOIN template_versions v ON v.template_id = c.template_id AND v.version = c.version
      WHERE c.id = ${p(f.candidateId)} AND ap.id = ${p(f.approvalId)}
        AND c.candidate_hash = ${p(f.candidateHash)} AND c.org_id = a.org_id
        AND t.origin = 'uploaded' AND t.status = ${p(f.expectedStatus)}
        AND v.created_by IS c.version_author_id
        AND (t.status = 'active' OR (c.mode = 'live' AND t.org_id = c.org_id))
        AND ap.reviewer_id != c.author_id
        AND (c.version_author_id IS NULL OR ap.reviewer_id != c.version_author_id)
        AND c.provider = 'apple' AND c.adapter_revision = ${p(APPLE_ADAPTER_REVISION)}
        AND c.adapter_capabilities = ${p(capabilities)}
        AND c.audience_policy_revision = ${p(AUDIENCE_POLICY_REVISION)}
        AND ${monotonic('adapter_revision')} AND ${monotonic('audience_policy_revision')}
        AND ${target()})`;
  });

export interface ImportIdentityFacts {
  uploadId: string;
  objectKey: string;
  createdBy: string | null;
  templateId: string;
  version: string;
}

/** The import record is still the one that was queued, in the actor's org (or the platform). */
export const importMatches = (f: ImportIdentityFacts): Check =>
  check(
    'lineage',
    (p) => `EXISTS (SELECT 1 FROM template_imports i
      WHERE i.upload_id = ${p(f.uploadId)} AND i.org_id IS a.org_id
        AND i.object_key = ${p(f.objectKey)} AND i.created_by IS ${p(f.createdBy)}
        AND (i.step = 'persist' OR (i.step = 'done' AND i.template_id = ${p(f.templateId)}
          AND i.version = ${p(f.version)})))`,
  );

/** A clone source still exists and belongs to the org the reader was authorized for. */
export const cloneSource = (id: string, version: string): Check =>
  check(
    'lineage',
    (p) => `EXISTS (SELECT 1 FROM templates s JOIN template_versions sv ON sv.template_id = s.id
      WHERE s.id = ${p(id)} AND sv.version = ${p(version)} AND s.status != 'deleted'
        AND s.org_id IS a.org_id)`,
  );

/** A shared source: no org reader grant exists, so only existence is checked. */
export const sharedCloneSource = (id: string, version: string): Check =>
  check(
    'lineage',
    (p) => `EXISTS (SELECT 1 FROM templates s JOIN template_versions sv ON sv.template_id = s.id
      WHERE s.id = ${p(id)} AND sv.version = ${p(version)} AND s.status != 'deleted'
        AND s.org_id IS NULL)`,
  );

const HISTORY = `(EXISTS (SELECT 1 FROM template_candidates h WHERE h.template_id = t.id)
  OR EXISTS (SELECT 1 FROM template_releases h WHERE h.template_id = t.id))`;

/** `withHistory`: kept releases or candidates (soft delete); `false`: none (hard delete). */
export const historyIs = (templateId: string, withHistory: boolean): Check =>
  check(
    'lineage',
    (p) => `EXISTS (SELECT 1 FROM templates t WHERE t.id = ${p(templateId)}
      AND ${withHistory ? '' : 'NOT '}${HISTORY})`,
  );

export const noPasses = (templateId: string): Check =>
  check('lineage', (p) => `NOT EXISTS (SELECT 1 FROM passes WHERE template_id = ${p(templateId)})`);

/**
 * A reassignment is allowed: no candidates or releases, an unversioned uploaded template, and no
 * live pass of another org than the destination.
 */
export const assignable = (templateId: string, destinationOrgId: string | null): Check =>
  check(
    'lineage',
    (p) => `EXISTS (SELECT 1 FROM templates t WHERE t.id = ${p(templateId)}
      AND (t.origin = 'baked' OR t.active_version IS NULL) AND NOT ${HISTORY}
      AND NOT EXISTS (SELECT 1 FROM scan_event_templates se WHERE se.template_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM scanner_templates st WHERE st.template_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM scanning_sessions ss, json_each(ss.accepts, '$.templateIds') j
        WHERE ss.accepts IS NOT NULL AND j.value = t.id)
      AND (${p(destinationOrgId)} IS NULL OR NOT EXISTS (SELECT 1 FROM passes x
        WHERE x.template_id = t.id AND x.org_id != ${p(destinationOrgId)} AND x.deleted_at IS NULL)))`,
  );

export interface AdoptionFacts {
  adoptionKey: string;
  hashKey: string;
  value: string | null;
  legacy: string | null;
  legacyUpdatedAt: number | null;
}

/** The baked-build adoption settings are what the syncing build read: the loser of a race is refused. */
export const adoptionUnchanged = (f: AdoptionFacts): Check =>
  check(
    'stale',
    (
      p,
    ) => `(SELECT value FROM settings WHERE scope = 'system' AND key = ${p(f.adoptionKey)}) IS ${p(f.value)}
      AND (SELECT value FROM settings WHERE scope = 'system' AND key = ${p(f.hashKey)}) IS ${p(f.legacy)}
      AND (SELECT updated_at FROM settings WHERE scope = 'system' AND key = ${p(f.hashKey)}) IS ${p(f.legacyUpdatedAt)}`,
  );

/** The scope's newest release generation (the platform scope has no org) is the one the sync read. */
export const bakedHeadGeneration = (
  templateId: string,
  orgId: string | null,
  mode: string,
  generation: number,
): Check =>
  check(
    'release',
    (p) => `COALESCE((SELECT MAX(r.generation) FROM template_releases r
      WHERE r.template_id = ${p(templateId)} AND r.org_id IS ${p(orgId)}
        AND r.mode = ${p(mode)} AND r.provider = 'apple'), 0) = ${p(generation)}`,
  );

/** The newest Live release of the template's owning org is not an approved one (nothing to roll back to). */
const APPROVED_LIVE_HEAD = `EXISTS (SELECT 1 FROM template_releases r
  WHERE r.template_id = t.id AND r.org_id = t.org_id AND r.mode = 'live' AND r.provider = 'apple'
    AND r.source = 'approved'
    AND r.generation = (SELECT MAX(x.generation) FROM template_releases x
      WHERE x.template_id = r.template_id AND x.org_id = r.org_id AND x.mode = 'live' AND x.provider = 'apple'))`;

/** Restore flips the status only while no approved Live head of the owning org exists; a shared template has none. */
export const noApprovedLiveHead = (templateId: string): Check =>
  check(
    'lineage',
    (p) =>
      `EXISTS (SELECT 1 FROM templates t WHERE t.id = ${p(templateId)} AND NOT ${APPROVED_LIVE_HEAD})`,
  );
