import { useQuery } from '@tanstack/react-query';
import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from 'react';
import { PassListSchema } from '@/shared/contracts/passes.ts';
import { strictEmail } from '@/shared/email.ts';
import { api } from '../../lib/api.ts';
import { useUnsavedChangesGuard } from '../../ui/index.ts';
import { passKeys } from './api.ts';
import type { NewPassDraft, NewPassRelease, NewPassScope, StepId } from './new-pass-types.ts';
import {
  cleanValues,
  defaultValues,
  type FormValues,
  pickDeclared,
  validateValues,
} from './schema-form/index.ts';

export const EMPTY_SAMPLE: FormValues = {};

/** Draft state, scope synchronization, defaults, and review authorization. */
export function useNewPassDraft({
  principalId,
  sessionReady,
  linkTemplate,
  templateId,
  setTemplateId,
  stepChoice,
  setStep,
  setPendingTemplateCommit,
  ids,
  access,
  releaseData,
}: {
  principalId: string | undefined;
  sessionReady: boolean;
  linkTemplate: string | undefined;
  templateId: string | undefined;
  setTemplateId: Dispatch<SetStateAction<string | undefined>>;
  stepChoice: number | undefined;
  setStep: Dispatch<SetStateAction<number | undefined>>;
  setPendingTemplateCommit: Dispatch<SetStateAction<string | undefined>>;
  ids: StepId[];
  access: NewPassScope;
  releaseData: NewPassRelease;
}): NewPassDraft {
  const {
    mode,
    scope,
    grantsReady,
    operable,
    selectedOrg,
    setSelectedOrg,
    pendingChoice,
    setPendingChoice,
    orgId,
    canReadPasses,
    canReadTemplates,
  } = access;
  const { eligible, selectedTemplate, release, version, releasedVersion, schema } = releaseData;
  const [input, setInput] = useState<FormValues>({});
  const [email, setEmail] = useState('');
  const [send, setSend] = useState(false);
  const autoChecked = useRef(false);
  const validEmail = strictEmail(email) !== null;
  const inputErrors = schema ? validateValues(schema, input) : {};
  // Defaults belong to a specific released version, not the template's current draft.
  const seeded = useRef<string | undefined>(undefined);
  const seedKey =
    principalId && orgId && templateId && version
      ? JSON.stringify([principalId, orgId, templateId, version])
      : undefined;
  // Deep links advance only after the chosen template's active release is known.
  const step =
    stepChoice ??
    (orgId ? (linkTemplate && selectedTemplate?.id === linkTemplate && release ? 2 : 1) : 0);
  const at = ids[Math.min(step, ids.length - 1)] ?? 'org';
  useEffect(() => {
    if (stepChoice === undefined && orgId && linkTemplate && selectedTemplate?.id === linkTemplate)
      setStep(2);
  }, [stepChoice, orgId, linkTemplate, selectedTemplate, setStep]);
  const firstPass = useQuery({
    queryKey: [...passKeys.all, 'first-of-org', orgId ?? null, mode, principalId ?? null],
    queryFn: ({ signal }) => {
      if (!orgId || !canReadPasses) throw new Error('Choose an authorized organization.');
      return api.get('/api/v1/passes', PassListSchema, {
        query: { orgId, limit: 1 },
        signal,
      });
    },
    enabled: Boolean(orgId) && canReadPasses,
    staleTime: 0,
  });
  const [reviewed, setReviewed] = useState<{
    principalId: string;
    orgId: string;
    mode: typeof mode;
    templateId: string;
    version: string;
    releaseId: string;
    releaseGeneration: number;
    candidateHash: string;
  }>();
  const [conflict, setConflict] = useState(false);
  const releaseReady =
    Boolean(
      orgId &&
        selectedTemplate &&
        templateId &&
        version?.trim() &&
        release &&
        schema &&
        seedKey &&
        seeded.current === seedKey,
    ) &&
    (!eligible.isError || eligible.isFetchNextPageError) &&
    (!eligible.isFetching || eligible.isFetchingNextPage) &&
    !releasedVersion.isError &&
    !releasedVersion.isFetching;
  const readyToCreate =
    sessionReady &&
    grantsReady &&
    releaseReady &&
    Object.keys(inputErrors).length === 0 &&
    (!email.trim() || validEmail) &&
    !conflict &&
    reviewed?.principalId === principalId &&
    reviewed?.orgId === orgId &&
    reviewed?.mode === mode &&
    reviewed?.templateId === templateId &&
    reviewed?.version === version &&
    reviewed?.releaseId === release?.releaseId &&
    reviewed?.releaseGeneration === release?.releaseGeneration &&
    reviewed?.candidateHash === release?.candidateHash;
  useEffect(() => {
    // A missing release while access or the eligible list is being revalidated is not a
    // confirmed change. Keep the review until the fresh result can be compared.
    if (scope.isLoading || !sessionReady || (eligible.isFetching && !eligible.isFetchingNextPage))
      return;
    if (
      at === 'review' &&
      reviewed &&
      (reviewed.principalId !== principalId ||
        reviewed.orgId !== orgId ||
        reviewed.mode !== mode ||
        reviewed.templateId !== templateId ||
        reviewed.version !== version ||
        reviewed.releaseId !== release?.releaseId ||
        reviewed.releaseGeneration !== release?.releaseGeneration ||
        reviewed.candidateHash !== release?.candidateHash)
    ) {
      setReviewed(undefined);
    }
  }, [
    at,
    reviewed,
    scope.isLoading,
    sessionReady,
    eligible.isFetching,
    eligible.isFetchingNextPage,
    principalId,
    orgId,
    mode,
    templateId,
    version,
    release?.releaseId,
    release?.releaseGeneration,
    release?.candidateHash,
  ]);
  const [created, setCreated] = useState<{ id: string; orgId: string; principalId: string }>();
  const createdId = created?.id;

  const initialScope = useRef(true);
  const previousScope = useRef(scope.orgId);
  useEffect(() => {
    if (scope.isLoading) return;
    if (initialScope.current) {
      initialScope.current = false;
      previousScope.current = scope.orgId;
      if (pendingChoice === undefined) setSelectedOrg(scope.orgId);
      else if (pendingChoice === scope.orgId) setPendingChoice(undefined);
      return;
    }
    if (previousScope.current === scope.orgId) return;
    previousScope.current = scope.orgId;
    setSelectedOrg(scope.orgId);
    if (pendingChoice !== undefined && pendingChoice === scope.orgId) {
      setPendingChoice(undefined);
      return;
    }
    setPendingChoice(undefined);
    setPendingTemplateCommit(undefined);
    setTemplateId(undefined);
    setInput({});
    setEmail('');
    setSend(false);
    autoChecked.current = false;
    seeded.current = undefined;
    setReviewed(undefined);
    setConflict(false);
    setStep(scope.orgId && !scope.isError && operable.has(scope.orgId) ? 1 : 0);
  }, [
    scope.orgId,
    scope.isLoading,
    scope.isError,
    operable,
    pendingChoice,
    setSelectedOrg,
    setPendingChoice,
    setPendingTemplateCommit,
    setTemplateId,
    setStep,
  ]);
  const previousTemplateGrant = useRef<{ orgId: string; allowed: boolean } | undefined>(undefined);
  useEffect(() => {
    if (scope.isLoading || scope.isError || !orgId) return;
    const previous = previousTemplateGrant.current;
    previousTemplateGrant.current = { orgId, allowed: canReadTemplates };
    if (previous?.orgId !== orgId || !previous.allowed || canReadTemplates) return;
    // A confirmed loss of template access must not leave the old draft recoverable.
    setInput({});
    setEmail('');
    setSend(false);
    autoChecked.current = false;
    seeded.current = undefined;
    setReviewed(undefined);
    setConflict(false);
  }, [scope.isLoading, scope.isError, orgId, canReadTemplates]);
  useEffect(() => {
    if (!seedKey || !schema || seeded.current === seedKey) return;
    seeded.current = seedKey;
    setInput((current) => ({ ...defaultValues(schema), ...pickDeclared(schema, current) }));
  }, [seedKey, schema]);

  // The box checks itself the first time the address becomes valid; unchecking sticks.
  useEffect(() => {
    if (validEmail && !autoChecked.current) {
      autoChecked.current = true;
      setSend(true);
    }
  }, [validEmail]);

  const dirty = !createdId && (Object.keys(cleanValues(input)).length > 0 || email !== '');
  // A wizard choice changes only this page's search parameter; it must not be blocked as a
  // navigation away from the draft. The guard resumes once the validated scope catches up.
  const guard = useUnsavedChangesGuard(dirty && pendingChoice === undefined);
  useEffect(() => {
    if (pendingChoice === undefined || scope.isLoading) return;
    if (scope.isError || !operable.has(pendingChoice)) {
      setPendingChoice(undefined);
      setSelectedOrg(scope.orgId);
      return;
    }
    if (pendingChoice !== scope.orgId) scope.setOrgId(pendingChoice);
  }, [
    pendingChoice,
    scope.orgId,
    scope.isLoading,
    scope.isError,
    scope.setOrgId,
    operable,
    setPendingChoice,
    setSelectedOrg,
  ]);
  const firstOfOrg =
    canReadPasses &&
    firstPass.isSuccess &&
    !firstPass.isFetching &&
    firstPass.data.items.length === 0 &&
    firstPass.data.nextCursor === null;
  const chooseOrg = (id: string) => {
    if (!operable.has(id)) return;
    if (id !== selectedOrg) {
      setPendingTemplateCommit(undefined);
      setTemplateId(undefined);
      seeded.current = undefined;
      setInput({});
      setEmail('');
      setSend(false);
      autoChecked.current = false;
      setConflict(false);
      setReviewed(undefined);
    }
    // Keep the picker visible after a radio click; Enter/double-click may still commit it.
    setStep(step);
    setSelectedOrg(id);
    setPendingChoice(id !== scope.orgId ? id : undefined);
  };
  const chooseTemplate = (id: string) => {
    if (id !== templateId) {
      setPendingTemplateCommit(undefined);
      seeded.current = undefined;
      setInput({});
    }
    setTemplateId(id);
  };
  return {
    input,
    setInput,
    email,
    setEmail,
    send,
    setSend,
    validEmail,
    inputErrors,
    step,
    at,
    setReviewed,
    setConflict,
    releaseReady,
    readyToCreate,
    created,
    setCreated,
    createdId,
    guard,
    firstOfOrg,
    chooseOrg,
    chooseTemplate,
  };
}
