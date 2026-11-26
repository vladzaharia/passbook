import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useWizard, WizardDialog } from '@/web/ui/index.ts';
import { useOrgList } from '../../orgs/queries.ts';
import { markCreated } from '../../passes/created.tsx';
import { useUploadIdentity } from './queries.ts';
import {
  buildUploadBody,
  draftDirty,
  EMPTY_DRAFT as EMPTY,
  type UploadDraft,
  validateUpload,
} from './upload-input.ts';
import {
  CertificateStep,
  FIELD_STEP,
  HINTS,
  IdentityStep,
  PLATFORM,
  STEPS,
  UploadReview,
} from './upload-steps.tsx';

/** Uploads and opens the new identity, whose page says what to do next. */
export function UploadIdentityDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const orgs = useOrgList();
  const upload = useUploadIdentity();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<UploadDraft>(EMPTY);
  const [org, setOrg] = useState(PLATFORM);
  const [nfc, setNfc] = useState(false);
  const found = validateUpload(draft);
  const { label, ...certificate } = found;
  const owners = [
    { value: PLATFORM, label: 'Platform' },
    ...(orgs.data?.items ?? []).map((o) => ({ value: o.id, label: o.name })),
  ];
  const ownerLabel = owners.find((o) => o.value === org)?.label ?? org;

  const w = useWizard({
    open,
    steps: STEPS.map((s) => ({
      ...s,
      summary:
        s.id === 'identity' && draft.label.trim()
          ? draft.label.trim()
          : s.id === 'certificate' && !Object.keys(certificate).length
            ? draft.mode === 'p12'
              ? (draft.p12?.name ?? '')
              : 'PEM'
            : undefined,
    })),
    errors: {
      identity: label ? { label } : undefined,
      certificate: Object.keys(certificate).length ? certificate : undefined,
    },
    hints: HINTS,
    fieldStep: FIELD_STEP,
    onFinish: async () => {
      const created = await upload.mutateAsync(
        await buildUploadBody(draft, org === PLATFORM ? null : org, nfc),
      );
      onOpenChange(false);
      markCreated(`identity:${created.id}`);
      void navigate({
        to: '/admin/platform/wallet-accounts/$identityId',
        params: { identityId: created.id },
      });
    },
  });
  const patch = (p: Partial<UploadDraft>) => {
    setDraft((d) => ({ ...d, ...p }));
    w.clearServer();
  };

  return (
    <WizardDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Upload Apple identity"
      wizard={w}
      dirty={draftDirty(draft) || org !== PLATFORM || nfc}
      finishLabel="Upload identity"
      busy={upload.isPending}
      onClose={() => {
        setDraft(EMPTY);
        setOrg(PLATFORM);
        setNfc(false);
      }}
    >
      {w.id === 'identity' ? (
        <IdentityStep
          draft={draft}
          owners={owners}
          org={org}
          nfc={nfc}
          errors={w.errors}
          onLabel={(v) => patch({ label: v })}
          onOrg={(v) => {
            setOrg(v);
            w.clearServer('orgId');
          }}
          onNfc={setNfc}
        />
      ) : null}
      {w.id === 'certificate' ? (
        <CertificateStep draft={draft} errors={w.errors} patch={patch} />
      ) : null}
      {w.id === 'review' ? (
        <UploadReview draft={draft} ownerLabel={ownerLabel} nfc={nfc} onEdit={w.go} />
      ) : null}
    </WizardDialog>
  );
}
