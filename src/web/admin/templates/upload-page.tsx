import { Link } from '@tanstack/react-router';
import { Download } from 'lucide-react';
import { useEffect, useState } from 'react';
import { importErrorMessage } from '@/shared/contracts/templates.ts';
import { ACTION_ICON } from '../../lib/action-icons.ts';
import { errorMessage } from '../../lib/errors.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { useOrgOptions } from '../../lib/search.ts';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Celebrate,
  ErrorState,
  FormField,
  Input,
  PageHeader,
  Select,
  Skeleton,
} from '../../ui/index.ts';
import { useImportStatus, useTemplate, useUploadTemplate } from './api.ts';
import { TemplateStill } from './gallery.tsx';
import { type PackageInfo, readPackage, UploadDrop } from './upload-drop.tsx';
import { PackageChecklist, ValidationReport } from './validation-report.tsx';

const ALL = 'all';
const STEPS: Record<string, number> = {
  queued: 0,
  extract: 1,
  analyze: 2,
  'dry-run': 3,
  persist: 4,
  done: 4,
};
const STEP_TEXT: Record<string, string> = {
  queued: 'Waiting to start',
  extract: 'Opening the package',
  analyze: 'Checking files and images',
  'dry-run': 'Building a sample pass',
  persist: 'Saving the template',
};
/** Which piece slides out: archive problems the header, content the image, builds the barcode. */
const failedPiece = (error: string | null) =>
  error && /ZIP|ARCHIVE|ENTRY|COMPRESSION|PATH|NOT_A_ZIP|TOO_MANY/.test(error)
    ? 0
    : error === 'IMPORT_INVALID'
      ? 1
      : 2;

