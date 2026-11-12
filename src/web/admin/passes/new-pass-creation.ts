import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { isApiError } from '../../lib/errors.ts';
import { type NewPassPayload, useCreatePass } from './new-pass-create.ts';
import { EMPTY_SAMPLE } from './new-pass-draft.ts';
import type {
  NewPassCreation,
  NewPassDraft,
  NewPassRelease,
  NewPassScope,
} from './new-pass-types.ts';
import { cleanValues, pickDeclared } from './schema-form/index.ts';

/** Bind creation and conflict handling to the currently reviewed draft. */
export function useNewPassCreation({
  principalId,
  sessionReady,
  templateId,
  access,
  releaseData,
  draft,
}: {
  principalId: string | undefined;
  sessionReady: boolean;
  templateId: string | undefined;
  access: NewPassScope;
  releaseData: NewPassRelease;
  draft: NewPassDraft;
}): NewPassCreation {
  const navigate = useNavigate();
  const { orgId, mode, grantsReady, canReadTemplates, scope } = access;
  const { eligible, selectedTemplate, release, version, schema } = releaseData;
  const { input, email, send, validEmail, created, setCreated, setConflict } = draft;
  const canReadCreatedPass = Boolean(
    created &&
      scope.memberships.some(
        (membership) =>
          membership.userId === created.principalId &&
          membership.orgId === created.orgId &&
          membership.revokedAt === null &&
          membership.capabilities.includes('passes:read'),
      ),
  );
  const payload = useMemo(
    () => ({
      orgId,
      templateId,
      mode,
      templateVersion: version,
      releaseId: release?.releaseId,
      releaseGeneration: release?.releaseGeneration,
      input: cleanValues(schema ? pickDeclared(schema, input) : EMPTY_SAMPLE),
      ...(email.trim() ? { holderEmail: email.trim() } : {}),
      sendEmail: send && validEmail,
    }),
    [
      orgId,
      templateId,
      mode,
      version,
      release?.releaseId,
      release?.releaseGeneration,
      schema,
      input,
      email,
      send,
      validEmail,
    ],
  );
  const [pendingConflict, setPendingConflict] = useState<
    { payload: NewPassPayload; principalId: string } | undefined
  >(undefined);
  const create = useCreatePass(
    (id, createdOrgId, createdPrincipalId) =>
      setCreated({ id, orgId: createdOrgId, principalId: createdPrincipalId }),
    (submitted, submittedPrincipalId) =>
      setPendingConflict({ payload: submitted, principalId: submittedPrincipalId }),
  );
  useEffect(() => {
    if (!pendingConflict || !sessionReady || !grantsReady) return;
    const { payload: submitted, principalId: submittedPrincipalId } = pendingConflict;
    if (
      submittedPrincipalId !== principalId ||
      submitted.orgId !== orgId ||
      submitted.templateId !== templateId ||
      submitted.mode !== mode ||
      !canReadTemplates
    ) {
      setPendingConflict(undefined);
      return;
    }
    if (eligible.isPending || (eligible.isFetching && !eligible.isFetchingNextPage)) return;
    setPendingConflict(undefined);
    if (
      submitted.templateId !== selectedTemplate?.id ||
      submitted.templateVersion !== version ||
      submitted.releaseId !== release?.releaseId ||
      submitted.releaseGeneration !== release?.releaseGeneration
    )
      return;
    setConflict(true);
    void eligible.refetch();
  }, [
    pendingConflict,
    sessionReady,
    grantsReady,
    principalId,
    orgId,
    templateId,
    mode,
    canReadTemplates,
    eligible.isPending,
    eligible.isFetching,
    eligible.isFetchingNextPage,
    eligible.refetch,
    selectedTemplate,
    version,
    release,
    setConflict,
  ]);
  // The pass's page replaces the wizard in history; it leads with "Pass created".
  useEffect(() => {
    if (
      created &&
      sessionReady &&
      grantsReady &&
      principalId === created.principalId &&
      canReadCreatedPass
    )
      void navigate({
        to: '/admin/passes/$passId',
        params: { passId: created.id },
        search: { orgId: created.orgId },
        replace: true,
      });
  }, [created, principalId, sessionReady, grantsReady, canReadCreatedPass, navigate]);

  const fieldErrors = useMemo(() => {
    if (!isApiError(create.error)) return undefined;
    const out: Record<string, string> = {};
    for (const [path, msg] of Object.entries(create.error.fields))
      out[path.startsWith('input.') ? path.slice(6) : path] = msg;
    return out;
  }, [create.error]);
  return { payload, create, fieldErrors, onCancel: () => void navigate({ to: '/admin/passes' }) };
}
