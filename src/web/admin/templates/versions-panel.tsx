import { Smartphone } from 'lucide-react';
import { useState } from 'react';
import type { z } from 'zod';
import type { TemplateDetailSchema, TemplateVersionSchema } from '@/shared/contracts/templates.ts';
import { formatDateTime } from '../../lib/format.ts';
import { Badge, Button, Card, CardBody, CardHeader, ListRow, ListRows } from '../../ui/index.ts';
import { TellHoldersLink } from '../passes/change/entry-links.tsx';
import { ValidationReport } from './validation-report.tsx';
import { shortVersion, versionName, versionNumber } from './versions.ts';

type Template = z.infer<typeof TemplateDetailSchema>;
type Version = z.infer<typeof TemplateVersionSchema>;

function Pills({ v }: { v: Version }) {
  const errors = v.report.issues.filter((i) => i.severity === 'error').length;
  const warnings = v.report.issues.filter((i) => i.severity === 'warning').length;
  return (
    <>
      {warnings > 0 ? (
        <Badge tone="warning">
          {warnings} {warnings === 1 ? 'warning' : 'warnings'}
        </Badge>
      ) : null}
      {errors > 0 ? (
        <Badge tone="danger">
          {errors} {errors === 1 ? 'error' : 'errors'}
        </Badge>
      ) : null}
    </>
  );
}

export function VersionsPanel({
  template,
  draft,
  onTry,
  onRelease,
}: {
  template: Template;
  /** The newest valid version newer than Live: the one a release names. */
  draft?: string | undefined;
  /** Set for a viewer who may release: Try and Release show on each valid, non-Live version. */
  onTry?: ((version: string) => void) | undefined;
  onRelease?: ((version: string) => void) | undefined;
}) {
  const [report, setReport] = useState<string | undefined>(
    template.versions.find((v) => v.active)?.version ?? template.versions[0]?.version,
  );
  const shown = template.versions.find((v) => v.version === report);
  const newestFirst = [...template.versions].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader
          title="Saved versions"
          actions={
            template.orgId && template.passesOnOlderVersions > 0 ? (
              <TellHoldersLink orgId={template.orgId} templateId={template.id} />
            ) : undefined
          }
        />
        <CardBody>
          <ListRows label="Versions">
            {newestFirst.map((v) => {
              const n = versionNumber(template, v.version);
              const name = shortVersion(n);
              const releasable = v.report.ok && !v.active;
              return (
                <ListRow
                  key={v.version}
                  title={name}
                  pills={
                    <>
                      {v.version === draft ? <Badge>Draft</Badge> : null}
                      {v.active ? <Badge tone="success">Live</Badge> : null}
                      <Pills v={v} />
                    </>
                  }
                  meta={
                    <>
                      {formatDateTime(v.createdAt)} · {v.passCount}{' '}
                      {v.passCount === 1 ? 'pass' : 'passes'}
                    </>
                  }
                  trailing={
                    <div className="flex items-center gap-2">
                      {releasable && onTry ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          iconStart={<Smartphone aria-hidden />}
                          aria-label={`Try ${name}`}
                          onClick={() => onTry(v.version)}
                        >
                          Try
                        </Button>
                      ) : null}
                      {releasable && onRelease ? (
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={`Release ${name}`}
                          onClick={() => onRelease(v.version)}
                        >
                          Release
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Report for ${name}`}
                        onClick={() => setReport(v.version)}
                      >
                        Report
                      </Button>
                    </div>
                  }
                />
              );
            })}
          </ListRows>
        </CardBody>
      </Card>
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
