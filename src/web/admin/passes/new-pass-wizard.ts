import { useEffect, useMemo, useState } from 'react';
import { EMAIL_INVALID_MESSAGE } from '@/shared/email.ts';
import { useFormErrors } from '../../ui/index.ts';
import { useNewPassCreation } from './new-pass-creation.ts';
import { useNewPassScope } from './new-pass-data.ts';
import { EMPTY_SAMPLE, useNewPassDraft } from './new-pass-draft.ts';
import { useLivePreview } from './new-pass-preview.tsx';
import { useNewPassRelease } from './new-pass-release.ts';
import type { NewPassWizardModel, StepId } from './new-pass-types.ts';
import { type FormValues, keysBoundTo, pickDeclared } from './schema-form/index.ts';
import { displayName } from './template-groups.ts';

const TITLES: Record<StepId, string> = {
  org: 'Organization',
  template: 'Template',
  details: 'Details',
  holder: 'Holder',
  review: 'Review',
};

export function useNewPassWizard({
  linkTemplate,
  principalId,
  sessionReady,
}: {
  linkTemplate: string | undefined;
  principalId: string | undefined;
  sessionReady: boolean;
}): NewPassWizardModel {
  const access = useNewPassScope(principalId);
  const { mode, orgId, canReadTemplates, displayOrgId, displayCanReadTemplates } = access;
  const [templateId, setTemplateId] = useState<string | undefined>(linkTemplate);
  const [stepChoice, setStep] = useState<number | undefined>();
  const [pendingTemplateCommit, setPendingTemplateCommit] = useState<string | undefined>();
  const ids = useMemo<StepId[]>(() => ['org', 'template', 'details', 'holder', 'review'], []);
  const steps = ids.map((id) => ({ id, title: TITLES[id] }));
  const releaseData = useNewPassRelease({
    principalId,
    orgId,
    canReadTemplates,
    displayOrgId,
    displayCanReadTemplates,
    mode,
    linkTemplate,
    templateId,
    orgName: access.displayOrgName,
  });
  const { selectedTemplate, release, version, manifest, schema } = releaseData;
  const draft = useNewPassDraft({
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
  });
  const {
    input,
    email,
    validEmail,
    inputErrors,
    step,
    at,
    setReviewed,
    setConflict,
    releaseReady,
    readyToCreate,
    firstOfOrg,
  } = draft;
  const creation = useNewPassCreation({
    principalId,
    sessionReady,
    templateId,
    access,
    releaseData,
    draft,
  });
  const { payload, create, fieldErrors } = creation;
  // Each step's errors show once Next is refused, then clear as they are fixed.
  const check = useFormErrors<Partial<Record<string, string>>>(
    at === 'org'
      ? { org: orgId ? undefined : 'Choose an organization.' }
      : at === 'template'
        ? { template: selectedTemplate ? undefined : 'Choose a template.' }
        : at === 'details'
          ? inputErrors
          : at === 'holder'
            ? { holderEmail: email.trim() && !validEmail ? EMAIL_INVALID_MESSAGE : undefined }
            : {},
  );
  const emailError = check.errors.holderEmail ?? fieldErrors?.holderEmail;
  const hiddenKeys = useMemo(() => keysBoundTo(manifest, '/voided'), [manifest]);

  const go = (to: number) => {
    setPendingTemplateCommit(undefined);
    check.reset();
    if (ids[to] === 'review' && Object.keys(inputErrors).length > 0) {
      setStep(ids.indexOf('details'));
      return;
    }
    if (ids[to] === 'review' && at !== 'review') {
      setReviewed(
        principalId &&
          orgId &&
          selectedTemplate &&
          templateId &&
          version?.trim() &&
          release &&
          schema &&
          releaseReady
          ? {
              principalId,
              orgId,
              mode,
              templateId,
              version,
              releaseId: release.releaseId,
              releaseGeneration: release.releaseGeneration,
              candidateHash: release.candidateHash,
            }
          : undefined,
      );
      setConflict(false);
      create.reset();
    }
    setStep(Math.max(0, Math.min(ids.length - 1, to)));
  };
  useEffect(() => {
    if (
      !pendingTemplateCommit ||
      at !== 'template' ||
      pendingTemplateCommit !== templateId ||
      !release
    )
      return;
    check.reset();
    setPendingTemplateCommit(undefined);
    setStep(ids.indexOf('details'));
  }, [pendingTemplateCommit, at, templateId, release, check.reset, ids]);
  const index = (id: StepId) => ids.indexOf(id);
  /** Next with the step complete; a refused Next stays and Form focuses the first error. */
  function advance() {
    if (at === 'review') {
      const {
        orgId: submittedOrgId,
        templateId: submittedTemplateId,
        templateVersion,
        releaseId,
        releaseGeneration,
      } = payload;
      if (
        readyToCreate &&
        principalId &&
        submittedOrgId &&
        submittedTemplateId &&
        templateVersion?.trim() &&
        releaseId &&
        releaseGeneration !== undefined
      ) {
        create.mutate({
          payload: {
            ...payload,
            orgId: submittedOrgId,
            templateId: submittedTemplateId,
            templateVersion,
            releaseId,
            releaseGeneration,
          },
          firstOfOrg,
          principalId,
        });
      }
    } else go(step + 1);
  }
  const sampleValue = manifest?.sample;
  const sample =
    sampleValue && typeof sampleValue === 'object' && !Array.isArray(sampleValue)
      ? (sampleValue as FormValues)
      : EMPTY_SAMPLE;
  const previewInput = useMemo(
    () => (schema ? pickDeclared(schema, input) : EMPTY_SAMPLE),
    [schema, input],
  );
  const live = useLivePreview({
    templateId: orgId && selectedTemplate && release && schema ? templateId : undefined,
    orgId,
    principalId,
    mode,
    version,
    schema,
    sample,
    input: previewInput,
  });
  const name = selectedTemplate ? displayName(selectedTemplate) : undefined;
  return {
    principalId,
    sessionReady,
    templateId,
    setPendingTemplateCommit,
    steps,
    access,
    releaseData,
    draft,
    creation,
    check,
    emailError,
    hiddenKeys,
    go,
    index,
    advance,
    live,
    name,
  };
}
