import { useState } from 'react';
import { TAG_IMPORT_MAX_CHARS } from '@/shared/contracts/nfc-tag-keysets.ts';
import { KEYSET_COPY } from '@/shared/copy/tag-keysets.ts';
import { rekeyTagsConfirm } from '@/web/lib/confirms.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import {
  Button,
  Callout,
  CheckboxField,
  ConfirmDialog,
  Dialog,
  DialogContent,
  FileDrop,
  toast,
} from '@/web/ui/index.ts';
import type { ImportResult, Keyset } from './api.ts';
import { fill } from './words.ts';

const C = KEYSET_COPY.import;

type Run = (body: { csv: string; dryRun: boolean; replace?: boolean }) => Promise<ImportResult>;

/**
 * Import supplier-personalised tags: pick the CSV, see what a dry run finds (rows ready, then each bad or
 * repeated row), then import the ready ones. The file is read here and sent; keys are never shown back.
 */
export function ImportDialog({
  keyset,
  run,
  onClose,
}: {
  keyset: Keyset;
  run: Run;
  onClose: () => void;
}) {
  const [csv, setCsv] = useState('');
  const [name, setName] = useState('');
  const [result, setResult] = useState<ImportResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [replace, setReplace] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function dryRun(text: string, on: boolean) {
    setBusy(true);
    setError('');
    setResult(undefined);
    try {
      setResult(await run({ csv: text, dryRun: true, ...(on ? { replace: true } : {}) }));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function toggle(on: boolean) {
    setReplace(on);
    if (csv) await dryRun(csv, on);
  }
  async function check(file: File) {
    setBusy(true);
    setError('');
    setResult(undefined);
    try {
      const text = await file.text();
      setCsv(text);
      setName(file.name);
      setBusy(false);
      await dryRun(text, replace);
      return;
    } catch (cause) {
      setCsv('');
      setError(errorMessage(cause));
    }
    setBusy(false);
  }
  async function add() {
    setBusy(true);
    setError('');
    try {
      const done = await run({ csv, dryRun: false, ...(replace ? { replace: true } : {}) });
      toast.success(fill(replace ? C.replaced : C.added, { n: done.added }));
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        title={`${C.title} to ${keyset.name}`}
        description={C.help}
        size="lg"
        closeButton={!busy}
        footer={
          <>
            <Button variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              loading={busy}
              disabled={!result || result.ok === 0}
              onClick={() => (replace ? setConfirming(true) : void add())}
            >
              {fill(replace ? C.replaceGo : C.go, { n: result?.ok ?? 0 })}
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <FileDrop
            accept=".csv,.txt,text/csv,text/plain"
            maxBytes={TAG_IMPORT_MAX_CHARS}
            label={name || C.drop}
            disabled={busy}
            onFiles={([file]) => file && void check(file)}
          />
          <CheckboxField
            label={C.replace}
            checked={replace}
            disabled={busy}
            onCheckedChange={(on) => void toggle(on === true)}
          />
          {result ? <Findings result={result} replace={replace} /> : null}
        </div>
      </DialogContent>
      {confirming ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirming(false)}
          {...rekeyTagsConfirm(result?.ok ?? 0)}
          destructive
          onConfirm={async () => {
            await add();
          }}
        />
      ) : null}
    </Dialog>
  );
}

function Findings({ result, replace }: { result: ImportResult; replace: boolean }) {
  const bad = result.problems.length + result.moreProblems;
  return (
    <div className="grid gap-3" aria-live="polite">
      <p className="text-sm font-medium text-fg-strong">
        {fill(replace ? C.replaceReady : C.ready, { ok: result.ok, rows: result.rows })}
      </p>
      {bad > 0 ? (
        <div className="max-h-64 overflow-auto rounded-md border border-border">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Rows that will be skipped</caption>
            <thead className="bg-surface-sunken text-fg-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-normal">
                  Line
                </th>
                <th scope="col" className="px-3 py-2 font-normal">
                  Tag ID
                </th>
                <th scope="col" className="px-3 py-2 font-normal">
                  Skipped because
                </th>
              </tr>
            </thead>
            <tbody>
              {result.problems.map((p) => (
                <tr key={`${p.line}-${p.reason}`} className="border-t border-border">
                  <td className="px-3 py-2 tabular-nums">{p.line}</td>
                  <td className="px-3 py-2 font-mono text-xs">{p.uid ?? '—'}</td>
                  <td className="px-3 py-2">{KEYSET_COPY.problem[p.reason]}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.moreProblems > 0 ? (
            <p className="border-t border-border px-3 py-2 text-sm text-fg-muted">
              and {result.moreProblems} more
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
