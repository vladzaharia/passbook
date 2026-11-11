import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { MemberPhotoSchema } from '@/shared/contracts/check-in.ts';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import { api } from '../../../lib/api.ts';
import { errorMessage } from '../../../lib/errors.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CheckboxField,
  ConfirmDialog,
  ErrorState,
  Input,
  toast,
} from '../../../ui/index.ts';
import { canMutatePass, passKeys, passMutationPrincipal } from '../api.ts';
import { memberPhotoPng } from '../member-photo-file.ts';

export function MemberPhotoCard({ pass, readOnly }: { pass: PassDetailDto; readOnly: boolean }) {
  const path = `/api/v1/passes/${pass.id}/member-photo`;
  const client = useQueryClient();
  const photo = useQuery({
    queryKey: [...passKeys.detail(pass.id), 'member-photo'],
    queryFn: () => api.get(path, MemberPhotoSchema),
  });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();
  const [remove, setRemove] = useState(false);
  const [include, setInclude] = useState<boolean>();
  const disabled = readOnly || busy || pass.status === 'voided';
  async function write(done: string, work: (isAllowed: () => boolean) => Promise<unknown>) {
    if (disabled) return;
    const principalId = passMutationPrincipal(client);
    if (!principalId || !canMutatePass(client, pass, principalId)) return;
    const isCurrent = () => passMutationPrincipal(client) === principalId;
    const isAllowed = () => canMutatePass(client, pass, principalId);
    setBusy(true);
    setFailed(undefined);
    try {
      await work(isAllowed);
      if (!isAllowed()) return;
      await client.invalidateQueries({ queryKey: passKeys.detail(pass.id) });
      if (!isAllowed()) return;
      toast.success(done);
    } catch (error) {
      if (isAllowed()) setFailed(errorMessage(error));
    } finally {
      if (isCurrent()) {
        setBusy(false);
        setInclude(undefined);
      }
    }
  }
  return (
    <Card>
      <CardHeader title="Member photo" />
      <CardBody className="flex flex-col gap-3">
        {photo.isError ? (
          <ErrorState inline error={photo.error} onRetry={() => void photo.refetch()} />
        ) : (
          <>
            {photo.data?.url ? (
              <img
                src={photo.data.url}
                alt={pass.title ?? 'Member'}
                className="size-28 rounded-lg object-cover"
              />
            ) : null}
            <Input
              type="file"
              accept="image/*"
              aria-label="Member photo"
              disabled={disabled || photo.isPending}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = '';
                if (file)
                  void write('Member photo uploaded', async (isAllowed) => {
                    const png = await memberPhotoPng(file);
                    if (!isAllowed()) return;
                    await api.put(path, MemberPhotoSchema, {
                      png,
                      includeInPass: photo.data?.includeInPass ?? false,
                    });
                  });
              }}
            />
            <p className="text-sm text-fg-muted">
              Shown to scanning staff. Photos are cropped to a square.
            </p>
            {photo.data?.url ? (
              <>
                <CheckboxField
                  label="Include photo in Wallet pass"
                  checked={include ?? photo.data.includeInPass}
                  disabled={disabled || !photo.data.walletSupported}
                  onCheckedChange={(checked) => {
                    setInclude(checked === true);
                    void write(
                      checked === true ? 'Photo added to the pass' : 'Photo removed from the pass',
                      () => api.patch(path, MemberPhotoSchema, { includeInPass: checked === true }),
                    );
                  }}
                />
                {!photo.data.walletSupported ? (
                  <p className="text-sm text-fg-muted">
                    Wallet photos need a generic or event ticket pass without a strip image.
                  </p>
                ) : null}
                <Button variant="outline" disabled={disabled} onClick={() => setRemove(true)}>
                  Remove photo
                </Button>
              </>
            ) : null}
          </>
        )}
        {failed ? (
          <p role="alert" className="text-sm text-danger">
            {failed}
          </p>
        ) : null}
        <ConfirmDialog
          open={!readOnly && remove}
          onOpenChange={setRemove}
          title="Remove member photo?"
          description="The photo will be removed from scanners and, if included, the Wallet pass."
          confirmLabel="Remove photo"
          destructive
          onConfirm={() =>
            write('Member photo removed', () => api.deleteJson(path, MemberPhotoSchema))
          }
        />
      </CardBody>
    </Card>
  );
}
