import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { RefObject } from 'react';
import type { z } from 'zod';
import {
  ConnectionSchema,
  type CreateConnectionSchema,
  SyncNowResponseSchema,
} from '@/shared/contracts/connections.ts';
import { api } from '../../lib/api.ts';
import { toast } from '../../ui/index.ts';
import type { Mapping } from '../mapping/mapping.ts';
import { cleanValues } from '../passes/schema-form/index.ts';
import { connectionKeys } from './api.ts';
import { nestValues } from './config-schema.ts';
import { markApplyStarted } from './files/use-apply-watch.ts';
import { type Lifecycle, lifecycleToPatch } from './lifecycle-fields.tsx';
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
  fileId,
  onCreated,
}: {
  currentScope: RefObject<WizardScope>;
  life: Lifecycle;
  type: string | undefined;
  draft: ConfigDraft;
  shownSecrets: Record<string, string>;
  mapping: Mapping;
  /** File upload: the draft that becomes the first revision. */
  fileId?: string | undefined;
  onCreated: (created: CreatedConnection) => void;
}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ orgId, scope }: { orgId: string; scope: WizardScope }) => {
      const wantsWebhook = life.mode === 'webhook' || life.mode === 'hybrid';
      const pasted = draft.signingSecret?.trim();
      const webhookSecret = wantsWebhook ? pasted || generateSecret() : undefined;
      const body: CreateBody = {
        orgId,
        connectorType: type as string,
        name: draft.name.trim(),
        config: nestValues(cleanValues(draft.config)) as CreateBody['config'],
        ...(Object.keys(shownSecrets).length ? { secrets: shownSecrets } : {}),
        ...(Object.keys(mapping).length > 0 ? { mapping } : {}),
        ...lifecycleToPatch(life),
        ...(webhookSecret ? { webhookSecret } : {}),
        ...(fileId ? { fileId } : {}),
      };
      const connection = await api.post('/api/v1/connections', ConnectionSchema, body);
      let applyError: unknown;
      if (fileId) {
        // Review and Create confirmed the first file: apply it now. If the run cannot start, the new
        // page says Not applied yet and offers Sync now.
        try {
          await api.post(`/api/v1/connections/${connection.id}/sync`, SyncNowResponseSchema);
          markApplyStarted(connection.id);
        } catch (error) {
          applyError = error;
        }
      }
      return { connection, webhookSecret: pasted ? undefined : webhookSecret, scope, applyError };
    },
    onSuccess: async ({ connection, webhookSecret, scope, applyError }) => {
      if (applyError) toast.error(applyError, 'The first file did not start applying');
      await qc.invalidateQueries({ queryKey: connectionKeys.all });
      void qc.invalidateQueries({ queryKey: ['palette'] });
      if (currentScope.current === scope) {
        onCreated({ id: connection.id, url: connection.webhookUrl, secret: webhookSecret, scope });
      }
    },
  });
}
