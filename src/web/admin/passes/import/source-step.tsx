import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { PASS_IMPORT_MAX_BYTES } from '@/shared/contracts/pass-imports.ts';
import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import { errorMessage } from '../../../lib/errors.ts';
import { useMode } from '../../../lib/mode.ts';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  FileDrop,
  FormField,
  Input,
  SegmentedControl,
  Select,
  Skeleton,
  Textarea,
} from '../../../ui/index.ts';
import { useCreateImport, useImportTemplates } from './api.ts';

type Kind = 'file' | 'paste' | 'link';
const KINDS = [
  { value: 'file', label: C.fileTab },
  { value: 'paste', label: C.pasteTab },
  { value: 'link', label: C.linkTab },
] as const;
const TEXT_FILE = /\.(csv|tsv|txt)$/i;

/** Why a chosen file cannot be imported, or null. */
export function fileProblem(file: { name: string; size: number }): string | null {
  if (/\.xlsx?$/i.test(file.name)) return C.xlsx;
  if (!TEXT_FILE.test(file.name)) return C.notCsv;
  return file.size > PASS_IMPORT_MAX_BYTES ? C.tooBig : null;
}

/** Template and spreadsheet: a file, pasted rows or a published sheet link. */
export function SourceStep({ orgId }: { orgId: string }) {
  const navigate = useNavigate();
  const mode = useMode();
  const templates = useImportTemplates(orgId);
  const create = useCreateImport(orgId);
  const [templateId, setTemplateId] = useState<string>();
  const [kind, setKind] = useState<Kind>('file');
  const [file, setFile] = useState<{ name: string; csv: string }>();
  const [pasted, setPasted] = useState('');
  const [url, setUrl] = useState('');
  const [problem, setProblem] = useState<string>();

  const items = templates.data?.items ?? [];
  const chosen = templateId ?? (items.length === 1 ? items[0]?.templateId : undefined);
  const pastedTooBig = new Blob([pasted]).size > PASS_IMPORT_MAX_BYTES;
  const source =
    kind === 'file' && file
      ? ({ kind: 'file', name: file.name, csv: file.csv } as const)
      : kind === 'paste' && pasted.trim() && !pastedTooBig
        ? ({ kind: 'file', name: 'pasted.csv', csv: pasted } as const)
        : kind === 'link' && url.trim()
          ? ({ kind: 'url', url: url.trim() } as const)
          : undefined;

  async function take([picked]: File[]) {
    if (!picked) return;
    const bad = fileProblem(picked);
    setFile(undefined);
    setProblem(bad ?? undefined);
    if (bad) return;
    try {
      // fatal: another encoding would reach the check as replacement characters.
      setFile({
        name: picked.name,
        csv: new TextDecoder('utf-8', { fatal: true }).decode(await picked.arrayBuffer()),
      });
    } catch {
      setProblem(C.notUtf8);
    }
  }

  function start() {
    if (!chosen || !source) return;
    create.mutate(
      { templateId: chosen, source },
      {
        onSuccess: (imp) =>
          void navigate({
            to: '/admin/passes/import/$importId',
            params: { importId: imp.id },
            search: { orgId },
          }),
      },
    );
  }

  return (
    <Card>
      <CardHeader title={C.sourceTitle} />
      <CardBody className="flex flex-col gap-4">
        {mode === 'test' ? <Callout tone="info">{C.testNote}</Callout> : null}
        {templates.isPending ? (
          <Skeleton className="h-9 sm:max-w-sm" />
        ) : (
          <FormField
            label={C.template}
            error={templates.isError ? errorMessage(templates.error) : undefined}
            help={items.length === 0 && !templates.isError ? C.noTemplates : undefined}
          >
            {(c) => (
              <Select
                {...c}
                className="sm:max-w-sm"
                value={chosen}
                onValueChange={setTemplateId}
                disabled={items.length === 0}
                options={items.map((t) => ({ value: t.templateId, label: t.name }))}
              />
            )}
          </FormField>
        )}
        <SegmentedControl
          label="Source"
          options={KINDS}
          value={kind}
          onValueChange={(next) => {
            setKind(next);
            setProblem(undefined);
          }}
        />
        {kind === 'file' ? (
          <div className="flex flex-col gap-2">
            <FileDrop label={C.dropLabel} art="mapping" invalid={Boolean(problem)} onFiles={take} />
            {file ? <p className="text-sm text-fg-muted">{file.name}</p> : null}
          </div>
        ) : kind === 'paste' ? (
          <FormField label={C.pasteLabel}>
            {(c) => (
              <Textarea
                {...c}
                rows={8}
                className="font-mono text-xs"
                value={pasted}
                placeholder={C.pastePlaceholder}
                onChange={(e) => setPasted(e.target.value)}
              />
            )}
          </FormField>
        ) : (
          <FormField label={C.linkLabel} help={C.linkHelp}>
            {(c) => (
              <Input
                {...c}
                type="url"
                inputMode="url"
                className="sm:max-w-lg"
                value={url}
                placeholder="https://docs.google.com/spreadsheets/…"
                onChange={(e) => setUrl(e.target.value)}
              />
            )}
          </FormField>
        )}
        {problem || (kind === 'paste' && pastedTooBig) ? (
          <Callout tone="danger">{problem ?? C.tooBig}</Callout>
        ) : null}
        {create.isError ? <Callout tone="danger">{errorMessage(create.error)}</Callout> : null}
        <div>
          <Button disabled={!chosen || !source} loading={create.isPending} onClick={start}>
            {create.isPending ? C.starting : C.start}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
