import type { TemplateRelease } from '@/shared/contracts/template-releases.ts';

/** What the releases tell the Versions list: which version is Live and Test, and what a row may do. */
export interface VersionReleases {
  orgId: string;
  live: string | null;
  test: string | null;
  /** When each version was last released, in either mode. */
  releasedAt: ReadonlyMap<string, number>;
  /** The newest release of each version, for its technical details. */
  releaseOf: ReadonlyMap<string, TemplateRelease>;
  /** Versions whose release was approved by the person who made it. */
  selfApproved: ReadonlySet<string>;
  /** Restore, by version, for the ones the viewer may return Live to. */
  restore: ReadonlyMap<string, () => void>;
  busy: boolean;
}

export function versionReleases(input: {
  orgId: string;
  live: { active: TemplateRelease | null; items: readonly TemplateRelease[] };
  test: { active: TemplateRelease | null; items: readonly TemplateRelease[] };
  selfApprovals: ReadonlySet<string>;
  restorable: (release: TemplateRelease) => boolean;
  onRestore: ((release: TemplateRelease) => void) | null;
  busy: boolean;
}): VersionReleases {
  const releasedAt = new Map<string, number>();
  const releaseOf = new Map<string, TemplateRelease>();
  const selfApproved = new Set<string>();
  const restore = new Map<string, () => void>();
  for (const r of [...input.live.items, ...input.test.items]) {
    const seen = releasedAt.get(r.version);
    if (seen === undefined || r.createdAt > seen) {
      releasedAt.set(r.version, r.createdAt);
      releaseOf.set(r.version, r);
    }
    if (r.approvalId && input.selfApprovals.has(r.approvalId)) selfApproved.add(r.version);
  }
  const { onRestore } = input;
  if (onRestore)
    for (const r of [...input.live.items].sort((a, b) => b.generation - a.generation))
      if (!restore.has(r.version) && input.restorable(r))
        restore.set(r.version, () => onRestore(r));
  return {
    orgId: input.orgId,
    live: input.live.active?.version ?? null,
    test: input.test.active?.version ?? null,
    releasedAt,
    releaseOf,
    selfApproved,
    restore,
    busy: input.busy,
  };
}
