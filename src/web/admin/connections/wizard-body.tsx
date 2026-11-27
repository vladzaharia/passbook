import type { Dispatch, SetStateAction } from 'react';
import type { z } from 'zod';
import type { ConnectorInfoSchema } from '@/shared/contracts/connections.ts';
import { errorMessage } from '../../lib/errors.ts';
import { ErrorState, SkeletonKeyValue } from '../../ui/index.ts';
import type { MappingRow, SourceField } from '../mapping/mapping.ts';
import type { targetsOf } from '../mapping/mapping-editor.tsx';
import { prefixed } from './config-schema.ts';
import { UploadConfig } from './files/upload-config.tsx';
import type { UploadDraft } from './files/use-upload-draft.ts';
import { type Lifecycle, LifecycleFields } from './lifecycle-fields.tsx';
import type { SampleField } from './rest/mapping-seed.ts';
import type { TestOutcome } from './test-result.tsx';
import { WizardMapping } from './wizard-mapping.tsx';
import { ReviewStep } from './wizard-review.tsx';
import { type ConfigDraft, ConfigStep } from './wizard-steps.tsx';

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
  cfgErrors: Record<string, string>;
  defaultMinutes: number | undefined;
  blockCreate: boolean;
  createFailed: boolean;
  createError: unknown;
  setStep: (step: number) => void;
  isUpload: boolean;
  /** A webhook goes on to the sender's side after Create: its name. */
  after?: string | undefined;
  upload: UploadDraft;
  /** The REST sample's fields, for the Mapping step. */
  onSample: (fields: SampleField[]) => void;
}) {
  const { step, info, connector, orgId, orgName, draft, setDraft, showErrors, serverFields } = p;
  const { test, onTested, life, setLife, lifeError, templateOrg } = p;
  const { rows, setRows, mapped, sample, targets, defaultMinutes, cfgErrors } = p;
  const { blockCreate, createFailed, createError, setStep, isUpload, upload, onSample } = p;
  return (
    <>
      {step === 1 ? (
        info && orgId && isUpload ? (
          <UploadConfig
            upload={upload}
            draft={draft}
            onChange={setDraft}
            showErrors={showErrors}
            idError={cfgErrors.idColumn ?? serverFields['config.idColumn']}
          />
        ) : info && orgId ? (
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
            }}
            test={test}
            onTest={onTested}
            onSample={onSample}
          />
        ) : connector.isError ? (
          <ErrorState inline error={connector.error} onRetry={() => void connector.refetch()} />
        ) : (
          <SkeletonKeyValue label="Loading connector" />
        )
      ) : null}
      {step === 2 ? (
        <WizardMapping
          info={info}
          orgId={orgId}
          templateOrg={templateOrg}
          life={life}
          setLife={setLife}
          draft={draft}
          test={test}
          onTest={onTested}
          rows={rows}
          setRows={setRows}
          errors={showErrors ? mapped.errors : {}}
          targets={targets}
          sources={sample}
          dataset={info?.type === 'demo' ? draft.config.dataset : undefined}
        />
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
            upload={isUpload}
            onEdit={setStep}
          />
          {p.after ? (
            <p className="text-sm text-fg-muted">
              Next: add the webhook in {p.after}. Nothing is issued until its first event.
            </p>
          ) : null}
          {blockCreate ? (
            <p className="text-sm text-danger">
              Creating passes needs a template and mappings. Turn it off or add them.
            </p>
          ) : null}
          {createFailed ? (
            <p className="text-sm text-danger">
              {Object.keys(serverFields).length > 0
                ? 'Fix the highlighted fields on Setup.'
                : errorMessage(createError)}
            </p>
          ) : null}
        </>
      ) : null}
    </>
  );
}
