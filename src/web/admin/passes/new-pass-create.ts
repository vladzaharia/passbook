import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { PassDetailSchema } from '@/shared/contracts/passes.ts';
import { api } from '../../lib/api.ts';
import { markMinted } from '../../lib/motion.ts';
import { passKeys } from './api.ts';
import { markCreated } from './created.tsx';
import { fingerprint, newKey } from './format.ts';
import type { FormValues } from './schema-form/index.ts';

interface NewPassPayload {
  orgId: string | undefined;
  templateId: string | undefined;
  input: FormValues;
  holderEmail?: string;
  sendEmail: boolean;
}

/**
 * Creates the pass. The same payload on retry reuses its idempotency key, so a double submit
 * cannot create two. On success the pass's page gets its card (so the preview morphs into it) and
 * the created mark; `firstOfOrg` makes that page celebrate.
 */
export function useCreatePass(
  payload: NewPassPayload,
  firstOfOrg: boolean,
  onCreated: (id: string) => void,
) {
  const qc = useQueryClient();
  const keyRef = useRef<{ fp: string; key: string }>({ fp: '', key: '' });
  return useMutation({
    mutationFn: () => {
      const fp = fingerprint(payload);
      if (keyRef.current.fp !== fp) keyRef.current = { fp, key: newKey() };
      return api.post('/api/v1/passes', PassDetailSchema, payload, {
        headers: { 'idempotency-key': keyRef.current.key },
      });
    },
    onSuccess: async (pass) => {
      await qc.invalidateQueries({ queryKey: passKeys.all });
      qc.setQueryData(passKeys.detail(pass.id), pass);
      markMinted(pass.id);
      markCreated(`pass:${pass.id}`, { sent: payload.sendEmail, first: firstOfOrg });
      onCreated(pass.id);
    },
  });
}
