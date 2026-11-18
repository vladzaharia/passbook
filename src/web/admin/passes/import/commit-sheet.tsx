import { useState } from 'react';
import type { PassImportDto } from '@/shared/contracts/pass-imports.ts';
import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import { errorMessage } from '../../../lib/errors.ts';
import {
  Button,
  Callout,
  CheckboxField,
  Sheet,
  SheetContent,
  SwitchRow,
} from '../../../ui/index.ts';
import { useCommitImport } from './api.ts';

/** The confirm sheet: email the new holders, skip rows with errors, then start. */
export function CommitSheet({
  imp,
  orgId,
  open,
  onOpenChange,
}: {
  imp: PassImportDto;
  orgId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const commit = useCommitImport(imp.id, orgId);
  const [email, setEmail] = useState(false);
  const [skip, setSkip] = useState(false);
  const counts = imp.counts;
  if (!counts) return null;
  const budget = imp.emailBudget ?? 0;
  const canEmail = counts.emailable > 0 && budget > 0;
  const blocked = counts.errors > 0 && !skip;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent title={C.sheet.title}>
        <div className="flex flex-col gap-4 p-4">
          <SwitchRow
            label={C.sheet.email}
            help={
              counts.emailable === 0 ? C.sheet.noEmail : C.emailBudget(budget, counts.emailable)
            }
            checked={email && canEmail}
            disabled={!canEmail}
            onCheckedChange={setEmail}
          />
          {counts.errors > 0 ? (
            <CheckboxField
              label={C.sheet.skip(counts.errors)}
              checked={skip}
              onCheckedChange={(v) => setSkip(v === true)}
            />
          ) : null}
          {commit.isError ? <Callout tone="danger">{errorMessage(commit.error)}</Callout> : null}
          <Button
            disabled={blocked}
            loading={commit.isPending}
            onClick={() =>
              commit.mutate(
                { skipInvalid: skip, email: email && canEmail },
                { onSuccess: () => onOpenChange(false) },
              )
            }
          >
            {C.commitLabel(counts.create, counts.update)}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
