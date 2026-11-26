import { useState } from 'react';
import { TAG_IMPORT_MAX_CHARS } from '@/shared/contracts/nfc-tag-keysets.ts';
import { KEYSET_COPY } from '@/shared/copy/tag-keysets.ts';
import { rekeyTagsConfirm } from '@/web/lib/confirms.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import { pluralize } from '@/web/lib/format.ts';
import { isStepUp } from '@/web/lib/step-up.ts';
import {
  Callout,
  CheckboxField,
  FileDrop,
  toast,
  useWizard,
  WizardDialog,
} from '@/web/ui/index.ts';
import type { ImportResult, Keyset } from './api.ts';
import { Findings } from './import-findings.tsx';
import { fill } from './words.ts';

const C = KEYSET_COPY.import;

type Run = (body: { csv: string; dryRun: boolean; replace?: boolean }) => Promise<ImportResult>;

/**
 * Import supplier-personalised tags in two steps: File (the CSV and whether to replace keys), then
 * Check (what a dry run finds; the finish imports the ready rows). The file is read here and sent;
 * keys are never shown back.
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
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [replace, setReplace] = useState(false);

  async function dryRun(text: string, on: boolean) {
    setChecking(true);
    setError('');
    setResult(undefined);
    try {
      setResult(await run({ csv: text, dryRun: true, ...(on ? { replace: true } : {}) }));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setChecking(false);
    }
  }
  async function pick(file: File) {
    setError('');
    setResult(undefined);
    try {
      const text = await file.text();
      setCsv(text);
      setName(file.name);
      await dryRun(text, replace);
    } catch (cause) {
      setCsv('');
      setName('');
      setError(errorMessage(cause));
    }
  }
  async function toggle(on: boolean) {
    setReplace(on);
    if (csv) await dryRun(csv, on);
  }

  const ok = result?.ok ?? 0;
  const w = useWizard({
    open: true,
    steps: [
      { id: 'file', title: 'File', heading: 'Add the file', summary: name || undefined },
      { id: 'check', title: 'Check', heading: 'Check the rows' },
    ],
    errors: {
      file: checking || !result ? { file: 'Add a file.' } : undefined,
      check: ok === 0 ? { rows: 'No rows are ready.' } : undefined,
    },
    hints: { file: checking ? 'Checking the file.' : 'Add a file.', check: 'No rows are ready.' },
    fieldStep: {},
    onFinish: async () => {
      try {
        const done = await run({ csv, dryRun: false, ...(replace ? { replace: true } : {}) });
        toast.success(fill(replace ? C.replaced : C.added, { tags: pluralize(done.added, 'tag') }));
        onClose();
      } catch (cause) {
        // The step-up prompt says it; a second "no access" line would contradict it.
        if (!isStepUp(cause)) throw cause;
      }
    },
  });

  return (
    <WizardDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`${C.title} to ${keyset.name}`}
      wizard={w}
      dirty={csv !== ''}
      finishLabel={fill(replace ? C.replaceGo : C.go, { tags: pluralize(ok, 'tag') })}
      {...(replace ? { finishTone: 'danger' as const } : {})}
      busy={checking}
    >
      {w.id === 'file' ? (
        <>
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <FileDrop
            accept=".csv,.txt,text/csv,text/plain"
            maxBytes={TAG_IMPORT_MAX_CHARS}
            label={name || C.drop}
            disabled={checking}
            onFiles={([file]) => file && void pick(file)}
          />
          <p className="text-xs text-fg-muted">{C.help}</p>
          <CheckboxField
            label={C.replace}
            checked={replace}
            disabled={checking}
            onCheckedChange={(on) => void toggle(on === true)}
          />
        </>
      ) : null}
      {w.id === 'check' && result ? (
        <>
          {replace ? <Callout tone="warning">{rekeyTagsConfirm(ok).description}</Callout> : null}
          <Findings result={result} replace={replace} />
        </>
      ) : null}
    </WizardDialog>
  );
}
