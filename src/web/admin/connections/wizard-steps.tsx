import { useEffect, useMemo } from 'react';
import type { z } from 'zod';
import type { ConnectorInfoSchema, RecipeId } from '@/shared/contracts/connections.ts';
import { useOrgTimeZone } from '@/web/admin/settings/use-org-time-zone.ts';
import { connectorIcon } from '../../lib/entities.ts';
import {
  Card,
  CardBody,
  FormField,
  Input,
  OptionTile,
  RadioGroup,
  Select,
  SkeletonRows,
} from '../../ui/index.ts';
import { type FormValues, SchemaForm } from '../passes/schema-form/index.ts';
import { authOptions, flattenSchema, WIZARD_HIDDEN } from './config-schema.ts';
import { recipeHidden } from './recipe-copy.ts';
import { RecipePicker, SigningSecretField } from './recipe-picker.tsx';
import type { SampleField } from './rest/mapping-seed.ts';
import { WizardRest } from './rest/wizard-rest.tsx';
import { secretSchema } from './secret-schema.ts';
import type { TestOutcome } from './test-result.tsx';
import { WizardTest } from './wizard-test.tsx';

type Connector = z.infer<typeof ConnectorInfoSchema>;

export function ConnectorStep({
  connectors,
  loading,
  type,
  onType,
  onCommit,
  orgs,
  orgId,
  onOrg,
  showErrors,
}: {
  connectors: readonly Connector[];
  loading: boolean;
  type: string | undefined;
  onType: (type: string) => void;
  onCommit: () => void;
  /** Shown only when the top-bar scope does not set the org. */
  orgs: { id: string; name: string }[] | null;
  orgId: string | undefined;
  onOrg: (id: string) => void;
  /** Next was pressed with no org or no connector. */
  showErrors?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-6">
      {orgs ? (
        <FormField
          label="Organization"
          required
          error={showErrors && !orgId ? 'Choose an organization.' : undefined}
        >
          {(c) => (
            <Select
              {...c}
              className="sm:max-w-sm"
              value={orgId}
              placeholder="Choose an organization"
              onValueChange={onOrg}
              options={orgs.map((o) => ({ value: o.id, label: o.name }))}
            />
          )}
        </FormField>
      ) : null}
      {loading ? (
        <SkeletonRows rows={3} label="Loading connectors" />
      ) : (
        <fieldset className="min-w-0">
          <legend className="mb-2 text-sm font-medium text-fg">Connector</legend>
          <div
            role="radiogroup"
            aria-label="Connector"
            aria-invalid={showErrors && !type ? true : undefined}
            aria-describedby={showErrors && !type ? 'connector-error' : undefined}
            className="grid grid-cols-1 gap-2 sm:grid-cols-2"
          >
            {connectors.map((c) => {
              const Icon = connectorIcon(c.type);
              const picked = c.type === type;
              return (
                <OptionTile
                  key={c.type}
                  name="connector"
                  value={c.type}
                  label={c.displayName}
                  className="items-center"
                  checked={picked}
                  onSelect={onType}
                  onCommit={() => {
                    onType(c.type);
                    onCommit();
                  }}
                  media={
                    <span
                      aria-hidden
                      key={picked ? 'on' : 'off'}
                      className={`inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface-sunken ${
                        picked ? 'wl-glyph-bounce text-accent-fg' : 'text-fg-muted'
                      }`}
                    >
                      <Icon className="size-5" />
                    </span>
                  }
                />
              );
            })}
          </div>
          {showErrors && !type ? (
            <p id="connector-error" className="mt-2 text-xs text-danger">
              Choose a connector.
            </p>
          ) : null}
        </fieldset>
      )}
    </div>
  );
}

export interface ConfigDraft {
  name: string;
  config: FormValues;
  secrets: FormValues;
  /** A secret the sender made (Shopify, Stripe), pasted. */
  signingSecret?: string;
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
  onRecipe,
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
  /** Picks a sender: the wizard seeds the mapping and void rules from it. */
  onRecipe: (id: RecipeId) => void;
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
  const customEntitled = connector.entitled !== false;
  const firstEntitled = connector.recipes.find((r) => r.entitled !== false)?.id;
  // A plan that lists senders but not a custom one starts on its first sender.
  useEffect(() => {
    if (offered && !customEntitled && recipe === 'custom' && firstEntitled) onRecipe(firstEntitled);
  }, [offered, customEntitled, recipe, firstEntitled, onRecipe]);
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
        {offered ? (
          <RecipePicker
            recipes={connector.recipes}
            customEntitled={customEntitled}
            value={recipe}
            onChange={onRecipe}
          />
        ) : null}
        {recipe !== 'custom' && connector.recipes.find((r) => r.id === recipe)?.pasteSecret ? (
          <SigningSecretField
            recipe={recipe}
            value={draft.signingSecret ?? ''}
            onChange={(signingSecret) => set({ signingSecret })}
            error={(showErrors ? secretError : undefined) ?? serverErrors.signing}
          />
        ) : null}
        <SchemaForm
          orgZone={orgZone}
          schema={flat}
          value={draft.config}
          onChange={(config) => set({ config })}
          hiddenKeys={mainHidden}
          showAllErrors={showErrors}
          serverErrors={serverErrors.config}
        />
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
            />
            {test?.kind === 'result' && test.result.sample?.length ? (
              <ul aria-label="Fields in the first record" className="flex flex-wrap gap-1.5">
                {test.result.sample.map((f) => (
                  <li
                    key={f.pointer}
                    title={f.preview}
                    className="rounded-md border border-border bg-surface-sunken px-2 py-0.5 font-mono text-xs text-fg"
                  >
                    {f.pointer}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
