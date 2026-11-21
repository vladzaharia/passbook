import { Download } from 'lucide-react';
import { useState } from 'react';
import type { PassImportDto } from '@/shared/contracts/pass-imports.ts';
import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import { errorMessage } from '../../../lib/errors.ts';
import { useSession } from '../../../lib/session.ts';
import { Buddy, Button, Callout, Card, CardBody, toast } from '../../../ui/index.ts';
import { downloadImportFile, useCheckImport, useDiscardImport } from './api.ts';
import { CommitSheet } from './commit-sheet.tsx';
import { Previews } from './previews.tsx';
import { ProblemsTable } from './problems.tsx';

/** Counts, previews and problems of a checked draft; commit opens the sheet. */
export function CheckStep({
  imp,
  orgId,
  canOperate,
  onEditColumns,
  onDiscarded,
}: {
  imp: PassImportDto;
  orgId: string;
  canOperate: boolean;
  onEditColumns: () => void;
  onDiscarded: () => void;
}) {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const again = useCheckImport(imp.id, orgId);
  const discard = useDiscardImport(imp.id, orgId);
  const counts = imp.counts;
  if (!counts) return null;
  const stale = imp.state === 'stale';
  const nothing = counts.create + counts.update === 0;
  return (
    <Card>
      <CardBody className="flex flex-col gap-4">
        <div className="flex items-center gap-4 pt-4">
          <Buddy
            scene="sweep"
            mood={counts.errors > 0 ? 'curious' : 'happy'}
            size="sm"
            className="shrink-0"
          />
          <p className="text-base font-medium text-fg-strong">{C.countsLine(counts)}</p>
        </div>
        {stale && imp.plan && canOperate ? (
          <Callout
            tone="warning"
            actions={
              <Button
                size="sm"
                variant="outline"
                loading={again.isPending}
                onClick={() => imp.plan && again.mutate({ plan: imp.plan })}
              >
                {C.check.checkAgain}
              </Button>
            }
          >
            {C.check.stale}
          </Callout>
        ) : null}
        {again.isError ? <Callout tone="danger">{errorMessage(again.error)}</Callout> : null}
        <Previews imp={imp} orgId={orgId} principalId={session.authed?.user.id} />
        <ProblemsTable imp={imp} />
        <div className="flex flex-wrap gap-2">
          {canOperate ? (
            <Button disabled={stale || nothing} onClick={() => setOpen(true)}>
              {C.commitButton(counts)}
            </Button>
          ) : null}
          {canOperate ? (
            <Button variant="outline" onClick={onEditColumns}>
              {C.check.changeColumns}
            </Button>
          ) : null}
          {imp.errorFile ? (
            <Button
              variant="outline"
              iconStart={<Download aria-hidden />}
              onClick={() =>
                downloadImportFile(imp.id, orgId, 'errors.csv').catch((e: unknown) =>
                  toast.error(e, C.results.couldNotDownload),
                )
              }
            >
              {C.check.download}
            </Button>
          ) : null}
          {canOperate ? (
            <Button
              variant="ghost"
              loading={discard.isPending}
              onClick={() => discard.mutate(undefined, { onSuccess: onDiscarded })}
            >
              {C.check.discard}
            </Button>
          ) : null}
        </div>
        <CommitSheet imp={imp} orgId={orgId} open={open} onOpenChange={setOpen} />
      </CardBody>
    </Card>
  );
}
