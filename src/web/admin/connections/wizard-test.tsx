import { useMutation } from '@tanstack/react-query';
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import type { z } from 'zod';
import { TestConfigResponseSchema } from '@/shared/contracts/connection-preview.ts';
import type { ConnectorInfoSchema } from '@/shared/contracts/connections.ts';
import { ACTION_ICON } from '../../lib/action-icons.ts';
import { api } from '../../lib/api.ts';
import { Button } from '../../ui/index.ts';
import { cleanValues, type FormValues } from '../passes/schema-form/index.ts';
import { flattenSchema, nestValues, WIZARD_HIDDEN } from './config-schema.ts';
import { secretSchema } from './secret-schema.ts';
import { type TestOutcome, TestResult } from './test-result.tsx';

type Connector = z.infer<typeof ConnectorInfoSchema>;

/** The wizard's Test: the same call on Configuration and Mapping, so a sample can be loaded on either. */
export function WizardTest({
  connector,
  orgId,
  config,
  secrets,
  test,
  onTest,
  autoKey,
}: {
  connector: Connector;
  orgId: string;
  config: FormValues;
  secrets: FormValues;
  test: TestOutcome | undefined;
  onTest: (outcome: TestOutcome) => void;
  /** Runs Test whenever this changes after the first render (a free, local test). */
  autoKey?: string | undefined;
}) {
  const authType = String(config['auth.type'] ?? 'none');
  const secretsFlat = useMemo(
    () => (connector.secretSchema ? secretSchema(connector.secretSchema) : null),
    [connector.secretSchema],
  );
  const hiddenSecrets = useMemo(
    () => WIZARD_HIDDEN(flattenSchema(secretsFlat), authType),
    [secretsFlat, authType],
  );
  const run = useMutation({
    mutationFn: () =>
      api.post('/api/v1/connections/test-config', TestConfigResponseSchema, {
        orgId,
        connectorType: connector.type,
        config: nestValues(cleanValues(config)),
        secrets: Object.fromEntries(
          Object.entries(cleanValues(secrets))
            .filter(([k]) => !hiddenSecrets.has(k))
            .map(([k, v]) => [k, String(v)]),
        ),
      }),
  });
  // Only the newest run reports: a slow answer to an earlier config must not replace a later one.
  const latest = useRef(0);
  const start = () => {
    const mine = ++latest.current;
    const report = (outcome: TestOutcome) => {
      if (mine === latest.current) onTest(outcome);
    };
    return run.mutateAsync().then(
      (r) => report({ kind: 'result', result: r, at: Date.now() }),
      (error: unknown) => report({ kind: 'error', error, at: Date.now() }),
    );
  };
  const go = useRef(start);
  go.current = start;
  const seen = useRef(autoKey);
  useEffect(() => {
    if (autoKey === undefined || seen.current === autoKey) return;
    seen.current = autoKey;
    void go.current();
  }, [autoKey]);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        variant="outline"
        iconStart={<ACTION_ICON.test aria-hidden />}
        busy="pulse"
        loading={run.isPending}
        onClick={() => void start()}
      >
        Test
      </Button>
      <TestResult outcome={test} />
    </div>
  );
}

/**
 * The last test, kept only while what it tested is still what the wizard holds: the same
 * organization, principal, connector and untouched config and secrets.
 */
export function useTestOutcome<S>({
  orgId,
  scope,
  current,
  type,
  draft,
}: {
  orgId: string | undefined;
  scope: S;
  current: RefObject<S>;
  type: string | undefined;
  draft: { config: FormValues; secrets: FormValues };
}): [TestOutcome | undefined, (outcome: TestOutcome) => void] {
  const [tested, setTested] = useState<{
    outcome: TestOutcome;
    orgId: string;
    scope: S;
    type: string;
    config: FormValues;
    secrets: FormValues;
  }>();
  const test =
    tested !== undefined &&
    tested.orgId === orgId &&
    tested.scope === scope &&
    tested.type === type &&
    tested.config === draft.config &&
    tested.secrets === draft.secrets
      ? tested.outcome
      : undefined;
  const onTested = (outcome: TestOutcome) => {
    if (current.current !== scope || !orgId || !type) return;
    setTested({ outcome, orgId, scope, type, config: draft.config, secrets: draft.secrets });
  };
  return [test, onTested];
}
