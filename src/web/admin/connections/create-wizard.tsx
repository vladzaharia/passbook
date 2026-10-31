import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import type { z } from 'zod';
import { ConnectionSchema, type CreateConnectionSchema } from '@/shared/contracts/connections.ts';
import { api } from '../../lib/api.ts';
import { isApiError } from '../../lib/errors.ts';
import { useOrgOptions } from '../../lib/search.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ErrorState,
  FormField,
  Input,
  PageHeader,
  RadioGroup,
  Select,
  Spinner,
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from '../../ui/index.ts';
import {
  cleanValues,
  describeSchema,
  type FormValues,
  flatFields,
  SchemaForm,
  validateValues,
} from '../passes/schema-form/index.ts';
import { useTemplate, useTemplates } from '../templates/api.ts';
import { connectionKeys, useConnector, useConnectors } from './api.ts';
import {
  type Lifecycle,
  LifecycleFields,
  lifecycleError,
  lifecycleToPatch,
} from './lifecycle-fields.tsx';
import { fromRows, type MappingRow } from './mapping.ts';
import { MappingEditor } from './mapping-editor.tsx';
import { secretSchema } from './secret-schema.ts';
import { generateSecret, SecretOnce } from './webhook.tsx';

const STEPS = ['Connector', 'Configuration', 'Mapping', 'Lifecycle', 'Create'] as const;
const NO_TEMPLATE = '__none__';

const DEFAULT_LIFE: Lifecycle = {
  mode: 'poll',
  intervalSeconds: '',
  holderEmailField: '',
  defaultTemplateId: '',
  autoCreate: false,
  autoEmail: false,
  onMissing: 'flag',
};

type CreateBody = z.input<typeof CreateConnectionSchema>;

