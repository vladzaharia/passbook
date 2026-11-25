import { CircleCheck } from 'lucide-react';
import { useState } from 'react';
import { formatDateTime, pluralize } from '../../../lib/format.ts';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  Celebrate,
  KeyValue,
  StepList,
} from '../../../ui/index.ts';
import { ExplorerBuddy } from '../rest/explorer-buddy.tsx';
import { diffLine, type Revision, statusOf } from './status.ts';
import { sizeOf } from './upload-config.tsx';
import { UploadDrop } from './upload-drop.tsx';
import type { RevisionUpload } from './use-revision-upload.ts';

/** Syncing: the file is uploaded, the passes follow. The list polls until the run is done. */
function Applying({ revision }: { revision: Revision }) {
  return (
    <StepList
      label="Applying the file"
      items={[
        { id: 'up', state: 'done', label: 'Uploaded', detail: revision.name },
        { id: 'sync', state: 'working', label: 'Updating passes', detail: undefined },
      ]}
    />
  );
}

/** The run finished. Seen finishing, the buddy cheers once; opened later, it is a plain line. */
function Applied({ revision, fresh }: { revision: Revision; fresh: boolean }) {
  const line = diffLine(revision) ?? `${pluralize(revision.rows, 'row')} applied`;
  if (!fresh)
    return (
      <p className="flex items-center gap-2 text-sm text-fg">
        <CircleCheck aria-hidden className="size-4 shrink-0 text-success" />
        Applied. {line}
      </p>
    );
  return (
    <div className="relative">
      <Celebrate when />
      <ExplorerBuddy mood="happy">
        <p role="status" className="text-sm font-medium text-fg-strong">
          Applied
        </p>
        <p className="text-sm text-fg-muted">{line}</p>
      </ExplorerBuddy>
    </div>
  );
}

/** The revision in use: its state, a few facts, and the way to upload a new version. */
export function CurrentRevision({
  revision,
  upload,
  canManage,
}: {
  revision: Revision;
  upload: RevisionUpload;
  canManage: boolean;
}) {
  // Opened mid-run: the finish is worth a cheer. Opened after: it is not news.
  const [sawApplying] = useState(!revision.applied);
  const status = statusOf(revision);
  return (
    <Card>
      <CardHeader title="File" actions={<Badge tone={status.tone}>{status.label}</Badge>} />
      <CardBody className="flex min-w-0 flex-col gap-5">
        {revision.applied ? (
          <Applied revision={revision} fresh={sawApplying} />
        ) : (
          <Applying revision={revision} />
        )}
        <KeyValue
          items={[
            { label: 'Name', value: revision.name },
            { label: 'Revision', value: `${revision.revision}` },
            {
              label: 'Rows',
              value: `${pluralize(revision.rows, 'row')} · ${sizeOf(revision.bytes)}`,
            },
            {
              label: 'Uploaded',
              value: `${formatDateTime(revision.createdAt)}${revision.createdByName ? ` by ${revision.createdByName}` : ''}`,
            },
          ]}
        />
        {canManage ? (
          <div className="flex min-w-0 flex-col gap-2 border-t border-border pt-4">
            <h3 className="text-sm font-medium text-fg-strong">Upload new version</h3>
            <UploadDrop
              busy={upload.busy}
              failure={upload.failure}
              label="Drop a file or choose"
              onFile={upload.take}
            />
            {upload.same ? (
              <p role="status" className="text-sm text-fg-muted">
                No changes. The file matches the current version.
              </p>
            ) : null}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
