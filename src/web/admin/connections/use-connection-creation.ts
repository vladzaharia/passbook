import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { RefObject } from 'react';
import type { z } from 'zod';
import { ConnectionSchema, type CreateConnectionSchema } from '@/shared/contracts/connections.ts';
import { api } from '../../lib/api.ts';
import { cleanValues } from '../passes/schema-form/index.ts';
import { connectionKeys } from './api.ts';
import { nestValues } from './config-schema.ts';
import { type Lifecycle, lifecycleToPatch } from './lifecycle-fields.tsx';
import type { Mapping } from './mapping.ts';
import { generateSecret } from './webhook.tsx';
import type { ConfigDraft } from './wizard-steps.tsx';

type CreateBody = z.input<typeof CreateConnectionSchema>;
type WizardScope = { orgId: string | undefined; userId: string | undefined };
type CreatedConnection = {
  id: string;
  url: string | null;
  secret?: string;
  scope: WizardScope;
};

export function useConnectionCreation({
  currentScope,
  life,
  type,
  draft,
  shownSecrets,
  mapping,
  onCreated,
}: {
  currentScope: RefObject<WizardScope>;
  life: Lifecycle;
  type: string | undefined;
  draft: ConfigDraft;
  shownSecrets: Record<string, string>;
  mapping: Mapping;
  onCreated: (created: CreatedConnection) => void;
}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ orgId, scope }: { orgId: string; scope: WizardScope }) => {
      const wantsWebhook = life.mode === 'webhook' || life.mode === 'hybrid';
      const webhookSecret = wantsWebhook ? generateSecret() : undefined;
      const body: CreateBody = {
        orgId,
        connectorType: type as string,
        name: draft.name.trim(),
        config: nestValues(cleanValues(draft.config)) as CreateBody['config'],
        ...(Object.keys(shownSecrets).length ? { secrets: shownSecrets } : {}),
        ...(Object.keys(mapping).length > 0 ? { mapping } : {}),
        ...lifecycleToPatch(life),
        ...(webhookSecret ? { webhookSecret } : {}),
      };
      const connection = await api.post('/api/v1/connections', ConnectionSchema, body);
      return { connection, webhookSecret, scope };
    },
    onSuccess: async ({ connection, webhookSecret, scope }) => {
      await qc.invalidateQueries({ queryKey: connectionKeys.all });
      void qc.invalidateQueries({ queryKey: ['palette'] });
      if (currentScope.current === scope) {
        onCreated({ id: connection.id, url: connection.webhookUrl, secret: webhookSecret, scope });
      }
    },
  });
}
