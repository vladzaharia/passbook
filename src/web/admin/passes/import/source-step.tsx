import { Link, useNavigate } from '@tanstack/react-router';
import { Code2, FileText, Plug, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { PASS_IMPORT_MAX_BYTES } from '@/shared/contracts/pass-imports.ts';
import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import { parseCsv } from '@/shared/csv/parse.ts';
import { errorMessage } from '../../../lib/errors.ts';
import { useMode } from '../../../lib/mode.ts';
import { orgPath } from '../../../lib/scope.ts';
import {
  Button,
  Callout,
  FileDrop,
  FormField,
  IconButton,
  Input,
  OptionTile,
  SegmentedControl,
  Select,
  Skeleton,
  Textarea,
} from '../../../ui/index.ts';
import { rememberImportLink } from '../../connections/import-handoff.ts';
import { useCreateImport, useImportTemplates } from './api.ts';
import { markFresh } from './fresh.ts';
import { ImportWizard } from './import-wizard.tsx';
import { SampleCsv } from './sample-csv.tsx';
import { STEP } from './steps.ts';

type Way = 'file' | 'connection' | 'api';
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

/** "450 rows · 9 columns", or nothing when the text does not parse (the server says why). */
function shape(csv: string): string | null {
  try {
    const p = parseCsv(csv);
    return C.source.shape(p.rows.length, p.header.length);
  } catch {
    return null;
  }
}

/** Step one: the template and where the rows come from. */
export function SourceStep({ orgId, children }: { orgId: string; children?: ReactNode }) {
  const navigate = useNavigate();
  const mode = useMode();
  const templates = useImportTemplates(orgId);
  const create = useCreateImport(orgId);
  const [templateId, setTemplateId] = useState<string>();
  const [way, setWay] = useState<Way>('file');
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
  const ready = way === 'file' && Boolean(chosen && source);

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
    if (!chosen || !source) return false;
    create.mutate(
      { templateId: chosen, source, mapping: 'auto' },
      {
        onSuccess: (imp) => {
          if (source.kind === 'url') rememberImportLink(imp.id, source.url);
          markFresh(imp.id);
          void navigate({
            to: '/admin/o/$orgId/passes/import/$importId',
            params: { orgId, importId: imp.id },
          });
        },
      },
    );
    return undefined;
  }

  return (
    <ImportWizard
      current={STEP.source}
      onStep={() => undefined}
      onCancel={() => void navigate({ href: orgPath(orgId, '/passes') })}
      onNext={start}
      nextLabel={create.isPending ? C.starting : C.start}
      nextDisabled={!ready}
      nextHint={C.needInput}
      busy={create.isPending}
    >
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
              placeholder={C.chooseTemplate}
              options={items.map((t) => ({ value: t.templateId, label: t.name }))}
            />
          )}
        </FormField>
      )}
      <div
        role="radiogroup"
        aria-label={C.source.way}
        className="wl-deal grid gap-3 md:grid-cols-3"
      >
        {(
          [
            ['file', FileText, C.source.file, C.source.fileHint],
            ['connection', Plug, C.source.connection, C.source.connectionHint],
            ['api', Code2, C.source.api, C.source.apiHint],
          ] as const
        ).map(([value, icon, label, description]) => (
          <OptionTile
            key={value}
            name="source-way"
            value={value}
            label={label}
            description={description}
            icon={icon}
            checked={way === value}
            onSelect={(v) => setWay(v as Way)}
          />
        ))}
      </div>
      {way === 'connection' ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-raised p-4">
          <p className="text-sm text-fg-muted">{C.source.connectionBody}</p>
          <Button asChild variant="outline">
            <Link to={orgPath(orgId, '/connections/new')}>{C.source.connectionGo}</Link>
          </Button>
        </div>
      ) : null}
      {way === 'api' ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-raised p-4">
          <code className="font-mono text-sm text-fg-strong">POST /api/v1/pass-imports</code>
          <Button asChild variant="outline">
            <a href="/developers">{C.source.apiGo}</a>
          </Button>
        </div>
      ) : null}
      {way === 'file' ? (
        <div className="flex flex-col gap-4 rounded-lg border border-border bg-surface-raised p-4">
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
            file ? (
              <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface-sunken px-4 py-3">
                <p className="flex min-w-0 flex-wrap items-baseline gap-x-3 text-sm">
                  <span className="truncate font-semibold text-fg-strong">{file.name}</span>
                  <span className="text-xs text-fg-muted">{shape(file.csv)}</span>
                </p>
                <IconButton
                  label={C.source.remove}
                  icon={<X aria-hidden />}
                  onClick={() => setFile(undefined)}
                />
              </div>
            ) : (
              <FileDrop
                label={
                  <>
                    {C.dropLead} <span className="text-accent-fg underline">{C.dropChoose}</span>
                  </>
                }
                art="mapping"
                invalid={Boolean(problem)}
                onFiles={take}
              />
            )
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
          {chosen ? (
            <div>
              <SampleCsv templateId={chosen} orgId={orgId} />
            </div>
          ) : null}
        </div>
      ) : null}
      {create.isError ? <Callout tone="danger">{errorMessage(create.error)}</Callout> : null}
      {children}
    </ImportWizard>
  );
}
