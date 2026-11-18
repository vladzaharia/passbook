import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Download, Mail, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { PassImportDto } from '@/shared/contracts/pass-imports.ts';
import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import {
  Buddy,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Celebrate,
  ConfirmDialog,
  toast,
} from '../../../ui/index.ts';
import { handOffToConnection } from '../../connections/import-handoff.ts';
import { downloadImportFile, emailTheRest, removeCreated, useFailedRows } from './api.ts';

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="text-2xl font-semibold tabular-nums text-fg-strong">{value}</dd>
    </div>
  );
}

function FailedRows({ imp, orgId }: { imp: PassImportDto; orgId: string }) {
  const total = imp.progress?.failed ?? 0;
  const failed = useFailedRows(imp.id, orgId, total > 0);
  const items = failed.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-fg-strong">{C.results.failedRows}</h3>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full min-w-[24rem] text-left text-sm">
          <caption className="sr-only">{C.results.failedRows}</caption>
          <thead className="bg-surface-raised text-xs text-fg-muted">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                {C.results.row}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {C.results.problem}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {items.map((r) => (
              <tr key={r.row}>
                <td className="px-3 py-2 tabular-nums text-fg-strong">{r.row}</td>
                <td className="px-3 py-2">{r.message ?? r.code ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {total > items.length ? (
        <p className="text-xs text-fg-muted">{C.check.truncated(items.length, total)}</p>
      ) : null}
    </div>
  );
}

/** What the import did, and what can still be done with it. */
export function ImportResults({
  imp,
  orgId,
  canSync,
  canOperate,
}: {
  imp: PassImportDto;
  orgId: string;
  canSync: boolean;
  /** Results links, mail and removal need `passes:operate`; the error file needs only read. */
  canOperate: boolean;
}) {
  const qc = useQueryClient();
  const [removing, setRemoving] = useState(false);
  const [mailing, setMailing] = useState(false);
  const p = imp.progress;
  if (!p) return null;
  const clean = imp.state === 'done' && p.failed === 0;
  const live = p.created - p.removed;
  const save = (file: 'errors.csv' | 'results.csv') =>
    downloadImportFile(imp.id, orgId, file).catch((e: unknown) =>
      toast.error(e, C.results.couldNotDownload),
    );

  async function mail() {
    setMailing(true);
    try {
      const r = await emailTheRest(qc, imp.id, orgId);
      toast.sent(C.results.emailed(r.sent, r.skipped));
    } catch (e) {
      toast.error(e, C.results.couldNotEmail);
    } finally {
      setMailing(false);
    }
  }

  return (
    <Card>
      <CardHeader title={C.results.title} />
      <CardBody className="relative flex flex-col gap-4">
        <Celebrate when={clean} />
        <div className="flex items-center gap-4">
          <Buddy
            scene={clean ? 'cheer' : 'sorry'}
            mood={clean ? 'happy' : 'sad'}
            size="sm"
            className="shrink-0"
          />
          {clean ? <p className="text-base font-medium text-fg-strong">{C.results.clean}</p> : null}
        </div>
        {imp.state === 'failed' ? <Callout tone="danger">{C.results.stopped}</Callout> : null}
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label={C.results.created} value={p.created} />
          <Stat label={C.results.updated} value={p.updated} />
          <Stat label={C.results.unchanged} value={p.unchanged} />
          <Stat label={C.results.failed} value={p.failed} />
          <Stat label={C.results.notEmailed} value={p.notEmailed} />
          <Stat label={C.results.removed} value={p.removed} />
        </dl>
        <FailedRows imp={imp} orgId={orgId} />
        <div className="flex flex-wrap gap-2">
          {canOperate ? (
            <Button
              variant="outline"
              iconStart={<Download aria-hidden />}
              onClick={() => save('results.csv')}
            >
              {C.results.download}
            </Button>
          ) : null}
          {imp.errorFile ? (
            <Button
              variant="outline"
              iconStart={<Download aria-hidden />}
              onClick={() => save('errors.csv')}
            >
              {C.check.download}
            </Button>
          ) : null}
          {canOperate && p.notEmailed > 0 ? (
            <Button
              variant="outline"
              iconStart={<Mail aria-hidden />}
              loading={mailing}
              onClick={mail}
            >
              {C.results.emailRest}
            </Button>
          ) : null}
          {canOperate && live > 0 ? (
            <Button
              variant="outline"
              iconStart={<Trash2 aria-hidden />}
              onClick={() => setRemoving(true)}
            >
              {C.results.remove}
            </Button>
          ) : null}
          {canSync && imp.source.kind === 'url' && imp.mode === 'live' ? (
            <Button asChild variant="outline" iconStart={<RefreshCw aria-hidden />}>
              <Link
                to="/admin/connections/new"
                search={{ orgId }}
                onClick={() => handOffToConnection(imp)}
              >
                {C.results.sync}
              </Link>
            </Button>
          ) : null}
          <Button asChild variant="ghost">
            <Link to="/admin/passes/import" search={{ orgId }}>
              {C.results.startAgain}
            </Link>
          </Button>
        </div>
        <ConfirmDialog
          open={removing}
          onOpenChange={setRemoving}
          title={C.results.removeTitle}
          description={C.results.removeBody}
          confirmLabel={C.results.removeConfirm}
          destructive
          onConfirm={async () => {
            try {
              const r = await removeCreated(qc, imp.id, orgId);
              toast.success(
                r.skipped > 0
                  ? `${C.removed(r.removed)}. ${C.skipped(r.skipped)}.`
                  : C.removed(r.removed),
              );
              setRemoving(false);
            } catch (e) {
              toast.error(e, C.results.couldNotRemove);
            }
          }}
        />
      </CardBody>
    </Card>
  );
}
