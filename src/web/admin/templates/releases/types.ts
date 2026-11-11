import type { Mode } from '@/shared/contracts/common.ts';
import type { OrgCapability } from '@/shared/contracts/org-membership.ts';

/** Saved version information supplied by the template detail response. */
export interface ReleaseVersion {
  version: string;
  active: boolean;
  createdAt: number;
  displayOnly: boolean;
  /** Validation outcome; a version with errors cannot become a candidate. */
  report?: { ok: boolean };
}

export interface TemplateReleasesPanelProps {
  templateId: string;
  templateOrigin: 'baked' | 'uploaded';
  templateStatus: 'active' | 'archived' | 'deleted';
  templateOrgId: string | null;
  orgId: string | undefined;
  mode: Mode;
  versions: readonly ReleaseVersion[];
  capabilities: readonly OrgCapability[];
  currentUserId: string | null;
}

/** "Version 2" by age, oldest first; the version hash stays in technical details. */
export function versionLabel(versions: readonly ReleaseVersion[], hash: string): string {
  const byAge = [...versions].sort((a, b) => a.createdAt - b.createdAt);
  const at = byAge.findIndex((v) => v.version === hash);
  return at >= 0 ? `Version ${at + 1}` : 'Earlier version';
}