export function TemplateUploadPage({
  templateId,
  upload: initialUpload,
}: {
  templateId?: string | undefined;
  upload?: string | undefined;
}) {
  const scope = useOrgScope().orgId;
  const orgs = useOrgOptions();
  const base = useTemplate(templateId);
  const upload = useUploadTemplate();
  const [orgId, setOrgId] = useState<string | undefined>(scope);
  const [name, setName] = useState('');
  const [file, setFile] = useState<File>();
  const [info, setInfo] = useState<PackageInfo>();
  const [uploadId, setUploadId] = useState(initialUpload);
  const status = useImportStatus(uploadId);
  const s = status.data;
  const finished = s?.status === 'complete';
  const failed = s?.status === 'errored' || s?.status === 'terminated';
  const result = useTemplate(finished ? (s?.templateId ?? undefined) : undefined);
  const version = base.data ?? undefined;

  // Upload version: org and name come from the template being versioned.
  useEffect(() => {
    if (version) {
      setOrgId(version.orgId ?? undefined);
      setName(version.name);
    }
  }, [version]);

  async function choose(f: File) {
    setFile(f);
    const read = await readPackage(f);
    setInfo(read);
    if (!version && read.name && !name) setName(read.name);
  }
  // A file the server refuses outright never starts an import; the drop zone shows the refusal.
  const [rejected, setRejected] = useState(0);
  async function send(f: File | undefined = file) {
    if (!f) return;
    const res = await upload
      .mutateAsync({ file: f, orgId, name: name.trim() || undefined })
      .catch(() => undefined);
    if (res) setUploadId(res.uploadId);
    else setRejected((n) => n + 1);
  }

  const working = Boolean(uploadId) && !finished && !failed && !status.isError;
  const landed = uploadId ? (finished ? 4 : (STEPS[s?.step ?? 'queued'] ?? 0)) : undefined;
  const title = version ? `New version of ${version.name}` : 'Upload template';

  const left = finished ? (
    <Card>
      <CardHeader
        title={
          result.data && result.data.versions.length > 1
            ? `Version ${result.data.versions.length} of ${result.data.name}`
            : 'New template'
        }
      />
      <CardBody className="flex flex-col gap-4">
        <UploadDrop label="Done" file={file} onFile={() => {}} disabled landed={4} done compact />
        <div className="flex flex-wrap gap-2">
          {s?.templateId ? (
            <Button asChild>
              <Link to="/admin/templates/$templateId" params={{ templateId: s.templateId }}>
                Open template
              </Link>
            </Button>
          ) : null}
          {result.data && result.data.passesOnOlderVersions > 0 ? (
            <Button asChild variant="outline" iconStart={<ACTION_ICON.refresh aria-hidden />}>
              <Link
                to="/admin/templates/$templateId"
                params={{ templateId: s?.templateId ?? '' }}
                search={{ tab: 'versions' }}
              >
                Update passes
              </Link>
            </Button>
          ) : null}
        </div>
      </CardBody>
    </Card>
  ) : (
    <div className="flex flex-col gap-6">
      <UploadDrop
        label={failed ? 'Choose fixed file' : 'Drop a template package'}
        file={file}
        disabled={working || upload.isPending}
        landed={landed}
        failed={failed ? failedPiece(s?.error ?? null) : undefined}
        rejected={rejected}
        onFile={(f) => {
          void choose(f);
          // After a failure the fix goes straight up, with the same org and name.
          if (failed) void send(f);
        }}
      />
      <p aria-live="polite" className="sr-only">
        {working ? (STEP_TEXT[s?.step ?? 'queued'] ?? 'Processing') : ''}
      </p>
      {version ? null : (
        <div className="grid gap-4 @container sm:grid-cols-2">
          <FormField label="Name">
            {(c) => (
              <Input
                {...c}
                maxLength={120}
                value={name}
                disabled={working}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </FormField>
          <FormField label="Organization">
            {(c) => (
              <Select
                {...c}
                disabled={working}
                value={orgId ?? ALL}
                onValueChange={(v) => setOrgId(v === ALL ? undefined : v)}
                options={[
                  { value: ALL, label: 'All organizations' },
                  ...(orgs.data?.items ?? []).map((o) => ({ value: o.id, label: o.name })),
                ]}
              />
            )}
          </FormField>
        </div>
      )}
      {upload.isError ? <Callout tone="danger">{errorMessage(upload.error)}</Callout> : null}
      {failed || working ? null : (
        <div>
          <Button
            iconStart={<ACTION_ICON.upload aria-hidden />}
            busy="bob"
            loading={upload.isPending}
            disabled={!file}
            onClick={() => void send()}
          >
            {version ? 'Upload version' : 'Upload'}
          </Button>
        </div>
      )}
    </div>
  );

  const sentence = (error: string | null) =>
    error && !/^[A-Z][A-Z0-9_]+$/.test(error) ? error : importErrorMessage(error);
  const report = failed ? (
    <>
      <Callout tone="danger" title="Import failed">
        {sentence(s?.error ?? null)}
      </Callout>
      {s?.report?.issues.length ? <ValidationReport report={s.report} rise /> : null}
    </>
  ) : s?.report ? (
    <ValidationReport report={s.report} rise />
  ) : working ? (
    <Skeleton className="h-24 w-full" />
  ) : null;

  const aside = (
    <>
      {finished && s?.templateId && result.data ? (
        <div className="relative">
          <Celebrate when={s.report?.issues.length === 0} />
          <TemplateStill template={result.data} deal className="mx-auto w-full max-w-56" />
        </div>
      ) : null}
      {report ? (
        <section aria-label="Report" className="flex flex-col gap-3">
          {report}
        </section>
      ) : null}
      {finished ? null : (
        <Card>
          <CardHeader title="Package checklist" />
          <CardBody className="flex flex-col gap-4">
            <PackageChecklist files={info?.files} />
            <Button
              asChild
              variant="ghost"
              size="sm"
              iconStart={<Download aria-hidden />}
              className="self-start"
            >
              <a href="/api/v1/templates/baked:starter-generic/package" download>
                Download a starter package
              </a>
            </Button>
          </CardBody>
        </Card>
      )}
    </>
  );

  return (
    <>
      <PageHeader
        title={title}
        breadcrumbs={[
          { label: 'Templates', to: '/admin/templates' },
          { label: version ? 'New version' : 'Upload' },
        ]}
      />
      {status.isError ? (
        <ErrorState
          error={status.error}
          title="Could not read the upload"
          onRetry={() => void status.refetch()}
        />
      ) : (
        // TwoPane's layout with a named aside, so it stays distinct from the nav landmark.
        <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="flex min-w-0 flex-col gap-6">{left}</div>
          <aside aria-label="Package report" className="flex min-w-0 flex-col gap-6">
            {aside}
          </aside>
        </div>
      )}
    </>
  );
}
