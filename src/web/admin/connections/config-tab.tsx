import { useMemo, useState } from 'react';
import type { z } from 'zod';
import type { ConnectionDetailSchema } from '@/shared/contracts/connections.ts';
import { isApiError } from '../../lib/errors.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  FormField,
  Input,
  SaveBar,
  toast,
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from '../../ui/index.ts';
import {
  cleanValues,
  describeSchema,
  type FormValues,
  flatFields,
  pickDeclared,
  SchemaForm,
  sameValues,
  validateValues,
} from '../passes/schema-form/index.ts';
import { type ConnectionPatch, useConnectionActions, useConnector } from './api.ts';
import { secretSchema } from './secret-schema.ts';

type Detail = z.infer<typeof ConnectionDetailSchema>;

const num = (v: number | null) => (v === null ? '' : String(v));

function limitError(v: string, min: number, max: number): string | undefined {
  if (!v.trim()) return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max
    ? undefined
    : `Whole number from ${min} to ${max}.`;
}

function prefixed(fields: Record<string, string>, prefix: string) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields))
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
  return Object.keys(out).length > 0 ? out : undefined;
}

export function ConfigTab({ c }: { c: Detail }) {
  const actions = useConnectionActions(c.id);
  const connector = useConnector(c.connectorType);
  const cfgSchema = connector.data?.configSchema;
  const secSchema = useMemo(
    () => (connector.data?.secretSchema ? secretSchema(connector.data.secretSchema) : null),
    [connector.data],
  );
  const hasSecrets = secSchema ? flatFields(describeSchema(secSchema)).length > 0 : false;
  const initialConfig = useMemo(
    () => (cfgSchema ? pickDeclared(cfgSchema, c.config) : {}),
    [cfgSchema, c.config],
  );
  const [config, setConfig] = useState<FormValues | undefined>();
  const [replacing, setReplacing] = useState(false);
  const [secrets, setSecrets] = useState<FormValues>({});
  const [rpm, setRpm] = useState<string | undefined>();
  const [conc, setConc] = useState<string | undefined>();
  const [showErrors, setShowErrors] = useState(false);

  const cfg = config ?? initialConfig;
  const rpmValue = rpm ?? num(c.requestsPerMinute);
  const concValue = conc ?? num(c.maxConcurrency);
  const cfgErrors = cfgSchema ? validateValues(cfgSchema, cfg) : {};
  const secErrors = replacing && secSchema ? validateValues(secSchema, secrets) : {};
  const rpmError = limitError(rpmValue, 1, 6000);
  const concError = limitError(concValue, 1, 20);
  const dirty =
    !sameValues(cfg, initialConfig) ||
    replacing ||
    rpmValue !== num(c.requestsPerMinute) ||
    concValue !== num(c.maxConcurrency);
  const guard = useUnsavedChangesGuard(dirty);
  const serverFields = isApiError(actions.update.error) ? actions.update.error.fields : {};

  function reset() {
    setConfig(undefined);
    setReplacing(false);
    setSecrets({});
    setRpm(undefined);
    setConc(undefined);
    setShowErrors(false);
    actions.update.reset();
  }

  async function save() {
    const invalid =
      Object.keys(cfgErrors).length > 0 ||
      Object.keys(secErrors).length > 0 ||
      rpmError ||
      concError;
    if (invalid) return setShowErrors(true);
    const patch: ConnectionPatch = {};
    if (!sameValues(cfg, initialConfig)) patch.config = cleanValues(cfg) as never;
    if (replacing) {
      patch.secrets = Object.fromEntries(
        Object.entries(cleanValues(secrets)).map(([k, v]) => [k, String(v)]),
      );
    }
    if (rpmValue !== num(c.requestsPerMinute) && rpmValue.trim()) {
      patch.requestsPerMinute = Number(rpmValue);
    }
    if (concValue !== num(c.maxConcurrency) && concValue.trim()) {
      patch.maxConcurrency = Number(concValue);
    }
    try {
      await actions.update.mutateAsync(patch);
      reset();
      toast.success('Configuration saved');
    } catch (cause) {
      toast.error(cause);
    }
  }

  const defaults = connector.data?.defaults;
  return (
    <div className="grid max-w-3xl gap-6 pb-16">
      {cfgSchema ? (
        <Card>
          <CardHeader title="Connector" />
          <CardBody>
            <SchemaForm
              schema={cfgSchema}
              value={cfg}
              onChange={setConfig}
              showAllErrors={showErrors}
              serverErrors={prefixed(serverFields, 'config.')}
              disabled={actions.update.isPending}
            />
          </CardBody>
        </Card>
      ) : null}
      {hasSecrets ? (
        <Card>
          <CardHeader
            title="Credentials"
            actions={
              replacing ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setReplacing(false);
                    setSecrets({});
                  }}
                >
                  Keep current
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => setReplacing(true)}>
                  Replace credentials
                </Button>
              )
            }
          />
          <CardBody>
            {replacing ? (
              <SchemaForm
                schema={secSchema}
                value={secrets}
                onChange={setSecrets}
                showAllErrors={showErrors}
                serverErrors={prefixed(serverFields, 'secrets.')}
                disabled={actions.update.isPending}
                idPrefix="secret-"
              />
            ) : (
              <p className="text-sm text-fg-muted">
                {c.hasCredential ? 'Credentials are set.' : 'No credentials set.'} Stored encrypted.
                Never shown.
              </p>
            )}
          </CardBody>
        </Card>
      ) : null}
      <Card>
        <CardHeader title="Limits" />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="Requests per minute"
            error={showErrors ? rpmError : undefined}
            help={defaults ? `Default ${defaults.requestsPerMinute}.` : undefined}
          >
            {(f) => (
              <Input
                {...f}
                type="number"
                inputMode="numeric"
                value={rpmValue}
                onChange={(e) => setRpm(e.target.value)}
                disabled={actions.update.isPending}
              />
            )}
          </FormField>
          <FormField
            label="Max concurrency"
            error={showErrors ? concError : undefined}
            help={defaults ? `Default ${defaults.maxConcurrency}.` : undefined}
          >
            {(f) => (
              <Input
                {...f}
                type="number"
                inputMode="numeric"
                value={concValue}
                onChange={(e) => setConc(e.target.value)}
                disabled={actions.update.isPending}
              />
            )}
          </FormField>
        </CardBody>
      </Card>
      <SaveBar
        dirty={dirty}
        saving={actions.update.isPending}
        onSave={() => void save()}
        onDiscard={reset}
      />
      <UnsavedChangesDialog blocker={guard} />
    </div>
  );
}
