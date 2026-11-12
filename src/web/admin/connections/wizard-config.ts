import { useMemo } from 'react';
import type { z } from 'zod';
import type { ConnectorInfoSchema } from '@/shared/contracts/connections.ts';
import { cleanValues, validateValues } from '../passes/schema-form/index.ts';
import { flattenSchema, WIZARD_HIDDEN } from './config-schema.ts';
import type { ConfigDraft } from './wizard-steps.tsx';

type Connector = z.infer<typeof ConnectorInfoSchema>;

export function useWizardConfig(info: Connector | undefined, draft: ConfigDraft) {
  const flat = useMemo(() => flattenSchema(info?.configSchema), [info]);
  const authType = String(draft.config['auth.type'] ?? 'none');
  const shownSecrets = useMemo(() => {
    const hidden = WIZARD_HIDDEN(flattenSchema(info?.secretSchema), authType);
    return Object.fromEntries(
      Object.entries(cleanValues(draft.secrets))
        .filter(([k]) => !hidden.has(k))
        .map(([k, v]) => [k, String(v)]),
    );
  }, [info, draft.secrets, authType]);
  const cfgErrors = flat ? validateValues(flat, draft.config) : {};
  const secErrors = useMemo(() => {
    const schema = info?.secretSchema;
    if (!schema) return {};
    const hidden = WIZARD_HIDDEN(flattenSchema(schema), authType);
    return Object.fromEntries(
      Object.entries(validateValues(schema, draft.secrets)).filter(([k]) => !hidden.has(k)),
    );
  }, [info, draft.secrets, authType]);
  return { cfgErrors, secErrors, shownSecrets };
}
