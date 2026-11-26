import { useMemo, useRef, useState } from 'react';
import { useNewPassCreation } from './new-pass-creation.ts';
import { useNewPassScope } from './new-pass-data.ts';
import { EMPTY_SAMPLE, useNewPassDraft } from './new-pass-draft.ts';
import { useNewPassNav } from './new-pass-nav.ts';
import { useLivePreview } from './new-pass-preview.tsx';
import { useNewPassRelease } from './new-pass-release.ts';
import type { NewPassWizardModel } from './new-pass-types.ts';
import { type FormValues, keysBoundTo, pickDeclared } from './schema-form/index.ts';
import { displayName } from './template-groups.ts';

const INPUT = 'input.';

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
  const [pendingTemplateCommit, setPendingTemplateCommit] = useState<string | undefined>();
  const navReset = useRef<() => void>(() => undefined);
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
    templateId,
    setTemplateId,
    setPendingTemplateCommit,
    navReset,
    access,
    releaseData,
  });
  const { input } = draft;
  const creation = useNewPassCreation({
    principalId,
    sessionReady,
    templateId,
    access,
    releaseData,
    draft,
  });
  const { payload } = creation;
  const { wizard, notReady, settling } = useNewPassNav({
    principalId,
    sessionReady,
    linkTemplate,
    access,
    releaseData,
    draft,
    creation,
    setPendingTemplateCommit,
    pendingTemplateCommit,
    templateId,
    navReset,
    orgFixed: Boolean(access.displayOrgId) && !draft.orgChosen,
  });
  const errors = wizard.errors;
  // The details fields come back from the server as `input.<key>`; the form reads the bare key.
  const fieldErrors = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [path, message] of Object.entries(errors))
      if (message && path.startsWith(INPUT)) out[path.slice(INPUT.length)] = message;
    return Object.keys(out).length > 0 ? out : undefined;
  }, [errors]);
  const hiddenKeys = useMemo(() => keysBoundTo(manifest, '/voided'), [manifest]);
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
  return {
    principalId,
    sessionReady,
    templateId,
    setPendingTemplateCommit,
    wizard,
    access,
    releaseData,
    draft,
    creation,
    errors,
    fieldErrors,
    emailError: errors.holderEmail,
    hiddenKeys,
    finishLabel: payload.sendEmail ? 'Create and send' : 'Create pass',
    notReady,
    settling,
    live,
    name: selectedTemplate ? displayName(selectedTemplate) : undefined,
  };
}
