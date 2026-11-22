import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Download, List, Mail, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import type { PassImportDto } from '@/shared/contracts/pass-imports.ts';
import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import { Button, ConfirmDialog, Stepper, toast } from '../../../ui/index.ts';
import { handOffToConnection } from '../../connections/import-handoff.ts';
import { ChangeTheseLink } from '../change/entry-links.tsx';
import { downloadImportFile, emailTheRest } from './api.ts';
import type { UndoResult } from './api-run.ts';
import { FailedRows } from './failed-rows.tsx';
import { DoneCard, RunningCard } from './run-card.tsx';
import { IMPORT_STEPS, STEP } from './steps.ts';
import { UndoCard, UndoSummary } from './undo-card.tsx';

/** Step four: the run, then what it did and the undo window. */
export function ImportResults({
  imp,
  orgId,
  canSync,
  canOperate,
  onSource,
}: {
  imp: PassImportDto;
  orgId: string;
  canSync: boolean;
  /** Results links, mail and undo need `passes:operate`; the error file needs only read. */
  canOperate: boolean;
  onSource: () => void;
}) {
  const qc = useQueryClient();
  const [local, setUndo] = useState<UndoResult>();
  // The server keeps the undo: a reload shows it, and a run in progress polls.
  const undo = local ?? (imp.undo?.state === 'failed' ? undefined : imp.undo);
  const [mailing, setMailing] = useState(false);
  const [confirmMail, setConfirmMail] = useState(false);
  const p = imp.progress;
  const skipped = imp.counts?.errors ?? 0;
  const holding = (imp.emailHoldUntil ?? 0) > Date.now();
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
    <div className="flex flex-col gap-6">
      <Stepper steps={IMPORT_STEPS} current={STEP.issue} onStep={onSource} />
      {imp.state === 'committing' || !p ? (
        <RunningCard imp={imp} />
      ) : (
        <DoneCard imp={imp} undone={Boolean(undo)}>
          {undo ? (
            <UndoSummary result={undo} />
          ) : canOperate ? (
            <UndoCard imp={imp} orgId={orgId} onUndone={setUndo} />
          ) : null}
          <FailedRows imp={imp} orgId={orgId} />
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild iconStart={<List aria-hidden />}>
              <Link to="/admin/passes" search={{ orgId, importId: imp.id }}>
                {C.results.viewPasses}
              </Link>
            </Button>
            {canOperate && p.created + p.updated > 0 ? (
              <ChangeTheseLink orgId={orgId} importId={imp.id} />
            ) : null}
            {canOperate ? (
              <Button
                variant="outline"
                iconStart={<Download aria-hidden />}
                onClick={() => save('results.csv')}
              >
                {C.results.download}
              </Button>
            ) : null}
            {imp.errorFile && skipped > 0 ? (
              <Button
                variant="ghost"
                iconStart={<Download aria-hidden />}
                onClick={() => save('errors.csv')}
              >
                {C.results.skippedRowsN(skipped)}
              </Button>
            ) : null}
            {canOperate && p.notEmailed > 0 && !holding && !undo ? (
              <Button
                variant="outline"
                iconStart={<Mail aria-hidden />}
                loading={mailing}
                onClick={() => setConfirmMail(true)}
              >
                {C.results.emailRest}
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
            open={confirmMail}
            onOpenChange={setConfirmMail}
            title={C.results.emailRestTitle}
            description={C.results.emailRestBody(p.notEmailed)}
            confirmLabel={C.results.emailRestConfirm}
            onConfirm={async () => {
              setConfirmMail(false);
              await mail();
            }}
          />
        </DoneCard>
      )}
    </div>
  );
}
