import { type ReactNode, useState } from 'react';
import type { z } from 'zod';
import type { TemplateDetailSchema } from '@/shared/contracts/templates.ts';
import { Card, CardBody, CardHeader } from '../../ui/index.ts';
import type { VersionReleases } from './releases/version-info.ts';
import { ValidationReport } from './validation-report.tsx';
import { VersionList } from './version-list.tsx';
import { versionName, versionNumber } from './versions.ts';

type Template = z.infer<typeof TemplateDetailSchema>;

export function VersionsPanel({
  template,
  draft,
  onTry,
  onRelease,
  canCompare = false,
  releases = null,
  rollout,
}: {
  template: Template;
  /** The newest valid version newer than Live: the one a release names. */
  draft?: string | undefined;
  /** Set for a viewer who may release: Try and Release show in each valid, non-Live version's menu. */
  onTry?: ((version: string) => void) | undefined;
  onRelease?: ((version: string) => void) | undefined;
  /** The release dry run is open to the viewer: rows offer Compare. */
  canCompare?: boolean;
  /** Live and Test, and what a row may restore; null until the releases load. */
  releases?: VersionReleases | null;
  /** How far the Live release has reached the passes: the card's first block. */
  rollout?: ReactNode;
}) {
  const [report, setReport] = useState<string | undefined>(
    template.versions.find((v) => v.active)?.version ?? template.versions[0]?.version,
  );
  const shown = template.versions.find((v) => v.version === report);
  return (
    <div className="grid gap-4">
      <VersionList
        template={template}
        draft={draft}
        onTry={onTry}
        onRelease={onRelease}
        canCompare={canCompare}
        onReport={setReport}
        releases={releases}
        rollout={rollout}
      />
      {shown ? (
        <Card>
          <CardHeader title={`Validation ${versionName(versionNumber(template, shown.version))}`} />
          <CardBody>
            <ValidationReport report={shown.report} />
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
