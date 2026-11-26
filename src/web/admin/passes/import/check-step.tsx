import { useState } from 'react';
import type { PassImportDto } from '@/shared/contracts/pass-imports.ts';
import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import { inputFields } from '@/shared/issuing/fields.ts';
import { errorMessage } from '../../../lib/errors.ts';
import { useMediaQuery } from '../../../lib/media.ts';
import { useSession } from '../../../lib/session.ts';
import { Button, Callout, Card, CardHeader, KeyValue, toast } from '../../../ui/index.ts';
import { useTemplate } from '../../templates/api.ts';
import { downloadImportFile, useCheckImport, useDiscardImport } from './api.ts';
import { HOLD_CHOICES, isUndone, useCommitRun } from './api-run.ts';
import { type EmailChoice, EmailSettings } from './check-aside.tsx';
import { type CheckFilter, CheckTiles } from './check-tiles.tsx';
import { FixTable } from './fix-table.tsx';
import { ImportWizard, summaryOf } from './import-wizard.tsx';
import { findLabel } from './match-sample.ts';
import { NewFan } from './new-fan.tsx';
import { STEP } from './steps.ts';
import { UpdatesList } from './updates-list.tsx';

/** Counts, fixes, diffs and cards of a checked draft; Create starts the run. */
export function CheckStep({
  imp,
  orgId,
  canOperate,
  onStep,
  onDiscarded,
}: {
  imp: PassImportDto;
  orgId: string;
  canOperate: boolean;
  onStep: (step: number) => void;
  onDiscarded: () => void;
}) {
  const session = useSession();
  const wide = useMediaQuery('(min-width: 1024px)');
  const template = useTemplate(imp.templateId, orgId);
  const again = useCheckImport(imp.id, orgId);
  const commit = useCommitRun(imp.id, orgId);
  const discard = useDiscardImport(imp.id, orgId);
  const [picked, setFilter] = useState<CheckFilter>('all');
  const [email, setEmail] = useState<EmailChoice>({ on: false, hold: '5m' });
  const counts = imp.counts;
  if (!counts) return null;
  // A filter whose rows are all gone (the last fix) shows everything again.
  const filter = picked !== 'all' && counts[picked] === 0 ? 'all' : picked;
  // The server refuses more work on an import that was undone.
  const undone = [again.error, commit.error, discard.error].some(isUndone);
  const stale = imp.state === 'stale';
  const nothing = counts.create + counts.update === 0;
  const fields = new Map(inputFields(template.data?.inputSchema).map((f) => [f.key, f]));
  const show = (f: Exclude<CheckFilter, 'all' | 'unchanged'>) => filter === 'all' || filter === f;
  const canEmail = counts.emailable > 0 && (imp.emailBudget ?? 0) > 0;

  function fix(row: number, pointer: string, value: string) {
    const plan = imp.plan;
    if (!plan) return;
    const overrides = { ...plan.overrides, [row]: { ...plan.overrides?.[row], [pointer]: value } };
    again.mutate({ plan: { ...plan, overrides } });
  }

  function start() {
    const choice = HOLD_CHOICES.find((h) => h.value === email.hold);
    commit.mutate({
      skipInvalid: counts?.errors ? counts.errors > 0 : false,
      email:
        email.on && canEmail
          ? choice && choice.holdMs > 0
            ? { send: 'held', holdMs: choice.holdMs }
            : { send: 'now' }
          : false,
    });
    return undefined;
  }

  const facts = (
    <KeyValue
      items={[
        { label: C.check.template, value: template.data?.name },
        {
          label: C.check.matchBy,
          value: findLabel(imp.plan, imp.columns, template.data?.inputSchema),
        },
        { label: C.check.rows, value: String(counts.rows) },
      ]}
    />
  );
  const settings = (
    <div className="flex flex-col gap-6">
      <EmailSettings imp={imp} value={email} onChange={setEmail} />
      {facts}
      {canOperate && !undone ? (
        <div>
          <Button
            variant="outline"
            loading={discard.isPending}
            onClick={() => discard.mutate(undefined, { onSuccess: onDiscarded })}
          >
            {C.check.discard}
          </Button>
        </div>
      ) : null}
    </div>
  );

  return (
    <ImportWizard
      current={STEP.check}
      summary={summaryOf(imp)}
      onStep={onStep}
      onCancel={onDiscarded}
      onBack={() => onStep(STEP.match)}
      onNext={canOperate ? start : undefined}
      nextLabel={C.commitButton(counts)}
      nextDisabled={stale || nothing || !canOperate || undone}
      busy={commit.isPending}
      asideLabel={C.check.settings}
      asideQuiet
      aside={settings}
    >
      <CheckTiles counts={counts} filter={filter} onFilter={setFilter} />
      {undone ? <Callout tone="warning">{C.undo.gone}</Callout> : null}
      {stale && imp.plan && canOperate && !undone ? (
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
      {again.isError && !undone ? (
        <Callout tone="danger">{errorMessage(again.error)}</Callout>
      ) : null}
      {commit.isError && !undone ? (
        <Callout tone="danger">{errorMessage(commit.error)}</Callout>
      ) : null}
      {show('errors') || filter === 'errors' ? (
        <FixTable
          imp={imp}
          fields={fields}
          editable
          total={counts.errors}
          busy={again.isPending}
          title={C.check.tileFix}
          onFix={canOperate ? fix : undefined}
          onDownload={
            imp.errorFile
              ? () =>
                  downloadImportFile(imp.id, orgId, 'errors.csv').catch((e: unknown) =>
                    toast.error(e, C.results.couldNotDownload),
                  )
              : undefined
          }
        />
      ) : null}
      {filter === 'all' || filter === 'update' ? (
        counts.update > 0 ? (
          <Card>
            <CardHeader title={`${C.check.tileUpdates} ${counts.update}`} />
            <UpdatesList id={imp.id} orgId={orgId} total={counts.update} />
          </Card>
        ) : null
      ) : null}
      {filter === 'all' || filter === 'create' ? (
        counts.create > 0 ? (
          <Card>
            <CardHeader title={`${C.check.tileNew} ${counts.create}`} />
            <NewFan imp={imp} orgId={orgId} principalId={session.authed?.user.id} />
          </Card>
        ) : null
      ) : null}
      {filter === 'unchanged' ? (
        <p className="text-sm text-fg-muted">{C.check.sameNote(counts.unchanged)}</p>
      ) : null}
      {filter === 'all' ? (
        <FixTable
          imp={imp}
          fields={fields}
          editable={false}
          total={imp.problemTotals.warnings}
          busy={false}
          title={C.check.notes}
        />
      ) : null}
      {wide ? null : (
        <Card>
          <div className="p-4">{settings}</div>
        </Card>
      )}
    </ImportWizard>
  );
}
