import { Link } from '@tanstack/react-router';
import { Upload } from 'lucide-react';
import { useState } from 'react';
import { errorMessage } from '../../lib/errors.ts';
import { useOrgFilter } from '../../lib/org-filter.tsx';
import { useOrgOptions } from '../../lib/search.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ErrorState,
  FileDrop,
  FormField,
  Input,
  PageHeader,
  Select,
  Spinner,
} from '../../ui/index.ts';
import { useImportStatus, useUploadTemplate } from './api.ts';
import { ValidationReport } from './validation-report.tsx';

const NONE = 'none';
const MAX_BYTES = 15 * 1024 * 1024;
const crumbs = [{ label: 'Templates', to: '/admin/templates' }, { label: 'Upload' }];

function importMessage(error: string | null | undefined): string {
  if (!error) return 'The import did not finish.';
  if (error === 'IMPORT_INVALID') return 'The package has errors. Fix them and upload again.';
  return /^[A-Z][A-Z0-9_]+$/.test(error) ? 'The import failed. Try again.' : error;
}

function Progress({ uploadId, onReset }: { uploadId: string; onReset: () => void }) {
  const status = useImportStatus(uploadId);
  if (status.isError) {
    return (
      <ErrorState
        error={status.error}
        title="Could not read upload status"
        onRetry={() => void status.refetch()}
      />
    );
  }
  const s = status.data;
  if (!s || s.status === 'queued' || s.status === 'running') {
    return (
      <Card className="max-w-3xl">
        <CardBody className="flex items-center gap-3">
          <Spinner label="Processing upload" />
          <p className="text-sm text-fg-strong" aria-live="polite">
            {s?.step ? `Processing: ${s.step}` : 'Queued'}
          </p>
        </CardBody>
      </Card>
    );
  }
  if (s.status === 'errored' || s.status === 'terminated') {
    return (
      <Card className="max-w-3xl">
        <CardHeader title="Import failed" />
        <CardBody className="grid gap-3">
          <p role="alert" className="text-sm text-danger">
            {importMessage(s.error)}
          </p>
          {s.report ? <ValidationReport report={s.report} /> : null}
          <div>
            <Button variant="outline" onClick={onReset}>
              Try again
            </Button>
          </div>
        </CardBody>
      </Card>
    );
  }
  return (
    <Card className="max-w-3xl">
      <CardHeader title="Import complete" />
      <CardBody className="grid gap-3">
        {s.report ? <ValidationReport report={s.report} /> : null}
        <div className="flex gap-2">
          {s.templateId ? (
            <Button asChild>
              <Link to={`/admin/templates/${s.templateId}` as never}>Open template</Link>
            </Button>
          ) : null}
          <Button variant="outline" onClick={onReset}>
            Upload another
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

export function TemplateUploadPage() {
  const { orgId: globalOrg } = useOrgFilter();
  const orgs = useOrgOptions();
  const upload = useUploadTemplate();
  const [orgId, setOrgId] = useState<string | undefined>(globalOrg);
  const [name, setName] = useState('');
  const [file, setFile] = useState<File>();
  const [uploadId, setUploadId] = useState<string>();

  function reset() {
    setUploadId(undefined);
    setFile(undefined);
    upload.reset();
  }

  return (
    <>
      <PageHeader title="Upload template" breadcrumbs={crumbs} />
      {uploadId ? (
        <Progress uploadId={uploadId} onReset={reset} />
      ) : (
        <Card className="max-w-3xl">
          <CardBody className="grid gap-4">
            <FormField label="Organization">
              {(c) => (
                <Select
                  {...c}
                  value={orgId ?? NONE}
                  onValueChange={(v) => setOrgId(v === NONE ? undefined : v)}
                  options={[
                    { value: NONE, label: 'None' },
                    ...(orgs.data?.items ?? []).map((o) => ({ value: o.id, label: o.name })),
                  ]}
                />
              )}
            </FormField>
            <FormField label="Name" help="Defaults to the package name.">
              {(c) => (
                <Input
                  {...c}
                  maxLength={120}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              )}
            </FormField>
            <div>
              <FileDrop
                accept=".zip,.pkpasstemplate"
                maxBytes={MAX_BYTES}
                label={file ? `${file.name} (change)` : 'Choose a .zip or .pkpasstemplate'}
                disabled={upload.isPending}
                onFiles={([f]) => setFile(f)}
              />
            </div>
            {upload.isError ? (
              <p role="alert" className="text-sm text-danger">
                {errorMessage(upload.error)}
              </p>
            ) : null}
            <div>
              <Button
                iconStart={<Upload aria-hidden />}
                loading={upload.isPending}
                disabled={!file}
                onClick={async () => {
                  if (!file) return;
                  const res = await upload
                    .mutateAsync({ file, orgId, name: name.trim() || undefined })
                    .catch(() => undefined);
                  if (res) setUploadId(res.uploadId);
                }}
              >
                Upload
              </Button>
            </div>
          </CardBody>
        </Card>
      )}
    </>
  );
}
