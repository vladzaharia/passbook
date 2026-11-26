import type { Dispatch, SetStateAction } from 'react';
import type { z } from 'zod';
import type { ConnectorInfoSchema } from '@/shared/contracts/connections.ts';
import { Callout } from '../../ui/index.ts';
import type { MappingRow, SourceField, TargetField } from '../mapping/mapping.ts';
import { MappingEditor } from '../mapping/mapping-editor.tsx';
import type { Lifecycle } from './lifecycle-fields.tsx';
import { TemplateSelect } from './template-select.tsx';
import type { TestOutcome } from './test-result.tsx';
import type { ConfigDraft } from './wizard-steps.tsx';
import { WizardTest } from './wizard-test.tsx';

/** The wizard's Mapping step: the template, a Test for sources that have one, then the mapping rows. */
export function WizardMapping({
  info,
  orgId,
  templateOrg,
  life,
  setLife,
  draft,
  test,
  onTest,
  rows,
  setRows,
  errors,
  targets,
  sources,
}: {
  info: z.infer<typeof ConnectorInfoSchema> | undefined;
  orgId: string | undefined;
  templateOrg: string | undefined;
  life: Lifecycle;
  setLife: Dispatch<SetStateAction<Lifecycle>>;
  draft: ConfigDraft;
  test: TestOutcome | undefined;
  onTest: (outcome: TestOutcome) => void;
  rows: MappingRow[];
  setRows: (rows: MappingRow[]) => void;
  errors: Record<string, string>;
  targets: TargetField[];
  sources: readonly SourceField[];
}) {
  return (
    <>
      <TemplateSelect
        orgId={orgId}
        value={life.defaultTemplateId}
        disabled={!templateOrg}
        onChange={(defaultTemplateId) => setLife((l) => ({ ...l, defaultTemplateId }))}
      />
      {info && orgId && !info.capabilities.upload ? (
        <WizardTest
          connector={info}
          orgId={orgId}
          config={draft.config}
          secrets={draft.secrets}
          test={test}
          onTest={onTest}
        />
      ) : null}
      {rows.length === 0 ? (
        <Callout tone="warning" title="Nothing mapped yet">
          Passes are not created or updated until you map fields to the template.
        </Callout>
      ) : null}
      <MappingEditor
        rows={rows}
        onChange={setRows}
        errors={errors}
        targets={targets}
        sources={sources}
      />
    </>
  );
}
