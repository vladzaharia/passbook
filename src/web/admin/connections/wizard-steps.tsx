import { useMemo } from 'react';
import type { z } from 'zod';
import type { ConnectorInfoSchema, RecipeId } from '@/shared/contracts/connections.ts';
import { useOrgTimeZone } from '@/web/admin/settings/use-org-time-zone.ts';
import { Card, CardBody, FormField, Input, RadioGroup } from '../../ui/index.ts';
import { type FormValues, SchemaForm } from '../passes/schema-form/index.ts';
import { authOptions, flattenSchema, WIZARD_HIDDEN } from './config-schema.ts';
import { DemoFields } from './demo/demo-fields.tsx';
import { FieldChips } from './demo/field-chips.tsx';
import { recipeHidden } from './recipe-copy.ts';
import { SigningSecretField } from './recipe-picker.tsx';
import type { SampleField } from './rest/mapping-seed.ts';
import { WizardRest } from './rest/wizard-rest.tsx';
import { secretSchema } from './secret-schema.ts';
import type { TestOutcome } from './test-result.tsx';
import { WizardTest } from './wizard-test.tsx';

type Connector = z.infer<typeof ConnectorInfoSchema>;

export interface ConfigDraft {
  name: string;
  config: FormValues;
  secrets: FormValues;
  /** A secret the sender made (Shopify, Stripe), pasted. */
  signingSecret?: string;
  fileId?: string; // file upload: the dropped file's draft
}

export function ConfigStep({
  connector,
  orgId,
  draft,
  onChange,
  showErrors,
  serverErrors,
  test,
  onTest,
  onSample,
  secretError,
}: {
  connector: Connector;
  orgId: string;
  draft: ConfigDraft;
  onChange: (next: ConfigDraft | ((d: ConfigDraft) => ConfigDraft)) => void;
  showErrors: boolean;
  serverErrors: {
    config?: Record<string, string>;
    secrets?: Record<string, string>;
    /** The server refused the pasted signing secret. */
    signing?: string | undefined;
  };
  test: TestOutcome | undefined;
  onTest: (outcome: TestOutcome) => void;
  /** The REST sample's fields, for the Mapping step. */
  onSample?: (fields: SampleField[]) => void;
  secretError?: string | undefined;
}) {
  const orgZone = useOrgTimeZone(orgId);
  const flat = useMemo(() => flattenSchema(connector.configSchema), [connector.configSchema]);
  const rest = connector.type === 'http-json';
  const auth = authOptions(flat);
  const authType = String(draft.config['auth.type'] ?? 'none');
  const recipe = (draft.config.recipe as RecipeId | undefined) ?? 'custom';
  const offered = connector.recipes.length > 0;
  const hidden = useMemo(
    () =>
      new Set([
        ...WIZARD_HIDDEN(flat, authType),
        ...recipeHidden(recipe, offered),
        ...(rest ? ['holderEmailPointer'] : []),
      ]),
    [flat, authType, recipe, offered, rest],
  );
  const keys = Object.keys((flat?.properties as object | undefined) ?? {});
  const mainHidden = useMemo(
    () => new Set([...hidden, ...keys.filter((k) => k.startsWith('auth.'))]),
    [hidden, keys],
  );
  const authHidden = useMemo(
    () => new Set([...hidden, ...keys.filter((k) => !k.startsWith('auth.'))]),
    [hidden, keys],
  );
  const authFields = keys.filter((k) => !authHidden.has(k)).length;
  // Under the Authentication radio the group heading would repeat it.
  const authSchema = useMemo(() => {
    const props = (flat?.properties ?? {}) as Record<string, Record<string, unknown>>;
    const stripped = Object.fromEntries(
      Object.entries(props).map(([k, d]) => [
        k,
        k.startsWith('auth.') ? { ...d, 'x-group': '' } : d,
      ]),
    );
    return { ...flat, properties: stripped };
  }, [flat]);
  const secretsFlat = useMemo(
    () => (connector.secretSchema ? secretSchema(connector.secretSchema) : null),
    [connector.secretSchema],
  );
  const hiddenSecrets = useMemo(
    () => WIZARD_HIDDEN(flattenSchema(secretsFlat), authType),
    [secretsFlat, authType],
  );
  const set = (patch: Partial<ConfigDraft>) => onChange({ ...draft, ...patch });
  const demo = connector.type === 'demo';

  // One card for the step, like Review: the schema's groups take headings inside it.
  return (
    <Card>
      <CardBody className="flex min-w-0 flex-col gap-6">
        <FormField
          label="Name"
          required
          error={showErrors && !draft.name.trim() ? 'Required.' : undefined}
        >
          {(c) => (
            <Input
              {...c}
              className="sm:max-w-md"
              maxLength={120}
              placeholder="Member sync"
              value={draft.name}
              onChange={(e) => set({ name: e.target.value })}
            />
          )}
        </FormField>
        {recipe !== 'custom' && connector.recipes.find((r) => r.id === recipe)?.pasteSecret ? (
          <SigningSecretField
            recipe={recipe}
            value={draft.signingSecret ?? ''}
            onChange={(signingSecret) => set({ signingSecret })}
            error={(showErrors ? secretError : undefined) ?? serverErrors.signing}
          />
        ) : null}
        {demo ? (
          <DemoFields
            schema={flat}
            value={draft.config}
            onChange={(config) => set({ config })}
            showErrors={showErrors}
            serverErrors={serverErrors.config}
          />
        ) : (
          <SchemaForm
            orgZone={orgZone}
            schema={flat}
            value={draft.config}
            onChange={(config) => set({ config })}
            hiddenKeys={mainHidden}
            showAllErrors={showErrors}
            serverErrors={serverErrors.config}
          />
        )}
        {auth ? (
          <RadioGroup
            legend="Authentication"
            orientation="horizontal"
            options={auth}
            value={authType}
            onValueChange={(v) => set({ config: { ...draft.config, 'auth.type': v } })}
          />
        ) : null}
        {authFields ? (
          <SchemaForm
            orgZone={orgZone}
            schema={authSchema}
            value={draft.config}
            onChange={(config) => set({ config })}
            hiddenKeys={authHidden}
            showAllErrors={showErrors}
            serverErrors={serverErrors.config}
            idPrefix="auth-"
          />
        ) : null}
        {secretsFlat &&
        hiddenSecrets.size < Object.keys(flattenSchema(secretsFlat)?.properties ?? {}).length ? (
          <SchemaForm
            orgZone={orgZone}
            schema={secretsFlat}
            value={draft.secrets}
            onChange={(secrets) => set({ secrets })}
            hiddenKeys={hiddenSecrets}
            showAllErrors={showErrors}
            serverErrors={serverErrors.secrets}
            idPrefix="secret-"
          />
        ) : null}
        {rest ? (
          <WizardRest
            orgId={orgId}
            draft={draft}
            onChange={onChange}
            hiddenSecrets={hiddenSecrets}
            showErrors={showErrors}
            onSample={onSample}
          />
        ) : (
          <div className="flex flex-col gap-3 border-t border-border pt-4">
            <WizardTest
              connector={connector}
              orgId={orgId}
              config={draft.config}
              secrets={draft.secrets}
              test={test}
              onTest={onTest}
              autoKey={demo ? String(draft.config.dataset ?? '') || undefined : undefined}
            />
            {test?.kind === 'result' && test.result.sample?.length ? (
              <FieldChips sample={test.result.sample} />
            ) : null}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
