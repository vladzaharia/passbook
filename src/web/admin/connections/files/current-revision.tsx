import { CircleCheck } from 'lucide-react';
import { useState } from 'react';
import { ACTION_ICON } from '../../../lib/action-icons.ts';
import { formatDateTime, pluralize } from '../../../lib/format.ts';
import {
  Badge,
  Button,
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

/** The file is uploaded; the passes follow once a run applies it. */
function Applying({
  revision,
  working,
  failed,
  onSync,
}: {
  revision: Revision;
  working: boolean;
  failed: boolean;
  onSync: (() => void) | undefined;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <StepList
        label={working ? 'Applying the file' : 'File not applied'}
        items={[
          { id: 'up', state: 'done', label: 'Uploaded', detail: revision.name },
          working
            ? { id: 'sync', state: 'working', label: 'Updating passes', detail: undefined }
            : {
                id: 'sync',
                state: failed ? 'invalid' : 'current',
                label: failed ? 'The last sync failed' : 'Not applied yet',
                detail: failed ? 'Check Health, then sync again.' : undefined,
              },
        ]}
      />
      {!working && onSync ? (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          iconStart={<ACTION_ICON.refresh aria-hidden />}
          onClick={onSync}
        >
          Sync now
        </Button>
      ) : null}
    </div>
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
  applying,
  failed,
  onSync,
}: {
  revision: Revision;
  upload: RevisionUpload;
  canManage: boolean;
  applying: boolean;
  /** The newest run ended in an error. */
  failed: boolean;
  /** Runs the sync; absent when the connection is off or the viewer cannot manage it. */
  onSync: (() => void) | undefined;
}) {
  // Opened mid-run: the finish is worth a cheer. Opened after: it is not news.
  const [sawApplying] = useState(!revision.applied);
  const status = applying ? { label: 'Applying', tone: 'info' as const } : statusOf(revision);
  return (
    <Card>
      <CardHeader title="File" actions={<Badge tone={status.tone}>{status.label}</Badge>} />
      <CardBody className="flex min-w-0 flex-col gap-5">
        {revision.applied ? (
          <Applied revision={revision} fresh={sawApplying} />
        ) : (
          <Applying revision={revision} working={applying} failed={failed} onSync={onSync} />
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
