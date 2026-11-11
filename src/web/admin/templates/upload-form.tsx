import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import type { z } from 'zod';
import type { OrgMembership } from '@/shared/contracts/org-membership.ts';
import type { TemplateDetailSchema } from '@/shared/contracts/templates.ts';
import { ACTION_ICON } from '../../lib/action-icons.ts';
import { errorMessage, isApiError } from '../../lib/errors.ts';
import { markMinted } from '../../lib/motion.ts';
import {
  Buddy,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  DetailNotFound,
  ErrorState,
  FormField,
  Input,
  PageHeader,
  Select,
  Skeleton,
} from '../../ui/index.ts';
import { markCreated } from '../passes/created.tsx';
import { useImportStatus, useTemplate, useUploadTemplate } from './api.ts';
import { type PackageInfo, readPackage, UploadDrop } from './upload-drop.tsx';
import { UploadReport } from './upload-report.tsx';

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

type Template = z.infer<typeof TemplateDetailSchema>;

export function UploadForm({
  version,
  initialUpload,
  selectedScope,
  memberships,
  onScopeChange,
}: {
  version: Template | undefined;
  initialUpload: string | undefined;
  selectedScope: string;
  memberships: OrgMembership[];
  onScopeChange: (orgId: string | undefined) => void;
}) {
  const navigate = useNavigate();
  const [selectedOrg, setSelectedOrg] = useState(selectedScope);
  // A form choice is not authoritative until the shell's validated scope catches up.
  const orgId = selectedOrg === selectedScope ? selectedOrg : undefined;
  const upload = useUploadTemplate();
  const [name, setName] = useState(version?.name ?? '');
  const [file, setFile] = useState<File>();
  const [info, setInfo] = useState<PackageInfo>();
  const [uploadId, setUploadId] = useState(initialUpload);
  const [uploadOrgId, setUploadOrgId] = useState<string | undefined>(
    version ? (version.orgId ?? undefined) : selectedScope,
  );
  // Started here, not reopened from Recent uploads: success opens the template.
  const [sent, setSent] = useState(false);
  const status = useImportStatus(uploadId, uploadOrgId);
  const s = status.data;
  const finished = s?.status === 'complete';
  const failed = s?.status === 'errored' || s?.status === 'terminated';
  const result = useTemplate(finished ? (s?.templateId ?? undefined) : undefined, selectedScope);

  // Upload version: the name comes from the template being versioned.
  useEffect(() => {
    if (version) setName(version.name);
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
    if (!f || !orgId || (version && version.orgId !== null && version.orgId !== orgId)) return;
    const targetOrgId = version ? (version.orgId ?? undefined) : orgId;
    const res = await upload
      .mutateAsync({ file: f, orgId: targetOrgId, name: name.trim() || undefined })
      .catch(() => undefined);
    if (res) {
      setUploadOrgId(targetOrgId);
      setUploadId(res.uploadId);
      setSent(true);
    } else setRejected((n) => n + 1);
  }

  // The template page replaces this one in history and leads with "Template imported". A report
  // reopened from Recent uploads stays here.
  const verifyingResult = Boolean(finished && s?.templateId && result.isPending);
  const resultFailed = Boolean(finished && s?.templateId && result.isError);
  const resultMatches =
    !result.data || result.data.orgId === null || result.data.orgId === selectedScope;
  const landedId =
    sent && finished && !verifyingResult && !resultFailed && resultMatches
      ? s?.templateId
      : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: navigate once per finished upload
  useEffect(() => {
    if (!landedId) return;
    markMinted(`template:${landedId}`);
    markCreated(`template:${landedId}`, version ? 'version' : 'imported');
    if (s?.version) markCreated(`template:${landedId}:version`, s.version);
    void navigate({
      to: '/admin/templates/$templateId',
      params: { templateId: landedId },
      search: { orgId: selectedScope },
      replace: true,
    });
  }, [landedId]);

  const working = Boolean(uploadId) && !finished && !failed && !status.isError;
  const landed = uploadId ? (finished ? 4 : (STEPS[s?.step ?? 'queued'] ?? 0)) : undefined;
  const title = version ? `New version of ${version.name}` : 'Upload template';

  if (verifyingResult) {
    return (
      <>
        <PageHeader title="Template" />
        <Skeleton className="h-24 w-full" />
      </>
    );
  }

  if (resultFailed) {
    return (
      <>
        <PageHeader title="Template" />
        {isApiError(result.error) && (result.error.isForbidden || result.error.isNotFound) ? (
          <DetailNotFound entity="template" to="/admin/templates" />
        ) : (
          <ErrorState
            error={result.error}
            title="Could not load the template"
            onRetry={() => void result.refetch()}
          />
        )}
      </>
    );
  }

  if (!resultMatches) {
    return (
      <>
        <PageHeader title="Template" />
        <DetailNotFound entity="template" to="/admin/templates" />
      </>
    );
  }

  const left =
    finished && !sent ? (
      <Card className="mt-18">
        <Buddy mood="happy" scene="cheer" />
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
                <Link
                  to="/admin/templates/$templateId"
                  params={{ templateId: s.templateId }}
                  search={{ orgId: selectedScope }}
                >
                  Open template
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
          disabled={!orgId || working || upload.isPending}
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
                  value={selectedOrg}
                  onValueChange={(v) => {
                    setSelectedOrg(v);
                    onScopeChange(v);
                  }}
                  options={memberships
                    .filter(
                      (m) => m.revokedAt === null && m.capabilities.includes('templates:author'),
                    )
                    .map((m) => ({ value: m.orgId, label: m.orgName }))}
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
              disabled={!file || !orgId}
              onClick={() => void send()}
            >
              {version ? 'Upload version' : 'Upload'}
            </Button>
          </div>
        )}
      </div>
    );

  return (
    <>
      <PageHeader
        title={title}
        breadcrumbs={[
          { label: 'Templates', to: '/admin/templates', search: { orgId: selectedScope } },
          { label: version ? 'New version' : 'Upload' },
        ]}
        actions={
          <Button asChild variant="outline">
            <Link to="/admin/templates" search={{ orgId: selectedScope }}>
              All templates
            </Link>
          </Button>
        }
      />
      <Callout
        tone="info"
        title={version ? `Uploading a version of ${version.name}` : 'Before you upload'}
      >
        {version
          ? `Organization: ${version.orgId ? (version.orgName ?? version.orgId) : 'All organizations (shared)'}. Imports match by name and organization, not template ID.`
          : 'Imports match by name and organization and can create or update a template.'}{' '}
        Imported versions are inactive; activation requires an approved release and can affect
        existing passes. Template changes are not isolated by the Test view.
      </Callout>
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
            <UploadReport
              status={s}
              template={result.data}
              files={info?.files}
              selectedScope={selectedScope}
              finished={finished}
              failed={failed}
              working={working}
            />
          </aside>
        </div>
      )}
    </>
  );
}
