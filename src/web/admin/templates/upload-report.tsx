import { Download } from 'lucide-react';
import type { z } from 'zod';
import {
  type ImportStatusSchema,
  importErrorMessage,
  type TemplateDetailSchema,
} from '@/shared/contracts/templates.ts';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Celebrate,
  Skeleton,
} from '../../ui/index.ts';
import { ImportWallets } from '../../wallet-report/import-wallets.tsx';
import { useVersionWalletReports } from './api.ts';
import { TemplateStill } from './gallery.tsx';
import { PackageChecklist, ValidationReport } from './validation-report.tsx';

type ImportStatus = z.infer<typeof ImportStatusSchema>;
type Template = z.infer<typeof TemplateDetailSchema>;

export function UploadReport({
  status: s,
  template,
  files,
  selectedScope,
  finished,
  failed,
  working,
}: {
  status: ImportStatus | undefined;
  template: Template | undefined;
  files: string[] | undefined;
  selectedScope: string;
  finished: boolean;
  failed: boolean;
  working: boolean;
}) {
  const error = s?.error ?? null;
  const wallets = useVersionWalletReports(
    finished && template ? s?.templateId : null,
    s?.version,
    template?.orgId ?? undefined,
  ).data;
  const report = failed ? (
    <>
      <Callout tone="danger" title="Import failed">
        {error && !/^[A-Z][A-Z0-9_]+$/.test(error) ? error : importErrorMessage(error)}
      </Callout>
      {s?.report?.issues.length ? <ValidationReport report={s.report} rise /> : null}
    </>
  ) : s?.report ? (
    <ValidationReport report={s.report} rise />
  ) : working ? (
    <Skeleton className="h-24 w-full" />
  ) : null;

  return (
    <>
      {finished && s?.templateId && template ? (
        <div className="relative">
          <Celebrate when={s.report?.issues.length === 0} />
          <TemplateStill template={template} deal className="mx-auto w-full max-w-56" />
        </div>
      ) : null}
      {wallets ? (
        <section aria-label="Wallet reports">
          <ImportWallets
            reports={wallets}
            templateId={s?.templateId ?? ''}
            orgId={template?.orgId ?? undefined}
          />
        </section>
      ) : null}
      {report ? (
        <section aria-label="Report" className="flex flex-col gap-3">
          {report}
        </section>
      ) : null}
      {finished ? null : (
        <>
          {files ? (
            <Card>
              <CardHeader title="Package" />
              <CardBody>
                <PackageChecklist files={files} />
              </CardBody>
            </Card>
          ) : null}
          <Button
            asChild
            variant="ghost"
            size="sm"
            iconStart={<Download aria-hidden />}
            className="self-start"
          >
            <a
              href={`/api/v1/templates/baked:starter-generic/package?orgId=${encodeURIComponent(selectedScope)}`}
              download
            >
              Download a starter package
            </a>
          </Button>
        </>
      )}
    </>
  );
}
