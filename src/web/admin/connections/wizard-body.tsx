import type { Dispatch, SetStateAction } from 'react';
import type { z } from 'zod';
import type { ConnectorInfoSchema } from '@/shared/contracts/connections.ts';
import { errorMessage } from '../../lib/errors.ts';
import { Callout, ErrorState, SkeletonKeyValue } from '../../ui/index.ts';
import type { MappingRow, SourceField } from '../mapping/mapping.ts';
import { MappingEditor, type targetsOf } from '../mapping/mapping-editor.tsx';
import { prefixed } from './config-schema.ts';
import { type Lifecycle, LifecycleFields } from './lifecycle-fields.tsx';
import { TemplateSelect } from './template-select.tsx';
import type { TestOutcome } from './test-result.tsx';
import { ReviewStep } from './wizard-review.tsx';
import { type ConfigDraft, ConfigStep } from './wizard-steps.tsx';
import { WizardTest } from './wizard-test.tsx';

type Connector = z.infer<typeof ConnectorInfoSchema>;

/** The steps after the connector pick: configuration, mapping, lifecycle and review. */
export function WizardBody(p: {
  step: number;
  info: Connector | undefined;
  connector: { isError: boolean; error: unknown; refetch: () => unknown };
  orgId: string | undefined;
  orgName: string;
  draft: ConfigDraft;
  setDraft: Dispatch<SetStateAction<ConfigDraft>>;
  showErrors: boolean;
  serverFields: Record<string, string>;
  test: TestOutcome | undefined;
  onTested: (outcome: TestOutcome) => void;
  secretError: string | undefined;
  life: Lifecycle;
  setLife: Dispatch<SetStateAction<Lifecycle>>;
  lifeError: string | undefined;
  templateOrg: string | undefined;
  selectedTemplateName: string | undefined;
  rows: MappingRow[];
  setRows: (rows: MappingRow[]) => void;
  mapped: { mapping: Record<string, unknown>; errors: Record<string, string> };
  sample: readonly SourceField[];
  targets: ReturnType<typeof targetsOf>;
  noMappings: boolean;
  defaultMinutes: number | undefined;
  blockCreate: boolean;
  createFailed: boolean;
  createError: unknown;
  setStep: (step: number) => void;
}) {
  const { step, info, connector, orgId, orgName, draft, setDraft, showErrors, serverFields } = p;
  const { test, onTested, secretError, life, setLife, lifeError, templateOrg } = p;
  const { rows, setRows, mapped, sample, targets, noMappings, defaultMinutes } = p;
  const { blockCreate, createFailed, createError, setStep } = p;
  return (
    <>
      {step === 1 ? (
        info && orgId ? (
          <ConfigStep
            key={orgId}
            connector={info}
            orgId={orgId}
            draft={draft}
            onChange={setDraft}
            showErrors={showErrors}
            serverErrors={{
              config: prefixed(serverFields, 'config.'),
              secrets: prefixed(serverFields, 'secrets.'),
              signing: serverFields.webhookSecret,
            }}
            test={test}
            onTest={onTested}
            secretError={secretError}
          />
        ) : connector.isError ? (
          <ErrorState inline error={connector.error} onRetry={() => void connector.refetch()} />
        ) : (
          <SkeletonKeyValue label="Loading connector" />
        )
      ) : null}
      {step === 2 ? (
        <>
          <TemplateSelect
            orgId={orgId}
            value={life.defaultTemplateId}
            disabled={!templateOrg}
            onChange={(defaultTemplateId) => setLife({ ...life, defaultTemplateId })}
          />
          {info && orgId ? (
            <WizardTest
              connector={info}
              orgId={orgId}
              config={draft.config}
              secrets={draft.secrets}
              test={test}
              onTest={onTested}
            />
          ) : null}
          {noMappings ? (
            <Callout tone="warning" title="Nothing mapped yet">
              Passes are not created or updated until you map fields to the template.
            </Callout>
          ) : null}
          <MappingEditor
            rows={rows}
            onChange={setRows}
            errors={showErrors ? mapped.errors : {}}
            targets={targets}
            sources={sample}
          />
        </>
      ) : null}
      {step === 3 ? (
        <LifecycleFields
          value={life}
          onChange={setLife}
          capabilities={info?.capabilities}
          defaultMinutes={defaultMinutes}
          error={showErrors ? lifeError : undefined}
        />
      ) : null}
      {step === 4 ? (
        <>
          <ReviewStep
            orgName={orgName}
            connector={info}
            name={draft.name}
            life={life}
            templateName={p.selectedTemplateName}
            mappings={Object.keys(mapped.mapping).length}
            defaultMinutes={defaultMinutes}
            onEdit={setStep}
          />
          {blockCreate ? (
            <p className="text-sm text-danger">
              Creating passes needs a template and mappings. Turn it off or add them.
            </p>
          ) : null}
          {createFailed ? (
            <p className="text-sm text-danger">
              {Object.keys(serverFields).length > 0
                ? 'Fix the highlighted fields on Configuration.'
                : errorMessage(createError)}
            </p>
          ) : null}
        </>
      ) : null}
    </>
  );
}
