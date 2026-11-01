import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { toast as sonner } from 'sonner';
import type { z } from 'zod';
import type { TemplateDetailSchema, TemplateVersionSchema } from '@/shared/contracts/templates.ts';
import { ACTION_ICON } from '../../lib/action-icons.ts';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CheckboxField,
  ConfirmDialog,
  Dialog,
  DialogContent,
  StatusPill,
  toast,
} from '../../ui/index.ts';
import { formatDate } from '../passes/format.ts';
import { useTemplateActions } from './api.ts';
import { ValidationReport } from './validation-report.tsx';

type Template = z.infer<typeof TemplateDetailSchema>;
type Version = z.infer<typeof TemplateVersionSchema>;

function ActivateDialog({
  template,
  version,
  onClose,
}: {
  template: Template;
  version: Version | null;
  onClose: () => void;
}) {
  const actions = useTemplateActions(template.id);
  const [rebuild, setRebuild] = useState(false);
  return (
    <Dialog open={version !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        size="sm"
        title={`Activate ${version?.version.slice(0, 8) ?? ''}`}
        footer={
          <>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              loading={actions.activate.isPending}
              onClick={async () => {
                if (!version) return;
                try {
                  await actions.activate.mutateAsync({
                    version: version.version,
                    rebuildPasses: rebuild,
                  });
                  toast.success(rebuild ? 'Activated. Rebuilding passes.' : 'Activated');
                  onClose();
                } catch (cause) {
                  toast.error(cause);
                }
              }}
            >
              Activate
            </Button>
          </>
        }
      >
        <CheckboxField
          label="Rebuild all passes on this template"
          checked={rebuild}
          onCheckedChange={(c) => setRebuild(c === true)}
        />
      </DialogContent>
    </Dialog>
  );
}

/** Moves every pass on an older version to the active one, after a confirm with the count. */
function UpdatePasses({ template }: { template: Template }) {
  const actions = useTemplateActions(template.id);
  const navigate = useNavigate();
  const [ask, setAsk] = useState(false);
  const n = template.passesOnOlderVersions;
  if (n === 0 || template.status !== 'active') return null;
  const label = `Update ${n} ${n === 1 ? 'pass' : 'passes'}`;
  return (
    <>
      <Button
        size="sm"
        iconStart={<ACTION_ICON.refresh aria-hidden />}
        onClick={() => setAsk(true)}
      >
        {label}
      </Button>
      <ConfirmDialog
        open={ask}
        onOpenChange={setAsk}
        title={`${label}?`}
        description="Each moves to the active version and devices get the update."
        confirmLabel={label}
        onConfirm={async () => {
          await actions.reissue.mutateAsync();
          sonner.success(`Updating ${n} ${n === 1 ? 'pass' : 'passes'}`, {
            duration: 6000,
            action: { label: 'View run', onClick: () => void navigate({ to: '/admin/status' }) },
          });
        }}
      />
    </>
  );
}

export function VersionsPanel({ template }: { template: Template }) {
  const [pick, setPick] = useState<Version | null>(null);
  const [report, setReport] = useState<string | undefined>(
    template.versions.find((v) => v.active)?.version ?? template.versions[0]?.version,
  );
  const shown = template.versions.find((v) => v.version === report);
  const baked = template.origin === 'baked';

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader title="Versions" />
        <CardBody>
          <ul className="divide-y divide-border">
            {template.versions.map((v) => {
              const errors = v.report.issues.filter((i) => i.severity === 'error').length;
              const warnings = v.report.issues.length - errors;
              return (
                <li
                  key={v.version}
                  className="flex flex-wrap items-center justify-between gap-3 py-2"
                >
                  <div className="text-sm">
                    <span className="font-mono text-xs text-fg-strong">
                      {v.version.slice(0, 12)}
                    </span>
                    <span className="ml-3 text-xs text-fg-muted">{formatDate(v.createdAt)}</span>
                    {v.active ? (
                      <StatusPill status="active" tone="success" className="ml-2" />
                    ) : null}
                    <span className="ml-3 text-xs text-fg-muted tabular-nums">
                      Passes: {v.passCount}
                    </span>
                    {errors > 0 ? (
                      <Badge tone="danger" className="ml-2">
                        {errors} {errors === 1 ? 'error' : 'errors'}
                      </Badge>
                    ) : null}
                    {warnings > 0 ? (
                      <Badge tone="warning" className="ml-2">
                        {warnings} {warnings === 1 ? 'warning' : 'warnings'}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="flex gap-2">
                    {v.active ? <UpdatePasses template={template} /> : null}
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Report for ${v.version.slice(0, 12)}`}
                      onClick={() => setReport(v.version)}
                    >
                      Report
                    </Button>
                    {baked || v.active ? null : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!v.report.ok}
                        aria-label={`Activate ${v.version.slice(0, 12)}`}
                        onClick={() => setPick(v)}
                      >
                        Activate
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </CardBody>
      </Card>
      {shown ? (
        <Card>
          <CardHeader title={`Validation ${shown.version.slice(0, 12)}`} />
          <CardBody>
            <ValidationReport report={shown.report} />
          </CardBody>
        </Card>
      ) : null}
      <ActivateDialog template={template} version={pick} onClose={() => setPick(null)} />
    </div>
  );
}
