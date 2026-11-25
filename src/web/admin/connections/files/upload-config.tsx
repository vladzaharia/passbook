import { FileSpreadsheet } from 'lucide-react';
import { useState } from 'react';
import { pluralize } from '../../../lib/format.ts';
import { Button, Card, CardBody, FormField, Input, Select } from '../../../ui/index.ts';
import type { ConfigDraft } from '../wizard-steps.tsx';
import { FileChecks } from './file-checks.tsx';
import { FilePreviewTable } from './file-preview-table.tsx';
import { IdColumnField } from './id-column-field.tsx';
import { JsonSlot } from './json-slot.tsx';
import { FailureNote, UploadDrop } from './upload-drop.tsx';
import type { UploadDraft } from './use-upload-draft.ts';

export const sizeOf = (bytes: number): string =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** The wizard's Configuration for a file upload: drop a file, read what it holds, pick the ID column. */
export function UploadConfig({
  upload,
  draft,
  onChange,
  showErrors,
  idError,
}: {
  upload: UploadDraft;
  draft: ConfigDraft;
  onChange: (next: (d: ConfigDraft) => ConfigDraft) => void;
  showErrors: boolean;
  idError?: string | undefined;
}) {
  const { file } = upload;
  const [replacing, setReplacing] = useState(false);
  const idColumn = String(draft.config.idColumn ?? '');
  const missing = showErrors && !file;
  const failure =
    upload.failure ?? (missing ? { kind: 'bad' as const, text: 'Add a file.' } : undefined);
  return (
    <Card>
      <CardBody className="flex min-w-0 flex-col gap-6">
        <FormField
          label="Name"
          required
          error={showErrors && !draft.name.trim() ? 'Required.' : undefined}
        >
          {(c) => (
            <Input
              {...c}
              className="sm:max-w-md"
              maxLength={120}
              placeholder="Member list"
              value={draft.name}
              onChange={(e) => onChange((d) => ({ ...d, name: e.target.value }))}
            />
          )}
        </FormField>
        {file && !replacing && !upload.busy ? (
          <div className="flex min-w-0 flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-sunken px-3 py-2">
            <FileSpreadsheet aria-hidden className="size-5 shrink-0 text-fg-muted" />
            <p className="min-w-0 flex-1 text-sm text-fg">
              <span className="font-medium break-all text-fg-strong">{file.name}</span>
              <span className="text-fg-muted">
                {' · '}
                {pluralize(file.rows, 'row')}
                {' · '}
                {pluralize(file.columns.length, 'column')}
                {' · '}
                {sizeOf(file.bytes)}
              </span>
            </p>
            <Button variant="outline" size="sm" onClick={() => setReplacing(true)}>
              Replace
            </Button>
          </div>
        ) : (
          <>
            <UploadDrop
              busy={upload.busy}
              failure={failure}
              invalid={missing}
              label={file ? 'Drop the new file or choose' : 'Drop a file or choose'}
              onFile={(f) => {
                setReplacing(false);
                upload.take(f);
              }}
            />
            {file && replacing && !upload.busy ? (
              <Button
                variant="ghost"
                size="sm"
                className="self-start"
                onClick={() => setReplacing(false)}
              >
                Keep the current file
              </Button>
            ) : null}
          </>
        )}
        {file && !replacing && !upload.busy && upload.failure ? (
          <FailureNote failure={upload.failure} />
        ) : null}
        {file && !replacing ? (
          <>
            {file.sheets.length > 1 ? (
              <FormField label="Sheet" className="sm:max-w-sm">
                {(c) => (
                  <Select
                    {...c}
                    value={file.sheet ?? undefined}
                    disabled={upload.busy}
                    onValueChange={(sheet) => upload.reparse({ sheet })}
                    options={file.sheets.map((s) => ({ value: s, label: s }))}
                  />
                )}
              </FormField>
            ) : null}
            {upload.json !== undefined ? (
              <JsonSlot
                doc={upload.json}
                records={file.recordsPointer ?? ''}
                idColumn={idColumn}
                onRecords={(recordsPointer) => upload.reparse({ recordsPointer })}
                onId={(pointer) =>
                  onChange((d) => ({ ...d, config: { ...d.config, idColumn: pointer } }))
                }
              />
            ) : null}
            <IdColumnField
              file={file}
              value={idColumn}
              error={showErrors ? idError : undefined}
              disabled={upload.busy}
              onChange={(pointer) =>
                onChange((d) => ({ ...d, config: { ...d.config, idColumn: pointer } }))
              }
            />
            <FileChecks file={file} idColumn={idColumn} />
            <FilePreviewTable file={file} idColumn={idColumn} />
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}
