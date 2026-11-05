import { useState } from 'react';
import type { z } from 'zod';
import type { TemplateDetailSchema, TemplateVersionSchema } from '@/shared/contracts/templates.ts';
import { formatDateTime } from '../../lib/format.ts';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ListRow,
  ListRows,
  StatusPill,
} from '../../ui/index.ts';
import { ActivateDialog } from './activate-dialog.tsx';
import { ValidationReport } from './validation-report.tsx';
import { versionName, versionNumber } from './versions.ts';

type Template = z.infer<typeof TemplateDetailSchema>;
type Version = z.infer<typeof TemplateVersionSchema>;

function Pills({ v }: { v: Version }) {
  const errors = v.report.issues.filter((i) => i.severity === 'error').length;
  const warnings = v.report.issues.filter((i) => i.severity === 'warning').length;
  return (
    <>
      {v.active ? <StatusPill status="active" tone="success" /> : null}
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
  const [pick, setPick] = useState<string | null>(null);
  const [report, setReport] = useState<string | undefined>(
    template.versions.find((v) => v.active)?.version ?? template.versions[0]?.version,
  );
  const shown = template.versions.find((v) => v.version === report);
  const baked = template.origin === 'baked';
  const newestFirst = [...template.versions].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader title="Versions" />
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
                      {v.passCount === 1 ? 'pass' : 'passes'} ·{' '}
                      <span className="font-mono">{v.version.slice(0, 12)}</span>
                    </>
                  }
                  trailing={
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`Report for ${name}`}
                        onClick={() => setReport(v.version)}
                      >
                        Report
                      </Button>
                      {baked || v.active ? null : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!v.report.ok}
                          aria-label={`Activate ${name}`}
                          onClick={() => setPick(v.version)}
                        >
                          Activate
                        </Button>
                      )}
                    </>
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
      <ActivateDialog template={template} version={pick} onClose={() => setPick(null)} />
    </div>
  );
}