export function CreateConnectionWizard() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const orgs = useOrgOptions();
  const connectors = useConnectors();
  const [step, setStep] = useState(0);
  const [orgId, setOrgId] = useState<string>();
  const [type, setType] = useState<string>();
  const [name, setName] = useState('');
  const [config, setConfig] = useState<FormValues>({});
  const [secrets, setSecrets] = useState<FormValues>({});
  const [rows, setRows] = useState<MappingRow[]>([]);
  const [life, setLife] = useState<Lifecycle>(DEFAULT_LIFE);
  const [showErrors, setShowErrors] = useState(false);
  const [created, setCreated] = useState<{ id: string; url: string | null; secret?: string }>();
  const connector = useConnector(type);
  const templates = useTemplates({ orgId }, Boolean(orgId));
  const template = useTemplate(life.defaultTemplateId || undefined);

  const dirty = !created && (Boolean(orgId) || name !== '' || Object.keys(config).length > 0);
  const guard = useUnsavedChangesGuard(dirty);

  const cfgSchema = connector.data?.configSchema;
  const secSchema = useMemo(
    () => (connector.data?.secretSchema ? secretSchema(connector.data.secretSchema) : null),
    [connector.data],
  );
  const hasSecrets = secSchema ? flatFields(describeSchema(secSchema)).length > 0 : false;
  const cfgErrors = cfgSchema ? validateValues(cfgSchema, config) : {};
  const secErrors = secSchema ? validateValues(secSchema, secrets) : {};
  const mapped = fromRows(rows);
  const lifeError = lifecycleError(life);

  // Capabilities limit which modes make sense; start from the first supported one.
  useEffect(() => {
    const caps = connector.data?.capabilities;
    if (!caps) return;
    setLife((l) => ({
      ...l,
      mode: caps.poll ? 'poll' : caps.webhook ? 'webhook' : 'manual',
      intervalSeconds: String(connector.data?.defaults.intervalSeconds ?? ''),
    }));
  }, [connector.data]);

  const create = useMutation({
    mutationFn: async () => {
      const wantsWebhook = life.mode === 'webhook' || life.mode === 'hybrid';
      const webhookSecret = wantsWebhook ? generateSecret() : undefined;
      const body: CreateBody = {
        orgId: orgId as string,
        connectorType: type as string,
        name: name.trim(),
        config: cleanValues(config) as CreateBody['config'],
        ...(hasSecrets
          ? {
              secrets: Object.fromEntries(
                Object.entries(cleanValues(secrets)).map(([k, v]) => [k, String(v)]),
              ),
            }
          : {}),
        ...(Object.keys(mapped.mapping).length > 0 ? { mapping: mapped.mapping } : {}),
        ...lifecycleToPatch(life),
        ...(webhookSecret ? { webhookSecret } : {}),
      };
      const connection = await api.post('/api/v1/connections', ConnectionSchema, body);
      return { connection, webhookSecret };
    },
    onSuccess: async ({ connection, webhookSecret }) => {
      await qc.invalidateQueries({ queryKey: connectionKeys.all });
      // A secret is shown once here; otherwise the effect below opens the connection.
      setCreated({ id: connection.id, url: connection.webhookUrl, secret: webhookSecret });
    },
  });

  useEffect(() => {
    if (created && !created.secret) {
      void navigate({ to: `/admin/connections/${created.id}` as never });
    }
  }, [created, navigate]);

  const serverFields = isApiError(create.error) ? create.error.fields : {};
  const cfgServer = fieldsWithPrefix(serverFields, 'config.');
  const secServer = fieldsWithPrefix(serverFields, 'secrets.');

  function next() {
    if (step === 0 && (!orgId || !type)) return;
    if (step === 1) {
      if (!name.trim() || Object.keys(cfgErrors).length > 0 || Object.keys(secErrors).length > 0) {
        return setShowErrors(true);
      }
    }
    if (step === 2 && Object.keys(mapped.errors).length > 0) return setShowErrors(true);
    if (step === 3 && lifeError) return setShowErrors(true);
    setShowErrors(false);
    setStep((s) => s + 1);
  }

  const crumbs = [{ label: 'Connections', to: '/admin/connections' }, { label: 'New' }];

  if (created?.secret) {
    return (
      <>
        <PageHeader title="Connection created" breadcrumbs={crumbs} />
        <div className="grid max-w-2xl gap-4">
          <SecretOnce url={created.url} secret={created.secret} />
          <div>
            <Button asChild>
              <Link to={`/admin/connections/${created.id}` as never}>Open connection</Link>
            </Button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title="New connection" breadcrumbs={crumbs} />
      <ol className="mb-6 flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label="Steps">
        {STEPS.map((label, i) => (
          <li
            key={label}
            aria-current={i === step ? 'step' : undefined}
            className={i === step ? 'font-medium text-fg-strong' : 'text-fg-muted'}
          >
            {i + 1}. {label}
          </li>
        ))}
      </ol>

      {step === 0 ? (
        <div className="grid max-w-xl gap-4">
          <FormField label="Organization" required>
            {(c) => (
              <Select
                {...c}
                value={orgId}
                onValueChange={setOrgId}
                options={(orgs.data?.items ?? []).map((o) => ({ value: o.id, label: o.name }))}
              />
            )}
          </FormField>
          {connectors.isPending ? (
            <Spinner />
          ) : connectors.isError ? (
            <ErrorState error={connectors.error} onRetry={() => void connectors.refetch()} />
          ) : (
            <RadioGroup
              legend="Connector"
              value={type}
              onValueChange={(v) => {
                setType(v);
                setConfig({});
                setSecrets({});
              }}
              options={connectors.data.items.map((c) => ({
                value: c.type,
                label: c.displayName,
                hint: c.type,
              }))}
            />
          )}
        </div>
      ) : null}

      {step === 1 ? (
        connector.isPending ? (
          <Spinner />
        ) : connector.isError ? (
          <ErrorState error={connector.error} onRetry={() => void connector.refetch()} />
        ) : (
          <div className="grid max-w-3xl gap-6">
            <FormField
              label="Name"
              required
              error={showErrors && !name.trim() ? 'Required.' : undefined}
            >
              {(c) => (
                <Input
                  {...c}
                  maxLength={120}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              )}
            </FormField>
            <SchemaForm
              schema={cfgSchema}
              value={config}
              onChange={setConfig}
              showAllErrors={showErrors}
              serverErrors={cfgServer}
            />
            {hasSecrets ? (
              <Card>
                <CardHeader title="Credentials" />
                <CardBody>
                  <SchemaForm
                    schema={secSchema}
                    value={secrets}
                    onChange={setSecrets}
                    showAllErrors={showErrors}
                    serverErrors={secServer}
                  />
                  <p className="mt-3 text-xs text-fg-muted">Stored encrypted. Not shown again.</p>
                </CardBody>
              </Card>
            ) : null}
          </div>
        )
      ) : null}

      {step === 2 ? (
        <div className="grid max-w-4xl gap-4">
          <FormField label="Template">
            {(c) => (
              <Select
                {...c}
                className="max-w-sm"
                value={life.defaultTemplateId || NO_TEMPLATE}
                onValueChange={(v) =>
                  setLife({ ...life, defaultTemplateId: v === NO_TEMPLATE ? '' : v })
                }
                options={[
                  { value: NO_TEMPLATE, label: 'None' },
                  ...(templates.data?.items ?? []).map((t) => ({ value: t.id, label: t.name })),
                ]}
              />
            )}
          </FormField>
          <MappingEditor
            rows={rows}
            onChange={setRows}
            errors={showErrors ? mapped.errors : {}}
            inputKeys={
              template.data
                ? flatFields(describeSchema(template.data.inputSchema)).map((f) => f.key)
                : []
            }
            outputKeys={Object.keys(connector.data?.outputFields ?? {}).map((k) => `/${k}`)}
          />
        </div>
      ) : null}

      {step === 3 && orgId ? (
        <LifecycleFields
          orgId={orgId}
          value={life}
          onChange={setLife}
          capabilities={connector.data?.capabilities}
          error={showErrors ? lifeError : undefined}
        />
      ) : null}

      {step === 4 ? (
        <Card className="max-w-md">
          <CardHeader title="Review" />
          <CardBody className="grid gap-1 text-sm">
            <p>Name: {name}</p>
            <p>Connector: {connector.data?.displayName}</p>
            <p>Mode: {life.mode}</p>
            <p>Mappings: {Object.keys(mapped.mapping).length}</p>
            <p>Create passes automatically: {life.autoCreate ? 'Yes' : 'No'}</p>
            {create.isError ? (
              <p role="alert" className="mt-2 text-danger">
                {isApiError(create.error) && Object.keys(serverFields).length > 0
                  ? 'Fix the highlighted fields on Configuration.'
                  : create.error.message}
              </p>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      <div className="mt-8 flex gap-2">
        {step > 0 ? (
          <Button variant="outline" disabled={create.isPending} onClick={() => setStep(step - 1)}>
            Back
          </Button>
        ) : null}
        {step < 4 ? (
          <Button disabled={step === 0 && (!orgId || !type)} onClick={next}>
            Next
          </Button>
        ) : (
          <Button loading={create.isPending} onClick={() => create.mutate()}>
            Create connection
          </Button>
        )}
      </div>
      <UnsavedChangesDialog blocker={guard} />
    </>
  );
}

function fieldsWithPrefix(
  fields: Record<string, string>,
  prefix: string,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields))
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
  return Object.keys(out).length > 0 ? out : undefined;
}
