import { useState } from 'react';
import type { PassImportDto } from '@/shared/contracts/pass-imports.ts';
import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import { errorMessage } from '../../../lib/errors.ts';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  ErrorState,
  FormField,
  Select,
  Skeleton,
  SwitchRow,
} from '../../../ui/index.ts';
import type { MappingRow, TargetField } from '../../mapping/mapping.ts';
import { MappingEditor, targetsOf } from '../../mapping/mapping-editor.tsx';
import { useTemplate } from '../../templates/api.ts';
import { describeSchema, flatFields } from '../schema-form/index.ts';
import { useCheckImport } from './api.ts';
import { type Match, PINNED, planOfRows, rowsOfImport, sourcesOf } from './plan-rows.ts';

const MATCHES = [
  { value: 'externalId', label: C.match.byExternalId },
  { value: 'email', label: C.match.byEmail },
  { value: 'none', label: C.match.byNone },
] as const;

function MatchForm({
  imp,
  orgId,
  targets,
  onChecked,
}: {
  imp: PassImportDto;
  orgId: string;
  targets: readonly TargetField[];
  onChecked: () => void;
}) {
  const check = useCheckImport(imp.id, orgId);
  const [rows, setRows] = useState<MappingRow[]>(() => rowsOfImport(imp, targets));
  const [match, setMatch] = useState<Match>(imp.plan?.match ?? 'externalId');
  const [keepManual, setKeepManual] = useState(imp.plan?.keepManual ?? false);
  const [save, setSave] = useState(imp.plan?.save ?? true);
  const [shown, setShown] = useState(false);
  const result = planOfRows(rows, { match, keepManual, save });

  function submit() {
    setShown(true);
    if (result.plan) check.mutate({ plan: result.plan }, { onSuccess: onChecked });
  }

  return (
    <Card>
      <CardHeader title={C.match.title} />
      <CardBody className="flex flex-col gap-6">
        {imp.errorCode && !check.isError ? (
          <Callout tone="warning">{errorText(imp.errorCode)}</Callout>
        ) : null}
        <MappingEditor
          rows={rows}
          onChange={setRows}
          targets={targets}
          pinned={PINNED}
          sources={sourcesOf(imp)}
          sourceNoun={C.match.column}
          errors={shown ? result.errors : {}}
          disabled={check.isPending}
        />
        <div className="flex flex-col gap-4 sm:max-w-md">
          <FormField label={C.match.findBy} error={shown ? result.matchError : undefined}>
            {(c) => (
              <Select
                {...c}
                value={match}
                onValueChange={(v) => setMatch(v as Match)}
                options={MATCHES}
              />
            )}
          </FormField>
          {match === 'none' ? null : (
            <SwitchRow
              label={C.match.keepManual}
              help={C.match.keepManualHelp}
              checked={keepManual}
              onCheckedChange={setKeepManual}
            />
          )}
          <SwitchRow label={C.match.save} checked={save} onCheckedChange={setSave} />
        </div>
        {check.isError ? <Callout tone="danger">{errorMessage(check.error)}</Callout> : null}
        <div>
          <Button loading={check.isPending} onClick={submit}>
            {check.isPending ? C.match.checking : C.match.submit}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

const errorText = (code: string) =>
  code === 'IMPORT_COLUMN_MISSING' ? C.savedColumns : C.checkUnfinished;

/** Pick the column for each field, how passes are found, and run the check. */
export function MatchStep({
  imp,
  orgId,
  onChecked,
}: {
  imp: PassImportDto;
  orgId: string;
  onChecked: () => void;
}) {
  const template = useTemplate(imp.templateId, orgId);
  if (template.isError)
    return (
      <ErrorState
        subject="the template"
        error={template.error}
        onRetry={() => template.refetch()}
      />
    );
  if (!template.data) return <Skeleton className="h-64" />;
  const targets = targetsOf(flatFields(describeSchema(template.data.inputSchema)));
  return <MatchForm imp={imp} orgId={orgId} targets={targets} onChecked={onChecked} />;
}
