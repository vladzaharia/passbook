import { useState } from 'react';
import type { z } from 'zod';
import type { TemplateDetailSchema, TemplateVersionSchema } from '@/shared/contracts/templates.ts';
import { formatDateTime } from '../../lib/format.ts';
import { Badge, Button, Card, CardBody, CardHeader, ListRow, ListRows } from '../../ui/index.ts';
import { ValidationReport } from './validation-report.tsx';
import { versionName, versionNumber } from './versions.ts';

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

export function VersionsPanel({ template }: { template: Template }) {
  const [report, setReport] = useState<string | undefined>(
    template.versions.find((v) => v.active)?.version ?? template.versions[0]?.version,
  );
  const shown = template.versions.find((v) => v.version === report);
  const newestFirst = [...template.versions].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader title="Version history" />
        <CardBody>
          <ListRows label="Versions">
            {newestFirst.map((v) => {
              const name = versionName(versionNumber(template, v.version));
              return (
                <ListRow
                  key={v.version}
                  title={name}
                  pills={<Pills v={v} />}
                  meta={
                    <>
                      {formatDateTime(v.createdAt)} · {v.passCount}{' '}
                      {v.passCount === 1 ? 'pass' : 'passes'}
                    </>
                  }
                  trailing={
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Report for ${name}`}
                      onClick={() => setReport(v.version)}
                    >
                      Report
                    </Button>
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
